/**
 * A form that keeps itself, without anybody pressing Save.
 *
 * ## The two saves, and why there are two
 *
 * This hook does two different things that are easy to confuse:
 *
 *   1. **It writes every change to the device, at once.** That is
 *      `onboarding-draft.ts`, and it is the copy that survives a session
 *      ending, a closed tab and a refused request — because none of those are
 *      moments when the server can be reached.
 *   2. **It sends the form up, a couple of seconds after typing stops.** That
 *      is the real save, and it is the one that makes a step go green.
 *
 * Only the first is guaranteed. The second is best-effort by nature: a
 * half-typed website address is not a URL, and an address with no postcode is
 * not an address, so there are long stretches of a form's life where there is
 * nothing the API would accept. `canSend` is how the form says so, and while it
 * is false nothing is sent and the device copy is the whole of the safety net.
 *
 * ## Why a debounce rather than a save per keystroke
 *
 * A registration number is twenty characters. Sending twenty PATCHes for it
 * would cost twenty audit rows, twenty recomputations of the onboarding
 * progress and twenty chances to race each other into the wrong order. Waiting
 * for a pause in typing costs nothing, because the device copy was already
 * written on the first of those twenty keystrokes.
 *
 * ## What the seller is told
 *
 * The status this returns is shown on screen, and every value of it is a
 * different promise:
 *
 *   - `saving` / `saved` — the marketplace has it.
 *   - `keptLocally` — the marketplace does not have it yet, this browser does.
 *   - `sessionEnded` — the session is over; this browser still has it and will
 *     offer it back after signing in.
 *   - `noStorage` — this browser is keeping nothing. Press Save.
 *
 * The last one matters more than its rarity suggests. Telling somebody their
 * work is kept when it is not is the one failure this whole feature exists to
 * prevent, so a `localStorage` that refused a write is said out loud rather
 * than swallowed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { onSessionEnded } from '@/lib/api';
import { clearDraft, writeDraft } from '@/lib/onboarding-draft';

export type AutoSaveStatus =
  /** Nothing has been typed since the last save, or since the form opened. */
  | 'idle'
  /** Typed and held on the device; the send is waiting for a pause. */
  | 'pending'
  /** The request is in flight. */
  | 'saving'
  /** The marketplace has it. */
  | 'saved'
  /** The send failed or cannot be made yet. The device copy holds it. */
  | 'keptLocally'
  /** The session ended mid-form. The device copy holds it. */
  | 'sessionEnded'
  /** This browser refused to keep a copy. Nothing is holding it but the page. */
  | 'noStorage';

export interface FormAutoSave {
  status: AutoSaveStatus;
  /** When the status last changed, for "kept at 14:05". Null while idle. */
  changedAt: number | null;
  /**
   * Forget the device copy.
   *
   * Called after a successful manual save — the server has the answers, so an
   * offer to restore them on the next visit would only be confusing — and when
   * a seller discards a restored draft.
   */
  forgetDraft: () => void;
}

export interface FormAutoSaveOptions<T> {
  /** Whose draft this is. Drafts are never shared between seller accounts. */
  sellerAccountId: string;
  /** Which step. One draft per step, keyed by the server's own step key. */
  section: string;
  /**
   * Everything the form is holding, as something `JSON.stringify` can take.
   *
   * Compared by its serialised form, so a new object with the same contents on
   * every render does not look like a change. That is deliberate: React state
   * for a form is rebuilt constantly and identity means nothing here.
   */
  values: T;
  /** Whether anything has been typed. Nothing is written or sent until it has. */
  isDirty: boolean;
  /** Whether the form is currently in a state the API would accept. */
  canSend: boolean;
  /** False for a read-only application - under review, approved, rejected. */
  enabled: boolean;
  /** The real save. Rejecting is expected and is not an error worth a toast. */
  save: () => Promise<unknown>;
  /** How long a pause in typing counts as "stopped". */
  delayMs?: number;
}

/** Long enough that a typed field is one save, short enough to feel automatic. */
const DEFAULT_DELAY_MS = 2000;

export function useFormAutoSave<T>({
  sellerAccountId,
  section,
  values,
  isDirty,
  canSend,
  enabled,
  save,
  delayMs = DEFAULT_DELAY_MS,
}: FormAutoSaveOptions<T>): FormAutoSave {
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const [changedAt, setChangedAt] = useState<number | null>(null);

  const serialised = JSON.stringify(values);

  /*
   * Three refs holding "the current one of these", and all three for the same
   * reason: the debounced send runs from inside a timeout that was created
   * several keystrokes ago, and everything it touches has to be the version
   * that exists when it FIRES, not the version that existed when it was set.
   *
   *   - `saveRef` closes over the form's state, so it is a new function on
   *     every render. Putting it in the effect's dependency list would restart
   *     the countdown on every render this hook's own `setStatus` causes,
   *     which is a loop that never settles.
   *   - `latestRef` is how a save that has just come back knows whether
   *     anything was typed while it was in the air.
   *   - `statusRef` keeps the status out of the effect's dependencies, where it
   *     would have the same effect as `saveRef`.
   */
  const saveRef = useRef(save);
  saveRef.current = save;

  const latestRef = useRef(serialised);
  latestRef.current = serialised;

  const statusRef = useRef<AutoSaveStatus>(status);
  statusRef.current = status;

  const timerRef = useRef<number | null>(null);

  /** What the server was last given, serialised. Null before the first send. */
  const sentRef = useRef<string | null>(null);

  const announce = useCallback((next: AutoSaveStatus): void => {
    setStatus(next);
    setChangedAt(Date.now());
  }, []);

  const cancelTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const forgetDraft = useCallback((): void => {
    clearDraft(sellerAccountId, section);
    sentRef.current = latestRef.current;
  }, [sellerAccountId, section]);

  /**
   * Send what the form was holding when the countdown finished.
   *
   * The device copy is cleared only if nothing has been typed since. Somebody
   * who carried on typing while a save was in flight must not lose the newer
   * characters from the device just because the older ones arrived.
   */
  const run = useCallback(
    async (snapshot: string): Promise<void> => {
      announce('saving');

      try {
        await saveRef.current();
        sentRef.current = snapshot;

        if (latestRef.current === snapshot) {
          clearDraft(sellerAccountId, section);
          announce('saved');
        } else {
          announce('pending');
        }
      } catch {
        /*
         * Deliberately quiet.
         *
         * An auto-save is refused all the time and most refusals are not
         * problems: a field half-typed, a network that dropped for a second, a
         * session that has just ended. A toast for each of those would train a
         * seller to dismiss toasts. What the screen says instead is where the
         * work is — on this device — which is the thing they actually need to
         * know. The Save button still reports its own failures in full.
         */
        announce('keptLocally');
      }
    },
    [announce, sellerAccountId, section],
  );

  /* Write to the device on every change, and start the countdown to a send. */
  useEffect(() => {
    if (!enabled || !isDirty) return;
    if (serialised === sentRef.current) return;

    const kept = writeDraft(sellerAccountId, section, values);

    // A browser that will not keep a copy is said out loud, and it outranks
    // every other status: it is the only one that means "your work is in this
    // tab and nowhere else".
    if (!kept) {
      announce('noStorage');
    } else if (statusRef.current !== 'saving') {
      announce('pending');
    }

    // Nothing the API would take yet — an address missing its postcode, an
    // email that is still being typed. The device copy above is the save until
    // the form says otherwise.
    if (!canSend) return;

    cancelTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void run(serialised);
    }, delayMs);

    return cancelTimer;
    /*
     * `values` is represented by `serialised`, which is what a change actually
     * means here; listing the object itself would fire this on every render.
     * `announce`, `cancelTimer` and `run` are all stable.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialised, isDirty, canSend, enabled, delayMs, sellerAccountId, section]);

  /* Stop the clock when the form goes away. */
  useEffect(() => cancelTimer, [cancelTimer]);

  /*
   * The session ending is the case this whole feature is named after.
   *
   * Nothing is sent — there is nothing to send it with — and nothing needs to
   * be written either, because the effect above wrote it on the keystroke. All
   * that is left is to stop the pending request and tell the seller where
   * their work is, so the sign-in screen is not the first thing they meet with
   * no explanation of what became of the form behind it.
   */
  useEffect(
    () =>
      onSessionEnded(() => {
        cancelTimer();
        // `noStorage` is not overwritten. It is the more serious of the two and
        // the advice it gives - press Save - is still the right advice.
        setStatus((current) => (current === 'noStorage' ? current : 'sessionEnded'));
        setChangedAt(Date.now());
      }),
    [cancelTimer],
  );

  return { status, changedAt, forgetDraft };
}
