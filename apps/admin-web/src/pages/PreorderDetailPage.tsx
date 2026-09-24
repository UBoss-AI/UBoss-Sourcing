/**
 * One bulk preorder. Read-only on a seller's preorder, for support and audit;
 * on the operator's own product staff answer it here (`OperatorAnswerCard`).
 *
 * Every revision is shown with its terms reference (the first characters of
 * its SHA-256), which is what the audit trail's `preorder.buyer_confirmed`
 * entry names: support can tell a disputing buyer exactly which terms they
 * confirmed.
 */
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Card,
  DescriptionList,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import type { Money } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { preorderTone } from '@/lib/preorders';
import { currencyExponent } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useSession } from '@/auth/session-context';
import { OperatorAnswerCard, type AnswerablePreorder } from '@/pages/preorder/OperatorAnswerCard';

interface Offer {
  id: string;
  revision: number;
  kind: string;
  state: string;
  quantityBaseUnits: number;
  unitPrice: Money;
  freight: Money;
  total: Money;
  committedDeliveryDate: string;
  note: string | null;
  termsHash: string;
  createdByLabel: string;
  createdAt: string;
}

interface Detail extends AnswerablePreorder {
  id: string;
  /** OPERATOR: the store's own product, answered here by staff. */
  supplier: 'SELLER' | 'OPERATOR';
  requestNumber: string;
  status: string;
  product: { name: string; sku: string };
  seller: { name: string };
  buyer: { name: string; organization: string | null } | null;
  quantity: { orderingUnit: string; unitQuantity: number; baseUnits: number };
  requestedDeliveryDate: string;
  earliestDeliveryDate: string;
  destinationCountry: string;
  purchaseOrderReference: string | null;
  customerNotes: string | null;
  indicative: { unitPrice: Money | null; goodsTotal: Money | null };
  offers: Offer[];
  confirmed: { termsHash: string; committedDeliveryDate: string | null } | null;
  order: { id: string; orderNumber: string; status: string; grandTotal: Money } | null;
  capacityReservedBaseUnits: number | null;
  closedReason: string | null;
  history: { toStatus: string; actorLabel: string; reason: string | null; at: string }[];
  submittedAt: string;
}

export function PreorderDetailPage(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const { t } = useI18n();
  const { can } = useSession();
  const query = useQuery({
    queryKey: ['admin', 'preorder', id],
    queryFn: () =>
      api.get<{ preorder: Detail }>(`/admin/preorders/${id}`).then((body) => body.preorder),
  });

  if (query.isPending) return <LoadingState label={t('preorders.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const preorder = query.data;

  return (
    <>
      <PageHeader
        title={`${preorder.requestNumber} · ${preorder.product.name}`}
        back={{ to: '/preorders', label: t('preorders.title') }}
        meta={
          <Badge tone={preorderTone(preorder.status)}>
            {t(`preorders.status.${preorder.status}` as TranslationKey)}
          </Badge>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <Card title={t('preorders.request')}>
            <DescriptionList
              items={[
                { label: t('preorders.column.seller'), value: preorder.seller.name },
                {
                  label: t('preorders.column.buyer'),
                  value: preorder.buyer?.organization ?? preorder.buyer?.name ?? '—',
                },
                { label: t('preorders.sku'), value: preorder.product.sku },
                {
                  label: t('preorders.column.pieces'),
                  value: formatNumber(preorder.quantity.baseUnits),
                },
                { label: t('preorders.requestedDate'), value: preorder.requestedDeliveryDate },
                { label: t('preorders.earliestDate'), value: preorder.earliestDeliveryDate },
                { label: t('preorders.destination'), value: preorder.destinationCountry },
                {
                  label: t('preorders.poReference'),
                  value: preorder.purchaseOrderReference ?? '—',
                },
                {
                  label: t('preorders.indicative'),
                  value:
                    preorder.indicative.unitPrice === null
                      ? t('preorders.quoted')
                      : `${formatMoney(preorder.indicative.unitPrice)} · ${formatMoney(preorder.indicative.goodsTotal)}`,
                },
                {
                  label: t('preorders.capacityHeld'),
                  value: formatNumber(preorder.capacityReservedBaseUnits ?? 0),
                },
              ]}
            />
            {preorder.customerNotes !== null && (
              <p className="mt-3 whitespace-pre-line text-sm text-ink">{preorder.customerNotes}</p>
            )}
          </Card>

          <Card title={t('preorders.revisions')}>
            {preorder.offers.length === 0 ? (
              <p className="text-sm text-ink-muted">{t('preorders.noRevisions')}</p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {preorder.offers.map((offer) => (
                  <li key={offer.id} className="py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-ink">
                        {t('preorders.revision', { revision: String(offer.revision) })}
                      </p>
                      <Badge tone={offer.state === 'ACCEPTED' ? 'success' : 'neutral'}>
                        {offer.state}
                      </Badge>
                    </div>
                    <p className="mt-1 text-ink">
                      {t('preorders.revisionLine', {
                        pieces: formatNumber(offer.quantityBaseUnits),
                        price: formatMoney(offer.unitPrice),
                        freight: formatMoney(offer.freight),
                        date: offer.committedDeliveryDate,
                      })}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {offer.createdByLabel} · {formatDateTime(offer.createdAt)} ·{' '}
                      <span className="font-mono">{offer.termsHash.slice(0, 16)}</span>
                    </p>
                    {offer.note !== null && (
                      <p className="mt-1 text-xs text-ink-muted">{offer.note}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <aside className="space-y-4">
          {preorder.supplier === 'OPERATOR' && can(Permission.ORDER_FULFIL) && (
            <OperatorAnswerCard
              preorder={preorder}
              exponent={currencyExponent(preorder.currency)}
            />
          )}
          {preorder.order !== null && (
            <Card title={t('preorders.order')}>
              <Link
                to={`/orders/${preorder.order.id}`}
                className="text-sm font-medium text-brand hover:underline"
              >
                {preorder.order.orderNumber}
              </Link>
              <p className="mt-1 text-sm text-ink">{formatMoney(preorder.order.grandTotal)}</p>
            </Card>
          )}
          <Card title={t('preorders.history')}>
            <ol className="space-y-2 text-sm">
              {preorder.history.map((entry, index) => (
                <li key={`${entry.at}-${String(index)}`}>
                  <p className="text-ink">
                    {t(`preorders.status.${entry.toStatus}` as TranslationKey)}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {entry.actorLabel} · {formatDateTime(entry.at)}
                    {entry.reason !== null && ` — ${entry.reason}`}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
          <p className="text-xs text-ink-muted">
            {preorder.supplier === 'OPERATOR'
              ? t('preorders.answeredByStore')
              : t('preorders.readOnly')}
          </p>
        </aside>
      </div>
    </>
  );
}
