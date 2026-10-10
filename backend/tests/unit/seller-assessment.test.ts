/**
 * Seller Assessment rules (domain/seller-assessment.ts), without a database:
 * turnover at the INR 30 crore boundary, eligible seller types and India-only
 * manufacture, score boundaries and rounding, minimum dimension ratings, CAPA
 * deadlines and blocking, the 23 checklist items and N/A, external certificate
 * problems, approval validity, reminders, independence and simulated steps.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECKLIST,
  DIMENSIONS,
  DRAFT_POLICY_DEFAULTS,
  applicationProblems,
  approvalValidUntil,
  canMoveApproval,
  canMoveAssessment,
  certProblems,
  checklistProblems,
  computeScore,
  dueReminders,
  findingBlocksRelease,
  findingDeadlines,
  isIndependentApprover,
  isSingleCountryCode,
  meetsAssessmentTurnover,
  mockStepModeProblem,
  policyConfigProblems,
  retentionYears,
  turnoverProblems,
  unmetPrerequisites,
  type ApplicationFacts,
} from '../../src/domain/seller-assessment.js';

const P = DRAFT_POLICY_DEFAULTS;
const MIN = 30_000_000_000n; // INR 300,000,000 in paise

const turnover = (amountMinor: bigint) => ({ amountMinor, currency: 'INR', measure: 'ENTITY_REVENUE_FROM_OPERATIONS_EX_GST' as const, basis: 'AUDITED_LATEST' as const, auditedStatementsEvidence: true, caConfirmationEvidence: true, precedingAuditEvidence: false });

function facts(over: Partial<ApplicationFacts> = {}): ApplicationFacts {
  return {
    applicantType: 'MANUFACTURER',
    entityCountry: 'IN',
    legalEntityComplete: true,
    addressesComplete: true,
    directors: 2,
    beneficialOwners: 1,
    signatoryNamed: true,
    delegationNeeded: false,
    delegationEvidence: false,
    panGstPresent: true,
    bankPresent: true,
    brands: [{ rightsEvidence: true }],
    facilities: [{ countryCode: 'IN', agreementEvidence: true, ownedByApplicant: true }],
    outsourced: [],
    auditAccessGranted: true,
    products: [{ madeInCountry: 'IN', countries: 1, channels: 1, facilityDeclared: true }],
    fulfilmentDeclared: true,
    insuranceDeclared: true,
    personalDataConsent: true,
    turnover: turnover(MIN),
    ...over,
  };
}

describe('turnover: at least INR 30 crore (= INR 300,000,000)', () => {
  it('refuses one paisa below, accepts exactly the minimum and above', () => {
    expect(meetsAssessmentTurnover(MIN - 1n, MIN)).toBe(false);
    expect(meetsAssessmentTurnover(MIN, MIN)).toBe(true);
    expect(meetsAssessmentTurnover(MIN + 1n, MIN)).toBe(true);
    expect(P.turnoverMinimumMinor).toBe('30000000000');
  });

  it('refuses group turnover, forecasts and unaudited GTV whatever the amount', () => {
    for (const measure of ['GROUP', 'FORECAST', 'UNAUDITED_GTV'] as const) {
      expect(turnoverProblems({ ...turnover(MIN * 10n), measure }, P)).toContain('TURNOVER_MEASURE_NOT_ALLOWED');
    }
  });

  it('needs audited statements and CA confirmation', () => {
    expect(turnoverProblems({ ...turnover(MIN), auditedStatementsEvidence: false, caConfirmationEvidence: false }, P)).toEqual(['CA_CONFIRMATION_MISSING', 'AUDITED_STATEMENTS_MISSING']);
  });

  it('the audit-not-yet-due exception changes the evidence, never the threshold', () => {
    const exception = { ...turnover(MIN - 1n), basis: 'PRECEDING_AUDIT_PLUS_CA_CERTIFIED' as const, auditedStatementsEvidence: false, precedingAuditEvidence: true };
    expect(turnoverProblems(exception, P)).toEqual(['TURNOVER_BELOW_MINIMUM']);
    expect(turnoverProblems({ ...exception, amountMinor: MIN }, P)).toEqual([]);
    expect(turnoverProblems({ ...exception, amountMinor: MIN, precedingAuditEvidence: false }, P)).toEqual(['PRECEDING_AUDIT_MISSING']);
  });
});

describe('eligibility', () => {
  it('a complete Indian manufacturer has no problems', () => {
    expect(applicationProblems(facts(), P)).toEqual([]);
  });

  it.each(['TRADER', 'UNAUTHORISED_DISTRIBUTOR', 'RESELLER', 'INDIVIDUAL', 'DROPSHIPPER'] as const)('excludes %s', (applicantType) => {
    expect(applicationProblems(facts({ applicantType }), P)).toContain('APPLICANT_TYPE_NOT_ELIGIBLE');
  });

  it('blocks foreign facilities, foreign subcontracting and foreign-made goods', () => {
    expect(applicationProblems(facts({ facilities: [{ countryCode: 'CN', agreementEvidence: true, ownedByApplicant: true }] }), P)).toContain('FACILITY_OUTSIDE_INDIA');
    expect(applicationProblems(facts({ outsourced: [{ countryCode: 'VN', critical: true }] }), P)).toContain('FOREIGN_SUBCONTRACTING');
    expect(applicationProblems(facts({ products: [{ madeInCountry: 'DE', countries: 1, channels: 1, facilityDeclared: true }] }), P)).toContain('PRODUCT_FOREIGN_MADE');
  });

  it('a brand owner needs agreements for facilities it does not own, and audit access', () => {
    const p = applicationProblems(facts({ applicantType: 'BRAND_OWNER', facilities: [{ countryCode: 'IN', agreementEvidence: false, ownedByApplicant: false }], auditAccessGranted: false }), P);
    expect(p).toEqual(expect.arrayContaining(['AGREEMENTS_MISSING', 'AUDIT_ACCESS_NOT_GRANTED']));
  });

  it('countries are single ISO codes, never a region', () => {
    expect(isSingleCountryCode('DE')).toBe(true);
    expect(isSingleCountryCode('EU')).toBe(false);
    expect(isSingleCountryCode('EUROPE')).toBe(false);
  });
});

describe('scoring', () => {
  const all = (r: number) => Object.fromEntries(DIMENSIONS.map((d) => [d.code, r]));

  it('uses the seven weights from the document, summing to 100', () => {
    expect(DIMENSIONS.map((d) => d.weight)).toEqual([15, 25, 20, 15, 10, 10, 5]);
  });

  it('all 4s is exactly 80 and eligible; never rounds 79.x up', () => {
    expect(computeScore(all(4), P)).toMatchObject({ display: '80.00', band: 'RELEASE_ELIGIBLE' });
    // 25-weight at 3, everything else 4: 80 - 5 = 75 -> remediation.
    const r = { ...all(4), PRODUCT_DESTINATION: 3 };
    expect(computeScore(r, P)).toMatchObject({ display: '75.00', band: 'REMEDIATION' });
    // 5-weight at 3, rest 4 -> 79.00: below 80 however it is displayed.
    expect(computeScore({ ...all(4), INTEGRITY_CAPA: 3 }, P)).toMatchObject({ display: '79.00', band: 'REMEDIATION' });
  });

  it('a high total with one dimension below 3 is not eligible', () => {
    const r = { ...all(5), INTEGRITY_CAPA: 2 };
    const s = computeScore(r, P);
    expect(s.scoreTimesFive / 5).toBeGreaterThanOrEqual(80);
    expect(s.band).toBe('REMEDIATION');
    expect(s.belowDimensionMinimum).toEqual(['INTEGRITY_CAPA']);
  });

  it('65 is remediation, below 65 is declined, unrated is incomplete', () => {
    expect(computeScore({ ...all(3), PRODUCT_DESTINATION: 4, MANUFACTURING_QUALITY: 4 }, P).band).toBe('REMEDIATION'); // 69
    expect(computeScore(all(3), P)).toMatchObject({ display: '60.00', band: 'DECLINED' });
    expect(computeScore({ IDENTITY: 5 }, P).band).toBe('INCOMPLETE');
  });
});

describe('findings', () => {
  const at = new Date('2026-10-01T00:00:00Z');
  it('deadlines: critical immediate, major plan 7 and closure 30, minor 60', () => {
    expect(findingDeadlines('CRITICAL', at, P).containmentDueAt).toEqual(at);
    expect(findingDeadlines('MAJOR', at, P).planDueAt?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(findingDeadlines('MAJOR', at, P).closureDueAt.toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(findingDeadlines('MINOR', at, P).closureDueAt.toISOString()).toBe('2026-11-30T00:00:00.000Z');
  });

  it('critical and major block release until verified closed; minor stays visible but does not block', () => {
    expect(findingBlocksRelease({ classification: 'CRITICAL', status: 'ACTION_SUBMITTED' })).toBe(true);
    expect(findingBlocksRelease({ classification: 'MAJOR', status: 'VERIFIED_CLOSED' })).toBe(false);
    expect(findingBlocksRelease({ classification: 'MINOR', status: 'OPEN' })).toBe(false);
  });
});

describe('checklist', () => {
  it('has all 23 items, C01..C23', () => {
    expect(CHECKLIST).toHaveLength(23);
    expect(CHECKLIST.map((c) => c.code)).toEqual(Array.from({ length: 23 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`));
  });

  it('untouched items are unreviewed; N/A without approval does not count', () => {
    const now = new Date();
    const problems = checklistProblems([{ code: 'C05', outcome: 'NOT_APPLICABLE', naApprovedByUserId: null, expiresOn: null }], now);
    expect(problems.find((p) => p.code === 'C01')?.problem).toBe('UNREVIEWED');
    expect(problems.find((p) => p.code === 'C05')?.problem).toBe('NA_NOT_APPROVED');
  });

  it('mandatory items may never be N/A', () => {
    for (const code of ['C03', 'C07', 'C08', 'C15', 'C16', 'C23']) expect(CHECKLIST.find((c) => c.code === code)?.naAllowed).toBe(false);
  });
});

describe('external certification', () => {
  const now = new Date('2026-10-09T00:00:00Z');
  const ok = { status: 'AUTHENTICATED' as const, appointedByGloviaa: true, accreditationVerified: true, independenceVerified: true, authenticityVerified: true, expiresOn: new Date('2027-06-01'), facilityIds: ['F1'], productKeys: ['offer:A'] };
  it.each([
    ['missing', null, 'CERT_MISSING'],
    ['unauthenticated (seller upload only)', { ...ok, status: 'ISSUED_UNVERIFIED' as const, authenticityVerified: false }, 'CERT_NOT_AUTHENTICATED'],
    ['withdrawn', { ...ok, status: 'WITHDRAWN' as const }, 'CERT_WITHDRAWN'],
    ['expired', { ...ok, expiresOn: new Date('2026-10-01') }, 'CERT_EXPIRED'],
    ['counterfeit body (not verified)', { ...ok, accreditationVerified: false }, 'CERT_BODY_NOT_VERIFIED'],
  ])('%s', (_label, cert, problem) => {
    expect(certProblems(cert, { facilityId: 'F1', productKey: 'offer:A' }, now)).toContain(problem);
  });

  it('out of scope for the site or product', () => {
    expect(certProblems(ok, { facilityId: 'F2', productKey: 'offer:A' }, now)).toEqual(['CERT_OUT_OF_SCOPE']);
    expect(certProblems(ok, { facilityId: 'F1', productKey: 'offer:B' }, now)).toEqual(['CERT_OUT_OF_SCOPE']);
    expect(certProblems(ok, { facilityId: 'F1', productKey: 'offer:A' }, now)).toEqual([]);
  });
});

describe('validity and surveillance', () => {
  it('never more than twelve months, cut short by an earlier expiry', () => {
    const issued = new Date('2026-10-09T10:00:00Z');
    expect(approvalValidUntil(issued, 12, []).toISOString()).toBe('2027-10-09T10:00:00.000Z');
    expect(approvalValidUntil(issued, 12, [new Date('2027-03-01T00:00:00Z'), null]).toISOString()).toBe('2027-03-01T00:00:00.000Z');
  });

  it('reminders at 90, 60 and 30 days, each once', () => {
    const expires = new Date('2027-01-31T00:00:00Z');
    expect(dueReminders(expires, new Date('2026-10-01T00:00:00Z'), [90, 60, 30], [])).toEqual([]);
    expect(dueReminders(expires, new Date('2026-11-05T00:00:00Z'), [90, 60, 30], [])).toEqual([90]);
    expect(dueReminders(expires, new Date('2027-01-05T00:00:00Z'), [90, 60, 30], [90, 60])).toEqual([30]);
    expect(dueReminders(expires, new Date('2027-02-01T00:00:00Z'), [90, 60, 30], [])).toEqual([]);
  });
});

describe('controls', () => {
  it('release approver must not be a participant', () => {
    expect(isIndependentApprover('u1', ['u2', 'u3'])).toBe(true);
    expect(isIndependentApprover('u2', ['u2', 'u3'])).toBe(false);
  });

  it('gate prerequisites', () => {
    expect(unmetPrerequisites(8, { 1: 'PASSED', 2: 'PASSED' })).toEqual([3, 4, 5, 6, 7]);
    expect(unmetPrerequisites(4, { 1: 'PASSED', 3: 'IN_PROGRESS' })).toEqual([3]);
  });

  it('a disabled integration cannot be marked provider-verified', () => {
    expect(mockStepModeProblem({ mode: 'PROVIDER_VERIFIED', integrationEnabled: false })).toBe('INTEGRATION_NOT_ENABLED');
    expect(mockStepModeProblem({ mode: 'SIMULATED', integrationEnabled: false })).toBeNull();
  });

  it('a suspended approval is never moved back to active', () => {
    expect(canMoveApproval('SUSPENDED', 'ACTIVE')).toBe(false);
    expect(canMoveAssessment('RELEASED', 'IN_REVIEW')).toBe(false);
  });

  it('a policy version cannot relax the document past its limits', () => {
    expect(policyConfigProblems({ ...P })).toEqual([]);
    expect(policyConfigProblems({ ...P, releaseScoreMinimum: 70 })).toContain('SCORE_RANGE');
    expect(policyConfigProblems({ ...P, approvalValidityMonths: 18 })).toContain('VALIDITY_RANGE');
    expect(policyConfigProblems({ ...P, incidentReportHours: 48 })).toContain('INCIDENT_RANGE');
    expect(policyConfigProblems({ ...P, appealWindowCalendarDays: 3 })).toContain('APPEAL_RANGE');
  });

  it('retention: general default 7 years; identity, DSA and INFORM need configuring', () => {
    expect(retentionYears('GENERAL_ASSESSMENT', P, {})).toBe(7);
    expect(retentionYears('IDENTITY', P, {})).toBeNull();
    expect(retentionYears('EU_DSA_TRADER', P, {})).toBeNull();
    expect(retentionYears('US_INFORM', P, { US_INFORM: 3 })).toBe(3);
  });
});
