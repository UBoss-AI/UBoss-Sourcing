/**
 * The caption under a price the shop worked out rather than set.
 *
 * WHY THIS EXISTS AT ALL
 *
 * A price somebody typed for a market is a commitment. A converted one is a
 * conversion of a commitment made in another currency, at an indicative
 * reference rate that moves daily, rounded by a rule. They are different
 * things, and the failure mode of presenting them identically is that the
 * buyer discovers the difference on their statement rather than on the page.
 *
 * So wherever a converted figure appears, this appears under it. Nothing else
 * in the storefront has to remember to do it: the presence of `conversion` on
 * the price IS the signal, and passing null renders nothing.
 *
 * DELIBERATELY QUIET
 *
 * One line of small muted text, not a banner. The figure is still the shop's
 * own, still what the basket will charge, and still what the buyer came to
 * read - the caption qualifies it rather than warning about it. A red panel
 * here would make an ordinary, correct price look like a fault.
 *
 * It names the source currency and the date of the rate, because those are the
 * two facts that let somebody check the arithmetic themselves. It does not
 * name the rate to eight decimal places, which nobody reads, and it does not
 * name the provider on the storefront - that is an operations fact and it
 * lives on the settings screen.
 */
import { useI18n } from '@/i18n/i18n-context';
import type { PriceConversion } from '@/lib/types';

interface ApproximatePriceProps {
  conversion: PriceConversion | null | undefined;
  /**
   * `inline` for a tight space such as a catalogue card, where the caption is
   * a single short phrase. `block` for a product page, where there is room to
   * say when the rate was published.
   */
  variant?: 'inline' | 'block';
  className?: string;
}

export function ApproximatePrice({
  conversion,
  variant = 'block',
  className,
}: ApproximatePriceProps): React.JSX.Element | null {
  const { t, intlLocale } = useI18n();

  // The ordinary case, and the default for every deployment: a real price
  // somebody entered for this currency. Nothing to say.
  if (conversion === null || conversion === undefined) return null;

  const asOf = new Date(conversion.rateAsOf);
  const dated = Number.isNaN(asOf.getTime())
    ? null
    : asOf.toLocaleDateString(intlLocale, { year: 'numeric', month: 'short', day: 'numeric' });

  const text =
    variant === 'inline' || dated === null
      ? t('price.approximate', { currency: conversion.baseCurrency })
      : t('price.approximateOn', { currency: conversion.baseCurrency, date: dated });

  return (
    <p className={`text-xs text-ink-muted ${className ?? ''}`.trim()} data-approximate-price="true">
      {text}
    </p>
  );
}
