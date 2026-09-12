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
import type { Translate } from '@/i18n/i18n-context';

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
    if (error.code === 'PRODUCT_PRICE_ON_REQUEST') return t('errors.pricedOnRequest');
    if (error.code === 'PRODUCT_NOT_ORDERABLE') return t('errors.notOrderable');
    if (error.code === 'PACK_SIZE_UNKNOWN') return t('errors.packSizeUnknown');

    if (error.message.length > 0) return error.message;
  }

  if (error instanceof Error && error.message.length > 0) return error.message;

  return fallback ?? t('common.theRequestFailed');
}
