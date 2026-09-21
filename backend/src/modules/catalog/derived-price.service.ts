/**
 * Pricing a market nobody has typed a price for.
 *
 * THE RULE THIS SITS UNDER, WHICH IT DOES NOT CHANGE
 *
 * `product_prices` is the authority. A figure a person entered for a currency
 * is what the shop charges in it, always, and this module never overrides one.
 * It only ever fills a hole: a SKU that has no row in the requested currency,
 * which until now simply was not sellable in it.
 *
 * That default has not changed either. Derivation is OFF unless an operator
 * turns `deriveMissingPrices` on, because opening a market is a pricing
 * decision and a database migration is not the thing that should make it.
 *
 * WHY A DERIVED FIGURE IS DIFFERENT FROM A MANUAL ONE, AND SAYS SO
 *
 * A manual price is a commitment. A derived one is a conversion of a
 * commitment made in another currency, at an indicative reference rate that
 * moves daily, rounded by a rule - so it is an approximation, it is labelled
 * as one everywhere it is shown, and the rate that produced it is recorded on
 * any order that results. The alternative, which is what most systems do, is
 * to present the two identically and leave the customer to discover the
 * difference on their statement.
 *
 * WHERE THE ARITHMETIC LIVES
 *
 * Not here. `domain/fx.ts` resolves the pair to a rate and `bulk-price
 * .service.ts`'s `conversionFor`/`convert` turn that rate into minor units
 * under the deployment's rounding rule - the same two functions the scheduled
 * price rewrite uses. That is deliberate and it is the project rule about
 * `quoteSchedule` applied to a second surface: the figure a shopper is shown
 * at read time and the figure the nightly job would write into a price row
 * must come from one implementation, or they will drift and nobody will be
 * able to say which is right.
 */
import {
  FxError,
  resolveRate,
  type FxPurpose,
  type ResolvedRate,
} from '../../domain/fx.js';
import { type Minor } from '../../domain/money.js';
import { prisma } from '../../infra/prisma.js';
import {
  FX_POLICY_VERSION,
  FX_SETTINGS_ID,
  activeRateSet,
  freshnessPolicyFrom,
} from '../settings/fx-snapshot.service.js';
import { conversionFor, convert, type PriceRounding } from './bulk-price.service.js';

/** How a figure shown to a customer was arrived at. */
export type PriceSource = 'MANUAL' | 'CONVERTED';

/**
 * Everything an order needs to record about a conversion, and everything a
 * page needs to caption one.
 */
export interface ConversionContext {
  baseCurrency: string;
  targetCurrency: string;
  rate: ResolvedRate;
  rounding: PriceRounding;
  policyVersion: string;
}

export interface DerivationSettings {
  enabled: boolean;
  baseCurrency: string;
  marginPercent: string;
  rounding: PriceRounding;
  policyVersion: string;
}

function isRounding(value: string): value is PriceRounding {
  return value === 'exact' || value === 'whole' || value === 'charm';
}

async function derivationSettings(baseCurrency: string): Promise<DerivationSettings> {
  const row = await prisma.currencyRateSync.upsert({
    where: { id: FX_SETTINGS_ID },
    create: { id: FX_SETTINGS_ID },
    update: {},
  });

  return {
    enabled: row.deriveMissingPrices,
    baseCurrency,
    marginPercent: row.marginPercent.toFixed(2),
    // A value outside the set can only come from a hand-edited database.
    // Falling back beats throwing: a bad rounding rule must not make the
    // catalogue unreachable, which is where somebody would notice it.
    rounding: isRounding(row.rounding) ? row.rounding : 'charm',
    policyVersion: FX_POLICY_VERSION,
  };
}

/**
 * Why no derived price could be produced.
 *
 * A closed set rather than a bare null, because the four reasons are not the
 * same fact and a shopper deserves to be told which one applies. "This product
 * is not sold in zloty" and "we cannot price in zloty this minute because the
 * rate feed has been down since Tuesday" look identical from inside the code
 * and completely different from outside it, and conflating them sends an
 * operator hunting through the catalogue for a missing price row that was
 * never the problem.
 */
export type DerivationRefusal =
  /** The target IS the base currency. Not a refusal; there is nothing to convert. */
  | 'NOT_APPLICABLE'
  /** `deriveMissingPrices` is off. The deployment prices by hand, deliberately. */
  | 'DISABLED'
  /** No validated rate set has ever been activated. */
  | 'NO_RATE_SET'
  /** There is a set, but it is too old for what the caller is doing. */
  | 'RATE_TOO_OLD'
  /** The feed does not quote this currency at all. The ECB and AED, for example. */
  | 'PAIR_NOT_QUOTED';

export type DerivationResult =
  | { ok: true; context: ConversionContext }
  | { ok: false; refusal: DerivationRefusal };

/**
 * The conversion to use for one target currency right now, or why not.
 *
 * Every refusal ends with the SKU being unavailable in that currency, which is
 * the behaviour that was already there for a currency with no price row. What
 * is new is that the caller can say which kind of unavailable it is.
 *
 * `purpose` is the whole reason the caller has to state what it is doing. A
 * catalogue page may render from a rate that is days old and caption it
 * approximate; a checkout may not, and is refused instead, so the sale fails
 * safely rather than charging a figure nobody can reconcile afterwards.
 */
export async function resolveDerivation(
  targetCurrency: string,
  baseCurrency: string,
  purpose: FxPurpose,
  now: Date = new Date(),
): Promise<DerivationResult> {
  const target = targetCurrency.toUpperCase();
  const base = baseCurrency.toUpperCase();

  // Converting a currency to itself is not a conversion, and a price row in
  // the base currency is a manual price by definition.
  if (target === base) return { ok: false, refusal: 'NOT_APPLICABLE' };

  const settings = await derivationSettings(base);
  if (!settings.enabled) return { ok: false, refusal: 'DISABLED' };

  const set = await activeRateSet();
  if (set === null) return { ok: false, refusal: 'NO_RATE_SET' };

  const policyRow = await prisma.currencyRateSync.findUnique({
    where: { id: FX_SETTINGS_ID },
    select: { displayMaxAgeHours: true, checkoutMaxAgeHours: true },
  });

  if (policyRow === null) return { ok: false, refusal: 'NO_RATE_SET' };

  try {
    const rate = resolveRate(base, target, set, {
      purpose,
      policy: freshnessPolicyFrom(policyRow),
      adjustmentPercent: settings.marginPercent,
      now,
    });

    return {
      ok: true,
      context: {
        baseCurrency: base,
        targetCurrency: target,
        rate,
        rounding: settings.rounding,
        policyVersion: settings.policyVersion,
      },
    };
  } catch (cause) {
    if (cause instanceof FxError) {
      return {
        ok: false,
        refusal: cause.reason === 'RATE_TOO_OLD' ? 'RATE_TOO_OLD' : 'PAIR_NOT_QUOTED',
      };
    }
    throw cause;
  }
}

/** The common case: the context, or null, without caring which refusal. */
export async function conversionContextFor(
  targetCurrency: string,
  baseCurrency: string,
  purpose: FxPurpose,
  now: Date = new Date(),
): Promise<ConversionContext | null> {
  const result = await resolveDerivation(targetCurrency, baseCurrency, purpose, now);
  return result.ok ? result.context : null;
}

/**
 * A refusal in words a shopper can act on.
 *
 * Deliberately vague about the provider and precise about what the shopper
 * should do. "The ECB feed last published on Friday" is an operations fact,
 * not a shopping one, and it belongs on the settings screen rather than in a
 * basket.
 */
export function explainRefusal(refusal: DerivationRefusal, currency: string): string {
  switch (refusal) {
    case 'RATE_TOO_OLD':
    case 'NO_RATE_SET':
      return `We cannot price in ${currency} at the moment. Please try again shortly, or switch currency.`;
    case 'PAIR_NOT_QUOTED':
      return `${currency} cannot be converted automatically. Please switch currency.`;
    case 'DISABLED':
    case 'NOT_APPLICABLE':
      return `Not sold in ${currency}.`;
  }
}

/** True when the refusal is temporary and retrying later is the right advice. */
export function isTransientRefusal(refusal: DerivationRefusal): boolean {
  return refusal === 'RATE_TOO_OLD' || refusal === 'NO_RATE_SET';
}

/**
 * Convert one base-currency amount with an already-resolved context.
 *
 * Separate from `conversionContextFor` so a page converting two hundred
 * catalogue rows resolves the rate once. Re-resolving per row would be slow
 * and, worse, could straddle a refresh and price half a page at one rate.
 */
export function deriveAmount(baseAmountMinor: Minor, context: ConversionContext): Minor {
  return convert(
    baseAmountMinor,
    conversionFor({
      sourceCurrency: context.baseCurrency,
      targetCurrency: context.targetCurrency,
      rate: context.rate.rate,
      rounding: context.rounding,
    }),
  );
}

/**
 * The columns an order freezes, as a plain object.
 *
 * Built once, at checkout, and written with the order row. Nothing recomputes
 * it afterwards: when the rate moves tomorrow, this order keeps today's
 * number, today's rate and today's rounding rule, which is the difference
 * between a total somebody can be shown the arithmetic for and a total nobody
 * can explain.
 *
 * `baseGrandTotalMinor` is supplied by the caller rather than derived here,
 * because only checkout knows the final total after tax, shipping and any
 * coupon - converting the line prices and adding them up separately would be a
 * second answer to "what does this basket cost".
 */
export interface OrderFxSnapshot {
  fxPriceSource: PriceSource;
  fxSnapshotId: string | null;
  fxBaseCurrency: string;
  fxMidRate: string;
  fxRateUsed: string;
  fxAdjustmentPercent: string;
  fxRateAsOf: Date;
  fxProvider: string;
  fxPolicyVersion: string;
}

export function orderFxSnapshotFrom(context: ConversionContext): OrderFxSnapshot {
  return {
    fxPriceSource: 'CONVERTED',
    fxSnapshotId: context.rate.snapshotId,
    fxBaseCurrency: context.baseCurrency,
    fxMidRate: context.rate.midRate,
    fxRateUsed: context.rate.rate,
    fxAdjustmentPercent: context.rate.adjustmentPercent,
    fxRateAsOf: context.rate.asOf,
    fxProvider: context.rate.provider,
    fxPolicyVersion: context.policyVersion,
  };
}

/** What the API hands a frontend so it can caption an approximate figure. */
export interface ConversionDisclosure {
  source: PriceSource;
  baseCurrency: string;
  rate: string;
  rateAsOf: string;
  provider: string;
  approximate: true;
}

export function discloseConversion(context: ConversionContext): ConversionDisclosure {
  return {
    source: 'CONVERTED',
    baseCurrency: context.baseCurrency,
    rate: context.rate.rate,
    rateAsOf: context.rate.asOf.toISOString(),
    provider: context.rate.provider,
    approximate: true,
  };
}
