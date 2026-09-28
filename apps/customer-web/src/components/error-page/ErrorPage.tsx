/**
 * The one full-page error, in every app, for every kind of failure.
 *
 * The same ghost, the same layout and the same tokens for a missing page, a
 * refused one, a server that fell over and a browser with no network; what
 * changes is the numeral, the words and the ways onward. See `error-kind.ts`
 * for how a thrown value becomes a kind, and for why nothing from the error
 * itself is ever shown.
 *
 * **Works outside the router and outside the providers.** The app-wide error
 * boundary sits above both, so this component takes `t` as a prop rather than
 * reading a context, and an action is a router `to` only when the caller knows
 * a router is there — the boundary passes plain `href`s.
 *
 * **Announced, not focused.** The heading and message sit in a
 * `role="alert"` region, so a screen reader reads them the moment the page
 * appears, without the page moving keyboard focus out from under somebody who
 * was tabbing through the header.
 *
 * **Compact errors stay compact.** This is for a route that cannot render at
 * all. A form field, a single widget or a toast keeps its inline message.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Translate, TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';
import { DEFAULT_STATUS, type ErrorKind } from './error-kind';
import { GhostScene } from './GhostScene';

/** What each kind says. A total record, so a new kind cannot ship silent. */
const COPY: Readonly<Record<ErrorKind, { title: TranslationKey; message: TranslationKey }>> = {
  notFound: { title: 'errorPage.notFound.title', message: 'errorPage.notFound.message' },
  unauthorized: { title: 'errorPage.unauthorized.title', message: 'errorPage.unauthorized.message' },
  forbidden: { title: 'errorPage.forbidden.title', message: 'errorPage.forbidden.message' },
  timeout: { title: 'errorPage.timeout.title', message: 'errorPage.timeout.message' },
  rateLimited: { title: 'errorPage.rateLimited.title', message: 'errorPage.rateLimited.message' },
  server: { title: 'errorPage.server.title', message: 'errorPage.server.message' },
  badGateway: { title: 'errorPage.badGateway.title', message: 'errorPage.badGateway.message' },
  unavailable: { title: 'errorPage.unavailable.title', message: 'errorPage.unavailable.message' },
  offline: { title: 'errorPage.offline.title', message: 'errorPage.offline.message' },
  chunk: { title: 'errorPage.chunk.title', message: 'errorPage.chunk.message' },
};

/**
 * One way onward.
 *
 * Exactly one of `to` (a router link — only inside the router), `href` (a
 * plain link, for the app-wide boundary) or `onClick`.
 */
export interface ErrorAction {
  label: string;
  primary?: boolean | undefined;
  to?: string | undefined;
  /** Router state to carry with `to`, e.g. where to return after sign-in. */
  state?: unknown;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
}

export interface ErrorPageProps {
  kind: ErrorKind;
  t: Translate;
  /** `undefined` draws the kind's usual numeral; `null` draws none. */
  statusCode?: number | null | undefined;
  /** Overrides for the kind's own wording. Plain text; never an error's message. */
  title?: string | undefined;
  message?: string | undefined;
  /** A correlation id that has already been through `safeReference`. */
  reference?: string | null | undefined;
  actions?: readonly ErrorAction[] | undefined;
  /** Shows the inline search, and receives the trimmed query on submit. */
  onSearch?: ((query: string) => void) | undefined;
  /** Fill the viewport. For errors that replaced the whole app. */
  fullScreen?: boolean | undefined;
}

const ACTION_BASE =
  'inline-flex h-11 min-w-[9rem] cursor-pointer items-center justify-center rounded-full px-6 ' +
  'text-sm font-semibold transition-colors';

const ACTION_PRIMARY = 'bg-brand-fill text-white shadow-card hover:bg-brand-fill-hover';

const ACTION_SECONDARY =
  'border border-border-strong bg-surface text-ink hover:border-border-hover hover:bg-surface-hover';

function ActionButton({ action }: { action: ErrorAction }): React.JSX.Element {
  const className = cx(ACTION_BASE, action.primary === true ? ACTION_PRIMARY : ACTION_SECONDARY);

  if (action.to !== undefined) {
    return (
      <Link to={action.to} state={action.state} className={className}>
        {action.label}
      </Link>
    );
  }

  if (action.href !== undefined) {
    return (
      <a href={action.href} className={className}>
        {action.label}
      </a>
    );
  }

  return (
    <button type="button" onClick={action.onClick} className={className}>
      {action.label}
    </button>
  );
}

function ErrorSearch({
  t,
  onSearch,
}: {
  t: Translate;
  onSearch: (query: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const inputId = useId();

  return (
    <form
      role="search"
      aria-label={t('errorPage.search.label')}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(query.trim());
      }}
      className="mx-auto mt-8 flex w-full max-w-md items-center gap-2 rounded-full border border-border bg-surface p-1.5 shadow-card focus-within:border-brand"
    >
      <label htmlFor={inputId} className="sr-only">
        {t('errorPage.search.label')}
      </label>
      <input
        id={inputId}
        type="search"
        name="q"
        value={query}
        maxLength={200}
        autoComplete="off"
        placeholder={t('errorPage.search.placeholder')}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        className="h-9 min-w-0 flex-1 bg-transparent px-3 text-sm text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
      />
      <button
        type="submit"
        className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-full bg-brand-fill px-4 text-sm font-semibold text-white hover:bg-brand-fill-hover"
      >
        {t('errorPage.search.submit')}
      </button>
    </form>
  );
}

export function ErrorPage({
  kind,
  t,
  statusCode,
  title,
  message,
  reference = null,
  actions = [],
  onSearch,
  fullScreen = false,
}: ErrorPageProps): React.JSX.Element {
  const reduceMotion = usePrefersReducedMotion();
  const code = statusCode === undefined ? DEFAULT_STATUS[kind] : statusCode;
  const copy = COPY[kind];

  return (
    <div
      data-error-kind={kind}
      className={cx(
        'flex w-full flex-col items-center justify-center overflow-hidden px-4 text-center',
        fullScreen
          ? 'min-h-[100dvh] bg-surface py-12 pb-[max(3rem,env(safe-area-inset-bottom))] pt-[max(3rem,env(safe-area-inset-top))]'
          : 'min-h-[60vh] py-16 sm:py-24',
      )}
    >
      <div className="w-full max-w-2xl">
        <GhostScene statusCode={code} reduceMotion={reduceMotion} />

        <div role="alert">
          {code !== null && <p className="sr-only">{t('errorPage.codeLabel', { code })}</p>}
          <h1 className="text-balance text-3xl font-bold tracking-tight text-ink sm:text-5xl">
            {title ?? t(copy.title)}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-base text-ink-muted sm:mt-6 sm:text-lg">
            {message ?? t(copy.message)}
          </p>
        </div>

        {onSearch !== undefined && <ErrorSearch t={t} onSearch={onSearch} />}

        {actions.length > 0 && (
          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:mt-10 sm:flex-row sm:items-center">
            {actions.map((action) => (
              <ActionButton key={action.label} action={action} />
            ))}
          </div>
        )}

        {reference !== null && (
          <p className="mt-10 text-xs text-ink-subtle">
            {t('errorPage.referenceLabel')}{' '}
            <code className="select-all rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-ink-muted">
              {reference}
            </code>
          </p>
        )}
      </div>
    </div>
  );
}
