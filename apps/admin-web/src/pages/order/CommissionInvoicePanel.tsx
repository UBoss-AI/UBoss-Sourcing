/**
 * The commission the marketplace charged each seller on this order, and its
 * commission invoice.
 *
 * One row per seller order. "Generate Commission Invoice" is offered only when
 * the server says the seller order is eligible - payment captured, not
 * cancelled, the commission final at the configured stage - and is replaced by
 * "View Commission Invoice" and "Download PDF" once one exists, so a second
 * click has nothing to press. The server enforces the same rule regardless.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, LinkButton } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { commissionApi, downloadCommissionDocument, newIdempotencyKey } from '@/lib/commission-invoices';
import { STATUS_TONE, blockerText } from '@/pages/finance/commission-shared';

export function CommissionInvoicePanel({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { can } = useSession();
  const allowed = can(Permission.COMMISSION_INVOICE_VIEW);
  const query = useQuery({
    queryKey: ['admin', 'order-commission', orderId],
    queryFn: () => commissionApi.forOrder(orderId),
    enabled: allowed,
  });
  const generate = useMutation({
    mutationFn: (sellerOrderGroupId: string) => commissionApi.generate(sellerOrderGroupId, newIdempotencyKey()),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['admin', 'order-commission', orderId] });
      void navigate(`/finance/commission-invoices/${result.invoice.id}`);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });
  const download = useMutation({
    mutationFn: ({ documentId, name }: { documentId: string; name: string }) => downloadCommissionDocument(documentId, name),
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (!allowed || query.data === undefined || query.data.sellerOrders.length === 0) return null;

  return (
    <Card title={t('commission.panel.title')} description={t('commission.panel.intro')}>
      <ul className="divide-y divide-border-subtle text-sm">
        {query.data.sellerOrders.map((row) => (
          <li key={row.sellerOrderGroupId} className="space-y-2 px-5 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-ink">{row.sellerName}</p>
                <p className="text-xs text-ink-muted">
                  {row.sellerOrderNumber}
                  {row.platformFee !== null &&
                    ` · ${t('commission.panel.fee', { fee: formatMoney(row.platformFee), tax: formatMoney(row.platformFeeTax) })}`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {row.active === null ? (
                  can(Permission.COMMISSION_INVOICE_GENERATE) && (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={row.blockers.length > 0}
                      isLoading={generate.isPending && generate.variables === row.sellerOrderGroupId}
                      onClick={() => {
                        generate.mutate(row.sellerOrderGroupId);
                      }}
                    >
                      {t('commission.panel.generate')}
                    </Button>
                  )
                ) : (
                  <>
                    <Badge tone={STATUS_TONE[row.active.status] ?? 'neutral'}>{t(`commission.status.${row.active.status}` as TranslationKey)}</Badge>
                    <LinkButton size="sm" variant="secondary" to={`/finance/commission-invoices/${row.active.id}`}>
                      {t('commission.panel.view')}
                    </LinkButton>
                    {row.active.documentId !== null && can(Permission.COMMISSION_INVOICE_DOWNLOAD) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        isLoading={download.isPending}
                        onClick={() => {
                          if (row.active?.documentId != null) {
                            download.mutate({ documentId: row.active.documentId, name: `Gloviaa-Mart-Commission-Invoice-${row.active.number ?? row.active.id}.pdf` });
                          }
                        }}
                      >
                        {t('commission.panel.download')}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
            {row.active === null && row.blockers.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-muted">
                {row.blockers.map((blocker) => (
                  <li key={blocker.code}>{blockerText(t, blocker)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
