/**
 * What somebody may do inside one inspection agency.
 *
 * A fourth catalogue beside `permissions.ts` (the marketplace's staff),
 * `seller-permissions.ts` (one seller's own rows) and
 * `logistics-permissions.ts` (one carrier's consignments). These keys grant
 * authority over ONE agency's jobs and nothing else, and every check is made
 * together with the tenant filter (the agency id from the session) and, for an
 * inspector, the assignment filter - an inspector sees only the jobs they are
 * named on (DOD-018).
 */

export const InspectionAgencyPermission = {
  /// Read the agency's own jobs. An INSPECTOR is further narrowed to jobs they
  /// are assigned to.
  JOB_READ: 'inspection.job.read',
  /// Accept or decline an offered job, with the agency's conflict statement.
  JOB_ACCEPT: 'inspection.job.accept',
  /// Name the inspector and a backup.
  JOB_ASSIGN: 'inspection.job.assign',
  /// Record checks, sampling, defects and evidence; submit the report.
  JOB_PERFORM: 'inspection.job.perform',
  /// Return or sign a report, and reclassify a defect with evidence.
  REPORT_SIGN: 'inspection.report.sign',
  /// Add and change the agency's people.
  MEMBER_WRITE: 'inspection.member.write',
  /// Send invoices and read their status.
  INVOICE_WRITE: 'inspection.invoice.write',
} as const;

export type InspectionAgencyPermissionKey =
  (typeof InspectionAgencyPermission)[keyof typeof InspectionAgencyPermission];

export type InspectionAgencyRoleName = 'AGENCY_ADMIN' | 'COORDINATOR' | 'INSPECTOR' | 'QA_REVIEWER';

const P = InspectionAgencyPermission;

/**
 * Role grants. The inspector cannot sign; QA cannot record findings; neither
 * can change who else is in the agency. A report is therefore always the work
 * of at least two people - the one who inspected and the one who signed.
 */
export const INSPECTION_AGENCY_ROLES: Readonly<
  Record<InspectionAgencyRoleName, readonly InspectionAgencyPermissionKey[]>
> = Object.freeze({
  AGENCY_ADMIN: [P.JOB_READ, P.JOB_ACCEPT, P.JOB_ASSIGN, P.MEMBER_WRITE, P.INVOICE_WRITE],
  COORDINATOR: [P.JOB_READ, P.JOB_ACCEPT, P.JOB_ASSIGN, P.INVOICE_WRITE],
  INSPECTOR: [P.JOB_READ, P.JOB_PERFORM],
  QA_REVIEWER: [P.JOB_READ, P.REPORT_SIGN],
});

export function inspectionPermissionsFor(role: InspectionAgencyRoleName): ReadonlySet<InspectionAgencyPermissionKey> {
  return new Set(INSPECTION_AGENCY_ROLES[role]);
}

/** Only an inspector's job list is narrowed to their own assignments. */
export function isAssignmentScoped(role: InspectionAgencyRoleName): boolean {
  return role === 'INSPECTOR';
}
