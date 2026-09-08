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

    if (error.message.length > 0) return error.message;
  }

  if (error instanceof Error && error.message.length > 0) return error.message;

  return fallback ?? t('common.theRequestFailed');
}
