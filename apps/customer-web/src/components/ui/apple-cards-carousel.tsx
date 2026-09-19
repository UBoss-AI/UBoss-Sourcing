/**
 * A rail of cards you scroll sideways, each of which opens into a panel.
 *
 * One card is a photograph with a name written across the top of it. Press it
 * and the card's subject opens as a dialog in front of the page; close it and
 * the rail scrolls the card you were reading back under your cursor, so you
 * carry on from where you were rather than from where the track happened to
 * stop.
 *
 * It is on the front page carrying the departments — see
 * `components/catalog/CategoryCarousel.tsx`, which supplies the cards and owns
 * everything about what a department *is*. Nothing in this file knows what a
 * category is, which is the point: it is a rail, and the next thing that wants
 * one should not have to fork it.
 *
 * ---
 *
 * WHERE THIS CAME FROM, AND WHAT HAD TO CHANGE
 *
 * The shape of this is the Aceternity `apple-cards-carousel` component. It
 * arrives written for Next.js and shadcn/ui, and this repository is neither,
 * so the same list `ui/flip-words.tsx`, `ui/background-gradient.tsx` and
 * `ui/3d-globe.tsx` keep applies again, with a few entries of its own.
 *
 *   - **`cn` is `cx`.** This project's class joiner is `lib/cx.ts`. There is no
 *     `clsx`/`tailwind-merge` pair here and adding one for one function would
 *     be two dependencies for it.
 *   - **`next/image` is an `<img>`.** There is no Next.js here and no image
 *     optimiser behind it. The original's `BlurImage` also spreads `fill` and
 *     `blurDataURL` — both `next/image` props — straight onto a DOM `<img>`,
 *     which React warns about on every render. What survives is the part worth
 *     having: the picture fades in from blurred when it loads.
 *   - **`@tabler/icons-react` is `components/icons.tsx`.** Three icons is not
 *     a dependency. `ArrowLeftIcon` and `ArrowRightIcon` were added there for
 *     this, drawn to match the set rather than imported to match the original.
 *   - **`dark:` variants are tokens.** This app themes with CSS custom
 *     properties — `surface`, `ink`, `navy`, `border` — and a component
 *     hard-coding `bg-neutral-900 dark:bg-white` would be the only thing on the
 *     page not following the operator's theme. See `index.css`.
 *
 * And five things that were wrong rather than merely foreign:
 *
 *   - **The panel is a real `<dialog>`.** The original builds it from a fixed
 *     `div`, which means no focus trap, no inertness for a screen reader, and
 *     an Escape handler bound to `window` by every card on the page whether it
 *     is open or not. `showModal()` gives all three for free and returns focus
 *     to the card on the way out. `components/Modal.tsx` carries the longer
 *     argument, and the `[&:not([open])]:hidden` below is the trap it
 *     documents.
 *   - **The close scroll is measured, not guessed.** The original computes
 *     where to scroll back to from `(cardWidth + gap) * (index + 1)`, with the
 *     width and the gap written down as numbers — 230/384 and 4/8, when the
 *     rail's own `gap-4` is 16px. So it lands near the right card at one
 *     breakpoint and somewhere else at every other. Here the card scrolls
 *     *itself* back into view, which cannot disagree with the layout.
 *   - **The right-hand fade renders.** The original's is `bg-gradient-to-l`
 *     with no colour stops on an absolutely positioned empty div: it paints
 *     nothing at all. Both edges fade here, from the page's own surface, and
 *     both are `pointer-events-none` so the card under them is still
 *     pressable.
 *   - **The buttons tell the truth on arrival.** `canScrollRight` starts
 *     `true` in the original, so a rail whose cards all fit offers a live Next
 *     button that does nothing. Both are computed from the track on mount and
 *     recomputed when it resizes.
 *   - **The stagger is capped.** The original delays card *n* by `0.2 * n`
 *     seconds with no viewport gate, so a catalogue with twenty-five
 *     departments fades its last card in five seconds after the page settles —
 *     and does it off screen, where nobody sees the effect and everybody pays
 *     for it. Capped at eight cards' worth here, and switched off entirely
 *     under `prefers-reduced-motion` along with the panel fade and the smooth
 *     scrolling. `docs/ACCESSIBILITY.md` has the rule.
 *
 * One thing was deliberately not carried over: the original dismisses the
 * panel from a `useOutsideClick` hook watching `mousedown` and `touchstart` on
 * the whole document. This one closes on Escape and on its close button, which
 * is what every other dialog in this app does — `components/Modal.tsx` has no
 * click-outside either, and a storefront where one dialog vanishes on a stray
 * click and the next does not is a storefront that has taught nobody anything.
 * Dismissing on a press of the backdrop was tried and dropped: a click handler
 * on the `<dialog>` is the only way to catch it, and `jsx-a11y` is right that
 * a click handler with no keyboard equivalent on a non-interactive element is
 * a trap — the keyboard equivalent here is Escape, which is already wired.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeftIcon, ArrowRightIcon, CloseIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';
import { useI18n } from '@/i18n/i18n-context';

export interface CarouselCard {
  /** Stable across a re-order, so React keys on it rather than on an index. */
  id: string;
  /** The small line above the title. */
  eyebrow: string;
  title: string;
  /** The line along the bottom of the card, or nothing. */
  meta: string | null;
  /** The cover photograph. `null` draws `fallback` instead. */
  src: string | null;
  /** What is drawn when there is no photograph, or when one fails to load. */
  fallback: React.ReactNode;
  /**
   * The body of the panel the card opens into.
   *
   * A function rather than a node, and `close` is why. The panel is a modal
   * dialog and the useful thing to put in one of these is a link — press it
   * and the page behind the panel changes while the panel stays sitting on top
   * of it, which reads as a page that failed to navigate. Anything in here
   * that leaves the page calls `close` on its way out.
   */
  content: (close: () => void) => React.ReactNode;
}

/**
 * How far one press of an arrow moves the track.
 *
 * Measured off a card rather than written down: the card is one width on a
 * phone and another from `md`, and the gap between them is a Tailwind class
 * somebody will eventually change. `clientWidth` is the answer for the frame
 * before there is a card to measure, and in jsdom, where every box is 0x0.
 */
function scrollStep(track: HTMLDivElement): number {
  const card = track.querySelector<HTMLElement>('[data-carousel-card]');
  if (card === null) return track.clientWidth;

  const row = card.parentElement ?? card;
  const gap = Number.parseFloat(window.getComputedStyle(row).columnGap);

  return card.offsetWidth + (Number.isNaN(gap) ? 0 : gap);
}

export function Carousel({ cards }: { cards: CarouselCard[] }): React.JSX.Element {
  const { t } = useI18n();
  const reduced = usePrefersReducedMotion();

  const trackRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  /*
   * A pixel of slack at each end.
   *
   * A track whose width is fractional never reaches `scrollWidth -
   * clientWidth` exactly, so the Next button would stay enabled at the end of
   * the rail forever — and a button that is lit and does nothing is worse than
   * one that is plainly spent.
   */
  const measure = useCallback(() => {
    const track = trackRef.current;
    if (track === null) return;

    setCanScrollLeft(track.scrollLeft > 1);
    setCanScrollRight(track.scrollLeft < track.scrollWidth - track.clientWidth - 1);
  }, []);

  useEffect(() => {
    measure();

    const track = trackRef.current;
    if (track === null) return undefined;

    // The rail's answer changes when the window does — a phone turned
    // sideways fits cards that did not fit a moment ago.
    const observer = new ResizeObserver(measure);
    observer.observe(track);

    return () => {
      observer.disconnect();
    };
  }, [measure, cards.length]);

  const scrollRail = useCallback(
    (direction: -1 | 1) => {
      const track = trackRef.current;
      if (track === null) return;

      track.scrollBy({
        left: direction * scrollStep(track),
        behavior: reduced ? 'auto' : 'smooth',
      });
    },
    [reduced],
  );

  return (
    <div className="relative">
      {/* The fades are the page's own surface, so the rail reads as running
          under the edges of the column rather than stopping at them. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 z-20 w-6 bg-gradient-to-r from-surface to-transparent sm:w-10"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-20 w-6 bg-gradient-to-l from-surface to-transparent sm:w-10"
      />

      {/*
       * `overscroll-x-contain` so a swipe past the last card is not handed to
       * the browser as a back navigation, and `py-2` so the focus ring on a
       * card is not clipped by the scroll port.
       */}
      <div
        ref={trackRef}
        onScroll={measure}
        className="hide-scrollbar flex overflow-x-auto overscroll-x-contain py-2"
      >
        <div className="flex flex-row gap-4 px-1">
          {cards.map((card, index) => (
            <motion.div
              key={card.id}
              data-carousel-card
              className="shrink-0"
              initial={reduced ? false : { opacity: 0, y: 16 }}
              animate={{
                opacity: 1,
                y: 0,
                transition: {
                  duration: 0.45,
                  // Eight cards' worth at most: past that the rail is off
                  // screen and the delay is only a cost.
                  delay: Math.min(index, 8) * 0.05,
                  ease: 'easeOut',
                },
              }}
            >
              <Card card={card} />
            </motion.div>
          ))}
        </div>
      </div>

      {/* Below the rail rather than floating over it: an arrow on top of a
          card covers the card, and on a phone it covers the one card the rail
          is showing. */}
      <div className="mt-3 flex justify-end gap-2">
        <RailButton
          label={t('carousel.previous')}
          disabled={!canScrollLeft}
          onPress={() => {
            scrollRail(-1);
          }}
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </RailButton>
        <RailButton
          label={t('carousel.next')}
          disabled={!canScrollRight}
          onPress={() => {
            scrollRail(1);
          }}
        >
          <ArrowRightIcon className="h-5 w-5" />
        </RailButton>
      </div>
    </div>
  );
}

function RailButton({
  label,
  onPress,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      disabled={disabled}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-ink-muted shadow-card transition-[color,border-color,box-shadow] hover:border-border-hover hover:text-brand hover:shadow-card-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:border-border disabled:hover:text-ink-muted"
    >
      {children}
    </button>
  );
}

export function Card({ card }: { card: CarouselCard }): React.JSX.Element {
  const { t } = useI18n();
  const reduced = usePrefersReducedMotion();

  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || !open || dialog.open) return;

    dialog.showModal();
  }, [open]);

  /*
   * Escape closes the panel, and the browser is asked to wait.
   *
   * `cancel` is the browser closing the dialog itself without telling React —
   * so it is cancelled, the state changes instead, and the real `close()`
   * happens once the panel has finished fading. Escape, the close button and
   * the backdrop all take that one path.
   */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;

    const onCancel = (event: Event): void => {
      event.preventDefault();
      close();
    };

    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
    };
  }, [close]);

  /*
   * Closed, and the rail put back where the reader left it.
   *
   * The native dialog has already returned focus to the card by the time this
   * runs, so the only thing left is the track: a card opened from halfway
   * along the rail should be under the cursor again when the panel goes, not
   * wherever the rail was when the page loaded. `block: 'nearest'` because
   * this must move the rail sideways and the page not at all.
   */
  /*
   * The card lifts under the cursor, unless it was asked not to.
   *
   * Spread rather than `whileHover={reduced ? undefined : …}` because
   * `exactOptionalPropertyTypes` is on: an optional prop is given a value or
   * it is not written at all, and `undefined` is neither.
   */
  const hoverLift = reduced ? {} : { whileHover: { y: -4 } };

  const finishClose = useCallback(() => {
    dialogRef.current?.close();
    buttonRef.current?.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  }, [reduced]);

  return (
    <>
      <motion.button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
        {...hoverLift}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="group relative flex h-80 w-56 flex-col items-start justify-start overflow-hidden rounded-xl bg-navy text-left shadow-card transition-shadow hover:shadow-card-hover md:h-[30rem] md:w-[21rem]"
      >
        {card.src === null ? card.fallback : <Cover src={card.src} fallback={card.fallback} />}

        {/* Two scrims, not one. The top one is what the name is legible
            against; the bottom one gives the card a base, so it does not read
            as a photograph that ran out. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-1/2 bg-gradient-to-b from-navy/85 via-navy/45 to-transparent"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-1/3 bg-gradient-to-t from-navy/80 to-transparent"
        />

        <span className="relative z-20 flex h-full w-full flex-col justify-between p-5 sm:p-6">
          <span className="block">
            <span className="block text-xxs font-semibold uppercase tracking-[0.18em] text-white/85">
              {card.eyebrow}
            </span>
            <span className="mt-2 block text-title text-white [text-wrap:balance] md:text-title-lg">
              {card.title}
            </span>
          </span>

          {card.meta !== null && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-white/85">
              {card.meta}
              <ArrowRightIcon
                aria-hidden="true"
                className="h-4 w-4 transition-transform group-hover:translate-x-1"
              />
            </span>
          )}
        </span>
      </motion.button>

      {/*
       * `bg-transparent` and `p-0`: the dialog is the frame and the panel
       * inside it is what is drawn, which is what lets the panel animate
       * without the top-layer box flashing in behind it.
       *
       * `[&:not([open])]:hidden` is not redundant. The browser hides a closed
       * dialog with `display: none`, and any `display` this element sets would
       * silently override it — which renders the panel inline in the page. The
       * long version of that is in `components/Modal.tsx`.
       */}
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="w-full max-w-4xl bg-transparent p-0 backdrop:bg-navy/60 backdrop:backdrop-blur-sm [&:not([open])]:hidden"
      >
        <AnimatePresence onExitComplete={finishClose}>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: reduced ? 0 : 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduced ? 0 : 8 }}
              transition={{ duration: reduced ? 0 : 0.22, ease: 'easeOut' }}
              className="relative rounded-xl border border-border bg-surface p-5 text-left shadow-overlay sm:p-8"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xxs font-semibold uppercase tracking-[0.18em] text-brand">
                    {card.eyebrow}
                  </p>
                  <h3 id={titleId} className="mt-2 text-title-lg text-ink sm:text-title-xl">
                    {card.title}
                  </h3>
                </div>

                <button
                  type="button"
                  onClick={close}
                  aria-label={t('modal.close')}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-ink-muted transition-colors hover:border-border-hover hover:text-ink"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              </div>

              <div className="mt-6">{card.content(close)}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </dialog>
    </>
  );
}

/**
 * The photograph, and what happens when there is not one.
 *
 * Three states, and all three are ordinary. It is blurred and transparent
 * until it loads, which is the fade the original was after; it is sharp once
 * it has; and if the request fails it is replaced by the same drawn artwork a
 * department with no photograph gets. A storefront on a network that cannot
 * reach the image CDN loses the pictures and keeps the rail.
 *
 * `alt=""` and `aria-hidden`: the department's name is written across the card
 * in real text directly above this, so a screen reader announcing the picture
 * as well would say the same thing twice.
 */
function Cover({ src, fallback }: { src: string; fallback: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');

  if (state === 'failed') return <>{fallback}</>;

  return (
    <>
      <span aria-hidden="true" className="absolute inset-0 bg-surface-sunken" />
      <img
        src={src}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        onLoad={() => {
          setState('loaded');
        }}
        onError={() => {
          setState('failed');
        }}
        className={cx(
          'absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-105',
          state === 'loaded' ? 'opacity-100 blur-0' : 'opacity-0 blur-sm',
        )}
      />
    </>
  );
}
