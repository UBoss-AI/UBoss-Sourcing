/**
 * Auto-pay: consent, limits, and the decision made at charge time.
 *
 * The thing this file is really testing is a distinction: a saved card is not
 * permission to use it. `customer_payment_methods` says an instrument exists;
 * `customer_autopay_settings` says the account holder asked us to use it, up to
 * this much, under these rules. Every test below is about keeping those two
 * apart, because conflating them is exactly how somebody is billed for
 * something they never agreed to.
 *
 * `evaluateAutoPay` is the function every off-session charge path consults, and
 * it is deliberately a READ. That is what lets the review screen tell a
 * customer "this basket will need your approval" weeks before the day it would
 * be charged, rather than discovering it at the moment of payment.
 *
 * The three outcomes are not degrees of one another:
 *
 *   CHARGE       - go ahead.
 *   ASK_CUSTOMER - do not charge, and ask. A deferral.
 *   REFUSE       - do not charge, and do not ask. A refusal.
 *
 * A test that treated the last two as interchangeable would be missing the
 * point of having both.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  type AutoPayActor,
  disableAutoPay,
  enableAutoPay,
  evaluateAutoPay,
  getAutoPaySettings,
  recordWithheldCharge,
  retryAttemptsFor,
  setAutoPayPaused,
  updateAutoPaySettings,
} from '../../src/modules/payments/autopay.service.js';

let actor: AutoPayActor;
let rival: AutoPayActor;
let paymentMethodId: string;
let expiredMethodId: string;

const flags = { autopay: env.FEATURE_CUSTOMER_AUTOPAY };

function setFlags(values: { FEATURE_CUSTOMER_AUTOPAY: boolean }): void {
  Object.assign(env as unknown as typeof values, values);
}

async function makeCustomer(email: string): Promise<AutoPayActor> {
  const userId = newId();
  await prisma.user.create({
    data: { id: userId, type: 'CUSTOMER', email, emailNormalized: email, status: 'ACTIVE' },
  });

  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId, fullName: 'Test Buyer', activatedAt: new Date() },
  });

  return {
    customerProfileId: profile.id,
    userId,
    email,
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (test)',
  };
}

/** A saved card belonging to `owner`. Chargeable unless `expired`. */
async function makeCard(
  owner: AutoPayActor,
  options: { expired?: boolean; detached?: boolean } = {},
): Promise<string> {
  const id = newId();
  const year = new Date().getUTCFullYear();

  await prisma.customerPaymentMethod.create({
    data: {
      id,
      customerProfileId: owner.customerProfileId,
      provider: 'STRIPE',
      providerCustomerId: `cus_${id.slice(0, 10)}`,
      providerPaymentMethodId: `pm_${id.slice(0, 12)}`,
      brand: 'visa',
      last4: '4242',
      expMonth: options.expired === true ? 1 : 12,
      expYear: options.expired === true ? year - 1 : year + 3,
      status: options.detached === true ? 'DETACHED' : 'ACTIVE',
      consentAcceptedAt: new Date(),
      consentVersion: 'v1',
    },
  });

  return id;
}

async function resetAll(): Promise<void> {
  // Files share one MariaDB database (`fileParallelism: false`), so a run that
  // follows another has to clear whatever that one left behind. Ordered
  // children-first: every FK here is ON DELETE RESTRICT or NO ACTION, so a
  // profile cannot go until the orders and carts pointing at it have.
  await prisma.auditLog.deleteMany({});
  await prisma.customerAutoPaySetting.deleteMany({});
  await prisma.integrationEvent.deleteMany({});
  await prisma.erpWebhookReceipt.deleteMany({});
  await prisma.erpSyncRecordError.deleteMany({});
  await prisma.erpInventorySyncRun.deleteMany({});
  await prisma.erpInventorySnapshot.deleteMany({});
  await prisma.erpConnection.deleteMany({});
  await prisma.erpOrderPush.deleteMany({});
  await prisma.paymentEvent.deleteMany({});
  await prisma.paymentTransaction.deleteMany({});
  await prisma.paymentProviderConnection.deleteMany({});
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: 'apx-' } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: 'apx-' } } });
  await prisma.scheduleOccurrence.deleteMany({});
  await prisma.recurringScheduleItem.deleteMany({});
  await prisma.recurringSchedule.deleteMany({});
  await prisma.customerPaymentMethod.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.couponRedemption.deleteMany({});
  await prisma.customerLimit.deleteMany({});
  await prisma.assistantMessage.deleteMany({});
  await prisma.assistantConversation.deleteMany({});
  await prisma.dataRequest.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.authToken.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
}

beforeEach(async () => {
  await resetAll();

  setFlags({ FEATURE_CUSTOMER_AUTOPAY: true });

  actor = await makeCustomer('buyer@autopay.test');
  rival = await makeCustomer('rival@autopay.test');

  paymentMethodId = await makeCard(actor);
  expiredMethodId = await makeCard(actor, { expired: true });
});

afterAll(async () => {
  // See the note in customer-erp-integration.test.ts: rows left behind surface
  // as a foreign-key failure in the first file of the next run.
  await resetAll();
  setFlags({ FEATURE_CUSTOMER_AUTOPAY: flags.autopay });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Opting in
// ---------------------------------------------------------------------------

describe('opting in', () => {
  it('records the consent, not just the setting', async () => {
    const settings = await enableAutoPay(actor, { paymentMethodId, consentAccepted: true });

    expect(settings.status).toBe('ACTIVE');
    expect(settings.enabled).toBe(true);
    expect(settings.consentAcceptedAt).not.toBeNull();
    expect(settings.consentVersion).toBe(env.AUTOPAY_CONSENT_VERSION);

    const row = await prisma.customerAutoPaySetting.findUniqueOrThrow({
      where: { customerProfileId: actor.customerProfileId },
    });

    // The evidence a disputed charge is settled with. The address is hashed
    // rather than stored: it proves consent came from somewhere without making
    // this a worse table to leak.
    expect(row.consentIpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.consentIpHash).not.toBe('203.0.113.7');
    expect(row.consentUserAgent).toBe('Mozilla/5.0 (test)');
  });

  it('refuses without the tick', async () => {
    // The single most important refusal in this file. Charging somebody who did
    // not agree is not something a default value may bring about.
    await expect(
      enableAutoPay(actor, { paymentMethodId, consentAccepted: false }),
    ).rejects.toMatchObject({ code: 'AUTOPAY_CONSENT_REQUIRED' });

    expect(await prisma.customerAutoPaySetting.count()).toBe(0);
  });

  it('refuses a card that has expired', async () => {
    await expect(
      enableAutoPay(actor, { paymentMethodId: expiredMethodId, consentAccepted: true }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_PAYMENT_METHOD_INVALID' });
  });

  it('refuses a card that belongs to somebody else', async () => {
    const theirCard = await makeCard(rival);

    // A 404-shaped refusal: a card belonging to another customer is
    // indistinguishable from one that does not exist.
    await expect(
      enableAutoPay(actor, { paymentMethodId: theirCard, consentAccepted: true }),
    ).rejects.toMatchObject({ code: 'AUTOPAY_PAYMENT_METHOD_REQUIRED' });
  });

  it('refuses an amount limit with no currency', async () => {
    await expect(
      enableAutoPay(actor, {
        paymentMethodId,
        consentAccepted: true,
        maxTransactionMinor: 50_000n,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a threshold at or above the maximum', async () => {
    // Such a threshold can never fire - the charge is refused before anybody is
    // asked - so a customer who set one has misunderstood which field does
    // what.
    await expect(
      enableAutoPay(actor, {
        paymentMethodId,
        consentAccepted: true,
        maxTransactionMinor: 50_000n,
        approvalThresholdMinor: 50_000n,
        limitCurrency: 'EUR',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a limit of nothing, which is what switching it off is for', async () => {
    await expect(
      enableAutoPay(actor, {
        paymentMethodId,
        consentAccepted: true,
        maxTransactionMinor: 0n,
        limitCurrency: 'EUR',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('is refused entirely where the deployment has not enabled it', async () => {
    setFlags({ FEATURE_CUSTOMER_AUTOPAY: false });

    await expect(
      enableAutoPay(actor, { paymentMethodId, consentAccepted: true }),
    ).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
  });

  it('returns an off state for a customer who never opted in, rather than a 404', async () => {
    const settings = await getAutoPaySettings(actor.customerProfileId);

    expect(settings.status).toBe('DISABLED');
    expect(settings.enabled).toBe(false);
    // So the screen renders the off state without a special case.
    expect(settings.currentConsentVersion).toBe(env.AUTOPAY_CONSENT_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Changing the arrangement
// ---------------------------------------------------------------------------

describe('changing settings', () => {
  beforeEach(async () => {
    await enableAutoPay(actor, {
      paymentMethodId,
      consentAccepted: true,
      maxTransactionMinor: 100_000n,
      approvalThresholdMinor: 50_000n,
      limitCurrency: 'EUR',
    });
  });

  it('lowers a limit without asking for consent again', async () => {
    // Consent was given to the arrangement. Lowering a ceiling is not a change
    // that needs it renewed.
    const settings = await updateAutoPaySettings(actor, { maxTransactionMinor: 60_000n });

    expect(settings.maxTransactionMinor).toBe('60000');
    expect(settings.consentAcceptedAt).not.toBeNull();
  });

  it('refuses a maximum lowered below the threshold, which would strand it', async () => {
    // Below the threshold, "ask me about anything over 500" can never fire -
    // the charge is refused at 200 first - so the customer would believe they
    // were being consulted about charges that are simply going to fail.
    await expect(
      updateAutoPaySettings(actor, { maxTransactionMinor: 20_000n }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // And lowering both together is fine, which is what somebody actually
    // wanting a smaller arrangement does.
    const settings = await updateAutoPaySettings(actor, {
      maxTransactionMinor: 20_000n,
      approvalThresholdMinor: 10_000n,
    });

    expect(settings.maxTransactionMinor).toBe('20000');
    expect(settings.approvalThresholdMinor).toBe('10000');
  });

  it('validates a change against the merged state, not the incoming fields alone', async () => {
    // Clearing the currency while a maximum is still in place would otherwise
    // pass, and store an amount nothing could be compared to.
    await expect(updateAutoPaySettings(actor, { limitCurrency: null })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('records the before and after, so a raised ceiling can be traced', async () => {
    await updateAutoPaySettings(actor, { maxTransactionMinor: 500_000n });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'autopay.settings_updated' },
    });

    expect(JSON.stringify(entry.beforeJson)).toContain('100000');
    expect(JSON.stringify(entry.afterJson)).toContain('500000');
  });

  it('pauses without withdrawing consent, and resumes without asking again', async () => {
    const paused = await setAutoPayPaused(actor, true);
    expect(paused.status).toBe('PAUSED');
    // The reason pause and disable are two different things: a fortnight away
    // is not a change of mind.
    expect(paused.consentAcceptedAt).not.toBeNull();

    const resumed = await setAutoPayPaused(actor, false);
    expect(resumed.status).toBe('ACTIVE');
  });

  it('re-checks the card on resume', async () => {
    await setAutoPayPaused(actor, true);

    // The card was detached in Stripe's own portal during the pause.
    await prisma.customerPaymentMethod.update({
      where: { id: paymentMethodId },
      data: { status: 'DETACHED' },
    });

    // Resuming into an arrangement that cannot charge would only fail at the
    // next delivery, by which time nobody is watching.
    await expect(setAutoPayPaused(actor, false)).rejects.toMatchObject({
      code: 'SCHEDULE_PAYMENT_METHOD_INVALID',
    });
  });

  it('withdraws consent on disable, and keeps the limits for next time', async () => {
    const settings = await disableAutoPay(actor);

    expect(settings.status).toBe('DISABLED');
    expect(settings.consentAcceptedAt).toBeNull();
    expect(settings.consentWithdrawnAt).not.toBeNull();
    // The preferences survive a change of mind.
    expect(settings.maxTransactionMinor).toBe('100000');
  });

  it('lets a customer withdraw consent even where the feature was switched off', async () => {
    setFlags({ FEATURE_CUSTOMER_AUTOPAY: false });

    // A right to withdraw that depends on a deployment flag is not a right.
    const settings = await disableAutoPay(actor);
    expect(settings.status).toBe('DISABLED');
  });

  it('treats disabling something already off as done, not as an error', async () => {
    await disableAutoPay(actor);
    const settings = await disableAutoPay(actor);

    expect(settings.status).toBe('DISABLED');
  });
});

// ---------------------------------------------------------------------------
// The decision, at charge time
// ---------------------------------------------------------------------------

describe('evaluateAutoPay', () => {
  const euro = (minor: bigint) => ({
    customerProfileId: actor.customerProfileId,
    amountMinor: minor,
    currency: 'EUR',
  });

  it('permits a charge inside the limits', async () => {
    await enableAutoPay(actor, {
      paymentMethodId,
      consentAccepted: true,
      maxTransactionMinor: 100_000n,
      approvalThresholdMinor: 50_000n,
      limitCurrency: 'EUR',
    });

    const decision = await evaluateAutoPay(euro(40_000n));

    expect(decision).toMatchObject({ outcome: 'CHARGE', paymentMethodId });
  });

  it('refuses when there is no consent at all', async () => {
    const decision = await evaluateAutoPay(euro(1000n));

    expect(decision).toMatchObject({
      outcome: 'REFUSE',
      code: 'AUTOPAY_NOT_ENABLED',
    });
  });

  it('refuses while paused', async () => {
    await enableAutoPay(actor, { paymentMethodId, consentAccepted: true });
    await setAutoPayPaused(actor, true);

    const decision = await evaluateAutoPay(euro(1000n));
    expect(decision.outcome).toBe('REFUSE');
  });

  it('refuses once consent has been withdrawn', async () => {
    await enableAutoPay(actor, { paymentMethodId, consentAccepted: true });
    await disableAutoPay(actor);

    const decision = await evaluateAutoPay(euro(1000n));
    expect(decision).toMatchObject({ outcome: 'REFUSE', code: 'AUTOPAY_NOT_ENABLED' });
  });

  it('refuses when the card has since become unusable', async () => {
    await enableAutoPay(actor, { paymentMethodId, consentAccepted: true });

    await prisma.customerPaymentMethod.update({
      where: { id: paymentMethodId },
      data: { status: 'DETACHED' },
    });

    const decision = await evaluateAutoPay(euro(1000n));
    expect(decision).toMatchObject({
      outcome: 'REFUSE',
      code: 'AUTOPAY_PAYMENT_METHOD_REQUIRED',
    });
  });

  it('refuses above the maximum, rather than asking', async () => {
    await enableAutoPay(actor, {
      paymentMethodId,
      consentAccepted: true,
      maxTransactionMinor: 100_000n,
      limitCurrency: 'EUR',
    });

    const decision = await evaluateAutoPay(euro(100_001n));

    // The customer said no single charge should ever be this big. The right
    // answer is to stop, not to ask.
    expect(decision).toMatchObject({ outcome: 'REFUSE', code: 'AUTOPAY_LIMIT_EXCEEDED' });
  });

  it('asks above the threshold, rather than refusing', async () => {
    await enableAutoPay(actor, {
      paymentMethodId,
      consentAccepted: true,
      maxTransactionMinor: 100_000n,
      approvalThresholdMinor: 50_000n,
      limitCurrency: 'EUR',
    });

    const decision = await evaluateAutoPay(euro(60_000n));

    // A deferral, not a refusal. The distinction the whole two-limit design
    // exists for.
    expect(decision).toMatchObject({
      outcome: 'ASK_CUSTOMER',
      thresholdMinor: '50000',
      currency: 'EUR',
    });
  });

  it('charges exactly at the threshold, and asks one minor unit above it', async () => {
    await enableAutoPay(actor, {
      paymentMethodId,
      consentAccepted: true,
      approvalThresholdMinor: 50_000n,
      limitCurrency: 'EUR',
    });

    expect((await evaluateAutoPay(euro(50_000n))).outcome).toBe('CHARGE');
    expect((await evaluateAutoPay(euro(50_001n))).outcome).toBe('ASK_CUSTOMER');
  });

  it('refuses a charge in a currency the limits are not in', async () => {
    await enableAutoPay(actor, {
      paymentMethodId,
      consentAccepted: true,
      maxTransactionMinor: 100_000n,
      limitCurrency: 'EUR',
    });

    // 100000 JPY is about 600 EUR, not 1000. Converting a cap the customer
    // typed is a decision about their money that nothing here may make
    // silently.
    const decision = await evaluateAutoPay({
      customerProfileId: actor.customerProfileId,
      amountMinor: 100_000n,
      currency: 'JPY',
    });

    expect(decision).toMatchObject({ outcome: 'REFUSE', code: 'AUTOPAY_CURRENCY_MISMATCH' });
  });

  it('permits any currency when the customer set no limits of their own', async () => {
    await enableAutoPay(actor, { paymentMethodId, consentAccepted: true });

    const decision = await evaluateAutoPay({
      customerProfileId: actor.customerProfileId,
      amountMinor: 100_000n,
      currency: 'JPY',
    });

    expect(decision.outcome).toBe('CHARGE');
  });

  it('applies the operator’s ceiling on top of the customer’s', async () => {
    const original = env.AUTOPAY_PLATFORM_MAX_MINOR;
    Object.assign(env as unknown as { AUTOPAY_PLATFORM_MAX_MINOR: number }, {
      AUTOPAY_PLATFORM_MAX_MINOR: 10_000,
    });

    try {
      // No customer limit at all - the backstop still applies. It exists so a
      // pricing bug cannot become a five-figure charge nobody authorised.
      await enableAutoPay(actor, { paymentMethodId, consentAccepted: true });

      const decision = await evaluateAutoPay(euro(10_001n));
      expect(decision).toMatchObject({ outcome: 'REFUSE', code: 'AUTOPAY_LIMIT_EXCEEDED' });

      expect((await evaluateAutoPay(euro(10_000n))).outcome).toBe('CHARGE');
    } finally {
      Object.assign(env as unknown as { AUTOPAY_PLATFORM_MAX_MINOR: number }, {
        AUTOPAY_PLATFORM_MAX_MINOR: original,
      });
    }
  });

  it('never reads one customer’s authority for another', async () => {
    await enableAutoPay(actor, { paymentMethodId, consentAccepted: true });

    const decision = await evaluateAutoPay({
      customerProfileId: rival.customerProfileId,
      amountMinor: 1000n,
      currency: 'EUR',
    });

    expect(decision).toMatchObject({ outcome: 'REFUSE', code: 'AUTOPAY_NOT_ENABLED' });
  });

  it('refuses everything while the feature is switched off', async () => {
    await enableAutoPay(actor, { paymentMethodId, consentAccepted: true });
    setFlags({ FEATURE_CUSTOMER_AUTOPAY: false });

    const decision = await evaluateAutoPay(euro(1000n));
    expect(decision).toMatchObject({ outcome: 'REFUSE', code: 'FEATURE_DISABLED' });
  });
});

// ---------------------------------------------------------------------------
// Explaining a charge that did not happen
// ---------------------------------------------------------------------------

describe('the customer’s own time, size and scope limits', () => {
  const euro = (minor: bigint, extra: Record<string, unknown> = {}) => ({
    customerProfileId: actor.customerProfileId,
    amountMinor: minor,
    currency: 'EUR',
    ...extra,
  });

  const DAY = 86_400_000;

  async function makeSeller(slug: string): Promise<string> {
    const id = newId();
    await prisma.sellerAccount.create({
      data: {
        id,
        slug,
        legalName: `${slug} Ltd`,
        displayName: slug,
        displayNameNormalized: slug.replace(/[^a-z0-9]/g, ''),
        registrationCountry: 'IN',
        kind: 'WHOLESALER',
        status: 'APPROVED',
      },
    });
    return id;
  }

  async function makeCategory(slug: string): Promise<string> {
    const id = newId();
    await prisma.category.create({ data: { id, name: slug, slug, isActive: true } });
    return id;
  }

  /** An automatic charge already taken (or in flight) this period. */
  async function chargeTaken(
    owner: AutoPayActor,
    amountMinor: bigint,
    options: { status?: 'CAPTURED' | 'FAILED'; createdAt?: Date; key?: string } = {},
  ): Promise<void> {
    const connection =
      (await prisma.paymentProviderConnection.findFirst({ select: { id: true } })) ??
      (await prisma.paymentProviderConnection.create({
        data: { id: newId(), provider: 'STRIPE', mode: 'TEST', label: 'apx', credentialsEnc: 'x' },
      }));
    const orderId = newId();
    await prisma.order.create({
      data: {
        id: orderId,
        orderNumber: `UB-APX-${orderId.slice(-8)}`,
        customerProfileId: owner.customerProfileId,
        status: 'CONFIRMED',
        currency: 'EUR',
        subtotalMinor: amountMinor,
        discountMinor: 0n,
        taxMinor: 0n,
        shippingMinor: 0n,
        grandTotalMinor: amountMinor,
        shippingAddressJson: {},
        billingAddressJson: {},
      },
    });
    await prisma.paymentTransaction.create({
      data: {
        id: newId(),
        orderId,
        connectionId: connection.id,
        provider: 'STRIPE',
        mode: 'TEST',
        status: options.status ?? 'CAPTURED',
        amountMinor,
        capturedMinor: options.status === 'FAILED' ? 0n : amountMinor,
        currency: 'EUR',
        idempotencyKey: options.key ?? `occ:${newId()}`,
        ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      },
    });
  }

  describe('the end date', () => {
    it('refuses to set an end date that has already passed', async () => {
      await expect(
        enableAutoPay(actor, {
          paymentMethodId,
          consentAccepted: true,
          authorityExpiresAt: new Date(Date.now() - DAY),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('charges until the end date and refuses from the moment it arrives', async () => {
      const ends = new Date(Date.now() + 10 * DAY);
      await enableAutoPay(actor, { paymentMethodId, consentAccepted: true, authorityExpiresAt: ends });

      expect((await evaluateAutoPay(euro(1_000n, { now: new Date(ends.getTime() - 1) }))).outcome).toBe('CHARGE');
      expect(await evaluateAutoPay(euro(1_000n, { now: ends }))).toMatchObject({
        outcome: 'REFUSE',
        code: 'AUTOPAY_AUTHORITY_EXPIRED',
      });
      expect(await evaluateAutoPay(euro(1_000n, { now: new Date(ends.getTime() + 30 * DAY) }))).toMatchObject({
        outcome: 'REFUSE',
        code: 'AUTOPAY_AUTHORITY_EXPIRED',
      });
    });

    it('says the authority has ended, so the screen can ask for a new date', async () => {
      const ends = new Date(Date.now() + 5 * DAY);
      await enableAutoPay(actor, { paymentMethodId, consentAccepted: true, authorityExpiresAt: ends });
      await prisma.customerAutoPaySetting.updateMany({
        where: { customerProfileId: actor.customerProfileId },
        data: { authorityExpiresAt: new Date(Date.now() - 1_000) },
      });

      const view = await getAutoPaySettings(actor.customerProfileId);
      expect(view.authorityExpired).toBe(true);
    });

    it('carries on again once a new end date is set', async () => {
      await enableAutoPay(actor, {
        paymentMethodId,
        consentAccepted: true,
        authorityExpiresAt: new Date(Date.now() + DAY),
      });
      await prisma.customerAutoPaySetting.updateMany({
        where: { customerProfileId: actor.customerProfileId },
        data: { authorityExpiresAt: new Date(Date.now() - 1_000) },
      });
      expect((await evaluateAutoPay(euro(1_000n))).outcome).toBe('REFUSE');

      await updateAutoPaySettings(actor, { authorityExpiresAt: new Date(Date.now() + 30 * DAY) });
      expect((await evaluateAutoPay(euro(1_000n))).outcome).toBe('CHARGE');
    });
  });

  describe('the start date', () => {
    it('takes nothing before it and charges from it', async () => {
      const starts = new Date(Date.now() + 3 * DAY);
      await enableAutoPay(actor, { paymentMethodId, consentAccepted: true, authorityStartsAt: starts });

      expect(await evaluateAutoPay(euro(1_000n))).toMatchObject({
        outcome: 'REFUSE',
        code: 'AUTOPAY_AUTHORITY_NOT_STARTED',
      });
      expect((await evaluateAutoPay(euro(1_000n, { now: starts }))).outcome).toBe('CHARGE');
    });

    it('refuses a start date after the end date', async () => {
      await expect(
        enableAutoPay(actor, {
          paymentMethodId,
          consentAccepted: true,
          authorityStartsAt: new Date(Date.now() + 10 * DAY),
          authorityExpiresAt: new Date(Date.now() + 5 * DAY),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('the cap per period', () => {
    async function withCap(period: 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR' = 'MONTH'): Promise<void> {
      await enableAutoPay(actor, {
        paymentMethodId,
        consentAccepted: true,
        limitCurrency: 'EUR',
        periodCapMinor: 100_000n,
        capPeriod: period,
      });
    }

    it('charges while the period total stays inside the cap', async () => {
      await withCap();
      await chargeTaken(actor, 70_000n);

      expect((await evaluateAutoPay(euro(30_000n))).outcome).toBe('CHARGE');
    });

    it('asks the customer once this charge would take the period past the cap', async () => {
      await withCap();
      await chargeTaken(actor, 70_000n);

      expect(await evaluateAutoPay(euro(30_001n))).toMatchObject({
        outcome: 'ASK_CUSTOMER',
        code: 'AUTOPAY_PERIOD_CAP_REACHED',
        thresholdMinor: '100000',
        currency: 'EUR',
      });
    });

    it('shows the customer how much of the cap is used', async () => {
      await withCap();
      await chargeTaken(actor, 25_000n);

      const view = await getAutoPaySettings(actor.customerProfileId);
      expect(view).toMatchObject({ periodCapMinor: '100000', capPeriod: 'MONTH', periodUsedMinor: '25000' });
    });

    it('does not count a failed attempt, a payment made by hand, or somebody else’s charges', async () => {
      await withCap();
      await chargeTaken(actor, 90_000n, { status: 'FAILED' });
      await chargeTaken(actor, 90_000n, { key: 'checkout:by-hand' });
      await chargeTaken(rival, 90_000n);

      expect((await evaluateAutoPay(euro(100_000n))).outcome).toBe('CHARGE');
    });

    it('starts again in the next period', async () => {
      await withCap();
      await chargeTaken(actor, 100_000n);
      expect((await evaluateAutoPay(euro(1_000n))).outcome).toBe('ASK_CUSTOMER');

      const nextMonth = new Date(Date.now() + 40 * DAY);
      expect((await evaluateAutoPay(euro(1_000n, { now: nextMonth }))).outcome).toBe('CHARGE');
    });

    it('refuses a cap with no period or no currency', async () => {
      await expect(
        enableAutoPay(actor, { paymentMethodId, consentAccepted: true, limitCurrency: 'EUR', periodCapMinor: 100n }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        enableAutoPay(actor, { paymentMethodId, consentAccepted: true, periodCapMinor: 100n, capPeriod: 'MONTH' }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('the supplier and category scope', () => {
    it('charges an order that is wholly inside the chosen suppliers', async () => {
      const seller = await makeSeller('apx-inside');
      await enableAutoPay(actor, { paymentMethodId, consentAccepted: true, scopeSellerKeys: [seller] });

      const decision = await evaluateAutoPay(
        euro(1_000n, { lines: [{ sellerAccountId: seller, categoryId: null }] }),
      );
      expect(decision.outcome).toBe('CHARGE');
    });

    it('asks, rather than charging, when any line is from a supplier outside it', async () => {
      const inside = await makeSeller('apx-inside');
      const outside = await makeSeller('apx-outside');
      await enableAutoPay(actor, { paymentMethodId, consentAccepted: true, scopeSellerKeys: [inside] });

      const decision = await evaluateAutoPay(
        euro(1_000n, {
          lines: [
            { sellerAccountId: inside, categoryId: null },
            { sellerAccountId: outside, categoryId: null },
          ],
        }),
      );
      expect(decision).toMatchObject({ outcome: 'ASK_CUSTOMER', code: 'AUTOPAY_OUTSIDE_SCOPE' });
    });

    it('treats the marketplace’s own stock as a supplier the customer can allow or not', async () => {
      const seller = await makeSeller('apx-inside');
      await enableAutoPay(actor, { paymentMethodId, consentAccepted: true, scopeSellerKeys: [seller] });

      const own = [{ sellerAccountId: null, categoryId: null }];
      expect((await evaluateAutoPay(euro(1_000n, { lines: own }))).outcome).toBe('ASK_CUSTOMER');

      await updateAutoPaySettings(actor, { scopeSellerKeys: [seller, 'MARKETPLACE'] });
      expect((await evaluateAutoPay(euro(1_000n, { lines: own }))).outcome).toBe('CHARGE');
    });

    it('does not count "we did not look at the basket" as covered', async () => {
      const seller = await makeSeller('apx-inside');
      await enableAutoPay(actor, { paymentMethodId, consentAccepted: true, scopeSellerKeys: [seller] });

      expect((await evaluateAutoPay(euro(1_000n))).outcome).toBe('ASK_CUSTOMER');
    });

    it('limits by category the same way', async () => {
      const allowed = await makeCategory('apx-allowed');
      const other = await makeCategory('apx-other');
      await enableAutoPay(actor, { paymentMethodId, consentAccepted: true, scopeCategoryIds: [allowed] });

      const okay = await evaluateAutoPay(euro(1_000n, { lines: [{ sellerAccountId: null, categoryId: allowed }] }));
      const not = await evaluateAutoPay(euro(1_000n, { lines: [{ sellerAccountId: null, categoryId: other }] }));
      expect(okay.outcome).toBe('CHARGE');
      expect(not).toMatchObject({ outcome: 'ASK_CUSTOMER', code: 'AUTOPAY_OUTSIDE_SCOPE' });
    });

    it('treats no scope at all as every supplier and every category', async () => {
      await enableAutoPay(actor, { paymentMethodId, consentAccepted: true });
      const outside = await makeSeller('apx-anyone');

      const decision = await evaluateAutoPay(
        euro(1_000n, { lines: [{ sellerAccountId: outside, categoryId: null }] }),
      );
      expect(decision.outcome).toBe('CHARGE');
    });

    it('refuses a supplier or category that does not exist', async () => {
      await expect(
        enableAutoPay(actor, { paymentMethodId, consentAccepted: true, scopeSellerKeys: [newId()] }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        enableAutoPay(actor, { paymentMethodId, consentAccepted: true, scopeCategoryIds: [newId()] }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});

describe('withheld charges', () => {
  it('goes on the audit trail, because a missing delivery needs an explanation too', async () => {
    await enableAutoPay(actor, {
      paymentMethodId,
      consentAccepted: true,
      maxTransactionMinor: 10_000n,
      limitCurrency: 'EUR',
    });

    const decision = await evaluateAutoPay({
      customerProfileId: actor.customerProfileId,
      amountMinor: 99_999n,
      currency: 'EUR',
    });

    await recordWithheldCharge({
      customerProfileId: actor.customerProfileId,
      userId: actor.userId,
      orderId: null,
      amountMinor: 99_999n,
      currency: 'EUR',
      decision,
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'autopay.charge_withheld' },
    });

    const after = JSON.stringify(entry.afterJson);
    expect(after).toContain('AUTOPAY_LIMIT_EXCEEDED');
    // Money on the trail as a string, like everywhere else.
    expect(after).toContain('99999');
  });

  it('writes nothing when the charge was permitted', async () => {
    await enableAutoPay(actor, { paymentMethodId, consentAccepted: true });

    await recordWithheldCharge({
      customerProfileId: actor.customerProfileId,
      userId: actor.userId,
      orderId: null,
      amountMinor: 1000n,
      currency: 'EUR',
      decision: await evaluateAutoPay({
        customerProfileId: actor.customerProfileId,
        amountMinor: 1000n,
        currency: 'EUR',
      }),
    });

    expect(
      await prisma.auditLog.count({ where: { action: 'autopay.charge_withheld' } }),
    ).toBe(0);
  });
});

describe('retry preference', () => {
  it('turns a customer’s choice into a bounded number of attempts', () => {
    // NONE means fail and tell them: the choice of somebody who would rather
    // pay by hand than have a card retried behind their back.
    expect(retryAttemptsFor('NONE')).toBe(0);
    expect(retryAttemptsFor('ONCE')).toBe(1);
    // The platform's ceiling still applies on top. Repeated declines are read
    // by banks as a signal about the card itself.
    expect(retryAttemptsFor('STANDARD')).toBe(env.SCHEDULE_MAX_PAYMENT_ATTEMPTS - 1);
  });
});
