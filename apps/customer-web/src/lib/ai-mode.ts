/**
 * Carrying a question from the landing page into AI Mode.
 *
 * Somebody types "which suction catheters fit a 10 Fr port" into the hero
 * search box and presses Search. AI Mode is a different route, so the question
 * has to travel — and what must not happen is the thing every storefront gets
 * wrong: they arrive somewhere and their question is gone.
 *
 * So it is parked here on the way out and collected once on the way in. Three
 * decisions:
 *
 *   - **`sessionStorage`, not the URL.** A question can be a paragraph, it can
 *     contain anything a person types, and it has no business being in a link
 *     that gets pasted into a chat window, logged by a proxy or kept in browser
 *     history. It belongs to this tab and this visit and is gone when the tab
 *     closes — which also means a shared machine in a procurement office does
 *     not offer the next person the last person's question.
 *   - **`sessionStorage`, not React state or router state.** AI Mode is open
 *     to guests, so most trips are a client-side navigation that state would
 *     survive — but a customer who signs in part-way through is a real page
 *     load, and the question has to come out the other side of it.
 *   - **Read once.** `takePendingQuestion` clears as it reads, so refreshing
 *     the AI page does not re-ask the question that was already asked. It is a
 *     handoff, not a stored draft.
 *
 * The route is here too, so the half-dozen places that link to AI Mode agree on
 * one string.
 */

/** The AI Mode route. One constant, so a rename is one edit. */
export const AI_MODE_PATH = '/ai';

const PENDING_QUESTION_KEY = 'uboss_ai_pending_question';

/**
 * What to do with a question that arrives from somewhere else.
 *
 * `send` means the customer pressed Search with words in the box: they have
 * already asked, and making them press a second button on arrival is a step
 * that exists for no reason. `compose` means it should land in the composer
 * ready to edit — used when the question came from somewhere less explicit.
 */
export type PendingIntent = 'send' | 'compose';

export interface PendingQuestion {
  text: string;
  intent: PendingIntent;
}

function isPendingQuestion(value: unknown): value is PendingQuestion {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as Partial<PendingQuestion>;
  return (
    typeof candidate.text === 'string' &&
    (candidate.intent === 'send' || candidate.intent === 'compose')
  );
}

/** Park a question for AI Mode to pick up. An empty one parks nothing. */
export function setPendingQuestion(text: string, intent: PendingIntent = 'send'): void {
  const trimmed = text.trim();

  try {
    if (trimmed.length === 0) {
      sessionStorage.removeItem(PENDING_QUESTION_KEY);
      return;
    }

    sessionStorage.setItem(PENDING_QUESTION_KEY, JSON.stringify({ text: trimmed, intent }));
  } catch {
    // Private browsing, or site data blocked. The customer keeps their
    // navigation and loses the pre-filled question, which is a small loss and
    // not a reason to fail the click.
  }
}

/**
 * Collect the parked question, clearing it.
 *
 * Clears first and returns second, so a parse failure cannot leave a value that
 * gets retried on every mount.
 */
export function takePendingQuestion(): PendingQuestion | null {
  try {
    const raw = sessionStorage.getItem(PENDING_QUESTION_KEY);
    sessionStorage.removeItem(PENDING_QUESTION_KEY);

    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);
    return isPendingQuestion(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
