/**
 * The console's side of buyer-company verification.
 *
 * Every decision call carries `expectedVersion` - the version of the
 * application the reviewer was looking at - so two reviewers acting at once
 * cannot both win. The server answers the second with
 * BUYER_COMPANY_VERSION_CONFLICT and this panel reloads the case.
 */
import { api } from './api';

export type BuyerCompanyStatus =
  | 'DRAFT'
  | 'EMAIL_VERIFICATION_PENDING'
  | 'SUBMITTED'
  | 'AUTOMATED_CHECK_IN_PROGRESS'
  | 'UNDER_REVIEW'
  | 'MORE_INFORMATION_REQUIRED'
  | 'RESUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUSPENDED'
  | 'REVERIFICATION_REQUIRED';

export const STATUSES: readonly BuyerCompanyStatus[] = [
  'SUBMITTED',
  'AUTOMATED_CHECK_IN_PROGRESS',
  'UNDER_REVIEW',
  'MORE_INFORMATION_REQUIRED',
  'RESUBMITTED',
  'REVERIFICATION_REQUIRED',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'DRAFT',
  'EMAIL_VERIFICATION_PENDING',
];

export type RiskLevel = 'NONE' | 'LOW' | 'ELEVATED' | 'HIGH';

export const REJECTION_REASON_CODES = [
  'REGISTRATION_NOT_FOUND',
  'DETAILS_DO_NOT_MATCH',
  'DOCUMENTS_INSUFFICIENT',
  'AUTHORITY_NOT_SHOWN',
  'NOT_A_REGISTERED_BUSINESS',
  'DUPLICATE_APPLICATION',
  'UNSUPPORTED_JURISDICTION',
  'NO_RESPONSE',
  'OTHER',
] as const;

export const DOCUMENT_KINDS = [
  'CERTIFICATE_OF_INCORPORATION',
  'REGISTRY_EXTRACT',
  'TAX_REGISTRATION_CERTIFICATE',
  'PROOF_OF_REGISTERED_ADDRESS',
  'AUTHORIZATION_LETTER',
  'BUSINESS_LICENCE',
  'REPRESENTATIVE_IDENTITY',
  'OWNERSHIP_DECLARATION',
  'OTHER',
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface QueueRow {
  id: string;
  reference: string;
  legalName: string | null;
  tradingName: string | null;
  registrationCountry: string | null;
  entityType: string | null;
  registrationNumber: string | null;
  applicant: { email: string; fullName: string | null } | null;
  status: BuyerCompanyStatus;
  riskLevel: RiskLevel;
  flags: { failed: number; duplicates: number; signals: number };
  assignedReviewer: { id: string; email: string } | null;
  submittedAt: string | null;
  ageDays: number;
  lastActivityAt: string;
}

export interface QueuePage {
  rows: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: Partial<Record<BuyerCompanyStatus, number>>;
}

export interface CheckRow {
  id: string;
  provider: string;
  subject: string;
  outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'UNAVAILABLE' | 'MANUAL_REQUIRED' | 'SIGNAL';
  summary: string;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  sourceReference: string | null;
  sourceUrl: string | null;
  checkedAt: string;
}

export interface ReviewCase {
  id: string;
  reference: string;
  status: BuyerCompanyStatus;
  version: number;
  statusReason: string | null;
  statusReasonCode: string | null;
  resubmissionAllowed: boolean;
  riskLevel: RiskLevel;
  registrationClaimed: boolean;
  /**
   * The seller account for the same legal entity, when the applicant started
   * from it. Its status is its own and decides nothing here.
   */
  linkedSeller: {
    id: string;
    legalName: string;
    displayName: string;
    status: string;
    registrationCountry: string;
  } | null;
  business: {
    legalName: string | null;
    tradingName: string | null;
    entityType: string | null;
    registrationCountry: string | null;
    registrationNumber: string | null;
    incorporationDate: string | null;
    industry: string | null;
    website: string | null;
    businessEmail: string | null;
    businessEmailVerified: boolean;
    businessDomainStatus: string;
    businessPhone: string | null;
  };
  applicant: {
    fullName: string | null;
    phone: string | null;
    jobTitle: string | null;
    relationship: string | null;
    authorityConfirmed: boolean;
  };
  addresses: {
    kind: string;
    line1: string;
    line2: string | null;
    city: string;
    region: string | null;
    postalCode: string | null;
    countryCode: string;
  }[];
  identifiers: { scheme: string; value: string | null; notApplicable: boolean; notApplicableReason: string | null }[];
  procurement: Record<string, unknown> | null;
  problems: { field: string; code: string }[];
  documents: {
    id: string;
    kind: DocumentKind;
    status: string;
    mimeType: string;
    sizeBytes: number;
    pageCount: number | null;
    reviewReason: string | null;
    infoRequestId: string | null;
    createdAt: string;
  }[];
  infoRequests: {
    id: string;
    status: 'OPEN' | 'ANSWERED' | 'CANCELLED';
    message: string;
    requestedDocumentKinds: string[];
    createdAt: string;
    responseMessage: string | null;
    respondedAt: string | null;
  }[];
  members: {
    userId: string;
    role: string;
    status: string;
    email: string;
    emailVerified: boolean;
    fullName: string | null;
    phone: string | null;
    joinedAt: string;
  }[];
  currentCase: {
    id: string;
    round: number;
    trigger: string;
    state: string;
    assignedReviewer: { id: string; email: string } | null;
    assignedAt: string | null;
    requiresSecondReview: boolean;
    firstApprovalById: string | null;
    firstApprovalAt: string | null;
    openedAt: string;
  } | null;
  checks: CheckRow[];
  timeline: {
    id: string;
    kind: string;
    visibility: 'INTERNAL' | 'APPLICANT';
    actorType: string;
    actorUserId: string | null;
    message: string | null;
    data: Record<string, unknown> | null;
    createdAt: string;
  }[];
  statusHistory: {
    from: BuyerCompanyStatus;
    to: BuyerCompanyStatus;
    reason: string | null;
    reasonCode: string | null;
    actorType: string;
    actorUserId: string | null;
    createdAt: string;
  }[];
  consents: { purpose: string; textVersion: string; acceptedAt: string; userId: string }[];
  allowedTransitions: { to: BuyerCompanyStatus; requiresReason: boolean }[];
  createdAt: string;
  submittedAt: string | null;
  firstSubmittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  suspendedAt: string | null;
  awaitingSecondReview?: boolean;
}

export const caseKey = (id: string): readonly unknown[] => ['admin', 'buyer-company', id];

export function fetchQueue(params: URLSearchParams): Promise<QueuePage> {
  return api.get(`/admin/buyer-companies?${params.toString()}`);
}

export function fetchCase(id: string): Promise<ReviewCase> {
  return api.get(`/admin/buyer-companies/${id}`);
}

export function fetchReviewers(): Promise<{ reviewers: { id: string; email: string }[] }> {
  return api.get('/admin/buyer-companies/reviewers');
}

export const reviewApi = {
  startReview: (id: string, expectedVersion: number): Promise<ReviewCase> =>
    api.post(`/admin/buyer-companies/${id}/start-review`, { expectedVersion }),
  assign: (id: string, reviewerId: string | null): Promise<ReviewCase> =>
    api.post(`/admin/buyer-companies/${id}/assign`, { reviewerId }),
  note: (id: string, note: string): Promise<ReviewCase> =>
    api.post(`/admin/buyer-companies/${id}/notes`, { note }),
  requestInformation: (id: string, body: { expectedVersion: number; message: string; documentKinds: string[] }): Promise<ReviewCase> =>
    api.post(`/admin/buyer-companies/${id}/request-information`, body),
  approve: (id: string, body: { expectedVersion: number; reason: string | null }): Promise<ReviewCase> =>
    api.post(`/admin/buyer-companies/${id}/approve`, body),
  reject: (
    id: string,
    body: { expectedVersion: number; reasonCode: string; reason: string; resubmissionAllowed: boolean },
  ): Promise<ReviewCase> => api.post(`/admin/buyer-companies/${id}/reject`, body),
  suspend: (id: string, body: { expectedVersion: number; reason: string }): Promise<ReviewCase> =>
    api.post(`/admin/buyer-companies/${id}/suspend`, body),
  reverify: (id: string, body: { expectedVersion: number; reason: string; documentKinds: string[] }): Promise<ReviewCase> =>
    api.post(`/admin/buyer-companies/${id}/reverify`, body),
  rerunChecks: (id: string): Promise<ReviewCase> => api.post(`/admin/buyer-companies/${id}/checks`),
  documentLink: (documentId: string): Promise<{ url: string; expiresAt: string }> =>
    api.post(`/admin/buyer-company-documents/${documentId}/link`),
  decideDocument: (documentId: string, decision: 'ACCEPTED' | 'REJECTED', reason: string | null): Promise<ReviewCase> =>
    api.post(`/admin/buyer-company-documents/${documentId}/decision`, { decision, reason }),
};

export function statusTone(status: BuyerCompanyStatus): 'success' | 'warning' | 'danger' | 'neutral' | 'brand' {
  switch (status) {
    case 'APPROVED':
      return 'success';
    case 'REJECTED':
    case 'SUSPENDED':
      return 'danger';
    case 'MORE_INFORMATION_REQUIRED':
    case 'REVERIFICATION_REQUIRED':
    case 'EMAIL_VERIFICATION_PENDING':
      return 'warning';
    case 'DRAFT':
      return 'neutral';
    default:
      return 'brand';
  }
}

export function riskTone(risk: RiskLevel): 'danger' | 'warning' | 'neutral' | 'success' {
  if (risk === 'HIGH') return 'danger';
  if (risk === 'ELEVATED') return 'warning';
  if (risk === 'NONE') return 'success';
  return 'neutral';
}

export function outcomeTone(outcome: CheckRow['outcome']): 'success' | 'danger' | 'warning' | 'neutral' | 'brand' {
  switch (outcome) {
    case 'PASS':
      return 'success';
    case 'FAIL':
      return 'danger';
    case 'INCONCLUSIVE':
    case 'SIGNAL':
      return 'warning';
    case 'MANUAL_REQUIRED':
      return 'brand';
    default:
      return 'neutral';
  }
}
