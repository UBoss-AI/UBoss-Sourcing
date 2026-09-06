/**
 * The console bell.
 *
 * This replaced the "needs attention" panel that used to sit at the top of the
 * dashboard. The reasoning: something you must be told about is something you
 * must be told about wherever you happen to be standing. A panel on one screen
 * only works for the person who happens to have that screen open, and the
 * people who run a shop spend their day on Orders and Inventory.
 *
 * Four decisions worth keeping:
 *
 *   - **Opening it does not clear it.** The badge goes down when a row is
 *     opened or when "mark all as read" is pressed, not when the panel is
 *     glanced at. A bell that empties itself the moment you look at it loses
 *     the one order you were about to deal with before the phone rang.
 *   - **Read state is the caller's.** Several people share one console; the
 *     backend keeps a read row per person, so clearing your badge leaves
 *     everyone else's alone.
 *   - **The sentence is built here, not sent.** The API sends what happened
 *     and the values involved; the phrasing comes out of the same catalogue as
 *     the rest of the interface, so the bell speaks whichever of the eight
 *     languages the reader picked.
 *   - **A kind this build does not know is still shown.** A panel one deploy
 *     behind the API must say "something happened" rather than silently drop
 *     it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { formatRelative } from '@/lib/format';
import type { ConsoleNotification, ConsoleNotificationFeed } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/**
 * Kinds this build knows how to phrase. Mirrors `AdminNotificationKind` in
 * backend/src/modules/notifications/admin-notification.service.ts - anything
 * not listed here falls through to the generic line.
 */
const ORDER_PLACED = 'order.placed';

/**
 * A member of staff opened the console, and where from.
 *
 * Carries `staff.read` on the backend, so most people never see these rows -
 * which is the point. They are here for whoever is responsible for the accounts
 * to glance at, and a sign-in from a place nobody works is the thing they are
 * looking for.
 */
const ADMIN_SIGNED_IN = 'admin.signed_in';

/**
 * Somebody signed themselves up on the storefront and confirmed their email.
 *
 * Carries `customer.read` on the backend - it names a person and their contact
 * details. Where sign-ups are reviewed, this row is the queue: it links to the
 * customer, where the Approve button is.
 */
const CUSTOMER_REGISTERED = 'customer.registered';

/** One page of the feed. Deliberately short: this is a bell, not the audit log. */
const FEED_LIMIT = 20;

/**
 * How often the badge refreshes itself.
 *
 * A minute, and only while the tab is in front. An order placed now is worth
 * knowing about within the minute and not within the second, and this poll
 * runs on every page in the panel - a tighter interval would multiply into
 * real load on a self-hosted box for no operational gain.
 */
const POLL_INTERVAL_MS = 60_000;

const QUERY_KEY = ['console-notifications'] as const;

/**
 * Variables cross the wire as JSON, so they arrive as `unknown` however
 * carefully the backend typed them. Narrowing to the primitives the contract
 * promises is what keeps a malformed row rendering as a dash rather than as
 * "[object Object]".
 */
function textVariable(variables: Record<string, unknown>, key: string, fallback: string): string {
  const value = variables[key];
  if (typeof value === 'string') return value === '' ? fallback : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return fallback;
}

function numberVariable(variables: Record<string, unknown>, key: string): number {
  const value = variables[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface Phrase {
  title: string;
  detail: string | null;
}

function describe(
  notification: ConsoleNotification,
  t: ReturnType<typeof useI18n>['t'],
): Phrase {
  const variables = notification.variables;

  if (notification.kind === ORDER_PLACED) {
    const customerName = textVariable(variables, 'customerName', '—');
    const itemName = textVariable(variables, 'itemName', '—');
    const extraCount = numberVariable(variables, 'extraCount');

    return {
      title:
        extraCount > 0
          ? t('notifications.orderPlaced.many', { customerName, itemName, extraCount })
          : t('notifications.orderPlaced.one', { customerName, itemName }),
      detail: t('notifications.orderPlaced.detail', {
        orderNumber: textVariable(variables, 'orderNumber', '—'),
        orderTotal: textVariable(variables, 'orderTotal', '—'),
      }),
    };
  }

  if (notification.kind === CUSTOMER_REGISTERED) {
    const variables = notification.variables;
    const fullName = textVariable(variables, 'fullName', '—');
    const country = textVariable(variables, 'country', '—');
    const awaiting = variables.requiresApproval === true;

    return {
      title: awaiting
        ? t('notifications.customerRegistered.awaiting', { fullName })
        : t('notifications.customerRegistered.title', { fullName }),
      detail: t('notifications.customerRegistered.detail', {
        email: textVariable(variables, 'email', '—'),
        phone: textVariable(variables, 'phone', '—'),
        country,
      }),
    };
  }

  if (notification.kind === ADMIN_SIGNED_IN) {
    // `place` is the geocoded name when a lookup was possible and the
    // coordinates when it was not, so this line always says somewhere.
    const place = textVariable(variables, 'place', '—');
    const accuracyM = numberVariable(variables, 'accuracyM');

    return {
      title: t('notifications.adminSignedIn.title', {
        email: textVariable(variables, 'email', '—'),
        place,
      }),
      // The coordinates repeat under the place rather than replacing it: a
      // reverse-geocoded name is a guess at a street, and the pair is what
      // anybody checking an unexpected sign-in actually needs. The radius goes
      // beside them so a 2km wifi fix is not read as a doorstep.
      detail:
        accuracyM > 0
          ? t('notifications.adminSignedIn.detailAccurate', {
              latitude: textVariable(variables, 'latitude', '—'),
              longitude: textVariable(variables, 'longitude', '—'),
              accuracyM: Math.round(accuracyM),
            })
          : t('notifications.adminSignedIn.detail', {
              latitude: textVariable(variables, 'latitude', '—'),
              longitude: textVariable(variables, 'longitude', '—'),
            }),
    };
  }

  return { title: t('notifications.unrecognised', { kind: notification.kind }), detail: null };
}

/** One row. A link when it leads somewhere, plain text when it does not. */
function NotificationRow({
  notification,
  onOpen,
}: {
  notification: ConsoleNotification;
  onOpen: (notification: ConsoleNotification) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const phrase = describe(notification, t);

  const body = (
    <>
      {/* The unread mark. A dot rather than a bold row: bold is already doing
          the work of the sentence, and two weights of emphasis in a 20-row
          list reads as noise. */}
      <span
        aria-hidden="true"
        className={cx(
          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
          notification.isRead ? 'bg-transparent' : 'bg-accent',
        )}
      />

      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-snug text-ink">
          {phrase.title}
          {!notification.isRead && <span className="sr-only"> ({t('notifications.new')})</span>}
        </span>
        {phrase.detail !== null && (
          <span className="mt-0.5 block text-xs text-ink-muted">{phrase.detail}</span>
        )}
        <span className="mt-0.5 block text-xxs text-ink-subtle">
          {formatRelative(notification.createdAt)}
        </span>
      </span>
    </>
  );

  const className = cx(
    'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors',
    notification.isRead ? 'bg-surface' : 'bg-accent-soft/30',
  );

  if (notification.linkPath === null) {
    return (
      <li>
        <div className={className}>{body}</div>
      </li>
    );
  }

  return (
    <li>
      <Link
        to={notification.linkPath}
        onClick={() => {
          onOpen(notification);
        }}
        className={cx(className, 'hover:bg-surface-hover')}
      >
        {body}
      </Link>
    </li>
  );
}

export function NotificationBell(): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () =>
      api.get<ConsoleNotificationFeed>('/admin/notifications', { query: { limit: FEED_LIMIT } }),
    refetchInterval: POLL_INTERVAL_MS,
    // A background tab polling every minute is a background tab burning a
    // connection for a badge nobody is looking at.
    refetchIntervalInBackground: false,
  });

  const invalidate = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  // Marking read is deliberately silent - no toast, no error state. It is a
  // side effect of reading something, and a failed one costs the reader
  // nothing but a badge that clears on the next click.
  const markRead = useMutation({
    mutationFn: (notificationIds: string[]) =>
      api.post<{ marked: number }>('/admin/notifications/read', { notificationIds }),
    onSuccess: invalidate,
  });

  const markAllRead = useMutation({
    mutationFn: () => api.post<{ marked: number }>('/admin/notifications/read-all'),
    onSuccess: invalidate,
  });

  // Close on an outside click or Escape - the same contract as the account
  // menu beside it. Without the Escape handler a keyboard user who opens the
  // panel has no way back out of it.
  useEffect(() => {
    if (!isOpen) return undefined;

    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current?.contains(event.target as Node) !== true) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const items = query.data?.items ?? [];
  const unreadCount = query.data?.unreadCount ?? 0;

  const handleOpenRow = (notification: ConsoleNotification): void => {
    setIsOpen(false);
    if (!notification.isRead) markRead.mutate([notification.id]);
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        // The count belongs in the accessible name, not only in the badge:
        // "Notifications" alone tells a screen-reader user nothing about
        // whether it is worth opening.
        aria-label={
          unreadCount > 0
            ? `${t('notifications.openLabel')} — ${t('notifications.unreadBadge', { count: unreadCount })}`
            : t('notifications.openLabel')
        }
        className={cx(
          'relative flex h-10 w-10 items-center justify-center rounded-md border border-transparent',
          'text-ink-muted transition-colors hover:border-border hover:bg-surface-hover hover:text-ink',
          isOpen && 'border-border bg-surface-hover text-ink',
        )}
      >
        <BellIcon className="h-[1.15rem] w-[1.15rem]" />

        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className={cx(
              'absolute -right-0.5 -top-0.5 flex h-[1.05rem] min-w-[1.05rem] items-center',
              'justify-center rounded-full bg-danger px-1 text-xxs font-semibold leading-none',
              'text-white ring-2 ring-surface',
            )}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label={t('notifications.title')}
          className="absolute right-0 z-40 mt-1.5 w-[22rem] max-w-[calc(100vw-1.5rem)] animate-fade-in rounded-lg border border-border bg-surface shadow-popover"
        >
          <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
            <h2 className="text-sm font-semibold text-ink">{t('notifications.title')}</h2>

            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  markAllRead.mutate();
                }}
                disabled={markAllRead.isPending}
                className="rounded text-xs font-medium text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline disabled:opacity-60"
              >
                {t('notifications.markAllRead')}
              </button>
            )}
          </header>

          <div className="max-h-[24rem] overflow-y-auto">
            {query.isPending && (
              <p className="px-3 py-6 text-center text-xs text-ink-muted">{t('common.loading')}</p>
            )}

            {query.isError && (
              <p className="px-3 py-6 text-center text-xs text-danger">
                {t('notifications.loadFailed')}
              </p>
            )}

            {query.data !== undefined && items.length === 0 && (
              <div className="px-3 py-6 text-center">
                <p className="text-sm font-medium text-ink">{t('notifications.empty')}</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  {t('notifications.emptyDescription')}
                </p>
              </div>
            )}

            {items.length > 0 && (
              <ul className="divide-y divide-border-subtle">
                {items.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onOpen={handleOpenRow}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
