/**
 * The department strip: every aisle in the shop, in one line.
 *
 * It sits at the top of `/products` and of every `/category/:slug`, and it is
 * the same strip on both — which is the whole point. A shopper who has read
 * the row once knows where everything is, and moving between departments stops
 * being "go back, find the grid, press the next one" and becomes one press in
 * a row that never moves.
 *
 * WHAT IS ON IT
 *
 * "All products" first, then one item per department the catalogue actually
 * stocks, in the operator's own order. Each item is a mark and a name; the one
 * you are in is underlined and its mark sits on a brand plate. Nothing else —
 * no counts, no chevrons, no badges. A strip is read at a glance across, and
 * every extra glyph in an item is another thing to skip past twenty-five
 * times.
 *
 * WHY THESE ARE LINKS AND NOT TABS
 *
 * They look like tabs and they are not, deliberately. Pressing one goes to
 * `/category/<slug>` — a real page with its own address, its own title, its
 * own place in the history. A tab strip that swapped the grid in place would
 * be a catalogue where a shopper cannot send a colleague the department they
 * are looking at, cannot bookmark it, and loses it on Back. `CatalogPage`'s
 * header says the same thing about filters: the address bar is the state.
 *
 * THE STRIP IS SCROLLED, NOT WRAPPED
 *
 * Twenty-six departments do not fit across a laptop and they never will. A row
 * that wrapped would be four rows deep on a phone, pushing the products under
 * the fold on the page whose job is to show products. So it scrolls sideways,
 * with the scrollbar hidden (`.hide-scrollbar` in `index.css`, which explains
 * why) and a fade at each end that says there is more in that direction.
 *
 * Three ways to move it, because three kinds of pointer reach this page. A
 * finger swipes. A trackpad sends horizontal deltas and they are left alone. A
 * mouse has one wheel pointing the wrong way, so a vertical tick over the row
 * is turned into a horizontal one — and handed back at both ends, so the page
 * still scrolls once the row has nowhere to go. The arrows are for everyone,
 * and they appear only on the side there is more to see.
 *
 * The active item scrolls itself into view on arrival. Landing on a department
 * from a search or a link and finding the strip showing "All products" through
 * to "Electronics", with no sign of where you actually are, is the failure
 * this avoids.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AllProductsIcon } from '@/components/department-icons';
import { ArrowLeftIcon, ArrowRightIcon } from '@/components/icons';
import { departmentMark } from '@/lib/department-mark';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import type { CategoryNode } from '@/lib/types';

/**
 * How far one press of an end arrow moves the track.
 *
 * Most of a screenful, not all of it: a page that scrolls exactly its own
 * width leaves nothing in common between before and after, and the eye has to
 * start again. Leaving one item visible is what makes it read as continuing.
 */
const ARROW_STEP = 0.8;

/** One item in the row: what it shows, and where it goes. */
interface StripItem {
  key: string;
  label: string;
  to: string;
  Mark: (props: { className?: string }) => React.JSX.Element;
}

export function CategoryStrip({
  departments,
  activeSlug,
}: {
  departments: CategoryNode[];
  /**
   * The department being read, or `null` on `/products`.
   *
   * This is the ROOT department, not the category in the address bar: a
   * shopper three levels into Medical Devices is still in Medical Devices, and
   * a strip that lit nothing up because "IV Cannula" is not on it would be
   * telling them they are nowhere. `CatalogPage` resolves the ancestor.
   */
  activeSlug: string | null;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const trackRef = useRef<HTMLUListElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  /** Whether there is anything left to scroll to, in each direction. */
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (track === null) return;

    // A pixel of slack. Sub-pixel layout means `scrollLeft` at the far right
    // is routinely 0.5 short of the maximum, which would leave the arrow lit
    // on a track that cannot move.
    const max = track.scrollWidth - track.clientWidth;
    setOverflow({ left: track.scrollLeft > 1, right: track.scrollLeft < max - 1 });
  }, []);

  /*
   * A mouse wheel scrolls the row sideways.
   *
   * A mouse has one wheel and this row only moves in the other direction, so
   * without this the only way past "Building & Construction" with a mouse is
   * the arrows. A trackpad already sends horizontal deltas, so those are left
   * alone — taking them over would fight the gesture the visitor is making.
   *
   * It hands the scroll back at both ends rather than swallowing it. A strip
   * that ate every wheel tick while the pointer happened to be over it is a
   * page that will not scroll, which is the failure mode of every horizontal
   * rail that does this badly.
   *
   * A native listener, not `onWheel`: React attaches wheel handlers passively
   * at the root, and `preventDefault` in a passive listener does nothing.
   */
  useEffect(() => {
    const track = trackRef.current;
    if (track === null) return;

    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

      const max = track.scrollWidth - track.clientWidth;
      if (max <= 0) return;
      if (event.deltaY < 0 && track.scrollLeft <= 0) return;
      if (event.deltaY > 0 && track.scrollLeft >= max) return;

      event.preventDefault();
      track.scrollLeft = Math.min(max, Math.max(0, track.scrollLeft + event.deltaY));
    };

    track.addEventListener('wheel', onWheel, { passive: false });
    track.addEventListener('scroll', measure, { passive: true });

    // A wider window can turn a scrolling row into one that fits, and the
    // arrows have to stop offering a move that does nothing.
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(track);

    measure();

    return () => {
      track.removeEventListener('wheel', onWheel);
      track.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [measure, departments.length]);

  /*
   * Bring the active item into view, without scrolling the page to it.
   *
   * `scrollIntoView` would scroll every scrollable ancestor, which on arrival
   * at a category page means the window jumps down past the breadcrumb to put
   * a 60px strip in the middle of the screen. This moves the track and nothing
   * else: the item's offset inside the track, less half the track's width, is
   * the position that centres it.
   */
  useEffect(() => {
    const track = trackRef.current;
    const item = activeRef.current;
    if (track === null || item === null) return;
    // jsdom implements no scrolling at all, and a decorative scroll is not
    // worth a polyfill in every test that renders the catalogue.
    if (typeof track.scrollTo !== 'function') return;

    track.scrollTo({
      left: item.offsetLeft - track.clientWidth / 2 + item.clientWidth / 2,
      behavior: 'auto',
    });
    measure();
  }, [activeSlug, measure]);

  if (departments.length === 0) return null;

  const nudge = (direction: -1 | 1): void => {
    const track = trackRef.current;
    if (track === null || typeof track.scrollBy !== 'function') return;

    track.scrollBy({ left: direction * track.clientWidth * ARROW_STEP, behavior: 'smooth' });
  };

  const items: StripItem[] = [
    { key: '', label: t('catalog.allProducts'), to: '/products', Mark: AllProductsIcon },
    ...departments.map((department) => ({
      key: department.slug,
      label: department.name,
      to: `/category/${department.slug}`,
      Mark: departmentMark(department.name, department.slug),
    })),
  ];

  return (
    <nav
      aria-label={t('catalog.departments')}
      className="relative -mx-4 mb-5 border-b border-border bg-surface sm:mx-0 sm:rounded-lg sm:border sm:shadow-card"
    >
      {/* The two fades. `pointer-events-none`, so the item under one is still
          pressable, and `from-surface` so they match whichever theme is on.

          Only drawn on the side there is more to see: a permanent fade at an
          end the row cannot move past is a promise of something that is not
          there. */}
      {overflow.left && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-14 bg-gradient-to-r from-surface via-surface/80 to-transparent sm:rounded-l-lg"
        />
      )}
      {overflow.right && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 z-[1] w-14 bg-gradient-to-l from-surface via-surface/80 to-transparent sm:rounded-r-lg"
        />
      )}

      {/*
       * The arrows, for the pointer that does not want to spin a wheel.
       *
       * `hidden sm:flex`, because a phone has the gesture and does not have
       * the room. They are the only two controls in this row, so they are the
       * only two things in it that are buttons rather than links — a press
       * that moves the view is not a press that goes anywhere.
       */}
      {overflow.left && (
        <button
          type="button"
          aria-label={t('carousel.previous')}
          onClick={() => {
            nudge(-1);
          }}
          className="absolute left-1 top-1/2 z-[2] hidden h-8 w-8 -translate-y-1/2 items-center justify-center
                     rounded-full border border-border bg-surface text-ink-muted shadow-card transition
                     hover:border-border-hover hover:text-brand focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-ring sm:flex"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
      )}
      {overflow.right && (
        <button
          type="button"
          aria-label={t('carousel.next')}
          onClick={() => {
            nudge(1);
          }}
          className="absolute right-1 top-1/2 z-[2] hidden h-8 w-8 -translate-y-1/2 items-center justify-center
                     rounded-full border border-border bg-surface text-ink-muted shadow-card transition
                     hover:border-border-hover hover:text-brand focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-ring sm:flex"
        >
          <ArrowRightIcon className="h-4 w-4" />
        </button>
      )}

      <ul ref={trackRef} className="hide-scrollbar flex items-stretch overflow-x-auto px-2">
        {items.map((item) => {
          const isActive = (activeSlug ?? '') === item.key;

          return (
            <li key={item.key} ref={isActive ? activeRef : null} className="shrink-0">
              <Link
                to={item.to}
                aria-current={isActive ? 'page' : undefined}
                className={cx(
                  // A fixed width, so the row is a grid rather than a ragged
                  // line whose items jump around as the names change length.
                  // 5.5rem holds "Packaging" at 11px before it truncates.
                  'group relative flex w-[5.5rem] flex-col items-center gap-1.5 px-1 pb-3 pt-3',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                )}
              >
                {/*
                 * The mark's line colour is NOT the label's.
                 *
                 * Tinting the whole item brand-blue when it is active turned
                 * the mark into one colour — its line and its accent are then
                 * the same blue, and a two-tone drawing with one tone in it is
                 * a silhouette. The active item says so with the plate, the
                 * weight and the bar underneath; the mark keeps its two tones
                 * throughout, which is the whole reason it has them.
                 */}
                <span
                  className={cx(
                    'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                    isActive
                      ? 'bg-brand-soft text-ink ring-1 ring-inset ring-brand/20'
                      : 'text-ink-muted group-hover:bg-surface-hover group-hover:text-ink',
                  )}
                >
                  <item.Mark className="h-6 w-6" />
                </span>

                <span
                  className={cx(
                    'w-full truncate text-center text-xxs leading-tight transition-colors',
                    isActive
                      ? 'font-semibold text-brand'
                      : 'font-medium text-ink-muted group-hover:text-ink',
                  )}
                  // The full name for the ones that truncate. "Toys, Hob…" is
                  // a name a shopper should be able to check without pressing.
                  title={item.label}
                >
                  {item.label}
                </span>

                {/* Drawn, not measured. A bar the width of the item is exact
                    in all eight languages for free, and nothing here moves —
                    the same argument `CatalogPage`'s sort control makes. */}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand"
                  />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
