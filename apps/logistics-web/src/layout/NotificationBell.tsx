/**
 * The bell.
 *
 * A carrier's feed: assignments offered, exceptions raised, SLA warnings, a
 * proof of delivery that landed. Deduplicated on the server, so a carrier
 * redelivering the same tracking event twice does not ring this twice.
 *
 * Polled on a slow beat and only while the tab is in front. A dispatcher wants
 * to know about a new assignment within the minute, not within the second, and
 * this runs on every screen in the portal - a tighter interval would multiply
 * into real load on a self-hosted box for no operational gain.
 *
 * TWO KINDS OF ROW, AND THEY LEAVE IN DIFFERENT WAYS
 *
 * "Collected" and "out for delivery" are news: true forever, and over once
 * somebody has read them. A failed delivery or a cold-chain excursion is a
 * problem: it stays in the list until the parcel moves again or the exception
 * is closed, whether or not anybody has looked. So the badge counts unread
 * news PLUS live problems, which is the same rule the marketplace's own
 * console follows - and a dispatcher pressing "mark all read" no longer makes
 * a delivery failure disappear.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellIcon } from '@/components/icons';
import { Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { fetchNotifications, markNotificationsRead, notificationsKey } from '@/lib/logistics';
import { formatRelative } from '@/lib/format';

const POLL_INTERVAL_MS = 60_000;

export function NotificationBell(): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'active' | 'resolved'>('active');
  const containerRef = useRef<HTMLDivElement>(null);

  const feed = useQuery({
    // The view is part of the key: the history is a different query with a
    // different ordering, not a subset of this list.
    queryKey: [...notificationsKey, view],
    queryFn: () => fetchNotifications(view),
    refetchInterval: POLL_INTERVAL_MS,
    // Only while the tab is in front. A depot leaves this open all night.
    refetchIntervalInBackground: false,
  });

  const markRead = useMutation({
    mutationFn: (ids?: string[]) => markNotificationsRead(ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationsKey });
    },
  });

  // Close on a click outside, and on Escape. A popover that traps the page is
  // worse than no popover.
  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current?.contains(event.target as Node) === false) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const unread = feed.data?.unreadCount ?? 0;
  const openAlerts = feed.data?.openAlertCount ?? 0;

  /**
   * The badge, and it is deliberately not the unread count any more.
   *
   * Unread news plus live problems, computed on the server. A delivery failure
   * somebody read this morning is still a delivery failure; a badge that
   * dropped when they glanced at it would be a badge that hid one.
   */
  const waiting = feed.data?.activeCount ?? 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="relative rounded-md p-2 text-ink-muted hover:bg-surface-hover"
        aria-label={t('nav.notifications')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <BellIcon className="h-5 w-5" />
        {waiting > 0 ? (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[0.6rem] font-bold text-white"
            // The count is in the button's own accessible name below, so this
            // is decoration for people who can see it.
            aria-hidden="true"
          >
            {waiting > 99 ? '99+' : waiting}
          </span>
        ) : null}
        <span className="sr-only">{waiting > 0 ? ` (${String(waiting)})` : ''}</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t('nav.notifications')}
          className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        >
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-ink">{t('nav.notifications')}</p>
              {view === 'active' && unread > 0 ? (
                <button
                  type="button"
                  className="text-xs font-medium text-brand hover:underline"
                  onClick={() => {
                    markRead.mutate(undefined);
                  }}
                >
                  {t('toast.dismiss')}
                </button>
              ) : null}
            </div>

            {/*
              Two halves rather than one list with closed rows in it. The bell
              has to stay short enough to read at a loading bay; the history is
              for the question that comes later - "what happened to that one?"
            */}
            <div role="tablist" aria-label={t('nav.notifications')} className="mt-2 flex gap-1">
              {(['active', 'resolved'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={view === tab}
                  className={cx(
                    'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                    view === tab
                      ? 'bg-brand-soft text-brand'
                      : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                  )}
                  onClick={() => {
                    setView(tab);
                  }}
                >
                  {tab === 'active'
                    ? openAlerts > 0
                      ? t('notifications.tabOpenWithCount', { count: openAlerts })
                      : t('notifications.tabOpen')
                    : t('notifications.tabResolved')}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {feed.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner className="h-5 w-5 text-ink-subtle" />
              </div>
            ) : (feed.data?.notifications.length ?? 0) === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-ink-subtle">
                {t('common.nothingHereYet')}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {feed.data?.notifications.map((entry) => {
                  const isLiveAlert = entry.class === 'ALERT' && entry.status === 'ACTIVE';

                  const body = (
                    <>
                      <p
                        className={cx(
                          'text-sm',
                          // A live problem is emphasised whether or not it has
                          // been read, because reading it changed nothing
                          // about it.
                          isLiveAlert
                            ? 'font-semibold text-danger'
                            : entry.readAt === null
                              ? 'font-semibold text-ink'
                              : 'text-ink-muted',
                        )}
                      >
                        {entry.title}
                        {isLiveAlert ? (
                          <span className="sr-only"> ({t('notifications.stillOpen')})</span>
                        ) : null}
                      </p>
                      {entry.body === null ? null : (
                        <p className="mt-0.5 truncate text-xs text-ink-subtle">{entry.body}</p>
                      )}
                      <p className="mt-1 text-xxs text-ink-subtle">
                        {formatRelative(entry.createdAt)}
                      </p>

                      {/* Why it stopped being a problem, kept with the row -
                          which is the reason a closed alert is retained rather
                          than deleted. */}
                      {entry.status !== 'ACTIVE' && entry.resolutionReason !== null ? (
                        <p className="mt-1 rounded border border-border bg-surface-sunken px-2 py-1 text-xxs leading-relaxed text-ink-muted">
                          {entry.resolutionReason}
                        </p>
                      ) : null}
                    </>
                  );

                  return (
                    <li key={entry.id}>
                      {entry.shipmentId === null ? (
                        <div className="px-4 py-3">{body}</div>
                      ) : (
                        <Link
                          to={`/shipments/${entry.shipmentId}`}
                          className="block px-4 py-3 hover:bg-surface-hover"
                          onClick={() => {
                            setOpen(false);
                            markRead.mutate([entry.id]);
                          }}
                        >
                          {body}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
