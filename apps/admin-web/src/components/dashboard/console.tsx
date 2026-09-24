/**
 * The dashboard's surfaces.
 *
 * A small set of primitives that every role dashboard is assembled from: the
 * ground with its technical backdrop, the frosted card, the bento lattice the
 * cards sit in, and the section heading. Everything visual lives here, so a
 * dashboard page is a list of what it shows rather than a list of class
 * attributes.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web and
 * apps/logistics-web, on the same reasoning as ui.tsx and tailwind.config.js
 * before it: a buyer, an operator and a carrier are looking at one product,
 * and a card that is frosted on one screen and flat on the next reads as two.
 * The repository has no shared package and introducing one would touch every
 * build config in it; parallel copies with this note is the house convention.
 *
 * Nothing here takes a translation key. Every string is passed in already
 * translated, which is what lets the three copies stay identical — the three
 * apps have three different `TranslationKey` unions.
 *
 * ---
 *
 * WHAT THE DECORATION IS ALLOWED TO DO
 *
 * Take the backdrop, the blooms, the spotlight and the hover lift away and
 * every one of these screens still says exactly what it said. That is the test
 * each of them had to pass to be here. None of them carries a value, a status
 * or a state; all of them are `aria-hidden` and none is in the tab order.
 *
 * And nothing moves on its own. There is no drifting gradient and no pulse:
 * motion happens in response to a pointer, a focus, or data arriving, and then
 * it stops. These are screens people leave open on a wall.
 */
import { useCallback, useRef, type ReactNode } from 'react';
import { cx } from '@/lib/cx';

// ---------------------------------------------------------------------------
// The ground
// ---------------------------------------------------------------------------

/**
 * The dashboard page ground, with the dot field and the two blooms.
 *
 * `relative`, because the backdrop is an absolutely-positioned child; the
 * content sits above it in its own stacking context rather than relying on
 * source order.
 *
 * The backdrop is one element with four stacked gradients, not four elements.
 * It never participates in layout, so it costs one composited layer and no
 * reflow — which matters on the tablet in a warehouse, where this screen is
 * open all day.
 */
export function ConsoleGround({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    // The bleed must cancel the shell's own padding at every width, or the
    // ground pokes past the screen: it used `sm:-mx-6` while the shell only
    // pads 24px from `lg`, which pushed every dashboard 8px wide between
    // 640 and 1024px (a tablet).
    <div
      className={cx(
        'console-ground relative isolate -mx-4 -my-6 px-4 py-6 lg:-mx-6 lg:-my-8 lg:px-6 lg:py-8',
        className,
      )}
    >
      <div className="console-backdrop" aria-hidden="true" />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface ConsoleCardProps {
  /** The heading. Omitted for a card whose content is its own title. */
  title?: string | undefined;
  /** One line under the heading. */
  description?: string | undefined;
  /** Buttons, a filter, a link to the full screen. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
  /** Convenience for the common padded body. Omit for a flush table. */
  bodyClassName?: string | undefined;
  /**
   * Whether the card responds to a pointer.
   *
   * A card that only displays a figure must NOT set this. A lift and a
   * spotlight on something you cannot click is a promise the screen does not
   * keep, and a reader who has tried once stops trusting the ones that do.
   */
  interactive?: boolean | undefined;
  /** The heading's id, so a caller can wire `aria-labelledby` to it. */
  headingId?: string | undefined;
  /**
   * Announced politely when the card's figures change under a background
   * refresh. Off by default: a dashboard of twelve live regions talking over
   * each other is worse than silence.
   */
  live?: boolean | undefined;
}

/**
 * A frosted dashboard card.
 *
 * The spotlight follows the pointer by writing two custom properties on the
 * element and letting CSS draw the gradient. Done this way rather than with a
 * state update per mouse move, because a state update per mouse move is a
 * React render per mouse move across a grid of a dozen cards, and that is
 * measurable on a mid-range tablet.
 *
 * The spotlight is deliberately NOT shown on keyboard focus. A focus ring
 * already says where the keyboard is; a second, softer, differently-shaped
 * indicator beside it makes the real one harder to find rather than easier.
 */
export function ConsoleCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  interactive = false,
  headingId,
  live = false,
}: ConsoleCardProps): React.JSX.Element {
  const host = useRef<HTMLElement | null>(null);

  const trackPointer = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const element = host.current;
    if (element === null) return;

    // `getBoundingClientRect` per move is a read, and reads are cheap as long
    // as nothing above has written to layout in the same frame. Nothing here
    // does: the only writes are two custom properties, which the compositor
    // picks up without laying anything out.
    const box = element.getBoundingClientRect();
    element.style.setProperty('--spot-x', `${String(event.clientX - box.left)}px`);
    element.style.setProperty('--spot-y', `${String(event.clientY - box.top)}px`);
  }, []);

  return (
    <section
      ref={host}
      onPointerMove={interactive ? trackPointer : undefined}
      className={cx('console-card', interactive && 'console-card-interactive', className)}
      {...(live ? { 'aria-live': 'polite' as const, 'aria-atomic': false } : {})}
    >
      {interactive ? <span className="console-spotlight" aria-hidden="true" /> : null}

      {title === undefined && actions === undefined ? null : (
        <header className="relative flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-console-border/70 px-5 py-4">
          <div className="min-w-0">
            {title === undefined ? null : (
              <h3 id={headingId} className="text-title-xs text-ink">
                {title}
              </h3>
            )}
            {description === undefined ? null : (
              <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-ink-muted">
                {description}
              </p>
            )}
          </div>
          {actions === undefined ? null : (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          )}
        </header>
      )}

      <div className={cx('relative', bodyClassName)}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The lattice
// ---------------------------------------------------------------------------

/**
 * How wide a bento cell is, on a wide screen.
 *
 * Written out rather than computed, because Tailwind reads these files as
 * text: a `lg:col-span-${n}` built at runtime compiles to no CSS at all. This
 * has bitten this repository before — see the note on `BAND_COLUMNS` in the
 * logistics dashboard.
 */
const SPAN: Record<number, string> = {
  1: 'lg:col-span-1',
  2: 'lg:col-span-2',
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
  6: 'lg:col-span-6',
};

const SPAN_MD: Record<number, string> = {
  1: 'md:col-span-1',
  2: 'md:col-span-2',
  3: 'md:col-span-3',
};

/**
 * The bento grid.
 *
 * Six columns on a wide screen, three on a tablet, one on a phone. Six rather
 * than twelve because every cell here is at least a quarter of the width — a
 * twelve-column lattice would only offer sizes nothing uses, and every unused
 * step is one more way for two cards to end up a column apart for no reason.
 *
 * `items-start`, so a cell is the height of what it holds. Stretched, a short
 * card beside a long activity feed becomes a tall empty box with one line of
 * text adrift in the middle of it.
 */
export function BentoGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <div className={cx('grid items-start gap-4 md:grid-cols-3 lg:grid-cols-6', className)}>
      {children}
    </div>
  );
}

/**
 * One cell.
 *
 * `min-w-0` is not cosmetic. A grid item defaults to `min-width: auto`, which
 * means it refuses to shrink below its content — so one long tracking number
 * in a table inside a cell pushes the whole lattice wider than the viewport
 * and the page scrolls sideways on a phone. This is the fix, and it is why
 * "no horizontal overflow" is a property of the grid rather than of each card.
 */
export function BentoCell({
  span = 2,
  spanMd,
  children,
  className,
}: {
  /** Columns on a wide screen, out of six. */
  span?: 1 | 2 | 3 | 4 | 6;
  /** Columns on a tablet, out of three. Defaults to sensible from `span`. */
  spanMd?: 1 | 2 | 3;
  children: ReactNode;
  className?: string | undefined;
}): React.JSX.Element {
  const tablet = spanMd ?? (span >= 4 ? 3 : span === 3 ? 3 : 1);

  return (
    <div className={cx('min-w-0', SPAN_MD[tablet], SPAN[span], className)}>{children}</div>
  );
}

// ---------------------------------------------------------------------------
// The page heading
// ---------------------------------------------------------------------------

/**
 * The dashboard's own header: who it is for, when it was measured, and the
 * controls that change both.
 *
 * `lastUpdated` is rendered as a `<time>` with a machine-readable `dateTime`,
 * because "2 minutes ago" is the useful form for a person and useless for
 * anything else reading the page.
 */
export function ConsoleHeader({
  title,
  subtitle,
  lastUpdatedLabel,
  lastUpdatedAt,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  /** Already-formatted, e.g. "Updated 2 minutes ago". */
  lastUpdatedLabel?: string | undefined;
  lastUpdatedAt?: string | null | undefined;
  /** The range tabs, the refresh button, any filters. */
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h1 className="text-title-lg text-ink">{title}</h1>
        {subtitle === undefined ? null : (
          <p className="mt-1 max-w-prose text-sm text-ink-muted">{subtitle}</p>
        )}
        {lastUpdatedLabel === undefined ? null : (
          <p className="mt-2 text-xxs text-ink-subtle">
            {lastUpdatedAt === undefined || lastUpdatedAt === null ? (
              lastUpdatedLabel
            ) : (
              <time dateTime={lastUpdatedAt}>{lastUpdatedLabel}</time>
            )}
          </p>
        )}
      </div>

      {children === undefined ? null : (
        // `min-w-0 max-w-full`: a flex item is otherwise as wide as its content,
        // and the range switch inside is built to scroll sideways - which it
        // cannot do if its row grows to fit it. At 320px that row pushed the
        // whole dashboard 35px past the screen.
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{children}</div>
      )}
    </header>
  );
}
