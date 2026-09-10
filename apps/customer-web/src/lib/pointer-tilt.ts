/**
 * A card that leans towards the pointer.
 *
 * The effect is a perspective tilt of a few degrees plus a soft highlight that
 * follows the cursor, which together read as "this is an object with a surface"
 * rather than "this is a rectangle that got a bigger shadow". It is applied to
 * the product card, which is the one component in this storefront a buyer
 * spends real time hovering over — a grid of forty of them is the catalogue.
 *
 * Four decisions, and each of them is the difference between this being a nice
 * touch and being the reason a phone drops frames.
 *
 * **Custom properties, not React state.** A pointer moving across a card fires
 * dozens of events a second, and putting the angle in state would re-render the
 * card — and its price, its chips and its image — on every one of them. This
 * writes two CSS variables straight to the node through a ref. React never
 * hears about it, because React has nothing to decide.
 *
 * **One write per frame.** The events are coalesced into a `requestAnimationFrame`
 * callback, so a pointer that fires eight moves between two frames still costs
 * one style write. Reading `getBoundingClientRect` on every event would be the
 * expensive half — that is a layout read — so the rect is measured once when the
 * pointer arrives and reused until it leaves.
 *
 * **Mouse only.** `pointerType` is checked: a finger has no hover state, and on
 * a touch screen the "tilt" would fire once as a tap landed and stick until the
 * next tap somewhere else. Pen is left out for the same reason.
 *
 * **Nothing at all under `prefers-reduced-motion`.** Checked at the event
 * rather than at mount, so a visitor who changes the setting is respected
 * without a reload. The CSS also neutralises the transform, so the two agree
 * even if one of them is edited.
 *
 * Only `transform` is animated by any of this. The tilt, the scale and the
 * highlight's position are all one composited property on two elements.
 */
import { useCallback, useEffect, useRef } from 'react';

/**
 * The most the card ever leans, in degrees.
 *
 * Six. Enough to read as a surface catching the light, and short of the angle
 * at which a 14px product name starts to look blurred on a non-retina screen —
 * which is the thing that makes a tilt look cheap rather than expensive.
 */
const MAX_DEGREES = 6;

interface Tilt {
  /** Put this on the element that should lean. */
  ref: React.RefObject<HTMLElement | null>;
  onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
}

function prefersReducedMotion(): boolean {
  // jsdom has no `matchMedia` unless a test installs one, and a hover effect
  // is not worth a polyfill in every test that renders a card.
  if (typeof window.matchMedia !== 'function') return false;

  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useTilt(): Tilt {
  const ref = useRef<HTMLElement | null>(null);

  /** The card's box, measured when the pointer arrives. */
  const box = useRef<DOMRect | null>(null);
  /** The pending pointer position, in client coordinates. */
  const pending = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);

  const apply = useCallback(() => {
    frame.current = null;

    const element = ref.current;
    const rect = box.current;
    const point = pending.current;
    if (element === null || rect === null || point === null) return;
    // A zero-sized box is jsdom, or a card that has been unmounted mid-frame.
    if (rect.width === 0 || rect.height === 0) return;

    // -1 at the left or top edge, +1 at the right or bottom, 0 in the middle.
    const dx = (point.x - rect.left) / rect.width * 2 - 1;
    const dy = (point.y - rect.top) / rect.height * 2 - 1;

    // `rotateX` is negated: pushing the pointer *down* should tip the far edge
    // away, and a positive `rotateX` tips the near edge away instead, which
    // reads as the card recoiling from the cursor.
    element.style.setProperty('--tilt-x', `${(-dy * MAX_DEGREES).toFixed(2)}deg`);
    element.style.setProperty('--tilt-y', `${(dx * MAX_DEGREES).toFixed(2)}deg`);

    // Where the highlight sits, as a percentage of the card. The same two
    // numbers, in the units the gradient's own transform wants.
    element.style.setProperty('--tilt-gx', `${(dx * 50).toFixed(1)}%`);
    element.style.setProperty('--tilt-gy', `${(dy * 50).toFixed(1)}%`);
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
      if (event.pointerType !== 'mouse' || prefersReducedMotion()) return;

      // The one layout read, taken once per hover rather than per move.
      box.current = ref.current?.getBoundingClientRect() ?? null;
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

    // Removed rather than set to zero, so the resting state lives in the
    // stylesheet's own defaults and there is one place that says what "not
    // tilted" means.
    const element = ref.current;
    if (element === null) return;

    for (const name of ['--tilt-x', '--tilt-y', '--tilt-gx', '--tilt-gy']) {
      element.style.removeProperty(name);
    }
  }, []);

  // A card unmounted while the pointer is over it — a filter change, a page of
  // results replaced — would otherwise leave a frame queued against a node
  // that no longer exists.
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return { ref, onPointerEnter, onPointerMove, onPointerLeave };
}
