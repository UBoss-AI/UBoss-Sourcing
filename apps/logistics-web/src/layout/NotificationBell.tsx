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
  const containerRef = useRef<HTMLDivElement>(null);

  const feed = useQuery({
    queryKey: notificationsKey,
    queryFn: fetchNotifications,
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
        {unread > 0 ? (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[0.6rem] font-bold text-white"
            // The count is in the button's own accessible name below, so this
            // is decoration for people who can see it.
            aria-hidden="true"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
        <span className="sr-only">{unread > 0 ? ` (${String(unread)})` : ''}</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t('nav.notifications')}
          className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-ink">{t('nav.notifications')}</p>
            {unread > 0 ? (
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
                      <p className="mt-1 text-xxs text-ink-subtle">
                        {formatRelative(entry.createdAt)}
                      </p>
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
