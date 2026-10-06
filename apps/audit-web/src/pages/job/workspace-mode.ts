/**
 * Who may do what on this job - decided once, for the whole workspace.
 *
 * From the server's own answer (`me.isNamedInspector`, the job's status) and
 * the session's permission keys. The server checks every write again; this
 * only decides which controls a person is shown.
 */
import { Permission, type PermissionKey } from '@/lib/permissions';
import type { JobDetail } from '@/lib/console-types';
import type { WorkspaceMode } from './types';

export function workspaceModeFor(
  detail: JobDetail,
  can: (...keys: PermissionKey[]) => boolean,
  canAny: (...keys: PermissionKey[]) => boolean,
): WorkspaceMode {
  const agency = detail.audience === 'AGENCY';
  const named = agency && detail.me.isNamedInspector;
  const namedInspector = named && can(Permission.JOB_PERFORM);
  return {
    agency,
    namedInspector,
    performing: namedInspector && detail.job.status === 'IN_PROGRESS',
    qa: agency && can(Permission.REPORT_SIGN) && !named,
    coordinator: agency && canAny(Permission.JOB_ACCEPT, Permission.JOB_ASSIGN),
    staff: detail.audience === 'STAFF',
  };
}

/** The anchor ids of the workspace's sections, for the in-page navigation. */
export const SECTION_IDS = {
  overview: 'job-overview',
  coordinate: 'job-coordinate',
  inspector: 'job-inspector',
  checklist: 'job-checklist',
  sampling: 'job-sampling',
  quantities: 'job-quantities',
  defects: 'job-defects',
  lab: 'job-lab',
  evidence: 'job-evidence',
  report: 'job-report',
  subLots: 'job-sublots',
  timeline: 'job-timeline',
} as const;

/** A whole number typed into a field, or null when it is not one. */
export function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** A decimal typed into a quantity field, as the exact string the API wants, or null. */
export function decimalText(text: string): string | null {
  const trimmed = text.trim();
  return /^\d{1,15}(?:\.\d{1,3})?$/.test(trimmed) ? trimmed : null;
}

/** Undefined-free text for an optional API field: empty means null. */
export function optional(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}
