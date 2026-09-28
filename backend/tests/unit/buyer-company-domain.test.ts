/**
 * The buyer-company rules that decide things without a database: the state
 * machine, company-level authority, identifier check digits, what a country
 * asks for, and what counts as a complete application.
 */
import { describe, expect, it } from 'vitest';
import {
  allowedBuyerCompanyTransitions,
  assertBuyerCompanyTransition,
  BuyerCompanyStatusValues,
  companyCapabilityBlock,
  isPurchasingStatus,
} from '../../src/domain/buyer-company-state.js';
import {
  identifierInconsistencies,
  identifierProblem,
  identifierRequirementsFor,
  isValidLei,
  isValidNip,
  isValidRegon,
  normaliseIdentifier,
  registrationNumberProblem,
  registrationRegisterFor,
} from '../../src/domain/buyer-company-identifiers.js';
import {
  businessDomainStatus,
  completenessProblems,
  documentRequirementsFor,
  APPLICANT_RELATIONSHIPS,
  normaliseCompanyLegalName,
  postalCodeProblem,
  type ApplicationSnapshot,
} from '../../src/domain/buyer-company-requirements.js';
import { AppError } from '../../src/domain/errors.js';

function refusalCode(run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.details[0]?.code : 'NOT_APP_ERROR';
  }
  return undefined;
}

describe('buyer-company state machine', () => {
  it('never lets an applicant approve, from any status', () => {
    for (const from of BuyerCompanyStatusValues) {
      const allowed = allowedBuyerCompanyTransitions(from, 'APPLICANT').map((rule) => rule.to);
      expect(allowed, from).not.toContain('APPROVED');
    }
  });

  it('never lets the system approve or reject', () => {
    for (const from of BuyerCompanyStatusValues) {
      const allowed = allowedBuyerCompanyTransitions(from, 'SYSTEM').map((rule) => rule.to);
      expect(allowed, from).not.toContain('APPROVED');
      expect(allowed, from).not.toContain('REJECTED');
    }
  });

  it('only reaches APPROVED from review, suspension or re-verification', () => {
    const sources = BuyerCompanyStatusValues.filter((from) =>
      allowedBuyerCompanyTransitions(from, 'REVIEWER').some((rule) => rule.to === 'APPROVED'),
    );
    expect(sources.sort()).toEqual(['REVERIFICATION_REQUIRED', 'SUSPENDED', 'UNDER_REVIEW']);
  });

  it('sends automated checks only onward to a person', () => {
    const next = [
      ...allowedBuyerCompanyTransitions('AUTOMATED_CHECK_IN_PROGRESS', 'SYSTEM'),
      ...allowedBuyerCompanyTransitions('AUTOMATED_CHECK_IN_PROGRESS', 'REVIEWER'),
    ].map((rule) => rule.to);
    expect([...new Set(next)]).toEqual(['UNDER_REVIEW']);
  });

  it('requires a reason for a rejection, a request for information and a suspension', () => {
    expect(refusalCode(() => { assertBuyerCompanyTransition({ from: 'UNDER_REVIEW', to: 'REJECTED', actor: 'REVIEWER', reason: '  ' }); })).toBe('REASON_REQUIRED');
    expect(refusalCode(() => { assertBuyerCompanyTransition({ from: 'UNDER_REVIEW', to: 'MORE_INFORMATION_REQUIRED', actor: 'REVIEWER' }); })).toBe('REASON_REQUIRED');
    expect(refusalCode(() => { assertBuyerCompanyTransition({ from: 'APPROVED', to: 'SUSPENDED', actor: 'REVIEWER' }); })).toBe('REASON_REQUIRED');
    expect(refusalCode(() => { assertBuyerCompanyTransition({ from: 'UNDER_REVIEW', to: 'REJECTED', actor: 'REVIEWER', reason: 'Register shows it dissolved.' }); })).toBeUndefined();
  });

  it('refuses an undefined transition, a wrong actor and a no-op', () => {
    expect(refusalCode(() => { assertBuyerCompanyTransition({ from: 'APPROVED', to: 'REJECTED', actor: 'REVIEWER', reason: 'x' }); })).toBe('TRANSITION_UNDEFINED');
    expect(refusalCode(() => { assertBuyerCompanyTransition({ from: 'UNDER_REVIEW', to: 'APPROVED', actor: 'APPLICANT' }); })).toBe('ACTOR_NOT_PERMITTED');
    expect(refusalCode(() => { assertBuyerCompanyTransition({ from: 'DRAFT', to: 'DRAFT', actor: 'APPLICANT' }); })).toBe('SAME_STATUS');
  });

  it('lets only APPROVED purchase', () => {
    expect(BuyerCompanyStatusValues.filter(isPurchasingStatus)).toEqual(['APPROVED']);
  });

  it('judges role before approval, and approval only for what represents the business', () => {
    expect(companyCapabilityBlock('VIEWER', 'APPROVED', 'PURCHASE')).toBe('ROLE');
    expect(companyCapabilityBlock('BUYER', 'UNDER_REVIEW', 'PURCHASE')).toBe('NOT_APPROVED');
    expect(companyCapabilityBlock('BUYER', 'SUSPENDED', 'PURCHASE')).toBe('NOT_APPROVED');
    expect(companyCapabilityBlock('BUYER', 'APPROVED', 'PURCHASE')).toBeNull();
    expect(companyCapabilityBlock('OWNER', 'DRAFT', 'MANAGE_APPLICATION')).toBeNull();
    expect(companyCapabilityBlock('OWNER', 'UNDER_REVIEW', 'MANAGE_MEMBERS')).toBe('NOT_APPROVED');
    expect(companyCapabilityBlock('BUYER', 'DRAFT', 'MANAGE_APPLICATION')).toBe('ROLE');
  });
});

describe('identifier check digits', () => {
  it('accepts real Polish NIP and REGON numbers and rejects a changed digit', () => {
    expect(isValidNip('5260250274')).toBe(true);
    expect(isValidNip('5260250275')).toBe(false);
    expect(isValidRegon('000002217')).toBe(true);
    expect(isValidRegon('00012680100000')).toBe(true);
    expect(isValidRegon('000002218')).toBe(false);
  });

  it('checks a LEI with ISO 7064 mod 97-10', () => {
    expect(isValidLei('5493001KJTIIGC8Y1R12')).toBe(true);
    expect(isValidLei('5493001KJTIIGC8Y1R13')).toBe(false);
  });

  it('checks GSTIN, PAN, EU VAT and the country of a VAT number', () => {
    expect(identifierProblem('IN_GSTIN', '27AAPFU0939F1ZV', 'IN')).toBeNull();
    expect(identifierProblem('IN_GSTIN', '27AAPFU0939F1ZX', 'IN')).toBe('GSTIN_CHECKSUM');
    expect(identifierProblem('IN_PAN', 'AAPFU0939F', 'IN')).toBeNull();
    expect(identifierProblem('IN_PAN', 'AAPF0939F', 'IN')).toBe('PAN_FORMAT');
    expect(identifierProblem('EU_VAT', 'PL5260250274', 'PL')).toBeNull();
    expect(identifierProblem('EU_VAT', 'PL5260250275', 'PL')).toBe('NIP_CHECKSUM');
    expect(identifierProblem('EU_VAT', 'DE123456789', 'PL')).toBe('VAT_COUNTRY');
    expect(identifierProblem('EU_VAT', 'US123456789', null)).toBe('VAT_PREFIX');
  });

  it('normalises separators people paste off a letterhead', () => {
    expect(normaliseIdentifier(' pl 526-025-02-74 ')).toBe('PL5260250274');
  });
});

describe('registration numbers by country and legal form', () => {
  it('uses CIN, LLPIN, KRS and CEIDG where they apply', () => {
    expect(registrationRegisterFor('IN', 'PRIVATE_LIMITED_COMPANY')).toBe('IN_CIN');
    expect(registrationRegisterFor('IN', 'LIMITED_LIABILITY_PARTNERSHIP')).toBe('IN_LLPIN');
    expect(registrationRegisterFor('IN', 'SOLE_PROPRIETORSHIP')).toBe('LOCAL');
    expect(registrationRegisterFor('PL', 'PRIVATE_LIMITED_COMPANY')).toBe('PL_KRS');
    expect(registrationRegisterFor('PL', 'SOLE_PROPRIETORSHIP')).toBe('PL_CEIDG');
    expect(registrationRegisterFor('DE', 'PRIVATE_LIMITED_COMPANY')).toBe('LOCAL');
  });

  it('validates the shape of each', () => {
    expect(registrationNumberProblem('IN_CIN', 'U12345MH2020PTC123456')).toBeNull();
    expect(registrationNumberProblem('IN_CIN', 'U12345MH2020PTC12345')).toBe('CIN_FORMAT');
    expect(registrationNumberProblem('IN_LLPIN', 'AAB1234')).toBeNull();
    expect(registrationNumberProblem('PL_KRS', '0000019193')).toBeNull();
    expect(registrationNumberProblem('PL_KRS', '19193')).toBe('KRS_FORMAT');
    expect(registrationNumberProblem('PL_CEIDG', '5260250274')).toBeNull();
  });
});

describe('what each country asks for', () => {
  it('never makes a GSTIN or an EU VAT number compulsory, and always offers "not registered"', () => {
    const india = identifierRequirementsFor('IN', 'PRIVATE_LIMITED_COMPANY');
    expect(india.find((row) => row.scheme === 'IN_GSTIN')).toEqual({ scheme: 'IN_GSTIN', required: false, allowNotApplicable: true });
    const poland = identifierRequirementsFor('PL', 'PRIVATE_LIMITED_COMPANY');
    expect(poland.find((row) => row.scheme === 'EU_VAT')).toEqual({ scheme: 'EU_VAT', required: false, allowNotApplicable: true });
    const germany = identifierRequirementsFor('DE', 'PRIVATE_LIMITED_COMPANY');
    expect(germany.find((row) => row.scheme === 'EU_VAT')?.allowNotApplicable).toBe(true);
  });

  it('asks a company for its own PAN, and does not demand a proprietor\'s personal one', () => {
    expect(identifierRequirementsFor('IN', 'PRIVATE_LIMITED_COMPANY').find((row) => row.scheme === 'IN_PAN')?.required).toBe(true);
    expect(identifierRequirementsFor('IN', 'SOLE_PROPRIETORSHIP').find((row) => row.scheme === 'IN_PAN')?.required).toBe(false);
  });

  it('requires NIP and REGON in Poland', () => {
    const poland = identifierRequirementsFor('PL', 'SOLE_PROPRIETORSHIP');
    expect(poland.filter((row) => row.required).map((row) => row.scheme).sort()).toEqual(['PL_NIP', 'PL_REGON']);
  });

  it('asks a KRS company for no existence document, because the register is read directly', () => {
    const krs = documentRequirementsFor({ registrationCountry: 'PL', entityType: 'PRIVATE_LIMITED_COMPANY', providedSchemes: new Set() });
    expect(krs.find((row) => row.purpose === 'PROVES_EXISTENCE')?.required).toBe(false);
    const ceidg = documentRequirementsFor({ registrationCountry: 'PL', entityType: 'SOLE_PROPRIETORSHIP', providedSchemes: new Set() });
    expect(ceidg.find((row) => row.purpose === 'PROVES_EXISTENCE')?.required).toBe(true);
  });

  it('asks for a GST certificate only when a GSTIN is given, and never for an identity document by default', () => {
    const without = documentRequirementsFor({ registrationCountry: 'IN', entityType: 'PRIVATE_LIMITED_COMPANY', providedSchemes: new Set() });
    const withGst = documentRequirementsFor({ registrationCountry: 'IN', entityType: 'PRIVATE_LIMITED_COMPANY', providedSchemes: new Set(['IN_GSTIN']) });
    expect(without.some((row) => row.kinds.includes('TAX_REGISTRATION_CERTIFICATE'))).toBe(false);
    expect(withGst.some((row) => row.kinds.includes('TAX_REGISTRATION_CERTIFICATE') && row.required)).toBe(true);
    for (const row of [...without, ...withGst]) {
      expect(row.kinds).not.toContain('REPRESENTATIVE_IDENTITY');
      expect(row.kinds).not.toContain('OWNERSHIP_DECLARATION');
    }
  });

  it('offers proof of address and a business licence to everybody, and requires neither', () => {
    for (const [country, entityType] of [['IN', 'PRIVATE_LIMITED_COMPANY'], ['PL', 'SOLE_PROPRIETORSHIP'], ['DE', 'OTHER']] as const) {
      const rows = documentRequirementsFor({ registrationCountry: country, entityType, providedSchemes: new Set() });
      expect(rows.find((row) => row.kinds.includes('PROOF_OF_REGISTERED_ADDRESS'))?.required).toBe(false);
      expect(rows.find((row) => row.kinds.includes('BUSINESS_LICENCE'))?.required).toBe(false);
    }
  });

  it('validates postcodes for the markets it knows and stays loose elsewhere', () => {
    expect(postalCodeProblem('PL', '00-916')).toBeNull();
    expect(postalCodeProblem('PL', '00916')).toBe('POSTCODE_FORMAT');
    expect(postalCodeProblem('IN', '411001')).toBeNull();
    expect(postalCodeProblem('IN', '011001')).toBe('POSTCODE_FORMAT');
    expect(postalCodeProblem('IN', '')).toBe('REQUIRED');
    expect(postalCodeProblem('AE', '')).toBeNull();
  });

  it('reads the business email domain against the website', () => {
    expect(businessDomainStatus('buyer@gmail.com', 'acme.com')).toBe('FREE_MAIL_PROVIDER');
    expect(businessDomainStatus('buyer@acme.com', 'https://www.acme.com/about')).toBe('MATCHES_WEBSITE');
    expect(businessDomainStatus('buyer@eu.acme.com', 'acme.com')).toBe('MATCHES_WEBSITE');
    expect(businessDomainStatus('buyer@other.io', 'acme.com')).toBe('DIFFERS_FROM_WEBSITE');
    expect(businessDomainStatus('buyer@acme.com', null)).toBe('NO_WEBSITE');
  });

  it('treats legal suffixes and accents as the same company for duplicate signals', () => {
    expect(normaliseCompanyLegalName('ACME Polska Sp. z o.o.')).toBe(normaliseCompanyLegalName('Acme Polska'));
    expect(normaliseCompanyLegalName('Zakłady Łódź Private Limited')).toBe('zaklady lodz');
  });

  it('flags a GSTIN that carries a different PAN, and a PL VAT number that is not PL+NIP', () => {
    const found = identifierInconsistencies({
      registrationCountry: 'IN',
      entityType: 'PRIVATE_LIMITED_COMPANY',
      registrationNumber: null,
      identifiers: new Map([['IN_PAN', 'AAACB1234C'], ['IN_GSTIN', '27AAPFU0939F1ZV']]),
    });
    expect(found.map((row) => row.code)).toContain('GSTIN_PAN_MISMATCH');
    const poland = identifierInconsistencies({
      registrationCountry: 'PL',
      entityType: 'PRIVATE_LIMITED_COMPANY',
      registrationNumber: null,
      identifiers: new Map([['PL_NIP', '5260250274'], ['EU_VAT', 'PL5250000251']]),
    });
    expect(poland.map((row) => row.code)).toEqual(['VAT_NIP_MISMATCH']);
  });
});

describe('completeness at submission', () => {
  const complete: ApplicationSnapshot = {
    legalName: 'Acme Polska Sp. z o.o.',
    entityType: 'PRIVATE_LIMITED_COMPANY',
    registrationCountry: 'PL',
    registrationNumber: '0000019193',
    incorporationDate: new Date('2001-06-11T00:00:00Z'),
    industry: 'HEALTHCARE',
    businessEmail: 'buyer@acme.pl',
    businessPhone: '+48221234567',
    applicantJobTitle: 'Procurement lead',
    applicantRelationship: 'EMPLOYEE',
    applicantAuthorityConfirmed: true,
    addressKinds: new Set(['REGISTERED_OFFICE', 'BILLING', 'SHIPPING']),
    identifiers: [
      { scheme: 'PL_NIP', value: '5260250274', notApplicable: false, notApplicableReason: null },
      { scheme: 'PL_REGON', value: '000002217', notApplicable: false, notApplicableReason: null },
      { scheme: 'EU_VAT', value: null, notApplicable: true, notApplicableReason: 'EXEMPT' },
    ],
    documentKinds: new Set(),
  };

  it('accepts a complete KRS application with VAT declared exempt and no documents', () => {
    expect(completenessProblems(complete)).toEqual([]);
  });

  it('names every missing piece by field', () => {
    const problems = completenessProblems({
      ...complete,
      legalName: null,
      applicantAuthorityConfirmed: false,
      addressKinds: new Set(['REGISTERED_OFFICE']),
      identifiers: [],
    });
    const fields = problems.map((problem) => problem.field);
    expect(fields).toEqual(expect.arrayContaining(['legalName', 'applicantAuthorityConfirmed', 'addresses.BILLING', 'addresses.SHIPPING', 'identifiers.PL_NIP', 'identifiers.PL_REGON']));
  });

  it('refuses "not applicable" on a required number, and a future incorporation date', () => {
    const problems = completenessProblems({
      ...complete,
      incorporationDate: new Date(Date.now() + 86_400_000),
      identifiers: [
        { scheme: 'PL_NIP', value: null, notApplicable: true, notApplicableReason: 'NOT_REGISTERED' },
        { scheme: 'PL_REGON', value: '000002217', notApplicable: false, notApplicableReason: null },
      ],
    });
    expect(problems).toEqual(expect.arrayContaining([
      { field: 'identifiers.PL_NIP', code: 'NOT_APPLICABLE_NOT_ALLOWED' },
      { field: 'incorporationDate', code: 'IN_FUTURE' },
    ]));
  });

  it('needs the representative to say how they stand to the business, from the fixed list', () => {
    expect(completenessProblems({ ...complete, applicantRelationship: null })).toContainEqual({
      field: 'applicantRelationship',
      code: 'REQUIRED',
    });
    // A value typed around the storefront is not a relationship.
    expect(completenessProblems({ ...complete, applicantRelationship: 'CEO' })).toContainEqual({
      field: 'applicantRelationship',
      code: 'REQUIRED',
    });
  });

  it('asks an outside agent for an authorisation letter, and nobody else', () => {
    const agent = completenessProblems({ ...complete, applicantRelationship: 'AUTHORISED_AGENT' });
    expect(agent).toContainEqual({ field: 'documents.AUTHORIZATION_LETTER', code: 'DOCUMENT_REQUIRED' });
    expect(
      completenessProblems({
        ...complete,
        applicantRelationship: 'AUTHORISED_AGENT',
        documentKinds: new Set(['AUTHORIZATION_LETTER']),
      }),
    ).toEqual([]);
    for (const relationship of APPLICANT_RELATIONSHIPS.filter((value) => value !== 'AUTHORISED_AGENT')) {
      expect(completenessProblems({ ...complete, applicantRelationship: relationship })).toEqual([]);
    }
  });

  it('asks a Polish sole trader for an existence document', () => {
    const problems = completenessProblems({ ...complete, entityType: 'SOLE_PROPRIETORSHIP', registrationNumber: '5260250274', incorporationDate: null });
    expect(problems.map((problem) => problem.code)).toContain('DOCUMENT_REQUIRED');
  });
});
