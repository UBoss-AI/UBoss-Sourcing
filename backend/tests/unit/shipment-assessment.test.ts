import { describe, expect, it } from 'vitest';
import {
  assertAssessmentTransition,
  certificateValidUntil,
  COMMON_CHECKLIST,
  evaluateChecks,
  evaluateRequirement,
  isBadgeDowngrade,
  policyProblem,
  quantityProblem,
  releaseRefusal,
  samplingStatement,
  scopeFingerprint,
  waiverStatement,
  type BadgePolicy,
  type ReleaseFacts,
} from '../../src/domain/shipment-assessment.js';

const policy: BadgePolicy = {
  version: 1,
  platinumRule: 'WAIVER_ELIGIBLE',
  goldRule: 'WAIVER_ELIGIBLE_WITH_REVIEW',
  silverRule: 'ASSESSMENT_REQUIRED',
  bronzeRule: 'ASSESSMENT_REQUIRED',
  unbadgedRule: 'ASSESSMENT_REQUIRED',
  defaultDispatchDays: null,
  maxDispatchDays: null,
  sellerCertificateMonths: 12,
};
const facts = { policy, mandatoryInspection: false, mandatoryReason: null, applicabilityKnown: true, sellerSuspended: false };

describe('badge requirement', () => {
  it('Bronze, Silver and no badge require assessment', () => {
    for (const badge of ['BRONZE', 'SILVER', null] as const) expect(evaluateRequirement({ ...facts, badge }).requirement).toBe('ASSESSMENT_REQUIRED');
  });
  it('Platinum and Gold are only eligible - never waived by the rule itself', () => {
    expect(evaluateRequirement({ ...facts, badge: 'PLATINUM' }).requirement).toBe('WAIVER_ELIGIBLE');
    expect(evaluateRequirement({ ...facts, badge: 'GOLD' }).requirement).toBe('WAIVER_ELIGIBLE_WITH_REVIEW');
  });
  it('a mandatory inspection, unknown applicability or suspension removes eligibility', () => {
    expect(evaluateRequirement({ ...facts, badge: 'PLATINUM', mandatoryInspection: true, mandatoryReason: 'rule' }).requirement).toBe('ASSESSMENT_REQUIRED');
    expect(evaluateRequirement({ ...facts, badge: 'PLATINUM', applicabilityKnown: false }).requirement).toBe('ASSESSMENT_REQUIRED');
    expect(evaluateRequirement({ ...facts, badge: 'PLATINUM', sellerSuspended: true }).requirement).toBe('ASSESSMENT_REQUIRED');
  });
  it('a policy may not waive sellers without a badge', () => {
    expect(policyProblem({ ...policy, unbadgedRule: 'WAIVER_ELIGIBLE' })).toBe('UNBADGED_MUST_REQUIRE_ASSESSMENT');
    expect(policyProblem(policy)).toBeNull();
  });
  it('knows a downgrade from an upgrade', () => {
    expect(isBadgeDowngrade('PLATINUM', 'GOLD')).toBe(true);
    expect(isBadgeDowngrade('GOLD', null)).toBe(true);
    expect(isBadgeDowngrade('SILVER', 'GOLD')).toBe(false);
    expect(isBadgeDowngrade(null, 'GOLD')).toBe(false);
  });
});

describe('checks', () => {
  const pass = COMMON_CHECKLIST.map((item) => ({ itemCode: item.code, outcome: 'PASS' as const, note: null, evidenceCount: 1 }));
  it('each item stands alone: one failure fails the whole shipment', () => {
    const checks = pass.map((check) => (check.itemCode === 'F1' ? { ...check, outcome: 'FAIL' as const } : check));
    expect(evaluateChecks(COMMON_CHECKLIST, checks, 'PRE_LOADING').outcome).toBe('FAILED');
  });
  it('a hold holds the whole shipment', () => {
    const checks = pass.map((check) => (check.itemCode === 'G1' ? { ...check, outcome: 'HOLD' as const } : check));
    expect(evaluateChecks(COMMON_CHECKLIST, checks, 'PRE_LOADING').outcome).toBe('HELD');
  });
  it('missing results, missing evidence and unexplained N/A are incomplete', () => {
    const verdict = evaluateChecks(
      COMMON_CHECKLIST,
      pass
        .filter((check) => check.itemCode !== 'A1')
        .map((check) => (check.itemCode === 'D1' ? { ...check, evidenceCount: 0 } : check.itemCode === 'H3' ? { ...check, outcome: 'NOT_APPLICABLE' as const } : check)),
      'PRE_LOADING',
    );
    expect(verdict).toMatchObject({ outcome: 'INCOMPLETE', missing: ['A1'], missingEvidence: ['D1'], unjustifiedNa: ['H3'] });
  });
  it('loading checks are separate from pre-loading', () => {
    expect(evaluateChecks(COMMON_CHECKLIST, pass.filter((check) => !check.itemCode.startsWith('K')), 'PRE_LOADING').outcome).toBe('PASSED');
    expect(evaluateChecks(COMMON_CHECKLIST, pass.filter((check) => !check.itemCode.startsWith('K')), 'LOADING').outcome).toBe('INCOMPLETE');
  });
});

describe('quantities and sampling', () => {
  const q = { orderedQuantity: 100, declaredQuantity: 100, presentedQuantity: 100, countedQuantity: 100, sampledQuantity: 13, approvedQuantity: 100 };
  it('no partial release: the approved quantity is the whole order or nothing', () => {
    expect(quantityProblem(q)).toBeNull();
    expect(quantityProblem({ ...q, approvedQuantity: 90 })).toBe('APPROVED_NOT_WHOLE_SHIPMENT');
    expect(quantityProblem({ ...q, sampledQuantity: 101 })).toBe('SAMPLE_ABOVE_COUNT');
  });
  it('a sampled result is described as a sample', () => {
    expect(samplingStatement(q, 'ISO 2859-1 level II')).toContain('sample of 13 of 100 units');
    expect(samplingStatement(q, null)).not.toContain('All');
    expect(samplingStatement({ ...q, sampledQuantity: 100 }, null)).toContain('All 100');
  });
});

describe('release', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  const base: ReleaseFacts = {
    now,
    l1Complete: true,
    status: 'APPROVED_FOR_L2',
    authorization: { status: 'ACTIVE', kind: 'WAIVER', dispatchDeadline: new Date('2026-10-12T00:00:00Z'), scopeFingerprint: 'f', badgeVersion: 3, loadingChecksRequired: true },
    currentFingerprint: 'f',
    currentBadgeVersion: 3,
    waiverStillEligible: true,
    sellerSuspended: false,
    loadingChecksPassed: true,
    openExceptions: 0,
  };
  it('releases only when every condition holds', () => {
    expect(releaseRefusal(base)).toBeNull();
    expect(releaseRefusal({ ...base, l1Complete: false })).toBe('L1_NOT_COMPLETE');
    expect(releaseRefusal({ ...base, status: 'ON_HOLD' })).toBe('NOT_APPROVED');
    expect(releaseRefusal({ ...base, authorization: null })).toBe('NO_AUTHORIZATION');
    expect(releaseRefusal({ ...base, now: new Date('2026-10-13T00:00:00Z') })).toBe('AUTHORIZATION_EXPIRED');
    expect(releaseRefusal({ ...base, currentFingerprint: 'g' })).toBe('SHIPMENT_CHANGED');
    expect(releaseRefusal({ ...base, currentBadgeVersion: 4 })).toBe('BADGE_CHANGED');
    expect(releaseRefusal({ ...base, sellerSuspended: true })).toBe('SELLER_SUSPENDED');
    expect(releaseRefusal({ ...base, loadingChecksPassed: false })).toBe('LOADING_CHECKS_PENDING');
    if (base.authorization === null) throw new Error('unreachable');
    expect(releaseRefusal({ ...base, authorization: { ...base.authorization, status: 'CONSUMED' } })).toBe('NO_AUTHORIZATION');
  });
  it('a failed or held shipment cannot be approved straight to L2', () => {
    expect(() => assertAssessmentTransition('FAILED', 'APPROVED_FOR_L2')).toThrow();
    expect(() => assertAssessmentTransition('ON_HOLD', 'DISPATCHED')).toThrow();
    expect(() => assertAssessmentTransition('DISPATCHED', 'APPROVED_FOR_L2')).toThrow();
  });
  it('the fingerprint changes with quantity and destination', () => {
    const one = scopeFingerprint({ sellerAccountId: 's', lines: [{ offerId: 'a', quantity: 2 }], packingList: null, destination: 'DE' });
    expect(scopeFingerprint({ sellerAccountId: 's', lines: [{ offerId: 'a', quantity: 3 }], packingList: null, destination: 'DE' })).not.toBe(one);
    expect(scopeFingerprint({ sellerAccountId: 's', lines: [{ offerId: 'a', quantity: 2 }], packingList: null, destination: 'FR' })).not.toBe(one);
  });
});

describe('documents', () => {
  it('a seller certificate never outlives its evidence', () => {
    const issued = new Date('2026-01-01T00:00:00Z');
    expect(certificateValidUntil(issued, 12, []).toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(certificateValidUntil(issued, 12, [new Date('2026-06-30T00:00:00Z')]).toISOString().slice(0, 10)).toBe('2026-06-30');
  });
  it('the waiver says no physical assessment is attested', () => {
    expect(waiverStatement('Gloviaa Mart')).toBe(
      'This shipment assessment was waived under the applicable Gloviaa Mart seller-badge policy. No physical shipment assessment is attested by this waiver.',
    );
  });
});
