/**
 * The bulk-savings popover's figures, from `GET /catalog/bulk-pricing`.
 *
 * Every number is the server's, priced by the same function the basket uses,
 * so the saving the popover promises is the saving the checkout charges.
 * Savings arrive as whole basis points (800 = 8%) and amounts as minor-unit
 * strings; nothing here does arithmetic on money.
 */
import { api } from './api';
import type { Money } from './format';

export type BulkUnit = 'PIECE' | 'CARTON' | 'UK_PALLET' | 'US_PALLET' | 'CONTAINER';

export interface BulkBand {
  minQuantity: number;
  maxQuantity: number | null;
  unitPrice: Money;
  savingBasisPoints: number;
  businessBuyersOnly: boolean;
  endsAt: string | null;
}

/**
 * One bulk offer, as a card: buy this many, pay this much each. Every amount is
 * the server's, in the offer's currency; nothing here is worked out in the
 * browser.
 */
export interface BulkOfferCard {
  minQuantity: number;
  maxQuantity: number | null;
  unitPrice: Money;
  listUnitPrice: Money;
  savingPerPiece: Money;
  /** unit price x minimum quantity. */
  lineTotal: Money;
  /** saving per piece x minimum quantity. */
  totalSaving: Money;
  savingBasisPoints: number;
  businessBuyersOnly: boolean;
  endsAt: string | null;
  isCurrent: boolean;
  isNext: boolean;
  /** Strictly the cheapest per piece of two or more offers. Never guessed. */
  isBestValue: boolean;
  /** The minimum can be met from stock; past it the rest is a preorder. */
  withinStock: boolean;
  /** In the viewer's own currency, indicative only. */
  approximateUnitPrice: Money | null;
}

export interface BulkUnitOption {
  unit: BulkUnit;
  piecesPerUnit: number;
  unitPrice: Money;
  perPiece: Money;
  savingBasisPoints: number;
  bestPerPiece: Money;
  wholeUnitsInStock: number;
  requiresFreightQuote: boolean;
}

export type BulkPricing =
  | { available: false }
  | {
      available: true;
      offerId: string;
      sellerName: string;
      currency: string;
      quantity: number;
      listUnitPrice: Money;
      current: {
        unitPrice: Money;
        lineTotal: Money;
        savingBasisPoints: number;
        saving: Money;
        tierMinQuantity: number | null;
      };
      next: {
        minQuantity: number;
        addQuantity: number;
        unitPrice: Money;
        savingPerPiece: Money;
        savingBasisPoints: number;
      } | null;
      ladder: BulkBand[];
      preorderBands: { minQuantity: number; unitPrice: Money; savingBasisPoints: number }[];
      /** Every offer this buyer can reach, together. Empty when the seller set none. */
      offers: BulkOfferCard[];
      /** Bands the seller keeps for preorders only. */
      preorderOffers: BulkOfferCard[];
      units: BulkUnitOption[];
      stockBaseUnits: number;
      exceedsStock: boolean;
      preorderAvailable: boolean;
      approximate: {
        currency: string;
        rateAsOf: string;
        unitPrice: Money;
        listUnitPrice: Money;
        nextUnitPrice: Money | null;
      } | null;
    };

export function fetchBulkPricing(input: {
  productId: string;
  variantId: string | null;
  quantity: number;
  displayCurrency: string | null;
}): Promise<BulkPricing> {
  return api.get('/catalog/bulk-pricing', {
    query: {
      productId: input.productId,
      variantId: input.variantId ?? undefined,
      quantity: input.quantity,
      displayCurrency: input.displayCurrency ?? undefined,
    },
  });
}

/** 800 → "8%", 1250 → "12.5%". Display only; the figure itself is an integer. */
export function formatBasisPoints(basisPoints: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(
    basisPoints / 10_000,
  );
}

/** Whether there is anything worth saying: a saving now, one within reach, or a stock limit. */
export function hasSomethingToSay(pricing: BulkPricing): boolean {
  if (!pricing.available) return false;
  return (
    pricing.next !== null ||
    pricing.current.savingBasisPoints > 0 ||
    pricing.exceedsStock ||
    pricing.units.some((unit) => unit.unit !== 'PIECE' && unit.savingBasisPoints > 0)
  );
}

const DISMISSED_PREFIX = 'uboss.bulkSavings.dismissed:';

/** Dismissed for this product and version, for this browser session. */
export function isDismissed(productId: string, variantId: string | null): boolean {
  try {
    return (
      window.sessionStorage.getItem(`${DISMISSED_PREFIX}${productId}:${variantId ?? '-'}`) === '1'
    );
  } catch {
    return false;
  }
}

export function rememberDismissed(productId: string, variantId: string | null): void {
  try {
    window.sessionStorage.setItem(`${DISMISSED_PREFIX}${productId}:${variantId ?? '-'}`, '1');
  } catch {
    // A private window without storage: dismissed until the next render only.
  }
}
