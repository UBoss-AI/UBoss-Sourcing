/**
 * The Seller Hub bell.
 *
 * Same reasoning as the console's, which this is modelled on: something a
 * seller must be told about is something they must be told about wherever they
 * happen to be standing. A page that only says it on the dashboard works for
 * whoever has the dashboard open, and a seller spends their day on Orders and
 * Listings.
 *
 * FOUR DECISIONS, ALL BORROWED FROM THE CONSOLE BELL BECAUSE THEY WERE RIGHT
 *
 *   - **Opening it does not clear it.** The badge falls when a row is opened,
 *     not when the panel is glanced at. A bell that empties itself the moment
 *     you look at it loses the one order you were about to deal with before
 *     the phone rang.
 *   - **Read state is the reader's.** A seller with twelve staff would
 *     otherwise get twelve copies of every event; the backend keeps a read
 *     entry per member, so clearing your badge leaves everyone else's alone.
 *   - **A kind this build does not know is still shown.** The server sends the
 *     title and the body already written, so a Hub one deploy behind the API
 *     shows the row rather than dropping it.
 *   - **The badge counts PROBLEMS, not news.** See below - it is the one place
 *     this differs from a naive unread count, and it is the difference between
 *     a badge that reaches zero and one that never does.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import { fetchNotifications, markNotificationRead, type SellerNotification } from '@/lib/seller';

/**
 * The console's bell, glyph for glyph.
 *
 * Copied from `admin-web/src/components/icons.tsx` rather than drawn again -
 * same two paths, same 1.7 stroke, same round caps and joins. The two
 * applications do not share a component library, so the only way the same idea
 * looks like the same idea in both is for this to be the same geometry; a
 * second, similar bell is how one product ends up looking like two.
 */
function BellIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8.6a6 6 0 1 0-12 0c0 5.2-1.8 6.6-1.8 6.6h15.6S18 13.8 18 8.6" />
      <path d="M13.7 18.6a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

/**
 * What the badge counts.
 *
 * An ALERT that is still ACTIVE and this reader has not opened. Deliberately
 * NOT "unread", which would include every "a customer placed an order" and
 * leave a permanent number on the bell that nobody can clear by doing
 * anything - at which point people stop reading it, which is the only failure
 * mode a notification system really has.
 *
 * A resolved alert still appears in the panel. It is simply not counted: the
 * carrier accepted after all, and the seller can read that once and move on.
 */
function isCounted(notification: SellerNotification): boolean {
  return (
    notification.notificationClass === 'ALERT' &&
    notification.status === 'ACTIVE' &&
    !notification.isRead
  );
}

export function SellerNotificationBell(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();

  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const query = useQuery({ queryKey: ['seller', 'notifications'], queryFn: fetchNotifications });

  const markRead = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['seller', 'notifications'] });
    },
  });

  /*
   * Close on a click outside, and on Escape.
   *
   * Written out rather than reached for from a library: this is the only
   * popover in the Hub, and a dependency for one is a dependency to keep in
   * step for ever. Both listeners are removed with the panel - a bell that
   * leaves a document listener behind is a leak that only shows up after
   * somebody navigates forty times.
   */
  useEffect(() => {
    if (!isOpen) return undefined;

    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setIsOpen(false);
        // Focus goes back to the control that opened it, or a keyboard user is
        // dropped at the top of the document with no idea where they were.
        buttonRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const notifications = query.data?.notifications ?? [];
  const count = notifications.filter(isCounted).length;
  const recent = notifications.slice(0, 8);

  function open(notification: SellerNotification): void {
    if (!notification.isRead) markRead.mutate(notification.id);
    setIsOpen(false);

    // The server decides where a row goes; an unlinked row is read in place
    // rather than navigating somewhere arbitrary.
    if (notification.linkPath !== null) void navigate(notification.linkPath);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setIsOpen((previous) => !previous);
        }}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={
          count === 0
            ? t('sellerBell.label')
            : t('sellerBell.labelWithCount', { total: String(count) })
        }
        className={cx(
          'relative inline-flex h-9 w-9 items-center justify-center rounded-md border',
          'border-border-strong bg-surface text-ink transition-colors hover:bg-surface-hover',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
          isOpen && 'bg-surface-hover',
        )}
      >
        <BellIcon className="h-5 w-5" />

        {count > 0 && (
          <span
            className={cx(
              'absolute -right-1 -top-1 inline-flex min-w-4 items-center justify-center',
              'rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white',
            )}
          >
            {/* 9+ rather than a three-digit number squeezed into a circle. */}
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label={t('sellerBell.label')}
          className={cx(
            'absolute right-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden',
            'rounded-xl border border-border bg-surface shadow-lg',
          )}
        >
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
            <p className="text-sm font-semibold text-ink">{t('sellerBell.title')}</p>
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                void navigate('/seller/notifications');
              }}
              className="text-xxs font-medium text-brand hover:text-brand-hover focus:outline-none focus-visible:underline"
            >
              {t('sellerBell.seeAll')}
            </button>
          </div>

          {query.isPending && (
            <p className="px-4 py-6 text-center text-sm text-ink-muted">{t('common.loading')}</p>
          )}

          {!query.isPending && recent.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-ink-muted">{t('sellerBell.empty')}</p>
          )}

          <ul className="max-h-80 divide-y divide-border-subtle overflow-y-auto">
            {recent.map((notification) => (
              <li key={notification.id}>
                <button
                  type="button"
                  onClick={() => {
                    open(notification);
                  }}
                  className={cx(
                    'w-full px-4 py-3 text-left transition-colors hover:bg-surface-hover',
                    'focus:outline-none focus-visible:bg-surface-hover',
                    !notification.isRead && 'bg-brand-soft/20',
                  )}
                >
                  <div className="flex items-start gap-2">
                    {/*
                      A dot, not a word. It marks a row still needing
                      attention; a resolved alert loses it, which is how the
                      panel shows that something fixed itself.
                    */}
                    <span
                      className={cx(
                        'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        isCounted(notification) ? 'bg-danger' : 'bg-transparent',
                      )}
                      aria-hidden="true"
                    />

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{notification.title}</p>

                      {notification.body !== null && (
                        <p className="mt-0.5 line-clamp-2 text-xxs leading-relaxed text-ink-muted">
                          {notification.body}
                        </p>
                      )}

                      {notification.status === 'RESOLVED' && (
                        <p className="mt-1 text-xxs font-medium text-success">
                          {t('sellerBell.resolved')}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
