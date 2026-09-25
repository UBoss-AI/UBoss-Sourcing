/**
 * A carrier's own profile, from the operator's side: the review queue.
 *
 * The carrier edits its profile in the logistics portal. Identity changes and
 * compliance documents wait here for a member of staff; nothing the carrier
 * proposes reaches the live record until one of these calls approves it.
 */
import { api, downloadFile } from './api';

export type VerificationState = 'UNVERIFIED' | 'VERIFIED' | 'REVERIFICATION_REQUIRED';

export type ComplianceKind =
  | 'BUSINESS_LICENCE'
  | 'INSURANCE_CERTIFICATE'
  | 'TRANSPORT_PERMIT'
  | 'COMPANY_REGISTRATION'
  | 'TAX_REGISTRATION'
  | 'OTHER';

export interface ReviewDocument {
  id: string;
  kind: ComplianceKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanState: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED' | 'SKIPPED' | 'GENERATED';
  reviewState: 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED';
  rejectionReason: string | null;
  expiresOn: string | null;
  uploadedByLabel: string;
  createdAt: string;
  reviewedAt: string | null;
  downloadable: boolean;
  supersededAt: string | null;
}

export interface ReviewChange {
  id: string;
  state: string;
  proposed: Record<string, unknown>;
  current: Record<string, unknown>;
  requestedByLabel: string;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface PartnerProfileReview {
  profile: {
    identity: { verificationState: VerificationState; verifiedAt: string | null };
    review: { pendingChange: ReviewChange | null; lastDecision: ReviewChange | null };
    compliance: {
      items: {
        kind: ComplianceKind;
        status: 'MISSING' | 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
        expiresOn: string | null;
      }[];
    };
    completion: { percent: number };
  };
  documentHistory: ReviewDocument[];
}

export const partnerReviewKey = (id: string): readonly unknown[] => [
  'admin',
  'logistics',
  'partner',
  id,
  'profile-review',
];

export function fetchPartnerReview(id: string): Promise<PartnerProfileReview> {
  return api.get(`/admin/logistics/partners/${id}/profile`);
}

export function decideProfileChange(
  partnerId: string,
  changeId: string,
  decision: 'APPROVED' | 'REJECTED',
  note: string,
): Promise<PartnerProfileReview> {
  return api.post(`/admin/logistics/partners/${partnerId}/profile-changes/${changeId}/decision`, {
    decision,
    note: note.trim() === '' ? null : note.trim(),
  });
}

export function decideDocument(
  partnerId: string,
  documentId: string,
  decision: 'VERIFIED' | 'REJECTED',
  reason: string,
): Promise<PartnerProfileReview> {
  return api.post(`/admin/logistics/partners/${partnerId}/documents/${documentId}/decision`, {
    decision,
    reason: reason.trim() === '' ? null : reason.trim(),
  });
}

export function setVerification(
  partnerId: string,
  state: VerificationState,
  note: string,
): Promise<PartnerProfileReview> {
  return api.post(`/admin/logistics/partners/${partnerId}/verification`, {
    state,
    note: note.trim() === '' ? null : note.trim(),
  });
}

/** Mint the single-use link, then spend it. */
export async function downloadReviewDocument(
  partnerId: string,
  document: ReviewDocument,
): Promise<void> {
  const link = await api.post<{ url: string; fileName: string }>(
    `/admin/logistics/partners/${partnerId}/documents/${document.id}/link`,
  );
  await downloadFile(link.url.replace(/^\/api\/v1/, ''), link.fileName);
}
