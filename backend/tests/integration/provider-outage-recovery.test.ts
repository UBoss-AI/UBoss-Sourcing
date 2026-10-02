/**
 * Money that is stuck because a provider went quiet (LIVE-017).
 *
 * `tests/unit/provider-fault-injection.test.ts` proves each adapter fails
 * with a typed, retry-aware error when its provider misbehaves. This file is
 * the next step: that the SYSTEM recovers, against the same scripted fake
 * provider on a real socket.
 *
 *   1. A refund the provider accepted, whose webhook never arrives. The
 *      refund poll (REFUND_POLL) asks the provider; while the provider is
 *      down the refund stays PROCESSING and nothing is guessed; once it
 *      answers, the refund settles exactly as the webhook would have settled
 *      it - status, the seller's settlement, an audit row - and a second pass
 *      changes nothing.
 *   2. A seller payout while the payout provider is down: the connection is
 *      torn down, then a 503 during lookup. Money stays reserved. Recovery
 *      confirms the original transfer without submitting another payout.
 *
 * Scheduled tracking is covered by carrier-tracking-poll.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { allocateOrder, evaluateHolds, runPayouts } from '../../src/modules/finance/escrow.service.js';
import { sellerFinance } from '../../src/modules/finance/finance-views.service.js';
import { pollProcessingRefunds, REFUND_POLL_AFTER_MINUTES } from '../../src/modules/payments/refund-poll.service.js';
import { StripeAdapter } from '../../src/modules/payments/stripe.adapter.js';
import { setPayoutAdapterForTests } from '../../src/modules/seller/payout.service.js';
import { stripeConnectAdapter } from '../../src/modules/seller/stripe-connect.adapter.js';
import { redirectingFetch, startFakeProvider, type FakeProvider } from '../support/fake-provider.js';

const PREFIX = 'por17-';
const ORDER_PREFIX = 'UB-POR17-';
const BUYER_EMAIL = 'por17-buyer@test.local';

type Flags = {
  FEATURE_ESCROW_LEDGER: boolean;
  SELLER_FUNDS_RELEASE_AFTER_DAYS: number | undefined;
  SELLER_FUNDS_RESERVE_BPS: number;
  SELLER_FUNDS_RESERVE_DAYS: number;
};
const mutable = env as unknown as Flags;
const saved: Flags = {
  FEATURE_ESCROW_LEDGER: mutable.FEATURE_ESCROW_LEDGER,
  SELLER_FUNDS_RELEASE_AFTER_DAYS: mutable.SELLER_FUNDS_RELEASE_AFTER_DAYS,
  SELLER_FUNDS_RESERVE_BPS: mutable.SELLER_FUNDS_RESERVE_BPS,
  SELLER_FUNDS_RESERVE_DAYS: mutable.SELLER_FUNDS_RESERVE_DAYS,
};

let fake: FakeProvider;
const realFetch = globalThis.fetch;
let buyerUserId = '';
let buyerProfileId = '';
let connectionId = '';
let createdConnection = false;
let counter = 0;

const tag = (): string => {
  counter += 1;
  return `${String(Date.now()).slice(-6)}${String(counter)}`;
};

async function seller(): Promise<string> {
  const id = newId();
  const t = tag();
  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `POR ${t} Ltd`,
      displayName: `POR ${t}`,
      displayNameNormalized: `por ${t}`,
      slug: `${PREFIX}${t}`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  await prisma.sellerPayoutAccountReference.create({
    data: {
      id: newId(),
      sellerAccountId: id,
      provider: 'stripe_connect',
      providerAccountId: `acct_por${t}`,
      state: 'ENABLED',
      payoutsEnabled: true,
    },
  });
  return id;
}

/** A paid order with one seller part, delivered ten days ago. */
async function paidOrder(sellerId: string, gross = 100_000n): Promise<{ orderId: string; groupId: string; paymentId: string }> {
  const t = tag();
  const fee = 10_000n;
  const feeTax = 1_800n;
  const orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `${ORDER_PREFIX}${t}`,
      customerProfileId: buyerProfileId,
      status: 'DELIVERED',
      currency: 'INR',
      subtotalMinor: gross,
      grandTotalMinor: gross,
      paidMinor: gross,
      billingAddressJson: { line1: '1 Road', city: 'Pune', postalCode: '411001', country: 'IN' },
      shippingAddressJson: { line1: '1 Road', city: 'Pune', postalCode: '411001', country: 'IN' },
      placedAt: new Date(Date.now() - 12 * 86_400_000),
    },
  });
  const groupId = newId();
  await prisma.sellerOrderGroup.create({
    data: {
      id: groupId,
      sellerAccountId: sellerId,
      orderId,
      sellerOrderNumber: `SO-POR-${t}`,
      status: 'DELIVERED',
      goodsTotalMinor: gross,
      commissionMinor: fee,
      currency: 'INR',
      deliveredAt: new Date(Date.now() - 10 * 86_400_000),
    },
  });
  await prisma.sellerOrderSettlement.create({
    data: {
      id: newId(),
      sellerOrderGroupId: groupId,
      sellerAccountId: sellerId,
      currency: 'INR',
      grossProceedsMinor: gross,
      feeBasisMinor: gross,
      platformFeeMinor: fee,
      platformFeeTaxMinor: feeTax,
      estimatedSettlementMinor: gross - fee - feeTax,
      feeTaxRatePercent: '18.000000',
      feeTaxLabel: 'GST',
      feeTaxVerified: true,
      breakdownJson: [],
    },
  });
  const paymentId = newId();
  await prisma.paymentTransaction.create({
    data: {
      id: paymentId,
      orderId,
      connectionId,
      provider: 'STRIPE',
      mode: 'TEST',
      status: 'CAPTURED',
      amountMinor: gross,
      capturedMinor: gross,
      currency: 'INR',
      method: 'card',
      providerPaymentId: `ch_por${t}`,
      idempotencyKey: newId(),
      capturedAt: new Date(Date.now() - 12 * 86_400_000),
    },
  });
  return { orderId, groupId, paymentId };
}

async function cleanUp(): Promise<void> {
  const sellers = (await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })).map((row) => row.id);
  const orders = (await prisma.order.findMany({ where: { orderNumber: { startsWith: ORDER_PREFIX } }, select: { id: true } })).map((row) => row.id);
  const refunds = (await prisma.refund.findMany({ where: { orderId: { in: orders } }, select: { id: true } })).map((row) => row.id);
  const entries = (
    await prisma.ledgerEntry.findMany({
      where: { OR: [{ orderId: { in: orders } }, { sellerAccountId: { in: sellers } }] },
      select: { id: true },
    })
  ).map((row) => row.id);
  await prisma.ledgerLine.deleteMany({ where: { entryId: { in: entries } } });
  await prisma.ledgerEntry.deleteMany({ where: { id: { in: entries } } });
  await prisma.ledgerAccount.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerFundHold.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.sellerPayout.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.auditLog.deleteMany({ where: { resourceId: { in: [...refunds, ...orders] } } });
  await prisma.refund.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.sellerOrderSettlement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerPayoutAccountReference.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: BUYER_EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: BUYER_EMAIL } });
}

beforeAll(async () => {
  await cleanUp();
  fake = await startFakeProvider();
  vi.stubGlobal('fetch', redirectingFetch({ 'https://api.stripe.com': fake.origin }, realFetch));

  buyerUserId = newId();
  await prisma.user.create({
    data: { id: buyerUserId, type: 'CUSTOMER', email: BUYER_EMAIL, emailNormalized: BUYER_EMAIL, status: 'ACTIVE' },
  });
  buyerProfileId = newId();
  await prisma.customerProfile.create({ data: { id: buyerProfileId, userId: buyerUserId, fullName: 'POR Buyer' } });

  // One STRIPE/TEST connection is a database invariant: reuse one if a
  // neighbouring file left it, and remove only the one made here.
  const existing = await prisma.paymentProviderConnection.findUnique({
    where: { provider_mode: { provider: 'STRIPE', mode: 'TEST' } },
    select: { id: true },
  });
  if (existing === null) {
    connectionId = newId();
    createdConnection = true;
    await prisma.paymentProviderConnection.create({
      data: { id: connectionId, provider: 'STRIPE', mode: 'TEST', label: 'por17-test', credentialsEnc: 'v1:x:y:z', isActive: false },
    });
  } else {
    connectionId = existing.id;
  }
});

afterEach(() => {
  Object.assign(mutable, saved);
  setPayoutAdapterForTests(null);
  fake.reset();
  fake.fallback = { status: 503, json: { error: { message: 'fake provider: nothing scripted' } } };
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await fake.close();
  await cleanUp();
  if (createdConnection) await prisma.paymentProviderConnection.deleteMany({ where: { id: connectionId } });
});

describe('a refund whose webhook never arrives', () => {
  it('stays processing while the provider is down, then settles once from the poll', async () => {
    const sellerId = await seller();
    const order = await paidOrder(sellerId);
    const providerRefundId = `re_por17_${newId().slice(-10)}`;
    const refundId = newId();
    // The provider accepted it: the order's refunded total moved then, and
    // the refund waits for the provider's final word.
    await prisma.refund.create({
      data: {
        id: refundId,
        orderId: order.orderId,
        paymentTransactionId: order.paymentId,
        provider: 'STRIPE',
        providerRefundId,
        amountMinor: 4_000n,
        currency: 'INR',
        reason: 'One carton damaged',
        status: 'PROCESSING',
        requestedById: buyerUserId,
        idempotencyKey: newId(),
      },
    });
    await prisma.order.update({ where: { id: order.orderId }, data: { refundedMinor: 4_000n } });

    const stripe = new StripeAdapter({ keyId: 'pk_test_por17', keySecret: 'sk_test_por17', webhookSecret: '' });
    const load = () => Promise.resolve({ provider: stripe, connectionId, kind: 'STRIPE' as const });
    const later = new Date(Date.now() + (REFUND_POLL_AFTER_MINUTES + 5) * 60_000);

    // Too soon: the webhook may simply be on its way.
    await pollProcessingRefunds(new Date(), load);
    expect(fake.requests.some((request) => request.path.includes(providerRefundId))).toBe(false);

    // The provider is down.
    const down = await pollProcessingRefunds(later, load);
    expect(down.unreachable).toBeGreaterThanOrEqual(1);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).status).toBe('PROCESSING');
    const settlementBefore = await prisma.sellerOrderSettlement.findFirstOrThrow({ where: { sellerOrderGroupId: order.groupId } });
    expect(settlementBefore.refundsAdjustmentsMinor).toBe(0n);

    // It comes back and says the refund succeeded.
    fake.fallback = { status: 200, json: { id: providerRefundId, object: 'refund', amount: 4_000, status: 'succeeded' } };
    const up = await pollProcessingRefunds(later, load);
    expect(up.succeeded).toBeGreaterThanOrEqual(1);

    const asked = fake.requests.filter((request) => request.path === `/v1/refunds/${providerRefundId}`);
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(asked.every((request) => request.method === 'GET')).toBe(true);

    const settled = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    expect(settled.status).toBe('SUCCEEDED');
    expect(settled.completedAt).not.toBeNull();

    // The seller's settlement carries the refund, as the webhook would have made it.
    const settlement = await prisma.sellerOrderSettlement.findFirstOrThrow({ where: { sellerOrderGroupId: order.groupId } });
    expect(settlement.refundsAdjustmentsMinor).toBe(4_000n);
    expect(settlement.estimatedSettlementMinor).toBeLessThan(settlementBefore.estimatedSettlementMinor);

    const audit = await prisma.auditLog.findMany({ where: { action: 'refund.completed', resourceId: refundId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.afterJson).toMatchObject({ status: 'SUCCEEDED', source: 'refund_poll' });

    // A second pass (or the webhook arriving late) changes nothing.
    const before = fake.requests.length;
    await pollProcessingRefunds(later, load);
    expect(fake.requests.slice(before).some((request) => request.path.includes(providerRefundId))).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'refund.completed', resourceId: refundId } })).toBe(1);
  });
});

describe('a seller payout while the payout provider is down', () => {
  it('keeps unknown funds reserved and reconciles the original transfer without sending again', async () => {
    Object.assign(mutable, {
      FEATURE_ESCROW_LEDGER: true,
      SELLER_FUNDS_RELEASE_AFTER_DAYS: 7,
      SELLER_FUNDS_RESERVE_BPS: 0,
      SELLER_FUNDS_RESERVE_DAYS: 30,
    });
    setPayoutAdapterForTests(stripeConnectAdapter('sk_test_por17_connect'));
    const sellerId = await seller();
    const order = await paidOrder(sellerId);
    await allocateOrder(order.orderId);
    await evaluateHolds();
    const share = (await sellerFinance(sellerId)).balances[0]?.availableMinor;
    expect(share).toBe('88200');

    // The connection is torn down before a byte comes back...
    fake.script({ reset: true });
    const torn = await runPayouts('por17-test', sellerId);
    expect(torn.failed).toHaveLength(1);
    expect((await sellerFinance(sellerId)).balances[0]).toMatchObject({ availableMinor: '0', inTransitMinor: share });
    const original = await prisma.sellerPayout.findFirstOrThrow({ where: { sellerAccountId: sellerId } });
    expect(original).toMatchObject({ status: 'PENDING', providerStatusRaw: 'UNKNOWN' });

    // ...then the provider answers 503.
    fake.script({ status: 503, json: { error: { message: 'Service unavailable' } } });
    const down = await runPayouts('por17-test', sellerId);
    expect(down.skipped).toHaveLength(1);
    expect((await sellerFinance(sellerId)).balances[0]).toMatchObject({ availableMinor: '0', inTransitMinor: share });

    expect(await prisma.sellerPayout.count({ where: { sellerAccountId: sellerId } })).toBe(1);
    expect(await prisma.sellerPayout.count({ where: { sellerAccountId: sellerId, status: 'FAILED' } })).toBe(0);

    // Recovered: one transfer, the whole balance, once.
    fake.script({ status: 200, json: { data: [{ id: 'tr_por17_recovered', transfer_group: original.reference, reversed: false,
      metadata: { reference: original.reference, amountMinor: share, currency: original.currency } }], has_more: false } });
    const paid = await runPayouts('por17-test', sellerId);
    expect(paid.paid).toHaveLength(1);
    expect(paid.paid[0]?.amountMinor).toBe(share);
    expect((await sellerFinance(sellerId)).balances[0]?.availableMinor).toBe('0');
    expect(await prisma.sellerPayout.count({ where: { sellerAccountId: sellerId, status: 'PAID' } })).toBe(1);

    // Nothing is left to send.
    const again = await runPayouts('por17-test', sellerId);
    expect(again.paid).toHaveLength(0);

    // Exactly one POST; later attempts only read the original reference.
    const transfers = fake.requests.filter((request) => request.method === 'POST' && request.path === '/v1/transfers');
    expect(transfers).toHaveLength(1);
    const keys = transfers.map((request) => String(request.headers['idempotency-key']));
    expect(new Set(keys).size).toBe(1);
    expect(keys.every((key) => key.startsWith('ledger-payout:'))).toBe(true);
    expect(keys[0]).toBe(original.idempotencyKey);
    expect(fake.requests.filter(request => request.method === 'GET' && request.path.includes(`transfer_group=${original.reference}`))).toHaveLength(2);
    expect(await prisma.ledgerEntry.count({ where: { payoutId: original.id, kind: 'REVERSAL' } })).toBe(0);

    // Every ledger entry for this seller still balances.
    const entries = await prisma.ledgerEntry.findMany({ where: { sellerAccountId: sellerId }, include: { lines: true } });
    for (const entry of entries) {
      expect(entry.lines.reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(0n);
    }
  });
});
