/**
 * The Seller Hub's idle session, as the browser sees it.
 *
 * THE SERVER DECIDES
 *
 * The Hub re-locks on the server after SELLER_HUB_IDLE_TIMEOUT_SECONDS
 * without deliberate activity (see the backend's seller guard). Nothing here
 * can keep it open or end it early: this module only reports what the person
 * does, hears when the server says the Hub will re-lock, and tells every tab.
 *
 * WHAT COUNTS AS A PERSON DOING SOMETHING
 *
 * Every change the Hub sends (POST, PUT, PATCH, DELETE) counts on its own. A
 * read counts only when it carries `x-seller-activity: 1`, which this module
 * adds when the person clicked or pressed a key in the last few seconds and
 * the tab is in front. So opening a page counts, and a notification badge
 * polling in a background tab does not. Moving the mouse is not activity -
 * pointer movement is never listened to.
 *
 * EVERY TAB AGREES
 *
 * Tabs share one session row, so they already share one expiry on the server.
 * A BroadcastChannel carries what one tab learns - a later expiry after a
 * click, a "stay signed in", a sign-out, the expiry itself - to the others, so
 * no tab keeps warning about a Hub another tab has just kept open, and none
 * stays drawn after another tab has signed out.
 */

export const SELLER_ACTIVITY_HEADER = 'x-seller-activity';
export const SELLER_EXPIRES_HEADER = 'x-seller-session-expires-at';

/** A click or key press this recent makes the next Hub read "deliberate". */
export const INTERACTION_WINDOW_MS = 15_000;

/** Where the lock screen finds why it is back. Kept for this tab only. */
const EXPIRED_NOTICE_KEY = 'uboss.sellerHub.expiredNotice';
const CHANNEL_NAME = 'uboss-seller-hub-session';

export type SellerSessionEvent =
  | { type: 'expiresAt'; at: string }
  | { type: 'renewed'; at: string }
  | { type: 'expired' }
  | { type: 'closed' };

type Listener = (event: SellerSessionEvent) => void;
const listeners = new Set<Listener>();

let lastInteraction = 0;
let installed = false;
let channel: BroadcastChannel | null = null;

function openChannel(): BroadcastChannel | null {
  if (channel !== null) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (message: MessageEvent<SellerSessionEvent>) => {
      // From another tab: tell this tab's listeners, never echo it back.
      for (const listener of listeners) listener(message.data);
    };
  } catch {
    channel = null;
  }
  return channel;
}

/** Tell this tab and every other tab. */
export function publishSellerSession(event: SellerSessionEvent): void {
  for (const listener of listeners) listener(event);
  try {
    openChannel()?.postMessage(event);
  } catch {
    // A closed channel: other tabs learn at their next request instead.
  }
}

export function onSellerSession(listener: Listener): () => void {
  listeners.add(listener);
  openChannel();
  return () => {
    listeners.delete(listener);
  };
}

/** Start listening for clicks and key presses. Idempotent. */
export function installInteractionTracking(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const mark = (): void => {
    lastInteraction = Date.now();
  };
  // Capture phase, passive: sees every press without being able to stop one.
  window.addEventListener('pointerdown', mark, { capture: true, passive: true });
  window.addEventListener('keydown', mark, { capture: true, passive: true });
}

/** For tests. */
export function noteInteraction(at: number = Date.now()): void {
  lastInteraction = at;
}

function isHubPath(path: string): boolean {
  return /^\/sellers?(\/|$|\?)/.test(path);
}

/** Headers for a request, when it is a Hub read a person asked for. */
export function sellerActivityHeaders(path: string, method: string): Record<string, string> {
  if (!isHubPath(path) || (method !== 'GET' && method !== 'HEAD')) return {};
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return {};
  if (Date.now() - lastInteraction > INTERACTION_WINDOW_MS) return {};
  return { [SELLER_ACTIVITY_HEADER]: '1' };
}

/** Read the server's answer about the Hub's expiry off any response. */
export function noteSellerResponse(path: string, headers: Headers, errorCode: string | null): void {
  if (!isHubPath(path)) return;
  if (errorCode === 'SELLER_SESSION_EXPIRED') {
    publishSellerSession({ type: 'expired' });
    return;
  }
  const at = headers.get(SELLER_EXPIRES_HEADER);
  if (at !== null && !Number.isNaN(Date.parse(at))) publishSellerSession({ type: 'expiresAt', at });
}

export function rememberExpiredNotice(): void {
  try {
    window.sessionStorage.setItem(EXPIRED_NOTICE_KEY, '1');
  } catch {
    // No storage: the lock screen simply does not say why.
  }
}

/** Whether the lock screen should say the Hub timed out. Read once, then cleared. */
export function takeExpiredNotice(): boolean {
  try {
    const found = window.sessionStorage.getItem(EXPIRED_NOTICE_KEY) === '1';
    window.sessionStorage.removeItem(EXPIRED_NOTICE_KEY);
    return found;
  } catch {
    return false;
  }
}

/** The later of two expiry times, as ISO strings; the server's clock is the source. */
export function laterExpiry(current: string | null, next: string): string {
  if (current === null) return next;
  return Date.parse(next) > Date.parse(current) ? next : current;
}
