/**
 * The "Ownership, registrations and exports" section of the seller
 * application: its types, its two calls, and the percentage arithmetic.
 *
 * Ownership crosses the wire as basis points (2500 = 25.00%), an integer, so
 * "33.33" typed three times adds up the same on the server as it does here.
 * The conversion below is string arithmetic, never a float multiplication.
 */
import { api } from './api';

export const SELLER_LEGAL_FORMS = [
  'SOLE_PROPRIETORSHIP',
  'PARTNERSHIP',
  'LIMITED_LIABILITY_PARTNERSHIP',
  'PRIVATE_LIMITED_COMPANY',
  'PUBLIC_LIMITED_COMPANY',
  'OTHER',
] as const;

export type SellerLegalForm = (typeof SELLER_LEGAL_FORMS)[number];

export interface KybOwner {
  /** Present for a person already on the application, so they are changed in place. */
  id?: string | null;
  fullName: string;
  nationality: string | null;
  ownershipBasisPoints: number;
  role: string | null;
  isControllingPerson: boolean;
  isPoliticallyExposed: boolean;
}

export interface KybGap {
  code:
    | 'LEGAL_FORM_MISSING'
    | 'REGISTRATION_NUMBER_REQUIRED'
    | 'REGISTRATION_NUMBER_FORMAT'
    | 'TAX_NUMBER_INVALID'
    | 'BENEFICIAL_OWNER_REQUIRED'
    | 'OWNERSHIP_OVER_100'
    | 'EXPORT_MARKETS_REQUIRED';
  label: string;
}

export interface KybView {
  isEditable: boolean;
  isIndia: boolean;
  policy: { beneficialOwnersRequired: boolean };
  registrationNumberName: 'CIN' | 'LLPIN' | null;
  legalForm: SellerLegalForm | null;
  udyamNumber: string | null;
  iecNumber: string | null;
  exportCapable: boolean;
  exportMarkets: string[];
  yearsExporting: number | null;
  intendedCategories: { id: string; name: string }[];
  beneficialOwners: (KybOwner & { id: string })[];
  ownershipTotalBasisPoints: number;
  outstanding: KybGap[];
}

export interface KybInput {
  legalForm: SellerLegalForm | null;
  udyamNumber: string | null;
  iecNumber: string | null;
  exportCapable: boolean;
  exportMarkets: string[];
  yearsExporting: number | null;
  intendedCategoryIds: string[];
  beneficialOwners: KybOwner[];
}

export function fetchKyb(): Promise<KybView> {
  return api.get<KybView>('/seller/kyb');
}

export function saveKyb(input: KybInput): Promise<KybView> {
  return api.put<KybView>('/seller/kyb', input);
}

/**
 * "25", "25.5" or "25.50" to 2550. Null for anything that is not a percentage
 * from 0 to 100 with at most two decimals.
 */
export function percentToBasisPoints(text: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const points = whole * 100 + fraction;
  return points > 10_000 ? null : points;
}

/** 2550 to "25.5". */
export function basisPointsToPercent(points: number): string {
  const whole = Math.floor(points / 100);
  const fraction = points % 100;
  if (fraction === 0) return String(whole);
  return `${String(whole)}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}
