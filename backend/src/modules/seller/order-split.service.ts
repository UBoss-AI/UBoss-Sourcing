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
import { enqueueIfConnected } from '../seller-erp/job.service.js';

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
      /*
       * The frozen bulk breakdown, where the line has one.
       *
       * Selected here so the seller's "new order" notice can say "2 UK pallets
       * (2,400 units)" rather than "2,400 units" - and so it can be a BULK
       * order notice rather than an ordinary one. Null on every line that is
       * not a bulk order, which is most of them, and the notice then reads
       * exactly as it always has.
       */
      packaging: {
        select: {
          packageType: true,
          packageQuantity: true,
          unitsPerPackage: true,
          totalBaseUnits: true,
        },
      },
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

    /*
     * A BULK order is announced as one.
     *
     * Not a NEW_ORDER with different wording. It is a different job: a pallet
     * order needs a forklift booked and a lorry found, and the seller who
     * reads "new order", pictures a box, and plans their afternoon accordingly
     * discovers the difference on the loading bay.
     *
     * Read off the frozen snapshots on the order lines, which are already
     * loaded - no extra query for the ordinary order, which has none.
     */
    const bulkSummary = summariseBulk(
      sellerItems.map((item) => item.packaging ?? null),
    );

    await notifySeller({
      sellerAccountId,
      kind: bulkSummary === null ? 'NEW_ORDER' : 'BULK_ORDER_RECEIVED',
      title:
        bulkSummary === null
          ? `New order ${sellerOrderNumber}`
          : `New bulk order ${sellerOrderNumber}`,
      body:
        bulkSummary ??
        (lineRows.length === 1
          ? 'One line to pack. Accept it to set your dispatch deadline.'
          : `${String(lineRows.length)} lines to pack. Accept it to set your dispatch deadline.`),
      linkPath: `/seller/orders/${groupId}`,
      severity: 'INFO',
      subjectType: 'seller_order_group',
      subjectId: groupId,
      tx,
    });

    /*
     * Tell the seller's own accounting system, inside this transaction.
     *
     * A TRANSACTIONAL OUTBOX, and the transaction is the point: an order that
     * committed must not be able to lose the fact that Tally has to be told,
     * and a rolled-back split must not leave a job behind claiming an order
     * exists. `enqueueIfConnected` does nothing at all for the overwhelming
     * majority of sellers, who have no ERP connected - two indexed reads and
     * out.
     *
     * The payload is a REFERENCE rather than a built voucher. Assembling one
     * here would mean assembling it inside the checkout transaction, on the
     * critical path of somebody paying; the dispatch beat builds it a moment
     * later. The EVENT is what must be recorded transactionally, not its
     * rendering.
     */
    await enqueueIfConnected({
      sellerAccountId,
      eventType: 'SALES_ORDER',
      sourceEntityType: 'seller_order_group',
      sourceEntityId: groupId,
      orderId,
      sellerOrderGroupId: groupId,
      payload: { kind: 'ORDER_BACKFILL', sellerOrderGroupId: groupId },
      // Everything about ONE buyer order stays in order behind one key, so a
      // Receipt can never post before the Invoice it pays.
      sequenceKey: orderId,
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

/**
 * Let the sellers' progress move the buyer's order.
 *
 * The buyer has one order and reads one status. On a marketplace order that
 * status has no other source: nobody on the operator's staff picks it, so
 * without this it sits at "Confirmed - we are getting your order ready" while
 * the seller packs it, ships it and the buyer signs for it.
 *
 * THREE RULES, AND EACH EXISTS BECAUSE THE OBVIOUS VERSION IS WRONG:
 *
 *   - **An order with any of the operator's own lines is left alone.** Part of
 *     it is genuinely this shop's work, and a status saying "shipped" while a
 *     box is still on their own shelf is a lie to the buyer and a lost pick in
 *     the warehouse. Staff drive those, as they always have.
 *   - **It moves only when every group has.** One seller of three dispatching
 *     is not an order that has shipped. A buyer told "shipped" who then waits
 *     a week for the other two boxes has been told something false.
 *   - **Cancelled groups do not hold it back**, but an order whose groups are
 *     ALL cancelled is not "shipped" either - it is cancelled, which is the
 *     operator's decision through the refund path and not something to infer
 *     from here.
 *
 * WHY THIS IS NOT IN THE CALLER'S TRANSACTION
 *
 * `transitionOrder` owns the buyer's order: it commits its own transaction and
 * then sends the buyer's email and hands the order to their ERP. Reaching
 * inside it from here would either skip both or nest one transaction in
 * another and deadlock on the rows the outer one is holding. So this runs
 * after the seller's group is safely written, and it is written to be re-run:
 * it reads the groups as they are now and moves the order at most one step per
 * state, so a crash in between is repaired by the next dispatch, the next
 * delivery, or a call to this function - never doubled.
 */
export async function syncOrderWithSellerGroups(orderId: string): Promise<void> {
  const operatorLines = await prisma.orderItem.count({
    where: { orderId, sellerOfferId: null },
  });

  if (operatorLines > 0) return;

  const groups = await prisma.sellerOrderGroup.findMany({
    where: { orderId },
    select: { status: true },
  });

  const live = groups.filter((group) => group.status !== 'CANCELLED');
  if (live.length === 0) return;

  const everyGroupDelivered = live.every((group) => group.status === 'DELIVERED');
  const everyGroupGone = live.every(
    (group) => group.status === 'SHIPPED' || group.status === 'DELIVERED',
  );
  const anyGroupStarted = live.some((group) => group.status !== 'NEW');

  // Imported here rather than at the top of the file: `order.service` imports
  // the split above, and a static import back would be a cycle.
  const { transitionOrder } = await import('../orders/order.service.js');

  const actor = { userId: null, email: null, type: 'SYSTEM' as const };

  const move = async (
    to: 'PROCESSING' | 'SHIPPED' | 'DELIVERED',
    reason: string,
  ): Promise<void> => {
    await transitionOrder({ orderId, to, actor, reason });
  };

  /*
   * One step at a time, through the states the machine actually has.
   *
   * CONFIRMED -> PROCESSING -> SHIPPED -> DELIVERED, never a jump: the history
   * an order carries is what support reads back to a buyer asking what
   * happened, and a row missing from it is a question nobody can answer. The
   * status is re-read between steps because each one is its own transaction.
   */
  const statusOf = async (): Promise<string | null> => {
    const row = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
    return row?.status ?? null;
  };

  if ((await statusOf()) === 'CONFIRMED' && (anyGroupStarted || everyGroupGone)) {
    await move('PROCESSING', 'A seller started work on their part');
  }

  if (!everyGroupGone) return;

  if ((await statusOf()) === 'PROCESSING') {
    await move('SHIPPED', 'Every seller has dispatched their part');
  }

  if (!everyGroupDelivered) return;

  if ((await statusOf()) === 'SHIPPED') {
    await move('DELIVERED', 'Every seller has delivered their part');
  }
}

/**
 * "2 UK pallets and 1 container (14,400 units in all)", or null.
 *
 * Null when nothing on the order was bought by the package, which is the
 * ordinary case and is what makes the notice read exactly as it always has.
 *
 * English here, deliberately. A seller notification is composed on the server
 * and stored as text - there is no translation layer between this and the
 * bell - and that is a pre-existing property of `SellerNotification` rather
 * than something this feature introduces. What a BUYER reads is built in the
 * frontend from structured figures in their own language; this is the
 * seller's own operational alert on their own hub.
 */
function summariseBulk(
  snapshots: readonly ({ packageType: string; packageQuantity: number; totalBaseUnits: number } | null)[],
): string | null {
  const counts = new Map<string, number>();
  let totalUnits = 0;
  let sawAny = false;

  for (const snapshot of snapshots) {
    if (snapshot === null) continue;
    sawAny = true;
    counts.set(
      snapshot.packageType,
      (counts.get(snapshot.packageType) ?? 0) + snapshot.packageQuantity,
    );
    totalUnits += snapshot.totalBaseUnits;
  }

  if (!sawAny) return null;

  const words = [...counts.entries()].map(([type, quantity]) => {
    const plural = quantity === 1 ? '' : 's';
    const noun =
      type === 'CARTON'
        ? `carton${plural}`
        : type === 'UK_PALLET'
          ? `UK pallet${plural}`
          : type === 'US_PALLET'
            ? `US pallet${plural}`
            : `container${plural}`;
    return `${String(quantity)} ${noun}`;
  });

  return (
    `${words.join(', ')} - ${totalUnits.toLocaleString('en-GB')} units in all. ` +
    'Check you can load and move it before you accept.'
  );
}
