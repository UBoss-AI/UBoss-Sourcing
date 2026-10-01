/**
 * The buyer's milestone timeline for one order. Read-only.
 */
import { api } from '@/lib/api';
import type { ProductionDelayReason, ProductionStage } from '@/lib/seller-workbench';

interface Money {
  minor: string;
  formatted: string;
  currency: string;
}

export type BuyerPaymentState = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED';

export type MilestoneEventKind =
  | 'ORDER_PLACED'
  | 'PAYMENT_CONFIRMED'
  | 'MILESTONE_REACHED'
  | 'MILESTONE_PLANNED'
  | 'DELAY_RAISED'
  | 'DELAY_RESOLVED'
  | 'DOCUMENT_ISSUED'
  | 'SHIPMENT_DISPATCHED'
  | 'SHIPMENT_DELIVERED';

export interface OrderMilestones {
  payment: { state: BuyerPaymentState; total: Money; paid: Money; refunded: Money; confirmedAt: string | null };
  sellers: {
    sellerGroupId: string;
    sellerName: string;
    status: string;
    production: {
      stages: { stage: ProductionStage; completedAt: string | null; note: string | null; plannedFor: string | null }[];
      openDelays: {
        stage: ProductionStage;
        reason: ProductionDelayReason | null;
        expectedDate: string | null;
        message: string | null;
        raisedAt: string;
      }[];
    };
    inspection: { level: string; status: string } | null;
    shipments: {
      id: string;
      status: string;
      carrierName: string | null;
      trackingNumber: string | null;
      trackingUrl: string | null;
      dispatchedAt: string | null;
      deliveredAt: string | null;
    }[];
    documents: {
      id: string;
      kind: string;
      title: string;
      version: number;
      validation: 'PENDING_REVIEW' | 'VALID' | 'REJECTED' | null;
      issuedOn: string | null;
      expiresOn: string | null;
    }[];
  }[];
  events: {
    at: string;
    kind: MilestoneEventKind;
    sellerGroupId: string | null;
    stage?: ProductionStage;
    reason?: ProductionDelayReason | null;
    expectedDate?: string | null;
    message?: string | null;
    label?: string | null;
  }[];
}

export function fetchOrderMilestones(orderId: string): Promise<OrderMilestones> {
  return api.get<OrderMilestones>(`/orders/${orderId}/milestones`);
}
