/**
 * Quantity price bands as stored, turned into what `domain/quantity-tier.ts`
 * works on - and the one definition of "a business buyer" a band can ask for.
 */
import type { QuantityTier } from '../../domain/quantity-tier.js';

/** The columns a band is applied from. Select exactly this wherever bands are priced. */
export const TIER_SELECT = {
  id: true,
  minQuantity: true,
  maxQuantity: true,
  priceMinor: true,
  isActive: true,
  startsAt: true,
  endsAt: true,
  businessBuyersOnly: true,
  countryCodes: true,
  preorderOnly: true,
} as const;

export interface TierRow {
  id: string;
  minQuantity: number;
  maxQuantity: number | null;
  priceMinor: bigint;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  businessBuyersOnly: boolean;
  countryCodes: unknown;
  preorderOnly: boolean;
}

export function toQuantityTier(row: TierRow): QuantityTier {
  const codes = Array.isArray(row.countryCodes)
    ? row.countryCodes
        .filter((code): code is string => typeof code === 'string')
        .map((code) => code.toUpperCase())
    : null;
  return {
    id: row.id,
    minQuantity: row.minQuantity,
    maxQuantity: row.maxQuantity,
    priceMinor: row.priceMinor,
    isActive: row.isActive,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    businessBuyersOnly: row.businessBuyersOnly,
    countryCodes: codes,
    preorderOnly: row.preorderOnly,
  };
}

/**
 * A business buyer: an active account with a company name on its profile.
 * The same test a bulk preorder applies, so a band "for business accounts" and
 * the preorder form agree about who that is.
 */
export function isBusinessBuyer(
  profile: { organization: string | null; user: { status: string } } | null | undefined,
): boolean {
  return (
    profile !== null &&
    profile !== undefined &&
    profile.user.status === 'ACTIVE' &&
    (profile.organization ?? '').trim() !== ''
  );
}

/** What an order line freezes about the band that priced it. */
export interface QuantityTierSnapshot {
  tierId: string;
  /** A seller's own band, or the operator's store-wide quantity discount. */
  source: 'SELLER' | 'STORE';
  minQuantity: number;
  maxQuantity: number | null;
  listUnitPriceMinor: string;
  unitPriceMinor: string;
  businessBuyersOnly: boolean;
}

export function snapshotTier(
  tier: QuantityTier,
  listUnitPriceMinor: bigint,
  source: QuantityTierSnapshot['source'] = 'SELLER',
): QuantityTierSnapshot {
  return {
    tierId: tier.id,
    source,
    minQuantity: tier.minQuantity,
    maxQuantity: tier.maxQuantity,
    listUnitPriceMinor: listUnitPriceMinor.toString(),
    unitPriceMinor: tier.priceMinor.toString(),
    businessBuyersOnly: tier.businessBuyersOnly,
  };
}
