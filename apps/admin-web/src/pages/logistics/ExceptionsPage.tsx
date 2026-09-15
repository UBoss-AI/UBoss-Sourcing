/**
 * The exception queue, across every carrier.
 *
 * Sorted most severe first and then oldest first, which is the order somebody
 * working through it should. Newest-first would starve the consignment that
 * has been stuck longest, and that is the one the queue exists to find.
 *
 * Open exceptions only, by default. A resolved exception is history and
 * belongs on the consignment it happened to; a queue that shows both is a
 * queue nobody can tell the state of at a glance.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import {
  Badge,
  Button,
  Card,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
  ToolbarToggle,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime, formatRelative, humanise } from '@/lib/format';
import {
  fetchAdminExceptions,
  severityKey,
  severityTone,
  type AdminExceptionRow,
  type ExceptionSeverity,
} from '@/lib/logistics';

const PAGE_SIZE = 25;

const SEVERITIES: readonly ExceptionSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export function LogisticsExceptionsPage(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const severity = params.get('severity') ?? '';
  // Absent means open-only, which is what the backend defaults to as well.
  const includeResolved = params.get('includeResolved') === '1';
  const page = Math.max(1, Number(params.get('page') ?? '1'));

  const query = useQuery({
    queryKey: ['admin', 'logistics', 'exceptions', severity, includeResolved, page],
    queryFn: () => {
      const next = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (severity.length > 0) next.set('severity', severity);
      if (includeResolved) next.set('openOnly', 'false');
      return fetchAdminExceptions(next);
    },
    // An exception queue is watched. Two minutes is often enough to notice a
    // new one and rare enough not to be load on a self-hosted box.
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value.length === 0) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const columns: Column<AdminExceptionRow>[] = [
    {
      key: 'severity',
      header: t('logistics.exceptions.column.severity'),
      align: 'center',
      render: (row) => (
        <Badge tone={severityTone(row.severity)} dot>
          {t(severityKey(row.severity))}
        </Badge>
      ),
    },
    {
      key: 'what',
      header: t('logistics.exceptions.column.what'),
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{humanise(row.type)}</p>
          {row.reason !== null && <p className="truncate text-xxs text-ink-subtle">{row.reason}</p>}
        </div>
      ),
    },
    {
      key: 'shipment',
      header: t('logistics.exceptions.column.shipment'),
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-ink">{row.shipment.shipmentReference}</p>
          <p className="truncate text-xxs text-ink-subtle">{row.shipment.receivingCompanyName}</p>
        </div>
      ),
    },
    {
      key: 'carrier',
      header: t('logistics.exceptions.column.carrier'),
      secondary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">{row.partner?.displayName ?? '—'}</span>
      ),
    },
    {
      key: 'raised',
      header: t('logistics.exceptions.column.raised'),
      secondary: true,
      nowrap: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">{formatRelative(row.createdAt)}</span>
      ),
    },
    {
      key: 'due',
      header: t('logistics.exceptions.column.due'),
      secondary: true,
      nowrap: true,
      render: (row) => (
        <div>
          <p className="text-xs text-ink-muted">{formatDateTime(row.resolutionDueAt)}</p>
          {row.revisedEtaAt !== null && (
            <p className="text-xxs text-ink-subtle">
              {t('logistics.exceptions.revisedEta', { when: formatDateTime(row.revisedEtaAt) })}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'state',
      header: t('logistics.exceptions.column.state'),
      align: 'center',
      render: (row) => <Badge tone="neutral">{humanise(row.state)}</Badge>,
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('logistics.exceptions.heading')}
        description={t('logistics.exceptions.intro')}
      />

      <Card>
        <Toolbar>
          <ToolbarField label={t('logistics.exceptions.filter.severity')} className="w-48">
            <Select
              value={severity}
              onChange={(event) => {
                update('severity', event.currentTarget.value);
              }}
            >
              <option value="">{t('logistics.exceptions.filter.everySeverity')}</option>
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {t(severityKey(value))}
                </option>
              ))}
            </Select>
          </ToolbarField>

          <ToolbarToggle
            label={t('logistics.exceptions.filter.includeResolved')}
            checked={includeResolved}
            onChange={(checked) => {
              update('includeResolved', checked ? '1' : '');
            }}
          />

          <ToolbarActions>
            <Button
              variant="secondary"
              onClick={() => {
                void query.refetch();
              }}
            >
              {t('common.refresh')}
            </Button>
          </ToolbarActions>
        </Toolbar>

        <DataTable
          caption={t('logistics.exceptions.heading')}
          columns={columns}
          rows={query.data?.exceptions ?? []}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          minWidth="60rem"
          emptyTitle={t('logistics.exceptions.emptyTitle')}
          emptyDescription={
            includeResolved
              ? t('logistics.exceptions.emptyBody')
              : t('logistics.exceptions.emptyOpen')
          }
          onRowClick={(row) => {
            void navigate(`/logistics/shipments/${row.shipmentId}`);
          }}
        />
      </Card>

      {query.data !== undefined && query.data.total > PAGE_SIZE && (
        <Pager
          page={page}
          limit={PAGE_SIZE}
          total={query.data.total}
          totalPages={query.data.pageCount}
          onPageChange={(next: number) => {
            update('page', String(next));
          }}
        />
      )}
    </div>
  );
}
