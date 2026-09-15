/**
 * The marketplace's own view of third-party carriers.
 *
 * This is the OPERATOR's side. A carrier's staff use a separate application
 * entirely (`apps/logistics-web`), signed in against a separate cookie jar and
 * a separate permission catalogue; nothing here is reachable by them and
 * nothing there is reachable from here. Two rules follow from that and run
 * through every type below:
 *
 *   - **This side sees everything, and says so.** A recipient's telephone
 *     number arrives here unmasked, because the marketplace is the party that
 *     holds the customer relationship and answers the telephone when a
 *     delivery goes wrong. The carrier's own screen masks the same field.
 *   - **A credential is never read back.** An integration's stored key comes
 *     back as a hint - a few characters of the encrypted envelope - and a
 *     webhook signing secret comes back exactly once, in the response to
 *     rotating it, and never again. There is no endpoint that returns either
 *     in full, and adding one would undo the reason they are encrypted at
 *     rest.
 *
 * Money is a string in minor units here as everywhere else in this console.
 */
import { api } from './api';

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

export type LogisticsPartnerStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

export type LogisticsContractStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'TERMINATED' | 'SUSPENDED';

export type ShipmentStatus =
  | 'CREATED'
  | 'AWAITING_ASSIGNMENT'
  | 'ASSIGNED'
  | 'ACCEPTANCE_PENDING'
  | 'ACCEPTED'
  | 'PICKUP_SCHEDULED'
  | 'READY_FOR_PICKUP'
  | 'PICKED_UP'
  | 'DISPATCHED'
  | 'AT_ORIGIN_HUB'
  | 'IN_TRANSIT'
  | 'AT_DESTINATION_HUB'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERY_ATTEMPTED'
  | 'DELIVERED'
  | 'DELAYED'
  | 'ON_HOLD'
  | 'ADDRESS_ISSUE'
  | 'CUSTOMS_HOLD'
  | 'DAMAGED'
  | 'TEMPERATURE_EXCEPTION'
  | 'DELIVERY_FAILED'
  | 'RETURN_REQUESTED'
  | 'RETURN_IN_TRANSIT'
  | 'RETURNED'
  | 'LOST'
  | 'CANCELLED';

export type SlaState = 'NOT_APPLICABLE' | 'ON_TRACK' | 'AT_RISK' | 'BREACHED';

export type ExceptionSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type CarrierProvider = 'MANUAL' | 'CUSTOM' | 'DHL' | 'FEDEX' | 'UPS';

export type CapabilityKind =
  | 'TEMPERATURE_CONTROLLED'
  | 'COLD_CHAIN_2_8'
  | 'FROZEN'
  | 'STERILE_HANDLING'
  | 'DANGEROUS_GOODS'
  | 'FRAGILE_HANDLING'
  | 'OVERSIZED'
  | 'PALLET'
  | 'TAIL_LIFT'
  | 'WHITE_GLOVE'
  | 'SAME_DAY'
  | 'NEXT_DAY'
  | 'INTERNATIONAL'
  | 'CUSTOMS_BROKERAGE'
  | 'PROOF_OF_DELIVERY_PHOTO'
  | 'PROOF_OF_DELIVERY_OTP';

export type CapabilityState = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export type LogisticsServiceType =
  'STANDARD' | 'EXPRESS' | 'SAME_DAY' | 'ECONOMY' | 'FREIGHT' | 'WHITE_GLOVE';

export type LogisticsRole =
  | 'LOGISTICS_PARTNER_OWNER'
  | 'LOGISTICS_PARTNER_ADMIN'
  | 'DISPATCHER'
  | 'DRIVER'
  | 'OPERATIONS_AGENT'
  | 'READ_ONLY_TRACKING_USER';

// ---------------------------------------------------------------------------
// Carriers
// ---------------------------------------------------------------------------

export interface PartnerRow {
  id: string;
  partnerCode: string;
  displayName: string;
  legalName: string;
  registrationCountry: string;
  status: LogisticsPartnerStatus;
  contractStatus: LogisticsContractStatus;
  contractEndsAt: string | null;
  contactEmail: string;
  maxOpenShipments: number | null;
  createdAt: string;
  memberCount: number;
  regionCount: number;
  /** Consignments still moving with this carrier, counted server-side. */
  openShipments: number;
}

export function fetchPartners(params: URLSearchParams): Promise<{ partners: PartnerRow[] }> {
  return api.get<{ partners: PartnerRow[] }>(`/admin/logistics/partners?${params.toString()}`);
}

export interface PartnerRegion {
  id: string;
  scope: 'COUNTRY' | 'STATE' | 'CITY' | 'POSTCODE_PREFIX';
  countryCode: string;
  regionValue: string | null;
  supportsPickup: boolean;
  supportsDelivery: boolean;
  isActive: boolean;
}

export interface PartnerCapability {
  id: string;
  kind: CapabilityKind;
  state: CapabilityState;
  evidenceReference: string | null;
  evidenceExpiresAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface PartnerSlaPolicy {
  id: string;
  name: string;
  serviceType: LogisticsServiceType;
  pickupHours: number | null;
  deliveryHours: number | null;
  riskWindowMinutes: number;
  maxDeliveryAttempts: number;
  podRequiresRecipientName: boolean;
  podRequiresSignature: boolean;
  podRequiresPhoto: boolean;
  podRequiresOtp: boolean;
  podRequiresDesignation: boolean;
  isDefault: boolean;
  isActive: boolean;
}

export interface PartnerMember {
  id: string;
  fullName: string;
  role: LogisticsRole;
  status: string;
  jobTitle: string | null;
  lastActiveAt: string | null;
  user: { email: string; mfaEnabledAt: string | null };
}

export interface PartnerDetail {
  id: string;
  partnerCode: string;
  legalName: string;
  displayName: string;
  registrationNumber: string | null;
  taxNumber: string | null;
  licenceNumber: string | null;
  licenceExpiresAt: string | null;
  registrationCountry: string;
  contactEmail: string;
  contactPhone: string | null;
  emergencyPhone: string | null;
  websiteUrl: string | null;
  addressJson: unknown;
  status: LogisticsPartnerStatus;
  contractStatus: LogisticsContractStatus;
  contractReference: string | null;
  contractStartsAt: string | null;
  contractEndsAt: string | null;
  suspensionReason: string | null;
  suspendedAt: string | null;
  maxOpenShipments: number | null;
  maxDailyAssignments: number | null;
  autoAssignEnabled: boolean;
  /**
   * The operator's own assessment of this carrier. It routinely names people
   * and it never leaves this console - the carrier's own profile endpoint does
   * not select the column at all.
   */
  internalNotes: string | null;
  createdAt: string;
  carrierIntegration: {
    id: string;
    name: string;
    provider: CarrierProvider;
    state: string;
  } | null;
  regions: PartnerRegion[];
  capabilities: PartnerCapability[];
  slaPolicies: PartnerSlaPolicy[];
  users: PartnerMember[];
}

export function fetchPartner(id: string): Promise<PartnerDetail> {
  return api.get<PartnerDetail>(`/admin/logistics/partners/${id}`);
}

export interface CreatePartnerBody {
  legalName: string;
  displayName: string;
  registrationCountry: string;
  contactEmail: string;
  contactPhone?: string;
  websiteUrl?: string;
  registrationNumber?: string;
  contractReference?: string;
  maxOpenShipments?: number;
  internalNotes?: string;
  ownerEmail: string;
  ownerFullName: string;
}

/**
 * Create a carrier and invite its first owner.
 *
 * The activation link is emailed and is NOT in the response - see the note on
 * the route. What comes back is enough to tell the operator who was written to
 * and how long they have.
 */
export function createPartner(body: CreatePartnerBody): Promise<{
  id: string;
  partnerCode: string;
  displayName: string;
  invitedOwner: string;
  invitationExpiresAt: string;
}> {
  return api.post('/admin/logistics/partners', body);
}

export function setPartnerStatus(
  id: string,
  body: { status: LogisticsPartnerStatus; reason?: string; handoverShipments?: boolean },
): Promise<{ withdrawn: number }> {
  return api.post(`/admin/logistics/partners/${id}/status`, body);
}

export function setPartnerRegions(
  id: string,
  regions: {
    scope: PartnerRegion['scope'];
    countryCode: string;
    regionValue?: string;
    supportsPickup?: boolean;
    supportsDelivery?: boolean;
  }[],
): Promise<{ count: number }> {
  return api.put(`/admin/logistics/partners/${id}/regions`, { regions });
}

export function decideCapability(
  id: string,
  body: {
    kind: CapabilityKind;
    state: CapabilityState;
    evidenceReference?: string;
    evidenceExpiresAt?: string;
    note?: string;
  },
): Promise<never> {
  return api.post(`/admin/logistics/partners/${id}/capabilities`, body);
}

export function saveSlaPolicy(
  id: string,
  body: {
    id?: string;
    name: string;
    serviceType: LogisticsServiceType;
    pickupHours?: number | null;
    deliveryHours?: number | null;
    riskWindowMinutes?: number;
    maxDeliveryAttempts?: number;
    podRequiresRecipientName?: boolean;
    podRequiresSignature?: boolean;
    podRequiresPhoto?: boolean;
    podRequiresOtp?: boolean;
    podRequiresDesignation?: boolean;
    isDefault?: boolean;
    isActive?: boolean;
  },
): Promise<{ id: string }> {
  return api.put(`/admin/logistics/partners/${id}/sla-policies`, body);
}

export function invitePartnerUser(
  id: string,
  body: { email: string; fullName: string; role: LogisticsRole },
): Promise<{ email: string; expiresAt: string }> {
  return api.post(`/admin/logistics/partners/${id}/invitations`, body);
}

// ---------------------------------------------------------------------------
// Consignments
// ---------------------------------------------------------------------------

export interface AdminShipmentRow {
  id: string;
  shipmentReference: string;
  trackingNumber: string;
  status: ShipmentStatus;
  slaState: SlaState;
  sellerCompanyName: string;
  receivingCompanyName: string;
  destinationCity: string | null;
  destinationCountry: string;
  packageCount: number;
  expectedPickupAt: string | null;
  estimatedDeliveryAt: string | null;
  createdAt: string;
  assignedPartner: { id: string; displayName: string } | null;
  order: { id: string; orderNumber: string } | null;
}

export interface AdminShipmentPage {
  shipments: AdminShipmentRow[];
  total: number;
  page: number;
  pageCount: number;
}

export function fetchAdminShipments(params: URLSearchParams): Promise<AdminShipmentPage> {
  return api.get<AdminShipmentPage>(`/admin/logistics/shipments?${params.toString()}`);
}

/**
 * Where an event came from.
 *
 * These are the backend's own `LogisticsEventSource` members, spelled exactly
 * as they arrive. The carrier's own portal shows the same six under its own
 * labels; both read the same column.
 */
export type ShipmentEventSource =
  | 'LOGISTICS_PORTAL'
  | 'DRIVER_APP'
  | 'UBOSS_ADMIN'
  | 'CARRIER_API'
  | 'INBOUND_WEBHOOK'
  | 'SYSTEM_AUTOMATION';

export interface ShipmentTimelineEvent {
  id: string;
  previousStatus: ShipmentStatus | null;
  status: ShipmentStatus;
  publicDescription: string | null;
  internalNote: string | null;
  occurredAt: string;
  recordedAt: string;
  locationLabel: string | null;
  locationCountry: string | null;
  source: ShipmentEventSource;
  /** The carrier's own code, kept beside the status it was mapped to. */
  externalStatusCode: string | null;
  isCorrection: boolean;
  reason: string | null;
}

export interface AdminShipmentDetail {
  id: string;
  shipmentReference: string;
  trackingNumber: string;
  status: ShipmentStatus;
  serviceType: LogisticsServiceType;
  slaState: SlaState;
  sellerCompanyName: string;
  receivingCompanyName: string;
  pickupAddressJson: unknown;
  deliveryAddressJson: unknown;
  pickupContactName: string | null;
  pickupContactPhone: string | null;
  pickupContactEmail: string | null;
  deliveryContactName: string | null;
  deliveryContactPhone: string | null;
  deliveryContactEmail: string | null;
  originCountry: string;
  destinationCountry: string;
  destinationCity: string | null;
  destinationPostalCode: string | null;
  packageCount: number;
  totalWeightGrams: number;
  productCategorySummary: string | null;
  requiresColdChain: boolean;
  requiresTemperatureRange: boolean;
  temperatureMinC: string | null;
  temperatureMaxC: string | null;
  requiresSterileHandling: boolean;
  isFragile: boolean;
  isDangerousGoods: boolean;
  dangerousGoodsClass: string | null;
  handlingNotes: string | null;
  /** Minor units as a string, with its own currency. Never a JS number. */
  declaredValueMinor: string | null;
  currency: string | null;
  expectedPickupAt: string | null;
  pickupDueAt: string | null;
  estimatedDeliveryAt: string | null;
  deliveryDueAt: string | null;
  acceptedAt: string | null;
  pickedUpAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  deliveryAttemptCount: number;
  lastEventAt: string | null;
  lastCarrierSyncAt: string | null;
  carrierTrackingNumber: string | null;
  carrierTrackingUrl: string | null;
  createdAt: string;
  order: { id: string; orderNumber: string } | null;
  assignedPartner: { id: string; displayName: string; partnerCode: string } | null;
  carrierIntegration: { id: string; name: string; provider: CarrierProvider; state: string } | null;
  assignments: {
    id: string;
    state: 'OFFERED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED' | 'COMPLETED';
    assignedAutomatically: boolean;
    offeredAt: string;
    respondBy: string | null;
    respondedAt: string | null;
    responseReason: string | null;
    withdrawnAt: string | null;
    withdrawnReason: string | null;
    completedAt: string | null;
    partner: { id: string; displayName: string };
  }[];
  exceptions: {
    id: string;
    type: string;
    severity: ExceptionSeverity;
    state: string;
    reason: string | null;
    resolutionDueAt: string | null;
    revisedEtaAt: string | null;
    resolvedAt: string | null;
    createdAt: string;
  }[];
  events: ShipmentTimelineEvent[];
  allowedTransitions: {
    to: ShipmentStatus;
    requiresReason: boolean;
    requiresProofOfDelivery: boolean;
    permission: string | null;
  }[];
}

export function fetchAdminShipment(id: string): Promise<AdminShipmentDetail> {
  return api.get<AdminShipmentDetail>(`/admin/logistics/shipments/${id}`);
}

export interface EligiblePartner {
  id: string;
  displayName: string;
  partnerCode: string;
  status: LogisticsPartnerStatus;
  openShipments: number;
  maxOpenShipments: number | null;
  onTimePercentage: number | null;
  /** Why this carrier is or is not offerable. Shown verbatim. */
  reasons: string[];
  isEligible: boolean;
}

export function fetchEligiblePartners(
  shipmentId: string,
): Promise<{ partners: EligiblePartner[] }> {
  return api.get(`/admin/logistics/shipments/${shipmentId}/eligible-partners`);
}

export function assignShipment(
  shipmentId: string,
  body: { logisticsPartnerId: string; respondByHours?: number },
): Promise<{ assignmentId: string; respondBy: string | null }> {
  return api.post(`/admin/logistics/shipments/${shipmentId}/assign`, body);
}

export function withdrawShipment(shipmentId: string, reason: string): Promise<never> {
  return api.post(`/admin/logistics/shipments/${shipmentId}/withdraw`, { reason });
}

/**
 * Put a status right.
 *
 * The only door out of DELIVERED, RETURNED, LOST or CANCELLED in the wrong
 * direction, and the reason is mandatory and at least eight characters because
 * it is written into the timeline as a correction and read months later by
 * somebody asking why a parcel appeared to go backwards.
 */
export function correctShipmentStatus(
  shipmentId: string,
  body: { status: ShipmentStatus; reason: string },
): Promise<{ eventId: string }> {
  return api.post(`/admin/logistics/shipments/${shipmentId}/correct-status`, body);
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export interface AdminExceptionRow {
  id: string;
  shipmentId: string;
  type: string;
  severity: ExceptionSeverity;
  state: string;
  reason: string | null;
  resolutionDueAt: string | null;
  revisedEtaAt: string | null;
  createdAt: string;
  shipment: { shipmentReference: string; receivingCompanyName: string };
  partner: { id: string; displayName: string } | null;
}

export function fetchAdminExceptions(params: URLSearchParams): Promise<{
  exceptions: AdminExceptionRow[];
  total: number;
  page: number;
  pageCount: number;
}> {
  return api.get(`/admin/logistics/exceptions?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Carrier connections
// ---------------------------------------------------------------------------

export type IntegrationState = 'UNCONFIGURED' | 'ACTIVE' | 'DEGRADED' | 'DISABLED';

export interface CarrierIntegrationRow {
  id: string;
  provider: CarrierProvider;
  name: string;
  state: IntegrationState;
  baseUrl: string | null;
  /**
   * A few characters of the stored credential ENVELOPE, never of the secret
   * itself. Enough to tell two saved keys apart, useless to anybody who copies
   * it.
   */
  credentialHint: string | null;
  hasWebhookSecret: boolean;
  /** Where the carrier posts. Public by design; the signature is the guard. */
  webhookUrl: string;
  pollingEnabled: boolean;
  pollingIntervalMinutes: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  consecutiveFailures: number;
  deadLetteredEvents: number;
  isActive: boolean;
}

export interface ProviderRequirement {
  provider: CarrierProvider;
  /** MANUAL only. Everything else needs credentials before it can be used. */
  worksOutOfTheBox: boolean;
  /** The environment variables this build reads for that provider. */
  requires: string[];
}

export function fetchIntegrations(): Promise<{
  integrations: CarrierIntegrationRow[];
  providers: ProviderRequirement[];
}> {
  return api.get('/admin/logistics/integrations');
}

export function saveIntegration(body: {
  id?: string;
  provider: CarrierProvider;
  name: string;
  baseUrl?: string;
  credentials?: Record<string, string>;
  pollingEnabled?: boolean;
  pollingIntervalMinutes?: number;
  webhookToleranceSeconds?: number;
  isActive?: boolean;
}): Promise<{ id: string; state: string }> {
  return api.put('/admin/logistics/integrations', body);
}

export function testIntegration(id: string): Promise<{ ok: boolean; message: string }> {
  return api.post(`/admin/logistics/integrations/${id}/test`);
}

/**
 * Mint a new webhook signing secret.
 *
 * The secret is in THIS response and in no other, ever. Nothing caches it and
 * there is no endpoint that reads it back, which is why the dialog that shows
 * it says so in as many words.
 */
export function rotateWebhookSecret(id: string): Promise<{
  secret: string;
  webhookUrl: string;
  notice: string;
}> {
  return api.post(`/admin/logistics/integrations/${id}/rotate-secret`);
}

export function saveStatusMapping(
  id: string,
  body: {
    providerCode: string;
    canonicalStatus: ShipmentStatus | null;
    raisesExceptionType?: string | null;
    publicDescription?: string;
    note?: string;
  },
): Promise<never> {
  return api.put(`/admin/logistics/integrations/${id}/status-mappings`, body);
}

export function fetchKnownCodes(provider: CarrierProvider): Promise<{
  codes: { code: string; status: ShipmentStatus | null; description: string }[];
}> {
  return api.get(`/admin/logistics/integrations/known-codes?provider=${provider}`);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export type Tone =
  'neutral' | 'brand' | 'accent' | 'action' | 'operational' | 'success' | 'warning' | 'danger';

/**
 * A status's tone.
 *
 * Colour is never the only signal: every one of these is rendered inside a
 * `Badge`, which always carries the status in words. The tone is there to let
 * a reader scan a hundred rows, not to be the information.
 */
export function shipmentStatusTone(status: ShipmentStatus): Tone {
  switch (status) {
    case 'DELIVERED':
      return 'success';
    case 'DAMAGED':
    case 'TEMPERATURE_EXCEPTION':
    case 'DELIVERY_FAILED':
    case 'LOST':
      return 'danger';
    case 'DELIVERY_ATTEMPTED':
    case 'DELAYED':
    case 'ON_HOLD':
    case 'ADDRESS_ISSUE':
    case 'CUSTOMS_HOLD':
    case 'RETURN_REQUESTED':
    case 'RETURN_IN_TRANSIT':
      return 'warning';
    case 'PICKED_UP':
    case 'DISPATCHED':
    case 'AT_ORIGIN_HUB':
    case 'IN_TRANSIT':
    case 'AT_DESTINATION_HUB':
      return 'brand';
    case 'OUT_FOR_DELIVERY':
      return 'operational';
    case 'ASSIGNED':
    case 'ACCEPTED':
    case 'PICKUP_SCHEDULED':
    case 'READY_FOR_PICKUP':
      return 'accent';
    case 'ACCEPTANCE_PENDING':
      return 'action';
    default:
      return 'neutral';
  }
}

export function slaTone(state: SlaState): Tone {
  switch (state) {
    case 'ON_TRACK':
      return 'success';
    case 'AT_RISK':
      return 'warning';
    case 'BREACHED':
      return 'danger';
    case 'NOT_APPLICABLE':
      return 'neutral';
  }
}

export function severityTone(severity: ExceptionSeverity): Tone {
  switch (severity) {
    case 'CRITICAL':
      return 'danger';
    case 'HIGH':
      return 'warning';
    case 'MEDIUM':
      return 'accent';
    case 'LOW':
      return 'neutral';
  }
}

export function partnerStatusTone(status: LogisticsPartnerStatus): Tone {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'PENDING_ACTIVATION':
      return 'warning';
    case 'SUSPENDED':
      return 'danger';
    case 'DEACTIVATED':
      return 'neutral';
  }
}

export function integrationStateTone(state: IntegrationState): Tone {
  switch (state) {
    case 'ACTIVE':
      return 'success';
    case 'DEGRADED':
      return 'warning';
    case 'UNCONFIGURED':
      return 'accent';
    case 'DISABLED':
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// Message keys
// ---------------------------------------------------------------------------

/*
 * Each of these returns a TEMPLATE LITERAL type rather than a widened string,
 * so the key it builds is checked against the catalogue exactly as a literal
 * would be. A status added to the backend without a matching label is then a
 * compile error here, rather than a raw SCREAMING_SNAKE string in front of an
 * operator.
 */

export type ShipmentStatusKey = `logistics.shipmentStatus.${ShipmentStatus}`;

export function statusLabelKey(status: ShipmentStatus): ShipmentStatusKey {
  return `logistics.shipmentStatus.${status}`;
}

export type SlaKey = `logistics.sla.${SlaState}`;

export function slaKey(state: SlaState): SlaKey {
  return `logistics.sla.${state}`;
}

export type SeverityKey = `logistics.severity.${ExceptionSeverity}`;

export function severityKey(severity: ExceptionSeverity): SeverityKey {
  return `logistics.severity.${severity}`;
}

export type PartnerStatusKey = `logistics.partnerStatus.${LogisticsPartnerStatus}`;

export function statusKey(status: LogisticsPartnerStatus): PartnerStatusKey {
  return `logistics.partnerStatus.${status}`;
}

export type ContractKey = `logistics.contractStatus.${LogisticsContractStatus}`;

export function contractKey(status: LogisticsContractStatus): ContractKey {
  return `logistics.contractStatus.${status}`;
}

export type CapabilityKey = `logistics.capabilityState.${CapabilityState}`;

export function capabilityKey(state: CapabilityState): CapabilityKey {
  return `logistics.capabilityState.${state}`;
}

export type ScopeKey = `logistics.regionScope.${PartnerRegion['scope']}`;

export function scopeKey(scope: PartnerRegion['scope']): ScopeKey {
  return `logistics.regionScope.${scope}`;
}

export type RoleKey = `logistics.role.${LogisticsRole}`;

export function roleKey(role: LogisticsRole): RoleKey {
  return `logistics.role.${role}`;
}

export type EventSourceKey = `logistics.eventSource.${ShipmentEventSource}`;

export function sourceKey(source: ShipmentEventSource): EventSourceKey {
  return `logistics.eventSource.${source}`;
}

export type IntegrationStateKey = `logistics.integrationState.${IntegrationState}`;

export function integrationStateKey(state: IntegrationState): IntegrationStateKey {
  return `logistics.integrationState.${state}`;
}
