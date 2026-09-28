/** What the commission invoice screens share: status colours and the blocker wording. */
import type { BadgeTone } from '@/components/ui';
import type { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';

export const STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  ISSUED: 'success',
  PARTIALLY_CREDITED: 'warning',
  FULLY_CREDITED: 'accent',
  VOID: 'danger',
};

export const COLLECTION_TONE: Record<string, BadgeTone> = {
  OUTSTANDING: 'warning',
  PAID: 'success',
  ADJUSTED_AGAINST_SETTLEMENT: 'accent',
};

type Translate = ReturnType<typeof useI18n>['t'];

const BLOCKER_KEYS = new Set([
  'PAYMENT_NOT_CAPTURED',
  'ORDER_CANCELLED',
  'SELLER_ORDER_CANCELLED',
  'DISPUTE_OPEN',
  'COMMISSION_NOT_CALCULATED',
  'NO_COMMISSION',
  'STAGE_NOT_REACHED_CONFIRMED',
  'STAGE_NOT_REACHED_SHIPPED',
  'STAGE_NOT_REACHED_DELIVERED',
]);

/** Why a seller order cannot be invoiced yet, in the reader's language. */
export function blockerText(t: Translate, blocker: { code: string; message: string }): string {
  return BLOCKER_KEYS.has(blocker.code) ? t(`commission.blocker.${blocker.code}` as TranslationKey) : blocker.message;
}
