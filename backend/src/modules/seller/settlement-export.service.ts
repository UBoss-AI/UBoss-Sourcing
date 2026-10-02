/**
 * What a seller needs beside a statement to reconcile it (JOURNEY-034).
 *
 * - The money not on any statement yet: protected funds still HELD for their
 *   release terms, funds ON_HOLD (an open dispute or the operator), and the
 *   reserve kept back from released funds until its date. Read from
 *   `seller_fund_holds`, the record the ledger releases from.
 * - The statement, or a period of statements, as a CSV file: every line with
 *   its kind and order number, then each statement's totals and the status of
 *   the payout that carried it. Amounts stay in minor units with their
 *   currency, so a spreadsheet never rounds a cent the statement did not.
 *
 * Cells go through `csvRow`, which neutralises spreadsheet formulas.
 */
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { csvRow } from '../reports/export.service.js';
import { recordSellerAudit } from './audit.service.js';

export interface SellerFundsSummary {
  currencies: {
    currency: string;
    /** Waiting for delivery, the return window or an inspection. */
    heldMinor: string;
    /** Stopped by an open dispute or by the operator. */
    onHoldMinor: string;
    /** Kept back from released funds until `reserveReleaseAt`. */
    reserveMinor: string;
    nextReserveReleaseAt: string | null;
  }[];
  payoutsPausedByOperator: boolean;
  payoutHoldReason: string | null;
}

export async function sellerFundsSummary(sellerAccountId: string): Promise<SellerFundsSummary> {
  const [holds, reserves, account] = await Promise.all([
    prisma.sellerFundHold.groupBy({
      by: ['currency', 'status'],
      where: { sellerAccountId, status: { in: ['HELD', 'ON_HOLD'] } },
      _sum: { allocatedMinor: true },
    }),
    prisma.sellerFundHold.groupBy({
      by: ['currency'],
      where: { sellerAccountId, status: 'RELEASED', reserveMinor: { gt: 0 }, reserveReleasedAt: null },
      _sum: { reserveMinor: true },
      _min: { reserveReleaseAt: true },
    }),
    prisma.sellerPayoutAccountReference.findFirst({
      where: { sellerAccountId },
      select: { payoutsHeldByOperator: true, payoutHoldReason: true },
    }),
  ]);

  const byCurrency = new Map<string, { held: bigint; onHold: bigint; reserve: bigint; next: Date | null }>();
  const entry = (currency: string) => {
    let row = byCurrency.get(currency);
    if (row === undefined) byCurrency.set(currency, (row = { held: 0n, onHold: 0n, reserve: 0n, next: null }));
    return row;
  };
  for (const row of holds) {
    const amount = row._sum.allocatedMinor ?? 0n;
    if (row.status === 'HELD') entry(row.currency).held += amount;
    else entry(row.currency).onHold += amount;
  }
  for (const row of reserves) {
    const target = entry(row.currency);
    target.reserve += row._sum.reserveMinor ?? 0n;
    target.next = row._min.reserveReleaseAt;
  }

  return {
    currencies: [...byCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, row]) => ({
        currency,
        heldMinor: row.held.toString(),
        onHoldMinor: row.onHold.toString(),
        reserveMinor: row.reserve.toString(),
        nextReserveReleaseAt: row.next?.toISOString() ?? null,
      })),
    payoutsPausedByOperator: account?.payoutsHeldByOperator ?? false,
    payoutHoldReason: account?.payoutsHeldByOperator === true ? account.payoutHoldReason : null,
  };
}

export const SETTLEMENT_CSV_HEADER = [
  'row',
  'statement',
  'period_start',
  'period_end',
  'statement_status',
  'occurred_at',
  'kind',
  'order',
  'credit_minor',
  'debit_minor',
  'currency',
  'reason',
  'payout_reference',
  'payout_status',
] as const;

/**
 * A signed amount as two non-negative columns. A leading minus would be
 * read as a formula and quoted by the guard in `csvRow`, which turns a
 * deduction into text in the spreadsheet.
 */
function creditDebit(amount: bigint): [string, string] {
  return amount < 0n ? ['0', (-amount).toString()] : [amount.toString(), '0'];
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every line of the given statements, then each statement's totals. */
async function statementsCsv(sellerAccountId: string, settlementIds: string[]): Promise<string> {
  const statements = await prisma.sellerSettlement.findMany({
    where: { id: { in: settlementIds }, sellerAccountId },
    orderBy: { periodStart: 'asc' },
    include: {
      lines: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
      payouts: { orderBy: { createdAt: 'desc' }, take: 1, select: { reference: true, status: true } },
    },
  });

  const out: string[] = [csvRow(SETTLEMENT_CSV_HEADER)];
  for (const statement of statements) {
    const payout = statement.payouts[0] ?? null;
    const common = [statement.reference, day(statement.periodStart), day(statement.periodEnd), statement.status];
    for (const line of statement.lines) {
      out.push(
        csvRow([
          'LINE',
          ...common,
          line.occurredAt.toISOString(),
          line.kind,
          line.description,
          ...creditDebit(line.amountMinor),
          line.currency,
          line.reason ?? '',
          '',
          '',
        ]),
      );
    }
    const totals: [string, bigint][] = [
      ['GROSS', statement.grossMinor],
      ['COMMISSION', -statement.commissionMinor],
      ['PROCESSING_FEE', -statement.processingFeeMinor],
      ['REFUNDS', -statement.refundsMinor],
      ['ADJUSTMENTS', statement.adjustmentsMinor],
      ['NET_PAYABLE', statement.netPayableMinor],
    ];
    for (const [kind, amount] of totals) {
      out.push(
        csvRow([
          'TOTAL',
          ...common,
          '',
          kind,
          '',
          ...creditDebit(amount),
          statement.currency,
          kind === 'NET_PAYABLE' ? (statement.holdReason ?? '') : '',
          kind === 'NET_PAYABLE' ? (payout?.reference ?? '') : '',
          kind === 'NET_PAYABLE' ? (payout?.status ?? 'NOT_PAID') : '',
        ]),
      );
    }
  }
  return out.join('');
}

/** One statement as a CSV file. Somebody else's statement is not found. */
export async function settlementStatementCsv(
  seller: { sellerAccountId: string; displayName: string },
  settlementId: string,
  correlationId?: string | null,
): Promise<{ fileName: string; content: string }> {
  const statement = await prisma.sellerSettlement.findUnique({
    where: { id: settlementId },
    select: { sellerAccountId: true, reference: true },
  });
  if (statement === null || statement.sellerAccountId !== seller.sellerAccountId) throw notFound('Settlement');
  const content = await statementsCsv(seller.sellerAccountId, [settlementId]);
  await recordSellerAudit({
    sellerAccountId: seller.sellerAccountId,
    action: 'seller.settlement.exported',
    actor: { type: 'CUSTOMER', label: seller.displayName },
    resourceType: 'seller_settlement',
    resourceId: settlementId,
    summary: `Statement ${statement.reference} was downloaded as a spreadsheet.`,
    correlationId: correlationId ?? null,
  });
  return { fileName: `${statement.reference}.csv`, content };
}

/** Every statement whose period lies inside [from, to), as one CSV file. */
export async function settlementPeriodCsv(
  seller: { sellerAccountId: string; displayName: string },
  window: { from: Date; to: Date },
  correlationId?: string | null,
): Promise<{ fileName: string; content: string }> {
  const rows = await prisma.sellerSettlement.findMany({
    where: { sellerAccountId: seller.sellerAccountId, periodStart: { gte: window.from }, periodEnd: { lte: window.to } },
    select: { id: true },
    take: 500,
  });
  const content = await statementsCsv(
    seller.sellerAccountId,
    rows.map((row) => row.id),
  );
  await recordSellerAudit({
    sellerAccountId: seller.sellerAccountId,
    action: 'seller.settlement.exported',
    actor: { type: 'CUSTOMER', label: seller.displayName },
    resourceType: 'seller_settlement',
    summary: `Statements from ${day(window.from)} to ${day(window.to)} were downloaded as a spreadsheet.`,
    correlationId: correlationId ?? null,
  });
  return { fileName: `settlements-${day(window.from)}-${day(window.to)}.csv`, content };
}
