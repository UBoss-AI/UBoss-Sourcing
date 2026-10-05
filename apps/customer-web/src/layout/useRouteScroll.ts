/**
 * Where a page starts when it is navigated to, and where focus lands.
 *
 * A single-page app never reloads, so nothing does what a page load would:
 * the scroll position stays wherever the previous page left it, and focus
 * stays on the button that was pressed. This hook does both, once per page,
 * from the layout - so no screen has to remember to.
 *
 * ## Which element scrolls
 *
 * Usually the window. The signed-out screens are the exception: from `lg` up
 * their frame is pinned to the window's height and the FORM column scrolls
 * inside it (see `AuthSplit`). A reset that only moved the window would leave
 * such a column wherever it was. So besides the window, every element inside
 * `<main>` marked `data-route-scroll` is put back to its top. A column that
 * the new page mounted fresh is already at its top; the attribute is for a
 * scroller a layout keeps mounted across pages.
 *
 * ## When
 *
 *   - **A new page (PUSH or REPLACE to a different path): the top, at once.**
 *     `behavior: 'instant'` - a smooth scroll from the bottom of a long form
 *     to the top of the next page is an animation of the page you just left.
 *     In a LAYOUT effect, so it happens after the new page is in the DOM and
 *     before it is painted: nothing of the old position is ever drawn.
 *   - **Back and Forward (POP): where that entry was left**, as a page load
 *     would. Positions are remembered per history entry as the window
 *     scrolls. A page whose content is still loading may be too short to
 *     reach the saved position at first; the restore is re-applied while the
 *     document grows, for a moment, and abandoned the instant the person
 *     scrolls themselves.
 *   - **The same path with a different query** (a filter, a sort, a page of
 *     results): nothing. Pathname is the trigger, not the location key, so a
 *     query refetch or a state update never throws anybody back to the top.
 *
 * ## Focus
 *
 * Moves to the page's own primary heading when it marks one with
 * `data-route-focus` (and `tabIndex={-1}`), otherwise to `<main>`. Either way
 * a screen reader is told the page changed, and the heading is the more
 * useful thing to hear. `preventScroll`, so focusing never moves the page
 * the reset just positioned.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { NavigationType, useLocation, useNavigationType } from 'react-router-dom';

/** How long a POP keeps trying to reach a saved position while content loads. */
const RESTORE_WINDOW_MS = 1500;

/** How long a scroll has to rest before its position is remembered. */
const SAVE_AFTER_MS = 120;

/** Saved window positions by history-entry key. Module scope: one app, one history. */
const saved = new Map<string, number>();

/** Forgets every remembered position. For tests: a reload does it in a browser. */
export function forgetScrollPositions(): void {
  saved.clear();
}

/** Resets every nested scroller the page marked, and the window. */
export function resetScroll(main: HTMLElement | null): void {
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  if (main === null) return;
  for (const element of main.querySelectorAll<HTMLElement>('[data-route-scroll]')) {
    element.scrollTop = 0;
  }
}

/** The page's own heading if it offered one, otherwise the main region. */
export function focusPage(main: HTMLElement | null): void {
  if (main === null) return;
  const target = main.querySelector<HTMLElement>('[data-route-focus]') ?? main;
  target.focus({ preventScroll: true });
}

export function useRouteScroll(
  mainRef: RefObject<HTMLElement | null>,
  options: { skip?: (from: string, to: string) => boolean } = {},
): void {
  const location = useLocation();
  const navigationType = useNavigationType();
  const previousPath = useRef<string | null>(null);
  const keyRef = useRef(location.key);
  keyRef.current = location.key;
  const skip = options.skip;

  // The browser's own restoration would fight this one: it fires on
  // popstate, before the new page exists, and restores into the old one.
  useEffect(() => {
    const before = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => {
      window.history.scrollRestoration = before;
    };
  }, []);

  // Remember where each entry was left, once each scroll comes to rest.
  //
  // Not on every frame: reading `scrollY` makes the browser bring layout up to
  // date there and then, so a read per frame did a forced layout per frame
  // for the whole of every scroll. Measured on the home page, this listener
  // was the largest piece of script running during a scroll. The resting
  // position is the one that matters. A press or a key is what starts a
  // navigation, so the position is also taken then, in case somebody clicks a
  // link within the moment before the timer fires; `pagehide` covers leaving
  // the site.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const record = (): void => {
      saved.set(keyRef.current, window.scrollY);
    };
    const onScroll = (): void => {
      clearTimeout(timer);
      timer = setTimeout(record, SAVE_AFTER_MS);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointerdown', record, { capture: true, passive: true });
    window.addEventListener('keydown', record, { capture: true, passive: true });
    window.addEventListener('pagehide', record);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointerdown', record, { capture: true });
      window.removeEventListener('keydown', record, { capture: true });
      window.removeEventListener('pagehide', record);
      clearTimeout(timer);
    };
  }, []);

  useLayoutEffect(() => {
    const from = previousPath.current;
    const to = location.pathname;
    previousPath.current = to;
    // The first render is a page load: the browser has already put it at its
    // top, and focus belongs to the page's own document order.
    if (from === null || from === to) return;
    if (skip?.(from, to) === true) return;

    const main = mainRef.current;
    focusPage(main);

    const target = navigationType === NavigationType.Pop ? saved.get(location.key) : undefined;
    if (target === undefined || target === 0) {
      resetScroll(main);
      return;
    }

    // Back or Forward to somewhere with a position worth returning to.
    window.scrollTo({ top: target, left: 0, behavior: 'instant' });
    if (Math.abs(window.scrollY - target) < 2) return;

    // Too short yet - the content is still arriving. Try again as it grows,
    // and stop the moment the person takes over.
    let gaveUp = false;
    const stop = (): void => {
      gaveUp = true;
      observer.disconnect();
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    };
    const observer = new ResizeObserver(() => {
      if (gaveUp) return;
      window.scrollTo({ top: target, left: 0, behavior: 'instant' });
      if (Math.abs(window.scrollY - target) < 2) stop();
    });
    observer.observe(document.body);
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('keydown', stop);
    const timer = window.setTimeout(stop, RESTORE_WINDOW_MS);
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [location.pathname, location.key, navigationType, mainRef, skip]);
}
