/**
 * A grid of summary tiles where a soft highlight follows the pointer.
 *
 * The interaction is the "card hover effect" pattern: one highlight plate,
 * shared between every tile by a layout id, glides to whichever tile is under
 * the pointer or holds keyboard focus. It says "this is the one you are about
 * to open" without the grid jumping about - the tiles themselves only lift by
 * a shadow step.
 *
 * Built on `motion`, which this app already ships; no component library was
 * added for it. With reduced motion asked for, the plate is not animated
 * between tiles and the entrance stagger is skipped - each tile simply shows
 * its hover state in place.
 *
 * Each tile is a real button, so the grid is a list of things to open for a
 * keyboard or a screen reader too, not a set of decorated divs.
 */
import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';

export interface HoverCard {
  key: string;
  title: string;
  /** The figure or short status this tile is about. */
  value: ReactNode;
  detail?: ReactNode;
  /** A coloured edge for a tile that needs attention. */
  tone?: 'default' | 'warning' | 'success';
  onOpen: () => void;
  /** What a screen reader hears for the button, beyond the title. */
  openLabel: string;
}

const container = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.045 } },
};

const item = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const } },
};

export function HoverCardGrid({
  cards,
  idPrefix,
}: {
  cards: readonly HoverCard[];
  idPrefix: string;
}): React.JSX.Element {
  const reduced = usePrefersReducedMotion();
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <motion.ul
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      variants={container}
      initial={reduced ? false : 'hidden'}
      animate="shown"
    >
      {cards.map((card) => (
        <motion.li key={card.key} {...(reduced ? {} : { variants: item })} className="relative">
          <button
            type="button"
            aria-label={card.openLabel}
            onClick={card.onOpen}
            onMouseEnter={() => {
              setHovered(card.key);
            }}
            onMouseLeave={() => {
              setHovered(null);
            }}
            onFocus={() => {
              setHovered(card.key);
            }}
            onBlur={() => {
              setHovered(null);
            }}
            className="group relative block h-full w-full rounded-xl p-1.5 text-left focus-visible:outline-none"
          >
            <AnimatePresence>
              {hovered === card.key ? (
                <motion.span
                  aria-hidden="true"
                  className="absolute inset-0 block rounded-xl bg-brand-soft ring-1 ring-brand/20"
                  {...(reduced
                    ? {}
                    : {
                        layoutId: `${idPrefix}-hover-plate`,
                        initial: { opacity: 0 },
                        animate: { opacity: 1, transition: { duration: 0.15 } },
                        exit: { opacity: 0, transition: { duration: 0.15, delay: 0.1 } },
                      })}
                />
              ) : null}
            </AnimatePresence>

            <span
              className={cx(
                'relative z-10 flex h-full flex-col gap-1 rounded-lg border bg-surface px-4 py-3.5 shadow-card',
                'transition-[box-shadow,border-color] group-hover:shadow-card-hover',
                'group-focus-visible:ring-2 group-focus-visible:ring-brand',
                card.tone === 'warning'
                  ? 'border-warning/40'
                  : card.tone === 'success'
                    ? 'border-success/30'
                    : 'border-border',
              )}
            >
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
                {card.title}
              </span>
              <span className="text-base font-semibold text-ink">{card.value}</span>
              {card.detail === undefined ? null : (
                <span className="text-xs leading-relaxed text-ink-muted">{card.detail}</span>
              )}
            </span>
          </button>
        </motion.li>
      ))}
    </motion.ul>
  );
}
