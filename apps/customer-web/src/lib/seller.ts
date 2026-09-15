/**
 * The Seller Hub's API surface, as the storefront sees it.
 *
 * Types first, because they are the contract and the screens are written
 * against them. Two rules run through the whole file and are worth stating
 * once rather than at every field:
 *
 *   - **Every money value is a STRING of minor units.** Never a number. A
 *     wholesale price in paise exceeds JavaScript's safe integer range for
 *     figures sellers genuinely quote, and `JSON.parse` would lose the low
 *     digits before any code here could object. `formatMinor` below is the
 *     only place one is turned into something a person reads.
 *
 *   - **Nothing here sends a seller id.** There is no `sellerAccountId`
 *     parameter on any call, because the server resolves the seller from the
 *     session. A function taking one would be a function an attacker could
 *     hand somebody else's.
 */
import { api, postFile } from './api';

// ---------------------------------------------------------------------------
// Who is selling
// ---------------------------------------------------------------------------

export type SellerApplicationStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'ACTION_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUSPENDED';

export interface SellerIdentity {
  sellerAccountId: string;
  displayName: string;
  legalName: string;
  slug: string;
  status: SellerApplicationStatus;
  role: string;
  isTrading: boolean;
  isApplicationEditable: boolean;
  /** The seller's own mark, for the Hub's frame. Null until they upload one. */
  logoUrl: string | null;
  permissions: string[];
  /**
   * The Hub's own password, as this browser finds it.
   *
   * Selling shares the account somebody buys with and puts a second password in
   * front of the Hub. `isSet` is whether they have chosen one; `isOpen` is
   * whether THIS browser has entered it. Two flags rather than one because the
   * Hub draws a different screen for each, and learning which from a refusal
   * would flash the workspace first.
   */
  lock: { isSet: boolean; isOpen: boolean };
}

/** Choose the Seller Hub password, or change it. */
export function setSellerLock(input: {
  currentPassword?: string | null;
  newPassword: string;
}): Promise<{ lock: { isSet: boolean; isOpen: boolean } }> {
  return api.post<{ lock: { isSet: boolean; isOpen: boolean } }>('/sellers/lock', input);
}

/** Open the Hub for this browser. */
export function openSellerLock(
  password: string,
): Promise<{ lock: { isSet: boolean; isOpen: boolean } }> {
  return api.post<{ lock: { isSet: boolean; isOpen: boolean } }>('/sellers/lock/open', {
    password,
  });
}

/** Shut the Hub without signing out of the shop. */
export function closeSellerLock(): Promise<{ lock: { isSet: boolean; isOpen: boolean } }> {
  return api.post<{ lock: { isSet: boolean; isOpen: boolean } }>('/sellers/lock/close', {});
}

/**
 * "Does this account sell here?"
 *
 * Answers `null` for an ordinary buyer rather than throwing, which is what
 * lets the header call it on every page without a 403 in the console each
 * time.
 */
export function fetchSellerIdentity(): Promise<{ seller: SellerIdentity | null }> {
  return api.get<{ seller: SellerIdentity | null }>('/sellers/me');
}

export function checkDisplayName(name: string): Promise<{ available: boolean }> {
  return api.get<{ available: boolean }>(
    `/sellers/display-name-available?name=${encodeURIComponent(name)}`,
  );
}

export interface ApplyInput {
  legalName: string;
  displayName: string;
  registrationCountry: string;
  kind?: 'MANUFACTURER' | 'AUTHORISED_DISTRIBUTOR' | 'WHOLESALER' | 'RESELLER';
}

export function applyToSell(input: ApplyInput): Promise<{ sellerAccountId: string }> {
  return api.post<{ sellerAccountId: string }>('/sellers/apply', input);
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export type OnboardingStepState =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETE'
  | 'ERROR'
  | 'UNDER_REVIEW';

export interface OnboardingRequirement {
  fieldKey: string;
  stepKey: string;
  label: string;
  helpText: string | null;
  isRequired: boolean;
  isDocument: boolean;
  /** A hint for the field, never the check itself - the server decides. */
  validationPattern: string | null;
}

export interface OnboardingStep {
  key: string;
  title: string;
  summary: string;
  state: OnboardingStepState;
  isRequiredForSubmission: boolean;
  message: string | null;
  requirements: OnboardingRequirement[];
}

export interface OnboardingView {
  steps: OnboardingStep[];
  completedSteps: number;
  requiredSteps: number;
  percentComplete: number;
  lastStepKey: string | null;
  canSubmit: boolean;
  blockingSteps: { key: string; title: string }[];
}

export function fetchOnboarding(): Promise<OnboardingView> {
  return api.get<OnboardingView>('/seller/onboarding');
}

export interface BusinessProfile {
  representativeName: string | null;
  representativeEmail: string | null;
  representativePhone: string | null;
  representativeRole: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
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
}

export interface SellerAccountSummary {
  legalName: string;
  displayName: string;
  slug: string;
  kind: string;
  registrationCountry: string;
  description: string | null;
  status: SellerApplicationStatus;
  statusReason: string | null;
  version: number;
  /**
   * The seller's own mark, as a URL built on read. Null where they have none,
   * which is a working state: their shop front shows their initial instead.
   */
  logoUrl: string | null;
}

export function fetchBusinessProfile(): Promise<{
  account: SellerAccountSummary | null;
  profile: BusinessProfile | null;
}> {
  return api.get<{ account: SellerAccountSummary | null; profile: BusinessProfile | null }>(
    '/seller/business-profile',
  );
}

export function saveBusinessProfile(
  patch: Partial<BusinessProfile> & { extraIdentifiers?: Record<string, string> },
): Promise<{ state: OnboardingStepState; missing: string[] }> {
  return api.patch<{ state: OnboardingStepState; missing: string[] }>(
    '/seller/business-profile',
    patch,
  );
}

/**
 * The mark on the seller's own shop front.
 *
 * Returns the URL to show immediately, rather than asking the caller to refetch
 * the profile — an upload that visibly does nothing until a second request
 * lands reads as an upload that failed.
 */
export function uploadSellerLogo(file: File): Promise<{ url: string | null }> {
  const form = new FormData();
  form.append('file', file);

  return postFile<{ url: string | null }>('/seller/logo', form);
}

export function removeSellerLogo(): Promise<never> {
  return api.delete<never>('/seller/logo');
}

export function saveStoreProfile(patch: {
  description?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
}): Promise<never> {
  return api.patch<never>('/seller/store-profile', patch);
}

export function acceptAgreement(input: {
  kind: string;
  version: string;
  acceptedName: string;
  signatureStorageKey?: string | null;
}): Promise<never> {
  return api.post<never>('/seller/agreements', input);
}

export function submitApplication(): Promise<never> {
  return api.post<never>('/seller/submit');
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface MoneyTile {
  currency: string;
  amountMinor: string;
  previousAmountMinor: string;
}

export interface SellerDashboard {
  range: 'today' | 'week' | 'month' | 'quarter';
  periodFrom: string;
  periodTo: string;
  newOrders: number;
  ordersToDispatch: number;
  overdueOrders: number;
  grossSales: MoneyTile | null;
  netEarnings: MoneyTile | null;
  upcomingPayout: { currency: string; amountMinor: string; scheduledFor: string | null } | null;
  returnsOpen: number;
  refundsInPeriod: number;
  activeListings: number;
  listingsNeedingChanges: number;
  listingsInReview: number;
  draftListings: number;
  lowStockSkus: number;
  outOfStockSkus: number;
  qualityScore: number | null;
  /** Nothing listed, nothing drafted, nothing ordered - a brand-new seller. */
  hasNothingYet: boolean;
  documentsExpiringSoon: { id: string; kind: string; expiresOn: string }[];
  closedLocations: { id: string; name: string; reason: string | null }[];
  onboarding: {
    percentComplete: number;
    canSubmit: boolean;
    blockingSteps: { key: string; title: string }[];
  };
  payout: {
    state: string;
    isProviderConfigured: boolean;
    missingConfigurationKey: string | null;
    pendingRequirements: string[];
  };
  /** Tiles that could not be computed. Rendered as unavailable, not as zero. */
  unavailable: { tile: string; reason: string }[];
}

export function fetchDashboard(range: string): Promise<SellerDashboard> {
  return api.get<SellerDashboard>(`/seller/dashboard?range=${encodeURIComponent(range)}`);
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

export type OfferStatus = 'INACTIVE' | 'ACTIVE' | 'PAUSED' | 'NEEDS_CHANGES' | 'ARCHIVED';

export interface OfferRow {
  id: string;
  status: OfferStatus;
  productId: string;
  productName: string;
  productSlug: string;
  imageUrl: string | null;
  sellerSku: string;
  brandName: string | null;
  priceMinor: string;
  currency: string;
  minimumOrderQuantity: number;
  availableQuantity: number;
  reservedQuantity: number;
  qualityScore: number | null;
  statusReason: string | null;
  updatedAt: string;
  locations: { locationId: string; locationName: string; availableQuantity: number }[];
}

export interface OfferListResult {
  rows: OfferRow[];
  total: number;
  counts: Record<string, number>;
}

export function fetchOffers(params: URLSearchParams): Promise<OfferListResult> {
  return api.get<OfferListResult>(`/seller/listings?${params.toString()}`);
}

export function setOfferStatus(id: string, status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED'): Promise<never> {
  return api.patch<never>(`/seller/listings/${id}/status`, { status });
}

export function updateOfferPrice(
  id: string,
  body: { priceMinor: string; currency?: string | null },
): Promise<never> {
  return api.patch<never>(`/seller/listings/${id}/price`, body);
}

// ---------------------------------------------------------------------------
// The listing wizard
// ---------------------------------------------------------------------------

export type ListingSection =
  | 'PRODUCT_PHOTOS'
  | 'PRICE_STOCK_SHIPPING'
  | 'PRODUCT_DESCRIPTION'
  | 'ADDITIONAL_INFORMATION'
  | 'MEDICAL_COMPLIANCE';

export type SectionState =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETE'
  | 'ERROR'
  | 'OPTIONAL'
  | 'UNDER_REVIEW';

export interface SchemaAttribute {
  attributeKey: string;
  label: string;
  helpText: string | null;
  section: ListingSection;
  type:
    | 'TEXT'
    | 'LONG_TEXT'
    | 'RICH_TEXT'
    | 'NUMBER'
    | 'DECIMAL'
    | 'MEASUREMENT'
    | 'DROPDOWN'
    | 'MULTI_SELECT'
    | 'BOOLEAN'
    | 'DATE'
    | 'KEY_VALUE_LIST'
    | 'DOCUMENT';
  isRequired: boolean;
  unit: string | null;
  allowedUnits: string[] | null;
  allowedValues: { value: string; label: string }[] | null;
  minNumber: number | null;
  maxNumber: number | null;
  minLength: number | null;
  maxLength: number | null;
  pattern: string | null;
  isSearchable: boolean;
  isVariantDimension: boolean;
  isTitleComponent: boolean;
  titleOrder: number | null;
  isRegulatoryOnly?: boolean;
  sortOrder: number;
}

export interface ListingSchema {
  categoryId: string;
  categoryName: string;
  categoryPath: { id: string; name: string }[];
  attributes: SchemaAttribute[];
  mediaSlots: { slot: string; label: string; isRequired: boolean }[];
  variantDimensions: { attributeKey: string; label: string }[];
  sectionTotals: { section: ListingSection; total: number; required: number }[];
}

export interface SectionSummary {
  section: ListingSection;
  completed: number;
  total: number;
  required: number;
  missingRequired: number;
  state: SectionState;
}

export interface ListingIssue {
  severity: 'BLOCKER' | 'WARNING' | 'ADVISORY';
  code: string;
  section: ListingSection | null;
  attributeKey: string | null;
  message: string;
}

export type ListingDraftStatus =
  | 'DRAFT'
  | 'VALIDATION_FAILED'
  | 'READY_FOR_SUBMISSION'
  | 'PENDING_REVIEW'
  | 'ACTION_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'ARCHIVED';

export interface DraftOffer {
  priceMinor?: string | null;
  currency?: string | null;
  compareAtPriceMinor?: string | null;
  minimumOrderQuantity?: number | null;
  orderIncrement?: number | null;
  maximumOrderQuantity?: number | null;
  handlingTimeDays?: number | null;
  warrantyMonths?: number | null;
  sellingRegions?: string[] | null;
  priceTiers?: { minQuantity: number; priceMinor: string }[] | null;
}

export interface DraftPackaging {
  baseUnit?: string | null;
  unitsPerPack?: number | null;
  packsPerBox?: number | null;
  boxesPerCarton?: number | null;
  cartonsPerPallet?: number | null;
  statedTotalUnits?: number | null;
  netWeightGrams?: number | null;
  grossWeightGrams?: number | null;
}

export interface DraftStock {
  locationId: string;
  availableQuantity: number;
  reorderThreshold?: number | null;
  batchNumber?: string | null;
  expiresOn?: string | null;
}

// ---------------------------------------------------------------------------
// Photographs and videos
// ---------------------------------------------------------------------------

export type SellerMediaKind = 'IMAGE' | 'VIDEO';

export interface ListingMedia {
  id: string;
  slot: string;
  kind: SellerMediaKind;
  /** Where the file is served from. Built server-side from the storage key. */
  url: string;
  altText: string | null;
  isPrimary: boolean;
  widthPx: number | null;
  heightPx: number | null;
  durationSeconds: number | null;
  byteSize: number;
  contentType: string;
  rejectionCode: string | null;
  scanState: string;
  sortOrder: number;
}

export function fetchListingMedia(draftId: string): Promise<{ media: ListingMedia[] }> {
  return api.get<{ media: ListingMedia[] }>(`/seller/listing-drafts/${draftId}/media`);
}

/**
 * Upload one photograph or video.
 *
 * The file goes as multipart, with the slot and alt text as ordinary fields
 * beside it. The KIND is not sent: the server reads the magic bytes and decides,
 * because a browser will happily label an MP4 as an image and the ceiling that
 * applies depends on which it really is.
 */
export function uploadListingMedia(
  draftId: string,
  file: File,
  fields: { slot?: string | null; altText?: string | null } = {},
): Promise<ListingMedia> {
  const form = new FormData();
  // The file LAST, so the server has already parsed the fields by the time the
  // bytes arrive - multipart is ordered, and a field after a large file is a
  // field read after megabytes of upload.
  if (fields.slot != null) form.append('slot', fields.slot);
  if (fields.altText != null) form.append('altText', fields.altText);
  form.append('file', file, file.name);

  return postFile<ListingMedia>(`/seller/listing-drafts/${draftId}/media`, form);
}

export function updateListingMedia(
  draftId: string,
  mediaId: string,
  patch: { slot?: string | null; altText?: string | null; isPrimary?: boolean; sortOrder?: number },
): Promise<ListingMedia> {
  return api.patch<ListingMedia>(
    `/seller/listing-drafts/${draftId}/media/${mediaId}`,
    patch,
  );
}

export function deleteListingMedia(draftId: string, mediaId: string): Promise<never> {
  return api.delete<never>(`/seller/listing-drafts/${draftId}/media/${mediaId}`);
}

export interface DraftView {
  id: string;
  status: ListingDraftStatus;
  categoryId: string | null;
  brandId: string | null;
  brandName: string | null;
  matchedProductId: string | null;
  sellerSku: string | null;
  attributes: Record<string, unknown>;
  offer: DraftOffer;
  stock: DraftStock[];
  packaging: DraftPackaging;
  generatedTitle: string | null;
  sellerEditedTitle: string | null;
  sections: SectionSummary[];
  issues: ListingIssue[];
  isSubmittable: boolean;
  canPreviewTitle: boolean;
  reviewComment: string | null;
  version: number;
  updatedAt: string;
  media: {
    id: string;
    slot: string;
    altText: string | null;
    isPrimary: boolean;
    uploaded: boolean;
    rejectionCode: string | null;
    sortOrder: number;
  }[];
  schema: ListingSchema | null;
}

export interface DraftPatch {
  categoryId?: string | null;
  brandId?: string | null;
  sellerSku?: string | null;
  attributes?: Record<string, unknown>;
  offer?: DraftOffer;
  stock?: DraftStock[];
  packaging?: DraftPackaging;
  /** The version last read. A stale save is refused rather than merged. */
  expectedVersion?: number;
}

export function fetchListingSchema(categoryId: string): Promise<ListingSchema> {
  return api.get<ListingSchema>(
    `/seller/listing-schema?categoryId=${encodeURIComponent(categoryId)}`,
  );
}

export function createDraft(input: {
  categoryId?: string | null;
  brandId?: string | null;
}): Promise<DraftView> {
  return api.post<DraftView>('/seller/listing-drafts', input);
}

export function fetchDraft(id: string): Promise<DraftView> {
  return api.get<DraftView>(`/seller/listing-drafts/${id}`);
}

export function saveDraft(id: string, patch: DraftPatch): Promise<DraftView> {
  return api.patch<DraftView>(`/seller/listing-drafts/${id}`, patch);
}

export function validateDraft(id: string): Promise<DraftView> {
  return api.post<DraftView>(`/seller/listing-drafts/${id}/validate`);
}

export interface TitlePreview {
  ready: boolean;
  title: string | null;
  contributions: { attributeKey: string; label: string; text: string }[];
  blockedBy: { attributeKey: string; label: string; reason: string }[];
  isEditable: boolean;
}

export function previewTitle(id: string): Promise<TitlePreview> {
  return api.post<TitlePreview>(`/seller/listing-drafts/${id}/preview-title`);
}

export function submitDraft(id: string): Promise<DraftView> {
  return api.post<DraftView>(`/seller/listing-drafts/${id}/submit`);
}

export interface DraftListRow {
  id: string;
  status: ListingDraftStatus;
  title: string | null;
  sellerSku: string | null;
  categoryId: string | null;
  brandName: string | null;
  sections: Record<string, { completed: number; total: number; state: string }>;
  openIssues: number;
  updatedAt: string;
}

export function fetchDrafts(
  params: URLSearchParams,
): Promise<{ rows: DraftListRow[]; total: number; counts: Record<string, number> }> {
  return api.get<{ rows: DraftListRow[]; total: number; counts: Record<string, number> }>(
    `/seller/listing-drafts?${params.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

export interface BrandSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  manufacturerLegalName: string | null;
  logoStorageKey: string | null;
}

export function fetchBrands(query: string): Promise<{
  brands: BrandSummary[];
  recent: BrandSummary[];
  /** Advice on a typed name. Never a refusal - the server accepts it anyway. */
  warnings: { code: string; message: string }[];
}> {
  return api.get<{
    brands: BrandSummary[];
    recent: BrandSummary[];
    warnings: { code: string; message: string }[];
  }>(`/seller/brands?q=${encodeURIComponent(query)}`);
}

export function requestBrand(input: {
  requestedName: string;
  manufacturerLegalName?: string | null;
  websiteUrl?: string | null;
  justification?: string | null;
}): Promise<{ requestId: string; brandId: string }> {
  return api.post<{ requestId: string; brandId: string }>('/seller/brand-requests', input);
}

export interface BrandRequestRow {
  id: string;
  requestedName: string;
  status: 'PENDING' | 'INFORMATION_REQUESTED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  /** Why it was refused, or what was asked for. Written for the seller. */
  decisionReason: string | null;
  createdAt: string;
  brandId: string | null;
}

export function fetchBrandRequests(): Promise<{ requests: BrandRequestRow[] }> {
  return api.get<{ requests: BrandRequestRow[] }>('/seller/brand-requests');
}

/** Take back a request nobody has decided yet. */
export function withdrawBrandRequest(id: string): Promise<never> {
  return api.delete<never>(`/seller/brand-requests/${id}`);
}

// ---------------------------------------------------------------------------
// Places, stock, orders, money
// ---------------------------------------------------------------------------

export interface SellerLocation {
  id: string;
  code: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postcode: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  isPickupLocation: boolean;
  isReturnLocation: boolean;
  dispatchCutoff: string | null;
  workingDaysMask: number;
  handlingTimeDays: number;
  shipsToCountries: string[];
  hasColdChain: boolean;
  hasControlledStorage: boolean;
  hasSterileStorage: boolean;
  isOperational: boolean;
  closedReason: string | null;
}

export function fetchLocations(): Promise<{ locations: SellerLocation[] }> {
  return api.get<{ locations: SellerLocation[] }>('/seller/locations');
}

export function createLocation(input: Record<string, unknown>): Promise<SellerLocation> {
  return api.post<SellerLocation>('/seller/locations', input);
}

export interface GeocodedAddress {
  latitude: number;
  longitude: number;
  /** What the geocoder thinks it was asked about, so a person can check it. */
  label: string | null;
}

/**
 * An address to coordinates.
 *
 * `result` is null for every way this can fail to answer — no geocoder
 * configured on the deployment, one that timed out, one that found nothing —
 * and the caller treats all of them the same way: the address still saves, it
 * simply has no pin. A dispatch place is a real place whether or not a third
 * party could find it on a map.
 */
export function geocodeLocation(query: string): Promise<{ result: GeocodedAddress | null }> {
  return api.post<{ result: GeocodedAddress | null }>('/seller/locations/geocode', { query });
}

export interface InventoryRow {
  offerId: string;
  sellerSku: string;
  productName: string;
  locationId: string;
  locationName: string;
  locationCode: string;
  availableQuantity: number;
  reservedQuantity: number;
  quarantinedQuantity: number;
  reorderThreshold: number;
  batchNumber: string | null;
  expiresOn: string | null;
  erpQuantity: number | null;
  erpSyncedAt: string | null;
  isLow: boolean;
  version: number;
}

export function fetchInventory(
  params: URLSearchParams,
): Promise<{ rows: InventoryRow[]; total: number }> {
  return api.get<{ rows: InventoryRow[]; total: number }>(
    `/seller/inventory?${params.toString()}`,
  );
}

export function recordStockMovement(input: {
  offerId: string;
  locationId: string;
  type: 'RECEIPT' | 'ADJUSTMENT' | 'RETURN' | 'QUARANTINE' | 'QUARANTINE_RELEASE';
  quantityDelta: number;
  reason?: string | null;
  idempotencyKey?: string;
}): Promise<{ balance: number }> {
  return api.post<{ balance: number }>('/seller/inventory/movements', input);
}

export type SellerOrderStatus =
  | 'NEW'
  | 'ACCEPTED'
  | 'PROCESSING'
  | 'READY_FOR_DISPATCH'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'RETURN_REQUESTED'
  | 'RETURNED'
  | 'REFUNDED'
  | 'DISPUTED';

export interface SellerOrderRow {
  id: string;
  sellerOrderNumber: string;
  status: SellerOrderStatus;
  orderNumber: string;
  placedAt: string | null;
  dispatchDueAt: string | null;
  isOverdue: boolean;
  currency: string;
  goodsTotalMinor: string;
  sellerNetMinor: string;
  lineCount: number;
  itemCount: number;
  locationName: string | null;
}

export function fetchSellerOrders(
  params: URLSearchParams,
): Promise<{ rows: SellerOrderRow[]; total: number; counts: Record<string, number> }> {
  return api.get<{ rows: SellerOrderRow[]; total: number; counts: Record<string, number> }>(
    `/seller/orders?${params.toString()}`,
  );
}

export function transitionOrder(
  id: string,
  body: { status: string; reason?: string | null; locationId?: string | null },
): Promise<never> {
  return api.patch<never>(`/seller/orders/${id}/status`, body);
}

export interface SettlementRow {
  id: string;
  reference: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  grossMinor: string;
  commissionMinor: string;
  processingFeeMinor: string;
  refundsMinor: string;
  adjustmentsMinor: string;
  netPayableMinor: string;
  holdReason: string | null;
}

export function fetchSettlements(): Promise<{ settlements: SettlementRow[]; total: number }> {
  return api.get<{ settlements: SettlementRow[]; total: number }>('/seller/settlements');
}

export interface PayoutAccountView {
  state: string;
  provider: string | null;
  providerAccountId: string | null;
  payoutsEnabled: boolean;
  payoutsHeldByOperator: boolean;
  payoutHoldReason: string | null;
  pendingRequirements: string[];
  bankName: string | null;
  accountLast4: string | null;
  payoutCurrency: string | null;
  /**
   * Whether a payout provider exists on this deployment at all.
   *
   * The payout screen branches on this and NEVER renders a verified state when
   * it is false. That is the whole reason it is sent: a seller told their
   * account is verified by a system that cannot verify anything has been lied
   * to about their own money.
   */
  isProviderConfigured: boolean;
  missingConfigurationKey: string | null;
}

export function fetchPayoutAccount(): Promise<PayoutAccountView> {
  return api.get<PayoutAccountView>('/seller/payout-account');
}

export function startPayoutOnboarding(urls: {
  returnUrl: string;
  refreshUrl: string;
}): Promise<{ url: string; expiresAt: string }> {
  return api.post<{ url: string; expiresAt: string }>('/seller/payout-account/onboarding', urls);
}

/** Re-read the provider after the seller has been away setting things up. */
export function refreshPayoutAccount(): Promise<PayoutAccountView> {
  return api.post<PayoutAccountView>('/seller/payout-account/refresh', {});
}

// ---------------------------------------------------------------------------
// The rest of a working day: one order, one settlement, the team, the record
// ---------------------------------------------------------------------------

export interface SettlementLine {
  id: string;
  kind: string;
  /** Minor units as a string. Never a number — see the money rule. */
  amountMinor: string;
  currency: string;
  description: string | null;
  reason: string | null;
  orderGroupId: string | null;
  occurredAt: string;
}

export function fetchSettlementLines(id: string): Promise<{ lines: SettlementLine[] }> {
  return api.get<{ lines: SettlementLine[] }>(`/seller/settlements/${id}/lines`);
}

export interface PayoutRow {
  id: string;
  reference: string;
  status: string;
  amountMinor: string;
  currency: string;
  scheduledFor: string | null;
  paidAt: string | null;
  failureReason: string | null;
  /** What the seller can do about a failure. Never left empty on one. */
  remediationHint: string | null;
}

export function fetchPayouts(): Promise<{ payouts: PayoutRow[] }> {
  return api.get<{ payouts: PayoutRow[] }>('/seller/payouts');
}

export interface SellerOrderDetail {
  id: string;
  sellerOrderNumber: string;
  orderNumber: string;
  status: SellerOrderStatus;
  buyerOrderStatus: string;
  placedAt: string | null;
  dispatchDueAt: string | null;
  locationId: string | null;
  currency: string;
  goodsTotalMinor: string;
  taxTotalMinor: string;
  shippingTotalMinor: string;
  commissionMinor: string;
  sellerNetMinor: string;
  commissionBasisPointsApplied: number | null;
  cancellationReason: string | null;
  deliveryAddress: unknown;
  lines: {
    id: string;
    /** The buyer order line this covers. A shipment names its contents by this. */
    orderItemId: string;
    offerId: string;
    sellerSku: string;
    productName: string;
    productSlug: string;
    quantity: number;
    fulfilledQuantity: number;
    returnedQuantity: number;
    unitPriceMinor: string;
    lineTotalMinor: string;
    sellerNetMinor: string;
  }[];
  shipments: {
    id: string;
    status: string;
    carrierName: string;
    trackingNumber: string;
    trackingUrl: string | null;
    dispatchedAt: string | null;
    deliveredAt: string | null;
  }[];
  returns: {
    id: string;
    status: string;
    reasonCode: string;
    reasonText: string | null;
    sellerResponse: string | null;
    createdAt: string;
  }[];
  /**
   * What this member may do next. The panel renders exactly these.
   *
   * Each carries whether the move needs a reason written down, because that
   * is a property of the transition and not of the screen: cancelling has to
   * be explained wherever it is offered.
   */
  allowedTransitions: { to: SellerOrderStatus; requiresReason: boolean }[];
}

export function fetchSellerOrder(id: string): Promise<SellerOrderDetail> {
  return api.get<SellerOrderDetail>(`/seller/orders/${id}`);
}

export function recordShipment(
  id: string,
  body: {
    carrierName: string;
    trackingNumber: string;
    trackingUrl?: string | null;
    contents?: { orderItemId: string; quantity: number }[] | null;
  },
): Promise<{ shipmentId: string }> {
  return api.post<{ shipmentId: string }>(`/seller/orders/${id}/shipments`, body);
}

export interface SellerMemberRow {
  id: string;
  role: string;
  joinedAt: string;
  name: string;
  email: string;
}

export function fetchMembers(): Promise<{ members: SellerMemberRow[] }> {
  return api.get<{ members: SellerMemberRow[] }>('/seller/members');
}

export function changeMemberRole(memberId: string, role: string): Promise<never> {
  return api.patch<never>(`/seller/members/${memberId}`, { role });
}

export function removeMember(memberId: string): Promise<never> {
  return api.delete<never>(`/seller/members/${memberId}`);
}

export interface SellerAuditRow {
  id: string;
  action: string;
  /** A role — "Marketplace moderation" — never a staff member's name. */
  actorLabel: string;
  resourceType: string;
  resourceId: string | null;
  summary: string;
  createdAt: string;
}

export function fetchSellerAudit(limit = 50): Promise<{ entries: SellerAuditRow[] }> {
  return api.get<{ entries: SellerAuditRow[] }>(`/seller/audit?limit=${String(limit)}`);
}

export interface SellerNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  linkPath: string | null;
  severity: string;
  createdAt: string;
  /** Per member, not per account: twelve staff do not get twelve copies. */
  isRead: boolean;
}

export function fetchNotifications(): Promise<{ notifications: SellerNotification[] }> {
  return api.get<{ notifications: SellerNotification[] }>('/seller/notifications');
}

export function markNotificationRead(id: string): Promise<never> {
  return api.post<never>(`/seller/notifications/${id}/read`, {});
}

export function updateLocation(id: string, input: Record<string, unknown>): Promise<SellerLocation> {
  return api.patch<SellerLocation>(`/seller/locations/${id}`, input);
}

/** Archives rather than deletes: stock movements still point at it. */
export function archiveLocation(id: string): Promise<never> {
  return api.delete<never>(`/seller/locations/${id}`);
}

/** Take a submitted listing back out of the review queue to change it. */
export function withdrawDraft(id: string): Promise<DraftView> {
  return api.post<DraftView>(`/seller/listing-drafts/${id}/withdraw`, {});
}

/** Copy a live listing into a new draft under a new code of the seller's own. */
export function duplicateListing(id: string, sellerSku: string): Promise<{ offerId: string }> {
  return api.post<{ offerId: string }>(`/seller/listings/${id}/duplicate`, { sellerSku });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Minor units to something a person reads.
 *
 * The division happens on a BigInt and the fractional part is assembled from
 * the remainder as a string. Converting to a Number first is the bug this
 * function exists to avoid: it is invisible in testing, because it only
 * appears above 2^53, and by then it is on an invoice.
 *
 * The exponent is hard-coded at two, which is right for every currency this
 * marketplace trades in today. A zero-decimal currency (JPY, KRW) would need
 * the exponent from the currency table, and the place to get it is the same
 * one the backend uses - `currencyExponent` in `domain/money.ts`.
 */
export function formatMinor(amountMinor: string, currency: string, locale = 'en'): string {
  const negative = amountMinor.startsWith('-');
  const digits = negative ? amountMinor.slice(1) : amountMinor;

  const value = BigInt(digits.length > 0 ? digits : '0');
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, '0');

  const grouped = new Intl.NumberFormat(locale).format(whole);

  try {
    const symbol =
      new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value ?? currency;

    return `${negative ? '-' : ''}${symbol}${grouped}.${fraction}`;
  } catch {
    // An unknown currency code throws in `Intl`. Showing the code beside the
    // number is a worse label and a better failure than showing nothing.
    return `${negative ? '-' : ''}${currency} ${grouped}.${fraction}`;
  }
}

/**
 * One spelling of each order status.
 *
 * Here rather than in a page, because the list and the detail screen both draw
 * it and two spellings of "READY_FOR_DISPATCH" is how a seller ends up asking
 * support whether "Ready to go" and "Ready for dispatch" are the same thing.
 */
export function orderLabelKey(
  status: SellerOrderStatus,
): `seller.orderStatus.${SellerOrderStatus}` {
  return `seller.orderStatus.${status}`;
}

/** A key for an application status, for a badge. */
export function applicationStatusKey(
  status: SellerApplicationStatus,
): `seller.applicationStatus.${SellerApplicationStatus}` {
  return `seller.applicationStatus.${status}`;
}

export function applicationStatusTone(
  status: SellerApplicationStatus,
): 'neutral' | 'brand' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'APPROVED':
      return 'success';
    case 'ACTION_REQUIRED':
      return 'warning';
    case 'REJECTED':
    case 'SUSPENDED':
      return 'danger';
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return 'brand';
    case 'DRAFT':
      return 'neutral';
  }
}

export function offerStatusTone(
  status: OfferStatus,
): 'neutral' | 'brand' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'NEEDS_CHANGES':
      return 'warning';
    case 'PAUSED':
      return 'neutral';
    case 'ARCHIVED':
      return 'neutral';
    case 'INACTIVE':
      return 'brand';
  }
}

export function sectionLabel(section: ListingSection): string {
  switch (section) {
    case 'PRODUCT_PHOTOS':
      return 'Product photos';
    case 'PRICE_STOCK_SHIPPING':
      return 'Price, stock and shipping';
    case 'PRODUCT_DESCRIPTION':
      return 'Product description';
    case 'ADDITIONAL_INFORMATION':
      return 'Additional information';
    case 'MEDICAL_COMPLIANCE':
      // The enum member is still MEDICAL_COMPLIANCE - renaming it is a
      // migration - but the marketplace sells fasteners and cables as well as
      // devices, so the LABEL is the general one. What a category actually
      // asks for in this section is the category's business.
      return 'Compliance and certification';
  }
}

/**
 * What a seller may do next, from this status.
 *
 * A short list rather than every legal transition: the server's state machine
 * allows more than a seller should be offered in a row - moving straight from
 * NEW to SHIPPED is legal in two hops and is not a button, because skipping
 * "accepted" loses the dispatch clock the SLA is measured against.
 */
export type OrderActionKey =
  | 'accept'
  | 'reject'
  | 'startPicking'
  | 'readyToGo'
  | 'markShipped'
  | 'markDelivered'
  | 'acceptReturn'
  | 'dispute';

export interface OrderAction {
  to: SellerOrderStatus;
  /**
   * What the button says, as a key.
   *
   * Its own name rather than the destination status: "Accept" and "Accepted"
   * are different words, and a button labelled with the state it produces
   * reads as a description of where you already are.
   */
  labelKey: `seller.orderAction.${OrderActionKey}`;
  isPrimary: boolean;
}

export function nextActions(status: SellerOrderStatus): OrderAction[] {
  switch (status) {
    case 'NEW':
      return [
        { to: 'ACCEPTED', labelKey: 'seller.orderAction.accept', isPrimary: true },
        { to: 'CANCELLED', labelKey: 'seller.orderAction.reject', isPrimary: false },
      ];
    case 'ACCEPTED':
      return [{ to: 'PROCESSING', labelKey: 'seller.orderAction.startPicking', isPrimary: true }];
    case 'PROCESSING':
      return [
        { to: 'READY_FOR_DISPATCH', labelKey: 'seller.orderAction.readyToGo', isPrimary: true },
      ];
    case 'READY_FOR_DISPATCH':
      return [{ to: 'SHIPPED', labelKey: 'seller.orderAction.markShipped', isPrimary: true }];
    case 'SHIPPED':
      return [{ to: 'DELIVERED', labelKey: 'seller.orderAction.markDelivered', isPrimary: false }];
    case 'RETURN_REQUESTED':
      return [
        { to: 'RETURNED', labelKey: 'seller.orderAction.acceptReturn', isPrimary: true },
        { to: 'DISPUTED', labelKey: 'seller.orderAction.dispute', isPrimary: false },
      ];
    default:
      return [];
  }
}
