/**
 * Held funds, the transaction ledger and seller payouts (D13 facilitator
 * model; checklist Master rows 58, 59, 60, 61 and 43).
 *
 * No real Stripe call is made: the payout provider is a stand-in put in place
 * with `setPayoutAdapterForTests`, the same seam the Stripe Connect adapter
 * plugs into.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  allocateOrder,
  decideEarlyRelease,
  evaluateHolds,
  liftManualHold,
  placeManualHold,
  recordRefund,
  requestEarlyRelease,
  runPayouts,
  sweepPaymentsAndRefunds,
} from '../../src/modules/finance/escrow.service.js';
import {
  buyerPaymentProtection,
  listHolds,
  listLedgerOrders,
  orderLedger,
  refundsAndChargebacks,
  runReconciliation,
  sellerFinance,
  sellerHolds,
} from '../../src/modules/finance/finance-views.service.js';
import { listEntries, postEntry, reverseEntry } from '../../src/modules/finance/ledger.service.js';
import {
  setPayoutAdapterForTests,
  startPayoutOnboarding,
  type PayoutProviderAdapter,
} from '../../src/modules/seller/payout.service.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import { SellerRole, permissionsForSellerRole } from '../../src/domain/seller-permissions.js';

const PREFIX = 'escrow-test-';
const BUYER_EMAIL = 'escrow-buyer@test.local';
let buyerProfileId = '';
let connectionId = '';
let counter = 0;

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
function switchOn(reserveBps = 0): void {
  Object.assign(mutable, {
    FEATURE_ESCROW_LEDGER: true,
    SELLER_FUNDS_RELEASE_AFTER_DAYS: 7,
    SELLER_FUNDS_RESERVE_BPS: reserveBps,
    SELLER_FUNDS_RESERVE_DAYS: 30,
  });
}

const sentPayouts: { providerAccountId: string; amountMinor: bigint; idempotencyKey: string }[] = [];
let refusePayouts = false;
const fakeAdapter: PayoutProviderAdapter = {
  name: 'stripe_connect',
  isConfigured: true,
  startOnboarding: (input) =>
    Promise.resolve({
      url: 'https://connect.stripe.test/setup/abc',
      expiresAt: new Date(Date.now() + 300_000),
      providerAccountId: input.existingProviderAccountId ?? `acct_${input.sellerAccountId.slice(-10)}`,
    }),
  readAccount: (id) =>
    Promise.resolve({ state: 'ENABLED', providerAccountId: id, payoutsEnabled: true, pendingRequirements: [], bankName: 'Test Bank', accountLast4: '6789' }),
  sendPayout: (input) => {
    if (refusePayouts) return Promise.reject(new Error('Your destination account needs to have at least one of the following capabilities enabled: transfers'));
    sentPayouts.push({ providerAccountId: input.providerAccountId, amountMinor: input.amountMinor, idempotencyKey: input.idempotencyKey });
    return Promise.resolve({ providerPayoutId: `tr_${String(sentPayouts.length)}${input.idempotencyKey.slice(-6)}`, status: 'PAID' as const });
  },
  listTransfers: () => Promise.resolve([]),
};

function tag(): string {
  counter += 1;
  return `${String(Date.now()).slice(-6)}${String(counter)}`;
}

async function seller(payable = true): Promise<string> {
  const id = newId();
  const t = tag();
  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `Escrow ${t} Ltd`,
      displayName: `Escrow ${t}`,
      displayNameNormalized: `escrow ${t}`,
      slug: `${PREFIX}${t}`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  if (payable) {
    await prisma.sellerPayoutAccountReference.create({
      data: { id: newId(), sellerAccountId: id, provider: 'stripe_connect', providerAccountId: `acct_${t}`, state: 'ENABLED', payoutsEnabled: true },
    });
  }
  return id;
}

interface Fixture {
  orderId: string;
  groupId: string;
  paymentId: string;
}

async function paidOrder(
  sellerId: string,
  opts: { gross?: bigint; fee?: bigint; feeTax?: bigint; deliveredDaysAgo?: number | null } = {},
): Promise<Fixture> {
  const t = tag();
  const gross = opts.gross ?? 100_000n;
  const fee = opts.fee ?? 10_000n;
  const feeTax = opts.feeTax ?? 1_800n;
  const orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `ESC-T-${t}`,
      customerProfileId: buyerProfileId,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: gross,
      grandTotalMinor: gross,
      paidMinor: gross,
      billingAddressJson: { line1: '1 Road', city: 'Pune', postalCode: '411001', country: 'IN' },
      shippingAddressJson: { line1: '1 Road', city: 'Pune', postalCode: '411001', country: 'IN' },
      placedAt: new Date(),
    },
  });
  const delivered = opts.deliveredDaysAgo === undefined ? null : opts.deliveredDaysAgo;
  const groupId = newId();
  await prisma.sellerOrderGroup.create({
    data: {
      id: groupId,
      sellerAccountId: sellerId,
      orderId,
      sellerOrderNumber: `SO-${t}`,
      status: delivered === null ? 'SHIPPED' : 'DELIVERED',
      goodsTotalMinor: gross,
      commissionMinor: fee,
      currency: 'INR',
      deliveredAt: delivered === null ? null : new Date(Date.now() - delivered * 86_400_000),
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
      providerPaymentId: `pi_${t}`,
      idempotencyKey: newId(),
      capturedAt: new Date(),
    },
  });
  return { orderId, groupId, paymentId };
}

async function cleanUp(): Promise<void> {
  const sellers = (await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })).map((row) => row.id);
  const orders = (await prisma.order.findMany({ where: { orderNumber: { startsWith: 'ESC-T-' } }, select: { id: true } })).map((row) => row.id);
  const entries = (
    await prisma.ledgerEntry.findMany({
      where: { OR: [{ orderId: { in: orders } }, { sellerAccountId: { in: sellers } }] },
      select: { id: true },
    })
  ).map((row) => row.id);
  await prisma.ledgerLine.deleteMany({ where: { entryId: { in: entries } } });
  await prisma.ledgerEntry.deleteMany({ where: { id: { in: entries } } });
  await prisma.ledgerAccount.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.ledgerReconciliationRun.deleteMany({ where: { startedByLabel: 'escrow-test' } });
  await prisma.sellerFundReleaseRequest.deleteMany({ where: { fundHoldId: { in: (await prisma.sellerFundHold.findMany({ where: { orderId: { in: orders } }, select: { id: true } })).map((row) => row.id) } } });
  await prisma.sellerFundHold.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.sellerPayout.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.dispute.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.refund.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.sellerOrderSettlement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.inspectionRequirement.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerPayoutAccountReference.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.paymentProviderConnection.deleteMany({ where: { label: 'escrow-test' } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: BUYER_EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: BUYER_EMAIL } });
}

async function entriesOf(orderId: string) {
  return prisma.ledgerEntry.findMany({
    where: { orderId },
    include: { lines: { include: { account: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

beforeAll(async () => {
  await cleanUp();
  const user = await prisma.user.create({
    data: { id: newId(), type: 'CUSTOMER', email: BUYER_EMAIL, emailNormalized: BUYER_EMAIL, status: 'ACTIVE' },
  });
  buyerProfileId = newId();
  await prisma.customerProfile.create({ data: { id: buyerProfileId, userId: user.id, fullName: 'Escrow Buyer' } });
  connectionId = newId();
  await prisma.paymentProviderConnection.create({
    data: { id: connectionId, provider: 'STRIPE', mode: 'TEST', label: 'escrow-test', credentialsEnc: 'v1:x:y:z', isActive: false },
  });
  setPayoutAdapterForTests(fakeAdapter);
});

afterEach(() => {
  Object.assign(mutable, saved);
  refusePayouts = false;
});

afterAll(async () => {
  setPayoutAdapterForTests(null);
  await cleanUp();
});

describe('Row 59: one balanced ledger per order', () => {
  it('records the payment and allocates the seller share, fee and fee tax, once', async () => {
    switchOn();
    const sellerId = await seller();
    const f = await paidOrder(sellerId);

    expect(await allocateOrder(f.orderId)).toEqual({ captured: 1, allocated: 1 });
    expect(await allocateOrder(f.orderId)).toEqual({ captured: 0, allocated: 0 });

    const entries = await entriesOf(f.orderId);
    expect(entries.map((e) => e.kind)).toEqual(['PAYMENT_CAPTURED', 'SALE_ALLOCATED']);
    for (const entry of entries) {
      expect(entry.lines.reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(0n);
    }
    const ledger = await orderLedger(f.orderId);
    expect(ledger.summary).toMatchObject({
      grossMinor: '100000',
      platformFeeMinor: '10000',
      platformFeeTaxMinor: '1800',
      sellerShareMinor: '88200',
      heldMinor: '88200',
      refundsMinor: '0',
    });
    expect(ledger.holds[0]?.status).toBe('HELD');
    expect(ledger.holds[0]?.terms).toMatchObject({ releaseAfterDays: 7, requiresDelivery: true });
  });
});

describe('JOURNEY-052: one source for every movement of money', () => {
  it("books the operator's delivery to logistics, so buyer clearing nets to zero", async () => {
    switchOn();
    const sellerId = await seller();
    const f = await paidOrder(sellerId);
    // The buyer also paid 3,000 for delivery levels the operator controls.
    await prisma.sellerOrderSettlement.updateMany({ where: { sellerOrderGroupId: f.groupId }, data: { ubossDeliveryMinor: 3_000n } });
    await prisma.paymentTransaction.update({ where: { id: f.paymentId }, data: { amountMinor: 103_000n, capturedMinor: 103_000n } });
    // The fixture has no leg rows, so the order's shipping is left at zero: in a real
    // order the 3,000 is a UBOSS-owned leg, which the operator entry never counts twice.
    await prisma.order.update({ where: { id: f.orderId }, data: { grandTotalMinor: 103_000n, paidMinor: 103_000n } });

    await allocateOrder(f.orderId);
    const ledger = await orderLedger(f.orderId);
    expect(ledger.summary).toMatchObject({
      grossMinor: '103000',
      logisticsMinor: '3000',
      sellerShareMinor: '88200',
      unallocatedMinor: '0',
    });
    expect(ledger.inspection).toEqual({ ledgerMinor: '0', invoices: [] });
    for (const entry of await entriesOf(f.orderId)) {
      expect(entry.lines.reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(0n);
    }
  });

  it('reverses an entry line by line, once, and refuses a second reversal', async () => {
    switchOn();
    const sellerId = await seller();
    const f = await paidOrder(sellerId);
    await allocateOrder(f.orderId);
    const capture = (await entriesOf(f.orderId)).find((entry) => entry.kind === 'PAYMENT_CAPTURED');
    expect(capture).toBeDefined();
    const captureId = capture?.id ?? '';

    const reversalId = await prisma.$transaction((tx) => reverseEntry(tx, captureId, 'Test correction'));
    // Asking again returns the same reversal and writes nothing.
    expect(await prisma.$transaction((tx) => reverseEntry(tx, captureId, 'Again'))).toBe(reversalId);
    expect(await prisma.ledgerEntry.count({ where: { reversesEntryId: captureId } })).toBe(1);

    const reversal = await prisma.ledgerEntry.findUniqueOrThrow({
      where: { id: reversalId },
      include: { lines: { include: { account: true } } },
    });
    expect(reversal.kind).toBe('REVERSAL');
    const original = new Map(capture?.lines.map((line) => [line.account.code, line.amountMinor]));
    for (const line of reversal.lines) {
      expect(line.amountMinor).toBe(-(original.get(line.account.code) ?? 0n));
    }

    // A second reversal under any other key is refused by the database.
    await expect(
      prisma.$transaction((tx) =>
        postEntry(tx, {
          kind: 'REVERSAL',
          idempotencyKey: `second-reversal:${captureId}`,
          currency: 'INR',
          memo: 'A second undo',
          orderId: f.orderId,
          reversesEntryId: captureId,
          lines: [
            { code: 'PROVIDER_BALANCE', amountMinor: -1n },
            { code: 'BUYER_FUNDS_CLEARING', amountMinor: 1n },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it('keeps every entry balanced per currency across the whole ledger for these orders', async () => {
    const orders = (await prisma.order.findMany({ where: { orderNumber: { startsWith: 'ESC-T-' } }, select: { id: true } })).map(
      (row) => row.id,
    );
    const entries = await prisma.ledgerEntry.findMany({ where: { orderId: { in: orders } }, include: { lines: true } });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.lines.every((line) => line.currency === entry.currency)).toBe(true);
      expect(entry.lines.reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(0n);
    }
  });
});

describe('Row 60: release conditions and holds', () => {
  it('keeps money held until delivery and the acceptance window, then releases it less the reserve', async () => {
    switchOn(1_000);
    const sellerId = await seller();
    const early = await paidOrder(sellerId, { deliveredDaysAgo: 2 });
    const undelivered = await paidOrder(sellerId);
    const due = await paidOrder(sellerId, { deliveredDaysAgo: 10 });
    await sweepPaymentsAndRefunds();

    await evaluateHolds();
    const status = async (orderId: string) => (await prisma.sellerFundHold.findFirstOrThrow({ where: { orderId } })).status;
    expect(await status(early.orderId)).toBe('HELD');
    expect(await status(undelivered.orderId)).toBe('HELD');
    expect(await status(due.orderId)).toBe('RELEASED');

    const released = await prisma.sellerFundHold.findFirstOrThrow({ where: { orderId: due.orderId } });
    expect(released.reserveMinor).toBe(8_820n);
    expect(released.releasedMinor).toBe(79_380n);
    const conditions = released.conditionsJson as { key: string; met: boolean }[];
    expect(conditions.every((c) => c.met)).toBe(true);

    const finance = await sellerFinance(sellerId);
    expect(finance.balances[0]).toMatchObject({ availableMinor: '79380', reserveMinor: '8820', heldMinor: '176400', platformFeesMinor: '30000' });

    // The reserve joins the available balance once its period is over.
    const later = await evaluateHolds(new Date(Date.now() + 31 * 86_400_000));
    expect(later.reserves).toBeGreaterThanOrEqual(1);
    const freed = await prisma.sellerFundHold.findFirstOrThrow({ where: { orderId: due.orderId } });
    expect(freed.reserveReleasedAt).not.toBeNull();
    const entries = await entriesOf(due.orderId);
    expect(entries.filter((e) => e.kind === 'RESERVE_RELEASED')).toHaveLength(1);
  });

  it('puts money on hold while a dispute is open, and back when it closes', async () => {
    switchOn();
    const sellerId = await seller();
    const f = await paidOrder(sellerId, { deliveredDaysAgo: 10 });
    await allocateOrder(f.orderId);
    const disputeId = newId();
    await prisma.dispute.create({
      data: {
        id: disputeId,
        reference: `DSP${tag()}`.slice(0, 16),
        kind: 'CLAIM',
        status: 'AWAITING_SELLER',
        orderId: f.orderId,
        sellerOrderGroupId: f.groupId,
        sellerAccountId: sellerId,
        customerProfileId: buyerProfileId,
        reasonCode: 'NOT_AS_DESCRIBED',
        currency: 'INR',
      },
    });
    await evaluateHolds();
    const held = await prisma.sellerFundHold.findFirstOrThrow({ where: { orderId: f.orderId } });
    expect(held.status).toBe('ON_HOLD');
    expect(held.holdCode).toBe('DISPUTE');
    // A seller sees the hold, not the reason text staff wrote.
    const mine = await sellerHolds(sellerId, 1, 10);
    expect(mine.items[0]?.status).toBe('ON_HOLD');

    await prisma.dispute.update({ where: { id: disputeId }, data: { status: 'REJECTED' } });
    await evaluateHolds(); // lifts the dispute hold, then releases
    expect((await prisma.sellerFundHold.findFirstOrThrow({ where: { orderId: f.orderId } })).status).toBe('RELEASED');
  });

  it('waits for an inspection pass where one is required', async () => {
    switchOn();
    const sellerId = await seller();
    const f = await paidOrder(sellerId, { deliveredDaysAgo: 10 });
    await prisma.inspectionRequirement.create({
      data: {
        id: newId(),
        sellerOrderGroupId: f.groupId,
        orderId: f.orderId,
        sellerAccountId: sellerId,
        level: 'MANDATORY',
        status: 'REPORT_IN_REVIEW',
        reason: 'Category rule',
        inputsJson: {},
        evaluatedAt: new Date(),
      },
    });
    await allocateOrder(f.orderId);
    await evaluateHolds();
    const hold = await prisma.sellerFundHold.findFirstOrThrow({ where: { orderId: f.orderId } });
    expect(hold.status).toBe('HELD');
    expect((hold.conditionsJson as { key: string; met: boolean }[]).find((c) => c.key === 'INSPECTION_PASSED')?.met).toBe(false);

    await prisma.inspectionRequirement.updateMany({ where: { orderId: f.orderId }, data: { status: 'RELEASED' } });
    await evaluateHolds();
    expect((await prisma.sellerFundHold.findFirstOrThrow({ where: { orderId: f.orderId } })).status).toBe('RELEASED');
  });

  it('lets staff hold money by hand, and needs a second person to release it early', async () => {
    switchOn();
    const sellerId = await seller();
    const f = await paidOrder(sellerId);
    await allocateOrder(f.orderId);
    const hold = await prisma.sellerFundHold.findFirstOrThrow({ where: { orderId: f.orderId } });
    const alice = { userId: newId(), label: 'alice@ops.test' };
    const bob = { userId: newId(), label: 'bob@ops.test' };

    await placeManualHold(hold.id, 'Checking the invoice', alice);
    await expect(placeManualHold(hold.id, 'Again', alice)).rejects.toMatchObject({ code: 'FUND_HOLD_STATE_CONFLICT' });
    await liftManualHold(hold.id);

    const request = await requestEarlyRelease(hold.id, 'Buyer confirmed receipt by email', alice);
    await expect(requestEarlyRelease(hold.id, 'Twice', bob)).rejects.toMatchObject({ code: 'FUND_RELEASE_ALREADY_PENDING' });
    await expect(decideEarlyRelease(request.id, true, null, alice)).rejects.toMatchObject({ code: 'FUND_RELEASE_SAME_APPROVER' });
    await decideEarlyRelease(request.id, true, 'Agreed', bob);
    const released = await prisma.sellerFundHold.findUniqueOrThrow({ where: { id: hold.id } });
    expect(released.status).toBe('RELEASED');
    expect(released.releaseKind).toBe('MANUAL');
  });
});

describe('Row 60 / 43: payouts to the connected account', () => {
  it('sends the available balance once, settles it, and links the released holds', async () => {
    switchOn();
    const sellerId = await seller();
    const f = await paidOrder(sellerId, { deliveredDaysAgo: 10 });
    await allocateOrder(f.orderId);
    await evaluateHolds();

    const first = await runPayouts('escrow-test', sellerId);
    expect(first.paid).toHaveLength(1);
    expect(first.paid[0]?.amountMinor).toBe('88200');
    const second = await runPayouts('escrow-test', sellerId);
    expect(second.paid).toHaveLength(0);

    const payout = await prisma.sellerPayout.findFirstOrThrow({ where: { sellerAccountId: sellerId } });
    expect(payout.status).toBe('PAID');
    expect(payout.providerPayoutId).toMatch(/^tr_/);
    expect(sentPayouts.at(-1)?.idempotencyKey).toBe(`ledger-payout:${payout.id}`);
    expect((await prisma.sellerFundHold.findFirstOrThrow({ where: { orderId: f.orderId } })).payoutId).toBe(payout.id);

    const balances = (await sellerFinance(sellerId)).balances[0];
    expect(balances).toMatchObject({ availableMinor: '0', inTransitMinor: '0', paidOutMinor: '88200' });
  });

  it('puts the money back and records why when the provider refuses', async () => {
    switchOn();
    refusePayouts = true;
    const sellerId = await seller();
    const f = await paidOrder(sellerId, { deliveredDaysAgo: 10 });
    await allocateOrder(f.orderId);
    await evaluateHolds();
    const result = await runPayouts('escrow-test', sellerId);
    expect(result.failed).toHaveLength(1);
    const payout = await prisma.sellerPayout.findFirstOrThrow({ where: { sellerAccountId: sellerId } });
    expect(payout.status).toBe('FAILED');
    expect(payout.failureReason).toContain('capabilities');
    expect((await sellerFinance(sellerId)).balances[0]?.availableMinor).toBe('88200');
  });

  it('skips a seller who has not connected a payout account', async () => {
    switchOn();
    const sellerId = await seller(false);
    const f = await paidOrder(sellerId, { deliveredDaysAgo: 10 });
    await allocateOrder(f.orderId);
    await evaluateHolds();
    const result = await runPayouts('escrow-test', sellerId);
    expect(result.skipped[0]?.reason).toMatch(/not connected/);
  });
});

describe('Row 12: Stripe Connect onboarding stores the connected account', () => {
  it('keeps the acct id from the first link and reuses it', async () => {
    const sellerId = await seller(false);
    const membership: SellerMembership = {
      sellerAccountId: sellerId,
      memberId: newId(),
      customerProfileId: newId(),
      displayName: 'Escrow Owner',
      legalName: 'Escrow Ltd',
      slug: 'x',
      status: 'APPROVED',
      role: SellerRole.OWNER,
      permissions: permissionsForSellerRole(SellerRole.OWNER),
      hasLock: false,
      isTrading: true,
      isApplicationEditable: false,
      registrationCountry: 'IN',
      logoStorageKey: null,
    };
    const urls = { returnUrl: 'https://shop.test/seller/payments', refreshUrl: 'https://shop.test/seller/payments' };
    const link = await startPayoutOnboarding(membership, urls);
    expect(link.url).toContain('connect.stripe.test');
    const row = await prisma.sellerPayoutAccountReference.findUniqueOrThrow({ where: { sellerAccountId: sellerId } });
    expect(row.provider).toBe('stripe_connect');
    expect(row.providerAccountId).toBe(link.providerAccountId);
    expect(row.state).toBe('REQUIREMENTS_DUE');
    const again = await startPayoutOnboarding(membership, urls);
    expect(again.providerAccountId).toBe(row.providerAccountId);
  });
});

describe('Row 61: refunds and chargebacks reach the ledger', () => {
  it('posts a refund and charges the seller the part their order carries', async () => {
    switchOn();
    const sellerId = await seller();
    const f = await paidOrder(sellerId);
    await allocateOrder(f.orderId);
    const refundId = newId();
    await prisma.refund.create({
      data: {
        id: refundId,
        orderId: f.orderId,
        paymentTransactionId: f.paymentId,
        provider: 'STRIPE',
        amountMinor: 20_000n,
        currency: 'INR',
        reason: 'Damaged',
        status: 'SUCCEEDED',
        requestedById: newId(),
        idempotencyKey: newId(),
        completedAt: new Date(),
      },
    });
    await prisma.sellerOrderSettlement.updateMany({ where: { sellerOrderGroupId: f.groupId }, data: { refundsAdjustmentsMinor: 20_000n } });

    expect((await refundsAndChargebacks(1, 100)).refunds.find((r) => r.id === refundId)?.accounting).toBe('NOT_POSTED');
    await sweepPaymentsAndRefunds();
    await sweepPaymentsAndRefunds();

    const ledger = await orderLedger(f.orderId);
    expect(ledger.summary).toMatchObject({ refundsMinor: '20000', refundsChargedToSellersMinor: '20000', heldMinor: '68200' });
    expect(ledger.refunds[0]?.accounting).toBe('POSTED');
    expect(ledger.entries.filter((e) => e.kind === 'REFUND_ISSUED')).toHaveLength(1);
  });

  it('posts a lost chargeback as money taken back, with its accounting status', async () => {
    switchOn();
    const sellerId = await seller();
    const f = await paidOrder(sellerId);
    await allocateOrder(f.orderId);
    const refundId = newId();
    await prisma.refund.create({
      data: {
        id: refundId,
        orderId: f.orderId,
        paymentTransactionId: f.paymentId,
        provider: 'STRIPE',
        amountMinor: 100_000n,
        currency: 'INR',
        reason: 'Chargeback lost (dp_x)',
        status: 'SUCCEEDED',
        requestedById: '0'.repeat(26),
        idempotencyKey: `chargeback-lost:dp_${tag()}`,
        completedAt: new Date(),
      },
    });
    const disputeId = newId();
    await prisma.dispute.create({
      data: {
        id: disputeId,
        reference: `CB${tag()}`.slice(0, 16),
        kind: 'CHARGEBACK',
        status: 'LOST',
        orderId: f.orderId,
        customerProfileId: buyerProfileId,
        reasonCode: 'fraudulent',
        providerDisputeId: `dp_${tag()}`,
        paymentTransactionId: f.paymentId,
        currency: 'INR',
        disputedAmountMinor: 100_000n,
        refundId,
      },
    });
    await prisma.$transaction(async (tx) => {
      await recordRefund(tx, refundId, 'CHARGEBACK_LOST', disputeId);
    });
    const ledger = await orderLedger(f.orderId);
    expect(ledger.entries.some((e) => e.kind === 'CHARGEBACK_LOST' && e.disputeId === disputeId)).toBe(true);
    expect(ledger.chargebacks[0]?.accounting).toBe('LOSS_POSTED');
  });
});

describe('Row 59: the finance lists', () => {
  it('lists orders with their summary, entries by kind, and held funds by status', async () => {
    switchOn();
    const sellerId = await seller();
    const f = await paidOrder(sellerId);
    await allocateOrder(f.orderId);
    const orders = await listLedgerOrders(1, 100);
    const row = orders.items.find((item) => item.orderId === f.orderId);
    expect(row).toMatchObject({ settlement: 'HELD', grossMinor: '100000', platformFeeMinor: '10000' });
    const entries = await listEntries({ orderId: f.orderId, kind: 'SALE_ALLOCATED', page: 1, pageSize: 10 });
    expect(entries.total).toBe(1);
    expect(entries.items[0]?.lines.length).toBe(4);
    const holds = await listHolds('HELD', 1, 100);
    expect(holds.items.some((hold) => hold.orderId === f.orderId)).toBe(true);
  });
});

describe('Row 59: reconciliation', () => {
  it('matches captured payments and reports a payment missing from the ledger', async () => {
    switchOn();
    const sellerId = await seller();
    const posted = await paidOrder(sellerId);
    await allocateOrder(posted.orderId);
    const missing = await paidOrder(sellerId);
    const run = await runReconciliation(new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000), 'escrow-test');
    expect(run.status).toBe('COMPLETED');
    expect(run.matchedCount).toBeGreaterThan(0);
    const payment = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: missing.paymentId } });
    expect(run.items.some((i) => i.kind === 'MISSING_IN_LEDGER' && i.providerReference === payment.providerPaymentId)).toBe(true);
  });
});

describe('Row 58: the buyer sees how the payment is held', () => {
  it('shows method, status, release terms and per-seller milestones, never the seller fee', async () => {
    switchOn();
    const sellerId = await seller();
    const f = await paidOrder(sellerId, { deliveredDaysAgo: 1 });
    await allocateOrder(f.orderId);
    await evaluateHolds();
    const view = await buyerPaymentProtection(f.orderId);
    expect(view.payment).toMatchObject({ status: 'CAPTURED', method: 'card', provider: 'STRIPE' });
    expect(view.protectionEnabled).toBe(true);
    expect(view.releaseTerms.releaseAfterDays).toBe(7);
    expect(view.sellers[0]).toMatchObject({ fundsStatus: 'HELD' });
    expect(view.sellers[0]?.conditions.find((c) => c.key === 'DELIVERED')?.met).toBe(true);
    expect(view.receipts.some((r) => r.kind === 'payment')).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/platformFee|allocatedMinor|commission/i);
  });
});
