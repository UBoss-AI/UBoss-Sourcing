/**
 * My Profile: the shapes, the calls, and the form's own arithmetic.
 *
 * The form logic lives here rather than in the page so it can be tested
 * without rendering anything: turning a profile into a draft, a draft back
 * into the smallest PATCH that says what changed, and checking a field before
 * the server does. The server checks everything again - these checks exist so
 * a mistake is pointed at while the person is still looking at the field.
 */
import { api, downloadFile } from './api';

// ---------------------------------------------------------------------------
// What the server sends
// ---------------------------------------------------------------------------

export interface ProfileAddress {
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode?: string | null;
  countryCode: string;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export type OperatingHours = Partial<Record<Weekday, { open: string; close: string } | null>>;

export type ComplianceKind =
  | 'BUSINESS_LICENCE'
  | 'INSURANCE_CERTIFICATE'
  | 'TRANSPORT_PERMIT'
  | 'COMPANY_REGISTRATION'
  | 'TAX_REGISTRATION'
  | 'OTHER';

export const COMPLIANCE_KINDS: readonly ComplianceKind[] = [
  'BUSINESS_LICENCE',
  'INSURANCE_CERTIFICATE',
  'TRANSPORT_PERMIT',
  'COMPANY_REGISTRATION',
  'TAX_REGISTRATION',
  'OTHER',
];

export type ComplianceStatus = 'MISSING' | 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

export type IntegrationStatus =
  | 'CONNECTED'
  | 'CONFIGURED_UNVERIFIED'
  | 'CREDENTIALS_REQUIRED'
  | 'ERROR'
  | 'DISABLED'
  | 'MANUAL_TRACKING'
  | 'NOT_CONFIGURED'
  | 'AWAITING_FIRST_EVENT'
  | 'ACTIVE'
  | 'CONSENT_ONLY';

export type TransportMode = 'ROAD' | 'AIR' | 'SEA' | 'RAIL';
export const DECLARABLE_MODES: readonly TransportMode[] = ['ROAD', 'AIR', 'SEA', 'RAIL'];

export interface ComplianceDocument {
  id: string;
  kind: ComplianceKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanState: string;
  reviewState: 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED';
  rejectionReason: string | null;
  expiresOn: string | null;
  uploadedByLabel: string;
  createdAt: string;
  reviewedAt: string | null;
  downloadable: boolean;
}

export interface ProfileChange {
  id: string;
  state: string;
  proposed: Partial<Record<ReverifiedField, unknown>>;
  current: Partial<Record<ReverifiedField, unknown>>;
  requestedByLabel: string;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface LogisticsProfile {
  identity: {
    id: string;
    partnerCode: string;
    legalName: string;
    displayName: string;
    partnerKind: string;
    status: 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
    suspensionReason: string | null;
    verificationState: 'UNVERIFIED' | 'VERIFIED' | 'REVERIFICATION_REQUIRED';
    verifiedAt: string | null;
    logoUrl: string | null;
    createdAt: string;
    updatedAt: string;
  };
  company: {
    registeredAddress: ProfileAddress | null;
    operationalAddress: ProfileAddress | null;
    registrationCountry: string;
    registrationNumber: string | null;
    taxNumber: string | null;
    websiteUrl: string | null;
    businessDescription: string | null;
  };
  contacts: {
    contactEmail: string;
    contactPhone: string | null;
    primaryContactName: string | null;
    primaryContactTitle: string | null;
    emergencyContactName: string | null;
    emergencyPhone: string | null;
    supportEmail: string | null;
    supportPhone: string | null;
    billingContactName: string | null;
    billingEmail: string | null;
    billingPhone: string | null;
  };
  coverage: {
    regions: {
      id: string;
      scope: string;
      countryCode: string;
      regionValue: string;
      supportsPickup: boolean;
      supportsDelivery: boolean;
      isExclusion: boolean;
      isActive: boolean;
    }[];
    countries: string[];
    hubLocations: Hub[];
  };
  capabilities: {
    selfManaged: boolean;
    levels: string[];
    pricedTransportModes: string[];
    declaredTransportModes: TransportMode[];
    approved: { kind: string; state: string; evidenceExpiresAt: string | null }[];
    fleetSize: number;
    activeDrivers: number;
    vehicleKinds: string[];
    maxVehicleLoadKg: number | null;
    refrigeratedVehicles: number;
    operatingHours: OperatingHours | null;
    timeZone: string | null;
  };
  compliance: {
    licenceNumber: string | null;
    licenceExpiresAt: string | null;
    contractStatus: string;
    contractEndsAt: string | null;
    items: { kind: ComplianceKind; status: ComplianceStatus; expiresOn: string | null }[];
    documents: ComplianceDocument[];
  };
  integrations: { key: string; status: IntegrationStatus; lastSuccessAt: string | null }[];
  review: { pendingChange: ProfileChange | null; lastDecision: ProfileChange | null };
  history: {
    id: string;
    actorLabel: string;
    action: string;
    summary: string | null;
    createdAt: string;
  }[] | null;
  completion: { percent: number; missing: string[] };
  editing: { canEdit: boolean; immediate: string[]; reverified: string[] };
}

export interface Hub {
  name: string;
  city: string;
  countryCode: string;
}

export interface ProfileSaveResult {
  profile: LogisticsProfile;
  applied: string[];
  submittedForReview: string[];
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const profileKey = ['logistics', 'profile'] as const;

export function fetchProfile(): Promise<LogisticsProfile> {
  return api.get('/logistics/profile');
}

export function saveProfile(changes: ProfilePatch): Promise<ProfileSaveResult> {
  return api.patch('/logistics/profile', changes);
}

export function withdrawPendingChange(): Promise<LogisticsProfile> {
  return api.delete('/logistics/profile/pending-change');
}

export function uploadLogo(file: File): Promise<{ logoUrl: string }> {
  const form = new FormData();
  form.append('file', file);
  return api.upload('/logistics/profile/logo', form);
}

export function removeLogo(): Promise<void> {
  return api.delete('/logistics/profile/logo');
}

export function uploadComplianceDocument(input: {
  kind: ComplianceKind;
  expiresOn: string;
  file: File;
}): Promise<ComplianceDocument> {
  const form = new FormData();
  // Fields before the file: the server reads them from the part that
  // precedes it.
  form.append('kind', input.kind);
  if (input.expiresOn !== '') form.append('expiresOn', input.expiresOn);
  form.append('file', input.file);
  return api.upload('/logistics/profile/documents', form);
}

/** Mint a single-use link, then spend it. Two requests, by design. */
export async function downloadComplianceDocument(document: ComplianceDocument): Promise<void> {
  const link = await api.post<{ url: string; fileName: string }>(
    `/logistics/profile/documents/${document.id}/link`,
  );
  // The link is absolute from the API root; the client adds that root itself.
  await downloadFile(link.url.replace(/^\/api\/v1/, ''), link.fileName);
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/** Fields the operator must verify before they change. */
export const REVERIFIED_FIELDS = [
  'legalName',
  'displayName',
  'registrationNumber',
  'taxNumber',
  'registrationCountry',
  'registeredAddress',
  'licenceNumber',
  'licenceExpiresAt',
] as const;
export type ReverifiedField = (typeof REVERIFIED_FIELDS)[number];

export interface AddressDraft {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}

/** Every editable value, as the inputs hold it: strings, never null. */
export interface ProfileDraft {
  // Re-verified
  legalName: string;
  displayName: string;
  registrationNumber: string;
  taxNumber: string;
  registrationCountry: string;
  registeredAddress: AddressDraft;
  licenceNumber: string;
  licenceExpiresAt: string;
  // Immediate
  contactEmail: string;
  contactPhone: string;
  emergencyPhone: string;
  emergencyContactName: string;
  websiteUrl: string;
  primaryContactName: string;
  primaryContactTitle: string;
  supportEmail: string;
  supportPhone: string;
  billingContactName: string;
  billingEmail: string;
  billingPhone: string;
  businessDescription: string;
  operationalAddress: AddressDraft;
  operatingHours: Record<Weekday, { enabled: boolean; open: string; close: string }>;
  timeZone: string;
  declaredTransportModes: TransportMode[];
  hubLocations: Hub[];
}

export type ProfilePatch = Partial<Record<string, unknown>>;

const EMPTY_ADDRESS: AddressDraft = {
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  countryCode: '',
};

function addressDraft(address: ProfileAddress | null): AddressDraft {
  if (address === null) return { ...EMPTY_ADDRESS };
  return {
    line1: address.line1,
    line2: address.line2 ?? '',
    city: address.city,
    region: address.region ?? '',
    postalCode: address.postalCode ?? '',
    countryCode: address.countryCode,
  };
}

function isBlankAddress(address: AddressDraft): boolean {
  const keys: (keyof AddressDraft)[] = ['line1', 'line2', 'city', 'region', 'postalCode', 'countryCode'];
  return keys.every((key) => address[key].trim() === '');
}

/** The address as the server wants it, or null for a cleared one. */
function addressPayload(address: AddressDraft): ProfileAddress | null {
  if (isBlankAddress(address)) return null;
  const optional = (value: string): string | null => (value.trim() === '' ? null : value.trim());
  return {
    line1: address.line1.trim(),
    line2: optional(address.line2),
    city: address.city.trim(),
    region: optional(address.region),
    postalCode: optional(address.postalCode),
    countryCode: address.countryCode.trim().toUpperCase(),
  };
}

export function draftFromProfile(profile: LogisticsProfile): ProfileDraft {
  const hours = profile.capabilities.operatingHours ?? {};
  return {
    legalName: profile.identity.legalName,
    displayName: profile.identity.displayName,
    registrationNumber: profile.company.registrationNumber ?? '',
    taxNumber: profile.company.taxNumber ?? '',
    registrationCountry: profile.company.registrationCountry,
    registeredAddress: addressDraft(profile.company.registeredAddress),
    licenceNumber: profile.compliance.licenceNumber ?? '',
    licenceExpiresAt: profile.compliance.licenceExpiresAt ?? '',
    contactEmail: profile.contacts.contactEmail,
    contactPhone: profile.contacts.contactPhone ?? '',
    emergencyPhone: profile.contacts.emergencyPhone ?? '',
    emergencyContactName: profile.contacts.emergencyContactName ?? '',
    websiteUrl: profile.company.websiteUrl ?? '',
    primaryContactName: profile.contacts.primaryContactName ?? '',
    primaryContactTitle: profile.contacts.primaryContactTitle ?? '',
    supportEmail: profile.contacts.supportEmail ?? '',
    supportPhone: profile.contacts.supportPhone ?? '',
    billingContactName: profile.contacts.billingContactName ?? '',
    billingEmail: profile.contacts.billingEmail ?? '',
    billingPhone: profile.contacts.billingPhone ?? '',
    businessDescription: profile.company.businessDescription ?? '',
    operationalAddress: addressDraft(profile.company.operationalAddress),
    operatingHours: Object.fromEntries(
      WEEKDAYS.map((day) => {
        const slot = hours[day];
        return [
          day,
          slot === undefined || slot === null
            ? { enabled: false, open: '09:00', close: '17:00' }
            : { enabled: true, open: slot.open, close: slot.close },
        ];
      }),
    ) as ProfileDraft['operatingHours'],
    timeZone: profile.capabilities.timeZone ?? '',
    declaredTransportModes: [...profile.capabilities.declaredTransportModes],
    hubLocations: profile.coverage.hubLocations.map((hub) => ({ ...hub })),
  };
}

/** What each draft field sends. `undefined` never appears in a patch. */
function payloadFor(field: keyof ProfileDraft, draft: ProfileDraft): unknown {
  const value = draft[field];
  switch (field) {
    case 'registeredAddress':
    case 'operationalAddress':
      return addressPayload(value as AddressDraft);
    case 'operatingHours': {
      const hours = value as ProfileDraft['operatingHours'];
      const enabled = WEEKDAYS.filter((day) => hours[day].enabled);
      if (enabled.length === 0) return null;
      return Object.fromEntries(
        enabled.map((day) => [day, { open: hours[day].open, close: hours[day].close }]),
      );
    }
    case 'declaredTransportModes':
      return [...(value as TransportMode[])].sort();
    case 'hubLocations':
      return (value as Hub[]).map((hub) => ({
        name: hub.name.trim(),
        city: hub.city.trim(),
        countryCode: hub.countryCode.trim().toUpperCase(),
      }));
    case 'registrationCountry':
      return (value as string).trim().toUpperCase();
    case 'contactEmail':
    case 'legalName':
    case 'displayName':
      // Required on the server; sent trimmed, never as null.
      return (value as string).trim();
    default: {
      const text = (value as string).trim();
      return text === '' ? null : text;
    }
  }
}

/**
 * The smallest PATCH that says what changed.
 *
 * Compared as the server would store it, so re-typing the same value, adding
 * a trailing space or re-ordering modes is "no change" rather than a save that
 * writes an audit row for nothing.
 */
export function diffDraft(initial: ProfileDraft, draft: ProfileDraft): ProfilePatch {
  const patch: ProfilePatch = {};
  for (const field of Object.keys(draft) as (keyof ProfileDraft)[]) {
    const before = JSON.stringify(payloadFor(field, initial));
    const after = payloadFor(field, draft);
    if (JSON.stringify(after) !== before) patch[field] = after;
  }
  return patch;
}

export function isReverified(field: string): field is ReverifiedField {
  return (REVERIFIED_FIELDS as readonly string[]).includes(field);
}

// ---------------------------------------------------------------------------
// Checking a field before the server does
// ---------------------------------------------------------------------------

export type FieldProblem =
  | 'required'
  | 'email'
  | 'phone'
  | 'url'
  | 'country'
  | 'tooLong'
  | 'hours'
  | 'address'
  | 'timeZone'
  | 'date';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()./-]{4,32}$/;
const COUNTRY = /^[A-Za-z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function checkAddress(address: AddressDraft): FieldProblem | null {
  if (isBlankAddress(address)) return null;
  if (address.line1.trim() === '' || address.city.trim() === '') return 'address';
  if (!COUNTRY.test(address.countryCode.trim())) return 'country';
  return null;
}

/**
 * Every problem in the draft, keyed the way the server keys its own details
 * (`operationalAddress`, `hubLocations.2`, `operatingHours.mon`), so one map
 * can hold both and a field shows whichever it has.
 */
export function validateDraft(draft: ProfileDraft): Record<string, FieldProblem> {
  const problems: Record<string, FieldProblem> = {};
  const set = (field: string, problem: FieldProblem | null): void => {
    if (problem !== null) problems[field] = problem;
  };

  const required = (value: string, max: number): FieldProblem | null =>
    value.trim() === '' ? 'required' : value.trim().length > max ? 'tooLong' : null;
  const optional = (value: string, max: number): FieldProblem | null =>
    value.trim().length > max ? 'tooLong' : null;
  const email = (value: string, isRequired: boolean): FieldProblem | null => {
    if (value.trim() === '') return isRequired ? 'required' : null;
    return EMAIL.test(value.trim()) ? null : 'email';
  };
  const phone = (value: string): FieldProblem | null =>
    value.trim() === '' || PHONE.test(value.trim()) ? null : 'phone';

  set('legalName', required(draft.legalName, 255));
  set('displayName', required(draft.displayName, 160));
  set('registrationNumber', optional(draft.registrationNumber, 64));
  set('taxNumber', optional(draft.taxNumber, 64));
  set('registrationCountry', COUNTRY.test(draft.registrationCountry.trim()) ? null : 'country');
  set('registeredAddress', checkAddress(draft.registeredAddress));
  set('licenceNumber', optional(draft.licenceNumber, 64));
  set(
    'licenceExpiresAt',
    draft.licenceExpiresAt === '' || DATE.test(draft.licenceExpiresAt) ? null : 'date',
  );

  set('contactEmail', email(draft.contactEmail, true));
  set('supportEmail', email(draft.supportEmail, false));
  set('billingEmail', email(draft.billingEmail, false));
  set('contactPhone', phone(draft.contactPhone));
  set('emergencyPhone', phone(draft.emergencyPhone));
  set('supportPhone', phone(draft.supportPhone));
  set('billingPhone', phone(draft.billingPhone));
  set('emergencyContactName', optional(draft.emergencyContactName, 160));
  set('primaryContactName', optional(draft.primaryContactName, 160));
  set('primaryContactTitle', optional(draft.primaryContactTitle, 120));
  set('billingContactName', optional(draft.billingContactName, 160));
  set('businessDescription', optional(draft.businessDescription, 2000));

  const url = draft.websiteUrl.trim();
  if (url !== '') {
    let ok = false;
    try {
      const parsed = new URL(url);
      ok = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      ok = false;
    }
    set('websiteUrl', ok ? null : 'url');
  }

  set('operationalAddress', checkAddress(draft.operationalAddress));

  for (const day of WEEKDAYS) {
    const slot = draft.operatingHours[day];
    if (slot.enabled && !(slot.open < slot.close)) problems[`operatingHours.${day}`] = 'hours';
  }

  if (draft.timeZone !== '' && !knownTimeZone(draft.timeZone)) problems['timeZone'] = 'timeZone';

  draft.hubLocations.forEach((hub, index) => {
    if (hub.name.trim() === '' || hub.city.trim() === '') problems[`hubLocations.${index}`] = 'required';
    else if (!COUNTRY.test(hub.countryCode.trim())) problems[`hubLocations.${index}`] = 'country';
  });

  return problems;
}

/**
 * Where a server detail belongs. `operationalAddress.city` is shown on the
 * operational address; `hubLocations.2.name` on the third hub.
 */
export function problemKeyFor(serverField: string): string {
  const [head, second] = serverField.split('.');
  if (head === 'hubLocations' || head === 'operatingHours') {
    return second === undefined ? head : `${head}.${second}`;
  }
  return head ?? serverField;
}

/** Every IANA zone this browser knows, for the picker. */
export function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}
