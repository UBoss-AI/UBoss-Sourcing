/**
 * The tracking block on the buyer's order page.
 *
 * One line per parcel - who is bringing it, from whom, the tracking numbers -
 * and under each line that has a consignment behind it: anything wrong with
 * it in plain words, when it is expected, the carrier's journey, and once it
 * has arrived, the proof of delivery.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 *   - It never decides what a buyer may see. The server sends only the
 *     buyer's own consignments and only the buyer-safe parts of them; there is
 *     no carrier note or driver here to hide.
 *   - It never shows a proof-of-delivery image inline. The signature and the
 *     photograph are downloaded through a link that works once and for a few
 *     minutes, minted when the buyer presses the button - the same as every
 *     other private file on this site.
 *   - It never invents a date. When there is no estimate it says so, rather
 *     than rendering an empty "Expected:".
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  fetchOrderTracking,
  proofOfDeliveryLink,
  type ConsignmentTracking,
  type PodImageKind,
  type TrackingEta,
  type TrackingEvent,
  type TrackingProofOfDelivery,
} from '@/lib/order-tracking';
import { downloadWith } from '@/lib/seller-documents';
import type { OrderShipment } from '@/lib/types';

/** Statuses with a label of their own. Anything else reads "Update". */
const LABELLED: ReadonlySet<string> = new Set([
  'PICKED_UP',
  'DISPATCHED',
  'AT_ORIGIN_HUB',
  'IN_TRANSIT',
  'AT_DESTINATION_HUB',
  'OUT_FOR_DELIVERY',
  'DELIVERY_ATTEMPTED',
  'DELIVERED',
  'DELAYED',
  'ON_HOLD',
  'ADDRESS_ISSUE',
  'CUSTOMS_HOLD',
  'DAMAGED',
  'TEMPERATURE_EXCEPTION',
  'DELIVERY_FAILED',
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
  'RETURNED',
  'LOST',
  'CANCELLED',
]);

function statusLabelKey(status: string): TranslationKey {
  return (LABELLED.has(status) ? `orderTracking.status.${status}` : 'orderTracking.status.other') as TranslationKey;
}

export function OrderTracking({
  orderId,
  shipments,
}: {
  orderId: string;
  shipments: OrderShipment[];
}): React.JSX.Element | null {
  const { t } = useI18n();
  const hasConsignments = shipments.some((shipment) => (shipment.consignmentIds?.length ?? 0) > 0);

  const tracking = useQuery({
    queryKey: ['order', orderId, 'tracking'],
    queryFn: () => fetchOrderTracking(orderId),
    enabled: hasConsignments,
  });

  if (shipments.length === 0) return null;

  const byId = new Map((tracking.data?.consignments ?? []).map((row) => [row.id, row]));

  return (
    <div className="mt-4 border-t border-border pt-4">
      <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
        {t('orderDetail.tracking')}
      </h3>
      <ul className="mt-2 space-y-4 text-sm">
        {shipments.map((shipment, index) => {
          const details = (shipment.consignmentIds ?? [])
            .map((id) => byId.get(id))
            .filter((row): row is ConsignmentTracking => row !== undefined);

          return (
            <li key={`${shipment.trackingNumber ?? ''}:${String(index)}`}>
              <span className="text-ink">{shipment.carrier ?? t('orderDetail.courier')}</span>
              {shipment.deliveryStage !== undefined && (
                <span className="ml-2 inline-flex rounded-full bg-brand-soft px-2 py-0.5 text-xxs font-medium text-brand">
                  {t(`orderDetail.stage.${shipment.deliveryStage}`)}
                </span>
              )}
              {shipment.sentBy !== null && (
                <span className="ml-2 text-xs text-ink-muted">
                  {t('orderDetail.sentBy', { seller: shipment.sentBy })}
                </span>
              )}
              {shipment.trackingNumber !== null && (
                <span className="ml-2 font-mono text-xs text-ink-muted">{shipment.trackingNumber}</span>
              )}
              {shipment.carrierTrackingNumber !== undefined && shipment.carrierTrackingNumber !== null && (
                <span className="ml-2 text-xs text-ink-muted">
                  {t('orderDetail.carrierTrackingNumber', { number: shipment.carrierTrackingNumber })}
                </span>
              )}
              {shipment.trackingUrl !== null && (
                <a
                  href={shipment.trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 font-medium text-brand hover:underline"
                >
                  {t('orderDetail.trackIt')}
                </a>
              )}
              {shipment.dispatchedAt !== null && (
                <span className="ml-2 text-xs text-ink-subtle">
                  {t('orderTracking.dispatchedAt', { date: formatDateTime(shipment.dispatchedAt) })}
                </span>
              )}

              {/*
                Said plainly where updates will NOT appear here on their own -
                the India Post case, and any carrier followed by hand. A buyer
                who is not told refreshes this page waiting for movement that
                was never going to show up on it.
              */}
              {shipment.trackingIsAutomatic === false && (
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t('orderDetail.trackingByHand')}</p>
              )}

              {details.length > 0 ? (
                details.map((detail) => (
                  <ConsignmentTrackingDetail
                    key={detail.id}
                    orderId={orderId}
                    consignment={detail}
                    showReference={details.length > 1}
                  />
                ))
              ) : (
                // No consignment behind this line (a despatch note typed by a
                // seller or the shop), or the tracking has not loaded: the
                // journey the order page already carries, in the buyer's words.
                shipment.events !== undefined &&
                shipment.events.length > 0 && (
                  <ol className="mt-2 space-y-1 border-l border-border pl-3">
                    {shipment.events
                      .filter((event) => event.description !== null)
                      .map((event, eventIndex) => (
                        <li key={`${event.occurredAt}:${String(eventIndex)}`} className="text-xs text-ink-muted">
                          <span className="text-ink-subtle">{formatDateTime(event.occurredAt)}</span>{' '}
                          {event.description}
                        </li>
                      ))}
                  </ol>
                )
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One consignment's trouble, ETA, journey and proof of delivery. */
export function ConsignmentTrackingDetail({
  orderId,
  consignment,
  showReference,
}: {
  orderId: string;
  consignment: ConsignmentTracking;
  showReference: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border-subtle bg-surface-sunken/40 p-3">
      {showReference && <p className="font-mono text-xxs text-ink-subtle">{consignment.reference}</p>}

      {consignment.openTrouble.length > 0 && (
        <ul role="status" className="space-y-1">
          {consignment.openTrouble.map((trouble) => (
            <li
              key={trouble.category}
              className="rounded-md bg-warning-soft px-3 py-2 text-xs font-medium leading-relaxed text-warning"
            >
              {t(`orderTracking.trouble.${trouble.category}` as TranslationKey)}
            </li>
          ))}
        </ul>
      )}

      <EtaLine eta={consignment.eta} />

      {consignment.events.length > 0 && (
        <div>
          <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
            {t('orderTracking.journey')}
          </p>
          <ol className="mt-1 space-y-1 border-l border-border pl-3">
            {consignment.events.map((event, index) => (
              <EventRow key={`${event.occurredAt}:${String(index)}`} event={event} />
            ))}
          </ol>
        </div>
      )}

      {consignment.proofOfDelivery !== null ? (
        <ProofOfDelivery orderId={orderId} shipmentId={consignment.id} pod={consignment.proofOfDelivery} />
      ) : (
        consignment.deliveredWithoutProof && (
          <p className="text-xs text-ink-muted">{t('orderTracking.pod.none')}</p>
        )
      )}
    </div>
  );
}

export function EtaLine({ eta }: { eta: TrackingEta }): React.JSX.Element | null {
  const { t } = useI18n();

  if (eta.source === 'FINISHED') return null;

  if (eta.source === 'NONE' || eta.at === null) {
    return <p className="text-xs text-ink-muted">{t('orderTracking.eta.none')}</p>;
  }

  const date = formatDate(eta.at);
  const line =
    eta.source === 'REVISED'
      ? t('orderTracking.eta.revised', { date })
      : eta.source === 'PROMISE'
        ? t('orderTracking.eta.promise', { date })
        : t('orderTracking.eta.estimate', { date });

  return (
    <p className="text-sm text-ink">
      {line}
      {eta.isLate && <span className="ml-1 text-xs text-warning">{t('orderTracking.eta.late')}</span>}
    </p>
  );
}

export function EventRow({ event }: { event: TrackingEvent }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <li className={cx('text-xs', event.kind === 'TROUBLE' ? 'text-warning' : 'text-ink-muted')}>
      <span className="text-ink-subtle">{formatDateTime(event.occurredAt)}</span>{' '}
      <span className={event.kind === 'TROUBLE' ? 'font-medium' : undefined}>
        {event.description ?? t(statusLabelKey(event.status))}
      </span>
      {event.location !== null && (
        <span className="text-ink-subtle"> · {event.location}</span>
      )}
      {event.kind === 'CORRECTION' && (
        <span className="ml-1 text-xxs text-ink-subtle">({t('orderTracking.corrected')})</span>
      )}
    </li>
  );
}

export function ProofOfDelivery({
  orderId,
  shipmentId,
  pod,
  audience = 'buyer',
}: {
  orderId: string;
  shipmentId: string;
  pod: TrackingProofOfDelivery;
  /** The seller is never offered the images; the line under them says why. */
  audience?: 'buyer' | 'seller';
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();

  const download = useMutation({
    mutationFn: (kind: PodImageKind) => downloadWith(() => proofOfDeliveryLink(orderId, shipmentId, kind)),
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const images: { kind: PodImageKind; image: { captured: boolean; available: boolean } }[] = [
    { kind: 'signature', image: pod.signature },
    { kind: 'photo', image: pod.photo },
  ];
  const offered = images.filter((entry) => entry.image.available);
  const withheld = images.filter((entry) => entry.image.captured && !entry.image.available);

  return (
    <section aria-label={t('orderTracking.pod.title')} className="border-t border-border-subtle pt-3">
      <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('orderTracking.pod.title')}</p>
      <dl className="mt-1 space-y-0.5 text-xs text-ink-muted">
        <div>
          <dt className="inline">{t('orderTracking.pod.deliveredAt')}</dt>{' '}
          <dd className="inline text-ink">{formatDateTime(pod.deliveredAt)}</dd>
        </div>
        <div>
          <dt className="inline">{t('orderTracking.pod.receivedBy')}</dt>{' '}
          <dd className="inline text-ink">
            {pod.receivedBy === null
              ? t('orderTracking.pod.noName')
              : pod.receivedByRole === null
                ? pod.receivedBy
                : `${pod.receivedBy} (${pod.receivedByRole})`}
          </dd>
        </div>
      </dl>
      {pod.confirmedWithCode && <p className="mt-1 text-xs text-success">{t('orderTracking.pod.code')}</p>}
      {pod.businessStamped && <p className="mt-1 text-xs text-ink-muted">{t('orderTracking.pod.stamped')}</p>}

      {offered.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {offered.map(({ kind }) => (
            <Button
              key={kind}
              size="sm"
              variant="secondary"
              isLoading={download.isPending && download.variables === kind}
              onClick={() => {
                download.mutate(kind);
              }}
            >
              {t(kind === 'signature' ? 'orderTracking.pod.downloadSignature' : 'orderTracking.pod.downloadPhoto')}
            </Button>
          ))}
          <span className="text-xxs text-ink-subtle">{t('orderTracking.pod.linkNote')}</span>
        </div>
      )}
      {withheld.length > 0 && (
        <p className="mt-1 text-xxs text-ink-subtle">
          {t(audience === 'seller' ? 'orderTracking.pod.sellerImages' : 'orderTracking.pod.withheld')}
        </p>
      )}
    </section>
  );
}
