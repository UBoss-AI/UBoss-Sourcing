/**
 * Customers and purchasing limits - integration, against a real MariaDB.
 *
 * Two themes:
 *   - Onboarding is invitation-only, and the invitation is transactional: a
 *     failed creation must not leave a usable activation link behind.
 *   - Limits are a financial control. They are enforced server-side, they
 *     report every violation at once, and a customer cannot raise their own.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Role, ROLE_DEFINITIONS } from '../../src/domain/permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  addAddress,
  archiveAddress,
  createCustomer,
  getCustomer,
  listCustomers,
  resendInvitation,
  setCustomerStatus,
  updateAddress,
  updatePurchasingLimits,
} from '../../src/modules/customers/customer.service.js';
import {
  checkPurchasingLimits,
  getSpendSummary,
  monthToDateSpend,
} from '../../src/modules/customers/limits.service.js';
import { issueSession, isSessionActive } from '../../src/modules/identity/session.service.js';
import { acceptInvitation } from '../../src/modules/identity/token.service.js';
import { login } from '../../src/modules/identity/auth.service.js';

let actor: { userId: string; email: string };

const STANDARD_RULES = { minOrderQty: 1, maxOrderQty: null, qtyIncrement: 1 };

async function resetCustomers(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.recurringScheduleItem.deleteMany({});
  await prisma.recurringSchedule.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.authToken.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
}

/** A committed order, so the monthly spend cap has something to count. */
async function placeOrder(
  customerProfileId: string,
  grandTotalMinor: bigint,
  status: 'CONFIRMED' | 'CANCELLED' | 'DRAFT' = 'CONFIRMED',
): Promise<string> {
  const id = newId();
  await prisma.order.create({
    data: {
      id,
      orderNumber: `UB-${id.slice(-10)}`,
      customerProfileId,
      status,
      currency: 'INR',
      grandTotalMinor,
      billingAddressJson: {},
      shippingAddressJson: {},
    },
  });
  return id;
}

beforeEach(async () => {
  await resetCustomers();

  for (const definition of ROLE_DEFINITIONS) {
    await prisma.role.upsert({
      where: { key: definition.key },
      update: {},
      create: {
        id: newId(),
        key: definition.key,
        name: definition.name,
        description: definition.description,
        isSystem: true,
      },
    });
  }

  const actorId = newId();
  await prisma.user.create({
    data: {
      id: actorId,
      type: 'ADMIN',
      email: 'admin@customers.test',
      emailNormalized: 'admin@customers.test',
      status: 'ACTIVE',
    },
  });
  actor = { userId: actorId, email: 'admin@customers.test' };
});

afterAll(async () => {
  await resetCustomers();
  await prisma.$disconnect();
});

describe('creating a customer', () => {
  it('creates a pending account with no password', async () => {
    const created = await createCustomer(
      { email: 'buyer@acme.test', fullName: 'Vikram Desai', organization: 'Acme' },
      actor,
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { id: created.userId } });

    expect(user.status).toBe('PENDING_INVITATION');
    // The administrator never sets or sees a password.
    expect(user.passwordHash).toBeNull();
    expect(user.type).toBe('CUSTOMER');
  });

  it('assigns the customer role and no admin permissions', async () => {
    const created = await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);

    const roles = await prisma.userRole.findMany({
      where: { userId: created.userId },
      include: { role: true },
    });

    expect(roles).toHaveLength(1);
    expect(roles[0]?.role.key).toBe(Role.CUSTOMER);
  });

  it('queues the invitation email', async () => {
    await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);

    const outbox = await prisma.notificationOutbox.findFirst({
      where: { eventKey: 'customer.invitation' },
    });

    expect(outbox?.recipientEmail).toBe('buyer@acme.test');
    // The activation link is rendered into the body at queue time.
    expect(outbox?.body).toContain('/activate?token=');
  });

  it('can create without inviting', async () => {
    const created = await createCustomer(
      { email: 'later@acme.test', fullName: 'V', sendInvitation: false },
      actor,
    );

    expect(created.invitationSent).toBe(false);
    expect(await prisma.notificationOutbox.count()).toBe(0);
    expect(await prisma.authToken.count()).toBe(0);
  });

  it('rejects a duplicate email', async () => {
    await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);
    await expect(
      createCustomer({ email: 'BUYER@acme.test', fullName: 'Other' }, actor),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('stores addresses and makes the first one the default', async () => {
    const created = await createCustomer(
      {
        email: 'buyer@acme.test',
        fullName: 'V',
        addresses: [
          {
            contactName: 'V',
            contactPhone: '+91 90000 00000',
            line1: 'Gate 3',
            city: 'Pune',
            state: 'MH',
            postalCode: '411019',
            country: 'in',
          },
        ],
      },
      actor,
    );

    const address = await prisma.address.findFirstOrThrow({
      where: { customerProfileId: created.customerProfileId },
    });

    expect(address.city).toBe('Pune');
    // Normalised to ISO-3166 upper case for the CHAR(2) column.
    expect(address.country).toBe('IN');
  });

  /**
   * The transactional-outbox guarantee. A creation that rolls back must not
   * leave a live activation link pointing at a user that does not exist.
   */
  it('leaves no invitation behind when creation fails', async () => {
    await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);
    const tokensBefore = await prisma.authToken.count();
    const outboxBefore = await prisma.notificationOutbox.count();

    await createCustomer({ email: 'buyer@acme.test', fullName: 'Dup' }, actor).catch(
      () => undefined,
    );

    expect(await prisma.authToken.count()).toBe(tokensBefore);
    expect(await prisma.notificationOutbox.count()).toBe(outboxBefore);
  });

  it('rejects a limit range where max is below min', async () => {
    await expect(
      createCustomer(
        {
          email: 'buyer@acme.test',
          fullName: 'V',
          limits: { perCurrency: [{ currencyCode: 'INR', perOrderMinMinor: '900000', perOrderMaxMinor: '100000' }] },
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a non-integer money string', async () => {
    await expect(
      createCustomer(
        { email: 'buyer@acme.test', fullName: 'V', limits: { perCurrency: [{ currencyCode: 'INR', perOrderMaxMinor: '5000.00' }] } },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('invitation lifecycle', () => {
  it('activates the account and lets it sign in', async () => {
    const created = await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);

    const token = await prisma.authToken.findFirstOrThrow({
      where: { userId: created.userId, type: 'INVITATION' },
    });

    // The service stores only the hash, so the test re-issues to obtain a raw
    // token the same way the email does.
    const outbox = await prisma.notificationOutbox.findFirstOrThrow();
    const rawToken = /\/activate\?token=([A-Za-z0-9_-]+)/.exec(outbox.body)?.[1];
    expect(rawToken).toBeTruthy();
    expect(token.consumedAt).toBeNull();

    await acceptInvitation({
      token: rawToken ?? '',
      password: 'ActivatedPass!2026',
      acceptedTerms: true,
      consentVersion: 'v1',
    });

    const result = await login({
      email: 'buyer@acme.test',
      password: 'ActivatedPass!2026',
      kind: 'CUSTOMER',
    });

    expect(result.user.id).toBe(created.userId);
    expect(result.user.customerProfileId).toBe(created.customerProfileId);
  });

  it('supersedes the previous link when an invitation is resent', async () => {
    const created = await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);
    const first = await prisma.notificationOutbox.findFirstOrThrow();
    const firstToken = /\/activate\?token=([A-Za-z0-9_-]+)/.exec(first.body)?.[1] ?? '';

    await resendInvitation(created.customerProfileId, actor);

    // The older link must stop working the moment a new one is sent.
    await expect(
      acceptInvitation({
        token: firstToken,
        password: 'ActivatedPass!2026',
        acceptedTerms: true,
        consentVersion: 'v1',
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_ALREADY_USED' });
  });

  it('refuses to re-invite an already active account', async () => {
    const created = await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);
    await prisma.user.update({ where: { id: created.userId }, data: { status: 'ACTIVE' } });

    await expect(resendInvitation(created.customerProfileId, actor)).rejects.toMatchObject({
      code: 'INVITATION_ALREADY_ACCEPTED',
    });
  });

  it('refuses to re-invite a deactivated account', async () => {
    const created = await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);
    await prisma.user.update({ where: { id: created.userId }, data: { status: 'DEACTIVATED' } });

    await expect(resendInvitation(created.customerProfileId, actor)).rejects.toMatchObject({
      code: 'ACCOUNT_DEACTIVATED',
    });
  });
});

describe('status changes', () => {
  /** SOP 3.1: access is lost immediately, not at the next sign-in attempt. */
  it('revokes every live session on deactivation', async () => {
    const created = await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);
    await prisma.user.update({ where: { id: created.userId }, data: { status: 'ACTIVE' } });

    const session = await issueSession(created.userId, 'CUSTOMER');
    expect(await isSessionActive(session.sessionId)).toBe(true);

    const result = await setCustomerStatus(created.customerProfileId, false, actor, 'fraud review');

    expect(result.sessionsRevoked).toBe(1);
    expect(await isSessionActive(session.sessionId)).toBe(false);
  });

  /**
   * Reactivating a never-activated account must return it to
   * PENDING_INVITATION - it still has no password, so ACTIVE would be a lie.
   */
  it('reactivates a never-activated account as pending, not active', async () => {
    const created = await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);
    await setCustomerStatus(created.customerProfileId, false, actor);
    await setCustomerStatus(created.customerProfileId, true, actor);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: created.userId } });
    expect(user.status).toBe('PENDING_INVITATION');
  });

  it('reactivates a previously activated account as active', async () => {
    const created = await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);
    await prisma.customerProfile.update({
      where: { id: created.customerProfileId },
      data: { activatedAt: new Date() },
    });

    await setCustomerStatus(created.customerProfileId, false, actor);
    await setCustomerStatus(created.customerProfileId, true, actor);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: created.userId } });
    expect(user.status).toBe('ACTIVE');
  });
});

describe('addresses', () => {
  let profileId: string;

  beforeEach(async () => {
    const created = await createCustomer({ email: 'buyer@acme.test', fullName: 'V' }, actor);
    profileId = created.customerProfileId;
  });

  const sample = {
    contactName: 'V',
    contactPhone: '+91 90000 00000',
    line1: 'Gate 3',
    city: 'Pune',
    state: 'MH',
    postalCode: '411019',
    country: 'IN',
  };

  it('makes the first address the default for both roles', async () => {
    const { addressId } = await addAddress(profileId, sample, actor);
    const address = await prisma.address.findUniqueOrThrow({ where: { id: addressId } });

    expect(address.isDefaultBilling).toBe(true);
    expect(address.isDefaultShipping).toBe(true);
  });

  /**
   * Two defaults would make checkout pick whichever the database returned
   * first, which is a silently wrong shipping address.
   */
  it('never leaves two default shipping addresses', async () => {
    await addAddress(profileId, sample, actor);
    await addAddress(profileId, { ...sample, city: 'Mumbai', isDefaultShipping: true }, actor);

    const defaults = await prisma.address.count({
      where: { customerProfileId: profileId, isDefaultShipping: true },
    });
    expect(defaults).toBe(1);
  });

  it('moves the default when an existing address is promoted', async () => {
    const first = await addAddress(profileId, sample, actor);
    const second = await addAddress(profileId, { ...sample, city: 'Mumbai' }, actor);

    await updateAddress(profileId, second.addressId, { isDefaultShipping: true }, actor);

    const rows = await prisma.address.findMany({ where: { customerProfileId: profileId } });
    expect(rows.find((r) => r.id === first.addressId)?.isDefaultShipping).toBe(false);
    expect(rows.find((r) => r.id === second.addressId)?.isDefaultShipping).toBe(true);
  });

  /** The IDOR case: an address id from another customer must not resolve. */
  it('scopes edits to the owning customer', async () => {
    const { addressId } = await addAddress(profileId, sample, actor);
    const other = await createCustomer({ email: 'other@acme.test', fullName: 'Other' }, actor);

    await expect(
      updateAddress(other.customerProfileId, addressId, { city: 'Hacked' }, actor),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const unchanged = await prisma.address.findUniqueOrThrow({ where: { id: addressId } });
    expect(unchanged.city).toBe('Pune');
  });

  it('scopes archiving to the owning customer', async () => {
    const { addressId } = await addAddress(profileId, sample, actor);
    const other = await createCustomer({ email: 'other@acme.test', fullName: 'Other' }, actor);

    await expect(archiveAddress(other.customerProfileId, addressId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses to archive an address a recurring schedule depends on', async () => {
    const { addressId } = await addAddress(profileId, sample, actor);

    await prisma.recurringSchedule.create({
      data: {
        id: newId(),
        customerProfileId: profileId,
        name: 'Weekly bolts',
        status: 'ACTIVE',
        frequency: 'EVERY_N_DAYS',
        intervalDays: 7,
        timezone: 'Asia/Kolkata',
        startDate: new Date(),
        paymentMode: 'PAYMENT_LINK',
        shippingAddressId: addressId,
        billingAddressId: addressId,
        consentAcceptedAt: new Date(),
        consentVersion: 'v1',
      },
    });

    await expect(archiveAddress(profileId, addressId)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('purchasing limits', () => {
  let profileId: string;

  beforeEach(async () => {
    const created = await createCustomer(
      {
        email: 'buyer@acme.test',
        fullName: 'V',
        limits: {
          perCurrency: [
            {
              currencyCode: 'INR',
              perOrderMinMinor: '50000',
              perOrderMaxMinor: '5000000',
              monthlySpendCapMinor: '20000000',
            },
          ],
        },
      },
      actor,
    );
    profileId = created.customerProfileId;
  });

  it('accepts an order inside every limit', async () => {
    const result = await checkPurchasingLimits({
      customerProfileId: profileId,
      lines: [
        { productId: newId(), productName: 'Bolt', quantity: 10, rules: STANDARD_RULES },
      ],
      grandTotalMinor: 100_000n,
      currency: 'INR',
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects an order below the minimum value', async () => {
    const result = await checkPurchasingLimits({
      customerProfileId: profileId,
      lines: [{ productId: newId(), productName: 'Bolt', quantity: 1, rules: STANDARD_RULES }],
      grandTotalMinor: 10_000n,
      currency: 'INR',
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe('ORDER_BELOW_MINIMUM_VALUE');
  });

  it('rejects an order above the maximum value', async () => {
    const result = await checkPurchasingLimits({
      customerProfileId: profileId,
      lines: [{ productId: newId(), productName: 'Bolt', quantity: 1, rules: STANDARD_RULES }],
      grandTotalMinor: 9_000_000n,
      currency: 'INR',
    });

    expect(result.violations[0]?.code).toBe('ORDER_ABOVE_MAXIMUM_VALUE');
  });

  it('enforces per-product quantity rules', async () => {
    const result = await checkPurchasingLimits({
      customerProfileId: profileId,
      lines: [
        {
          productId: newId(),
          productName: 'Hex Bolt',
          quantity: 3,
          rules: { minOrderQty: 10, maxOrderQty: 100, qtyIncrement: 5 },
        },
      ],
      grandTotalMinor: 100_000n,
      currency: 'INR',
    });

    expect(result.violations[0]?.code).toBe('QUANTITY_BELOW_MINIMUM');
    expect(result.violations[0]?.meta).toMatchObject({ minimum: 10, requested: 3 });
  });

  /** The increment counts from the minimum, not from zero. */
  it('measures the quantity increment from the minimum', async () => {
    const rules = { minOrderQty: 10, maxOrderQty: null, qtyIncrement: 5 };

    const valid = await checkPurchasingLimits({
      customerProfileId: profileId,
      lines: [{ productId: newId(), productName: 'Bolt', quantity: 15, rules }],
      grandTotalMinor: 100_000n,
      currency: 'INR',
    });
    expect(valid.ok).toBe(true);

    const invalid = await checkPurchasingLimits({
      customerProfileId: profileId,
      lines: [{ productId: newId(), productName: 'Bolt', quantity: 13, rules }],
      grandTotalMinor: 100_000n,
      currency: 'INR',
    });
    expect(invalid.violations[0]?.code).toBe('QUANTITY_INCREMENT_INVALID');
  });

  /**
   * A B2B order can have forty lines. Reporting one problem per round-trip is
   * a genuinely bad buying experience, so every violation comes back together.
   */
  it('reports every violation at once', async () => {
    const result = await checkPurchasingLimits({
      customerProfileId: profileId,
      lines: [
        {
          productId: newId(),
          productName: 'Bolt',
          quantity: 3,
          rules: { minOrderQty: 10, maxOrderQty: null, qtyIncrement: 1 },
        },
        {
          productId: newId(),
          productName: 'Nut',
          quantity: 500,
          rules: { minOrderQty: 1, maxOrderQty: 100, qtyIncrement: 1 },
        },
      ],
      grandTotalMinor: 9_000_000n,
      currency: 'INR',
    });

    expect(result.violations.length).toBeGreaterThanOrEqual(3);
    expect(result.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining([
        'QUANTITY_BELOW_MINIMUM',
        'QUANTITY_ABOVE_MAXIMUM',
        'ORDER_ABOVE_MAXIMUM_VALUE',
      ]),
    );
  });
});

describe('monthly spend cap', () => {
  let profileId: string;

  beforeEach(async () => {
    const created = await createCustomer(
      { email: 'buyer@acme.test', fullName: 'V', limits: { perCurrency: [{ currencyCode: 'INR', monthlySpendCapMinor: '1000000' }] } },
      actor,
    );
    profileId = created.customerProfileId;
  });

  it('counts committed orders toward the cap', async () => {
    await placeOrder(profileId, 400_000n);
    await placeOrder(profileId, 300_000n);

    expect(await monthToDateSpend(profileId, 'INR')).toBe(700_000n);
  });

  /** A cancelled order must not consume the customer's budget. */
  it('excludes cancelled and draft orders', async () => {
    await placeOrder(profileId, 400_000n);
    await placeOrder(profileId, 900_000n, 'CANCELLED');
    await placeOrder(profileId, 900_000n, 'DRAFT');

    expect(await monthToDateSpend(profileId, 'INR')).toBe(400_000n);
  });

  it('blocks an order that would breach the cap', async () => {
    await placeOrder(profileId, 800_000n);

    const result = await checkPurchasingLimits({
      customerProfileId: profileId,
      lines: [{ productId: newId(), productName: 'Bolt', quantity: 1, rules: STANDARD_RULES }],
      grandTotalMinor: 300_000n,
      currency: 'INR',
    });

    expect(result.violations[0]?.code).toBe('CUSTOMER_SPEND_CAP_EXCEEDED');
    // Naming the remaining budget lets the customer trim rather than guess.
    expect(result.violations[0]?.meta).toMatchObject({ remainingMinor: '200000' });
  });

  it('allows an order that exactly reaches the cap', async () => {
    await placeOrder(profileId, 800_000n);

    const result = await checkPurchasingLimits({
      customerProfileId: profileId,
      lines: [{ productId: newId(), productName: 'Bolt', quantity: 1, rules: STANDARD_RULES }],
      grandTotalMinor: 200_000n,
      currency: 'INR',
    });

    expect(result.ok).toBe(true);
  });

  it('can exclude an order being re-checked', async () => {
    const orderId = await placeOrder(profileId, 900_000n);

    const withoutExclusion = await checkPurchasingLimits({
      customerProfileId: profileId,
      lines: [{ productId: newId(), productName: 'Bolt', quantity: 1, rules: STANDARD_RULES }],
      grandTotalMinor: 900_000n,
      currency: 'INR',
    });
    expect(withoutExclusion.ok).toBe(false);

    const reChecked = await checkPurchasingLimits({
      customerProfileId: profileId,
      lines: [{ productId: newId(), productName: 'Bolt', quantity: 1, rules: STANDARD_RULES }],
      grandTotalMinor: 900_000n,
      currency: 'INR',
      excludeOrderId: orderId,
    });
    expect(reChecked.ok).toBe(true);
  });

  it('clamps the remaining budget at zero when the cap was lowered', async () => {
    await placeOrder(profileId, 900_000n);
    await updatePurchasingLimits(
      profileId,
      { perCurrency: [{ currencyCode: 'INR', monthlySpendCapMinor: '500000' }] },
      actor,
    );

    const summary = await getSpendSummary(profileId, 'INR');
    expect(summary.monthToDateMinor).toBe('900000');
    // Never a negative "remaining".
    expect(summary.remainingMinor).toBe('0');
  });
});

describe('approval routing', () => {
  it('routes every order when approval is unconditional', async () => {
    const created = await createCustomer(
      { email: 'buyer@acme.test', fullName: 'V', limits: { requiresOrderApproval: true } },
      actor,
    );

    const result = await checkPurchasingLimits({
      customerProfileId: created.customerProfileId,
      lines: [{ productId: newId(), productName: 'Bolt', quantity: 1, rules: STANDARD_RULES }],
      grandTotalMinor: 1000n,
      currency: 'INR',
    });

    // Not a violation - the order is allowed, it just needs a decision first.
    expect(result.ok).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it('routes only orders at or above the threshold', async () => {
    const created = await createCustomer(
      {
        email: 'buyer@acme.test',
        fullName: 'V',
        limits: {
          requiresOrderApproval: true,
          perCurrency: [{ currencyCode: 'INR', approvalThresholdMinor: '1000000' }],
        },
      },
      actor,
    );

    const below = await checkPurchasingLimits({
      customerProfileId: created.customerProfileId,
      lines: [{ productId: newId(), productName: 'Bolt', quantity: 1, rules: STANDARD_RULES }],
      grandTotalMinor: 999_999n,
      currency: 'INR',
    });
    expect(below.requiresApproval).toBe(false);

    const atThreshold = await checkPurchasingLimits({
      customerProfileId: created.customerProfileId,
      lines: [{ productId: newId(), productName: 'Bolt', quantity: 1, rules: STANDARD_RULES }],
      grandTotalMinor: 1_000_000n,
      currency: 'INR',
    });
    expect(atThreshold.requiresApproval).toBe(true);
  });
});

describe('reads', () => {
  it('paginates and searches', async () => {
    await createCustomer({ email: 'a@acme.test', fullName: 'Alpha', organization: 'Acme' }, actor);
    await createCustomer({ email: 'b@zen.test', fullName: 'Beta', organization: 'Zenith' }, actor);

    const all = await listCustomers({ limit: 10 });
    expect(all.pagination.total).toBe(2);

    const filtered = await listCustomers({ q: 'Zenith' });
    expect(filtered.pagination.total).toBe(1);
    expect(filtered.customers[0]).toMatchObject({ fullName: 'Beta' });
  });

  it('filters by account status', async () => {
    const created = await createCustomer({ email: 'a@acme.test', fullName: 'Alpha' }, actor);
    await prisma.user.update({ where: { id: created.userId }, data: { status: 'ACTIVE' } });
    await createCustomer({ email: 'b@acme.test', fullName: 'Beta' }, actor);

    const pending = await listCustomers({ status: 'PENDING_INVITATION' });
    expect(pending.pagination.total).toBe(1);
  });

  it('serialises money as strings, never as JS numbers', async () => {
    const created = await createCustomer(
      {
        email: 'a@acme.test',
        fullName: 'Alpha',
        limits: { perCurrency: [{ currencyCode: 'INR', monthlySpendCapMinor: '100000000000000001' }] },
      },
      actor,
    );

    const customer = await getCustomer(created.customerProfileId);
    const limits = customer['limits'] as { perCurrency: Record<string, unknown>[] };
    const inr = limits.perCurrency.find((row) => row['currencyCode'] === 'INR');

    // Beyond Number.MAX_SAFE_INTEGER: as a JS number this would already be wrong.
    expect(inr?.['monthlySpendCapMinor']).toBe('100000000000000001');
    expect(typeof inr?.['monthlySpendCapMinor']).toBe('string');
  });
});
