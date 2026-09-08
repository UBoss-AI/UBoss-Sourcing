/**
 * Order status presentation, shared by the list and detail pages.
 *
 * The vocabulary is the backend's. Nothing here decides what an order *is* —
 * only how it reads to the person who placed it. A customer does not think in
 * terms of `PENDING_PAYMENT`; they think "you are waiting for my money".
 */
import type { BadgeTone } from '@/components/ui';
import type { Translate, TranslationKey } from '@/i18n/i18n-context';

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
export function orderStatusLabel(t: Translate, status: string): string {
  const labels: Record<string, TranslationKey> = {
    PENDING_PAYMENT: 'orderStatus.pendingPayment',
    PENDING_APPROVAL: 'orderStatus.pendingApproval',
    CONFIRMED: 'orderStatus.confirmed',
    PROCESSING: 'orderStatus.processing',
    PACKED: 'orderStatus.packed',
    SHIPPED: 'orderStatus.shipped',
    DELIVERED: 'orderStatus.delivered',
    CANCELLED: 'orderStatus.cancelled',
    RETURNED: 'orderStatus.returned',
    PAYMENT_FAILED: 'orderStatus.paymentFailed',
  };

  const key = labels[status];
  if (key !== undefined) return t(key);

  return (
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
export function orderStatusExplanation(
  t: Translate,
  status: string,
  paymentMode: string | null,
): string | null {
  switch (status) {
    case 'PENDING_PAYMENT':
      return paymentMode === 'PAYMENT_LINK'
        ? t('orderStatus.explainPaymentLinkSent')
        : t('orderStatus.explainAwaitingPayment');
    case 'PENDING_APPROVAL':
      return t('orderStatus.explainAwaitingApproval');
    case 'CONFIRMED':
      return t('orderStatus.explainConfirmed');
    case 'PROCESSING':
      return t('orderStatus.explainProcessing');
    case 'PACKED':
      return t('orderStatus.explainPacked');
    case 'SHIPPED':
      return t('orderStatus.explainShipped');
    case 'PAYMENT_FAILED':
      return t('orderStatus.explainPaymentFailed');
    case 'CANCELLED':
      return t('orderStatus.explainCancelled');
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

export function scheduleStatusLabel(t: Translate, status: string): string {
  const labels: Record<string, TranslationKey> = {
    ACTIVE: 'orderStatus.scheduleActive',
    PAUSED: 'orderStatus.schedulePaused',
    COMPLETED: 'orderStatus.scheduleFinished',
    CANCELLED: 'orderStatus.scheduleCancelled',
    FAILED: 'orderStatus.scheduleFailed',
  };

  const key = labels[status];
  return key === undefined ? status : t(key);
}
