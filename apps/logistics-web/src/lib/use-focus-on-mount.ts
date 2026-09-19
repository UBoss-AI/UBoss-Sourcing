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
 *
 * WHY IT TAKES THE FIELD'S OWN REF INSTEAD OF BEING COMBINED AT THE CALL SITE
 *
 * A field that is both registered with react-hook-form and focused on mount
 * needs two callbacks on one `ref`, and writing the join inline throws the
 * stability above away - the arrow is a new function on every render, so React
 * detaches and reattaches it on every render, and the focus runs again each
 * time:
 *
 *     ref={(node) => { fieldRef(node); focus(node); }}   // DO NOT
 *
 * That is the sign-in bug. Nothing on a sign-in screen re-renders while
 * somebody types the first time, so it looks fine - but after one refused
 * attempt react-hook-form re-validates on every keystroke, the page renders
 * again on each one, and the cursor was thrown out of the password box and
 * back into the email box mid-word. Passing the field's ref in here keeps one
 * stable callback on the element, so the field is registered once and focused
 * once, however often the form re-renders:
 *
 *     const { ref: emailRef, ...emailField } = form.register('email');
 *     const focusEmail = useFocusOnMount(emailRef);
 *     <Input {...emailField} ref={focusEmail} />
 */
import { useCallback, useRef } from 'react';

export function useFocusOnMount<T extends HTMLElement = HTMLElement>(
  attach?: (node: T | null) => void,
): (node: T | null) => void {
  /*
   * The ref `register` hands out is a fresh closure on every render, and the
   * stable callback below would otherwise hold the first one for the life of
   * the field. Kept in a box, written during render - which is the only moment
   * early enough, because React attaches refs after the render that produced
   * them and the very first attach has to see the first one.
   */
  const latest = useRef(attach);
  latest.current = attach;

  return useCallback((node: T | null) => {
    latest.current?.(node);
    node?.focus();
  }, []);
}
