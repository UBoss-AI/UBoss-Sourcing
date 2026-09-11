/**
 * "Choose your fulfilment warehouse" — the checkout's warehouse picker.
 *
 * The cart page already has a panel that says which warehouses could reach a
 * country (`DeliveryOptionsPanel`). This is the other half of the same idea
 * and it is a different thing: there, choosing records a preference and
 * changes no money; here, choosing **is a field on the order**. Each card
 * carries a `quoteId` naming a stored offer, checkout sends the one that was
 * picked, and the totals shown on the card are the totals the server will
 * charge — the shipping figure from the chosen lane goes through the same
 * pricing run as any shipping method.
 *
 * That difference is why these are radio buttons and not the cart panel's
 * `aria-pressed` toggles. A control that submits with the form is a radio.
 *
 * WHAT THIS SECTION WILL NOT DO
 *
 * **It computes nothing.** Not the totals, not the arrival dates, not which
 * option is fastest or cheapest or recommended. Every figure and every badge
 * is the server's. A storefront that works out its own "best" option is a
 * storefront that eventually puts a Lowest price badge on the dearer card.
 *
 * **It does not offer a warehouse that holds part of the basket.** There is no
 * approved split-fulfilment flow in this project, so an option that cannot
 * cover every line is not an option — the server keeps those out of `options`
 * and this screen shows them under "why not", with the lines they are short
 * of, rather than as something clickable that would break at the picking face.
 *
 * **It never substitutes.** If the chosen warehouse disappears between one
 * quote and the next, the selection is cleared and the buyer is asked again.
 * Quietly moving their order to a different warehouse — or a different product
 * — is the one thing that must not happen here.
 *
 * **It does not offer an estimate as an offer.** An answer priced from a
 * country rather than an address is labelled and unselectable, because the
 * server refuses such a quote at checkout.
 */
import { CountryFlag } from '@/components/CountryFlag';
import { SelectedFlag } from '@/components/SavedCardList';
import { AlertIcon } from '@/components/icons';
import { Badge, Button, Spinner } from '@/components/ui';
import { choiceCardClass } from '@/lib/cards';
import { formatIsoDate } from '@/lib/calendar-date';
import { formatMoney, formatNumber } from '@/lib/format';
import type {
  IneligibleWarehouse,
  OptionWarehouse,
  WarehouseOption,
  WarehouseOptionsResponse,
} from '@/lib/fulfilment';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';

/** "Pune, India", or the best of what the row actually has. */
function shipsFrom(warehouse: OptionWarehouse): string {
  if (warehouse.city === null) return warehouse.countryName ?? warehouse.name;

  return warehouse.countryName === null
    ? warehouse.city
    : `${warehouse.city}, ${warehouse.countryName}`;
}

/**
 * "Thu 18 Sep", in the reader's own locale and in UTC.
 *
 * UTC because these are calendar days, not instants — see the header of
 * `lib/calendar-date.ts`. Rendering `2026-09-18` through a local formatter
 * shows the 17th to two thirds of the world.
 */
function day(iso: string, intlLocale: string): string {
  return formatIsoDate(iso, intlLocale, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "Arrives Thu 18 Sep", or the range when the lane quotes one. */
function arrival(option: WarehouseOption, intlLocale: string, t: Translate): string {
  const from = day(option.deliveryFromDate, intlLocale);

  if (option.deliveryFromDate === option.deliveryToDate) {
    return t('fulfilment.arrivesOn', { date: from });
  }

  return t('fulfilment.arrivesBetween', { from, to: day(option.deliveryToDate, intlLocale) });
}

/** "2–4 business days in transit". Business and calendar days are not the same promise. */
function transit(option: WarehouseOption, t: Translate): string {
  const { min, max } = option.transitDays;

  if (min === max) {
    return option.usesBusinessDays
      ? t('fulfilment.transitBusinessExact', { count: max })
      : t('fulfilment.transitCalendarExact', { count: max });
  }

  return option.usesBusinessDays
    ? t('fulfilment.transitBusiness', { min, max })
    : t('fulfilment.transitCalendar', { min, max });
}

/** One figure of the breakdown. Compact rows, tabular figures, one baseline. */
function Line({
  label,
  value,
  tone = 'normal',
}: {
  label: string;
  value: string;
  tone?: 'normal' | 'credit' | 'total';
}): React.JSX.Element {
  return (
    <div
      className={
        tone === 'total'
          ? 'flex justify-between gap-3 border-t border-border-subtle pt-1.5 text-sm font-semibold text-ink'
          : 'flex justify-between gap-3 text-xs text-ink-muted'
      }
    >
      <dt>{label}</dt>
      <dd className={tone === 'credit' ? 'tabular text-success' : 'tabular text-ink'}>{value}</dd>
    </div>
  );
}

/**
 * One warehouse's offer.
 *
 * A real radio inside a `<label>`, exactly like the address cards above it on
 * the same page — this is the same kind of decision and it should not look
 * like a different one. Selection is carried by the ring, the radio and the
 * tick together, because a buyer who cannot separate the ring from the border
 * can still see the tick.
 */
function OptionCard({
  option,
  isSelected,
  isSelectable,
  onSelect,
}: {
  option: WarehouseOption;
  isSelected: boolean;
  /** False for an estimate, which the server will refuse at checkout. */
  isSelectable: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();

  const stockedLines = option.lines.filter((line) => line.isStockTracked);

  return (
    <li>
      <label
        className={
          isSelectable
            ? choiceCardClass(isSelected)
            : 'relative flex cursor-default gap-3 rounded-lg border border-dashed border-border bg-surface-sunken p-4'
        }
      >
        <input
          type="radio"
          name="fulfilmentWarehouse"
          className="mt-1 h-4 w-4 shrink-0 border-border-strong text-brand"
          checked={isSelected}
          disabled={!isSelectable}
          onChange={onSelect}
        />

        <div className="min-w-0 flex-1 pr-20 text-sm">
          {/* --- Who, and from where ------------------------------------- */}
          <div className="flex items-start gap-1.5">
            {option.warehouse.countryCode !== null && (
              <CountryFlag
                code={option.warehouse.countryCode}
                className="mt-1 h-3 w-[1.125rem] shrink-0"
              />
            )}
            <div className="min-w-0">
              <span className="block text-title-xs text-ink">{option.warehouse.name}</span>
              <span className="mt-0.5 block text-xs text-ink-muted">
                {t('fulfilment.shipsFrom', { place: shipsFrom(option.warehouse) })}
              </span>
            </div>
          </div>

          {/* --- Badges ---------------------------------------------------
              Fastest and Lowest price are facts about this list; Recommended
              is a name for the default so a pre-selected card says why. All
              three are the server's, never worked out here. */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {option.isFastest && <Badge tone="operational">{t('fulfilment.fastest')}</Badge>}
            {option.isCheapest && <Badge tone="action">{t('fulfilment.cheapest')}</Badge>}
            {option.isRecommended && <Badge tone="brand">{t('fulfilment.recommended')}</Badge>}
            {/* A warehouse running short-staffed can still ship, and somebody
                choosing between two of them is entitled to know. */}
            {option.warehouse.operationalStatus === 'LIMITED' && (
              <Badge tone="warning">{t('fulfilment.limited')}</Badge>
            )}
          </div>

          {/* --- When ------------------------------------------------------ */}
          <span className="mt-2.5 block text-sm font-medium text-ink">
            {arrival(option, intlLocale, t)}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
            {t('fulfilment.dispatchedOn', { date: day(option.dispatchDate, intlLocale) })} ·{' '}
            {transit(option, t)}
          </span>
          <span className="mt-0.5 block text-xs text-ink-subtle">
            {option.carrier.name} · {option.carrier.serviceLevel}
            {option.distanceKm !== null && (
              <> · {t('fulfilment.distance', { km: formatNumber(Math.round(option.distanceKm)) })}</>
            )}
          </span>

          {/* Every line is covered — the server never offers an option
              otherwise — so this counts rather than lists. A made-to-order
              product carries no quantity anywhere and is not counted as stock
              that exists. */}
          {stockedLines.length > 0 && (
            <span className="mt-1.5 block text-xs font-medium text-success">
              {t('fulfilment.inStockHere', { count: stockedLines.length })}
            </span>
          )}

          {/* --- What it costs ---------------------------------------------
              The whole breakdown, on the card, because the point of the
              section is comparing warehouses and a total with no parts cannot
              be compared. These are the figures the order will carry. */}
          <dl className="mt-3 space-y-1 border-t border-border-subtle pt-2.5">
            <Line label={t('checkout.subtotal')} value={formatMoney(option.totals.subtotal)} />
            {option.totals.discount.minor !== '0' && (
              <Line
                label={t('checkout.discount')}
                tone="credit"
                value={`−${formatMoney(option.totals.discount)}`}
              />
            )}
            <Line label={t('checkout.tax')} value={formatMoney(option.totals.tax)} />
            <Line
              label={t('checkout.delivery')}
              value={
                option.totals.shipping.minor === '0'
                  ? t('fulfilment.deliveryFree')
                  : formatMoney(option.totals.shipping)
              }
            />
            <Line
              label={t('checkout.total')}
              tone="total"
              value={formatMoney(option.totals.grandTotal)}
            />
          </dl>
        </div>

        {isSelected && isSelectable && <SelectedFlag />}
      </label>
    </li>
  );
}

/** Why a warehouse the buyer might have expected is not on the list. */
function IneligibleRow({ entry }: { entry: IneligibleWarehouse }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <li className="text-xs leading-relaxed text-ink-muted">
      <span className="font-medium text-ink">{entry.warehouse.name}</span>
      {/* The server's own sentence. It knows which of eight reasons this is,
          and it words each one for a buyer rather than for an operator — an
          exclusion never carries the operator's reason with it. */}
      <span> — {entry.message}</span>

      {entry.shortLines.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-4 text-ink-subtle">
          {entry.shortLines.map((line) => (
            <li key={`${line.productId}:${line.variantId ?? 'base'}`}>
              {t('fulfilment.shortOf', {
                name: line.productName,
                wanted: formatNumber(line.quantity),
                available: formatNumber(line.availableQty),
              })}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The card shape, before there is anything to put in it. */
function OptionSkeleton(): React.JSX.Element {
  return (
    <li aria-hidden="true" className="rounded-lg border border-border bg-surface p-4">
      <div className="skeleton h-4 w-2/5" />
      <div className="skeleton mt-2 h-3 w-1/3" />
      <div className="skeleton mt-3 h-3 w-1/2" />
      <div className="skeleton mt-3 h-3 w-full" />
      <div className="skeleton mt-1.5 h-3 w-4/5" />
      <div className="skeleton mt-3 h-5 w-1/3" />
    </li>
  );
}

export interface FulfilmentWarehouseSectionProps {
  /** The answer, once there is one. */
  data: WarehouseOptionsResponse | undefined;
  isPending: boolean;
  isRefreshing: boolean;
  isError: boolean;
  /** The server's sentence for why the ask failed, already worded for a reader. */
  errorText: string | null;
  onRetry: () => void;

  /** No address chosen yet — a real state, not an error. */
  hasAddress: boolean;

  /** The warehouse the buyer is on, whether they picked it or it was the default. */
  selectedWarehouseId: string | null;
  onSelect: (warehouseId: string) => void;

  /**
   * Something happened to the chosen offer between quoting and now: it
   * expired and was re-fetched, its price moved, or the warehouse went away.
   * Worded by the page, because the page is what noticed.
   */
  notice: { tone: 'info' | 'warning'; text: string } | null;
}

export function FulfilmentWarehouseSection({
  data,
  isPending,
  isRefreshing,
  isError,
  errorText,
  onRetry,
  hasAddress,
  selectedWarehouseId,
  onSelect,
  notice,
}: FulfilmentWarehouseSectionProps): React.JSX.Element {
  const { t } = useI18n();

  // --- Nothing to ask about yet ------------------------------------------
  if (!hasAddress) {
    return (
      <p className="mt-4 text-sm leading-relaxed text-ink-muted">
        {t('fulfilment.chooseAddressFirst')}
      </p>
    );
  }

  if (isPending) {
    return (
      <div className="mt-4">
        <p role="status" className="flex items-center gap-2 text-xs text-ink-muted">
          <Spinner className="h-3.5 w-3.5" />
          {t('fulfilment.loading')}
        </p>
        <ul className="mt-3 space-y-2.5">
          <OptionSkeleton />
          <OptionSkeleton />
        </ul>
      </div>
    );
  }

  if (isError || data === undefined) {
    return (
      <div className="mt-4">
        <p
          role="alert"
          className="flex gap-2.5 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
        >
          <AlertIcon className="mt-px h-4 w-4 shrink-0" />
          <span>{errorText ?? t('fulfilment.failed')}</span>
        </p>
        <Button size="sm" className="mt-3" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  const place = data.destination.countryName;

  return (
    <div className="mt-4">
      {/* --- What kind of answer this is ---------------------------------- */}
      {data.isEstimate ? (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-ink"
        >
          <Badge tone="warning">{t('fulfilment.estimate')}</Badge>
          <span className="min-w-0 flex-1">{t('fulfilment.estimateHint', { country: place })}</span>
        </p>
      ) : (
        data.options.length > 0 && (
          <p className="text-xs leading-relaxed text-ink-muted">
            {data.options.length === 1
              ? t('fulfilment.oneOption', { place })
              : t('fulfilment.manyOptions', { count: data.options.length, place })}
          </p>
        )
      )}

      {notice !== null && (
        <p
          role="status"
          className={
            notice.tone === 'warning'
              ? 'mt-3 flex gap-2.5 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs leading-relaxed text-ink'
              : 'mt-3 rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-xs leading-relaxed text-ink-muted'
          }
        >
          {notice.tone === 'warning' && (
            <AlertIcon className="mt-px h-4 w-4 shrink-0 text-warning" />
          )}
          <span>{notice.text}</span>
        </p>
      )}

      {isRefreshing && (
        <p role="status" className="mt-3 flex items-center gap-2 text-xs text-ink-muted">
          <Spinner className="h-3.5 w-3.5" />
          {t('fulfilment.refreshing')}
        </p>
      )}

      {/* --- The offers ---------------------------------------------------- */}
      {data.options.length > 0 ? (
        <fieldset className="mt-3">
          <legend className="sr-only">{t('fulfilment.heading')}</legend>
          <ul className="space-y-2.5">
            {data.options.map((option) => (
              <OptionCard
                key={option.quoteId}
                option={option}
                isSelectable={!data.isEstimate}
                isSelected={!data.isEstimate && option.warehouse.id === selectedWarehouseId}
                onSelect={() => {
                  onSelect(option.warehouse.id);
                }}
              />
            ))}
          </ul>
        </fieldset>
      ) : (
        /*
         * Nobody can send this basket here.
         *
         * A real answer with a next step, not an error: the reasons below are
         * per warehouse, and most of them — a quantity larger than any one
         * warehouse holds, above all — are cleared by editing the cart.
         */
        <div
          role="status"
          className="mt-3 rounded-md border border-warning/30 bg-warning-soft px-3 py-3"
        >
          <p className="text-sm font-semibold text-warning">{t('fulfilment.noneHeading')}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink">
            {t('fulfilment.noneBody', { place })}
          </p>
        </div>
      )}

      {/* --- Why the rest are not here -------------------------------------
          Kept even when there are offers. A buyer who knows there is a depot
          in their own city and does not see it on the list will assume the
          list is broken; naming it and saying why is the difference between
          an answer and a shrug. */}
      {data.ineligible.length > 0 && (
        <details className="mt-3 rounded-md border border-border bg-surface-sunken px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-ink">
            {t('fulfilment.whyNot', { count: data.ineligible.length })}
          </summary>
          <ul className="mt-2 space-y-2">
            {data.ineligible.map((entry) => (
              <IneligibleRow key={entry.warehouse.id} entry={entry} />
            ))}
          </ul>

          {/* Said once, here, rather than on each short warehouse: it is a
              policy of the shop and not a fact about Antwerp. */}
          {data.ineligible.some((entry) => entry.reason === 'INSUFFICIENT_STOCK') && (
            <p className="mt-2 border-t border-border-subtle pt-2 text-xxs leading-relaxed text-ink-subtle">
              {t('fulfilment.noSplit')}
            </p>
          )}
        </details>
      )}

      {/* --- What this destination refuses outright ------------------------- */}
      {data.restrictedLines.length > 0 && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5"
        >
          <p className="text-xs font-semibold text-danger">
            {t('fulfilment.restrictedHeading', { country: place })}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs leading-relaxed text-ink">
            {data.restrictedLines.map((line) => (
              <li key={`${line.productId}:${line.variantId ?? 'base'}`}>
                <span className="font-medium">{line.productName}</span>
                {line.reason !== null && <span className="text-ink-muted"> — {line.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
