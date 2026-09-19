/**
 * A stack of square slides that slides sideways, one in focus at a time.
 *
 * Every slide is a photograph with a title written across it. The one in focus
 * sits square to the reader and carries a call to action; the rest are tipped
 * back a few degrees and dimmed, so the row reads as a deck of cards seen at
 * an angle rather than as a filmstrip. Press a tipped slide and it comes
 * forward; press the arrows and the deck moves one step.
 *
 * It is on the catalogue carrying a department's sub-categories — see
 * `components/catalog/SubCategoryRail.tsx`, which supplies the slides and owns
 * everything about what a sub-category *is*. Nothing in this file knows what a
 * category is, which is the same split `ui/apple-cards-carousel.tsx` keeps for
 * the front page's rail and for the same reason: the next thing that wants a
 * deck should not have to fork a catalogue to get one.
 *
 * ---
 *
 * WHERE THIS CAME FROM, AND WHAT HAD TO CHANGE
 *
 * The shape of this is the Aceternity `carousel` component. It arrives written
 * for Next.js and shadcn/ui, and this repository is neither, so the list
 * `ui/apple-cards-carousel.tsx`, `ui/background-gradient.tsx` and
 * `ui/3d-globe.tsx` all keep applies again:
 *
 *   - **No `"use client"`.** There is no React Server Components boundary
 *     here. The directive is inert at best and a lie about the build at worst.
 *   - **`@tabler/icons-react` is `components/icons.tsx`.** One arrow is not a
 *     dependency, and `ArrowRightIcon` is already drawn to match this set.
 *   - **`cn` is `cx`.** `lib/cx.ts` is this project's class joiner; there is
 *     no `clsx`/`tailwind-merge` pair here.
 *   - **Hard-coded hues are tokens.** The original paints the slide
 *     `bg-[#1D1F2F]`, the controls `bg-neutral-200 dark:bg-neutral-800` and
 *     the button `bg-white text-black`. This app themes from CSS custom
 *     properties, and a component that ignored them would be the one row of
 *     the page that did not follow the operator's palette.
 *
 * And five things that were wrong rather than merely foreign:
 *
 *   - **The parallax loop does not run forever.** The original starts a
 *     `requestAnimationFrame` loop per slide on mount and never stops it: it
 *     writes `--x` and `--y` on every frame of the page's life, for every
 *     slide, whether a pointer is anywhere near one or not. Here the two
 *     custom properties are written from the pointer event itself, coalesced
 *     into one frame, and only while a pointer is actually on the slide —
 *     which is exactly the argument `lib/pointer-tilt.ts` already makes for
 *     the product card, and the same argument `ui/background-gradient.tsx`
 *     makes about the drift.
 *   - **`useRef<number>()` does not compile.** React 19's types require an
 *     initial argument. It is `useRef<number | null>(null)` here, which is
 *     also what the rest of this codebase writes.
 *   - **A slide is reachable from a keyboard.** The original puts `onClick`
 *     on a bare `<li>`: no role, no tab stop, nothing a keyboard or a screen
 *     reader can do with it. Here a slide that is not in focus is a real
 *     `<button>` that says which sub-category it would bring forward, and the
 *     action on the slide in focus is a real link. `jsx-a11y` is right about
 *     this and the fix is not a `role` attribute.
 *   - **A slide that is not in focus is out of the tab order.** It is
 *     `invisible` as well as transparent, so a keyboard user tabbing through
 *     the page does not land on a link they cannot see — the same trap
 *     `components/Modal.tsx` documents for a closed dialog.
 *   - **Nothing moves under `prefers-reduced-motion`.** The tip, the
 *     parallax and the slide transition are all switched off together; the
 *     deck still works, it just changes slide instead of gliding. The rule is
 *     in `docs/ACCESSIBILITY.md`.
 *
 * Two deliberate departures of substance:
 *
 *   - **The slide has a ceiling.** The original sizes it `70vmin` square with
 *     none, which on a desktop browser is an eight-hundred-pixel block in the
 *     middle of a catalogue page. The size here is `min(54vmin, 18rem)` — the
 *     same proportion on a phone, where `vmin` is doing useful work, and
 *     capped on a desktop, where it was only ever making the page longer.
 *   - **The track clamps to its own extent.** The original translates it by a
 *     share of its width, which centres the slide in focus always: right in
 *     the middle of a long deck, and wrong at either end, where it leaves half
 *     a viewport of empty page beside the first slide and again beside the
 *     last. Here the offset is measured and clamped, so the deck centres what
 *     you are looking at until it runs out of deck and then stops — which is
 *     what a filmstrip does, and what stops the first slide sitting alone in
 *     the middle of a wide empty band.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRightIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';
import { useI18n } from '@/i18n/i18n-context';

export interface CarouselSlide {
  /** Stable across a re-order, so React keys on it rather than on an index. */
  id: string;
  /** Written across the slide, and what the select button announces. */
  title: string;
  /** The photograph. `null` draws `fallback` instead. */
  src: string | null;
  /** What is drawn when there is no photograph, or when one fails to load. */
  fallback: React.ReactNode;
  /**
   * What the slide in focus offers — a link, in every current caller.
   *
   * Rendered only on the slide in focus, and only that slide's copy is in the
   * tab order. A deck of twenty-six slides each carrying a live link is
   * twenty-six tab stops for one visible choice.
   */
  action: React.ReactNode;
}

/**
 * How far the pointer moves the photograph, as a divisor.
 *
 * The photograph is drawn 120% of the slide and shifted by a thirtieth of the
 * pointer's offset from the centre, so it can slide inside the frame without
 * ever showing an edge. Thirty is the original's number and it is a good one:
 * at a fifteenth the picture visibly swims, at sixty nothing happens.
 */
const PARALLAX_DIVISOR = 30;

/**
 * How much sideways travel moves the deck on by one slide.
 *
 * About a short flick of a trackpad. Lower and one flick skips two shelves;
 * much higher and the deck feels stuck to the gesture.
 */
const WHEEL_STEP = 55;

/** A wheel event this long after the last one starts a new gesture. */
const WHEEL_GESTURE_GAP_MS = 220;

function Slide({
  slide,
  index,
  current,
  onSelect,
}: {
  slide: CarouselSlide;
  index: number;
  current: number;
  onSelect: (index: number) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const reduced = usePrefersReducedMotion();
  const [failed, setFailed] = useState(false);

  const slideRef = useRef<HTMLLIElement>(null);
  /** The slide's box, measured once when the pointer arrives. */
  const box = useRef<DOMRect | null>(null);
  /** The pending pointer position, in client coordinates. */
  const pending = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);

  const isCurrent = current === index;

  const apply = useCallback(() => {
    frame.current = null;

    const element = slideRef.current;
    const rect = box.current;
    const point = pending.current;
    if (element === null || rect === null || point === null) return;
    // A zero-sized box is jsdom, or a slide unmounted mid-frame.
    if (rect.width === 0 || rect.height === 0) return;

    element.style.setProperty('--x', `${String(Math.round(point.x - (rect.left + rect.width / 2)))}px`);
    element.style.setProperty('--y', `${String(Math.round(point.y - (rect.top + rect.height / 2)))}px`);
  }, []);

  const schedule = useCallback(
    (event: React.PointerEvent<HTMLLIElement>) => {
      pending.current = { x: event.clientX, y: event.clientY };
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(apply);
    },
    [apply],
  );

  const onPointerEnter = (event: React.PointerEvent<HTMLLIElement>): void => {
    // A finger has no hover: the parallax would fire once as a tap landed and
    // stay put until the next one somewhere else. Same rule as `useTilt`.
    if (event.pointerType !== 'mouse' || reduced) return;
    box.current = slideRef.current?.getBoundingClientRect() ?? null;
    schedule(event);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLLIElement>): void => {
    if (box.current === null) return;
    schedule(event);
  };

  const onPointerLeave = (): void => {
    box.current = null;
    pending.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    slideRef.current?.style.removeProperty('--x');
    slideRef.current?.style.removeProperty('--y');
  };

  // The frame is cancelled on unmount as well as on leave: a slide taken off
  // the page between a move and its frame would otherwise write to a node that
  // is no longer in the document.
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const showPhotograph = slide.src !== null && !failed;

  return (
    <li
      ref={slideRef}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className={cx(
        'group/slide relative mx-[var(--carousel-gap)] flex h-[var(--carousel-size)] w-[var(--carousel-size)]',
        'flex-col items-center justify-end overflow-hidden rounded-xl text-center',
        '[perspective:1200px] [transform-style:preserve-3d]',
        // The lean is a pair of custom properties rather than an inline
        // `transform`, and that is what lets `:hover` change it. An inline
        // style wins against every class, so a `hover:scale-*` on a slide
        // carrying one is a rule that silently never applies.
        !reduced && '[transform:scale(var(--slide-scale))_rotateX(var(--slide-tip))]',
        // The highlight. A slide behind the one in focus comes half way
        // forward under the pointer, so it reads as reachable before it is
        // pressed — which is the whole job of a hover state on a control that
        // does not look like a control.
        !reduced && !isCurrent && 'hover:[--slide-scale:0.99] hover:[--slide-tip:3deg]',
        // The rim, which is the part that survives reduced motion: a ring
        // appearing under the pointer is not movement, so it is the honest
        // answer for somebody who has asked for less of it.
        !isCurrent && 'hover:ring-2 hover:ring-inset hover:ring-white/45',
      )}
      style={
        reduced
          ? undefined
          : ({
              '--slide-scale': isCurrent ? '1' : '0.96',
              '--slide-tip': isCurrent ? '0deg' : '8deg',
              transformOrigin: 'bottom',
              transition: 'transform var(--dur-slow, 500ms) var(--ease-ui)',
            } as React.CSSProperties)
      }
    >
      {/* The picture, and the plate it falls back to. Both sit under
          everything else and neither takes a press: the select button and the
          action are what this slide can do. */}
      <span
        aria-hidden="true"
        className="absolute inset-0 overflow-hidden rounded-xl bg-navy"
        style={
          isCurrent && !reduced
            ? {
                transform: `translate3d(calc(var(--x, 0px) / ${String(PARALLAX_DIVISOR)}), calc(var(--y, 0px) / ${String(PARALLAX_DIVISOR)}), 0)`,
                transition: 'transform var(--dur-fast) linear',
              }
            : undefined
        }
      >
        {showPhotograph ? (
          <img
            src={slide.src ?? ''}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => {
              setFailed(true);
            }}
            className={cx(
              // 120% and centred, so the parallax shift never exposes an edge.
              'absolute left-1/2 top-1/2 h-[120%] w-[120%] -translate-x-1/2 -translate-y-1/2 object-cover',
              'transition-opacity duration-500',
              // The other half of the highlight: the picture comes up from
              // half-dimmed to nearly lit, so the slide under the pointer is
              // the one you are looking at even before it is pressed.
              isCurrent ? 'opacity-100' : 'opacity-50 group-hover/slide:opacity-90',
            )}
          />
        ) : (
          slide.fallback
        )}

        {/* The scrim. Only under the slide in focus, because only that slide
            has words on it — a scrim over a dimmed neighbour is two veils on
            one picture. */}
        <span
          className={cx(
            'absolute inset-0 bg-gradient-to-t from-navy/90 via-navy/35 via-55% to-transparent transition-opacity duration-500',
            isCurrent ? 'opacity-100' : 'opacity-0',
          )}
        />
      </span>

      {/* A slide that is not in focus is a button that brings it forward.
          Only rendered when it is not in focus, or it would sit over the
          action on the slide that is. */}
      {!isCurrent && (
        <button
          type="button"
          onClick={() => {
            onSelect(index);
          }}
          className="absolute inset-0 z-[1] cursor-pointer rounded-xl focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
                     focus-visible:ring-offset-surface"
        >
          <span className="sr-only">{t('catalog.showSubCategory', { category: slide.title })}</span>
        </button>
      )}

      {/* The words.

          The title fades with the slide. The action is rendered only on the
          slide in focus, and that is deliberately a condition rather than a
          class: `invisible` takes a link out of the tab order in a browser and
          does nothing at all where there is no CSS, so a deck of twenty-six
          would be twenty-six tab stops for one visible choice in exactly the
          environment nobody checks. Not rendering it cannot be got wrong. */}
      <div
        className={cx(
          // At the foot of the card, where the scrim is darkest and where a
          // reader's eye already is once they have taken in the photograph.
          'relative z-[2] w-full px-4 pb-5 transition-opacity duration-500',
          isCurrent ? 'visible opacity-100' : 'invisible opacity-0',
        )}
      >
        <h3 className="text-title text-white drop-shadow-[0_1px_8px_rgb(0_0_0/0.45)] md:text-title-lg">
          {slide.title}
        </h3>
        {isCurrent && <div className="mt-4 flex justify-center">{slide.action}</div>}
      </div>
    </li>
  );
}

function Control({
  direction,
  label,
  onClick,
}: {
  direction: 'previous' | 'next';
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cx(
        'flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-ink-muted',
        'shadow-card transition hover:-translate-y-0.5 hover:border-border-hover hover:text-brand',
        'active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        direction === 'previous' && 'rotate-180',
      )}
    >
      <ArrowRightIcon className="h-5 w-5" />
    </button>
  );
}

export function Carousel({
  slides,
  label,
}: {
  slides: CarouselSlide[];
  /** Names the deck for a screen reader — "Inside Medical Devices". */
  label: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const reduced = usePrefersReducedMotion();
  const [current, setCurrent] = useState(0);
  const headingId = useId();

  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLUListElement>(null);

  /**
   * How far the track is pushed left, in pixels.
   *
   * Measured rather than computed as a share of the track, and that is the
   * whole point of this block. A share puts the slide in focus in the middle
   * of the viewport always — which is right in the middle of a long deck and
   * wrong at either end, where it leaves half a viewport of empty page beside
   * the first slide and the same beside the last. Clamping to the track's own
   * extent is what a filmstrip does: it centres what you are looking at until
   * it runs out of deck, and then it stops.
   */
  const [offset, setOffset] = useState(0);

  const place = useCallback(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (viewport === null || track === null) return;

    const visible = viewport.clientWidth;
    const total = track.scrollWidth;
    if (visible === 0 || total === 0) return;

    // Every slide is the same width, so one slide's pitch is the track over
    // the count. Reading it back beats writing the number down: the size is a
    // `vmin` expression and the gap is a Tailwind class, and both change with
    // the viewport.
    const pitch = total / slides.length;
    const centred = current * pitch + pitch / 2 - visible / 2;

    setOffset(total <= visible ? 0 : Math.max(0, Math.min(centred, total - visible)));
  }, [current, slides.length]);

  useLayoutEffect(place, [place]);

  useEffect(() => {
    if (typeof ResizeObserver !== 'function') return;

    const observer = new ResizeObserver(place);
    if (viewportRef.current !== null) observer.observe(viewportRef.current);
    return () => {
      observer.disconnect();
    };
  }, [place]);

  /**
   * The slide the wheel is working against.
   *
   * A ref beside the state, so the wheel listener is attached once for the
   * life of the deck rather than torn down and rebuilt on every step — which
   * would throw away the accumulator mid-gesture and make a slow wheel do
   * nothing at all.
   */
  const currentRef = useRef(0);
  currentRef.current = current;

  /*
   * A SIDEWAYS gesture moves the deck. A vertical one never does.
   *
   * The department strip converts a vertical wheel into a sideways step,
   * because it is 72px tall and a mouse has no other way to reach the far end
   * of it. The deck must not do the same, and the difference is its size: it
   * is 288px tall and spans the column, so the cursor is over it for most of
   * the way down the page. Converting there meant that scrolling the page past
   * the deck silently changed which shelf was in focus — which reads as a
   * component moving on its own while you are trying to get past it.
   *
   * So the test is the AXIS of the gesture, not the timing of it. An earlier
   * version took vertical ticks once the pointer had rested for a fifth of a
   * second, on the theory that a settled pointer meant intent. It does not: a
   * reader who pauses over a photograph and then carries on scrolling has
   * settled by that definition, and the deck moved under them anyway.
   *
   * A sideways gesture cannot be mistaken for anything else. Nothing on this
   * page scrolls horizontally, so a visitor making one over the deck means the
   * deck and nothing but the deck. A mouse with only a vertical wheel reaches
   * it through the arrows, which is what they are for.
   *
   * Two details carried over. It hands the gesture back at both ends, so
   * nothing above it can be left unable to scroll. And it accumulates rather
   * than stepping per event: one flick of a trackpad is dozens of events, and
   * a shelf each would cross the whole department.
   *
   * A native listener, not `onWheel`: React attaches wheel handlers passively
   * at the root, and `preventDefault` in a passive listener does nothing.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null || slides.length < 2) return;

    let lastWheelAt = 0;
    let travelled = 0;

    const onWheel = (event: WheelEvent): void => {
      /*
       * Sideways, or shift-and-wheel, which is the long-standing convention
       * for "I mean horizontally" on hardware that cannot express it. Both are
       * deliberate. A plain vertical delta is the page being scrolled, and it
       * is left entirely alone.
       */
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!sideways && !event.shiftKey) return;

      const delta = sideways ? event.deltaX : event.deltaY;
      if (delta === 0) return;

      const newGesture = event.timeStamp - lastWheelAt > WHEEL_GESTURE_GAP_MS;
      lastWheelAt = event.timeStamp;
      if (newGesture) travelled = 0;

      // At the far end, so is the deck: hand the gesture back.
      const index = currentRef.current;
      if (delta < 0 && index === 0) return;
      if (delta > 0 && index === slides.length - 1) return;

      event.preventDefault();

      travelled += delta;
      if (Math.abs(travelled) < WHEEL_STEP) return;

      const direction = travelled > 0 ? 1 : -1;
      travelled = 0;
      setCurrent((at) => Math.min(slides.length - 1, Math.max(0, at + direction)));
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      viewport.removeEventListener('wheel', onWheel);
    };
  }, [slides.length]);

  /*
   * A different deck opens at its first card.
   *
   * `CatalogPage` stays mounted as a shopper moves between departments, so
   * this component is re-rendered with new slides rather than remounted, and
   * without this it keeps whatever index it was left on. Stepping to the fifth
   * shelf of Medical Devices and then pressing Tools & Hardware opened that
   * department at 5 of 5 — the last card, clamped hard against the right-hand
   * edge, which reads as a department opening at its end.
   *
   * Clamping the index into range was the previous answer and it only hid the
   * half of the fault that crashed: a deck of twenty-six left at nine and
   * handed a deck of thirty still opens nine shelves in.
   *
   * The signature is the count and the first card's id rather than every id.
   * It is O(1) per render, it changes for any department a shopper can
   * actually move to, and it deliberately does NOT change when the same deck
   * is re-rendered — a background refetch of the category tree must not throw
   * away the shelf somebody is reading.
   */
  const deckId = `${String(slides.length)}:${slides[0]?.id ?? ''}`;

  useEffect(() => {
    setCurrent(0);
  }, [deckId]);

  if (slides.length === 0) return null;

  const step = (delta: number): void => {
    setCurrent((index) => (index + delta + slides.length) % slides.length);
  };

  return (
    /*
     * The viewport clips, the track slides inside it.
     *
     * The track is as wide as every slide laid end to end — twenty-six of them
     * is some forty feet of it — so something has to clip it, or it simply
     * widens the document and the whole page grows a horizontal scrollbar.
     * Clipping at one slide's width would cut the neighbours off at the edge
     * of the slide in focus, and those neighbours *are* the deck. So the clip
     * is the full width of the page's column, and the track moves within it.
     *
     * A deck shorter than its viewport is centred instead — `justify-center`
     * with an offset pinned at zero — so three shelves sit in the middle of
     * the page rather than hard against its left edge.
     */
    <div
      aria-labelledby={headingId}
      role="group"
      ref={viewportRef}
      className="relative w-full overflow-hidden
                 [--carousel-gap:min(3vmin,1rem)] [--carousel-size:min(54vmin,18rem)]"
    >
      <p id={headingId} className="sr-only">
        {label}
      </p>

      <ul
        ref={trackRef}
        className={cx(
          'mx-auto flex w-max',
          !reduced && 'transition-transform duration-700 ease-ui',
        )}
        style={{ transform: `translateX(-${String(Math.round(offset))}px)` }}
      >
        {slides.map((slide, index) => (
          <Slide
            key={slide.id}
            slide={slide}
            index={index}
            current={current}
            onSelect={setCurrent}
          />
        ))}
      </ul>

      {/* Below the deck rather than over it, and in normal flow rather than
          positioned: an arrow floating on the photograph sits on top of the
          title on a phone, and one positioned under an absolutely-sized box
          leaves the caller to guess how much room to leave for it. */}
      <div className="mt-4 flex w-full items-center justify-center gap-3">
        <Control
          direction="previous"
          label={t('carousel.previous')}
          onClick={() => {
            step(-1);
          }}
        />
        <p className="min-w-16 text-center text-xs tabular-nums text-ink-muted" aria-hidden="true">
          {current + 1} / {slides.length}
        </p>
        <Control
          direction="next"
          label={t('carousel.next')}
          onClick={() => {
            step(1);
          }}
        />
      </div>
    </div>
  );
}
