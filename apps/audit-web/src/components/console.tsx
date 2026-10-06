/**
 * The pieces every console screen shares.
 *
 * Built on the primitives in `ui.tsx` and `DataTable.tsx`, never beside them:
 * a badge here is a `Badge`, a failed panel is an `ErrorState`. What this file
 * adds is the console's own vocabulary - an enum shown as words, a query's
 * four states in one wrapper, a table that becomes cards on a phone, the
 * history of a case, a list of short codes typed as chips, tabs, and a
 * private file previewed or downloaded with the session cookie.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { DataTable, type Column } from './DataTable';
import { Badge, Button, Callout, EmptyState, ErrorState, Input, LoadingState, NoAccessState, Spinner } from './ui';
import { useToast } from './toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError, downloadFile, fetchBlob } from '@/lib/api';
import { cx } from '@/lib/cx';
import { enumLabel, enumTone, type EnumFamily } from '@/lib/enum-labels';
import { formatDateTime } from '@/lib/format';
import type { HistoryEntry } from '@/lib/console-types';
import { useWideViewport } from '@/lib/use-media-query';

// ---------------------------------------------------------------------------
// Enum badge
// ---------------------------------------------------------------------------

/** A server enum as a badge: the words always, the colour as a second signal. */
export function EnumBadge({
  family,
  value,
  dot = true,
}: {
  family: EnumFamily;
  value: string | null | undefined;
  dot?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Badge tone={enumTone(family, value)} dot={dot}>
      {enumLabel(t, family, value)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// A query's states
// ---------------------------------------------------------------------------

/**
 * Loading, refused, failed (with a retry) or ready - in one shape.
 *
 * A 403 is "you cannot see this", not an error; a 404 is "not found" with the
 * server's words. Everything else shows the server's own message.
 */
export function QueryBoundary<T>({
  query,
  children,
  loadingLabel,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  loadingLabel?: string;
}): React.JSX.Element {
  if (query.isPending) return <LoadingState {...(loadingLabel === undefined ? {} : { label: loadingLabel })} />;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 403) return <NoAccessState />;
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return <>{children(query.data)}</>;
}

// ---------------------------------------------------------------------------
// A table on a desk, cards on a phone
// ---------------------------------------------------------------------------

/**
 * `DataTable` from 640px up; below that, one card per row from `card`.
 *
 * Only one of the two is rendered, so a screen reader meets each row once.
 * The card must carry the same link the table's first column does.
 */
export function ResponsiveTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  card,
  emptyTitle,
  emptyDescription,
  minWidth,
  rowClassName,
  isRefreshing,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  card: (row: T) => ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  minWidth?: string;
  rowClassName?: (row: T) => string | undefined;
  isRefreshing?: boolean;
}): React.JSX.Element {
  const wide = useWideViewport();
  const { t } = useI18n();

  if (wide || rows.length === 0) {
    return (
      <DataTable
        caption={caption}
        columns={columns}
        rows={rows}
        rowKey={rowKey}
        {...(emptyTitle === undefined ? {} : { emptyTitle })}
        {...(emptyDescription === undefined ? {} : { emptyDescription })}
        {...(minWidth === undefined ? {} : { minWidth })}
        {...(rowClassName === undefined ? {} : { rowClassName })}
        {...(isRefreshing === undefined ? {} : { isRefreshing })}
      />
    );
  }

  return (
    <ul
      aria-label={caption}
      aria-busy={isRefreshing === true}
      className={cx('divide-y divide-border-subtle', isRefreshing === true && 'opacity-60')}
    >
      {rows.map((row) => (
        <li key={rowKey(row)} className={cx('px-4 py-3.5', rowClassName?.(row))}>
          {card(row)}
        </li>
      ))}
      {rows.length === 0 && <li className="px-4 py-6 text-center text-sm text-ink-muted">{t('common.nothingHereYet')}</li>}
    </ul>
  );
}

/** A label-and-value line inside a phone card. */
export function CardField({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-ink-subtle">{label}</span>
      <span className="min-w-0 text-right text-ink">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A failed write
// ---------------------------------------------------------------------------

/**
 * Why a write was refused, beside the form that sent it.
 *
 * The server's message first - it is written to be acted on - then, when the
 * server listed which fields or rules were the problem, those as a list, and
 * the reference that makes a support request answerable. `describeDetail`
 * lets a screen turn a detail code into words it knows.
 */
export function MutationError({
  error,
  describeDetail,
  title,
}: {
  error: unknown;
  describeDetail?: (detail: ApiError['details'][number]) => ReactNode;
  title?: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (error === null || error === undefined) return null;

  const message = error instanceof Error && error.message.length > 0 ? error.message : t('common.theRequestFailed');
  const details = error instanceof ApiError ? error.details : [];
  const reference = error instanceof ApiError ? error.correlationId : null;
  const describe = describeDetail ?? ((detail: ApiError['details'][number]) => detail.message ?? detail.field ?? detail.code ?? '');
  const lines = details.map((detail) => describe(detail)).filter((line) => line !== '' && line !== null);

  return (
    <Callout tone="danger" role="alert" title={title ?? t('common.mutationFailed')}>
      <p>{message}</p>
      {lines.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      {reference !== null && (
        <p className="mt-1.5 font-mono text-xxs text-ink-subtle">{t('common.reference', { reference })}</p>
      )}
    </Callout>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** What happened, oldest first, with who did it. A real list, so it is read as one. */
export function HistoryList({ entries }: { entries: HistoryEntry[] }): React.JSX.Element {
  const { t } = useI18n();

  if (entries.length === 0) {
    return <p className="text-sm text-ink-muted">{t('common.noHistory')}</p>;
  }

  return (
    <ol className="relative space-y-4 border-l border-border-subtle pl-5">
      {entries.map((entry, index) => (
        <li key={`${entry.at}-${String(index)}`} className="relative">
          <span aria-hidden="true" className="absolute -left-[1.6rem] top-1.5 h-2 w-2 rounded-full bg-accent ring-4 ring-surface" />
          <p className="text-sm text-ink">{entry.summary}</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
            {entry.actorLabel !== null && entry.actorLabel !== '' && <> · {entry.actorLabel}</>}
          </p>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/**
 * A list of short values - unit references, requirement codes - typed one at
 * a time. Enter or a comma adds; each chip has its own remove button with a
 * name that says which one it removes. `normalise` runs on each value before
 * it is added (upper-casing a code, trimming a reference).
 */
export function ChipInput({
  label,
  values,
  onChange,
  hint,
  normalise = (value) => value.trim(),
  max,
  placeholder,
  error,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  hint?: string;
  normalise?: (value: string) => string;
  max?: number;
  placeholder?: string;
  error?: string | undefined;
}): React.JSX.Element {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState('');

  const commit = (raw: string): void => {
    const parts = raw
      .split(/[,\n]/)
      .map(normalise)
      .filter((part) => part.length > 0);
    if (parts.length === 0) return;
    const next = [...values];
    for (const part of parts) {
      if (!next.includes(part) && (max === undefined || next.length < max)) next.push(part);
    }
    onChange(next);
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {values.map((value) => (
            <li key={value}>
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-xs font-medium text-accent ring-1 ring-inset ring-accent/25">
                <span className="font-mono">{value}</span>
                <button
                  type="button"
                  className="rounded-full px-1 leading-none hover:bg-accent/15"
                  aria-label={t('common.removeItem', { item: value })}
                  onClick={() => {
                    onChange(values.filter((entry) => entry !== value));
                  }}
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={id}
        value={draft}
        invalid={error !== undefined}
        {...(placeholder === undefined ? {} : { placeholder })}
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          const value = event.target.value;
          if (value.includes(',')) commit(value);
          else setDraft(value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          commit(draft);
        }}
      />
      <p id={`${id}-hint`} className="text-xs text-ink-muted">
        {hint ?? t('common.chipsHint')}
      </p>
      {error !== undefined && (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * WAI-ARIA tabs: arrow keys move between them, only the selected one is in
 * the tab order, and each panel is labelled by its tab.
 */
export function Tabs<K extends string>({
  label,
  tabs,
  selected,
  onSelect,
  children,
}: {
  label: string;
  tabs: { key: K; label: string; badge?: ReactNode }[];
  selected: K;
  onSelect: (key: K) => void;
  children: ReactNode;
}): React.JSX.Element {
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = tabs.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (target === undefined) return;
    onSelect(target.key);
    refs.current[target.key]?.focus();
  };

  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((tab, index) => {
          const active = tab.key === selected;
          return (
            <button
              key={tab.key}
              ref={(node) => {
                refs.current[tab.key] = node;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.key}`}
              aria-selected={active}
              aria-controls={`${base}-panel`}
              tabIndex={active ? 0 : -1}
              onClick={() => {
                onSelect(tab.key);
              }}
              onKeyDown={(event) => {
                move(event, index);
              }}
              className={cx(
                '-mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                active ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {tab.label}
              {tab.badge}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${selected}`} className="pt-5">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Private files
// ---------------------------------------------------------------------------

/** Download a private file with the session cookie, and say so if it fails. */
export function DownloadButton({
  path,
  fileName,
  label,
  size = 'sm',
  variant = 'secondary',
}: {
  path: string;
  fileName: string;
  label?: string;
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'ghost';
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      size={size}
      variant={variant}
      isLoading={busy}
      onClick={() => {
        setBusy(true);
        downloadFile(path, fileName)
          .catch((error: unknown) => {
            toast.error(error instanceof Error && error.message !== '' ? error.message : t('common.downloadFailed'));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      {label ?? t('common.download')}
    </Button>
  );
}

/**
 * A private file shown in the page: a PDF in an iframe, an image as an image,
 * anything else as "download it". The bytes are fetched with the session and
 * held as an object URL, revoked when the preview goes. Nothing is sent to a
 * third-party viewer.
 */
export function FilePreview({ path, name }: { path: string; name: string }): React.JSX.Element {
  const { t } = useI18n();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; url: string; type: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setState({ status: 'loading' });
    fetchBlob(path)
      .then(({ blob, contentType }) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setState({ status: 'ready', url, type: contentType });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', error });
      });
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [path]);

  if (state.status === 'loading') {
    return (
      <div className="flex h-64 items-center justify-center gap-2 rounded-md border border-border bg-surface-sunken text-sm text-ink-muted">
        <Spinner />
        <span role="status">{t('common.preview.loading')}…</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="rounded-md border border-border">
        <ErrorState error={state.error} />
      </div>
    );
  }

  const title = t('common.preview.title', { name });
  if (state.type.includes('pdf')) {
    return <iframe title={title} src={state.url} className="h-[32rem] w-full rounded-md border border-border bg-white" />;
  }
  if (state.type.startsWith('image/')) {
    return (
      <img
        src={state.url}
        alt={title}
        className="max-h-[32rem] w-full rounded-md border border-border bg-surface-sunken object-contain"
      />
    );
  }
  return (
    <div className="rounded-md border border-border">
      <EmptyState title={t('common.preview.notPreviewable')} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small layout helpers
// ---------------------------------------------------------------------------

/** A heading inside a card body, with an optional line of explanation. */
export function SectionHeading({
  title,
  description,
  actions,
  id,
}: {
  title: string;
  description?: string | undefined;
  actions?: ReactNode;
  id?: string;
}): React.JSX.Element {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 id={id} className="text-title-xs text-ink">
          {title}
        </h3>
        {description !== undefined && <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-ink-muted">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A clickable tile with a big number, for the dashboards. Links when given `to`. */
export function StatTile({
  label,
  value,
  sub,
  tone = 'default',
  action,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  action?: ReactNode;
}): React.JSX.Element {
  const toneClass = {
    default: 'text-ink',
    warning: 'text-warning',
    danger: 'text-danger',
    success: 'text-success',
  }[tone];
  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface p-4 shadow-card transition-[border-color,box-shadow] hover:border-border-hover">
      <p className="min-h-8 text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">{label}</p>
      <p className={cx('mt-2 text-title tabular', toneClass)}>{value}</p>
      {sub !== undefined && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{sub}</p>}
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  );
}
