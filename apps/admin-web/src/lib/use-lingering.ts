/**
 * Keep something on screen for as long as it takes to leave.
 *
 * React unmounts a thing the moment the state that rendered it goes away, and
 * an element removed from the document animates nothing on its way out. So
 * anything that should fade, slide or shrink as it goes needs its state to
 * outlive the decision to close by exactly the length of that animation -
 * which is all this hook is.
 *
 * It holds the **last value**, not a flag. The difference matters wherever
 * the data being displayed disappears along with the decision to display it:
 * the delivery-coverage panel is rendered from a query keyed on the warehouse
 * being pointed at, so the instant nobody is pointing at one, that query is
 * disabled and its answer is gone. Fading out an empty panel - or worse, one
 * that has flipped back to its loading spinner for 200ms on the way out - is
 * not an exit animation, it is a second thing happening. Keeping the value
 * means what fades is what was there.
 *
 * Under `prefers-reduced-motion: reduce` the block in `index.css` collapses
 * every transition to nothing, so the caller's element is already invisible
 * long before the timer here fires. Nothing lingers on screen; there is
 * simply a fraction of a second in which an invisible element is still
 * mounted, which costs nobody anything.
 *
 * Coming back before the timer fires is the ordinary case rather than an edge
 * one - a pointer that left a marker and returned to it - and it is why the
 * caller should animate with a *transition* rather than a keyframe: the timer
 * is cancelled, `isLeaving` goes back to false, and a transition picks the
 * element up wherever it had got to instead of snapping it back.
 */
import { useEffect, useRef, useState } from 'react';

export interface Lingering<T> {
  /** What to render: the live value, or the last one while it leaves. */
  value: T;
  /** True once the value has gone and the exit is running. */
  isLeaving: boolean;
}

export function useLingering<T>(value: T | null, exitMs: number): Lingering<T> | null {
  const lastRef = useRef<T | null>(null);
  /**
   * Nothing but a way to ask for one more render once the exit is over.
   *
   * The value itself lives in a ref rather than in state because it is
   * written during render - a caller handing over a freshly built object each
   * time, which is the normal shape of a props snapshot, would otherwise set
   * state on every render and never stop.
   */
  const [, setElapsed] = useState(0);

  const isPresent = value !== null;
  if (value !== null) lastRef.current = value;

  useEffect(() => {
    // Present, or nothing to see out. Either way there is no exit to time.
    if (isPresent || lastRef.current === null) return undefined;

    const timer = window.setTimeout(() => {
      lastRef.current = null;
      setElapsed((count) => count + 1);
    }, exitMs);

    // Runs when it comes back and when the caller unmounts, which are the two
    // ways an exit ends early.
    return () => {
      window.clearTimeout(timer);
    };
  }, [isPresent, exitMs]);

  if (value !== null) return { value, isLeaving: false };
  if (lastRef.current === null) return null;
  return { value: lastRef.current, isLeaving: true };
}
