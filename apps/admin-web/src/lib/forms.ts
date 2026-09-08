/**
 * Form helpers shared by every editor in the panel.
 *
 * The important one is `applyApiErrors`. The backend returns
 * `details: [{ field, code, message }]` on a validation failure, and a form
 * that ignores it shows one banner at the top while the offending input sits
 * there looking fine. Mapping the details back onto the fields is what turns a
 * rejection into something a person can fix.
 */
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError, NetworkError } from './api';

/**
 * Push an API error onto a react-hook-form.
 *
 * Returns the message that belongs in the form-level banner - either the
 * server's message when nothing mapped onto a field, or null when every detail
 * found a home and the fields say it all.
 */
export function applyApiErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  knownFields: readonly Path<T>[],
  /**
   * What to say when the failure carries no message of its own.
   *
   * Passed in rather than written here: this module has no `t`, and the string
   * it returns is rendered above a form for a person to read. Callers hand it
   * `t('common.theRequestFailed')`; the English default is what a caller that
   * has not been updated still shows.
   */
  fallbackMessage = 'The request failed.',
): string | null {
  if (error instanceof NetworkError) return error.message;

  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : fallbackMessage;
  }

  const fieldErrors = error.fieldErrors();
  let matched = 0;

  for (const [field, message] of Object.entries(fieldErrors)) {
    // Only set errors for fields this form actually has. A detail naming a
    // field that is not on screen would otherwise block submission forever
    // with nothing visible to correct.
    if (!knownFields.includes(field as Path<T>)) continue;
    setError(field as Path<T>, { type: 'server', message });
    matched += 1;
  }

  return matched > 0 && matched === Object.keys(fieldErrors).length ? null : error.message;
}

/**
 * An idempotency key for a mutation that must not be applied twice.
 *
 * Generated once per attempt and reused across retries of that same attempt -
 * a new key per retry defeats the point.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Trim and collapse to null, for optional text fields. */
export function nullIfBlank(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text.length === 0 ? null : text;
}
