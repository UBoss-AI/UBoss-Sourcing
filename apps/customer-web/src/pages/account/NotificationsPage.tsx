/**
 * Notifications — what this deployment has actually sent you (JOURNEY-056).
 *
 * Read out of the notification outbox by recipient address: these are the
 * messages that were queued for this account and delivered.
 *
 * What each row carries:
 *
 * **Unread.** The server keeps this person's own read mark on each row.
 * Opening the page marks nothing; pressing a row, or "Mark all as read",
 * does. The count at the top is the same number the server counts.
 *
 * **Priority.** "Important" on what needs acting on now - a failed payment, a
 * sign-in from a new device, a delivery problem. Derived by the server from
 * the event, so every surface agrees.
 *
 * **A link to the thing itself** - the order, the claim, the request - built
 * by the server from what the notification is about. Where it has none, the
 * family's own list page.
 *
 * **Choices.** Below the list, which families arrive by email, text message
 * and here. Security, order, payment and data-rights messages cannot be
 * switched off, and the panel says so rather than offering a switch that
 * would be ignored.
 *
 * Still deliberately absent: the message body. Several of these carry a
 * single-use link, and a list that handed those back would turn one borrowed
 * session into every live link the account has ever been sent.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Badge, Button, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import {
  AlertIcon,
  BellIcon,
  BoxIcon,
  CalendarIcon,
  CardIcon,
  ShieldIcon,
  DocumentIcon,
  HeadsetIcon,
  TruckIcon,
} from '@/components/icons';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import type { AccountNotification, NotificationPreferenceFamily } from '@/lib/types';
import { AccountPanel } from './AccountPanel';

/**
 * Which family a notification belongs to, from the first segment of its key,
 * for the mark and the fallback link. The server's own `family` decides what
 * can be muted; this only draws.
 */
const FAMILIES: readonly {
  prefix: string;
  labelKey: TranslationKey;
  icon: (props: { className?: string }) => React.JSX.Element;
  /** Where the notification's subject lives, when the server gave no link. */
  to?: string;
}[] = [
  { prefix: 'order.message', labelKey: 'notifications.family.messages', icon: HeadsetIcon, to: '/account/messages' },
  { prefix: 'order.', labelKey: 'notifications.family.orders', icon: BoxIcon, to: '/account/orders' },
  { prefix: 'shipment.', labelKey: 'notifications.family.shipments', icon: TruckIcon, to: '/account/orders' },
  { prefix: 'rfq.', labelKey: 'notifications.family.quotes', icon: DocumentIcon, to: '/account/rfqs' },
  { prefix: 'return.', labelKey: 'notifications.family.returns', icon: BoxIcon, to: '/account/returns' },
  { prefix: 'dispute.', labelKey: 'notifications.family.disputes', icon: HeadsetIcon, to: '/account/disputes' },
  { prefix: 'inspection.', labelKey: 'notifications.family.inspection', icon: ShieldIcon, to: '/account/orders' },
  { prefix: 'payment.', labelKey: 'notifications.family.payments', icon: CardIcon, to: '/account/orders' },
  { prefix: 'refund.', labelKey: 'notifications.family.payments', icon: CardIcon },
  { prefix: 'autopay.', labelKey: 'notifications.family.payments', icon: CardIcon },
  { prefix: 'schedule.', labelKey: 'notifications.family.scheduled', icon: CalendarIcon },
  { prefix: 'preorder_chat.', labelKey: 'notifications.family.messages', icon: HeadsetIcon, to: '/account/messages' },
  { prefix: 'preorder.', labelKey: 'notifications.family.preorders', icon: BoxIcon, to: '/account/preorders' },
  { prefix: 'user.', labelKey: 'notifications.family.account', icon: ShieldIcon },
  { prefix: 'customer.', labelKey: 'notifications.family.account', icon: ShieldIcon },
  { prefix: 'data_request.', labelKey: 'notifications.family.yourData', icon: ShieldIcon },
];

function familyFor(eventKey: string): (typeof FAMILIES)[number] | null {
  return FAMILIES.find((family) => eventKey.startsWith(family.prefix)) ?? null;
}

/** The label of a server family key in the choices panel. */
const FAMILY_LABELS: Record<string, TranslationKey> = {
  account: 'notifications.family.account',
  orders: 'notifications.family.orders',
  payments: 'notifications.family.payments',
  yourData: 'notifications.family.yourData',
  messages: 'notifications.family.messages',
  shipments: 'notifications.family.shipments',
  quotes: 'notifications.family.quotes',
  preorders: 'notifications.family.preorders',
  returns: 'notifications.family.returns',
  disputes: 'notifications.family.disputes',
  inspection: 'notifications.family.inspection',
  scheduled: 'notifications.family.scheduled',
  company: 'notifications.family.company',
  savedSearches: 'notifications.family.savedSearches',
  support: 'notifications.family.support',
  integrations: 'notifications.family.integrations',
};

const CHANNELS = ['EMAIL', 'SMS', 'IN_APP'] as const;
type Channel = (typeof CHANNELS)[number];

const CHANNEL_LABELS: Record<Channel, TranslationKey> = {
  EMAIL: 'notifications.channel.EMAIL',
  SMS: 'notifications.channel.SMS',
  IN_APP: 'notifications.channel.IN_APP',
};

interface CentreResponse {
  notifications: AccountNotification[];
  unreadCount?: number;
}

export function NotificationsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const { isCustomer } = useSession();
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);

  useDocumentMeta({ title: t('account.nav.notifications'), noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['account-notifications', unreadOnly],
    queryFn: () =>
      api.get<CentreResponse>(`/account/notifications${unreadOnly ? '?unreadOnly=true' : ''}`),
    enabled: isCustomer,
  });

  const markRead = useMutation({
    mutationFn: (body: { ids: string[] } | { all: true }) =>
      api.post<{ updated: number }>('/account/notifications/read', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['account-notifications'] });
    },
  });

  if (query.isPending) return <LoadingState label={t('notifications.loading')} />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const { notifications } = query.data;
  const unreadCount = query.data.unreadCount ?? 0;

  return (
    <>
      <PageHeader
        title={t('account.nav.notifications')}
        description={t('notifications.description')}
      />

      <AccountPanel title={t('notifications.heading')}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-muted" aria-live="polite">
            {unreadCount === 0
              ? t('notifications.allRead')
              : t('notifications.unreadCount', { unread: formatNumber(unreadCount) })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={unreadOnly}
              onClick={() => {
                setUnreadOnly((value) => !value);
              }}
            >
              {unreadOnly ? t('notifications.showAll') : t('notifications.showUnread')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={unreadCount === 0}
              isLoading={markRead.isPending}
              onClick={() => {
                markRead.mutate({ all: true });
              }}
            >
              {t('notifications.markAllRead')}
            </Button>
          </div>
        </div>

        {notifications.length === 0 ? (
          <EmptyState
            title={unreadOnly ? t('notifications.noUnreadTitle') : t('notifications.emptyTitle')}
            description={unreadOnly ? t('notifications.noUnreadBody') : t('notifications.emptyBody')}
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {notifications.map((entry) => {
              const family = familyFor(entry.eventKey);
              const Mark = family?.icon ?? BellIcon;
              const to = entry.link ?? family?.to;
              const unread = entry.readAt === null;
              const open = (): void => {
                if (unread) markRead.mutate({ ids: [entry.id] });
              };

              return (
                <li key={entry.id} className="flex items-start gap-3 py-3.5 first:pt-0 last:pb-0">
                  <span
                    aria-hidden="true"
                    className={cx(
                      'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md ring-1 ring-inset',
                      entry.priority === 'HIGH'
                        ? 'bg-danger-soft text-danger ring-danger/20'
                        : 'bg-brand-soft text-brand ring-brand/15',
                    )}
                  >
                    <Mark className="h-4 w-4" />
                    {unread && (
                      <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-surface" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className={cx('text-sm text-ink', unread ? 'font-semibold' : 'font-medium')}>
                      {unread && <span className="sr-only">{t('notifications.unread')}: </span>}
                      {to === undefined ? (
                        entry.subject
                      ) : (
                        <Link to={to} onClick={open} className="hover:text-brand hover:underline">
                          {entry.subject}
                        </Link>
                      )}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
                      {entry.priority === 'HIGH' && <Badge tone="danger">{t('notifications.priority.HIGH')}</Badge>}
                      {family !== null && <span>{t(family.labelKey)}</span>}
                      {entry.sentAt !== null && (
                        <>
                          {family !== null && <span aria-hidden="true">·</span>}
                          <span className="tabular">{formatDateTime(entry.sentAt)}</span>
                        </>
                      )}
                    </p>
                  </div>

                  {unread && to === undefined && (
                    <Button variant="ghost" size="sm" onClick={open}>
                      {t('notifications.markRead')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/*
         * Where the message itself is, said plainly.
         *
         * Somebody who opens this page looking for the contents of an email
         * needs to be told that this is a record of what was sent rather than
         * a copy of it — otherwise they conclude the page is broken.
         */}
        <p className="mt-5 flex max-w-prose items-start gap-2 border-t border-border-subtle pt-4 text-xs leading-relaxed text-ink-muted">
          <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" />
          {t('notifications.bodiesAreInYourInbox')}
        </p>

        <p className="mt-3 text-sm text-ink-muted">
          {t('notifications.wrongAddress')}{' '}
          <Link to="/account/profile" className="font-medium text-brand hover:underline">
            {t('account.nav.profileInformation')}
          </Link>
        </p>
      </AccountPanel>

      <NotificationPreferencesPanel enabled={isCustomer} />
    </>
  );
}

/**
 * Which families arrive on which channel. A switch per family and channel;
 * the mandatory families show "Always on" instead of a switch.
 */
function NotificationPreferencesPanel({ enabled }: { enabled: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const preferences = useQuery({
    queryKey: ['notification-preferences'],
    // An older API may answer without it; the panel then shows no rows.
    queryFn: () => api.get<{ families?: NotificationPreferenceFamily[] }>('/account/notification-preferences'),
    enabled,
  });
  const [draft, setDraft] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (preferences.data === undefined) return;
    const muted = new Set<string>();
    for (const family of preferences.data.families ?? []) {
      for (const channel of CHANNELS) {
        if (family.channels[channel] === false) muted.add(`${family.key}:${channel}`);
      }
    }
    setDraft(muted);
  }, [preferences.data]);

  const save = useMutation({
    mutationFn: (muted: Set<string>) =>
      api.put<{ families: NotificationPreferenceFamily[] }>('/account/notification-preferences', {
        muted: [...muted].map((entry) => {
          const [family = '', channel = 'EMAIL'] = entry.split(':');
          return { family, channel };
        }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['notification-preferences'], data);
      void queryClient.invalidateQueries({ queryKey: ['account-notifications'] });
    },
  });

  if (preferences.isPending || draft === null) {
    return (
      <AccountPanel title={t('notifications.preferences.title')}>
        <LoadingState label={t('notifications.preferences.loading')} />
      </AccountPanel>
    );
  }
  if (preferences.isError) {
    return (
      <AccountPanel title={t('notifications.preferences.title')}>
        <ErrorState
          error={preferences.error}
          onRetry={() => {
            void preferences.refetch();
          }}
        />
      </AccountPanel>
    );
  }

  const toggle = (family: string, channel: Channel): void => {
    setDraft((current) => {
      const next = new Set(current ?? []);
      const key = `${family}:${channel}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <AccountPanel title={t('notifications.preferences.title')}>
      <p className="mb-4 max-w-prose text-sm text-ink-muted">{t('notifications.preferences.description')}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-muted">
              <th scope="col" className="py-2 pr-3 font-medium">
                {t('notifications.preferences.family')}
              </th>
              {CHANNELS.map((channel) => (
                <th key={channel} scope="col" className="px-2 py-2 text-center font-medium">
                  {t(CHANNEL_LABELS[channel])}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {(preferences.data.families ?? []).map((family) => {
              const label = t(FAMILY_LABELS[family.key] ?? 'notifications.family.other');
              return (
                <tr key={family.key}>
                  <th scope="row" className="py-2.5 pr-3 text-left font-medium text-ink">
                    {label}
                    {family.mandatory && (
                      <span className="ml-2 text-xs font-normal text-ink-muted">
                        {t('notifications.preferences.alwaysOn')}
                      </span>
                    )}
                  </th>
                  {CHANNELS.map((channel) => (
                    <td key={channel} className="px-2 py-2.5 text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand"
                        aria-label={t('notifications.preferences.toggle', { family: label, channel: t(CHANNEL_LABELS[channel]) })}
                        checked={family.mandatory || !draft.has(`${family.key}:${channel}`)}
                        disabled={family.mandatory}
                        onChange={() => {
                          toggle(family.key, channel);
                        }}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 max-w-prose text-xs text-ink-muted">{t('notifications.preferences.smsNote')}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          isLoading={save.isPending}
          onClick={() => {
            save.mutate(draft);
          }}
        >
          {t('notifications.preferences.save')}
        </Button>
        {save.isSuccess && <span className="text-sm text-success">{t('notifications.preferences.saved')}</span>}
        {save.isError && <span className="text-sm text-danger">{errorMessage(t, save.error)}</span>}
      </div>
    </AccountPanel>
  );
}
