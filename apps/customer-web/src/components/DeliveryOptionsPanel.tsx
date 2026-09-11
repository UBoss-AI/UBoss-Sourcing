/**
 * "Where this can ship from" - the delivery options for a basket.
 *
 * A buyer's country is often inside more than one warehouse's reach, and those
 * warehouses do not offer the same thing: one is two days away and charges for
 * it, another is five days away and free. Until this existed the storefront
 * could not say so - there was one shipping method for the whole shop - and a
 * buyer had no way to trade time against cost.
 *
 * WHAT THIS PANEL WILL NOT DO
 *
 * **It never invents a promise.** A warehouse whose lead time or fee nobody
 * has published is shown with the terms it actually has, which is none, and
 * said in words. "3-5 days, free" put on screen because the field was null
 * would be a promise this software made up on the operator's behalf.
 *
 * **It does not hide the near miss.** A warehouse in range that holds only
 * part of the basket appears under its own heading with the lines it is short
 * of. Dropping it would leave a buyer wondering why the depot in their own
 * city is not on the list; showing it as available would break the order at
 * the picking face.
 *
 * **It says nothing about why a country is closed.** The server sends a count
 * and no reasons, deliberately, and this panel can only report the fact that
 * nobody serves the destination. An operator's note about customs paperwork is
 * theirs and not the buyer's.
 *
 * WHAT SELECTING AN OPTION DOES, AND DOES NOT, DO
 *
 * Choosing one records the buyer's preference and shows it back to them. It
 * does **not** yet change the order total: the figure in the summary beside
 * this panel still comes from the shipping method the deployment has
 * configured, because the delivery fee a warehouse quotes is not wired into
 * cart pricing or into fulfilment. Anything else would be a screen that
 * quotes one number and charges another, which is the single worst thing a
 * checkout can do - so the panel says which of the two it is, rather than
 * looking like it has decided.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CountryFlag } from '@/components/CountryFlag';
import { Badge, Button, Spinner } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatMoney, formatNumber } from '@/lib/format';
import {
  deliveryOptionsQueryKey,
  fetchDeliveryOptions,
} from '@/lib/delivery-options';
import type { DeliveryOption, DeliveryOptionsRequest } from '@/lib/delivery-options';
import { useI18n } from '@/i18n/i18n-context';

/**
 * One warehouse's offer, as a card.
 *
 * Real `<button>` with `aria-pressed` rather than a radio group, and that is
 * about what the control *is*: a radio group implies one of these will be
 * submitted with the basket, and until the fee is wired into pricing this is a
 * preference being recorded rather than a field being filled in. The tilt is
 * the storefront's own `useTilt` idiom from the product card, so an option
 * feels like the same kind of object as a product.
 */
function OptionCard({
  option,
  isSelected,
  onSelect,
  isPartial = false,
}: {
  option: DeliveryOption;
  isSelected: boolean;
  onSelect: () => void;
  isPartial?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  const shipsFrom =
    option.warehouse.city === null
      ? option.warehouse.countryName ?? option.warehouse.name
      : `${option.warehouse.city}${
          option.warehouse.countryName === null ? '' : `, ${option.warehouse.countryName}`
        }`;

  const short = option.lines.filter((line) => !line.isFulfillable);

  return (
    <li>
      <button
        type="button"
        // Disabled rather than absent for a partial option: it is information,
        // not an offer, and a button that looked pressable and then refused
        // would be worse than one that says it cannot be taken.
        disabled={isPartial}
        aria-pressed={isPartial ? undefined : isSelected}
        onClick={onSelect}
        className={cx(
          'flex w-full flex-col gap-2 rounded-lg border p-3 text-left transition',
          isPartial
            ? 'cursor-default border-dashed border-border bg-surface-sunken'
            : cx(
                'bg-surface hover:border-brand/50 hover:shadow-card-hover',
                isSelected ? 'border-brand ring-2 ring-brand/30' : 'border-border shadow-card',
              ),
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* `items-start` and no truncation: the panel is a narrow column
                beside the order summary, and "Ships from Aspropyrgos, Greece"
                does not fit on one line of it. A wrapped place name is
                readable; a truncated one is a town nobody can identify. */}
            <p className="flex items-start gap-1.5 text-sm font-semibold text-ink">
              {option.warehouse.countryCode !== null && (
                <CountryFlag
                  code={option.warehouse.countryCode}
                  className="mt-0.5 h-3 w-[1.125rem] shrink-0"
                />
              )}
              <span>{t('delivery.shipsFrom', { place: shipsFrom })}</span>
            </p>

            <p className="mt-0.5 text-xs text-ink-muted">
              {option.leadTimeDays === null
                ? t('delivery.leadTimeUnset')
                : /*
                   * A range, or one figure when the two ends are the same.
                   *
                   * "Arrives in 3 to 3 days" is what a single key would
                   * produce, and it reads as a bug. The exact form takes
                   * `count`, which is what i18next needs to choose between
                   * "1 day" and "2 days" - a key with `_one`/`_other` and no
                   * `count` matches nothing and renders as its own name.
                   */
                  option.leadTimeDays.min === option.leadTimeDays.max
                  ? t('delivery.leadTimeExact', { count: option.leadTimeDays.max })
                  : t('delivery.leadTimeDays', {
                      min: option.leadTimeDays.min,
                      max: option.leadTimeDays.max,
                    })}
            </p>
          </div>

          <div className="shrink-0 text-right">
            <p className="text-sm font-semibold text-ink">
              {option.fee === null
                ? t('delivery.feeUnset')
                : option.fee.minor === '0'
                  ? t('delivery.feeFree')
                  : formatMoney(option.fee)}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {option.isFastest && <Badge tone="operational">{t('delivery.fastest')}</Badge>}
          {option.isCheapest && <Badge tone="action">{t('delivery.cheapest')}</Badge>}
          {/* A warehouse that is running short staffed can still ship, and a
              buyer choosing between two of them is entitled to know. */}
          {option.warehouse.operationalStatus === 'LIMITED' && (
            <Badge tone="warning">{t('delivery.limited')}</Badge>
          )}
          {isSelected && !isPartial && <Badge tone="brand">{t('delivery.chosen')}</Badge>}
        </div>

        {/* Which lines this warehouse is short of. Named, with the quantities,
            because "some items are unavailable" tells a buyer nothing they can
            act on. */}
        {isPartial && short.length > 0 && (
          <ul className="space-y-0.5 border-t border-border-subtle pt-2 text-xs text-ink-muted">
            {short.map((line) => (
              <li key={`${line.productId}:${line.variantId ?? 'base'}`}>
                {t('delivery.shortOf', {
                  name: line.productName,
                  wanted: formatNumber(line.quantity),
                  available: formatNumber(line.availableQty),
                })}
              </li>
            ))}
          </ul>
        )}
      </button>
    </li>
  );
}

interface DeliveryOptionsPanelProps {
  /**
   * The destination, as ISO 3166-1 alpha-2, or null when the shopper has not
   * said where they are.
   *
   * Null is a real state and not an error: the panel asks them to choose a
   * market rather than guessing one, because a delivery promise made to the
   * wrong country is worse than no promise at all.
   */
  countryCode: string | null;
  /** The basket. Empty asks "who could ever deliver here". */
  items: { productId: string; variantId: string | null; quantity: number }[];
}

export function DeliveryOptionsPanel({
  countryCode,
  items,
}: DeliveryOptionsPanelProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [chosenId, setChosenId] = useState<string | null>(null);

  const request: DeliveryOptionsRequest = { countryCode: countryCode ?? '', items };

  const query = useQuery({
    queryKey: deliveryOptionsQueryKey(request),
    queryFn: () => fetchDeliveryOptions(request),
    enabled: countryCode !== null && countryCode.length === 2,
    /*
     * Not cached for long, on purpose. Availability is the input that changes
     * fastest in this system - it moves every time anybody else checks out -
     * and a held answer saying "Antwerp has it, two days" is the one answer
     * that must never be stale. Thirty seconds covers a page that re-renders
     * while somebody reads it and nothing more.
     */
    staleTime: 30 * 1000,
  });

  if (countryCode === null) {
    return (
      <section className="mt-4 rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">{t('delivery.heading')}</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          {t('delivery.chooseCountry')}
        </p>
      </section>
    );
  }

  const data = query.data;

  return (
    <section className="mt-4 rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">{t('delivery.heading')}</h2>

      {query.isPending && (
        <p role="status" className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
          <Spinner className="h-3.5 w-3.5" />
          {t('delivery.loading')}
        </p>
      )}

      {query.isError && (
        <div className="mt-2">
          <p role="alert" className="text-xs leading-relaxed text-ink-muted">
            {t('delivery.failed')}
          </p>
          <Button
            size="sm"
            className="mt-2"
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}

      {data !== undefined && (
        <>
          <p className="mt-0.5 text-xs text-ink-muted">
            {t('delivery.destination', { country: data.destination.countryName })}
          </p>

          {data.options.length === 0 && data.partial.length === 0 ? (
            /*
             * Nobody can deliver, and *which* nobody matters.
             *
             * "No warehouse is near enough" and "we do not serve your country"
             * are different sentences with different next steps - the first
             * may change when a warehouse opens, the second is a decision -
             * and `closedByOperator` is what tells them apart. It is a count
             * and carries no reason, which is the right amount for a buyer to
             * be told.
             */
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              {data.closedByOperator > 0
                ? t('delivery.noneServed', { country: data.destination.countryName })
                : t('delivery.noneInRange', { country: data.destination.countryName })}
            </p>
          ) : (
            <>
              {data.options.length > 1 && (
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  {t('delivery.chooseHint', { count: data.options.length })}
                </p>
              )}

              {data.options.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {data.options.map((option) => (
                    <OptionCard
                      key={option.warehouse.id}
                      option={option}
                      isSelected={
                        // The first option is the one on offer until somebody
                        // says otherwise: it is the soonest arrival, and a
                        // list where nothing is chosen reads as a list where
                        // nothing is available.
                        chosenId === null
                          ? option.warehouse.id === data.options[0]?.warehouse.id
                          : chosenId === option.warehouse.id
                      }
                      onSelect={() => {
                        setChosenId(option.warehouse.id);
                      }}
                    />
                  ))}
                </ul>
              )}

              {data.partial.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-xs font-semibold text-ink">
                    {t('delivery.partialHeading')}
                  </h3>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                    {t('delivery.partialNote')}
                  </p>
                  <ul className="mt-2 space-y-2">
                    {data.partial.map((option) => (
                      <OptionCard
                        key={option.warehouse.id}
                        option={option}
                        isSelected={false}
                        isPartial
                        onSelect={() => {
                          // Nothing: a partial option is information, and the
                          // button is disabled. Kept as a no-op rather than
                          // making the prop optional, so every card is built
                          // the same way.
                        }}
                      />
                    ))}
                  </ul>
                </div>
              )}

              {/* What choosing actually does today. See the module header - a
                  screen that quotes one delivery fee and charges another is
                  the worst thing a checkout can do, so this says which of the
                  two figures is the one being charged. */}
              {data.options.length > 0 && (
                <p className="mt-3 text-xxs leading-relaxed text-ink-subtle">
                  {t('delivery.notChargedYet')}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
