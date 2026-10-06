/**
 * Quantities, units, sampling wording and the lot decision (Audit Console,
 * module B). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  fromMilli,
  summariseDefectUnits,
  summariseQuantities,
  toMilli,
  validateQuantities,
} from '../../src/domain/inspection-quantity.js';
import { computeInspectionResult } from '../../src/domain/inspection-state.js';
import { evaluateInspectionGate } from '../../src/domain/inspection-gate.js';

const plan = { critical: { accept: 0, reject: 1 }, major: { accept: 2, reject: 3 }, minor: { accept: 5, reject: 6 } } as never;

describe('exact quantities', () => {
  it('holds decimals exactly, without binary floating point', () => {
    expect(toMilli('0.1') + toMilli('0.2')).toBe(toMilli('0.3'));
    expect(fromMilli(toMilli('4999.999') - toMilli('5000'))).toBe('-0.001');
    expect(fromMilli(toMilli('12.500'))).toBe('12.5');
  });

  it('refuses more than three decimals, negatives and text', () => {
    for (const value of ['1.2345', '-1', 'ten', '1e3', '']) {
      expect(() => toMilli(value)).toThrow();
    }
  });

  it('refuses fractions of a countable unit but allows them for measured units', () => {
    expect(() => validateQuantities({ unit: 'PIECE', scopeMethod: 'SAMPLE', orderedQuantity: '10.5' })).toThrow();
    expect(() => validateQuantities({ unit: 'CARTON', scopeMethod: 'SAMPLE', orderedQuantity: '10', verifiedQuantity: '9.5' })).toThrow();
    expect(validateQuantities({ unit: 'KILOGRAM', scopeMethod: 'SAMPLE', orderedQuantity: '10.25', verifiedQuantity: '10.125' }).verified).toBe(10_125n);
  });

  it('refuses counts that do not reconcile', () => {
    const base = { unit: 'PIECE' as const, scopeMethod: 'SAMPLE' as const, orderedQuantity: '5000' };
    expect(() => validateQuantities({ ...base, verifiedQuantity: '5000', sampledQuantity: '6000' })).toThrow(/sampled/);
    expect(() => validateQuantities({ ...base, sampledQuantity: '100', functionallyTestedQuantity: '120' })).toThrow(/tested/);
    expect(() => validateQuantities({ ...base, functionallyTestedQuantity: '100', testedConformingQuantity: '95', testedNonconformingQuantity: '4' })).toThrow(/equal/);
    expect(() => validateQuantities({ ...base, testedConformingQuantity: '95' })).toThrow();
    expect(() => validateQuantities({ ...base, verifiedQuantity: '10', damagedQuantity: '11' })).toThrow();
    expect(() => validateQuantities({ ...base, packaging: [{ unit: 'CARTON', contains: '0', of: 'PIECE' }] })).toThrow();
    expect(() => validateQuantities({ ...base, packaging: [{ unit: 'PIECE', contains: '24', of: 'PIECE' }] })).toThrow();
  });

  it('refuses a "full" inspection that examined fewer units than were verified', () => {
    expect(() =>
      validateQuantities({ unit: 'PIECE', scopeMethod: 'FULL', orderedQuantity: '500', verifiedQuantity: '500', sampledQuantity: '80' }),
    ).toThrow(/full inspection/i);
    expect(validateQuantities({ unit: 'PIECE', scopeMethod: 'FULL', orderedQuantity: '500', verifiedQuantity: '500', sampledQuantity: '500' }).sampled).toBe(500_000n);
  });
});

describe('what a sample says, and what it does not', () => {
  it('states the tested result and the untested remainder, never a count of working units', () => {
    const summary = summariseQuantities(
      validateQuantities({
        unit: 'PIECE',
        scopeMethod: 'SAMPLE',
        orderedQuantity: '5000',
        verifiedQuantity: '5000',
        sampledQuantity: '200',
        functionallyTestedQuantity: '100',
        testedConformingQuantity: '95',
        testedNonconformingQuantity: '5',
      }),
    );
    expect(summary.statement).toBe('95 of 100 tested units passed; 4,900 units were not tested.');
    expect(summary.statement).not.toMatch(/4,750|working/);
    expect(summary.functional.untested).toBe('4900');
    // An observation about the sample: 5% non-conforming, as basis points.
    expect(summary.functional.observedNonconformingBasisPoints).toBe(500);
  });

  it('keeps reconciliation separate: short, excess, matching, or not counted', () => {
    const sum = (verified: string | null) =>
      summariseQuantities(validateQuantities({ unit: 'PIECE', scopeMethod: 'SAMPLE', orderedQuantity: '1000', verifiedQuantity: verified })).reconciliation;
    expect(sum('980')).toMatchObject({ status: 'SHORT', difference: '-20' });
    expect(sum('1010')).toMatchObject({ status: 'EXCESS', difference: '10' });
    expect(sum('1000')).toMatchObject({ status: 'MATCHES', difference: '0' });
    expect(sum(null)).toMatchObject({ status: 'NOT_VERIFIED', difference: null });
  });

  it('says honestly when nothing was tested, and when the lot was not counted', () => {
    expect(summariseQuantities(validateQuantities({ unit: 'PIECE', scopeMethod: 'SAMPLE', orderedQuantity: '10' })).statement).toBe(
      'No units were functionally tested.',
    );
    const notCounted = summariseQuantities(
      validateQuantities({ unit: 'PIECE', scopeMethod: 'SAMPLE', orderedQuantity: '10', functionallyTestedQuantity: '5', testedConformingQuantity: '5', testedNonconformingQuantity: '0' }),
    );
    expect(notCounted.statement).toMatch(/not known because the lot was not counted/);
  });
});

describe('defective units versus defect occurrences', () => {
  it('counts a unit with three defects once, by its worst defect', () => {
    const summary = summariseDefectUnits([
      { severity: 'MINOR', defectQuantity: 2, unitRefs: ['U-1', 'u-2'] },
      { severity: 'MAJOR', defectQuantity: 1, unitRefs: ['U-1'] },
      { severity: 'MINOR', defectQuantity: 1, unitRefs: ['U-1'] },
      { severity: 'MINOR', defectQuantity: 3, unitRefs: null },
    ]);
    expect(summary.occurrences).toEqual({ critical: 0, major: 1, minor: 6, total: 7 });
    expect(summary.defectiveUnitsIdentified).toBe(2);
    expect(summary.defectiveUnitsByWorstSeverity).toEqual({ critical: 0, major: 1, minor: 1 });
    expect(summary.occurrencesWithoutUnit).toBe(3);
  });
});

describe('the lot decision', () => {
  it('applies the plan to a sample, and zero acceptance to a full inspection', () => {
    const defects = [{ severity: 'MAJOR' as const, defectQuantity: 2 }];
    expect(computeInspectionResult({ sampling: plan, defects, nonconformingChecks: 0 }).result).toBe('PASS');
    const full = computeInspectionResult({ sampling: plan, defects, nonconformingChecks: 0, scopeMethod: 'FULL' });
    expect(full.result).toBe('FAIL');
    expect(full.limits.major).toEqual({ accept: 0, reject: 1 });
  });

  it('cannot PASS with a hold, and a known failure still FAILS', () => {
    expect(computeInspectionResult({ sampling: plan, defects: [], nonconformingChecks: 0, holds: ['MANDATORY_CHECK_NOT_PERFORMED:PROD.FUNCTION'] }).result).toBe('INCONCLUSIVE');
    expect(computeInspectionResult({ sampling: plan, defects: [{ severity: 'CRITICAL', defectQuantity: 1 }], nonconformingChecks: 0, holds: ['LAB_RESULT_PENDING:S1'] }).result).toBe('FAIL');
  });

  it('holds an inconclusive pre-shipment report at the dispatch gate', () => {
    const verdict = evaluateInspectionGate({
      requirementId: 'r',
      level: 'MANDATORY',
      release: null,
      latestSignedResult: 'INCONCLUSIVE',
      hasOpenJob: false,
      blockingNcrCount: 0,
      currentScopeHash: 'h',
      alreadyCollected: false,
      buyerReviewEndsAt: null,
      now: new Date(),
    });
    expect(verdict).toMatchObject({ open: false, reason: 'INCONCLUSIVE' });
  });
});
