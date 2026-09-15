/**
 * The company directory, as the admin console reads it.
 *
 * Mirrors `modules/directory/directory.service.ts` on the server. The shape is
 * a tree on purpose — company, then its accounts, then the people inside them —
 * because the question this screen answers is about a business, not about a
 * row in one of three tables.
 */
import { api } from './api';
import type { MapConfig } from './warehouses';

export type DirectoryAccountKind = 'SELLER' | 'BUYER' | 'LOGISTICS';

export interface DirectoryPerson {
  userId: string;
  customerProfileId: string | null;
  name: string;
  email: string;
  accountStatus: string;
  /** Everything this company's accounts make them. Usually one, often two. */
  roles: { kind: DirectoryAccountKind; label: string }[];
  ordersPlaced: number;
  lastLoginAt: string | null;
}

export interface DirectorySellerAccount {
  id: string;
  displayName: string;
  legalName: string;
  slug: string;
  status: string;
  kind: string;
  registrationCountry: string;
  logoUrl: string | null;
  liveListings: number;
  listingsInReview: number;
  draftListings: number;
  ordersReceived: number;
  createdAt: string;
}

export interface DirectoryLogisticsAccount {
  id: string;
  partnerCode: string;
  displayName: string;
  legalName: string;
  status: string;
  contractStatus: string;
  registrationCountry: string;
  contactEmail: string;
  openShipments: number;
  memberCount: number;
  createdAt: string;
}

export interface DirectoryBuyerAccount {
  organisationNames: string[];
  profileCount: number;
  ordersPlaced: number;
}

export interface DirectoryCompany {
  key: string;
  name: string;
  country: string | null;
  kinds: DirectoryAccountKind[];
  seller: DirectorySellerAccount | null;
  logistics: DirectoryLogisticsAccount | null;
  buyer: DirectoryBuyerAccount | null;
  people: DirectoryPerson[];
  hasMorePeople: boolean;
}

export interface DirectoryResult {
  companies: DirectoryCompany[];
  page: number;
  pageSize: number;
  total: number;
  isTruncated: boolean;
  counts: { sellers: number; logistics: number; buyerOrganisations: number };
  unlistedBuyers: { total: number; sample: DirectoryPerson[] } | null;
}

export function fetchDirectory(params: URLSearchParams): Promise<DirectoryResult> {
  return api.get<DirectoryResult>(`/admin/directory?${params.toString()}`);
}

/** What to call each kind of account in a badge. */
export function kindLabel(kind: DirectoryAccountKind): string {
  if (kind === 'SELLER') return 'Sells';
  if (kind === 'LOGISTICS') return 'Carries';
  return 'Buys';
}

/**
 * The colour a kind is drawn in.
 *
 * One colour per kind, used for the badge on a company row and again on the
 * account panel below it, so an operator scanning the list learns the three
 * colours once rather than reading every badge.
 */
export function kindTone(kind: DirectoryAccountKind): 'brand' | 'success' | 'neutral' {
  if (kind === 'SELLER') return 'brand';
  if (kind === 'LOGISTICS') return 'success';
  return 'neutral';
}

/** A seller application status, in the words the Sellers screen uses. */
export function sellerStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    DRAFT: 'Not submitted',
    SUBMITTED: 'Waiting for review',
    UNDER_REVIEW: 'Being reviewed',
    ACTION_REQUIRED: 'Sent back',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    SUSPENDED: 'Suspended',
  };

  return labels[status] ?? status;
}

export function sellerStatusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'APPROVED') return 'success';
  if (status === 'REJECTED' || status === 'SUSPENDED') return 'danger';
  if (status === 'ACTION_REQUIRED' || status === 'SUBMITTED' || status === 'UNDER_REVIEW') {
    return 'warning';
  }
  return 'neutral';
}

export function partnerStatusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'ACTIVE') return 'success';
  if (status === 'SUSPENDED') return 'danger';
  if (status === 'PENDING_ACTIVATION') return 'warning';
  return 'neutral';
}

/** `PENDING_ACTIVATION` → `Pending activation`. */
export function humanise(value: string): string {
  return value
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (character) => character.toUpperCase());
}

// ---------------------------------------------------------------------------
// One seller, in depth
// ---------------------------------------------------------------------------

export interface SellerInsightMoney {
  currency: string;
  /** Minor units, as a string. Money is never a `number` in this codebase. */
  amountMinor: string;
}

export interface SellerInsightLocation {
  id: string;
  code: string;
  name: string;
  addressLine1: string;
  city: string;
  postcode: string;
  countryCode: string;
  /** Null when nobody has placed it. Never 0,0 — the API refuses those. */
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  isPickupLocation: boolean;
  isReturnLocation: boolean;
  hasColdChain: boolean;
  isOperational: boolean;
}

export interface SellerInsight {
  sellerAccountId: string;
  displayName: string;
  legalName: string;
  catalogue: { live: number; paused: number; needsChanges: number; inReview: number; drafts: number };
  trade: {
    ordersTotal: number;
    ordersLast30Days: number;
    lastOrderAt: string | null;
    grossSales: SellerInsightMoney[];
    sellerNet: SellerInsightMoney[];
  };
  stock: { unitsAvailable: number; outOfStockOffers: number; closedLocations: number };
  locations: SellerInsightLocation[];
  map: MapConfig;
  placedLocations: number;
}

/**
 * Loaded only for a company somebody has actually opened.
 *
 * The directory lists forty companies a page; running this for every one of
 * them would be forty round trips for a screen where most cards stay shut.
 */
export function fetchSellerInsight(sellerAccountId: string): Promise<SellerInsight> {
  return api.get<SellerInsight>(`/admin/sellers/${sellerAccountId}/insight`);
}
