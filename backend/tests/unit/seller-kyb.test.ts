/**
 * The know-your-business rules for a seller application, without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalIec,
  canonicalUdyam,
  kybGaps,
  kybSignals,
  sellerRegistrationRegister,
  taxNumberProblem,
  type KybFacts,
} from '../../src/domain/seller-kyb.js';
import { REDACTED_PATHS } from '../../src/infra/logger.js';

const FACTS: KybFacts = {
  registrationCountry: 'IN',
  legalForm: 'SOLE_PROPRIETORSHIP',
  companyRegistrationNumber: null,
  taxRegistrationNumber: null,
  exportCapable: false,
  exportMarkets: [],
  owners: [{ ownershipBasisPoints: 10_000 }],
};
const POLICY = { beneficialOwnersRequired: true };
const codes = (facts: Partial<KybFacts>, policy = POLICY): string[] =>
  kybGaps({ ...FACTS, ...facts }, policy).map((gap) => gap.code);

describe('kybGaps', () => {
  it('asks for nothing more from a complete proprietorship', () => {
    expect(codes({})).toEqual([]);
  });

  it('asks for the legal form first', () => {
    expect(codes({ legalForm: null })).toContain('LEGAL_FORM_MISSING');
  });

  it('asks an Indian company for a CIN, and an LLP for an LLPIN, in their formats', () => {
    expect(codes({ legalForm: 'PRIVATE_LIMITED_COMPANY' })).toContain('REGISTRATION_NUMBER_REQUIRED');
    expect(codes({ legalForm: 'PUBLIC_LIMITED_COMPANY', companyRegistrationNumber: 'L12345MH2020PLC123456' })).toEqual([]);
    expect(codes({ legalForm: 'LIMITED_LIABILITY_PARTNERSHIP', companyRegistrationNumber: 'U12345MH2020PTC123456' })).toContain(
      'REGISTRATION_NUMBER_FORMAT',
    );
    expect(codes({ legalForm: 'LIMITED_LIABILITY_PARTNERSHIP', companyRegistrationNumber: 'AAB-1234' })).toEqual([]);
  });

  it('never asks for a CIN outside India', () => {
    expect(codes({ registrationCountry: 'DE', legalForm: 'PRIVATE_LIMITED_COMPANY' })).toEqual([]);
  });

  it('flags a GSTIN whose check character does not match', () => {
    expect(codes({ taxRegistrationNumber: '27AAGCN4521R1ZP' })).toContain('TAX_NUMBER_INVALID');
    expect(codes({ taxRegistrationNumber: '27AAPFU0939F1ZV' })).toEqual([]);
  });

  it('asks for an owner only when the policy does, and refuses more than 100%', () => {
    expect(codes({ owners: [] })).toContain('BENEFICIAL_OWNER_REQUIRED');
    expect(codes({ owners: [] }, { beneficialOwnersRequired: false })).toEqual([]);
    expect(codes({ owners: [{ ownershipBasisPoints: 6000 }, { ownershipBasisPoints: 5000 }] })).toContain('OWNERSHIP_OVER_100');
  });

  it('asks an exporter where it exports to', () => {
    expect(codes({ exportCapable: true })).toContain('EXPORT_MARKETS_REQUIRED');
    expect(codes({ exportCapable: true, exportMarkets: ['DE'] })).toEqual([]);
  });
});

describe('identifiers', () => {
  it('stores Udyam as the certificate prints it, and refuses a malformed one', () => {
    expect(canonicalUdyam('udyam-mh-01-0000001')).toBe('UDYAM-MH-01-0000001');
    expect(canonicalUdyam('UDYAM MH 01 0000001')).toBe('UDYAM-MH-01-0000001');
    expect(canonicalUdyam('UDYAM-MH-01-00001')).toBeNull();
  });

  it('keeps an IEC to ten characters', () => {
    expect(canonicalIec('abcde1234f')).toBe('ABCDE1234F');
    expect(canonicalIec('ABC')).toBeNull();
  });

  it('only checks a GSTIN for India', () => {
    expect(taxNumberProblem('IN', '27AAGCN4521R1ZP')).toBe('GSTIN_CHECKSUM');
    expect(taxNumberProblem('DE', '27AAGCN4521R1ZP')).toBeNull();
    expect(taxNumberProblem('IN', '')).toBeNull();
  });

  it('names the register only where India names one', () => {
    expect(sellerRegistrationRegister('IN', 'PRIVATE_LIMITED_COMPANY')).toBe('IN_CIN');
    expect(sellerRegistrationRegister('in', 'LIMITED_LIABILITY_PARTNERSHIP')).toBe('IN_LLPIN');
    expect(sellerRegistrationRegister('IN', 'PARTNERSHIP')).toBe('LOCAL');
    expect(sellerRegistrationRegister('PL', 'PRIVATE_LIMITED_COMPANY')).toBe('LOCAL');
  });

  it('tells the reviewer when the GSTIN was issued to a different PAN', () => {
    expect(
      kybSignals({
        registrationCountry: 'IN',
        legalForm: 'PARTNERSHIP',
        companyRegistrationNumber: null,
        taxRegistrationNumber: '27AAPFU0939F1ZV',
        panNumber: 'AAPFX0939F',
      }),
    ).toContain('GSTIN_PAN_MISMATCH');
    expect(
      kybSignals({
        registrationCountry: 'IN',
        legalForm: 'PARTNERSHIP',
        companyRegistrationNumber: null,
        taxRegistrationNumber: '27AAPFU0939F1ZV',
        panNumber: 'AAPFU0939F',
      }),
    ).toEqual([]);
  });
});

describe('logs', () => {
  it("never write a seller's identifiers or owners", () => {
    for (const path of [
      'taxRegistrationNumber',
      'companyRegistrationNumber',
      'udyamNumber',
      'iecNumber',
      'extraIdentifiersJson',
      'beneficialOwners',
      '*.taxRegistrationNumber',
    ]) {
      expect(REDACTED_PATHS as readonly string[]).toContain(path);
    }
  });
});
