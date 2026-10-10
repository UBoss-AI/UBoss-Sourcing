/**
 * Product evidence and product safety cases (Doc 08 and Doc 07).
 *
 *   GET  /audit/product-evidence               evidence per SKU/version, site and country
 *   GET  /audit/product-evidence/prompts       Doc 08 assurance matrix (reviewer prompts)
 *   POST /audit/product-evidence               record evidence           (Idempotency-Key)
 *   POST /audit/product-evidence/:id/status    verify, suspend, withdraw, reject
 *   GET  /audit/safety-cases                   cases + recall rehearsal status
 *   GET  /audit/safety-cases/:id               one case, its scope and actions
 *   GET  /audit/safety-cases/:id/trace         what the case reaches
 *   POST /audit/safety-cases                   open a case               (Idempotency-Key)
 *   POST /audit/safety-cases/:id/contain       contain
 *   POST /audit/safety-cases/:id/actions       reporting decision, notice, recall action (Idempotency-Key)
 *   POST /audit/safety-cases/:id/correction    root cause, correction, tests, certificates
 *   POST /audit/safety-cases/:id/release       human release (not by the opener)
 *   POST /audit/recall-rehearsals              annual rehearsal          (Idempotency-Key)
 *
 * The server decides everything, including separation of duties; this file
 * only carries it.
 */
import { api } from './api';

const enc = encodeURIComponent;
const w = (idempotencyKey: string) => ({ idempotencyKey });

export const EVIDENCE_KINDS = ['MANAGEMENT_SYSTEM_CERTIFICATE', 'PRODUCT_CERTIFICATE', 'TEST_REPORT', 'DECLARATION_OF_CONFORMITY', 'REGISTRATION', 'MARKETING_AUTHORISATION', 'LICENCE', 'OTHER'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type EvidenceStatus = 'UNVERIFIED' | 'VERIFIED' | 'SUSPENDED' | 'WITHDRAWN' | 'EXPIRED' | 'REJECTED';
/** The statuses a reviewer can set by hand. EXPIRED is set by the expiry sweep. */
export const EVIDENCE_ACTIONS = ['VERIFIED', 'SUSPENDED', 'WITHDRAWN', 'REJECTED'] as const;
export type EvidenceAction = (typeof EVIDENCE_ACTIONS)[number];

export interface EvidenceRow {
  id: string;
  sellerAccountId: string;
  offerId: string | null;
  productKey: string;
  productVersion: string;
  facilityRef: string;
  countryCode: string;
  departmentSlug: string | null;
  kind: EvidenceKind;
  scheme: string;
  issuer: string;
  accreditation: string | null;
  scope: string;
  certificateNumber: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  changeConditions: string | null;
  surveillanceDueAt: string | null;
  requiredForTrading: boolean;
  existingAccepted: boolean;
  gapAssessment: string | null;
  verificationMethod: string | null;
  verificationEvidence: string | null;
  verifiedAt: string | null;
  status: EvidenceStatus;
  statusReason: string | null;
  recordedById: string;
  createdAt: string;
  blocksTrading: boolean;
  /** What this kind of evidence does NOT prove. */
  limit: string | null;
  daysToExpiry: number | null;
}

export interface EvidenceInput {
  sellerAccountId: string;
  offerId?: string | null;
  productKey: string;
  productVersion: string;
  facilityRef: string;
  countryCode: string;
  departmentSlug?: string | null;
  kind: EvidenceKind;
  scheme: string;
  issuer: string;
  accreditation?: string | null;
  scope: string;
  certificateNumber?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  changeConditions?: string | null;
  surveillanceDueAt?: string | null;
  requiredForTrading: boolean;
  existingAccepted?: boolean;
  gapAssessment?: string | null;
}

export interface AssuranceRow {
  department: string;
  triggers: string;
  surveillance: string;
  sixMonth: 'ALL' | 'CONDITIONAL' | 'NONE';
}

export interface AssurancePrompts {
  row: AssuranceRow | null;
  notice: string;
  matrix: AssuranceRow[];
}

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export const SEVERITIES: readonly Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const SOURCE_TYPES = ['DISPUTE', 'INCIDENT', 'SURVEILLANCE', 'STAFF', 'AUTHORITY', 'REHEARSAL'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SCOPE_KINDS = ['OFFER', 'PRODUCT', 'FACILITY', 'LOT', 'SELLER'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export const ACTION_KINDS = ['REPORTING_DECISION', 'CUSTOMER_NOTICE', 'RETRIEVAL', 'DISPOSAL', 'REPAIR', 'REPLACEMENT', 'EFFECTIVENESS_CHECK', 'NOTE'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
/** A reporting decision is a qualified person's. There is deliberately no AI option. */
export const REPORTING_DECISIONS = ['REPORT', 'NOT_REQUIRED', 'PENDING_ADVICE'] as const;
export type ReportingDecision = (typeof REPORTING_DECISIONS)[number];
export const REHEARSAL_OUTCOMES = ['PASSED', 'GAPS_FOUND', 'FAILED'] as const;
export type RehearsalOutcome = (typeof REHEARSAL_OUTCOMES)[number];

export interface SafetyCaseRow {
  id: string;
  reference: string;
  title: string;
  description: string;
  severity: Severity;
  status: string;
  sourceType: SourceType;
  sourceId: string | null;
  sellerAccountId: string | null;
  containmentJson: { stopListings?: boolean; stopShipments?: boolean; stopRecurring?: boolean; note?: string } | null;
  rootCause: string | null;
  correctionEvidence: string | null;
  verificationTests: string | null;
  currentCertificates: string | null;
  releaseApprovedById: string | null;
  releasedAt: string | null;
  openedById: string;
  createdAt: string;
}

export interface ScopeRow {
  id: string;
  kind: ScopeKind;
  ref: string;
  label: string | null;
  contained: boolean;
}

export interface ActionRow {
  id: string;
  kind: ActionKind;
  authority: string | null;
  decision: ReportingDecision | null;
  deadlineAt: string | null;
  qualifiedRole: string | null;
  quantity: number | null;
  effectivenessPercentBp: number | null;
  detail: string;
  actorUserId: string;
  createdAt: string;
}

export interface SafetyCaseDetail extends SafetyCaseRow {
  scope: ScopeRow[];
  actions: ActionRow[];
}

export interface Rehearsal {
  id: string;
  year: number;
  scenario: string;
  outcome: RehearsalOutcome;
  performedAt: string;
}

export interface SafetyCaseList {
  cases: SafetyCaseRow[];
  rehearsal: { last: Rehearsal | null; due: boolean };
}

export interface Trace {
  orders: { orderId: string; orderNumber: string; status: string; country: string | null }[];
  unitsSold?: number;
  customers: number;
  countries: string[];
  unshipped: { id: string; sellerOrderNumber: string; status: string }[];
  recurring: number;
  stockUnits: number;
}

export interface ScopeInput {
  kind: ScopeKind;
  ref: string;
  label?: string | null;
}

export const productSafetyKeys = {
  evidence: (filter: { sellerAccountId?: string; countryCode?: string }) => ['audit', 'product-evidence', filter] as const,
  prompts: () => ['audit', 'product-evidence', 'prompts'] as const,
  cases: () => ['audit', 'safety-cases'] as const,
  case: (id: string) => ['audit', 'safety-cases', id] as const,
  trace: (id: string) => ['audit', 'safety-cases', id, 'trace'] as const,
};

export async function fetchEvidence(filter: { sellerAccountId?: string; countryCode?: string }): Promise<EvidenceRow[]> {
  const result = await api.get<{ evidence: EvidenceRow[] }>('/audit/product-evidence', { query: { sellerAccountId: filter.sellerAccountId || undefined, countryCode: filter.countryCode || undefined } });
  return result.evidence;
}

export function fetchPrompts(): Promise<AssurancePrompts> {
  return api.get<AssurancePrompts>('/audit/product-evidence/prompts');
}

export function recordEvidence(input: EvidenceInput, key: string): Promise<{ id: string; limit: string }> {
  return api.post('/audit/product-evidence', input, w(key));
}

export function setEvidenceStatus(id: string, input: { status: EvidenceAction; method?: string | null; evidence?: string | null; reason?: string | null }, key: string): Promise<void> {
  return api.post(`/audit/product-evidence/${enc(id)}/status`, input, w(key));
}

export function fetchSafetyCases(): Promise<SafetyCaseList> {
  return api.get<SafetyCaseList>('/audit/safety-cases');
}

export function fetchSafetyCase(id: string): Promise<SafetyCaseDetail> {
  return api.get<SafetyCaseDetail>(`/audit/safety-cases/${enc(id)}`);
}

export function fetchTrace(id: string): Promise<Trace> {
  return api.get<Trace>(`/audit/safety-cases/${enc(id)}/trace`);
}

export function openSafetyCase(input: { title: string; description: string; severity: Severity; sourceType: SourceType; sellerAccountId?: string | null; scope: ScopeInput[] }, key: string): Promise<{ id: string }> {
  return api.post('/audit/safety-cases', input, w(key));
}

export function containSafetyCase(id: string, input: { severity: Severity; stopListings: boolean; stopShipments: boolean; stopRecurring: boolean; note: string; addScope?: ScopeInput[] }, key: string): Promise<void> {
  return api.post(`/audit/safety-cases/${enc(id)}/contain`, input, w(key));
}

export interface ActionInput {
  kind: ActionKind;
  detail: string;
  authority?: string | null;
  decision?: ReportingDecision | null;
  deadlineAt?: string | null;
  qualifiedRole?: string | null;
  quantity?: number | null;
  effectivenessPercentBp?: number | null;
}

export function recordSafetyAction(id: string, input: ActionInput, key: string): Promise<void> {
  return api.post(`/audit/safety-cases/${enc(id)}/actions`, input, w(key));
}

export function recordCorrection(id: string, input: { rootCause: string; correctionEvidence: string; verificationTests: string; currentCertificates: string }, key: string): Promise<void> {
  return api.post(`/audit/safety-cases/${enc(id)}/correction`, input, w(key));
}

export function releaseSafetyCase(id: string, note: string, key: string): Promise<void> {
  return api.post(`/audit/safety-cases/${enc(id)}/release`, { note }, w(key));
}

export function recordRehearsal(input: { scenario: string; scopeTraced: string; minutesToTrace?: number | null; findings?: string | null; outcome: RehearsalOutcome; performedAt: string }, key: string): Promise<{ id: string }> {
  return api.post('/audit/recall-rehearsals', input, w(key));
}

/** A date input's value as the ISO instant the server parses. */
export function dateToIso(value: string): string | null {
  return value === '' ? null : new Date(`${value}T00:00:00.000Z`).toISOString();
}
