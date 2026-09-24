/**
 * Bulk preorders across every seller, for support and audit. Read-only.
 *
 * A preorder is a negotiation between a buyer and a seller, and the operator
 * has no business answering for either of them - so this page and the one it
 * opens show what was asked, every set of terms proposed and what was agreed,
 * and offer no action that would change any of it.
 */
import { useSearchParams } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Badge, PageHeader, Select, Toolbar, ToolbarField } from '@/components/ui';
import { api } from '@/lib/api';
import { PREORDER_STATUSES, preorderTone } from '@/lib/preorders';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import type { Money } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';

interface Row {
  id: string;
  requestNumber: string;
  status: string;
  /** OPERATOR: the store's own product - staff answer it. */
  supplier?: 'SELLER' | 'OPERATOR';
  baseUnits: number;
  requestedDeliveryDate: string;
  committedDeliveryDate: string | null;
  value: Money | null;
  updatedAt: string;
  productName: string;
  sellerName: string;
  buyerOrganization: string;
}

export function PreordersPage(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const supplier = params.get('supplier') ?? '';

  const query = useQuery({
    queryKey: ['admin', 'preorders', status, supplier],
    queryFn: () =>
      api.get<{ preorders: Row[] }>('/admin/preorders', {
        query: {
          ...(status === '' ? {} : { status }),
          ...(supplier === '' ? {} : { supplier }),
        },
      }),
  });

  const columns: Column<Row>[] = [
    {
      key: 'number',
      header: t('preorders.column.request'),
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{row.requestNumber}</p>
          <p className="truncate text-xs text-ink-muted">{row.productName}</p>
        </div>
      ),
    },
    {
      key: 'seller',
      header: t('preorders.column.seller'),
      render: (row) =>
        row.supplier === 'OPERATOR' ? (
          <span className="inline-flex items-center gap-1.5">
            {row.sellerName}
            <Badge tone="operational">{t('preorders.ours')}</Badge>
          </span>
        ) : (
          row.sellerName
        ),
      secondary: true,
    },
    {
      key: 'buyer',
      header: t('preorders.column.buyer'),
      render: (row) => row.buyerOrganization,
      secondary: true,
    },
    {
      key: 'pieces',
      header: t('preorders.column.pieces'),
      render: (row) => formatNumber(row.baseUnits),
      align: 'right',
    },
    {
      key: 'value',
      header: t('preorders.column.value'),
      render: (row) => (row.value === null ? '—' : formatMoney(row.value)),
      align: 'right',
      tertiary: true,
    },
    {
      key: 'date',
      header: t('preorders.column.delivery'),
      render: (row) => row.committedDeliveryDate ?? row.requestedDeliveryDate,
      tertiary: true,
    },
    {
      key: 'status',
      header: t('preorders.column.status'),
      render: (row) => (
        <Badge tone={preorderTone(row.status)}>
          {t(`preorders.status.${row.status}` as TranslationKey)}
        </Badge>
      ),
      align: 'center',
    },
    {
      key: 'updated',
      header: t('preorders.column.updated'),
      render: (row) => formatDateTime(row.updatedAt),
      secondary: true,
    },
  ];

  return (
    <>
      <PageHeader title={t('preorders.title')} description={t('preorders.description')} />
      <Toolbar>
        <ToolbarField label={t('preorders.supplierFilter')}>
          <Select
            value={supplier}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.currentTarget.value === '') next.delete('supplier');
              else next.set('supplier', event.currentTarget.value);
              setParams(next, { replace: true });
            }}
          >
            <option value="">{t('preorders.supplier.all')}</option>
            <option value="OPERATOR">{t('preorders.supplier.OPERATOR')}</option>
            <option value="SELLER">{t('preorders.supplier.SELLER')}</option>
          </Select>
        </ToolbarField>
        <ToolbarField label={t('preorders.column.status')}>
          <Select
            value={status}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.currentTarget.value === '') next.delete('status');
              else next.set('status', event.currentTarget.value);
              setParams(next, { replace: true });
            }}
          >
            <option value="">{t('preorders.allStatuses')}</option>
            {PREORDER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`preorders.status.${value}` as TranslationKey)}
              </option>
            ))}
          </Select>
        </ToolbarField>
      </Toolbar>
      <DataTable
        caption={t('preorders.title')}
        columns={columns}
        rows={query.data?.preorders ?? []}
        rowKey={(row) => row.id}
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
        emptyTitle={t('preorders.empty')}
        onRowClick={(row) => {
          void navigate(`/preorders/${row.id}`);
        }}
      />
    </>
  );
}
