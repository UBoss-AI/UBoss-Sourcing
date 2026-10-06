/**
 * Whether this person has asked for less movement.
 *
 * Read straight from the media query rather than through motion's own
 * `useReducedMotion`, for the same two reasons the storefront's copy of this
 * gives: the preference is answered by not rendering an animation at all
 * rather than by damping one, and motion's hook resolves the query once per
 * page and caches it, which is fine in a browser and untestable in a suite
 * that has to render both answers.
 *
 * Subscribed, not sampled: somebody who turns the preference on mid-session
 * gets the still version from that moment, not at the next page load.
 */
import { useEffect, useState } from 'react';

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The media query, or nothing.
 *
 * jsdom does not implement `matchMedia`, so a test that mounts a screen
 * containing a caller would otherwise die on a call it is not asking about.
 * Absent means "no preference expressed", which is the answer every browser
 * that does implement it gives by default.
 */
function reduceQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE_QUERY) : null;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reduceQuery()?.matches ?? false);

  useEffect(() => {
    const query = reduceQuery();
    if (query === null) return undefined;

    const settle = (): void => {
      setReduced(query.matches);
    };

    settle();
    query.addEventListener('change', settle);

    return () => {
      query.removeEventListener('change', settle);
    };
  }, []);

  return reduced;
}
