/**
 * Seller onboarding verification, as the Audit Team works it.
 *
 * The Audit Team owns seller verification: taking an application for review,
 * asking for corrections, approving or rejecting it, accepting or refusing its
 * documents and turnover, and recording manual screenings. The Admin Panel
 * reads the same records and cannot change them. The server checks
 * `audit.seller.verify` on every write here; hiding a button is a courtesy.
 *
 * The types mirror the Admin Panel's seller client, because both panels read
 * the same application from the same service. One rule carries over: a
 * seller-visible reason and an internal note are different fields, always.
 */
import { api } from './api';

type Key = string;
const w = (idempotencyKey: Key) => ({ idempotencyKey });
const enc = encodeURIComponent;

export type SellerApplicationStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'ACTION_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUSPENDED';

export interface SellerApplicationRow {
  id: string;
  legalName: string;
  displayName: string;
  status: SellerApplicationStatus;
  registrationCountry: string;
  kind: string;
  submittedAt: string | null;
  completedSteps: number;
  requiredSteps: number;
  documentCount: number;
  /** Sent back after the Audit Team asked for corrections. */
  resubmitted: boolean;
}

export interface SellerApplicationList {
  rows: SellerApplicationRow[];
  total: number;
  counts: Record<string, number>;
}

export function fetchSellerApplications(
  params: URLSearchParams,
): Promise<SellerApplicationList> {
  return api.get<SellerApplicationList>(`/admin/sellers?${params.toString()}`);
}

/** One application in full, including everything the seller never sees. */
export interface SellerApplicationDetail {
  id: string;
  legalName: string;
  displayName: string;
  slug: string;
  kind: string;
  status: SellerApplicationStatus;
  registrationCountry: string;
  description: string | null;
  statusReason: string | null;
  /** Operator-only. Rendered in its own panel, clearly marked. */
  internalNotes: string | null;
  resubmissionAllowed: boolean;
  commissionBasisPoints: number | null;
  qualityScore: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  approvedAt: string | null;
  suspendedAt: string | null;
  createdAt: string;
  /** Optimistic concurrency, so two reviewers cannot overwrite each other. */
  version: number;

  businessProfile: {
    representativeName: string | null;
    representativeEmail: string | null;
    representativePhone: string | null;
    representativeRole: string | null;
    supportEmail: string | null;
    supportPhone: string | null;
    legalForm: string | null;
    companyRegistrationNumber: string | null;
    taxRegistrationNumber: string | null;
    eoriNumber: string | null;
    eudamedSrn: string | null;
    websiteUrl: string | null;
    yearsInBusiness: number | null;
    registeredAddressLine1: string | null;
    registeredAddressLine2: string | null;
    registeredCity: string | null;
    registeredRegion: string | null;
    registeredPostcode: string | null;
    registeredCountry: string | null;
    extraIdentifiersJson: Record<string, string> | null;
  } | null;

  onboarding: {
    stepsJson: Record<string, { state: string; updatedAt?: string; message?: string | null }>;
    completedSteps: number;
    requiredSteps: number;
    lastStepKey: string | null;
  } | null;

  /**
   * Never more than the bank's name and the last four digits. The provider's
   * own account id and raw requirement list are not sent.
   */
  payoutAccount: {
    provider: string | null;
    state: string;
    payoutsEnabled: boolean;
    bankName: string | null;
    accountLast4: string | null;
    payoutCurrency: string | null;
    /** The payment provider's own word for the bank account. Null: it has said nothing. */
    bankAccountStatus: string | null;
    detailsSubmitted: boolean;
    lastSyncedAt: string | null;
  } | null;

  /** Ownership, registrations, exports, screening and the approval gate. */
  kyb: SellerKybReview;

  locations: {
    id: string;
    code: string;
    name: string;
    addressLine1: string;
    city: string;
    postcode: string;
    countryCode: string;
    isPickupLocation: boolean;
    isReturnLocation: boolean;
    isOperational: boolean;
    dispatchCutoff: string | null;
    handlingTimeDays: number;
  }[];

  documents: SellerDocument[];

  agreements: {
    id: string;
    kind: string;
    version: string;
    method: string;
    acceptedName: string | null;
    ipAddress: string | null;
    acceptedAt: string;
  }[];

  verificationCases: {
    id: string;
    kind: string;
    state: string;
    provider: string | null;
    failureReason: string | null;
    expiresAt: string | null;
    decidedAt: string | null;
  }[];

  members: {
    id: string;
    role: string;
    customerProfile: { fullName: string; user: { email: string } };
  }[];
}


export type ScreeningResult = 'CLEAR' | 'POTENTIAL_MATCH' | 'CONFIRMED_MATCH';

export interface SellerScreening {
  id: string;
  subjectType: 'ENTITY' | 'BENEFICIAL_OWNER';
  beneficialOwnerId: string | null;
  /** The name as it was when screened. */
  subjectName: string;
  /** Always `manual` here - no automated screening provider exists. */
  provider: string;
  automated: boolean;
  state: ScreeningResult | 'PENDING_REVIEW';
  listsChecked: string | null;
  note: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  isCurrent: boolean;
}

export interface SellerReadinessItem {
  code:
    | 'STEP_INCOMPLETE'
    | 'DOCUMENT_NOT_APPROVED'
    | 'DOCUMENT_EXPIRED'
    | 'SCREENING_REQUIRED'
    | 'SCREENING_NOT_CLEAR';
  field?: string;
  message?: string;
  meta?: { name?: string };
}

export interface SellerKybReview {
  isIndia: boolean;
  policy: { beneficialOwnersRequired: boolean };
  registrationNumberName: 'CIN' | 'LLPIN' | null;
  legalForm: string | null;
  udyamNumber: string | null;
  iecNumber: string | null;
  exportCapable: boolean;
  exportMarkets: string[];
  yearsExporting: number | null;
  intendedCategories: { id: string; name: string; blockedIn: { countryCode: string; reason: string }[] }[];
  beneficialOwners: {
    id: string;
    fullName: string;
    nationality: string | null;
    ownershipBasisPoints: number;
    role: string | null;
    isControllingPerson: boolean;
    isPoliticallyExposed: boolean;
    screening: SellerScreening | null;
  }[];
  ownershipTotalBasisPoints: number;
  outstanding: { code: string; label: string }[];
  signals: string[];
  screening: {
    required: boolean;
    provider: 'manual';
    automatedProviderConfigured: false;
    entity: SellerScreening | null;
    history: SellerScreening[];
  };
  readiness: { ready: boolean; missing: SellerReadinessItem[] };
}

export interface ScreeningInput {
  subjectType: 'ENTITY' | 'BENEFICIAL_OWNER';
  beneficialOwnerId?: string | null;
  result: ScreeningResult;
  listsChecked: string;
  note?: string | null;
}


export type TurnoverVerificationState =
  | 'NOT_STARTED'
  | 'AWAITING_INPUT'
  | 'IN_PROGRESS'
  | 'VERIFIED'
  | 'FAILED'
  | 'PROVIDER_UNCONFIGURED'
  | 'EXPIRED';

export interface SellerTurnoverDeclaration {
  id: string;
  /** Whole minor units, as a string. */
  amountMinor: string;
  currency: string;
  financialYearStart: string;
  financialYearEnd: string;
  minimumMinor: string;
  policyVersion: string;
  declaredAt: string;
  verificationState: TurnoverVerificationState;
  /** Seller-visible. */
  decisionReason: string | null;
  /** Operator-only. */
  internalNote: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  supersededReason: string | null;
  isCurrent: boolean;
  meetsMinimum: boolean;
}

export interface SellerTurnoverReview {
  policy: {
    required: boolean;
    minimumMinor: string;
    currency: string;
    currencyExponent: number;
    policyVersion: string;
    financialYearStartMonth: number;
  };
  applies: boolean;
  grandfathered: boolean;
  standing: 'NOT_DECLARED' | 'ELIGIBLE' | 'BELOW_MINIMUM' | 'OUT_OF_DATE';
  current: SellerTurnoverDeclaration | null;
  history: SellerTurnoverDeclaration[];
  evidence: {
    id: string;
    originalFileName: string;
    scanState: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    uploadedAt: string;
    isCurrent: boolean;
  }[];
}


export interface SellerDocument {
  id: string;
  kind: string;
  /** The onboarding requirement it answers, where it answers one. */
  requirementFieldKey: string | null;
  originalFileName: string;
  contentType: string;
  byteSize: number;
  /** What, if anything, looked at the file for malware. */
  scanState: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  /** Seller-visible. Written by whoever refused it. */
  rejectedReason: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  /** False where this deployment refuses to serve unscanned files. */
  isDownloadable: boolean;
  createdAt: string;
}


/**
 * What a document kind is called, in the words somebody holding it would use.
 *
 * A map rather than a rule, because no rule gets these right: title-casing the
 * enum gives "Ce certificate" and "Iso 13485", and sentence-casing it gives
 * "Ce certificate" too. Both read as a typo on a screen whose whole job is
 * deciding whether a business is real.
 *
 * Mirrors `SELLER_DOCUMENT_KINDS` in the storefront's own seller client — the
 * seller and the reviewer must be looking at the same words for the same file.
 */
const DOCUMENT_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  CE_CERTIFICATE: 'CE certificate',
  DECLARATION_OF_CONFORMITY: 'Declaration of Conformity',
  NOTIFIED_BODY_CERTIFICATE: 'Notified body certificate',
  ISO_13485: 'Quality management certificate (ISO 9001 / ISO 13485)',
  REGULATORY_LICENCE: 'Regulatory or import licence',
  BUSINESS_REGISTRATION: 'Business registration document',
  TAX_CERTIFICATE: 'Tax registration certificate',
  IDENTITY_PROOF: 'Photo identification',
  ADDRESS_PROOF: 'Proof of address',
  // Evidence a reviewer reads - not a bank verification.
  BANK_STATEMENT: 'Bank letter, statement or cancelled cheque',
  BRAND_AUTHORISATION: 'Brand authorisation',
  TRADEMARK_EVIDENCE: 'Trademark evidence',
  INSTRUCTIONS_FOR_USE: 'Instructions for use',
  STERILISATION_EVIDENCE: 'Sterilisation evidence',
  OTHER: 'Something else',
});

export function documentKindLabel(kind: string): string {
  const known = DOCUMENT_KIND_LABELS[kind];
  if (known !== undefined) return known;

  // A kind this build has not heard of is still named rather than shown as a
  // raw enum member: a console one deploy behind the API must stay readable.
  const words = kind.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}


// ---------------------------------------------------------------------------
// Who decided
// ---------------------------------------------------------------------------

export interface VerificationHistoryEntry {
  id: string;
  action: string;
  at: string;
  summary: string | null;
  /** Kept exactly as written at the time: an earlier admin decision still says ADMIN. */
  actorType: 'ADMIN' | 'AUDIT' | 'SELLER' | 'SYSTEM';
  actorLabel: string | null;
}

export interface VerificationBlock {
  ownedBy: 'AUDIT';
  consoleEnabled: boolean;
  /** False when no active audit reviewer can verify sellers yet. */
  reviewersAvailable: boolean;
  currentDecision: VerificationHistoryEntry | null;
  history: VerificationHistoryEntry[];
}

export interface SellerVerificationDetail {
  application: SellerApplicationDetail & { verification: VerificationBlock };
  readiness: { ready: boolean; missing: SellerReadinessItem[] };
  turnover: SellerTurnoverReview;
}

export const verificationKeys = {
  all: ['audit', 'seller-verification'] as const,
  list: (filters: Record<string, unknown>) => ['audit', 'seller-verification', 'list', filters] as const,
  detail: (id: string) => ['audit', 'seller-verification', 'detail', id] as const,
};

export function fetchVerificationQueue(query: {
  status?: SellerApplicationStatus | null;
  resubmitted?: boolean;
  search?: string;
  page?: number;
}): Promise<SellerApplicationList> {
  return api.get<SellerApplicationList>('/audit/seller-verification', {
    query: {
      status: query.status ?? undefined,
      resubmitted: query.resubmitted === true ? 'true' : undefined,
      search: query.search === undefined || query.search.trim() === '' ? undefined : query.search.trim(),
      page: query.page ?? 1,
    },
  });
}

export function fetchVerification(id: string): Promise<SellerVerificationDetail> {
  return api.get<SellerVerificationDetail>(`/audit/seller-verification/${enc(id)}`);
}

export type VerificationDecisionStatus = 'UNDER_REVIEW' | 'ACTION_REQUIRED' | 'APPROVED' | 'REJECTED';

export interface VerificationDecision {
  status: VerificationDecisionStatus;
  /** Seller-visible. Required to ask for corrections or to reject. */
  reason?: string | null;
  /** Never shown to the seller. */
  internalNote?: string | null;
  resubmissionAllowed?: boolean;
  /** The version on screen. A decision made meanwhile refuses this one. */
  expectedVersion: number;
}

export function decideVerification(id: string, body: VerificationDecision, key: Key): Promise<unknown> {
  return api.post(`/audit/seller-verification/${enc(id)}/decision`, body, w(key));
}

export interface ScreeningInput {
  subjectType: 'ENTITY' | 'BENEFICIAL_OWNER';
  beneficialOwnerId?: string | null;
  result: ScreeningResult;
  listsChecked: string;
  note?: string | null;
}

export function recordScreening(id: string, input: ScreeningInput, key: Key): Promise<SellerScreening> {
  return api.post<SellerScreening>(`/audit/seller-verification/${enc(id)}/screening`, input, w(key));
}

export interface TurnoverDecision {
  declarationId: string;
  decision: 'VERIFIED' | 'FAILED';
  reason: string;
  internalNote?: string | null;
  /** The state on screen. A declaration decided meanwhile refuses this one. */
  expectedVerificationState: TurnoverVerificationState;
}

export function decideTurnover(id: string, input: TurnoverDecision, key: Key): Promise<SellerTurnoverReview> {
  return api.post<SellerTurnoverReview>(`/audit/seller-verification/${enc(id)}/turnover/decision`, input, w(key));
}

export function decideDocument(
  documentId: string,
  body: { decision: 'APPROVED' | 'REJECTED'; reason?: string | null },
  key: Key,
): Promise<unknown> {
  return api.post(`/audit/seller-verification/documents/${enc(documentId)}/decision`, body, w(key));
}

/** The path a document's file is read from, with the session. */
export const documentFilePath = (documentId: string): string => `/audit/seller-verification/documents/${enc(documentId)}/file`;
