/**
 * Reports.
 *
 * The window lives in the URL so a report can be sent to someone as a link,
 * and the dates it actually covers are printed on the page — "last 30 days"
 * means something different depending on when it was opened, and a figure
 * quoted out of a report has to be traceable to a period.
 *
 * The distinction the sales panel exists to make: **gross sales** is what was
 * ordered, **collected** is what the gateway actually confirmed, and **net
 * revenue** is collected minus refunds. Presenting only the first would report
 * unpaid orders as revenue, which is the most common way a dashboard lies.
 * The four headline figures are one size; the four that break them down are a
 * step smaller, because they are read second.
 *
 * Exports are asynchronous: `POST /admin/exports` queues a job, and the file
 * is fetched with a one-time token once it is ready. Nothing here blocks on a
 * large export.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingState,
  Metric,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
} from '@/components/ui';
import { ApiError, api, downloadFile } from '@/lib/api';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  humanise,
  minorToMajor,
} from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { BadgeTone } from '@/components/ui';
import type { Money } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

interface SalesReport {
  summary: {
    currency: string;
    window: { from: string; to: string };
    orderCount: number;
    grossSales: Money;
    tax: Money;
    shipping: Money;
    discount: Money;
    collected: Money;
    refunded: Money;
    netRevenue: Money;
    averageOrderValue: Money;
  };
  topProducts?: {
    productId: string;
    name: string;
    sku: string;
    quantity: number;
    revenue: Money;
  }[];
}

interface OrdersReport {
  byStatus: { status: string; count: number; value: string }[];
  fulfilmentAgeing: {
    bucket: string;
    count: number;
    oldestOrderNumber: string | null;
    oldestAgeDays: number | null;
  }[];
}

interface ExportJob {
  id: string;
  type: string;
  status: string;
  fileName: string | null;
  rowCount?: number | null;
  createdAt: string;
  completedAt: string | null;
}

const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
] as const;

const EXPORT_TYPES = [
  { value: 'ORDERS', label: 'Orders' },
  { value: 'PAYMENTS', label: 'Payments' },
  { value: 'CUSTOMERS', label: 'Customers' },
  { value: 'INVENTORY', label: 'Inventory' },
  { value: 'PRODUCTS', label: 'Products' },
] as const;

function exportTone(status: string): BadgeTone {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'FAILED' || status === 'DEAD') return 'danger';
  return 'warning';
}

function ExportsPanel(): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const [type, setType] = useState<string>('ORDERS');

  const canCreate = can(Permission.EXPORT_CREATE);

  const query = useQuery({
    queryKey: ['exports'],
    queryFn: () => api.get<{ exports: ExportJob[] }>('/admin/exports'),
    // An export runs in the background, so this list is polled while any job
    // is still working rather than making the user reload the page.
    refetchInterval: (q) =>
      (q.state.data?.exports ?? []).some(
        (job) => job.status === 'PENDING' || job.status === 'RUNNING',
      )
        ? 3000
        : false,
  });

  const create = useMutation({
    mutationFn: () => api.post<{ exportJobId: string }>('/admin/exports', { type }),
    onSuccess: async () => {
      toast.success('Export queued. It appears below when it is ready.');
      await queryClient.invalidateQueries({ queryKey: ['exports'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'The export could not be queued.');
    },
  });

  const download = useMutation({
    mutationFn: async (job: ExportJob) => {
      // The download link is a one-time token, so it is requested at the
      // moment of download rather than held in the page.
      const { token } = await api.get<{ token: string }>(`/admin/exports/${job.id}`);
      await downloadFile(`/exports/download/${token}`, job.fileName ?? 'export.csv');
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'The file could not be downloaded.');
    },
  });

  const isWorking = (job: ExportJob): boolean =>
    job.status === 'PENDING' || job.status === 'RUNNING';

  const columns: Column<ExportJob>[] = [
    {
      key: 'type',
      header: 'Export',
      render: (row) => (
        <div>
          <p className="font-medium text-ink">{humanise(row.type)}</p>
          {row.fileName !== null && (
            <p className="truncate font-mono text-xxs text-ink-subtle">{row.fileName}</p>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge dot tone={exportTone(row.status)}>
          {humanise(row.status)}
        </Badge>
      ),
    },
    {
      key: 'rows',
      header: 'Rows',
      align: 'right',
      secondary: true,
      render: (row) =>
        row.rowCount == null ? (
          <span className="text-ink-subtle">—</span>
        ) : (
          formatNumber(row.rowCount)
        ),
    },
    {
      key: 'created',
      header: 'Requested',
      secondary: true,
      nowrap: true,
      render: (row) => <span className="text-ink-muted">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('reports.actions')}</span>,
      align: 'right',
      render: (row) =>
        row.status === 'SUCCEEDED' ? (
          <Button
            size="sm"
            // Scoped to the row being fetched, so one download does not put
            // every other Download button into a spinner.
            isLoading={download.isPending && download.variables.id === row.id}
            onClick={() => {
              download.mutate(row);
            }}
          >
            {t('reports.download')}
            <span className="sr-only"> the {humanise(row.type)} export</span>
          </Button>
        ) : isWorking(row) ? (
          <span className="text-xs text-ink-subtle">{t('reports.stillRunning')}</span>
        ) : null,
    },
  ];

  return (
    <Card title={t('reports.exports')} description={t('reports.csvGeneratedInTheBackground')}>
      {canCreate && (
        <Toolbar>
          <ToolbarField label={t('reports.whatToExport')}>
            <Select
              value={type}
              onChange={(event) => {
                setType(event.target.value);
              }}
              className="w-52"
            >
              {EXPORT_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </ToolbarField>

          <Button
            variant="primary"
            isLoading={create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            Request export
          </Button>

          <ToolbarActions>
            <p className="text-xs text-ink-muted">
              An export covers everything, not the period chosen above.
            </p>
          </ToolbarActions>
        </Toolbar>
      )}

      <DataTable
        caption="Exports"
        columns={columns}
        rows={query.data?.exports}
        rowKey={(row) => row.id}
        isLoading={query.isPending}
        error={query.isError ? query.error : undefined}
        loadingLabel="Loading exports"
        minWidth="46rem"
        onRetry={() => {
          void query.refetch();
        }}
        emptyTitle="No exports yet"
        emptyDescription={
          canCreate
            ? 'Request one above. It is queued, and the download appears here when it is ready.'
            : 'Nothing has been exported.'
        }
      />
    </Card>
  );
}

export function ReportsPage(): React.JSX.Element {
  const { t } = useI18n();

  const [searchParams, setSearchParams] = useSearchParams();
  const days = Number(searchParams.get('days') ?? '30');

  const range = useMemo(() => {
    const to = new Date();
    const span = Number.isFinite(days) && days > 0 ? days : 30;
    const from = new Date(to.getTime() - span * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [days]);

  const sales = useQuery({
    queryKey: ['report-sales', range],
    queryFn: () => api.get<SalesReport>('/admin/reports/sales', { query: range }),
  });

  const orders = useQuery({
    queryKey: ['report-orders', range],
    queryFn: () => api.get<OrdersReport>('/admin/reports/orders', { query: range }),
  });

  const currency = sales.data?.summary.currency ?? 'INR';
  const reportWindow = sales.data?.summary.window;

  const statusColumns: Column<OrdersReport['byStatus'][number]>[] = [
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge dot>{humanise(row.status)}</Badge>,
    },
    {
      key: 'count',
      header: 'Orders',
      align: 'right',
      render: (row) => formatNumber(row.count),
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      nowrap: true,
      render: (row) =>
        formatMoney({ minor: row.value, formatted: minorToMajor(row.value), currency }),
    },
  ];

  const ageingColumns: Column<OrdersReport['fulfilmentAgeing'][number]>[] = [
    { key: 'bucket', header: 'Waiting', nowrap: true, render: (row) => row.bucket },
    { key: 'count', header: 'Orders', align: 'right', render: (row) => formatNumber(row.count) },
    {
      key: 'oldest',
      header: 'Oldest',
      align: 'right',
      nowrap: true,
      render: (row) =>
        row.oldestOrderNumber === null ? (
          <span className="text-ink-subtle">—</span>
        ) : (
          <span className="font-mono text-xxs">
            {row.oldestOrderNumber}
            {row.oldestAgeDays !== null && ` · ${formatNumber(row.oldestAgeDays)}d`}
          </span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('reports.reports')}
        description={t('reports.orderedCollectedAndRefundedKept')}
      />

      <div className="space-y-5">
        <Card
          title={t('reports.sales')}
          // The dates the figures actually cover. "Last 30 days" is not a
          // period a number can be quoted against six weeks later.
          {...(reportWindow === undefined
            ? {}
            : {
                description: `${formatDate(reportWindow.from)} to ${formatDate(reportWindow.to)}`,
              })}
          actions={
            <label className="flex items-center gap-2">
              <span className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                {t('reports.period')}
              </span>
              <Select
                value={String(days)}
                onChange={(event) => {
                  setSearchParams({ days: event.target.value }, { replace: true });
                }}
                className="h-8 w-40 py-0 text-xs"
              >
                {WINDOWS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
          }
        >
          {sales.isPending && <LoadingState label={t('reports.loadingSales')} />}
          {sales.isError && (
            <ErrorState
              error={sales.error}
              onRetry={() => {
                void sales.refetch();
              }}
            />
          )}

          {sales.data !== undefined && (
            <div className="space-y-4 px-5 py-4">
              {/* The four that get quoted. */}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Metric
                  label={t('reports.orders')}
                  value={formatNumber(sales.data.summary.orderCount)}
                  emphasis="primary"
                  sub={`Average ${formatMoney(sales.data.summary.averageOrderValue)}`}
                />
                <Metric
                  label={t('reports.grossSales')}
                  value={formatMoney(sales.data.summary.grossSales)}
                  emphasis="primary"
                  sub="Ordered, including tax and shipping"
                />
                <Metric
                  label={t('reports.collected')}
                  value={formatMoney(sales.data.summary.collected)}
                  emphasis="primary"
                  sub="Confirmed by the gateway, not merely ordered"
                />
                <Metric
                  label={t('reports.netRevenue')}
                  value={formatMoney(sales.data.summary.netRevenue)}
                  emphasis="primary"
                  sub={`Collected less ${formatMoney(sales.data.summary.refunded)} refunded`}
                />
              </div>

              {/* The four they break down into. Same cards, one step quieter. */}
              <div className="grid gap-3 border-t border-border-subtle pt-4 sm:grid-cols-2 xl:grid-cols-4">
                <Metric label={t('reports.tax')} value={formatMoney(sales.data.summary.tax)} />
                <Metric
                  label={t('reports.shipping')}
                  value={formatMoney(sales.data.summary.shipping)}
                />
                <Metric
                  label={t('reports.discounts')}
                  value={formatMoney(sales.data.summary.discount)}
                />
                <Metric
                  label={t('reports.refunded')}
                  value={formatMoney(sales.data.summary.refunded)}
                />
              </div>
            </div>
          )}
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card
            title={t('reports.ordersByStatus')}
            description={t('reports.everyOrderPlacedInThe')}
          >
            <DataTable
              caption="Orders by status"
              columns={statusColumns}
              rows={orders.data?.byStatus}
              rowKey={(row) => row.status}
              isLoading={orders.isPending}
              error={orders.isError ? orders.error : undefined}
              loadingLabel="Loading orders by status"
              onRetry={() => {
                void orders.refetch();
              }}
              emptyTitle="No orders in this period"
              emptyDescription="Widen the period to see more."
            />
          </Card>

          <Card
            title={t('reports.fulfilmentAgeing')}
            description={t('reports.howLongConfirmedOrdersHave')}
          >
            <DataTable
              caption="Fulfilment ageing"
              columns={ageingColumns}
              rows={orders.data?.fulfilmentAgeing}
              rowKey={(row) => row.bucket}
              isLoading={orders.isPending}
              error={orders.isError ? orders.error : undefined}
              loadingLabel="Loading fulfilment ageing"
              emptyTitle="Nothing waiting"
              emptyDescription="No confirmed order is sitting unshipped."
            />
          </Card>
        </div>

        <ExportsPanel />
      </div>
    </>
  );
}
