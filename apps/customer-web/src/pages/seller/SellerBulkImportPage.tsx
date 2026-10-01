/**
 * Seller Hub -> Bulk update (checklist Master row 37).
 *
 * Upload a CSV or XLSX keyed by the seller's own SKUs, see every problem and
 * every change before anything happens, then apply. Only existing listings of
 * this seller are touched; new listings still go through the listing wizard
 * and review. The server re-checks the file on apply and refuses a file with
 * problems, so the "Apply" button is a convenience, not the guard.
 */
import { useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import {
  applySellerImport,
  fetchSellerImports,
  uploadSellerImport,
  type SellerImportChange,
  type SellerImportView,
} from '@/lib/seller-workbench';
import { ApprovalRequiredNotice, type SellerOutletContext } from './SellerLayout';

const TEMPLATE_COLUMNS =
  'seller_sku,price,compare_at_price,minimum_order_quantity,status,location_code,available_quantity';

export function SellerBulkImportPage(): React.JSX.Element {
  const { t } = useI18n();
  const seller = useOutletContext<SellerOutletContext>();

  if (!seller.isTrading) {
    return (
      <>
        <PageHeader title={t('sellerImport.title')} />
        <ApprovalRequiredNotice seller={seller} />
      </>
    );
  }

  return <BulkImportBody />;
}

function describeChange(t: ReturnType<typeof useI18n>['t'], change: SellerImportChange): string[] {
  const parts: string[] = [];
  if (change.price !== undefined) {
    parts.push(t('sellerImport.change.price', { from: change.price.from, to: change.price.to, currency: change.currency }));
  }
  if (change.compareAtPrice !== undefined) {
    parts.push(t('sellerImport.change.compareAt', { to: change.compareAtPrice.to, currency: change.currency }));
  }
  if (change.minimumOrderQuantity !== undefined) {
    parts.push(
      t('sellerImport.change.moq', { from: change.minimumOrderQuantity.from, to: change.minimumOrderQuantity.to }),
    );
  }
  if (change.status !== undefined) {
    parts.push(t(change.status.to === 'ACTIVE' ? 'sellerImport.change.activate' : 'sellerImport.change.pause'));
  }
  if (change.stock !== undefined) {
    parts.push(
      t('sellerImport.change.stock', {
        location: change.stock.locationCode,
        from: change.stock.from,
        to: change.stock.to,
      }),
    );
  }
  return parts;
}

function BulkImportBody(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState<SellerImportView | null>(null);

  const history = useQuery({ queryKey: ['seller', 'bulk-imports'], queryFn: fetchSellerImports });

  const upload = useMutation({
    mutationFn: uploadSellerImport,
    onSuccess: async (view) => {
      setCurrent(view);
      await client.invalidateQueries({ queryKey: ['seller', 'bulk-imports'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const apply = useMutation({
    mutationFn: applySellerImport,
    onSuccess: async (view) => {
      setCurrent(view);
      toast.success(t('sellerImport.applied', { count: view.job.updatedRows }));
      await client.invalidateQueries({ queryKey: ['seller', 'bulk-imports'] });
      await client.invalidateQueries({ queryKey: ['seller', 'inventory'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const canApply =
    current !== null &&
    current.job.isDryRun &&
    current.appliedJobId === null &&
    current.errors.length === 0 &&
    (current.preview?.changes.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <PageHeader title={t('sellerImport.title')} description={t('sellerImport.description')} />

      <Card title={t('sellerImport.uploadTitle')} bodyClassName="px-6 py-5 space-y-4">
        <p className="text-sm text-ink-muted">{t('sellerImport.columnsHelp')}</p>
        <code className="block overflow-x-auto rounded bg-surface-sunken px-3 py-2 text-xs">{TEMPLATE_COLUMNS}</code>
        <div className="flex flex-wrap items-center gap-3">
          <a
            className="text-sm font-medium text-brand underline"
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(`${TEMPLATE_COLUMNS}\r\n`)}`}
            download="listing-update-template.csv"
          >
            {t('sellerImport.template')}
          </a>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label={t('sellerImport.chooseFile')}
            className="text-sm"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file !== undefined) upload.mutate(file);
              event.currentTarget.value = '';
            }}
          />
          {upload.isPending && <span className="text-sm text-ink-muted">{t('sellerImport.checking')}</span>}
        </div>
      </Card>

      {current !== null && (
        <Card
          title={current.job.isDryRun ? t('sellerImport.previewTitle') : t('sellerImport.resultTitle')}
          description={current.job.fileName}
          bodyClassName="px-6 py-5 space-y-4"
        >
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge tone="neutral">{t('sellerImport.rows', { count: current.job.totalRows })}</Badge>
            {current.errors.length > 0 && (
              <Badge tone="danger">{t('sellerImport.problemRows', { count: current.job.invalidRows })}</Badge>
            )}
            {current.preview !== null && (
              <Badge tone="success">{t('sellerImport.changes', { count: current.preview.changes.length })}</Badge>
            )}
            {!current.job.isDryRun && (
              <Badge tone="success">{t('sellerImport.updated', { count: current.job.updatedRows })}</Badge>
            )}
          </div>

          {current.errors.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{t('sellerImport.problems')}</caption>
                <thead>
                  <tr className="text-ink-muted">
                    <th className="py-1 pr-3">{t('sellerImport.row')}</th>
                    <th className="py-1 pr-3">{t('sellerImport.column')}</th>
                    <th className="py-1 pr-3">{t('sellerImport.problem')}</th>
                  </tr>
                </thead>
                <tbody>
                  {current.errors.map((error, index) => (
                    <tr key={`${String(error.rowNumber)}-${String(index)}`} className="border-t border-border">
                      <td className="py-1 pr-3">{error.rowNumber}</td>
                      <td className="py-1 pr-3">{error.columnName ?? '—'}</td>
                      <td className="py-1 pr-3">
                        {error.message}
                        {error.rawValue !== null && <span className="text-ink-muted"> ({error.rawValue})</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {current.job.isDryRun && <p className="mt-2 text-sm text-ink-muted">{t('sellerImport.fixAndRetry')}</p>}
            </div>
          )}

          {current.preview !== null && current.preview.changes.length > 0 && (
            <ul className="space-y-1 text-sm" aria-label={t('sellerImport.previewTitle')}>
              {current.preview.changes.map((change) => (
                <li key={change.rowNumber}>
                  <span className="font-medium text-ink">{change.sellerSku}</span>
                  <span className="text-ink-muted"> — {describeChange(t, change).join('; ')}</span>
                </li>
              ))}
            </ul>
          )}

          {current.preview !== null && current.preview.changes.length === 0 && current.errors.length === 0 && (
            <p className="text-sm text-ink-muted">{t('sellerImport.nothingToChange')}</p>
          )}

          {canApply && (
            <Button
              isLoading={apply.isPending}
              onClick={() => {
                apply.mutate(current.job.id);
              }}
            >
              {t('sellerImport.apply')}
            </Button>
          )}
        </Card>
      )}

      <Card title={t('sellerImport.history')}>
        {history.isPending ? (
          <LoadingState />
        ) : history.isError ? (
          <ErrorState
            error={history.error}
            onRetry={() => {
              void history.refetch();
            }}
          />
        ) : history.data.length === 0 ? (
          <EmptyState title={t('sellerImport.noHistory')} />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {history.data.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3">
                <span className="text-ink">{job.fileName}</span>
                <span className="text-ink-muted">{formatDateTime(job.createdAt)}</span>
                <Badge tone={job.isDryRun ? 'neutral' : job.status === 'SUCCEEDED' ? 'success' : 'warning'}>
                  {job.isDryRun ? t('sellerImport.kindPreview') : t('sellerImport.kindApplied')}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
