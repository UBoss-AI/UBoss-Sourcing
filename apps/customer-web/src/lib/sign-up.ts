/**
 * The "check your email" page that follows a sign-up.
 *
 * It is a route of its own rather than a state of the form, so that the page
 * after "Create account" is a new page in every sense a browser has: it
 * starts at its own top, its heading takes focus, Back returns to a clean
 * form, and refreshing it shows it again rather than an empty form.
 *
 * The address travels in the history entry's state, never in the URL. A URL
 * is copied into logs, referrers and screenshots; history state stays in this
 * tab (and survives a refresh of it). Opened with no state - typed in, or
 * shared - the page still renders, and asks for the address before resending.
 */

export const CHECK_EMAIL_PATH = '/register/check-email';

export type SignUpVariant = 'individual' | 'company';

export interface CheckEmailState {
  email: string;
  requiresApproval: boolean;
  variant: SignUpVariant;
}

/** The state a sign-up left, or null when the page was opened some other way. */
export function readCheckEmailState(state: unknown): CheckEmailState | null {
  if (typeof state !== 'object' || state === null) return null;
  const candidate = state as Record<string, unknown>;
  if (typeof candidate['email'] !== 'string' || candidate['email'].length === 0) return null;
  return {
    email: candidate['email'],
    requiresApproval: candidate['requiresApproval'] === true,
    variant: candidate['variant'] === 'company' ? 'company' : 'individual',
  };
}
