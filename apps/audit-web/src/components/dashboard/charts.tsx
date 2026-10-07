/**
 * The staff dashboard's two chart pieces that the shared kit does not have:
 * a key-figure tile and a ranked bar list.
 *
 * Audit Console only, unlike `console.tsx` and `ModernDonutCard.tsx` beside
 * it, which are kept byte-identical with the other apps. Like them, nothing
 * here takes a translation key: every string arrives translated.
 *
 * Both are links when they have somewhere to go. A figure on this screen is
 * always the count of a list that exists elsewhere in the console, and the
 * way to check a figure is to open that list.
 */
import { Link } from 'react-router-dom';
import { ConsoleCard } from '@/components/dashboard/console';
import { cx } from '@/lib/cx';
import { formatNumber } from '@/lib/format';

// ---------------------------------------------------------------------------
// Key figure
// ---------------------------------------------------------------------------

const TONE: Record<'default' | 'warning' | 'danger' | 'success', string> = {
  default: 'text-ink',
  warning: 'text-warning',
  danger: 'text-danger',
  success: 'text-success',
};

/**
 * One headline number, with what it counts under it.
 *
 * The tone colours the figure only when there is something to see: a red
 * zero says "problem" about a queue that is empty.
 */
export function KpiTile({
  label,
  value,
  sub,
  to,
  tone = 'default',
  meter,
}: {
  label: string;
  /** Already formatted. A dash while it is still loading. */
  value: string;
  sub?: string | undefined;
  to: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  /** 0-100. Draws a thin bar under the figure, for a share of a whole. */
  meter?: number | undefined;
}): React.JSX.Element {
  return (
    <Link to={to} className="block h-full rounded-xl focus-visible:outline-none">
      <ConsoleCard interactive className="h-full" bodyClassName="flex h-full flex-col p-4">
        <p className="min-h-8 text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">{label}</p>
        <p className={cx('mt-1 tabular text-title-lg', TONE[tone])}>{value}</p>
        {meter === undefined ? null : (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-console-border/60" aria-hidden="true">
            <div className="h-full rounded-full bg-chart-seq-3" style={{ width: `${String(Math.max(0, Math.min(100, meter)))}%` }} />
          </div>
        )}
        {sub === undefined ? null : <p className="mt-2 text-xs leading-relaxed text-ink-muted">{sub}</p>}
      </ConsoleCard>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Ranked bars
// ---------------------------------------------------------------------------

export interface BarRow {
  id: string;
  label: string;
  value: number;
  /** Where the row leads. */
  to: string;
  /** Draws the bar in the warning or danger fill instead of the series blue. */
  tone?: 'warning' | 'danger' | undefined;
}

const BAR_FILL = {
  default: 'bg-chart-seq-3',
  warning: 'bg-warning-fill',
  danger: 'bg-danger-fill',
} as const;

/**
 * Horizontal bars, one series, every value written beside its bar.
 *
 * Bars rather than a ring because these rows are compared with each other,
 * not read as parts of one whole. The figure is text, so the bar is never the
 * only way to read it, and each row is a link to the list it counts.
 */
export function BarListCard({
  title,
  description,
  rows,
  empty,
  actions,
  className,
}: {
  title: string;
  description?: string | undefined;
  rows: readonly BarRow[];
  /** Shown instead of the bars when there are no rows. Zero rows still show, at zero. */
  empty?: string | undefined;
  actions?: React.ReactNode;
  className?: string | undefined;
}): React.JSX.Element {
  const max = rows.reduce((top, row) => Math.max(top, row.value), 0);

  return (
    <ConsoleCard title={title} description={description} actions={actions} className={cx('h-full', className)} bodyClassName="px-3 py-3">
      {rows.length === 0 ? (
        empty === undefined ? null : <p className="px-2 py-8 text-center text-sm text-ink-subtle">{empty}</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                to={row.to}
                className="group block rounded-md px-2 py-2 transition-colors hover:bg-surface-hover/60"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-xs font-medium text-ink">{row.label}</span>
                  <span className="shrink-0 tabular text-sm font-semibold text-ink">{formatNumber(row.value)}</span>
                </span>
                <span className="mt-1.5 block h-2.5 w-full" aria-hidden="true">
                  <span
                    className={cx(
                      'block h-full rounded-r transition-opacity group-hover:opacity-80',
                      BAR_FILL[row.tone ?? 'default'],
                    )}
                    // A zero is drawn as nothing, not as a sliver that reads as "a few".
                    style={{ width: row.value === 0 || max === 0 ? '0' : `${String(Math.max(2, (row.value / max) * 100))}%` }}
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ConsoleCard>
  );
}
