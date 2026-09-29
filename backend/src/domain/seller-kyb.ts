/**
 * Know-your-business rules for a seller application: what a seller must tell
 * the marketplace about who it is, who owns it and what it will sell, and what
 * is still missing.
 *
 * Pure functions, no database. The service reads the rows and passes the
 * facts in; the onboarding checklist, the submit gate and the reviewer's
 * screen all ask this one file, so "what is missing" is said in the same
 * words everywhere.
 *
 * The identifier checks are the buyer-company ones (`buyer-company-
 * identifiers.ts`) reused, not a second copy: a CIN is the same 21 characters
 * whether the company is buying or selling.
 *
 * WHAT THIS DOES NOT DO. It checks that a number is well formed and that the
 * answers hang together. It does not check that the business exists - no
 * registry is asked. That is the reviewer's job, on the documents, and the
 * reviewer's screen says so.
 */
import {
  identifierInconsistencies,
  identifierProblem,
  normaliseIdentifier,
  registrationNumberProblem,
  registrationRegisterFor,
  type RegistrationRegister,
} from './buyer-company-identifiers.js';
import { checkGstin } from './gst.js';

export const SELLER_LEGAL_FORMS = [
  'SOLE_PROPRIETORSHIP',
  'PARTNERSHIP',
  'LIMITED_LIABILITY_PARTNERSHIP',
  'PRIVATE_LIMITED_COMPANY',
  'PUBLIC_LIMITED_COMPANY',
  'OTHER',
] as const;

export type SellerLegalFormName = (typeof SELLER_LEGAL_FORMS)[number];

/** Beneficial owners one application may list. More is a group chart, not a form. */
export const MAX_BENEFICIAL_OWNERS = 20;
/** Categories one application may name. */
export const MAX_INTENDED_CATEGORIES = 50;
/** Export markets one application may name. */
export const MAX_EXPORT_MARKETS = 100;
/** 100.00%, in basis points. */
export const FULL_OWNERSHIP_BASIS_POINTS = 10_000;

/** One thing the application still needs, in words the seller can act on. */
export interface KybGap {
  /** Stable, for the interface to translate. */
  code:
    | 'LEGAL_FORM_MISSING'
    | 'REGISTRATION_NUMBER_REQUIRED'
    | 'REGISTRATION_NUMBER_FORMAT'
    | 'TAX_NUMBER_INVALID'
    | 'BENEFICIAL_OWNER_REQUIRED'
    | 'OWNERSHIP_OVER_100'
    | 'EXPORT_MARKETS_REQUIRED';
  /** English, for the checklist message the backend writes. */
  label: string;
}

export interface KybFacts {
  registrationCountry: string;
  legalForm: SellerLegalFormName | null;
  companyRegistrationNumber: string | null;
  taxRegistrationNumber: string | null;
  exportCapable: boolean;
  exportMarkets: readonly string[];
  owners: readonly { ownershipBasisPoints: number }[];
}

export interface KybPolicy {
  /** SELLER_REQUIRE_BENEFICIAL_OWNERS. */
  beneficialOwnersRequired: boolean;
}

/**
 * Which register the registration number belongs to.
 *
 * India only has a named register, because only India's is written out in
 * `buyer-company-identifiers.ts`; everywhere else the country's own requirement
 * row decides the format, and this answers `LOCAL`.
 */
export function sellerRegistrationRegister(
  country: string,
  legalForm: SellerLegalFormName | null,
): RegistrationRegister {
  const register = registrationRegisterFor(country.toUpperCase(), legalForm);
  // Poland's KRS/CEIDG rule is written for buyer companies with Polish
  // identifiers the seller application does not ask for; a seller there is
  // judged by its requirement rows, like every other non-India country.
  return register === 'IN_CIN' || register === 'IN_LLPIN' ? register : 'LOCAL';
}

/**
 * The GSTIN's own problem, or null.
 *
 * India only: a Goods and Services Tax number carries a check character, and
 * a number that fails it is a typo, not a registration. Everywhere else the
 * requirement row's pattern is the whole check.
 */
export function taxNumberProblem(country: string, value: string | null): string | null {
  if (country.toUpperCase() !== 'IN') return null;
  const text = (value ?? '').trim();
  if (text.length === 0) return null;
  const problem = checkGstin(text);
  return problem === null ? null : `GSTIN_${problem}`;
}

/** Udyam, stored the way the certificate prints it: UDYAM-XX-00-0000000. */
export function canonicalUdyam(raw: string): string | null {
  const normalised = normaliseIdentifier(raw);
  if (identifierProblem('IN_UDYAM', normalised, 'IN') !== null) return null;
  return `UDYAM-${normalised.slice(5, 7)}-${normalised.slice(7, 9)}-${normalised.slice(9)}`;
}

/** IEC, ten characters, upper case. */
export function canonicalIec(raw: string): string | null {
  const normalised = normaliseIdentifier(raw);
  return identifierProblem('IN_IEC', normalised, 'IN') === null ? normalised : null;
}

/** Total declared ownership, in basis points. */
export function totalOwnership(owners: readonly { ownershipBasisPoints: number }[]): number {
  return owners.reduce((sum, owner) => sum + owner.ownershipBasisPoints, 0);
}

/**
 * What the ownership-and-registrations part of the application is still
 * waiting for. Empty means nothing.
 */
export function kybGaps(facts: KybFacts, policy: KybPolicy): KybGap[] {
  const gaps: KybGap[] = [];
  const country = facts.registrationCountry.toUpperCase();

  if (facts.legalForm === null) {
    gaps.push({ code: 'LEGAL_FORM_MISSING', label: 'Your legal form' });
  }

  const register = sellerRegistrationRegister(country, facts.legalForm);
  if (register !== 'LOCAL') {
    const name = register === 'IN_CIN' ? 'CIN' : 'LLPIN';
    const number = (facts.companyRegistrationNumber ?? '').trim();
    if (number.length === 0) {
      gaps.push({ code: 'REGISTRATION_NUMBER_REQUIRED', label: `Your ${name}` });
    } else if (registrationNumberProblem(register, normaliseIdentifier(number)) !== null) {
      gaps.push({ code: 'REGISTRATION_NUMBER_FORMAT', label: `A ${name} in the right format` });
    }
  }

  if (taxNumberProblem(country, facts.taxRegistrationNumber) !== null) {
    gaps.push({
      code: 'TAX_NUMBER_INVALID',
      label: 'A GSTIN whose check character matches',
    });
  }

  if (policy.beneficialOwnersRequired && facts.owners.length === 0) {
    gaps.push({
      code: 'BENEFICIAL_OWNER_REQUIRED',
      label: 'At least one person who owns or controls the business',
    });
  }

  if (totalOwnership(facts.owners) > FULL_OWNERSHIP_BASIS_POINTS) {
    gaps.push({ code: 'OWNERSHIP_OVER_100', label: 'Ownership that adds up to 100% or less' });
  }

  if (facts.exportCapable && facts.exportMarkets.length === 0) {
    gaps.push({ code: 'EXPORT_MARKETS_REQUIRED', label: 'The countries you already export to' });
  }

  return gaps;
}

/**
 * Identifiers that contradict each other, for the reviewer. Signals, never
 * refusals: a GSTIN issued under a group company's PAN has an innocent
 * explanation, and a person is the right one to decide.
 */
export function kybSignals(input: {
  registrationCountry: string;
  legalForm: SellerLegalFormName | null;
  companyRegistrationNumber: string | null;
  taxRegistrationNumber: string | null;
  panNumber: string | null;
}): string[] {
  if (input.registrationCountry.toUpperCase() !== 'IN') return [];

  const identifiers = new Map<string, string>();
  const pan = normaliseIdentifier(input.panNumber ?? '');
  const gstin = normaliseIdentifier(input.taxRegistrationNumber ?? '');
  if (pan.length > 0) identifiers.set('IN_PAN', pan);
  if (gstin.length > 0) identifiers.set('IN_GSTIN', gstin);

  return identifierInconsistencies({
    registrationCountry: 'IN',
    entityType: input.legalForm,
    registrationNumber: input.companyRegistrationNumber,
    identifiers,
  }).map((signal) => signal.code);
}
