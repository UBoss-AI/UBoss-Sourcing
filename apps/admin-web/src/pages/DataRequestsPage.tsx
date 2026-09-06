/**
 * Data subject requests.
 *
 * The screen that turns "we comply with the GDPR" into something a supervisory
 * authority can be shown. Three decisions shape it:
 *
 *   - **Sorted by deadline, not by arrival.** Art. 12(3) gives one month from
 *     receipt, and a queue ordered by "newest first" tells a member of staff
 *     nothing about which request is about to breach it. Anything past its
 *     date is called overdue in as many words, because a red row that nobody
 *     has named is a red row people learn to scroll past.
 *
 *   - **Erasure blockers are shown before the decision, not after.** An
 *     unpaid order or an open return makes erasure "not yet" rather than "no",
 *     and the person deciding needs to know which of the two they are looking
 *     at. The backend recomputes them on every read, so what is on screen is
 *     the position now.
 *
 *   - **A refusal cannot be submitted without a reason.** Art. 12(4) requires
 *     the subject be told why and reminded they may complain to a supervisory
 *     authority; the reason typed here is what reaches them. The form enforces
 *     it, and so does the server - this one is worth checking twice.
 *
 * There is deliberately no way to erase a customer from here without a request
 * behind it. Art. 5(2) asks the controller to be able to demonstrate
 * compliance, and an erasure with no record of who asked demonstrates nothing.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  PageHeader,
  Select,
  Textarea,
  Toolbar,
  ToolbarField,
} from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { ApiError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { Pagination } from '@/lib/types';
import { Permission } from '@/lib/permissions';
import type { BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';

type RequestType = 'EXPORT' | 'ERASURE';
type RequestStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'FAILED';

interface DataRequestRow {
  id: string;
  type: RequestType;
  status: RequestStatus;
  subjectEmail: string;
  subjectUserId: string;
  subjectNote: string | null;
  decisionNote: string | null;
  requestedAt: string;
  dueAt: string;
  completedAt: string | null;
  handledAt: string | null;
  errorMessage: string | null;
  overdue: boolean;
}

interface Blocker {
  code: string;
  count: number;
  detail: string;
}

interface RequestDetail extends DataRequestRow {
  blockers: Blocker[];
  result: unknown;
}

const STATUS_TONE: Record<RequestStatus, BadgeTone> = {
  PENDING: 'warning',
  IN_PROGRESS: 'accent',
  COMPLETED: 'success',
  REJECTED: 'neutral',
  FAILED: 'danger',
};

/** Days left before Art. 12(3) is breached, negative once it has been. */
function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/**
 * The decision dialog.
 *
 * Approve and reject share it because they share the only field that matters -
 * the note - and because splitting them would let the reject path quietly lose
 * the blocker warning that makes the decision informed.
 */
function DecisionDialog({
  request,
  mode,
  onClose,
}: {
  request: RequestDetail;
  mode: 'approve' | 'reject';
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      api.post(`/admin/data-requests/${request.id}/${mode}`, { note: note.trim() || null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['data-requests'] });
      toast.success(mode === 'approve' ? t('dataRequests.approved') : t('dataRequests.rejected'));
      onClose();
    },
    onError: (caught) => {
      // A blocker that appeared between the page load and the click lands
      // here. The message names it, so the answer is not just "try again".
      setError(caught instanceof ApiError ? caught.message : t('dataRequests.decisionFailed'));
    },
  });

  const irreversible = mode === 'approve' && request.type === 'ERASURE';

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={
        mode === 'approve' ? t('dataRequests.approveTitle') : t('dataRequests.rejectTitle')
      }
      description={request.subjectEmail}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant={mode === 'approve' ? 'primary' : 'danger'}
            isLoading={submit.isPending}
            disabled={mode === 'reject' && note.trim().length === 0}
            onClick={() => {
              setError(null);
              submit.mutate();
            }}
          >
            {mode === 'approve' ? t('dataRequests.confirmApprove') : t('dataRequests.confirmReject')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error !== null && <Callout tone="danger">{error}</Callout>}

        {irreversible && (
          <Callout tone="warning" title={t('dataRequests.irreversibleTitle')}>
            {t('dataRequests.irreversibleBody')}
          </Callout>
        )}

        {request.blockers.length > 0 && (
          <Callout tone="danger" title={t('dataRequests.blockedTitle')}>
            <ul className="list-disc space-y-1 pl-5">
              {request.blockers.map((blocker) => (
                <li key={blocker.code}>{blocker.detail}</li>
              ))}
            </ul>
          </Callout>
        )}

        <label className="block">
          <span className="text-xs font-medium text-ink">
            {mode === 'reject'
              ? t('dataRequests.reasonRequired')
              : t('dataRequests.noteOptional')}
          </span>
          <Textarea
            className="mt-1.5"
            rows={4}
            value={note}
            maxLength={1024}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            placeholder={
              mode === 'reject' ? t('dataRequests.reasonPlaceholder') : t('dataRequests.notePlaceholder')
            }
          />
          {mode === 'reject' && (
            // Not decoration: this text is sent to the subject verbatim.
            <span className="mt-1 block text-xxs text-ink-subtle">
              {t('dataRequests.reasonIsSentToSubject')}
            </span>
          )}
        </label>
      </div>
    </Modal>
  );
}

/** Loads the one request being decided, so the blockers are current. */
function DecisionLoader({
  requestId,
  mode,
  onClose,
}: {
  requestId: string;
  mode: 'approve' | 'reject';
  onClose: () => void;
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['data-requests', requestId],
    queryFn: () => api.get<RequestDetail>(`/admin/data-requests/${requestId}`),
  });

  if (query.data === undefined) return null;

  return <DecisionDialog request={query.data} mode={mode} onClose={onClose} />;
}

export function DataRequestsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();

  const [searchParams, setSearchParams] = useSearchParams();
  const [deciding, setDeciding] = useState<{ id: string; mode: 'approve' | 'reject' } | null>(null);

  const page = Number(searchParams.get('page') ?? '1');
  const status = searchParams.get('status') ?? '';
  const type = searchParams.get('type') ?? '';

  const query = useQuery({
    queryKey: ['data-requests', { page, status, type }],
    queryFn: () =>
      api.get<{ items: DataRequestRow[]; pagination: Pagination }>('/admin/data-requests', {
        query: {
          page,
          limit: 25,
          status: status === '' ? undefined : status,
          type: type === '' ? undefined : type,
        },
      }),
  });

  const setParam = (key: string, value: string): void => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === '') next.delete(key);
      else next.set(key, value);
      next.delete('page');
      return next;
    });
  };

  const mayAction = can(Permission.DATA_REQUEST_ACTION);

  const columns: Column<DataRequestRow>[] = [
    {
      key: 'subject',
      header: t('dataRequests.subject'),
      render: (row) => (
        <div className="min-w-48">
          <p className="text-ink">{row.subjectEmail}</p>
          {row.subjectNote !== null && (
            // The subject's own words. Shown, never acted on: a request asking
            // for something the law does not grant is still only a request.
            <p className="mt-0.5 text-xxs text-ink-subtle">“{row.subjectNote}”</p>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: t('dataRequests.right'),
      nowrap: true,
      render: (row) => (
        <Badge tone={row.type === 'ERASURE' ? 'danger' : 'neutral'}>
          {row.type === 'ERASURE' ? t('dataRequests.typeErasure') : t('dataRequests.typeExport')}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: t('dataRequests.status'),
      nowrap: true,
      render: (row) => (
        <Badge tone={STATUS_TONE[row.status]}>
          {t(`dataRequests.status.${row.status}` as 'dataRequests.status.PENDING')}
        </Badge>
      ),
    },
    {
      key: 'due',
      header: t('dataRequests.deadline'),
      nowrap: true,
      render: (row) => {
        if (row.completedAt !== null) {
          return (
            <span className="text-ink-muted">
              {t('dataRequests.answeredOn', { when: formatDateTime(row.completedAt) })}
            </span>
          );
        }

        const days = daysUntil(row.dueAt);

        return (
          <div>
            <p className={row.overdue ? 'font-semibold text-danger' : 'text-ink'}>
              {formatDateTime(row.dueAt)}
            </p>
            <p className="text-xxs text-ink-subtle">
              {row.overdue
                ? t('dataRequests.overdueBy', { days: Math.abs(days) })
                : t('dataRequests.daysLeft', { days })}
            </p>
          </div>
        );
      },
    },
    {
      key: 'requested',
      header: t('dataRequests.requested'),
      secondary: true,
      tertiary: true,
      nowrap: true,
      render: (row) => <span className="text-ink-muted">{formatDateTime(row.requestedAt)}</span>,
    },
    {
      key: 'actions',
      header: t('dataRequests.decision'),
      align: 'right',
      render: (row) => {
        if (row.status !== 'PENDING') {
          return row.decisionNote === null ? (
            <span className="text-ink-subtle">—</span>
          ) : (
            <span className="text-xxs text-ink-muted">{row.decisionNote}</span>
          );
        }

        if (!mayAction) {
          // Read-only staff see the queue and the clock, not the buttons.
          return <span className="text-xxs text-ink-subtle">{t('dataRequests.awaitingReview')}</span>;
        }

        return (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              onClick={() => {
                setDeciding({ id: row.id, mode: 'reject' });
              }}
            >
              {t('dataRequests.refuse')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setDeciding({ id: row.id, mode: 'approve' });
              }}
            >
              {t('dataRequests.approve')}
            </Button>
          </div>
        );
      },
    },
  ];

  const overdueCount = (query.data?.items ?? []).filter((row) => row.overdue).length;

  return (
    <>
      <PageHeader
        title={t('dataRequests.title')}
        description={t('dataRequests.description')}
      />

      {overdueCount > 0 && (
        // Named, not merely coloured. A month is the legal maximum, not a
        // target, and a breach is worth saying out loud.
        <Callout tone="danger" title={t('dataRequests.overdueTitle')}>
          {t('dataRequests.overdueBody', { count: overdueCount })}
        </Callout>
      )}

      <Card>
        <Toolbar>
          <ToolbarField label={t('dataRequests.status')}>
            <Select
              value={status}
              onChange={(event) => {
                setParam('status', event.target.value);
              }}
              className="w-48"
            >
              <option value="">{t('dataRequests.anyStatus')}</option>
              {(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'FAILED'] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {t(`dataRequests.status.${value}` as 'dataRequests.status.PENDING')}
                  </option>
                ),
              )}
            </Select>
          </ToolbarField>

          <ToolbarField label={t('dataRequests.right')}>
            <Select
              value={type}
              onChange={(event) => {
                setParam('type', event.target.value);
              }}
              className="w-48"
            >
              <option value="">{t('dataRequests.anyRight')}</option>
              <option value="EXPORT">{t('dataRequests.typeExport')}</option>
              <option value="ERASURE">{t('dataRequests.typeErasure')}</option>
            </Select>
          </ToolbarField>
        </Toolbar>

        <DataTable
          caption={t('dataRequests.title')}
          columns={columns}
          rows={query.data?.items}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel={t('dataRequests.loading')}
          minWidth="62rem"
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle={t('dataRequests.emptyTitle')}
          emptyDescription={t('dataRequests.emptyDescription')}
        />

        {query.data !== undefined && (
          <Pager
            page={query.data.pagination.page}
            limit={query.data.pagination.limit}
            total={query.data.pagination.total}
            totalPages={query.data.pagination.totalPages}
            onPageChange={(next) => {
              setSearchParams((current) => {
                const params = new URLSearchParams(current);
                params.set('page', String(next));
                return params;
              });
            }}
          />
        )}
      </Card>

      {deciding !== null && (
        <DecisionLoader
          requestId={deciding.id}
          mode={deciding.mode}
          onClose={() => {
            setDeciding(null);
          }}
        />
      )}
    </>
  );
}
