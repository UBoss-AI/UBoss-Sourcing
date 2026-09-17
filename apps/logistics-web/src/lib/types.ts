/**
 * The shapes the API sends.
 *
 * Written by hand rather than generated, and kept deliberately narrow: what is
 * declared here is what the portal actually reads. A type that named every
 * column the backend has would invite a screen to render one the backend does
 * not send to a carrier.
 *
 * Every money figure crosses the wire as a STRING, because it is BigInt minor
 * units on the server and a JSON number would round it. Nothing here parses one
 * into a number.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Every status a consignment can hold, in the order a parcel walks them.
 *
 * Mirrors `ShipmentStatusValues` in the backend's
 * `domain/logistics-shipment-state.ts`. The ORDER matters: it is the order the
 * status filter renders in, which is the reading order rather than
 * alphabetical.
 */
export const SHIPMENT_STATUSES = [
  'CREATED',
  'AWAITING_ASSIGNMENT',
  'ASSIGNED',
  'ACCEPTANCE_PENDING',
  'ACCEPTED',
  'PICKUP_SCHEDULED',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'DISPATCHED',
  'AT_ORIGIN_HUB',
  'IN_TRANSIT',
  'AT_DESTINATION_HUB',
  'OUT_FOR_DELIVERY',
  'DELIVERY_ATTEMPTED',
  'DELIVERED',
  'DELAYED',
  'ON_HOLD',
  'ADDRESS_ISSUE',
  'CUSTOMS_HOLD',
  'DAMAGED',
  'TEMPERATURE_EXCEPTION',
  'DELIVERY_FAILED',
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
  'RETURNED',
  'LOST',
  'CANCELLED',
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export type SlaState = 'NOT_APPLICABLE' | 'ON_TRACK' | 'AT_RISK' | 'BREACHED';

export type ServiceType =
  'STANDARD' | 'EXPRESS' | 'SAME_DAY' | 'ECONOMY' | 'FREIGHT' | 'WHITE_GLOVE';

export type LogisticsRole =
  | 'LOGISTICS_PARTNER_OWNER'
  | 'LOGISTICS_PARTNER_ADMIN'
  | 'DISPATCHER'
  | 'DRIVER'
  | 'OPERATIONS_AGENT'
  | 'READ_ONLY_TRACKING_USER';

export type EventSource =
  | 'LOGISTICS_PORTAL'
  | 'DRIVER_APP'
  | 'UBOSS_ADMIN'
  | 'CARRIER_API'
  | 'INBOUND_WEBHOOK'
  | 'SYSTEM_AUTOMATION';

export type ExceptionSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ExceptionState =
  'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'ESCALATED' | 'RESOLVED' | 'CLOSED';

export type PickupState =
  'REQUESTED' | 'SCHEDULED' | 'CONFIRMED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type ManifestState = 'OPEN' | 'CLOSED' | 'HANDED_OVER' | 'CANCELLED';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface MfaState {
  /** Whether this ROLE must pass a challenge. A policy, not a preference. */
  required: boolean;
  enrolled: boolean;
  /** Whether THIS session has passed it. */
  sessionVerified: boolean;
  recoveryCodesRemaining: number;
}

export interface PortalSession {
  user: {
    id: string;
    email: string;
    fullName: string;
    role: LogisticsRole;
    /** The exact keys this person holds. The nav and every button reads them. */
    permissions: string[];
    isDriver: boolean;
  };
  partner: {
    id: string;
    code: string;
    displayName: string;
    status: 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
    canAcceptNewWork: boolean;
  };
  mfa: MfaState;
}

export interface MfaEnrolment {
  secret: string;
  /** `otpauth://` — rendered as a QR code in the browser, never fetched. */
  uri: string;
  /** Shown exactly once. There is no endpoint that returns them again. */
  recoveryCodes: string[];
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

export interface SlaLeg {
  state: SlaState;
  dueAt: string | null;
  metAt: string | null;
  minutesLate: number;
  minutesRemaining: number | null;
}

export interface SlaAssessment {
  state: SlaState;
  pickup: SlaLeg;
  delivery: SlaLeg;
  minutesLate: number;
  minutesRemaining: number | null;
}

export interface ShipmentRow {
  id: string;
  shipmentReference: string;
  trackingNumber: string;
  orderReference: string | null;
  sellerCompanyName: string;
  receivingCompanyName: string;
  originWarehouse: string | null;
  destinationCity: string | null;
  destinationCountry: string;
  packageCount: number;
  assignedDriverName: string | null;
  status: ShipmentStatus;
  serviceType: ServiceType;
  expectedPickupAt: string | null;
  estimatedDeliveryAt: string | null;
  lastEventAt: string | null;
  sla: SlaAssessment;
  openExceptionCount: number;
  hasProofOfDelivery: boolean;
  requiresColdChain: boolean;
  isDangerousGoods: boolean;
}

export interface ShipmentPage {
  rows: ShipmentRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * A contact detail as the server decided to show it.
 *
 * `display` is already masked where it should be - the masking happens on the
 * server, before the value reaches this process, so there is no full number in
 * the network tab to un-mask. `offerSecureContact` is the server telling the
 * portal to render a "call through UBOSS" button instead of a tel: link.
 */
export interface MaskedContact {
  display: string | null;
  isMasked: boolean;
  offerSecureContact: boolean;
}

export interface ShipmentAddress {
  line1?: string;
  line2?: string | null;
  city?: string;
  region?: string | null;
  postalCode?: string;
  countryCode?: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface ShipmentPackage {
  id: string;
  packageReference: string;
  sequence: number;
  weightGrams: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  packagingType: string | null;
  isFragile: boolean;
  requiresColdChain: boolean;
  batchReference: string | null;
  scannedOutAt: string | null;
  scannedInAt: string | null;
}

export interface AllowedTransition {
  to: ShipmentStatus;
  requiresReason: boolean;
  requiresProofOfDelivery: boolean;
}

export interface ShipmentDetail {
  id: string;
  shipmentReference: string;
  trackingNumber: string;
  carrierTrackingNumber: string | null;
  carrierTrackingUrl: string | null;
  orderReference: string | null;
  status: ShipmentStatus;
  serviceType: ServiceType;

  sellerCompanyName: string;
  receivingCompanyName: string;

  originWarehouse: { name: string; code: string; timezone: string | null } | null;
  pickupAddress: ShipmentAddress;
  deliveryAddress: ShipmentAddress;
  originCountry: string;
  destinationCountry: string;
  destinationCity: string | null;
  destinationPostalCode: string | null;
  distanceKm: string | null;

  packageCount: number;
  totalWeightGrams: number;
  totalVolumeCm3: number | null;
  productCategorySummary: string | null;

  handling: {
    requiresColdChain: boolean;
    requiresTemperatureRange: boolean;
    temperatureMinC: string | null;
    temperatureMaxC: string | null;
    requiresSterileHandling: boolean;
    isFragile: boolean;
    isDangerousGoods: boolean;
    dangerousGoodsClass: string | null;
    handlingNotes: string | null;
  };

  contacts: {
    pickup: { name: string | null; phone: MaskedContact; email: MaskedContact };
    delivery: { name: string | null; phone: MaskedContact; email: MaskedContact };
  };

  expectedPickupAt: string | null;
  estimatedDeliveryAt: string | null;
  acceptedAt: string | null;
  pickedUpAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  deliveryAttemptCount: number;
  lastEventAt: string | null;
  lastCarrierSyncAt: string | null;

  sla: SlaAssessment;

  assignment: {
    id: string;
    state: 'OFFERED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED' | 'COMPLETED';
    offeredAt: string;
    respondBy: string | null;
    respondedAt: string | null;
    responseReason: string | null;
  };

  assignedDriver: { profileId: string; name: string; phone: MaskedContact } | null;

  packages: ShipmentPackage[];

  openExceptions: {
    id: string;
    type: string;
    severity: ExceptionSeverity;
    state: ExceptionState;
    reason: string;
    resolutionDueAt: string | null;
    revisedEtaAt: string | null;
  }[];

  hasProofOfDelivery: boolean;

  /**
   * NULL IS A REAL ANSWER and is rendered as "Live location unavailable".
   *
   * Nothing in this portal interpolates a position, animates between two
   * scans, or draws a marker the server did not send. See the note on
   * `lastKnownPositionOf` in the backend.
   */
  lastKnownPosition: {
    latitude: string;
    longitude: string;
    accuracyM: number | null;
    at: string;
    source: 'EVENT' | 'TRIP';
  } | null;

  allowedTransitions: AllowedTransition[];

  /** True when the assignment is settled: history, not a live door. */
  isReadOnly: boolean;
}

export interface TimelineEntry {
  id: string;
  previousStatus: ShipmentStatus | null;
  status: ShipmentStatus;
  publicDescription: string | null;
  /** Null for a caller without operations authority. */
  internalNote: string | null;
  reason: string | null;
  occurredAt: string;
  recordedAt: string;
  locationLabel: string | null;
  locationCountry: string | null;
  source: EventSource;
  /** The carrier's own code, preserved even after it was mapped. */
  externalStatusCode: string | null;
  isCorrection: boolean;
  isException: boolean;
  documentId: string | null;
  exceptionId: string | null;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardCounts {
  assignedToday: number;
  acceptancePending: number;
  pickupPending: number;
  pickedUp: number;
  dispatched: number;
  inTransit: number;
  outForDelivery: number;
  deliveredToday: number;
  delayed: number;
  exceptions: number;
  failedDeliveries: number;
  returns: number;
  slaAtRisk: number;
  slaBreached: number;
}

export interface Dashboard {
  counts: DashboardCounts;
  metrics: {
    /** Null with no history. Never 100 for a carrier that has delivered nothing. */
    onTimeDeliveryPercentage: number | null;
    averageTransitHours: number | null;
    firstAttemptSuccessPercentage: number | null;
    proofOfDeliveryPending: number;
  };
  statusDistribution: { status: ShipmentStatus; count: number }[];
  recentActivity: {
    shipmentId: string;
    shipmentReference: string;
    status: ShipmentStatus;
    receivingCompanyName: string;
    occurredAt: string;
    publicDescription: string | null;
  }[];
  urgentExceptions: {
    id: string;
    shipmentId: string;
    shipmentReference: string;
    type: string;
    severity: ExceptionSeverity;
    reason: string;
    createdAt: string;
  }[];
  upcomingPickups: {
    id: string;
    shipmentReference: string | null;
    warehouseName: string | null;
    windowStartAt: string;
    windowEndAt: string;
  }[];
  deliveriesDueToday: {
    shipmentId: string;
    shipmentReference: string;
    receivingCompanyName: string;
    destinationCity: string | null;
    estimatedDeliveryAt: string | null;
  }[];
  integration: {
    /** Null where this carrier works entirely inside the portal. */
    provider: string | null;
    state: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
    lastTrackingSyncAt: string | null;
    deadLetteredEvents: number;
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface PickupRow {
  id: string;
  state: PickupState;
  shipmentId: string | null;
  shipmentReference: string | null;
  warehouseName: string | null;
  /** The IANA zone the window's clock belongs to. */
  timezone: string | null;
  windowStartAt: string;
  windowEndAt: string;
  warehouseInstructions: string | null;
  readinessConfirmedAt: string | null;
  driverName: string | null;
  vehicleRegistration: string | null;
  packagesCollected: number | null;
  failureReason: string | null;
  completedAt: string | null;
}

export interface ManifestRow {
  id: string;
  manifestNumber: string;
  state: ManifestState;
  driverName: string | null;
  vehicleRegistration: string | null;
  originLabel: string | null;
  destinationLabel: string | null;
  plannedDepartureAt: string | null;
  closedAt: string | null;
  handedOverAt: string | null;
  shipmentCount: number;
  packageCount: number;
}

export interface ExceptionRow {
  id: string;
  shipmentId: string;
  shipmentReference: string;
  receivingCompanyName: string;
  type: string;
  severity: ExceptionSeverity;
  state: ExceptionState;
  reason: string;
  ownerName: string | null;
  resolutionDueAt: string | null;
  revisedEtaAt: string | null;
  customerNotifiedAt: string | null;
  escalatedAt: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface CompanyRow {
  name: string;
  type: 'SELLER' | 'RECEIVER';
  activeShipments: number;
  inTransitShipments: number;
  deliveredShipments: number;
  delayedShipments: number;
  lastShipmentAt: string | null;
  mainRegions: string[];
  onTimePercentage: number | null;
}

export interface DriverRow {
  id: string;
  /** Their account, where they have one. Null for a record-only driver. */
  partnerUserId: string | null;
  fullName: string;
  phone: string | null;
  email: string | null;
  /** Whether they can open the phone app. False for most of a fleet. */
  hasPortalAccess: boolean;
  state: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  employeeReference: string | null;
  licenceNumber: string | null;
  licenceExpiresAt: string | null;
  canCarryDangerousGoods: boolean;
  canCarryColdChain: boolean;
  canCarrySterile: boolean;
  hasLocationConsent: boolean;
  /** Consignments they are carrying right now. */
  openTasks: number;
}

/**
 * One link in the chain of people who have held a consignment.
 *
 * Read oldest first, unlike every other list in the portal: this is a chain
 * rather than a feed, and "A, then B because A was sick" reads forwards.
 */
export interface DriverAssignmentEntry {
  id: string;
  driverProfileId: string;
  driverName: string;
  vehicleRegistration: string | null;
  isPickupLeg: boolean;
  isDeliveryLeg: boolean;
  assignedAt: string;
  unassignedAt: string | null;
  completedAt: string | null;
  /** Why they came off, where a dispatcher gave a reason. */
  unassignedReason: string | null;
  previousAssignmentId: string | null;
  /** Who put them on it. */
  assignedByName: string | null;
  /** Whether this is the one that counts right now. */
  isActive: boolean;
}

export interface VehicleRow {
  id: string;
  registration: string;
  kind: string;
  hasRefrigeration: boolean;
  hasTailLift: boolean;
  temperatureMinC: string | null;
  temperatureMaxC: string | null;
  maxWeightGrams: number | null;
  isActive: boolean;
}

export interface DriverTask {
  assignmentId: string;
  shipmentId: string;
  shipmentReference: string;
  trackingNumber: string;
  leg: 'PICKUP' | 'DELIVERY';
  routeSequence: number | null;
  status: ShipmentStatus;
  companyName: string;
  contactName: string | null;
  /** Unmasked: this is the caller's own stop, today. */
  contactPhone: string | null;
  addressLines: string[];
  city: string | null;
  postalCode: string | null;
  countryCode: string;
  latitude: string | null;
  longitude: string | null;
  packageCount: number;
  requiresColdChain: boolean;
  isDangerousGoods: boolean;
  isFragile: boolean;
  handlingNotes: string | null;
  dueAt: string | null;
  podPolicy: {
    requiresRecipientName: boolean;
    requiresSignature: boolean;
    requiresPhoto: boolean;
    requiresOtp: boolean;
    requiresDesignation: boolean;
  };
}

export interface PartnerProfile {
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
  status: string;
  contractStatus: string;
  contractReference: string | null;
  contractStartsAt: string | null;
  contractEndsAt: string | null;
  suspensionReason: string | null;
  regions: {
    id: string;
    scope: string;
    countryCode: string;
    regionValue: string;
    supportsPickup: boolean;
    supportsDelivery: boolean;
    isActive: boolean;
  }[];
  capabilities: { id: string; kind: string; state: string; evidenceExpiresAt: string | null }[];
  slaPolicies: {
    id: string;
    name: string;
    serviceType: string;
    pickupHours: number | null;
    deliveryHours: number | null;
    riskWindowMinutes: number;
    maxDeliveryAttempts: number;
    isDefault: boolean;
    podRequiresRecipientName: boolean;
    podRequiresSignature: boolean;
    podRequiresPhoto: boolean;
    podRequiresOtp: boolean;
    podRequiresDesignation: boolean;
  }[];
}

export interface MemberRow {
  id: string;
  fullName: string;
  email: string;
  role: LogisticsRole;
  status: 'INVITED' | 'ACTIVE' | 'DISABLED';
  jobTitle: string | null;
  phone: string | null;
  isDriver: boolean;
  requiresMfa: boolean;
  /** Whether they have enrolled. Never the secret, and never a hint at it. */
  mfaEnrolled: boolean;
  lastActiveAt: string | null;
  createdAt: string;
}

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  shipmentId: string | null;
  shipmentReference: string | null;
  readAt: string | null;
  createdAt: string;

  /**
   * News or problem.
   *
   * `INFORMATION` - "collected", "out for delivery" - is over once it has been
   * read. `ALERT` - a failed delivery, a cold-chain excursion - is over when
   * the parcel moves again or the exception is closed, whoever has read it.
   * The two leave the list in different ways, which is why the row carries
   * which it is.
   */
  class: 'INFORMATION' | 'ALERT';
  status: 'ACTIVE' | 'RESOLVED' | 'ARCHIVED';
  resolvedAt: string | null;
  resolutionReason: string | null;
}

export interface NotificationFeed {
  notifications: NotificationRow[];
  unreadCount: number;
  /** The badge: unread news plus live problems, counted by the server. */
  activeCount: number;
  /** Live problems alone. */
  openAlertCount: number;
}

export interface ProofOfDelivery {
  id: string;
  recipientName: string | null;
  recipientDesignation: string | null;
  deliveredAt: string;
  deliveryLocationLabel: string | null;
  hasSignature: boolean;
  hasPhoto: boolean;
  otpVerified: boolean;
  businessStamped: boolean;
  /** Document IDS, never bytes and never URLs. A link is asked for separately. */
  signatureDocumentId: string | null;
  photoDocumentId: string | null;
  exceptionNote: string | null;
  capturedBy: string | null;
}

export interface DocumentRow {
  id: string;
  kind: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanState: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED' | 'SKIPPED';
  /** False where this deployment refuses files nothing has scanned. */
  isDownloadable: boolean;
  createdAt: string;
}

export interface LiveLocation {
  tripId: string;
  driverName: string;
  latitude: string;
  longitude: string;
  accuracyM: number | null;
  at: string;
  ageSeconds: number;
}
