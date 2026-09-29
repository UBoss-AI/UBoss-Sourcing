/**
 * One place that turns a thrown thing into a sentence for a customer.
 *
 * The server's own `message` is already written for the person reading it, and
 * it is the one sentence that knows *why* a request was refused - so it is
 * used unchanged wherever there is one. What this adds is the handful of
 * failures the browser diagnoses on its own: no connection, no response, a
 * 503. `api.ts` words those in English because it has no `t` to call, and an
 * English sentence in the middle of a German page is exactly what this
 * function exists to prevent - the code on the error, not its text, is what is
 * matched on.
 *
 * `fallback` is what to say when the thing thrown is not an error at all, or
 * carries no message: usually the calling screen's own "that did not save"
 * line, which is more useful than a generic one.
 */
import { ApiError, NetworkError } from './api';
import { formatIsoDate } from './calendar-date';
import { formatNumber } from './format';
import type { Translate, TranslationKey } from '@/i18n/i18n-context';

/** Logistics refusals with a sentence of their own under `errors.logistics.*`. */
const LOGISTICS_CODES = new Set([
  'LOGISTICS_L1_OWNER_FIXED',
  'LOGISTICS_HYBRID_ALL_SELLER',
  'LOGISTICS_MODE_OWNERS_MISMATCH',
  'LOGISTICS_CHANGE_NOT_CONFIRMED',
  'LOGISTICS_POLICY_VERSION_CONFLICT',
  'LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED',
  'LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED',
  'LOGISTICS_PRICE_INVALID',
  'LOGISTICS_FREE_NOT_CONFIRMED',
  'LOGISTICS_PROVIDER_NOT_ENABLED',
  'LOGISTICS_CARRIER_UNSUITABLE',
  'LOGISTICS_RATE_INCOMPLETE',
  'LOGISTICS_RATE_NOT_EDITABLE',
  'LOGISTICS_QUOTE_REQUIRED',
  'LOGISTICS_PRICE_CHANGED',
  'LOGISTICS_LEG_NOT_ASSIGNABLE',
  'LOGISTICS_LEG_TRANSITION_INVALID',
  'LOGISTICS_LEG_TRACKING_REQUIRED',
  'LOGISTICS_PARTNER_NOT_ELIGIBLE',
]);

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

/** A seller's factories and certificates, and their verification (Master row 13). */
const FACTORY_CODES = new Set([
  'FACTORY_NOT_EDITABLE',
  'FACTORY_INCOMPLETE',
  'FACTORY_TRANSITION_INVALID',
  'CERTIFICATION_NOT_EDITABLE',
  'CERTIFICATION_TRANSITION_INVALID',
  'TRUST_EVIDENCE_UNUSABLE',
  'TRUST_EVIDENCE_IN_USE',
]);

/** Seller invoices and packing lists. */
const SELLER_DOCUMENT_CODES = new Set([
  'SELLER_DOCUMENT_NOT_ELIGIBLE',
  'SELLER_DOCUMENT_VALIDATION_FAILED',
  'SELLER_DOCUMENT_IMMUTABLE',
  'SHIPMENT_PACKAGES_LOCKED',
  'SHIPMENT_CONTENTS_MISMATCH',
  'SHIPMENT_SPLIT_INVALID',
  'DOCUMENT_RENDER_FAILED',
]);

/** Preorder chat refusals. Each says what to do next, in the reader's language. */
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

/** Support request refusals. Each says what to do instead, in the reader's language. */
const SUPPORT_CODES = new Set([
  'SUPPORT_TICKET_LIMIT_REACHED',
  'SUPPORT_ORDER_NOT_FOUND',
  'SUPPORT_TICKET_CLOSED',
  'SUPPORT_TICKET_TRANSITION_NOT_ALLOWED',
  'SUPPORT_ASSIGNEE_NOT_ELIGIBLE',
  'SUPPORT_ATTACHMENTS_UNAVAILABLE',
  'SUPPORT_ATTACHMENT_LIMIT_REACHED',
]);

/**
 * Buyer-company refusals. Each is reached mid-task - pressing Check out while
 * buying for a company that is still being verified, sending an application
 * that is missing something - so each is said in the reader's language.
 */
const BUYER_COMPANY_CODES = new Set([
  'BUYER_COMPANIES_DISABLED',
  'BUYER_CONTEXT_INVALID',
  'BUYER_CONTEXT_UNSUPPORTED',
  'BUYER_COMPANY_NOT_APPROVED',
  'BUYER_COMPANY_ROLE_FORBIDDEN',
  'BUYER_COMPANY_TRANSITION_NOT_ALLOWED',
  'BUYER_COMPANY_NOT_EDITABLE',
  'BUYER_COMPANY_INCOMPLETE',
  'BUYER_COMPANY_VERSION_CONFLICT',
  'BUYER_COMPANY_EMAIL_CODE_INVALID',
  'BUYER_COMPANY_DOCUMENT_REJECTED',
  'BUYER_COMPANY_LIMIT_REACHED',
  'BUYER_COMPANY_INVITATION_EXISTS',
  'BUYER_COMPANY_INVITATION_INVALID',
  'BUYER_COMPANY_ALREADY_MEMBER',
  'BUYER_COMPANY_MEMBER_PROTECTED',
]);

/**
 * A seller's team (Master row 14): inviting, accepting, changing a role. Each
 * is met mid-task on the Team page or the join page, so each is said in the
 * reader's language.
 */
const SELLER_TEAM_CODES = new Set([
  'SELLER_INVITATION_EXISTS',
  'SELLER_INVITATION_INVALID',
  'SELLER_INVITATION_SEND_LIMIT',
  'SELLER_ALREADY_MEMBER',
  'SELLER_MEMBERSHIP_EXISTS',
  'SELLER_MEMBER_PROTECTED',
  'SELLER_LAST_OWNER',
]);

/** An individual's identity check, on Identity and import. */
const CUSTOMER_KYC_CODES = new Set([
  'CUSTOMER_KYC_NOT_EDITABLE',
  'CUSTOMER_KYC_INCOMPLETE',
  'CUSTOMER_KYC_TRANSITION_INVALID',
]);

/**
 * Terms and Conditions refusals, met on the sign-up and activation forms.
 * Each tells the reader what to do next: agree, agree again to the new
 * version, or come back when the Terms are published.
 */
const TERMS_CODES = new Set([
  'TERMS_ACCEPTANCE_REQUIRED',
  'TERMS_VERSION_OUTDATED',
  'TERMS_DOCUMENT_UNAVAILABLE',
]);

export function isTermsError(code: string): boolean {
  return TERMS_CODES.has(code);
}

/** The reader's locale for a date inside an error sentence. */
function navigatorLocale(): string {
  return typeof document !== 'undefined' && document.documentElement.lang !== ''
    ? document.documentElement.lang
    : 'en';
}

export function errorMessage(t: Translate, error: unknown, fallback?: string): string {
  if (error instanceof NetworkError) {
    return error.isOffline ? t('common.youAppearOffline') : t('common.couldNotReachStore');
  }

  if (error instanceof ApiError) {
    // The two codes the client mints itself, rather than reads off an error
    // envelope. Everything else came from the backend with a message.
    if (error.code === 'SERVICE_UNAVAILABLE') return t('common.storeTemporarilyUnavailable');
    if (error.code === 'UNEXPECTED_RESPONSE') {
      return t('common.unexpectedResponse', { status: String(error.status) });
    }

    /*
     * Two refusals a customer meets while choosing how to pay, translated
     * here rather than passed through in the server's English.
     *
     * The rule above - use the backend's sentence, it knows why - is the right
     * default and stays the default. It is wrong for exactly these two: they
     * are reached by pressing a button on a checkout page, in the middle of a
     * flow the customer is already partway through, and a sentence in the
     * wrong language at that moment reads as the site breaking rather than as
     * an answer. Every other code still falls through below.
     */
    if (error.code === 'PAYMENT_INSTRUMENT_UNAVAILABLE') {
      return t('payment.thatWayOfPayingIsUnavailable');
    }
    // Stripe Checkout's refusals. Each says what the customer can do next.
    if (error.code === 'PAYMENT_ATTEMPT_IN_PROGRESS') return t('payment.attemptInProgress');
    if (error.code === 'PAYMENT_AMOUNT_NOT_SUPPORTED') return t('payment.amountNotSupported');
    if (error.code === 'PAYMENT_PROVIDER_NOT_CONFIGURED') return t('payment.notConfigured');
    if (error.code === 'PAYMENT_METHOD_NOT_CHARGEABLE') {
      return t('payment.thatCardCannotBeUsed');
    }

    /*
     * Three refusals a customer meets while pressing Add to basket, for the
     * same reason as the two above: they arrive mid-task, on a page the
     * customer is already partway through, and an English sentence at that
     * moment reads as the site breaking rather than as an answer.
     *
     * They are three codes and not one because the customer has three
     * different things to do about them - ask for a quote, come back later, or
     * order by the piece instead.
     */
    if (error.code === 'SELLER_SESSION_EXPIRED') return t('sellerSession.expired');
    // Only staff approve sellers, so a seller meets this only if a screen
    // they share with staff ever relays it. Worded all the same.
    if (error.code === 'SELLER_APPROVAL_EVIDENCE_MISSING') return t('errors.sellerApprovalEvidenceMissing');
    if (error.code === 'LISTING_BLOCKED') return t('errors.listingBlocked');
    if (error.code === 'PRODUCT_PRICE_ON_REQUEST') return t('errors.pricedOnRequest');
    if (error.code === 'PRODUCT_NOT_ORDERABLE') return t('errors.notOrderable');
    if (error.code === 'PACK_SIZE_UNKNOWN') return t('errors.packSizeUnknown');
    if (error.code === 'RECEIPT_NOT_AVAILABLE') return t('errors.receiptNotAvailable');

    /*
     * The B2C maximum order quantity. Reached from Add to basket, a reorder,
     * the assistant's cards, the preorder form and the basket itself - every
     * one mid-task - so it is worded here, with the limit from the error's
     * own figures. The pages that can offer a way out (switch to a company,
     * reduce) open a dialog instead; this is the sentence for the rest.
     */
    if (error.code === 'B2C_MAX_ORDER_QUANTITY_EXCEEDED') {
      const allowed = error.details[0]?.meta?.['allowedQuantity'];
      if (typeof allowed === 'number') {
        return t('b2cLimit.individualMessage', { limit: formatNumber(allowed) });
      }
    }

    /*
     * The four delivery levels. Reached from Seller Hub -> Logistics and from
     * the checkout, mid-task, so the answer is given in the reader's language.
     * Each code has its own sentence because each sends the reader somewhere
     * different - the Self tab, the carriers list, the confirmation box.
     */
    if (TERMS_CODES.has(error.code)) return t(`errors.terms.${error.code}` as TranslationKey);
    if (LOGISTICS_CODES.has(error.code)) return t(`errors.logistics.${error.code}` as TranslationKey);

    /*
     * Bulk preorders. Each refusal names its figure - the minimum, the step,
     * the earliest date - because "Minimum preorder quantity is 1,000
     * pieces" is something a buyer can act on and "the request failed" is
     * not. The figures come from the error's own details, never from the
     * page, so the sentence cannot disagree with the rule that refused it.
     */
    if (PREORDER_CODES.has(error.code)) {
      const meta = error.details[0]?.meta ?? {};
      const count = (key: string): string =>
        typeof meta[key] === 'number' ? formatNumber(meta[key]) : '';
      const day = (key: string): string =>
        typeof meta[key] === 'string' ? formatIsoDate(meta[key], navigatorLocale(), { dateStyle: 'long' }) : '';

      return t(`errors.preorder.${error.code}` as TranslationKey, {
        minimum: count('minimumBaseUnits'),
        increment: count('incrementBaseUnits'),
        maximum: count('maximumBaseUnits'),
        available: count('availableBaseUnits'),
        earliest: day('earliest'),
        latest: day('latest'),
      });
    }

    /*
     * Seller invoices and packing lists. A seller meets these pressing Issue
     * or Mark packed; the checklist on the page names each field, and this is
     * the one-line summary above it.
     */
    // Quantity price bands: the panel marks each band; this is the summary.
    if (error.code === 'QUANTITY_TIERS_INVALID') return t('errors.quantityTiersInvalid');
    // Container loading: the panel marks each figure; this is the summary.
    if (error.code === 'CONTAINER_LOADING_INVALID') return t('errors.containerLoadingInvalid');

    // Pressed Save on a review form for a product not yet delivered to them -
    // a page left open, or an order that was cancelled in the meantime.
    if (error.code === 'REVIEW_NOT_ELIGIBLE') return t('reviews.error.notEligible');

    if (PREORDER_CHAT_CODES.has(error.code)) {
      return t(`errors.preorderChat.${error.code}` as TranslationKey);
    }

    if (SUPPORT_CODES.has(error.code)) {
      return t(`errors.support.${error.code}` as TranslationKey);
    }

    if (SELLER_DOCUMENT_CODES.has(error.code)) {
      return t(`errors.sellerDocument.${error.code}` as TranslationKey);
    }

    if (SELLER_TEAM_CODES.has(error.code)) {
      // Which rule protects a member: themselves, or somebody holding more.
      const detail = error.details[0]?.code;
      if (error.code === 'SELLER_MEMBER_PROTECTED' && detail !== undefined) {
        return t(`errors.sellerTeam.protected.${detail}` as TranslationKey, {
          defaultValue: t('errors.sellerTeam.SELLER_MEMBER_PROTECTED'),
        });
      }
      return t(`errors.sellerTeam.${error.code}` as TranslationKey);
    }

    if (FACTORY_CODES.has(error.code)) {
      // A page left open while a reviewer decided, or the check lapsed.
      if (error.details.some((detail) => detail.code === 'STALE')) return t('errors.factory.STALE');
      return t(`errors.factory.${error.code}` as TranslationKey);
    }

    if (CUSTOMER_KYC_CODES.has(error.code)) {
      // "Fill in every detail" would send a buyer whose passport lapsed looking for a blank field.
      if (error.details.some((detail) => detail.code === 'EXPIRED')) return t('errors.customerKyc.DOCUMENT_EXPIRED');
      return t(`errors.customerKyc.${error.code}` as TranslationKey);
    }

    if (BUYER_COMPANY_CODES.has(error.code)) {
      // A refused upload says which rule it broke - type, size, pages,
      // scripts - because "that file was refused" leaves nothing to fix.
      const detail = error.details[0]?.code;
      if (error.code === 'BUYER_COMPANY_DOCUMENT_REJECTED' && detail !== undefined) {
        return t(`errors.buyerCompany.document.${detail}` as TranslationKey, {
          defaultValue: t('errors.buyerCompany.BUYER_COMPANY_DOCUMENT_REJECTED'),
        });
      }
      // The team says which rule protects a member, and a resend cap is not an application limit.
      if (
        detail !== undefined &&
        (error.code === 'BUYER_COMPANY_MEMBER_PROTECTED' || (error.code === 'BUYER_COMPANY_LIMIT_REACHED' && detail === 'MAX_SENDS'))
      ) {
        return t(`errors.buyerCompany.team.${detail}` as TranslationKey, {
          defaultValue: t(`errors.buyerCompany.${error.code}` as TranslationKey),
        });
      }
      return t(`errors.buyerCompany.${error.code}` as TranslationKey);
    }

    if (error.message.length > 0) return error.message;
  }

  if (error instanceof Error && error.message.length > 0) return error.message;

  return fallback ?? t('common.theRequestFailed');
}
