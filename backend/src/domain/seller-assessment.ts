/**
 * Seller Assessment and Onboarding: the rules, pure, so the services, the
 * worker and the tests all ask the same question the same way.
 *
 * Source: "Seller Assessment and Onboarding Process and Checklist", Version
 * 1.0, prepared 9 October 2026, effective date blank. The document says its
 * commercial and operational defaults are PROPOSED and bind only once adopted
 * and disclosed. So every number here is a versioned policy default, never a
 * constant a service may assume is in force:
 *
 *   - COMMERCIAL defaults (score thresholds, CAPA deadlines, validity months,
 *     appeal windows, service targets) may be changed by an adopted policy
 *     version or a documented commercial exception.
 *   - MANDATORY controls (hard gates, hard stops, current independent
 *     certification, exact scope, critical/major closure, independent release)
 *     are not policy numbers at all. No version, exception or badge waives
 *     them, and nothing in this file lets one.
 *
 * "Software implemented" is not "real assessment completed": every record the
 * software keeps says who recorded it, and a simulated step says it was
 * simulated.
 */

// --- Policy -------------------------------------------------------------------

export const POLICY_SOURCE_VERSION = '1.0';

export interface AssessmentPolicyConfig {
  /** Minor units (paise). INR 30 crore = 30,000,000,000. "At least". */
  turnoverMinimumMinor: string;
  turnoverCurrency: string;
  releaseScoreMinimum: number;
  remediationScoreMinimum: number;
  dimensionRatingMinimum: number;
  adminReviewTargetBusinessDays: number;
  majorPlanDays: number;
  majorClosureDays: number;
  minorClosureDays: number;
  approvalValidityMonths: number;
  reminderDaysBeforeExpiry: number[];
  appealWindowCalendarDays: number;
  appealTargetBusinessDays: number;
  incidentReportHours: number;
  retentionYearsDefault: number;
  /** Category id -> surveillance interval in months. '*' is the fallback. */
  surveillanceMonthsByCategory: Record<string, number>;
  sanctionsRescreenDays: number;
}

/** The document's proposed defaults. A DRAFT until somebody adopts a version. */
export const DRAFT_POLICY_DEFAULTS: Readonly<AssessmentPolicyConfig> = Object.freeze({
  turnoverMinimumMinor: '30000000000',
  turnoverCurrency: 'INR',
  releaseScoreMinimum: 80,
  remediationScoreMinimum: 65,
  dimensionRatingMinimum: 3,
  adminReviewTargetBusinessDays: 5,
  majorPlanDays: 7,
  majorClosureDays: 30,
  minorClosureDays: 60,
  approvalValidityMonths: 12,
  reminderDaysBeforeExpiry: [90, 60, 30],
  appealWindowCalendarDays: 7,
  appealTargetBusinessDays: 10,
  incidentReportHours: 24,
  retentionYearsDefault: 7,
  surveillanceMonthsByCategory: { '*': 12 },
  sanctionsRescreenDays: 30,
});

/** Which config keys are commercial defaults. Everything not listed is not configurable at all. */
export const COMMERCIAL_DEFAULT_KEYS: readonly (keyof AssessmentPolicyConfig)[] = [
  'releaseScoreMinimum',
  'remediationScoreMinimum',
  'dimensionRatingMinimum',
  'adminReviewTargetBusinessDays',
  'majorPlanDays',
  'majorClosureDays',
  'minorClosureDays',
  'approvalValidityMonths',
  'reminderDaysBeforeExpiry',
  'appealWindowCalendarDays',
  'appealTargetBusinessDays',
  'incidentReportHours',
  'surveillanceMonthsByCategory',
  'sanctionsRescreenDays',
  'turnoverMinimumMinor',
  'turnoverCurrency',
  'retentionYearsDefault',
];

export type PolicyProblem =
  | 'TURNOVER_MALFORMED'
  | 'SCORE_ORDER'
  | 'SCORE_RANGE'
  | 'DIMENSION_RANGE'
  | 'DEADLINE_RANGE'
  | 'VALIDITY_RANGE'
  | 'REMINDERS'
  | 'APPEAL_RANGE'
  | 'INCIDENT_RANGE'
  | 'RETENTION_RANGE'
  | 'SURVEILLANCE';

/**
 * A config a version may carry. Limits stop a version quietly relaxing a
 * control past what the document allows: validity can only be shortened, an
 * incident deadline only tightened, and the score floor can only rise.
 */
export function policyConfigProblems(config: AssessmentPolicyConfig): PolicyProblem[] {
  const out: PolicyProblem[] = [];
  const int = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  if (!/^\d{1,18}$/.test(config.turnoverMinimumMinor) || !/^[A-Z]{3}$/.test(config.turnoverCurrency)) out.push('TURNOVER_MALFORMED');
  if (!int(config.releaseScoreMinimum, 80, 100) || !int(config.remediationScoreMinimum, 0, 100)) out.push('SCORE_RANGE');
  if (config.remediationScoreMinimum > config.releaseScoreMinimum) out.push('SCORE_ORDER');
  if (!int(config.dimensionRatingMinimum, 3, 5)) out.push('DIMENSION_RANGE');
  if (!int(config.majorPlanDays, 1, 7) || !int(config.majorClosureDays, 1, 30) || !int(config.minorClosureDays, 1, 60) || !int(config.adminReviewTargetBusinessDays, 1, 60)) out.push('DEADLINE_RANGE');
  if (!int(config.approvalValidityMonths, 1, 12)) out.push('VALIDITY_RANGE');
  const r = config.reminderDaysBeforeExpiry;
  if (!Array.isArray(r) || r.length === 0 || r.length > 6 || !r.every((d) => int(d, 1, 365)) || new Set(r).size !== r.length) out.push('REMINDERS');
  if (!int(config.appealWindowCalendarDays, 7, 60) || !int(config.appealTargetBusinessDays, 1, 60)) out.push('APPEAL_RANGE');
  if (!int(config.incidentReportHours, 1, 24)) out.push('INCIDENT_RANGE');
  if (!int(config.retentionYearsDefault, 1, 30) || !int(config.sanctionsRescreenDays, 1, 365)) out.push('RETENTION_RANGE');
  const s = config.surveillanceMonthsByCategory;
  if (typeof s !== 'object' || s === null || !int(s['*'], 1, 12) || !Object.values(s).every((m) => int(m, 1, 12))) out.push('SURVEILLANCE');
  return out;
}

// --- Seller types and turnover ------------------------------------------------

export type ApplicantType =
  | 'MANUFACTURER'
  | 'BRAND_OWNER'
  | 'TRADER'
  | 'UNAUTHORISED_DISTRIBUTOR'
  | 'RESELLER'
  | 'INDIVIDUAL'
  | 'DROPSHIPPER';

export const ELIGIBLE_APPLICANT_TYPES: readonly ApplicantType[] = ['MANUFACTURER', 'BRAND_OWNER'];

/** At least the minimum (policy v1.0: "at least INR 30 crore"). Integers only. */
export function meetsAssessmentTurnover(amountMinor: bigint, minimumMinor: bigint): boolean {
  return amountMinor >= minimumMinor;
}

export type TurnoverBasis = 'AUDITED_LATEST' | 'PRECEDING_AUDIT_PLUS_CA_CERTIFIED';

export interface TurnoverFacts {
  amountMinor: bigint | null;
  currency: string | null;
  /** Revenue from operations of the applicant entity, excluding GST. Anything else is refused. */
  measure: 'ENTITY_REVENUE_FROM_OPERATIONS_EX_GST' | 'GROUP' | 'FORECAST' | 'UNAUDITED_GTV' | null;
  basis: TurnoverBasis | null;
  auditedStatementsEvidence: boolean;
  caConfirmationEvidence: boolean;
  /** For the exception: the preceding year's audited statements. */
  precedingAuditEvidence: boolean;
}

export type TurnoverProblem =
  | 'TURNOVER_MISSING'
  | 'TURNOVER_CURRENCY'
  | 'TURNOVER_MEASURE_NOT_ALLOWED'
  | 'TURNOVER_BELOW_MINIMUM'
  | 'AUDITED_STATEMENTS_MISSING'
  | 'CA_CONFIRMATION_MISSING'
  | 'PRECEDING_AUDIT_MISSING';

/**
 * The turnover rule. The audit-not-yet-due exception changes the EVIDENCE, never
 * the threshold: the CA-certified current figure must still meet the minimum.
 */
export function turnoverProblems(facts: TurnoverFacts, policy: Pick<AssessmentPolicyConfig, 'turnoverMinimumMinor' | 'turnoverCurrency'>): TurnoverProblem[] {
  const out: TurnoverProblem[] = [];
  if (facts.amountMinor === null) return ['TURNOVER_MISSING'];
  if (facts.currency !== policy.turnoverCurrency) out.push('TURNOVER_CURRENCY');
  if (facts.measure !== 'ENTITY_REVENUE_FROM_OPERATIONS_EX_GST') out.push('TURNOVER_MEASURE_NOT_ALLOWED');
  if (!meetsAssessmentTurnover(facts.amountMinor, BigInt(policy.turnoverMinimumMinor))) out.push('TURNOVER_BELOW_MINIMUM');
  if (!facts.caConfirmationEvidence) out.push('CA_CONFIRMATION_MISSING');
  if (facts.basis === 'PRECEDING_AUDIT_PLUS_CA_CERTIFIED') {
    if (!facts.precedingAuditEvidence) out.push('PRECEDING_AUDIT_MISSING');
  } else if (!facts.auditedStatementsEvidence) {
    out.push('AUDITED_STATEMENTS_MISSING');
  }
  return out;
}

// --- The application ----------------------------------------------------------

export type ApplicationProblem =
  | TurnoverProblem
  | 'APPLICANT_TYPE_NOT_ELIGIBLE'
  | 'NOT_INDIAN_ENTITY'
  | 'LEGAL_ENTITY_INCOMPLETE'
  | 'ADDRESSES_INCOMPLETE'
  | 'DIRECTORS_MISSING'
  | 'BENEFICIAL_OWNERS_MISSING'
  | 'SIGNATORY_MISSING'
  | 'DELEGATION_MISSING'
  | 'TAX_IDS_MISSING'
  | 'BANK_MISSING'
  | 'BRANDS_MISSING'
  | 'BRAND_RIGHTS_MISSING'
  | 'FACILITIES_MISSING'
  | 'FACILITY_OUTSIDE_INDIA'
  | 'FOREIGN_SUBCONTRACTING'
  | 'AGREEMENTS_MISSING'
  | 'AUDIT_ACCESS_NOT_GRANTED'
  | 'PRODUCTS_MISSING'
  | 'PRODUCT_FOREIGN_MADE'
  | 'PRODUCT_SCOPE_INCOMPLETE'
  | 'FULFILMENT_MISSING'
  | 'INSURANCE_MISSING'
  | 'CONSENT_MISSING';

export interface ApplicationFacts {
  applicantType: ApplicantType | null;
  entityCountry: string | null;
  legalEntityComplete: boolean;
  addressesComplete: boolean;
  directors: number;
  beneficialOwners: number;
  signatoryNamed: boolean;
  /** True when the signatory is not a director and so needs a delegation. */
  delegationNeeded: boolean;
  delegationEvidence: boolean;
  panGstPresent: boolean;
  bankPresent: boolean;
  brands: { rightsEvidence: boolean }[];
  facilities: { countryCode: string; agreementEvidence: boolean; ownedByApplicant: boolean }[];
  outsourced: { countryCode: string; critical: boolean }[];
  auditAccessGranted: boolean;
  products: { madeInCountry: string; countries: number; channels: number; facilityDeclared: boolean }[];
  fulfilmentDeclared: boolean;
  insuranceDeclared: boolean;
  personalDataConsent: boolean;
  turnover: TurnoverFacts;
}

/** Everything Gate 1 needs. An incomplete file is returned for correction, never traded. */
export function applicationProblems(f: ApplicationFacts, policy: AssessmentPolicyConfig): ApplicationProblem[] {
  const out: ApplicationProblem[] = [];
  if (f.applicantType === null || !ELIGIBLE_APPLICANT_TYPES.includes(f.applicantType)) out.push('APPLICANT_TYPE_NOT_ELIGIBLE');
  if (f.entityCountry !== 'IN') out.push('NOT_INDIAN_ENTITY');
  if (!f.legalEntityComplete) out.push('LEGAL_ENTITY_INCOMPLETE');
  if (!f.addressesComplete) out.push('ADDRESSES_INCOMPLETE');
  if (f.directors === 0) out.push('DIRECTORS_MISSING');
  if (f.beneficialOwners === 0) out.push('BENEFICIAL_OWNERS_MISSING');
  if (!f.signatoryNamed) out.push('SIGNATORY_MISSING');
  if (f.delegationNeeded && !f.delegationEvidence) out.push('DELEGATION_MISSING');
  if (!f.panGstPresent) out.push('TAX_IDS_MISSING');
  if (!f.bankPresent) out.push('BANK_MISSING');
  if (f.brands.length === 0) out.push('BRANDS_MISSING');
  if (f.brands.some((b) => !b.rightsEvidence)) out.push('BRAND_RIGHTS_MISSING');
  if (f.facilities.length === 0) out.push('FACILITIES_MISSING');
  if (f.facilities.some((x) => x.countryCode !== 'IN')) out.push('FACILITY_OUTSIDE_INDIA');
  if (f.outsourced.some((x) => x.countryCode !== 'IN')) out.push('FOREIGN_SUBCONTRACTING');
  // A brand owner remains accountable for outsourced manufacture: every
  // facility it does not own needs an enforceable manufacturing/quality agreement.
  if (f.facilities.some((x) => !x.ownedByApplicant && !x.agreementEvidence)) out.push('AGREEMENTS_MISSING');
  if (!f.auditAccessGranted) out.push('AUDIT_ACCESS_NOT_GRANTED');
  if (f.products.length === 0) out.push('PRODUCTS_MISSING');
  if (f.products.some((p) => p.madeInCountry !== 'IN')) out.push('PRODUCT_FOREIGN_MADE');
  if (f.products.some((p) => p.countries === 0 || p.channels === 0 || !p.facilityDeclared)) out.push('PRODUCT_SCOPE_INCOMPLETE');
  if (!f.fulfilmentDeclared) out.push('FULFILMENT_MISSING');
  if (!f.insuranceDeclared) out.push('INSURANCE_MISSING');
  if (!f.personalDataConsent) out.push('CONSENT_MISSING');
  out.push(...turnoverProblems(f.turnover, policy));
  return out;
}

/** Problems that make the applicant ineligible under this policy, rather than merely incomplete. */
export const INELIGIBLE_PROBLEMS: ReadonlySet<ApplicationProblem> = new Set([
  'APPLICANT_TYPE_NOT_ELIGIBLE',
  'NOT_INDIAN_ENTITY',
  'FACILITY_OUTSIDE_INDIA',
  'FOREIGN_SUBCONTRACTING',
  'PRODUCT_FOREIGN_MADE',
  'TURNOVER_BELOW_MINIMUM',
  'TURNOVER_MEASURE_NOT_ALLOWED',
]);

// --- Gates --------------------------------------------------------------------

export const GATES = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type GateNumber = (typeof GATES)[number];

export type GateStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'CORRECTION_REQUESTED' | 'PASSED' | 'FAILED';

/** Who decides each gate. A key is a capability, not a person. */
export const GATE_CAPABILITY: Readonly<Record<GateNumber, AssessmentCapability>> = Object.freeze({
  1: 'ASSESS',
  2: 'FINANCE',
  3: 'REGULATORY',
  4: 'ASSESS',
  5: 'ASSESS',
  6: 'ASSESS',
  7: 'LEGAL',
  8: 'RELEASE',
});

/** Gate N may be decided only after these have passed. Gate 4 onward follow classification. */
export const GATE_PREREQUISITES: Readonly<Record<GateNumber, readonly GateNumber[]>> = Object.freeze({
  1: [],
  2: [1],
  3: [1],
  4: [1, 3],
  5: [1, 3],
  6: [4],
  7: [1, 2],
  8: [1, 2, 3, 4, 5, 6, 7],
});

export function unmetPrerequisites(gate: GateNumber, statuses: Partial<Record<GateNumber, GateStatus>>): GateNumber[] {
  return GATE_PREREQUISITES[gate].filter((g) => statuses[g] !== 'PASSED');
}

// --- Capabilities and separation of duties -----------------------------------

/**
 * Scoped assessment capabilities. Granted to Audit Console staff on top of
 * their role; one person may hold several. Holding a capability says what a
 * person MAY do; independence is checked against what they actually did.
 */
export type AssessmentCapability =
  | 'HEAD_OF_ASSURANCE'
  | 'ASSESS'
  | 'REGULATORY'
  | 'FINANCE'
  | 'OPERATIONS'
  | 'LEGAL'
  | 'RELEASE'
  | 'APPEAL_REVIEW';

export const ASSESSMENT_CAPABILITIES: readonly AssessmentCapability[] = ['HEAD_OF_ASSURANCE', 'ASSESS', 'REGULATORY', 'FINANCE', 'OPERATIONS', 'LEGAL', 'RELEASE', 'APPEAL_REVIEW'];

/**
 * Event kinds that make somebody a participant in the assessment decision.
 * A release approver who did any of these on the same assessment is not
 * independent of it - whatever capabilities they hold.
 */
export const DECISION_EVENT_KINDS: ReadonlySet<string> = new Set([
  'GATE_DECIDED',
  'CHECKLIST_REVIEWED',
  'CHECKLIST_NA_APPROVED',
  'SCORE_RATED',
  'FINDING_RAISED',
  'FINDING_CLOSED',
  'SPECIALIST_REVIEWED',
  'SCOPE_CLASSIFIED',
  'CERTIFICATION_RECORDED',
  'CERTIFICATION_AUTHENTICATED',
  'WORKPAPER_RECORDED',
  'RECOMMENDED_FOR_RELEASE',
  'DECISION_DECLINED',
  'DECISION_REMEDIATION',
  'DECISION_REASSESS',
  'HARD_STOP_RECORDED',
]);

export function isIndependentApprover(approverUserId: string, participantUserIds: Iterable<string>): boolean {
  for (const id of participantUserIds) if (id === approverUserId) return false;
  return true;
}

// --- Checklist (Section 8, all 23 items, original meaning) --------------------

export interface ChecklistItemDef {
  code: string;
  gate: GateNumber;
  /** Text from the document, verbatim apart from punctuation. */
  text: string;
  /** Mandatory items can never be marked N/A. */
  naAllowed: boolean;
  /** Whether an expiry date is expected when Pass is recorded. */
  expiryExpected: boolean;
}

export const CHECKLIST: readonly ChecklistItemDef[] = Object.freeze([
  { code: 'C01', gate: 2, text: 'Indian legal entity registration and registered and operating addresses verified.', naAllowed: false, expiryExpected: false },
  { code: 'C02', gate: 1, text: 'Manufacturer or brand owner status established and every actual production facility declared.', naAllowed: false, expiryExpected: false },
  { code: 'C03', gate: 2, text: 'Turnover at least INR 30 crore verified for the applicant entity and relevant financial year.', naAllowed: false, expiryExpected: true },
  { code: 'C04', gate: 2, text: 'Audited accounts, CA confirmation, solvency and credit references reviewed.', naAllowed: false, expiryExpected: false },
  { code: 'C05', gate: 2, text: 'PAN, GST, IEC, export capability and product-specific licences verified where applicable.', naAllowed: true, expiryExpected: true },
  { code: 'C06', gate: 2, text: 'Beneficial owners, directors, authorised signatory and delegation verified.', naAllowed: false, expiryExpected: false },
  { code: 'C07', gate: 2, text: 'Bank beneficiary matches seller entity and account independently confirmed.', naAllowed: false, expiryExpected: false },
  { code: 'C08', gate: 2, text: 'Sanctions, restricted-party, adverse integrity and conflict checks resolved.', naAllowed: false, expiryExpected: true },
  { code: 'C09', gate: 1, text: 'Trademark ownership, manufacturing agreements and intellectual-property rights established.', naAllowed: false, expiryExpected: true },
  { code: 'C10', gate: 4, text: 'Site audit completed for every facility and outsourced critical process.', naAllowed: false, expiryExpected: false },
  { code: 'C11', gate: 4, text: 'Quality system, calibration, traceability, segregation and recall test reviewed.', naAllowed: false, expiryExpected: false },
  { code: 'C12', gate: 4, text: 'Samples independently selected, sealed, shipped and tested to recorded criteria.', naAllowed: false, expiryExpected: false },
  { code: 'C13', gate: 3, text: 'Product composition, intended use, classifications and destination requirements recorded.', naAllowed: false, expiryExpected: false },
  { code: 'C14', gate: 3, text: 'Regulatory authorisations, technical documentation, labels, warnings and local actors validated.', naAllowed: true, expiryExpected: true },
  { code: 'C15', gate: 5, text: 'External body competence, accreditation and independence verified.', naAllowed: false, expiryExpected: true },
  { code: 'C16', gate: 5, text: 'External certificate independently authenticated and scope confirmed.', naAllowed: false, expiryExpected: true },
  { code: 'C17', gate: 6, text: 'Critical and major findings closed with effectiveness evidence.', naAllowed: true, expiryExpected: false },
  { code: 'C18', gate: 2, text: 'Product liability, recall, cargo and operational coverage reviewed as applicable.', naAllowed: true, expiryExpected: true },
  { code: 'C19', gate: 3, text: 'Approved country importer route and broker authority defined.', naAllowed: true, expiryExpected: false },
  { code: 'C20', gate: 7, text: 'Seller terms, agreement, fees, logistics and payout mandates signed.', naAllowed: false, expiryExpected: false },
  { code: 'C21', gate: 7, text: 'Stock capacity, lead times, dispatch, packaging and after-sales service confirmed.', naAllowed: false, expiryExpected: false },
  { code: 'C22', gate: 7, text: 'Mock order and recall traceability exercise completed.', naAllowed: false, expiryExpected: false },
  { code: 'C23', gate: 8, text: 'Human release approval and system purchase gate independently checked.', naAllowed: false, expiryExpected: false },
]);

export type ChecklistOutcome = 'UNREVIEWED' | 'PASS' | 'FAIL' | 'NOT_APPLICABLE';

export interface ChecklistRow {
  code: string;
  outcome: ChecklistOutcome;
  naApprovedByUserId: string | null;
  expiresOn: Date | null;
}

export type ChecklistProblem = { code: string; problem: 'UNREVIEWED' | 'FAILED' | 'NA_NOT_APPROVED' | 'EXPIRED' };

/** Release needs every item Pass, or N/A approved by a second person. Untouched stays unreviewed. */
export function checklistProblems(rows: readonly ChecklistRow[], now: Date, exceptCodes: readonly string[] = []): ChecklistProblem[] {
  const out: ChecklistProblem[] = [];
  for (const item of CHECKLIST) {
    if (exceptCodes.includes(item.code)) continue;
    const row = rows.find((r) => r.code === item.code);
    if (row === undefined || row.outcome === 'UNREVIEWED') out.push({ code: item.code, problem: 'UNREVIEWED' });
    else if (row.outcome === 'FAIL') out.push({ code: item.code, problem: 'FAILED' });
    else if (row.outcome === 'NOT_APPLICABLE' && row.naApprovedByUserId === null) out.push({ code: item.code, problem: 'NA_NOT_APPROVED' });
    else if (row.expiresOn !== null && row.expiresOn.getTime() <= now.getTime()) out.push({ code: item.code, problem: 'EXPIRED' });
  }
  return out;
}

// --- Scoring (Section 4) ------------------------------------------------------

export const DIMENSIONS = [
  { code: 'IDENTITY', weight: 15, label: 'Identity, ownership and eligibility', evidence: 'Valid legal entity, beneficial ownership and turnover' },
  { code: 'PRODUCT_DESTINATION', weight: 25, label: 'Product and destination conformity', evidence: 'Regulatory evidence for exact SKU and market' },
  { code: 'MANUFACTURING_QUALITY', weight: 20, label: 'Manufacturing and quality systems', evidence: 'Site audit, process control and traceability' },
  { code: 'SAMPLE_TESTING', weight: 15, label: 'Sample performance and test evidence', evidence: 'Controlled samples and competent laboratory results' },
  { code: 'FINANCIAL_INSURANCE', weight: 10, label: 'Financial capacity and insurance', evidence: 'Solvency, bank verification and coverage' },
  { code: 'FULFILMENT_SERVICE', weight: 10, label: 'Fulfilment and service capability', evidence: 'Capacity, stock, packaging, logistics and support' },
  { code: 'INTEGRITY_CAPA', weight: 5, label: 'Integrity and corrective action', evidence: 'Authentic records, references and effective closure' },
] as const;

export type DimensionCode = (typeof DIMENSIONS)[number]['code'];

export type ScoreBand = 'INCOMPLETE' | 'RELEASE_ELIGIBLE' | 'REMEDIATION' | 'DECLINED';

export interface ScoreResult {
  /** Exact score x 5 (an integer 0..500), so no rounding can lift a failing score. */
  scoreTimesFive: number;
  /** For display only: two decimals, truncated - never rounded up. */
  display: string;
  band: ScoreBand;
  belowDimensionMinimum: DimensionCode[];
  unrated: DimensionCode[];
}

/**
 * Weighted contribution = weight x rating / 5. The sum is kept times five as
 * an integer and compared against threshold x 5, so 79.8 is never "80".
 */
export function computeScore(ratings: Partial<Record<DimensionCode, number>>, policy: Pick<AssessmentPolicyConfig, 'releaseScoreMinimum' | 'remediationScoreMinimum' | 'dimensionRatingMinimum'>): ScoreResult {
  let total = 0;
  const unrated: DimensionCode[] = [];
  const low: DimensionCode[] = [];
  for (const d of DIMENSIONS) {
    const r = ratings[d.code];
    if (r === undefined || !Number.isInteger(r) || r < 0 || r > 5) {
      unrated.push(d.code);
      continue;
    }
    total += d.weight * r;
    if (r < policy.dimensionRatingMinimum) low.push(d.code);
  }
  const whole = Math.floor(total / 5);
  const hundredths = Math.floor(((total % 5) * 100) / 5);
  const display = `${String(whole)}.${String(hundredths).padStart(2, '0')}`;
  let band: ScoreBand;
  if (unrated.length > 0) band = 'INCOMPLETE';
  else if (total >= policy.releaseScoreMinimum * 5 && low.length === 0) band = 'RELEASE_ELIGIBLE';
  else if (total >= policy.remediationScoreMinimum * 5) band = 'REMEDIATION';
  else band = 'DECLINED';
  return { scoreTimesFive: total, display, band, belowDimensionMinimum: low, unrated };
}

// --- Findings / CAPA (Section 2 Gate 6 and Section 10) -------------------------

export type FindingClass = 'CRITICAL' | 'MAJOR' | 'MINOR';
export type FindingStatus = 'OPEN' | 'CONTAINED' | 'PLAN_SUBMITTED' | 'ACTION_SUBMITTED' | 'VERIFIED_CLOSED' | 'REOPENED';

export function findingDeadlines(cls: FindingClass, raisedAt: Date, policy: Pick<AssessmentPolicyConfig, 'majorPlanDays' | 'majorClosureDays' | 'minorClosureDays'>): { containmentDueAt: Date | null; planDueAt: Date | null; closureDueAt: Date } {
  const add = (days: number) => new Date(raisedAt.getTime() + days * 86_400_000);
  if (cls === 'CRITICAL') return { containmentDueAt: raisedAt, planDueAt: raisedAt, closureDueAt: raisedAt };
  if (cls === 'MAJOR') return { containmentDueAt: null, planDueAt: add(policy.majorPlanDays), closureDueAt: add(policy.majorClosureDays) };
  return { containmentDueAt: null, planDueAt: null, closureDueAt: add(policy.minorClosureDays) };
}

/** Critical and major findings block release until an auditor verifies closure. A deadline never authorises supply. */
export function findingBlocksRelease(f: { classification: FindingClass; status: FindingStatus }): boolean {
  return f.classification !== 'MINOR' && f.status !== 'VERIFIED_CLOSED';
}

/** What closure needs: containment for critical, root cause, action and effectiveness evidence for everything. */
export function closureProblems(f: {
  classification: FindingClass;
  containment: string | null;
  rootCause: string | null;
  correctiveAction: string | null;
  preventiveAction: string | null;
  closureEvidenceCount: number;
  effectivenessVerification: string | null;
}): string[] {
  const out: string[] = [];
  if (f.classification === 'CRITICAL' && (f.containment ?? '').trim() === '') out.push('CONTAINMENT_REQUIRED');
  if ((f.rootCause ?? '').trim() === '') out.push('ROOT_CAUSE_REQUIRED');
  if ((f.correctiveAction ?? '').trim() === '') out.push('CORRECTIVE_ACTION_REQUIRED');
  if ((f.preventiveAction ?? '').trim() === '') out.push('PREVENTIVE_ACTION_REQUIRED');
  if (f.closureEvidenceCount === 0) out.push('CLOSURE_EVIDENCE_REQUIRED');
  if ((f.effectivenessVerification ?? '').trim() === '') out.push('EFFECTIVENESS_REQUIRED');
  return out;
}

// --- Hard stops (Section 3) ---------------------------------------------------

export const HARD_STOPS = [
  'FALSIFIED_EVIDENCE',
  'UNVERIFIABLE_OWNERSHIP',
  'PROHIBITED_SANCTIONS_MATCH',
  'UNMET_TURNOVER',
  'UNSAFE_OR_COUNTERFEIT_PRODUCT',
  'MISSING_AUTHORISATION',
  'CRITICAL_FINDING',
  'INSURER_CANCELLATION',
  'CERTIFICATE_WITHDRAWN',
  'ILLEGAL_IMPORT_ROUTE',
  'SITE_ACCESS_REFUSED',
  'UNDISCLOSED_MANUFACTURING_CHANGE',
] as const;
export type HardStop = (typeof HARD_STOPS)[number];

// --- External certification (Gate 5) -----------------------------------------

export type ExternalCertStatus = 'APPOINTED' | 'IN_PROGRESS' | 'ISSUED_UNVERIFIED' | 'AUTHENTICATED' | 'SUSPENDED' | 'WITHDRAWN' | 'EXPIRED' | 'REFUSED';

export interface ExternalCertFacts {
  status: ExternalCertStatus;
  appointedByGloviaa: boolean;
  accreditationVerified: boolean;
  independenceVerified: boolean;
  authenticityVerified: boolean;
  expiresOn: Date | null;
  facilityIds: readonly string[];
  productKeys: readonly string[];
}

export type CertProblem = 'CERT_MISSING' | 'CERT_NOT_APPOINTED_BY_MARKETPLACE' | 'CERT_NOT_AUTHENTICATED' | 'CERT_WITHDRAWN' | 'CERT_EXPIRED' | 'CERT_BODY_NOT_VERIFIED' | 'CERT_OUT_OF_SCOPE';

/** A seller upload is never authentication; out-of-scope is as bad as none. */
export function certProblems(cert: ExternalCertFacts | null, need: { facilityId: string; productKey: string } | null, now: Date): CertProblem[] {
  if (cert === null) return ['CERT_MISSING'];
  const out: CertProblem[] = [];
  if (!cert.appointedByGloviaa) out.push('CERT_NOT_APPOINTED_BY_MARKETPLACE');
  if (cert.status === 'WITHDRAWN' || cert.status === 'SUSPENDED' || cert.status === 'REFUSED') out.push('CERT_WITHDRAWN');
  else if (cert.status === 'EXPIRED' || cert.expiresOn === null || cert.expiresOn.getTime() <= now.getTime()) out.push('CERT_EXPIRED');
  else if (cert.status !== 'AUTHENTICATED' || !cert.authenticityVerified) out.push('CERT_NOT_AUTHENTICATED');
  if (!cert.accreditationVerified || !cert.independenceVerified) out.push('CERT_BODY_NOT_VERIFIED');
  if (need !== null && (!cert.facilityIds.includes(need.facilityId) || !cert.productKeys.includes(need.productKey))) out.push('CERT_OUT_OF_SCOPE');
  return out;
}

// --- Validity (Section 6) -----------------------------------------------------

/** No more than `months`, cut short by the earliest mandatory expiry. Never extends an external certificate. */
export function approvalValidUntil(issuedAt: Date, months: number, mandatoryExpiries: readonly (Date | null)[]): Date {
  const cap = new Date(Date.UTC(issuedAt.getUTCFullYear(), issuedAt.getUTCMonth() + months, issuedAt.getUTCDate(), issuedAt.getUTCHours(), issuedAt.getUTCMinutes()));
  // A day that does not exist in the target month (31 Feb) rolls back to the month's last day.
  if (cap.getUTCDate() !== issuedAt.getUTCDate()) cap.setUTCDate(0);
  let end = cap;
  for (const d of mandatoryExpiries) if (d !== null && d.getTime() < end.getTime()) end = d;
  return end;
}

/** Which reminder thresholds are due now and not yet sent. */
export function dueReminders(expiresAt: Date, now: Date, thresholds: readonly number[], alreadySent: readonly number[]): number[] {
  const daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000);
  if (daysLeft <= 0) return [];
  return thresholds.filter((t) => daysLeft <= t && !alreadySent.includes(t)).sort((a, b) => b - a).slice(-1);
}

// --- Business days ------------------------------------------------------------

/** Monday-Friday. Public holidays are a deployment setting not modelled yet - the target says so. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

export function appealDeadline(noticeIssuedAt: Date, windowDays: number): Date {
  return new Date(noticeIssuedAt.getTime() + windowDays * 86_400_000);
}

// --- Change control (Section 6) -----------------------------------------------

export const CHANGE_KINDS = [
  'FACILITY',
  'LEGAL_ENTITY',
  'BENEFICIAL_OWNERSHIP',
  'BRAND_RIGHTS',
  'SUBCONTRACTOR',
  'MATERIALS',
  'FORMULATION',
  'DESIGN',
  'MANUFACTURING_PROCESS',
  'INTENDED_USE',
  'SAFETY_SOFTWARE',
  'LABELS',
  'COUNTRY',
  'NEW_PRODUCT',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

// --- Retention (Section 7) ----------------------------------------------------

export const RETENTION_CATEGORIES = [
  /** General assessment record: policy default years after last transaction / relationship end. */
  'GENERAL_ASSESSMENT',
  /** Product-specific obligations that may be longer; configured per category. */
  'PRODUCT_SPECIFIC',
  /** Identity documents: statutory purpose and deletion rules, never blanket 7 years. */
  'IDENTITY',
  /** EU DSA Art. 30 trader traceability data. */
  'EU_DSA_TRADER',
  /** US INFORM Consumers Act data. */
  'US_INFORM',
  'BANKING',
] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

/**
 * Retention years per category. Null means the legal value has not been
 * configured: the record is kept and listed as a configuration dependency,
 * never deleted on a guessed date.
 */
export function retentionYears(category: RetentionCategory, policy: Pick<AssessmentPolicyConfig, 'retentionYearsDefault'>, configured: Partial<Record<RetentionCategory, number>>): number | null {
  if (category === 'GENERAL_ASSESSMENT') return configured.GENERAL_ASSESSMENT ?? policy.retentionYearsDefault;
  return configured[category] ?? null;
}

// --- AI controls (Section 5) ---------------------------------------------------

export const AI_ALLOWED_TASKS = ['EXTRACTION', 'CONSISTENCY_CHECK', 'EXPIRY_DETECTION', 'RESEARCH_FLAG', 'DRAFT_WORKPAPER', 'POSSIBLE_SANCTIONS_MATCH'] as const;
/** Never an AI output, whatever a client sends. */
export const AI_FORBIDDEN_ACTIONS = ['APPROVE_SELLER', 'ISSUE_EXTERNAL_CERTIFICATE', 'RESOLVE_SANCTIONS_MATCH', 'DETERMINE_LEGAL_COMPLIANCE', 'AUTHORISE_MONEY_MOVEMENT'] as const;

// --- Scope keys ---------------------------------------------------------------

export type SalesChannel = 'B2B' | 'B2C';

/** One material combination (Section 11): product version x site x country x channel. */
export function scopeKey(s: { productKey: string; facilityId: string; countryCode: string; channel: SalesChannel }): string {
  return `${s.productKey}|${s.facilityId}|${s.countryCode}|${s.channel}`;
}

/** No blanket regions: a scope row names one ISO country. 'EU', 'EEA', 'EUROPE' are refused. */
export function isSingleCountryCode(code: string): boolean {
  return /^[A-Z]{2}$/.test(code) && !['EU', 'EZ', 'UN', 'XX'].includes(code);
}

// --- Status machines ----------------------------------------------------------
// Statuses are VARCHAR columns; these maps are the only judge of a move.

export type AssessmentStatus = 'DRAFT' | 'SUBMITTED' | 'CORRECTION_REQUESTED' | 'IN_REVIEW' | 'REMEDIATION' | 'RELEASED' | 'DECLINED' | 'WITHDRAWN';

const ASSESSMENT_MOVES: Readonly<Record<AssessmentStatus, readonly AssessmentStatus[]>> = Object.freeze({
  DRAFT: ['SUBMITTED', 'WITHDRAWN'],
  SUBMITTED: ['CORRECTION_REQUESTED', 'IN_REVIEW', 'DECLINED', 'WITHDRAWN'],
  CORRECTION_REQUESTED: ['SUBMITTED', 'DECLINED', 'WITHDRAWN'],
  IN_REVIEW: ['REMEDIATION', 'RELEASED', 'DECLINED', 'CORRECTION_REQUESTED'],
  REMEDIATION: ['IN_REVIEW', 'DECLINED', 'WITHDRAWN'],
  RELEASED: [],
  DECLINED: [],
  WITHDRAWN: [],
});

export function canMoveAssessment(from: string, to: AssessmentStatus): boolean {
  return (ASSESSMENT_MOVES[from as AssessmentStatus] ?? []).includes(to);
}

/** The seller may edit the application only in these. */
export const SELLER_EDITABLE: readonly AssessmentStatus[] = ['DRAFT', 'CORRECTION_REQUESTED'];
/** Reviewers may record work only in these. */
export const REVIEWABLE: readonly AssessmentStatus[] = ['SUBMITTED', 'IN_REVIEW', 'REMEDIATION'];

export type ApprovalStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'SUPERSEDED' | 'EXPIRED';

const APPROVAL_MOVES: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = Object.freeze({
  ACTIVE: ['SUSPENDED', 'REVOKED', 'SUPERSEDED', 'EXPIRED'],
  // A suspension is lifted only by a new release (revalidation), never back to ACTIVE.
  SUSPENDED: ['REVOKED', 'SUPERSEDED', 'EXPIRED'],
  REVOKED: [],
  SUPERSEDED: [],
  EXPIRED: [],
});

export function canMoveApproval(from: string, to: ApprovalStatus): boolean {
  return (APPROVAL_MOVES[from as ApprovalStatus] ?? []).includes(to);
}

export type DispositionStatus = 'PENDING_REVIEW' | 'HOLD' | 'RELEASE_APPROVED' | 'CANCEL_RECOMMENDED' | 'RECALL';
/** Only a recorded release lets a held seller order move on. */
export function dispositionAllowsDispatch(status: string): boolean {
  return status === 'RELEASE_APPROVED';
}

export const WORKPAPER_KINDS = ['SITE_AUDIT', 'SAMPLE_PLAN', 'LAB_COMPETENCE', 'CONTRACT', 'MOCK_ORDER', 'IDENTITY_CHECK', 'BANK_VERIFICATION', 'SANCTIONS_SCREENING', 'SPECIALIST_REVIEW', 'AI_OUTPUT'] as const;
export type WorkpaperKind = (typeof WORKPAPER_KINDS)[number];

export const CONTRACT_KINDS = ['SELLER_TERMS', 'SERVICE_AGREEMENT', 'PRODUCT_SCHEDULE', 'INSURANCE_ENDORSEMENT', 'FEE_SCHEDULE', 'PAYMENT_MANDATE'] as const;
export const MOCK_ORDER_STEPS = ['ALLOCATION', 'INSPECTION', 'PACKOUT', 'SHIPMENT_DOCUMENTS', 'TRACKING', 'REFUND', 'RECALL_TRACE'] as const;
export const SITE_AUDIT_AREAS = ['PRODUCTION', 'OUTSOURCED_PROCESSES', 'QUALITY_CONTROL', 'CALIBRATION', 'BATCH_TRACEABILITY', 'WORKER_SAFETY', 'STORAGE', 'COMPLAINTS', 'RECALL_CAPABILITY'] as const;
export const SPECIALIST_AREAS = ['REGULATORY', 'FINANCE', 'OPERATIONS', 'LEGAL'] as const;
export type SpecialistArea = (typeof SPECIALIST_AREAS)[number];

/**
 * A mock-order step may be marked PROVIDER_VERIFIED only when the integration
 * it exercises is enabled in this deployment. Otherwise it is SIMULATED, and
 * says so.
 */
export function mockStepModeProblem(step: { mode: string; integrationEnabled: boolean }): string | null {
  if (step.mode === 'PROVIDER_VERIFIED' && !step.integrationEnabled) return 'INTEGRATION_NOT_ENABLED';
  if (step.mode !== 'PROVIDER_VERIFIED' && step.mode !== 'SIMULATED') return 'MODE_INVALID';
  return null;
}
