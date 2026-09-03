/**
 * Reports.
 *
 * The window lives in the URL so a report can be sent to someone as a link.
 *
 * The distinction the sales panel exists to make: **gross sales** is what was
 * ordered, **collected** is what the gateway actually confirmed, and **net
 * revenue** is collected minus refunds. Presenting only the first would report
 * unpaid orders as revenue, which is the most common way a dashboard lies.
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
import { Badge, Button, Card, ErrorState, LoadingState, PageHeader, Select } from '@/components/ui';
import { ApiError, api, downloadFile } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber, humanise, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { Money } from '@/lib/types';

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
  topProducts?: { productId: string; name: string; sku: string; quantity: number; revenue: Money }[];
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

function Metric({ label, value, note }: { label: string; value: string; note?: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3.5">
      <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{label}</p>
      <p className="mt-1.5 text-lg font-semibold tabular tracking-tight text-ink">{value}</p>
      {note !== undefined && <p className="mt-0.5 text-xs text-ink-muted">{note}</p>}
    </div>
  );
}

function ExportsPanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const [type, setType] = useState<string>('ORDERS');

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

  const columns: Column<ExportJob>[] = [
    { key: 'type', header: 'Export', render: (row) => humanise(row.type) },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge
          tone={
            row.status === 'SUCCEEDED'
              ? 'success'
              : row.status === 'FAILED' || row.status === 'DEAD'
                ? 'danger'
                : 'warning'
          }
        >
          {humanise(row.status)}
        </Badge>
      ),
    },
    {
      key: 'rows',
      header: 'Rows',
      align: 'right',
      secondary: true,
      render: (row) => (row.rowCount == null ? '—' : formatNumber(row.rowCount)),
    },
    {
      key: 'created',
      header: 'Requested',
      secondary: true,
      render: (row) => <span className="whitespace-nowrap">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) =>
        row.status === 'SUCCEEDED' ? (
          <Button
            size="sm"
            variant="ghost"
            isLoading={download.isPending}
            onClick={() => {
              download.mutate(row);
            }}
          >
            Download
          </Button>
        ) : null,
    },
  ];

  return (
    <Card
      title="Exports"
      description="Queued in the background. A large export does not hold up this page."
      actions={
        can(Permission.EXPORT_CREATE) ? (
          <div className="flex gap-2">
            <Select
              value={type}
              aria-label="Export type"
              onChange={(event) => {
                setType(event.target.value);
              }}
              className="h-8 py-0 text-xs"
            >
              {EXPORT_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              isLoading={create.isPending}
              onClick={() => {
                create.mutate();
              }}
            >
              Request export
            </Button>
          </div>
        ) : undefined
      }
    >
      <DataTable
        caption="Exports"
        columns={columns}
        rows={query.data?.exports}
        rowKey={(row) => row.id}
        isLoading={query.isPending}
        error={query.isError ? query.error : undefined}
        emptyTitle="No exports yet"
      />
    </Card>
  );
}

export function ReportsPage(): React.JSX.Element {
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

  const statusColumns: Column<OrdersReport['byStatus'][number]> = {
    key: 'status',
    header: 'Status',
    render: (row) => <Badge>{humanise(row.status)}</Badge>,
  };

  const ageingColumns: Column<OrdersReport['fulfilmentAgeing'][number]>[] = [
    { key: 'bucket', header: 'Waiting', render: (row) => row.bucket },
    { key: 'count', header: 'Orders', align: 'right', render: (row) => formatNumber(row.count) },
    {
      key: 'oldest',
      header: 'Oldest',
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
        title="Reports"
        description="Ordered, collected and refunded — kept separate, because they are different numbers."
        actions={
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <span className="sr-only sm:not-sr-only">Period</span>
            <Select
              value={String(days)}
              onChange={(event) => {
                setSearchParams({ days: event.target.value }, { replace: true });
              }}
              className="w-40"
            >
              {WINDOWS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
        }
      />

      <div className="space-y-5">
        <Card title="Sales">
          {sales.isPending && <LoadingState />}
          {sales.isError && (
            <ErrorState
              error={sales.error}
              onRetry={() => {
                void sales.refetch();
              }}
            />
          )}

          {sales.data !== undefined && (
            <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                label="Orders"
                value={formatNumber(sales.data.summary.orderCount)}
                note={`Average ${formatMoney(sales.data.summary.averageOrderValue)}`}
              />
              <Metric
                label="Gross sales"
                value={formatMoney(sales.data.summary.grossSales)}
                note="What was ordered, including tax and shipping"
              />
              <Metric
                label="Collected"
                value={formatMoney(sales.data.summary.collected)}
                note="Confirmed by the gateway, not merely ordered"
              />
              <Metric
                label="Net revenue"
                value={formatMoney(sales.data.summary.netRevenue)}
                note={`Collected less ${formatMoney(sales.data.summary.refunded)} refunded`}
              />
              <Metric label="Tax" value={formatMoney(sales.data.summary.tax)} />
              <Metric label="Shipping" value={formatMoney(sales.data.summary.shipping)} />
              <Metric label="Discounts" value={formatMoney(sales.data.summary.discount)} />
              <Metric label="Refunded" value={formatMoney(sales.data.summary.refunded)} />
            </div>
          )}
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Orders by status">
            <DataTable
              caption="Orders by status"
              columns={[
                statusColumns,
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
                  render: (row) =>
                    formatMoney({
                      minor: row.value,
                      formatted: minorToMajor(row.value),
                      currency,
                    }),
                },
              ]}
              rows={orders.data?.byStatus}
              rowKey={(row) => row.status}
              isLoading={orders.isPending}
              error={orders.isError ? orders.error : undefined}
              emptyTitle="No orders in this period"
            />
          </Card>

          <Card
            title="Fulfilment ageing"
            description="How long confirmed orders have been waiting to ship."
          >
            <DataTable
              caption="Fulfilment ageing"
              columns={ageingColumns}
              rows={orders.data?.fulfilmentAgeing}
              rowKey={(row) => row.bucket}
              isLoading={orders.isPending}
              emptyTitle="Nothing waiting"
            />
          </Card>
        </div>

        <ExportsPanel />
      </div>
    </>
  );
}
