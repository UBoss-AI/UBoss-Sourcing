/**
 * A seller's quantity price bands on one listing, for Seller Hub.
 *
 * The server validates the whole set (`domain/quantity-tier.ts`) and answers
 * each problem by band index and code; the editor translates those codes
 * rather than re-implementing the rules.
 */
import { api } from './api';
import type { Money } from './format';

export interface QuantityTierRow {
  id: string;
  minQuantity: number;
  maxQuantity: number | null;
  priceMinor: string;
  unitPrice: Money;
  savingBasisPoints: number;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  businessBuyersOnly: boolean;
  countryCodes: string[] | null;
  preorderOnly: boolean;
}

export interface QuantityTierSet {
  offerId: string;
  currency: string;
  listUnitPrice: Money;
  tiers: QuantityTierRow[];
}

export interface QuantityTierInput {
  minQuantity: number;
  maxQuantity: number | null;
  priceMinor: string;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  businessBuyersOnly: boolean;
  countryCodes: string[] | null;
  preorderOnly: boolean;
}

export function fetchQuantityTiers(offerId: string): Promise<QuantityTierSet> {
  return api.get(`/seller/offers/${offerId}/quantity-tiers`);
}

export function saveQuantityTiers(
  offerId: string,
  tiers: QuantityTierInput[],
): Promise<QuantityTierSet> {
  return api.put(`/seller/offers/${offerId}/quantity-tiers`, { tiers });
}
