/** Bulk preorder statuses and their badge tones, shared by the two read-only preorder pages. */
import type { BadgeTone } from '@/components/ui';

export const PREORDER_STATUSES = [
  'SUBMITTED',
  'SELLER_REVIEW_REQUIRED',
  'SELLER_ACCEPTED',
  'SELLER_COUNTERED',
  'PAYMENT_REQUIRED',
  'CONFIRMED',
  'IN_PRODUCTION',
  'READY_FOR_FULFILLMENT',
  'CONVERTED_TO_ORDER',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;

export function preorderTone(status: string): BadgeTone {
  if (status === 'SUBMITTED' || status === 'SELLER_REVIEW_REQUIRED') return 'warning';
  if (status === 'CONVERTED_TO_ORDER' || status === 'CONFIRMED') return 'success';
  if (status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED') return 'neutral';
  return 'operational';
}
