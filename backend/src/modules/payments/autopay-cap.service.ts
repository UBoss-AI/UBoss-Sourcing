/** Shared period usage for preview and the atomic payment reservation. */
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { capPeriodWindow, type AutoPayCapPeriodName } from '../../domain/autopay-authority.js';

/**
 * What automatic (off-session, scheduled) charges have taken - or are in the
 * middle of taking - from this customer in the current period.
 *
 * Counted from the payment attempts themselves rather than from orders, and
 * including attempts still in flight: two plans running in the same minute
 * must not both see the whole cap available. A failed or cancelled attempt
 * moved no money and does not count. Only the scheduled engine's own charges
 * count (their idempotency key is the occurrence's, `occ:...`): an order the
 * customer paid by hand was not taken under this authority.
 */
export async function automaticChargesInPeriod(
  customerProfileId: string,
  currency: string,
  period: AutoPayCapPeriodName,
  now: Date,
  client: Pick<PrismaTransaction, 'paymentTransaction'> = prisma,
  excludedAttemptId?: string,
): Promise<bigint> {
  const window = capPeriodWindow(now, period);
  const total = await client.paymentTransaction.aggregate({
    where: {
      ...(excludedAttemptId === undefined ? {} : { id: { not: excludedAttemptId } }),
      currency,
      idempotencyKey: { startsWith: 'occ:' },
      status: { in: ['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED'] },
      createdAt: { gte: window.start, lt: window.end },
      order: { customerProfileId },
    },
    _sum: { amountMinor: true },
  });
  return total._sum.amountMinor ?? 0n;
}
