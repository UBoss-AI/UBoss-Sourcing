/**
 * Self-registration - integration, against a real MariaDB.
 *
 * The interesting assertions here are the negative ones. A public sign-up form
 * is the one place a stranger can create rows in this database, so what it
 * *refuses* to do matters more than the happy path:
 *
 *   - It must not answer differently for an address that already has an
 *     account, or it becomes a way to enumerate the customer list.
 *   - It must not produce an account that can sign in before the confirmation
 *     link is opened, or an emailed link stops meaning anything.
 *   - It must not produce one that can sign in before staff approve, wherever
 *     the deployment asks for approval.
 *   - It must not be reachable at all where the feature flag is down.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_DEFINITIONS } from '../../src/domain/permissions.js';
import { env } from '../../src/config/env.js';
import { buildApp } from '../../src/http/app.js';
import { sha256Hex } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { approveRegistration } from '../../src/modules/customers/registration.service.js';

const PASSWORD = 'RegisterTestPass!2026';
const EMAIL = 'newbuyer@example.test';

let app: Awaited<ReturnType<typeof buildApp>>;

/**
 * The flags are read through `env`, which is parsed once at import. Tests flip
 * the parsed object and put it back afterwards; re-importing the module per
 * case would mean a second Prisma client and a second connection pool.
 */
const originalFlags = {
  selfRegistration: env.FEATURE_CUSTOMER_SELF_REGISTRATION,
  requiresApproval: env.CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL,
};

function setFlags(selfRegistration: boolean, requiresApproval: boolean): void {
  (env as { FEATURE_CUSTOMER_SELF_REGISTRATION: boolean }).FEATURE_CUSTOMER_SELF_REGISTRATION =
    selfRegistration;
  (
    env as { CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL: boolean }
  ).CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL = requiresApproval;
}

async function resetAccounts(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.adminNotificationRead.deleteMany({});
  await prisma.adminNotification.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.authToken.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
}

async function seedRolesAndMarket(): Promise<void> {
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

  // A country the deployment serves, and the currency it is quoted in. The
  // sign-up form refuses a country this store has not activated, so without
  // these there is nothing valid to post.
  await prisma.currency.upsert({
    where: { code: 'INR' },
    update: { isActive: true },
    create: { code: 'INR', name: 'Indian Rupee', symbol: '₹', exponent: 2, isActive: true },
  });
  await prisma.country.upsert({
    where: { code: 'IN' },
    update: { isActive: true, currencyCode: 'INR' },
    create: {
      code: 'IN',
      name: 'India',
      currencyCode: 'INR',
      phonePrefix: '+91',
      isActive: true,
    },
  });
}

/** A well-formed sign-up, with whatever the case under test wants changed. */
function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fullName: 'Asha Menon',
    email: EMAIL,
    phone: '+91 98765 43210',
    country: 'IN',
    password: PASSWORD,
    acceptedTerms: true,
    ...overrides,
  };
}

/**
 * Every test gets its own client IP.
 *
 * `/auth/register` allows five attempts an hour per address, which is the right
 * limit for a public sign-up form and far too tight for a suite that posts to
 * it a dozen times in two seconds. Sharing one IP made each test's result
 * depend on how many ran before it. A distinct address per test is a fresh
 * bucket, and it leaves the limiter itself switched on rather than stubbed -
 * `rate-limit.test.ts` is what proves the limiter works.
 *
 * It goes in as `remoteAddress`, the socket's own address, and NOT as an
 * `x-forwarded-for` header: the app only sets `trustProxy` in production, so
 * outside it that header is ignored and every request would key on 127.0.0.1.
 */
let clientIp = 0;

function nextIp(): string {
  clientIp += 1;
  // TEST-NET-3 (RFC 5737): reserved for documentation, routable nowhere.
  return `203.0.113.${String(clientIp % 250)}`;
}

let currentIp = nextIp();

function post(url: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/${url}`,
    remoteAddress: currentIp,
    payload,
  });
}

/**
 * The raw token from the confirmation email.
 *
 * Only the SHA-256 is stored, so the row cannot be read back into a link. The
 * outbox row carries the URL that was actually sent, which is the same thing
 * the customer would click.
 */
async function verificationLinkToken(): Promise<string> {
  const outbox = await prisma.notificationOutbox.findFirst({
    where: { eventKey: 'customer.email_verification' },
    orderBy: { createdAt: 'desc' },
  });

  const url = /https?:\/\/\S*?token=([A-Za-z0-9_-]+)/.exec(outbox?.body ?? '');
  if (url?.[1] === undefined) throw new Error('no verification link was emailed');
  return url[1];
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await seedRolesAndMarket();
});

afterAll(async () => {
  setFlags(originalFlags.selfRegistration, originalFlags.requiresApproval);
  await app.close();
});

beforeEach(async () => {
  await resetAccounts();
  setFlags(true, true);
  currentIp = nextIp();
});

afterEach(() => {
  setFlags(originalFlags.selfRegistration, originalFlags.requiresApproval);
});

describe('POST /auth/register - the feature flag', () => {
  it('refuses outright where self-registration is off', async () => {
    setFlags(false, true);

    const response = await post('auth/register', registration());

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'SELF_REGISTRATION_DISABLED',
    );
    expect(await prisma.user.count()).toBe(0);
  });
});

describe('POST /auth/register - creating an account', () => {
  it('creates a closed account and emails a confirmation link', async () => {
    const response = await post('auth/register', registration());

    expect(response.statusCode).toBe(202);
    expect(response.json<{ requiresApproval: boolean }>().requiresApproval).toBe(true);

    const user = await prisma.user.findUnique({
      where: { emailNormalized: EMAIL },
      include: { customerProfile: true, roles: { include: { role: true } } },
    });

    expect(user).not.toBeNull();
    // Closed on both counts: the address is unproved and staff have not seen it.
    expect(user?.status).toBe('PENDING_APPROVAL');
    expect(user?.emailVerifiedAt).toBeNull();
    // The password is theirs from the start - unlike an invitation, where the
    // account exists for days with no credential at all.
    expect(user?.passwordHash).not.toBeNull();
    expect(user?.roles.map((assignment) => assignment.role.key)).toEqual(['customer']);

    // Punctuation stripped, the international prefix kept.
    expect(user?.phone).toBe('+919876543210');
    expect(user?.customerProfile?.fullName).toBe('Asha Menon');
    // The country answers the storefront's "where are you ordering from?"
    // prompt, so a new account is never asked it twice.
    expect(user?.customerProfile?.preferredCountry).toBe('IN');
    expect(user?.customerProfile?.preferredCurrency).toBe('INR');
    expect(user?.customerProfile?.consentAcceptedAt).not.toBeNull();
    // Nobody invited them, and that null is how the trail tells the two
    // onboarding paths apart later.
    expect(user?.customerProfile?.invitedById).toBeNull();
    expect(user?.customerProfile?.activatedAt).toBeNull();

    expect(await verificationLinkToken()).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it('will not let the new account sign in before the link is opened', async () => {
    await post('auth/register', registration());

    const response = await post('auth/login', { email: EMAIL, password: PASSWORD });

    expect(response.statusCode).toBe(401);
    // Not "awaiting approval": the fix is in their inbox, and sending them off
    // to wait for a colleague would be a wrong turn.
    expect(response.json<{ error: { code: string } }>().error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('refuses a country this store does not serve', async () => {
    const response = await post('auth/register', registration({ country: 'ZZ' }));

    expect(response.statusCode).toBe(400);
    expect(
      response.json<{ error: { details: { field: string }[] } }>().error.details[0]?.field,
    ).toBe('country');
    expect(await prisma.user.count()).toBe(0);
  });

  it('refuses a sign-up that has not accepted the terms', async () => {
    const response = await post('auth/register', registration({ acceptedTerms: false }));

    expect(response.statusCode).toBe(400);
    expect(await prisma.user.count()).toBe(0);
  });

  it('holds the backend password floor', async () => {
    const response = await post('auth/register', registration({ password: 'short' }));

    expect(response.statusCode).toBe(400);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe('POST /auth/register - account enumeration', () => {
  it('answers a taken address identically, and mails the address instead', async () => {
    const first = await post('auth/register', registration());
    expect(first.statusCode).toBe(202);

    await prisma.notificationOutbox.deleteMany({});

    // Same address, different everything else - as an attacker probing a list
    // would send it.
    const second = await post(
      'auth/register',
      registration({ fullName: 'Someone Else', phone: '+1 415 555 0100' }),
    );

    // Byte for byte the same answer. Anything that differed here - a status
    // code, a message, a field - would be the oracle.
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());

    // No second account, and no detail of the first one overwritten.
    expect(await prisma.user.count()).toBe(1);
    const profile = await prisma.customerProfile.findFirst();
    expect(profile?.fullName).toBe('Asha Menon');

    // The truth went to the mailbox, not to whoever filled the form in.
    const mail = await prisma.notificationOutbox.findFirst({
      where: { eventKey: 'customer.registration_duplicate' },
    });
    expect(mail?.recipientEmail).toBe(EMAIL);
  });
});

describe('POST /auth/verify-email', () => {
  it('confirms the address and leaves the account with staff', async () => {
    await post('auth/register', registration());
    const token = await verificationLinkToken();

    const response = await post('auth/verify-email', { token });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('PENDING_APPROVAL');

    const user = await prisma.user.findUnique({
      where: { emailNormalized: EMAIL },
      include: { customerProfile: true },
    });
    expect(user?.emailVerifiedAt).not.toBeNull();
    expect(user?.status).toBe('PENDING_APPROVAL');
    // They have done everything asked of them; only the commercial decision
    // is outstanding, and that is what `status` carries.
    expect(user?.customerProfile?.activatedAt).not.toBeNull();

    // Still cannot sign in - and now told the accurate reason.
    const signIn = await post('auth/login', { email: EMAIL, password: PASSWORD });
    expect(signIn.json<{ error: { code: string } }>().error.code).toBe('ACCOUNT_PENDING_APPROVAL');

    // The console bell is rung here rather than at sign-up: an unconfirmed
    // address is not yet worth a colleague's attention.
    const bell = await prisma.adminNotification.findFirst({
      where: { kind: 'customer.registered' },
    });
    expect(bell).not.toBeNull();
    expect(bell?.requiredPermission).toBe('customer.read');
  });

  it('opens the account immediately where approval is not required', async () => {
    setFlags(true, false);

    await post('auth/register', registration());
    const token = await verificationLinkToken();

    const response = await post('auth/verify-email', { token });

    expect(response.json<{ status: string }>().status).toBe('ACTIVE');

    const signIn = await post('auth/login', { email: EMAIL, password: PASSWORD });
    expect(signIn.statusCode).toBe(200);
  });

  it('spends the link exactly once', async () => {
    await post('auth/register', registration());
    const token = await verificationLinkToken();

    expect((await post('auth/verify-email', { token })).statusCode).toBe(200);

    const second = await post('auth/verify-email', { token });
    expect(second.statusCode).toBe(400);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('TOKEN_ALREADY_USED');
  });

  it('refuses a token minted for a different purpose', async () => {
    await post('auth/register', registration());
    const user = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: EMAIL } });

    // A password-reset token, presented as a confirmation link.
    const raw = 'a'.repeat(43);
    await prisma.authToken.create({
      data: {
        id: newId(),
        userId: user.id,
        type: 'PASSWORD_RESET',
        tokenHash: sha256Hex(raw),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const response = await post('auth/verify-email', { token: raw });
    expect(response.json<{ error: { code: string } }>().error.code).toBe('TOKEN_INVALID');
  });
});

/**
 * Approval is exercised through the service rather than the admin route.
 *
 * The route is four lines - parse an id, call this, echo the result - and the
 * setup it would need (a staff account, its role, that role's permission rows,
 * a sign-in and a posted location) would test the admin auth stack, which has
 * its own file. What is worth pinning down is the rule, and the rule lives
 * here.
 */
describe('approving a self-registered account', () => {
  // A real staff row, not a made-up id: the audit trail carries a foreign key
  // to it, and a trail that cannot name the actor is not allowed to commit.
  let actor: { userId: string; email: string };

  beforeEach(async () => {
    const actorId = newId();
    await prisma.user.create({
      data: {
        id: actorId,
        type: 'ADMIN',
        email: 'staff@self-registration.test',
        emailNormalized: 'staff@self-registration.test',
        status: 'ACTIVE',
      },
    });
    actor = { userId: actorId, email: 'staff@self-registration.test' };
  });

  async function registerAndConfirm(): Promise<string> {
    await post('auth/register', registration());
    await post('auth/verify-email', { token: await verificationLinkToken() });

    const profile = await prisma.customerProfile.findFirstOrThrow({
      where: { user: { emailNormalized: EMAIL } },
    });
    return profile.id;
  }

  it('opens the account and emails the holder', async () => {
    const profileId = await registerAndConfirm();

    const result = await approveRegistration(profileId, actor);

    expect(result.email).toBe(EMAIL);
    const user = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: EMAIL } });
    expect(user.status).toBe('ACTIVE');

    // The password they chose at sign-up is the one that now works. Approval
    // never issues a credential.
    const signIn = await post('auth/login', { email: EMAIL, password: PASSWORD });
    expect(signIn.statusCode).toBe(200);

    const mail = await prisma.notificationOutbox.findFirst({
      where: { eventKey: 'customer.registration_approved' },
    });
    expect(mail?.recipientEmail).toBe(EMAIL);
  });

  /**
   * The one refusal that matters. Approving an unconfirmed account hands a
   * live login to whoever typed the address rather than to whoever owns it -
   * precisely what the confirmation link exists to prevent, and nothing a
   * member of staff can tell apart by looking at the record.
   */
  it('refuses while the email address is unconfirmed', async () => {
    await post('auth/register', registration());
    const profile = await prisma.customerProfile.findFirstOrThrow({
      where: { user: { emailNormalized: EMAIL } },
    });

    await expect(approveRegistration(profile.id, actor)).rejects.toMatchObject({
      statusCode: 409,
      code: 'EMAIL_NOT_VERIFIED',
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: EMAIL } });
    expect(user.status).toBe('PENDING_APPROVAL');
  });

  it('refuses an account that is already active', async () => {
    const profileId = await registerAndConfirm();
    await approveRegistration(profileId, actor);

    await expect(approveRegistration(profileId, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('refuses an invited account, which was never awaiting approval', async () => {
    const userId = newId();
    const customerRole = await prisma.role.findUniqueOrThrow({ where: { key: 'customer' } });

    await prisma.user.create({
      data: {
        id: userId,
        type: 'CUSTOMER',
        email: 'invited@example.test',
        emailNormalized: 'invited@example.test',
        status: 'PENDING_INVITATION',
        roles: { create: { roleId: customerRole.id } },
      },
    });

    const profile = await prisma.customerProfile.create({
      data: { id: newId(), userId, fullName: 'Invited Buyer' },
    });

    await expect(approveRegistration(profile.id, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('POST /auth/verify-email/resend', () => {
  it('sends a fresh link and retires the previous one', async () => {
    await post('auth/register', registration());
    const first = await verificationLinkToken();

    const response = await post('auth/verify-email/resend', { email: EMAIL });
    expect(response.statusCode).toBe(202);

    const second = await verificationLinkToken();
    expect(second).not.toBe(first);

    // The old link is dead the moment a new one is issued, so a stale email
    // cannot be used against an account whose owner asked for another.
    expect((await post('auth/verify-email', { token: first })).statusCode).toBe(400);
    expect((await post('auth/verify-email', { token: second })).statusCode).toBe(200);
  });

  it('answers identically for an address that has no account', async () => {
    const unknown = await post('auth/verify-email/resend', { email: 'nobody@example.test' });

    expect(unknown.statusCode).toBe(202);
    expect(await prisma.notificationOutbox.count()).toBe(0);
  });
});
