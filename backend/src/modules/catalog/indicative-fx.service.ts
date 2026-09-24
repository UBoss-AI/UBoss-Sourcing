/**
 * An approximate conversion, for SHOWING a figure in the reader's currency.
 *
 * Never for charging. A seller's offer is sold only in the offer's own
 * currency - the cart refuses it in any other - so every figure this produces
 * is labelled approximate on every screen that shows it, carries the rate, its
 * date and the snapshot it came from, and is frozen onto a preorder request so
 * "what was I shown?" can be answered afterwards.
 *
 * Built from the same published rate set and the same integer conversion as
 * the catalogue's own derived prices (`fx-snapshot.service`, `bulk-price`), so
 * it cannot disagree with them about a rate. Mid-market, with no margin: an
 * indication is not an offer to exchange money.
 */
import { FxError, QUOTE_DP, crossRate, formatRate, parseRate } from '../../domain/fx.js';
import type { Minor } from '../../domain/money.js';
import { activeRateSet } from '../settings/fx-snapshot.service.js';
import { convert, conversionFor } from './bulk-price.service.js';

export interface IndicativeConversion {
  fromCurrency: string;
  toCurrency: string;
  /** Mid-market, `QUOTE_DP` places. */
  rate: string;
  asOf: Date;
  snapshotId: string | null;
  provider: string;
  convert(amountMinor: Minor): Minor;
}

/**
 * The conversion from one currency to another, or null when there is no
 * valid published rate set or it does not quote the pair. Null is a real
 * answer: the reader is then shown the offer's own currency only.
 */
export async function indicativeConversion(
  fromCurrency: string,
  toCurrency: string,
): Promise<IndicativeConversion | null> {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  if (from === to) return null;

  const set = await activeRateSet();
  if (set === null) return null;

  let rate: string;
  try {
    rate = formatRate(parseRate(crossRate(from, to, set)), QUOTE_DP);
  } catch (error) {
    if (error instanceof FxError) return null;
    throw error;
  }

  const conversion = conversionFor({
    sourceCurrency: from,
    targetCurrency: to,
    rate,
    rounding: 'exact',
  });

  return {
    fromCurrency: from,
    toCurrency: to,
    rate,
    asOf: set.asOf,
    snapshotId: set.snapshotId,
    provider: set.provider,
    convert: (amountMinor) => convert(amountMinor, conversion),
  };
}

/** The provenance of a conversion as it crosses the API. */
export function describeConversion(
  conversion: IndicativeConversion,
): Record<string, string | null> {
  return {
    approximate: 'true',
    currency: conversion.toCurrency,
    fromCurrency: conversion.fromCurrency,
    rate: conversion.rate,
    rateAsOf: conversion.asOf.toISOString(),
    snapshotId: conversion.snapshotId,
    provider: conversion.provider,
  };
}
