/**
 * What one piece costs at each quantity and in each way of buying it - the
 * numbers behind the product page's bulk-savings popover.
 *
 * Every figure comes from the functions that price the basket:
 * `priceForQuantity` for loose pieces and the seller's own package prices for
 * cartons, pallets and containers. Nothing here is a second pricing engine; it
 * only asks the same questions for several quantities at once. A conversion to
 * the viewer's currency is labelled approximate and carries its rate set, and
 * is never used to charge anything.
 */
import {
  ladderFor,
  nextSaving,
  priceForQuantity,
  savingBasisPoints,
  type TierBuyer,
} from '../../domain/quantity-tier.js';
import { bulkOffers, type BulkOffer } from '../../domain/bulk-offers.js';
import { serialiseMoney, type Minor } from '../../domain/money.js';
import { prisma } from '../../infra/prisma.js';
import { evaluateEligibility } from '../preorders/policy.service.js';
import { listBuyableOptions } from '../seller/packaging.service.js';
import { describeConversion, indicativeConversion } from './indicative-fx.service.js';
import { isBusinessBuyer } from './quantity-tier.service.js';

export interface BulkPricingInput {
  productId: string;
  variantId: string | null;
  offerId: string | null;
  /** Pieces the buyer is looking at. */
  quantity: number;
  displayCurrency: string | null;
  customerProfileId: string | null;
  now?: Date;
}

export async function bulkPricing(input: BulkPricingInput): Promise<Record<string, unknown>> {
  const now = input.now ?? new Date();
  const profile =
    input.customerProfileId === null
      ? null
      : await prisma.customerProfile.findUnique({
          where: { id: input.customerProfileId },
          select: {
            organization: true,
            preferredCountry: true,
            user: { select: { status: true } },
          },
        });
  const address =
    input.customerProfileId === null
      ? null
      : await prisma.address.findFirst({
          where: {
            customerProfileId: input.customerProfileId,
            archivedAt: null,
            isDefaultShipping: true,
          },
          select: { country: true, timezone: true },
        });
  const country = address?.country ?? profile?.preferredCountry ?? null;

  const eligibility = await evaluateEligibility({
    productId: input.productId,
    variantId: input.variantId,
    offerId: input.offerId,
    destinationCountry: country,
    timezone: address?.timezone ?? null,
    now,
  });
  const offer = eligibility.offer;
  if (offer === null || offer.status !== 'ACTIVE') return { available: false };

  const currency = offer.currency;
  const money = (minor: Minor) => serialiseMoney(minor, currency);
  const buyer: TierBuyer = {
    now,
    isBusinessBuyer: isBusinessBuyer(profile),
    country,
    channel: 'BASKET',
  };
  const list = offer.priceMinor;
  const quantity = Math.max(1, input.quantity);
  const current = priceForQuantity(list, offer.quantityTiers, quantity, buyer);
  const upcoming = nextSaving(list, offer.quantityTiers, quantity, buyer);

  // Bands this buyer could reach in the basket, and - shown separately - the
  // ones a seller keeps for preorders only.
  const ladder = ladderFor(offer.quantityTiers, buyer).map((tier) => ({
    minQuantity: tier.minQuantity,
    maxQuantity: tier.maxQuantity,
    unitPrice: money(tier.priceMinor),
    savingBasisPoints: savingBasisPoints(list, tier.priceMinor),
    businessBuyersOnly: tier.businessBuyersOnly,
    endsAt: tier.endsAt?.toISOString() ?? null,
  }));
  const preorderBands = ladderFor(offer.quantityTiers, {
    ...buyer,
    channel: 'PREORDER',
    isBusinessBuyer: true,
  })
    .filter((tier) => tier.preorderOnly)
    .map((tier) => ({
      minQuantity: tier.minQuantity,
      unitPrice: money(tier.priceMinor),
      savingBasisPoints: savingBasisPoints(list, tier.priceMinor),
    }));

  // Each way of buying it, priced per piece. A package price divides exactly
  // by what is in it (`validatePackagingOption`), so these are exact.
  // The operator's own product has no seller packaging to price.
  const options = offer.id === null ? [] : await listBuyableOptions(offer.id);
  const units = [
    {
      unit: 'PIECE' as const,
      piecesPerUnit: 1,
      unitPrice: money(current.unitPriceMinor),
      perPiece: money(current.unitPriceMinor),
      savingBasisPoints: savingBasisPoints(list, current.unitPriceMinor),
      bestPerPiece: money(
        ladder.length === 0
          ? list
          : ladderFor(offer.quantityTiers, buyer).reduce(
              (low, tier) => (tier.priceMinor < low ? tier.priceMinor : low),
              list,
            ),
      ),
      wholeUnitsInStock: offer.availableQuantity,
      requiresFreightQuote: false,
    },
    ...options
      .filter((option) => option.currency === currency)
      .map((option) => {
        const perPiece = BigInt(option.effectiveUnitPriceMinor);
        const best = option.tiers.reduce((low, tier) => {
          const piece = BigInt(tier.pricePerPackageMinor) / BigInt(option.unitsPerPackage);
          return piece < low ? piece : low;
        }, perPiece);
        return {
          unit: option.packageType,
          piecesPerUnit: option.unitsPerPackage,
          unitPrice: money(BigInt(option.packagePriceMinor)),
          perPiece: money(perPiece),
          savingBasisPoints: savingBasisPoints(list, perPiece),
          bestPerPiece: money(best),
          wholeUnitsInStock: option.wholePackagesAvailable,
          requiresFreightQuote: option.requiresFreightQuote,
        };
      }),
  ];

  const conversion =
    input.displayCurrency === null || input.displayCurrency.toUpperCase() === currency
      ? null
      : await indicativeConversion(currency, input.displayCurrency);

  // Every reachable offer as a card, and the preorder-only ones beside them.
  // Same pricing functions as the basket; see domain/bulk-offers.ts.
  const offerCard = (offer: BulkOffer) => ({
    minQuantity: offer.minQuantity,
    maxQuantity: offer.maxQuantity,
    unitPrice: money(offer.unitPriceMinor),
    listUnitPrice: money(list),
    savingPerPiece: money(offer.savingPerPieceMinor),
    lineTotal: money(offer.lineTotalMinor),
    totalSaving: money(offer.totalSavingMinor),
    savingBasisPoints: offer.savingBasisPoints,
    businessBuyersOnly: offer.businessBuyersOnly,
    endsAt: offer.endsAt?.toISOString() ?? null,
    isCurrent: offer.isCurrent,
    isNext: offer.isNext,
    isBestValue: offer.isBestValue,
    withinStock: offer.withinStock,
    approximateUnitPrice:
      conversion === null
        ? null
        : serialiseMoney(conversion.convert(offer.unitPriceMinor), conversion.toCurrency),
  });
  const offers = bulkOffers({
    listPriceMinor: list,
    tiers: offer.quantityTiers,
    buyer,
    quantity,
    stock: offer.availableQuantity,
  }).map(offerCard);
  const preorderOffers = bulkOffers({
    listPriceMinor: list,
    tiers: offer.quantityTiers.filter((tier) => tier.preorderOnly),
    buyer: { ...buyer, channel: 'PREORDER', isBusinessBuyer: true },
    quantity,
    stock: 0,
  }).map(offerCard);

  return {
    available: true,
    offerId: offer.id,
    sellerName: offer.sellerDisplayName,
    currency,
    quantity,
    listUnitPrice: money(list),
    current: {
      unitPrice: money(current.unitPriceMinor),
      lineTotal: money(current.unitPriceMinor * BigInt(quantity)),
      savingBasisPoints: savingBasisPoints(list, current.unitPriceMinor),
      saving: money((list - current.unitPriceMinor) * BigInt(quantity)),
      tierMinQuantity: current.tier?.minQuantity ?? null,
    },
    next:
      upcoming === null
        ? null
        : {
            minQuantity: upcoming.tier.minQuantity,
            addQuantity: upcoming.addQuantity,
            unitPrice: money(upcoming.unitPriceMinor),
            savingPerPiece: money(upcoming.savingPerPieceMinor),
            savingBasisPoints: savingBasisPoints(list, upcoming.unitPriceMinor),
          },
    ladder,
    preorderBands,
    offers,
    preorderOffers,
    units,
    stockBaseUnits: offer.availableQuantity,
    exceedsStock: quantity > offer.availableQuantity,
    // Past the stock, the only honest way to buy that many is to ask the
    // seller to make it. Offered only when the seller takes preorders.
    preorderAvailable: eligibility.available,
    approximate:
      conversion === null
        ? null
        : {
            ...describeConversion(conversion),
            unitPrice: serialiseMoney(
              conversion.convert(current.unitPriceMinor),
              conversion.toCurrency,
            ),
            listUnitPrice: serialiseMoney(conversion.convert(list), conversion.toCurrency),
            nextUnitPrice:
              upcoming === null
                ? null
                : serialiseMoney(
                    conversion.convert(upcoming.unitPriceMinor),
                    conversion.toCurrency,
                  ),
          },
  };
}
