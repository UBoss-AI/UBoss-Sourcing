/**
 * The dashboard's hero chart.
 *
 * One ring, a total in the middle, a legend of real buttons, and a table for
 * anyone who wants the figures rather than the shape. Every role dashboard
 * uses this and none of them hard-codes a status in it: it is handed segments
 * and it draws them.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web and
 * apps/logistics-web — see the note at the top of console.tsx. It takes no
 * translation key and no router type for exactly that reason: every string
 * arrives translated and navigation is a callback, so the three copies cannot
 * drift over a difference in their catalogues.
 *
 * ---
 *
 * HOW IT IS READ, AND BY WHOM
 *
 * The ring is `role="img"` with a label that says what it shows. Its arcs are
 * decoration in the accessibility tree — they carry no text, they are not
 * focusable, and nothing is reachable only through them.
 *
 * **The legend is the control.** Each entry is a real `<button>` with
 * `aria-pressed`, carrying the label, the count and the share as text. That is
 * a deliberate choice over making the arcs focusable too: a segment reachable
 * twice is two tab stops that announce the same thing, and on a ring of eight
 * statuses that is sixteen stops between the chart and the table under it. It
 * is the same reasoning `ProportionBar` in components/charts.tsx records for
 * the same decision.
 *
 * Clicking an arc still works, because a pointer user reasonably expects it
 * to. It is an accelerator for something already reachable, never the only way.
 *
 * ---
 *
 * FOUR THINGS IT REFUSES TO DO
 *
 *   - **It never derives the total.** The figure in the middle is passed in.
 *     Summing the segments here would quietly redefine 100% as "the statuses
 *     this chart happens to break out", and the number in the ring would then
 *     disagree with the number on the screen it links to.
 *   - **It never hides a shortfall.** Where the segments do not account for
 *     the total, it says so in words under the chart rather than drawing a
 *     ring that looks complete.
 *   - **It never relies on colour alone.** Every segment carries its label,
 *     its count and its share as text, and the legend swatch has a shape as
 *     well as a hue.
 *   - **It never animates twice.** The ring draws itself once, when data first
 *     arrives. A background refetch updates the arcs without replaying it,
 *     because a chart that redraws itself every thirty seconds is a chart
 *     nobody can read on the thirtieth second.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { cx } from '@/lib/cx';
import {
  STEP_SHAPE,
  STEP_STROKE,
  STEP_SWATCH,
  buildDonut,
  type DonutSegment,
  type DonutSegmentInput,
} from '@/lib/donut';

/** The strings the card needs. Passed in already translated. */
export interface DonutCardLabels {
  /** "Value", for the table column. */
  value: string;
  /** "Share", for the table column. */
  share: string;
  /** "Status", for the table column. */
  status: string;
  /** "View as table". */
  viewAsTable: string;
  /** "Clear filter". */
  clearFilter: string;
  /** "Showing {{label}} only" — the caller substitutes. */
  filteredBy: string;
  /** "Nothing to show for this period." */
  empty: string;
  /** "Could not load this chart." */
  error: string;
  /** "Try again". */
  retry: string;
  /** "Loading…" */
  loading: string;
  /**
   * "{{count}} not broken out below" — shown only where the segments do not
   * account for the total.
   */
  remainder: string;
  /**
   * "Slices under 1% are drawn at a readable minimum; the figures beside them
   * are exact."
   */
  clampNote: string;
}

export interface ModernDonutCardProps {
  title: string;
  description?: string | undefined;
  /** The authoritative figure, from the server. Never summed here. */
  total: number;
  /** The caption above the total, e.g. "MY ORDERS". */
  centerLabel: string;
  /** The caption below it, e.g. "orders in this period". */
  unitLabel: string;
  segments: readonly DonutSegmentInput[];
  /** The selected segment's `id`, or null. Controlled by the caller. */
  selectedSegment: string | null;
  /**
   * Called with a segment id, or null to clear.
   *
   * Selecting the segment that is already selected clears it — the caller
   * does not need to special-case that; this component passes null.
   */
  onSegmentSelect: (id: string | null) => void;
  /** Already-formatted, e.g. "Last 30 days". Shown beside the title. */
  dateRangeLabel?: string | undefined;
  loading?: boolean | undefined;
  error?: unknown;
  onRetry?: (() => void) | undefined;
  /** Replaces the whole body when there is nothing to draw. */
  emptyState?: React.ReactNode;
  lastUpdatedAt?: string | null | undefined;
  /** Overrides the generated description of the chart for a screen reader. */
  ariaLabel?: string | undefined;
  labels: DonutCardLabels;
  className?: string | undefined;
  /** Rendered under the legend — a footnote, a link to the full queue. */
  footer?: React.ReactNode;
}

/** The SVG is drawn in a fixed user-space box and scaled by CSS. */
const VIEWBOX = 240;
const RADIUS = 96;
const STROKE = 26;
const STROKE_ACTIVE = 34;

export function ModernDonutCard({
  title,
  description,
  total,
  centerLabel,
  unitLabel,
  segments,
  selectedSegment,
  onSegmentSelect,
  dateRangeLabel,
  loading = false,
  error,
  onRetry,
  emptyState,
  lastUpdatedAt,
  ariaLabel,
  labels,
  className,
  footer,
}: ModernDonutCardProps): React.JSX.Element {
  const headingId = useId();
  const [hovered, setHovered] = useState<string | null>(null);

  const geometry = buildDonut(segments, total, { radius: RADIUS });

  /*
   * Whether the entry animation has already run.
   *
   * Keyed on data ARRIVING rather than on mount: the card mounts while the
   * request is still in flight, so an animation started at mount plays against
   * an empty ring and is over before the arcs exist. It runs once and then
   * never again, including across a refetch — see the header.
   */
  const drawn = useRef(false);
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    if (drawn.current || loading || geometry.isEmpty) return;
    drawn.current = true;
    setAnimate(true);
  }, [loading, geometry.isEmpty]);

  const active = hovered ?? selectedSegment;
  const selected = geometry.segments.find((segment) => segment.id === selectedSegment) ?? null;
  const anyClamped = geometry.segments.some((segment) => segment.clamped);

  const chartLabel =
    ariaLabel ??
    `${title}. ${String(total)} ${unitLabel}. ` +
      geometry.segments
        .map((segment) => `${segment.label}: ${String(segment.value)}, ${String(segment.percentage)}%`)
        .join('. ');

  // --- The states that are not a chart ------------------------------------

  let body: React.JSX.Element;

  if (loading) {
    body = <DonutSkeleton label={labels.loading} />;
  } else if (error !== undefined && error !== null) {
    body = (
      <div className="flex min-h-[18rem] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <p className="text-sm text-ink-muted">{labels.error}</p>
        {onRetry === undefined ? null : (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:border-border-hover hover:bg-surface-hover"
          >
            {labels.retry}
          </button>
        )}
      </div>
    );
  } else if (geometry.isEmpty) {
    body = (
      <div className="flex min-h-[18rem] items-center justify-center px-6 py-10 text-center">
        {emptyState ?? <p className="text-sm text-ink-subtle">{labels.empty}</p>}
      </div>
    );
  } else {
    body = (
      <div
        /*
         * `items-start`, not `items-center`.
         *
         * The two columns are rarely the same height — a legend of eight
         * stages with a table toggle under it is twice the ring — and centring
         * the short one leaves a band of empty card above the chart, which
         * reads as something having failed to load. Aligning both to the top
         * puts the ring beside the first legend entry, which is also where the
         * eye goes.
         */
        className="grid gap-6 px-5 py-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] lg:items-start"
      >
        {/* --- The ring ------------------------------------------------- */}
        <div className="relative mx-auto w-full max-w-[18rem]">
          <span className="console-hero-bloom" aria-hidden="true" />

          <svg
            viewBox={`0 0 ${String(VIEWBOX)} ${String(VIEWBOX)}`}
            role="img"
            aria-label={chartLabel}
            className="relative w-full"
          >
            {/*
              The track. A full ring at low opacity behind the arcs, so a
              nearly-empty chart still reads as a ring with one slice in it
              rather than as a stray crescent floating in the card.
            */}
            <circle
              cx={VIEWBOX / 2}
              cy={VIEWBOX / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              className="stroke-console-border/60"
            />

            {/*
              Rotated so zero degrees is twelve o'clock. Done on the group
              rather than per arc, so the geometry module only ever has to
              think in "degrees clockwise from the top".
            */}
            <g transform={`rotate(-90 ${String(VIEWBOX / 2)} ${String(VIEWBOX / 2)})`}>
              {geometry.segments
                .filter((segment) => segment.value > 0)
                .map((segment) => {
                  const isActive = active === segment.id;

                  return (
                    <circle
                      key={segment.id}
                      cx={VIEWBOX / 2}
                      cy={VIEWBOX / 2}
                      r={RADIUS}
                      fill="none"
                      strokeLinecap="round"
                      strokeWidth={isActive ? STROKE_ACTIVE : STROKE}
                      strokeDasharray={segment.dashArray}
                      strokeDashoffset={segment.dashOffset}
                      className={cx(
                        'console-arc',
                        STEP_STROKE[segment.step],
                        active !== null && !isActive && 'console-arc-muted',
                        animate && 'animate-donut-draw',
                        'cursor-pointer',
                      )}
                      style={
                        {
                          '--donut-circumference': String(geometry.circumference),
                          '--donut-offset': String(segment.dashOffset),
                        } as React.CSSProperties
                      }
                      /*
                        Decoration in the accessibility tree. The legend below
                        is the control — see the header for why this is not
                        also focusable.
                      */
                      aria-hidden="true"
                      onPointerEnter={() => {
                        setHovered(segment.id);
                      }}
                      onPointerLeave={() => {
                        setHovered(null);
                      }}
                      onClick={() => {
                        onSegmentSelect(selectedSegment === segment.id ? null : segment.id);
                      }}
                    />
                  );
                })}
            </g>
          </svg>

          {/*
            The centre. Absolutely positioned over the ring rather than drawn
            as SVG text, so it inherits the app's type scale and its tabular
            figures — an SVG `<text>` would need every one of those repeated
            as presentation attributes, and would not reflow.

            `pointer-events-none`, so it does not steal the hover from the arc
            passing behind it.
          */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <p className="text-xxs font-semibold uppercase tracking-[0.14em] text-ink-subtle">
              {centerLabel}
            </p>
            {/*
              The one number the whole card exists for.

              Carries a test id because it is genuinely hard to address
              otherwise: the same figure appears again in the legend whenever a
              single segment holds the lot, so a text query for it is ambiguous
              exactly when the chart is at its simplest. Same reasoning as
              `packing-formula` on the product page.
            */}
            <p data-testid="donut-total" className="tabular text-title-xl text-ink">
              {formatCount(total)}
            </p>
            <p className="mt-0.5 max-w-[9rem] text-xxs leading-snug text-ink-muted">{unitLabel}</p>
          </div>
        </div>

        {/* --- The legend ----------------------------------------------- */}
        <div className="min-w-0">
          {/*
            One column until there is genuinely room for two.

            The second column used to arrive at `xl`, which on a 1280px screen
            with a 280px sidebar leaves each entry about 150px — and every
            label truncated to "Waiti…", "Deliver…", "Cancelle…". A legend
            whose labels are cut off is a legend that has stopped being the
            readable half of the chart, which is the one job it has.
          */}
          <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
            {geometry.segments.map((segment) => (
              <li key={segment.id}>
                <LegendButton
                  segment={segment}
                  selected={selectedSegment === segment.id}
                  onHover={setHovered}
                  onSelect={() => {
                    onSegmentSelect(selectedSegment === segment.id ? null : segment.id);
                  }}
                />
              </li>
            ))}
          </ul>

          {selected === null ? null : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <p className="text-xs text-ink-muted">
                {labels.filteredBy.replace('{{label}}', selected.label)}
              </p>
              <button
                type="button"
                onClick={() => {
                  onSegmentSelect(null);
                }}
                className="rounded px-2 py-1 text-xs font-medium text-brand underline-offset-2 transition-colors hover:underline"
              >
                {labels.clearFilter}
              </button>
            </div>
          )}

          {/*
            Where the ring does not account for the total, say so. Anything
            else is a chart that looks complete and is not — and the day that
            happens is the day somebody adds a status to the backend and not
            to the grouping, which nothing else on the screen would reveal.
          */}
          {geometry.reconciliation.reconciles ? null : (
            <p className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-xxs text-warning">
              {labels.remainder.replace(
                '{{count}}',
                String(Math.abs(geometry.reconciliation.remainder)),
              )}
            </p>
          )}

          {anyClamped ? (
            <p className="mt-2 text-xxs leading-snug text-ink-subtle">{labels.clampNote}</p>
          ) : null}

          {/*
            The figures, for anybody who wants them rather than the shape.
            A real table in a `<details>` rather than a visually-hidden copy:
            hidden duplicate content makes a screen-reader user hear the whole
            legend twice, and this way it is available to everybody.
          */}
          <details className="group mt-4">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-xs font-medium text-ink-muted transition-colors hover:text-ink">
              <svg
                viewBox="0 0 20 20"
                className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m8 6 4 4-4 4" />
              </svg>
              {labels.viewAsTable}
            </summary>

            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">{chartLabel}</caption>
                <thead>
                  <tr className="text-ink-subtle">
                    <th scope="col" className="py-1 pr-3 font-medium">
                      {labels.status}
                    </th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">
                      {labels.value}
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      {labels.share}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-console-border/60">
                  {geometry.segments.map((segment) => (
                    <tr key={segment.id}>
                      <th scope="row" className="py-1.5 pr-3 font-normal text-ink">
                        {segment.label}
                      </th>
                      <td className="tabular py-1.5 pr-3 text-right text-ink">{segment.value}</td>
                      <td className="tabular py-1.5 text-right text-ink-muted">
                        {segment.percentage}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {footer === undefined ? null : <div className="mt-4">{footer}</div>}
        </div>
      </div>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className={cx('console-card overflow-hidden', className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-console-border/70 px-5 py-4">
        <div className="min-w-0">
          <h2 id={headingId} className="text-title-sm text-ink">
            {title}
          </h2>
          {description === undefined ? null : (
            <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-ink-muted">
              {description}
            </p>
          )}
        </div>

        {dateRangeLabel === undefined ? null : (
          <p className="shrink-0 text-xxs text-ink-subtle">
            {lastUpdatedAt === undefined || lastUpdatedAt === null ? (
              dateRangeLabel
            ) : (
              <time dateTime={lastUpdatedAt}>{dateRangeLabel}</time>
            )}
          </p>
        )}
      </header>

      {body}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * One legend entry: the control that selects a segment.
 *
 * `aria-pressed` rather than a checkbox or a link, because that is what this
 * is — a toggle that filters the list below. A link would promise navigation
 * that does not happen, and a checkbox would promise that several can be on at
 * once.
 *
 * `min-h-[2.75rem]` is the touch target. 44px is the practical floor for a
 * control somebody is tapping on a phone in a warehouse, and a legend row is
 * otherwise about 28px.
 */
function LegendButton({
  segment,
  selected,
  onHover,
  onSelect,
}: {
  segment: DonutSegment;
  selected: boolean;
  onHover: (id: string | null) => void;
  onSelect: () => void;
}): React.JSX.Element {
  const shape = STEP_SHAPE[segment.step];

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      onPointerEnter={() => {
        onHover(segment.id);
      }}
      onPointerLeave={() => {
        onHover(null);
      }}
      onFocus={() => {
        onHover(segment.id);
      }}
      onBlur={() => {
        onHover(null);
      }}
      className={cx(
        // No focus classes: the global `:focus-visible` rule in index.css
        // already draws the ring, and the console layer there corrects its
        // offset colour for this surface.
        'flex min-h-[2.75rem] w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors',
        selected ? 'bg-brand-soft' : 'hover:bg-surface-hover/60',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'h-2.5 w-2.5 shrink-0',
          STEP_SWATCH[segment.step],
          shape === 'round' && 'rounded-full',
          shape === 'square' && 'rounded-[2px]',
          shape === 'diamond' && 'rotate-45 rounded-[2px]',
        )}
      />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-ink">{segment.label}</span>
        {segment.detail === undefined ? null : (
          <span className="block truncate text-xxs text-ink-subtle">{segment.detail}</span>
        )}
      </span>

      <span className="shrink-0 text-right">
        <span className="tabular block text-sm font-semibold text-ink">
          {formatCount(segment.value)}
        </span>
        <span className="tabular block text-xxs text-ink-subtle">{segment.percentage}%</span>
      </span>

      {/*
        A second channel for the selected state, so "which one is filtering the
        list" does not rest on a soft blue ground alone.
      */}
      {selected ? (
        <svg
          viewBox="0 0 20 20"
          className="h-3.5 w-3.5 shrink-0 text-brand"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m4 10 4 4 8-8" />
        </svg>
      ) : null}
    </button>
  );
}

/**
 * The chart while it is loading.
 *
 * A dimmed ring of the right size rather than a spinner, so the card does not
 * change height when the data lands and push everything below it down the
 * page. `aria-busy` and a live label, so the wait is announced once rather
 * than discovered.
 */
function DonutSkeleton({ label }: { label: string }): React.JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="flex min-h-[18rem] flex-col items-center justify-center gap-4 px-6 py-10"
    >
      <svg
        viewBox={`0 0 ${String(VIEWBOX)} ${String(VIEWBOX)}`}
        className="w-40 opacity-40"
        aria-hidden="true"
      >
        <circle
          cx={VIEWBOX / 2}
          cy={VIEWBOX / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          className="stroke-console-border"
        />
      </svg>
      <p className="text-xs text-ink-subtle">{label}</p>
    </div>
  );
}

/**
 * A count, grouped.
 *
 * `Intl` rather than a hand-rolled separator: a thousands separator is a comma
 * in English, a full stop in German and a thin space in French, and this
 * number sits in the middle of a chart in eight languages.
 */
function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined).format(value);
}
