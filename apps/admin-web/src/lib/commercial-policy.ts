/**
 * Typed helpers for the admin commercial-policy routes (Doc 07 delivery,
 * returns, refunds and disputes; Doc 08 commercial, certification and launch).
 *
 * Every proposed number is a DRAFT schedule a second person approves and
 * activates with evidence; nothing here activates anything by itself. Money
 * is a string of minor units, exactly as the API sends it.
 */
import { api } from '@/lib/api';

export const SCHEDULE_KINDS = ['COMMISSION', 'LARGE_ORDER_DISCOUNT', 'LOGISTICS_CHARGE', 'CERTIFICATION_RECOVERY', 'SECURITY', 'INSURANCE', 'PAYMENT_PLAN', 'SUBSCRIPTION', 'CASE_WINDOWS'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export const SCHEDULE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'RETIRED'] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];
export const HANDLING_KINDS = ['DANGEROUS_GOODS', 'LITHIUM_BATTERY', 'WOOD_PACKAGING', 'TEMPERATURE_CONTROL'] as const;
export const LAUNCH_EDIT_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'NOT_APPLICABLE'] as const;
export const REMEDY_KINDS = ['CORRECTION', 'REPAIR', 'REPLACEMENT', 'MISSING_QUANTITY_DELIVERY', 'PRICE_ADJUSTMENT', 'RETURN', 'REFUND', 'SERVICE_REPERFORMANCE', 'SETTLEMENT_HOLD', 'LISTING_SUSPENSION'] as const;
export const DECISION_PARTIES = ['SELLER', 'PLATFORM', 'PROVIDER', 'BUYER', 'INSURER'] as const;
export const TESTING_PAYERS = ['PLATFORM', 'SELLER', 'BUYER', 'PROVIDER'] as const;
export const IMPORTER_PARTIES = ['BUYER', 'SELLER', 'APPROVED_ARRANGEMENT', 'MARKETPLACE', 'OTHER'] as const;
export const REVIEW_ITEM_STATUSES = ['VERIFIED', 'PENDING', 'NOT_APPLICABLE', 'FAILED'] as const;
export const RECOVERY_SOURCES = ['CHARGEBACK', 'REFUND', 'CARRIER', 'INSURER', 'SELLER', 'OTHER'] as const;
export const SECURITY_FORMS = ['RESERVE', 'GUARANTEE', 'DEPOSIT', 'COMBINED'] as const;
export const REVIEW_OUTCOMES = ['NO_CHANGE', 'REDUCE_EXCESS', 'CONSIDER_REDUCTION', 'ISSUE_FOUND'] as const;
export const COST_KINDS = ['COST', 'CREDIT', 'SELLER_DEDUCTION'] as const;
export const RISK_GROUPS = ['GROUP_1', 'GROUP_2', 'GROUP_3'] as const;

export interface CommercialSchedule {
  id: string;
  kind: ScheduleKind;
  version: number;
  status: ScheduleStatus;
  title: string;
  sourceDocument: string;
  scopeJson: { countries?: string[]; channels?: string[]; sellerAccountIds?: string[] } | null;
  bodyJson: unknown;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  scheduleReference: string | null;
  preparedById: string | null;
  submittedAt: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  approvalEvidence: string | null;
  providerConfirmationRef: string | null;
  providerConfirmedAt: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleDetail extends CommercialSchedule {
  events: { id: string; kind: string; actorUserId: string | null; note: string | null; createdAt: string }[];
  activationProblems: string[];
}

export interface ScheduleEdit {
  title?: string;
  scope?: { countries?: string[]; channels?: ('B2B' | 'B2C')[] };
  body?: unknown;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  scheduleReference?: string | null;
  note?: string | null;
}

export interface CommercialReference {
  commission: { department: string; b2bBps: number; b2cBps: number; consideration: string }[];
  workedExample: { netGoodsMinor: string; commissionMinor: string; externalCostMinor: string; coordinationMinor: string; platformChargesBeforeTaxMinor: string };
  catalogueDifferences: { kind: string; department: string; name?: string }[];
}

export interface LaunchCountry {
  code: string;
  name: string;
  isEuVat: boolean;
  status: string;
  required: number;
  open: number;
}

export interface LaunchItem {
  status: string;
  ownerName: string | null;
  ownerUserId: string | null;
  scope: string | null;
  evidence: string | null;
  reviewerUserId: string | null;
  reviewedAt: string | null;
  expiresAt: string | null;
  blockingReason: string | null;
  sourceCheckedOn: string | null;
  sourceNote: string | null;
}

export interface LaunchDecision {
  key: string;
  title: string;
  source: string;
  owner: string;
  expires: boolean;
  citedSources: string[];
  item: LaunchItem | null;
  blocker: string | null;
}

export interface LaunchDetail {
  country: { code: string; name: string; isEuVat: boolean; isActive: boolean };
  launch: { countryCode: string; status: string; enabledAt?: string | null; note?: string | null };
  decisions: LaunchDecision[];
  blockers: { key: string; reason: string }[];
  notice: string;
}

export interface Programme {
  id: string;
  reference: string;
  sellerAccountId: string;
  title: string;
  currency: string;
  capBps: number;
  periodStart: string;
  periodEnd: string;
  status: string;
  eligibleCostMinor: string;
  reservedMinor: string;
  confirmedMinor: string;
  refundedMinor: string;
  creditedMinor: string;
  unrecoveredMinor: string;
}

export interface ProgrammeDetail extends Programme {
  costs: { id: string; kind: string; externalReference: string; supplierName: string; amountMinor: string; currency: string; eligible: boolean; verifiedAt: string | null; evidence: string; createdAt: string }[];
  allocations: { id: string; orderId: string | null; netGoodsMinor: string; amountMinor: string; refundedMinor: string; currency: string; status: string; createdAt: string }[];
}

export interface SecuritySchedule {
  id: string;
  sellerAccountId: string;
  tier: string;
  form: string;
  reserveBps: number;
  holdDays: number;
  guaranteeMinor: string;
  depositMinor: string;
  capMinor: string | null;
  currency: string;
  status: string;
  providerPermissionRef: string | null;
  activatedAt: string | null;
  nextMonthlyReviewAt: string | null;
  nextQuarterlyReviewAt: string | null;
}

export interface SecurityReview {
  id: string;
  scheduleId: string;
  kind: string;
  periodKey: string;
  heldMinor: string | null;
  exposureMinor: string | null;
  excessMinor: string | null;
  outcome: string;
  note: string | null;
  reviewedAt: string | null;
  dueAt: string;
}

export interface SecurityView {
  proposals: Record<string, { reserveBps: number; holdDays: number; guaranteeAlternative: boolean }>;
  schedules: SecuritySchedule[];
  reviews: SecurityReview[];
}

export interface InsurancePolicy {
  id: string;
  holderType: 'SELLER' | 'PLATFORM';
  sellerAccountId: string | null;
  coverType: string;
  riskGroup: string | null;
  insurer: string;
  policyNumber: string;
  insuredEntity: string;
  currency: string;
  perOccurrenceMinor: string | null;
  aggregateMinor: string | null;
  effectiveFrom: string;
  expiresAt: string;
  verificationStatus: string;
  brokerName: string | null;
  brokerReviewedAt: string | null;
  gaps: string[];
  daysToExpiry: number;
}

export interface InsuranceView {
  groups: { code: string; description: string; productLiabilityPerOccurrenceMinor: string; productLiabilityAggregateMinor: string; recallLimitMinor: string; recallNote: string; securityTreatment: string }[];
  notice: string;
  policies: InsurancePolicy[];
}

export interface CommissionAdjustment {
  id: string;
  refundId: string;
  orderItemId: string;
  sellerOrderGroupId: string | null;
  refundedGoodsMinor: string;
  reversedMinor: string;
  currency: string;
  basis: string;
  fault: string;
  status: string;
  appliedAt: string | null;
  createdAt: string;
}

export interface LocalActor {
  role: string;
  name: string;
  evidence: string;
  verified: boolean;
}

export interface ImportRoute {
  id: string;
  countryCode: string;
  categoryId: string | null;
  channel: 'B2B' | 'B2C';
  importerParty: string;
  importerName: string | null;
  localActorsJson: LocalActor[];
  regulatedCategory: boolean;
  status: string;
  evidence: string | null;
  validUntil: string | null;
  note: string | null;
  reviewedAt: string | null;
}

export interface ProviderReview {
  id: string;
  providerName: string;
  logisticsPartnerId: string | null;
  itemsJson: Record<string, { status: string; evidence?: string | null }>;
  integrationStatus: string;
  status: string;
  reviewedAt: string | null;
  nextReviewAt: string | null;
  updatedAt: string;
}

export interface HandlingRequirement {
  id: string;
  kind: string;
  categoryId: string | null;
  destinationCountry: string | null;
  requiredEvidence: string;
  isActive: boolean;
}

export interface ProductEvidence {
  id: string;
  sellerAccountId: string;
  productKey: string;
  productVersion: string;
  facilityRef: string;
  countryCode: string;
  kind: string;
  scheme: string;
  issuer: string;
  certificateNumber: string | null;
  expiresOn: string | null;
  status: string;
  blocksTrading: boolean;
  daysToExpiry: number | null;
}

export interface SafetyCase {
  id: string;
  reference: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  sourceType: string;
  rootCause: string | null;
  correctionEvidence: string | null;
  releasedAt: string | null;
  createdAt: string;
}

export interface SafetyCaseDetail extends SafetyCase {
  scope: { id: string; kind: string; ref: string; label: string | null; contained: boolean }[];
  actions: { id: string; kind: string; authority: string | null; decision: string | null; deadlineAt: string | null; detail: string; createdAt: string }[];
}

export interface LineSnapshot {
  id: string;
  orderItemId: string;
  sellerOrderGroupId: string | null;
  sellerAccountId: string | null;
  manufacturerName: string | null;
  productVersion: string | null;
  facilityRef: string | null;
  sellerCountry: string | null;
  destinationCountry: string;
  channel: string;
  deliveryTerm: string;
  namedPlace: string | null;
  importerOfRecord: string;
  currency: string;
  commissionBaseMinor: string;
  commissionBps: number;
  commissionMinor: string;
  commissionSource: string;
  commissionRuleVersion: string | null;
  rounding: string;
  policyVersionsJson: unknown;
  controlGapsJson: unknown;
}

export type RefundState = 'REQUESTED' | 'SUBMITTED' | 'PENDING_PROVIDER' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface RefundStatus {
  id: string;
  amountMinor: string;
  currency: string;
  instructedAt: string;
  providerConfirmedAt: string | null;
  state: RefundState;
  outcomeUnknown: boolean;
}

export interface CaseControls {
  dispute: { id: string; reference: string; status: string; orderId: string; currency: string };
  profile: {
    category: string;
    urgency: string;
    lateIntake: boolean;
    lateIntakeReason: string | null;
    acknowledgementDueAt: string;
    acknowledgedAt: string | null;
    evidenceSufficientAt: string | null;
    evidenceSufficientReason: string | null;
    initialDecisionDueAt: string | null;
    appealReviewDueAt: string | null;
    appealReviewerId: string | null;
  } | null;
  requests: { id: string; requestedFrom: string; purpose: string; description: string; dueAt: string; status: string }[];
  remedies: { id: string; kind: string; amountMinor: string | null; currency: string | null; payer: string; quantity: number | null; expectedCompletionAt: string; status: string; completedAt: string | null }[];
  testing: { id: string; laboratory: string; interimPayer: string; costMinor: string; currency: string; status: string; finalPayer: string | null }[];
  recoveries: { id: string; source: string; sourceReference: string; amountMinor: string; currency: string; status: string; overlapNote: string | null }[];
  legalNotice: string;
}

export interface GroupControls {
  status: string;
  editable: boolean;
  gateMode: string;
  lines: LineSnapshot[];
}

export interface DispatchControls {
  gateMode: string;
  gaps: string[];
  requirements: string[];
  booking: { lane: string; status: string; packaging: string; singleSourceReason: string | null } | null;
  quotes: { id: string; providerName: string; amountMinor: string; currency: string; transitDaysMin: number | null; transitDaysMax: number | null; comparable: boolean }[];
  evidence: { temperatureLogRef: string | null; sealsJson: unknown; packingPhotoRefsJson: unknown } | null;
  custody: { id: string; fromParty: string; toParty: string; place: string; handedOverAt: string; packages: number; sealsIntact: boolean }[];
  partials: { id: string; orderApprovalRef: string; approvedByParty: string; billedMinor: string; currency: string }[];
}

const base = '/admin/commercial';

export const commercialApi = {
  reference: () => api.get<CommercialReference>(`${base}/reference`),
  schedules: (filter: { kind?: string; status?: string }) =>
    api.get<{ schedules: CommercialSchedule[] }>(`${base}/schedules`, { query: { ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.status ? { status: filter.status } : {}) } }),
  schedule: (id: string) => api.get<ScheduleDetail>(`${base}/schedules/${id}`),
  preview: (id: string, q: { goodsMinor: string; externalFreightMinor: string; channel: string }) =>
    api.get<unknown>(`${base}/schedules/${id}/preview`, { query: q }),
  draft: (kind: ScheduleKind) => api.post<{ id: string }>(`${base}/schedules`, { kind }),
  edit: (id: string, body: ScheduleEdit) => api.patch(`${base}/schedules/${id}`, body),
  submit: (id: string) => api.post(`${base}/schedules/${id}/submit`),
  decide: (id: string, body: { approve: boolean; evidence: string; providerConfirmationRef?: string | null }) => api.post(`${base}/schedules/${id}/decision`, body),
  providerConfirmation: (id: string, reference: string) => api.post(`${base}/schedules/${id}/provider-confirmation`, { reference }),
  activate: (id: string) => api.post(`${base}/schedules/${id}/activate`),
  retire: (id: string, reason: string) => api.post(`${base}/schedules/${id}/retire`, { reason }),

  launches: () => api.get<{ countries: LaunchCountry[] }>(`${base}/launch`),
  launch: (cc: string) => api.get<LaunchDetail>(`${base}/launch/${cc}`),
  saveLaunchItem: (cc: string, key: string, body: Record<string, unknown>) => api.put(`${base}/launch/${cc}/${key}`, body),
  reviewLaunchItem: (cc: string, key: string, body: { approve: boolean; note: string }) => api.post(`${base}/launch/${cc}/${key}/review`, body),
  setCountry: (cc: string, enable: boolean, note: string) => api.post(`${base}/launch/${cc}/${enable ? 'enable' : 'disable'}`, { note }),

  programmes: () => api.get<{ programmes: Programme[] }>(`${base}/certification-programmes`),
  programme: (id: string) => api.get<ProgrammeDetail>(`${base}/certification-programmes/${id}`),
  createProgramme: (body: Record<string, unknown>) => api.post(`${base}/certification-programmes`, body),
  recordCost: (id: string, body: Record<string, unknown>) => api.post(`${base}/certification-programmes/${id}/costs`, body),
  verifyCost: (costId: string, eligible: boolean) => api.post(`${base}/certification-costs/${costId}/verify`, { eligible }),
  programmeStatus: (id: string, status: 'ACTIVE' | 'PAUSED' | 'CLOSED') => api.post(`${base}/certification-programmes/${id}/status`, { status }),

  security: () => api.get<SecurityView>(`${base}/security`),
  proposeSecurity: (body: Record<string, unknown>) => api.post(`${base}/security`, body),
  activateSecurity: (id: string, providerPermissionRef: string) => api.post(`${base}/security/${id}/activate`, { providerPermissionRef }),
  completeReview: (id: string, body: { exposureMinor: string; outcome: string; note: string }) => api.post(`${base}/security-reviews/${id}`, body),

  insurance: () => api.get<InsuranceView>(`${base}/insurance`),
  saveInsurance: (body: Record<string, unknown>) => api.put(`${base}/insurance`, body),
  verifyInsurance: (id: string, body: { verified: boolean; method: string }) => api.post(`${base}/insurance/${id}/verify`, body),

  adjustments: () => api.get<{ adjustments: CommissionAdjustment[] }>(`${base}/commission-adjustments`),
  applyAdjustment: (id: string, creditNoteReference: string) => api.post(`${base}/commission-adjustments/${id}/apply`, { creditNoteReference }),

  importRoutes: (countryCode?: string) => api.get<{ routes: ImportRoute[] }>(`${base}/import-routes`, { query: countryCode ? { countryCode } : {} }),
  saveImportRoute: (body: Record<string, unknown>) => api.put(`${base}/import-routes`, body),
  decideImportRoute: (id: string, body: { approve: boolean; note: string }) => api.post(`${base}/import-routes/${id}/decision`, body),

  providerReviews: () => api.get<{ items: string[]; reviews: ProviderReview[] }>(`${base}/provider-reviews`),
  saveProviderReview: (body: Record<string, unknown>) => api.put(`${base}/provider-reviews`, body),
  decideProviderReview: (id: string, approve: boolean) => api.post(`${base}/provider-reviews/${id}/decision`, { approve }),

  handling: () => api.get<{ requirements: HandlingRequirement[]; customsDocumentKinds: string[] }>(`${base}/handling-requirements`),
  saveHandling: (body: Record<string, unknown>) => api.put(`${base}/handling-requirements`, body),

  productEvidence: () => api.get<{ evidence: ProductEvidence[] }>(`${base}/product-evidence`),
  safetyCases: () => api.get<{ cases: SafetyCase[] }>(`${base}/safety-cases`),
  safetyCase: (id: string) => api.get<SafetyCaseDetail>(`${base}/safety-cases/${id}`),

  orderControls: (orderId: string) => api.get<{ lines: LineSnapshot[]; refunds: RefundStatus[] }>(`/admin/orders/${orderId}/commercial-controls`),
  groupControls: (groupId: string) => api.get<GroupControls>(`/admin/seller-orders/${groupId}/controls`),
  dispatchControls: (groupId: string) => api.get<DispatchControls>(`/admin/seller-orders/${groupId}/dispatch-controls`),
  lossRecovery: (orderId: string, body: Record<string, unknown>) => api.post(`/admin/orders/${orderId}/loss-recoveries`, body),

  caseControls: (disputeId: string) => api.get<CaseControls>(`/admin/disputes/${disputeId}/case-controls`),
  caseAction: (disputeId: string, path: string, body?: unknown, method: 'post' | 'put' = 'post') =>
    method === 'put' ? api.put(`/admin/disputes/${disputeId}/case-controls/${path}`, body) : api.post(`/admin/disputes/${disputeId}/case-controls/${path}`, body),
  caseAssignees: () => api.get<{ assignees: { id: string; email: string }[] }>('/admin/disputes/assignees'),
  completeRemedy: (remedyId: string, body: { refundId?: string | null; note?: string | null }) => api.post(`/admin/disputes/remedies/${remedyId}/complete`, body),
};

/** Basis points to a percentage string: 1250 -> "12.5%". */
export function bpsToPercent(bps: number): string {
  return `${String(bps / 100)}%`;
}
