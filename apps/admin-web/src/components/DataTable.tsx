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
import type { MouseEvent, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { EmptyState, ErrorState, LoadingState, NoAccessState } from './ui';

export interface Column<T> {
  /** Stable key, also used for the cell's React key. */
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /**
   * Right-align for money, counts and anything else read as a digit column;
   * centre for a lone status chip. Right-aligned cells also get tabular
   * figures, so the digits line up down the page.
   */
  align?: 'left' | 'right' | 'center';
  /** Hidden below `lg`. Use for columns that are context, not identity. */
  secondary?: boolean;
  /**
   * Hidden below `sm` as well as being `secondary`. For the third and fourth
   * supporting column on a wide operational table, where a phone can show the
   * identity, the status and one number and nothing more.
   */
  tertiary?: boolean;
  width?: string;
  /**
   * Stops the cell wrapping. Dates, SKUs and short codes read worse broken
   * across two lines than they do pushing the table into its scroll container.
   */
  nowrap?: boolean;
}

interface DataTableProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  isLoading?: boolean;
  /** A refetch behind rows that are already on screen. Dims, never blanks. */
  isRefreshing?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Renders the no-permission state instead of the table. */
  isForbidden?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  loadingLabel?: string;
  /**
   * Below this the table scrolls sideways inside its own container rather than
   * crushing its columns. Set it on tables with more than about five columns.
   */
  minWidth?: string;
  /**
   * Per-row emphasis, for a state the reader must not have to hunt for — an
   * out-of-stock SKU, a failed job. Use it for a *ground tint only*: the row
   * still has to carry the same fact in words, because a colour on its own is
   * not a signal to anyone who cannot see it.
   */
  rowClassName?: (row: T) => string | undefined;
  /**
   * A convenience click target for a row that *already* contains a link to the
   * same place. It is never the only way to get there: the row's first cell
   * carries a real `<a>`, which is what a keyboard and a screen reader use.
   * Keep it a navigation, never a mutation.
   */
  onRowClick?: (row: T) => void;
}

/*
 * Was the click on something that handles its own clicks?
 *
 * A row-level handler that fires on top of the link, button or checkbox inside
 * the row causes double navigations and, worse, swallows the row action the
 * user was actually aiming at. Selecting text in a cell should not navigate
 * either — dragging across an order number to copy it and landing on a
 * different page is the classic clickable-row complaint.
 */
function isOwnClickTarget(event: MouseEvent<HTMLTableRowElement>): boolean {
  if (event.defaultPrevented) return true;

  const target = event.target as HTMLElement | null;
  if (target?.closest('a, button, input, select, textarea, label, [role="button"]') !== null) {
    return true;
  }

  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  isLoading = false,
  isRefreshing = false,
  error,
  onRetry,
  isForbidden = false,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyAction,
  loadingLabel,
  minWidth,
  rowClassName,
  onRowClick,
}: DataTableProps<T>): React.JSX.Element {
  if (isForbidden) return <NoAccessState />;

  if (error !== undefined && error !== null) {
    return <ErrorState error={error} {...(onRetry === undefined ? {} : { onRetry })} />;
  }

  if (isLoading) {
    return <LoadingState {...(loadingLabel === undefined ? {} : { label: loadingLabel })} />;
  }

  if (rows === undefined || rows.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        {...(emptyDescription === undefined ? {} : { description: emptyDescription })}
        {...(emptyAction === undefined ? {} : { action: emptyAction })}
      />
    );
  }

  const alignClass = (align: Column<T>['align']): string =>
    align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';

  const visibility = (column: Column<T>): string | false =>
    column.tertiary === true
      ? 'hidden xl:table-cell'
      : column.secondary === true && 'hidden lg:table-cell';

  return (
    // Wide tables scroll inside their own container. The page body must never
    // scroll sideways - it takes the navigation off screen with it.
    //
    // `role="region"` + `tabIndex={0}`: a scrollable box that can only be
    // scrolled by dragging is unreachable without a mouse. Making it focusable
    // lets a keyboard user arrow the columns into view, and the accessible name
    // is what tells them which of the page's tables they have just landed in.
    <div
      className="overflow-x-auto"
      role="region"
      aria-label={caption}
      aria-busy={isRefreshing}
      tabIndex={0}
    >
      <table
        className={cx(
          'w-full border-collapse text-sm',
          // A refetch behind rows already on screen dims them rather than
          // replacing them with a spinner. Swapping a full table for a spinner
          // on every filter change is what makes a list feel like it reloads
          // the world each time you touch a dropdown.
          isRefreshing && 'opacity-60 transition-opacity',
        )}
        style={minWidth === undefined ? undefined : { minWidth }}
      >
        <caption className="sr-only">
          {caption} — {rows.length} row{rows.length === 1 ? '' : 's'}
        </caption>
        {/*
         * A tinted header row, with a rule heavy enough to be an edge.
         *
         * On a long table the header is the thing you look back up at, and an
         * untinted one is only distinguishable from the first row of data by
         * its letter-spacing. The tint answers "which line is the header" from
         * across the room; the `border-strong` beneath it separates the header
         * band from the body, where the rows are divided by the much lighter
         * `border-subtle`. Two weights, so the header wins.
         */}
        <thead className="bg-surface-sunken">
          <tr className="border-b border-border-strong/40">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width === undefined ? undefined : { width: column.width }}
                className={cx(
                  'whitespace-nowrap px-4 py-2.5 text-xxs font-semibold uppercase tracking-wider text-ink-muted',
                  alignClass(column.align),
                  visibility(column),
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        {/*
         * Every row highlights on hover, not only the clickable ones. On a
         * twelve-column table the highlight is what keeps your eye on one
         * record while you read across it; the `cursor-pointer` is what says
         * the row will do something if you click it. Those are two different
         * jobs and they used to be one class.
         */}
        <tbody className="divide-y divide-border-subtle">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={
                onRowClick === undefined
                  ? undefined
                  : (event) => {
                      if (isOwnClickTarget(event)) return;
                      onRowClick(row);
                    }
              }
              className={cx(
                'transition-colors hover:bg-surface-hover',
                onRowClick === undefined ? '' : 'cursor-pointer',
                // Last, so a row that has been singled out keeps its ground
                // through the hover rule above.
                rowClassName?.(row),
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx(
                    'px-4 py-2.5 align-middle text-ink',
                    alignClass(column.align),
                    column.align === 'right' && 'tabular',
                    column.nowrap === true && 'whitespace-nowrap',
                    visibility(column),
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

  // The two page buttons are the `secondary` Button's skin at pager scale.
  // Kept as a constant rather than reaching for <Button size="sm">, because a
  // 32px control inside a 40px-high bar would set the bar's height from the
  // button rather than from the text beside it.
  const pageButton =
    'rounded border border-border-strong bg-surface px-2.5 py-1 font-medium text-ink shadow-card ' +
    'transition-[background-color,border-color,color,box-shadow] ' +
    'hover:border-border-hover hover:bg-surface-hover ' +
    'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface ' +
    'disabled:text-ink-subtle disabled:shadow-none';

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-4 py-2.5 text-xs text-ink-muted"
    >
      <p aria-live="polite">
        <span className="tabular text-ink">
          {first}–{last}
        </span>{' '}
        of <span className="tabular text-ink">{total}</span>
      </p>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => { onPageChange(page - 1); }}
          disabled={page <= 1}
          className={pageButton}
        >
          Previous
        </button>
        <span className="whitespace-nowrap px-2">
          Page <span className="tabular">{page}</span> of <span className="tabular">{totalPages}</span>
        </span>
        <button
          type="button"
          onClick={() => { onPageChange(page + 1); }}
          disabled={page >= totalPages}
          className={pageButton}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
