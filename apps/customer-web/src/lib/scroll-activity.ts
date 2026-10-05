/**
 * Whether the visitor is scrolling right now.
 *
 * The home page's hero carries three moving decorations — the WebGL globe,
 * the star field and the sourcing hub's orbits — and each of them redraws
 * every frame. Measured on the live storefront with a 4x CPU slowdown, they
 * left only about a third of scroll frames on time, mostly because the hub's
 * frosted-glass cards re-blur a moving background on every frame. Scrolling is the
 * one moment smoothness is noticed, and decoration is the one thing nobody
 * notices pausing, so each of them stops for the length of a scroll gesture
 * and picks up again a moment after it ends.
 *
 * Two ways to read it, for the two kinds of consumer:
 *
 *   - **CSS** reads `data-scrolling` on `<html>`. The hub pauses its
 *     animations with `animation-play-state` under that attribute, and no
 *     React render is involved at all.
 *   - **Render loops** call `subscribeScrollActivity`, and are told on each
 *     change. One window listener is shared by everybody, attached on the
 *     first subscription and removed with the last.
 *
 * The listener is passive, so it can never delay the scroll it is watching,
 * and it does no work per event beyond resetting one timer.
 */

/** How long after the last scroll event the gesture counts as over. */
const SETTLE_MS = 160;

type Listener = (scrolling: boolean) => void;

const listeners = new Set<Listener>();
let scrolling = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function set(next: boolean): void {
  if (next === scrolling) return;
  scrolling = next;

  if (next) document.documentElement.setAttribute('data-scrolling', '');
  else document.documentElement.removeAttribute('data-scrolling');

  for (const listener of listeners) listener(next);
}

function onScroll(): void {
  set(true);
  clearTimeout(timer);
  timer = setTimeout(() => {
    set(false);
  }, SETTLE_MS);
}

/** True while a scroll gesture is under way. */
export function isScrolling(): boolean {
  return scrolling;
}

/**
 * Be told when scrolling starts and stops. Returns the unsubscribe function.
 *
 * Starting the shared listener is a side effect of the first subscription, so
 * a page with nothing to pause pays nothing.
 */
export function subscribeScrollActivity(listener: Listener): () => void {
  if (listeners.size === 0) {
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;

    window.removeEventListener('scroll', onScroll, { capture: true });
    clearTimeout(timer);
    set(false);
  };
}
