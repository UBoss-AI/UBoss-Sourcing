/**
 * What the marketplace has told you.
 *
 * A seller finds out about a decision three ways: an email they may not have
 * opened, a screen they may not have visited, and this. It is the only one that
 * is complete, which is why nothing is ever removed from it — a notice about a
 * refused listing is still the record of that refusal a week later.
 *
 * **Read state is per person, not per business.** A seller with twelve staff
 * would otherwise have one of them read a notice and the other eleven never see
 * it. The server keeps a read mark per member, and marking one read here marks
 * it for you alone.
 *
 * Each notice carries where it came from, so "your listing was sent back" is a
 * link to the listing rather than a sentence that leaves the seller hunting.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import {
  fetchNotifications,
  markNotificationRead,
  type SellerNotification,
} from '@/lib/seller';

const SEVERITY_TONES: Record<string, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'> = {
  INFO: 'neutral',
  SUCCESS: 'success',
  WARNING: 'warning',
  CRITICAL: 'danger',
};

export function SellerNotificationsPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const query = useQuery({
    queryKey: ['seller', 'notifications'],
    queryFn: fetchNotifications,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'notifications'] });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.notifications.markFailed')));
    },
  });

  const notifications = query.data?.notifications ?? [];
  const unread = notifications.filter((row) => !row.isRead);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('seller.notifications.title')}
        description={
          unread.length === 0
            ? t('seller.notifications.allRead')
            : t('seller.notifications.unread', { count: unread.length })
        }
      />

      {query.isPending && <LoadingState label={t('seller.notifications.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.isSuccess && notifications.length === 0 && (
        <EmptyState
          title={t('seller.notifications.emptyTitle')}
          description={t('seller.notifications.emptyBody')}
        />
      )}

      {notifications.length > 0 && (
        <Card title={t('seller.notifications.recent')}>
          <ul className="divide-y divide-border-subtle">
            {notifications.map((row) => (
              <NotificationRow
                key={row.id}
                notification={row}
                isBusy={markRead.isPending}
                onRead={() => {
                  markRead.mutate(row.id);
                }}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function NotificationRow({
  notification,
  onRead,
  isBusy,
}: {
  notification: SellerNotification;
  onRead: () => void;
  isBusy: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <li
      className={cx(
        'px-6 py-4',
        // A ground tint, and the word "New" beside it. The tint alone is not a
        // signal to anybody who cannot see it.
        !notification.isRead && 'bg-brand-soft/40',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-ink">{notification.title}</p>
            {!notification.isRead && <Badge tone="brand">{t('seller.notifications.new')}</Badge>}
            <Badge tone={SEVERITY_TONES[notification.severity] ?? 'neutral'}>
              {notification.severity.toLowerCase()}
            </Badge>
          </div>

          {notification.body !== null && (
            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">
              {notification.body}
            </p>
          )}

          <p className="mt-1 text-xxs text-ink-subtle">
            {new Date(notification.createdAt).toLocaleString()}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/*
            Only an internal path is followed. `linkPath` is written by the
            server, but rendering whatever arrives as an href is how one bad row
            becomes an open redirect, and the cost of checking is one line.
          */}
          {notification.linkPath !== null && notification.linkPath.startsWith('/') && (
            <Link to={notification.linkPath} className="text-xs text-brand hover:underline">
              {t('seller.notifications.open')}
            </Link>
          )}

          {!notification.isRead && (
            <Button disabled={isBusy} onClick={onRead}>
              {t('seller.notifications.markRead')}
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
