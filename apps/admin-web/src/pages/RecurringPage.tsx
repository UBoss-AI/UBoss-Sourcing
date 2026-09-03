/**
 * Recurring schedules.
 *
 * The `summary` string comes from the server ("Every 7 days at 06:00
 * (Asia/Kolkata)"). Rebuilding it here from frequency + interval + weekday +
 * timezone would be a second implementation of the recurrence rules, and the
 * two would disagree the first time either changed. The timezone stays visible
 * because a schedule runs on the customer's wall clock, not the viewer's.
 *
 * Pausing does not cancel: the schedule stops producing orders and keeps its
 * place. Cancelling is final, so it asks first and takes a reason.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, PageHeader, Select, Textarea } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDateTime, formatNumber, humanise } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { Pagination } from '@/lib/types';

interface ScheduleRow {
  id: string;
  name: string;
  status: string;
  summary: string;
  frequency: string;
  timezone: string;
  startDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
  occurrenceCount: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  paymentMode: string;
  payerEmail: string | null;
  hasMandate: boolean;
  consentAcceptedAt: string | null;
  failureCount: number;
  maxFailures: number;
  pausedReason: string | null;
  cancelReason: string | null;
  itemCount: number;
  customer: { id: string; fullName: string | null; organization: string | null } | null;
}

function scheduleTone(status: string): BadgeTone {
  if (status === 'ACTIVE') return 'success';
  if (status === 'PAUSED') return 'warning';
  if (status === 'CANCELLED' || status === 'FAILED') return 'danger';
  if (status === 'COMPLETED') return 'neutral';
  return 'neutral';
}

function ActionDialog({
  schedule,
  action,
  onClose,
}: {
  schedule: ScheduleRow;
  action: 'pause' | 'resume' | 'cancel';
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const trimmed = reason.trim();

      if (action === 'cancel') {
        // Cancel is a DELETE, so the reason travels as a query parameter - a
        // DELETE body is not reliably forwarded by every proxy.
        return api.delete(
          `/admin/schedules/${schedule.id}`,
          trimmed === '' ? {} : { query: { reason: trimmed } },
        );
      }

      return api.post(
        `/admin/schedules/${schedule.id}/${action}`,
        trimmed === '' ? undefined : { reason: trimmed },
      );
    },
    onSuccess: async () => {
      toast.success(
        action === 'pause'
          ? 'Schedule paused. It will not produce orders until resumed.'
          : action === 'resume'
            ? 'Schedule resumed.'
            : 'Schedule cancelled.',
      );
      await queryClient.invalidateQueries({ queryKey: ['schedules'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
    onError: (apiError) => {
      setError(apiError instanceof ApiError ? apiError.message : 'That could not be done.');
    },
  });

  const titles = {
    pause: `Pause “${schedule.name}”?`,
    resume: `Resume “${schedule.name}”?`,
    cancel: `Cancel “${schedule.name}”?`,
  };

  const bodies = {
    pause: 'It stops producing orders and keeps its place. Resume puts it back on schedule.',
    resume: 'It starts producing orders again from its next scheduled run.',
    cancel:
      'This is final. Orders it has already produced are unaffected, but the schedule cannot be restarted — the customer would have to create a new one.',
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={titles[action]}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Keep as is
          </Button>
          <Button
            variant={action === 'cancel' ? 'danger' : 'primary'}
            disabled={action === 'cancel' && reason.trim() === ''}
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {action === 'pause' ? 'Pause schedule' : action === 'resume' ? 'Resume schedule' : 'Cancel schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-ink-muted">{bodies[action]}</p>

        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-danger"
          >
            {error}
          </p>
        )}

        {action !== 'resume' && (
          <Field
            label="Reason"
            hint={
              action === 'cancel'
                ? 'Required. Recorded on the schedule and visible to the customer.'
                : 'Optional. Shown on the schedule while it is paused.'
            }
            required={action === 'cancel'}
          >
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                rows={2}
                value={reason}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            )}
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function RecurringPage(): React.JSX.Element {
  const { can } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1');
  const status = searchParams.get('status') ?? '';

  const [dialog, setDialog] = useState<{
    schedule: ScheduleRow;
    action: 'pause' | 'resume' | 'cancel';
  } | null>(null);

  const query = useQuery({
    queryKey: ['schedules', { page, status }],
    queryFn: () =>
      api.get<{ schedules: ScheduleRow[]; pagination: Pagination }>('/admin/schedules', {
        query: { page, limit: 25, status: status === '' ? undefined : status },
      }),
  });

  const canWrite = can(Permission.SCHEDULE_WRITE);

  const columns: Column<ScheduleRow>[] = [
    {
      key: 'schedule',
      header: 'Schedule',
      render: (row) => (
        <div>
          <p className="font-medium text-ink">{row.name}</p>
          {/* The server's own description of the recurrence - not rebuilt here. */}
          <p className="text-xxs text-ink-subtle">{row.summary}</p>
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (row) =>
        row.customer === null ? (
          '—'
        ) : (
          <div>
            <Link
              to={`/customers/${row.customer.id}`}
              className="text-ink hover:text-accent hover:underline"
            >
              {row.customer.fullName ?? 'Customer'}
            </Link>
            {row.customer.organization !== null && (
              <p className="text-xxs text-ink-subtle">{row.customer.organization}</p>
            )}
          </div>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div>
          <Badge tone={scheduleTone(row.status)}>{humanise(row.status)}</Badge>
          {row.failureCount > 0 && (
            <p className="mt-0.5 text-xxs text-warning">
              {formatNumber(row.failureCount)} of {formatNumber(row.maxFailures)} failures
            </p>
          )}
          {row.pausedReason !== null && (
            <p className="mt-0.5 text-xxs text-ink-subtle">{row.pausedReason}</p>
          )}
        </div>
      ),
    },
    {
      key: 'next',
      header: 'Next run',
      render: (row) =>
        row.nextRunAt === null ? (
          <span className="text-ink-subtle">Not scheduled</span>
        ) : (
          <div>
            <p className="whitespace-nowrap text-ink">{formatDateTime(row.nextRunAt)}</p>
            {/* The schedule runs on the customer's wall clock, so the zone
                matters when the reader is somewhere else. */}
            <p className="text-xxs text-ink-subtle">{row.timezone}</p>
          </div>
        ),
    },
    {
      key: 'payment',
      header: 'Payment',
      secondary: true,
      render: (row) => (
        <div>
          <Badge>{humanise(row.paymentMode)}</Badge>
          {row.paymentMode === 'MANDATE' && !row.hasMandate && (
            <p className="mt-0.5 text-xxs text-danger">No mandate on file</p>
          )}
        </div>
      ),
    },
    {
      key: 'runs',
      header: 'Runs',
      align: 'right',
      secondary: true,
      render: (row) =>
        row.maxOccurrences === null
          ? formatNumber(row.occurrenceCount)
          : `${formatNumber(row.occurrenceCount)} / ${formatNumber(row.maxOccurrences)}`,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) =>
        canWrite ? (
          <div className="flex justify-end gap-1">
            {row.status === 'ACTIVE' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDialog({ schedule: row, action: 'pause' });
                }}
              >
                Pause
              </Button>
            )}
            {row.status === 'PAUSED' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDialog({ schedule: row, action: 'resume' });
                }}
              >
                Resume
              </Button>
            )}
            {row.status !== 'CANCELLED' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDialog({ schedule: row, action: 'cancel' });
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Recurring orders"
        description="Schedules that place orders on their own. Times are the customer's local wall clock."
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          <label>
            <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Status
            </span>
            <Select
              value={status}
              onChange={(event) => {
                setSearchParams((current) => {
                  const next = new URLSearchParams(current);
                  if (event.target.value === '') next.delete('status');
                  else next.set('status', event.target.value);
                  next.delete('page');
                  return next;
                });
              }}
              className="w-44"
            >
              <option value="">Any status</option>
              {['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'].map((value) => (
                <option key={value} value={value}>
                  {humanise(value)}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <DataTable
          caption="Recurring schedules"
          columns={columns}
          rows={query.data?.schedules}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          error={query.isError ? query.error : undefined}
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle="No recurring schedules"
          emptyDescription="Customers create these from their account. Staff can pause, resume or cancel them here."
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

      {dialog !== null && (
        <ActionDialog
          schedule={dialog.schedule}
          action={dialog.action}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
    </>
  );
}
