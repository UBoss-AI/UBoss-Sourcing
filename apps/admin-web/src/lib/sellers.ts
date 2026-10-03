/**
 * The marketplace's side of the Seller Hub, as the admin console sees it.
 *
 * One rule runs through the types: **a seller-visible reason and an internal
 * note are different fields, everywhere.** The reason is written for the
 * seller and appears on their screen; the note is the operator's own
 * assessment and never leaves this console. Collapsing them into one box is
 * how a private judgement ends up in front of the business it was about.
 */
import { api } from './api';

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

export function fetchSellerApplication(id: string): Promise<SellerApplicationDetail> {
  return api.get<SellerApplicationDetail>(`/admin/sellers/${id}`);
}

// --- Ownership, screening and the approval gate ---------------------------

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

/** Record a manual restricted-party / sanctions screening. */
export function recordSellerScreening(id: string, input: ScreeningInput): Promise<SellerScreening> {
  return api.post<SellerScreening>(`/admin/sellers/${id}/screening`, input);
}

export interface SellerDecision {
  status: 'UNDER_REVIEW' | 'ACTION_REQUIRED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  /** Seller-visible. The state machine demands it on every refusal and stop. */
  reason?: string | null;
  /** Operator-only. Never serialised to a seller route. */
  internalNote?: string | null;
  resubmissionAllowed?: boolean;
  /** The version last read. A stale decision is refused rather than applied. */
  expectedVersion?: number | null;
}

/** 204 (no body) when it happened; `{ pending }` (202) when it waits for a second approver (JOURNEY-061). */
export function decideSellerApplication(id: string, decision: SellerDecision): Promise<unknown> {
  return api.post<unknown>(`/admin/sellers/${id}/decision`, decision);
}

/**
 * Put one seller on their own commission rate, or back on the standard one.
 *
 * Basis points, or null for "whatever the marketplace charges". Null is not
 * zero: null follows the standard rate when it moves, zero is a promise to
 * take nothing from this seller whatever the standard becomes.
 */
export function setSellerCommission(
  id: string,
  commissionBasisPoints: number | null,
): Promise<never> {
  return api.patch<never>(`/admin/sellers/${id}/commission`, { commissionBasisPoints });
}

// ---------------------------------------------------------------------------
// Listing moderation and brand requests
// ---------------------------------------------------------------------------

export interface ListingReviewRow {
  id: string;
  sellerAccountId: string;
  sellerName: string;
  title: string | null;
  sellerSku: string | null;
  categoryId: string | null;
  brandName: string | null;
  submittedAt: string | null;
  /**
   * Which revision is waiting.
   *
   * Shown in the queue so two administrators looking at the same row can see
   * they are looking at the same thing - and so one of them can tell, after a
   * refusal, that the seller has sent something newer since.
   */
  submittedVersion: number | null;
  openIssues: number;
}

export function fetchListingReviewQueue(
  params?: URLSearchParams,
): Promise<{ rows: ListingReviewRow[]; total: number }> {
  const query = params === undefined ? '' : `?${params.toString()}`;
  return api.get<{ rows: ListingReviewRow[]; total: number }>(
    `/admin/seller-listings/review-queue${query}`,
  );
}

/** The five sections a listing is described in, in the order they are asked. */
export const LISTING_SECTIONS = [
  'PRODUCT_PHOTOS',
  'PRICE_STOCK_SHIPPING',
  'PRODUCT_DESCRIPTION',
  'ADDITIONAL_INFORMATION',
  'MEDICAL_COMPLIANCE',
] as const;

export type ListingSection = (typeof LISTING_SECTIONS)[number];

export interface ListingSchemaAttribute {
  attributeKey: string;
  label: string;
  helpText: string | null;
  section: ListingSection;
  type: string;
  isRequired: boolean;
  unit: string | null;
  allowedValues?: { value: string; label?: string }[] | null;
  sortOrder: number;
  isRegulatoryOnly?: boolean;
}

export interface ListingReviewDetail {
  id: string;
  status: string;
  sellerAccountId: string;
  sellerName: string;
  sellerSku: string | null;
  title: string | null;
  generatedTitle: string | null;
  sellerEditedTitle: string | null;
  brandName: string | null;
  brandStatus: string | null;
  categoryId: string | null;
  categoryPath: { id: string; name: string }[];
  attributes: Record<string, unknown>;
  /** The seller's description sections, specifications and per-option values. */
  content: ListingContent | null;
  offer: Record<string, unknown>;
  stock: unknown[];
  packaging: Record<string, unknown>;
  media: {
    id: string;
    slot: string;
    kind: string;
    /** Null when the upload never completed — not a broken photograph. */
    url: string | null;
    altText: string | null;
    isPrimary: boolean;
    contentType: string;
    scanState: string;
    rejectionCode: string | null;
    sortOrder: number;
  }[];
  issues: {
    id: string;
    severity: string;
    code: string;
    section: string | null;
    attributeKey: string | null;
    message: string;
    isFromModerator: boolean;
  }[];
  schema: {
    categoryId: string;
    categoryName: string;
    categoryPath: { id: string; name: string }[];
    attributes: ListingSchemaAttribute[];
    mediaSlots: { slot: string; label: string; isRequired: boolean }[];
  } | null;
  submittedAt: string | null;
  /**
   * The revision this screen is showing, which its decision must carry back.
   *
   * Not an autosave counter: it is the version AS SUBMITTED, so it changes
   * only when the listing leaves the queue and comes back. The server refuses
   * a decision quoting a revision that is no longer the one under review.
   */
  submittedVersion: number | null;
  reviewComment: string | null;
  /** Who made the last decision: a refused listing's appeal goes to somebody else (JOURNEY-062). */
  reviewedByUserId: string | null;
  /** What the seller was asked to send with the last "needs changes". */
  evidenceRequest: EvidenceRequestItem[];
  /** The seller's appeal against a refusal. */
  appeal: { reason: string; appealedAt: string | null; outcome: string | null } | null;
  updatedAt: string;
}

export const EVIDENCE_KINDS = ['CERTIFICATE', 'TEST_REPORT', 'LABEL_PHOTO', 'PRODUCT_PHOTO', 'AUTHORISATION', 'OTHER'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface EvidenceRequestItem {
  kind: string;
  label: string;
  note: string | null;
}

export function fetchListingForReview(id: string): Promise<ListingReviewDetail> {
  return api.get<ListingReviewDetail>(`/admin/seller-listings/${id}`);
}

/** Decide a seller's appeal. Refused for the moderator who refused the listing. */
export function decideListingAppeal(
  id: string,
  body: { outcome: 'UPHELD' | 'REFUSED'; comment: string },
): Promise<{ id: string; status: string }> {
  return api.post<{ id: string; status: string }>(`/admin/seller-listings/${id}/appeal-decision`, body);
}

export interface ProhibitedTerm {
  id: string;
  term: string;
  reason: string;
  severity: 'BLOCKER' | 'WARNING' | 'ADVISORY';
  isActive: boolean;
  updatedAt: string;
}

export function fetchProhibitedTerms(): Promise<{ terms: ProhibitedTerm[] }> {
  return api.get<{ terms: ProhibitedTerm[] }>('/admin/listing-moderation/terms');
}

export function saveProhibitedTerm(
  id: string | null,
  body: { term: string; reason: string; severity: ProhibitedTerm['severity']; isActive: boolean },
): Promise<{ term: ProhibitedTerm }> {
  return id === null
    ? api.post<{ term: ProhibitedTerm }>('/admin/listing-moderation/terms', body)
    : api.put<{ term: ProhibitedTerm }>(`/admin/listing-moderation/terms/${id}`, body);
}

export function deleteProhibitedTerm(id: string): Promise<unknown> {
  return api.delete(`/admin/listing-moderation/terms/${id}`);
}

export function decideListing(
  id: string,
  body: {
    status: 'APPROVED' | 'ACTION_REQUIRED' | 'REJECTED';
    comment?: string | null;
    fieldComments?: { section?: string | null; attributeKey?: string | null; message: string }[];
    /**
     * The revision that was read, from `fetchListingForReview`.
     *
     * Always sent. A decision without it is a decision that will land on
     * whatever the listing happens to hold when it arrives, which on a queue
     * two people share is a review of one revision approving another.
     */
    expectedVersion?: number | null;
    /** With ACTION_REQUIRED: what the seller must send. */
    evidenceRequest?: { kind: EvidenceKind; label: string; note?: string | null }[];
    /** With APPROVED: countries the product may not be sold to. */
    blockedCountries?: string[];
  },
): Promise<{ offerId: string | null }> {
  return api.post<{ offerId: string | null }>(`/admin/seller-listings/${id}/decision`, body);
}

export interface BrandRequestRow {
  id: string;
  requestedName: string;
  sellerName: string;
  manufacturerLegalName: string | null;
  websiteUrl: string | null;
  justification: string | null;
  /** `INFORMATION_REQUESTED` means we have already gone back to the seller. */
  status: 'PENDING' | 'INFORMATION_REQUESTED';
  /** What was asked for, while we are waiting on the seller to answer it. */
  informationRequested: string | null;
  /** Drafts held up behind this name. Nothing unapproved can go on sale. */
  listingsWaiting: number;
  /** Other sellers whose open request points at the same brand row. */
  alsoRequestedBy: string[];
  createdAt: string;
}

export function fetchBrandRequests(): Promise<{ requests: BrandRequestRow[] }> {
  return api.get<{ requests: BrandRequestRow[] }>('/admin/brand-requests');
}

export function decideBrandRequest(
  id: string,
  body: {
    decision: 'APPROVED' | 'REJECTED' | 'INFORMATION_REQUESTED';
    reason?: string | null;
    correctedName?: string | null;
  },
): Promise<never> {
  return api.post<never>(`/admin/brand-requests/${id}/decision`, body);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function applicationStatusLabel(status: SellerApplicationStatus): string {
  switch (status) {
    case 'DRAFT':
      return 'Not submitted';
    case 'SUBMITTED':
      return 'Waiting for review';
    case 'UNDER_REVIEW':
      return 'Being reviewed';
    case 'ACTION_REQUIRED':
      return 'Sent back';
    case 'APPROVED':
      return 'Approved';
    case 'REJECTED':
      return 'Rejected';
    case 'SUSPENDED':
      return 'Suspended';
  }
}

export function applicationStatusTone(
  status: SellerApplicationStatus,
): 'neutral' | 'brand' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'APPROVED':
      return 'success';
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return 'brand';
    case 'ACTION_REQUIRED':
      return 'warning';
    case 'REJECTED':
    case 'SUSPENDED':
      return 'danger';
    case 'DRAFT':
      return 'neutral';
  }
}

/** The eight onboarding steps, in order, with a readable name. */
export const ONBOARDING_STEPS: readonly { key: string; title: string }[] = Object.freeze([
  { key: 'account_verification', title: 'Contact verification' },
  { key: 'business_identity', title: 'Business identity' },
  { key: 'kyb_kyc', title: 'Identity and documents' },
  { key: 'store_profile', title: 'Store details' },
  { key: 'locations', title: 'Pickup and returns' },
  { key: 'payout', title: 'Payout account' },
  { key: 'compliance', title: 'Compliance' },
  { key: 'agreements', title: 'Agreements' },
]);

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
// A seller's evidence
// ---------------------------------------------------------------------------

/**
 * One certificate, licence or proof, as the review screen renders it.
 *
 * `status` is derived on the server from `approvedAt` and `rejectedReason`
 * rather than here, because the seller's own Hub renders the same three words
 * from the same field and two derivations of "has this been accepted" is how
 * the two screens end up disagreeing in front of the person they disagree
 * about.
 */
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

export interface SellerDocumentLink {
  url: string;
  expiresAt: string;
  fileName: string;
  contentType: string;
}

/**
 * A link to read one back.
 *
 * A POST because it MINTS a single-use token with a life of minutes. Opened the
 * moment it arrives and never stored: a link held in state is a link that has
 * expired by the time anybody clicks it.
 */
export function createSellerDocumentLink(documentId: string): Promise<SellerDocumentLink> {
  return api.post<SellerDocumentLink>(`/admin/seller-documents/${documentId}/link`);
}

export interface SellerDocumentDecision {
  decision: 'APPROVED' | 'REJECTED';
  /** Seller-visible, and the server requires it on a refusal. */
  reason?: string | null;
}

export function decideSellerDocument(
  documentId: string,
  decision: SellerDocumentDecision,
): Promise<never> {
  return api.post<never>(`/admin/seller-documents/${documentId}/decision`, decision);
}

/** What approval puts on the product page, as the seller wrote it. */
export interface ListingContent {
  specifications: { group: string; rows: { label: string; value: string; unit: string | null; highlight: boolean }[] }[];
  descriptionSections: { heading: string; body: string; imageMediaId: string | null; altText: string | null }[];
  variantOverrides: { variantSignature: string; group: string; label: string; value: string; unit: string | null }[];
}

/**
 * A verified supplier as the Sellers screen lists it: approved, not suspended,
 * with something live in the catalogue. The same rule the public catalogue
 * uses for the word "verified", plus the seller id so a row opens the record.
 */
export interface VerifiedSupplierRow {
  sellerId: string;
  slug: string;
  displayName: string;
  kind: string;
  registrationCountry: string;
  /** When the operator approved them. Null for an approval made before the date was recorded. */
  verifiedAt: string | null;
  productCount: number;
  logoUrl: string | null;
}

export interface VerifiedSupplierList {
  suppliers: VerifiedSupplierRow[];
  total: number;
}

/** `newest` puts the most recently verified first and leaves undated approvals out. */
export function fetchVerifiedSuppliers(sort?: 'newest'): Promise<VerifiedSupplierList> {
  return api.get<VerifiedSupplierList>(
    sort === undefined ? '/admin/sellers/verified' : `/admin/sellers/verified?sort=${sort}`,
  );
}
