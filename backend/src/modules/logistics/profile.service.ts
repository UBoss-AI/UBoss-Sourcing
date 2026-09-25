/**
 * My Profile: a logistics company describing itself, and the operator checking it.
 *
 * FOUR KINDS OF FIELD, AND THE LINE BETWEEN THEM IS THE POINT
 *
 *   1. **System** - the id, the partner code, the dates, the fleet and driver
 *      counts, the levels it is priced for. Computed or assigned; nothing a
 *      request can write.
 *   2. **Operator-controlled** - account status, contract, approved regions,
 *      approved capabilities, the carrier integration, verification. The
 *      contract between the marketplace and the carrier. Shown, never written
 *      here.
 *   3. **Partner-editable** - contacts, operational address, description,
 *      hours, time zone, declared modes, hubs. Saved immediately.
 *   4. **Re-verified** - legal name, trading name, registration, tax number,
 *      registered address, registration country, transport licence. Saved as a
 *      PROPOSAL and applied only when a member of staff approves it. Until then
 *      the live record keeps the values that were verified.
 *
 * The request schema is `.strict()`, so a body naming a field from group 1 or
 * 2 is refused with 400 rather than silently ignored. "Read-only" is enforced
 * by the parser, not by the form.
 *
 * TENANCY
 *
 * Every partner-side function takes a `LogisticsMembership`, which only
 * `resolveLogisticsMembership` can produce from a session. No function here
 * accepts a partner id from a caller on the partner side. The admin-side
 * functions take one, and are reachable only behind `requireAdmin`.
 *
 * WHAT IS NEVER RETURNED
 *
 * `internalNotes`, every encrypted credential and webhook secret, and any
 * storage key of a private file. An integration is reported as a state word -
 * "connected" is said only where a verified success has been recorded.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  CarrierProvider,
  LogisticsComplianceDocumentKind,
  LogisticsComplianceReviewState,
  LogisticsDocumentScanState,
  LogisticsPartnerVerificationState,
} from '../../generated/prisma/enums.js';
import { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import {
  ErrorCode,
  badRequest,
  conflict,
  forbidden,
  notFound,
  serviceUnavailable,
} from '../../domain/errors.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import {
  MalwareDetectedError,
  MalwareScannerUnavailableError,
  assertNotMalware,
  scanForMalware,
} from '../../infra/malware-scan.js';
import { prisma } from '../../infra/prisma.js';
import {
  assertWithinSizeLimit,
  sniffDocumentType,
  sniffImageType,
  storage,
} from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import type { AdminActor } from './admin.service.js';
import { OPERATOR_LABEL, recordLogisticsAudit } from './audit.service.js';
import {
  assertLogisticsPermission,
  normaliseLogisticsName,
  type LogisticsMembership,
} from './partner.service.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Ten megabytes: a scanned certificate, not a photographed binder. */
export const MAX_COMPLIANCE_DOCUMENT_BYTES = 10 * 1024 * 1024;

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Weekday = (typeof WEEKDAYS)[number];

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour.');

const hoursDaySchema = z
  .object({ open: clock, close: clock })
  .strict()
  .refine((day) => day.open < day.close, { message: 'Closing time must be after opening time.' });

const operatingHoursSchema = z
  .object(
    Object.fromEntries(
      WEEKDAYS.map((day) => [day, hoursDaySchema.nullable().optional()]),
    ) as Record<Weekday, z.ZodOptional<z.ZodNullable<typeof hoursDaySchema>>>,
  )
  .strict();

export type OperatingHours = Partial<Record<Weekday, { open: string; close: string } | null>>;

const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use a two-letter country code.');

export const addressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(120),
    region: z.string().trim().max(120).nullable().optional(),
    postalCode: z.string().trim().max(20).nullable().optional(),
    countryCode,
  })
  .strict();

export type ProfileAddress = z.infer<typeof addressSchema>;

const hubSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    city: z.string().trim().min(1).max(120),
    countryCode,
  })
  .strict();

export const DECLARABLE_TRANSPORT_MODES = ['ROAD', 'AIR', 'SEA', 'RAIL'] as const;

/** Empty strings become null: a cleared field is "not set", not "". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value));

const optionalEmail = z
  .string()
  .trim()
  .max(320)
  .nullable()
  .optional()
  .transform((value) => (value === '' ? null : value))
  .pipe(z.string().email().nullable().optional());

const phone = z
  .string()
  .trim()
  .max(32)
  .regex(/^\+?[0-9 ()./-]{4,32}$/, 'Use digits, spaces and an optional leading +.');

const optionalPhone = z
  .string()
  .trim()
  .max(32)
  .nullable()
  .optional()
  .transform((value) => (value === '' ? null : value))
  .pipe(phone.nullable().optional());

const optionalUrl = z
  .string()
  .trim()
  .max(512)
  .nullable()
  .optional()
  .transform((value) => (value === '' ? null : value))
  .pipe(
    z
      .string()
      .url()
      .refine((value) => /^https?:\/\//i.test(value), 'Use an http or https address.')
      .nullable()
      .optional(),
  );

function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Fields a partner changes immediately. */
const immediateShape = {
  contactEmail: z.string().trim().email().max(320).optional(),
  contactPhone: optionalPhone,
  emergencyPhone: optionalPhone,
  emergencyContactName: optionalText(160),
  websiteUrl: optionalUrl,
  primaryContactName: optionalText(160),
  primaryContactTitle: optionalText(120),
  supportEmail: optionalEmail,
  supportPhone: optionalPhone,
  billingContactName: optionalText(160),
  billingEmail: optionalEmail,
  billingPhone: optionalPhone,
  businessDescription: optionalText(2000),
  operationalAddress: addressSchema.nullable().optional(),
  operatingHours: operatingHoursSchema.nullable().optional(),
  timeZone: z
    .string()
    .trim()
    .max(64)
    .refine(isKnownTimeZone, 'Choose a time zone from the list.')
    .nullable()
    .optional(),
  declaredTransportModes: z
    .array(z.enum(DECLARABLE_TRANSPORT_MODES))
    .max(DECLARABLE_TRANSPORT_MODES.length)
    .optional(),
  hubLocations: z.array(hubSchema).max(20).optional(),
};

/** Fields whose change waits for the operator. */
const reverifiedShape = {
  legalName: z.string().trim().min(2).max(255).optional(),
  displayName: z.string().trim().min(2).max(160).optional(),
  registrationNumber: optionalText(64),
  taxNumber: optionalText(64),
  registrationCountry: countryCode.optional(),
  registeredAddress: addressSchema.nullable().optional(),
  licenceNumber: optionalText(64),
  licenceExpiresAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
};

export const IMMEDIATE_FIELDS = Object.keys(immediateShape) as (keyof typeof immediateShape)[];
export const REVERIFIED_FIELDS = Object.keys(reverifiedShape) as (keyof typeof reverifiedShape)[];

/**
 * The whole PATCH body. `.strict()`: naming `id`, `partnerCode`, `status`,
 * `verificationState` or any other field outside the two groups is a 400.
 */
export const profileUpdateSchema = z.object({ ...immediateShape, ...reverifiedShape }).strict();
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

type ReverifiedField = (typeof REVERIFIED_FIELDS)[number];
type ReverifiedValues = Partial<Record<ReverifiedField, unknown>>;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ComplianceStatus = 'MISSING' | 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

/**
 * What the integration panel may say. No member of this means "connected"
 * unless a verified success has actually been recorded.
 */
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

export interface ComplianceDocumentView {
  id: string;
  kind: LogisticsComplianceDocumentKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanState: LogisticsDocumentScanState;
  reviewState: LogisticsComplianceReviewState;
  rejectionReason: string | null;
  expiresOn: string | null;
  uploadedByLabel: string;
  createdAt: string;
  reviewedAt: string | null;
  /** Whether a link would be issued for it now. */
  downloadable: boolean;
}

export interface ProfileChangeView {
  id: string;
  state: string;
  proposed: ReverifiedValues;
  current: ReverifiedValues;
  requestedByLabel: string;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface LogisticsProfileView {
  identity: {
    id: string;
    partnerCode: string;
    legalName: string;
    displayName: string;
    partnerKind: string;
    status: string;
    suspensionReason: string | null;
    verificationState: LogisticsPartnerVerificationState;
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
    hubLocations: { name: string; city: string; countryCode: string }[];
  };
  capabilities: {
    selfManaged: boolean;
    /** Levels this company is named on a published rate or a leg for. */
    levels: string[];
    /** Modes it is priced for on a published rate. Evidence, not a claim. */
    pricedTransportModes: string[];
    /** Modes it says it runs. A claim, and shown as one. */
    declaredTransportModes: string[];
    approved: { kind: string; state: string; evidenceExpiresAt: string | null }[];
    fleetSize: number;
    activeDrivers: number;
    vehicleKinds: string[];
    /** Heaviest single vehicle, in kilograms, where any vehicle states one. */
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
    items: {
      kind: LogisticsComplianceDocumentKind;
      status: ComplianceStatus;
      expiresOn: string | null;
    }[];
    documents: ComplianceDocumentView[];
  };
  integrations: { key: string; status: IntegrationStatus; lastSuccessAt: string | null }[];
  review: { pendingChange: ProfileChangeView | null; lastDecision: ProfileChangeView | null };
  /**
   * Who changed the profile, newest first. Null for a caller without the
   * audit permission: a dispatcher may read the profile and not the trail.
   */
  history:
    | {
        id: string;
        actorLabel: string;
        action: string;
        summary: string | null;
        createdAt: string;
      }[]
    | null;
  completion: { percent: number; missing: string[] };
  /** Which fields the caller may change, and how. The form reads this. */
  editing: {
    canEdit: boolean;
    immediate: string[];
    reverified: string[];
  };
}

/** The compliance documents every carrier is expected to hold. */
export const REQUIRED_COMPLIANCE_KINDS: readonly LogisticsComplianceDocumentKind[] = [
  'BUSINESS_LICENCE',
  'INSURANCE_CERTIFICATE',
  'TRANSPORT_PERMIT',
];

/** Read an address written by any earlier version, or null. */
export function readAddress(json: unknown): ProfileAddress | null {
  if (json === null || typeof json !== 'object') return null;
  const parsed = addressSchema.safeParse(json);
  if (parsed.success) return parsed.data;

  // Older rows were written by the admin screen with the same keys and
  // sometimes a lower-case country. Take what is recognisable; drop the rest.
  const raw = json as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof raw[key] === 'string' && raw[key].trim() !== '' ? raw[key].trim() : null;
  const line1 = text('line1');
  const city = text('city');
  const country = text('countryCode') ?? text('country');
  if (line1 === null || city === null || country === null || !/^[a-z]{2}$/i.test(country)) {
    return null;
  }
  return {
    line1,
    line2: text('line2'),
    city,
    region: text('region') ?? text('state'),
    postalCode: text('postalCode') ?? text('postcode'),
    countryCode: country.toUpperCase(),
  };
}

function readHours(json: unknown): OperatingHours | null {
  const parsed = operatingHoursSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function readModes(json: unknown): string[] {
  const parsed = z.array(z.enum(DECLARABLE_TRANSPORT_MODES)).safeParse(json);
  return parsed.success ? parsed.data : [];
}

function readHubs(json: unknown): { name: string; city: string; countryCode: string }[] {
  const parsed = z.array(hubSchema).safeParse(json);
  return parsed.success ? parsed.data : [];
}

const isoDate = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

/** Whether a compliance file may be handed out at all. Same rule as shipment documents. */
function isServable(scanState: LogisticsDocumentScanState): boolean {
  if (scanState === 'CLEAN') return true;
  if (scanState === 'SKIPPED') return env.LOGISTICS_ALLOW_UNSCANNED_DOCUMENTS;
  return false;
}

/** The status one required kind has, from the newest live upload of it. */
export function complianceStatusFor(
  document: { reviewState: LogisticsComplianceReviewState; expiresOn: Date | null } | undefined,
  now: Date = new Date(),
): ComplianceStatus {
  if (document === undefined) return 'MISSING';
  if (document.expiresOn !== null && document.expiresOn.getTime() < startOfUtcDay(now)) {
    return 'EXPIRED';
  }
  return document.reviewState;
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * The state word for a carrier API. The only road to CONNECTED is an ACTIVE
 * integration with a recorded success.
 */
export function carrierStatus(
  provider: CarrierProvider,
  integration: { provider: CarrierProvider; state: string; lastSuccessAt: Date | null } | null,
): IntegrationStatus {
  if (provider === 'INDIA_POST') return 'MANUAL_TRACKING';
  if (integration === null || integration.provider !== provider) return 'CREDENTIALS_REQUIRED';
  switch (integration.state) {
    case 'ACTIVE':
      return integration.lastSuccessAt === null ? 'CONFIGURED_UNVERIFIED' : 'CONNECTED';
    case 'CONFIGURED':
      return 'CONFIGURED_UNVERIFIED';
    case 'ERROR':
      return 'ERROR';
    case 'DISABLED':
      return 'DISABLED';
    default:
      return 'CREDENTIALS_REQUIRED';
  }
}

/** Fields that count towards the completion ring. */
const COMPLETION_CHECKS: readonly [
  string,
  (view: Omit<LogisticsProfileView, 'completion'>) => boolean,
][] = [
  ['logo', (v) => v.identity.logoUrl !== null],
  ['registeredAddress', (v) => v.company.registeredAddress !== null],
  ['registrationNumber', (v) => v.company.registrationNumber !== null],
  ['taxNumber', (v) => v.company.taxNumber !== null],
  ['websiteUrl', (v) => v.company.websiteUrl !== null],
  ['businessDescription', (v) => v.company.businessDescription !== null],
  ['contactPhone', (v) => v.contacts.contactPhone !== null],
  ['primaryContactName', (v) => v.contacts.primaryContactName !== null],
  ['emergencyPhone', (v) => v.contacts.emergencyPhone !== null],
  ['supportEmail', (v) => v.contacts.supportEmail !== null],
  ['billingEmail', (v) => v.contacts.billingEmail !== null],
  ['operatingHours', (v) => v.capabilities.operatingHours !== null],
  ['timeZone', (v) => v.capabilities.timeZone !== null],
  ['declaredTransportModes', (v) => v.capabilities.declaredTransportModes.length > 0],
  ['licenceNumber', (v) => v.compliance.licenceNumber !== null],
  ...REQUIRED_COMPLIANCE_KINDS.map(
    (kind) =>
      [
        `document.${kind}`,
        (v: Omit<LogisticsProfileView, 'completion'>) =>
          v.compliance.items.some((item) => item.kind === kind && item.status !== 'MISSING'),
      ] as [string, (view: Omit<LogisticsProfileView, 'completion'>) => boolean],
  ),
];

export function profileCompletion(view: Omit<LogisticsProfileView, 'completion'>): {
  percent: number;
  missing: string[];
} {
  const missing = COMPLETION_CHECKS.filter(([, check]) => !check(view)).map(([key]) => key);
  const done = COMPLETION_CHECKS.length - missing.length;
  return { percent: Math.round((done / COMPLETION_CHECKS.length) * 100), missing };
}

function changeView(row: {
  id: string;
  state: string;
  proposedJson: unknown;
  currentJson: unknown;
  requestedByLabel: string;
  requestedAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
}): ProfileChangeView {
  return {
    id: row.id,
    state: row.state,
    proposed: row.proposedJson ?? {},
    current: row.currentJson ?? {},
    requestedByLabel: row.requestedByLabel,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
  };
}

function documentView(row: {
  id: string;
  kind: LogisticsComplianceDocumentKind;
  originalFileName: string;
  contentType: string;
  byteSize: number;
  scanState: LogisticsDocumentScanState;
  reviewState: LogisticsComplianceReviewState;
  rejectionReason: string | null;
  expiresOn: Date | null;
  uploadedByLabel: string;
  createdAt: Date;
  reviewedAt: Date | null;
}): ComplianceDocumentView {
  return {
    id: row.id,
    kind: row.kind,
    fileName: row.originalFileName,
    contentType: row.contentType,
    sizeBytes: row.byteSize,
    scanState: row.scanState,
    reviewState: row.reviewState,
    rejectionReason: row.rejectionReason,
    expiresOn: isoDate(row.expiresOn),
    uploadedByLabel: row.uploadedByLabel,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    downloadable: isServable(row.scanState),
  };
}

const DOCUMENT_SELECT = {
  id: true,
  kind: true,
  originalFileName: true,
  contentType: true,
  byteSize: true,
  scanState: true,
  reviewState: true,
  rejectionReason: true,
  expiresOn: true,
  uploadedByLabel: true,
  createdAt: true,
  reviewedAt: true,
} as const;

/**
 * Build the whole profile for one partner id.
 *
 * Private to this module: the partner-side entry point derives the id from a
 * membership, and the admin-side one sits behind `requireAdmin`.
 */
async function buildProfile(
  logisticsPartnerId: string,
  editing: LogisticsProfileView['editing'],
  includeHistory: boolean,
): Promise<LogisticsProfileView> {
  const partner = await prisma.logisticsPartner.findFirst({
    where: { id: logisticsPartnerId, archivedAt: null },
    select: {
      id: true,
      partnerCode: true,
      legalName: true,
      displayName: true,
      partnerKind: true,
      status: true,
      suspensionReason: true,
      verificationState: true,
      verifiedAt: true,
      logoStorageKey: true,
      createdAt: true,
      updatedAt: true,
      addressJson: true,
      operationalAddressJson: true,
      registrationCountry: true,
      registrationNumber: true,
      taxNumber: true,
      websiteUrl: true,
      businessDescription: true,
      contactEmail: true,
      contactPhone: true,
      primaryContactName: true,
      primaryContactTitle: true,
      emergencyContactName: true,
      emergencyPhone: true,
      supportEmail: true,
      supportPhone: true,
      billingContactName: true,
      billingEmail: true,
      billingPhone: true,
      operatingHoursJson: true,
      timeZone: true,
      declaredTransportModesJson: true,
      hubLocationsJson: true,
      licenceNumber: true,
      licenceExpiresAt: true,
      contractStatus: true,
      contractEndsAt: true,
      regions: {
        orderBy: [{ countryCode: 'asc' }, { regionValue: 'asc' }],
        select: {
          id: true,
          scope: true,
          countryCode: true,
          regionValue: true,
          supportsPickup: true,
          supportsDelivery: true,
          isExclusion: true,
          isActive: true,
        },
      },
      capabilities: {
        orderBy: { kind: 'asc' },
        select: { kind: true, state: true, evidenceExpiresAt: true },
      },
      carrierIntegration: {
        // State words and timestamps only. The encrypted columns are never
        // selected, so they cannot be serialised by a mistake further down.
        select: {
          id: true,
          provider: true,
          state: true,
          lastSuccessAt: true,
          webhookSecretEnc: true,
        },
      },
      vehicles: {
        where: { isActive: true },
        select: { kind: true, maxWeightGrams: true, hasRefrigeration: true },
      },
      complianceDocuments: {
        where: { supersededAt: null },
        orderBy: { createdAt: 'desc' },
        select: DOCUMENT_SELECT,
      },
      profileChanges: {
        orderBy: { requestedAt: 'desc' },
        take: 2,
        select: {
          id: true,
          state: true,
          proposedJson: true,
          currentJson: true,
          requestedByLabel: true,
          requestedAt: true,
          decidedAt: true,
          decisionNote: true,
        },
      },
      _count: { select: { drivers: { where: { state: 'ACTIVE' } } } },
    },
  });

  if (partner === null) throw notFound('Logistics partner');

  const [rateLevels, legLevels, gps, webhookSuccess, history] = await Promise.all([
    prisma.logisticsLevelRate.findMany({
      where: { logisticsPartnerId: partner.id, status: 'PUBLISHED' },
      distinct: ['level', 'transportMode'],
      select: { level: true, transportMode: true },
    }),
    prisma.shipmentLeg.findMany({
      where: { logisticsPartnerId: partner.id },
      distinct: ['level'],
      select: { level: true },
    }),
    Promise.all([
      prisma.logisticsDriverProfile.count({
        where: {
          logisticsPartnerId: partner.id,
          state: 'ACTIVE',
          locationConsentAt: { not: null },
          locationConsentWithdrawnAt: null,
        },
      }),
      prisma.logisticsLocationPing.findFirst({
        where: {
          driver: { logisticsPartnerId: partner.id },
          receivedAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
        },
        select: { id: true },
      }),
    ]),
    partner.carrierIntegration === null
      ? Promise.resolve(null)
      : prisma.carrierWebhookEvent.findFirst({
          where: {
            carrierIntegrationId: partner.carrierIntegration.id,
            state: { in: ['PROCESSED', 'IGNORED'] },
          },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true },
        }),
    includeHistory
      ? prisma.logisticsAuditLog.findMany({
          where: {
            logisticsPartnerId: partner.id,
            OR: [
              { action: { startsWith: 'logistics.profile.' } },
              { action: 'logistics.organisation.updated' },
            ],
          },
          orderBy: { id: 'desc' },
          take: 25,
          // The summary line only. The before/after JSON is not selected.
          select: { id: true, actorLabel: true, action: true, summary: true, createdAt: true },
        })
      : Promise.resolve(null),
  ]);

  const [consentingDrivers, recentPing] = gps;
  const documents = partner.complianceDocuments;
  const newestOf = (kind: LogisticsComplianceDocumentKind) =>
    documents.find((d) => d.kind === kind);

  const integration = partner.carrierIntegration;
  const kinds = new Set<LogisticsComplianceDocumentKind>([
    ...REQUIRED_COMPLIANCE_KINDS,
    ...documents.map((document) => document.kind),
  ]);

  const pending = partner.profileChanges.find((change) => change.state === 'PENDING') ?? null;
  const lastDecided =
    partner.profileChanges.find(
      (change) => change.state === 'APPROVED' || change.state === 'REJECTED',
    ) ?? null;

  const weights = partner.vehicles
    .map((vehicle) => vehicle.maxWeightGrams)
    .filter((grams): grams is number => grams !== null);

  const view: Omit<LogisticsProfileView, 'completion'> = {
    identity: {
      id: partner.id,
      partnerCode: partner.partnerCode,
      legalName: partner.legalName,
      displayName: partner.displayName,
      partnerKind: partner.partnerKind,
      status: partner.status,
      suspensionReason: partner.suspensionReason,
      verificationState: partner.verificationState,
      verifiedAt: partner.verifiedAt?.toISOString() ?? null,
      logoUrl: partner.logoStorageKey === null ? null : storage.urlFor(partner.logoStorageKey),
      createdAt: partner.createdAt.toISOString(),
      updatedAt: partner.updatedAt.toISOString(),
    },
    company: {
      registeredAddress: readAddress(partner.addressJson),
      operationalAddress: readAddress(partner.operationalAddressJson),
      registrationCountry: partner.registrationCountry,
      registrationNumber: partner.registrationNumber,
      taxNumber: partner.taxNumber,
      websiteUrl: partner.websiteUrl,
      businessDescription: partner.businessDescription,
    },
    contacts: {
      contactEmail: partner.contactEmail,
      contactPhone: partner.contactPhone,
      primaryContactName: partner.primaryContactName,
      primaryContactTitle: partner.primaryContactTitle,
      emergencyContactName: partner.emergencyContactName,
      emergencyPhone: partner.emergencyPhone,
      supportEmail: partner.supportEmail,
      supportPhone: partner.supportPhone,
      billingContactName: partner.billingContactName,
      billingEmail: partner.billingEmail,
      billingPhone: partner.billingPhone,
    },
    coverage: {
      regions: partner.regions,
      countries: [
        ...new Set(
          partner.regions
            .filter((region) => region.isActive && !region.isExclusion)
            .map((region) => region.countryCode),
        ),
      ].sort(),
      hubLocations: readHubs(partner.hubLocationsJson),
    },
    capabilities: {
      selfManaged: partner.partnerKind === 'SELLER_SELF_MANAGED',
      levels: [
        ...new Set([...rateLevels.map((row) => row.level), ...legLevels.map((row) => row.level)]),
      ].sort(),
      pricedTransportModes: [...new Set(rateLevels.map((row) => row.transportMode))].sort(),
      declaredTransportModes: readModes(partner.declaredTransportModesJson),
      approved: partner.capabilities.map((capability) => ({
        kind: capability.kind,
        state: capability.state,
        evidenceExpiresAt: isoDate(capability.evidenceExpiresAt),
      })),
      fleetSize: partner.vehicles.length,
      activeDrivers: partner._count.drivers,
      vehicleKinds: [...new Set(partner.vehicles.map((vehicle) => vehicle.kind))].sort(),
      maxVehicleLoadKg: weights.length === 0 ? null : Math.max(...weights) / 1000,
      refrigeratedVehicles: partner.vehicles.filter((vehicle) => vehicle.hasRefrigeration).length,
      operatingHours: readHours(partner.operatingHoursJson),
      timeZone: partner.timeZone,
    },
    compliance: {
      licenceNumber: partner.licenceNumber,
      licenceExpiresAt: isoDate(partner.licenceExpiresAt),
      contractStatus: partner.contractStatus,
      contractEndsAt: isoDate(partner.contractEndsAt),
      items: [...kinds].map((kind) => {
        const newest = newestOf(kind);
        return {
          kind,
          status: complianceStatusFor(newest),
          expiresOn: isoDate(newest?.expiresOn ?? null),
        };
      }),
      documents: documents.map(documentView),
    },
    integrations: [
      {
        key: 'DHL',
        status: carrierStatus('DHL', integration),
        lastSuccessAt:
          integration?.provider === 'DHL'
            ? (integration.lastSuccessAt?.toISOString() ?? null)
            : null,
      },
      {
        key: 'FEDEX',
        status: carrierStatus('FEDEX', integration),
        lastSuccessAt:
          integration?.provider === 'FEDEX'
            ? (integration.lastSuccessAt?.toISOString() ?? null)
            : null,
      },
      { key: 'INDIA_POST', status: 'MANUAL_TRACKING', lastSuccessAt: null },
      {
        key: 'GPS',
        status:
          recentPing !== null
            ? 'ACTIVE'
            : consentingDrivers > 0
              ? 'CONSENT_ONLY'
              : 'NOT_CONFIGURED',
        lastSuccessAt: null,
      },
      {
        key: 'WEBHOOK',
        // Connected only once a signed event has actually been accepted.
        status:
          integration === null || integration.webhookSecretEnc === null
            ? 'NOT_CONFIGURED'
            : webhookSuccess === null
              ? 'AWAITING_FIRST_EVENT'
              : 'CONNECTED',
        lastSuccessAt: webhookSuccess?.receivedAt.toISOString() ?? null,
      },
    ],
    review: {
      pendingChange: pending === null ? null : changeView(pending),
      lastDecision: lastDecided === null ? null : changeView(lastDecided),
    },
    editing,
    history:
      history === null
        ? null
        : history.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
  };

  return { ...view, completion: profileCompletion(view) };
}

function editingFor(membership: LogisticsMembership): LogisticsProfileView['editing'] {
  const canEdit = membership.permissions.has(LogisticsPermission.ORGANISATION_WRITE);
  return {
    canEdit,
    immediate: canEdit ? [...IMMEDIATE_FIELDS] : [],
    reverified: canEdit ? [...REVERIFIED_FIELDS] : [],
  };
}

/** The signed-in person's own company. The id comes from the session and nowhere else. */
export async function readLogisticsProfile(
  membership: LogisticsMembership,
): Promise<LogisticsProfileView> {
  assertLogisticsPermission(membership, LogisticsPermission.ORGANISATION_READ);
  return buildProfile(
    membership.logisticsPartnerId,
    editingFor(membership),
    membership.permissions.has(LogisticsPermission.AUDIT_READ),
  );
}

// ---------------------------------------------------------------------------
// Changing it
// ---------------------------------------------------------------------------

/** The live value of every re-verified field, in the same shape a proposal uses. */
function currentReverified(partner: {
  legalName: string;
  displayName: string;
  registrationNumber: string | null;
  taxNumber: string | null;
  registrationCountry: string;
  addressJson: unknown;
  licenceNumber: string | null;
  licenceExpiresAt: Date | null;
}): Record<ReverifiedField, unknown> {
  return {
    legalName: partner.legalName,
    displayName: partner.displayName,
    registrationNumber: partner.registrationNumber,
    taxNumber: partner.taxNumber,
    registrationCountry: partner.registrationCountry,
    registeredAddress: readAddress(partner.addressJson),
    licenceNumber: partner.licenceNumber,
    licenceExpiresAt: isoDate(partner.licenceExpiresAt),
  };
}

const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface ProfileUpdateResult {
  profile: LogisticsProfileView;
  /** Immediate fields that were written. */
  applied: string[];
  /** Re-verified fields now waiting for the operator. */
  submittedForReview: string[];
}

/**
 * Save the partner's edits.
 *
 * Immediate fields are written. Re-verified fields that actually differ from
 * the live record become ONE pending proposal, replacing any earlier pending
 * one (which is marked WITHDRAWN rather than deleted). A proposal identical to
 * the live values is not a proposal and is dropped.
 */
export async function updateLogisticsProfile(
  membership: LogisticsMembership,
  input: ProfileUpdate,
  correlationId?: string | null,
): Promise<ProfileUpdateResult> {
  assertLogisticsPermission(membership, LogisticsPermission.ORGANISATION_WRITE);

  const body = profileUpdateSchema.parse(input);

  const partner = await prisma.logisticsPartner.findFirst({
    where: { id: membership.logisticsPartnerId, archivedAt: null },
    select: {
      id: true,
      legalName: true,
      displayName: true,
      registrationNumber: true,
      taxNumber: true,
      registrationCountry: true,
      addressJson: true,
      licenceNumber: true,
      licenceExpiresAt: true,
      contactEmail: true,
      contactPhone: true,
      emergencyPhone: true,
      emergencyContactName: true,
      websiteUrl: true,
      primaryContactName: true,
      primaryContactTitle: true,
      supportEmail: true,
      supportPhone: true,
      billingContactName: true,
      billingEmail: true,
      billingPhone: true,
      businessDescription: true,
      operationalAddressJson: true,
      operatingHoursJson: true,
      timeZone: true,
      declaredTransportModesJson: true,
      hubLocationsJson: true,
    },
  });

  if (partner === null) throw notFound('Logistics partner');

  // --- Immediate ---------------------------------------------------------
  const data: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  const column: Record<(typeof IMMEDIATE_FIELDS)[number], string> = {
    contactEmail: 'contactEmail',
    contactPhone: 'contactPhone',
    emergencyPhone: 'emergencyPhone',
    emergencyContactName: 'emergencyContactName',
    websiteUrl: 'websiteUrl',
    primaryContactName: 'primaryContactName',
    primaryContactTitle: 'primaryContactTitle',
    supportEmail: 'supportEmail',
    supportPhone: 'supportPhone',
    billingContactName: 'billingContactName',
    billingEmail: 'billingEmail',
    billingPhone: 'billingPhone',
    businessDescription: 'businessDescription',
    operationalAddress: 'operationalAddressJson',
    operatingHours: 'operatingHoursJson',
    timeZone: 'timeZone',
    declaredTransportModes: 'declaredTransportModesJson',
    hubLocations: 'hubLocationsJson',
  };

  for (const field of IMMEDIATE_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    const name = column[field];
    const previous = (partner as Record<string, unknown>)[name];
    if (sameValue(previous, value)) continue;
    // A JSON column is cleared with the database's NULL, not JSON null.
    data[name] = value === null && name.endsWith('Json') ? Prisma.DbNull : value;
    before[field] = previous ?? null;
    after[field] = value;
  }

  // --- Re-verified -------------------------------------------------------
  const current = currentReverified(partner);
  const proposed: ReverifiedValues = {};
  const proposedCurrent: ReverifiedValues = {};

  for (const field of REVERIFIED_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (sameValue(current[field], value)) continue;
    proposed[field] = value;
    proposedCurrent[field] = current[field];
  }

  if (typeof proposed.displayName === 'string') {
    const normalised = normaliseLogisticsName(proposed.displayName);
    const clash = await prisma.logisticsPartner.findFirst({
      where: { displayNameNormalized: normalised, id: { not: partner.id } },
      select: { id: true },
    });
    if (clash !== null) {
      throw conflict(ErrorCode.CONFLICT, 'Another logistics company already uses that name.', [
        { field: 'displayName', code: 'TAKEN' },
      ]);
    }
  }

  const applied = Object.keys(after);
  const submittedForReview = Object.keys(proposed);

  if (applied.length === 0 && submittedForReview.length === 0) {
    return { profile: await readLogisticsProfile(membership), applied, submittedForReview };
  }

  await prisma.$transaction(async (tx) => {
    if (applied.length > 0) {
      await tx.logisticsPartner.update({ where: { id: partner.id }, data });

      await recordLogisticsAudit(
        {
          logisticsPartnerId: partner.id,
          actorUserId: membership.userId,
          actorLabel: membership.fullName,
          action: 'logistics.profile.updated',
          resourceType: 'logistics_partner',
          resourceId: partner.id,
          before,
          after,
          summary: `Profile updated: ${applied.join(', ')}.`,
          correlationId: correlationId ?? null,
        },
        tx,
      );
    }

    if (submittedForReview.length > 0) {
      // Retire the open request first, so the UNIQUE pendingKey is free.
      const superseded = await tx.logisticsPartnerProfileChange.updateMany({
        where: { logisticsPartnerId: partner.id, state: 'PENDING' },
        data: { state: 'WITHDRAWN', pendingKey: null, decidedAt: new Date() },
      });

      const changeId = newId();
      await tx.logisticsPartnerProfileChange.create({
        data: {
          id: changeId,
          logisticsPartnerId: partner.id,
          state: 'PENDING',
          pendingKey: partner.id,
          proposedJson: proposed as Prisma.InputJsonObject,
          currentJson: proposedCurrent as Prisma.InputJsonObject,
          requestedByUserId: membership.userId,
          requestedByLabel: membership.fullName.slice(0, 160),
        },
      });

      await recordLogisticsAudit(
        {
          logisticsPartnerId: partner.id,
          actorUserId: membership.userId,
          actorLabel: membership.fullName,
          action: 'logistics.profile.change_requested',
          resourceType: 'logistics_partner_profile_change',
          resourceId: changeId,
          before: proposedCurrent,
          after: proposed,
          summary:
            `Sent for verification: ${submittedForReview.join(', ')}.` +
            (superseded.count > 0 ? ' It replaces the earlier request.' : ''),
          correlationId: correlationId ?? null,
        },
        tx,
      );
    }
  });

  return { profile: await readLogisticsProfile(membership), applied, submittedForReview };
}

/** Take back an identity change nobody has decided yet. */
export async function withdrawProfileChange(
  membership: LogisticsMembership,
  correlationId?: string | null,
): Promise<LogisticsProfileView> {
  assertLogisticsPermission(membership, LogisticsPermission.ORGANISATION_WRITE);

  const pending = await prisma.logisticsPartnerProfileChange.findFirst({
    where: { logisticsPartnerId: membership.logisticsPartnerId, state: 'PENDING' },
    select: { id: true },
  });

  if (pending === null) throw notFound('Pending change');

  await prisma.$transaction(async (tx) => {
    const updated = await tx.logisticsPartnerProfileChange.updateMany({
      where: { id: pending.id, state: 'PENDING' },
      data: { state: 'WITHDRAWN', pendingKey: null, decidedAt: new Date() },
    });
    if (updated.count !== 1)
      throw conflict(ErrorCode.CONFLICT, 'That request was already decided.');

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: 'logistics.profile.change_withdrawn',
        resourceType: 'logistics_partner_profile_change',
        resourceId: pending.id,
        summary: 'The pending verification request was withdrawn.',
        correlationId: correlationId ?? null,
      },
      tx,
    );
  });

  return readLogisticsProfile(membership);
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

/**
 * Replace the company's logo. The bytes decide the type (SVG is refused), the
 * scanner runs before anything is written, and the old file is removed only
 * after the new one is recorded - the same order `seller/logo.service.ts` uses.
 */
export async function uploadLogisticsLogo(
  membership: LogisticsMembership,
  buffer: Buffer,
  correlationId?: string | null,
): Promise<{ logoUrl: string }> {
  assertLogisticsPermission(membership, LogisticsPermission.ORGANISATION_WRITE);

  assertWithinSizeLimit(buffer.byteLength);
  const sniffed = sniffImageType(buffer);
  await assertNotMalware(buffer);

  const partner = await prisma.logisticsPartner.findUniqueOrThrow({
    where: { id: membership.logisticsPartnerId },
    select: { logoStorageKey: true },
  });

  const stored = await storage.put(buffer, sniffed.mimeType, sniffed.extension, 'public');

  await prisma.logisticsPartner.update({
    where: { id: membership.logisticsPartnerId },
    data: { logoStorageKey: stored.storageKey },
  });

  await removeObject(partner.logoStorageKey);

  await recordLogisticsAudit({
    logisticsPartnerId: membership.logisticsPartnerId,
    actorUserId: membership.userId,
    actorLabel: membership.fullName,
    action: 'logistics.profile.logo_updated',
    resourceType: 'logistics_partner',
    resourceId: membership.logisticsPartnerId,
    summary: 'The company logo was changed.',
    correlationId: correlationId ?? null,
  });

  return { logoUrl: storage.urlFor(stored.storageKey) };
}

export async function removeLogisticsLogo(
  membership: LogisticsMembership,
  correlationId?: string | null,
): Promise<void> {
  assertLogisticsPermission(membership, LogisticsPermission.ORGANISATION_WRITE);

  const partner = await prisma.logisticsPartner.findUniqueOrThrow({
    where: { id: membership.logisticsPartnerId },
    select: { logoStorageKey: true },
  });

  if (partner.logoStorageKey === null) throw notFound('Logo');

  await prisma.logisticsPartner.update({
    where: { id: membership.logisticsPartnerId },
    data: { logoStorageKey: null },
  });

  await removeObject(partner.logoStorageKey);

  await recordLogisticsAudit({
    logisticsPartnerId: membership.logisticsPartnerId,
    actorUserId: membership.userId,
    actorLabel: membership.fullName,
    action: 'logistics.profile.logo_removed',
    resourceType: 'logistics_partner',
    resourceId: membership.logisticsPartnerId,
    summary: 'The company logo was removed.',
    correlationId: correlationId ?? null,
  });
}

async function removeObject(storageKey: string | null): Promise<void> {
  if (storageKey === null || storageKey.length === 0) return;
  try {
    await storage.delete(storageKey);
  } catch {
    // Litter rather than a broken logo. See `seller/logo.service.ts`.
  }
}

// ---------------------------------------------------------------------------
// Compliance documents
// ---------------------------------------------------------------------------

export const complianceUploadSchema = z
  .object({
    kind: z.enum([
      'BUSINESS_LICENCE',
      'INSURANCE_CERTIFICATE',
      'TRANSPORT_PERMIT',
      'COMPANY_REGISTRATION',
      'TAX_REGISTRATION',
      'OTHER',
    ]),
    expiresOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional()
      .transform((value) => (value === '' || value === undefined ? null : value)),
  })
  .strict();

async function scanComplianceFile(bytes: Buffer): Promise<LogisticsDocumentScanState> {
  try {
    const result = await scanForMalware(bytes);
    return result.status === 'CLEAN' ? 'CLEAN' : 'SKIPPED';
  } catch (error) {
    if (error instanceof MalwareDetectedError) {
      throw badRequest(ErrorCode.MALWARE_DETECTED, 'The uploaded file failed the security scan.');
    }
    if (error instanceof MalwareScannerUnavailableError) {
      throw serviceUnavailable('The file security scanner is temporarily unavailable.', error);
    }
    throw error;
  }
}

/**
 * File a compliance document. PDF or image only, decided by the bytes; ten
 * megabytes; scanned before it is stored; written under the PRIVATE prefix.
 * The previous live document of the same kind is superseded, not deleted.
 */
export async function uploadComplianceDocument(
  membership: LogisticsMembership,
  input: { kind: string; expiresOn?: string | null; fileName: string; bytes: Buffer },
  correlationId?: string | null,
): Promise<ComplianceDocumentView> {
  assertLogisticsPermission(membership, LogisticsPermission.ORGANISATION_WRITE);

  const meta = complianceUploadSchema.parse({ kind: input.kind, expiresOn: input.expiresOn });

  if (input.bytes.byteLength === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The file is empty.', [
      { field: 'file', code: 'EMPTY' },
    ]);
  }
  if (input.bytes.byteLength > MAX_COMPLIANCE_DOCUMENT_BYTES) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Documents must be 10 MB or smaller.', [
      { field: 'file', code: 'TOO_LARGE', meta: { maxBytes: MAX_COMPLIANCE_DOCUMENT_BYTES } },
    ]);
  }

  const sniffed = sniffDocumentType(input.bytes);
  const scanState = await scanComplianceFile(input.bytes);
  const stored = await storage.put(input.bytes, sniffed.mimeType, sniffed.extension, 'private');

  const fileName =
    input.fileName.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 255) ||
    `document.${sniffed.extension}`;
  const id = newId();

  const row = await prisma.$transaction(async (tx) => {
    await tx.logisticsPartnerDocument.updateMany({
      where: {
        logisticsPartnerId: membership.logisticsPartnerId,
        kind: meta.kind,
        supersededAt: null,
      },
      data: { supersededAt: new Date() },
    });

    const created = await tx.logisticsPartnerDocument.create({
      data: {
        id,
        logisticsPartnerId: membership.logisticsPartnerId,
        kind: meta.kind,
        storageKey: stored.storageKey,
        originalFileName: fileName,
        contentType: sniffed.mimeType,
        byteSize: input.bytes.byteLength,
        contentHash: createHash('sha256').update(input.bytes).digest('hex'),
        scanState,
        expiresOn: meta.expiresOn === null ? null : new Date(`${meta.expiresOn}T00:00:00.000Z`),
        uploadedByUserId: membership.userId,
        uploadedByLabel: membership.fullName.slice(0, 160),
      },
      select: DOCUMENT_SELECT,
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: 'logistics.profile.document_uploaded',
        resourceType: 'logistics_partner_document',
        resourceId: id,
        after: { kind: meta.kind, expiresOn: meta.expiresOn, scanState },
        summary: `${fileName} was filed for verification.`,
        correlationId: correlationId ?? null,
      },
      tx,
    );

    return created;
  });

  return documentView(row);
}

export interface ComplianceLink {
  url: string;
  expiresAt: string;
  fileName: string;
}

type LinkAudience = 'partner' | 'admin';

const tokenHashFor = (audience: LinkAudience, documentId: string, token: string): string =>
  sha256Hex(`logistics-compliance:${audience}:${documentId}:${token}`);

async function mintLink(
  audience: LinkAudience,
  userId: string,
  document: { id: string; originalFileName: string; scanState: LogisticsDocumentScanState },
  url: (token: string) => string,
): Promise<ComplianceLink> {
  if (!isServable(document.scanState)) {
    throw conflict(
      ErrorCode.SELLER_DOCUMENT_REJECTED,
      document.scanState === 'SKIPPED'
        ? 'This installation does not serve files that have not been scanned for malware.'
        : 'This file cannot be downloaded.',
      [{ code: 'SCAN_STATE', meta: { scanState: document.scanState } }],
    );
  }

  const { token } = generateToken(32);
  const expiresAt = new Date(Date.now() + env.LOGISTICS_DOCUMENT_URL_TTL_SECONDS * 1000);

  await prisma.authToken.create({
    data: {
      id: newId(),
      userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: tokenHashFor(audience, document.id, token),
      expiresAt,
      createdById: userId,
    },
  });

  return {
    url: url(token),
    expiresAt: expiresAt.toISOString(),
    fileName: document.originalFileName,
  };
}

async function consumeLink(
  audience: LinkAudience,
  userId: string,
  documentId: string,
  token: string,
): Promise<void> {
  const record = await prisma.authToken.findUnique({
    where: { tokenHash: tokenHashFor(audience, documentId, token) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });

  if (
    record === null ||
    record.userId !== userId ||
    record.consumedAt !== null ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
  }

  const consumed = await prisma.authToken.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  if (consumed.count !== 1) {
    throw forbidden(ErrorCode.TOKEN_ALREADY_USED, 'This download link has already been used.');
  }
}

/** A single-use link to one of the caller's own company's documents. */
export async function createComplianceDocumentLink(
  membership: LogisticsMembership,
  documentId: string,
  correlationId?: string | null,
): Promise<ComplianceLink> {
  assertLogisticsPermission(membership, LogisticsPermission.ORGANISATION_READ);

  const document = await prisma.logisticsPartnerDocument.findFirst({
    // The tenant boundary is in the WHERE, so another company's id is a 404.
    where: { id: documentId, logisticsPartnerId: membership.logisticsPartnerId },
    select: { id: true, originalFileName: true, scanState: true },
  });

  if (document === null) throw notFound('Document');

  const link = await mintLink(
    'partner',
    membership.userId,
    document,
    (token) => `/api/v1/logistics/profile/documents/${document.id}/download?token=${token}`,
  );

  await recordLogisticsAudit({
    logisticsPartnerId: membership.logisticsPartnerId,
    actorUserId: membership.userId,
    actorLabel: membership.fullName,
    action: 'logistics.profile.document_downloaded',
    resourceType: 'logistics_partner_document',
    resourceId: document.id,
    summary: `${document.originalFileName} was downloaded.`,
    correlationId: correlationId ?? null,
  });

  return link;
}

/**
 * Redeem a partner link. The token AND the session must both match, so a link
 * forwarded to somebody at another carrier does not work for them.
 */
export async function redeemComplianceDocumentLink(
  membership: LogisticsMembership,
  documentId: string,
  token: string,
): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  await consumeLink('partner', membership.userId, documentId, token);

  const document = await prisma.logisticsPartnerDocument.findFirst({
    where: { id: documentId, logisticsPartnerId: membership.logisticsPartnerId },
    select: { storageKey: true, contentType: true, originalFileName: true, scanState: true },
  });

  if (document === null) throw notFound('Document');
  if (!isServable(document.scanState)) {
    throw conflict(ErrorCode.SELLER_DOCUMENT_REJECTED, 'This file cannot be downloaded.');
  }

  return {
    body: await storage.get(document.storageKey),
    contentType: document.contentType,
    fileName: document.originalFileName,
  };
}

// ---------------------------------------------------------------------------
// The operator's side
// ---------------------------------------------------------------------------

export interface PartnerProfileReview {
  profile: LogisticsProfileView;
  /** Every document ever filed, newest first, superseded ones included. */
  documentHistory: (ComplianceDocumentView & { supersededAt: string | null })[];
}

/** The whole profile, for staff, with the review queue attached. */
export async function readPartnerProfileForReview(
  partnerId: string,
): Promise<PartnerProfileReview> {
  const profile = await buildProfile(
    partnerId,
    { canEdit: false, immediate: [], reverified: [] },
    true,
  );

  const history = await prisma.logisticsPartnerDocument.findMany({
    where: { logisticsPartnerId: partnerId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { ...DOCUMENT_SELECT, supersededAt: true },
  });

  return {
    profile,
    documentHistory: history.map((row) => ({
      ...documentView(row),
      supersededAt: row.supersededAt?.toISOString() ?? null,
    })),
  };
}

function requireNote(note: string | null | undefined, field: string): string {
  const trimmed = (note ?? '').trim();
  if (trimmed.length < 8) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Say why. The carrier is shown this, and a refusal with no reason cannot be fixed.',
      [{ field, code: 'REASON_REQUIRED' }],
    );
  }
  return trimmed.slice(0, 512);
}

/**
 * Approve or reject the pending identity change. Approval writes the proposed
 * values to the live record and marks the company VERIFIED; rejection leaves
 * the record alone and requires a reason the carrier will see.
 */
export async function decideProfileChange(
  actor: AdminActor,
  partnerId: string,
  changeId: string,
  decision: 'APPROVED' | 'REJECTED',
  note: string | null,
): Promise<PartnerProfileReview> {
  const change = await prisma.logisticsPartnerProfileChange.findFirst({
    where: { id: changeId, logisticsPartnerId: partnerId },
    select: { id: true, state: true, proposedJson: true, currentJson: true },
  });

  if (change === null) throw notFound('Profile change');
  if (change.state !== 'PENDING') {
    throw conflict(ErrorCode.CONFLICT, 'This request has already been decided or withdrawn.');
  }

  const reason = decision === 'REJECTED' ? requireNote(note, 'note') : note?.trim() || null;
  const proposed = z.object(reverifiedShape).strict().parse(change.proposedJson);

  await prisma.$transaction(async (tx) => {
    const updated = await tx.logisticsPartnerProfileChange.updateMany({
      where: { id: change.id, state: 'PENDING' },
      data: {
        state: decision,
        pendingKey: null,
        decidedByUserId: actor.userId,
        decidedAt: new Date(),
        decisionNote: reason,
      },
    });
    if (updated.count !== 1) {
      throw conflict(ErrorCode.CONFLICT, 'This request has already been decided or withdrawn.');
    }

    if (decision === 'APPROVED') {
      const data: Record<string, unknown> = {
        verificationState: 'VERIFIED',
        verifiedAt: new Date(),
        verifiedByUserId: actor.userId,
      };
      if (proposed.legalName !== undefined) data['legalName'] = proposed.legalName;
      if (proposed.displayName !== undefined) {
        data['displayName'] = proposed.displayName;
        data['displayNameNormalized'] = normaliseLogisticsName(proposed.displayName);
      }
      if (proposed.registrationNumber !== undefined)
        data['registrationNumber'] = proposed.registrationNumber;
      if (proposed.taxNumber !== undefined) data['taxNumber'] = proposed.taxNumber;
      if (proposed.registrationCountry !== undefined)
        data['registrationCountry'] = proposed.registrationCountry;
      if (proposed.registeredAddress !== undefined)
        data['addressJson'] = proposed.registeredAddress ?? Prisma.DbNull;
      if (proposed.licenceNumber !== undefined) data['licenceNumber'] = proposed.licenceNumber;
      if (proposed.licenceExpiresAt !== undefined)
        data['licenceExpiresAt'] =
          proposed.licenceExpiresAt === null
            ? null
            : new Date(`${proposed.licenceExpiresAt}T00:00:00.000Z`);

      await tx.logisticsPartner.update({ where: { id: partnerId }, data });
    }

    await recordLogisticsAudit(
      {
        logisticsPartnerId: partnerId,
        actorUserId: actor.userId,
        actorLabel: OPERATOR_LABEL,
        action:
          decision === 'APPROVED'
            ? 'logistics.profile.change_approved'
            : 'logistics.profile.change_rejected',
        resourceType: 'logistics_partner_profile_change',
        resourceId: change.id,
        before: change.currentJson,
        after: decision === 'APPROVED' ? change.proposedJson : undefined,
        summary:
          decision === 'APPROVED'
            ? 'Your company details change was verified and applied.'
            : `Your company details change was not accepted: ${reason ?? ''}`,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'logistics_partner_profile_change',
    resourceId: change.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: change.currentJson,
    after: { decision, note: reason, proposed: change.proposedJson },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return readPartnerProfileForReview(partnerId);
}

/** Accept or refuse one compliance document. A refusal carries a reason. */
export async function decideComplianceDocument(
  actor: AdminActor,
  partnerId: string,
  documentId: string,
  decision: 'VERIFIED' | 'REJECTED',
  reason: string | null,
): Promise<PartnerProfileReview> {
  const document = await prisma.logisticsPartnerDocument.findFirst({
    where: { id: documentId, logisticsPartnerId: partnerId },
    select: { id: true, reviewState: true, originalFileName: true, scanState: true },
  });

  if (document === null) throw notFound('Document');
  if (
    decision === 'VERIFIED' &&
    (document.scanState === 'INFECTED' || document.scanState === 'FAILED')
  ) {
    throw conflict(ErrorCode.CONFLICT, 'A file that failed the security scan cannot be verified.');
  }

  const note = decision === 'REJECTED' ? requireNote(reason, 'reason') : null;

  await prisma.$transaction(async (tx) => {
    await tx.logisticsPartnerDocument.update({
      where: { id: document.id },
      data: {
        reviewState: decision,
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
        rejectionReason: note,
      },
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: partnerId,
        actorUserId: actor.userId,
        actorLabel: OPERATOR_LABEL,
        action:
          decision === 'VERIFIED'
            ? 'logistics.profile.document_verified'
            : 'logistics.profile.document_rejected',
        resourceType: 'logistics_partner_document',
        resourceId: document.id,
        before: { reviewState: document.reviewState },
        after: { reviewState: decision, reason: note },
        summary:
          decision === 'VERIFIED'
            ? `${document.originalFileName} was verified.`
            : `${document.originalFileName} was not accepted: ${note ?? ''}`,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'logistics_partner_document',
    resourceId: document.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { reviewState: document.reviewState },
    after: { reviewState: decision, reason: note },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return readPartnerProfileForReview(partnerId);
}

/** Record that staff have (or have not) checked the company's identity. */
export async function setPartnerVerification(
  actor: AdminActor,
  partnerId: string,
  state: LogisticsPartnerVerificationState,
  note: string | null,
): Promise<PartnerProfileReview> {
  const partner = await prisma.logisticsPartner.findFirst({
    where: { id: partnerId, archivedAt: null },
    select: { id: true, verificationState: true },
  });
  if (partner === null) throw notFound('Logistics partner');

  const reason = state === 'VERIFIED' ? note?.trim() || null : requireNote(note, 'note');

  await prisma.$transaction(async (tx) => {
    await tx.logisticsPartner.update({
      where: { id: partnerId },
      data: {
        verificationState: state,
        verifiedAt: state === 'VERIFIED' ? new Date() : null,
        verifiedByUserId: state === 'VERIFIED' ? actor.userId : null,
      },
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: partnerId,
        actorUserId: actor.userId,
        actorLabel: OPERATOR_LABEL,
        action: 'logistics.profile.verification_changed',
        resourceType: 'logistics_partner',
        resourceId: partnerId,
        before: { verificationState: partner.verificationState },
        after: { verificationState: state, note: reason },
        summary:
          state === 'VERIFIED'
            ? 'Your company identity was verified.'
            : `Your company verification status is now ${state}${reason === null ? '' : `: ${reason}`}.`,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'logistics_partner',
    resourceId: partnerId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { verificationState: partner.verificationState },
    after: { verificationState: state, note: reason },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return readPartnerProfileForReview(partnerId);
}

/** A single-use link for staff to one partner's document. */
export async function createAdminComplianceLink(
  actor: AdminActor,
  partnerId: string,
  documentId: string,
): Promise<ComplianceLink> {
  const document = await prisma.logisticsPartnerDocument.findFirst({
    where: { id: documentId, logisticsPartnerId: partnerId },
    select: { id: true, originalFileName: true, scanState: true },
  });
  if (document === null) throw notFound('Document');

  const link = await mintLink(
    'admin',
    actor.userId,
    document,
    (token) =>
      `/api/v1/admin/logistics/partners/${partnerId}/documents/${document.id}/download?token=${token}`,
  );

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'logistics_partner_document',
    resourceId: document.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { downloaded: true },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return link;
}

export async function redeemAdminComplianceLink(
  userId: string,
  partnerId: string,
  documentId: string,
  token: string,
): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  await consumeLink('admin', userId, documentId, token);

  const document = await prisma.logisticsPartnerDocument.findFirst({
    where: { id: documentId, logisticsPartnerId: partnerId },
    select: { storageKey: true, contentType: true, originalFileName: true, scanState: true },
  });
  if (document === null) throw notFound('Document');
  if (!isServable(document.scanState)) {
    throw conflict(ErrorCode.SELLER_DOCUMENT_REJECTED, 'This file cannot be downloaded.');
  }

  return {
    body: await storage.get(document.storageKey),
    contentType: document.contentType,
    fileName: document.originalFileName,
  };
}
