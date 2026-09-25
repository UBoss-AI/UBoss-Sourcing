/**
 * The bulk preorder note and the bulk-quantity suggestion: the rules the three
 * ways into a preorder share.
 *
 * There is ONE minimum. The info button, the suggestion that appears when the
 * quantity reaches bulk, the acknowledgement and the request form all read
 * `eligibility.moq` from `GET /preorders/eligibility` - the product's or
 * variant's own terms, else the seller's default, else the deployment's
 * `PREORDER_DEFAULT_MOQ`. Nothing in this file, or in any component, holds a
 * number of its own: the "1,000" a buyer sees is always the server's.
 *
 * Whether the buyer has read the note is also the server's: `viewer.
 * preorderInfo.acknowledged`. The browser keeps two conveniences only, both in
 * session storage and both harmless to lose:
 *
 *   - that the suggestion was dismissed for this product, so it does not come
 *     back on every keystroke this session;
 *   - that a GUEST ticked the box, so it can be recorded against their account
 *     the moment they sign in. It is never proof on its own - the server
 *     refuses a request from an account with no record of its own.
 */
import { api } from './api';

/** How long the quantity has to rest at bulk before the suggestion appears. */
export const BULK_PROMPT_SETTLE_MS = 600;

/**
 * Did the quantity just reach the bulk threshold from below it?
 *
 * Only the step that crosses counts: 999 → 1,000 does, 1,000 → 1,001 does not,
 * and neither does the page opening at 1,200. Holding the + button therefore
 * crosses once, not once per step.
 */
export function crossedBulkThreshold(
  previous: number | undefined,
  next: number | undefined,
  threshold: number | null,
): boolean {
  if (threshold === null || threshold <= 0) return false;
  if (previous === undefined || next === undefined) return false;
  return previous < threshold && next >= threshold;
}

const PROMPT_PREFIX = 'uboss.preorder.bulkPrompt:';
const GUEST_ACK_KEY = 'uboss.preorder.guestAcknowledged';

/**
 * The key a dismissal is remembered under.
 *
 * The threshold and the note's version are part of it, so a seller raising the
 * minimum - or the operator changing the note - brings the suggestion back.
 */
function promptKey(
  productId: string,
  variantId: string | null,
  threshold: number,
  policyVersion: string,
): string {
  return `${PROMPT_PREFIX}${productId}:${variantId ?? '-'}:${String(threshold)}:${policyVersion}`;
}

export function isBulkPromptDismissed(
  productId: string,
  variantId: string | null,
  threshold: number,
  policyVersion: string,
): boolean {
  try {
    return (
      window.sessionStorage.getItem(promptKey(productId, variantId, threshold, policyVersion)) ===
      '1'
    );
  } catch {
    return false;
  }
}

export function rememberBulkPromptDismissed(
  productId: string,
  variantId: string | null,
  threshold: number,
  policyVersion: string,
): void {
  try {
    window.sessionStorage.setItem(promptKey(productId, variantId, threshold, policyVersion), '1');
  } catch {
    // No storage (a private window): it stays dismissed until the page reloads.
  }
}

/** A guest ticked the box at this version, before being sent to sign in. */
export function rememberGuestAcknowledgement(policyVersion: string): void {
  try {
    window.sessionStorage.setItem(GUEST_ACK_KEY, policyVersion);
  } catch {
    // Without storage the buyer is simply asked again after signing in.
  }
}

/** The version a guest acknowledged in this tab, taken off as it is read. */
export function takeGuestAcknowledgement(): string | null {
  try {
    const version = window.sessionStorage.getItem(GUEST_ACK_KEY);
    window.sessionStorage.removeItem(GUEST_ACK_KEY);
    return version;
  } catch {
    return null;
  }
}

export function hasGuestAcknowledgement(policyVersion: string): boolean {
  try {
    return window.sessionStorage.getItem(GUEST_ACK_KEY) === policyVersion;
  } catch {
    return false;
  }
}

/** Record, on the server, that the signed-in buyer read the note at this version. */
export function acknowledgePreorderInfo(policyVersion: string) {
  return api.post<{
    acknowledgement: { type: 'PREORDER_INFO'; policyVersion: string; acknowledgedAt: string };
  }>('/preorders/acknowledgement', { policyVersion });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type PreorderEventName =
  | 'preorder_info_opened'
  | 'bulk_threshold_reached'
  | 'bulk_prompt_dismissed'
  | 'bulk_prompt_start_preorder'
  | 'bulk_prompt_continue_regular'
  | 'preorder_info_acknowledged'
  | 'preorder_form_opened'
  /** The quantity settled above stock and the stock prompt was answered. */
  | 'stock_prompt_dismissed'
  | 'stock_prompt_change_quantity'
  | 'stock_prompt_start_preorder';

/** The DOM event a deployment's own analytics can listen for. */
export const PREORDER_EVENT = 'uboss:preorder';

/**
 * Announce a step of the preorder journey.
 *
 * The storefront has no analytics of its own - each operator brings their own
 * - so this is a plain `window` event (`uboss:preorder`) their tag can listen
 * for. The detail is the step and the product, and nothing about the person:
 * no user id, no email, no company. The acknowledgement itself is also written
 * to the server's audit log, which is the record that matters.
 */
export function emitPreorderEvent(
  name: PreorderEventName,
  detail: { productId: string; variantId: string | null },
): void {
  try {
    window.dispatchEvent(new CustomEvent(PREORDER_EVENT, { detail: { name, ...detail } }));
  } catch {
    // An environment without CustomEvent has nobody listening either.
  }
}
