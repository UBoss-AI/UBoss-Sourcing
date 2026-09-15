/**
 * Who this carrier ships for.
 *
 * Built entirely from the carrier's OWN consignments. There is nothing on this
 * screen that touches the marketplace's customer table, the seller table, an
 * order line or a payment: a carrier learns that it moves twelve consignments
 * a month for a named hospital, and nothing about what that hospital buys,
 * from whom, or for how much.
 *
 * That is not a filter applied on the way out — the server's query never
 * selects any of it. See `listCompanies` in `dashboard.service.ts`.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Select,
  Toolbar,
  ToolbarField,
} from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { useI18n } from '@/i18n/i18n-context';
import { formatDate } from '@/lib/format';
import { companiesKey, fetchCompanies } from '@/lib/logistics';
import type { CompanyRow } from '@/lib/types';

export function CompaniesPage(): React.JSX.Element {
  const { t } = useI18n();
  const [type, setType] = useState<'SELLER' | 'RECEIVER'>('RECEIVER');

  const companies = useQuery({
    queryKey: companiesKey(type),
    queryFn: () => fetchCompanies(type),
  });

  const columns: Column<CompanyRow>[] = [
    {
      key: 'name',
      header: t('companies.company'),
      render: (row) => (
        <Link
          // The company name is the filter. There is no company id in this
          // portal - a carrier has no business holding one - so the link
          // carries the name the consignments were addressed to.
          to={`/shipments?${type === 'SELLER' ? 'sellerCompany' : 'receivingCompany'}=${encodeURIComponent(row.name)}`}
          className="font-medium text-brand hover:underline"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: 'active',
      header: t('companies.active'),
      align: 'right',
      render: (row) => row.activeShipments,
    },
    {
      key: 'inTransit',
      header: t('companies.inTransit'),
      align: 'right',
      secondary: true,
      render: (row) => row.inTransitShipments,
    },
    {
      key: 'delivered',
      header: t('companies.delivered'),
      align: 'right',
      secondary: true,
      render: (row) => row.deliveredShipments,
    },
    {
      key: 'delayed',
      header: t('companies.delayed'),
      align: 'right',
      render: (row) => (
        <span className={row.delayedShipments > 0 ? 'text-warning' : undefined}>
          {row.delayedShipments}
        </span>
      ),
    },
    {
      key: 'regions',
      header: t('companies.regions'),
      tertiary: true,
      render: (row) => (row.mainRegions.length === 0 ? '—' : row.mainRegions.join(', ')),
    },
    {
      key: 'last',
      header: t('companies.lastShipment'),
      align: 'right',
      nowrap: true,
      tertiary: true,
      render: (row) => formatDate(row.lastShipmentAt),
    },
  ];

  return (
    <>
      <PageHeader title={t('companies.heading')} />

      <Card>
        {/*
          Sellers or receivers, as a named choice on the list itself.
          This was a lone checkbox chip in the page header, which is a
          toolbar control standing on the page background: it read as an
          empty box beside the title, and with it unticked nothing said the
          table was showing receiving companies rather than sellers.
        */}
        <Toolbar>
          <ToolbarField label={t('companies.showing')}>
            <Select
              value={type}
              onChange={(event) => {
                setType(event.target.value === 'SELLER' ? 'SELLER' : 'RECEIVER');
              }}
            >
              <option value="RECEIVER">{t('companies.receivers')}</option>
              <option value="SELLER">{t('companies.sellers')}</option>
            </Select>
          </ToolbarField>
        </Toolbar>

        {companies.isLoading ? (
          <LoadingState />
        ) : companies.isError ? (
          <ErrorState
            error={companies.error}
            onRetry={() => {
              void companies.refetch();
            }}
          />
        ) : (companies.data?.companies.length ?? 0) === 0 ? (
          <EmptyState title={t('companies.emptyTitle')} description={t('companies.emptyBody')} />
        ) : (
          <DataTable
            caption={t('companies.heading')}
            columns={columns}
            rows={companies.data?.companies}
            rowKey={(row) => row.name}
            minWidth="44rem"
          />
        )}
      </Card>
    </>
  );
}
