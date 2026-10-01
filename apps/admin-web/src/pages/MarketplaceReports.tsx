/**
 * Reports → marketplace: GMV, supplier quality, inspection, disputes and
 * settlement, for the same window as the rest of the Reports page.
 *
 * Money is never added across currencies: each currency is its own row. The
 * settlement card is fetched only for a role holding payment.read, the same
 * line the payments report draws - the server refuses it anyway.
 */
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Badge, Card, ErrorState, LoadingState, Metric } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney, formatNumber, humanise } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { Money } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

export interface MarketplaceReport {
  gmv: {
    byCurrency: { currency: string; orders: number; gmv: Money; discount: Money }[];
    sellerGmv: { currency: string; sellerOrders: number; gmv: Money; commission: Money }[];
  };
  supplierQuality: {
    sellerAccountId: string;
    displayName: string;
    orders: number;
    cancelled: number;
    returns: number;
    claims: number;
    inspections: number;
    inspectionFails: number;
  }[];
  inspection: {
    requirementsByStatus: { status: string; count: number }[];
    jobsByStatus: { status: string; count: number }[];
    signed: number;
    failed: number;
    openNcrsBySeverity: { severity: string; count: number }[];
    overdueReports: number;
  };
  disputes: {
    byStatus: { kind: string; status: string; count: number }[];
    byResolution: { resolution: string; count: number }[];
    awarded: { currency: string; amount: Money }[];
    sellerResponseOverdue: number;
  };
}

export interface SettlementReport {
  settlements: {
    status: string;
    currency: string;
    count: number;
    gross: Money;
    commission: Money;
    refunds: Money;
    netPayable: Money;
  }[];
  payouts: { status: string; currency: string; count: number; amount: Money }[];
  failedPayoutsOpen: number;
  settlementsOnHold: number;
}

/** "3 of 40 (8%)", or a dash when nothing was measured. */
function share(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${formatNumber(part)} / ${formatNumber(whole)} (${String(Math.round((part / whole) * 100))}%)`;
}

export function MarketplaceReports({ range }: { range: { from: string; to: string } }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const canSeeSettlements = can(Permission.PAYMENT_READ);

  const report = useQuery({
    queryKey: ['report-marketplace', range],
    queryFn: () => api.get<MarketplaceReport>('/admin/reports/marketplace', { query: range }),
  });

  const settlements = useQuery({
    queryKey: ['report-settlements', range],
    queryFn: () => api.get<SettlementReport>('/admin/reports/settlements', { query: range }),
    enabled: canSeeSettlements,
  });

  const supplierColumns: Column<MarketplaceReport['supplierQuality'][number]>[] = [
    { key: 'seller', header: t('reports.marketplace.seller'), render: (row) => row.displayName },
    { key: 'orders', header: t('label.orders'), align: 'right', render: (row) => formatNumber(row.orders) },
    {
      key: 'returns',
      header: t('reports.marketplace.returns'),
      align: 'right',
      nowrap: true,
      render: (row) => share(row.returns, row.orders),
    },
    {
      key: 'claims',
      header: t('reports.marketplace.claims'),
      align: 'right',
      nowrap: true,
      render: (row) => share(row.claims, row.orders),
    },
    {
      key: 'inspections',
      header: t('reports.marketplace.inspectionFails'),
      align: 'right',
      nowrap: true,
      render: (row) => share(row.inspectionFails, row.inspections),
    },
    {
      key: 'cancelled',
      header: t('reports.marketplace.cancelled'),
      align: 'right',
      nowrap: true,
      render: (row) => share(row.cancelled, row.orders),
    },
  ];

  const settlementColumns: Column<SettlementReport['settlements'][number]>[] = [
    { key: 'status', header: t('label.status'), render: (row) => <Badge dot>{humanise(row.status)}</Badge> },
    { key: 'currency', header: t('reports.marketplace.currency'), render: (row) => row.currency },
    { key: 'count', header: t('reports.marketplace.statements'), align: 'right', render: (row) => formatNumber(row.count) },
    { key: 'gross', header: t('reports.marketplace.gross'), align: 'right', nowrap: true, render: (row) => formatMoney(row.gross) },
    {
      key: 'commission',
      header: t('reports.marketplace.commission'),
      align: 'right',
      nowrap: true,
      render: (row) => formatMoney(row.commission),
    },
    {
      key: 'net',
      header: t('reports.marketplace.netPayable'),
      align: 'right',
      nowrap: true,
      render: (row) => formatMoney(row.netPayable),
    },
  ];

  const payoutColumns: Column<SettlementReport['payouts'][number]>[] = [
    { key: 'status', header: t('label.status'), render: (row) => <Badge dot>{humanise(row.status)}</Badge> },
    { key: 'currency', header: t('reports.marketplace.currency'), render: (row) => row.currency },
    { key: 'count', header: t('reports.marketplace.payouts'), align: 'right', render: (row) => formatNumber(row.count) },
    { key: 'amount', header: t('label.value'), align: 'right', nowrap: true, render: (row) => formatMoney(row.amount) },
  ];

  return (
    <div className="space-y-5">
      <Card title={t('reports.marketplace.gmv')} description={t('reports.marketplace.gmvIntro')}>
        {report.isPending && <LoadingState label={t('reports.marketplace.loading')} />}
        {report.isError && (
          <ErrorState
            error={report.error}
            onRetry={() => {
              void report.refetch();
            }}
          />
        )}
        {report.data !== undefined && (
          <div className="grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
            {report.data.gmv.byCurrency.length === 0 && (
              <Metric label={t('reports.marketplace.gmv')} value="—" sub={t('reports.noOrdersInThisPeriod')} />
            )}
            {report.data.gmv.byCurrency.map((row) => (
              <Metric
                key={`gmv-${row.currency}`}
                label={t('reports.marketplace.gmvIn', { currency: row.currency })}
                value={formatMoney(row.gmv)}
                emphasis="primary"
                sub={t('reports.marketplace.ordersCount', { orders: formatNumber(row.orders) })}
              />
            ))}
            {report.data.gmv.sellerGmv.map((row) => (
              <Metric
                key={`seller-${row.currency}`}
                label={t('reports.marketplace.sellerGmvIn', { currency: row.currency })}
                value={formatMoney(row.gmv)}
                sub={t('reports.marketplace.commissionEarned', { amount: formatMoney(row.commission) })}
              />
            ))}
          </div>
        )}
      </Card>

      <Card title={t('reports.marketplace.supplierQuality')} description={t('reports.marketplace.supplierQualityIntro')}>
        <DataTable
          caption={t('reports.marketplace.supplierQuality')}
          columns={supplierColumns}
          rows={report.data?.supplierQuality}
          rowKey={(row) => row.sellerAccountId}
          isLoading={report.isPending}
          error={report.isError ? report.error : undefined}
          loadingLabel={t('reports.marketplace.loading')}
          emptyTitle={t('reports.marketplace.noSupplierActivity')}
          emptyDescription={t('reports.widenThePeriod')}
        />
      </Card>

      {report.data !== undefined && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card title={t('reports.marketplace.inspection')} description={t('reports.marketplace.inspectionIntro')}>
            <div className="grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-3">
              <Metric
                label={t('reports.marketplace.reportsSigned')}
                value={formatNumber(report.data.inspection.signed)}
              />
              <Metric
                label={t('reports.marketplace.failRate')}
                value={share(report.data.inspection.failed, report.data.inspection.signed)}
              />
              <Metric
                label={t('reports.marketplace.reportsOverdue')}
                value={formatNumber(report.data.inspection.overdueReports)}
              />
            </div>
            <ul className="divide-y divide-border-subtle border-t border-border-subtle">
              {report.data.inspection.requirementsByStatus.map((row) => (
                <li key={`req-${row.status}`} className="flex justify-between px-5 py-2 text-sm">
                  <span className="text-ink-muted">{humanise(row.status)}</span>
                  <span className="tabular font-semibold text-ink">{formatNumber(row.count)}</span>
                </li>
              ))}
              {report.data.inspection.openNcrsBySeverity.map((row) => (
                <li key={`ncr-${row.severity}`} className="flex justify-between px-5 py-2 text-sm">
                  <span className="text-ink-muted">
                    {t('reports.marketplace.openNcrs', { severity: humanise(row.severity) })}
                  </span>
                  <span className="tabular font-semibold text-ink">{formatNumber(row.count)}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title={t('reports.marketplace.disputes')} description={t('reports.marketplace.disputesIntro')}>
            <div className="grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-2">
              <Metric
                label={t('reports.marketplace.sellerResponseOverdue')}
                value={formatNumber(report.data.disputes.sellerResponseOverdue)}
              />
              {report.data.disputes.awarded.map((row) => (
                <Metric
                  key={`awarded-${row.currency}`}
                  label={t('reports.marketplace.awardedIn', { currency: row.currency })}
                  value={formatMoney(row.amount)}
                />
              ))}
            </div>
            <ul className="divide-y divide-border-subtle border-t border-border-subtle">
              {report.data.disputes.byStatus.map((row) => (
                <li key={`${row.kind}-${row.status}`} className="flex justify-between px-5 py-2 text-sm">
                  <span className="text-ink-muted">
                    {humanise(row.kind)} · {humanise(row.status)}
                  </span>
                  <span className="tabular font-semibold text-ink">{formatNumber(row.count)}</span>
                </li>
              ))}
              {report.data.disputes.byResolution.map((row) => (
                <li key={`res-${row.resolution}`} className="flex justify-between px-5 py-2 text-sm">
                  <span className="text-ink-muted">
                    {t('reports.marketplace.decided', { outcome: humanise(row.resolution) })}
                  </span>
                  <span className="tabular font-semibold text-ink">{formatNumber(row.count)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {canSeeSettlements && (
        <Card title={t('reports.marketplace.settlement')} description={t('reports.marketplace.settlementIntro')}>
          {settlements.data !== undefined && (
            <div className="grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-2">
              <Metric
                label={t('reports.marketplace.settlementsOnHold')}
                value={formatNumber(settlements.data.settlementsOnHold)}
              />
              <Metric
                label={t('reports.marketplace.failedPayouts')}
                value={formatNumber(settlements.data.failedPayoutsOpen)}
              />
            </div>
          )}
          <DataTable
            caption={t('reports.marketplace.settlement')}
            columns={settlementColumns}
            rows={settlements.data?.settlements}
            rowKey={(row) => `${row.status}-${row.currency}`}
            isLoading={settlements.isPending}
            error={settlements.isError ? settlements.error : undefined}
            loadingLabel={t('reports.marketplace.loading')}
            emptyTitle={t('reports.marketplace.noSettlements')}
            emptyDescription={t('reports.widenThePeriod')}
          />
          <DataTable
            caption={t('reports.marketplace.payouts')}
            columns={payoutColumns}
            rows={settlements.data?.payouts}
            rowKey={(row) => `${row.status}-${row.currency}`}
            isLoading={settlements.isPending}
            error={settlements.isError ? settlements.error : undefined}
            loadingLabel={t('reports.marketplace.loading')}
            emptyTitle={t('reports.marketplace.noPayouts')}
            emptyDescription={t('reports.widenThePeriod')}
          />
        </Card>
      )}
    </div>
  );
}
