/**
 * Messages and notifications, in one header entry (checklist DYNAMIC-001).
 *
 * One entry rather than two icons because the header has to fit at 320px, and
 * because a buyer's question on arrival is "is anything waiting for me?" -
 * whichever kind it is. The badge is the sum of both unread counts, each
 * counted by the server; the panel says which is which.
 *
 * Only for a signed-in customer. A guest has no inbox, and a seller's messages
 * live in Seller Hub, which has its own sign-in and its own notification
 * centre. Like the account menu beside it, it is a disclosure, not an ARIA
 * menu: a button with `aria-expanded` over a short list of links.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { BellIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useChatUnreadCount } from '@/lib/use-chat-unread';
import { useI18n } from '@/i18n/i18n-context';

/** Shares the notification page's key prefix, so marking read there refreshes this. */
const headerNotificationsKey = ['account-notifications', 'header-unread'] as const;

function useNotificationUnreadCount(enabled: boolean): number {
  const query = useQuery({
    queryKey: headerNotificationsKey,
    queryFn: () => api.get<{ unreadCount?: number }>('/account/notifications?limit=1'),
    enabled,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return enabled ? (query.data?.unreadCount ?? 0) : 0;
}

export function HeaderInbox(): React.JSX.Element | null {
  const { t } = useI18n();
  const { isCustomer } = useSession();
  const location = useLocation();
  const messages = useChatUnreadCount();
  const notifications = useNotificationUnreadCount(isCustomer);
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current?.contains(event.target as Node) !== true) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    setIsOpen(false);
  }, [location.pathname]);

  if (!isCustomer) return null;

  const total = messages + notifications;
  const label =
    total === 0 ? t('header.inboxNone') : t('header.inboxUnread', { unread: formatNumber(total) });
  const items = [
    { to: '/account/messages', text: t('header.inboxMessages'), unread: messages },
    { to: '/account/notifications', text: t('header.inboxNotifications'), unread: notifications },
  ];

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
      >
        <BellIcon className="h-5 w-5 shrink-0" />
        {total > 0 && (
          <span
            aria-hidden="true"
            data-testid="inbox-badge"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-action-fill px-1 text-xxs font-bold text-white ring-2 ring-surface"
          >
            {total > 99 ? '99+' : formatNumber(total)}
          </span>
        )}
      </button>
      {isOpen && (
        <nav
          id={panelId}
          aria-label={t('header.inboxTitle')}
          className="absolute right-0 top-full z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-1 shadow-card"
        >
          <ul>
            {items.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm text-ink hover:bg-surface-hover"
                >
                  <span>{item.text}</span>
                  <span className={item.unread > 0 ? 'font-semibold text-action-strong' : 'text-ink-muted'}>
                    {item.unread > 0
                      ? t('header.inboxItemUnread', { unread: formatNumber(item.unread) })
                      : t('header.inboxItemNone')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
