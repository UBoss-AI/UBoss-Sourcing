/**
 * Turning one buyer's order into each seller's share of it.
 *
 * A buyer places ONE order and pays once. A marketplace order, though, is
 * several pieces of work for several businesses: three sellers each pack their
 * own box, each gets their own dispatch deadline, each is owed their own money,
 * and each may cancel their part without touching the others'. That is what a
 * `SellerOrderGroup` is — a seller's view of an order, with its own number, its
 * own status and its own arithmetic.
 *
 * WHEN THIS RUNS
 *
 * On confirmation, not on placement. An order that has not been paid for is not
 * work a seller should start, and the split is what puts it on their screen. It
 * is called from inside `transitionOrder`'s CONFIRMED branch and shares that
 * transaction, so an order cannot end up confirmed with its sellers unaware of
 * it — or, worse, split twice.
 *
 * IT IS IDEMPOTENT, and that is not optional. A payment provider will resend a
 * webhook, and a second confirmation of the same order must not create a second
 * set of groups. The `uq_seller_order_group` unique index on
 * `(orderId, sellerAccountId)` is the backstop; this checks first so the common
 * case is a cheap read rather than a caught constraint violation.
 *
 * LINES WITHOUT A SELLER ARE NOT AN ERROR. An order line with no
 * `sellerOfferId` is the operator's own stock, which is most lines on most
 * deployments. Those produce no group, because nobody else is owed anything for
 * them and nobody else has to pack them. An order made entirely of operator
 * stock splits into nothing at all, silently and correctly.
 *
 * THE MONEY IS COMPUTED ONCE AND KEPT
 *
 * Every figure here is stored on the group rather than recomputed on read, and
 * the commission RATE is stored beside the figure it produced. A seller's
 * settlement must not move because they edited their price afterwards, or
 * because the operator changed the platform rate in March. Without the stored
 * rate a disputed settlement cannot even be recomputed to show it was right.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { notifySeller } from './notification.service.js';

type Tx = Prisma.TransactionClient;

export interface SplitResult {
  /** Groups created by this call. Zero on a re-run, and on an operator-only order. */
  groups: number;
  /** Seller order lines created. */
  lines: number;
}

/**
 * Allocate the next order number for one seller.
 *
 * Sequential PER SELLER, so a seller's own paperwork numbers from one and does
 * not leak how many orders the marketplace as a whole has taken — which is
 * commercially sensitive and none of their business. A counter row per seller,
 * incremented with `value = value + 1` so it takes an InnoDB row lock and two
 * concurrent confirmations cannot collide. Gaps are fine; duplicates are not,
 * and `uq_seller_order_number` refuses them anyway.
 */
async function nextSellerOrderNumber(tx: Tx, sellerAccountId: string): Promise<string> {
  const key = `seller-order:${sellerAccountId}`;

  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: 'SO', padding: 5 },
  });

  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });

  return `${sequence.prefix}-${sequence.value.toString().padStart(sequence.padding, '0')}`;
}

/**
 * What the marketplace keeps from this seller, in basis points.
 *
 * The seller's own rate wins where they have one — a seller negotiated onto a
 * different schedule keeps it when the platform rate moves, which is the whole
 * reason that column is nullable. Otherwise the platform rate, which defaults
 * to zero: a deployment that has not decided what it charges must not quietly
 * start charging something.
 */
export function commissionBasisPointsFor(
  sellerRate: number | null,
  platformRate: number,
): number {
  const rate = sellerRate ?? platformRate;
  // Clamped rather than trusted. A negative rate would pay the seller more than
  // the buyer paid, and anything at or above 100% would pay them nothing or
  // less than nothing; both are configuration mistakes rather than deals.
  return Math.max(0, Math.min(10_000, Math.trunc(rate)));
}

/**
 * Commission on an amount, rounded half-up to the minor unit.
 *
 * BigInt throughout, and the rounding is explicit. `(amount * bp) / 10000` in
 * integer arithmetic truncates, which quietly favours the seller by up to one
 * paisa per line — small, systematic, and exactly the kind of drift that makes
 * a settlement fail to reconcile by a few rupees nobody can account for.
 */
export function commissionOn(amountMinor: bigint, basisPoints: number): bigint {
  if (basisPoints <= 0 || amountMinor <= 0n) return 0n;

  const numerator = amountMinor * BigInt(basisPoints);
  const half = 10_000n / 2n;

  return (numerator + half) / 10_000n;
}

/**
 * Split a confirmed order into one group per seller.
 *
 * Pass the transaction the confirmation is running in. Returns what it created
 * so the caller can log it; creates nothing and returns zeroes when the order
 * has no seller lines, or has already been split.
 */
export async function splitOrderToSellers(orderId: string, tx: Tx): Promise<SplitResult> {
  const items = await tx.orderItem.findMany({
    where: { orderId, sellerOfferId: { not: null } },
    select: {
      id: true,
      sellerOfferId: true,
      quantity: true,
      unitPriceMinor: true,
      lineSubtotalMinor: true,
      lineTotalMinor: true,
      taxAmountMinor: true,
      sellerOffer: { select: { sellerAccountId: true } },
    },
  });

  if (items.length === 0) return { groups: 0, lines: 0 };

  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { currency: true, orderNumber: true },
  });

  // Already split? A resent webhook is the normal reason, not a bug.
  const existing = await tx.sellerOrderGroup.findFirst({
    where: { orderId },
    select: { id: true },
  });

  if (existing !== null) return { groups: 0, lines: 0 };

  const platformRate =
    (await tx.businessProfile.findFirst({ select: { sellerCommissionBasisPoints: true } }))
      ?.sellerCommissionBasisPoints ?? 0;

  // Group the lines by seller. One pass, in memory: an order has tens of lines,
  // not thousands, and a query per seller inside a confirmation transaction is
  // how a webhook times out.
  const bySeller = new Map<string, typeof items>();

  for (const item of items) {
    const sellerAccountId = item.sellerOffer?.sellerAccountId;
    if (sellerAccountId === undefined) continue;

    const group = bySeller.get(sellerAccountId) ?? [];
    group.push(item);
    bySeller.set(sellerAccountId, group);
  }

  const sellers = await tx.sellerAccount.findMany({
    where: { id: { in: [...bySeller.keys()] } },
    select: { id: true, commissionBasisPoints: true },
  });

  const rateBySeller = new Map(
    sellers.map((seller) => [
      seller.id,
      commissionBasisPointsFor(seller.commissionBasisPoints, platformRate),
    ]),
  );

  let groups = 0;
  let lines = 0;

  for (const [sellerAccountId, sellerItems] of bySeller) {
    const basisPoints = rateBySeller.get(sellerAccountId) ?? 0;
    const groupId = newId();
    const sellerOrderNumber = await nextSellerOrderNumber(tx, sellerAccountId);

    /*
     * Commission is taken on the GOODS, not on tax and not on shipping.
     *
     * Tax is not the seller's revenue — it is money passing through them to a
     * tax authority — and charging a percentage of it would mean the
     * marketplace's take moved with the VAT rate of the country the buyer
     * happened to be in. Shipping is excluded for the same reason: it is
     * recovery of a cost, not margin.
     */
    let goodsTotalMinor = 0n;
    let taxTotalMinor = 0n;
    let commissionMinor = 0n;

    const lineRows = sellerItems.map((item) => {
      const lineCommission = commissionOn(item.lineSubtotalMinor, basisPoints);

      goodsTotalMinor += item.lineSubtotalMinor;
      taxTotalMinor += item.taxAmountMinor;
      commissionMinor += lineCommission;

      return {
        id: newId(),
        orderGroupId: groupId,
        orderItemId: item.id,
        // Non-null by the query's own filter; narrowed for the type.
        offerId: item.sellerOfferId ?? '',
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        lineTotalMinor: item.lineTotalMinor,
        commissionMinor: lineCommission,
        sellerNetMinor: item.lineSubtotalMinor - lineCommission,
        currency: order.currency,
      };
    });

    await tx.sellerOrderGroup.create({
      data: {
        id: groupId,
        sellerAccountId,
        orderId,
        sellerOrderNumber,
        status: 'NEW',
        goodsTotalMinor,
        taxTotalMinor,
        // Marketplace shipping is not apportioned per seller yet — there is no
        // per-seller shipping quote to apportion. Zero is the honest figure,
        // not a guess at a share of the buyer's delivery charge.
        shippingTotalMinor: 0n,
        commissionMinor,
        sellerNetMinor: goodsTotalMinor - commissionMinor,
        currency: order.currency,
        commissionBasisPointsApplied: basisPoints,
        // No dispatch deadline yet. It is set from the location's cut-off and
        // handling time when the seller accepts and says where it ships from —
        // before that there is no location to compute one against, and a
        // deadline invented from nothing is a seller marked late unfairly.
        dispatchDueAt: null,
      },
    });

    await tx.sellerOrderLine.createMany({ data: lineRows });

    await notifySeller({
      sellerAccountId,
      kind: 'NEW_ORDER',
      title: `New order ${sellerOrderNumber}`,
      body:
        lineRows.length === 1
          ? 'One line to pack. Accept it to set your dispatch deadline.'
          : `${String(lineRows.length)} lines to pack. Accept it to set your dispatch deadline.`,
      linkPath: `/seller/orders/${groupId}`,
      severity: 'INFO',
      subjectType: 'seller_order_group',
      subjectId: groupId,
      tx,
    });

    groups += 1;
    lines += lineRows.length;
  }

  return { groups, lines };
}

/** The same split, outside a caller's transaction. For backfills and tests. */
export async function splitOrder(orderId: string): Promise<SplitResult> {
  return prisma.$transaction((tx) => splitOrderToSellers(orderId, tx));
}
