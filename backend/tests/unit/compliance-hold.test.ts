/**
 * Destination documentation readiness and the pre-dispatch hold
 * (JOURNEY-049), on facts alone: which rules match, which party owes what,
 * and what holds the goods until it is fixed or overridden.
 */
import { describe, expect, it } from 'vitest';
import {
  assertComplianceOpen,
  evaluateCompliance,
  ruleMatchesLine,
  type ComplianceLineFact,
  type ComplianceRuleFact,
  type TradeValidationState,
} from '../../src/domain/compliance-hold.js';

const rule = (patch: Partial<ComplianceRuleFact>): ComplianceRuleFact => ({
  id: 'r1',
  name: 'Rule',
  destinationCountry: 'DE',
  categoryId: null,
  hsPrefix: '',
  restriction: 'NONE',
  requiredDocumentKind: null,
  requiredDocumentName: null,
  responsibleParty: 'SELLER',
  requiresHsVerification: false,
  note: null,
  ...patch,
});

const LINE: ComplianceLineFact = {
  sku: 'GLOVE-M',
  categoryIds: ['child', 'parent'],
  hsCode: '40151900',
  hsState: 'DECLARED',
  hsVerifiedCode: null,
};

const docs = (entries: [string, TradeValidationState[]][] = []) => new Map(entries);

describe('rule matching', () => {
  it('matches by destination, any category above the product, and HS prefix', () => {
    expect(ruleMatchesLine(rule({}), LINE, 'DE')).toBe(true);
    expect(ruleMatchesLine(rule({}), LINE, 'FR')).toBe(false);
    expect(ruleMatchesLine(rule({ destinationCountry: '' }), LINE, 'FR')).toBe(true);
    expect(ruleMatchesLine(rule({ categoryId: 'parent' }), LINE, 'DE')).toBe(true);
    expect(ruleMatchesLine(rule({ categoryId: 'other' }), LINE, 'DE')).toBe(false);
    expect(ruleMatchesLine(rule({ hsPrefix: '4015' }), LINE, 'DE')).toBe(true);
    expect(ruleMatchesLine(rule({ hsPrefix: '3004' }), LINE, 'DE')).toBe(false);
  });

  it('matches on the code staff corrected it to once verified', () => {
    const corrected = { ...LINE, hsState: 'VERIFIED' as const, hsVerifiedCode: '30049099' };
    expect(ruleMatchesLine(rule({ hsPrefix: '3004' }), corrected, 'DE')).toBe(true);
  });
});

describe('the hold', () => {
  const evaluate = (rules: ComplianceRuleFact[], documents = docs(), overrideKeys: string[] | null = null, lines = [LINE]) =>
    evaluateCompliance({ destination: 'DE', rules, lines, documents, overrideKeys });

  it('is open when no rule applies', () => {
    expect(evaluate([rule({ destinationCountry: 'US', restriction: 'PROHIBITED' })])).toMatchObject({ open: true, items: [], holds: [] });
  });

  it('holds prohibited goods', () => {
    const verdict = evaluate([rule({ restriction: 'PROHIBITED' })]);
    expect(verdict.open).toBe(false);
    expect(verdict.holds.map((hold) => hold.code)).toEqual(['PROHIBITED']);
  });

  it('holds for a seller document until a current version is VALID, not merely awaiting review', () => {
    const rules = [rule({ restriction: 'RESTRICTED', requiredDocumentKind: 'IMPORT_LICENCE' })];
    expect(evaluate(rules).holds.map((hold) => hold.code)).toEqual(['DOCUMENT_MISSING']);
    expect(evaluate(rules, docs([['IMPORT_LICENCE', ['PENDING_REVIEW']]])).holds.map((hold) => hold.code)).toEqual([
      'DOCUMENT_NOT_VALID',
    ]);
    expect(evaluate(rules, docs([['IMPORT_LICENCE', ['EXPIRED']]])).items[0]?.status).toBe('EXPIRED');
    expect(evaluate(rules, docs([['IMPORT_LICENCE', ['VALID']]])).open).toBe(true);
  });

  it('lists a document the buyer owes without holding the seller for it', () => {
    const verdict = evaluate([rule({ requiredDocumentKind: 'IMPORT_LICENCE', responsibleParty: 'BUYER' })]);
    expect(verdict.open).toBe(true);
    expect(verdict.items[0]).toMatchObject({ responsibleParty: 'BUYER', status: 'MISSING', skus: ['GLOVE-M'] });
  });

  it('holds an unverified or rejected HS code where a rule needs it verified', () => {
    const rules = [rule({ requiresHsVerification: true })];
    expect(evaluate(rules).holds.map((hold) => hold.code)).toEqual(['HS_UNVERIFIED']);
    expect(evaluate(rules, docs(), null, [{ ...LINE, hsState: 'REJECTED' }]).holds.map((hold) => hold.code)).toEqual([
      'HS_REJECTED',
    ]);
    expect(evaluate(rules, docs(), null, [{ ...LINE, hsState: 'VERIFIED' }]).open).toBe(true);
  });

  it('an override covers the holds it named, and a new cause holds the goods again', () => {
    const first = evaluate([rule({ restriction: 'PROHIBITED' })]);
    const keys = first.holds.map((hold) => hold.key);
    expect(evaluate([rule({ restriction: 'PROHIBITED' })], docs(), keys)).toMatchObject({ open: true, overridden: true });

    const later = evaluate([rule({ restriction: 'PROHIBITED', requiresHsVerification: true })], docs(), keys);
    expect(later.open).toBe(false);
    expect(later.holds.filter((hold) => !hold.covered).map((hold) => hold.code)).toEqual(['HS_UNVERIFIED']);
  });

  it('refuses the move with 409 DESTINATION_DOCUMENTS_NOT_READY, naming the party', () => {
    const verdict = evaluate([rule({ restriction: 'PROHIBITED', name: 'No gloves to DE' })]);
    expect(() => {
      assertComplianceOpen(verdict, { from: 'PROCESSING', to: 'READY_FOR_DISPATCH' });
    }).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: 'DESTINATION_DOCUMENTS_NOT_READY',
        details: [expect.objectContaining({ code: 'PROHIBITED', meta: expect.objectContaining({ party: 'SELLER', rule: 'No gloves to DE' }) })],
      }),
    );
    expect(() => {
      assertComplianceOpen(evaluate([]), { from: 'PROCESSING', to: 'READY_FOR_DISPATCH' });
    }).not.toThrow();
  });
});
