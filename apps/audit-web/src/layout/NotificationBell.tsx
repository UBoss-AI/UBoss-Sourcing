/**
 * The bell.
 *
 * An auditor's feed: a job assigned, a report returned by QA, a document about
 * to expire, a rule waiting for approval. `GET /audit/notifications` answers
 * `{ items, unread }`, and opening a row marks it read with
 * `POST /audit/notifications/:id/read`.
 *
 * Polled on a slow beat and only while the tab is in front - a new assignment
 * matters within the minute, not within the second, and this runs on every
 * screen.
 *
 * NOT THERE YET IS NOT AN ERROR
 *
 * The feed is being built beside this console. Until the route exists the API
 * answers 404, and the bell then stays quiet - no badge, and a sentence in the
 * panel saying notifications are not available yet - rather than putting an
 * error on every screen.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellIcon } from '@/components/icons';
import { Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { cx } from '@/lib/cx';
import { fetchNotifications, markNotificationRead, notificationsKey } from '@/lib/audit';
import { markAllNotificationsRead } from '@/lib/console-api';
import { formatRelative } from '@/lib/format';

const POLL_INTERVAL_MS = 60_000;

export function NotificationBell(): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const feed = useQuery({
    queryKey: notificationsKey,
    queryFn: fetchNotifications,
    // A missing route will not appear by asking again a second later.
    retry: (failures, error) => !(error instanceof ApiError && error.status === 404) && failures < 2,
    refetchInterval: (query) =>
      query.state.error instanceof ApiError && query.state.error.status === 404
        ? false
        : POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const markRead = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationsKey });
    },
  });

  const markAll = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationsKey });
    },
  });

  // Close on a click outside, and on Escape.
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

  const unavailable = feed.error instanceof ApiError && feed.error.status === 404;
  const unread = feed.data?.unread ?? 0;
  const items = feed.data?.items ?? [];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="relative rounded-md p-2 text-ink-muted hover:bg-surface-hover"
        aria-label={unread > 0 ? `${t('nav.notifications')} (${String(unread)})` : t('nav.notifications')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <BellIcon className="h-5 w-5" />
        {unread > 0 ? (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[0.6rem] font-bold text-white"
            // The count is in the button's accessible name above.
            aria-hidden="true"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t('nav.notifications')}
          className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-ink">{t('nav.notifications')}</p>
            {unread > 0 ? (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-accent-soft disabled:opacity-60"
                disabled={markAll.isPending}
                onClick={() => {
                  markAll.mutate();
                }}
              >
                {t('notifications.markAllRead')}
              </button>
            ) : null}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {feed.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner className="h-5 w-5 text-ink-subtle" />
              </div>
            ) : unavailable ? (
              <p className="px-4 py-8 text-center text-sm text-ink-subtle">
                {t('notifications.unavailable')}
              </p>
            ) : feed.isError ? (
              <p role="alert" className="px-4 py-8 text-center text-sm text-danger">
                {t('notifications.failed')}
              </p>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-ink-subtle">
                {t('notifications.empty')}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((entry) => {
                  const body = (
                    <>
                      <p
                        className={cx(
                          'text-sm',
                          entry.readAt === null ? 'font-semibold text-ink' : 'text-ink-muted',
                        )}
                      >
                        {entry.title}
                      </p>
                      {entry.body === null ? null : (
                        <p className="mt-0.5 truncate text-xs text-ink-subtle">{entry.body}</p>
                      )}
                      <p className="mt-1 text-xxs text-ink-subtle">{formatRelative(entry.createdAt)}</p>
                    </>
                  );

                  const markThisRead = (): void => {
                    if (entry.readAt === null) markRead.mutate(entry.id);
                  };

                  return (
                    <li key={entry.id}>
                      {/* Only a path inside this console is followed; anything
                          else is shown as information. */}
                      {entry.link?.startsWith('/') === true && !entry.link.startsWith('//') ? (
                        <Link
                          to={entry.link}
                          className="block px-4 py-3 hover:bg-surface-hover"
                          onClick={() => {
                            setOpen(false);
                            markThisRead();
                          }}
                        >
                          {body}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className="block w-full px-4 py-3 text-left hover:bg-surface-hover"
                          onClick={markThisRead}
                        >
                          {body}
                        </button>
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
