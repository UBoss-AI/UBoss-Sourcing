/**
 * What somebody may do in the Audit Console.
 *
 * A fifth catalogue, beside `permissions.ts` (the marketplace's staff),
 * `seller-permissions.ts`, `logistics-permissions.ts` and
 * `inspection-permissions.ts` (one agency's people). The console serves two
 * kinds of member and this file is where the difference is written down:
 *
 *   - STAFF: the marketplace's own audit supervisors and compliance reviewers.
 *     They see every seller case, every agency's jobs (read), and the rules.
 *   - AGENCY: an inspection agency's admin, coordinator, inspector or QA
 *     reviewer. They see their OWN agency's jobs and nothing else, and an
 *     inspector only the jobs they are named on. Their job keys are the
 *     existing `inspection.*` keys, so the rules in the inspection services
 *     apply unchanged.
 *
 * A key answers "may this person do this kind of thing". Whose data, and
 * which job, are answered by the tenant and assignment filters in the
 * services - never by a key alone. Hiding a menu entry is not authorisation.
 */
import {
  INSPECTION_AGENCY_ROLES,
  InspectionAgencyPermission,
  type InspectionAgencyPermissionKey,
  type InspectionAgencyRoleName,
} from './inspection-permissions.js';

export const AuditPermission = {
  DASHBOARD_READ: 'audit.dashboard.read',
  /// Business identity (read), qualification and product cases.
  SELLER_READ: 'audit.seller.read',
  /// Decide compliance documents and qualification/product cases.
  CASE_REVIEW: 'audit.case.review',
  /// Decide seller onboarding applications: take one for review, ask for
  /// corrections, approve or reject it, accept or refuse its documents and
  /// turnover, and record a manual screening. The Audit Team owns this; the
  /// Admin Panel only reads it. Never granted to an inspection agency.
  SELLER_VERIFY: 'audit.seller.verify',
  /// Documents and their expiry.
  DOCUMENT_READ: 'audit.document.read',
  RULE_READ: 'audit.rule.read',
  /// Draft a rule or a new version of one. Never enough to approve it.
  RULE_DRAFT: 'audit.rule.draft',
  /// Approve or reject a submitted rule - never one the same person drafted.
  RULE_APPROVE: 'audit.rule.approve',
  /// Inspection plans and checklists.
  CHECKLIST_MANAGE: 'audit.checklist.manage',
  /// Every agency's jobs, reports and corrective actions, read-only.
  JOB_OVERSEE: 'audit.job.oversee',
  /// Ask for a sub-lot release. Approved by somebody else in the Admin Panel.
  RELEASE_REQUEST: 'audit.release.request',
  /// Every agency and its people, read-only.
  TEAM_READ: 'audit.team.read',
} as const;

export type AuditPermissionKey = (typeof AuditPermission)[keyof typeof AuditPermission];

/** Every key the console knows: its own plus the agency keys. */
export type AuditConsoleKey = AuditPermissionKey | InspectionAgencyPermissionKey;

export type AuditStaffRoleName = 'SUPERVISOR' | 'COMPLIANCE_REVIEWER';
export type AuditRoleName = AuditStaffRoleName | InspectionAgencyRoleName;

const A = AuditPermission;

/**
 * Staff grants. A reviewer decides cases and seller applications and drafts
 * rules (agency members never verify sellers); only a supervisor
 * approves a rule, manages checklists or asks for a sub-lot release - and the
 * services refuse a supervisor approving their own draft.
 */
export const AUDIT_STAFF_ROLES: Readonly<Record<AuditStaffRoleName, readonly AuditPermissionKey[]>> = Object.freeze({
  SUPERVISOR: [
    A.DASHBOARD_READ,
    A.SELLER_READ,
    A.CASE_REVIEW,
    A.SELLER_VERIFY,
    A.DOCUMENT_READ,
    A.RULE_READ,
    A.RULE_DRAFT,
    A.RULE_APPROVE,
    A.CHECKLIST_MANAGE,
    A.JOB_OVERSEE,
    A.RELEASE_REQUEST,
    A.TEAM_READ,
  ],
  COMPLIANCE_REVIEWER: [
    A.DASHBOARD_READ,
    A.SELLER_READ,
    A.CASE_REVIEW,
    A.SELLER_VERIFY,
    A.DOCUMENT_READ,
    A.RULE_READ,
    A.RULE_DRAFT,
    A.JOB_OVERSEE,
  ],
});

/** An agency member's console keys: the dashboard, plus their agency role's keys. */
export function agencyConsoleKeys(role: InspectionAgencyRoleName): ReadonlySet<AuditConsoleKey> {
  return new Set<AuditConsoleKey>([A.DASHBOARD_READ, ...INSPECTION_AGENCY_ROLES[role]]);
}

export function staffConsoleKeys(role: AuditStaffRoleName): ReadonlySet<AuditConsoleKey> {
  return new Set<AuditConsoleKey>(AUDIT_STAFF_ROLES[role]);
}

export { InspectionAgencyPermission };
