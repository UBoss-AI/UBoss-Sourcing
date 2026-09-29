/**
 * Dead background jobs and undeliverable emails.
 *
 * The operations dashboard counts both queues and links here. Before this
 * page existed both links landed on Not Found, so a member of staff could see
 * that emails had failed and do nothing about any of them.
 *
 * One page, two routes, because the two queues are the same shape of problem:
 * something stopped after its last attempt, and a person decides whether it
 * should go round once more. What the API sends is deliberately thin - no job
 * payload, no email body, the recipient masked - so what is shown is enough to
 * decide and nothing more.
 *
 * Retrying asks first. It is one more attempt, never a reset, and the server
 * refuses a second press, so the confirm is about the decision rather than
 * about protecting anything.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { ConfirmDialog } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, LinkButton, PageHeader } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import {
  type DeadJob,
  type DeadLetterKind,
  type FailedNotification,
  deadLetterApi,
  deadLetterKeys,
} from '@/lib/dead-letter';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';

type Row = DeadJob | FailedNotification;

export function DeadLetterPage({ kind }: { kind: DeadLetterKind }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<Row | null>(null);

  const canRetry = can(Permission.SETTINGS_WRITE);
  const isJobs = kind === 'jobs';

  const query = useQuery({
    queryKey: deadLetterKeys.list(kind),
    queryFn: async (): Promise<Row[]> =>
      isJobs
        ? (await deadLetterApi.deadJobs()).jobs
        : (await deadLetterApi.failedNotifications()).notifications,
  });

  const rows = query.data;

  const retry = useMutation({
    mutationFn: (id: string) =>
      isJobs ? deadLetterApi.retryJob(id) : deadLetterApi.retryNotification(id),
    onSuccess: async () => {
      toast.success(t('deadLetter.retryQueued'));
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: deadLetterKeys.all });
      await queryClient.invalidateQueries({ queryKey: ['operations'] });
    },
    onError: async (error) => {
      // A 409 means somebody else got there first, or the item is not
      // retryable; either way the list is out of date, so refresh it.
      toast.error(
        error instanceof ApiError && error.status === 409
          ? t('deadLetter.notRetryable')
          : t('deadLetter.retryFailed'),
      );
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: deadLetterKeys.all });
    },
  });

  const attempts = (row: Row): string =>
    t('deadLetter.attempts', { made: row.attemptCount, allowed: row.maxAttempts });

  const retryCell = (row: Row): React.JSX.Element | null => {
    if (!canRetry) return null;
    if ('retryable' in row && !row.retryable) {
      return <span className="text-xs text-ink-subtle">{t('deadLetter.recipientErased')}</span>;
    }
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setConfirming(row);
        }}
      >
        {t('deadLetter.retry')}
      </Button>
    );
  };

  const errorCell = (value: string | null): React.JSX.Element => (
    <span className="break-words text-xs text-ink-muted">{value ?? t('deadLetter.noError')}</span>
  );

  const jobColumns: Column<DeadJob>[] = [
    {
      key: 'type',
      header: t('deadLetter.jobType'),
      render: (row) => <span className="font-mono text-xs text-ink">{row.jobType}</span>,
    },
    {
      key: 'status',
      header: t('deadLetter.status'),
      render: () => (
        <Badge tone="danger" dot>
          {t('deadLetter.statusDead')}
        </Badge>
      ),
    },
    { key: 'attempts', header: t('deadLetter.attemptsHeader'), render: attempts, nowrap: true },
    { key: 'error', header: t('deadLetter.lastError'), render: (row) => errorCell(row.lastError) },
    {
      key: 'when',
      header: t('deadLetter.failedAt'),
      render: (row) => formatDateTime(row.failedAt),
      nowrap: true,
      secondary: true,
    },
    { key: 'action', header: <span className="sr-only">{t('deadLetter.retry')}</span>, render: retryCell },
  ];

  const notificationColumns: Column<FailedNotification>[] = [
    {
      key: 'event',
      header: t('deadLetter.message'),
      render: (row) => <span className="font-mono text-xs text-ink">{row.eventKey}</span>,
    },
    {
      key: 'recipient',
      header: t('deadLetter.recipient'),
      render: (row) => <span className="text-ink">{row.recipient ?? t('deadLetter.noRecipient')}</span>,
    },
    { key: 'attempts', header: t('deadLetter.attemptsHeader'), render: attempts, nowrap: true },
    { key: 'error', header: t('deadLetter.lastError'), render: (row) => errorCell(row.lastError) },
    {
      key: 'when',
      header: t('deadLetter.lastAttempt'),
      render: (row) => formatDateTime(row.lastAttemptAt),
      nowrap: true,
      secondary: true,
    },
    { key: 'action', header: <span className="sr-only">{t('deadLetter.retry')}</span>, render: retryCell },
  ];

  const title = isJobs ? t('deadLetter.jobsTitle') : t('deadLetter.notificationsTitle');

  return (
    <>
      <PageHeader
        title={title}
        description={isJobs ? t('deadLetter.jobsDescription') : t('deadLetter.notificationsDescription')}
        actions={
          <LinkButton to={isJobs ? '/operations/failed-notifications' : '/operations/dead-jobs'} variant="secondary">
            {isJobs ? t('deadLetter.notificationsTitle') : t('deadLetter.jobsTitle')}
          </LinkButton>
        }
      />

      <Card>
        {isJobs ? (
          <DataTable
            caption={title}
            columns={jobColumns}
            rows={rows as DeadJob[] | undefined}
            rowKey={(row) => row.id}
            isLoading={query.isPending}
            isRefreshing={query.isFetching && !query.isPending}
            error={query.isError ? query.error : undefined}
            onRetry={() => {
              void query.refetch();
            }}
            loadingLabel={t('deadLetter.loading')}
            minWidth="52rem"
            emptyTitle={t('deadLetter.jobsEmptyTitle')}
            emptyDescription={t('deadLetter.emptyDescription')}
          />
        ) : (
          <DataTable
            caption={title}
            columns={notificationColumns}
            rows={rows as FailedNotification[] | undefined}
            rowKey={(row) => row.id}
            isLoading={query.isPending}
            isRefreshing={query.isFetching && !query.isPending}
            error={query.isError ? query.error : undefined}
            onRetry={() => {
              void query.refetch();
            }}
            loadingLabel={t('deadLetter.loading')}
            minWidth="52rem"
            emptyTitle={t('deadLetter.notificationsEmptyTitle')}
            emptyDescription={t('deadLetter.emptyDescription')}
          />
        )}
      </Card>

      <ConfirmDialog
        isOpen={confirming !== null}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming !== null) retry.mutate(confirming.id);
        }}
        title={isJobs ? t('deadLetter.confirmJobTitle') : t('deadLetter.confirmNotificationTitle')}
        body={t('deadLetter.confirmBody')}
        confirmLabel={t('deadLetter.retry')}
        isWorking={retry.isPending}
      />
    </>
  );
}

/** `/operations/dead-jobs` - the queue the dashboard's "dead background jobs" count links to. */
export function DeadJobsPage(): React.JSX.Element {
  return <DeadLetterPage kind="jobs" />;
}

/** `/operations/failed-notifications` - the undeliverable emails the dashboard counts. */
export function FailedNotificationsPage(): React.JSX.Element {
  return <DeadLetterPage kind="notifications" />;
}
