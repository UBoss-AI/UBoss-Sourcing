/**
 * A seller's health rating, for the Audit Console.
 *
 * Modelled on Amazon's Account Health Rating: one number from 0 to 1,000 and
 * three bands with fixed colours, so an auditor reads a seller's standing at a
 * glance and a seller list can be sorted by risk.
 *
 *   HEALTHY    200 - 1,000   green
 *   AT_RISK    100 -   199   amber
 *   UNHEALTHY    0 -    99   red
 *
 * The number starts at 1,000 and each open issue takes points off by its
 * severity. Two caps keep the band honest whatever the arithmetic says:
 *
 *   - any CRITICAL issue holds the score at 99 or less (UNHEALTHY), the way an
 *     Amazon critical violation puts an account at risk of deactivation;
 *   - any HIGH issue holds it at 199 or less (AT_RISK).
 *
 * So the band always names the worst thing that is open, and the number only
 * ranks sellers inside a band.
 *
 * Every input is a count the server already holds. Nothing here reads the
 * database, so the rule is tested on its own.
 */

export const HEALTH_BANDS = ['HEALTHY', 'AT_RISK', 'UNHEALTHY'] as const;
export type HealthBand = (typeof HEALTH_BANDS)[number];

export const ISSUE_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/** Points one open issue takes off the score. */
export const SEVERITY_POINTS: Readonly<Record<IssueSeverity, number>> = {
  CRITICAL: 400,
  HIGH: 150,
  MEDIUM: 50,
  LOW: 10,
};

export const MAX_SCORE = 1000;
/** Lowest score of each band, Amazon's own thresholds. */
export const AT_RISK_FROM = 100;
export const HEALTHY_FROM = 200;

/**
 * Inspection performance target, like Amazon's "Order Defect Rate under 1%":
 * a seller whose signed inspections fail more often than this has a HIGH
 * issue. Judged only once there are enough reports to mean something.
 */
export const INSPECTION_FAILURE_TARGET_PERCENT = 10;
export const INSPECTION_MIN_REPORTS = 3;
/** How far back the inspection record looks. */
export const INSPECTION_WINDOW_DAYS = 365;
/** How soon an approved document's expiry counts as an issue. */
export const EXPIRY_WARNING_DAYS = 30;

/**
 * What can be wrong, each with a fixed severity. The kind is a published
 * value: both the API and the console's translations key off it.
 */
export const ISSUE_KINDS = {
  /** An open critical non-conformance from a signed inspection. */
  CRITICAL_NCR_OPEN: 'CRITICAL',
  /** A category qualification or product case suspended by a reviewer. */
  CASE_SUSPENDED: 'CRITICAL',
  /** A compliance document suspended by a reviewer. */
  DOCUMENT_SUSPENDED: 'CRITICAL',
  /** Goods held: an inspection failed or an NCR blocks release. */
  LOT_HELD: 'HIGH',
  /** An open major non-conformance. */
  MAJOR_NCR_OPEN: 'HIGH',
  /** Signed inspections fail above the target rate. */
  INSPECTION_FAILURE_RATE: 'HIGH',
  /** A document the seller relied on has expired. */
  DOCUMENT_EXPIRED: 'HIGH',
  /** A qualification lapsed. */
  CASE_EXPIRED: 'HIGH',
  /** A business-identity check (KYB) expired or was rejected. */
  IDENTITY_CHECK_LAPSED: 'HIGH',
  /** A qualification must be looked at again because a document changed. */
  CASE_REREVIEW: 'MEDIUM',
  /** An approved document expires within EXPIRY_WARNING_DAYS. */
  DOCUMENT_EXPIRING: 'MEDIUM',
  /** A document was rejected. */
  DOCUMENT_REJECTED: 'MEDIUM',
  /** An open minor non-conformance. */
  MINOR_NCR_OPEN: 'LOW',
  /** A reviewer is waiting on the seller to change something. */
  CHANGES_REQUESTED: 'LOW',
} as const satisfies Record<string, IssueSeverity>;

export type IssueKind = keyof typeof ISSUE_KINDS;

/** The counts behind one seller's rating. */
export interface HealthSignals {
  criticalNcrsOpen: number;
  majorNcrsOpen: number;
  minorNcrsOpen: number;
  lotsHeld: number;
  casesSuspended: number;
  casesExpired: number;
  casesRereview: number;
  casesChangesRequested: number;
  documentsSuspended: number;
  documentsExpired: number;
  documentsExpiring: number;
  documentsRejected: number;
  documentsChangesRequested: number;
  identityChecksLapsed: number;
  /** Signed, current inspection reports in the window, by result. */
  reportsPassed: number;
  reportsFailed: number;
  reportsInconclusive: number;
}

export const EMPTY_SIGNALS: Readonly<HealthSignals> = Object.freeze({
  criticalNcrsOpen: 0,
  majorNcrsOpen: 0,
  minorNcrsOpen: 0,
  lotsHeld: 0,
  casesSuspended: 0,
  casesExpired: 0,
  casesRereview: 0,
  casesChangesRequested: 0,
  documentsSuspended: 0,
  documentsExpired: 0,
  documentsExpiring: 0,
  documentsRejected: 0,
  documentsChangesRequested: 0,
  identityChecksLapsed: 0,
  reportsPassed: 0,
  reportsFailed: 0,
  reportsInconclusive: 0,
});

export interface HealthIssue {
  kind: IssueKind;
  severity: IssueSeverity;
  count: number;
}

export interface InspectionRecord {
  reports: number;
  passed: number;
  /** FAIL and INCONCLUSIVE together: both hold the goods. */
  notPassed: number;
  /** Whole percent, or null with no reports. */
  passRatePercent: number | null;
  /** Null until there are INSPECTION_MIN_REPORTS reports. */
  meetsTarget: boolean | null;
}

export interface SellerHealth {
  score: number;
  band: HealthBand;
  issues: HealthIssue[];
  bySeverity: Record<IssueSeverity, number>;
  inspection: InspectionRecord;
}

export function bandOf(score: number): HealthBand {
  if (score >= HEALTHY_FROM) return 'HEALTHY';
  if (score >= AT_RISK_FROM) return 'AT_RISK';
  return 'UNHEALTHY';
}

export function inspectionRecord(signals: HealthSignals): InspectionRecord {
  const reports = signals.reportsPassed + signals.reportsFailed + signals.reportsInconclusive;
  const notPassed = signals.reportsFailed + signals.reportsInconclusive;
  const passRatePercent = reports === 0 ? null : Math.round((signals.reportsPassed * 100) / reports);
  const meetsTarget = reports < INSPECTION_MIN_REPORTS ? null : notPassed * 100 <= reports * INSPECTION_FAILURE_TARGET_PERCENT;
  return { reports, passed: signals.reportsPassed, notPassed, passRatePercent, meetsTarget };
}

/** The open issues, worst first, one entry per kind. */
export function healthIssues(signals: HealthSignals): HealthIssue[] {
  const inspection = inspectionRecord(signals);
  const counts: Record<IssueKind, number> = {
    CRITICAL_NCR_OPEN: signals.criticalNcrsOpen,
    CASE_SUSPENDED: signals.casesSuspended,
    DOCUMENT_SUSPENDED: signals.documentsSuspended,
    LOT_HELD: signals.lotsHeld,
    MAJOR_NCR_OPEN: signals.majorNcrsOpen,
    INSPECTION_FAILURE_RATE: inspection.meetsTarget === false ? 1 : 0,
    DOCUMENT_EXPIRED: signals.documentsExpired,
    CASE_EXPIRED: signals.casesExpired,
    IDENTITY_CHECK_LAPSED: signals.identityChecksLapsed,
    CASE_REREVIEW: signals.casesRereview,
    DOCUMENT_EXPIRING: signals.documentsExpiring,
    DOCUMENT_REJECTED: signals.documentsRejected,
    MINOR_NCR_OPEN: signals.minorNcrsOpen,
    CHANGES_REQUESTED: signals.casesChangesRequested + signals.documentsChangesRequested,
  };
  const issues: HealthIssue[] = [];
  // ISSUE_KINDS is declared worst first, so insertion order is the ranking.
  for (const kind of Object.keys(ISSUE_KINDS) as IssueKind[]) {
    const count = Math.max(0, Math.trunc(counts[kind]));
    if (count > 0) issues.push({ kind, severity: ISSUE_KINDS[kind], count });
  }
  return issues;
}

export function rateSellerHealth(signals: HealthSignals): SellerHealth {
  const issues = healthIssues(signals);
  const bySeverity: Record<IssueSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let deduction = 0;
  for (const issue of issues) {
    bySeverity[issue.severity] += issue.count;
    deduction += SEVERITY_POINTS[issue.severity] * issue.count;
  }

  let score = Math.max(0, MAX_SCORE - deduction);
  if (bySeverity.CRITICAL > 0) score = Math.min(score, AT_RISK_FROM - 1);
  else if (bySeverity.HIGH > 0) score = Math.min(score, HEALTHY_FROM - 1);

  return { score, band: bandOf(score), issues, bySeverity, inspection: inspectionRecord(signals) };
}

/** Worst first: band, then score, then the most critical issues. For sorting a list. */
export function compareHealth(a: SellerHealth, b: SellerHealth): number {
  return a.score - b.score || b.bySeverity.CRITICAL - a.bySeverity.CRITICAL;
}
