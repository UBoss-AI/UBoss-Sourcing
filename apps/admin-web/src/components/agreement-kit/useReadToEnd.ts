/**
 * Whether the bottom of a scrolling box has been in view.
 *
 * Asked on every scroll, whenever the box or its content changes size (a
 * resize, a font arriving, 200% zoom, a longer translation), and once after
 * the box is laid out - which is what lets text short enough to fit enable
 * the button at once. Keyboard scrolling, a screen reader moving through the
 * text and a scroll wheel all end in a scroll event, so they all count.
 *
 * Once reached it stays reached until `resetKey` changes, so scrolling back
 * up to re-read a clause does not disable the button again. The key names the
 * documents shown, so another version or language starts over.
 *
 * This says the end of the text was on screen. It does not say anybody read
 * it, and nothing in the kit claims it does. There are no timers.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

/** How close to the bottom counts as the bottom, in CSS pixels. */
export const READ_TO_END_TOLERANCE_PX = 8;

export function atEnd(box: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return box.scrollHeight - box.clientHeight - box.scrollTop <= READ_TO_END_TOLERANCE_PX;
}

export function useReadToEnd(
  ref: RefObject<HTMLElement | null>,
  /** Only while the text is shown and loaded; never for a loading or failed state. */
  active: boolean,
  resetKey: string,
): boolean {
  const [reached, setReached] = useState(false);

  // Reset before paint, so a stale "reached" never flashes an enabled button
  // for the text that replaced it.
  useLayoutEffect(() => {
    setReached(false);
  }, [resetKey]);

  const check = useCallback((): void => {
    const box = ref.current;
    if (box !== null && atEnd(box)) setReached(true);
  }, [ref]);

  useEffect(() => {
    if (!active) return undefined;
    const box = ref.current;
    if (box === null) return undefined;

    const frame = requestAnimationFrame(check);
    box.addEventListener('scroll', check, { passive: true });

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(check);
      observer.observe(box);
      for (const child of Array.from(box.children)) observer.observe(child);
    }
    window.addEventListener('resize', check);

    return () => {
      cancelAnimationFrame(frame);
      box.removeEventListener('scroll', check);
      observer?.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [active, check, ref, resetKey]);

  return active && reached;
}
