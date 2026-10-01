/**
 * The buyer's milestone timeline on their order (checklist Master row 22):
 * payment, and per seller the production stages, open exceptions, inspection,
 * shipments and documents, then everything in date order.
 *
 * Read-only. Renders nothing for an order with no sellers and no events, so an
 * ordinary order page is not given an empty card.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Card } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDate, formatDateTime } from '@/lib/format';
import { fetchOrderMilestones, type OrderMilestones } from '@/lib/order-milestones';
import { delayReasonKey, stageKey } from '@/lib/seller-workbench';

type EventRow = OrderMilestones['events'][number];

function eventText(t: ReturnType<typeof useI18n>['t'], event: EventRow): string {
  const stage = event.stage === undefined ? '' : t(stageKey(event.stage));
  switch (event.kind) {
    case 'MILESTONE_REACHED':
      return t('orderMilestones.event.reached', { stage });
    case 'MILESTONE_PLANNED':
      return t('orderMilestones.event.planned', { stage, date: formatDate(event.expectedDate ?? null) });
    case 'DELAY_RAISED':
      return t('orderMilestones.event.delayed', {
        stage,
        reason: event.reason == null ? '' : t(delayReasonKey(event.reason)),
        date: formatDate(event.expectedDate ?? null),
      });
    case 'DELAY_RESOLVED':
      return t('orderMilestones.event.resolved', { stage });
    case 'DOCUMENT_ISSUED':
      return t('orderMilestones.event.document', { title: event.label ?? '' });
    case 'SHIPMENT_DISPATCHED':
      return t('orderMilestones.event.dispatched', { carrier: event.label ?? '' });
    case 'SHIPMENT_DELIVERED':
      return t('orderMilestones.event.delivered');
    case 'PAYMENT_CONFIRMED':
      return t('orderMilestones.event.paid');
    case 'ORDER_PLACED':
      return t('orderMilestones.event.placed');
  }
}

export function OrderMilestoneTimeline({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['order', orderId, 'milestones'],
    queryFn: () => fetchOrderMilestones(orderId),
    retry: false,
  });

  if (!query.isSuccess) return null;
  const view = query.data;
  if (view.sellers.length === 0 && view.events.length === 0) return null;

  return (
    <Card title={t('orderMilestones.title')} bodyClassName="px-6 py-5 space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-muted">{t('orderMilestones.payment')}</span>
        <Badge tone={view.payment.state === 'PAID' ? 'success' : view.payment.state === 'UNPAID' ? 'warning' : 'neutral'}>
          {t(`orderMilestones.paymentState.${view.payment.state}` as TranslationKey)}
        </Badge>
        <span className="text-ink">
          {t('orderMilestones.paidOf', { paid: view.payment.paid.formatted, total: view.payment.total.formatted })}
        </span>
      </div>

      {view.sellers.map((seller) => (
        <section key={seller.sellerGroupId} className="space-y-3" data-testid={`milestones-${seller.sellerGroupId}`}>
          <h3 className="font-medium text-ink">{seller.sellerName}</h3>

          <ol className="grid gap-2 sm:grid-cols-4" aria-label={t('orderMilestones.production')}>
            {seller.production.stages.map((row) => (
              <li key={row.stage} className="rounded-lg border border-border px-3 py-2 text-sm">
                <p className="font-medium text-ink">{t(stageKey(row.stage))}</p>
                <p className="text-ink-muted">
                  {row.completedAt !== null
                    ? t('orderMilestones.doneOn', { date: formatDate(row.completedAt) })
                    : row.plannedFor !== null
                      ? t('orderMilestones.expected', { date: formatDate(row.plannedFor) })
                      : t('orderMilestones.pending')}
                </p>
                {row.note !== null && <p className="text-ink">{row.note}</p>}
              </li>
            ))}
          </ol>

          {seller.production.openDelays.map((delay) => (
            <p
              key={delay.raisedAt}
              role="status"
              className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-ink"
            >
              {t('orderMilestones.delayNotice', {
                stage: t(stageKey(delay.stage)),
                reason: delay.reason === null ? '' : t(delayReasonKey(delay.reason)),
                date: formatDate(delay.expectedDate),
              })}
              {delay.message !== null && <> {delay.message}</>}
            </p>
          ))}

          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-ink-muted">{t('orderMilestones.inspection')}</dt>
              <dd className="text-ink">
                {seller.inspection === null
                  ? t('orderMilestones.inspectionNone')
                  : t(`orderMilestones.inspectionStatus.${seller.inspection.status}` as TranslationKey)}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">{t('orderMilestones.shipments')}</dt>
              <dd className="text-ink">
                {seller.shipments.length === 0
                  ? t('orderMilestones.shipmentsNone')
                  : seller.shipments.map((shipment) => (
                      <span key={shipment.id} className="block">
                        {[shipment.carrierName, shipment.trackingNumber].filter(Boolean).join(' · ')}
                        {shipment.deliveredAt !== null
                          ? ` — ${t('orderMilestones.deliveredOn', { date: formatDate(shipment.deliveredAt) })}`
                          : shipment.dispatchedAt !== null
                            ? ` — ${t('orderMilestones.dispatchedOn', { date: formatDate(shipment.dispatchedAt) })}`
                            : ''}
                      </span>
                    ))}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">{t('orderMilestones.documents')}</dt>
              <dd className="text-ink">
                {seller.documents.length === 0
                  ? t('orderMilestones.documentsNone')
                  : seller.documents.map((document) => (
                      <span key={document.id} className="block">
                        {document.title}
                        {document.validation === 'VALID' && ` — ${t('orderMilestones.documentVerified')}`}
                      </span>
                    ))}
              </dd>
            </div>
          </dl>
        </section>
      ))}

      <section>
        <h3 className="mb-2 font-medium text-ink">{t('orderMilestones.history')}</h3>
        <ol className="space-y-1 text-sm">
          {view.events.map((event, index) => (
            <li key={`${event.at}-${String(index)}`} className="flex flex-wrap gap-x-3">
              <time className="text-ink-muted" dateTime={event.at}>
                {formatDateTime(event.at)}
              </time>
              <span className="text-ink">{eventText(t, event)}</span>
              {event.message != null && event.kind !== 'DELAY_RAISED' && <span className="text-ink-muted">{event.message}</span>}
            </li>
          ))}
        </ol>
      </section>
    </Card>
  );
}
