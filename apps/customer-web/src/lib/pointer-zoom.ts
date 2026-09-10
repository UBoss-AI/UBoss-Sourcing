/**
 * Where in a box the pointer is, as two numbers between 0 and 1.
 *
 * That is the whole of it. The product page's image zoom is done in CSS from
 * those two numbers — see `.zoom-layer` in index.css — because a magnifier
 * that follows a cursor is the exact shape of problem that gets written as a
 * `background-position` animation and then repaints a 600px square sixty times
 * a second for the length of the hover.
 *
 * The decisions are the same four as `pointer-tilt.ts`, and for the same
 * reasons, but they are worth restating because this hook is the one attached
 * to the largest paint on the page:
 *
 * **Custom properties, not React state.** The zoom is a `transform` on one
 * element. React has nothing to decide, so it is never told: the numbers go
 * straight to the node through a ref.
 *
 * **One write per frame.** Pointer moves are coalesced into a
 * `requestAnimationFrame` callback. The box is measured once when the pointer
 * arrives and reused until it leaves, because `getBoundingClientRect` is a
 * layout read and doing one per mouse event is how a hover effect starts
 * costing more than the page.
 *
 * **Mouse only.** A finger has no hover. On a touch screen the zoom would
 * open on a tap, centred wherever the tap landed, and stay open until the next
 * tap somewhere else — a product photograph stuck at 2.5x, which reads as a
 * broken image rather than as a feature.
 *
 * **Reduced motion keeps the zoom and loses the easing.** Unlike the card
 * tilt, this one is not decoration: it is how somebody reads a product code
 * off a photograph, and taking it away would take the information with it. So
 * the layer still tracks the pointer, and the CSS drops the transitions so it
 * moves without gliding. That is the same treatment `scroll-behavior` gets in
 * this app — the destination still happens, the animation does not.
 *
 * `isZooming` is an attribute on the container rather than a class, so the CSS
 * can key the layer's visibility off it. It is what stops a sticky `:hover`
 * on a touch screen showing a zoom nobody asked for.
 */
import { useCallback, useEffect, useRef } from 'react';

interface PointerZoom {
  /** Put this on the box the pointer moves over. */
  ref: React.RefObject<HTMLDivElement | null>;
  onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
}

export function usePointerZoom(): PointerZoom {
  const ref = useRef<HTMLDivElement | null>(null);

  const box = useRef<DOMRect | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);

  const apply = useCallback(() => {
    frame.current = null;

    const element = ref.current;
    const rect = box.current;
    const point = pending.current;
    if (element === null || rect === null || point === null) return;
    // A zero-sized box is jsdom, or a node unmounted mid-frame.
    if (rect.width === 0 || rect.height === 0) return;

    // Clamped, because a pointer can be a fraction of a pixel outside the box
    // on the frame the browser reports the last move, and an out-of-range
    // value would slide the layer past its own edge and show the frame behind
    // it.
    const u = Math.min(1, Math.max(0, (point.x - rect.left) / rect.width));
    const v = Math.min(1, Math.max(0, (point.y - rect.top) / rect.height));

    element.style.setProperty('--zoom-u', u.toFixed(4));
    element.style.setProperty('--zoom-v', v.toFixed(4));
  }, []);

  const schedule = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      pending.current = { x: event.clientX, y: event.clientY };
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(apply);
    },
    [apply],
  );

  const onPointerEnter = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'mouse') return;

      const element = ref.current;
      if (element === null) return;

      // The one layout read, taken once per hover rather than per move.
      box.current = element.getBoundingClientRect();
      element.dataset.zooming = 'true';
      schedule(event);
    },
    [schedule],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'mouse' || box.current === null) return;
      schedule(event);
    },
    [schedule],
  );

  const onPointerLeave = useCallback(() => {
    box.current = null;
    pending.current = null;

    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }

    const element = ref.current;
    if (element === null) return;

    delete element.dataset.zooming;
    // Removed rather than set back to the middle, so the resting position
    // lives in the stylesheet's own fallbacks and there is one place that
    // says where an un-zoomed layer sits.
    element.style.removeProperty('--zoom-u');
    element.style.removeProperty('--zoom-v');
  }, []);

  // A gallery whose image changes while the pointer is over it — a thumbnail
  // pressed, a variant chosen — would otherwise leave a frame queued against
  // a node that has gone.
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return { ref, onPointerEnter, onPointerMove, onPointerLeave };
}
