/**
 * Category qualification and product compliance, requirement by requirement
 * (Audit Console, module A). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateCompliance,
  type CaseScope,
  type ComplianceDocumentFacts,
  type RequirementRule,
} from '../../src/domain/compliance-evaluation.js';
import { AUDIT_STAFF_ROLES, agencyConsoleKeys } from '../../src/domain/audit-console-permissions.js';

const MED = 'med-dept'; // the department
const IVC = 'iv-cannula'; // a category under it
const TOOLS = 'tools-dept';
const TODAY = '2026-10-06';

function rule(overrides: Partial<RequirementRule> = {}): RequirementRule {
  return {
    id: 'r1',
    code: 'IN-MD-MFG-LICENCE',
    ruleVersion: 1,
    name: 'Manufacturing licence',
    obligation: 'LEGAL',
    level: 'SELLER_CATEGORY',
    categoryIds: [MED],
    includeDescendants: true,
    supplyRoles: ['MANUFACTURER'],
    originCountries: ['IN'],
    destinationMarkets: [],
    riskClasses: [],
    applicability: 'APPLIES',
    expiryKind: 'DOCUMENT_EXPIRY',
    reviewMonths: null,
    ...overrides,
  };
}

function doc(overrides: Partial<ComplianceDocumentFacts> = {}): ComplianceDocumentFacts {
  return {
    id: 'd1',
    reviewStatus: 'APPROVED',
    requirementCodes: ['IN-MD-MFG-LICENCE'],
    categoryScopeIds: [MED],
    productScopeIds: [],
    factoryId: null,
    expiresOn: '2028-01-01',
    noExpiryReason: null,
    verifiedAt: '2026-09-01T00:00:00.000Z',
    verificationMethod: 'MANUAL_EVIDENCE',
    verificationOutcome: 'NOT_CHECKED',
    ...overrides,
  };
}

const scope = (overrides: Partial<CaseScope> = {}): CaseScope => ({
  level: 'SELLER_CATEGORY',
  categoryPath: [IVC, MED],
  productId: null,
  supplyRole: 'MANUFACTURER',
  destinationMarket: '',
  originCountry: 'IN',
  factoryId: null,
  riskClass: null,
  ...overrides,
});

const run = (rules: RequirementRule[], documents: ComplianceDocumentFacts[], s = scope(), determinations = {}) =>
  evaluateCompliance({ rules, scope: s, documents, determinations, today: TODAY });

describe('a qualification is exactly as wide as its scope', () => {
  it('is ready when an approved, in-scope, in-date document satisfies the rule', () => {
    const result = run([rule()], [doc()]);
    expect(result.ready).toBe(true);
    expect(result.outcomes[0]).toMatchObject({ state: 'SATISFIED', documentId: 'd1', validUntil: '2028-01-01' });
  });

  it('does not carry one category into an unrelated one', () => {
    const toolsRule = rule({ id: 'r2', code: 'TOOLS-RULE', categoryIds: [TOOLS] });
    // Qualified for medical devices on its own document...
    expect(run([rule(), toolsRule], [doc()]).ready).toBe(true);
    // ...and the same documents say nothing about tools.
    const tools = run([rule(), toolsRule], [doc()], scope({ categoryPath: ['hand-tools', TOOLS] }));
    expect(tools.ready).toBe(false);
    expect(tools.outcomes).toEqual([expect.objectContaining({ code: 'TOOLS-RULE', state: 'MISSING', blocking: true })]);
  });

  it('refuses a document whose scope does not cover the category, product or site', () => {
    expect(run([rule()], [doc({ categoryScopeIds: [TOOLS] })]).outcomes[0]?.state).toBe('WRONG_SCOPE');
    expect(run([rule()], [doc({ categoryScopeIds: [] })]).outcomes[0]?.state).toBe('WRONG_SCOPE');
    expect(run([rule()], [doc({ factoryId: 'factory-b' })], scope({ factoryId: 'factory-a' })).outcomes[0]?.state).toBe('WRONG_SCOPE');
    const product = rule({ level: 'PRODUCT' });
    expect(run([product], [doc({ productScopeIds: ['other-product'] })], scope({ level: 'PRODUCT', productId: 'p1' })).outcomes[0]?.state).toBe('WRONG_SCOPE');
  });

  it('refuses an expired document, and a document with no expiry and no reason', () => {
    expect(run([rule()], [doc({ expiresOn: '2026-01-01' })]).outcomes[0]?.state).toBe('EXPIRED');
    expect(run([rule()], [doc({ expiresOn: null, noExpiryReason: null })]).outcomes[0]?.state).toBe('WRONG_SCOPE');
    expect(run([rule()], [doc({ expiresOn: null, noExpiryReason: 'Valid while the retention fee is paid.' })]).outcomes[0]?.state).toBe('SATISFIED');
  });

  it('applies a periodic review interval even when the document never expires', () => {
    const periodic = rule({ expiryKind: 'PERIODIC_REVIEW', reviewMonths: 12 });
    const stale = run([periodic], [doc({ expiresOn: null, noExpiryReason: 'Retention fee.', verifiedAt: '2025-01-01T00:00:00.000Z' })]);
    expect(stale.outcomes[0]?.state).toBe('EXPIRED');
  });

  it('never counts a document that is not approved', () => {
    for (const status of ['SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'REJECTED', 'SUSPENDED', 'EXPIRED', 'DRAFT']) {
      expect(run([rule()], [doc({ reviewStatus: status })]).outcomes[0]?.state).toBe('PENDING_REVIEW');
    }
  });

  it('only applies a rule to the roles, origins, markets and device classes it names', () => {
    expect(run([rule()], [], scope({ supplyRole: 'DISTRIBUTOR' })).outcomes).toEqual([]);
    expect(run([rule()], [], scope({ originCountry: 'DE' })).outcomes).toEqual([]);
    const eu = rule({ code: 'EU-DOC', destinationMarkets: ['EU'], originCountries: [] });
    expect(run([eu], [], scope({ destinationMarket: 'IN' })).outcomes).toEqual([]);
    expect(run([eu], [], scope({ destinationMarket: 'EU' })).outcomes).toHaveLength(1);
    // A notified-body rule for higher classes does not reach a plain Class I product.
    const nb = rule({ code: 'EU-NB', level: 'PRODUCT', riskClasses: ['IIA', 'IIB', 'III'], originCountries: [] });
    expect(run([nb], [], scope({ level: 'PRODUCT', productId: 'p1', riskClass: 'CLASS_I' })).outcomes).toEqual([]);
    expect(run([nb], [], scope({ level: 'PRODUCT', productId: 'p1', riskClass: 'IIA' })).outcomes).toHaveLength(1);
  });
});

describe('uncertain applicability stays uncertain', () => {
  const unresolved = rule({ code: 'BORDERLINE', applicability: 'UNRESOLVED' });

  it('blocks approval until a reviewer decides, and still blocks a recorded "unresolved"', () => {
    expect(run([unresolved], [doc({ requirementCodes: ['BORDERLINE'] })]).outcomes[0]).toMatchObject({ state: 'NEEDS_DETERMINATION', blocking: true });
    const stillOpen = run([unresolved], [], scope(), { BORDERLINE: { decision: 'UNRESOLVED', reason: 'Drug-device status not settled.' } });
    expect(stillOpen.outcomes[0]).toMatchObject({ state: 'UNRESOLVED', blocking: true });
    expect(stillOpen.ready).toBe(false);
  });

  it('lets a reasoned "not applicable" through, and "applies" then needs the evidence', () => {
    expect(run([unresolved, rule()], [doc()], scope(), { BORDERLINE: { decision: 'NOT_APPLICABLE', reason: 'Not a drug-device combination.' } }).ready).toBe(true);
    const applies = run([unresolved], [], scope(), { BORDERLINE: { decision: 'APPLIES', reason: 'It is.' } });
    expect(applies.outcomes[0]).toMatchObject({ state: 'MISSING', blocking: true });
  });
});

describe('no approved rule is not a qualification', () => {
  it('is never "ready" when nothing approved applies, or only optional rules do', () => {
    expect(run([], [])).toMatchObject({ ready: false, noApprovedRules: true });
    const optional = rule({ obligation: 'OPTIONAL_QUALIFICATION' });
    const result = run([optional], []);
    expect(result.outcomes[0]).toMatchObject({ state: 'OPTIONAL_NOT_HELD', blocking: false });
    expect(result.ready).toBe(false);
  });
});

describe('who may do what in the console', () => {
  it('lets only a supervisor approve rules, and keeps inspectors and QA apart', () => {
    expect(AUDIT_STAFF_ROLES.SUPERVISOR).toContain('audit.rule.approve');
    expect(AUDIT_STAFF_ROLES.COMPLIANCE_REVIEWER).not.toContain('audit.rule.approve');
    expect(AUDIT_STAFF_ROLES.COMPLIANCE_REVIEWER).not.toContain('audit.release.request');
    const inspector = agencyConsoleKeys('INSPECTOR');
    const qa = agencyConsoleKeys('QA_REVIEWER');
    expect(inspector.has('inspection.job.perform')).toBe(true);
    expect(inspector.has('inspection.report.sign')).toBe(false);
    expect(qa.has('inspection.report.sign')).toBe(true);
    expect(qa.has('inspection.job.perform')).toBe(false);
    // No agency role holds a staff key.
    for (const role of ['AGENCY_ADMIN', 'COORDINATOR', 'INSPECTOR', 'QA_REVIEWER'] as const) {
      expect([...agencyConsoleKeys(role)].filter((key) => key.startsWith('audit.') && key !== 'audit.dashboard.read')).toEqual([]);
    }
  });
});
