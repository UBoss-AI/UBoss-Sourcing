/**
 * Put the cursor in a field the moment it appears.
 *
 * WHY THIS EXISTS RATHER THAN `autoFocus`
 *
 * The attribute focuses whenever the element mounts, wherever it happens to
 * be, and it cannot be undone once React has rendered it. On a long screen
 * that yanks the reader's scroll position to somewhere they were not looking,
 * which is why `jsx-a11y` forbids it.
 *
 * A callback ref is narrower, and this one is STABLE - `useCallback` with no
 * dependencies - which is the part that matters. React reattaches an inline
 * callback ref on every render, so an inline `(node) => node?.focus()` would
 * drag the cursor back to the field every time anything on the screen changed.
 * A stable callback is attached once, when the node mounts, and detached once,
 * when it unmounts. Reopening a panel focuses it again; typing in it does not.
 *
 * Use it only where the focus is a consequence of something the person just
 * did: opening the sign-in page, pressing a button that reveals a panel. A
 * field that focuses itself for no reason is the accessibility problem the
 * rule is about, and this hook does not make that acceptable.
 */
import { useCallback } from 'react';

export function useFocusOnMount(): (node: HTMLElement | null) => void {
  return useCallback((node: HTMLElement | null) => {
    node?.focus();
  }, []);
}
