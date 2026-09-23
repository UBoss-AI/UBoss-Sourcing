/**
 * Pricing a consignment, buying it, and booking the van.
 *
 * The other half of the delivery screen. `ConsignmentCarrierPanel` is for a
 * seller who hands the parcel to a haulage company inside the platform; this
 * is for a seller who has their OWN account with a carrier, where the three
 * steps are asking what it costs, paying for it, and arranging collection.
 *
 * THREE THINGS THIS SCREEN IS CAREFUL ABOUT
 *
 *   - **A price is what the carrier said, not what we think.** Every figure
 *     comes back from the carrier and is stored with the service it belongs
 *     to. Nothing here computes one.
 *   - **Buying twice.** The button is disabled while the call is in flight,
 *     and that is the weaker of the two defences — the real one is an
 *     idempotency key in the database. `purchasedNow` tells the seller which
 *     happened, so a double click reads as "already booked" rather than
 *     silently claiming a second parcel.
 *   - **A confirmation number is only ever the carrier's.** Where the carrier
 *     returned none, the row says nobody gave one rather than showing an
 *     internal id dressed up as a booking reference.
 *
 * Money is handled as MINOR UNITS IN A STRING all the way to the formatter. It
 * never becomes a JavaScript number, because a delivery charge that has been
 * through a float is one that can disagree with the invoice by a cent — and
 * that is the cent the customer writes in about.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Field, Input, LoadingState } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import { formatMoneyMinor } from '@/lib/format';
import { errorMessage } from '@/lib/errors';
import {
  cancelPickup,
  confirmPickupReadiness,
  fetchPickups,
  fetchQuotes,
  purchaseConsignment,
  requestQuotes,
  schedulePickup,
  selectQuote,
  type Pickup,
  type PickupState,
} from '@/lib/seller';

const PICKUP_TONE: Record<PickupState, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'> = {
  REQUESTED: 'warning',
  SCHEDULED: 'brand',
  CONFIRMED: 'brand',
  COMPLETED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

function pickupStateLabel(t: Translate, state: PickupState): string {
  switch (state) {
    case 'REQUESTED':
      return t('sellerPickup.state.requested');
    case 'SCHEDULED':
      return t('sellerPickup.state.scheduled');
    case 'CONFIRMED':
      return t('sellerPickup.state.confirmed');
    case 'COMPLETED':
      return t('sellerPickup.state.completed');
    case 'FAILED':
      return t('sellerPickup.state.failed');
    case 'CANCELLED':
      return t('sellerPickup.state.cancelled');
  }
}

/** States past which the collection is over and nothing can be done to it. */
function isLive(pickup: Pickup): boolean {
  return (
    pickup.state === 'REQUESTED' || pickup.state === 'SCHEDULED' || pickup.state === 'CONFIRMED'
  );
}

export function ConsignmentCarrierPurchasePanel({
  shipmentId,
  reference,
}: {
  shipmentId: string;
  reference: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [notes, setNotes] = useState('');

  const quotes = useQuery({
    queryKey: ['seller', 'consignment', shipmentId, 'quotes'],
    queryFn: () => fetchQuotes(shipmentId),
  });

  const pickups = useQuery({
    queryKey: ['seller', 'consignment', shipmentId, 'pickups'],
    queryFn: () => fetchPickups({ shipmentId }),
  });

  const refreshQuotes = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['seller', 'consignment', shipmentId, 'quotes'] });
  };

  const refreshPickups = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['seller', 'consignment', shipmentId, 'pickups'] });
  };

  const ask = useMutation({
    mutationFn: () => requestQuotes(shipmentId),
    onSuccess: refreshQuotes,
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const choose = useMutation({
    mutationFn: (quoteId: string) => selectQuote(shipmentId, quoteId),
    onSuccess: refreshQuotes,
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const buy = useMutation({
    mutationFn: () => purchaseConsignment(shipmentId),
    onSuccess: async (result) => {
      /*
       * Which of the two happened.
       *
       * `purchasedNow` false means the server replayed an earlier booking
       * rather than making a second one. Saying so is the difference between a
       * seller who understands their double click did nothing and one who
       * thinks they have two parcels coming.
       */
      toast.success(
        result.purchasedNow ? t('sellerBuy.booked') : t('sellerBuy.alreadyBooked'),
      );
      await refreshQuotes();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const book = useMutation({
    mutationFn: () =>
      schedulePickup(shipmentId, {
        windowStartAt: new Date(windowStart).toISOString(),
        windowEndAt: new Date(windowEnd).toISOString(),
        // The warehouse's own zone, taken from this browser. A wall-clock
        // window means nothing without one.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        instructions: notes.length > 0 ? notes : null,
      }),
    onSuccess: async () => {
      toast.success(t('sellerPickup.booked'));
      setNotes('');
      await refreshPickups();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const ready = useMutation({
    mutationFn: (pickupId: string) => confirmPickupReadiness(pickupId),
    onSuccess: async () => {
      toast.success(t('sellerPickup.readyConfirmed'));
      await refreshPickups();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const callOff = useMutation({
    mutationFn: (pickupId: string) => cancelPickup(pickupId, null),
    onSuccess: async () => {
      toast.success(t('sellerPickup.cancelled'));
      await refreshPickups();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const rows = quotes.data?.quotes ?? [];
  const chosen = rows.find((quote) => quote.isSelected);
  const collections = pickups.data?.pickups ?? [];
  const liveCollection = collections.find(isLive);

  return (
    <div className="space-y-5 rounded-md border border-border-subtle px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">{reference}</p>
        <Button
          type="button"
          variant="secondary"
          disabled={ask.isPending}
          onClick={() => {
            ask.mutate();
          }}
        >
          {ask.isPending ? t('sellerBuy.asking') : t('sellerBuy.askPrices')}
        </Button>
      </div>

      {quotes.isLoading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('sellerBuy.noQuotes')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((quote) => (
            <li
              key={quote.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2.5 text-sm"
            >
              <div className="min-w-0">
                <p className="font-medium text-ink">
                  {quote.serviceName ?? quote.serviceCode}
                  {quote.isSelected && (
                    <span className="ml-2 align-middle">
                      <Badge tone="success">{t('sellerBuy.chosen')}</Badge>
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {quote.provider}
                  {quote.estimatedTransitDays !== null
                    ? ` · ${t('sellerBuy.transitDays', {
                        total: String(quote.estimatedTransitDays),
                      })}`
                    : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {/* Minor units straight from the server to the formatter. The
                    number never becomes a JavaScript number on the way. */}
                <span className="font-medium text-ink">
                  {formatMoneyMinor(quote.totalMinor, quote.currency)}
                </span>
                {!quote.isSelected && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={choose.isPending}
                    onClick={() => {
                      choose.mutate(quote.id);
                    }}
                  >
                    {t('sellerBuy.choose')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {chosen !== undefined && (
        <div className="border-t border-border-subtle pt-4">
          <Button
            type="button"
            disabled={buy.isPending}
            onClick={() => {
              buy.mutate();
            }}
          >
            {buy.isPending
              ? t('sellerBuy.booking')
              : t('sellerBuy.buy', {
                  amount: formatMoneyMinor(chosen.totalMinor, chosen.currency),
                })}
          </Button>
          <p className="mt-2 text-xs text-ink-muted">{t('sellerBuy.buyNote')}</p>
        </div>
      )}

      {/* --- Booking the van ------------------------------------------- */}

      <div className="space-y-3 border-t border-border-subtle pt-4">
        <p className="text-sm font-medium text-ink">{t('sellerPickup.heading')}</p>

        {collections.length > 0 && (
          <ul className="space-y-2">
            {collections.map((pickup) => (
              <li
                key={pickup.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="text-ink">
                    {new Date(pickup.windowStartAt).toLocaleString()} –{' '}
                    {new Date(pickup.windowEndAt).toLocaleTimeString()}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {pickup.arrangedWith}
                    {/* Only ever the carrier's own reference. Where they gave
                        none, the line says so rather than inventing one. */}
                    {pickup.carrierConfirmationNumber !== null
                      ? ` · ${t('sellerPickup.reference', {
                          reference: pickup.carrierConfirmationNumber,
                        })}`
                      : ` · ${t('sellerPickup.noReference')}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={PICKUP_TONE[pickup.state]}>
                    {pickupStateLabel(t, pickup.state)}
                  </Badge>
                  {isLive(pickup) && pickup.readinessConfirmedAt === null && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={ready.isPending}
                      onClick={() => {
                        ready.mutate(pickup.id);
                      }}
                    >
                      {t('sellerPickup.markReady')}
                    </Button>
                  )}
                  {isLive(pickup) && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={callOff.isPending}
                      onClick={() => {
                        callOff.mutate(pickup.id);
                      }}
                    >
                      {t('sellerPickup.callOff')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {liveCollection === undefined ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('sellerPickup.from')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    type="datetime-local"
                    value={windowStart}
                    onChange={(event) => {
                      setWindowStart(event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label={t('sellerPickup.to')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    type="datetime-local"
                    value={windowEnd}
                    onChange={(event) => {
                      setWindowEnd(event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>

            <Field label={t('sellerPickup.notes')} hint={t('sellerPickup.notesHint')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value);
                  }}
                />
              )}
            </Field>

            <Button
              type="button"
              disabled={windowStart.length === 0 || windowEnd.length === 0 || book.isPending}
              onClick={() => {
                book.mutate();
              }}
            >
              {book.isPending ? t('sellerPickup.booking') : t('sellerPickup.book')}
            </Button>
          </div>
        ) : (
          // One live collection at a time. The server refuses a second with a
          // UNIQUE index; hiding the form is so a seller never presses a button
          // that cannot work.
          <p className="text-xs text-ink-muted">{t('sellerPickup.alreadyBooked')}</p>
        )}
      </div>
    </div>
  );
}
