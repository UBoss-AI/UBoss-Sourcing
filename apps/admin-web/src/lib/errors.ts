/**
 * A thrown thing, as one sentence for a member of staff.
 *
 * The server's own message is used where there is one - it knows why a
 * request was refused. The logistics-level refusals are translated here
 * instead, because they arrive mid-task on screens used in eight languages.
 */
import { ApiError } from './api';
import type { TranslationKey } from '@/i18n/i18n-context';

type Translate = (key: TranslationKey, options?: Record<string, unknown>) => string;

const LOGISTICS_CODES = new Set([
  'LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED',
  'LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED',
  'LOGISTICS_PRICE_INVALID',
  'LOGISTICS_FREE_NOT_CONFIRMED',
  'LOGISTICS_CARRIER_UNSUITABLE',
  'LOGISTICS_RATE_INCOMPLETE',
  'LOGISTICS_RATE_NOT_EDITABLE',
  'LOGISTICS_LEG_NOT_ASSIGNABLE',
  'LOGISTICS_LEG_TRANSITION_INVALID',
  'LOGISTICS_LEG_TRACKING_REQUIRED',
  'LOGISTICS_PARTNER_NOT_ELIGIBLE',
  'LOGISTICS_POLICY_VERSION_CONFLICT',
  'PLATFORM_FEE_POLICY_INVALID',
  'PLATFORM_FEE_POLICY_NOT_EDITABLE',
]);

/**
 * Preorder refusals. Staff meet these answering a preorder on the store's own
 * product, and each names its figure - the earliest date, the minimum - from
 * the error's own details, in the same sentences the storefront uses.
 */
const PREORDER_CODES = new Set([
  'PREORDER_NOT_AVAILABLE',
  'PREORDER_BUYER_NOT_ELIGIBLE',
  'PREORDER_BELOW_MINIMUM',
  'PREORDER_INCREMENT_MISMATCH',
  'PREORDER_ABOVE_MAXIMUM',
  'PREORDER_UNIT_NOT_AVAILABLE',
  'PREORDER_DATE_TOO_EARLY',
  'PREORDER_DATE_TOO_FAR',
  'PREORDER_DESTINATION_NOT_SERVED',
  'PREORDER_TRANSITION_NOT_ALLOWED',
  'PREORDER_TERMS_CHANGED',
  'PREORDER_CAPACITY_EXCEEDED',
  'PREORDER_EXPIRED',
  'PREORDER_POLICY_INVALID',
  'PREORDER_ACKNOWLEDGEMENT_REQUIRED',
  'PREORDER_INFO_OUTDATED',
  'PREORDER_CONTAINER_NOT_CONFIGURED',
  'PREORDER_PROPOSAL_INVALID',
  'PREORDER_STOCK_CHANGED',
]);

/** Preorder chat refusals, worded in the reader's language. */
const PREORDER_CHAT_CODES = new Set([
  'PREORDER_CHAT_CLOSED',
  'PREORDER_CHAT_BLOCKED',
  'PREORDER_CHAT_MESSAGE_TOO_LONG',
  'PREORDER_CHAT_MESSAGE_ID_REUSED',
  'PREORDER_CHAT_TRANSITION_NOT_ALLOWED',
  'PREORDER_CHAT_DUPLICATE_CONVERSATION',
  'PREORDER_CHAT_ASSIGNEE_NOT_ELIGIBLE',
  'PREORDER_CHAT_PREORDER_MISMATCH',
  'PREORDER_CHAT_PROPOSAL_NOT_OPEN',
  'PREORDER_CHAT_ATTACHMENTS_UNAVAILABLE',
]);

export function errorMessage(t: Translate, error: unknown, fallback?: string): string {
  if (error instanceof ApiError) {
    if (LOGISTICS_CODES.has(error.code)) return t(`errors.levels.${error.code}` as TranslationKey);
    if (PREORDER_CODES.has(error.code)) {
      const meta = error.details[0]?.meta ?? {};
      const count = (key: string): string =>
        typeof meta[key] === 'number' ? new Intl.NumberFormat().format(meta[key]) : '';
      const day = (key: string): string =>
        typeof meta[key] === 'string'
          ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(
              new Date(`${meta[key]}T00:00:00Z`),
            )
          : '';
      return t(`errors.preorder.${error.code}` as TranslationKey, {
        minimum: count('minimumBaseUnits'),
        increment: count('incrementBaseUnits'),
        maximum: count('maximumBaseUnits'),
        available: count('availableBaseUnits'),
        earliest: day('earliest'),
        latest: day('latest'),
      });
    }
    if (PREORDER_CHAT_CODES.has(error.code)) {
      return t(`errors.preorderChat.${error.code}` as TranslationKey);
    }
    if (error.message.length > 0) return error.message;
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback ?? t('common.somethingWentWrong');
}
