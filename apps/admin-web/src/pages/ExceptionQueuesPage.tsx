/**
 * Exception queues (LIVE-011).
 *
 * Every queue of work the operator's team must not let sit: how many items
 * wait, how long the oldest has waited, how many are past the SLA, and who
 * owns it - as a ROLE, with the role it escalates to. Staff with
 * settings.write change the SLA hours and the roles here. Naming the people
 * who hold each role on each shift stays the operator's own runbook; the
 * page says so.
 *
 * Below it, the critical account actions waiting for a second member of
 * staff (maker-checker, JOURNEY-061).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { PendingActionsCard } from '@/components/governance';
import { roleLabel } from '@/lib/governance';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, Field, Input, PageHeader, Select } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';

export interface ExceptionQueue {
  key: string;
  href: string;
  slaHours: number;
  ownerRole: string;
  escalationRole: string;
  isDefault: boolean;
  count: number;
  oldestAt: string | null;
  oldestAgeHours: number | null;
  breached: number;
  error: boolean;
}

/** The system roles a queue can be owned by. A custom role is shown as-is. */
const ROLE_OPTIONS = [
  'business_owner',
  'catalog_manager',
  'inventory_manager',
  'order_manager',
  'finance_approver',
  'support_agent',
  'compliance_officer',
] as const;

export const EXCEPTION_QUEUES_KEY = ['admin-exception-queues'] as const;

function EditQueueDialog({ queue, onClose }: { queue: ExceptionQueue; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [slaHours, setSlaHours] = useState(String(queue.slaHours));
  const [ownerRole, setOwnerRole] = useState(queue.ownerRole);
  const [escalationRole, setEscalationRole] = useState(queue.escalationRole);
  const hours = Number.parseInt(slaHours, 10);
  const valid = Number.isInteger(hours) && hours >= 1 && hours <= 2160;

  const save = useMutation({
    mutationFn: () => api.put(`/admin/exception-queues/${queue.key}`, { slaHours: hours, ownerRole, escalationRole }),
    onSuccess: async () => {
      toast.success(t('exceptionQueues.saved'));
      await queryClient.invalidateQueries({ queryKey: EXCEPTION_QUEUES_KEY });
      onClose();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const roleChoices = ROLE_OPTIONS.includes(queue.ownerRole as (typeof ROLE_OPTIONS)[number])
    ? [...ROLE_OPTIONS]
    : [...ROLE_OPTIONS, queue.ownerRole];

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('exceptionQueues.editTitle', { queue: t(`exceptionQueues.queue.${queue.key}` as TranslationKey) })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            isLoading={save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('exceptionQueues.slaHours')} hint={t('exceptionQueues.slaHoursHint')} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="number"
              min={1}
              max={2160}
              value={slaHours}
              onChange={(event) => {
                setSlaHours(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t('exceptionQueues.owner')} required>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={ownerRole}
              onChange={(event) => {
                setOwnerRole(event.target.value);
              }}
            >
              {roleChoices.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('exceptionQueues.escalation')} required>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={escalationRole}
              onChange={(event) => {
                setEscalationRole(event.target.value);
              }}
            >
              {roleChoices.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </Modal>
  );
}

export function ExceptionQueuesPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [editing, setEditing] = useState<ExceptionQueue | null>(null);
  const mayEdit = can(Permission.SETTINGS_WRITE);

  const query = useQuery({
    queryKey: EXCEPTION_QUEUES_KEY,
    queryFn: () => api.get<{ generatedAt: string; queues: ExceptionQueue[] }>('/admin/exception-queues'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const columns: Column<ExceptionQueue>[] = [
    {
      key: 'queue',
      header: t('exceptionQueues.column.queue'),
      render: (row) => (
        <Link to={row.href} className="font-medium text-ink underline-offset-2 hover:underline">
          {t(`exceptionQueues.queue.${row.key}` as TranslationKey)}
        </Link>
      ),
    },
    {
      key: 'waiting',
      header: t('exceptionQueues.column.waiting'),
      align: 'right',
      render: (row) => (row.error ? <Badge tone="danger">{t('exceptionQueues.unavailable')}</Badge> : formatNumber(row.count)),
    },
    {
      key: 'oldest',
      header: t('exceptionQueues.column.oldest'),
      align: 'right',
      render: (row) =>
        row.oldestAgeHours === null ? '—' : (
          <span title={row.oldestAt === null ? undefined : formatDateTime(row.oldestAt)}>
            {t('exceptionQueues.hours', { hours: formatNumber(row.oldestAgeHours) })}
          </span>
        ),
    },
    {
      key: 'breached',
      header: t('exceptionQueues.column.breached'),
      align: 'right',
      render: (row) =>
        row.breached > 0 ? <Badge tone="danger">{formatNumber(row.breached)}</Badge> : <Badge tone="success">0</Badge>,
    },
    {
      key: 'sla',
      header: t('exceptionQueues.column.sla'),
      align: 'right',
      render: (row) => (
        <span>
          {t('exceptionQueues.hours', { hours: formatNumber(row.slaHours) })}
          {row.isDefault && (
            <span className="ml-1 text-xxs text-ink-muted">({t('exceptionQueues.default')})</span>
          )}
        </span>
      ),
    },
    { key: 'owner', header: t('exceptionQueues.column.owner'), render: (row) => roleLabel(row.ownerRole) },
    {
      key: 'escalation',
      header: t('exceptionQueues.column.escalation'),
      secondary: true,
      render: (row) => roleLabel(row.escalationRole),
    },
    ...(mayEdit
      ? [
          {
            key: 'edit',
            header: <span className="sr-only">{t('common.edit')}</span>,
            align: 'right' as const,
            render: (row: ExceptionQueue) => (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(row);
                }}
              >
                {t('common.edit')}
              </Button>
            ),
          },
        ]
      : []),
  ];

  const breachedTotal = (query.data?.queues ?? []).reduce((sum, row) => sum + row.breached, 0);

  return (
    <div className="space-y-5">
      <PageHeader title={t('exceptionQueues.title')} description={t('exceptionQueues.description')} />

      <Callout tone="info" title={t('exceptionQueues.peopleTitle')}>
        <p className="text-sm">{t('exceptionQueues.peopleBody')}</p>
      </Callout>

      {breachedTotal > 0 && (
        <Callout tone="warning" role="status">
          {t('exceptionQueues.breachedSummary', { total: formatNumber(breachedTotal) })}
        </Callout>
      )}

      <Card>
        <DataTable
          caption={t('exceptionQueues.title')}
          columns={columns}
          rows={query.data?.queues ?? []}
          rowKey={(row) => row.key}
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle={t('exceptionQueues.empty')}
        />
      </Card>

      <PendingActionsCard />

      {editing !== null && (
        <EditQueueDialog
          queue={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
