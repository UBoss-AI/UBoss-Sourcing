/**
 * The permission keys, as the audit console knows them.
 *
 * Mirrors `domain/audit-console-permissions.ts` in the backend. This copy is a
 * COURTESY, not a control: the server checks every one of these on every
 * request, and what this file buys is a screen that says "you do not have
 * access to this" instead of rendering a page of failed panels.
 *
 * Two families. `audit.*` keys belong to the marketplace's own staff
 * (supervisors and compliance reviewers); `inspection.*` keys belong to the
 * people of an inspection agency. Nobody holds both by role.
 */
export const Permission = {
  // --- Marketplace staff ---------------------------------------------------
  DASHBOARD_READ: 'audit.dashboard.read',
  SELLER_READ: 'audit.seller.read',
  CASE_REVIEW: 'audit.case.review',
  SELLER_VERIFY: 'audit.seller.verify',
  DOCUMENT_READ: 'audit.document.read',
  RULE_READ: 'audit.rule.read',
  RULE_DRAFT: 'audit.rule.draft',
  RULE_APPROVE: 'audit.rule.approve',
  CHECKLIST_MANAGE: 'audit.checklist.manage',
  JOB_OVERSEE: 'audit.job.oversee',
  RELEASE_REQUEST: 'audit.release.request',
  TEAM_READ: 'audit.team.read',

  // --- Inspection agencies -------------------------------------------------
  JOB_READ: 'inspection.job.read',
  JOB_ACCEPT: 'inspection.job.accept',
  JOB_ASSIGN: 'inspection.job.assign',
  JOB_PERFORM: 'inspection.job.perform',
  REPORT_SIGN: 'inspection.report.sign',
  MEMBER_WRITE: 'inspection.member.write',
  INVOICE_WRITE: 'inspection.invoice.write',
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

/** Does this person hold every key in the list? */
export function holdsAll(held: readonly string[], required: readonly PermissionKey[]): boolean {
  return required.every((key) => held.includes(key));
}

/**
 * Does this person hold at least one of them?
 *
 * An empty list means "no permission required", which is how a screen every
 * member may open - the profile, the notification feed - is expressed without
 * a special case.
 */
export function holdsAny(held: readonly string[], required: readonly PermissionKey[]): boolean {
  return required.length === 0 || required.some((key) => held.includes(key));
}
