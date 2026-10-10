/**
 * Shipment Assessment: the Audit Team's check between L1 and L2.
 *
 *   GET  /audit/shipment-assessments                 queues
 *   GET  /audit/shipment-assessments/:id             one case
 *   POST /audit/shipment-assessments/:id/...         rounds, checks, evidence, submit, qa, waiver, hold, reassessment
 *   GET/POST /audit/shipment-assessments/policy      the badge policy
 *   GET/PUT  /audit/sellers/:id/badge                a seller's Audit badge
 *   GET/POST /audit/seller-verification/:id/certificates
 *
 * The server decides everything; this file only carries it.
 */
import { api } from './api';

const enc = encodeURIComponent;
type Key = string;
const w = (idempotencyKey: Key) => ({ idempotencyKey });

export type AssessmentStatus =
  | 'AWAITING_L1'
  | 'READY_FOR_ASSESSMENT'
  | 'IN_PROGRESS'
  | 'AWAITING_QA'
  | 'WAIVER_REVIEW'
  | 'APPROVED_FOR_L2'
  | 'FAILED'
  | 'ON_HOLD'
  | 'REASSESSMENT_REQUIRED'
  | 'DISPATCHED'
  | 'CANCELLED';
export type BadgeTier = 'PLATINUM' | 'GOLD' | 'SILVER' | 'BRONZE';
export type Requirement = 'ASSESSMENT_REQUIRED' | 'WAIVER_ELIGIBLE' | 'WAIVER_ELIGIBLE_WITH_REVIEW';
export type CheckOutcome = 'PASS' | 'FAIL' | 'HOLD' | 'NOT_APPLICABLE';
export const BADGE_TIERS: readonly BadgeTier[] = ['PLATINUM', 'GOLD', 'SILVER', 'BRONZE'];
export const CHECK_OUTCOMES: readonly CheckOutcome[] = ['PASS', 'FAIL', 'HOLD', 'NOT_APPLICABLE'];

export const QUEUES = ['ready', 'inProgress', 'awaitingQa', 'waiver', 'approved', 'failed', 'reassessment', 'awaitingL1', 'history', 'rollout'] as const;
export type Queue = (typeof QUEUES)[number];

export interface AssessmentRow {
  id: string;
  number: string;
  status: AssessmentStatus;
  orderNumber: string;
  sellerOrderNumber: string;
  seller: string;
  badge: BadgeTier | null;
  units: number;
  lines: number;
  l1CompletedAt: string | null;
  l1Location: string | null;
  plannedL2At: string | null;
  requirement: Requirement;
  requirementReason: string;
  mandatoryInspection: boolean;
  assessor: string | null;
  qaReviewer: string | null;
  releaseDeadline: string | null;
  releaseKind: 'ASSESSMENT' | 'WAIVER' | null;
  certificate: string | null;
  existingAtRollout: boolean;
  blocked: boolean;
}

export interface AssessmentList {
  total: number;
  counts: Record<string, number>;
  rows: AssessmentRow[];
}

export interface ChecklistItem {
  code: string;
  section: string;
  label: string;
  phase: 'PRE_LOADING' | 'LOADING';
  evidenceRequired: boolean;
}

export interface CheckView {
  round: number;
  itemCode: string;
  section: string;
  phase: string;
  outcome: CheckOutcome;
  note: string | null;
  measuredValue: string | null;
  sampled: boolean;
  recordedByRole: string;
  recordedAt: string;
}

export interface Quantities {
  orderedQuantity: number | null;
  declaredQuantity: number | null;
  presentedQuantity: number | null;
  countedQuantity: number | null;
  sampledQuantity: number | null;
  approvedQuantity: number | null;
  sellingUnit: string | null;
  unitsPerPackage: number | null;
  packagesDeclared: number | null;
  packagesCounted: number | null;
  grossWeightDeclaredGrams: string | null;
  grossWeightMeasuredGrams: string | null;
  countingMethod: string | null;
  samplingMethod: string | null;
  sampleCoverageNote: string | null;
}

export interface RoundView {
  round: number;
  kind: 'ASSESSMENT' | 'WAIVER';
  checklistVersion: string;
  checklist: ChecklistItem[];
  startedAt: string | null;
  submittedAt: string | null;
  inspectionLocation: string | null;
  quantities: Quantities;
  outcome: 'PASSED' | 'FAILED' | 'HELD' | null;
  findingsSummary: string | null;
  qaDecision: string | null;
  qaNote: string | null;
  qaDecidedAt: string | null;
  correctiveAction: string | null;
  assessorUserId: string | null;
}

export interface DocumentView {
  id: string;
  number: string;
  kind: string;
  version: number;
  status: string;
  issuedAt: string;
  validUntil: string | null;
  dispatchBy: string | null;
  signedByName: string;
  signedByRole: string;
  round: number | null;
  supersedesId: string | null;
  revokedReason: string | null;
}

export interface EvidenceView {
  id: string;
  round: number;
  itemCode: string | null;
  fileName: string;
  contentType: string;
  byteSize: number;
  uploadedByRole: string;
  note: string | null;
  createdAt: string;
}

export interface AssessmentDetail {
  id: string;
  number: string;
  status: AssessmentStatus;
  version: number;
  orderNumber: string;
  sellerOrderNumber: string;
  seller: string;
  badge: BadgeTier | null;
  l1CompletedAt: string | null;
  l1Location: string | null;
  plannedL2At: string | null;
  releaseRefusal: string | null;
  releaseDeadline: string | null;
  loadingChecksCompletedAt: string | null;
  documents: DocumentView[];
  currentRound: number;
  requirement: Requirement;
  requirementReason: string;
  mandatoryInspection: boolean;
  mandatoryReason: string | null;
  readinessNote: string | null;
  sellerResponse: string | null;
  holdReason: string | null;
  lines: { sku: string; name: string; quantity: number }[];
  rounds: RoundView[];
  checks: CheckView[];
  evidence: EvidenceView[];
  applicabilityKnown: boolean;
  badgeAtEvaluation: BadgeTier | null;
  policyVersion: number;
  existingAtRollout: boolean;
  assessor: string | null;
  assessorUserId: string | null;
  qaReviewer: string | null;
  sellerStatus: string;
  events: { id: string; kind: string; fromStatus: string | null; toStatus: string | null; actorRole: string; actor: string | null; note: string | null; occurredAt: string }[];
  waivers: {
    id: string;
    decision: 'APPROVED' | 'REJECTED';
    badgeAtDecision: BadgeTier | null;
    policyVersion: number;
    historyReviewNote: string | null;
    reason: string;
    decidedBy: string | null;
    decidedAt: string;
    invalidatedAt: string | null;
    invalidationReason: string | null;
  }[];
  releases: {
    id: string;
    kind: 'ASSESSMENT' | 'WAIVER';
    status: string;
    round: number;
    dispatchDeadline: string;
    deadlineJustification: string;
    badgeAtIssue: BadgeTier | null;
    policyVersion: number;
    issuedAt: string;
    consumedAt: string | null;
    invalidatedAt: string | null;
    invalidationReason: string | null;
  }[];
  exceptions: { id: string; kind: string; detail: string; occurredAt: string; resolvedAt: string | null; resolutionNote: string | null }[];
}

export interface WaiverHistory {
  available: boolean;
  inspections: { job: string; result: string; status: string; at: string }[];
  assessments: { number: string; round: number; outcome: string; at: string | null }[];
  unresolvedComplaints: { id: string; status: string; at: string }[];
  seller: { status: string; qualityScore: string | null; badge: BadgeTier | null; badgeSetAt: string | null } | null;
}

export interface Policy {
  version: number;
  platinumRule: Requirement;
  goldRule: Requirement;
  silverRule: Requirement;
  bronzeRule: Requirement;
  unbadgedRule: Requirement;
  defaultDispatchDays: number | null;
  maxDispatchDays: number | null;
  sellerCertificateMonths: number;
  note: string | null;
  createdAt: string;
}

export interface BadgeInfo {
  badge: BadgeTier | null;
  setAt: string | null;
  version: number;
  history: { fromTier: BadgeTier | null; toTier: BadgeTier | null; reason: string; changedBy: string | null; at: string }[];
}

export const assessmentKeys = {
  all: ['shipment-assessment'] as const,
  list: (filters: object) => ['shipment-assessment', 'list', filters] as const,
  detail: (id: string) => ['shipment-assessment', 'detail', id] as const,
  history: (id: string) => ['shipment-assessment', 'waiver-history', id] as const,
  policy: () => ['shipment-assessment', 'policy'] as const,
  badge: (sellerId: string) => ['shipment-assessment', 'badge', sellerId] as const,
  certificates: (sellerId: string) => ['shipment-assessment', 'certificates', sellerId] as const,
};

const base = '/audit/shipment-assessments';
const one = (id: string, tail = '') => `${base}/${enc(id)}${tail}`;

export function fetchAssessments(filters: { queue: Queue; search: string; page: number }): Promise<AssessmentList> {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: '25' });
  if (filters.queue === 'rollout') params.set('rollout', 'true');
  else params.set('queue', filters.queue);
  if (filters.search !== '') params.set('search', filters.search);
  return api.get(`${base}?${params.toString()}`);
}

export const fetchAssessment = (id: string): Promise<{ assessment: AssessmentDetail }> => api.get(one(id));
export const fetchWaiverHistory = (id: string): Promise<WaiverHistory> => api.get(one(id, '/waiver-history'));
export const fetchPolicy = (): Promise<{ current: Policy | null; history: Policy[] }> => api.get(`${base}/policy`);
export const evidencePath = (id: string, evidenceId: string): string => one(id, `/evidence/${enc(evidenceId)}`);
export const documentPath = (id: string, documentId: string): string => one(id, `/documents/${enc(documentId)}`);

export const startRound = (id: string, expectedVersion: number, key: Key): Promise<unknown> => api.post(one(id, '/rounds'), { expectedVersion }, w(key));

export interface CheckInput {
  itemCode: string;
  outcome: CheckOutcome;
  note?: string | null;
  measuredValue?: string | null;
  sampled?: boolean;
}
export const recordChecks = (id: string, checks: CheckInput[], key: Key): Promise<unknown> => api.post(one(id, '/checks'), { checks }, w(key));

export type QuantityInput = Partial<Omit<Quantities, 'orderedQuantity'>> & { inspectionLocation?: string | null };
export const recordQuantities = (id: string, body: QuantityInput, key: Key): Promise<unknown> => api.put(one(id, '/quantities'), body, w(key));

export function uploadEvidence(id: string, input: { file: File; itemCode: string | null; note: string | null }, key: Key): Promise<{ id: string }> {
  const form = new FormData();
  if (input.itemCode !== null && input.itemCode !== '') form.append('itemCode', input.itemCode);
  if (input.note !== null && input.note.trim() !== '') form.append('note', input.note.trim());
  form.append('file', input.file);
  return api.upload(one(id, '/evidence'), form, w(key));
}

export const submitRound = (id: string, body: { findingsSummary: string; expectedVersion: number }, key: Key): Promise<unknown> => api.post(one(id, '/submit'), body, w(key));

export interface DeadlineInput {
  dispatchDeadline: string | null;
  deadlineJustification: string | null;
}
export const decideQa = (id: string, body: { decision: 'APPROVED' | 'RETURNED'; note: string | null; expectedVersion: number } & DeadlineInput, key: Key): Promise<unknown> =>
  api.post(one(id, '/qa'), body, w(key));
export const openWaiverReview = (id: string, expectedVersion: number, key: Key): Promise<unknown> => api.post(one(id, '/waiver-review'), { expectedVersion }, w(key));
export const decideWaiver = (
  id: string,
  body: { decision: 'APPROVED' | 'REJECTED'; reason: string; historyReviewNote: string | null; evidenceRefs: string[]; expectedVersion: number } & DeadlineInput,
  key: Key,
): Promise<unknown> => api.post(one(id, '/waiver'), body, w(key));
export const holdShipment = (id: string, body: { reason: string; expectedVersion: number }, key: Key): Promise<unknown> => api.post(one(id, '/hold'), body, w(key));
export const requireReassessment = (id: string, body: { reason: string; expectedVersion: number }, key: Key): Promise<unknown> =>
  api.post(one(id, '/reassessment'), body, w(key));
export const resolveException = (exceptionId: string, note: string, key: Key): Promise<unknown> =>
  api.post(`${base}/exceptions/${enc(exceptionId)}/resolve`, { note }, w(key));
export const revokeDocument = (documentId: string, reason: string, key: Key): Promise<unknown> => api.post(`/audit/audit-documents/${enc(documentId)}/revoke`, { reason }, w(key));
export const publishPolicy = (body: Omit<Policy, 'version' | 'createdAt' | 'note'> & { note: string }, key: Key): Promise<{ version: number }> => api.post(`${base}/policy`, body, w(key));

export const fetchBadge = (sellerId: string): Promise<BadgeInfo> => api.get(`/audit/sellers/${enc(sellerId)}/badge`);
export const setBadge = (sellerId: string, body: { tier: BadgeTier | null; reason: string; expectedVersion: number }, key: Key): Promise<unknown> =>
  api.put(`/audit/sellers/${enc(sellerId)}/badge`, body, w(key));
export const fetchCertificates = (sellerId: string): Promise<{ certificates: DocumentView[] }> => api.get(`/audit/seller-verification/${enc(sellerId)}/certificates`);
export const certificatePath = (sellerId: string, documentId: string): string => `/audit/seller-verification/${enc(sellerId)}/certificates/${enc(documentId)}`;
export const issueCertificate = (
  sellerId: string,
  body: { categories: string[]; markets: string[]; scopeNote: string; siteLocationId: string | null },
  key: Key,
): Promise<{ id: string; number: string }> => api.post(`/audit/seller-verification/${enc(sellerId)}/certificates`, body, w(key));
