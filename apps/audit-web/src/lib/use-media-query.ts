/**
 * Does the viewport match a media query, live?
 *
 * Used to render a table OR its phone cards, never both: two copies of every
 * row in the DOM is twice the work for a screen reader that ignores
 * `display: none` only when the stylesheet has loaded. Without `matchMedia`
 * (a test environment) it answers `fallback`.
 */
import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string, fallback = true): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    () => (typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? fallback : window.matchMedia(query).matches),
    () => fallback,
  );
}

/** At least the `sm` breakpoint (640px): wide enough for a table. */
export function useWideViewport(): boolean {
  return useMediaQuery('(min-width: 640px)');
}
