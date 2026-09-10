/**
 * Notifications — what this deployment has actually sent you.
 *
 * Read out of the notification outbox by recipient address, which is the
 * honest answer to "my notifications": these are the messages that were
 * queued for this account and delivered. It is not a feed and it is not a
 * preference screen.
 *
 * Three deliberate absences.
 *
 * **Nothing to mark as read.** There is nothing on the server that tracks
 * whether somebody opened an email, so a read/unread state here would be an
 * invention — one this page would have to store and then be wrong about.
 *
 * **No message body.** Each of these is a rendered email, and several of them
 * carry a single-use link: a payment link, a password reset, a data-export
 * download. A list endpoint that handed those back would turn one borrowed
 * session into every live link the account has ever been sent. The subject
 * line is what identifies a message; the message itself is in the inbox it was
 * sent to.
 *
 * **Only what was sent.** A queued message has not arrived and a failed one
 * never will, and listing either as something the customer received would be a
 * lie about their own record.
 *
 * The event key is turned into a human label here rather than on the server,
 * because it is a UI string in eight languages and the server has no business
 * holding those. An event this page has no label for falls back to the
 * subject line, which is a real sentence — never to a raw `order.confirmed`.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import {
  AlertIcon,
  BellIcon,
  BoxIcon,
  CalendarIcon,
  CardIcon,
  ShieldIcon,
} from '@/components/icons';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import type { AccountNotification } from '@/lib/types';
import { AccountPanel } from './AccountPanel';

/**
 * Which family a notification belongs to, from the first segment of its key.
 *
 * Matched on the prefix rather than on the whole key, so a new event in an
 * existing family — and there are a dozen scheduled-order events — arrives
 * with the right mark and the right grouping without this table growing a row.
 */
const FAMILIES: readonly {
  prefix: string;
  labelKey: TranslationKey;
  icon: (props: { className?: string }) => React.JSX.Element;
}[] = [
  { prefix: 'order.', labelKey: 'notifications.family.orders', icon: BoxIcon },
  { prefix: 'payment.', labelKey: 'notifications.family.payments', icon: CardIcon },
  { prefix: 'refund.', labelKey: 'notifications.family.payments', icon: CardIcon },
  { prefix: 'autopay.', labelKey: 'notifications.family.payments', icon: CardIcon },
  { prefix: 'schedule.', labelKey: 'notifications.family.scheduled', icon: CalendarIcon },
  { prefix: 'user.', labelKey: 'notifications.family.account', icon: ShieldIcon },
  { prefix: 'customer.', labelKey: 'notifications.family.account', icon: ShieldIcon },
  { prefix: 'data_request.', labelKey: 'notifications.family.yourData', icon: ShieldIcon },
];

function familyFor(eventKey: string): (typeof FAMILIES)[number] | null {
  return FAMILIES.find((family) => eventKey.startsWith(family.prefix)) ?? null;
}

export function NotificationsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const { isCustomer } = useSession();

  useDocumentMeta({ title: t('account.nav.notifications'), noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['account-notifications'],
    queryFn: () => api.get<{ notifications: AccountNotification[] }>('/account/notifications'),
    enabled: isCustomer,
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

  return (
    <>
      <PageHeader
        title={t('account.nav.notifications')}
        description={t('notifications.description')}
      />

      <AccountPanel title={t('notifications.heading')}>
        {notifications.length === 0 ? (
          <EmptyState
            title={t('notifications.emptyTitle')}
            description={t('notifications.emptyBody')}
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {notifications.map((entry) => {
              const family = familyFor(entry.eventKey);
              const Mark = family?.icon ?? BellIcon;

              return (
                <li key={entry.id} className="flex items-start gap-3 py-3.5 first:pt-0 last:pb-0">
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand ring-1 ring-inset ring-brand/15"
                  >
                    <Mark className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{entry.subject}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
                      {family !== null && <span>{t(family.labelKey)}</span>}
                      {entry.sentAt !== null && (
                        <>
                          {family !== null && <span aria-hidden="true">·</span>}
                          <span className="tabular">{formatDateTime(entry.sentAt)}</span>
                        </>
                      )}
                    </p>
                  </div>
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
    </>
  );
}
