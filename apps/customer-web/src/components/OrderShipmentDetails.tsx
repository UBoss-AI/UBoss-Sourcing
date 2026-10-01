/**
 * How the buyer's order ships (checklist Master rows 42 and 56): for each
 * consignment, its mode, Incoterm, ports, pickup and carrier as the seller
 * booked them, and the trade documents the sellers have recorded that a buyer
 * may see - certificate of origin, bill of lading or air waybill, and category
 * documents - with issuer, expiry and review state.
 *
 * Renders nothing while there is nothing to show, so a domestic parcel with
 * no booking and no papers adds no empty card to the order page.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Card } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import {
  buyerTradeDocumentFileUrl,
  fetchBuyerShipmentDetails,
  type TradeValidation,
} from '@/lib/shipment-paperwork';

const VALIDATION_TONE: Record<TradeValidation, BadgeTone> = {
  PENDING_REVIEW: 'warning',
  VALID: 'success',
  REJECTED: 'danger',
  EXPIRED: 'danger',
};

export function OrderShipmentDetails({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['order', orderId, 'shipment-details'],
    queryFn: () => fetchBuyerShipmentDetails(orderId),
  });

  if (query.data === undefined) return null;
  const booked = query.data.shipments.filter((row) => row.terms !== null || row.carrier.name !== null);
  const documents = query.data.documents;
  if (booked.length === 0 && documents.length === 0) return null;

  return (
    <Card title={t('orderShipment.title')} bodyClassName="space-y-4 px-6 py-5">
      {booked.map((shipment) => (
        <section key={shipment.shipmentId} className="space-y-1 text-sm" data-testid={`shipment-${shipment.reference}`}>
          <h3 className="font-semibold text-ink">
            {shipment.reference}
            {shipment.sellerName !== null && <span className="font-normal text-ink-muted"> · {shipment.sellerName}</span>}
          </h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-ink">
            {shipment.terms !== null && (
              <>
                <dt className="text-ink-muted">{t('orderShipment.mode')}</dt>
                <dd>{t(`shipmentBooking.mode.${shipment.terms.mode}`)}</dd>
                <dt className="text-ink-muted">{t('orderShipment.incoterm')}</dt>
                <dd>
                  {shipment.terms.incoterm}
                  {shipment.terms.incotermPlace !== null && ` ${shipment.terms.incotermPlace}`}
                </dd>
                {(shipment.terms.originPort !== null || shipment.terms.destinationPort !== null) && (
                  <>
                    <dt className="text-ink-muted">{t('orderShipment.ports')}</dt>
                    <dd>
                      {shipment.terms.originPort ?? '—'} → {shipment.terms.destinationPort ?? '—'}
                    </dd>
                  </>
                )}
                {shipment.terms.pickupDate !== null && (
                  <>
                    <dt className="text-ink-muted">{t('orderShipment.pickup')}</dt>
                    <dd>
                      {shipment.terms.pickupDate}
                      {shipment.terms.pickupWindowFrom !== null &&
                        ` ${shipment.terms.pickupWindowFrom}–${shipment.terms.pickupWindowTo ?? ''}`}
                    </dd>
                  </>
                )}
                {shipment.terms.routeNote !== null && (
                  <>
                    <dt className="text-ink-muted">{t('orderShipment.route')}</dt>
                    <dd>{shipment.terms.routeNote}</dd>
                  </>
                )}
              </>
            )}
            {shipment.carrier.name !== null && (
              <>
                <dt className="text-ink-muted">{t('orderShipment.carrier')}</dt>
                <dd>
                  {shipment.carrier.name}
                  {shipment.carrier.trackingNumber !== null && ` · ${shipment.carrier.trackingNumber}`}
                </dd>
              </>
            )}
          </dl>
        </section>
      ))}

      {documents.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">{t('orderShipment.documents')}</h3>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {documents.map((document) => (
              <li key={document.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                <span className="font-medium text-ink">
                  {document.kind.startsWith('CATEGORY:') ? document.title : t(`tradeDocs.kind.${document.kind}` as TranslationKey)}
                </span>
                {document.shipmentReference !== null && (
                  <span className="text-xs text-ink-muted">{document.shipmentReference}</span>
                )}
                <Badge tone={VALIDATION_TONE[document.validation]}>{t(`tradeDocs.validation.${document.validation}`)}</Badge>
                <span className="text-xs text-ink-muted">
                  {t('tradeDocs.issuedByLabel')} {document.issuerName}
                  {document.referenceNumber !== null && ` · ${t('tradeDocs.numberLabel')} ${document.referenceNumber}`}
                  {document.expiresOn !== null && ` · ${t('tradeDocs.expiresLabel')} ${document.expiresOn}`}
                </span>
                {document.hasFile && (
                  <a
                    className="ml-auto text-action underline"
                    href={buyerTradeDocumentFileUrl(orderId, document.versionId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('tradeDocs.open')}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}
