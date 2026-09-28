/**
 * What a buyer-company application must contain before it can be submitted,
 * and which documents it is asked for.
 *
 * DATA MINIMISATION IS THE DESIGN CONSTRAINT HERE, not an afterthought. This
 * is a buyer account. It is not a payment-services onboarding, and nothing is
 * collected because a payment processor would collect it:
 *
 *   - No beneficial-owner details, no date of birth, no identity document and
 *     no bank details by default. The two document kinds that touch a person
 *     (REPRESENTATIVE_IDENTITY, OWNERSHIP_DECLARATION) can only be uploaded
 *     when a reviewer has asked for them in writing - see
 *     `REVIEWER_REQUEST_ONLY_KINDS`.
 *   - A document is only asked for where no official register can answer the
 *     same question. A Polish company in KRS is not asked for its extract,
 *     because the register is read directly.
 *
 * Every document kind carries `purpose`: the reason shown to the applicant.
 */
import {
  identifierProblem,
  identifierRequirementsFor,
  normaliseIdentifier,
  registrationNumberProblem,
  registrationRegisterFor,
  type BuyerCompanyEntityTypeName,
  type IdentifierSchemeName,
} from './buyer-company-identifiers.js';

export type BuyerCompanyDocumentKindName =
  | 'CERTIFICATE_OF_INCORPORATION'
  | 'REGISTRY_EXTRACT'
  | 'TAX_REGISTRATION_CERTIFICATE'
  | 'PROOF_OF_REGISTERED_ADDRESS'
  | 'AUTHORIZATION_LETTER'
  | 'BUSINESS_LICENCE'
  | 'REPRESENTATIVE_IDENTITY'
  | 'OWNERSHIP_DECLARATION'
  | 'OTHER';

export const BuyerCompanyDocumentKindValues: readonly BuyerCompanyDocumentKindName[] =
  Object.freeze([
    'CERTIFICATE_OF_INCORPORATION',
    'REGISTRY_EXTRACT',
    'TAX_REGISTRATION_CERTIFICATE',
    'PROOF_OF_REGISTERED_ADDRESS',
    'AUTHORIZATION_LETTER',
    'BUSINESS_LICENCE',
    'REPRESENTATIVE_IDENTITY',
    'OWNERSHIP_DECLARATION',
    'OTHER',
  ]);

/**
 * Kinds that touch a natural person. Never requested by default, and refused
 * at upload unless an open reviewer request names the kind - so the only way
 * one of these reaches our storage is a person on our side deciding, in
 * writing, that this case needs it.
 */
export const REVIEWER_REQUEST_ONLY_KINDS: ReadonlySet<BuyerCompanyDocumentKindName> = new Set([
  'REPRESENTATIVE_IDENTITY',
  'OWNERSHIP_DECLARATION',
]);

export type DocumentPurpose =
  /** Proves the company exists as a legal entity. */
  | 'PROVES_EXISTENCE'
  /** Proves the tax registration we cannot check against a register. */
  | 'PROVES_TAX_REGISTRATION'
  /** Proves the registered address. */
  | 'PROVES_ADDRESS'
  /** Proves the applicant may act for the company. */
  | 'PROVES_AUTHORITY'
  /** A licence the company's trade needs, where it needs one. */
  | 'PROVES_LICENCE'
  /** Asked for by a reviewer for this case. */
  | 'REVIEWER_REQUESTED';

export interface DocumentRequirement {
  /** Any one of these kinds satisfies the requirement. */
  kinds: BuyerCompanyDocumentKindName[];
  required: boolean;
  purpose: DocumentPurpose;
}

export interface RequirementsInput {
  registrationCountry: string | null;
  entityType: BuyerCompanyEntityTypeName | null;
  /** Schemes the applicant gave a value for (not declared not-applicable). */
  providedSchemes: ReadonlySet<string>;
  /** How the applicant stands to the business, when they have said. */
  applicantRelationship?: ApplicantRelationship | null;
}

/**
 * How the person applying stands to the business.
 *
 * Asked because "I am authorised to act for this company" means something
 * different from a director than from an outside agent, and a reviewer
 * deciding whether to ask for proof of authority needs to know which it is.
 * A code rather than free text, so it can be shown in the reader's language
 * and counted, and so nothing personal ends up typed into it.
 */
export const APPLICANT_RELATIONSHIPS = [
  /** A director, officer or company secretary. Usually visible in the register. */
  'DIRECTOR_OR_OFFICER',
  /** The proprietor, a partner or a shareholder who runs it. */
  'OWNER_OR_PARTNER',
  /** Somebody employed by the company - typically in purchasing. */
  'EMPLOYEE',
  /** Somebody outside the company acting for it - an agency, an accountant. */
  'AUTHORISED_AGENT',
  'OTHER',
] as const;

export type ApplicantRelationship = (typeof APPLICANT_RELATIONSHIPS)[number];

export function isApplicantRelationship(value: unknown): value is ApplicantRelationship {
  return typeof value === 'string' && (APPLICANT_RELATIONSHIPS as readonly string[]).includes(value);
}

/**
 * The documents asked for up front.
 *
 * The reasoning, per market:
 *   - **Existence.** Required everywhere except a Polish KRS entity, whose
 *     current extract we read from the court register's own open API. A
 *     Polish sole trader IS asked: CEIDG's API needs a token most deployments
 *     will not have, so the document is what a reviewer checks against.
 *   - **Tax registration.** Only in India and only when a GSTIN is given:
 *     GSTN offers no public API a marketplace may call without a GSP
 *     contract, so the certificate is the evidence. An EU VAT number is
 *     checked in VIES instead, and no certificate is needed.
 *   - **Authority.** Optional at submission - many applicants are directors
 *     and the register shows it. A reviewer asks for it when they cannot see
 *     the applicant among the representatives. The one exception is an
 *     AUTHORISED_AGENT: somebody acting from outside the company will never
 *     appear in its register, so the letter is the only evidence there is.
 *   - **Registered address and licence.** Offered, never required. A register
 *     extract usually shows the address already, and which trades need a
 *     licence differs by country and category - a reviewer asks where it
 *     matters rather than every applicant being made to guess.
 */
export function documentRequirementsFor(input: RequirementsInput): DocumentRequirement[] {
  const register = registrationRegisterFor(input.registrationCountry, input.entityType);
  const requirements: DocumentRequirement[] = [];

  requirements.push({
    kinds: ['CERTIFICATE_OF_INCORPORATION', 'REGISTRY_EXTRACT'],
    required: register !== 'PL_KRS',
    purpose: 'PROVES_EXISTENCE',
  });

  if (input.registrationCountry === 'IN' && input.providedSchemes.has('IN_GSTIN')) {
    requirements.push({
      kinds: ['TAX_REGISTRATION_CERTIFICATE'],
      required: true,
      purpose: 'PROVES_TAX_REGISTRATION',
    });
  }

  requirements.push({
    kinds: ['AUTHORIZATION_LETTER'],
    required: input.applicantRelationship === 'AUTHORISED_AGENT',
    purpose: 'PROVES_AUTHORITY',
  });

  requirements.push({
    kinds: ['PROOF_OF_REGISTERED_ADDRESS'],
    required: false,
    purpose: 'PROVES_ADDRESS',
  });

  requirements.push({
    kinds: ['BUSINESS_LICENCE'],
    required: false,
    purpose: 'PROVES_LICENCE',
  });

  return requirements;
}

// ---------------------------------------------------------------------------
// The business email's domain
// ---------------------------------------------------------------------------

/**
 * Webmail providers. A business email here is not a reason to refuse - many
 * small businesses use one - but it is a reason for a reviewer to look for
 * other evidence, which is all `FREE_MAIL_PROVIDER` does.
 */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.co.uk',
  'ymail.com',
  'rocketmail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  't-online.de',
  'mail.ru',
  'yandex.com',
  'yandex.ru',
  'zoho.com',
  'tutanota.com',
  'rediffmail.com',
  'wp.pl',
  'o2.pl',
  'onet.pl',
  'interia.pl',
  'op.pl',
  'libero.it',
  'orange.fr',
  'laposte.net',
  'free.fr',
  'sfr.fr',
  'seznam.cz',
]);

export type DomainStatusName =
  'UNKNOWN' | 'FREE_MAIL_PROVIDER' | 'MATCHES_WEBSITE' | 'DIFFERS_FROM_WEBSITE' | 'NO_WEBSITE';

/** The domain part of an email address, lower-cased. */
export function emailDomain(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.length === 0 ? null : domain;
}

/** A website's host without `www.`, or null when it cannot be parsed. */
export function websiteHost(website: string | null): string | null {
  if (website === null || website.trim().length === 0) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * How the business email's domain relates to the website. "Matches" is a
 * suffix match either way round, so `sales@eu.acme.com` against `acme.com`
 * and `buyer@acme.com` against `shop.acme.com` both count.
 */
export function businessDomainStatus(
  email: string | null,
  website: string | null,
): DomainStatusName {
  const domain = emailDomain(email);
  if (domain === null) return 'UNKNOWN';
  if (FREE_MAIL_DOMAINS.has(domain)) return 'FREE_MAIL_PROVIDER';

  const host = websiteHost(website);
  if (host === null) return 'NO_WEBSITE';

  const related = domain === host || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`);
  return related ? 'MATCHES_WEBSITE' : 'DIFFERS_FROM_WEBSITE';
}

// ---------------------------------------------------------------------------
// Completeness at submission
// ---------------------------------------------------------------------------

/** Legal forms that have an incorporation date on a register. */
function hasIncorporationDate(entityType: BuyerCompanyEntityTypeName | null): boolean {
  return (
    entityType === 'PRIVATE_LIMITED_COMPANY' ||
    entityType === 'PUBLIC_LIMITED_COMPANY' ||
    entityType === 'LIMITED_LIABILITY_PARTNERSHIP' ||
    entityType === 'COOPERATIVE'
  );
}

export function incorporationDateRequired(entityType: BuyerCompanyEntityTypeName | null): boolean {
  return hasIncorporationDate(entityType);
}

export interface ApplicationSnapshot {
  legalName: string | null;
  entityType: BuyerCompanyEntityTypeName | null;
  registrationCountry: string | null;
  registrationNumber: string | null;
  incorporationDate: Date | null;
  industry: string | null;
  businessEmail: string | null;
  businessPhone: string | null;
  applicantJobTitle: string | null;
  applicantRelationship: string | null;
  applicantAuthorityConfirmed: boolean;
  addressKinds: ReadonlySet<string>;
  identifiers: ReadonlyArray<{
    scheme: string;
    value: string | null;
    notApplicable: boolean;
    notApplicableReason: string | null;
  }>;
  /** Kinds with at least one upload that is pending or accepted. */
  documentKinds: ReadonlySet<string>;
}

export interface CompletenessProblem {
  field: string;
  code: string;
}

/**
 * Everything that stops this application being submitted, or an empty list.
 *
 * The wizard calls the same function (through the API) to show what is
 * missing, so "why can't I submit?" and the refusal have one answer.
 */
export function completenessProblems(
  snapshot: ApplicationSnapshot,
  today: Date = new Date(),
): CompletenessProblem[] {
  const problems: CompletenessProblem[] = [];
  const missing = (field: string): void => {
    problems.push({ field, code: 'REQUIRED' });
  };

  if ((snapshot.legalName ?? '').trim().length === 0) missing('legalName');
  if (snapshot.entityType === null) missing('entityType');
  if (snapshot.registrationCountry === null) missing('registrationCountry');
  if ((snapshot.industry ?? '').length === 0) missing('industry');
  if ((snapshot.businessEmail ?? '').length === 0) missing('businessEmail');
  if ((snapshot.businessPhone ?? '').length === 0) missing('businessPhone');
  if ((snapshot.applicantJobTitle ?? '').trim().length === 0) missing('applicantJobTitle');
  if (!isApplicantRelationship(snapshot.applicantRelationship)) missing('applicantRelationship');
  if (!snapshot.applicantAuthorityConfirmed) missing('applicantAuthorityConfirmed');

  const register = registrationRegisterFor(snapshot.registrationCountry, snapshot.entityType);
  if ((snapshot.registrationNumber ?? '').length === 0) {
    missing('registrationNumber');
  } else {
    const problem = registrationNumberProblem(
      register,
      normaliseIdentifier(snapshot.registrationNumber ?? ''),
    );
    if (problem !== null) problems.push({ field: 'registrationNumber', code: problem });
  }

  if (hasIncorporationDate(snapshot.entityType)) {
    if (snapshot.incorporationDate === null) missing('incorporationDate');
  }
  if (
    snapshot.incorporationDate !== null &&
    snapshot.incorporationDate.getTime() > today.getTime()
  ) {
    problems.push({ field: 'incorporationDate', code: 'IN_FUTURE' });
  }

  for (const kind of ['REGISTERED_OFFICE', 'BILLING', 'SHIPPING']) {
    if (!snapshot.addressKinds.has(kind)) missing(`addresses.${kind}`);
  }

  const given = new Map(snapshot.identifiers.map((row) => [row.scheme, row]));
  const provided = new Set<string>();

  for (const requirement of identifierRequirementsFor(
    snapshot.registrationCountry,
    snapshot.entityType,
  )) {
    const row = given.get(requirement.scheme);
    const field = `identifiers.${requirement.scheme}`;

    if (row === undefined || (row.value === null && !row.notApplicable)) {
      if (requirement.required) missing(field);
      continue;
    }

    if (row.notApplicable) {
      if (!requirement.allowNotApplicable) {
        problems.push({ field, code: 'NOT_APPLICABLE_NOT_ALLOWED' });
      } else if (row.notApplicableReason === null) {
        problems.push({ field, code: 'NOT_APPLICABLE_REASON_REQUIRED' });
      }
      continue;
    }

    const problem = identifierProblem(
      requirement.scheme,
      normaliseIdentifier(row.value ?? ''),
      snapshot.registrationCountry,
    );
    if (problem !== null) problems.push({ field, code: problem });
    else provided.add(requirement.scheme);
  }

  for (const requirement of documentRequirementsFor({
    registrationCountry: snapshot.registrationCountry,
    entityType: snapshot.entityType,
    providedSchemes: provided,
    applicantRelationship: isApplicantRelationship(snapshot.applicantRelationship)
      ? snapshot.applicantRelationship
      : null,
  })) {
    if (!requirement.required) continue;
    if (!requirement.kinds.some((kind) => snapshot.documentKinds.has(kind))) {
      problems.push({
        field: `documents.${requirement.kinds.join('|')}`,
        code: 'DOCUMENT_REQUIRED',
      });
    }
  }

  return problems;
}

/** The schemes an application may declare, for the given country. */
export function schemesFor(
  country: string | null,
  entityType: BuyerCompanyEntityTypeName | null,
): IdentifierSchemeName[] {
  return identifierRequirementsFor(country, entityType).map((requirement) => requirement.scheme);
}

// ---------------------------------------------------------------------------
// Company-name normalisation, for duplicate detection
// ---------------------------------------------------------------------------

/**
 * Legal-form suffixes stripped before names are compared. Deliberately a
 * short list of the forms in this product's markets - "Acme Sp. z o.o." and
 * "ACME SPOLKA Z OGRANICZONA ODPOWIEDZIALNOSCIA" are one company to a
 * reviewer, and a signal is all this produces.
 */
const LEGAL_SUFFIXES = [
  'private limited',
  'pvt ltd',
  'pvt',
  'limited',
  'ltd',
  'llp',
  'plc',
  'inc',
  'llc',
  'gmbh',
  'ag',
  'sa',
  'sas',
  'sarl',
  'srl',
  'spa',
  'bv',
  'nv',
  'ab',
  'oy',
  'as',
  'aps',
  'sp z o o',
  'spolka z ograniczona odpowiedzialnoscia',
  'spolka akcyjna',
  'sp k',
  'sp j',
];

export function normaliseCompanyLegalName(name: string): string {
  let value = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const suffix of LEGAL_SUFFIXES) {
    if (value.endsWith(` ${suffix}`)) value = value.slice(0, -suffix.length - 1).trim();
  }

  return value;
}

// ---------------------------------------------------------------------------
// Postcodes
// ---------------------------------------------------------------------------

/**
 * Postcode shapes for the markets this product is sold into.
 *
 * Only countries whose format is settled and simple are listed. Everywhere
 * else a postcode is optional and loosely bounded: a rule we have not checked
 * for a country is worse than none, because it refuses real addresses.
 */
const POSTCODE_SHAPES: Readonly<Record<string, RegExp>> = Object.freeze({
  IN: /^[1-9]\d{5}$/,
  PL: /^\d{2}-\d{3}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  IT: /^\d{5}$/,
  ES: /^\d{5}$/,
  GR: /^\d{3} ?\d{2}$/,
  NL: /^\d{4} ?[A-Z]{2}$/,
  BE: /^\d{4}$/,
  AT: /^\d{4}$/,
});

/** Countries where every address has a postcode. */
const POSTCODE_REQUIRED: ReadonlySet<string> = new Set(Object.keys(POSTCODE_SHAPES));

/** Null when the postcode suits the country, otherwise a problem code. */
export function postalCodeProblem(country: string, postalCode: string | null): string | null {
  const value = (postalCode ?? '').trim().toUpperCase();
  if (value.length === 0) return POSTCODE_REQUIRED.has(country) ? 'REQUIRED' : null;
  const shape = POSTCODE_SHAPES[country];
  if (shape !== undefined) return shape.test(value) ? null : 'POSTCODE_FORMAT';
  return /^[A-Z0-9 -]{2,12}$/.test(value) ? null : 'POSTCODE_FORMAT';
}
