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
  'PLATFORM_FEE_RULE_INVALID',
  'PLATFORM_FEE_SELF_APPROVAL_FORBIDDEN',
  'PLATFORM_FEE_NOT_PENDING_APPROVAL',
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
/** Support ticket refusals, said in the reader's language. */
const SUPPORT_CODES = new Set([
  'SUPPORT_TICKET_CLOSED',
  'SUPPORT_TICKET_TRANSITION_NOT_ALLOWED',
  'SUPPORT_ASSIGNEE_NOT_ELIGIBLE',
  'SUPPORT_RESOLUTION_CODE_REQUIRED',
  'SUPPORT_ATTACHMENTS_UNAVAILABLE',
]);

/** Commission invoice refusals. Finance meets these mid-task, in eight languages. */
const COMMISSION_CODES = new Set([
  'COMMISSION_INVOICE_NOT_ELIGIBLE',
  'COMMISSION_INVOICE_VALIDATION_FAILED',
  'COMMISSION_INVOICE_IMMUTABLE',
  'COMMISSION_INVOICE_INVALID_TRANSITION',
  'COMMISSION_INVOICE_VOID_NOT_PERMITTED',
  'COMMISSION_INVOICE_SETTINGS_INVALID',
  'COMMISSION_INVOICE_SETTINGS_CONFLICT',
  'COMMISSION_CREDIT_INVALID',
]);

/** An individual buyer's identity check, decided on the customer page. */
const CUSTOMER_KYC_CODES = new Set([
  'CUSTOMER_KYC_NOT_EDITABLE',
  'CUSTOMER_KYC_INCOMPLETE',
  'CUSTOMER_KYC_TRANSITION_INVALID',
]);

/** Suppliers' factories and certificates, decided on the seller page (Master row 13). */
const FACTORY_CODES = new Set([
  'FACTORY_NOT_EDITABLE',
  'FACTORY_INCOMPLETE',
  'FACTORY_TRANSITION_INVALID',
  'CERTIFICATION_NOT_EDITABLE',
  'CERTIFICATION_TRANSITION_INVALID',
  'TRUST_EVIDENCE_UNUSABLE',
  'TRUST_EVIDENCE_IN_USE',
]);

/** Legal documents and the Terms they govern. Said in the reader's language. */
const LEGAL_CODES = new Set([
  'LEGAL_DOCUMENT_IMMUTABLE',
  'LEGAL_DOCUMENT_VERSION_EXISTS',
  'TERMS_ACCEPTANCE_REQUIRED',
  'TERMS_VERSION_OUTDATED',
  'TERMS_DOCUMENT_UNAVAILABLE',
]);

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

/** Country rules, rate cards and storefront content (Master rows 69, 71, 72), under `errors.market.*`. */
const MARKET_CODES = new Set([
  'MARKET_DESTINATION_RESTRICTED',
  'MARKET_RULE_INVALID',
  'CONTENT_BLOCK_INVALID',
  'LOGISTICS_LANE_INVALID',
]);

export function errorMessage(t: Translate, error: unknown, fallback?: string): string {
  if (error instanceof ApiError) {
    if (LOGISTICS_CODES.has(error.code)) return t(`errors.levels.${error.code}` as TranslationKey);
    if (MARKET_CODES.has(error.code)) {
      const reason = error.details[0]?.meta?.reason;
      return t(`errors.market.${error.code}` as TranslationKey, { reason: typeof reason === 'string' ? reason : '', detail: error.message });
    }
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
    if (COMMISSION_CODES.has(error.code)) {
      return t(`errors.commission.${error.code}` as TranslationKey);
    }
    if (CUSTOMER_KYC_CODES.has(error.code)) {
      const detail = error.details.find((item) => item.code === 'EXPIRED' || item.code === 'STALE')?.code;
      if (detail === 'EXPIRED') return t('errors.customerKyc.DOCUMENT_EXPIRED');
      if (detail === 'STALE') return t('errors.customerKyc.STALE');
      return t(`errors.customerKyc.${error.code}` as TranslationKey);
    }
    // The approval gate. The review panel lists each missing item; this is the summary.
    if (error.code === 'SELLER_APPROVAL_EVIDENCE_MISSING') {
      return t('errors.sellerApprovalEvidenceMissing', { total: String(error.details.length) });
    }
    if (LEGAL_CODES.has(error.code)) {
      return t(`errors.legal.${error.code}` as TranslationKey);
    }
    if (FACTORY_CODES.has(error.code)) {
      const detail = error.details.find((item) => item.code === 'STALE' || item.code === 'EXPIRED')?.code;
      if (detail === 'STALE') return t('errors.factory.STALE');
      if (detail === 'EXPIRED') return t('errors.factory.CERTIFICATE_EXPIRED');
      return t(`errors.factory.${error.code}` as TranslationKey);
    }
    if (SUPPORT_CODES.has(error.code)) {
      return t(`errors.support.${error.code}` as TranslationKey);
    }
    if (error.message.length > 0) return error.message;
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback ?? t('common.somethingWentWrong');
}
