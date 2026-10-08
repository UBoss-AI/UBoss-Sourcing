/**
 * Every console call behind the sign-in, in one place.
 *
 * The same discipline as `audit.ts`: one spelling of every path, and each
 * React Query key beside the call it belongs to. Reads take filters; writes
 * take an `Idempotency-Key`, always - the caller holds one key per intended
 * action (see `useConsoleMutation`), so a retry after a lost response replays
 * the first answer instead of doing the thing twice.
 *
 * Agency WRITES go to `/audit/agency/...`; every READ goes through
 * `/audit/...`, which answers for both audiences from the session.
 */
import { api } from './api';
import type {
  CalendarResponse,
  CaseDetail,
  CaseRow,
  CorrectiveActionRow,
  CoverageRow,
  DashboardResponse,
  DocumentDecisionInput,
  DocumentDetail,
  DocumentRow,
  EvidenceItem,
  HealthBand,
  InsightsResponse,
  JobDetail,
  JobRow,
  PlanRow,
  ReportRow,
  RuleDetail,
  RuleInput,
  RuleView,
  SellerDetail,
  SellersResponse,
  TeamResponse,
} from './console-types';

const enc = encodeURIComponent;

/** A fresh key for one intended write. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type Key = string;
const w = (idempotencyKey: Key) => ({ idempotencyKey });

/** Every query key starts here, so one invalidation can refresh the console. */
export const consoleKeys = {
  all: ['audit', 'console'] as const,
  dashboard: () => ['audit', 'console', 'dashboard'] as const,
  jobs: (filters: Record<string, unknown> = {}) => ['audit', 'console', 'jobs', filters] as const,
  jobsAll: () => ['audit', 'console', 'jobs'] as const,
  job: (id: string) => ['audit', 'console', 'job', id] as const,
  calendar: (from: string, days: number) => ['audit', 'console', 'calendar', from, days] as const,
  reports: (filters: Record<string, unknown> = {}) => ['audit', 'console', 'reports', filters] as const,
  correctiveActions: (filters: Record<string, unknown> = {}) => ['audit', 'console', 'capa', filters] as const,
  checklists: () => ['audit', 'console', 'checklists'] as const,
  team: () => ['audit', 'console', 'team'] as const,
  sellers: (filters: Record<string, unknown> = {}) => ['audit', 'console', 'sellers', filters] as const,
  sellersAll: () => ['audit', 'console', 'sellers'] as const,
  seller: (id: string) => ['audit', 'console', 'seller', id] as const,
  cases: (filters: Record<string, unknown> = {}) => ['audit', 'console', 'cases', filters] as const,
  casesAll: () => ['audit', 'console', 'cases'] as const,
  products: (filters: Record<string, unknown> = {}) => ['audit', 'console', 'products', filters] as const,
  case: (id: string) => ['audit', 'console', 'case', id] as const,
  documents: (filters: Record<string, unknown> = {}) => ['audit', 'console', 'documents', filters] as const,
  documentsAll: () => ['audit', 'console', 'documents'] as const,
  document: (id: string) => ['audit', 'console', 'document', id] as const,
  rules: (filters: Record<string, unknown> = {}) => ['audit', 'console', 'rules', filters] as const,
  rulesAll: () => ['audit', 'console', 'rules'] as const,
  rule: (id: string) => ['audit', 'console', 'rule', id] as const,
  coverage: () => ['audit', 'console', 'coverage'] as const,
  insights: () => ['audit', 'console', 'insights'] as const,
};

// ---------------------------------------------------------------------------
// Dashboard, notifications
// ---------------------------------------------------------------------------

export const fetchDashboard = (): Promise<DashboardResponse> => api.get('/audit/dashboard');

export const markAllNotificationsRead = (): Promise<{ marked: number }> => api.post('/audit/notifications/read-all');

// ---------------------------------------------------------------------------
// Jobs (reads)
// ---------------------------------------------------------------------------

export interface JobFilters {
  status?: string;
  stage?: string;
  agencyId?: string;
  search?: string;
  overdue?: boolean;
}

export const fetchJobs = (filters: JobFilters): Promise<{ jobs: JobRow[] }> =>
  api.get('/audit/jobs', {
    query: {
      status: filters.status,
      stage: filters.stage,
      agencyId: filters.agencyId,
      search: filters.search,
      overdue: filters.overdue === true ? 'true' : undefined,
    },
  });

export const fetchJob = (id: string): Promise<JobDetail> => api.get(`/audit/jobs/${enc(id)}`);

export const fetchCalendar = (from: string, days: number): Promise<CalendarResponse> =>
  api.get('/audit/calendar', { query: { from, days } });

export const fetchReports = (filters: { result?: string; search?: string }): Promise<{ reports: ReportRow[] }> =>
  api.get('/audit/reports', { query: { result: filters.result, search: filters.search } });

export const reportPdfPath = (reportId: string): string => `/audit/reports/${enc(reportId)}/pdf`;

export const fetchCorrectiveActions = (filters: { status?: string }): Promise<{ items: CorrectiveActionRow[] }> =>
  api.get('/audit/corrective-actions', { query: { status: filters.status } });

/** Evidence is read through the console route, which answers for both audiences. */
export const evidencePath = (evidenceId: string): string => `/audit/evidence/${enc(evidenceId)}`;

// ---------------------------------------------------------------------------
// Jobs (agency writes, under /audit/agency)
// ---------------------------------------------------------------------------

const agencyJob = (id: string, action: string): string => `/audit/agency/jobs/${enc(id)}/${action}`;

export const acceptJob = (id: string, body: { conflictStatement: string; confirmNoConflict: true }, key: Key): Promise<unknown> =>
  api.post(agencyJob(id, 'accept'), body, w(key));

export const declineJob = (id: string, body: { reason: string }, key: Key): Promise<unknown> =>
  api.post(agencyJob(id, 'decline'), body, w(key));

export const assignInspector = (
  id: string,
  body: { inspectorMemberId: string; backupInspectorMemberId?: string | null },
  key: Key,
): Promise<unknown> => api.post(agencyJob(id, 'assign'), body, w(key));

export const declareConflict = (id: string, body: { hasConflict: boolean; details?: string | null }, key: Key): Promise<unknown> =>
  api.post(agencyJob(id, 'conflict'), body, w(key));

export const startJob = (id: string, key: Key): Promise<unknown> => api.post(agencyJob(id, 'start'), {}, w(key));

export interface CheckInput {
  itemCode: string;
  outcome: 'CONFORM' | 'NONCONFORM' | 'NOT_APPLICABLE';
  measuredValue?: string | null;
  note?: string | null;
  equipmentRef?: string | null;
  equipmentCalibratedUntil?: string | null;
  labReportEvidenceId?: string | null;
}

export const recordCheck = (id: string, body: CheckInput, key: Key): Promise<unknown> =>
  api.post(agencyJob(id, 'checks'), body, w(key));

export interface QuantitiesInput {
  unit: string;
  orderedQuantity?: string | null;
  declaredQuantity?: string | null;
  verifiedQuantity?: string | null;
  countingMethod?: string | null;
  countingNote?: string | null;
  packaging?: { unit: string; contains: string; of: string }[] | null;
  sampledQuantity?: string | null;
  functionallyTestedQuantity?: string | null;
  testedConformingQuantity?: string | null;
  testedNonconformingQuantity?: string | null;
  damagedQuantity?: string | null;
  packagingObservations?: string | null;
  labelingObservations?: string | null;
  damageObservations?: string | null;
}

export const recordQuantities = (id: string, body: QuantitiesInput, key: Key): Promise<unknown> =>
  api.post(agencyJob(id, 'quantities'), body, w(key));

export interface LabSampleInput {
  sampleCode: string;
  description: string;
  quantity?: string | null;
  unit?: string | null;
  sealNumber?: string | null;
  takenAt: string;
  laboratoryName?: string | null;
  laboratoryAccreditation?: string | null;
}

export const addLabSample = (id: string, body: LabSampleInput, key: Key): Promise<unknown> =>
  api.post(agencyJob(id, 'lab-samples'), body, w(key));

export const addCustodyEvent = (
  id: string,
  sampleId: string,
  body: { at: string; from: string; to: string; note?: string | null },
  key: Key,
): Promise<unknown> => api.post(`/audit/agency/jobs/${enc(id)}/lab-samples/${enc(sampleId)}/custody`, body, w(key));

export const recordLabResult = (
  id: string,
  sampleId: string,
  body: { labReportEvidenceId: string; resultSummary: string },
  key: Key,
): Promise<unknown> => api.post(`/audit/agency/jobs/${enc(id)}/lab-samples/${enc(sampleId)}/result`, body, w(key));

export const recordSampling = (
  id: string,
  body: { lotReference: string; sampledQuantity: number; acceptedQuantity: number; rejectedQuantity: number; cartonsOpened?: number | null },
  key: Key,
): Promise<unknown> => api.post(agencyJob(id, 'sampling'), body, w(key));

export const recordDefect = (
  id: string,
  body: {
    severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
    requirementRef: string;
    description: string;
    defectQuantity: number;
    unitRefs?: string[] | null;
    checkItemCode?: string | null;
  },
  key: Key,
): Promise<unknown> => api.post(agencyJob(id, 'defects'), body, w(key));

export const submitReport = (id: string, body: { summary?: string | null; limitations?: string | null }, key: Key): Promise<unknown> =>
  api.post(agencyJob(id, 'report/submit'), body, w(key));

export const returnReport = (id: string, body: { reason: string }, key: Key): Promise<unknown> =>
  api.post(agencyJob(id, 'report/return'), body, w(key));

export const signReport = (id: string, key: Key): Promise<unknown> => api.post(agencyJob(id, 'report/sign'), {}, w(key));

export const correctReport = (
  reportId: string,
  body: { reason: string; summary?: string | null; limitations?: string | null },
  key: Key,
): Promise<unknown> => api.post(`/audit/agency/reports/${enc(reportId)}/correct`, body, w(key));

export const reclassifyDefect = (
  defectId: string,
  body: { severity: 'CRITICAL' | 'MAJOR' | 'MINOR'; reason: string; evidenceId: string },
  key: Key,
): Promise<unknown> => api.post(`/audit/agency/defects/${enc(defectId)}/reclassify`, body, w(key));

export interface EvidenceUploadInput {
  file: File;
  purpose: string;
  defectId?: string | null;
  checkItemCode?: string | null;
  measurement?: string | null;
  note?: string | null;
  capturedAt?: string | null;
  latitude?: string | null;
  longitude?: string | null;
}

/**
 * Upload one evidence file.
 *
 * The text fields go into the form BEFORE the file: the server reads the
 * fields that arrive ahead of the file part, and a field after it is lost.
 * The idempotency key doubles as the client upload id, so a retried upload
 * is recognised as the same file.
 */
export function uploadEvidence(jobId: string, input: EvidenceUploadInput, key: Key): Promise<EvidenceItem> {
  const form = new FormData();
  form.append('purpose', input.purpose);
  const optional: [string, string | null | undefined][] = [
    ['defectId', input.defectId],
    ['checkItemCode', input.checkItemCode],
    ['measurement', input.measurement],
    ['note', input.note],
    ['capturedAt', input.capturedAt],
    ['latitude', input.latitude],
    ['longitude', input.longitude],
  ];
  for (const [name, value] of optional) {
    if (value !== null && value !== undefined && value.trim() !== '') form.append(name, value.trim());
  }
  form.append('clientUploadId', key.slice(0, 64));
  form.append('file', input.file);
  return api.upload(agencyJob(jobId, 'evidence'), form, w(key));
}

// ---------------------------------------------------------------------------
// Sub-lot releases (supervisor)
// ---------------------------------------------------------------------------

export const requestSubLotRelease = (
  jobId: string,
  body: {
    subLotCode: string;
    lotReference: string;
    quantity: string;
    unit: string;
    lines: { orderItemId: string; quantity: number }[];
    reason: string;
  },
  key: Key,
): Promise<unknown> => api.post(`/audit/jobs/${enc(jobId)}/sublot-releases`, body, w(key));

export const cancelSubLotRelease = (releaseId: string, key: Key): Promise<unknown> =>
  api.post(`/audit/sublot-releases/${enc(releaseId)}/cancel`, {}, w(key));

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

export const fetchPlans = (): Promise<{ plans: PlanRow[] }> => api.get('/audit/checklists');

export interface PlanInput {
  name: string;
  categoryId: string | null;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  inspectionLevel: string;
  aqlCritical: string;
  aqlMajor: string;
  aqlMinor: string;
  checklist: {
    code: string;
    section: string;
    label: string;
    requirement?: string | null;
    tolerance?: string | null;
    kind?: string;
    mandatory?: boolean;
    requiresLabReport?: boolean;
    requiresEquipment?: boolean;
  }[];
  language: string;
}

export const createPlan = (body: PlanInput, key: Key): Promise<{ id: string }> => api.post('/audit/checklists', body, w(key));

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export const fetchTeam = (): Promise<TeamResponse> => api.get('/audit/team');

export const inviteAgencyMember = (
  body: {
    email: string;
    fullName: string;
    role: 'AGENCY_ADMIN' | 'COORDINATOR' | 'INSPECTOR' | 'QA_REVIEWER';
    jobTitle?: string | null;
    idDocumentType?: string | null;
    idDocumentNumber?: string | null;
    competenceCategoryIds?: string[] | null;
    credentials?: string | null;
    credentialExpiresAt?: string | null;
  },
  key: Key,
): Promise<{ memberId: string; expiresAt: string }> => api.post('/audit/agency/team/invitations', body, w(key));

export const updateAgencyMember = (
  memberId: string,
  body: {
    role?: 'AGENCY_ADMIN' | 'COORDINATOR' | 'INSPECTOR' | 'QA_REVIEWER';
    jobTitle?: string | null;
    competenceCategoryIds?: string[] | null;
    credentials?: string | null;
    credentialExpiresAt?: string | null;
    status?: 'ACTIVE' | 'DISABLED';
  },
  key: Key,
): Promise<unknown> => api.patch(`/audit/agency/team/members/${enc(memberId)}`, body, w(key));

export const resendAgencyInvitation = (memberId: string, key: Key): Promise<{ expiresAt: string }> =>
  api.post(`/audit/agency/team/members/${enc(memberId)}/resend-invitation`, {}, w(key));

// ---------------------------------------------------------------------------
// Sellers and cases
// ---------------------------------------------------------------------------

export const fetchSellers = (filters: { search?: string; status?: string; health?: HealthBand; sort?: 'name' | 'risk' }): Promise<SellersResponse> =>
  api.get('/audit/sellers', { query: { search: filters.search, status: filters.status, health: filters.health, sort: filters.sort } });

/** Quality insights for the audit team: QIMA-style pass/fail, findings, suppliers and agencies. */
export const fetchInsights = (): Promise<InsightsResponse> => api.get('/audit/insights');

export const fetchSeller = (id: string): Promise<SellerDetail> => api.get(`/audit/sellers/${enc(id)}`);

export interface CaseFilters {
  level?: string;
  status?: string;
  sellerAccountId?: string;
  categoryId?: string;
  search?: string;
}

export const fetchCases = (filters: CaseFilters): Promise<{ cases: CaseRow[] }> =>
  api.get('/audit/cases', { query: { ...filters } });

export const fetchProductCases = (filters: { status?: string; search?: string }): Promise<{ cases: CaseRow[] }> =>
  api.get('/audit/products', { query: { status: filters.status, search: filters.search } });

export const fetchCase = (id: string): Promise<CaseDetail> => api.get(`/audit/cases/${enc(id)}`);

export const openCase = (
  body: {
    sellerAccountId: string;
    level: 'SELLER_CATEGORY' | 'PRODUCT';
    categoryId: string;
    supplyRole: string;
    productId?: string | null;
    destinationMarket?: string;
    message?: string | null;
  },
  key: Key,
): Promise<{ id: string; caseNumber: string; created: boolean }> => api.post('/audit/cases', body, w(key));

export type CaseActionName = 'start' | 'request-changes' | 'approve' | 'reject' | 'suspend';

export const decideCase = (
  id: string,
  action: CaseActionName,
  body: { expectedLockVersion: number; sellerMessage?: string | null; internalNote?: string | null },
  key: Key,
): Promise<{ status: string }> => api.post(`/audit/cases/${enc(id)}/${action}`, body, w(key));

export const recordDetermination = (
  id: string,
  body: { code: string; decision: 'APPLIES' | 'NOT_APPLICABLE' | 'UNRESOLVED'; reason: string },
  key: Key,
): Promise<unknown> => api.post(`/audit/cases/${enc(id)}/determinations`, body, w(key));

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface DocumentFilters {
  status?: string;
  sellerAccountId?: string;
  expiringWithinDays?: number;
  search?: string;
}

export const fetchDocuments = (filters: DocumentFilters): Promise<{ documents: DocumentRow[] }> =>
  api.get('/audit/documents', { query: { ...filters } });

export const fetchDocument = (id: string): Promise<DocumentDetail> => api.get(`/audit/documents/${enc(id)}`);

export const documentFilePath = (id: string): string => `/audit/documents/${enc(id)}/file`;

export type DocumentActionName = 'start' | 'request-changes' | 'approve' | 'reject' | 'suspend';

export const decideDocument = (id: string, action: DocumentActionName, body: DocumentDecisionInput, key: Key): Promise<unknown> =>
  api.post(`/audit/documents/${enc(id)}/${action}`, body, w(key));

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const fetchRules = (filters: { status?: string; categoryId?: string; search?: string }): Promise<{ rules: RuleView[] }> =>
  api.get('/audit/rules', { query: { ...filters } });

export const fetchCoverage = (): Promise<{ categories: CoverageRow[] }> => api.get('/audit/rules/coverage');

export const fetchRule = (id: string): Promise<RuleDetail> => api.get(`/audit/rules/${enc(id)}`);

export const draftRule = (body: RuleInput, key: Key): Promise<{ id: string }> => api.post('/audit/rules', body, w(key));

export const updateRule = (id: string, body: RuleInput & { lockVersion: number }, key: Key): Promise<unknown> =>
  api.put(`/audit/rules/${enc(id)}`, body, w(key));

export const submitRule = (id: string, key: Key): Promise<unknown> => api.post(`/audit/rules/${enc(id)}/submit`, {}, w(key));

export const approveRule = (id: string, note: string, key: Key): Promise<unknown> =>
  api.post(`/audit/rules/${enc(id)}/approve`, { note }, w(key));

export const rejectRule = (id: string, note: string, key: Key): Promise<unknown> =>
  api.post(`/audit/rules/${enc(id)}/reject`, { note }, w(key));

export const reviseRule = (id: string, key: Key): Promise<{ id: string; ruleVersion: number }> =>
  api.post(`/audit/rules/${enc(id)}/revise`, {}, w(key));

export const retireRule = (id: string, reason: string, key: Key): Promise<unknown> =>
  api.post(`/audit/rules/${enc(id)}/retire`, { reason }, w(key));

export const importResearchRules = (key: Key): Promise<{ created: number; skipped: { code: string; reason: string }[] }> =>
  api.post('/audit/rules/import-research', {}, w(key));
