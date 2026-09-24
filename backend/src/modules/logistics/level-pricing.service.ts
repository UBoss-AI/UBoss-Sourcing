/**
 * What delivery costs a buyer: L1 + L2 + L3 + L4, per seller, for one basket
 * going to one address.
 *
 * Called by `resolveCart` and by nothing that prices a basket on its own - the
 * cart, the checkout and the quote endpoint all get this answer through the
 * cart's single pricing run, so the figure a buyer reviews and the figure they
 * are charged cannot come from two places.
 *
 * WHO IS PRICED HERE. Only marketplace lines whose seller has PUBLISHED a
 * logistics policy. A seller who has not is untouched - their lines are priced
 * exactly as they were before this existed - because a new capability must not
 * become a new way for a running shop to stop selling.
 *
 * NOTHING IS GUESSED. A level with no approved price for this route makes the
 * seller's delivery `QUOTE_REQUIRED` and the cart not ready for checkout. It is
 * never priced at zero, and never at another route's price.
 *
 * THE QUOTE IS SIGNED. `token` is an HMAC over exactly what was priced - each
 * seller's policy version, each level's price row and amount, the currency and
 * the destination - under a server secret. Checkout re-prices from scratch and
 * refuses a token that does not match, so a browser that edits a figure, or
 * carries a quote across a price change, is told so instead of being charged
 * something nobody showed it.
 */
import { createHmac } from 'node:crypto';
import { env } from '../../config/env.js';
import {
  LOGISTICS_LEVELS,
  ownersForMode,
  resolveRoute,
  type LogisticsControlOwner,
  type LogisticsLevel,
  type PackageClass,
  type RouteRate,
} from '../../domain/logistics-levels.js';
import { sumMinor, type Minor } from '../../domain/money.js';
import type { FxPurpose } from '../../domain/fx.js';
import { safeCompare } from '../../infra/crypto.js';
import { prisma } from '../../infra/prisma.js';
import { conversionFor, convert } from '../catalog/bulk-price.service.js';
import { resolveDerivation } from '../catalog/derived-price.service.js';

export const DELIVERY_QUOTE_VERSION = 'logistics-levels-1';

export interface DeliveryLine {
  sellerOfferId: string;
  quantity: number;
  weightGrams: number | null;
  packageClass: PackageClass;
}

export interface PricedLeg {
  level: LogisticsLevel;
  owner: LogisticsControlOwner;
  rateId: string;
  rateVersionNumber: number;
  transportMode: string;
  provider: string | null;
  logisticsPartnerId: string | null;
  providerLabel: string | null;
  serviceName: string | null;
  originLabel: string;
  destinationLabel: string;
  transitDaysMin: number | null;
  transitDaysMax: number | null;
  originalAmountMinor: Minor;
  originalCurrency: string;
  fxRate: string | null;
  fxProvider: string | null;
  fxRateAsOf: Date | null;
  amountMinor: Minor;
  isFree: boolean;
  taxInclusive: boolean;
  priceSource: string;
}

export type SellerDeliveryStatus = 'PRICED' | 'QUOTE_REQUIRED';

export interface SellerDeliveryQuote {
  sellerAccountId: string;
  sellerName: string;
  policyVersionId: string;
  policyVersionNumber: number;
  status: SellerDeliveryStatus;
  /** Every level, priced or not. `leg` is null where there is no price. */
  levels: { level: LogisticsLevel; owner: LogisticsControlOwner; leg: PricedLeg | null; reason: string | null }[];
  /** Null unless every level is priced. Never a partial sum. */
  totalMinor: Minor | null;
}

export interface DeliveryQuote {
  version: string;
  currency: string;
  destinationCountry: string | null;
  sellers: SellerDeliveryQuote[];
  /** The sum over sellers whose delivery is fully priced. */
  totalMinor: Minor;
  quoteRequired: boolean;
  token: string;
}

/** A pallet outranks a parcel; a container outranks both. */
function heavier(a: PackageClass, b: PackageClass): PackageClass {
  const rank: Record<PackageClass, number> = { PARCEL: 0, PALLET: 1, CONTAINER: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function packageClassFor(packageType: string | null | undefined): PackageClass {
  if (packageType === 'UK_PALLET' || packageType === 'US_PALLET') return 'PALLET';
  if (packageType === 'CONTAINER') return 'CONTAINER';
  return 'PARCEL';
}

/**
 * Price delivery for a basket's marketplace lines.
 *
 * Returns `null` when no line belongs to a seller with a published policy -
 * the ordinary case on most deployments today, and then nothing about the
 * cart changes.
 */
export async function quoteDelivery(input: {
  lines: readonly DeliveryLine[];
  currency: string;
  destinationCountry: string | null;
  destinationPostcode: string | null;
  fxPurpose: FxPurpose;
  now?: Date;
}): Promise<DeliveryQuote | null> {
  if (input.lines.length === 0) return null;

  const offers = await prisma.sellerOffer.findMany({
    where: { id: { in: [...new Set(input.lines.map((line) => line.sellerOfferId))] } },
    select: { id: true, sellerAccountId: true },
  });
  const sellerOfOffer = new Map(offers.map((offer) => [offer.id, offer.sellerAccountId]));

  const policies = await prisma.sellerLogisticsPolicy.findMany({
    where: { sellerAccountId: { in: [...new Set(offers.map((offer) => offer.sellerAccountId))] }, activeVersionId: { not: null } },
    include: { activeVersion: true, sellerAccount: { select: { displayName: true } } },
  });
  if (policies.length === 0) return null;

  const sellers: SellerDeliveryQuote[] = [];

  for (const policy of policies) {
    const version = policy.activeVersion;
    if (version === null) continue;

    const sellerLines = input.lines.filter((line) => sellerOfOffer.get(line.sellerOfferId) === policy.sellerAccountId);
    if (sellerLines.length === 0) continue;

    const weights = sellerLines.map((line) => line.weightGrams);
    const weightGrams = weights.every((weight) => weight !== null)
      ? weights.reduce<number>((total, weight) => total + (weight ?? 0), 0)
      : null;
    const packageClass = sellerLines.reduce<PackageClass>((cls, line) => heavier(cls, line.packageClass), 'PARCEL');

    const originLocationId = await dispatchLocationFor(policy.sellerAccountId, sellerLines.map((line) => line.sellerOfferId));
    const owners = ownersForMode(version.mode, version);

    const rates = await prisma.logisticsLevelRate.findMany({
      where: {
        sellerAccountId: policy.sellerAccountId,
        status: 'PUBLISHED',
        effectiveFrom: { lte: input.now ?? new Date() },
      },
      include: {
        originLocation: { select: { name: true, city: true, countryCode: true } },
        logisticsPartner: { select: { displayName: true } },
      },
    });

    type LoadedRate = (typeof rates)[number];
    const routeRates: (RouteRate & { row: LoadedRate })[] = rates
      .filter((rate) => rate.amountMinor !== null)
      .map((rate) => ({
        id: rate.id,
        level: rate.level,
        owner: rate.owner,
        originLocationId: rate.originLocationId,
        originPortCode: rate.originPortCode,
        destinationPortCode: rate.destinationPortCode,
        destinationHubCode: rate.destinationHubCode,
        destinationHubName: rate.destinationHubName,
        destinationCountry: rate.destinationCountry,
        destinationPostalPrefix: rate.destinationPostalPrefix,
        packageClass: rate.packageClass,
        minWeightGrams: rate.minWeightGrams,
        maxWeightGrams: rate.maxWeightGrams,
        isWorldwideFlat: rate.isWorldwideFlat,
        amountMinor: rate.amountMinor ?? 0n,
        currency: rate.currency,
        publishedAt: rate.publishedAt,
        row: rate,
      }));

    const levels: SellerDeliveryQuote['levels'] = [];

    if (input.destinationCountry === null) {
      // No address yet: nothing can be matched to a route, and a quote for
      // "somewhere" is exactly the global number this refuses to invent.
      for (const level of LOGISTICS_LEVELS) {
        levels.push({ level, owner: owners[level], leg: null, reason: 'DESTINATION_REQUIRED' });
      }
    } else {
      const route = resolveRoute(routeRates, owners, {
        originLocationId,
        destinationCountry: input.destinationCountry,
        destinationPostcode: input.destinationPostcode,
        weightGrams,
        packageClass,
      });

      for (const step of route) {
        if (step.rate === null) {
          levels.push({
            level: step.level,
            owner: step.owner,
            leg: null,
            reason: step.owner === 'UBOSS' ? 'PENDING_UBOSS_PRICE' : 'NO_PRICE_FOR_ROUTE',
          });
          continue;
        }

        const converted = await convertForBuyer(step.rate.row.amountMinor ?? 0n, step.rate.currency, input.currency, input.fxPurpose);
        if (converted === null) {
          levels.push({ level: step.level, owner: step.owner, leg: null, reason: 'CURRENCY_NOT_CONVERTIBLE' });
          continue;
        }

        const row = step.rate.row;
        levels.push({
          level: step.level,
          owner: step.owner,
          reason: null,
          leg: {
            level: step.level,
            owner: step.owner,
            rateId: row.id,
            rateVersionNumber: row.versionNumber,
            transportMode: row.transportMode,
            provider: row.provider,
            logisticsPartnerId: row.logisticsPartnerId,
            providerLabel: row.providerLabel ?? row.logisticsPartner?.displayName ?? null,
            serviceName: row.serviceName,
            originLabel: originLabel(step.level, row),
            destinationLabel: destinationLabel(step.level, row, input.destinationCountry),
            transitDaysMin: row.transitDaysMin,
            transitDaysMax: row.transitDaysMax,
            originalAmountMinor: row.amountMinor ?? 0n,
            originalCurrency: row.currency,
            fxRate: converted.rate,
            fxProvider: converted.provider,
            fxRateAsOf: converted.asOf,
            amountMinor: converted.amountMinor,
            isFree: row.isFree,
            taxInclusive: row.taxInclusive,
            priceSource: row.priceSource,
          },
        });
      }
    }

    const priced = levels.every((level) => level.leg !== null);
    sellers.push({
      sellerAccountId: policy.sellerAccountId,
      sellerName: policy.sellerAccount.displayName,
      policyVersionId: version.id,
      policyVersionNumber: version.versionNumber,
      status: priced ? 'PRICED' : 'QUOTE_REQUIRED',
      levels,
      totalMinor: priced ? sumMinor(levels.map((level) => level.leg?.amountMinor ?? 0n)) : null,
    });
  }

  if (sellers.length === 0) return null;

  sellers.sort((a, b) => (a.sellerAccountId < b.sellerAccountId ? -1 : 1));
  const totalMinor = sumMinor(sellers.map((seller) => seller.totalMinor ?? 0n));
  const quoteRequired = sellers.some((seller) => seller.status === 'QUOTE_REQUIRED');

  const unsigned = {
    version: DELIVERY_QUOTE_VERSION,
    currency: input.currency,
    destinationCountry: input.destinationCountry,
    sellers,
    totalMinor,
    quoteRequired,
  };

  return { ...unsigned, token: signQuote(unsigned, input.destinationPostcode) };
}

/**
 * The seller's warehouse the goods leave from, where there is one answer.
 *
 * The location holding stock of every offer in the basket, else the one
 * holding the most. Null when the seller keeps no stock record here, and then
 * only an L1 price for "any warehouse" matches.
 */
async function dispatchLocationFor(sellerAccountId: string, offerIds: readonly string[]): Promise<string | null> {
  const stock = await prisma.sellerInventory.findMany({
    where: { sellerAccountId, offerId: { in: [...offerIds] }, availableQuantity: { gt: 0 }, location: { isOperational: true, archivedAt: null } },
    select: { locationId: true, offerId: true, availableQuantity: true },
  });
  if (stock.length === 0) return null;

  const byLocation = new Map<string, { offers: Set<string>; units: number }>();
  for (const row of stock) {
    const entry = byLocation.get(row.locationId) ?? { offers: new Set<string>(), units: 0 };
    entry.offers.add(row.offerId);
    entry.units += row.availableQuantity;
    byLocation.set(row.locationId, entry);
  }

  const ranked = [...byLocation.entries()].sort(
    (a, b) => b[1].offers.size - a[1].offers.size || b[1].units - a[1].units || (a[0] < b[0] ? -1 : 1),
  );
  return ranked[0]?.[0] ?? null;
}

function originLabel(
  level: LogisticsLevel,
  rate: { originLocation: { name: string } | null; originPortCode: string | null; destinationPortCode: string | null; destinationHubCode: string | null; destinationHubName: string | null },
): string {
  switch (level) {
    case 'L1':
      return rate.originLocation?.name ?? 'Seller warehouse';
    case 'L2':
      return rate.originPortCode ?? 'Port of loading';
    case 'L3':
      return rate.destinationPortCode ?? 'Destination port';
    case 'L4':
      return rate.destinationHubName ?? rate.destinationHubCode ?? 'Destination warehouse';
  }
}

function destinationLabel(
  level: LogisticsLevel,
  rate: { originPortCode: string | null; destinationPortCode: string | null; destinationHubCode: string | null; destinationHubName: string | null },
  country: string,
): string {
  switch (level) {
    case 'L1':
      return rate.originPortCode ?? 'Port of loading';
    case 'L2':
      return rate.destinationPortCode ?? 'Destination port';
    case 'L3':
      return rate.destinationHubName ?? rate.destinationHubCode ?? 'Destination warehouse';
    case 'L4':
      return `Delivery address (${country})`;
  }
}

/**
 * A level's price in the buyer's currency.
 *
 * The same rate feed and freshness rules as a converted product price
 * (`resolveDerivation`), with EXACT rounding: a freight charge is a cost
 * passed through, not a shelf price to be made to end in 99. Null when the
 * currencies differ and no usable rate exists - the level is then not priced,
 * rather than priced in a currency the buyer is not paying in.
 */
async function convertForBuyer(
  amountMinor: Minor,
  from: string,
  to: string,
  purpose: FxPurpose,
): Promise<{ amountMinor: Minor; rate: string | null; provider: string | null; asOf: Date | null } | null> {
  if (from.toUpperCase() === to.toUpperCase()) {
    return { amountMinor, rate: null, provider: null, asOf: null };
  }

  const derivation = await resolveDerivation(to, from, purpose);
  if (!derivation.ok) return null;

  const context = derivation.context;
  return {
    amountMinor: convert(
      amountMinor,
      conversionFor({ sourceCurrency: from, targetCurrency: to, rate: context.rate.rate, rounding: 'exact' }),
    ),
    rate: context.rate.rate,
    provider: context.rate.provider,
    asOf: context.rate.asOf,
  };
}

// --- The signature -----------------------------------------------------------

function signingKey(): string {
  // Domain-separated from the cookie signature it is derived from, so a value
  // valid as one can never be replayed as the other.
  return `${env.SESSION_COOKIE_SECRET}:logistics-delivery-quote:${DELIVERY_QUOTE_VERSION}`;
}

function canonical(quote: Omit<DeliveryQuote, 'token'>, postcode: string | null): string {
  return JSON.stringify({
    v: quote.version,
    c: quote.currency,
    d: quote.destinationCountry,
    p: (postcode ?? '').replace(/\s+/g, '').toUpperCase(),
    s: quote.sellers.map((seller) => ({
      id: seller.sellerAccountId,
      pv: seller.policyVersionId,
      st: seller.status,
      l: seller.levels.map((level) => ({
        l: level.level,
        o: level.owner,
        r: level.leg?.rateId ?? null,
        a: level.leg?.amountMinor.toString() ?? null,
      })),
    })),
    t: quote.totalMinor.toString(),
  });
}

function signQuote(quote: Omit<DeliveryQuote, 'token'>, postcode: string | null): string {
  return createHmac('sha256', signingKey()).update(canonical(quote, postcode)).digest('base64url');
}

/** Whether a token a client carried is the one this quote would be issued. */
export function tokenMatches(quote: DeliveryQuote, token: string): boolean {
  return safeCompare(quote.token, token);
}

/** The whole quote for the wire. Money as strings, never numbers. */
export function serialiseDeliveryQuote(quote: DeliveryQuote, options: { showLevels: boolean }) {
  return {
    version: quote.version,
    currency: quote.currency,
    total: quote.totalMinor.toString(),
    quoteRequired: quote.quoteRequired,
    token: quote.token,
    showLevels: options.showLevels,
    sellers: quote.sellers.map((seller) => ({
      sellerAccountId: seller.sellerAccountId,
      sellerName: seller.sellerName,
      status: seller.status,
      policyVersionNumber: seller.policyVersionNumber,
      total: seller.totalMinor === null ? null : seller.totalMinor.toString(),
      // The per-level figures are always computed and always kept; whether a
      // buyer SEES them is the operator's presentation choice.
      levels: seller.levels.map((level) => ({
        level: level.level,
        owner: level.owner,
        reason: level.reason,
        amount: level.leg === null ? null : options.showLevels ? level.leg.amountMinor.toString() : null,
        isFree: level.leg?.isFree ?? false,
        transportMode: options.showLevels ? (level.leg?.transportMode ?? null) : null,
        carrier: options.showLevels ? (level.leg?.providerLabel ?? level.leg?.provider ?? null) : null,
        origin: options.showLevels ? (level.leg?.originLabel ?? null) : null,
        destination: options.showLevels ? (level.leg?.destinationLabel ?? null) : null,
        transitDaysMin: level.leg?.transitDaysMin ?? null,
        transitDaysMax: level.leg?.transitDaysMax ?? null,
      })),
    })),
  };
}

export type SerialisedDeliveryQuote = ReturnType<typeof serialiseDeliveryQuote>;

/** Whether the buyer is shown each level, or one delivery line. */
export async function showLevelBreakdown(): Promise<boolean> {
  const profile = await prisma.businessProfile.findFirst({ select: { showLogisticsLevelBreakdown: true } });
  return profile?.showLogisticsLevelBreakdown ?? true;
}
