/**
 * Every call the portal makes, in one place.
 *
 * Thin wrappers over `api`, and they exist for two reasons rather than
 * ceremony:
 *
 *   1. **One spelling of every path.** A screen that wrote
 *      `/logistics/shipments/${id}` itself is a screen that can be pointed at
 *      the wrong id shape, and there is no partner id in any of these paths -
 *      the server resolves the company from the session. That absence is the
 *      tenant boundary, and it is easier to see when every path is on one
 *      screen.
 *   2. **Query keys beside their fetchers.** React Query invalidation goes
 *      wrong when a key is written twice; here each one is a function next to
 *      the call it belongs to.
 */
import { api } from './api';
import type {
  Dashboard,
  CompanyRow,
  DocumentRow,
  DriverAssignmentEntry,
  DriverRow,
  DriverTask,
  ExceptionRow,
  ExceptionSeverity,
  ExceptionState,
  LiveLocation,
  ManifestRow,
  MemberRow,
  MfaEnrolment,
  NotificationFeed,
  PartnerProfile,
  PickupRow,
  PortalSession,
  ProofOfDelivery,
  ShipmentDetail,
  ShipmentPage,
  ShipmentStatus,
  TimelineEntry,
  VehicleRow,
} from './types';

// ---------------------------------------------------------------------------
// Session and second factor
// ---------------------------------------------------------------------------

export const sessionKey = ['logistics', 'session'] as const;

export function fetchSession(): Promise<PortalSession> {
  return api.get<PortalSession>('/logistics/auth/me');
}

export function signIn(email: string, password: string): Promise<unknown> {
  return api.post('/logistics/auth/login', { email, password });
}

export function signOut(): Promise<unknown> {
  return api.post('/logistics/auth/logout');
}

export function activateAccount(input: {
  token: string;
  password: string;
  acceptedTerms: boolean;
}): Promise<{ activated: boolean; email: string }> {
  return api.post('/logistics/auth/invitations/accept', input);
}

export function beginMfaSetup(): Promise<MfaEnrolment> {
  return api.post<MfaEnrolment>('/logistics/auth/mfa/setup');
}

export function verifyMfa(
  code: string,
  mode: 'ENROL' | 'CHALLENGE',
): Promise<{ verified: boolean; usedRecoveryCode?: boolean; recoveryCodesRemaining?: number }> {
  return api.post('/logistics/auth/mfa/verify', { code, mode });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function dashboardKey(filters: Record<string, string | undefined>): readonly unknown[] {
  return ['logistics', 'dashboard', filters];
}

export function fetchDashboard(
  filters: Record<string, string | undefined> = {},
): Promise<Dashboard> {
  return api.get<Dashboard>('/logistics/dashboard', { query: filters });
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

export interface ShipmentQuery {
  search?: string;
  status?: ShipmentStatus[];
  slaState?: string[];
  destinationCountry?: string;
  sellerCompany?: string;
  receivingCompany?: string;
  driverProfileId?: string;
  hasException?: boolean;
  podState?: 'PRESENT' | 'MISSING';
  createdFrom?: string;
  createdTo?: string;
  deliveryFrom?: string;
  deliveryTo?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export function shipmentsKey(query: ShipmentQuery): readonly unknown[] {
  return ['logistics', 'shipments', query];
}

/**
 * Arrays go on the query string as repeated keys.
 *
 * `api`'s own `query` helper takes scalars, because that is what every other
 * screen in this repository needs. A status filter is genuinely a list, so it
 * is appended here rather than by widening the shared helper - which would
 * make every other caller's type looser for one caller's benefit.
 */
function toQueryString(query: ShipmentQuery): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;

    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, String(entry));
    } else {
      params.set(key, String(value));
    }
  }

  const text = params.toString();
  return text.length === 0 ? '' : `?${text}`;
}

export function fetchShipments(query: ShipmentQuery): Promise<ShipmentPage> {
  return api.get<ShipmentPage>(`/logistics/shipments${toQueryString(query)}`);
}

export function shipmentKey(id: string): readonly unknown[] {
  return ['logistics', 'shipment', id];
}

export function fetchShipment(id: string): Promise<ShipmentDetail> {
  return api.get<ShipmentDetail>(`/logistics/shipments/${id}`);
}

export function timelineKey(id: string): readonly unknown[] {
  return ['logistics', 'shipment', id, 'timeline'];
}

export function fetchTimeline(id: string): Promise<{ events: TimelineEntry[] }> {
  return api.get<{ events: TimelineEntry[] }>(`/logistics/shipments/${id}/timeline`);
}

export function acceptShipment(id: string): Promise<{ status: ShipmentStatus }> {
  return api.post(`/logistics/shipments/${id}/accept`);
}

export function rejectShipment(id: string, reason: string): Promise<{ status: ShipmentStatus }> {
  return api.post(`/logistics/shipments/${id}/reject`, { reason });
}

export interface StatusUpdate {
  status: ShipmentStatus;
  reason?: string;
  publicDescription?: string;
  internalNote?: string;
  occurredAt?: string;
  locationLabel?: string;
  revisedEtaAt?: string;
}

/**
 * Record a status event.
 *
 * The idempotency key is generated HERE, once per submission, and reused if
 * the request is retried. A dispatcher on a flaky connection who presses the
 * button twice writes one event; without a key every press is a distinct
 * event, which is also correct but is not what a double-click means.
 */
export function updateStatus(
  id: string,
  update: StatusUpdate,
  idempotencyKey: string,
): Promise<{ status: ShipmentStatus; duplicate: boolean }> {
  return api.post(`/logistics/shipments/${id}/status-events`, update, { idempotencyKey });
}

export function raiseException(
  id: string,
  input: {
    type: string;
    severity?: ExceptionSeverity;
    reason: string;
    detail?: string;
    revisedEtaAt?: string;
  },
): Promise<{ id: string }> {
  return api.post(`/logistics/shipments/${id}/exceptions`, input);
}

export function liveLocationKey(id: string): readonly unknown[] {
  return ['logistics', 'shipment', id, 'live-location'];
}

export function fetchLiveLocation(
  id: string,
): Promise<{ location: LiveLocation | null; staleAfterSeconds: number }> {
  return api.get(`/logistics/shipments/${id}/live-location`);
}

// ---------------------------------------------------------------------------
// Documents and proof
// ---------------------------------------------------------------------------

export function documentsKey(shipmentId: string): readonly unknown[] {
  return ['logistics', 'shipment', shipmentId, 'documents'];
}

export function fetchDocuments(shipmentId: string): Promise<{ documents: DocumentRow[] }> {
  return api.get(`/logistics/shipments/${shipmentId}/documents`);
}

export function uploadDocument(shipmentId: string, file: File, kind: string): Promise<DocumentRow> {
  const form = new FormData();
  form.append('kind', kind);
  form.append('file', file);

  return api.upload<DocumentRow>(`/logistics/shipments/${shipmentId}/documents`, form);
}

/**
 * A short-lived link to one file.
 *
 * A POST rather than a GET because it mints a credential and writes an audit
 * row. The URL that comes back is good for a few minutes and for one download.
 */
export function createDocumentLink(
  documentId: string,
): Promise<{ url: string; expiresAt: string; fileName: string; contentType: string }> {
  return api.post(`/logistics/documents/${documentId}/link`);
}

export function podKey(shipmentId: string): readonly unknown[] {
  return ['logistics', 'shipment', shipmentId, 'pod'];
}

export function fetchProofOfDelivery(
  shipmentId: string,
): Promise<{ proofOfDelivery: ProofOfDelivery | null }> {
  return api.get(`/logistics/shipments/${shipmentId}/proof-of-delivery`);
}

export interface PodInput {
  recipientName?: string;
  recipientDesignation?: string;
  deliveredAt?: string;
  latitude?: number;
  longitude?: number;
  locationLabel?: string;
  signatureDocumentId?: string;
  photoDocumentId?: string;
  businessStamped?: boolean;
  otp?: string;
  exceptionNote?: string;
}

export function captureProofOfDelivery(
  shipmentId: string,
  input: PodInput,
  idempotencyKey: string,
): Promise<{ podId: string; status: ShipmentStatus; duplicate: boolean }> {
  return api.post(`/logistics/shipments/${shipmentId}/proof-of-delivery`, input, {
    idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function pickupsKey(filters: Record<string, unknown>): readonly unknown[] {
  return ['logistics', 'pickups', filters];
}

export function fetchPickups(filters: {
  state?: string[];
  from?: string;
  to?: string;
}): Promise<{ pickups: PickupRow[] }> {
  const params = new URLSearchParams();
  for (const entry of filters.state ?? []) params.append('state', entry);
  if (filters.from !== undefined) params.set('from', filters.from);
  if (filters.to !== undefined) params.set('to', filters.to);

  const text = params.toString();
  return api.get(`/logistics/pickups${text.length === 0 ? '' : `?${text}`}`);
}

export function schedulePickup(input: {
  shipmentId: string;
  windowStartAt: string;
  windowEndAt: string;
  timezone?: string;
  driverProfileId?: string;
  vehicleId?: string;
  warehouseInstructions?: string;
}): Promise<{ pickupId: string; status: ShipmentStatus }> {
  return api.post('/logistics/pickups', input);
}

export function confirmPickupReady(pickupId: string): Promise<void> {
  return api.post(`/logistics/pickups/${pickupId}/confirm`);
}

export function completePickup(
  pickupId: string,
  packagesCollected: number | undefined,
  idempotencyKey: string,
): Promise<{ status: ShipmentStatus; duplicate: boolean }> {
  return api.post(
    `/logistics/pickups/${pickupId}/complete`,
    packagesCollected === undefined ? {} : { packagesCollected },
    { idempotencyKey },
  );
}

export function failPickup(pickupId: string, reason: string): Promise<void> {
  return api.post(`/logistics/pickups/${pickupId}/fail`, { reason });
}

export const manifestsKey = ['logistics', 'manifests'] as const;

export function fetchManifests(): Promise<{ manifests: ManifestRow[] }> {
  return api.get('/logistics/dispatch-manifests');
}

export function createManifest(input: {
  shipmentIds: string[];
  driverProfileId?: string;
  vehicleId?: string;
  originLabel?: string;
  destinationLabel?: string;
  plannedDepartureAt?: string;
  notes?: string;
}): Promise<{ manifestId: string; manifestNumber: string; dispatched: number }> {
  return api.post('/logistics/dispatch-manifests', input);
}

export function fetchManifest(id: string): Promise<{
  manifestNumber: string;
  state: string;
  driverName: string | null;
  vehicleRegistration: string | null;
  originLabel: string | null;
  destinationLabel: string | null;
  plannedDepartureAt: string | null;
  notes: string | null;
  lines: {
    shipmentReference: string;
    trackingNumber: string;
    receivingCompanyName: string;
    destinationCity: string | null;
    destinationCountry: string;
    packageCount: number;
    weightGrams: number;
    requiresColdChain: boolean;
    isDangerousGoods: boolean;
  }[];
}> {
  return api.get(`/logistics/dispatch-manifests/${id}`);
}

export function handOverManifest(id: string, signedBy: string): Promise<void> {
  return api.post(`/logistics/dispatch-manifests/${id}/handover`, { signedBy });
}

export function exceptionsKey(filters: Record<string, unknown>): readonly unknown[] {
  return ['logistics', 'exceptions', filters];
}

export function fetchExceptions(filters: {
  openOnly?: boolean;
  severity?: ExceptionSeverity[];
  page?: number;
}): Promise<{ rows: ExceptionRow[]; total: number; page: number; pageCount: number }> {
  const params = new URLSearchParams();
  if (filters.openOnly !== undefined) params.set('openOnly', String(filters.openOnly));
  for (const entry of filters.severity ?? []) params.append('severity', entry);
  if (filters.page !== undefined) params.set('page', String(filters.page));

  const text = params.toString();
  return api.get(`/logistics/exceptions${text.length === 0 ? '' : `?${text}`}`);
}

export function updateException(
  id: string,
  changes: {
    state?: ExceptionState;
    severity?: ExceptionSeverity;
    resolutionNotes?: string;
    revisedEtaAt?: string | null;
    escalationNote?: string;
    customerNotified?: boolean;
  },
): Promise<ExceptionRow> {
  return api.patch(`/logistics/exceptions/${id}`, changes);
}

// ---------------------------------------------------------------------------
// Companies, drivers and the fleet
// ---------------------------------------------------------------------------

export function companiesKey(type: 'SELLER' | 'RECEIVER'): readonly unknown[] {
  return ['logistics', 'companies', type];
}

export function fetchCompanies(type: 'SELLER' | 'RECEIVER'): Promise<{ companies: CompanyRow[] }> {
  return api.get('/logistics/companies', { query: { type } });
}

export const driversKey = ['logistics', 'drivers'] as const;

export function fetchDrivers(): Promise<{ drivers: DriverRow[] }> {
  return api.get('/logistics/drivers');
}

/**
 * The details of one driver, as the form collects them.
 *
 * `fullName` is typed, not picked. A carrier employs people who will never
 * open this software, and a fleet register that could only hold people with a
 * login is a register that does not describe the fleet.
 */
export interface DriverDetailsInput {
  fullName?: string;
  phone?: string | null;
  email?: string | null;
  employeeReference?: string | null;
  licenceNumber?: string | null;
  licenceExpiresAt?: string | null;
  canCarryDangerousGoods?: boolean;
  canCarryColdChain?: boolean;
  canCarrySterile?: boolean;
  state?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  /** Links a colleague’s account, which is what turns the phone app on. */
  partnerUserId?: string | null;
}

/** Add somebody to the fleet. A name is all that is required. */
export function createDriver(input: DriverDetailsInput): Promise<DriverRow> {
  return api.post('/logistics/drivers', input);
}

/**
 * Change a driver’s details, or take them off the rota.
 *
 * A patch, keyed on the driver RECORD rather than on an account, because most
 * drivers have no account to key on. Only what is sent is written, so
 * correcting a licence number cannot silently clear the certifications beside
 * it.
 */
export function updateDriver(
  driverProfileId: string,
  input: DriverDetailsInput,
): Promise<DriverRow> {
  return api.patch(`/logistics/drivers/${driverProfileId}`, input);
}

export const vehiclesKey = ['logistics', 'vehicles'] as const;

export function fetchVehicles(): Promise<{ vehicles: VehicleRow[] }> {
  return api.get('/logistics/vehicles');
}

export function createVehicle(input: {
  registration: string;
  kind: string;
  hasRefrigeration?: boolean;
  hasTailLift?: boolean;
  temperatureMinC?: number;
  temperatureMaxC?: number;
  maxWeightGrams?: number;
}): Promise<VehicleRow> {
  return api.post('/logistics/vehicles', input);
}

/**
 * Put a driver on a consignment, or move it from one to another.
 *
 * One call for both, because from a dispatcher's point of view it is one
 * action - "this parcel is Anja's now". The server decides which it was: a
 * first assignment needs no reason, a move requires one, and pressing it twice
 * on the same driver changes nothing.
 */
export function assignDriver(
  shipmentId: string,
  input: {
    driverProfileId: string;
    vehicleId?: string;
    isPickupLeg?: boolean;
    isDeliveryLeg?: boolean;
    /** Required when somebody is being taken off. */
    reason?: string;
  },
): Promise<{ assignmentId: string; replacedAssignmentId: string | null }> {
  return api.post(`/logistics/shipments/${shipmentId}/assign-driver`, input);
}

/** Take the driver off without putting another one on. */
export function unassignDriver(
  shipmentId: string,
  reason: string,
): Promise<{ unassignedAssignmentId: string | null }> {
  return api.post(`/logistics/shipments/${shipmentId}/unassign-driver`, { reason });
}

export const driverHistoryKey = (shipmentId: string): readonly unknown[] => [
  'logistics',
  'shipment',
  shipmentId,
  'driver-history',
];

/** Everyone who has held this consignment, oldest first. */
export function fetchDriverHistory(
  shipmentId: string,
): Promise<{ assignments: DriverAssignmentEntry[] }> {
  return api.get(`/logistics/shipments/${shipmentId}/driver-history`);
}

// ---------------------------------------------------------------------------
// The driver's own day
// ---------------------------------------------------------------------------

export const driverTasksKey = ['logistics', 'driver', 'tasks'] as const;

export function fetchDriverTasks(): Promise<{ tasks: DriverTask[] }> {
  return api.get('/logistics/driver/tasks');
}

export function setLocationConsent(granted: boolean): Promise<void> {
  return api.post('/logistics/driver/location-consent', { granted });
}

export function startTrip(input: { shipmentId?: string; vehicleId?: string }): Promise<{
  tripId: string;
  deviceToken: string;
  expiresAt: string;
  pingIntervalSeconds: number;
}> {
  return api.post('/logistics/driver/trips', input);
}

export function endTrip(
  tripId: string,
  state: 'COMPLETED' | 'PAUSED' = 'COMPLETED',
): Promise<void> {
  return api.post(`/logistics/driver/trips/${tripId}/end`, { state });
}

export function lookupPackage(
  reference: string,
): Promise<{ shipmentId: string; shipmentReference: string; packageId: string; sequence: number }> {
  return api.get('/logistics/packages/lookup', { query: { reference } });
}

export function scanPackage(packageId: string, direction: 'OUT' | 'IN'): Promise<void> {
  return api.post(`/logistics/packages/${packageId}/scan`, { direction });
}

// ---------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------

export const organisationKey = ['logistics', 'organisation'] as const;

export function fetchOrganisation(): Promise<PartnerProfile> {
  return api.get('/logistics/organisation');
}

export function updateOrganisation(changes: {
  contactEmail?: string;
  contactPhone?: string | null;
  emergencyPhone?: string | null;
  websiteUrl?: string | null;
}): Promise<PartnerProfile> {
  return api.patch('/logistics/organisation', changes);
}

export const membersKey = ['logistics', 'members'] as const;

export function fetchMembers(): Promise<{ members: MemberRow[] }> {
  return api.get('/logistics/members');
}

export function updateMember(
  id: string,
  changes: { role?: string; status?: string; jobTitle?: string | null; disabledReason?: string },
): Promise<MemberRow> {
  return api.patch(`/logistics/members/${id}`, changes);
}

export const notificationsKey = ['logistics', 'notifications'] as const;

/**
 * A carrier's feed.
 *
 * `active` is the bell - live problems and everything that happened lately.
 * `resolved` is the record of what was dealt with, kept rather than deleted so
 * a dispatcher can answer "what happened to that one?" weeks later.
 */
export function fetchNotifications(view: 'active' | 'resolved' = 'active'): Promise<NotificationFeed> {
  return api.get('/logistics/notifications', { query: { view } });
}

export function markNotificationsRead(ids?: string[]): Promise<{ marked: number }> {
  return api.post('/logistics/notifications/read', ids === undefined ? {} : { ids });
}
