/**
 * The shapes the console's screens read, written against the backend's
 * response builders - never ahead of them:
 *
 *   modules/audit-console/views.service.ts   jobs, reports, CAPA, dashboard, sellers
 *   modules/inspection/views.service.ts      the job bundle (agency and operator)
 *   modules/compliance/case.service.ts       cases and their live evaluation
 *   modules/compliance/document.service.ts   compliance documents
 *   modules/compliance/requirement.service.ts rules and coverage
 *   domain/inspection-quantity.ts            the quantity summary
 *
 * Enum-like fields are typed as `string` where the server may add a member
 * without this file knowing: every label and badge falls back to a readable
 * form of the raw value rather than rendering nothing.
 *
 * Quantities are STRINGS (exact decimals). Nothing here is a float.
 */
import type { AgencyKind } from './types';

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/** One entry of a compliance history (case, document or rule). */
export interface HistoryEntry {
  kind: string;
  actorLabel: string | null;
  summary: string;
  at: string;
}

export type InspectionStage = 'RAW_MATERIAL' | 'DURING_PRODUCTION' | 'PRE_SHIPMENT' | 'RECEIVING';
export const INSPECTION_STAGES: readonly InspectionStage[] = ['RAW_MATERIAL', 'DURING_PRODUCTION', 'PRE_SHIPMENT', 'RECEIVING'];

export type ScopeMethod = 'FULL' | 'SAMPLE';

export const JOB_STATUSES = [
  'REQUESTED',
  'ACCEPTED',
  'DECLINED',
  'INSPECTOR_ASSIGNED',
  'IN_PROGRESS',
  'REPORT_SUBMITTED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type SlaState = 'ON_TIME' | 'ACCEPT_OVERDUE' | 'REPORT_OVERDUE';

export const QUANTITY_UNITS = [
  'PIECE',
  'PAIR',
  'SET',
  'BOX',
  'CARTON',
  'PALLET',
  'ROLL',
  'KILOGRAM',
  'GRAM',
  'LITRE',
  'MILLILITRE',
  'METRE',
  'SQUARE_METRE',
] as const;
export type QuantityUnit = (typeof QUANTITY_UNITS)[number];
/** Units that count whole things; a fraction of one is refused by the server. */
export const COUNTABLE_UNITS: readonly QuantityUnit[] = ['PIECE', 'PAIR', 'SET', 'BOX', 'CARTON', 'PALLET', 'ROLL'];

export const COUNTING_METHODS = ['FULL_COUNT', 'CARTON_COUNT', 'WEIGHED', 'MEASURED', 'DECLARED_ONLY'] as const;
export type CountingMethod = (typeof COUNTING_METHODS)[number];

export type DefectSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR';
export const DEFECT_SEVERITIES: readonly DefectSeverity[] = ['CRITICAL', 'MAJOR', 'MINOR'];

export const EVIDENCE_PURPOSES = [
  'GENERAL',
  'CHECKLIST',
  'SAMPLING',
  'PACKAGING',
  'MEASUREMENT',
  'DEFECT',
  'CAPA',
  'RELEASE',
  'BINDING',
  'RECLASSIFICATION',
] as const;
export type EvidencePurpose = (typeof EVIDENCE_PURPOSES)[number];

export const CHECKLIST_SECTIONS = ['PRODUCT', 'QUANTITY', 'PACKAGING', 'LABELLING'] as const;
export type ChecklistSection = (typeof CHECKLIST_SECTIONS)[number];

export const CHECK_KINDS = [
  'FUNCTION',
  'DIMENSION',
  'MATERIAL',
  'WEIGHT_COUNT_VOLUME',
  'LABELLING',
  'PACKAGING',
  'BATCH_SERIAL_EXPIRY',
  'VISUAL',
  'OTHER',
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export type CheckOutcome = 'CONFORM' | 'NONCONFORM' | 'NOT_APPLICABLE';

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface AgencyInspectorRow {
  id: string;
  fullName: string;
  role: string;
  status: string;
  jobTitle: string | null;
  identityVerifiedAt: string | null;
  credentialExpiresAt: string | null;
  credentials: string | null;
  competenceCategoryIdsJson: unknown;
  idDocumentType: string | null;
  idDocumentNumber: string | null;
}

export interface AgencyDashboard {
  agency: { name: string; dailyCapacity: number; status: string; independenceStatement: string | null };
  me: { memberId: string; fullName: string; role: string; permissions: string[] };
  counts: {
    offered: number;
    toAssign: number;
    assigned: number;
    inProgress: number;
    awaitingQa: number;
    completed: number;
    overdue: number;
  };
  jobs: JobRow[];
  inspectors: AgencyInspectorRow[];
  reports: {
    id: string;
    jobId: string;
    jobNumber: string;
    revision: number;
    status: string;
    result: string | null;
    submittedAt: string | null;
    signedAt: string | null;
    returnedAt: string | null;
  }[];
  invoices: {
    id: string;
    jobNumber: string;
    invoiceNumber: string;
    amountMinor: string;
    currency: string;
    payer: string;
    status: string;
    submittedAt: string | null;
    paidAt: string | null;
  }[];
}

export interface StaffDashboard {
  cases: Record<string, number>;
  documents: Record<string, number>;
  rules: { waitingForApproval: number; approved: number; drafts: number };
  inspections: { open: number; overdue: number; held: number; subLotsWaiting: number };
  documentsExpiringIn30Days: number;
}

export type DashboardResponse =
  | { audience: 'AGENCY'; agency: AgencyDashboard }
  | { audience: 'STAFF'; staff: StaffDashboard };

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** One row of `GET /audit/jobs`. Agency rows carry no `agencyKind` or `lotReference`. */
export interface JobRow {
  id: string;
  jobNumber: string;
  kind: string;
  stage?: string;
  scopeMethod?: string;
  status: string;
  scheduledFor: string | null;
  acceptDueAt: string | null;
  reportDueAt: string | null;
  inspectionPointType: string;
  inspectionPoint: unknown;
  inspectorMemberId: string | null;
  readinessSubmitted: boolean;
  lotSize: number;
  lotReference?: string | null;
  agencyName?: string;
  agencyKind?: AgencyKind;
  sellerName: string;
  sellerOrderNumber: string;
  slaState: string;
}

export interface SamplingClass {
  aql: string;
  sampleSize: number;
  accept: number;
  reject: number;
}

export interface SamplingPlan {
  lotSize: number;
  level: string;
  codeLetter: string;
  sampleSize: number;
  critical: SamplingClass;
  major: SamplingClass;
  minor: SamplingClass;
}

export interface CheckResult {
  id: string;
  itemCode: string;
  section: string;
  label: string;
  requirement: string | null;
  outcome: CheckOutcome;
  measuredValue: string | null;
  note: string | null;
  equipmentRef: string | null;
  equipmentCalibratedUntil: string | null;
  labReportEvidenceId: string | null;
  recordedAt: string | null;
}

export interface ChecklistItem {
  code: string;
  section: string;
  label: string;
  requirement?: string | null;
  tolerance?: string | null;
  kind?: string;
  mandatory?: boolean;
  requiresLabReport?: boolean;
  requiresEquipment?: boolean;
}

export interface JobReport {
  id: string;
  revision: number;
  status: string;
  result: string | null;
  summary: string | null;
  computation: unknown;
  content: unknown;
  contentHash: string;
  integrity: string;
  submittedAt: string | null;
  returnedAt: string | null;
  returnReason: string | null;
  signedAt: string | null;
  signedByName: string | null;
}

export interface JobDefect {
  id: string;
  ncrNumber: string;
  severity: DefectSeverity;
  originalSeverity: string | null;
  requirementRef: string;
  description: string;
  defectQuantity: number;
  status: string;
  reclassifiedAt: string | null;
  reclassificationReason: string | null;
  sellerResponse: string | null;
  correctiveAction: string | null;
  capaSubmittedAt: string | null;
  verifiedAt: string | null;
  verifiedByReportId: string | null;
}

export interface EvidenceItem {
  id: string;
  jobId: string | null;
  defectId: string | null;
  checkItemCode: string | null;
  purpose: string;
  mediaKind: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  contentHash: string;
  scanState: string;
  capturedAt: string | null;
  receivedAt: string | null;
  uploadedByLabel: string | null;
  uploadedByParty: string;
  latitude: string | null;
  longitude: string | null;
  measurement: string | null;
  note: string | null;
}

export interface ScopeLine {
  orderItemId: string;
  name: string;
  sku: string;
  variant: string | null;
  quantity: number;
  orderingUnit: string;
  unitQuantity: number;
}

export interface JobScope {
  orderNumber?: string;
  sellerOrderNumber?: string;
  poReference?: string;
  referenceSample?: string | null;
  lines?: ScopeLine[];
  specialRequirements?: string | null;
}

/** One job from the inspection bundle. */
export interface JobView {
  id: string;
  jobNumber: string;
  kind: string;
  reinspectionOfJobId: string | null;
  status: string;
  agency: { id: string; name: string };
  payer: string;
  bookedByParty: string;
  bookedByLabel: string | null;
  inspectionPointType: string;
  inspectionPoint: unknown;
  scheduledFor: string | null;
  language: string;
  standard: string;
  lotSize: number;
  sampling: SamplingPlan | null;
  scope: JobScope | null;
  readiness: unknown;
  readinessSubmittedAt: string | null;
  acceptDueAt: string | null;
  reportDueAt: string | null;
  acceptedAt: string | null;
  assignedAt: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  declineReason: string | null;
  inspector: {
    fullName: string;
    idDocumentType: string | null;
    idDocumentNumber: string | null;
    identityVerified: boolean;
  } | null;
  samplingRecord: {
    lotReference: string | null;
    sampledQuantity: number | null;
    acceptedQuantity: number | null;
    rejectedQuantity: number | null;
    cartonsOpened: number | null;
  } | null;
  checks: CheckResult[];
  reports: JobReport[];
  report: JobReport | null;
  defects: JobDefect[];
  evidence: EvidenceItem[];
}

export interface InspectionRequirementView {
  id: string;
  orderNumber: string;
  sellerOrderNumber: string;
  sellerName: string;
  level: string;
  status: string;
  gate: { allowed: boolean; sentence: string };
  reason: string | null;
  ruleName: string | null;
  purchaseOrder: { reference: string; inspectionRequirement: string | null; inspectionTerms: string | null } | null;
  referenceSample: {
    reference: string;
    referenceCode: string | null;
    quantity: string;
    unitOfMeasure: string;
    approvalCriteria: string | null;
    decisionReason: string | null;
    approvedAt: string | null;
    files: string[];
  } | null;
}

export interface GateView {
  required?: boolean;
  released?: boolean;
  open?: boolean;
  reason: string;
  sentence: string;
}

/** The quantity summary the server computes - never recomputed here. */
export interface QuantitySummary {
  unit: QuantityUnit;
  scopeMethod: ScopeMethod;
  reconciliation: {
    ordered: string;
    declared: string | null;
    verified: string | null;
    difference: string | null;
    status: 'NOT_VERIFIED' | 'MATCHES' | 'SHORT' | 'EXCESS';
  };
  functional: {
    tested: string | null;
    conforming: string | null;
    nonconforming: string | null;
    untested: string | null;
    observedNonconformingBasisPoints: number | null;
  };
  damaged: string | null;
  /** The server's sentence about what was tested. Shown as written. */
  statement: string;
  countingMethod: CountingMethod | null;
  countingNote: string | null;
  packaging: { unit: QuantityUnit; contains: string; of: QuantityUnit }[] | null;
  observations: { packaging: string | null; labelling: string | null; damage: string | null };
  raw: {
    unit: QuantityUnit;
    orderedQuantity: string;
    declaredQuantity: string | null;
    verifiedQuantity: string | null;
    sampledQuantity: string | null;
    functionallyTestedQuantity: string | null;
    testedConformingQuantity: string | null;
    testedNonconformingQuantity: string | null;
    damagedQuantity: string | null;
  };
}

export interface DefectUnitSummary {
  occurrences: { critical: number; major: number; minor: number; total: number };
  defectiveUnitsIdentified: number;
  defectiveUnitsByWorstSeverity: { critical: number; major: number; minor: number };
  occurrencesWithoutUnit: number;
}

export interface CustodyEvent {
  at: string;
  from: string;
  to: string;
  note?: string | null;
}

export interface LabSample {
  id: string;
  sampleCode: string;
  description: string;
  quantity: string | null;
  unit: QuantityUnit | null;
  sealNumber: string | null;
  takenAt: string | null;
  laboratoryName: string | null;
  laboratoryAccreditation: string | null;
  custody: unknown;
  labReportEvidenceId: string | null;
  resultSummary: string | null;
}

export interface ExtrasReport {
  id: string;
  revision: number;
  status: string;
  result: string | null;
  limitations: string | null;
  correctsReportId: string | null;
  correctionReason: string | null;
  supersededAt: string | null;
  signedAt: string | null;
  signedByName: string | null;
}

export interface SubLotRow {
  id: string;
  subLotCode: string;
  quantity: string;
  unit: QuantityUnit;
  state: string;
  requestedByLabel: string;
  requestedAt: string | null;
  decidedByLabel: string | null;
  decisionNote: string | null;
  consumedAt: string | null;
  linesJson: unknown;
}

export interface JobExtras {
  stage: string;
  scopeMethod: string;
  timezone: string | null;
  agencyName: string;
  agencyKind: AgencyKind;
  quantities: QuantitySummary | null;
  defectUnits: DefectUnitSummary;
  labSamples: LabSample[];
  reports: ExtrasReport[];
  subLots: SubLotRow[];
}

export interface EligibleInspector {
  id: string;
  fullName: string;
  identityVerified: boolean;
  credentialExpiresAt: string | null;
  competent: boolean;
}

export interface ConflictCheck {
  agencyProblems: string[];
  personalConflict: boolean;
  declarations: {
    memberId: string;
    fullName: string;
    hasConflict: boolean;
    details: string | null;
    declaredAt: string | null;
  }[];
}

export interface TimelineEvent {
  id: string;
  kind: string;
  actorParty: string;
  actorLabel: string | null;
  summary: string;
  jobId: string | null;
  createdAt: string | null;
}

export interface AgencyJobDetail {
  audience: 'AGENCY';
  job: JobView;
  requirement: InspectionRequirementView;
  gate: GateView;
  checklist: ChecklistItem[];
  conflictCheck: ConflictCheck;
  me: {
    memberId: string;
    role: string;
    isNamedInspector: boolean;
    allowedTransitions: { to: string; requiresReason: boolean }[];
  };
  eligibleInspectors: EligibleInspector[];
  consignments: { id: string; shipmentReference: string; containerNumbers: string[]; sealNumbers: string[] }[];
  extras: JobExtras;
}

export interface StaffJobDetail {
  audience: 'STAFF';
  job: JobView;
  requirement: InspectionRequirementView;
  gate: GateView;
  releases: unknown[];
  timeline: TimelineEvent[];
  checklist: ChecklistItem[];
  extras: JobExtras;
}

export type JobDetail = AgencyJobDetail | StaffJobDetail;

// ---------------------------------------------------------------------------
// Calendar, reports, corrective actions
// ---------------------------------------------------------------------------

export interface CalendarDay {
  date: string;
  booked: number;
  capacity: number;
  full: boolean;
  jobs: {
    id: string;
    jobNumber: string;
    status: string;
    time: string;
    inspectionPointType: string;
    inspectionPoint: unknown;
    readiness: 'READY' | 'NOT_READY';
    readyDate: string | null;
  }[];
}

export interface CalendarResponse {
  capacity: number;
  days: CalendarDay[];
}

export interface ReportRow {
  id: string;
  revision: number;
  result: string | null;
  signedAt: string | null;
  signedByName: string | null;
  superseded: boolean;
  isCorrection: boolean;
  jobId: string;
  jobNumber: string;
  stage: string;
  scopeMethod: string;
  kind: string;
  agencyName: string;
  agencyKind: AgencyKind;
  sellerName: string;
  sellerOrderNumber: string;
}

export interface CorrectiveActionRow {
  id: string;
  ncrNumber: string;
  severity: DefectSeverity;
  description: string;
  status: string;
  requirementRef: string;
  correctiveAction: string | null;
  sellerResponse: string | null;
  capaSubmittedAt: string | null;
  verifiedAt: string | null;
  jobId: string;
  jobNumber: string;
  agencyName: string;
  sellerName: string;
  sellerOrderNumber: string;
  reinspections: { id: string; jobNumber: string; status: string; reinspectionOfJobId: string | null }[];
}

// ---------------------------------------------------------------------------
// Checklists (plans)
// ---------------------------------------------------------------------------

export interface PlanRow {
  id: string;
  name: string;
  categoryId: string | null;
  version: number;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  inspectionLevel: string;
  aqlCritical: string;
  aqlMajor: string;
  aqlMinor: string;
  checklist: ChecklistItem[];
  language: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export interface ConsolePerson {
  memberId: string;
  userId: string;
  kind: 'STAFF' | 'AGENCY';
  fullName: string;
  email: string;
  role: string;
  status: string;
  agency: { id: string; name: string } | null;
  accountType: string;
  activated: boolean;
  mfaEnrolled: boolean;
  identityVerified: boolean | null;
  credentialExpiresAt: string | null;
  competenceCategoryIds: string[];
}

export interface TeamResponse {
  people: ConsolePerson[];
  agencies: {
    id: string;
    name: string;
    kind: AgencyKind;
    status: string;
    country: string | null;
    accreditation: string | null;
  }[];
  canManage: boolean;
}

// ---------------------------------------------------------------------------
// Sellers and cases
// ---------------------------------------------------------------------------

export interface SellerRow {
  id: string;
  name: string;
  kind: string;
  applicationStatus: string;
  country: string | null;
  qualifications: number;
  casesOpen: number;
  documentsWaiting: number;
}

export interface BackfillRow {
  sellerAccountId: string;
  categoryId: string;
  categoryName: string;
  liveOffers: number;
  sellerName: string;
}

export interface SellersResponse {
  sellers: SellerRow[];
  backfill: BackfillRow[];
}

export interface SellerCaseRow {
  id: string;
  caseNumber: string;
  level: string;
  categoryId: string;
  categoryName: string;
  productId: string | null;
  supplyRole: string;
  destinationMarket: string;
  status: string;
  expiresAt: string | null;
  updatedAt: string | null;
}

export interface SellerDocumentRow {
  id: string;
  standard: string;
  documentType: string;
  reviewStatus: string;
  expiresOn: string | null;
  requirementCodes: string[];
  categoryScopeIds: string[];
  revision: number;
  supersededAt: string | null;
}

export interface SellerDetail {
  seller: {
    id: string;
    name: string;
    kind: string;
    applicationStatus: string;
    country: string | null;
    statusReason: string | null;
  };
  businessIdentity: {
    note: string;
    checks: {
      kind: string;
      state: string;
      method: string | null;
      issuer: string | null;
      checkedAt: string | null;
      validUntil: string | null;
    }[];
    screening: { state: string; at: string | null }[];
  };
  factories: { id: string; name: string; city: string | null; countryCode: string | null }[];
  cases: SellerCaseRow[];
  documents: SellerDocumentRow[];
}

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

export type Obligation = 'LEGAL' | 'CONTRACTUAL' | 'OPTIONAL_QUALIFICATION';
export type Applicability = 'APPLIES' | 'CONDITIONAL' | 'UNRESOLVED';

export interface RequirementOutcome {
  requirementId: string;
  code: string;
  ruleVersion: number;
  name: string;
  obligation: Obligation;
  applicability: Applicability;
  state: RequirementState;
  blocking: boolean;
  documentId: string | null;
  validUntil: string | null;
}

export interface Evaluation {
  outcomes: RequirementOutcome[];
  ready: boolean;
  noApprovedRules: boolean;
  expiresAt: string | null;
}

export interface Determination {
  decision: 'APPLIES' | 'NOT_APPLICABLE' | 'UNRESOLVED';
  reason: string;
  by?: string;
  at?: string;
}

export interface CaseView {
  id: string;
  caseNumber: string;
  level: string;
  sellerAccountId: string;
  categoryId: string;
  productId: string | null;
  supplyRole: string;
  destinationMarket: string;
  factoryId: string | null;
  status: string;
  reviewerLabel: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  sellerMessage: string | null;
  internalNote?: string | null;
  determinations?: Record<string, Determination>;
  lockVersion: number;
  updatedAt: string;
}

export interface CaseRow extends CaseView {
  sellerName: string;
  categoryName: string;
  productName: string | null;
}

export interface CaseDetail {
  case: CaseView;
  seller: { id: string; name: string; kind: string; country: string | null; status: string };
  categoryName: string;
  product: { id: string; name: string } | null;
  evaluation: Evaluation;
  enforcement: string;
  history: HistoryEntry[];
}

export const SUPPLY_ROLES = ['MANUFACTURER', 'IMPORTER', 'DISTRIBUTOR', 'AUTHORISED_REPRESENTATIVE'] as const;
export type SupplyRole = (typeof SUPPLY_ROLES)[number];

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DocumentBadge =
  | 'EVIDENCE_REVIEWED'
  | 'VERIFIED_WITH_ISSUER_OR_REGISTER'
  | 'EVIDENCE_REVIEWED_REGISTER_UNAVAILABLE';

export interface ComplianceDocument {
  id: string;
  sellerAccountId: string;
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
  /** What may be said about it. Never "authentic" - only what was checked. */
  badge: DocumentBadge | null;
  verificationMethod: string | null;
  verificationOutcome: string;
  verificationSource: string | null;
  verifiedAt: string | null;
  reviewMessage: string | null;
  internalNote?: string | null;
  reviewerLabel: string | null;
  revision: number;
  supersedesId: string | null;
  supersededAt: string | null;
  suspendedReason: string | null;
  hasFile: boolean;
  updatedAt: string;
}

export interface DocumentRow extends ComplianceDocument {
  sellerName: string;
}

export interface DocumentDetail {
  document: ComplianceDocument;
  file: { fileName: string; contentType: string; byteSize: number; scanState: string } | null;
  versions: { id: string; revision: number; reviewStatus: string; supersededAt: string | null }[];
  history: HistoryEntry[];
}

export const VERIFICATION_METHODS = ['MANUAL_EVIDENCE', 'REGISTRY_LOOKUP', 'ISSUER_CONFIRMATION'] as const;
export const VERIFICATION_OUTCOMES = ['NOT_CHECKED', 'VERIFIED', 'UNABLE_TO_VERIFY', 'MISMATCH'] as const;

export interface DocumentDecisionInput {
  expectedStatus: 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'SUSPENDED';
  message?: string | null;
  internalNote?: string | null;
  verificationMethod?: (typeof VERIFICATION_METHODS)[number];
  verificationOutcome?: (typeof VERIFICATION_OUTCOMES)[number];
  verificationSource?: string | null;
  categoryScopeIds?: string[];
  productScopeIds?: string[];
  requirementCodes?: string[];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const RULE_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETIRED'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export const RISK_CLASSES = ['CLASS_I', 'I_STERILE', 'I_MEASURING', 'I_REUSABLE_SURGICAL', 'IIA', 'IIB', 'III'] as const;

export interface RuleView {
  id: string;
  code: string;
  ruleVersion: number;
  status: string;
  name: string;
  description: string;
  requiredEvidence: string;
  obligation: Obligation;
  level: 'SELLER_CATEGORY' | 'PRODUCT';
  categoryIds: string[];
  includeDescendants: boolean;
  supplyRoles: string[];
  originCountries: string[];
  destinationMarkets: string[];
  riskClasses: string[];
  productTypeNote: string | null;
  intendedUseNote: string | null;
  applicability: Applicability;
  applicabilityNote: string | null;
  expiryKind: 'DOCUMENT_EXPIRY' | 'NO_EXPIRY' | 'PERIODIC_REVIEW';
  reviewMonths: number | null;
  sourceUrl: string;
  sourceTitle: string;
  sourcePublisher: string;
  lastReviewedOn: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  importedFrom: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  draftedByUserId: string | null;
  draftedByLabel: string | null;
  submittedAt: string | null;
  decidedByLabel: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  supersedesId: string | null;
  lockVersion: number;
}

export interface RuleDetail {
  rule: RuleView;
  versions: { id: string; ruleVersion: number; status: string; decidedAt: string | null; decidedByLabel: string | null }[];
  history: HistoryEntry[];
}

export interface CoverageRow {
  categoryId: string;
  name: string;
  slug: string;
  depth: number;
  parentId: string | null;
  products: number;
  approved: number;
  approvedMandatory: number;
  awaitingApproval: number;
  unresolved: number;
  conditional: number;
  needsReview: boolean;
}

/** The body of POST /audit/rules and PUT /audit/rules/:id (plus `lockVersion`). */
export interface RuleInput {
  code: string;
  name: string;
  description: string;
  requiredEvidence: string;
  obligation: Obligation;
  level: 'SELLER_CATEGORY' | 'PRODUCT';
  categoryIds: string[];
  includeDescendants: boolean;
  supplyRoles: string[];
  originCountries: string[];
  destinationMarkets: string[];
  riskClasses: string[];
  productTypeNote: string | null;
  intendedUseNote: string | null;
  applicability: Applicability;
  applicabilityNote: string | null;
  expiryKind: 'DOCUMENT_EXPIRY' | 'NO_EXPIRY' | 'PERIODIC_REVIEW';
  reviewMonths: number | null;
  sourceUrl: string;
  sourceTitle: string;
  sourcePublisher: string;
  lastReviewedOn: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  effectiveFrom: string | null;
}
