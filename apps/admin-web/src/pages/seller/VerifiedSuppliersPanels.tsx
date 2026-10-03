/**
 * Verified suppliers and newly verified suppliers, on the Sellers screen.
 *
 * These were two sections of the storefront's home page. They are the
 * operator's view now: who the marketplace has approved and who has something
 * live to sell is something the people running it check, not something every
 * visitor needs between the categories and the shelves.
 *
 * Both read `GET /admin/sellers/verified`, which applies exactly the public
 * catalogue's rule for "verified" and is guarded by the same permission as the
 * application queue above it. Nothing here is beyond what a reviewer already
 * sees on that queue: public name, type, country, approval date and the count
 * of live products. A row opens the seller's record.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Card } from '@/components/ui';
import { fetchVerifiedSuppliers, type VerifiedSupplierRow } from '@/lib/sellers';
import { useI18n } from '@/i18n/i18n-context';

/** How recent "newly verified" means. The storefront used the same 90 days. */
export const NEW_SUPPLIER_DAYS = 90;

function useColumns(): Column<VerifiedSupplierRow>[] {
  const { t, intlLocale } = useI18n();

  return [
    {
      key: 'supplier',
      header: t('adminVerifiedSuppliers.columnSupplier'),
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{row.displayName}</p>
          <p className="truncate font-mono text-xxs text-ink-subtle">{row.slug}</p>
        </div>
      ),
    },
    {
      key: 'kind',
      header: t('adminVerifiedSuppliers.columnType'),
      secondary: true,
      render: (row) => (
        <span className="text-xs capitalize text-ink-muted">
          {row.kind.replace(/_/g, ' ').toLowerCase()}
        </span>
      ),
    },
    {
      key: 'country',
      header: t('adminVerifiedSuppliers.columnCountry'),
      secondary: true,
      render: (row) => <span className="text-xs text-ink-muted">{row.registrationCountry}</span>,
    },
    {
      key: 'verified',
      header: t('adminVerifiedSuppliers.columnVerified'),
      nowrap: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">
          {row.verifiedAt === null
            ? t('adminVerifiedSuppliers.undated')
            : new Date(row.verifiedAt).toLocaleDateString(intlLocale)}
        </span>
      ),
    },
    {
      key: 'products',
      header: t('adminVerifiedSuppliers.columnProducts'),
      align: 'right',
      render: (row) => (
        <span className="text-xs text-ink">{row.productCount.toLocaleString(intlLocale)}</span>
      ),
    },
  ];
}

export function VerifiedSuppliersPanels(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const columns = useColumns();

  const all = useQuery({
    queryKey: ['admin', 'sellers', 'verified'],
    queryFn: () => fetchVerifiedSuppliers(),
  });
  const newest = useQuery({
    queryKey: ['admin', 'sellers', 'verified', 'newest'],
    queryFn: () => fetchVerifiedSuppliers('newest'),
  });

  // Filtered here, as the storefront did: "newest" is an order, and a seller
  // verified two years ago is still the newest on a quiet marketplace.
  const cutoff = Date.now() - NEW_SUPPLIER_DAYS * 86_400_000;
  const recent = newest.data?.suppliers.filter(
    (row) => row.verifiedAt !== null && new Date(row.verifiedAt).getTime() >= cutoff,
  );

  const open = (row: VerifiedSupplierRow): void => {
    void navigate(`/sellers/${row.sellerId}`);
  };

  const shown = all.data?.suppliers.length ?? 0;
  const total = all.data?.total ?? 0;

  return (
    <div className="grid gap-5">
      <Card
        title={t('adminVerifiedSuppliers.title')}
        description={
          total > shown
            ? t('adminVerifiedSuppliers.descriptionPartial', { shown, total })
            : t('adminVerifiedSuppliers.description')
        }
      >
        <DataTable
          caption={t('adminVerifiedSuppliers.title')}
          columns={columns}
          rows={all.data?.suppliers ?? []}
          rowKey={(row) => row.sellerId}
          isLoading={all.isPending}
          error={all.error}
          onRetry={() => {
            void all.refetch();
          }}
          emptyTitle={t('adminVerifiedSuppliers.emptyTitle')}
          emptyDescription={t('adminVerifiedSuppliers.emptyDescription')}
          onRowClick={open}
        />
      </Card>

      <Card
        title={t('adminVerifiedSuppliers.newTitle')}
        description={t('adminVerifiedSuppliers.newDescription', { days: NEW_SUPPLIER_DAYS })}
      >
        <DataTable
          caption={t('adminVerifiedSuppliers.newTitle')}
          columns={columns}
          rows={recent ?? []}
          rowKey={(row) => row.sellerId}
          isLoading={newest.isPending}
          error={newest.error}
          onRetry={() => {
            void newest.refetch();
          }}
          emptyTitle={t('adminVerifiedSuppliers.newEmptyTitle')}
          emptyDescription={t('adminVerifiedSuppliers.newEmptyDescription', {
            days: NEW_SUPPLIER_DAYS,
          })}
          onRowClick={open}
        />
      </Card>
    </div>
  );
}
