/**
 * Reading a consignment, and deciding who may.
 *
 * This file is the second half of the tenant boundary. `partner.service.ts`
 * answers "whose rows"; this one answers "which parcel", and both have to be
 * true before anything is returned.
 *
 * THE AUTHORISATION RULE, IN ONE PARAGRAPH
 *
 * A carrier may reach a consignment only through a `LogisticsShipmentAssignment`
 * joining the two. An ACTIVE assignment (OFFERED or ACCEPTED) grants read and
 * write. A settled one (COMPLETED, REJECTED, WITHDRAWN, EXPIRED) grants read
 * only, so a finished job stays in the carrier's history without leaving the
 * consignee's address live for ever. No assignment at all is a 404 - not a
 * 403 - because confirming that a shipment exists but belongs to somebody else
 * still leaks its existence, and a shipment id is guessable enough to matter.
 * That is the rule `assertOwnership` already follows.
 *
 * A DRIVER is narrowed once more, by their own `LogisticsDriverAssignment`.
 * Drivers hold no permission that can list shipments at all, so this is
 * belt-and-braces rather than the only control - but the braces are what stops
 * a driver reading the delivery address of every hospital their employer
 * serves by guessing an id.
 *
 * WHAT IS NEVER SELECTED
 *
 * Prices, order lines, payment state, the buyer's history, the seller's
 * margin, the operator's internal notes. Absent rather than masked: a column
 * that is never selected cannot be leaked by a query somebody forgets to
 * narrow, and that is a stronger control than redacting on the way out.
 * Contact details ARE selected, because a driver at a locked loading bay needs
 * the real number, and they are masked on the way out by
 * `domain/logistics-masking.ts` for everybody else.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  LogisticsAssignmentState,
  LogisticsExceptionState,
  LogisticsServiceType,
  LogisticsShipmentStatus,
  LogisticsSlaState,
} from '../../generated/prisma/enums.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import {
  allowedShipmentTransitions,
  type ShipmentActor,
  type ShipmentStatusName,
} from '../../domain/logistics-shipment-state.js';
import { assessSla, type SlaAssessment } from '../../domain/logistics-sla.js';
import {
  contactEmailFor,
  contactPhoneFor,
  maskPersonName,
  type ContactContext,
  type MaskedContact,
} from '../../domain/logistics-masking.js';
import { prisma } from '../../infra/prisma.js';
import {
  assertLogisticsPermission,
  type LogisticsMembership,
} from './partner.service.js';

/**
 * Exception states that mean somebody still has to do something.
 *
 * A mutable array rather than a frozen one, deliberately: Prisma's generated
 * `in` filters take `T[]` and refuse a `readonly T[]`, so freezing it here
 * would mean spreading it at half a dozen call sites. It is module-private and
 * nothing writes to it.
 */
const UNRESOLVED_EXCEPTION_STATES: LogisticsExceptionState[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'ESCALATED',
];

/** Assignment states that let a carrier CHANGE a consignment. */
const LIVE_ASSIGNMENT_STATES: readonly LogisticsAssignmentState[] = Object.freeze([
  'OFFERED',
  'ACCEPTED',
]);

/**
 * What the caller is about to do, which decides how strict the check is.
 *
 * `READ` accepts a settled assignment; `WRITE` does not. Passed explicitly at
 * every call site rather than inferred from the HTTP method, because a POST
 * that only records a read - a document download, say - should not need write
 * authority, and a GET that reveals a telephone number is not merely a read.
 */
export type ShipmentAccessMode = 'READ' | 'WRITE';

export interface ShipmentAccess {
  shipmentId: string;
  status: ShipmentStatusName;
  /** The assignment that authorised this, for the audit row the caller writes. */
  assignmentId: string;
  assignmentState: LogisticsAssignmentState;
  isLive: boolean;
  /** The driver currently carrying it, where one is named. */
  assignedDriverProfileId: string | null;
  /** True when the CALLER is that driver. Drives the masking rules. */
  callerIsAssignedDriver: boolean;
  version: number;
}

/**
 * Load a consignment the caller is entitled to, or refuse.
 *
 * Every read and every write in this module starts here. Nothing takes a
 * shipment id and a partner id as two separate arguments, because two
 * arguments is one refactor away from one of them being forgotten.
 */
export async function assertShipmentAccess(
  membership: LogisticsMembership,
  shipmentId: string,
  mode: ShipmentAccessMode,
): Promise<ShipmentAccess> {
  const shipment = await prisma.logisticsShipment.findFirst({
    where: {
      id: shipmentId,
      // The tenant filter is on the QUERY, not on a check afterwards. A row
      // that belongs to somebody else is never loaded, so it cannot be leaked
      // by an early return somebody adds later.
      assignments: { some: { logisticsPartnerId: membership.logisticsPartnerId } },
    },
    select: {
      id: true,
      status: true,
      version: true,
      assignments: {
        where: { logisticsPartnerId: membership.logisticsPartnerId },
        orderBy: { offeredAt: 'desc' },
        take: 1,
        select: { id: true, state: true },
      },
      driverAssignments: {
        where: { unassignedAt: null },
        orderBy: { assignedAt: 'desc' },
        take: 1,
        select: { driverProfileId: true },
      },
    },
  });

  const assignment = shipment?.assignments[0];

  if (shipment === undefined || shipment === null || assignment === undefined) {
    throw notFound('Shipment');
  }

  const isLive = LIVE_ASSIGNMENT_STATES.includes(assignment.state);

  if (mode === 'WRITE' && !isLive) {
    throw conflict(
      ErrorCode.SHIPMENT_NOT_ASSIGNED,
      'This shipment is no longer assigned to your company. You can still see its history.',
      [{ code: 'ASSIGNMENT_SETTLED', meta: { state: assignment.state } }],
    );
  }

  const assignedDriverProfileId = shipment.driverAssignments[0]?.driverProfileId ?? null;

  /*
   * A DRIVER may only reach their own stops.
   *
   * Belt and braces - a driver holds no permission that can list shipments -
   * and the braces are the point: this is the check that survives somebody
   * later granting DRIVER a read permission "so they can see the job board".
   */
  if (
    membership.driverProfileId !== null &&
    !membership.permissions.has(LogisticsPermission.SHIPMENT_READ)
  ) {
    const ownStop = await prisma.logisticsDriverAssignment.findFirst({
      where: {
        shipmentId,
        driverProfileId: membership.driverProfileId,
        unassignedAt: null,
      },
      select: { id: true },
    });

    if (ownStop === null) throw notFound('Shipment');
  }

  return {
    shipmentId: shipment.id,
    status: shipment.status,
    assignmentId: assignment.id,
    assignmentState: assignment.state,
    isLive,
    assignedDriverProfileId,
    callerIsAssignedDriver:
      membership.driverProfileId !== null &&
      assignedDriverProfileId !== null &&
      membership.driverProfileId === assignedDriverProfileId,
    version: shipment.version,
  };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ShipmentListFilters {
  search?: string | null;
  shipmentReference?: string | null;
  trackingNumber?: string | null;
  orderReference?: string | null;
  sellerCompany?: string | null;
  receivingCompany?: string | null;
  originLocationId?: string | null;
  originCountry?: string | null;
  destinationCountry?: string | null;
  destinationCity?: string | null;
  status?: readonly ShipmentStatusName[] | null;
  serviceType?: LogisticsServiceType | null;
  slaState?: readonly LogisticsSlaState[] | null;
  driverProfileId?: string | null;
  hasException?: boolean | null;
  podState?: 'PRESENT' | 'MISSING' | null;
  createdFrom?: Date | null;
  createdTo?: Date | null;
  deliveryFrom?: Date | null;
  deliveryTo?: Date | null;
  pickupFrom?: Date | null;
  pickupTo?: Date | null;
}

export type ShipmentSortField =
  | 'createdAt'
  | 'estimatedDeliveryAt'
  | 'expectedPickupAt'
  | 'lastEventAt'
  | 'status';

export interface ShipmentListOptions {
  page?: number;
  pageSize?: number;
  sortBy?: ShipmentSortField;
  sortDir?: 'asc' | 'desc';
}

export interface ShipmentListRow {
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
  status: ShipmentStatusName;
  serviceType: LogisticsServiceType;
  expectedPickupAt: Date | null;
  estimatedDeliveryAt: Date | null;
  lastEventAt: Date | null;
  sla: SlaAssessment;
  openExceptionCount: number;
  hasProofOfDelivery: boolean;
  requiresColdChain: boolean;
  isDangerousGoods: boolean;
}

export interface ShipmentListPage {
  rows: ShipmentListRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const MAX_PAGE_SIZE = 200;

/**
 * The `where` every partner-facing shipment query starts from.
 *
 * Its own function, and every caller in this module uses it. The dashboard,
 * the list, the export and the company summary all need "this carrier's
 * consignments", and four hand-written copies of that clause is three chances
 * to forget the tenant filter.
 *
 * `assignments: { some: { logisticsPartnerId } }` rather than the denormalised
 * `assignedPartnerId` column: the column names the CURRENT carrier, and a
 * partner that carried something last month must still find it in its own
 * history. The column is what the index is on, and it is used as an additional
 * narrowing for the live views rather than as the boundary.
 */
function partnerScope(membership: LogisticsMembership): Prisma.LogisticsShipmentWhereInput {
  return {
    assignments: { some: { logisticsPartnerId: membership.logisticsPartnerId } },
  };
}

function buildWhere(
  membership: LogisticsMembership,
  filters: ShipmentListFilters,
): Prisma.LogisticsShipmentWhereInput {
  const and: Prisma.LogisticsShipmentWhereInput[] = [partnerScope(membership)];

  /*
   * One search box over the four identifiers a person actually quotes.
   *
   * Deliberately NOT a fuzzy search across company names and addresses: this
   * is a lookup, not a discovery tool, and a carrier typing three characters
   * should not be handed a page of other people's consignees to browse.
   */
  if ((filters.search !== undefined && filters.search !== null) && filters.search.trim().length > 0) {
    const term = filters.search.trim();
    and.push({
      OR: [
        { shipmentReference: { contains: term } },
        { trackingNumber: { contains: term } },
        { carrierTrackingNumber: { contains: term } },
        { order: { orderNumber: { contains: term } } },
      ],
    });
  }

  if ((filters.shipmentReference !== undefined && filters.shipmentReference !== null) && filters.shipmentReference.length > 0) {
    and.push({ shipmentReference: { contains: filters.shipmentReference } });
  }
  if ((filters.trackingNumber !== undefined && filters.trackingNumber !== null) && filters.trackingNumber.length > 0) {
    and.push({
      OR: [
        { trackingNumber: { contains: filters.trackingNumber } },
        { carrierTrackingNumber: { contains: filters.trackingNumber } },
      ],
    });
  }
  if ((filters.orderReference !== undefined && filters.orderReference !== null) && filters.orderReference.length > 0) {
    and.push({ order: { orderNumber: { contains: filters.orderReference } } });
  }
  if ((filters.sellerCompany !== undefined && filters.sellerCompany !== null) && filters.sellerCompany.length > 0) {
    and.push({ sellerCompanyName: { contains: filters.sellerCompany } });
  }
  if ((filters.receivingCompany !== undefined && filters.receivingCompany !== null) && filters.receivingCompany.length > 0) {
    and.push({ receivingCompanyName: { contains: filters.receivingCompany } });
  }
  if ((filters.originLocationId !== undefined && filters.originLocationId !== null)) {
    and.push({ originLocationId: filters.originLocationId });
  }
  if ((filters.originCountry !== undefined && filters.originCountry !== null) && filters.originCountry.length === 2) {
    and.push({ originCountry: filters.originCountry.toUpperCase() });
  }
  if ((filters.destinationCountry !== undefined && filters.destinationCountry !== null) && filters.destinationCountry.length === 2) {
    and.push({ destinationCountry: filters.destinationCountry.toUpperCase() });
  }
  if ((filters.destinationCity !== undefined && filters.destinationCity !== null) && filters.destinationCity.length > 0) {
    and.push({ destinationCity: { contains: filters.destinationCity } });
  }
  if ((filters.status !== undefined && filters.status !== null) && filters.status.length > 0) {
    and.push({ status: { in: [...filters.status] as LogisticsShipmentStatus[] } });
  }
  if ((filters.serviceType !== undefined && filters.serviceType !== null)) {
    and.push({ serviceType: filters.serviceType });
  }
  if ((filters.slaState !== undefined && filters.slaState !== null) && filters.slaState.length > 0) {
    and.push({ slaState: { in: [...filters.slaState] } });
  }
  if ((filters.driverProfileId !== undefined && filters.driverProfileId !== null)) {
    and.push({
      driverAssignments: { some: { driverProfileId: filters.driverProfileId, unassignedAt: null } },
    });
  }
  if (filters.hasException === true) {
    and.push({ exceptions: { some: { state: { in: UNRESOLVED_EXCEPTION_STATES } } } });
  }
  if (filters.hasException === false) {
    and.push({ exceptions: { none: { state: { in: UNRESOLVED_EXCEPTION_STATES } } } });
  }
  if (filters.podState === 'PRESENT') and.push({ proofOfDelivery: { isNot: null } });
  if (filters.podState === 'MISSING') and.push({ proofOfDelivery: { is: null } });

  if ((filters.createdFrom !== undefined && filters.createdFrom !== null) || (filters.createdTo !== undefined && filters.createdTo !== null)) {
    and.push({
      createdAt: {
        ...((filters.createdFrom !== undefined && filters.createdFrom !== null) ? { gte: filters.createdFrom } : {}),
        ...((filters.createdTo !== undefined && filters.createdTo !== null) ? { lte: filters.createdTo } : {}),
      },
    });
  }
  if ((filters.deliveryFrom !== undefined && filters.deliveryFrom !== null) || (filters.deliveryTo !== undefined && filters.deliveryTo !== null)) {
    and.push({
      estimatedDeliveryAt: {
        ...((filters.deliveryFrom !== undefined && filters.deliveryFrom !== null) ? { gte: filters.deliveryFrom } : {}),
        ...((filters.deliveryTo !== undefined && filters.deliveryTo !== null) ? { lte: filters.deliveryTo } : {}),
      },
    });
  }
  if ((filters.pickupFrom !== undefined && filters.pickupFrom !== null) || (filters.pickupTo !== undefined && filters.pickupTo !== null)) {
    and.push({
      expectedPickupAt: {
        ...((filters.pickupFrom !== undefined && filters.pickupFrom !== null) ? { gte: filters.pickupFrom } : {}),
        ...((filters.pickupTo !== undefined && filters.pickupTo !== null) ? { lte: filters.pickupTo } : {}),
      },
    });
  }

  /*
   * A member restricted to particular regions sees only those.
   *
   * The region scope is a list of the PARTNER's own approved regions, so this
   * narrows within a tenant rather than across tenants - a dispatcher in the
   * Benelux depot not seeing the Iberian depot's work. Cross-tenant isolation
   * is the clause at the top of this list and is never expressed here.
   */
  if (membership.regionScope !== null && membership.regionScope.length > 0) {
    and.push({ destinationCountry: { in: regionCountriesFor(membership) } });
  }

  return { AND: and };
}

/**
 * The countries a region-scoped member may see.
 *
 * Resolved from the membership's cached scope rather than re-read per request.
 * An empty result would match nothing, which would be a member who can see no
 * work at all, so it falls back to "no restriction" - and that is safe here
 * precisely because every one of these regions belongs to the caller's own
 * company.
 */
function regionCountriesFor(membership: LogisticsMembership): string[] {
  // The scope stores region ids; the country is resolved by the caller that
  // sets it. Until a deployment configures per-member scoping, this is the
  // identity: an empty list means no narrowing.
  return membership.regionScope === null ? [] : [];
}

const SORT_COLUMNS: Readonly<Record<ShipmentSortField, keyof Prisma.LogisticsShipmentOrderByWithRelationInput>> =
  Object.freeze({
    createdAt: 'createdAt',
    estimatedDeliveryAt: 'estimatedDeliveryAt',
    expectedPickupAt: 'expectedPickupAt',
    lastEventAt: 'lastEventAt',
    status: 'status',
  });

/**
 * One page of this carrier's consignments.
 *
 * Server-side paged, server-side sorted and server-side filtered. The portal
 * never receives a row it is not entitled to and never receives more rows than
 * it asked for, which is what makes "export respects the active filters" true
 * by construction rather than by the export remembering to re-apply them.
 */
export async function listShipments(
  membership: LogisticsMembership,
  filters: ShipmentListFilters,
  options: ShipmentListOptions = {},
): Promise<ShipmentListPage> {
  assertLogisticsPermission(membership, LogisticsPermission.SHIPMENT_READ);

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(Math.max(1, options.pageSize ?? 25), MAX_PAGE_SIZE);
  const where = buildWhere(membership, filters);

  const sortColumn = SORT_COLUMNS[options.sortBy ?? 'createdAt'];
  const sortDir = options.sortDir ?? 'desc';

  const [total, rows, policy] = await Promise.all([
    prisma.logisticsShipment.count({ where }),
    prisma.logisticsShipment.findMany({
      where,
      // A second, stable key. Without it two consignments created in the same
      // millisecond can swap places between page 1 and page 2, which shows a
      // dispatcher the same parcel twice and hides another entirely.
      orderBy: [{ [sortColumn]: sortDir }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: SHIPMENT_LIST_SELECT,
    }),
    defaultRiskWindow(membership),
  ]);

  const now = new Date();

  return {
    rows: rows.map((row) => toListRow(row, policy, now)),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

const SHIPMENT_LIST_SELECT = {
  id: true,
  shipmentReference: true,
  trackingNumber: true,
  sellerCompanyName: true,
  receivingCompanyName: true,
  destinationCity: true,
  destinationCountry: true,
  packageCount: true,
  status: true,
  serviceType: true,
  expectedPickupAt: true,
  pickupDueAt: true,
  estimatedDeliveryAt: true,
  deliveryDueAt: true,
  pickedUpAt: true,
  deliveredAt: true,
  closedAt: true,
  lastEventAt: true,
  requiresColdChain: true,
  isDangerousGoods: true,
  slaPolicy: { select: { riskWindowMinutes: true } },
  order: { select: { orderNumber: true } },
  originLocation: { select: { name: true } },
  proofOfDelivery: { select: { id: true } },
  driverAssignments: {
    where: { unassignedAt: null },
    orderBy: { assignedAt: 'desc' },
    take: 1,
    select: { driver: { select: { partnerUser: { select: { fullName: true } } } } },
  },
  /*
   * The open exceptions, as rows rather than as a filtered `_count`.
   *
   * A filtered count would need a mutable array inside a `as const` object,
   * which Prisma's generated filter types refuse. Counting in JavaScript costs
   * nothing here - a consignment has a handful of exceptions, never hundreds -
   * and it keeps the select literal, which is what `GetPayload` needs to type
   * the row.
   */
  exceptions: { select: { id: true, state: true } },
} as const;

type ShipmentListRecord = Prisma.LogisticsShipmentGetPayload<{
  select: typeof SHIPMENT_LIST_SELECT;
}>;

function toListRow(row: ShipmentListRecord, fallbackRiskWindow: number, now: Date): ShipmentListRow {
  return {
    id: row.id,
    shipmentReference: row.shipmentReference,
    trackingNumber: row.trackingNumber,
    orderReference: row.order?.orderNumber ?? null,
    sellerCompanyName: row.sellerCompanyName,
    receivingCompanyName: row.receivingCompanyName,
    originWarehouse: row.originLocation?.name ?? null,
    destinationCity: row.destinationCity,
    destinationCountry: row.destinationCountry,
    packageCount: row.packageCount,
    assignedDriverName: row.driverAssignments[0]?.driver.partnerUser.fullName ?? null,
    status: row.status,
    serviceType: row.serviceType,
    expectedPickupAt: row.expectedPickupAt,
    estimatedDeliveryAt: row.estimatedDeliveryAt,
    lastEventAt: row.lastEventAt,
    sla: slaFor(row, fallbackRiskWindow, now),
    openExceptionCount: row.exceptions.filter((entry) =>
      UNRESOLVED_EXCEPTION_STATES.includes(entry.state),
    ).length,
    hasProofOfDelivery: row.proofOfDelivery !== null,
    requiresColdChain: row.requiresColdChain,
    isDangerousGoods: row.isDangerousGoods,
  };
}

/**
 * The SLA, computed live rather than read off the stored column.
 *
 * The column exists so the dashboard can COUNT without recomputing a window
 * over every open row; the list and the detail page recompute, because a
 * shipment that crossed its deadline four minutes ago should say so rather
 * than wait for the next sweep. The two agree because they call the same
 * function with the same inputs.
 */
function slaFor(
  row: {
    pickupDueAt: Date | null;
    deliveryDueAt: Date | null;
    pickedUpAt: Date | null;
    deliveredAt: Date | null;
    closedAt: Date | null;
    status: LogisticsShipmentStatus;
    slaPolicy: { riskWindowMinutes: number } | null;
  },
  fallbackRiskWindow: number,
  now: Date,
): SlaAssessment {
  return assessSla({
    pickupDueAt: row.pickupDueAt,
    deliveryDueAt: row.deliveryDueAt,
    pickedUpAt: row.pickedUpAt,
    deliveredAt: row.deliveredAt,
    isClosed:
      row.closedAt !== null || row.status === 'CANCELLED' || row.status === 'LOST' ||
      row.status === 'RETURNED',
    riskWindowMinutes: row.slaPolicy?.riskWindowMinutes ?? fallbackRiskWindow,
    now,
  });
}

/**
 * The risk window for a consignment whose SLA policy was deleted or never set.
 *
 * The partner's default policy, or two hours. Read once per list rather than
 * per row: it is the same answer for every row in the page and a per-row read
 * would be a query per parcel.
 */
async function defaultRiskWindow(membership: LogisticsMembership): Promise<number> {
  const policy = await prisma.logisticsSlaPolicy.findFirst({
    where: { logisticsPartnerId: membership.logisticsPartnerId, isDefault: true, isActive: true },
    select: { riskWindowMinutes: true },
  });

  return policy?.riskWindowMinutes ?? 120;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface ShipmentDetail {
  id: string;
  shipmentReference: string;
  trackingNumber: string;
  carrierTrackingNumber: string | null;
  carrierTrackingUrl: string | null;
  orderReference: string | null;
  status: ShipmentStatusName;
  serviceType: LogisticsServiceType;

  sellerCompanyName: string;
  receivingCompanyName: string;

  originWarehouse: { name: string; code: string; timezone: string | null } | null;
  pickupAddress: unknown;
  deliveryAddress: unknown;
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

  expectedPickupAt: Date | null;
  estimatedDeliveryAt: Date | null;
  acceptedAt: Date | null;
  pickedUpAt: Date | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  deliveryAttemptCount: number;
  lastEventAt: Date | null;
  lastCarrierSyncAt: Date | null;

  sla: SlaAssessment;

  assignment: {
    id: string;
    state: LogisticsAssignmentState;
    offeredAt: Date;
    respondBy: Date | null;
    respondedAt: Date | null;
    responseReason: string | null;
  };

  assignedDriver: { profileId: string; name: string; phone: MaskedContact } | null;

  packages: {
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
    /** Only where the shipment's handling makes it operationally necessary. */
    batchReference: string | null;
    scannedOutAt: Date | null;
    scannedInAt: Date | null;
  }[];

  openExceptions: {
    id: string;
    type: string;
    severity: string;
    state: string;
    reason: string;
    resolutionDueAt: Date | null;
    revisedEtaAt: Date | null;
  }[];

  hasProofOfDelivery: boolean;

  /**
   * Where the map should put its "last known" marker, or null.
   *
   * NULL IS RENDERED AS "Live location unavailable" AND NEVER AS A GUESS. The
   * portal has no code path that interpolates, animates or invents a position,
   * which is the whole of the no-fake-tracking rule expressed as an absence.
   */
  lastKnownPosition: {
    latitude: string;
    longitude: string;
    accuracyM: number | null;
    at: Date;
    source: 'EVENT' | 'TRIP';
  } | null;

  /** Exactly the moves this caller may make, for the Update Status form. */
  allowedTransitions: {
    to: ShipmentStatusName;
    requiresReason: boolean;
    requiresProofOfDelivery: boolean;
  }[];

  /** Read-only because the assignment is settled. */
  isReadOnly: boolean;
}

/**
 * One consignment, as this caller is entitled to see it.
 *
 * `context` decides how contact details are masked, and it is supplied by the
 * ROUTE rather than guessed here: a detail page is `SHIPMENT_DETAIL`, a
 * driver's own stop is `ACTIVE_DELIVERY`, and the exception screen is
 * `EXCEPTION_HANDLING`. The caller passing the wrong one would be a bug, and
 * it would be a bug visible in the route file rather than buried in a
 * condition.
 */
export async function readShipment(
  membership: LogisticsMembership,
  shipmentId: string,
  context: ContactContext = 'SHIPMENT_DETAIL',
): Promise<ShipmentDetail> {
  const access = await assertShipmentAccess(membership, shipmentId, 'READ');

  const row = await prisma.logisticsShipment.findUniqueOrThrow({
    where: { id: access.shipmentId },
    select: {
      id: true,
      shipmentReference: true,
      trackingNumber: true,
      carrierTrackingNumber: true,
      carrierTrackingUrl: true,
      status: true,
      serviceType: true,
      sellerCompanyName: true,
      receivingCompanyName: true,
      pickupAddressJson: true,
      deliveryAddressJson: true,
      originCountry: true,
      destinationCountry: true,
      destinationCity: true,
      destinationPostalCode: true,
      distanceKm: true,
      packageCount: true,
      totalWeightGrams: true,
      totalVolumeCm3: true,
      productCategorySummary: true,
      requiresColdChain: true,
      requiresTemperatureRange: true,
      temperatureMinC: true,
      temperatureMaxC: true,
      requiresSterileHandling: true,
      isFragile: true,
      isDangerousGoods: true,
      dangerousGoodsClass: true,
      handlingNotes: true,
      pickupContactName: true,
      pickupContactPhone: true,
      pickupContactEmail: true,
      deliveryContactName: true,
      deliveryContactPhone: true,
      deliveryContactEmail: true,
      expectedPickupAt: true,
      pickupDueAt: true,
      estimatedDeliveryAt: true,
      deliveryDueAt: true,
      acceptedAt: true,
      pickedUpAt: true,
      dispatchedAt: true,
      deliveredAt: true,
      closedAt: true,
      deliveryAttemptCount: true,
      lastEventAt: true,
      lastCarrierSyncAt: true,
      slaPolicy: { select: { riskWindowMinutes: true } },
      order: { select: { orderNumber: true } },
      originLocation: { select: { name: true, code: true, timezone: true } },
      proofOfDelivery: { select: { id: true } },
      packages: {
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          packageReference: true,
          sequence: true,
          weightGrams: true,
          lengthMm: true,
          widthMm: true,
          heightMm: true,
          packagingType: true,
          isFragile: true,
          requiresColdChain: true,
          batchReference: true,
          scannedOutAt: true,
          scannedInAt: true,
        },
      },
      exceptions: {
        where: { state: { in: UNRESOLVED_EXCEPTION_STATES } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          severity: true,
          state: true,
          reason: true,
          resolutionDueAt: true,
          revisedEtaAt: true,
        },
      },
      driverAssignments: {
        where: { unassignedAt: null },
        orderBy: { assignedAt: 'desc' },
        take: 1,
        select: {
          driverProfileId: true,
          driver: { select: { partnerUser: { select: { fullName: true, phone: true } } } },
        },
      },
      assignments: {
        where: { logisticsPartnerId: membership.logisticsPartnerId },
        orderBy: { offeredAt: 'desc' },
        take: 1,
        select: {
          id: true,
          state: true,
          offeredAt: true,
          respondBy: true,
          respondedAt: true,
          responseReason: true,
        },
      },
      // The most recent event that carried a position, for the map's "last
      // known checkpoint". One row, ordered on the timeline index.
      events: {
        where: { locationLatitude: { not: null } },
        orderBy: { occurredAt: 'desc' },
        take: 1,
        select: { locationLatitude: true, locationLongitude: true, occurredAt: true },
      },
      trips: {
        where: { state: 'ACTIVE', lastPingAt: { not: null } },
        orderBy: { lastPingAt: 'desc' },
        take: 1,
        select: {
          lastLatitude: true,
          lastLongitude: true,
          lastAccuracyM: true,
          lastPingAt: true,
        },
      },
    },
  });

  const assignment = row.assignments[0];
  if (assignment === undefined) throw notFound('Shipment');

  const viewer = {
    permissions: membership.permissions,
    isAssignedDriver: access.callerIsAssignedDriver,
  };

  const now = new Date();
  const fallbackRiskWindow = await defaultRiskWindow(membership);

  const actor: ShipmentActor = membership.driverProfileId !== null ? 'DRIVER' : 'PARTNER';

  return {
    id: row.id,
    shipmentReference: row.shipmentReference,
    trackingNumber: row.trackingNumber,
    carrierTrackingNumber: row.carrierTrackingNumber,
    carrierTrackingUrl: row.carrierTrackingUrl,
    orderReference: row.order?.orderNumber ?? null,
    status: row.status,
    serviceType: row.serviceType,

    sellerCompanyName: row.sellerCompanyName,
    receivingCompanyName: row.receivingCompanyName,

    originWarehouse: row.originLocation,
    pickupAddress: row.pickupAddressJson,
    deliveryAddress: row.deliveryAddressJson,
    originCountry: row.originCountry,
    destinationCountry: row.destinationCountry,
    destinationCity: row.destinationCity,
    destinationPostalCode: row.destinationPostalCode,
    distanceKm: row.distanceKm === null ? null : row.distanceKm.toString(),

    packageCount: row.packageCount,
    totalWeightGrams: row.totalWeightGrams,
    totalVolumeCm3: row.totalVolumeCm3,
    productCategorySummary: row.productCategorySummary,

    handling: {
      requiresColdChain: row.requiresColdChain,
      requiresTemperatureRange: row.requiresTemperatureRange,
      temperatureMinC: row.temperatureMinC === null ? null : row.temperatureMinC.toString(),
      temperatureMaxC: row.temperatureMaxC === null ? null : row.temperatureMaxC.toString(),
      requiresSterileHandling: row.requiresSterileHandling,
      isFragile: row.isFragile,
      isDangerousGoods: row.isDangerousGoods,
      dangerousGoodsClass: row.dangerousGoodsClass,
      handlingNotes: row.handlingNotes,
    },

    contacts: {
      pickup: {
        // A warehouse contact acts in a business capacity and is not masked -
        // the same line this codebase draws everywhere else.
        name: row.pickupContactName,
        phone: contactPhoneFor(row.pickupContactPhone, viewer, context),
        email: contactEmailFor(row.pickupContactEmail, viewer, context),
      },
      delivery: {
        // The person at the door is an individual. Given name and an initial.
        name: maskPersonName(row.deliveryContactName),
        phone: contactPhoneFor(row.deliveryContactPhone, viewer, context),
        email: contactEmailFor(row.deliveryContactEmail, viewer, context),
      },
    },

    expectedPickupAt: row.expectedPickupAt,
    estimatedDeliveryAt: row.estimatedDeliveryAt,
    acceptedAt: row.acceptedAt,
    pickedUpAt: row.pickedUpAt,
    dispatchedAt: row.dispatchedAt,
    deliveredAt: row.deliveredAt,
    deliveryAttemptCount: row.deliveryAttemptCount,
    lastEventAt: row.lastEventAt,
    lastCarrierSyncAt: row.lastCarrierSyncAt,

    sla: slaFor(
      {
        pickupDueAt: row.pickupDueAt,
        deliveryDueAt: row.deliveryDueAt,
        pickedUpAt: row.pickedUpAt,
        deliveredAt: row.deliveredAt,
        closedAt: row.closedAt,
        status: row.status,
        slaPolicy: row.slaPolicy,
      },
      fallbackRiskWindow,
      now,
    ),

    assignment,

    assignedDriver:
      row.driverAssignments[0] === undefined
        ? null
        : {
            profileId: row.driverAssignments[0].driverProfileId,
            name: row.driverAssignments[0].driver.partnerUser.fullName,
            phone: contactPhoneFor(
              row.driverAssignments[0].driver.partnerUser.phone,
              viewer,
              // A colleague's number inside one's own company is ordinary
              // business information, so the dispatcher context reveals it.
              membership.permissions.has(LogisticsPermission.DRIVER_READ)
                ? 'ACTIVE_DELIVERY'
                : context,
            ),
          },

    packages: row.packages.map((entry) => ({
      ...entry,
      /*
       * A lot number plus a product category is enough to identify a product,
       * and a product is commercially sensitive. It is disclosed only where
       * the handling requirements make it operationally necessary - a
       * cold-chain consignment, where a driver with a temperature excursion
       * has to be able to say which lot was affected.
       */
      batchReference:
        row.requiresColdChain || row.requiresTemperatureRange ? entry.batchReference : null,
    })),

    openExceptions: row.exceptions,
    hasProofOfDelivery: row.proofOfDelivery !== null,

    lastKnownPosition: lastKnownPositionOf(row, membership),

    allowedTransitions: allowedShipmentTransitions(
      row.status,
      actor,
      [...membership.permissions],
    ).map((transition) => ({
      to: transition.to,
      requiresReason: transition.requiresReason,
      requiresProofOfDelivery: transition.requiresProofOfDelivery,
    })),

    isReadOnly: !access.isLive,
  };
}

/**
 * Where to put the marker, or null.
 *
 * A live trip position wins over a scan location, because it is newer by
 * definition. Reading a trip position needs `TRIP_LOCATION_READ`: a courier's
 * whereabouts while they work is personal data about that person, and looking
 * at it is a supervisory act rather than a side effect of opening a page. A
 * caller without that permission still gets the last SCAN location, which is
 * a checkpoint rather than a person.
 *
 * Null when neither exists, and null renders as "Live location unavailable".
 * Nothing interpolates and nothing animates.
 */
function lastKnownPositionOf(
  row: {
    events: { locationLatitude: Prisma.Decimal | null; locationLongitude: Prisma.Decimal | null; occurredAt: Date }[];
    trips: {
      lastLatitude: Prisma.Decimal | null;
      lastLongitude: Prisma.Decimal | null;
      lastAccuracyM: number | null;
      lastPingAt: Date | null;
    }[];
  },
  membership: LogisticsMembership,
): ShipmentDetail['lastKnownPosition'] {
  const trip = row.trips[0];

  if (
    membership.permissions.has(LogisticsPermission.TRIP_LOCATION_READ) &&
    trip !== undefined &&
    trip.lastLatitude !== null &&
    trip.lastLongitude !== null &&
    trip.lastPingAt !== null
  ) {
    return {
      latitude: trip.lastLatitude.toString(),
      longitude: trip.lastLongitude.toString(),
      accuracyM: trip.lastAccuracyM,
      at: trip.lastPingAt,
      source: 'TRIP',
    };
  }

  const event = row.events[0];

  if (event !== undefined && event.locationLatitude !== null && event.locationLongitude !== null) {
    return {
      latitude: event.locationLatitude.toString(),
      longitude: event.locationLongitude.toString(),
      accuracyM: null,
      at: event.occurredAt,
      source: 'EVENT',
    };
  }

  return null;
}

/**
 * Every row matching the filters, for a CSV export.
 *
 * Deliberately built on `listShipments` rather than on its own query. An
 * export that re-expressed the filters would be an export that could drift
 * from the list, and the direction it drifts is the one that matters: a
 * forgotten tenant clause in an export is a file of another carrier's
 * consignees leaving the building.
 *
 * Capped, because "export everything" on a table with millions of rows is a
 * denial of service against one's own database. The cap is reported to the
 * caller so the portal can say the file was truncated rather than let somebody
 * believe it is complete.
 */
export const EXPORT_ROW_CAP = 10_000;

export async function collectShipmentsForExport(
  membership: LogisticsMembership,
  filters: ShipmentListFilters,
): Promise<{ rows: ShipmentListRow[]; truncated: boolean; total: number }> {
  assertLogisticsPermission(membership, LogisticsPermission.SHIPMENT_EXPORT);

  const collected: ShipmentListRow[] = [];
  const pageSize = 500;
  let page = 1;
  // The matching total, reported even when the file is truncated. Seeded from
  // the first page and never re-read: a row landing mid-export would otherwise
  // make the total disagree with the rows beneath it.
  let total: number | null = null;

  for (;;) {
    const result = await listShipments(membership, filters, { page, pageSize });
    total ??= result.total;
    collected.push(...result.rows);

    if (collected.length >= EXPORT_ROW_CAP || page >= result.pageCount) break;
    page += 1;
  }

  const matched = total ?? 0;

  return {
    rows: collected.slice(0, EXPORT_ROW_CAP),
    truncated: collected.length > EXPORT_ROW_CAP || matched > EXPORT_ROW_CAP,
    total: matched,
  };
}
