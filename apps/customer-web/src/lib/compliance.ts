/**
 * Compliance in the Seller Hub: qualification cases, compliance documents,
 * and which approved requirements reach the categories a seller sells in.
 *
 * The server decides everything here. A seller can ask for a qualification,
 * answer a request for changes, withdraw, and add, replace and submit a
 * document; they cannot approve anything, and they never see a reviewer's
 * internal notes. An approved document has been REVIEWED - it is never
 * described as authenticated, because an uploaded file proves nothing by
 * itself.
 *
 * Every write carries an Idempotency-Key, generated once per attempt by the
 * caller and reused on a retry of that attempt.
 */
import { api } from './api';
import { countryName } from './iso-countries';
import type { Translate, TranslationKey } from '@/i18n/i18n-context';

export type SupplyRole = 'MANUFACTURER' | 'IMPORTER' | 'DISTRIBUTOR' | 'AUTHORISED_REPRESENTATIVE';
export const SUPPLY_ROLES: readonly SupplyRole[] = ['MANUFACTURER', 'IMPORTER', 'DISTRIBUTOR', 'AUTHORISED_REPRESENTATIVE'];

export type EnforcementMode = 'OFF' | 'WARN' | 'ENFORCE';

export type CaseStatus =
  | 'REQUESTED'
  | 'UNDER_REVIEW'
  | 'CHANGES_REQUESTED'
  | 'QUALIFIED'
  | 'REJECTED'
  | 'SUSPENDED'
  | 'EXPIRED'
  | 'REREVIEW_REQUIRED'
  | 'WITHDRAWN';
export const CASE_STATUSES: readonly CaseStatus[] = [
  'REQUESTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'QUALIFIED', 'REJECTED', 'SUSPENDED', 'EXPIRED', 'REREVIEW_REQUIRED', 'WITHDRAWN',
];

export type DocumentReviewStatus = 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'SUSPENDED';
export const DOCUMENT_STATUSES: readonly DocumentReviewStatus[] = [
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUSPENDED',
];

export type ComplianceDocumentType =
  | 'CERTIFICATE'
  | 'LICENCE'
  | 'REGISTRATION'
  | 'DECLARATION_OF_CONFORMITY'
  | 'TEST_REPORT'
  | 'AUTHORISATION'
  | 'OTHER';
export const DOCUMENT_TYPES: readonly ComplianceDocumentType[] = [
  'CERTIFICATE', 'LICENCE', 'REGISTRATION', 'DECLARATION_OF_CONFORMITY', 'TEST_REPORT', 'AUTHORISATION', 'OTHER',
];

export type RequirementState =
  | 'SATISFIED'
  | 'MISSING'
  | 'EXPIRED'
  | 'WRONG_SCOPE'
  | 'PENDING_REVIEW'
  | 'NOT_APPLICABLE'
  | 'NEEDS_DETERMINATION'
  | 'UNRESOLVED'
  | 'OPTIONAL_NOT_HELD';
export const REQUIREMENT_STATES: readonly RequirementState[] = [
  'SATISFIED', 'MISSING', 'EXPIRED', 'WRONG_SCOPE', 'PENDING_REVIEW', 'NOT_APPLICABLE', 'NEEDS_DETERMINATION', 'UNRESOLVED', 'OPTIONAL_NOT_HELD',
];

export interface ComplianceCase {
  id: string;
  caseNumber: string;
  level: 'SELLER_CATEGORY' | 'PRODUCT';
  categoryId: string;
  categoryName?: string;
  productId: string | null;
  supplyRole: string;
  destinationMarket: string;
  factoryId: string | null;
  status: string;
  decidedAt: string | null;
  expiresAt: string | null;
  /** What the reviewer chose to tell the seller. Never their internal note. */
  sellerMessage: string | null;
  updatedAt: string;
}

export interface ComplianceDocument {
  id: string;
  documentType: string;
  standard: string;
  certificateNumber: string | null;
  issuer: string;
  issuingCountry: string | null;
  legalEntityName: string | null;
  factoryId: string | null;
  categoryScopeIds: string[];
  productScopeIds: string[];
  modelScope: string | null;
  scope: string | null;
  requirementCodes: string[];
  issuedOn: string | null;
  expiresOn: string | null;
  noExpiryReason: string | null;
  reviewStatus: string;
  /** What may be said about an approved document: what was checked, never "authentic". */
  badge: 'EVIDENCE_REVIEWED' | 'VERIFIED_WITH_ISSUER_OR_REGISTER' | 'EVIDENCE_REVIEWED_REGISTER_UNAVAILABLE' | null;
  reviewMessage: string | null;
  revision: number;
  supersedesId: string | null;
  supersededAt: string | null;
  suspendedReason: string | null;
  hasFile: boolean;
  updatedAt: string;
}

export interface CategoryGate {
  categoryId: string;
  name: string;
  /** Whether a new listing in it may go live under the current setting. */
  allowed: boolean;
  /** Whether an approved mandatory rule reaches it and no qualification is held. */
  missing: boolean;
  mode: EnforcementMode;
}

export interface ComplianceOverview {
  cases: ComplianceCase[];
  documents: ComplianceDocument[];
  categories: CategoryGate[];
  approvedRuleCount: number;
}

export interface RequirementOutcome {
  requirementId: string;
  code: string;
  ruleVersion: number;
  name: string;
  obligation: 'LEGAL' | 'CONTRACTUAL' | 'OPTIONAL_QUALIFICATION';
  applicability: 'APPLIES' | 'CONDITIONAL' | 'UNRESOLVED';
  state: string;
  blocking: boolean;
  documentId: string | null;
  validUntil: string | null;
}

export interface CaseDetail {
  case: ComplianceCase;
  seller: { id: string; name: string };
  categoryName: string;
  product: { id: string; name: string } | null;
  evaluation: { outcomes: RequirementOutcome[]; ready: boolean; noApprovedRules: boolean; expiresAt: string | null };
  enforcement: EnforcementMode;
  history: { kind: string; actorLabel: string | null; summary: string; at: string }[];
}

export interface ApprovedRequirement {
  id: string;
  code: string;
  name: string;
  description: string | null;
  requiredEvidence: string | null;
  obligation: string;
  level: string;
  applicability: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
}

export interface DocumentDetail {
  document: ComplianceDocument;
  file: { fileName: string; contentType: string; byteSize: number; scanState: string } | null;
  versions: { id: string; revision: number; reviewStatus: string; supersededAt: string | null }[];
  history: { kind: string; actorLabel: string | null; summary: string; at: string }[];
}

export interface CaseRequest {
  level: 'SELLER_CATEGORY' | 'PRODUCT';
  categoryId: string;
  productId?: string | null;
  supplyRole: SupplyRole;
  /** '' for any market, an ISO alpha-2 code, or 'EU'. */
  destinationMarket: string;
  factoryId?: string | null;
  message?: string | null;
}

export interface DocumentInput {
  documentType: ComplianceDocumentType;
  standard: string;
  certificateNumber?: string | null;
  issuer: string;
  issuingCountry?: string | null;
  legalEntityName?: string | null;
  factoryId?: string | null;
  categoryScopeIds: string[];
  productScopeIds: string[];
  modelScope?: string | null;
  scope?: string | null;
  requirementCodes: string[];
  issuedOn?: string | null;
  expiresOn?: string | null;
  noExpiryReason?: string | null;
  documentId: string;
  replacesId?: string | null;
  submit: boolean;
}

export const complianceKeys = {
  overview: ['seller', 'compliance'] as const,
  requirements: (categoryId: string) => ['seller', 'compliance', 'requirements', categoryId] as const,
  case: (id: string) => ['seller', 'compliance', 'case', id] as const,
  document: (id: string) => ['seller', 'compliance', 'document', id] as const,
};

export function fetchComplianceOverview(): Promise<ComplianceOverview> {
  return api.get<ComplianceOverview>('/seller/compliance');
}

export async function fetchApprovedRequirements(categoryId: string): Promise<ApprovedRequirement[]> {
  return (await api.get<{ requirements: ApprovedRequirement[] }>('/seller/compliance/requirements', { query: { categoryId } })).requirements;
}

export function requestComplianceCase(input: CaseRequest, idempotencyKey: string): Promise<{ id: string; caseNumber: string; created: boolean }> {
  return api.post('/seller/compliance/cases', input, { idempotencyKey });
}

export function fetchComplianceCase(id: string): Promise<CaseDetail> {
  return api.get<CaseDetail>(`/seller/compliance/cases/${encodeURIComponent(id)}`);
}

export function respondToCase(id: string, input: { action: 'RESUBMIT' | 'WITHDRAW'; message?: string | null }, idempotencyKey: string): Promise<{ ok: true }> {
  return api.post(`/seller/compliance/cases/${encodeURIComponent(id)}/respond`, input, { idempotencyKey });
}

export function createComplianceDocument(input: DocumentInput, idempotencyKey: string): Promise<{ id: string }> {
  return api.post('/seller/compliance/documents', input, { idempotencyKey });
}

export function fetchComplianceDocument(id: string): Promise<DocumentDetail> {
  return api.get<DocumentDetail>(`/seller/compliance/documents/${encodeURIComponent(id)}`);
}

export function submitComplianceDocument(id: string, idempotencyKey: string): Promise<{ ok: true }> {
  return api.post(`/seller/compliance/documents/${encodeURIComponent(id)}/submit`, undefined, { idempotencyKey });
}

// --- Words ---------------------------------------------------------------------

/** "Manufacturer", "Importer"; a role this build does not know is shown as sent. */
export function supplyRoleLabel(t: Translate, role: string): string {
  return (SUPPLY_ROLES as readonly string[]).includes(role) ? t(`compliance.role.${role}` as TranslationKey) : role;
}

/** "any market", "the European Union", or the country's own name in the reader's language. */
export function marketLabel(t: Translate, market: string | null, language: string): string {
  if (market === null || market === '') return t('compliance.market.any');
  if (market === 'EU') return t('compliance.market.EU');
  return countryName(market, language);
}

/** A status with words of its own, or the status as sent when this build does not know it. */
export function caseStatusLabel(t: Translate, status: string): string {
  return (CASE_STATUSES as readonly string[]).includes(status) ? t(`compliance.caseStatus.${status}` as TranslationKey) : status;
}

export function documentStatusLabel(t: Translate, status: string): string {
  return (DOCUMENT_STATUSES as readonly string[]).includes(status) ? t(`compliance.documentStatus.${status}` as TranslationKey) : status;
}

export function requirementStateLabel(t: Translate, state: string): string {
  return (REQUIREMENT_STATES as readonly string[]).includes(state) ? t(`compliance.state.${state}` as TranslationKey) : state;
}

export function documentTypeLabel(t: Translate, type: string): string {
  return (DOCUMENT_TYPES as readonly string[]).includes(type) ? t(`compliance.docType.${type}` as TranslationKey) : type;
}

/** Which of a seller's documents may be sent for review from where they stand. */
export function canSubmitDocument(status: string): boolean {
  return status === 'DRAFT' || status === 'CHANGES_REQUESTED' || status === 'REJECTED' || status === 'EXPIRED';
}
