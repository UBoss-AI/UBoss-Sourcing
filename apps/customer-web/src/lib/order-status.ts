/**
 * Order status presentation, shared by the list and detail pages.
 *
 * The vocabulary is the backend's. Nothing here decides what an order *is* —
 * only how it reads to the person who placed it. A customer does not think in
 * terms of `PENDING_PAYMENT`; they think "you are waiting for my money".
 */
import type { BadgeTone } from '@/components/ui';

/** Colour is a second signal only; every badge carries its own words. */
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
      return 'brand';
    default:
      return 'neutral';
  }
}

/** The status in the customer's terms rather than the database's. */
export function orderStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    PENDING_PAYMENT: 'Awaiting payment',
    PENDING_APPROVAL: 'Awaiting approval',
    CONFIRMED: 'Confirmed',
    PROCESSING: 'Being prepared',
    PACKED: 'Packed',
    SHIPPED: 'On its way',
    DELIVERED: 'Delivered',
    CANCELLED: 'Cancelled',
    RETURNED: 'Returned',
    PAYMENT_FAILED: 'Payment failed',
  };

  return (
    labels[status] ??
    status
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  );
}

/**
 * What is happening now, and what the customer can do about it.
 *
 * Returned as a sentence rather than a status word, because "Awaiting payment"
 * on its own does not tell someone whether they need to act.
 */
export function orderStatusExplanation(status: string, paymentMode: string | null): string | null {
  switch (status) {
    case 'PENDING_PAYMENT':
      return paymentMode === 'PAYMENT_LINK'
        ? 'A payment link has been emailed. The order is confirmed once it is paid.'
        : 'This order is waiting for payment. You can pay from this page.';
    case 'PENDING_APPROVAL':
      return 'Your approver has been notified. We will confirm the order once they approve it.';
    case 'CONFIRMED':
      return 'Payment received. We are getting your order ready.';
    case 'PROCESSING':
      return 'Your order is being picked and packed.';
    case 'PACKED':
      return 'Packed and waiting for collection by the courier.';
    case 'SHIPPED':
      return 'On its way to you.';
    case 'PAYMENT_FAILED':
      return 'The payment did not go through. Nothing has been charged — you can try again.';
    case 'CANCELLED':
      return 'This order was cancelled. Any payment taken has been refunded.';
    default:
      return null;
  }
}

/**
 * Schedule status presentation.
 *
 * An active schedule is `operational`, not `success`: it is not reporting that
 * something went well, it is reporting that a standing arrangement is in
 * force. Teal is the app's colour for that, and it keeps green meaning
 * "finished, and it worked".
 */
export function scheduleStatusTone(status: string): BadgeTone {
  if (status === 'ACTIVE') return 'operational';
  if (status === 'PAUSED') return 'warning';
  if (status === 'CANCELLED' || status === 'FAILED') return 'danger';
  return 'neutral';
}

export function scheduleStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    ACTIVE: 'Active',
    PAUSED: 'Paused',
    COMPLETED: 'Finished',
    CANCELLED: 'Cancelled',
    FAILED: 'Stopped after repeated failures',
  };

  return labels[status] ?? status;
}
