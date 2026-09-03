/**
 * Order types and status presentation, shared by the list and the detail page.
 *
 * The status vocabulary is the SOP's, and it is not editable here - the
 * backend's state machine decides what may follow what, and this file only
 * decides how each state looks.
 */
import type { BadgeTone } from '@/components/ui';
import type { Money, Pagination } from './types';

export interface OrderTotals {
  subtotal: Money;
  discount: Money;
  tax: Money;
  shipping: Money;
  grandTotal: Money;
  paid: Money;
  refunded: Money;
}

export interface OrderCustomer {
  id: string;
  fullName: string | null;
  organization: string | null;
  email?: string;
  status?: string;
}

export interface OrderListItem {
  id: string;
  orderNumber: string;
  status: string;
  source: string;
  currency: string;
  totals: OrderTotals;
  paymentMode: string | null;
  placedAt: string | null;
  confirmedAt: string | null;
  itemCount: number;
  createdAt: string;
  customer: OrderCustomer | null;
}

export interface OrderListResponse {
  orders: OrderListItem[];
  pagination: Pagination;
}

export interface OrderAddress {
  contactName: string | null;
  contactPhone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
}

export interface OrderItem {
  id: string;
  productId: string;
  name: string;
  sku: string;
  variantName: string | null;
  quantity: number;
  unitPrice: Money;
  lineSubtotal: Money;
  tax: Money;
  lineTotal: Money;
  taxRatePercent: string;
  taxClassCode: string;
}

export interface TimelineEntry {
  from: string | null;
  to: string;
  actorType: string;
  actorUserId: string | null;
  reason: string | null;
  at: string;
}

export interface AvailableTransition {
  to: string;
  requiresReason: boolean;
  permission: string | null;
}

export interface OrderPaymentLink {
  id: string;
  recipientEmail: string;
  amount: Money;
  expiresAt: string;
  sentAt: string | null;
  usedAt: string | null;
  revokedAt: string | null;
}

export interface OrderPayment {
  id: string;
  status: string;
  amount: Money;
  capturedAmount?: Money;
  provider?: string;
  providerPaymentId?: string | null;
  method?: string | null;
  failureMessage?: string | null;
  createdAt: string;
}

export interface OrderRefund {
  id: string;
  status: string;
  amount: Money;
  reason: string | null;
  createdAt: string;
}

export interface OrderApproval {
  id: string;
  decision: string;
  comment: string | null;
  decidedAt: string | null;
  approverEmail: string | null;
}

export interface OrderDetail extends OrderListItem {
  shippingAddress: OrderAddress | null;
  billingAddress: OrderAddress | null;
  shippingMethodName: string | null;
  customerNote: string | null;
  internalNote: string | null;
  cancelReason: string | null;
  items: OrderItem[];
  timeline: TimelineEntry[];
  approvals: OrderApproval[];
  payments: OrderPayment[];
  paymentLinks: OrderPaymentLink[];
  refunds: OrderRefund[];
  shipments: { id: string; carrier: string | null; trackingNumber: string | null; shippedAt: string }[];
  reservationCount: number;
  availableTransitions: AvailableTransition[];
}

/**
 * Status colour.
 *
 * Never the only signal - the badge always carries its label too. Colour on
 * its own excludes anyone who cannot separate these hues, and an order queue
 * is exactly where that matters.
 */
export function orderStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'DELIVERED':
    case 'CONFIRMED':
      return 'success';
    case 'CANCELLED':
    case 'PAYMENT_FAILED':
    case 'RETURNED':
      return 'danger';
    case 'PENDING_PAYMENT':
    case 'PENDING_APPROVAL':
      return 'warning';
    case 'PROCESSING':
    case 'PACKED':
    case 'SHIPPED':
      return 'accent';
    default:
      return 'neutral';
  }
}

/**
 * What a transition means, in the words an administrator would use.
 *
 * The button says the action ("Mark as shipped"), not the target state
 * ("SHIPPED"), because the person clicking it is doing a thing, not setting an
 * enum.
 */
export function transitionLabel(to: string): string {
  const labels: Record<string, string> = {
    PENDING_APPROVAL: 'Send for approval',
    CONFIRMED: 'Confirm order',
    PROCESSING: 'Start processing',
    PACKED: 'Mark as packed',
    SHIPPED: 'Mark as shipped',
    DELIVERED: 'Mark as delivered',
    CANCELLED: 'Cancel order',
    RETURNED: 'Record a return',
    PAYMENT_FAILED: 'Mark payment failed',
  };

  return labels[to] ?? `Move to ${to}`;
}

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PENDING_APPROVAL',
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
  'PAYMENT_FAILED',
] as const;
