/**
 * Seller Assessment and Onboarding: the Audit Team's eight-gate workflow.
 *
 *   GET  /audit/seller-assessments                 queue (search, owner, stage, risk, overdue, expiring)
 *   GET  /audit/seller-assessments/:id             one assessment in full
 *   POST/PUT /audit/seller-assessments/:id/...     gates, checklist, scores, scope, findings, workpapers, certification, release
 *   GET/POST /audit/seller-assessments/policies    versions, adoption, disclosure
 *   GET  /audit/seller-assessments/registers       notices, appeals, changes, incidents, bank changes
 *
 * The server decides everything - capabilities, independence, preconditions.
 * This file only carries it.
 */
import { api } from './api';

const enc = encodeURIComponent;
const base = '/audit/seller-assessments';
const one = (id: string, tail = '') => `${base}/${enc(id)}${tail}`;
const w = (idempotencyKey: string) => ({ idempotencyKey });

export const CAPABILITIES = ['HEAD_OF_ASSURANCE', 'ASSESS', 'REGULATORY', 'FINANCE', 'OPERATIONS', 'LEGAL', 'RELEASE', 'APPEAL_REVIEW'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const QUEUES = ['all', 'submitted', 'correction', 'review', 'remediation', 'released', 'draft', 'closed'] as const;
export type Queue = (typeof QUEUES)[number];
export const HARD_STOPS = ['FALSIFIED_EVIDENCE', 'UNVERIFIABLE_OWNERSHIP', 'PROHIBITED_SANCTIONS_MATCH', 'UNMET_TURNOVER', 'UNSAFE_OR_COUNTERFEIT_PRODUCT', 'MISSING_AUTHORISATION', 'CRITICAL_FINDING', 'INSURER_CANCELLATION', 'CERTIFICATE_WITHDRAWN', 'ILLEGAL_IMPORT_ROUTE', 'SITE_ACCESS_REFUSED', 'UNDISCLOSED_MANUFACTURING_CHANGE'] as const;
export const WORKPAPER_KINDS = ['SITE_AUDIT', 'SAMPLE_PLAN', 'LAB_COMPETENCE', 'CONTRACT', 'MOCK_ORDER', 'IDENTITY_CHECK', 'BANK_VERIFICATION', 'SANCTIONS_SCREENING', 'SPECIALIST_REVIEW', 'AI_OUTPUT'] as const;
export type WorkpaperKind = (typeof WORKPAPER_KINDS)[number];
export const GATE_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'action'> = { NOT_STARTED: 'neutral', IN_PROGRESS: 'action', CORRECTION_REQUESTED: 'warning', PASSED: 'success', FAILED: 'danger' };
export const EVIDENCE_CATEGORIES = ['IDENTITY', 'BANKING', 'FINANCIAL', 'OWNERSHIP', 'BRAND', 'MANUFACTURING', 'AGREEMENT', 'PRODUCT', 'LABORATORY', 'CERTIFICATE', 'INSURANCE', 'CONTRACT', 'CAPA', 'INCIDENT', 'APPEAL', 'OTHER'] as const;

export interface AssessmentRow {
  id: string;
  number: string;
  kind: string;
  status: string;
  seller: string;
  legalName: string;
  sellerAccountId: string;
  owner: string | null;
  riskLevel: string;
  policyVersion: string;
  gatesPassed: number;
  stage: number;
  reviewTargetAt: string | null;
  overdue: boolean;
  openFindings: { critical: number; major: number; minor: number };
  hardStops: number;
  submittedAt: string | null;
}

export interface Gate { gate: number; status: string; reason: string | null; assignedTo: string | null; assignedUserId: string | null; decidedBy: string | null; decidedAt: string | null; policyVersion: string | null }
export interface ChecklistItem { code: string; text: string; gate: number | null; naAllowed: boolean; outcome: string; evidenceRef: string | null; reviewer: string | null; reviewedAt: string | null; expiresOn: string | null; comment: string | null; naReason: string | null; naApprovedBy: string | null; naApprovedAt: string | null }
export interface Dimension { code: string; label: string; weight: number; evidenceNeeded: string; rating: number | null; contribution: string | null; evidenceRef: string | null; reasoning: string | null; ratedBy: string | null; ratedAt: string | null }
export interface Evidence { id: string; category: string; evidenceKey: string; label: string; version: number; fileName: string | null; contentType: string; byteSize: number; uploadedByRole: string; scanState: string; retentionCategory: string; legalHold: boolean; createdAt: string; downloadable: boolean }
export interface ScopeItem { id: string; productKey: string; offerId: string | null; productName: string; productVersion: string; intendedUse: string; facilityRef: string; countryCode: string; channel: string; decision: string; catalogueCategory?: string | null; hsProposal?: string | null; regulatoryClass?: string | null; requiredTests?: string | null; authorisations?: string | null; authorisationExpiresOn?: string | null; localResponsible?: string | null; importerLicence?: string | null; labelsLanguages?: string | null; warnings?: string | null; restrictions?: string | null; recallObligations?: string | null; shippingInsurance?: string | null; decisionReason?: string | null; nextReviewAt?: string | null }
export interface Finding { id: string; number: string; classification: string; requirement: string; evidence: string; containment: string | null; rootCause: string | null; correctiveAction: string | null; preventiveAction: string | null; ownerName: string | null; raisedAt: string; containmentDueAt: string | null; planDueAt: string | null; closureDueAt: string; overdue: boolean; status: string; closureEvidenceIds: string[]; effectivenessVerification: string | null; closedAt: string | null; version: number }
export interface Workpaper { id: string; kind: string; subjectRef: string | null; mode: string; revision: number; payload: Record<string, unknown> | null; recordedBy: string | null; recordedAt: string }
export interface Certification { id: string; bodyName: string; scheme: string; status: string; certificateNumber: string | null; issuer: string | null; issuedOn: string | null; expiresOn: string | null; procurementRef?: string | null; paymentRef?: string | null; accreditationBody?: string | null; accreditationNumber?: string | null; accreditationVerified?: boolean; sectorScope?: string | null; legalRecognition?: string | null; conflictCheck?: string | null; independenceVerified?: boolean; facilityRefs?: string[]; productKeys?: string[]; authenticityMethod?: string | null; authenticityReference?: string | null; authenticatedAt?: string | null; surveillanceConditions?: string | null; statusReason?: string | null; version?: number }
export interface ApprovalScope { id: string; productKey: string; productVersion: string; offerId: string | null; facilityRef: string; countryCode: string; channel: string; status: string; validUntil: string; blockedReason: string | null }
export interface Approval { id: string; number: string; status: string; assessmentId: string; issuedAt: string; validUntil: string; nextReviewAt: string; policyVersion: string; policyStatusAtRelease: string; score: string; statusReason: string | null; auditDocumentId: string | null; record: Record<string, unknown> | null; scopes: ApprovalScope[] }
export interface TimelineEntry { id: string; kind: string; subjectType: string; actor: string | null; actorRole: string; capability: string | null; reason: string | null; policyVersion: string | null; evidenceRefs: string[]; at: string }

export interface AssessmentDetail {
  id: string;
  number: string;
  kind: string;
  status: string;
  version: number;
  policyVersion: string;
  policyInForce: { version: string; status: string };
  seller: { id: string; legalName: string; displayName: string; accountStatus: string; legacyApprovedAt: string | null };
  application: Record<string, unknown> | null;
  applicationProblems: string[];
  correctionNote: string | null;
  submittedAt: string | null;
  fileCompleteAt: string | null;
  reviewTargetAt: string | null;
  owner: string | null;
  ownerUserId: string | null;
  riskLevel: string;
  legacyNote: string | null;
  decision: string | null;
  decisionReason: string | null;
  hardStops: { stop: string; reason: string; at: string }[];
  gates: Gate[];
  checklist: ChecklistItem[];
  score: { display: string; band: string; belowDimensionMinimum: string[]; dimensions: Dimension[]; thresholds: { release: number; remediation: number; dimension: number } } | null;
  evidence: Evidence[];
  scope: ScopeItem[];
  findings: Finding[];
  workpapers: Workpaper[];
  certifications: Certification[];
  approvals: Approval[];
  timeline: TimelineEntry[];
}

export const assessmentKeys = {
  all: ['seller-assessments'] as const,
  list: (params: Record<string, unknown>) => ['seller-assessments', 'list', params] as const,
  one: (id: string) => ['seller-assessments', 'one', id] as const,
  gaps: (id: string) => ['seller-assessments', 'gaps', id] as const,
  policies: () => ['seller-assessments', 'policies'] as const,
  capabilities: () => ['seller-assessments', 'capabilities'] as const,
  registers: () => ['seller-assessments', 'registers'] as const,
  tasks: () => ['seller-assessments', 'tasks'] as const,
  dispositions: () => ['seller-assessments', 'dispositions'] as const,
  impact: () => ['seller-assessments', 'impact'] as const,
  retention: () => ['seller-assessments', 'retention'] as const,
};

export function fetchAssessments(p: { queue: Queue; search: string; risk: string; overdue: boolean; expiringDays: string; page: number }): Promise<{ total: number; counts: Record<string, number>; rows: AssessmentRow[] }> {
  const q = new URLSearchParams({ page: String(p.page), pageSize: '25' });
  if (p.queue !== 'all') q.set('queue', p.queue);
  if (p.search.trim() !== '') q.set('search', p.search.trim());
  if (p.risk !== '') q.set('risk', p.risk);
  if (p.overdue) q.set('overdue', 'true');
  if (p.expiringDays !== '') q.set('expiringDays', p.expiringDays);
  return api.get(`${base}?${q.toString()}`);
}

export const fetchAssessment = (id: string): Promise<{ assessment: AssessmentDetail }> => api.get(one(id));
export const fetchGaps = (id: string): Promise<{ gaps: string[]; score: string | null; band: string | null; policyAdopted: boolean }> => api.get(one(id, '/release-gaps'));
export const evidencePath = (id: string, evidenceId: string) => one(id, `/evidence/${enc(evidenceId)}`);
export const approvalPdfPath = (approvalId: string) => `${base}/approvals/${enc(approvalId)}/pdf`;

type Body = Record<string, unknown>;
export const post = (path: string, body: Body, key: string) => api.post(`${base}${path}`, body, w(key));
export const put = (path: string, body: Body, key: string) => api.put(`${base}${path}`, body, w(key));

export function uploadEvidence(id: string, input: { file: File; category: string; evidenceKey: string; label: string }, key: string) {
  const form = new FormData();
  form.append('category', input.category);
  form.append('evidenceKey', input.evidenceKey);
  form.append('label', input.label);
  form.append('file', input.file);
  return api.upload(one(id, '/evidence'), form, w(key));
}

export interface Policy { id: string; version: string; status: string; configJson: Record<string, unknown>; sourceDocument: string; note: string | null; createdByUserId: string | null; effectiveFrom: string | null; adoptedAt: string | null; adoptionReference: string | null; disclosedAt: string | null; disclosureReference: string | null }
export const fetchPolicies = (): Promise<{ inForce: { version: string; status: string }; gateMode: string; versions: Policy[] }> => api.get(`${base}/policies`);
export const fetchCapabilities = (): Promise<{ staff: { userId: string; fullName: string; role: string; capabilities: string[] }[] }> => api.get(`${base}/capabilities`);
export const fetchImpact = (): Promise<{ gateMode: string; policy: { version: string; status: string }; sellers: number; activeOffers: number; offersWithSomeScope: number; offersThatWouldBlock: number; note: string; rows: { sellerAccountId: string; seller: string; offers: number; covered: number; hasApproval: boolean; wouldBlock: number }[] }> => api.get(`${base}/impact`);
export const fetchRetention = (): Promise<{ categories: { category: string; years: number | null; dependency: string | null; files: number; onLegalHold: number }[] }> => api.get(`${base}/retention`);
export const fetchTasks = (): Promise<{ tasks: { id: string; sellerAccountId: string; kind: string; subjectRef: string | null; dueAt: string; status: string; note: string | null }[] }> => api.get(`${base}/tasks`);
export const fetchDispositions = (): Promise<{ dispositions: { id: string; orderId: string; sellerOrderNumber: string | null; seller: string | null; trigger: string; reason: string; status: string; createdAt: string }[] }> => api.get(`${base}/dispositions`);

export interface Registers {
  notices: { id: string; number: string; seller: string; kind: string; hardStop: string | null; reason: string; issuedAt: string; appealDeadline: string; affectedOrders: string[] }[];
  appeals: { id: string; notice: string; seller: string; grounds: string; status: string; submittedAt: string; targetBy: string; overdue: boolean }[];
  changes: { id: string; seller: string; kind: string; description: string; undisclosed: boolean; status: string; createdAt: string }[];
  incidents: { id: string; seller: string; severity: string; description: string; late: boolean; deadlineHours: number; status: string; reportedAt: string }[];
  bankChanges: { id: string; seller: string; beneficiaryName: string; accountLast4: string; status: string; version: number; contactConfirmedAt: string | null; firstApprovedAt: string | null; requestedAt: string }[];
}
export const fetchRegisters = (): Promise<Registers> => api.get(`${base}/registers`);
