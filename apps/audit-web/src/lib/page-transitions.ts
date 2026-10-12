/**
 * A soft cross-fade between pages, on every navigation.
 *
 * React Router can wrap a navigation in the browser's View Transitions API,
 * but only when each `<Link>` or `navigate()` asks for it. Asking at every
 * call site is a rule the next new link forgets, so the router's own
 * `navigate` is wrapped once here and every in-app navigation asks.
 *
 * **Only when the page changes.** A navigation that keeps the path and
 * changes the query string is a filter, a tab or a search box writing to the
 * address bar, sometimes on every keystroke. Fading the screen for that would
 * make typing flicker, and a view transition briefly freezes the page while
 * it plays. Back and forward by history number are left alone too, and so
 * is a tab in the background, where the browser refuses the transition and
 * reports the refusal as an uncaught error.
 *
 * What the fade looks like lives in `index.css`, under "Page transitions",
 * and is switched off there for `prefers-reduced-motion`. A browser without
 * the API (and jsdom) gets the ordinary instant swap: React Router checks
 * for `document.startViewTransition` before using it.
 */
import type { createBrowserRouter } from 'react-router-dom';

type AppRouter = ReturnType<typeof createBrowserRouter>;
type To = Parameters<AppRouter['navigate']>[0];
type Options = Parameters<AppRouter['navigate']>[1];

/** The path a navigation is heading to, resolved against where we are. */
function targetPath(to: To): string {
  const here = window.location.href;
  if (to === null) return window.location.pathname;
  if (typeof to === 'string') return new URL(to, here).pathname;
  return to.pathname ? new URL(to.pathname, here).pathname : window.location.pathname;
}

export function withPageTransitions(router: AppRouter): AppRouter {
  const navigate = router.navigate.bind(router);
  router.navigate = (to: To | number, opts?: Options) => {
    if (typeof to === 'number') return navigate(to);
    const changesPage = !document.hidden && targetPath(to) !== window.location.pathname;
    return navigate(to, changesPage ? { viewTransition: true, ...opts } : opts);
  };
  return router;
}
