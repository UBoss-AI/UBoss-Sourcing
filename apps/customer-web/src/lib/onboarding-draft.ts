/**
 * What a seller has typed into their application, kept on their own device.
 *
 * ## Why this file exists
 *
 * A seller application is not filled in at one sitting. It is filled in out of
 * a folder: a registration certificate is in a drawer, a director has to be
 * asked for their passport number, a VAT number is on an invoice somebody has
 * to find. The steps have always saved on their own — but only when the seller
 * pressed **Save**, and the gap between typing something and pressing that
 * button is exactly where the work was being lost.
 *
 * Three ways it was lost, and this file answers all three:
 *
 *   - **The session ended.** An access cookie expires, the refresh behind it
 *     fails, and the next thing the page does is announce that the session is
 *     over. Everything in React state at that moment is in memory only, and a
 *     sign-in is a page load.
 *   - **The tab was closed**, or the browser was, or the machine was. A form
 *     that has never been sent anywhere exists nowhere.
 *   - **The save was refused.** A half-typed website address is not a URL and
 *     the API says so; the screen said "those details could not be saved" and
 *     the seller was left holding a form nobody had kept.
 *
 * So: every keystroke is written here, to `localStorage`, immediately. It costs
 * a fraction of a millisecond and it is the only copy that survives a session
 * ending, because writing to the server is precisely the thing an ended session
 * cannot do.
 *
 * ## What this is NOT
 *
 * It is not the save. The server is still the only place an application really
 * lives, and the debounced auto-save in the onboarding screen still sends
 * everything up as soon as it is send-able. This is the safety net underneath
 * that: what is on this device, for this seller, until the server has it.
 *
 * Which is also why it is keyed by seller account. Two people who share a
 * machine, or one person who left a company and joined another, must never be
 * shown each other's half-finished paperwork.
 *
 * ## Why it may fail, and why nothing here throws
 *
 * `localStorage` is not always there. Safari in private browsing used to throw
 * on every write; a browser with site data blocked throws on read; a full quota
 * throws on write. None of those are worth taking a seller's application screen
 * down for, so every entry point here catches and the caller gets `null` or a
 * `false`. A draft that could not be kept is a smaller problem than a blank
 * error page, and the screen says which of the two happened.
 */

/**
 * Bumped when the stored shape changes.
 *
 * A draft written by an older build is ignored rather than migrated. There is
 * no history worth keeping here — the worst case is that somebody retypes one
 * step — and a migration path for a throwaway cache is code that is never
 * exercised until the day it is wrong.
 */
const DRAFT_VERSION = 1;

const KEY_PREFIX = 'uboss.seller.onboarding';

/**
 * How long an untouched draft is worth restoring.
 *
 * Fourteen days is about the length of a slow application — long enough that
 * somebody who went away to get a notarised document still finds their work,
 * short enough that a form restored from a draft is never restored from a
 * version of the business that has since changed its address. Anything older
 * is dropped on read and the stored profile is shown instead.
 */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** One step's worth of unsent answers, with when they were last touched. */
export interface OnboardingDraft<T> {
  /** `Date.now()` at the last keystroke. */
  savedAt: number;
  values: T;
}

function storageKey(sellerAccountId: string, section: string): string {
  return `${KEY_PREFIX}.v${String(DRAFT_VERSION)}.${sellerAccountId}.${section}`;
}

/**
 * `localStorage`, or null where there is none.
 *
 * Reading the property itself can throw — that is not a hypothetical, it is
 * what a browser with site data blocked does — so even getting hold of it is
 * inside the guard.
 */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * What this seller had typed at this step, or null.
 *
 * Null covers every failure equally: no storage, nothing stored, stored by an
 * older build, stored too long ago, or stored as something that is no longer
 * JSON. The caller has one branch, which is the point.
 */
export function readDraft<T>(sellerAccountId: string, section: string): OnboardingDraft<T> | null {
  const store = storage();
  if (store === null) return null;

  try {
    const raw = store.getItem(storageKey(sellerAccountId, section));
    if (raw === null) return null;

    const parsed = JSON.parse(raw) as unknown;

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as OnboardingDraft<T>).savedAt !== 'number'
    ) {
      return null;
    }

    const draft = parsed as OnboardingDraft<T>;

    // Stale. Cleared on the way past rather than left to sit: a draft nobody
    // will ever be offered is just somebody's business details on a device.
    if (Date.now() - draft.savedAt > MAX_AGE_MS) {
      clearDraft(sellerAccountId, section);
      return null;
    }

    return draft;
  } catch {
    return null;
  }
}

/**
 * Keep what has been typed. Returns whether it could be kept.
 *
 * The return value is not decoration. The screen tells the seller either "kept
 * on this device" or "this browser is not keeping a copy — press Save", and
 * those are different promises. Saying the first when the write threw would be
 * the worst outcome this file could produce.
 */
export function writeDraft(sellerAccountId: string, section: string, values: unknown): boolean {
  const store = storage();
  if (store === null) return false;

  try {
    const draft: OnboardingDraft<unknown> = { savedAt: Date.now(), values };
    store.setItem(storageKey(sellerAccountId, section), JSON.stringify(draft));
    return true;
  } catch {
    // Almost always the quota. Nothing is retried and nothing is evicted: the
    // caller is about to say so on screen, and a cache that starts deleting
    // other people's data to make room for itself is a worse citizen than one
    // that admits it is full.
    return false;
  }
}

/** Forget this step's draft. Called once the server has the answers. */
export function clearDraft(sellerAccountId: string, section: string): void {
  const store = storage();
  if (store === null) return;

  try {
    store.removeItem(storageKey(sellerAccountId, section));
  } catch {
    // Nothing to do and nothing worth reporting: a draft that could not be
    // removed is stale data that will age out on its own.
  }
}

/**
 * Forget every draft this seller has on this device.
 *
 * Used when an application is sent for review — at that point the server holds
 * all of it, the form goes read-only, and a restored draft would only offer to
 * put back answers that can no longer be changed.
 *
 * It walks the keys rather than being told which sections exist, because the
 * steps come from the server and this file must not hold a second list of them
 * that can disagree.
 */
export function clearAllDrafts(sellerAccountId: string): void {
  const store = storage();
  if (store === null) return;

  try {
    const prefix = `${KEY_PREFIX}.v${String(DRAFT_VERSION)}.${sellerAccountId}.`;
    // Collected first. Removing while iterating `key(i)` shifts every index
    // after it, which silently skips every other match.
    const doomed: string[] = [];

    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && key.startsWith(prefix)) doomed.push(key);
    }

    for (const key of doomed) store.removeItem(key);
  } catch {
    // As above.
  }
}
