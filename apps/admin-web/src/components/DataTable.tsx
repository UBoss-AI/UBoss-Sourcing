/**
 * A table.
 *
 * A real `<table>`, not a grid of divs. Screen readers announce a table's row
 * and column position as you move through it; a div grid announces nothing,
 * and every admin panel that reaches for CSS grid here becomes unusable
 * without sight.
 *
 * The `caption` is visually hidden but present, because "Table with 12 rows"
 * is far more use than "Table" when several tables share a page.
 */
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { EmptyState, ErrorState, LoadingState } from './ui';

export interface Column<T> {
  /** Stable key, also used for the cell's React key. */
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Right-align. Use for money and counts, so digits line up. */
  align?: 'left' | 'right';
  /** Hidden below `lg`. Use for columns that are context, not identity. */
  secondary?: boolean;
  width?: string;
}

interface DataTableProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  /** Rendered as a clickable row. Keep it a navigation, not a mutation. */
  onRowClick?: (row: T) => void;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  isLoading = false,
  error,
  onRetry,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyAction,
  onRowClick,
}: DataTableProps<T>): React.JSX.Element {
  if (error !== undefined && error !== null) {
    return <ErrorState error={error} {...(onRetry === undefined ? {} : { onRetry })} />;
  }

  if (isLoading) return <LoadingState />;

  if (rows === undefined || rows.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        {...(emptyDescription === undefined ? {} : { description: emptyDescription })}
        {...(emptyAction === undefined ? {} : { action: emptyAction })}
      />
    );
  }

  return (
    // Wide tables scroll inside their own container. The page body must never
    // scroll sideways - it takes the navigation off screen with it.
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          {caption} — {rows.length} row{rows.length === 1 ? '' : 's'}
        </caption>
        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width === undefined ? undefined : { width: column.width }}
                className={cx(
                  'whitespace-nowrap px-4 py-2.5 text-xxs font-semibold uppercase tracking-wider text-ink-subtle',
                  column.align === 'right' ? 'text-right' : 'text-left',
                  column.secondary === true && 'hidden lg:table-cell',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick === undefined ? undefined : () => { onRowClick(row); }}
              className={cx(
                'transition-colors',
                onRowClick === undefined ? '' : 'cursor-pointer hover:bg-surface-sunken',
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx(
                    'px-4 py-2.5 align-middle text-ink',
                    column.align === 'right' ? 'text-right tabular' : 'text-left',
                    column.secondary === true && 'hidden lg:table-cell',
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Page controls.
 *
 * Shows the range and the total, not just page numbers: "1–25 of 340" answers
 * "how much more is there" in one glance, which a bare "Page 1 of 14" does not.
 */
export function Pager({
  page,
  limit,
  total,
  totalPages,
  onPageChange,
}: {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}): React.JSX.Element | null {
  if (total === 0) return null;

  const first = (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);

  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-ink-muted"
    >
      <p aria-live="polite">
        {first}–{last} of {total}
      </p>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => { onPageChange(page - 1); }}
          disabled={page <= 1}
          className="rounded border border-border-strong px-2.5 py-1 font-medium text-ink hover:bg-surface-sunken disabled:cursor-not-allowed disabled:text-ink-subtle"
        >
          Previous
        </button>
        <span className="px-2">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => { onPageChange(page + 1); }}
          disabled={page >= totalPages}
          className="rounded border border-border-strong px-2.5 py-1 font-medium text-ink hover:bg-surface-sunken disabled:cursor-not-allowed disabled:text-ink-subtle"
        >
          Next
        </button>
      </div>
    </nav>
  );
}
