/**
 * Refunds whose webhook never came (LIVE-017).
 *
 * A refund the provider accepted but has not finished is PROCESSING, and the
 * provider's webhook is what normally settles it. Webhooks are lost: an
 * endpoint down for an hour, a secret rotated in the wrong order, a proxy
 * that dropped the body. Before this existed such a refund stayed PROCESSING
 * for ever - the buyer had their money, the seller's settlement still counted
 * it, and the payment reconciliation could not see the gap, because the
 * order's refunded total had already moved when the provider accepted.
 *
 * So the worker asks. A refund still PROCESSING some minutes after it was
 * last touched is looked up at the provider; a terminal answer is applied in
 * exactly the way the webhook applies it - the refund's status, then the
 * sellers' settlements re-derived from every succeeded refund - so a webhook
 * that arrives late, before or after, lands on the same numbers.
 *
 * The update is conditional on the row still being PROCESSING, so a webhook
 * racing the poll cannot be applied twice. A provider that does not answer is
 * logged and tried again on the next beat; nothing is guessed.
 */
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { syncSettlementRefunds } from '../seller/settlement-refund.service.js';
import { loadActiveProvider, type LoadedProvider } from './payment.service.js';
import type { ProviderKind } from './provider.js';

/** How long a refund may sit PROCESSING before the provider is asked. */
export const REFUND_POLL_AFTER_MINUTES = 15;
/** At most this many refunds per pass; the rest wait for the next beat. */
const BATCH = 50;

export interface RefundPollResult {
  checked: number;
  succeeded: number;
  failed: number;
  stillProcessing: number;
  /** The provider could not be asked (outage, refusal, not configured). */
  unreachable: number;
}

/**
 * One pass. `loadProvider` is the seam a test uses to point the real adapter
 * at a fake provider; production passes nothing.
 */
export async function pollProcessingRefunds(
  now: Date = new Date(),
  loadProvider: (kind: ProviderKind) => Promise<LoadedProvider> = loadActiveProvider,
): Promise<RefundPollResult> {
  const result: RefundPollResult = { checked: 0, succeeded: 0, failed: 0, stillProcessing: 0, unreachable: 0 };
  const due = await prisma.refund.findMany({
    where: {
      status: 'PROCESSING',
      providerRefundId: { not: null },
      updatedAt: { lte: new Date(now.getTime() - REFUND_POLL_AFTER_MINUTES * 60_000) },
    },
    orderBy: { updatedAt: 'asc' },
    take: BATCH,
    select: { id: true, orderId: true, provider: true, providerRefundId: true, amountMinor: true, currency: true },
  });
  if (due.length === 0) return result;

  const providers = new Map<ProviderKind, LoadedProvider | null>();
  const providerFor = async (kind: ProviderKind) => {
    if (!providers.has(kind)) {
      try {
        const loaded = await loadProvider(kind);
        providers.set(kind, loaded.kind === kind ? loaded : null);
      } catch {
        providers.set(kind, null);
      }
    }
    return providers.get(kind) ?? null;
  };

  for (const refund of due) {
    result.checked += 1;
    const loaded = await providerFor(refund.provider);
    const ask = loaded?.provider.fetchRefundStatus?.bind(loaded.provider);
    if (ask === undefined || refund.providerRefundId === null) {
      result.unreachable += 1;
      continue;
    }

    let answer: Awaited<ReturnType<typeof ask>>;
    try {
      answer = await ask(refund.providerRefundId);
    } catch (error) {
      result.unreachable += 1;
      logger.warn({ refundId: refund.id, err: error }, 'refund poll: the provider could not be asked');
      continue;
    }

    // An answer about some other refund is not an answer about this one.
    if (answer.providerRefundId !== refund.providerRefundId) {
      result.unreachable += 1;
      logger.warn({ refundId: refund.id }, 'refund poll: the provider answered about a different refund');
      continue;
    }

    if (answer.status === 'PROCESSING') {
      result.stillProcessing += 1;
      continue;
    }

    const applied = await prisma.$transaction(async (tx) => {
      const moved = await tx.refund.updateMany({
        where: { id: refund.id, status: 'PROCESSING' },
        data: {
          status: answer.status,
          completedAt: now,
          ...(answer.failureMessage === null ? {} : { failureMessage: answer.failureMessage.slice(0, 500) }),
        },
      });
      if (moved.count !== 1) return false;
      await syncSettlementRefunds(refund.orderId, tx);
      await recordAudit(
        {
          action: AuditAction.REFUND_COMPLETED,
          resourceType: 'refund',
          resourceId: refund.id,
          actorType: 'SYSTEM',
          before: { status: 'PROCESSING' },
          after: {
            status: answer.status,
            orderId: refund.orderId,
            amountMinor: refund.amountMinor,
            currency: refund.currency,
            source: 'refund_poll',
          },
        },
        tx,
      );
      return true;
    });

    if (!applied) continue;
    if (answer.status === 'SUCCEEDED') result.succeeded += 1;
    else result.failed += 1;
  }

  return result;
}
