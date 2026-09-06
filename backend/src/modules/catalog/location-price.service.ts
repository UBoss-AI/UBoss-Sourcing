/**
 * What a shelf price becomes once you know where the shopper is.
 *
 * `product_prices` holds one figure per currency, and a currency is not a
 * location. Germany, the Netherlands and Ireland are all euro, and all three
 * charge different VAT on the same box - 19%, 21%, 23%. Quoting one number to
 * all three is quoting two of them a price they will not be charged, and the
 * discrepancy surfaces at checkout, which is the worst possible moment to
 * discover it.
 *
 * So the catalogue asks the question the cart already asks: given the
 * destination, what does this line actually cost? `tax/vat.service.ts` answers
 * it, and this module is a thin shelf-facing wrapper around that answer. Both
 * paths run through `applyLineTax`, so the grid, the product page and the
 * basket cannot disagree about a price.
 *
 * The one thing added here is putting the tax back IN. `applyLineTax` returns
 * a net figure and a rate, which is what a cart wants - it lists tax on its
 * own line. A shelf does not: Directive 98/6/EC requires the selling price a
 * consumer sees to include VAT, and a shopper who has been shown a gross price
 * all along must keep seeing one after switching country. So where the tax
 * class is inclusive, the destination's tax goes back into the displayed
 * figure and the price stays quoted the way the catalogue was authored.
 *
 * A deployment with no `vatCountry` never reaches any of that: the treatment
 * resolves to FLAT_RATE and every price is the listed one, exactly as before
 * this module existed.
 */
import { calculateTax, type Minor } from '../../domain/money.js';
import { prisma } from '../../infra/prisma.js';
import {
  TaxTreatment,
  VatCategory,
  applyLineTax,
  loadTaxContext,
  type TaxSetup,
  type VatCategoryValue,
} from '../tax/vat.service.js';

/**
 * The destination a public request is priced for.
 *
 * Null means "not stated", which the VAT engine reads as the seller's own
 * country rather than as an error - the same fallback a shopper gets before
 * they have entered a delivery address.
 *
 * An unrecognised value is ignored rather than rejected: a bad country code
 * should quote the default market, not break the catalogue. A bad *currency*
 * still has to be an error, because that one silently quotes another market's
 * numbers rather than merely the wrong tax on this one.
 */
export function destinationFor(requested: string | undefined | null): string | null {
  if (requested === undefined || requested === null) return null;

  const trimmed = requested.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * The tax setup for an anonymous shopper standing in `country`.
 *
 * No VAT number: these routes are unauthenticated, so there is nobody to hold
 * one. A business buyer's reverse charge is applied in the cart, once they
 * have signed in and their number has been through VIES - the catalogue quotes
 * the consumer price, which is the higher of the two and therefore the safe
 * one to advertise.
 */
export async function loadShelfTax(country: string | null): Promise<TaxSetup> {
  return loadTaxContext({
    destinationCountry: country,
    vatNumber: null,
    vatNumberValid: null,
  });
}

export interface ShelfLine {
  vatCategory: VatCategoryValue | null;
  /** The tax class's own percentage, as a string. */
  flatRatePercent: string;
  taxInclusive: boolean;
  productName: string;
}

export interface ShelfQuote {
  /** What the shopper is quoted, gross or net exactly as `taxInclusive` says. */
  unitPriceMinor: Minor;
  taxRatePercent: string;
  taxInclusive: boolean;
  /** Set when the rate could not be determined. The listed price is then kept. */
  problem: string | null;
}

/**
 * Are these two rates the same number?
 *
 * They arrive as strings from two different places - a Decimal column and a
 * tax class's own percentage - so "21" and "21.000000" are the same rate
 * written twice. Compared as text they are not, and compared as floats they
 * would be a rounding bug in the code that exists to prevent rounding bugs.
 */
function sameRate(left: string, right: string): boolean {
  const normalise = (value: string): string => {
    const [whole = '0', fraction = ''] = value.trim().split('.');
    return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`;
  };

  return normalise(left) === normalise(right);
}

/** The rate baked into a listed figure: the seller's own, for this band. */
function domesticRateFor(setup: TaxSetup, line: ShelfLine): string {
  if (line.vatCategory === null) return line.flatRatePercent;

  return setup.domesticRates.get(line.vatCategory)?.toString() ?? line.flatRatePercent;
}

/**
 * Reprice one listed figure for the destination.
 *
 * Under FLAT_RATE this returns its argument untouched, which is why an Indian
 * GST deployment sees no behaviour change at all.
 *
 * Where the rate cannot be determined - a tax class with no EU band, a member
 * state with no row for a band - the listed price is kept rather than a price
 * built on a rate nobody configured. The cart blocks that line at checkout
 * with the same message; a catalogue that hid the product instead would leave
 * an administrator with a vanished product and no explanation.
 */
export function quoteShelfPrice(setup: TaxSetup, line: ShelfLine, listedMinor: Minor): ShelfQuote {
  const applied = applyLineTax(setup, line, listedMinor);

  if (applied.problem !== null) {
    return {
      unitPriceMinor: listedMinor,
      taxRatePercent: line.flatRatePercent,
      taxInclusive: line.taxInclusive,
      problem: applied.problem,
    };
  }

  // FLAT_RATE, or a catalogue authored net of tax. Either way the figure is
  // already quoted the way this shelf quotes prices.
  if (!line.taxInclusive || applied.taxInclusive) {
    return { ...applied, problem: null };
  }

  /**
   * Quoted at the very rate the price was authored at - a domestic sale, or a
   * member state that happens to charge the same on this band.
   *
   * The figure is already right, and the round trip below can only damage it:
   * taking 9% out of INR 1,450.00 and putting 9% back lands on INR 1,450.01,
   * because neither direction divides evenly and each rounds on its own. A
   * penny appearing beside an untouched price reads as a pricing fault to
   * whoever typed it, and it is the shopper's own market that sees it - the
   * one market where the shelf must be exact.
   */
  if (sameRate(applied.taxRatePercent, domesticRateFor(setup, line))) {
    return {
      unitPriceMinor: listedMinor,
      taxRatePercent: applied.taxRatePercent,
      taxInclusive: true,
      problem: null,
    };
  }

  // An inclusive catalogue under an EU treatment. `applyLineTax` took the
  // seller's own VAT back out and handed over a net figure; the destination's
  // tax goes on top and the price is gross again. Where the supply is
  // zero-rated the rate is "0", the two figures coincide, and the shopper
  // correctly sees the net price.
  const gross = calculateTax(applied.unitPriceMinor, applied.taxRatePercent, false).grossMinor;

  return {
    unitPriceMinor: gross,
    taxRatePercent: applied.taxRatePercent,
    taxInclusive: true,
    problem: null,
  };
}

/**
 * How a whole shelf moves between the listed figures and the quoted ones.
 *
 * The listing sorts and filters in the database, against `basePriceMinor` -
 * the listed figure. The shopper types their price bounds against what they
 * can see, which after the adjustment above is a different number. Without a
 * translation between the two, a shopper in Ireland sets a EUR 100 ceiling and
 * the grid hands back items it then displays at EUR 104.
 *
 * The factor is taken from the STANDARD band, because that is what almost
 * every line in a catalogue carries. A reduced-rate product can therefore sit
 * a little outside a typed bound - the alternative is repricing the entire
 * catalogue in memory on every request in order to sort it, which is not a
 * trade worth making for a filter box.
 *
 * Both rates are carried rather than a ratio, so the conversion stays in exact
 * bigint arithmetic instead of going through a float.
 */
export interface ShelfScale {
  /** The rate baked into the listed figures. */
  fromPercent: string;
  /** The rate the shopper is quoted at. */
  toPercent: string;
}

/**
 * Null when listed and quoted figures coincide, which is the common case:
 * FLAT_RATE, a catalogue authored net of tax, or a domestic sale.
 */
export function shelfScaleFor(setup: TaxSetup, taxInclusive: boolean): ShelfScale | null {
  if (setup.context.treatment === TaxTreatment.FLAT_RATE) return null;
  if (!taxInclusive) return null;

  const from = setup.domesticRates.get(VatCategory.STANDARD)?.toString() ?? null;
  if (from === null) return null;

  const to = setup.context.zeroRated
    ? '0'
    : (setup.rates.get(VatCategory.STANDARD)?.toString() ?? null);
  if (to === null) return null;

  return from === to ? null : { fromPercent: from, toPercent: to };
}

/** A listed figure, as the shopper sees it. */
export function toQuoted(listedMinor: Minor, scale: ShelfScale | null): Minor {
  if (scale === null) return listedMinor;

  const net = calculateTax(listedMinor, scale.fromPercent, true).netMinor;
  return calculateTax(net, scale.toPercent, false).grossMinor;
}

/** A figure the shopper typed, back in the terms the database stores. */
export function toListed(quotedMinor: Minor, scale: ShelfScale | null): Minor {
  if (scale === null) return quotedMinor;

  const net = calculateTax(quotedMinor, scale.toPercent, true).netMinor;
  return calculateTax(net, scale.fromPercent, false).grossMinor;
}

/**
 * Whether this deployment's catalogue is authored inclusive of tax.
 *
 * One question per request rather than one per product: `shelfScaleFor` needs
 * an answer before any product has been read, so that the price bounds can be
 * translated into the query. Tax classes in a deployment are inclusive or they
 * are not - a catalogue mixing the two has a display problem this cannot fix
 * anyway - so the majority answer is the right one to scale a filter box by.
 * Each product's own price is still quoted from its own class.
 */
export async function catalogueIsInclusive(): Promise<boolean> {
  const [inclusive, total] = await Promise.all([
    prisma.taxClass.count({ where: { isActive: true, isInclusive: true } }),
    prisma.taxClass.count({ where: { isActive: true } }),
  ]);

  return inclusive * 2 > total;
}

/**
 * Everything a public request needs to price a shelf for one destination.
 *
 * Loaded once per request and threaded through, rather than resolved per
 * product: the VAT tables are the same for every line on the page, and a
 * lookup per card would turn a grid of twenty-four into fifty round trips.
 */
export interface ShelfContext {
  country: string | null;
  setup: TaxSetup;
  scale: ShelfScale | null;
}

export async function loadShelfContext(
  requestedCountry: string | undefined | null,
): Promise<ShelfContext> {
  const country = destinationFor(requestedCountry);
  const [setup, inclusive] = await Promise.all([loadShelfTax(country), catalogueIsInclusive()]);

  return { country, setup, scale: shelfScaleFor(setup, inclusive) };
}
