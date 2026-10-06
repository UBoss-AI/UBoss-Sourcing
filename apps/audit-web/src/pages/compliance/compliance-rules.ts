/**
 * What a reviewer may do next with a case or a document, by its status.
 *
 * Mirrors the transition tables in the backend (`case.service.ts`,
 * `document.service.ts`). This copy only decides which buttons are shown;
 * the server checks the move again and refuses one that is not allowed.
 */
import type { CaseActionName, DocumentActionName } from '@/lib/console-api';
import type { DocumentDecisionInput } from '@/lib/console-types';

const CASE_ACTIONS: Record<string, readonly CaseActionName[]> = {
  REQUESTED: ['start'],
  UNDER_REVIEW: ['request-changes', 'approve', 'reject'],
  CHANGES_REQUESTED: ['start'],
  QUALIFIED: ['suspend'],
  REREVIEW_REQUIRED: ['start', 'suspend'],
  SUSPENDED: ['start'],
  EXPIRED: ['start'],
  REJECTED: [],
  WITHDRAWN: [],
};

export function caseActionsFor(status: string): readonly CaseActionName[] {
  return CASE_ACTIONS[status] ?? [];
}

/** These decisions must tell the seller why, in at least ten characters. */
export function caseActionNeedsMessage(action: CaseActionName): boolean {
  return action === 'request-changes' || action === 'reject' || action === 'suspend';
}

/** A determination can only be recorded while the case is being reviewed. */
export function mayDetermine(status: string): boolean {
  return status === 'UNDER_REVIEW' || status === 'REREVIEW_REQUIRED';
}

const DOCUMENT_ACTIONS: Record<string, readonly DocumentActionName[]> = {
  SUBMITTED: ['start', 'request-changes', 'reject'],
  UNDER_REVIEW: ['request-changes', 'approve', 'reject'],
  APPROVED: ['suspend'],
  SUSPENDED: ['start'],
};

export function documentActionsFor(status: string): readonly DocumentActionName[] {
  return DOCUMENT_ACTIONS[status] ?? [];
}

export function documentActionNeedsMessage(action: DocumentActionName): boolean {
  return action !== 'start' && action !== 'approve';
}

const EXPECTED = new Set(['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SUSPENDED']);

export function expectedStatusOf(status: string): DocumentDecisionInput['expectedStatus'] | null {
  return EXPECTED.has(status) ? (status as DocumentDecisionInput['expectedStatus']) : null;
}

/** Scan states whose file the server will serve for a preview. */
export function isPreviewable(scanState: string): boolean {
  return scanState === 'CLEAN' || scanState === 'SCANNER_UNCONFIGURED';
}

/** The requirement code format the server accepts. */
export function normaliseRequirementCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '-');
}
