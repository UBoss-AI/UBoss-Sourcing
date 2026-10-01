/**
 * The transaction ledger: one append-only, double-entry journal for every
 * movement of money (see the block header in schema.prisma).
 *
 * Rules this file enforces:
 *   - An entry's lines are in one currency and sum to zero; no line is zero.
 *   - An entry is written once per idempotency key; a second post with the
 *     same key returns the first entry and writes nothing.
 *   - Nothing is updated or deleted. A correction is a REVERSAL entry.
 *
 * Sign convention: a debit is positive, a credit negative. A seller's
 * balances are liabilities of the platform, so they carry credit (negative)
 * sums; the read-side helpers flip them so a seller sees positive money.
 */
import { Prisma } from '../../generated/prisma/client.js';
import type { LedgerAccountCode, LedgerEntryKind } from '../../generated/prisma/enums.js';
import { internal } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

export const PLATFORM_OWNER = 'PLATFORM';

/** Accounts that belong to a seller rather than to the platform. */
const SELLER_CODES: ReadonlySet<LedgerAccountCode> = new Set<LedgerAccountCode>([
  'SELLER_HELD',
  'SELLER_RESERVE',
  'SELLER_AVAILABLE',
  'PAYOUTS_IN_TRANSIT',
]);

export interface LedgerLineInput {
  code: LedgerAccountCode;
  amountMinor: bigint;
}

export interface LedgerEntryInput {
  kind: LedgerEntryKind;
  idempotencyKey: string;
  currency: string;
  memo: string;
  actorLabel?: string;
  occurredAt?: Date;
  orderId?: string | null;
  sellerOrderGroupId?: string | null;
  sellerAccountId?: string | null;
  paymentTransactionId?: string | null;
  refundId?: string | null;
  payoutId?: string | null;
  disputeId?: string | null;
  providerReference?: string | null;
  reversesEntryId?: string | null;
  lines: LedgerLineInput[];
}

async function accountId(
  tx: PrismaTransaction,
  code: LedgerAccountCode,
  sellerAccountId: string | null,
  currency: string,
): Promise<string> {
  const isSeller = SELLER_CODES.has(code);
  if (isSeller && sellerAccountId === null) {
    throw internal(`Ledger account ${code} needs a seller.`);
  }
  const ownerKey = isSeller && sellerAccountId !== null ? sellerAccountId : PLATFORM_OWNER;
  const row = await tx.ledgerAccount.upsert({
    where: { code_ownerKey_currency: { code, ownerKey, currency } },
    create: { id: newId(), code, ownerKey, sellerAccountId: isSeller ? sellerAccountId : null, currency },
    update: {},
    select: { id: true },
  });
  return row.id;
}

/** Write one balanced entry. Returns the existing entry when the key was used before. */
export async function postEntry(
  tx: PrismaTransaction,
  input: LedgerEntryInput,
): Promise<{ entryId: string; created: boolean }> {
  const existing = await tx.ledgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });
  if (existing !== null) return { entryId: existing.id, created: false };

  const lines = input.lines.filter((line) => line.amountMinor !== 0n);
  const sum = lines.reduce((total, line) => total + line.amountMinor, 0n);
  if (lines.length < 2 || sum !== 0n) {
    throw internal(`Ledger entry ${input.idempotencyKey} is not balanced (${sum.toString()}).`);
  }

  const entryId = newId();
  await tx.ledgerEntry.create({
    data: {
      id: entryId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey.slice(0, 191),
      currency: input.currency,
      orderId: input.orderId ?? null,
      sellerOrderGroupId: input.sellerOrderGroupId ?? null,
      sellerAccountId: input.sellerAccountId ?? null,
      paymentTransactionId: input.paymentTransactionId ?? null,
      refundId: input.refundId ?? null,
      payoutId: input.payoutId ?? null,
      disputeId: input.disputeId ?? null,
      providerReference: input.providerReference ?? null,
      reversesEntryId: input.reversesEntryId ?? null,
      memo: input.memo.slice(0, 255),
      actorLabel: (input.actorLabel ?? 'System').slice(0, 160),
      occurredAt: input.occurredAt ?? new Date(),
    },
  });
  for (const line of lines) {
    await tx.ledgerLine.create({
      data: {
        id: newId(),
        entryId,
        accountId: await accountId(tx, line.code, input.sellerAccountId ?? null, input.currency),
        amountMinor: line.amountMinor,
        currency: input.currency,
      },
    });
  }
  return { entryId, created: true };
}

/** Undo one entry, line for line with the signs flipped. Once per entry. */
export async function reverseEntry(
  tx: PrismaTransaction,
  entryId: string,
  memo: string,
  actorLabel = 'System',
): Promise<string> {
  const entry = await tx.ledgerEntry.findUniqueOrThrow({
    where: { id: entryId },
    include: { lines: { include: { account: { select: { code: true } } } } },
  });
  const result = await postEntry(tx, {
    kind: 'REVERSAL',
    idempotencyKey: `reversal:${entryId}`,
    currency: entry.currency,
    memo,
    actorLabel,
    orderId: entry.orderId,
    sellerOrderGroupId: entry.sellerOrderGroupId,
    sellerAccountId: entry.sellerAccountId,
    paymentTransactionId: entry.paymentTransactionId,
    refundId: entry.refundId,
    payoutId: entry.payoutId,
    disputeId: entry.disputeId,
    providerReference: entry.providerReference,
    reversesEntryId: entryId,
    lines: entry.lines.map((line) => ({ code: line.account.code, amountMinor: -line.amountMinor })),
  });
  return result.entryId;
}

/** One row of a grouped sum: entry kind x account code x currency. */
export interface LedgerSumRow {
  kind: LedgerEntryKind;
  code: LedgerAccountCode;
  currency: string;
  key: string;
  total: bigint;
}

/**
 * Sum lines grouped by entry kind, account code and currency, for the entries
 * matching one column. `key` is that column's value.
 */
export async function sumLines(
  column: 'orderId' | 'sellerAccountId' | 'sellerOrderGroupId',
  values: string[],
  client: PrismaTransaction | typeof prisma = prisma,
): Promise<LedgerSumRow[]> {
  if (values.length === 0) return [];
  const col = Prisma.raw(`e.\`${column}\``);
  const rows = await client.$queryRaw<
    { kind: LedgerEntryKind; code: LedgerAccountCode; currency: string; k: string; total: bigint | number | string }[]
  >`SELECT e.kind AS kind, a.code AS code, e.currency AS currency, ${col} AS k,
           CAST(SUM(l.amountMinor) AS SIGNED) AS total
      FROM ledger_lines l
      JOIN ledger_entries e ON e.id = l.entryId
      JOIN ledger_accounts a ON a.id = l.accountId
     WHERE ${col} IN (${Prisma.join(values)})
     GROUP BY e.kind, a.code, e.currency, ${col}`;
  return rows.map((row) => ({
    kind: row.kind,
    code: row.code,
    currency: row.currency,
    key: row.k,
    total: BigInt(row.total),
  }));
}

/** Sum of the lines matching a filter. */
export function total(
  rows: LedgerSumRow[],
  filter: { code?: LedgerAccountCode; kinds?: LedgerEntryKind[]; key?: string; currency?: string },
): bigint {
  return rows
    .filter(
      (row) =>
        (filter.code === undefined || row.code === filter.code) &&
        (filter.kinds === undefined || filter.kinds.includes(row.kind)) &&
        (filter.key === undefined || row.key === filter.key) &&
        (filter.currency === undefined || row.currency === filter.currency),
    )
    .reduce((sum, row) => sum + row.total, 0n);
}

/** One order's money, as finance reads it. All positive minor units. */
export interface OrderLedgerSummary {
  currency: string;
  grossMinor: bigint;
  platformFeeMinor: bigint;
  platformFeeTaxMinor: bigint;
  sellerShareMinor: bigint;
  refundsMinor: bigint;
  refundsChargedToSellersMinor: bigint;
  releasedMinor: bigint;
  heldMinor: bigint;
  chargebackLossMinor: bigint;
}

export function summarise(rows: LedgerSumRow[], key: string, currency: string): OrderLedgerSummary {
  const pick = (code: LedgerAccountCode, kinds?: LedgerEntryKind[]): bigint =>
    total(rows, { code, key, currency, ...(kinds !== undefined ? { kinds } : {}) });
  return {
    currency,
    grossMinor: pick('PROVIDER_BALANCE', ['PAYMENT_CAPTURED']),
    platformFeeMinor: -pick('PLATFORM_COMMISSION'),
    platformFeeTaxMinor: -pick('PLATFORM_FEE_TAX'),
    sellerShareMinor: -pick('SELLER_HELD', ['SALE_ALLOCATED']),
    refundsMinor: -pick('PROVIDER_BALANCE', ['REFUND_ISSUED', 'CHARGEBACK_LOST']),
    refundsChargedToSellersMinor:
      pick('SELLER_HELD', ['REFUND_CHARGED_TO_SELLER']) + pick('SELLER_AVAILABLE', ['REFUND_CHARGED_TO_SELLER']),
    releasedMinor: pick('SELLER_HELD', ['FUNDS_RELEASED']),
    heldMinor: -pick('SELLER_HELD'),
    chargebackLossMinor: pick('CHARGEBACK_LOSSES'),
  };
}

/** Entries for a filter, newest first, with their lines. */
export async function listEntries(filter: {
  orderId?: string;
  sellerAccountId?: string;
  kind?: LedgerEntryKind;
  page: number;
  pageSize: number;
}): Promise<{ items: SerialisedEntry[]; total: number }> {
  const where: Prisma.LedgerEntryWhereInput = {
    ...(filter.orderId !== undefined ? { orderId: filter.orderId } : {}),
    ...(filter.sellerAccountId !== undefined ? { sellerAccountId: filter.sellerAccountId } : {}),
    ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
  };
  const [rows, count] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: { lines: { include: { account: { select: { code: true, ownerKey: true } } } } },
    }),
    prisma.ledgerEntry.count({ where }),
  ]);
  return { items: rows.map(serialiseEntry), total: count };
}

export interface SerialisedEntry {
  id: string;
  kind: LedgerEntryKind;
  currency: string;
  memo: string;
  actorLabel: string;
  occurredAt: string;
  orderId: string | null;
  sellerOrderGroupId: string | null;
  sellerAccountId: string | null;
  refundId: string | null;
  payoutId: string | null;
  disputeId: string | null;
  providerReference: string | null;
  reversesEntryId: string | null;
  lines: { account: LedgerAccountCode; owner: string; amountMinor: string }[];
}

export function serialiseEntry(row: {
  id: string;
  kind: LedgerEntryKind;
  currency: string;
  memo: string;
  actorLabel: string;
  occurredAt: Date;
  orderId: string | null;
  sellerOrderGroupId: string | null;
  sellerAccountId: string | null;
  refundId: string | null;
  payoutId: string | null;
  disputeId: string | null;
  providerReference: string | null;
  reversesEntryId: string | null;
  lines: { amountMinor: bigint; account: { code: LedgerAccountCode; ownerKey: string } }[];
}): SerialisedEntry {
  return {
    id: row.id,
    kind: row.kind,
    currency: row.currency,
    memo: row.memo,
    actorLabel: row.actorLabel,
    occurredAt: row.occurredAt.toISOString(),
    orderId: row.orderId,
    sellerOrderGroupId: row.sellerOrderGroupId,
    sellerAccountId: row.sellerAccountId,
    refundId: row.refundId,
    payoutId: row.payoutId,
    disputeId: row.disputeId,
    providerReference: row.providerReference,
    reversesEntryId: row.reversesEntryId,
    lines: row.lines.map((line) => ({
      account: line.account.code,
      owner: line.account.ownerKey,
      amountMinor: line.amountMinor.toString(),
    })),
  };
}
