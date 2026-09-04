/**
 * An empty state that is the whole page.
 *
 * `EmptyState` in `ui.tsx` fills a *panel* — a table with no rows inside a
 * page that has a heading of its own — so its title is a `<p>`. When the empty
 * state is the entire page, that title is the page's heading, and rendering it
 * as a paragraph leaves the document with no `<h1>` at all: a screen reader
 * arriving at an empty cart is told nothing about where it is.
 *
 * Same silhouette as `EmptyState`, same rhythm, same width limit on the
 * explanatory line — so the two read as one pattern. The only difference is
 * the element the title is made of, which is the only difference that matters.
 */
import type { ReactNode } from 'react';

export function PageEmptyState({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Anything extra below the action — a secondary link, a note. */
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-surface px-6 py-16 shadow-card">
      <div className="mx-auto flex max-w-md flex-col items-center text-center">
        <h1 className="text-title-lg text-ink">{title}</h1>
        {description !== undefined && (
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{description}</p>
        )}
        {action !== undefined && <div className="mt-6">{action}</div>}
        {children}
      </div>
    </div>
  );
}
