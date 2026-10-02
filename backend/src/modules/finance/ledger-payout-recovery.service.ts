import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import type { PayoutProviderAdapter } from '../seller/payout.service.js';
import { postEntry, reverseEntry } from './ledger.service.js';

export const PAYOUT_UNKNOWN_MESSAGE = 'The provider result is unknown. Funds remain reserved; reconcile the original payout reference before any new payment.';
export const DEFINITIVE_PAYOUT_FAILURE = 'DEFINITIVE_REJECTION';

export async function markPayoutUnknown(payoutId: string): Promise<void> {
  await prisma.sellerPayout.updateMany({ where: { id: payoutId, status: 'PENDING' }, data: {
    providerStatusRaw: 'UNKNOWN', lastAttemptError: PAYOUT_UNKNOWN_MESSAGE, remediationHint: PAYOUT_UNKNOWN_MESSAGE,
  } });
}

/** Lock the business operation, not a process-local promise: restarts and concurrent reads are harmless. */
export async function settleLedgerPayout(tx: PrismaTransaction, payoutId: string, sent: { providerPayoutId: string; status: 'PENDING' | 'IN_TRANSIT' | 'PAID' }, actorLabel: string): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM seller_payouts WHERE id = ${payoutId} FOR UPDATE`;
  const payout = await tx.sellerPayout.findUniqueOrThrow({ where: { id: payoutId } });
  if (payout.status !== 'PENDING' && payout.status !== 'IN_TRANSIT') return false;
  await tx.sellerPayout.update({ where: { id: payoutId }, data: {
    status: sent.status === 'PAID' ? 'PAID' : 'IN_TRANSIT', providerPayoutId: sent.providerPayoutId,
    providerStatusRaw: sent.status, paidAt: sent.status === 'PAID' ? new Date() : null,
    failureCode: null, failureReason: null, lastAttemptError: null, remediationHint: null,
  } });
  if (sent.status === 'PAID') await postEntry(tx, {
    kind: 'PAYOUT_SETTLED', idempotencyKey: `payout-settled:${payoutId}`, currency: payout.currency,
    memo: `Payout ${payout.reference} confirmed by the provider`, actorLabel,
    sellerAccountId: payout.sellerAccountId, payoutId, providerReference: sent.providerPayoutId,
    lines: [
      { code: 'PAYOUTS_IN_TRANSIT', amountMinor: payout.amountMinor },
      { code: 'PROVIDER_BALANCE', amountMinor: -payout.amountMinor },
    ],
  });
  return true;
}

/** Only a provider's definitive rejection can release the reserved funds. */
export async function rejectLedgerPayout(tx: PrismaTransaction, payoutId: string, reason: string, actorLabel: string): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM seller_payouts WHERE id = ${payoutId} FOR UPDATE`;
  const payout = await tx.sellerPayout.findUniqueOrThrow({ where: { id: payoutId } });
  if (payout.status !== 'PENDING' && payout.status !== 'IN_TRANSIT') return false;
  const entry = await tx.ledgerEntry.findFirstOrThrow({ where: { payoutId, kind: 'PAYOUT_INITIATED' } });
  await tx.sellerPayout.update({ where: { id: payoutId }, data: {
    status: 'FAILED', providerStatusRaw: 'FAILED', failureCode: DEFINITIVE_PAYOUT_FAILURE,
    failureReason: reason, lastAttemptError: reason,
    remediationHint: 'The provider confirmed rejection. Correct the payout account before finance runs payouts again.',
  } });
  await reverseEntry(tx, entry.id, `Payout ${payout.reference} definitively rejected: money back to available`, actorLabel);
  await tx.sellerFundHold.updateMany({ where: { payoutId }, data: { payoutId: null } });
  return true;
}

/** Includes pre-fix reversals: an old FAILED label alone does not prove the provider did not pay. */
export function unresolvedPayoutWhere(sellerAccountId: string, currency: string) {
  return {
    sellerAccountId, currency, idempotencyKey: { startsWith: 'ledger-payout:' },
    OR: [
      { status: { in: ['PENDING', 'IN_TRANSIT'] as ('PENDING' | 'IN_TRANSIT')[] } },
      { status: 'FAILED' as const, OR: [{ failureCode: null }, { failureCode: { not: DEFINITIVE_PAYOUT_FAILURE } }] },
    ],
  };
}

/** Read-only provider reconciliation. Never POST an unknown payout, even if lookup returns no transfer. */
export async function reconcileLedgerPayouts(sellerAccountId: string, currency: string, adapter: PayoutProviderAdapter, actorLabel: string) {
  const rows = await prisma.sellerPayout.findMany({ where: unresolvedPayoutWhere(sellerAccountId, currency) });
  const paid: { sellerAccountId: string; payoutId: string; amountMinor: string; currency: string }[] = [];
  const failed: { sellerAccountId: string; payoutId: string; reason: string }[] = [];
  for (const payout of rows) {
    if (payout.status === 'FAILED') {
      await prisma.sellerPayout.updateMany({ where: { id: payout.id, status: 'FAILED' }, data: {
        remediationHint: 'Legacy reversal has no definitive provider rejection evidence. Finance must reconcile this original reference before any new payout.',
      } });
      continue;
    }
    if (payout.provider !== adapter.name || adapter.readPayout === undefined) { await markPayoutUnknown(payout.id); continue; }
    try {
      const outcome = await adapter.readPayout({ reference: payout.reference, idempotencyKey: payout.idempotencyKey ?? '', amountMinor: payout.amountMinor, currency: payout.currency });
      if (outcome.status === 'UNKNOWN') { await markPayoutUnknown(payout.id); continue; }
      if (outcome.status === 'FAILED') {
        const reason = 'The provider confirmed that the original payout failed without moving funds.';
        const changed = await prisma.$transaction(tx => rejectLedgerPayout(tx, payout.id, reason, actorLabel));
        if (changed) failed.push({ sellerAccountId, payoutId: payout.id, reason });
      } else {
        const changed = await prisma.$transaction(tx => settleLedgerPayout(tx, payout.id, outcome, actorLabel));
        if (changed) paid.push({ sellerAccountId, payoutId: payout.id, amountMinor: payout.amountMinor.toString(), currency });
      }
    } catch {
      await markPayoutUnknown(payout.id);
    }
  }
  const unresolved = await prisma.sellerPayout.count({ where: unresolvedPayoutWhere(sellerAccountId, currency) });
  return { paid, failed, unresolved };
}
