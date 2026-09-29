/**
 * The seller's view of where one of their consignments is.
 *
 * The same milestones, ETA and proof-of-delivery summary the buyer is shown,
 * drawn with the same pieces, so the two sides of one parcel cannot disagree
 * about where it is. Two differences, both decided on the server: the person
 * who signed for it is named as "Given F.", and the signature and photograph
 * are never offered - they belong to somebody on the buyer's premises, and a
 * dispute about them goes through the marketplace.
 *
 * Collapsed until opened, because a seller's order page already carries a
 * great deal and most consignments on it are going perfectly well.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EtaLine, EventRow, ProofOfDelivery } from '@/components/order-tracking/OrderTracking';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { fetchSellerTracking } from '@/lib/consignment-logistics';

/** Statuses drawn as a problem on the timeline, as on the buyer's. */
const TROUBLE: ReadonlySet<string> = new Set([
  'CUSTOMS_HOLD',
  'DELAYED',
  'ON_HOLD',
  'ADDRESS_ISSUE',
  'DELIVERY_ATTEMPTED',
  'DELIVERY_FAILED',
  'DAMAGED',
  'LOST',
  'TEMPERATURE_EXCEPTION',
]);

export function SellerConsignmentTracking({
  shipmentId,
  reference,
}: {
  shipmentId: string;
  reference: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const tracking = useQuery({
    queryKey: ['seller', 'consignment', shipmentId, 'tracking'],
    queryFn: () => fetchSellerTracking(shipmentId),
    enabled: open,
  });

  const delivery = tracking.data?.delivery;
  const events = (tracking.data?.events ?? []).map((event) => ({
    status: event.status,
    kind: TROUBLE.has(event.status) ? ('TROUBLE' as const) : ('MILESTONE' as const),
    trouble: null,
    description: event.description,
    occurredAt: event.occurredAt,
    location: null,
  }));

  return (
    <div className="rounded-md border border-border-subtle p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink">{t('sellerTracking.title', { reference })}</p>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          {open ? t('sellerTracking.hide') : t('sellerTracking.show')}
        </Button>
      </div>

      {open && tracking.isLoading && <p className="mt-2 text-xs text-ink-muted">{t('sellerTracking.loading')}</p>}
      {open && tracking.isError && <p className="mt-2 text-xs text-danger">{t('sellerTracking.failed')}</p>}

      {open && tracking.data !== undefined && (
        <div className="mt-2 space-y-3">
          {delivery !== undefined && <EtaLine eta={delivery.eta} />}

          {events.length > 0 ? (
            <ol className="space-y-1 border-l border-border pl-3">
              {events.map((event, index) => (
                <EventRow key={`${event.occurredAt}:${String(index)}`} event={event} />
              ))}
            </ol>
          ) : (
            <p className="text-xs text-ink-muted">{t('sellerTracking.noEvents')}</p>
          )}

          {delivery?.proofOfDelivery !== undefined && delivery.proofOfDelivery !== null ? (
            <ProofOfDelivery
              orderId=""
              shipmentId={shipmentId}
              pod={delivery.proofOfDelivery}
              audience="seller"
            />
          ) : (
            delivery?.deliveredWithoutProof === true && (
              <p className="text-xs text-ink-muted">{t('orderTracking.pod.none')}</p>
            )
          )}
        </div>
      )}
    </div>
  );
}
