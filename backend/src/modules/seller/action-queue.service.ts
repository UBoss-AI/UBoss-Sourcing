/**
 * The seller's daily action queue (ENH-018): one ranked list of what must be
 * done, not count tiles. Overdue first, then anything due within a day, then
 * by deadline; at the same instant a dispute (money and a breach at stake)
 * outranks a dispatch, which outranks a quote; then by amount at stake in its
 * own currency; then by id, so equal tasks always come out in the same order.
 */
import { prisma } from '../../infra/prisma.js';

export type ActionKind = 'DISPUTE_RESPONSE' | 'DISPATCH' | 'QUOTE';

export interface ActionTask {
  kind: ActionKind;
  id: string;
  reference: string;
  dueAt: string;
  overdue: boolean;
  /** Minor units as a string, in `currency`. Null when nothing is stated. */
  amountMinor: string | null;
  currency: string | null;
  href: string;
}

const WEIGHT: Record<ActionKind, number> = { DISPUTE_RESPONSE: 3, DISPATCH: 2, QUOTE: 1 };
const DAY = 86_400_000;
const PER_KIND = 50;

interface Ranked extends ActionTask { at: number; impact: bigint }

export function rankTasks(tasks: Ranked[], now: Date): ActionTask[] {
  const t = now.getTime();
  const band = (task: Ranked): number => (task.at <= t ? 0 : task.at - t < DAY ? 1 : 2);
  return [...tasks]
    .sort((a, b) =>
      band(a) - band(b) ||
      a.at - b.at ||
      WEIGHT[b.kind] - WEIGHT[a.kind] ||
      (a.impact === b.impact ? 0 : a.impact > b.impact ? -1 : 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map(({ at: _at, impact: _impact, ...task }) => task);
}

export async function sellerActionQueue(sellerAccountId: string, now: Date = new Date()): Promise<ActionTask[]> {
  const [orders, invitations, disputes] = await Promise.all([
    prisma.sellerOrderGroup.findMany({
      where: { sellerAccountId, status: { in: ['NEW', 'ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH'] }, dispatchDueAt: { not: null } },
      select: { id: true, sellerOrderNumber: true, dispatchDueAt: true, goodsTotalMinor: true, currency: true },
      orderBy: [{ dispatchDueAt: 'asc' }, { id: 'asc' }],
      take: PER_KIND,
    }),
    prisma.rfqInvitation.findMany({
      where: { sellerAccountId, status: { in: ['INVITED', 'VIEWED'] }, rfq: { status: 'OPEN', responseDeadline: { not: null } } },
      select: { rfq: { select: { id: true, reference: true, responseDeadline: true, targetUnitPriceMinor: true, quantity: true, targetCurrency: true } } },
      orderBy: [{ rfq: { responseDeadline: 'asc' } }, { id: 'asc' }],
      take: PER_KIND,
    }),
    prisma.dispute.findMany({
      where: { sellerAccountId, status: 'AWAITING_SELLER', sellerResponseDueAt: { not: null } },
      select: { id: true, reference: true, sellerResponseDueAt: true, requestedAmountMinor: true, currency: true },
      orderBy: [{ sellerResponseDueAt: 'asc' }, { id: 'asc' }],
      take: PER_KIND,
    }),
  ]);
  const t = now.getTime();
  const task = (kind: ActionKind, id: string, reference: string, due: Date, impact: bigint | null, currency: string | null, href: string): Ranked => ({
    kind, id, reference, dueAt: due.toISOString(), overdue: due.getTime() <= t,
    amountMinor: impact === null ? null : impact.toString(), currency: impact === null ? null : currency, href, at: due.getTime(), impact: impact ?? 0n,
  });
  const all: Ranked[] = [
    ...orders.map((o) => task('DISPATCH', o.id, o.sellerOrderNumber, o.dispatchDueAt as Date, o.goodsTotalMinor, o.currency, `/seller/orders/${o.id}`)),
    ...invitations.map(({ rfq }) => {
      // Whole units only: a fractional quantity has no exact minor-unit total, so it states none.
      const whole = rfq.quantity !== null && rfq.quantity.isInteger() ? BigInt(rfq.quantity.toFixed(0)) : null;
      const impact = rfq.targetUnitPriceMinor !== null && whole !== null ? rfq.targetUnitPriceMinor * whole : null;
      return task('QUOTE', rfq.id, rfq.reference, rfq.responseDeadline as Date, impact, rfq.targetCurrency, `/seller/rfqs/${rfq.id}`);
    }),
    ...disputes.map((d) => task('DISPUTE_RESPONSE', d.id, d.reference, d.sellerResponseDueAt as Date, d.requestedAmountMinor, d.currency, `/seller/disputes/${d.reference}`)),
  ];
  return rankTasks(all, now);
}
