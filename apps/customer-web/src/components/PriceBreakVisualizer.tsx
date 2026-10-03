/**
 * Quantity slider over the bulk bands (ENH-027): the band's unit price and the
 * exact line total, how many weeks the seller's stated capacity needs, the
 * stated lead time, and a link that carries the figures into the landed-cost
 * estimator. Informational: the basket re-prices on every add.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n/i18n-context';
import type { BulkOfferCard } from '@/lib/bulk-pricing';
import { formatMoney, formatMoneyMinor } from '@/lib/format';
import { breakAt, sliderRange, type BreakCapacity } from '@/lib/price-breaks';

export function PriceBreakVisualizer({
  offers,
  capacity,
  initialQuantity,
}: {
  offers: BulkOfferCard[];
  capacity: BreakCapacity | null;
  initialQuantity: number;
}): React.JSX.Element | null {
  const { t, intlLocale } = useI18n();
  const id = useId();
  const range = offers.length === 0 ? null : sliderRange(offers);
  const [quantity, setQuantity] = useState(() => (range === null ? 1 : Math.min(range.max, Math.max(range.min, initialQuantity))));
  if (range === null) return null;
  const { band, totalMinor, productionWeeks } = breakAt(offers, quantity, capacity);
  const currency = band?.unitPrice.currency ?? offers[0]?.unitPrice.currency ?? '';
  const lead =
    capacity?.leadTimeDaysMin == null && capacity?.leadTimeDaysMax == null
      ? null
      : capacity.leadTimeDaysMin === capacity.leadTimeDaysMax || capacity.leadTimeDaysMax == null
        ? String(capacity.leadTimeDaysMin ?? capacity.leadTimeDaysMax)
        : capacity.leadTimeDaysMin == null
          ? String(capacity.leadTimeDaysMax)
          : `${String(capacity.leadTimeDaysMin)}–${String(capacity.leadTimeDaysMax)}`;
  const landed = band === null ? null : `/tools/landed-cost?unitPriceMinor=${band.unitPrice.minor}&currency=${encodeURIComponent(currency)}&quantity=${String(quantity)}`;

  return (
    <section aria-labelledby={`${id}-title`} className="rounded-lg border border-border-subtle p-3 text-sm">
      <h3 id={`${id}-title`} className="font-medium">{t('priceBreaks.title')}</h3>
      <label htmlFor={`${id}-qty`} className="mt-2 block text-ink-muted">
        {t('priceBreaks.quantity', { quantity: quantity.toLocaleString(intlLocale) })}
      </label>
      <input
        id={`${id}-qty`}
        type="range"
        min={range.min}
        max={range.max}
        step={1}
        value={quantity}
        onChange={(event) => {
          setQuantity(Number(event.target.value));
        }}
        className="w-full accent-brand"
      />
      <dl className="mt-2 grid gap-1 sm:grid-cols-2">
        <div><dt className="text-ink-muted">{t('priceBreaks.unitPrice')}</dt><dd className="font-medium">{band === null ? t('priceBreaks.noBand') : formatMoney(band.unitPrice)}</dd></div>
        <div><dt className="text-ink-muted">{t('priceBreaks.total')}</dt><dd className="font-medium">{totalMinor === null ? '—' : formatMoneyMinor(totalMinor.toString(), currency)}</dd></div>
        <div><dt className="text-ink-muted">{t('priceBreaks.production')}</dt><dd>{productionWeeks === null ? t('priceBreaks.capacityUnknown') : t('priceBreaks.weeks', { weeks: productionWeeks.toLocaleString(intlLocale), perWeek: (capacity?.unitsPerWeek ?? 0).toLocaleString(intlLocale) })}</dd></div>
        <div><dt className="text-ink-muted">{t('priceBreaks.leadTime')}</dt><dd>{lead === null ? t('priceBreaks.leadUnknown') : t('priceBreaks.leadDays', { days: lead })}</dd></div>
      </dl>
      {landed === null ? null : <Link to={landed} className="mt-2 inline-block font-medium text-brand hover:underline">{t('priceBreaks.landed')}</Link>}
    </section>
  );
}
