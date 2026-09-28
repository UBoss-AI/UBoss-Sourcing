/**
 * The storefront's side of buyer companies: the application a member sees,
 * and the calls that change it.
 *
 * Every call names the company in its path, and the backend re-checks the
 * caller's membership on each one - the id here is an address, not a
 * permission. Nothing is cached in browser storage: the application lives on
 * the server, which is what makes "save and resume" work across devices.
 */
import { api, postFile } from './api';
import type { BuyerCompanyRole, BuyerCompanyStatus, CompanyContextOption } from '@/auth/session-context';

export type EntityType =
  | 'SOLE_PROPRIETORSHIP'
  | 'PARTNERSHIP'
  | 'LIMITED_LIABILITY_PARTNERSHIP'
  | 'PRIVATE_LIMITED_COMPANY'
  | 'PUBLIC_LIMITED_COMPANY'
  | 'COOPERATIVE'
  | 'NON_PROFIT'
  | 'PUBLIC_BODY'
  | 'OTHER';

export const ENTITY_TYPES: readonly EntityType[] = [
  'PRIVATE_LIMITED_COMPANY',
  'PUBLIC_LIMITED_COMPANY',
  'LIMITED_LIABILITY_PARTNERSHIP',
  'PARTNERSHIP',
  'SOLE_PROPRIETORSHIP',
  'COOPERATIVE',
  'NON_PROFIT',
  'PUBLIC_BODY',
  'OTHER',
];

export const INDUSTRIES = [
  'HEALTHCARE',
  'MANUFACTURING',
  'CONSTRUCTION',
  'HOSPITALITY',
  'RETAIL',
  'WHOLESALE_DISTRIBUTION',
  'EDUCATION',
  'PUBLIC_SECTOR',
  'TECHNOLOGY',
  'LOGISTICS',
  'AGRICULTURE',
  'ENERGY',
  'PROFESSIONAL_SERVICES',
  'OTHER',
] as const;

export type Industry = (typeof INDUSTRIES)[number];

export type AddressKind = 'REGISTERED_OFFICE' | 'OPERATING' | 'BILLING' | 'SHIPPING';

export type Register = 'IN_CIN' | 'IN_LLPIN' | 'PL_KRS' | 'PL_CEIDG' | 'LOCAL';

export type Scheme =
  | 'IN_PAN'
  | 'IN_GSTIN'
  | 'IN_UDYAM'
  | 'IN_IEC'
  | 'PL_NIP'
  | 'PL_REGON'
  | 'EU_VAT'
  | 'EORI'
  | 'TAX_ID'
  | 'LEI';

export const NOT_APPLICABLE_REASONS = [
  'NOT_REGISTERED',
  'EXEMPT',
  'BELOW_THRESHOLD',
  'NOT_ISSUED_FOR_ENTITY',
] as const;

export type NotApplicableReason = (typeof NOT_APPLICABLE_REASONS)[number];

export type DocumentKind =
  | 'CERTIFICATE_OF_INCORPORATION'
  | 'REGISTRY_EXTRACT'
  | 'TAX_REGISTRATION_CERTIFICATE'
  | 'PROOF_OF_REGISTERED_ADDRESS'
  | 'AUTHORIZATION_LETTER'
  | 'BUSINESS_LICENCE'
  | 'REPRESENTATIVE_IDENTITY'
  | 'OWNERSHIP_DECLARATION'
  | 'OTHER';

export type DocumentPurpose =
  | 'PROVES_EXISTENCE'
  | 'PROVES_TAX_REGISTRATION'
  | 'PROVES_ADDRESS'
  | 'PROVES_AUTHORITY'
  | 'PROVES_LICENCE'
  | 'REVIEWER_REQUESTED';

/**
 * How the representative stands to the business. The same list as the
 * backend's `APPLICANT_RELATIONSHIPS`; an AUTHORISED_AGENT is asked for an
 * authorisation letter up front, and the server says so in `requirements`.
 */
export const APPLICANT_RELATIONSHIPS = [
  'DIRECTOR_OR_OFFICER',
  'OWNER_OR_PARTNER',
  'EMPLOYEE',
  'AUTHORISED_AGENT',
  'OTHER',
] as const;

export type ApplicantRelationship = (typeof APPLICANT_RELATIONSHIPS)[number];

export type ConsentPurpose = 'ACCURACY_DECLARATION' | 'BUSINESS_TERMS' | 'PRIVACY_NOTICE' | 'AUTHORITY_TO_ACT';

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = [
  'ACCURACY_DECLARATION',
  'BUSINESS_TERMS',
  'PRIVACY_NOTICE',
  'AUTHORITY_TO_ACT',
];

export interface CompanyAddress {
  kind: AddressKind;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
}

export interface CompanyIdentifier {
  scheme: Scheme;
  value: string | null;
  notApplicable: boolean;
  notApplicableReason: NotApplicableReason | null;
}

export interface ProcurementProfile {
  expectedMonthlyVolume?: 'UNDER_1K' | '1K_10K' | '10K_50K' | '50K_250K' | 'OVER_250K' | null;
  categories?: string[];
  deliveryCountries?: string[];
  preferredCurrency?: string | null;
  paymentTermsInterest?: boolean;
  erpIntegrationInterest?: boolean;
  expectedUsers?: '1' | '2_5' | '6_20' | 'OVER_20' | null;
}

export interface CompanyApplication {
  id: string;
  reference: string;
  status: BuyerCompanyStatus;
  version: number;
  statusReason: string | null;
  statusReasonCode: string | null;
  resubmissionAllowed: boolean;
  role: BuyerCompanyRole;
  canManage: boolean;
  consentVersion?: string;
  business: {
    legalName: string | null;
    tradingName: string | null;
    entityType: EntityType | null;
    registrationCountry: string | null;
    registrationNumber: string | null;
    incorporationDate: string | null;
    industry: Industry | null;
    website: string | null;
    businessEmail: string | null;
    businessEmailVerified: boolean;
    businessPhone: string | null;
  };
  applicant: {
    /** From the person's own profile. Shown, not edited, on the application. */
    fullName: string | null;
    phone: string | null;
    jobTitle: string | null;
    relationship: ApplicantRelationship | null;
    authorityConfirmed: boolean;
  };
  /** True when the draft was started from the person's seller account. */
  prefilledFromSeller: boolean;
  addresses: CompanyAddress[];
  identifiers: CompanyIdentifier[];
  procurement: ProcurementProfile | null;
  requirements: {
    register: Register;
    incorporationDateRequired: boolean;
    identifiers: { scheme: Scheme; required: boolean; allowNotApplicable: boolean }[];
    documents: { kinds: DocumentKind[]; required: boolean; purpose: DocumentPurpose }[];
  };
  problems: { field: string; code: string }[];
  documents: {
    id: string;
    kind: DocumentKind;
    status: 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED' | 'WITHDRAWN';
    mimeType: string;
    sizeBytes: number;
    pageCount: number | null;
    reviewReason: string | null;
    infoRequestId: string | null;
    createdAt: string;
  }[];
  infoRequests: {
    id: string;
    status: 'OPEN' | 'ANSWERED' | 'CANCELLED';
    message: string;
    requestedDocumentKinds: DocumentKind[];
    createdAt: string;
    responseMessage: string | null;
    respondedAt: string | null;
  }[];
  timeline: { kind: string; message: string | null; data: Record<string, unknown> | null; createdAt: string }[];
  actions: {
    edit: boolean;
    submit: boolean;
    resubmit: boolean;
    reopen: boolean;
    respond: boolean;
    verifyEmail: boolean;
  };
  createdAt: string;
  submittedAt: string | null;
  firstSubmittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  suspendedAt: string | null;
}

export interface ApplicationPatch {
  business?: Partial<Omit<CompanyApplication['business'], 'businessEmailVerified'>>;
  applicant?: {
    jobTitle?: string | null;
    relationship?: ApplicantRelationship | null;
    authorityConfirmed?: boolean;
  };
  addresses?: (Partial<CompanyAddress> & { kind: AddressKind; remove?: boolean })[];
  identifiers?: CompanyIdentifier[];
  procurement?: ProcurementProfile | null;
}

export const companyQueryKey = (id: string): readonly unknown[] => ['buyer-company', id];
export const COMPANIES_QUERY_KEY = ['buyer-companies'] as const;

/**
 * The seller account this person runs, which a new application may be
 * started from. Only ever their own - never a way to look anybody else up.
 */
export interface SellerSource {
  id: string;
  legalName: string;
  registrationCountry: string;
}

export function fetchMyCompanies(): Promise<{
  companies: CompanyContextOption[];
  sellerSource: SellerSource | null;
}> {
  return api.get('/buyer-companies');
}

export function createCompany(input: {
  legalName?: string | null;
  registrationCountry?: string | null;
  entityType?: EntityType | null;
  /** Pre-fill from this seller account; the server checks it is the caller's. */
  fromSellerAccountId?: string | null;
}): Promise<CompanyApplication> {
  return api.post('/buyer-companies', input);
}

export function fetchApplication(id: string): Promise<CompanyApplication> {
  return api.get(`/buyer-companies/${id}`);
}

export function saveApplication(id: string, patch: ApplicationPatch): Promise<CompanyApplication> {
  return api.patch(`/buyer-companies/${id}`, patch);
}

export function sendEmailCode(id: string): Promise<{ sentTo?: string; alreadyVerified?: true }> {
  return api.post(`/buyer-companies/${id}/email-code`);
}

export function confirmEmailCode(id: string, code: string): Promise<CompanyApplication> {
  return api.post(`/buyer-companies/${id}/email-code/confirm`, { code });
}

export function submitApplication(
  id: string,
  consents: Record<ConsentPurpose, boolean>,
): Promise<CompanyApplication> {
  return api.post(`/buyer-companies/${id}/submit`, { consents });
}

export function answerRequest(id: string, requestId: string, message: string): Promise<CompanyApplication> {
  return api.post(`/buyer-companies/${id}/info-requests/${requestId}/answer`, { message });
}

export function resubmitApplication(id: string): Promise<CompanyApplication> {
  return api.post(`/buyer-companies/${id}/resubmit`);
}

export function reopenApplication(id: string): Promise<CompanyApplication> {
  return api.post(`/buyer-companies/${id}/reopen`);
}

/** The `kind` field goes before the file: the server reads fields in order. */
export function uploadDocument(
  id: string,
  kind: DocumentKind,
  file: File,
  infoRequestId?: string | null,
  onProgress?: (fraction: number) => void,
): Promise<{ documentId: string; application: CompanyApplication }> {
  const form = new FormData();
  form.append('kind', kind);
  if (infoRequestId !== undefined && infoRequestId !== null) form.append('infoRequestId', infoRequestId);
  form.append('file', file);
  return postFile(`/buyer-companies/${id}/documents`, form, onProgress === undefined ? {} : { onProgress });
}

export function withdrawDocument(id: string, documentId: string): Promise<CompanyApplication> {
  return api.delete(`/buyer-companies/${id}/documents/${documentId}`);
}

/** Statuses in which the applicant is waiting and nothing is theirs to do. */
export const IN_REVIEW: readonly BuyerCompanyStatus[] = [
  'SUBMITTED',
  'AUTOMATED_CHECK_IN_PROGRESS',
  'UNDER_REVIEW',
  'RESUBMITTED',
];

/** The badge colour for a status, in the storefront's tones. */
export function statusTone(status: BuyerCompanyStatus): 'success' | 'warning' | 'danger' | 'neutral' | 'brand' {
  switch (status) {
    case 'APPROVED':
      return 'success';
    case 'REJECTED':
    case 'SUSPENDED':
      return 'danger';
    case 'MORE_INFORMATION_REQUIRED':
    case 'REVERIFICATION_REQUIRED':
    case 'EMAIL_VERIFICATION_PENDING':
      return 'warning';
    case 'DRAFT':
      return 'neutral';
    default:
      return 'brand';
  }
}
