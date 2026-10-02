/**
 * Seller settlement statements: closing a period into one statement per
 * seller and currency.
 *
 * Nothing wrote a statement before this, so the Seller Hub's statements page
 * was always empty. What this file holds the writer to:
 *
 *   - off unless the operator turns it on, and no order counts until its
 *     return window (the operator's own setting) has passed;
 *   - every figure is copied from the order's own settlement record, and the
 *     header adds up: gross - commission - fees - refunds + adjustments = net,
 *     which is also the sum of the lines;
 *   - an order is sold on exactly one statement, however often, however
 *     concurrently, the period is closed;
 *   - a refund after the statement is carried on the next one, as the
 *     difference only, and a refund given back is added back;
 *   - a statement moves no money: paying it is still refused.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { createPayout } from '../../src/modules/seller/payout.service.js';
import {
  closeSettlementPeriod,
  lastClosedPeriod,
} from '../../src/modules/seller/settlement-statement.service.js';
import {
  SETTLEMENT_CSV_HEADER,
  sellerFundsSummary,
  settlementStatementCsv,
} from '../../src/modules/seller/settlement-export.service.js';

const PREFIX = 'stl-test-';
const BUYER_EMAIL = 'stl-buyer@test.local';
let buyerProfileId = '';
let counter = 0;

type Flags = {
  FEATURE_SELLER_SETTLEMENT_STATEMENTS: boolean;
  SELLER_SETTLEMENT_PERIOD: 'WEEKLY' | 'MONTHLY';
  SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS: number | undefined;
};
const mutable = env as unknown as Flags;
const saved: Flags = {
  FEATURE_SELLER_SETTLEMENT_STATEMENTS: mutable.FEATURE_SELLER_SETTLEMENT_STATEMENTS,
  SELLER_SETTLEMENT_PERIOD: mutable.SELLER_SETTLEMENT_PERIOD,
  SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS: mutable.SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS,
};
const switchOn = (): void => {
  Object.assign(mutable, {
    FEATURE_SELLER_SETTLEMENT_STATEMENTS: true,
    SELLER_SETTLEMENT_PERIOD: 'MONTHLY',
    SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS: 14,
  });
};

async function seller(): Promise<string> {
  counter += 1;
  const id = newId();
  const tag = `${String(Date.now()).slice(-6)}${String(counter)}`;
  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `Statement ${tag} Private Limited`,
      displayName: `Statement ${tag}`,
      displayNameNormalized: `statement ${tag}`,
      slug: `${PREFIX}${tag}`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  return id;
}

interface OrderFigures {
  status?: 'DELIVERED' | 'SHIPPED';
  deliveredAt?: string;
  currency?: string;
  gross?: bigint;
  delivery?: bigint;
  fee?: bigint;
  feeTax?: bigint;
}

async function order(sellerId: string, figures: OrderFigures = {}): Promise<{ groupId: string; number: string }> {
  counter += 1;
  const tag = `${String(Date.now()).slice(-6)}${String(counter)}`;
  const currency = figures.currency ?? 'INR';
  const gross = figures.gross ?? 100_000n;
  const delivery = figures.delivery ?? 0n;
  const fee = figures.fee ?? 10_000n;
  const feeTax = figures.feeTax ?? 1_800n;
  const orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `STL-T-${tag}`,
      customerProfileId: buyerProfileId,
      status: 'DELIVERED',
      currency,
      subtotalMinor: gross,
      grandTotalMinor: gross + delivery,
      paidMinor: gross + delivery,
      billingAddressJson: { line1: '4 Hospital Road', city: 'Pune', postalCode: '411001', country: 'IN' },
      shippingAddressJson: { line1: '4 Hospital Road', city: 'Pune', postalCode: '411001', country: 'IN' },
      placedAt: new Date('2026-09-20T10:00:00Z'),
    },
  });
  const groupId = newId();
  const number = `SO-${tag}`;
  const status = figures.status ?? 'DELIVERED';
  await prisma.sellerOrderGroup.create({
    data: {
      id: groupId,
      sellerAccountId: sellerId,
      orderId,
      sellerOrderNumber: number,
      status,
      goodsTotalMinor: gross,
      commissionMinor: fee,
      currency,
      deliveredAt: status === 'DELIVERED' ? new Date(figures.deliveredAt ?? '2026-10-05T12:00:00Z') : null,
    },
  });
  await prisma.sellerOrderSettlement.create({
    data: {
      id: newId(),
      sellerOrderGroupId: groupId,
      sellerAccountId: sellerId,
      currency,
      grossProceedsMinor: gross,
      sellerDeliveryProceedsMinor: delivery,
      feeBasisMinor: gross,
      platformFeeMinor: fee,
      platformFeeTaxMinor: feeTax,
      estimatedSettlementMinor: gross + delivery - fee - feeTax,
      feeTaxRatePercent: '18.000000',
      feeTaxLabel: 'GST',
      feeTaxVerified: true,
      breakdownJson: [],
    },
  });
  return { groupId, number };
}

async function statements(sellerId: string) {
  return prisma.sellerSettlement.findMany({
    where: { sellerAccountId: sellerId },
    orderBy: [{ periodStart: 'asc' }, { currency: 'asc' }],
    include: { lines: { orderBy: [{ kind: 'asc' }, { amountMinor: 'asc' }] } },
  });
}

async function cleanUp(): Promise<void> {
  const sellers = (
    await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.inspectionAgencyInvoice.deleteMany({ where: { agency: { name: { startsWith: PREFIX } } } });
  await prisma.inspectionJob.deleteMany({ where: { agency: { name: { startsWith: PREFIX } } } });
  await prisma.inspectionRequirement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.inspectionAgency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.sellerSettlementLine.deleteMany({ where: { settlement: { sellerAccountId: { in: sellers } } } });
  await prisma.sellerSettlement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOrderSettlement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'STL-T-' } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'seller-settlement:' } } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: BUYER_EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: BUYER_EMAIL } });
}

beforeAll(async () => {
  await cleanUp();
  const buyer = await prisma.user.create({
    data: { id: newId(), type: 'CUSTOMER', email: BUYER_EMAIL, emailNormalized: BUYER_EMAIL, status: 'ACTIVE' },
  });
  buyerProfileId = newId();
  await prisma.customerProfile.create({ data: { id: buyerProfileId, userId: buyer.id, fullName: 'A Buyer' } });
});

afterEach(() => {
  Object.assign(mutable, saved);
});

afterAll(async () => {
  await cleanUp();
});

const NOVEMBER = new Date('2026-11-03T08:00:00Z'); // closes October
const DECEMBER = new Date('2026-12-02T08:00:00Z'); // closes November
const JANUARY = new Date('2027-01-04T08:00:00Z'); // closes December

describe('the period being closed', () => {
  it('is the last whole calendar month, or the last whole Monday-to-Monday week, in UTC', () => {
    expect(lastClosedPeriod(NOVEMBER, 'MONTHLY')).toEqual({
      start: new Date('2026-10-01T00:00:00Z'),
      end: new Date('2026-11-01T00:00:00Z'),
    });
    // 2026-11-03 is a Tuesday; the last whole week ended on Monday the 2nd.
    expect(lastClosedPeriod(NOVEMBER, 'WEEKLY')).toEqual({
      start: new Date('2026-10-26T00:00:00Z'),
      end: new Date('2026-11-02T00:00:00Z'),
    });
    // January's previous month is last year's December.
    expect(lastClosedPeriod(new Date('2027-01-15T00:00:00Z'), 'MONTHLY').start).toEqual(
      new Date('2026-12-01T00:00:00Z'),
    );
  });
});

describe('closing a period', () => {
  it('does nothing unless the operator switched statements on', async () => {
    const sellerId = await seller();
    await order(sellerId);

    const outcome = await closeSettlementPeriod(NOVEMBER);
    expect(outcome.skipped).toBe(true);
    expect(await statements(sellerId)).toHaveLength(0);
  });

  it('writes one statement per currency from the orders whose return window has passed, and it adds up', async () => {
    switchOn();
    const sellerId = await seller();
    const early = await order(sellerId, { deliveredAt: '2026-10-05T12:00:00Z', delivery: 5_000n });
    await order(sellerId, { deliveredAt: '2026-10-25T12:00:00Z' }); // inside the 14-day window at month end
    await order(sellerId, { status: 'SHIPPED' }); // not delivered
    await order(sellerId, { deliveredAt: '2026-10-02T12:00:00Z', currency: 'EUR', gross: 20_000n, fee: 2_000n, feeTax: 0n });

    await closeSettlementPeriod(NOVEMBER);
    const written = await statements(sellerId);

    expect(written.map((row) => row.currency)).toEqual(['EUR', 'INR']);
    const inr = written.find((row) => row.currency === 'INR');
    expect(inr).toMatchObject({
      status: 'PENDING_PAYOUT',
      periodStart: new Date('2026-10-01T00:00:00Z'),
      periodEnd: new Date('2026-11-01T00:00:00Z'),
      grossMinor: 105_000n, // goods 100,000 + the seller's own delivery 5,000
      commissionMinor: 11_800n, // fee 10,000 + tax on it 1,800
      refundsMinor: 0n,
      netPayableMinor: 93_200n,
    });
    expect(inr?.reference).toMatch(/^STL-2026-10-\d{4}$/);
    // MariaDB orders an enum by declaration, not by name; compare as a sorted list.
    const byKind = (inr?.lines ?? []).map((line) => [line.kind, line.amountMinor] as const).sort((x, y) =>
      x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1,
    );
    expect(byKind).toEqual([
      ['COMMISSION', -10_000n],
      // The tax on the fee is a line of its own (JOURNEY-034).
      ['COMMISSION_TAX', -1_800n],
      ['SALE', 100_000n],
      ['SHIPPING_CHARGE', 5_000n],
    ]);
    // Language-neutral: the Seller Hub labels the line by its kind.
    expect(new Set(inr?.lines.map((line) => line.description))).toEqual(new Set([early.number]));

    for (const statement of written) {
      const sum = statement.lines.reduce((total, line) => total + line.amountMinor, 0n);
      expect(sum).toBe(statement.netPayableMinor);
      expect(
        statement.grossMinor - statement.commissionMinor - statement.processingFeeMinor - statement.refundsMinor + statement.adjustmentsMinor,
      ).toBe(statement.netPayableMinor);
    }
  });

  it('writes nothing more when the same period is closed again, or twice at once', async () => {
    switchOn();
    const sellerId = await seller();
    await order(sellerId);

    await closeSettlementPeriod(NOVEMBER);
    const again = await closeSettlementPeriod(NOVEMBER);
    await Promise.allSettled([closeSettlementPeriod(NOVEMBER), closeSettlementPeriod(NOVEMBER)]);

    const written = await statements(sellerId);
    expect(written).toHaveLength(1);
    expect(written[0]?.lines.filter((line) => line.kind === 'SALE')).toHaveLength(1);
    expect(again.alreadyClosed).toBeGreaterThanOrEqual(1);
  });
});

describe('the months that follow', () => {
  it('sells an order once, carries a later refund as the difference, and adds back a refund given back', async () => {
    switchOn();
    const sellerId = await seller();
    const first = await order(sellerId, { deliveredAt: '2026-10-05T12:00:00Z' });
    const late = await order(sellerId, { deliveredAt: '2026-10-25T12:00:00Z' });

    await closeSettlementPeriod(NOVEMBER);

    // After October closed: 30,000 of the first order is refunded.
    await prisma.sellerOrderSettlement.update({
      where: { sellerOrderGroupId: first.groupId },
      data: { refundsAdjustmentsMinor: 30_000n },
    });
    await closeSettlementPeriod(DECEMBER);

    // Then 20,000 of that refund fails at the provider and is given back.
    await prisma.sellerOrderSettlement.update({
      where: { sellerOrderGroupId: first.groupId },
      data: { refundsAdjustmentsMinor: 10_000n },
    });
    await closeSettlementPeriod(JANUARY);
    // And nothing changes after that: no fourth statement.
    await closeSettlementPeriod(new Date('2027-02-03T08:00:00Z'));

    const [october, november, december, ...rest] = await statements(sellerId);
    expect(rest).toHaveLength(0);

    expect(october?.lines.filter((line) => line.kind === 'SALE').map((line) => line.orderGroupId)).toEqual([
      first.groupId,
    ]);

    // November: the late order, now past its window, and the refund on the first.
    expect(november?.lines.filter((line) => line.kind === 'SALE').map((line) => line.orderGroupId)).toEqual([
      late.groupId,
    ]);
    const novemberRefund = november?.lines.find((line) => line.kind === 'REFUND');
    expect(novemberRefund).toMatchObject({ orderGroupId: first.groupId, amountMinor: -30_000n });
    expect(november?.refundsMinor).toBe(30_000n);

    // December: only the 20,000 given back, as an adjustment.
    expect(december?.lines.map((line) => [line.kind, line.amountMinor])).toEqual([['REFUND', 20_000n]]);
    expect(december).toMatchObject({ grossMinor: 0n, refundsMinor: 0n, adjustmentsMinor: 20_000n, netPayableMinor: 20_000n });

    // Across all three, the first order was sold once and refunded 10,000 net.
    const firstLines = [october, november, december].flatMap((row) => row?.lines ?? []).filter((line) => line.orderGroupId === first.groupId);
    expect(firstLines.filter((line) => line.kind === 'SALE')).toHaveLength(1);
    expect(firstLines.filter((line) => line.kind === 'REFUND').reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(-10_000n);
  });

  it('moves no money: a closed statement still cannot be paid while no payout provider exists', async () => {
    switchOn();
    const sellerId = await seller();
    await order(sellerId);
    await closeSettlementPeriod(NOVEMBER);

    const [statement] = await statements(sellerId);
    await expect(createPayout(sellerId, statement?.id ?? '', 'PO-STL-TEST')).rejects.toMatchObject({
      code: 'SELLER_PAYOUT_PROVIDER_UNCONFIGURED',
    });
    expect(await prisma.sellerPayout.count({ where: { sellerAccountId: sellerId } })).toBe(0);
  });
});

describe('inspection fees the seller pays (JOURNEY-034)', () => {
  async function sellerPaidInvoice(
    sellerId: string,
    groupId: string,
    amountMinor: bigint,
    status: 'SUBMITTED' | 'APPROVED',
  ): Promise<string> {
    const group = await prisma.sellerOrderGroup.findUniqueOrThrow({ where: { id: groupId }, select: { orderId: true } });
    const agencyId = newId();
    await prisma.inspectionAgency.create({
      data: {
        id: agencyId,
        name: `${PREFIX}agency-${agencyId.slice(-6)}`,
        legalName: `${PREFIX}agency Ltd`,
        country: 'IN',
        contactEmail: `${agencyId.slice(-8).toLowerCase()}@stl-agency.test.local`,
      },
    });
    // A seller order has one requirement; a second invoice reuses it.
    const existing = await prisma.inspectionRequirement.findFirst({ where: { sellerOrderGroupId: groupId }, select: { id: true } });
    const requirementId = existing?.id ?? newId();
    if (existing === null) await prisma.inspectionRequirement.create({
      data: {
        id: requirementId,
        sellerOrderGroupId: groupId,
        orderId: group.orderId,
        sellerAccountId: sellerId,
        level: 'BUYER_REQUESTED',
        status: 'BOOKED',
        reason: 'Buyer asked',
        inputsJson: {},
        evaluatedAt: new Date(),
      },
    });
    const jobId = newId();
    await prisma.inspectionJob.create({
      data: {
        id: jobId,
        jobNumber: `${PREFIX}${jobId.slice(-10)}`,
        requirementId,
        agencyId,
        status: 'COMPLETED',
        bookedByParty: 'SELLER',
        bookedByLabel: 'Seller',
        payer: 'SELLER',
        inspectionPointType: 'SELLER_PREMISES',
        inspectionPointJson: { address: 'Plant 1' },
        scheduledFor: new Date('2026-10-01T09:00:00Z'),
        language: 'en',
        standard: 'ISO 2859-1',
        scopeJson: {},
        planSnapshotJson: {},
        lotSize: 100,
        samplingJson: {},
        acceptDueAt: new Date('2026-09-28T09:00:00Z'),
        reportDueAt: new Date('2026-10-03T09:00:00Z'),
      },
    });
    const invoiceId = newId();
    await prisma.inspectionAgencyInvoice.create({
      data: {
        id: invoiceId,
        jobId,
        agencyId,
        invoiceNumber: `INV-${invoiceId.slice(-8)}`,
        amountMinor,
        currency: 'INR',
        payer: 'SELLER',
        status,
        submittedByMemberId: newId(),
        decidedAt: status === 'APPROVED' ? new Date('2026-10-10T09:00:00Z') : null,
      },
    });
    return invoiceId;
  }

  it('deducts an approved seller-paid invoice once, on its own line, and leaves a pending one alone', async () => {
    switchOn();
    const sellerId = await seller();
    const sold = await order(sellerId);
    const approved = await sellerPaidInvoice(sellerId, sold.groupId, 4_000n, 'APPROVED');
    await sellerPaidInvoice(sellerId, sold.groupId, 9_000n, 'SUBMITTED');

    await closeSettlementPeriod(NOVEMBER);
    await closeSettlementPeriod(DECEMBER);

    const all = await statements(sellerId);
    const fees = all.flatMap((row) => row.lines).filter((line) => line.kind === 'INSPECTION_FEE');
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({ amountMinor: -4_000n, sourceRef: approved, orderGroupId: sold.groupId });

    const [october] = all;
    // 100,000 - 10,000 fee - 1,800 tax - 4,000 inspection.
    expect(october?.netPayableMinor).toBe(84_200n);
    expect(october?.adjustmentsMinor).toBe(-4_000n);
    for (const statement of all) {
      expect(statement.lines.reduce((total, line) => total + line.amountMinor, 0n)).toBe(statement.netPayableMinor);
    }

    // The reconciliation export: every line, deductions as debits, then the totals.
    const file = await settlementStatementCsv({ sellerAccountId: sellerId, displayName: 'Statement test' }, october?.id ?? '');
    const rows = file.content.trim().split('\r\n');
    expect(rows[0]).toBe(SETTLEMENT_CSV_HEADER.join(','));
    expect(rows.some((row) => row.includes(',INSPECTION_FEE,') && row.includes(',0,4000,INR,'))).toBe(true);
    expect(rows.some((row) => row.startsWith('TOTAL,') && row.includes(',NET_PAYABLE,') && row.includes(',84200,0,INR,'))).toBe(true);
    // No cell starts with a minus, which a spreadsheet would read as a formula.
    expect(file.content).not.toMatch(/(^|,)'?-\d/m);

    // Somebody else's statement is not found.
    const other = await seller();
    await expect(
      settlementStatementCsv({ sellerAccountId: other, displayName: 'Other' }, october?.id ?? ''),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('money not on a statement yet (JOURNEY-034)', () => {
  it('reports held, on-hold and reserve amounts per currency', async () => {
    const sellerId = await seller();
    const held = await order(sellerId);
    const stopped = await order(sellerId);
    const released = await order(sellerId);
    const groups = await prisma.sellerOrderGroup.findMany({
      where: { id: { in: [held.groupId, stopped.groupId, released.groupId] } },
      select: { id: true, orderId: true },
    });
    const orderOf = new Map(groups.map((row) => [row.id, row.orderId]));
    const hold = (groupId: string, status: 'HELD' | 'ON_HOLD' | 'RELEASED', extra: object = {}) =>
      prisma.sellerFundHold.create({
        data: {
          id: newId(),
          sellerOrderGroupId: groupId,
          sellerAccountId: sellerId,
          orderId: orderOf.get(groupId) ?? '',
          currency: 'INR',
          status,
          allocatedMinor: 50_000n,
          termsJson: {},
          ...extra,
        },
      });
    await hold(held.groupId, 'HELD');
    await hold(stopped.groupId, 'ON_HOLD', { holdCode: 'DISPUTE', holdReason: 'Open claim' });
    await hold(released.groupId, 'RELEASED', {
      releasedMinor: 45_000n,
      reserveMinor: 5_000n,
      reserveReleaseAt: new Date('2027-01-01T00:00:00Z'),
    });

    try {
      const summary = await sellerFundsSummary(sellerId);
      expect(summary.currencies).toEqual([
        { currency: 'INR', heldMinor: '50000', onHoldMinor: '50000', reserveMinor: '5000', nextReserveReleaseAt: '2027-01-01T00:00:00.000Z' },
      ]);
      expect(summary.payoutsPausedByOperator).toBe(false);
    } finally {
      // No foreign key ties a fund hold to its order, so it is removed by hand.
      await prisma.sellerFundHold.deleteMany({ where: { sellerAccountId: sellerId } });
    }
  });
});
