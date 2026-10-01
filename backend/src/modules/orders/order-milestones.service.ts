/**
 * The buyer's milestone timeline for one order: production, inspection,
 * shipments, documents and payment, read from what already exists.
 *
 * Read-only. It changes no status of any kind.
 *
 * What it is careful NOT to show:
 *   - a seller's internal production note: production comes only from
 *     `SellerOrderBuyerUpdate`, the buyer's copy written when it happened;
 *   - a trade document the seller or a rule hid (`buyerVisibility = HIDDEN`),
 *     or a slot with no version yet;
 *   - document files themselves - only the kind, title and review state.
 */
import { notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { PRODUCTION_STAGES } from '../../domain/production-milestones.js';
import { prisma } from '../../infra/prisma.js';

export type BuyerPaymentState = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED';

export function paymentState(grandTotal: bigint, paid: bigint, refunded: bigint): BuyerPaymentState {
  if (refunded > 0n) return refunded >= paid ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  if (paid <= 0n) return 'UNPAID';
  return paid >= grandTotal ? 'PAID' : 'PARTIALLY_PAID';
}

export interface TimelineEvent {
  at: string;
  kind:
    | 'ORDER_PLACED'
    | 'PAYMENT_CONFIRMED'
    | 'MILESTONE_REACHED'
    | 'MILESTONE_PLANNED'
    | 'DELAY_RAISED'
    | 'DELAY_RESOLVED'
    | 'DOCUMENT_ISSUED'
    | 'SHIPMENT_DISPATCHED'
    | 'SHIPMENT_DELIVERED';
  sellerGroupId: string | null;
  stage?: string;
  reason?: string | null;
  expectedDate?: string | null;
  message?: string | null;
  label?: string | null;
}

function dateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * `scope` is the caller's `orderScopeWhere` - the ownership check is the
 * query itself, so another buyer's order is a 404, not a 403.
 */
export async function readBuyerOrderMilestones(
  scope: { customerProfileId?: string; buyerCompanyId: string | null },
  orderId: string,
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...scope },
    select: {
      id: true,
      currency: true,
      grandTotalMinor: true,
      paidMinor: true,
      refundedMinor: true,
      placedAt: true,
      confirmedAt: true,
      sellerOrderGroups: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          sellerAccount: { select: { displayName: true } },
          buyerUpdates: { orderBy: { createdAt: 'asc' } },
          inspectionRequirement: { select: { level: true, status: true, updatedAt: true } },
          shipments: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              status: true,
              carrierName: true,
              trackingNumber: true,
              trackingUrl: true,
              dispatchedAt: true,
              deliveredAt: true,
            },
          },
          tradeDocuments: {
            where: { currentVersion: { gt: 0 }, OR: [{ buyerVisibility: null }, { buyerVisibility: { not: 'HIDDEN' } }] },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              kind: true,
              title: true,
              currentVersion: true,
              versions: {
                where: { supersededAt: null },
                orderBy: { version: 'desc' },
                take: 1,
                select: { validation: true, issuedOn: true, expiresOn: true, createdAt: true },
              },
            },
          },
        },
      },
    },
  });

  if (order === null) throw notFound('Order');

  const events: TimelineEvent[] = [];
  if (order.placedAt !== null) {
    events.push({ at: order.placedAt.toISOString(), kind: 'ORDER_PLACED', sellerGroupId: null });
  }
  if (order.confirmedAt !== null && order.paidMinor > 0n) {
    events.push({ at: order.confirmedAt.toISOString(), kind: 'PAYMENT_CONFIRMED', sellerGroupId: null });
  }

  const sellers = order.sellerOrderGroups.map((group) => {
    const reached = new Map<string, { at: string; message: string | null }>();
    const planned = new Map<string, string | null>();
    let openDelays: { stage: string; reason: string | null; expectedDate: string | null; message: string | null; raisedAt: string }[] = [];

    for (const update of group.buyerUpdates) {
      const at = update.createdAt.toISOString();
      events.push({
        at,
        kind: update.kind as TimelineEvent['kind'],
        sellerGroupId: group.id,
        stage: update.stage,
        reason: update.reason,
        expectedDate: dateOnly(update.expectedDate),
        message: update.message,
        label: group.sellerAccount.displayName,
      });
      if (update.kind === 'MILESTONE_REACHED') reached.set(update.stage, { at, message: update.message });
      if (update.kind === 'MILESTONE_PLANNED') planned.set(update.stage, dateOnly(update.expectedDate));
      if (update.kind === 'DELAY_RAISED') {
        openDelays.push({
          stage: update.stage,
          reason: update.reason,
          expectedDate: dateOnly(update.expectedDate),
          message: update.message,
          raisedAt: at,
        });
      }
      if (update.kind === 'DELAY_RESOLVED') {
        // The oldest open exception of that stage and reason is the one closed.
        const index = openDelays.findIndex((delay) => delay.stage === update.stage && delay.reason === update.reason);
        if (index >= 0) openDelays = openDelays.filter((_, i) => i !== index);
      }
    }

    for (const shipment of group.shipments) {
      if (shipment.dispatchedAt !== null) {
        events.push({ at: shipment.dispatchedAt.toISOString(), kind: 'SHIPMENT_DISPATCHED', sellerGroupId: group.id, label: shipment.carrierName });
      }
      if (shipment.deliveredAt !== null) {
        events.push({ at: shipment.deliveredAt.toISOString(), kind: 'SHIPMENT_DELIVERED', sellerGroupId: group.id, label: shipment.carrierName });
      }
    }

    const documents = group.tradeDocuments.map((document) => {
      const version = document.versions[0];
      if (version !== undefined) {
        events.push({ at: version.createdAt.toISOString(), kind: 'DOCUMENT_ISSUED', sellerGroupId: group.id, label: document.title });
      }
      return {
        id: document.id,
        kind: document.kind,
        title: document.title,
        version: document.currentVersion,
        validation: version?.validation ?? null,
        issuedOn: dateOnly(version?.issuedOn ?? null),
        expiresOn: dateOnly(version?.expiresOn ?? null),
      };
    });

    return {
      sellerGroupId: group.id,
      sellerName: group.sellerAccount.displayName,
      status: group.status,
      production: {
        stages: PRODUCTION_STAGES.map((stage) => ({
          stage,
          completedAt: reached.get(stage)?.at ?? null,
          note: reached.get(stage)?.message ?? null,
          plannedFor: planned.get(stage) ?? null,
        })),
        openDelays,
      },
      inspection:
        group.inspectionRequirement === null
          ? null
          : { level: group.inspectionRequirement.level, status: group.inspectionRequirement.status },
      shipments: group.shipments.map((shipment) => ({
        id: shipment.id,
        status: shipment.status,
        carrierName: shipment.carrierName,
        trackingNumber: shipment.trackingNumber,
        trackingUrl: shipment.trackingUrl,
        dispatchedAt: shipment.dispatchedAt?.toISOString() ?? null,
        deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
      })),
      documents,
    };
  });

  events.sort((a, b) => a.at.localeCompare(b.at));

  return {
    payment: {
      state: paymentState(order.grandTotalMinor, order.paidMinor, order.refundedMinor),
      total: serialiseMoney(order.grandTotalMinor, order.currency),
      paid: serialiseMoney(order.paidMinor, order.currency),
      refunded: serialiseMoney(order.refundedMinor, order.currency),
      confirmedAt: order.confirmedAt?.toISOString() ?? null,
    },
    sellers,
    events,
  };
}
