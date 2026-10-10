/**
 * Seller Assessment in the Seller Hub: apply, upload evidence, answer
 * findings, see approved and blocked scope, appeal, notify changes, report
 * incidents and ask for a bank-account change.
 *
 * The server decides eligibility and every gate; this file only carries it.
 */
import { api, newIdempotencyKey, postFile } from './api';

export interface SellerAssessmentView {
  id: string;
  number: string;
  kind: string;
  status: string;
  applicationRevision: number;
  policyVersion: string;
  policyInForce: { version: string; status: string };
  application: Record<string, unknown> | null;
  applicationProblems: string[];
  correctionNote: string | null;
  reviewTargetAt: string | null;
  gates: { gate: number; status: string; reason: string | null }[];
  evidence: { id: string; category: string; evidenceKey: string; label: string; version: number; fileName: string | null; createdAt: string }[];
  scope: { id: string; productName: string; productVersion: string; facilityRef: string; countryCode: string; channel: string; decision: string }[];
  findings: { id: string; number: string; classification: string; requirement: string; evidence: string; containment: string | null; rootCause: string | null; correctiveAction: string | null; preventiveAction: string | null; ownerName: string | null; planDueAt: string | null; closureDueAt: string; overdue: boolean; status: string; closureEvidenceIds: string[]; version: number }[];
  certifications: { id: string; bodyName: string; scheme: string; status: string; certificateNumber: string | null; expiresOn: string | null }[];
}

export interface Overview {
  gateMode: string;
  approvals: { id: string; number: string; status: string; issuedAt: string; validUntil: string; nextReviewAt: string; renewalDue: boolean; auditDocumentId: string | null; scopes: { id: string; productKey: string; productVersion: string; facilityRef: string; countryCode: string; channel: string; status: string; validUntil: string; blockedReason: string | null }[] }[];
  notices: { id: string; number: string; kind: string; reason: string; shareableEvidence: string; affectedOrders: string[]; settlementTreatment: string; correctiveActions: string; reviewRoute: string; issuedAt: string; appealDeadline: string; appealOpen: boolean; appeals: { id: string; status: string; submittedAt: string; targetBy: string; outcomeReason: string | null }[] }[];
  changes: { id: string; kind: string; description: string; status: string; decisionReason: string | null; createdAt: string }[];
  incidents: { id: string; severity: string; description: string; reportedAt: string; late: boolean; deadlineHours: number; status: string }[];
  bankChanges: { id: string; beneficiaryName: string; accountLast4: string; status: string; requestedAt: string }[];
}

export const sellerAssessmentKey = ['seller', 'assessment'] as const;

export const fetchSellerAssessment = (): Promise<{ overview: Overview; current: SellerAssessmentView | null }> => api.get('/seller/assessment');
const once = () => ({ idempotencyKey: newIdempotencyKey() });
export const startAssessment = (kind: string) => api.post<{ id: string }>('/seller/assessment', { kind }, once());
export const saveApplication = (id: string, patch: Record<string, unknown>, expectedRevision: number) => api.patch<{ revision: number }>(`/seller/assessment/${id}/application`, { patch, expectedRevision });
export const submitAssessment = (id: string) => api.post(`/seller/assessment/${id}/submit`, {});
export const respondToFinding = (id: string, body: Record<string, unknown>) => api.put(`/seller/assessment/findings/${id}`, body);
export const appeal = (noticeId: string, grounds: string) => api.post(`/seller/assessment/notices/${noticeId}/appeal`, { grounds, evidenceRef: null }, once());
export const notifyChange = (body: { kind: string; description: string; plannedFrom: string | null }) => api.post('/seller/assessment/changes', body, once());
export const reportIncident = (body: Record<string, unknown>) => api.post<{ late: boolean; deadlineHours: number }>('/seller/assessment/incidents', body, once());
export const requestBankChange = (body: Record<string, unknown>) => api.post('/seller/assessment/bank-changes', body, once());
export const approvalPdfUrl = (approvalId: string) => `/seller/assessment/approvals/${approvalId}/pdf`;

export function uploadEvidence(id: string, file: File, evidenceKey: string, category: string) {
  const form = new FormData();
  form.append('category', category);
  form.append('evidenceKey', evidenceKey);
  form.append('label', file.name);
  form.append('file', file);
  return postFile<{ id: string }>(`/seller/assessment/${id}/evidence`, form, { idempotencyKey: newIdempotencyKey() });
}

/**
 * Rupees as typed ("30,00,00,000" or "300000000.50") to whole paise, exactly:
 * string arithmetic, never a float. Null when it is not a plain amount.
 */
export function rupeesToPaise(entry: string): string | null {
  const clean = entry.replace(/[,\s]/g, '');
  const match = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(clean);
  if (match === null) return null;
  const whole = (match[1] ?? '0').replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
}

export function paiseToRupees(minor: string): string {
  const digits = minor.padStart(3, '0');
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  return fraction === '00' ? whole : `${whole}.${fraction}`;
}

/** The evidence each part of the application refers to, so the form can list what is still to upload. */
export const REQUIRED_EVIDENCE: { key: string; category: string; when?: 'delegation' | 'exception' }[] = [
  { key: 'audited', category: 'FINANCIAL' },
  { key: 'ca', category: 'FINANCIAL' },
  { key: 'preceding-audit', category: 'FINANCIAL', when: 'exception' },
  { key: 'bank', category: 'BANKING' },
  { key: 'delegation', category: 'IDENTITY', when: 'delegation' },
];
