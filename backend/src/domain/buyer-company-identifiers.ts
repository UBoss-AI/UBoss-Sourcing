/**
 * Tax, trade and registration identifiers for buyer companies, by country.
 *
 * Offline checks only: shape, and the published check digit where the issuing
 * authority defines one. A number that passes here is well-formed, not real -
 * whether it belongs to a live company is the registry's answer, asked by
 * `modules/buyer-companies/providers/`, and failing to reach the registry is
 * never treated as the number being wrong.
 *
 * Three markets are written out in detail because the product is sold into
 * them (India, Poland, the rest of the EU). Everywhere else gets a local
 * registration number and one TIN/VAT/GST-equivalent, both loosely shaped,
 * because a rule we have not verified for a jurisdiction is worse than no
 * rule: it refuses real companies.
 *
 * NOTHING HERE IS UNIVERSALLY MANDATORY WHEN THE LAW SAYS IT IS NOT. A small
 * Indian business below the GST threshold has no GSTIN; a Polish sole trader
 * under the VAT exemption limit has no active EU VAT number. Each such scheme
 * offers "not registered / not applicable" with a reason code, and that
 * declaration is an answer, not a gap.
 */
import { checkGstin } from './gst.js';

export type BuyerCompanyEntityTypeName =
  | 'SOLE_PROPRIETORSHIP'
  | 'PARTNERSHIP'
  | 'LIMITED_LIABILITY_PARTNERSHIP'
  | 'PRIVATE_LIMITED_COMPANY'
  | 'PUBLIC_LIMITED_COMPANY'
  | 'COOPERATIVE'
  | 'NON_PROFIT'
  | 'PUBLIC_BODY'
  | 'OTHER';

export const BuyerCompanyEntityTypeValues: readonly BuyerCompanyEntityTypeName[] = Object.freeze([
  'SOLE_PROPRIETORSHIP',
  'PARTNERSHIP',
  'LIMITED_LIABILITY_PARTNERSHIP',
  'PRIVATE_LIMITED_COMPANY',
  'PUBLIC_LIMITED_COMPANY',
  'COOPERATIVE',
  'NON_PROFIT',
  'PUBLIC_BODY',
  'OTHER',
]);

/** Member states of the EU, as ISO-3166 alpha-2. */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
]);

export function isEuCountry(country: string | null | undefined): boolean {
  return EU_COUNTRIES.has((country ?? '').toUpperCase());
}

/** Every scheme a company may declare. Stored in `buyer_company_identifiers.scheme`. */
export const IdentifierScheme = {
  IN_PAN: 'IN_PAN',
  IN_GSTIN: 'IN_GSTIN',
  IN_UDYAM: 'IN_UDYAM',
  IN_IEC: 'IN_IEC',
  PL_NIP: 'PL_NIP',
  PL_REGON: 'PL_REGON',
  EU_VAT: 'EU_VAT',
  EORI: 'EORI',
  TAX_ID: 'TAX_ID',
  LEI: 'LEI',
} as const;

export type IdentifierSchemeName = (typeof IdentifierScheme)[keyof typeof IdentifierScheme];

export const IDENTIFIER_SCHEMES: readonly IdentifierSchemeName[] = Object.freeze(
  Object.values(IdentifierScheme),
);

/** Why a scheme was declared not applicable. Shown to reviewers; codes only. */
export const NOT_APPLICABLE_REASONS = [
  /** Not registered for this tax at all. */
  'NOT_REGISTERED',
  /** Registered, but exempt (e.g. the Polish VAT small-business exemption). */
  'EXEMPT',
  /** Below the registration threshold. */
  'BELOW_THRESHOLD',
  /** This identifier does not exist for this legal form. */
  'NOT_ISSUED_FOR_ENTITY',
] as const;

export type NotApplicableReason = (typeof NOT_APPLICABLE_REASONS)[number];

/** Upper case, and every separator people paste off a letterhead removed. */
export function normaliseIdentifier(raw: string): string {
  return raw.toUpperCase().replace(/[\s.\-/_]/g, '');
}

// ---------------------------------------------------------------------------
// Check digits
// ---------------------------------------------------------------------------

/** Polish NIP: weights 6,5,7,2,3,4,5,6,7, mod 11, a remainder of 10 is invalid. */
export function isValidNip(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(value[index]), 0);
  const check = sum % 11;
  return check !== 10 && check === Number(value[9]);
}

/** Polish REGON, 9 or 14 digits, each with its own weights; mod 11, 10 -> 0. */
export function isValidRegon(value: string): boolean {
  const weights =
    value.length === 9
      ? [8, 9, 2, 3, 4, 5, 6, 7]
      : value.length === 14
        ? [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8]
        : null;
  if (weights === null || !/^\d+$/.test(value)) return false;
  const sum = weights.reduce((total, weight, index) => total + weight * Number(value[index]), 0);
  const check = sum % 11 === 10 ? 0 : sum % 11;
  return check === Number(value[value.length - 1]);
}

/** ISO 17442 LEI: 20 characters, ISO 7064 mod 97-10 over the whole string. */
export function isValidLei(value: string): boolean {
  if (!/^[A-Z0-9]{18}\d{2}$/.test(value)) return false;
  let remainder = 0;
  for (const char of value) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

// ---------------------------------------------------------------------------
// Per-scheme shape
// ---------------------------------------------------------------------------

/** Null when the value is acceptable for the scheme, otherwise a problem code. */
export function identifierProblem(
  scheme: IdentifierSchemeName,
  normalised: string,
  registrationCountry: string | null,
): string | null {
  switch (scheme) {
    case 'IN_PAN':
      // Five letters, four digits, a letter. The fourth letter is the holder's
      // kind (C company, F firm or LLP, P person ...), checked separately.
      return /^[A-Z]{5}\d{4}[A-Z]$/.test(normalised) ? null : 'PAN_FORMAT';
    case 'IN_GSTIN': {
      const problem = checkGstin(normalised);
      return problem === null ? null : `GSTIN_${problem}`;
    }
    case 'IN_UDYAM':
      return /^UDYAM[A-Z]{2}\d{9}$/.test(normalised) ? null : 'UDYAM_FORMAT';
    case 'IN_IEC':
      return /^[A-Z0-9]{10}$/.test(normalised) ? null : 'IEC_FORMAT';
    case 'PL_NIP':
      return isValidNip(normalised) ? null : 'NIP_CHECKSUM';
    case 'PL_REGON':
      return isValidRegon(normalised) ? null : 'REGON_CHECKSUM';
    case 'EU_VAT': {
      const match = /^([A-Z]{2})([0-9A-Z]{2,13})$/.exec(normalised);
      if (match === null) return 'VAT_FORMAT';
      const prefix = match[1] === 'EL' ? 'GR' : (match[1] ?? '');
      if (!EU_COUNTRIES.has(prefix)) return 'VAT_PREFIX';
      if (registrationCountry !== null && prefix !== registrationCountry) return 'VAT_COUNTRY';
      if (prefix === 'PL' && !isValidNip(match[2] ?? '')) return 'NIP_CHECKSUM';
      return null;
    }
    case 'EORI':
      return /^[A-Z]{2}[A-Z0-9]{1,15}$/.test(normalised) ? null : 'EORI_FORMAT';
    case 'LEI':
      return isValidLei(normalised) ? null : 'LEI_CHECKSUM';
    case 'TAX_ID':
      return /^[A-Z0-9]{3,40}$/.test(normalised) ? null : 'TAX_ID_FORMAT';
  }
}

// ---------------------------------------------------------------------------
// The registration number
// ---------------------------------------------------------------------------

/** Which register the registration number belongs to, for this country and form. */
export type RegistrationRegister =
  /** India, Ministry of Corporate Affairs: Corporate Identity Number. */
  | 'IN_CIN'
  /** India, Ministry of Corporate Affairs: LLP Identification Number. */
  | 'IN_LLPIN'
  /** Poland, National Court Register. */
  | 'PL_KRS'
  /** Poland, Central Register of Business Activity - sole traders, identified by NIP. */
  | 'PL_CEIDG'
  /** Anything else: the local company register, loosely shaped. */
  | 'LOCAL';

export function registrationRegisterFor(
  country: string | null,
  entityType: BuyerCompanyEntityTypeName | null,
): RegistrationRegister {
  if (country === 'IN') {
    if (entityType === 'LIMITED_LIABILITY_PARTNERSHIP') return 'IN_LLPIN';
    if (entityType === 'PRIVATE_LIMITED_COMPANY' || entityType === 'PUBLIC_LIMITED_COMPANY') {
      return 'IN_CIN';
    }
    // Proprietorships and ordinary partnerships are not registered with MCA;
    // they identify themselves by the local registration they hold.
    return 'LOCAL';
  }

  if (country === 'PL') {
    // A sole trader is in CEIDG, not KRS, and is identified there by NIP.
    // Every other form a buyer is likely to be (sp. z o.o., S.A., sp.k., sp.j.,
    // spółdzielnia, fundacja, stowarzyszenie) is entered in KRS.
    return entityType === 'SOLE_PROPRIETORSHIP' ? 'PL_CEIDG' : 'PL_KRS';
  }

  return 'LOCAL';
}

/** Null when the registration number fits its register, otherwise a problem code. */
export function registrationNumberProblem(
  register: RegistrationRegister,
  normalised: string,
): string | null {
  switch (register) {
    case 'IN_CIN':
      // L/U, industry code, state, year, class, serial - 21 characters.
      return /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/.test(normalised) ? null : 'CIN_FORMAT';
    case 'IN_LLPIN':
      return /^[A-Z]{3}\d{4}$/.test(normalised) ? null : 'LLPIN_FORMAT';
    case 'PL_KRS':
      return /^\d{10}$/.test(normalised) ? null : 'KRS_FORMAT';
    case 'PL_CEIDG':
      return isValidNip(normalised) ? null : 'NIP_CHECKSUM';
    case 'LOCAL':
      return /^[A-Z0-9]{2,40}$/.test(normalised) ? null : 'REGISTRATION_FORMAT';
  }
}

// ---------------------------------------------------------------------------
// Which identifiers a company is asked for
// ---------------------------------------------------------------------------

export interface IdentifierRequirement {
  scheme: IdentifierSchemeName;
  /** Must be given (a value), with no "not applicable" option. */
  required: boolean;
  /** "Not registered / not applicable" may be declared instead of a value. */
  allowNotApplicable: boolean;
}

/**
 * The identifiers the wizard shows for a country and legal form.
 *
 * Required means the law issues it to every business of that kind:
 *   - India: every company and LLP has its own PAN. A proprietor's PAN is a
 *     PERSONAL number, so for proprietorships and partnerships it is optional
 *     rather than demanded - data minimisation over completeness.
 *   - Poland: every business has a NIP and a REGON.
 * Everything else is optional or may be declared not applicable.
 */
export function identifierRequirementsFor(
  country: string | null,
  entityType: BuyerCompanyEntityTypeName | null,
): IdentifierRequirement[] {
  const lei: IdentifierRequirement = { scheme: 'LEI', required: false, allowNotApplicable: false };

  if (country === 'IN') {
    const entityPan =
      entityType === 'PRIVATE_LIMITED_COMPANY' ||
      entityType === 'PUBLIC_LIMITED_COMPANY' ||
      entityType === 'LIMITED_LIABILITY_PARTNERSHIP';
    return [
      { scheme: 'IN_PAN', required: entityPan, allowNotApplicable: false },
      { scheme: 'IN_GSTIN', required: false, allowNotApplicable: true },
      { scheme: 'IN_UDYAM', required: false, allowNotApplicable: false },
      { scheme: 'IN_IEC', required: false, allowNotApplicable: false },
      lei,
    ];
  }

  if (country === 'PL') {
    return [
      { scheme: 'PL_NIP', required: true, allowNotApplicable: false },
      { scheme: 'PL_REGON', required: true, allowNotApplicable: false },
      { scheme: 'EU_VAT', required: false, allowNotApplicable: true },
      { scheme: 'EORI', required: false, allowNotApplicable: false },
      lei,
    ];
  }

  if (isEuCountry(country)) {
    return [
      { scheme: 'EU_VAT', required: false, allowNotApplicable: true },
      { scheme: 'EORI', required: false, allowNotApplicable: false },
      lei,
    ];
  }

  return [{ scheme: 'TAX_ID', required: false, allowNotApplicable: true }, lei];
}

// ---------------------------------------------------------------------------
// Consistency between identifiers
// ---------------------------------------------------------------------------

export interface IdentifierInconsistency {
  code: string;
  schemes: string[];
}

/**
 * Identifiers that contradict each other. Reviewer signals, not refusals -
 * each one has innocent explanations (a GSTIN issued to a different PAN of the
 * same group), and a reviewer is the right person to decide.
 */
export function identifierInconsistencies(input: {
  registrationCountry: string | null;
  entityType: BuyerCompanyEntityTypeName | null;
  registrationNumber: string | null;
  identifiers: ReadonlyMap<string, string>;
}): IdentifierInconsistency[] {
  const found: IdentifierInconsistency[] = [];
  const pan = input.identifiers.get('IN_PAN');
  const gstin = input.identifiers.get('IN_GSTIN');
  const nip = input.identifiers.get('PL_NIP');
  const vat = input.identifiers.get('EU_VAT');

  // Characters 3-12 of a GSTIN are the holder's PAN.
  if (pan !== undefined && gstin !== undefined && gstin.slice(2, 12) !== pan) {
    found.push({ code: 'GSTIN_PAN_MISMATCH', schemes: ['IN_GSTIN', 'IN_PAN'] });
  }

  // The fourth character of a PAN says what kind of holder it belongs to.
  if (pan !== undefined) {
    const holder = pan.charAt(3);
    const expected =
      input.entityType === 'PRIVATE_LIMITED_COMPANY' ||
      input.entityType === 'PUBLIC_LIMITED_COMPANY'
        ? 'C'
        : input.entityType === 'LIMITED_LIABILITY_PARTNERSHIP' || input.entityType === 'PARTNERSHIP'
          ? 'F'
          : null;
    if (expected !== null && holder !== expected) {
      found.push({ code: 'PAN_HOLDER_TYPE_MISMATCH', schemes: ['IN_PAN'] });
    }
  }

  // A Polish VAT number is "PL" followed by the NIP.
  if (nip !== undefined && vat !== undefined && vat.startsWith('PL') && vat.slice(2) !== nip) {
    found.push({ code: 'VAT_NIP_MISMATCH', schemes: ['EU_VAT', 'PL_NIP'] });
  }

  // A Polish sole trader's registration number IS their NIP.
  if (
    input.registrationCountry === 'PL' &&
    input.entityType === 'SOLE_PROPRIETORSHIP' &&
    nip !== undefined &&
    input.registrationNumber !== null &&
    input.registrationNumber !== nip
  ) {
    found.push({ code: 'CEIDG_NIP_MISMATCH', schemes: ['PL_NIP'] });
  }

  return found;
}
