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
import { formatRelative, humanise } from '@/lib/format';
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

/**
 * A consignment has gone wrong somewhere.
 *
 * Carries `logistics.read` on the backend, because the row names a customer's
 * company and what happened to their delivery. The link goes to the
 * consignment, which is where the timeline and the carrier are - there is no
 * useful action on the bell itself, and a row that only says "something
 * happened" is a row people learn to dismiss.
 */
const LOGISTICS_EXCEPTION_RAISED = 'logistics.exception.raised';

/**
 * A seller attached a certificate or a licence for the marketplace to accept.
 *
 * Carries `customer.read` on the backend, the same grant the seller queue is
 * behind: the row names a business and what it is trying to prove about itself.
 * The link goes to that seller's screen, which is where the Accept and Send
 * back buttons are - the bell is the prompt, not the decision.
 */
const SELLER_DOCUMENT_UPLOADED = 'seller.document.uploaded';

/**
 * Somebody exercised a data-subject right.
 *
 * An ALERT rather than news, because a statutory clock is running on it.
 * Carries `data_request.read` on the backend: that a named individual has
 * asked to be erased is its own piece of information, and not everyone who
 * may look a customer up should be told it unprompted.
 */
const DATA_REQUEST_RAISED = 'data_request.raised';

/** A consignment could not be delivered. Clears when the parcel moves again. */
const LOGISTICS_DELIVERY_FAILED = 'logistics.delivery_failed';

/** Nobody has picked a consignment up. The one alert a person may close. */
const LOGISTICS_SHIPMENT_UNASSIGNED = 'logistics.shipment.unassigned';

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

  if (notification.kind === LOGISTICS_EXCEPTION_RAISED) {
    const severity = textVariable(variables, 'severity', 'MEDIUM');

    return {
      /*
       * The severity is in the sentence rather than only in a colour, because
       * this row is read in a dropdown that has no room for a badge and by
       * people who cannot see one. CRITICAL gets its own wording - a cold
       * chain break is not "an exception", it is a consignment somebody has
       * to deal with now.
       */
      title:
        severity === 'CRITICAL'
          ? t('notifications.logisticsException.critical', {
              shipmentReference: textVariable(variables, 'shipmentReference', '—'),
            })
          : t('notifications.logisticsException.title', {
              shipmentReference: textVariable(variables, 'shipmentReference', '—'),
            }),
      detail: t('notifications.logisticsException.detail', {
        exceptionType: humanise(textVariable(variables, 'exceptionType', '—')),
        receivingCompany: textVariable(variables, 'receivingCompany', '—'),
      }),
    };
  }

  if (notification.kind === SELLER_DOCUMENT_UPLOADED) {
    return {
      title: t('notifications.sellerDocumentUploaded.title', {
        sellerName: textVariable(variables, 'sellerName', '—'),
        documentKind: textVariable(variables, 'documentKind', '—'),
      }),
      detail: t('notifications.sellerDocumentUploaded.detail', {
        fileName: textVariable(variables, 'fileName', '—'),
      }),
    };
  }

  if (notification.kind === DATA_REQUEST_RAISED) {
    return {
      title: t('notifications.dataRequest.title', {
        type: humanise(textVariable(variables, 'type', '—')),
      }),
      // The address rather than a name: this row is what an operator uses to
      // find the request, and the request is keyed on the address.
      detail: t('notifications.dataRequest.detail', {
        email: textVariable(variables, 'email', '—'),
      }),
    };
  }

  if (notification.kind === LOGISTICS_DELIVERY_FAILED) {
    return {
      title: t('notifications.deliveryFailed.title', {
        shipmentReference: textVariable(variables, 'shipmentReference', '—'),
      }),
      detail: t('notifications.deliveryFailed.detail', {
        receivingCompany: textVariable(variables, 'receivingCompany', '—'),
        attemptCount: numberVariable(variables, 'attemptCount'),
      }),
    };
  }

  if (notification.kind === LOGISTICS_SHIPMENT_UNASSIGNED) {
    return {
      title: t('notifications.shipmentUnassigned.title', {
        shipmentReference: textVariable(variables, 'shipmentReference', '—'),
      }),
      detail: t('notifications.shipmentUnassigned.detail', {
        receivingCompany: textVariable(variables, 'receivingCompany', '—'),
        waitingHours: numberVariable(variables, 'waitingHours'),
      }),
    };
  }

  return { title: t('notifications.unrecognised', { kind: notification.kind }), detail: null };
}

/**
 * One row.
 *
 * Three shapes rather than one, because the row has to say which of three
 * things it is without the reader having to work it out: a piece of news, a
 * problem that is still a problem, or a problem that is over. The mark down
 * the left is what carries that - a hollow dot for unread news, a filled
 * warning dot for a live alert, a tick for a resolved one - and every one of
 * them is also stated in words for whoever cannot see it.
 *
 * The actions hang off the row rather than opening a menu, because there are
 * at most two of them and a bell is not a place to go hunting.
 */
function NotificationRow({
  notification,
  onOpen,
  onDismiss,
  onResolve,
  isBusy,
}: {
  notification: ConsoleNotification;
  onOpen: (notification: ConsoleNotification) => void;
  onDismiss: (notification: ConsoleNotification) => void;
  onResolve: (notification: ConsoleNotification) => void;
  isBusy: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const phrase = describe(notification, t);

  const isAlert = notification.class === 'ALERT';
  const isResolved = notification.status !== 'ACTIVE';
  const isLiveAlert = isAlert && !isResolved;

  const body = (
    <>
      {/* The mark. A dot rather than a bold row: bold is already doing the
          work of the sentence, and two weights of emphasis in a 20-row list
          reads as noise. A live alert gets a warning colour because it is the
          one thing on this list that is still wrong. */}
      <span
        aria-hidden="true"
        className={cx(
          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
          isResolved
            ? 'bg-transparent ring-1 ring-success'
            : isLiveAlert
              ? 'bg-danger-fill'
              : notification.isRead
                ? 'bg-transparent'
                : 'bg-accent',
        )}
      />

      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-snug text-ink">
          {phrase.title}
          {/* Everything the dot says, said again for a reader who cannot see
              it. "New" alone was enough while every row was news; it is not
              enough now that a row can be an unfixed problem. */}
          {isLiveAlert && <span className="sr-only"> ({t('notifications.stillOpen')})</span>}
          {isResolved && <span className="sr-only"> ({t('notifications.resolved')})</span>}
          {!isAlert && !notification.isRead && (
            <span className="sr-only"> ({t('notifications.new')})</span>
          )}
        </span>

        {phrase.detail !== null && (
          <span className="mt-0.5 block text-xs text-ink-muted">{phrase.detail}</span>
        )}

        {/* A problem that has come back says so. Without this, the second
            occurrence is indistinguishable from the first and nobody learns
            that it was fixed once already. */}
        {notification.occurrence > 1 && (
          <span className="mt-0.5 block text-xxs font-medium text-warning">
            {t('notifications.occurrence', { count: notification.occurrence })}
          </span>
        )}

        <span className="mt-0.5 block text-xxs text-ink-subtle">
          {formatRelative(notification.createdAt)}
        </span>

        {/* The history line. Who closed it, when and why - which is the whole
            reason a resolved alert is kept rather than deleted. */}
        {isResolved && notification.resolvedAt !== null && (
          <span className="mt-1 block rounded border border-border-subtle bg-surface-sunken px-2 py-1 text-xxs leading-relaxed text-ink-muted">
            <span className="block font-medium text-ink">
              {notification.resolvedBy === null
                ? t('notifications.resolvedBySystem', {
                    when: formatRelative(notification.resolvedAt),
                  })
                : t('notifications.resolvedByPerson', {
                    who: notification.resolvedBy,
                    when: formatRelative(notification.resolvedAt),
                  })}
            </span>
            {notification.resolutionReason !== null && (
              <span className="block">{notification.resolutionReason}</span>
            )}
          </span>
        )}
      </span>
    </>
  );

  const className = cx(
    'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors',
    isResolved
      ? 'bg-surface'
      : isLiveAlert
        ? 'bg-danger-soft/25'
        : notification.isRead
          ? 'bg-surface'
          : 'bg-accent-soft/30',
  );

  const content =
    notification.linkPath === null ? (
      <div className={className}>{body}</div>
    ) : (
      <Link
        to={notification.linkPath}
        onClick={() => {
          onOpen(notification);
        }}
        className={cx(className, 'hover:bg-surface-hover')}
      >
        {body}
      </Link>
    );

  // Only a LIVE alert has anything to act on. News clears itself by being
  // read, and a resolved alert is a record.
  if (!isLiveAlert) return <li>{content}</li>;

  return (
    <li>
      {content}
      {/* Reached only for a live alert - everything else returned above - so
          the strip carries the same tint as the row it belongs to. */}
      <div className="flex items-center justify-end gap-3 bg-danger-soft/25 px-3 pb-2 text-xxs">
        <button
          type="button"
          onClick={() => {
            onDismiss(notification);
          }}
          disabled={isBusy}
          className="rounded font-medium text-ink-muted underline-offset-2 transition-colors hover:text-ink hover:underline disabled:opacity-60"
        >
          {t('notifications.hideForMe')}
        </button>

        {/* Offered only where the server said a person may genuinely close it.
            Every other alert clears when the thing it describes is dealt
            with, and a button here would be a way to hide it instead. */}
        {notification.canResolveManually && (
          <button
            type="button"
            onClick={() => {
              onResolve(notification);
            }}
            disabled={isBusy}
            className="rounded font-semibold text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline disabled:opacity-60"
          >
            {t('notifications.resolveAction')}
          </button>
        )}
      </div>
    </li>
  );
}

/** Which half of the feed the panel is showing. */
type FeedView = 'active' | 'resolved';

export function NotificationBell(): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<FeedView>('active');
  /**
   * The alert a Resolve was pressed on, waiting for its reason.
   *
   * Held rather than resolved immediately, because a manual closure without an
   * explanation is what makes an alert log worthless six months later:
   * somebody closed it, nobody knows what they did, and the next person has to
   * work out from scratch whether the problem is still there.
   */
  const [resolving, setResolving] = useState<ConsoleNotification | null>(null);
  const [reason, setReason] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const query = useQuery({
    // The view is in the key, so switching to the history fetches it rather
    // than filtering rows the server already narrowed - the history is a
    // different query with a different ordering, not a subset of this one.
    queryKey: [...QUERY_KEY, view],
    queryFn: () =>
      api.get<ConsoleNotificationFeed>('/admin/notifications', {
        query: { limit: FEED_LIMIT, view },
      }),
    refetchInterval: POLL_INTERVAL_MS,
    // A background tab polling every minute is a background tab burning a
    // connection for a badge nobody is looking at.
    refetchIntervalInBackground: false,
  });

  /**
   * Refresh both halves, not only the one on screen.
   *
   * Resolving an alert moves it from one to the other, so invalidating the
   * open list alone would leave the history showing the state before the
   * thing that was just closed. The prefix key covers both.
   */
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

  /**
   * Hide a row from this person's own bell.
   *
   * Silent like marking read, and for the same reason - it changes nothing
   * except what one person is looking at. Emphatically not a resolution: the
   * problem is exactly as unsolved as it was, everybody else still sees it,
   * and the API says so by being a different endpoint rather than a flag.
   */
  const dismiss = useMutation({
    mutationFn: (notificationIds: string[]) =>
      api.post<{ dismissed: number }>('/admin/notifications/dismiss', { notificationIds }),
    onSuccess: invalidate,
  });

  /**
   * Close an alert, with a reason.
   *
   * The error IS shown, unlike the two above. A refused resolution is the
   * server saying "this one clears itself when the thing is dealt with" and
   * naming where to go; swallowing that would leave somebody pressing a button
   * that silently does nothing.
   */
  const resolve = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      api.post<ConsoleNotification>(`/admin/notifications/${input.id}/resolve`, {
        reason: input.reason,
      }),
    onSuccess: async () => {
      setResolving(null);
      setReason('');
      await invalidate();
    },
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
  const openAlertCount = query.data?.openAlertCount ?? 0;

  /**
   * The badge count, and it is deliberately not `unreadCount` any more.
   *
   * The server computes it against the documented active-alert rule: unread
   * news plus live problems. An alert somebody read this morning is still a
   * problem, and a badge that dropped when they glanced at it would be a badge
   * that hid one. See the header of
   * `backend/src/modules/notifications/admin-notification.service.ts`.
   *
   * The server returns it on every call whichever view was asked for, so the
   * badge keeps describing what is waiting while somebody reads through the
   * history rather than going blank the moment they switch tab.
   */
  const badgeCount = query.data?.activeCount ?? 0;

  const handleOpenRow = (notification: ConsoleNotification): void => {
    setIsOpen(false);
    if (!notification.isRead) markRead.mutate([notification.id]);
  };

  const handleDismiss = (notification: ConsoleNotification): void => {
    dismiss.mutate([notification.id]);
  };

  const handleResolve = (notification: ConsoleNotification): void => {
    setResolving(notification);
    setReason('');
  };

  // The caret follows the button that opened the box. Without this a keyboard
  // user presses Resolve and has to tab back through the whole list to reach
  // the field that appeared because of them.
  useEffect(() => {
    if (resolving !== null) reasonRef.current?.focus();
  }, [resolving]);

  const isBusy = dismiss.isPending || resolve.isPending;

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
          badgeCount > 0
            ? `${t('notifications.openLabel')} — ${t('notifications.waitingBadge', { count: badgeCount })}`
            : t('notifications.openLabel')
        }
        className={cx(
          'relative flex h-10 w-10 items-center justify-center rounded-md border border-transparent',
          'text-ink-muted transition-colors hover:border-border hover:bg-surface-hover hover:text-ink',
          isOpen && 'border-border bg-surface-hover text-ink',
        )}
      >
        <BellIcon className="h-[1.15rem] w-[1.15rem]" />

        {badgeCount > 0 && (
          <span
            aria-hidden="true"
            className={cx(
              'absolute -right-0.5 -top-0.5 flex h-[1.05rem] min-w-[1.05rem] items-center',
              'justify-center rounded-full bg-danger-fill px-1 text-xxs font-semibold leading-none',
              'text-white ring-2 ring-surface',
            )}
          >
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label={t('notifications.title')}
          className="absolute right-0 z-40 mt-1.5 w-[22rem] max-w-[calc(100vw-1.5rem)] animate-fade-in rounded-lg border border-border bg-surface shadow-popover"
        >
          <header className="border-b border-border px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink">{t('notifications.title')}</h2>

              {view === 'active' && unreadCount > 0 && (
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
            </div>

            {/*
              Two halves, not a filter.

              The bell shows what is waiting; the history shows what was closed,
              who closed it and why. Keeping them apart is what lets the first
              one be short enough to read - and a resolved alert that stayed in
              the list would put the panel back where it started, with problems
              nobody can clear.
            */}
            <div role="tablist" aria-label={t('notifications.title')} className="mt-2 flex gap-1">
              {(['active', 'resolved'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={view === tab}
                  onClick={() => {
                    setView(tab);
                  }}
                  className={cx(
                    'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                    view === tab
                      ? 'bg-accent-soft text-accent'
                      : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                  )}
                >
                  {tab === 'active'
                    ? openAlertCount > 0
                      ? t('notifications.tabOpenWithCount', { count: openAlertCount })
                      : t('notifications.tabOpen')
                    : t('notifications.tabResolved')}
                </button>
              ))}
            </div>
          </header>

          <div className="max-h-[24rem] overflow-y-auto">
            {query.isPending && (
              <p className="px-3 py-6 text-center text-xs text-ink-muted">{t('common.loading')}</p>
            )}

            {query.isError && (
              <div className="px-3 py-6 text-center">
                <p className="text-xs text-danger">{t('notifications.loadFailed')}</p>
                <button
                  type="button"
                  onClick={() => {
                    void query.refetch();
                  }}
                  className="mt-2 rounded text-xs font-medium text-accent underline-offset-2 hover:underline"
                >
                  {t('common.retry')}
                </button>
              </div>
            )}

            {query.data !== undefined && items.length === 0 && (
              <div className="px-3 py-6 text-center">
                <p className="text-sm font-medium text-ink">
                  {view === 'resolved'
                    ? t('notifications.historyEmpty')
                    : t('notifications.empty')}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  {view === 'resolved'
                    ? t('notifications.historyEmptyDescription')
                    : t('notifications.emptyDescription')}
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
                    onDismiss={handleDismiss}
                    onResolve={handleResolve}
                    isBusy={isBusy}
                  />
                ))}
              </ul>
            )}
          </div>

          {/*
            The reason, asked for before the alert closes.

            Inline rather than a modal on top of a popover, which would be two
            layers of overlay for one sentence of input. It replaces the list
            while it is open so there is exactly one thing to answer.
          */}
          {resolving !== null && (
            <div className="border-t border-border bg-surface-sunken px-3 py-3">
              <label
                htmlFor="notification-resolve-reason"
                className="block text-xs font-semibold text-ink"
              >
                {t('notifications.resolveReasonLabel')}
              </label>
              <p className="mt-0.5 text-xxs leading-relaxed text-ink-muted">
                {t('notifications.resolveReasonHint')}
              </p>

              {/*
                Focused on mount through a ref rather than `autoFocus`.

                The box appears because somebody pressed Resolve, so moving the
                caret into it is following their intent rather than stealing
                focus - but `autoFocus` also fires on hydration and on any
                remount, which is what the accessibility rule against it is
                really about. A ref fires exactly when this panel opens.
              */}
              <textarea
                id="notification-resolve-reason"
                ref={reasonRef}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
                rows={2}
                maxLength={512}
                className="mt-1.5 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
              />

              {resolve.isError && (
                <p role="alert" className="mt-1.5 text-xxs leading-relaxed text-danger">
                  {resolve.error instanceof Error
                    ? resolve.error.message
                    : t('common.somethingWentWrong')}
                </p>
              )}

              <div className="mt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setResolving(null);
                    setReason('');
                    resolve.reset();
                  }}
                  className="rounded text-xs font-medium text-ink-muted hover:text-ink"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    resolve.mutate({ id: resolving.id, reason: reason.trim() });
                  }}
                  // Four characters, the same floor the endpoint enforces. A
                  // reason of "ok" explains nothing to whoever reads this in
                  // six months.
                  disabled={reason.trim().length < 4 || resolve.isPending}
                  className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
                >
                  {t('notifications.resolveAction')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
