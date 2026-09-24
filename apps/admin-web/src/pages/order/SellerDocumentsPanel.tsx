/**
 * The sellers' own invoices and packing lists on this order - read only.
 *
 * On a marketplace order each seller issues their own tax invoice, in their
 * own name and number series. The operator can see and download them (for a
 * dispute, a customs query, a reconciliation) but can never edit, void or
 * re-issue one: that is the seller's legal document, and the one way to
 * correct it is the seller's own credit note. Drafts are not shown - they are
 * the seller's working copy, not a document.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { api, downloadFile } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';

interface Money {
  minor: string;
  currency: string;
  formatted: string;
}

interface SellerInvoiceRow {
  id: string;
  kind: 'TAX_INVOICE' | 'CREDIT_NOTE';
  status: string;
  number: string | null;
  issuedAt: string | null;
  issuedByLabel: string | null;
  supplyType: string | null;
  totals: { grandTotal: Money; totalTax: Money };
  voidReason: string | null;
  sellerName: string;
}

interface PackingListRow {
  id: string;
  status: string;
  number: string | null;
  issuedAt: string | null;
  packageCount: number;
  totalBaseUnits: number;
  grossWeightGrams: string;
  vehicleRegistration: string | null;
  voidReason: string | null;
  sellerName: string;
}

const TONE: Record<string, BadgeTone> = {
  ISSUED: 'success',
  VOIDED: 'danger',
  CREDIT_NOTE_REQUIRED: 'warning',
  SUPERSEDED: 'neutral',
};

type Kind = 'invoice' | 'packing-list';

export function SellerDocumentsPanel({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const allowed = can(Permission.INVOICE_READ);

  const query = useQuery({
    queryKey: ['order-seller-documents', orderId],
    queryFn: () =>
      api.get<{ invoices: SellerInvoiceRow[]; packingLists: PackingListRow[] }>(
        `/admin/orders/${orderId}/seller-documents`,
      ),
    enabled: allowed,
  });

  const download = useMutation({
    mutationFn: async ({ kind, id, name }: { kind: Kind; id: string; name: string }) => {
      const link = await api.post<{ url: string }>(`/admin/documents/${kind}/${id}/link`);
      await downloadFile(link.url.replace(/^\/api\/v1/, ''), `${name}.pdf`);
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : t('sellerDocuments.downloadFailed'));
    },
  });

  if (!allowed || query.data === undefined) return null;
  const { invoices, packingLists } = query.data;
  if (invoices.length === 0 && packingLists.length === 0) return null;

  return (
    <Card title={t('sellerDocuments.title')} description={t('sellerDocuments.intro')}>
      <div className="divide-y divide-border-subtle text-sm">
        {invoices.map((invoice) => (
          <div
            key={invoice.id}
            className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
          >
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-ink">{invoice.number}</span>
                <Badge tone={TONE[invoice.status] ?? 'neutral'}>
                  {t(`sellerDocuments.status.${invoice.status}` as TranslationKey)}
                </Badge>
                <span className="text-ink-muted">
                  {invoice.kind === 'CREDIT_NOTE'
                    ? t('sellerDocuments.creditNote')
                    : t('sellerDocuments.taxInvoice')}
                </span>
              </p>
              <p className="text-xs text-ink-muted">
                {t('sellerDocuments.invoiceLine', {
                  seller: invoice.sellerName,
                  total: invoice.totals.grandTotal.formatted,
                  when: formatDateTime(invoice.issuedAt),
                })}
              </p>
              {invoice.voidReason !== null && (
                <p className="text-xs text-ink-muted">{invoice.voidReason}</p>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              isLoading={download.isPending && download.variables.id === invoice.id}
              onClick={() => {
                download.mutate({
                  kind: 'invoice',
                  id: invoice.id,
                  name: invoice.number ?? invoice.id,
                });
              }}
            >
              {t('sellerDocuments.download')}
            </Button>
          </div>
        ))}
        {packingLists.map((list) => (
          <div
            key={list.id}
            className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
          >
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-ink">{list.number}</span>
                <Badge tone={TONE[list.status] ?? 'neutral'}>
                  {t(`sellerDocuments.status.${list.status}` as TranslationKey)}
                </Badge>
                <span className="text-ink-muted">{t('sellerDocuments.packingList')}</span>
              </p>
              <p className="text-xs text-ink-muted">
                {t('sellerDocuments.listLine', {
                  seller: list.sellerName,
                  packages: list.packageCount,
                  quantity: list.totalBaseUnits,
                })}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              isLoading={download.isPending && download.variables.id === list.id}
              onClick={() => {
                download.mutate({
                  kind: 'packing-list',
                  id: list.id,
                  name: list.number ?? list.id,
                });
              }}
            >
              {t('sellerDocuments.download')}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
