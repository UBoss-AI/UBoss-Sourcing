/**
 * What finance, sellers and buyers see of the ledger and held funds, and the
 * reconciliation of the ledger with the payment rows and the provider.
 *
 * Money leaves this file as strings of minor units, never as numbers.
 */
import { env } from '../../config/env.js';
import { notFound } from '../../domain/errors.js';
import type {
  LedgerReconciliationItemKind,
  SellerFundHoldStatus,
} from '../../generated/prisma/enums.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { listOrderReceipts } from '../payments/payment-receipt.service.js';
import { payoutAdapter } from '../seller/payout.service.js';
import { currentReleaseTerms, type ReleaseCondition } from './escrow.service.js';
import { listEntries, sumLines, summarise, total, type OrderLedgerSummary } from './ledger.service.js';

function money(summary: OrderLedgerSummary): Record<string, string> {
  return Object.fromEntries(
    Object.entries(summary).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]),
  );
}

function conditionsOf(json: unknown): ReleaseCondition[] {
  return Array.isArray(json) ? (json as ReleaseCondition[]) : [];
}

function serialiseHold(hold: {
  id: string;
  sellerOrderGroupId: string;
  sellerAccountId: string;
  orderId: string;
  currency: string;
  status: SellerFundHoldStatus;
  allocatedMinor: bigint;
  releasedMinor: bigint;
  reserveMinor: bigint;
  termsJson: unknown;
  conditionsJson: unknown;
  holdCode: string | null;
  holdReason: string | null;
  releaseKind: string | null;
  releasedAt: Date | null;
  reserveReleaseAt: Date | null;
  reserveReleasedAt: Date | null;
  payoutId: string | null;
  lastEvaluatedAt: Date | null;
}) {
  return {
    id: hold.id,
    sellerOrderGroupId: hold.sellerOrderGroupId,
    sellerAccountId: hold.sellerAccountId,
    orderId: hold.orderId,
    currency: hold.currency,
    status: hold.status,
    allocatedMinor: hold.allocatedMinor.toString(),
    releasedMinor: hold.releasedMinor.toString(),
    reserveMinor: hold.reserveMinor.toString(),
    terms: hold.termsJson,
    conditions: conditionsOf(hold.conditionsJson),
    holdCode: hold.holdCode,
    holdReason: hold.holdReason,
    releaseKind: hold.releaseKind,
    releasedAt: hold.releasedAt?.toISOString() ?? null,
    reserveReleaseAt: hold.reserveReleaseAt?.toISOString() ?? null,
    reserveReleasedAt: hold.reserveReleasedAt?.toISOString() ?? null,
    payoutId: hold.payoutId,
    lastEvaluatedAt: hold.lastEvaluatedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Admin: per-order ledger
// ---------------------------------------------------------------------------

/** Orders with ledger activity, newest first, each with its money summary. */
export async function listLedgerOrders(page: number, pageSize: number) {
  const grouped = await prisma.ledgerEntry.groupBy({
    by: ['orderId', 'currency'],
    where: { orderId: { not: null } },
    _max: { occurredAt: true },
    orderBy: { _max: { occurredAt: 'desc' } },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  const totalCount = (
    await prisma.ledgerEntry.groupBy({ by: ['orderId', 'currency'], where: { orderId: { not: null } } })
  ).length;
  const ids = grouped.map((row) => row.orderId).filter((id): id is string => id !== null);
  const [rows, orders, holds] = await Promise.all([
    sumLines('orderId', ids),
    prisma.order.findMany({ where: { id: { in: ids } }, select: { id: true, orderNumber: true } }),
    prisma.sellerFundHold.findMany({ where: { orderId: { in: ids } }, select: { orderId: true, status: true } }),
  ]);
  return {
    items: grouped
      .filter((row) => row.orderId !== null)
      .map((row) => {
        const orderId = row.orderId ?? '';
        const states = holds.filter((hold) => hold.orderId === orderId).map((hold) => hold.status);
        return {
          orderId,
          orderNumber: orders.find((order) => order.id === orderId)?.orderNumber ?? null,
          lastActivityAt: row._max.occurredAt?.toISOString() ?? null,
          settlement: settlementState(states),
          ...money(summarise(rows, orderId, row.currency)),
        };
      }),
    total: totalCount,
    page,
    pageSize,
  };
}

function settlementState(states: SellerFundHoldStatus[]): 'NONE' | 'HELD' | 'ON_HOLD' | 'PARTLY_RELEASED' | 'RELEASED' {
  if (states.length === 0) return 'NONE';
  if (states.some((state) => state === 'ON_HOLD')) return 'ON_HOLD';
  if (states.every((state) => state === 'RELEASED')) return 'RELEASED';
  return states.some((state) => state === 'RELEASED') ? 'PARTLY_RELEASED' : 'HELD';
}

/** One order's ledger: the summary, every entry, the holds, refunds and chargebacks. */
export async function orderLedger(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, currency: true, paidMinor: true, refundedMinor: true },
  });
  if (order === null) throw notFound('Order');
  const [rows, entries, holds, refunds, chargebacks, groups, inspectionInvoices] = await Promise.all([
    sumLines('orderId', [orderId]),
    listEntries({ orderId, page: 1, pageSize: 200 }),
    prisma.sellerFundHold.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    prisma.refund.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    prisma.dispute.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    prisma.sellerOrderGroup.findMany({
      where: { orderId },
      select: { id: true, sellerOrderNumber: true, sellerAccount: { select: { displayName: true } } },
    }),
    prisma.inspectionAgencyInvoice.findMany({
      where: { job: { requirement: { orderId } } },
      orderBy: { submittedAt: 'asc' },
      select: { id: true, invoiceNumber: true, amountMinor: true, currency: true, payer: true, status: true },
    }),
  ]);
  const payoutIds = holds.map((hold) => hold.payoutId).filter((id): id is string => id !== null);
  const payouts = await prisma.sellerPayout.findMany({
    where: { id: { in: payoutIds } },
    select: { id: true, reference: true, status: true, providerPayoutId: true, paidAt: true },
  });
  const postedRefunds = new Set(entries.items.map((entry) => entry.refundId).filter((id) => id !== null));
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    currency: order.currency,
    paidMinor: order.paidMinor.toString(),
    refundedMinor: order.refundedMinor.toString(),
    summary: money(summarise(rows, orderId, order.currency)),
    entries: entries.items,
    holds: holds.map((hold) => {
      const group = groups.find((row) => row.id === hold.sellerOrderGroupId);
      const payout = payouts.find((row) => row.id === hold.payoutId) ?? null;
      return {
        ...serialiseHold(hold),
        sellerOrderNumber: group?.sellerOrderNumber ?? null,
        sellerName: group?.sellerAccount.displayName ?? null,
        payout:
          payout === null
            ? null
            : {
                id: payout.id,
                reference: payout.reference,
                status: payout.status,
                providerPayoutId: payout.providerPayoutId,
                paidAt: payout.paidAt?.toISOString() ?? null,
              },
      };
    }),
    refunds: refunds.map((refund) => ({
      id: refund.id,
      amountMinor: refund.amountMinor.toString(),
      currency: refund.currency,
      status: refund.status,
      reason: refund.reason,
      providerRefundId: refund.providerRefundId,
      completedAt: refund.completedAt?.toISOString() ?? null,
      accounting: postedRefunds.has(refund.id) ? 'POSTED' : refund.status === 'SUCCEEDED' ? 'NOT_POSTED' : 'NOT_DUE',
    })),
    chargebacks: chargebacks
      .filter((dispute) => dispute.kind === 'CHARGEBACK')
      .map((dispute) => ({
        id: dispute.id,
        reference: dispute.reference,
        status: dispute.status,
        disputedAmountMinor: (dispute.disputedAmountMinor ?? 0n).toString(),
        currency: dispute.currency,
        evidenceDueAt: dispute.evidenceDueAt?.toISOString() ?? null,
        refundId: dispute.refundId,
        accounting:
          dispute.status === 'LOST'
            ? dispute.refundId !== null && postedRefunds.has(dispute.refundId)
              ? 'LOSS_POSTED'
              : 'LOSS_NOT_POSTED'
            : dispute.status === 'WON'
              ? 'WON_NO_MOVEMENT'
              : 'PENDING_OUTCOME',
      })),
    // Inspection moves no money through the ledger: no inspection fee is
    // charged to the buyer, and an agency's invoice is paid outside the
    // platform's payment balance. Listed so finance sees the cost and who
    // carries it beside the money that did move.
    inspection: {
      ledgerMinor: '0',
      invoices: inspectionInvoices.map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        amountMinor: invoice.amountMinor.toString(),
        currency: invoice.currency,
        payer: invoice.payer,
        status: invoice.status,
      })),
    },
  };
}

/** The finance view of refunds and chargebacks, each with its ledger status. */
export async function refundsAndChargebacks(page: number, pageSize: number) {
  const [refunds, chargebacks] = await Promise.all([
    prisma.refund.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { order: { select: { orderNumber: true } } },
    }),
    prisma.dispute.findMany({
      where: { kind: 'CHARGEBACK' },
      orderBy: { createdAt: 'desc' },
      take: pageSize,
      skip: (page - 1) * pageSize,
      select: {
        id: true,
        reference: true,
        orderId: true,
        status: true,
        disputedAmountMinor: true,
        currency: true,
        evidenceDueAt: true,
        refundId: true,
        createdAt: true,
      },
    }),
  ]);
  const refundIds = [...refunds.map((row) => row.id), ...chargebacks.map((row) => row.refundId ?? '')].filter(
    (id) => id.length > 0,
  );
  const posted = new Set(
    (await prisma.ledgerEntry.findMany({ where: { refundId: { in: refundIds } }, select: { refundId: true } })).map(
      (row) => row.refundId,
    ),
  );
  return {
    refunds: refunds.map((refund) => ({
      id: refund.id,
      orderId: refund.orderId,
      orderNumber: refund.order.orderNumber,
      amountMinor: refund.amountMinor.toString(),
      currency: refund.currency,
      status: refund.status,
      reason: refund.reason,
      createdAt: refund.createdAt.toISOString(),
      accounting: posted.has(refund.id) ? 'POSTED' : refund.status === 'SUCCEEDED' ? 'NOT_POSTED' : 'NOT_DUE',
    })),
    chargebacks: chargebacks.map((dispute) => ({
      id: dispute.id,
      reference: dispute.reference,
      orderId: dispute.orderId,
      status: dispute.status,
      disputedAmountMinor: (dispute.disputedAmountMinor ?? 0n).toString(),
      currency: dispute.currency,
      evidenceDueAt: dispute.evidenceDueAt?.toISOString() ?? null,
      createdAt: dispute.createdAt.toISOString(),
      accounting:
        dispute.status === 'LOST'
          ? dispute.refundId !== null && posted.has(dispute.refundId)
            ? 'LOSS_POSTED'
            : 'LOSS_NOT_POSTED'
          : dispute.status === 'WON'
            ? 'WON_NO_MOVEMENT'
            : 'PENDING_OUTCOME',
    })),
  };
}

/** Held funds, for the finance screen. */
export async function listHolds(status: SellerFundHoldStatus | undefined, page: number, pageSize: number) {
  const where = status !== undefined ? { status } : {};
  const [rows, count] = await Promise.all([
    prisma.sellerFundHold.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.sellerFundHold.count({ where }),
  ]);
  const [groups, requests] = await Promise.all([
    prisma.sellerOrderGroup.findMany({
      where: { id: { in: rows.map((row) => row.sellerOrderGroupId) } },
      select: { id: true, sellerOrderNumber: true, sellerAccount: { select: { displayName: true } } },
    }),
    prisma.sellerFundReleaseRequest.findMany({
      where: { fundHoldId: { in: rows.map((row) => row.id) }, status: 'PENDING' },
    }),
  ]);
  return {
    items: rows.map((row) => {
      const group = groups.find((item) => item.id === row.sellerOrderGroupId);
      const pending = requests.find((item) => item.fundHoldId === row.id) ?? null;
      return {
        ...serialiseHold(row),
        sellerOrderNumber: group?.sellerOrderNumber ?? null,
        sellerName: group?.sellerAccount.displayName ?? null,
        pendingRelease:
          pending === null
            ? null
            : {
                id: pending.id,
                reason: pending.reason,
                requestedById: pending.requestedById,
                requestedByLabel: pending.requestedByLabel,
                requestedAt: pending.requestedAt.toISOString(),
              },
      };
    }),
    total: count,
    page,
    pageSize,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

interface Finding {
  kind: LedgerReconciliationItemKind;
  providerReference?: string | null;
  providerType?: string | null;
  providerAmountMinor?: bigint | null;
  ledgerAmountMinor?: bigint | null;
  currency?: string | null;
  ledgerEntryId?: string | null;
  note: string;
}

/**
 * Compare the ledger, for a period, with the payment rows it is built from,
 * the sellers' settlement figures, and - when the provider can list them -
 * the provider's own transfers to connected accounts.
 */
export async function runReconciliation(periodStart: Date, periodEnd: Date, startedByLabel: string) {
  const runId = newId();
  const adapter = payoutAdapter();
  await prisma.ledgerReconciliationRun.create({
    data: { id: runId, provider: adapter.name, periodStart, periodEnd, startedByLabel, startedAt: new Date() },
  });
  const findings: Finding[] = [];
  let providerCount = 0;
  try {
    const between = { gte: periodStart, lt: periodEnd };

    // 1. Every entry balances.
    const unbalanced = await prisma.$queryRaw<{ entryId: string; total: bigint | number | string }[]>`
      SELECT l.entryId AS entryId, CAST(SUM(l.amountMinor) AS SIGNED) AS total
        FROM ledger_lines l JOIN ledger_entries e ON e.id = l.entryId
       WHERE e.occurredAt >= ${periodStart} AND e.occurredAt < ${periodEnd}
       GROUP BY l.entryId HAVING SUM(l.amountMinor) <> 0`;
    for (const row of unbalanced) {
      findings.push({ kind: 'UNBALANCED_ENTRY', ledgerEntryId: row.entryId, ledgerAmountMinor: BigInt(row.total), note: 'The lines of this entry do not sum to zero.' });
    }

    // 2. Captured payments and succeeded refunds each have their entry, for the same amount.
    const [payments, refunds] = await Promise.all([
      prisma.paymentTransaction.findMany({
        where: { status: 'CAPTURED', capturedAt: between },
        select: { id: true, capturedMinor: true, currency: true, providerPaymentId: true },
      }),
      prisma.refund.findMany({
        where: { status: 'SUCCEEDED', completedAt: between },
        select: { id: true, amountMinor: true, currency: true, providerRefundId: true },
      }),
    ]);
    const entries = await prisma.ledgerEntry.findMany({
      where: {
        idempotencyKey: {
          in: [...payments.map((row) => `capture:${row.id}`), ...refunds.map((row) => `refund:${row.id}`)],
        },
      },
      include: { lines: { include: { account: { select: { code: true } } } } },
    });
    const byKey = new Map(entries.map((entry) => [entry.idempotencyKey, entry]));
    const providerLine = (key: string): bigint | null => {
      const entry = byKey.get(key);
      if (entry === undefined) return null;
      return entry.lines.filter((line) => line.account.code === 'PROVIDER_BALANCE').reduce((sum, line) => sum + line.amountMinor, 0n);
    };
    for (const payment of payments) {
      const key = `capture:${payment.id}`;
      const amount = providerLine(key);
      findings.push(
        amount === null
          ? { kind: 'MISSING_IN_LEDGER', providerReference: payment.providerPaymentId, providerType: 'payment', providerAmountMinor: payment.capturedMinor, currency: payment.currency, note: 'Captured payment not posted to the ledger.' }
          : amount !== payment.capturedMinor
            ? { kind: 'AMOUNT_MISMATCH', providerReference: payment.providerPaymentId, providerType: 'payment', providerAmountMinor: payment.capturedMinor, ledgerAmountMinor: amount, currency: payment.currency, ledgerEntryId: byKey.get(key)?.id ?? null, note: 'Captured amount differs from the ledger.' }
            : { kind: 'MATCHED', providerReference: payment.providerPaymentId, providerType: 'payment', providerAmountMinor: payment.capturedMinor, ledgerAmountMinor: amount, currency: payment.currency, ledgerEntryId: byKey.get(key)?.id ?? null, note: 'Payment matches.' },
      );
    }
    for (const refund of refunds) {
      const key = `refund:${refund.id}`;
      const amount = providerLine(key);
      const ledger = amount === null ? null : -amount;
      findings.push(
        ledger === null
          ? { kind: 'MISSING_IN_LEDGER', providerReference: refund.providerRefundId, providerType: 'refund', providerAmountMinor: refund.amountMinor, currency: refund.currency, note: 'Succeeded refund not posted to the ledger.' }
          : ledger !== refund.amountMinor
            ? { kind: 'AMOUNT_MISMATCH', providerReference: refund.providerRefundId, providerType: 'refund', providerAmountMinor: refund.amountMinor, ledgerAmountMinor: ledger, currency: refund.currency, ledgerEntryId: byKey.get(key)?.id ?? null, note: 'Refund amount differs from the ledger.' }
            : { kind: 'MATCHED', providerReference: refund.providerRefundId, providerType: 'refund', providerAmountMinor: refund.amountMinor, ledgerAmountMinor: ledger, currency: refund.currency, ledgerEntryId: byKey.get(key)?.id ?? null, note: 'Refund matches.' },
      );
    }

    // 3. Each allocation matches the seller order's settlement figures.
    const allocations = await prisma.ledgerEntry.findMany({
      where: { kind: 'SALE_ALLOCATED', occurredAt: between },
      include: { lines: { include: { account: { select: { code: true } } } } },
    });
    const settlements = await prisma.sellerOrderSettlement.findMany({
      where: { sellerOrderGroupId: { in: allocations.map((entry) => entry.sellerOrderGroupId ?? '') } },
    });
    for (const entry of allocations) {
      // The operator's own part of an order has no seller order to match.
      if (entry.sellerOrderGroupId === null) continue;
      const settlement = settlements.find((row) => row.sellerOrderGroupId === entry.sellerOrderGroupId);
      const ledgerShare = -entry.lines.filter((line) => line.account.code === 'SELLER_HELD').reduce((sum, line) => sum + line.amountMinor, 0n);
      const expected =
        settlement === undefined
          ? null
          : settlement.grossProceedsMinor + settlement.sellerDeliveryProceedsMinor - settlement.platformFeeMinor - settlement.platformFeeTaxMinor;
      if (expected !== ledgerShare) {
        findings.push({ kind: 'STATEMENT_MISMATCH', ledgerEntryId: entry.id, ledgerAmountMinor: ledgerShare, providerAmountMinor: expected, currency: entry.currency, note: "The seller share in the ledger differs from the seller order's settlement." });
      }
    }

    // 4. The provider's transfers to connected accounts against settled payouts.
    if (adapter.listTransfers !== undefined) {
      const transfers = await adapter.listTransfers(periodStart, periodEnd);
      providerCount = transfers.length;
      const settled = await prisma.ledgerEntry.findMany({
        where: { kind: 'PAYOUT_SETTLED', occurredAt: between },
        include: { lines: { include: { account: { select: { code: true } } } } },
      });
      const settledAmount = (entry: (typeof settled)[number]): bigint =>
        entry.lines.filter((line) => line.account.code === 'PAYOUTS_IN_TRANSIT').reduce((sum, line) => sum + line.amountMinor, 0n);
      for (const transfer of transfers) {
        const entry = settled.find((row) => row.providerReference === transfer.id);
        if (entry === undefined) {
          findings.push({ kind: 'MISSING_IN_LEDGER', providerReference: transfer.id, providerType: 'transfer', providerAmountMinor: transfer.amountMinor, currency: transfer.currency, note: 'A transfer at the provider has no payout in the ledger.' });
        } else if (entry.currency !== transfer.currency) {
          findings.push({ kind: 'CURRENCY_CONVERTED', providerReference: transfer.id, providerType: 'transfer', providerAmountMinor: transfer.amountMinor, ledgerAmountMinor: settledAmount(entry), currency: transfer.currency, ledgerEntryId: entry.id, note: 'The provider converted this transfer.' });
        } else if (settledAmount(entry) !== transfer.amountMinor) {
          findings.push({ kind: 'AMOUNT_MISMATCH', providerReference: transfer.id, providerType: 'transfer', providerAmountMinor: transfer.amountMinor, ledgerAmountMinor: settledAmount(entry), currency: transfer.currency, ledgerEntryId: entry.id, note: 'Transfer amount differs from the ledger.' });
        } else {
          findings.push({ kind: 'MATCHED', providerReference: transfer.id, providerType: 'transfer', providerAmountMinor: transfer.amountMinor, ledgerAmountMinor: transfer.amountMinor, currency: transfer.currency, ledgerEntryId: entry.id, note: 'Transfer matches.' });
        }
      }
      for (const entry of settled) {
        if (!transfers.some((transfer) => transfer.id === entry.providerReference)) {
          findings.push({ kind: 'MISSING_AT_PROVIDER', providerReference: entry.providerReference, providerType: 'transfer', ledgerAmountMinor: settledAmount(entry), currency: entry.currency, ledgerEntryId: entry.id, note: 'A payout in the ledger was not found at the provider.' });
        }
      }
    }

    await prisma.ledgerReconciliationItem.createMany({
      data: findings.map((finding) => ({
        id: newId(),
        runId,
        kind: finding.kind,
        providerReference: finding.providerReference ?? null,
        providerType: finding.providerType ?? null,
        providerAmountMinor: finding.providerAmountMinor ?? null,
        ledgerAmountMinor: finding.ledgerAmountMinor ?? null,
        currency: finding.currency ?? null,
        ledgerEntryId: finding.ledgerEntryId ?? null,
        note: finding.note,
      })),
    });
    const matched = findings.filter((finding) => finding.kind === 'MATCHED').length;
    await prisma.ledgerReconciliationRun.update({
      where: { id: runId },
      data: {
        status: 'COMPLETED',
        providerTransactionCount: providerCount,
        matchedCount: matched,
        mismatchCount: findings.length - matched,
        completedAt: new Date(),
      },
    });
  } catch (error) {
    await prisma.ledgerReconciliationRun.update({
      where: { id: runId },
      data: { status: 'FAILED', errorMessage: (error as Error).message.slice(0, 1000), completedAt: new Date() },
    });
  }
  return readReconciliation(runId);
}

export async function listReconciliations() {
  const rows = await prisma.ledgerReconciliationRun.findMany({ orderBy: { startedAt: 'desc' }, take: 50 });
  return rows.map(serialiseRun);
}

function serialiseRun(row: {
  id: string;
  provider: string;
  periodStart: Date;
  periodEnd: Date;
  status: string;
  providerTransactionCount: number;
  matchedCount: number;
  mismatchCount: number;
  startedByLabel: string;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: row.id,
    provider: row.provider,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    status: row.status,
    providerTransactionCount: row.providerTransactionCount,
    matchedCount: row.matchedCount,
    mismatchCount: row.mismatchCount,
    startedByLabel: row.startedByLabel,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export async function readReconciliation(runId: string) {
  const run = await prisma.ledgerReconciliationRun.findUnique({ where: { id: runId }, include: { items: true } });
  if (run === null) throw notFound('Reconciliation');
  return {
    ...serialiseRun(run),
    items: run.items
      .filter((item) => item.kind !== 'MATCHED')
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        providerReference: item.providerReference,
        providerType: item.providerType,
        providerAmountMinor: item.providerAmountMinor?.toString() ?? null,
        ledgerAmountMinor: item.ledgerAmountMinor?.toString() ?? null,
        currency: item.currency,
        ledgerEntryId: item.ledgerEntryId,
        note: item.note,
      })),
  };
}

// ---------------------------------------------------------------------------
// Seller Hub: receivables, fees, reserves, settlement, reconciliation
// ---------------------------------------------------------------------------

export async function sellerFinance(sellerAccountId: string) {
  const rows = await sumLines('sellerAccountId', [sellerAccountId]);
  const currencies = [...new Set(rows.map((row) => row.currency))].sort();
  const balances = currencies.map((currency) => {
    const pick = (code: Parameters<typeof total>[1]['code'], kinds?: Parameters<typeof total>[1]['kinds']): bigint =>
      total(rows, { code, currency, ...(kinds !== undefined ? { kinds } : {}) });
    return {
      currency,
      // The seller's gross is their share plus what was taken from it. Not the
      // clearing line: that also carries the tax on top of the price and the
      // operator's delivery, which were never the seller's.
      grossSalesMinor: (
        -pick('SELLER_HELD', ['SALE_ALLOCATED']) -
        pick('PLATFORM_COMMISSION', ['SALE_ALLOCATED']) -
        pick('PLATFORM_FEE_TAX', ['SALE_ALLOCATED'])
      ).toString(),
      platformFeesMinor: (-pick('PLATFORM_COMMISSION', ['SALE_ALLOCATED'])).toString(),
      platformFeeTaxMinor: (-pick('PLATFORM_FEE_TAX', ['SALE_ALLOCATED'])).toString(),
      refundsChargedMinor: (
        pick('SELLER_HELD', ['REFUND_CHARGED_TO_SELLER']) + pick('SELLER_AVAILABLE', ['REFUND_CHARGED_TO_SELLER'])
      ).toString(),
      heldMinor: (-pick('SELLER_HELD')).toString(),
      reserveMinor: (-pick('SELLER_RESERVE')).toString(),
      availableMinor: (-pick('SELLER_AVAILABLE')).toString(),
      inTransitMinor: (-pick('PAYOUTS_IN_TRANSIT')).toString(),
      paidOutMinor: pick('PAYOUTS_IN_TRANSIT', ['PAYOUT_SETTLED']).toString(),
    };
  });
  const lastRun = await prisma.ledgerReconciliationRun.findFirst({
    where: { status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true, periodEnd: true },
  });
  return {
    enabled: env.FEATURE_ESCROW_LEDGER,
    releaseTerms: currentReleaseTerms(),
    balances,
    lastReconciledAt: lastRun?.completedAt?.toISOString() ?? null,
  };
}

export async function sellerHolds(sellerAccountId: string, page: number, pageSize: number) {
  const [rows, count] = await Promise.all([
    prisma.sellerFundHold.findMany({
      where: { sellerAccountId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.sellerFundHold.count({ where: { sellerAccountId } }),
  ]);
  const [groups, payouts] = await Promise.all([
    prisma.sellerOrderGroup.findMany({
      where: { id: { in: rows.map((row) => row.sellerOrderGroupId) } },
      select: { id: true, sellerOrderNumber: true },
    }),
    prisma.sellerPayout.findMany({
      where: { id: { in: rows.map((row) => row.payoutId ?? '') }, sellerAccountId },
      select: { id: true, reference: true, status: true },
    }),
  ]);
  return {
    items: rows.map((row) => {
      const { sellerAccountId: _seller, orderId: _order, holdReason, ...rest } = serialiseHold(row);
      const payout = payouts.find((item) => item.id === row.payoutId) ?? null;
      return {
        ...rest,
        // A seller sees why money is held, not who placed the hold.
        holdReason: row.holdCode === 'DISPUTE' ? null : holdReason,
        sellerOrderNumber: groups.find((group) => group.id === row.sellerOrderGroupId)?.sellerOrderNumber ?? null,
        payout: payout === null ? null : { reference: payout.reference, status: payout.status },
      };
    }),
    total: count,
    page,
    pageSize,
  };
}

// ---------------------------------------------------------------------------
// The buyer: how their payment is protected
// ---------------------------------------------------------------------------

export async function buyerPaymentProtection(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      currency: true,
      grandTotalMinor: true,
      paidMinor: true,
      refundedMinor: true,
      status: true,
    },
  });
  if (order === null) throw notFound('Order');
  const [payments, holds, groups, receipts] = await Promise.all([
    prisma.paymentTransaction.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, method: true, provider: true, currency: true, capturedMinor: true, amountMinor: true, cardBrand: true, cardLast4: true, capturedAt: true },
    }),
    prisma.sellerFundHold.findMany({ where: { orderId } }),
    prisma.sellerOrderGroup.findMany({
      where: { orderId },
      select: { id: true, sellerOrderNumber: true, status: true, sellerAccount: { select: { displayName: true } } },
    }),
    listOrderReceipts(orderId),
  ]);
  const payment = payments.find((row) => row.status === 'CAPTURED') ?? payments[0] ?? null;
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    currency: order.currency,
    grandTotalMinor: order.grandTotalMinor.toString(),
    paidMinor: order.paidMinor.toString(),
    refundedMinor: order.refundedMinor.toString(),
    payment:
      payment === null
        ? null
        : {
            status: payment.status,
            method: payment.method,
            provider: payment.provider,
            currency: payment.currency,
            cardBrand: payment.cardBrand,
            cardLast4: payment.cardLast4,
            capturedAt: payment.capturedAt?.toISOString() ?? null,
          },
    protectionEnabled: env.FEATURE_ESCROW_LEDGER,
    releaseTerms: currentReleaseTerms(),
    // One milestone row per seller order: where the money for it is. No
    // seller fee or share is shown - that is between the seller and the operator.
    sellers: groups.map((group) => {
      const hold = holds.find((row) => row.sellerOrderGroupId === group.id) ?? null;
      return {
        sellerOrderNumber: group.sellerOrderNumber,
        sellerName: group.sellerAccount.displayName,
        orderStatus: group.status,
        fundsStatus: hold === null ? 'NOT_ALLOCATED' : hold.status,
        onHoldForDispute: hold?.holdCode === 'DISPUTE',
        conditions: hold === null ? [] : conditionsOf(hold.conditionsJson),
        releasedAt: hold?.releasedAt?.toISOString() ?? null,
      };
    }),
    receipts,
  };
}
