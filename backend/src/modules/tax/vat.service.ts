/**
 * EU VAT: which rate, and why.
 *
 * The question this file answers is not "what is the VAT rate" — there is no
 * such thing as *the* rate. The same box of syringes leaving a Dutch warehouse
 * is 21% to a hospital in Rotterdam, 9% to one in Rotterdam if the state has
 * put medical devices in its reduced band, 0% to a German wholesaler that
 * holds a VAT number Germany will confirm, 19% to a German pharmacy that does
 * not, and 0% again to a buyer in Oslo. Five answers, four legal bases, one
 * product.
 *
 * So the unit of work here is a **treatment**, not a percentage: who is
 * selling, who is buying, where the goods go, and which article of Directive
 * 2006/112/EC that combination lands on. The percentage falls out of the
 * treatment afterwards.
 *
 * Four rules run through everything below.
 *
 *   - **A VAT number is a claim until a member state confirms it.** Zero-rating
 *     an intra-Community supply moves the tax liability to the customer, and
 *     Art. 138(1)(b) puts the burden of establishing their status on the
 *     seller. If VIES has not confirmed the number, the sale is taxed. Being
 *     wrong in that direction costs the customer cash flow; being wrong the
 *     other way costs the seller the tax.
 *
 *   - **Nothing is decided from the country the shopper says they live in.**
 *     Where the goods are *delivered* is what Art. 33 turns on, so the
 *     destination is the shipping address at checkout. The stated country is
 *     used only to quote a plausible price before an address exists, and the
 *     quote is recomputed against the real address before any money moves.
 *
 *   - **Rates are looked up as of a date.** A rate change is not an edit; see
 *     the `VatRate` model. Every lookup here passes the date of supply.
 *
 *   - **Unconfigured means unchanged.** A deployment with no `vatCountry` on
 *     its business profile gets `FLAT_RATE` and the tax class's own
 *     percentage — exactly what this system did before EU VAT existed in it.
 *     That is what lets one codebase serve an Indian GST shop and a Dutch one.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { calculateTax } from '../../domain/money.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

export const TaxTreatment = {
  FLAT_RATE: 'FLAT_RATE',
  DOMESTIC: 'DOMESTIC',
  INTRA_EU_REVERSE_CHARGE: 'INTRA_EU_REVERSE_CHARGE',
  INTRA_EU_B2C: 'INTRA_EU_B2C',
  EXPORT: 'EXPORT',
} as const;

export type TaxTreatmentValue = (typeof TaxTreatment)[keyof typeof TaxTreatment];

export const VatCategory = {
  STANDARD: 'STANDARD',
  REDUCED: 'REDUCED',
  SUPER_REDUCED: 'SUPER_REDUCED',
  ZERO: 'ZERO',
  EXEMPT: 'EXEMPT',
} as const;

export type VatCategoryValue = (typeof VatCategory)[keyof typeof VatCategory];

/**
 * The wording an invoice must carry when no VAT is charged.
 *
 * Art. 226(11) is not satisfied by leaving the tax line at zero: the invoice
 * has to say which provision it relies on. These are the standard formulations
 * and are frozen onto the invoice at issue, so a reprint years later says what
 * was issued rather than what this file happens to say today.
 */
const EXEMPTION_NOTES: Readonly<Partial<Record<TaxTreatmentValue, string>>> = Object.freeze({
  [TaxTreatment.INTRA_EU_REVERSE_CHARGE]:
    'Reverse charge. Intra-Community supply exempt under Article 138 of Council Directive ' +
    '2006/112/EC. VAT is to be accounted for by the recipient under Article 196.',
  [TaxTreatment.EXPORT]:
    'Zero-rated export of goods under Article 146 of Council Directive 2006/112/EC.',
});

export interface SellerVatProfile {
  /** The member state the business is established in. Null switches EU VAT off. */
  vatCountry: string | null;
  vatNumber: string | null;
}

export interface BuyerVatProfile {
  /** Where the goods are going. The shipping address country at checkout. */
  destinationCountry: string | null;
  vatNumber: string | null;
  /** What VIES said. Null means never checked, which is not the same as false. */
  vatNumberValid: boolean | null;
}

export interface TaxContext {
  treatment: TaxTreatmentValue;
  /** The member state whose rates apply. Null under FLAT_RATE and where zero-rated. */
  rateCountry: string | null;
  /** True when the rate is 0 by law rather than by the rate table. */
  zeroRated: boolean;
  /** Art. 226(11) wording, when one is required. */
  exemptionNote: string | null;
  sellerVatNumber: string | null;
  buyerVatNumber: string | null;
  /**
   * Why the treatment came out as it did, in a sentence a member of staff can
   * read. Shown in the admin order view, because "why is this order zero-rated"
   * is the single most common question about a VAT engine, and an answer that
   * requires reading the source is not an answer.
   */
  reason: string;
}

/** The flat-rate context: what every deployment gets until VAT is configured. */
export function flatRateContext(): TaxContext {
  return {
    treatment: TaxTreatment.FLAT_RATE,
    rateCountry: null,
    zeroRated: false,
    exemptionNote: null,
    sellerVatNumber: null,
    buyerVatNumber: null,
    reason: 'No EU VAT country is configured for this business, so tax-class rates apply.',
  };
}

/**
 * Decide the treatment.
 *
 * Pure: every fact it needs is an argument, so the whole decision table is
 * testable without a database. `euCountries` is the set of ISO codes flagged
 * `isEuVat` — passed in rather than looked up here for the same reason.
 */
export function resolveTaxTreatment(
  seller: SellerVatProfile,
  buyer: BuyerVatProfile,
  euCountries: ReadonlySet<string>,
): TaxContext {
  const sellerCountry = seller.vatCountry?.toUpperCase() ?? null;

  // Not an EU seller, or not configured as one. Nothing below applies.
  if (sellerCountry === null || !euCountries.has(sellerCountry)) return flatRateContext();

  const destination = buyer.destinationCountry?.toUpperCase() ?? null;

  // No address yet. Quote at the seller's own rate: it is the only defensible
  // guess, it is what a shopper standing in the seller's country would pay,
  // and checkout recomputes against the real address before any money moves.
  if (destination === null) {
    return {
      treatment: TaxTreatment.DOMESTIC,
      rateCountry: sellerCountry,
      zeroRated: false,
      exemptionNote: null,
      sellerVatNumber: seller.vatNumber,
      buyerVatNumber: null,
      reason:
        `No delivery address yet, so prices are quoted at ${sellerCountry} rates. ` +
        'The rate is recalculated from the delivery address at checkout.',
    };
  }

  // Same member state. Ordinary domestic VAT, whether or not the buyer is a
  // business - a domestic B2B sale is not reverse-charged.
  if (destination === sellerCountry) {
    return {
      treatment: TaxTreatment.DOMESTIC,
      rateCountry: sellerCountry,
      zeroRated: false,
      exemptionNote: null,
      sellerVatNumber: seller.vatNumber,
      buyerVatNumber: buyer.vatNumber,
      reason: `Delivered within ${sellerCountry}, so ${sellerCountry} VAT applies.`,
    };
  }

  // Leaving the Union. Zero-rated under Art. 146 - conditional on the seller
  // being able to prove the goods left, which is a paperwork obligation this
  // software records but cannot discharge.
  if (!euCountries.has(destination)) {
    return {
      treatment: TaxTreatment.EXPORT,
      rateCountry: null,
      zeroRated: true,
      exemptionNote: EXEMPTION_NOTES[TaxTreatment.EXPORT] ?? null,
      sellerVatNumber: seller.vatNumber,
      buyerVatNumber: buyer.vatNumber,
      reason:
        `Delivered to ${destination}, outside the EU VAT area, so the supply is zero-rated ` +
        'as an export. Keep proof of export with the order.',
    };
  }

  // Another member state, and the customer holds a number that state has
  // confirmed. The supply is zero-rated and the customer accounts for the tax.
  //
  // `=== true` and not a truthiness check: null means "never checked", and the
  // difference between "we asked and they said no" and "we never asked" is the
  // difference between a taxed sale and a tax bill.
  if (buyer.vatNumberValid === true && buyer.vatNumber !== null) {
    return {
      treatment: TaxTreatment.INTRA_EU_REVERSE_CHARGE,
      rateCountry: null,
      zeroRated: true,
      exemptionNote: EXEMPTION_NOTES[TaxTreatment.INTRA_EU_REVERSE_CHARGE] ?? null,
      sellerVatNumber: seller.vatNumber,
      buyerVatNumber: buyer.vatNumber,
      reason:
        `Intra-Community supply to a business in ${destination} holding a VAT number ` +
        'confirmed by VIES. Zero-rated; the customer accounts for the VAT.',
    };
  }

  // Another member state, no confirmed number. Charged at the DESTINATION
  // state's rate and declared through the One Stop Shop.
  //
  // The €10,000 distance-selling threshold in Art. 59c is deliberately not
  // implemented: it is a whole-business annual figure across every member
  // state, this software sees only its own orders, and a seller under the
  // threshold opts into destination rates anyway more often than not. Charging
  // the destination rate is the answer that is never unlawful; the seller's
  // accountant decides whether they could have charged less.
  return {
    treatment: TaxTreatment.INTRA_EU_B2C,
    rateCountry: destination,
    zeroRated: false,
    exemptionNote: null,
    sellerVatNumber: seller.vatNumber,
    buyerVatNumber: buyer.vatNumber,
    reason:
      buyer.vatNumber === null
        ? `Delivered to ${destination} with no VAT number given, so ${destination} VAT applies.`
        : `The VAT number given was not confirmed by VIES, so ${destination} VAT applies. ` +
          'Confirm the number to zero-rate future orders.',
  };
}

/** Countries flagged as inside the EU VAT area. Small, and read on every price. */
export async function euVatCountries(): Promise<Set<string>> {
  const rows = await prisma.country.findMany({
    where: { isEuVat: true },
    select: { code: true },
  });

  return new Set(rows.map((row) => row.code.toUpperCase()));
}

/** The seller's VAT identity. Null `vatCountry` is what keeps FLAT_RATE the default. */
export async function sellerVatProfile(): Promise<SellerVatProfile> {
  const profile = await prisma.businessProfile.findFirst({
    select: { vatCountry: true, vatNumber: true },
  });

  return {
    vatCountry: profile?.vatCountry ?? null,
    vatNumber: profile?.vatNumber ?? null,
  };
}

/**
 * The rate for one band in one country, as of a date.
 *
 * Returns null when the table has nothing to say, which the caller must treat
 * as "cannot price this here" rather than as zero. A missing rate is a
 * configuration gap; charging 0% because a row is absent would be a silent
 * undercharge that only surfaces at a VAT audit.
 */
export async function findVatRate(
  countryCode: string,
  category: VatCategoryValue,
  asOf: Date,
): Promise<Prisma.Decimal | null> {
  const row = await prisma.vatRate.findFirst({
    where: {
      countryCode: countryCode.toUpperCase(),
      category,
      validFrom: { lte: asOf },
      OR: [{ validTo: null }, { validTo: { gte: asOf } }],
    },
    // Latest applicable period wins, so an overlapping row added by hand
    // behaves as a correction rather than as a coin toss.
    orderBy: { validFrom: 'desc' },
    select: { ratePercent: true },
  });

  return row?.ratePercent ?? null;
}

/**
 * Every rate a country has on a date, by band.
 *
 * One query per priced cart rather than one per line: a fifty-line basket
 * touches at most a handful of bands, and looking each line up separately
 * turns pricing into fifty round trips.
 */
export async function vatRateTableFor(
  countryCode: string,
  asOf: Date,
): Promise<Map<VatCategoryValue, Prisma.Decimal>> {
  const rows = await prisma.vatRate.findMany({
    where: {
      countryCode: countryCode.toUpperCase(),
      validFrom: { lte: asOf },
      OR: [{ validTo: null }, { validTo: { gte: asOf } }],
    },
    orderBy: { validFrom: 'asc' },
    select: { category: true, ratePercent: true },
  });

  // Ascending, so a later period overwrites an earlier one and the last write
  // wins - the same "latest applicable period" rule as `findVatRate`.
  const table = new Map<VatCategoryValue, Prisma.Decimal>();
  for (const row of rows) table.set(row.category, row.ratePercent);

  return table;
}

export interface LineTaxInput {
  /** Null for a class with no EU meaning - the flat rate is then used. */
  vatCategory: VatCategoryValue | null;
  /** The tax class's own percentage, as a string. The FLAT_RATE answer. */
  flatRatePercent: string;
  productName: string;
}

export interface LineTaxResult {
  ratePercent: string;
  /** Set when the rate could not be determined, so the caller can refuse the sale. */
  problem: string | null;
}

/**
 * The rate for one line, given the treatment already decided.
 *
 * Kept separate from `resolveTaxTreatment` because the treatment is decided
 * once per order and the rate is decided once per line: a basket holding a
 * standard-rated and a reduced-rated item has one treatment and two rates, and
 * an invoice has to break the total down by rate to satisfy Art. 226(8)-(10).
 */
export function rateForLine(
  context: TaxContext,
  line: LineTaxInput,
  rates: ReadonlyMap<VatCategoryValue, Prisma.Decimal>,
): LineTaxResult {
  if (context.treatment === TaxTreatment.FLAT_RATE) {
    return { ratePercent: line.flatRatePercent, problem: null };
  }

  // Zero-rated by law. The band is irrelevant: a reverse-charged supply of a
  // reduced-rate product is still 0%.
  if (context.zeroRated) return { ratePercent: '0', problem: null };

  // An EU treatment against a product whose class was never given a band. The
  // flat rate is the only figure available and is almost certainly the wrong
  // country's, so this is surfaced rather than used silently.
  if (line.vatCategory === null) {
    return {
      ratePercent: line.flatRatePercent,
      problem:
        `${line.productName} has no EU VAT band on its tax class, so its flat rate was used. ` +
        'Set a VAT category on the tax class before selling it in the EU.',
    };
  }

  // Exempt and zero bands are 0% without needing a row, and most member states
  // never publish one for them.
  if (line.vatCategory === VatCategory.ZERO || line.vatCategory === VatCategory.EXEMPT) {
    return { ratePercent: '0', problem: null };
  }

  const rate = rates.get(line.vatCategory);

  if (rate === undefined) {
    // Never fall back to 0. A missing row is a configuration gap, and a silent
    // 0% is an undercharge that surfaces at an audit rather than at checkout.
    return {
      ratePercent: '0',
      problem:
        `No ${line.vatCategory} VAT rate is configured for ${context.rateCountry ?? 'that country'}, ` +
        `so ${line.productName} cannot be priced there.`,
    };
  }

  return { ratePercent: rate.toString(), problem: null };
}

export interface TaxSetup {
  context: TaxContext;
  /** Rates in the country being taxed. Empty when zero-rated or unconfigured. */
  rates: Map<VatCategoryValue, Prisma.Decimal>;
  /**
   * Rates in the SELLER's own country.
   *
   * Needed only for tax-inclusive catalogues, and only then for the reason in
   * `applyLineTax`: a listed gross price has the seller's domestic VAT baked
   * into it, and selling across a border means taking that particular VAT back
   * out before charging a different one — or none.
   */
  domesticRates: Map<VatCategoryValue, Prisma.Decimal>;
}

export interface ResolvedLineTax {
  unitPriceMinor: bigint;
  taxRatePercent: string;
  taxInclusive: boolean;
  problem: string | null;
}

/**
 * Turn a catalogue price into what this particular customer is charged.
 *
 * The interesting case is a **tax-inclusive catalogue selling across a
 * border**, which almost every implementation gets wrong.
 *
 * A Dutch shop lists a box at €121. That figure is €100 plus 21% Dutch VAT —
 * Dutch VAT specifically, baked into the number on the page. Sell it to a
 * German wholesaler under the reverse charge and the correct invoice is €100
 * and no tax. The tempting shortcut is to keep the €121 and set the tax line
 * to zero, which quietly charges the customer 21% more than they owe and hands
 * the seller money that is not theirs. The other tempting shortcut — treating
 * €121 as the net — overcharges by exactly the same amount.
 *
 * So under any EU treatment the listed gross is converted back to net using
 * the SELLER's domestic rate, and the destination's rate (or none) is then
 * applied on top. Under `FLAT_RATE` nothing here runs and inclusive pricing
 * behaves exactly as it always has.
 */
export function applyLineTax(
  setup: TaxSetup,
  line: LineTaxInput & { taxInclusive: boolean },
  unitPriceMinor: bigint,
): ResolvedLineTax {
  if (setup.context.treatment === TaxTreatment.FLAT_RATE) {
    return {
      unitPriceMinor,
      taxRatePercent: line.flatRatePercent,
      taxInclusive: line.taxInclusive,
      problem: null,
    };
  }

  const resolved = rateForLine(setup.context, line, setup.rates);

  if (!line.taxInclusive) {
    return {
      unitPriceMinor,
      taxRatePercent: resolved.ratePercent,
      taxInclusive: false,
      problem: resolved.problem,
    };
  }

  // The rate baked into the listed price: the seller's own, for this band. A
  // band the seller's country has no row for leaves the flat rate as the only
  // available answer, which is what an unconfigured deployment would have used
  // anyway.
  const domestic =
    line.vatCategory === null
      ? line.flatRatePercent
      : (setup.domesticRates.get(line.vatCategory)?.toString() ?? line.flatRatePercent);

  const net = calculateTax(unitPriceMinor, domestic, true).netMinor;

  return {
    unitPriceMinor: net,
    taxRatePercent: resolved.ratePercent,
    // Now an exclusive price: the destination's tax, if any, goes on top.
    taxInclusive: false,
    problem: resolved.problem,
  };
}

/**
 * Load everything pricing needs, in one go.
 *
 * The cart calls this once and then prices every line against the result. A
 * deployment with no VAT configured pays two small indexed queries for the
 * privilege of finding that out, which is the right price for not having two
 * code paths through checkout.
 */
export async function loadTaxContext(
  buyer: BuyerVatProfile,
  asOf: Date = new Date(),
): Promise<TaxSetup> {
  const [seller, countries] = await Promise.all([sellerVatProfile(), euVatCountries()]);

  const context = resolveTaxTreatment(seller, buyer, countries);

  // The one early return that costs nothing: a deployment with no vatCountry
  // reaches here, learns it has no EU obligations, and prices exactly as it
  // did before this module existed.
  if (context.treatment === TaxTreatment.FLAT_RATE) {
    return { context, rates: new Map(), domesticRates: new Map() };
  }

  const sellerCountry = seller.vatCountry ?? '';

  const [rates, domesticRates] = await Promise.all([
    context.rateCountry === null
      ? Promise.resolve(new Map<VatCategoryValue, Prisma.Decimal>())
      : vatRateTableFor(context.rateCountry, asOf),
    // Always loaded, even when the sale is zero-rated: an inclusive catalogue
    // needs the seller's own rate to take the baked-in VAT back out. See
    // `applyLineTax`.
    vatRateTableFor(sellerCountry, asOf),
  ]);

  if (context.rateCountry !== null && rates.size === 0) {
    logger.warn(
      { country: context.rateCountry, treatment: context.treatment },
      'no VAT rates configured for the country this order is taxed in',
    );
  }

  return { context, rates, domesticRates };
}
