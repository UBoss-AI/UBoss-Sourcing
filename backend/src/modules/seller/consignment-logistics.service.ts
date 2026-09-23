/**
 * Handing a seller's confirmed consignment to whoever will carry it.
 *
 * The seller's half of logistics, at the moment it is actually used: a buyer
 * has paid, the seller has confirmed their part, a consignment exists, and
 * somebody has to be named as carrying it. There are two kinds of somebody,
 * and they behave so differently that pretending they are one is the bug this
 * file exists to avoid:
 *
 *   A DELIVERY COMPANY ON THIS PLATFORM - the seller's own fleet, a courier
 *   that works for them, a haulier the marketplace brokered. It has a portal.
 *   It is OFFERED the consignment, accepts or refuses it, and puts one of its
 *   own drivers on it. The seller never touches the driver.
 *
 *   AN OUTSIDE CARRIER - DHL, FedEx, India Post. It is not on this platform
 *   and has no portal here. Without an API account, the seller books it on
 *   the carrier's own site or at a counter, and this system RECORDS what they
 *   arranged: the service, the collection reference, the carrier's own
 *   waybill number. It books nothing, prints no label, quotes no rate and
 *   never invents a tracking number - and every view of it says so.
 *
 * WHAT IS CHECKED, EVERY TIME, IN THIS ORDER
 *
 *   1. Ownership, from the session: the consignment is loaded
 *      `WHERE sellerAccountId = <session>`, so another seller's consignment is
 *      a 404 that confirms nothing.
 *   2. The seller has CONFIRMED their part. Nobody is asked to carry an order
 *      the seller may still refuse.
 *   3. The carrier does not have the goods yet. After collection, moving the
 *      consignment is a chain-of-custody event for the carrier and the
 *      marketplace, not a dropdown on the seller's screen.
 *   4. The choice is eligible, decided by the same functions that built the
 *      seller's list - so a choice shown as available cannot be refused, and
 *      one shown as unavailable cannot be smuggled through by editing the page.
 *
 * ONE LIVE CARRIER AT A TIME. A consignment holds either one live offer to a
 * delivery company or one live hand-made booking, never both and never two of
 * either. Switching between them is a reassignment: it needs a reason, the
 * loser is told, and the old row stays - "why did two carriers have this
 * parcel?" is asked after a late delivery.
 */
import type {
  CarrierProvider,
  LogisticsDocumentKind,
  LogisticsShipmentStatus,
} from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  assertShipmentTransition,
  isTrackingComplete,
  type ShipmentStatusName,
} from '../../domain/logistics-shipment-state.js';
import {
  logisticsStage,
  sellerHasConfirmed,
  sellerMayReassign,
  type LogisticsStage,
} from '../../domain/logistics-stage.js';
import {
  canSellerOfferToCarrier,
  explainSellerCarrierRefusal,
  type SellerCarrierRefusal,
} from '../../domain/seller-logistics.js';
import {
  carrierFromMethodKey,
  carrierSetupStatus,
  hasVerifiedOfficialApi,
  type CarrierSetupStatus,
} from '../../domain/seller-fulfilment.js';
import { maskPersonName } from '../../domain/logistics-masking.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import {
  announceOffer,
  announceWithdrawal,
  consignmentLoadType,
  findEligiblePartners,
  offerAssignmentInTransaction,
  resolveUnassignedConsignmentAlert,
  withdrawAssignmentInTransaction,
  type OfferOutcome,
  type WithdrawalOutcome,
} from '../logistics/assignment.service.js';
import { storeShipmentFile } from '../logistics/document.service.js';
import {
  appendEventInTransaction,
  recordShipmentEvent,
} from '../logistics/shipment-event.service.js';
import { recordSellerAudit } from './audit.service.js';
import {
  notifyCarrierBookingIncomplete,
  notifyConsignmentNeedsCarrier,
  resolveCarrierBookingIncomplete,
  resolveConsignmentUnassigned,
} from './carrier-notification.service.js';
import { resolveConsignmentMethodAlert } from './fulfilment-notification.service.js';

// ---------------------------------------------------------------------------
// The outside carriers
// ---------------------------------------------------------------------------

/** The carriers a seller can book by hand. */
export const MANUAL_CARRIERS = Object.freeze(['DHL', 'FEDEX', 'INDIA_POST'] as const);
export type ManualCarrierProvider = (typeof MANUAL_CARRIERS)[number];

export function isManualCarrierProvider(value: string): value is ManualCarrierProvider {
  return (MANUAL_CARRIERS as readonly string[]).includes(value);
}

/** The carrier's name as the carrier writes it. Never translated. */
export const MANUAL_CARRIER_NAMES: Readonly<Record<ManualCarrierProvider, string>> = Object.freeze({
  DHL: 'DHL',
  FEDEX: 'FedEx',
  INDIA_POST: 'India Post',
});

/**
 * The carrier's OWN public tracking page for a number.
 *
 * Not tracking: a link to where the carrier shows its tracking. Nothing here
 * reads it, polls it or claims to know what it says. India Post's page takes
 * no number in its address, so its link opens the page and the seller or
 * buyer types the number in - which is the truth about that page.
 */
export function carrierTrackingPageUrl(
  provider: ManualCarrierProvider,
  trackingNumber: string,
): string {
  const number = encodeURIComponent(trackingNumber);

  switch (provider) {
    case 'DHL':
      return `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${number}`;
    case 'FEDEX':
      return `https://www.fedex.com/fedextrack/?trknbr=${number}`;
    case 'INDIA_POST':
      return 'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx';
  }
}

/**
 * A carrier's waybill number, as typed.
 *
 * Deliberately loose. DHL, FedEx and India Post each have their own formats
 * and change them, and a validator strict enough to reject a real number is
 * worse than one that lets a typo through - the typo is visible on the screen
 * beside a link to check it. What this does refuse is the obviously not-a-
 * number: spaces inside, punctuation, anything under six characters.
 */
const TRACKING_NUMBER = /^[A-Za-z0-9-]{6,40}$/;

// ---------------------------------------------------------------------------
// Loading a consignment, owned
// ---------------------------------------------------------------------------

const CONSIGNMENT_SELECT = {
  id: true,
  shipmentReference: true,
  status: true,
  version: true,
  orderId: true,
  sellerAccountId: true,
  sellerOrderGroupId: true,
  assignedPartnerId: true,
  originCountry: true,
  destinationCountry: true,
  destinationCity: true,
  destinationPostalCode: true,
  pickupAddressJson: true,
  pickupContactName: true,
  packageCount: true,
  totalWeightGrams: true,
  requiresColdChain: true,
  requiresTemperatureRange: true,
  requiresSterileHandling: true,
  isDangerousGoods: true,
  isFragile: true,
  handlingNotes: true,
  expectedPickupAt: true,
  pickupDueAt: true,
  estimatedDeliveryAt: true,
  deliveryDueAt: true,
  carrierTrackingNumber: true,
  carrierTrackingUrl: true,
  currency: true,
  sellerOrderGroup: { select: { id: true, status: true, sellerOrderNumber: true, currency: true } },
  packages: {
    orderBy: { sequence: 'asc' as const },
    select: {
      sequence: true,
      weightGrams: true,
      lengthMm: true,
      widthMm: true,
      heightMm: true,
      packagingType: true,
    },
  },
} as const;

type LoadedConsignment = NonNullable<
  Awaited<ReturnType<typeof loadOwnedConsignment>>
>;

/**
 * The consignment, filtered by the session's seller.
 *
 * `null` is the MARKETPLACE's scope and is passed only by the admin routes,
 * which sit behind `logistics.read`. No seller route can produce it: they
 * pass `currentSeller(request).sellerAccountId`, which is never null.
 */
async function loadOwnedConsignment(
  client: PrismaTransaction | typeof prisma,
  sellerAccountId: string | null,
  shipmentId: string,
) {
  return client.logisticsShipment.findFirst({
    where: sellerAccountId === null ? { id: shipmentId } : { id: shipmentId, sellerAccountId },
    select: CONSIGNMENT_SELECT,
  });
}

async function requireOwnedConsignment(
  client: PrismaTransaction | typeof prisma,
  sellerAccountId: string | null,
  shipmentId: string,
): Promise<LoadedConsignment> {
  const consignment = await loadOwnedConsignment(client, sellerAccountId, shipmentId);
  if (consignment === null) throw notFound('Consignment');
  return consignment;
}

/** Why a seller cannot hand this consignment to anybody right now, if they cannot. */
export type AssignBlock = 'SELLER_ORDER_NOT_CONFIRMED' | 'COLLECTED' | 'FINISHED' | null;

function assignBlockFor(consignment: {
  status: LogisticsShipmentStatus;
  sellerOrderGroup: { status: string } | null;
}): AssignBlock {
  if (isTrackingComplete(consignment.status) || consignment.status === 'RETURNED') return 'FINISHED';
  if (consignment.sellerOrderGroup === null || !sellerHasConfirmed(consignment.sellerOrderGroup.status)) {
    return 'SELLER_ORDER_NOT_CONFIRMED';
  }
  if (!sellerMayReassign(consignment.status)) return 'COLLECTED';
  return null;
}

/** The three gates, as refusals a seller can act on. */
function assertAssignable(consignment: LoadedConsignment): void {
  const block = assignBlockFor(consignment);

  if (block === 'FINISHED') {
    throw conflict(
      ErrorCode.LOGISTICS_SHIPMENT_TERMINAL,
      `Consignment ${consignment.shipmentReference} is already finished.`,
    );
  }

  if (block === 'SELLER_ORDER_NOT_CONFIRMED') {
    throw conflict(
      ErrorCode.SELLER_ORDER_NOT_CONFIRMED,
      'Confirm this order before you assign anybody to carry it.',
      [{ code: 'SELLER_ORDER_NOT_CONFIRMED', meta: { status: consignment.sellerOrderGroup?.status ?? null } }],
    );
  }

  if (block === 'COLLECTED') {
    throw conflict(
      ErrorCode.CONSIGNMENT_REASSIGNMENT_LOCKED,
      `The carrier already has consignment ${consignment.shipmentReference}. Only they or the marketplace can move it now.`,
      [{ code: 'CONSIGNMENT_REASSIGNMENT_LOCKED', meta: { status: consignment.status } }],
    );
  }
}

// ---------------------------------------------------------------------------
// What the seller sees about one consignment
// ---------------------------------------------------------------------------

export interface ConsignmentAssignmentHistoryEntry {
  kind: 'PARTNER' | 'MANUAL_CARRIER';
  carrierName: string;
  state: string;
  at: string;
  /** A refusal's, withdrawal's or cancellation's reason. */
  reason: string | null;
}

export interface ManualBookingView {
  id: string;
  provider: ManualCarrierProvider;
  carrierName: string;
  status: 'BOOKING_REQUIRED' | 'BOOKED';
  serviceName: string | null;
  pickupReference: string | null;
  carrierTrackingNumber: string | null;
  trackingPageUrl: string | null;
  expectedPickupAt: string | null;
  expectedDeliveryAt: string | null;
  /** Minor units as a string. Never a number. */
  shippingCostMinor: string | null;
  currency: string | null;
  createdAt: string;
  bookedAt: string | null;
}

export interface ConsignmentLogisticsState {
  id: string;
  reference: string;
  status: ShipmentStatusName;
  stage: LogisticsStage;
  /** Who is carrying it, and how. */
  mode: 'NONE' | 'PARTNER' | 'MANUAL_CARRIER';
  canAssign: boolean;
  assignBlock: AssignBlock;
  partner: {
    id: string;
    displayName: string;
    assignmentState: string;
    respondBy: string | null;
  } | null;
  manualBooking: ManualBookingView | null;
  /**
   * Whether the carrier has put a driver on it, and a masked name.
   *
   * The seller sees THAT a driver is on it and a given name with an initial,
   * which is what a seller needs to recognise the person at their door. Not
   * the driver's phone, not their surname, and never a control over them.
   */
  driver: { isAssigned: boolean; maskedName: string | null };
  /** The carrier's OWN number: typed in by hand, or returned by a carrier API. */
  carrierTrackingNumber: string | null;
  trackingPageUrl: string | null;
  history: ConsignmentAssignmentHistoryEntry[];
}

/**
 * The logistics state of every consignment on one seller order.
 *
 * Ownership has already been settled by the caller, which loaded the order
 * group filtered by the session's seller; this is still filtered by seller
 * as well, because a second lock costs one column.
 */
export async function consignmentStatesForGroup(
  sellerAccountId: string,
  sellerOrderGroupId: string,
): Promise<ConsignmentLogisticsState[]> {
  const rows = await prisma.logisticsShipment.findMany({
    where: { sellerAccountId, sellerOrderGroupId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  return Promise.all(rows.map((row) => consignmentState(sellerAccountId, row.id)));
}

export async function consignmentState(
  sellerAccountId: string | null,
  shipmentId: string,
): Promise<ConsignmentLogisticsState> {
  const consignment = await requireOwnedConsignment(prisma, sellerAccountId, shipmentId);

  const [assignments, bookings, driver] = await Promise.all([
    prisma.logisticsShipmentAssignment.findMany({
      where: { shipmentId },
      orderBy: { offeredAt: 'desc' },
      select: {
        state: true,
        offeredAt: true,
        respondedAt: true,
        respondBy: true,
        responseReason: true,
        withdrawnAt: true,
        withdrawnReason: true,
        logisticsPartnerId: true,
        partner: { select: { displayName: true } },
      },
    }),
    prisma.sellerManualCarrierBooking.findMany({
      where: sellerAccountId === null ? { shipmentId } : { shipmentId, sellerAccountId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.logisticsDriverAssignment.findFirst({
      where: { activeShipmentId: shipmentId },
      select: { driver: { select: { fullName: true } } },
    }),
  ]);

  const liveAssignment =
    assignments.find((row) => row.state === 'OFFERED' || row.state === 'ACCEPTED') ?? null;
  const liveBooking = bookings.find((row) => row.activeShipmentId !== null) ?? null;

  const stage = logisticsStage({
    shipmentStatus: consignment.status,
    latestAssignmentState: assignments[0]?.state ?? null,
    hasActiveDriver: driver !== null,
    manualBookingStatus:
      liveBooking === null || liveBooking.status === 'CANCELLED' ? null : liveBooking.status,
  });

  const block = assignBlockFor(consignment);

  const history: ConsignmentAssignmentHistoryEntry[] = [
    ...assignments.map((row) => ({
      kind: 'PARTNER' as const,
      carrierName: row.partner.displayName,
      state: row.state,
      at: (row.withdrawnAt ?? row.respondedAt ?? row.offeredAt).toISOString(),
      reason: row.withdrawnReason ?? row.responseReason,
    })),
    ...bookings.map((row) => ({
      kind: 'MANUAL_CARRIER' as const,
      carrierName: isManualCarrierProvider(row.provider)
        ? MANUAL_CARRIER_NAMES[row.provider]
        : row.provider,
      state: row.status,
      at: (row.cancelledAt ?? row.bookedAt ?? row.createdAt).toISOString(),
      reason: row.cancelledReason,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    id: consignment.id,
    reference: consignment.shipmentReference,
    status: consignment.status,
    stage,
    mode: liveAssignment !== null ? 'PARTNER' : liveBooking !== null ? 'MANUAL_CARRIER' : 'NONE',
    canAssign: block === null,
    assignBlock: block,
    partner:
      liveAssignment === null
        ? null
        : {
            id: liveAssignment.logisticsPartnerId,
            displayName: liveAssignment.partner.displayName,
            assignmentState: liveAssignment.state,
            respondBy: liveAssignment.respondBy?.toISOString() ?? null,
          },
    manualBooking: liveBooking === null ? null : bookingView(liveBooking),
    driver: {
      isAssigned: driver !== null,
      maskedName: driver === null ? null : maskPersonName(driver.driver.fullName),
    },
    carrierTrackingNumber: consignment.carrierTrackingNumber,
    trackingPageUrl: consignment.carrierTrackingUrl,
    history,
  };
}

function bookingView(row: {
  id: string;
  provider: CarrierProvider;
  status: 'BOOKING_REQUIRED' | 'BOOKED' | 'CANCELLED';
  serviceName: string | null;
  pickupReference: string | null;
  carrierTrackingNumber: string | null;
  expectedPickupAt: Date | null;
  expectedDeliveryAt: Date | null;
  shippingCostMinor: bigint | null;
  currency: string | null;
  createdAt: Date;
  bookedAt: Date | null;
}): ManualBookingView | null {
  if (!isManualCarrierProvider(row.provider) || row.status === 'CANCELLED') return null;

  return {
    id: row.id,
    provider: row.provider,
    carrierName: MANUAL_CARRIER_NAMES[row.provider],
    status: row.status,
    serviceName: row.serviceName,
    pickupReference: row.pickupReference,
    carrierTrackingNumber: row.carrierTrackingNumber,
    trackingPageUrl:
      row.carrierTrackingNumber === null
        ? null
        : carrierTrackingPageUrl(row.provider, row.carrierTrackingNumber),
    expectedPickupAt: row.expectedPickupAt?.toISOString() ?? null,
    expectedDeliveryAt: row.expectedDeliveryAt?.toISOString() ?? null,
    shippingCostMinor: row.shippingCostMinor?.toString() ?? null,
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
    bookedAt: row.bookedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// The choices, with their reasons
// ---------------------------------------------------------------------------

export interface ConsignmentSummary {
  id: string;
  reference: string;
  sellerOrderNumber: string | null;
  origin: { city: string | null; countryCode: string; contactName: string | null };
  destination: { city: string | null; postalCode: string | null; countryCode: string };
  loadType: 'PARCEL' | 'CARTON' | 'PALLET' | 'FCL' | 'LCL';
  packageCount: number;
  totalWeightGrams: number;
  packages: {
    sequence: number;
    weightGrams: number;
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    packagingType: string | null;
  }[];
  pickupBy: string | null;
  deliverBy: string | null;
  handling: {
    coldChain: boolean;
    temperatureControlled: boolean;
    sterile: boolean;
    dangerousGoods: boolean;
    fragile: boolean;
    notes: string | null;
  };
}

/** One delivery company on this platform, and whether it can take this one. */
export interface PartnerOption {
  logisticsPartnerId: string;
  displayName: string;
  partnerCode: string;
  relationshipType: string;
  isEligible: boolean;
  /** The arrangement's refusal, where that is what stops it. */
  refusal: SellerCarrierRefusal | null;
  /**
   * The carrier's own serviceability, where that is what stops it: coverage,
   * approved capabilities, capacity, load type. Codes, translated on screen.
   */
  serviceability: string[];
  /** The whole reason in English, for logs and for a screen with no mapping. */
  reason: string | null;
}

/** DHL, FedEx or India Post, and how they can be used for this one. */
export interface ManualCarrierOption {
  provider: ManualCarrierProvider;
  name: string;
  isAvailable: boolean;
  /**
   * What the seller should know, as codes: API_CREDENTIALS_REQUIRED,
   * NO_OFFICIAL_API, MANUAL_BOOKING_AVAILABLE, ORIGIN_NOT_SERVED,
   * PALLETS_NOT_CARRIED, CONTAINERS_NOT_CARRIED, FREIGHT_SERVICE_REQUIRED.
   */
  notes: string[];
  setupStatus: CarrierSetupStatus;
  /**
   * True only when the seller's own API connection is live. Even then this
   * screen does not book through it - buying a label is its own step, with
   * its own price shown first - but it is the honest answer to "could this
   * be automatic?".
   */
  automaticBookingAvailable: boolean;
}

export interface ConsignmentLogisticsOptions {
  consignment: ConsignmentSummary;
  state: ConsignmentLogisticsState;
  partners: PartnerOption[];
  carriers: ManualCarrierOption[];
}

function pickupCity(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const city = (value as Record<string, unknown>)['city'];
  return typeof city === 'string' && city.trim().length > 0 ? city.trim() : null;
}

/**
 * Everything the "Assign logistics partner" screen shows, in one call.
 *
 * Lists the partners that CANNOT take this consignment as well as those that
 * can, each with its reason, and the three outside carriers with what using
 * each one would actually involve. An empty list cannot tell "you have no
 * carriers" from "yours does not reach Portugal", and those are different
 * next actions.
 */
export async function logisticsOptionsForConsignment(
  sellerAccountId: string,
  shipmentId: string,
  now: Date = new Date(),
): Promise<ConsignmentLogisticsOptions> {
  const consignment = await requireOwnedConsignment(prisma, sellerAccountId, shipmentId);
  const loadType = await consignmentLoadType(consignment.sellerOrderGroupId);

  const [state, links, serviceability, methods] = await Promise.all([
    consignmentState(sellerAccountId, shipmentId),
    prisma.sellerLogisticsPartner.findMany({
      where: { sellerAccountId, archivedAt: null },
      include: {
        logisticsPartner: {
          select: { id: true, displayName: true, partnerCode: true, status: true, archivedAt: true },
        },
      },
    }),
    findEligiblePartners(shipmentId),
    prisma.sellerFulfilmentMethod.findMany({
      where: { sellerAccountId, mode: 'INTEGRATED_CARRIER', archivedAt: null },
      select: {
        methodKey: true,
        carrierConnection: {
          select: {
            state: true,
            lastTestAt: true,
            lastTestPassedAt: true,
            credential: { select: { id: true } },
          },
        },
      },
    }),
  ]);

  const facts = {
    originCountry: consignment.originCountry,
    destinationCountry: consignment.destinationCountry,
    requiredCapabilities: sellerRequiredCapabilities(consignment),
  };

  const byPartner = new Map(serviceability.map((row) => [row.id, row]));

  const partners: PartnerOption[] = links.map((link) => {
    const verdict = canSellerOfferToCarrier(
      {
        status: link.status,
        effectiveFrom: link.effectiveFrom,
        effectiveTo: link.effectiveTo,
        archivedAt: link.archivedAt,
        serviceCountries: stringList(link.serviceCountriesJson),
        approvedCapabilities: stringList(link.approvedCapabilitiesJson),
      },
      { status: link.logisticsPartner.status, archivedAt: link.logisticsPartner.archivedAt },
      facts,
      now,
    );

    // The carrier's own reach and approvals. A partner the operator's picker
    // would not offer this consignment to is not offered it by a seller
    // either: an arrangement narrows what a carrier may do, never widens it.
    // A partner absent from the operator's list is not active at all.
    const operatorView = byPartner.get(link.logisticsPartnerId);
    const serviceCodes = verdict.allowed
      ? (operatorView?.reasons ?? ['PARTNER_NOT_ACTIVE']).filter((code) => code !== 'SUSPENDED')
      : [];

    const refusal = verdict.allowed ? null : verdict.refusal;
    const isEligible = refusal === null && serviceCodes.length === 0;

    return {
      logisticsPartnerId: link.logisticsPartnerId,
      displayName: link.logisticsPartner.displayName,
      partnerCode: link.logisticsPartner.partnerCode,
      relationshipType: link.relationshipType,
      isEligible,
      refusal,
      serviceability: serviceCodes,
      reason: isEligible
        ? null
        : refusal !== null
          ? explainSellerCarrierRefusal(refusal, link.logisticsPartner.displayName)
          : explainServiceability(serviceCodes, link.logisticsPartner.displayName),
    };
  });

  const carriers: ManualCarrierOption[] = MANUAL_CARRIERS.map((provider) => {
    const method = methods.find(
      (row) => carrierFromMethodKey(row.methodKey)?.provider === provider,
    );
    const setupStatus = carrierSetupStatus({
      provider,
      connection:
        method?.carrierConnection === null || method?.carrierConnection === undefined
          ? null
          : {
              state: method.carrierConnection.state,
              hasCredential: method.carrierConnection.credential !== null,
              lastTestAt: method.carrierConnection.lastTestAt,
              lastTestPassedAt: method.carrierConnection.lastTestPassedAt,
            },
    });

    const notes: string[] = [];
    let isAvailable = true;

    if (!hasVerifiedOfficialApi(provider)) notes.push('NO_OFFICIAL_API');
    else if (setupStatus !== 'CONNECTED') notes.push('API_CREDENTIALS_REQUIRED');

    if (provider === 'INDIA_POST') {
      // India Post collects inside India. Its international service delivers
      // abroad; it does not collect abroad.
      if (consignment.originCountry !== 'IN') {
        notes.push('ORIGIN_NOT_SERVED');
        isAvailable = false;
      }
      if (loadType === 'PALLET') {
        notes.push('PALLETS_NOT_CARRIED');
        isAvailable = false;
      }
      if (loadType === 'FCL' || loadType === 'LCL') {
        notes.push('CONTAINERS_NOT_CARRIED');
        isAvailable = false;
      }
    } else if (loadType === 'PALLET' || loadType === 'FCL' || loadType === 'LCL') {
      // Their parcel services will not take it; their freight arms will. The
      // seller books whichever it is, and should know which to ask for.
      notes.push('FREIGHT_SERVICE_REQUIRED');
    }

    if (isAvailable) notes.push('MANUAL_BOOKING_AVAILABLE');

    return {
      provider,
      name: MANUAL_CARRIER_NAMES[provider],
      isAvailable,
      notes,
      setupStatus,
      automaticBookingAvailable: setupStatus === 'CONNECTED',
    };
  });

  return {
    consignment: {
      id: consignment.id,
      reference: consignment.shipmentReference,
      sellerOrderNumber: consignment.sellerOrderGroup?.sellerOrderNumber ?? null,
      origin: {
        city: pickupCity(consignment.pickupAddressJson),
        countryCode: consignment.originCountry,
        contactName: consignment.pickupContactName,
      },
      destination: {
        city: consignment.destinationCity,
        postalCode: consignment.destinationPostalCode,
        countryCode: consignment.destinationCountry,
      },
      loadType,
      packageCount: consignment.packageCount,
      totalWeightGrams: consignment.totalWeightGrams,
      packages: consignment.packages,
      pickupBy: (consignment.pickupDueAt ?? consignment.expectedPickupAt)?.toISOString() ?? null,
      deliverBy: (consignment.deliveryDueAt ?? consignment.estimatedDeliveryAt)?.toISOString() ?? null,
      handling: {
        coldChain: consignment.requiresColdChain,
        temperatureControlled: consignment.requiresTemperatureRange,
        sterile: consignment.requiresSterileHandling,
        dangerousGoods: consignment.isDangerousGoods,
        fragile: consignment.isFragile,
        notes: consignment.handlingNotes,
      },
    },
    state,
    partners,
    carriers,
  };
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === 0 ? null : entries;
}

/** The same derivation the operator's picker uses. */
function sellerRequiredCapabilities(shipment: {
  requiresColdChain: boolean;
  requiresTemperatureRange: boolean;
  requiresSterileHandling: boolean;
  isDangerousGoods: boolean;
  originCountry: string;
  destinationCountry: string;
}): string[] {
  const needed: string[] = [];
  if (shipment.requiresColdChain) needed.push('COLD_CHAIN_2_8');
  if (shipment.requiresTemperatureRange) needed.push('TEMPERATURE_CONTROLLED');
  if (shipment.requiresSterileHandling) needed.push('STERILE_HANDLING');
  if (shipment.isDangerousGoods) needed.push('DANGEROUS_GOODS');
  if (shipment.originCountry !== shipment.destinationCountry) needed.push('INTERNATIONAL');
  return needed;
}

/** The serviceability codes in one English sentence. */
export function explainServiceability(codes: readonly string[], carrierName: string): string {
  const first = codes[0] ?? '';

  if (first === 'PARTNER_NOT_ACTIVE') return `${carrierName}'s account is not active.`;
  if (first === 'NO_COVERAGE_ORIGIN' || first === 'NO_COVERAGE_DESTINATION') {
    return `${carrierName} does not serve this route.`;
  }
  if (first === 'AT_CAPACITY') return `${carrierName} is at capacity.`;
  if (first === 'CONTAINER_NOT_SUPPORTED') return `${carrierName} does not carry containers.`;
  if (first === 'MISSING_CAPABILITY:PALLET') return `${carrierName} is not approved for pallets.`;
  if (first.startsWith('MISSING_CAPABILITY:')) {
    return `${carrierName} is not approved for the handling this consignment needs.`;
  }
  return `${carrierName} cannot take this consignment.`;
}

// ---------------------------------------------------------------------------
// Offering it to a delivery company on the platform
// ---------------------------------------------------------------------------

export interface AssignPartnerInput {
  actor: SellerLogisticsActor;
  shipmentId: string;
  logisticsPartnerId: string;
  /** Required when this replaces a carrier or a hand-made booking. */
  reason?: string | null;
  correlationId?: string | null;
}

export interface SellerLogisticsActor {
  sellerAccountId: string;
  /** The team member acting. Recorded, never used for authorisation. */
  memberId: string | null;
  /** How they are named in the trail. */
  label: string;
}

/**
 * Offer the consignment to a delivery company on this platform.
 *
 * IDEMPOTENT: asking again for the carrier that already has it returns that
 * offer and changes nothing - which is what a double-click, a retried request
 * and two tabs all need.
 *
 * ATOMIC: displacing the incumbent - a carrier or a hand-made booking - and
 * making the new offer happen in ONE transaction. If the offer cannot be made
 * the incumbent keeps the consignment. The version guard on the consignment
 * row is what makes two concurrent requests safe: the second sees a changed
 * row and is told to try again, and never produces two live offers.
 */
export async function assignPartnerToConsignment(
  input: AssignPartnerInput,
  attempt = 1,
): Promise<{
  assignmentId: string;
  respondBy: Date | null;
  replacedPartnerId: string | null;
  replacedManualBookingId: string | null;
  idempotent: boolean;
}> {
  const { actor } = input;
  const consignment = await requireOwnedConsignment(prisma, actor.sellerAccountId, input.shipmentId);

  // Idempotent before anything else: a repeat of a request that already
  // worked is answered with its result, whatever has changed about the
  // screen it came from.
  const live = await prisma.logisticsShipmentAssignment.findFirst({
    where: { shipmentId: consignment.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
    select: { id: true, logisticsPartnerId: true, respondBy: true },
  });

  if (live !== null && live.logisticsPartnerId === input.logisticsPartnerId) {
    return {
      assignmentId: live.id,
      respondBy: live.respondBy,
      replacedPartnerId: null,
      replacedManualBookingId: null,
      idempotent: true,
    };
  }

  assertAssignable(consignment);

  const options = await logisticsOptionsForConsignment(actor.sellerAccountId, consignment.id);
  const choice = options.partners.find((row) => row.logisticsPartnerId === input.logisticsPartnerId);

  // A carrier this seller has no arrangement with and a carrier that does not
  // exist are answered identically, so this cannot enumerate the marketplace's
  // carrier list.
  if (choice === undefined) {
    throw badRequest(
      ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE,
      'You are not set up to use that carrier. Request them from your carriers page first.',
      [{ field: 'logisticsPartnerId', code: ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE }],
    );
  }

  if (!choice.isEligible) {
    throw badRequest(
      ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE,
      choice.reason ?? `${choice.displayName} cannot take this consignment.`,
      [
        {
          field: 'logisticsPartnerId',
          code: ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE,
          meta: { refusal: choice.refusal, serviceability: choice.serviceability.join(",") },
        },
      ],
    );
  }

  const liveBooking = await prisma.sellerManualCarrierBooking.findUnique({
    where: { activeShipmentId: consignment.id },
    select: { id: true, provider: true },
  });

  const replacing = live !== null || liveBooking !== null;
  const reason = input.reason?.trim() ?? '';

  if (replacing && reason.length < 4) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Say why you are moving this consignment to a different carrier.',
      [{ field: 'reason', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  let outcome: { offered: OfferOutcome; withdrawn: WithdrawalOutcome | null; cancelledBookingId: string | null };

  try {
    outcome = await prisma.$transaction(async (tx) => {
      const withdrawn =
        live === null
          ? null
          : await withdrawAssignmentInTransaction(tx, {
              shipmentId: consignment.id,
              reason,
              actorUserId: null,
              actorLabel: `Seller: ${actor.label}`,
              ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
            });

      const cancelledBookingId =
        liveBooking === null
          ? null
          : await cancelBookingInTransaction(tx, {
              actor,
              shipmentId: consignment.id,
              bookingId: liveBooking.id,
              reason,
            });

      const offered = await offerAssignmentInTransaction(tx, {
        shipmentId: consignment.id,
        logisticsPartnerId: input.logisticsPartnerId,
        // Null, because no member of the marketplace's staff did this. The
        // seller is named in the audit row below.
        offeredByUserId: null,
        automatic: false,
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      });

      return { offered, withdrawn, cancelledBookingId };
    });
  } catch (error) {
    // Two requests for the same carrier racing each other: the loser finds the
    // winner's offer and returns it, rather than reporting a failure of
    // something that worked.
    const winner = await prisma.logisticsShipmentAssignment.findFirst({
      where: {
        shipmentId: consignment.id,
        logisticsPartnerId: input.logisticsPartnerId,
        state: { in: ['OFFERED', 'ACCEPTED'] },
      },
      select: { id: true, respondBy: true },
    });

    if (winner !== null) {
      return {
        assignmentId: winner.id,
        respondBy: winner.respondBy,
        replacedPartnerId: null,
        replacedManualBookingId: null,
        idempotent: true,
      };
    }

    /*
     * The winner may not have committed yet: MariaDB answers the loser of a
     * row-lock race with a deadlock, and the version guard with a conflict,
     * before the winner's commit is visible. Wait a moment and ask again from
     * the top - which then finds the winner's offer and answers idempotently,
     * or, if the other request was for somebody else, refuses properly.
     */
    if (attempt < 3 && isRaceLoss(error)) {
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt));
      return assignPartnerToConsignment(input, attempt + 1);
    }

    throw error;
  }

  // After the commit: nobody is told about something that then rolled back.
  if (outcome.withdrawn !== null) await announceWithdrawal(outcome.withdrawn);
  await announceOffer(outcome.offered);

  await recordSellerAudit({
    sellerAccountId: actor.sellerAccountId,
    action: replacing ? 'seller.carrier.reassigned' : 'seller.carrier.assigned',
    actor: { type: 'CUSTOMER', label: actor.label },
    resourceType: 'logistics_shipment',
    resourceId: consignment.id,
    before:
      live !== null
        ? { logisticsPartnerId: live.logisticsPartnerId }
        : liveBooking !== null
          ? { manualCarrier: liveBooking.provider }
          : null,
    after: {
      logisticsPartnerId: input.logisticsPartnerId,
      assignmentId: outcome.offered.assignmentId,
    },
    summary: replacing
      ? `Moved consignment ${consignment.shipmentReference} to ${outcome.offered.partnerName}. ${reason}`
      : `Offered consignment ${consignment.shipmentReference} to ${outcome.offered.partnerName}.`,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });

  // The seller has acted, so the parcel is no longer nobody's.
  await resolveConsignmentUnassigned({
    shipmentId: consignment.id,
    carrierName: outcome.offered.partnerName,
  });
  await resolveConsignmentMethodAlert(consignment.id);
  if (outcome.cancelledBookingId !== null) {
    await resolveCarrierBookingIncomplete({
      shipmentId: consignment.id,
      note: `Moved to ${outcome.offered.partnerName}.`,
    });
  }

  return {
    assignmentId: outcome.offered.assignmentId,
    respondBy: outcome.offered.respondBy,
    replacedPartnerId: live?.logisticsPartnerId ?? null,
    replacedManualBookingId: outcome.cancelledBookingId,
    idempotent: false,
  };
}

/** A transaction that lost a race with another request on the same consignment. */
function isRaceLoss(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'P2034' || code === 'P2002') return true;
  const details = (error as { details?: { code?: string }[] }).details;
  return (
    code === ErrorCode.CONFLICT && Array.isArray(details) && details.some((d) => d.code === 'VERSION_CONFLICT')
  ) || code === ErrorCode.SHIPMENT_ASSIGNMENT_SETTLED;
}

/**
 * Take the consignment back from whoever has it, without choosing anybody new.
 *
 * Before collection only, with a reason. The carrier that loses the work is
 * told, and its assignment row stays in the history.
 */
export async function withdrawConsignmentCarrier(input: {
  actor: SellerLogisticsActor;
  shipmentId: string;
  reason: string;
  correlationId?: string | null;
}): Promise<ConsignmentLogisticsState> {
  const { actor } = input;
  const consignment = await requireOwnedConsignment(prisma, actor.sellerAccountId, input.shipmentId);
  assertAssignable(consignment);

  const reason = input.reason.trim();
  if (reason.length < 4) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why you are taking this consignment back.', [
      { field: 'reason', code: ErrorCode.VALIDATION_FAILED },
    ]);
  }

  const [live, liveBooking] = await Promise.all([
    prisma.logisticsShipmentAssignment.findFirst({
      where: { shipmentId: consignment.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
      select: { id: true, partner: { select: { displayName: true } } },
    }),
    prisma.sellerManualCarrierBooking.findUnique({
      where: { activeShipmentId: consignment.id },
      select: { id: true, provider: true },
    }),
  ]);

  if (live === null && liveBooking === null) {
    throw conflict(ErrorCode.SHIPMENT_ASSIGNMENT_SETTLED, 'Nobody is carrying this consignment.');
  }

  const withdrawn = await prisma.$transaction(async (tx) => {
    const result =
      live === null
        ? null
        : await withdrawAssignmentInTransaction(tx, {
            shipmentId: consignment.id,
            reason,
            actorUserId: null,
            actorLabel: `Seller: ${actor.label}`,
            ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
          });

    if (liveBooking !== null) {
      await cancelBookingInTransaction(tx, {
        actor,
        shipmentId: consignment.id,
        bookingId: liveBooking.id,
        reason,
      });
    }

    return result;
  });

  if (withdrawn !== null) await announceWithdrawal(withdrawn);
  if (liveBooking !== null) {
    await resolveCarrierBookingIncomplete({ shipmentId: consignment.id, note: 'Booking cancelled.' });
  }

  await recordSellerAudit({
    sellerAccountId: actor.sellerAccountId,
    action: 'seller.carrier.withdrawn',
    actor: { type: 'CUSTOMER', label: actor.label },
    resourceType: 'logistics_shipment',
    resourceId: consignment.id,
    summary: `Took consignment ${consignment.shipmentReference} back from ${
      live?.partner.displayName ??
      (liveBooking !== null && isManualCarrierProvider(liveBooking.provider)
        ? MANUAL_CARRIER_NAMES[liveBooking.provider]
        : 'its carrier')
    }. ${reason}`,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });

  // Nobody has it again, and the seller is the one who has to fix that.
  await notifyConsignmentNeedsCarrier({
    shipmentId: consignment.id,
    sellerOrderGroupId: consignment.sellerOrderGroupId,
    sellerOrderNumber: consignment.sellerOrderGroup?.sellerOrderNumber ?? null,
  });

  return consignmentState(actor.sellerAccountId, consignment.id);
}

// ---------------------------------------------------------------------------
// Booking an outside carrier by hand
// ---------------------------------------------------------------------------

/**
 * Move a consignment's status inside somebody's transaction, as the seller.
 *
 * Checked against the state machine with the SELLER actor - unlike the
 * assignment service's own helper, which trusts its callers - and guarded on
 * the version read, so a concurrent change makes this fail rather than
 * overwrite it.
 */
async function moveAsSeller(
  tx: PrismaTransaction,
  params: {
    shipmentId: string;
    to: ShipmentStatusName;
    publicDescription: string;
    internalNote?: string | null;
    reason?: string | null;
    data?: {
      carrierTrackingNumber?: string | null;
      carrierTrackingUrl?: string | null;
      expectedPickupAt?: Date | null;
      estimatedDeliveryAt?: Date | null;
    };
  },
): Promise<void> {
  const current = await tx.logisticsShipment.findUniqueOrThrow({
    where: { id: params.shipmentId },
    select: { status: true, version: true },
  });

  assertShipmentTransition({
    from: current.status,
    to: params.to,
    actor: 'SELLER',
    ...(params.reason === undefined || params.reason === null ? {} : { reason: params.reason }),
  });

  const now = new Date();

  const updated = await tx.logisticsShipment.updateMany({
    where: { id: params.shipmentId, version: current.version },
    data: {
      status: params.to,
      lastEventAt: now,
      version: { increment: 1 },
      ...(params.data ?? {}),
    },
  });

  if (updated.count !== 1) {
    throw conflict(
      ErrorCode.CONFLICT,
      'This consignment was changed by somebody else a moment ago. Reload and try again.',
      [{ code: 'VERSION_CONFLICT' }],
    );
  }

  await appendEventInTransaction(tx, {
    shipmentId: params.shipmentId,
    from: current.status,
    to: params.to,
    source: 'SELLER_PORTAL',
    publicDescription: params.publicDescription,
    internalNote: params.internalNote ?? null,
    reason: params.reason ?? null,
    occurredAt: now,
  });
}

/**
 * Cancel a live hand-made booking, inside a transaction.
 *
 * The row is kept and marked CANCELLED, with who and why, and releases the
 * active slot so a new booking or an offer can take it. The consignment goes
 * back to waiting, and the carrier's number is taken off it: a number for a
 * booking that no longer stands is a number somebody would chase.
 */
async function cancelBookingInTransaction(
  tx: PrismaTransaction,
  params: { actor: SellerLogisticsActor; shipmentId: string; bookingId: string; reason: string },
): Promise<string> {
  const claimed = await tx.sellerManualCarrierBooking.updateMany({
    where: { id: params.bookingId, activeShipmentId: params.shipmentId },
    data: {
      status: 'CANCELLED',
      activeShipmentId: null,
      cancelledAt: new Date(),
      cancelledReason: params.reason.slice(0, 512),
      cancelledByLabel: params.actor.label.slice(0, 160),
    },
  });

  if (claimed.count !== 1) {
    throw conflict(ErrorCode.CONFLICT, 'That booking has already been changed. Reload and try again.');
  }

  await moveAsSeller(tx, {
    shipmentId: params.shipmentId,
    to: 'AWAITING_ASSIGNMENT',
    publicDescription: 'The carrier booking was cancelled. A new carrier is being arranged.',
    reason: params.reason,
    data: { carrierTrackingNumber: null, carrierTrackingUrl: null },
  });

  return params.bookingId;
}

/**
 * The seller chooses DHL, FedEx or India Post for this consignment, and will
 * book it themselves.
 *
 * Creates a BOOKING_REQUIRED row and moves the consignment to ASSIGNED - a
 * carrier has been named. Books nothing, calls nothing, creates no label and
 * no tracking number. The seller is alerted until they type in the carrier's
 * own number, because until then nobody is coming to collect.
 */
export async function createManualBooking(input: {
  actor: SellerLogisticsActor;
  shipmentId: string;
  provider: string;
  /** Required when this replaces a delivery company or another booking. */
  reason?: string | null;
  correlationId?: string | null;
}): Promise<{ booking: ManualBookingView; idempotent: boolean }> {
  const { actor } = input;

  if (!isManualCarrierProvider(input.provider)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose DHL, FedEx or India Post.', [
      { field: 'provider', code: 'NOT_A_MANUAL_CARRIER' },
    ]);
  }
  const provider = input.provider;

  const consignment = await requireOwnedConsignment(prisma, actor.sellerAccountId, input.shipmentId);

  const existing = await prisma.sellerManualCarrierBooking.findUnique({
    where: { activeShipmentId: consignment.id },
  });

  // The same carrier again: the booking it already has.
  if (existing !== null && existing.provider === provider) {
    const view = bookingView(existing);
    if (view !== null) return { booking: view, idempotent: true };
  }

  assertAssignable(consignment);

  const options = await logisticsOptionsForConsignment(actor.sellerAccountId, consignment.id);
  const option = options.carriers.find((row) => row.provider === provider);

  if (option === undefined || !option.isAvailable) {
    throw badRequest(
      ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE,
      `${MANUAL_CARRIER_NAMES[provider]} cannot carry this consignment.`,
      [{ field: 'provider', code: ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE, meta: { notes: (option?.notes ?? []).join(",") } }],
    );
  }

  const live = await prisma.logisticsShipmentAssignment.findFirst({
    where: { shipmentId: consignment.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
    select: { id: true },
  });

  const replacing = live !== null || existing !== null;
  const reason = input.reason?.trim() ?? '';

  if (replacing && reason.length < 4) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Say why you are moving this consignment to a different carrier.',
      [{ field: 'reason', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  const method = await prisma.sellerFulfilmentMethod.findFirst({
    where: {
      sellerAccountId: actor.sellerAccountId,
      mode: 'INTEGRATED_CARRIER',
      archivedAt: null,
      methodKey: { startsWith: `CARRIER:${provider}:` },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  const bookingId = newId();

  const { withdrawn } = await prisma.$transaction(async (tx) => {
    const withdrawnResult =
      live === null
        ? null
        : await withdrawAssignmentInTransaction(tx, {
            shipmentId: consignment.id,
            reason,
            actorUserId: null,
            actorLabel: `Seller: ${actor.label}`,
            ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
          });

    if (existing !== null) {
      await cancelBookingInTransaction(tx, {
        actor,
        shipmentId: consignment.id,
        bookingId: existing.id,
        reason,
      });
    }

    await tx.sellerManualCarrierBooking.create({
      data: {
        id: bookingId,
        shipmentId: consignment.id,
        sellerAccountId: actor.sellerAccountId,
        provider,
        sellerFulfilmentMethodId: method?.id ?? null,
        status: 'BOOKING_REQUIRED',
        activeShipmentId: consignment.id,
        createdBySellerMemberId: actor.memberId,
        createdByLabel: actor.label.slice(0, 160),
      },
    });

    await moveAsSeller(tx, {
      shipmentId: consignment.id,
      to: 'ASSIGNED',
      publicDescription: `${MANUAL_CARRIER_NAMES[provider]} has been chosen to carry this consignment.`,
      internalNote: 'Booked by hand by the seller. No carrier API was called.',
    });

    return { withdrawn: withdrawnResult };
  });

  if (withdrawn !== null) await announceWithdrawal(withdrawn);

  await recordSellerAudit({
    sellerAccountId: actor.sellerAccountId,
    action: 'seller.carrier.manual_booking.created',
    actor: { type: 'CUSTOMER', label: actor.label },
    resourceType: 'logistics_shipment',
    resourceId: consignment.id,
    after: { provider, bookingId, mode: 'MANUAL' },
    summary: `Chose ${MANUAL_CARRIER_NAMES[provider]} for consignment ${consignment.shipmentReference}, to be booked by hand.${
      replacing ? ` ${reason}` : ''
    }`,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });

  await resolveConsignmentUnassigned({
    shipmentId: consignment.id,
    carrierName: MANUAL_CARRIER_NAMES[provider],
  });
  await resolveConsignmentMethodAlert(consignment.id);
  await notifyCarrierBookingIncomplete({
    shipmentId: consignment.id,
    sellerOrderGroupId: consignment.sellerOrderGroupId,
    carrierName: MANUAL_CARRIER_NAMES[provider],
  });

  const created = await prisma.sellerManualCarrierBooking.findUniqueOrThrow({ where: { id: bookingId } });
  const view = bookingView(created);
  if (view === null) throw new Error('a booking just created is not live');

  return { booking: view, idempotent: false };
}

export interface ManualBookingDetails {
  serviceName?: string | null;
  pickupReference?: string | null;
  carrierTrackingNumber?: string | null;
  expectedPickupAt?: Date | null;
  expectedDeliveryAt?: Date | null;
  /** Minor units, as the string it crossed the API as. */
  shippingCostMinor?: string | null;
  currency?: string | null;
}

/**
 * Who is entering the carrier's details: the seller, or the marketplace's own
 * staff on the seller's behalf.
 */
export type BookingEditor =
  | { kind: 'SELLER'; actor: SellerLogisticsActor }
  | { kind: 'ADMIN'; userId: string; label: string };

/**
 * Record what the carrier gave the seller: its service, its collection
 * reference, its dates, what it cost, and - the one that matters - its own
 * tracking number.
 *
 * The first time a tracking number is entered the booking becomes BOOKED and
 * the consignment PICKUP_SCHEDULED, because a waybill number means the carrier
 * has the booking. Nothing is inferred from anything else: a pickup reference
 * without a waybill leaves it BOOKING_REQUIRED.
 */
export async function updateManualBooking(input: {
  editor: BookingEditor;
  shipmentId: string;
  details: ManualBookingDetails;
  correlationId?: string | null;
}): Promise<ManualBookingView> {
  const { editor, details } = input;

  const consignment =
    editor.kind === 'SELLER'
      ? await requireOwnedConsignment(prisma, editor.actor.sellerAccountId, input.shipmentId)
      : await prisma.logisticsShipment.findUnique({
          where: { id: input.shipmentId },
          select: CONSIGNMENT_SELECT,
        });

  if (consignment === null) throw notFound('Consignment');

  const booking = await prisma.sellerManualCarrierBooking.findUnique({
    where: { activeShipmentId: consignment.id },
  });

  if (booking === null || !isManualCarrierProvider(booking.provider)) {
    throw notFound('Carrier booking');
  }
  const provider = booking.provider;

  if (isTrackingComplete(consignment.status)) {
    throw conflict(
      ErrorCode.LOGISTICS_SHIPMENT_TERMINAL,
      `Consignment ${consignment.shipmentReference} is already finished.`,
    );
  }

  const trackingNumber =
    details.carrierTrackingNumber === undefined
      ? undefined
      : details.carrierTrackingNumber === null
        ? null
        : details.carrierTrackingNumber.trim().toUpperCase();

  if (trackingNumber !== undefined && trackingNumber !== null && !TRACKING_NUMBER.test(trackingNumber)) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `That does not look like a ${MANUAL_CARRIER_NAMES[provider]} tracking number. Use the number on the waybill, without spaces.`,
      [{ field: 'carrierTrackingNumber', code: 'FORMAT' }],
    );
  }

  // A number, once the carrier has the parcel, is the parcel's identity. It
  // can be corrected before collection - a typo on the day - and not after.
  if (
    trackingNumber !== undefined &&
    booking.carrierTrackingNumber !== null &&
    trackingNumber !== booking.carrierTrackingNumber &&
    !sellerMayReassign(consignment.status)
  ) {
    throw conflict(
      ErrorCode.CONSIGNMENT_REASSIGNMENT_LOCKED,
      'The carrier already has this parcel, so its tracking number cannot be changed here. Ask the marketplace to correct it.',
      [{ code: 'CONSIGNMENT_REASSIGNMENT_LOCKED', meta: { status: consignment.status } }],
    );
  }

  if (trackingNumber === null && booking.status === 'BOOKED') {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A booked consignment keeps its tracking number. Cancel the booking instead.',
      [{ field: 'carrierTrackingNumber', code: 'REQUIRED' }],
    );
  }

  // The same waybill on two live consignments is a paste in the wrong box.
  if (trackingNumber !== undefined && trackingNumber !== null) {
    const clash = await prisma.sellerManualCarrierBooking.findFirst({
      where: {
        provider,
        carrierTrackingNumber: trackingNumber,
        activeShipmentId: { not: null },
        id: { not: booking.id },
      },
      select: { id: true },
    });

    if (clash !== null) {
      throw conflict(
        ErrorCode.CONFLICT,
        `That ${MANUAL_CARRIER_NAMES[provider]} tracking number is already on another consignment.`,
        [{ field: 'carrierTrackingNumber', code: 'DUPLICATE' }],
      );
    }
  }

  const cost = parseCost(details.shippingCostMinor, details.currency, consignment.currency);

  const becomesBooked =
    booking.status === 'BOOKING_REQUIRED' && trackingNumber !== undefined && trackingNumber !== null;

  const trackingPage =
    trackingNumber === undefined || trackingNumber === null
      ? undefined
      : carrierTrackingPageUrl(provider, trackingNumber);

  await prisma.$transaction(async (tx) => {
    await tx.sellerManualCarrierBooking.update({
      where: { id: booking.id },
      data: {
        ...(details.serviceName === undefined
          ? {}
          : { serviceName: details.serviceName?.trim().slice(0, 120) || null }),
        ...(details.pickupReference === undefined
          ? {}
          : { pickupReference: details.pickupReference?.trim().slice(0, 64) || null }),
        ...(trackingNumber === undefined ? {} : { carrierTrackingNumber: trackingNumber }),
        ...(details.expectedPickupAt === undefined ? {} : { expectedPickupAt: details.expectedPickupAt }),
        ...(details.expectedDeliveryAt === undefined
          ? {}
          : { expectedDeliveryAt: details.expectedDeliveryAt }),
        ...(cost === undefined ? {} : cost),
        ...(becomesBooked ? { status: 'BOOKED' as const, bookedAt: new Date() } : {}),
      },
    });

    const shipmentData = {
      ...(trackingNumber === undefined
        ? {}
        : { carrierTrackingNumber: trackingNumber, carrierTrackingUrl: trackingPage ?? null }),
      ...(details.expectedPickupAt === undefined ? {} : { expectedPickupAt: details.expectedPickupAt }),
      ...(details.expectedDeliveryAt === undefined
        ? {}
        : { estimatedDeliveryAt: details.expectedDeliveryAt }),
    };

    if (becomesBooked && consignment.status === 'ASSIGNED') {
      const current = await tx.logisticsShipment.findUniqueOrThrow({
        where: { id: consignment.id },
        select: { status: true, version: true },
      });

      assertShipmentTransition({
        from: current.status,
        to: 'PICKUP_SCHEDULED',
        actor: editor.kind === 'SELLER' ? 'SELLER' : 'UBOSS_ADMIN',
      });

      const moved = await tx.logisticsShipment.updateMany({
        where: { id: consignment.id, version: current.version },
        data: {
          status: 'PICKUP_SCHEDULED',
          lastEventAt: new Date(),
          version: { increment: 1 },
          ...shipmentData,
        },
      });

      if (moved.count !== 1) {
        throw conflict(
          ErrorCode.CONFLICT,
          'This consignment was changed by somebody else a moment ago. Reload and try again.',
          [{ code: 'VERSION_CONFLICT' }],
        );
      }

      await appendEventInTransaction(tx, {
        shipmentId: consignment.id,
        from: current.status,
        to: 'PICKUP_SCHEDULED',
        source: editor.kind === 'SELLER' ? 'SELLER_PORTAL' : 'UBOSS_ADMIN',
        actorUserId: editor.kind === 'ADMIN' ? editor.userId : null,
        publicDescription: `Booked with ${MANUAL_CARRIER_NAMES[provider]}. Tracking number ${trackingNumber}.`,
        internalNote: 'Tracking number entered by hand. Not verified with the carrier.',
      });
    } else if (Object.keys(shipmentData).length > 0) {
      await tx.logisticsShipment.update({
        where: { id: consignment.id },
        data: { ...shipmentData, version: { increment: 1 } },
      });
    }
  });

  const label = editor.kind === 'SELLER' ? editor.actor.label : `Marketplace: ${editor.label}`;

  if (consignment.sellerAccountId !== null) {
    await recordSellerAudit({
      sellerAccountId: consignment.sellerAccountId,
      action: 'seller.carrier.manual_booking.updated',
      actor:
        editor.kind === 'SELLER'
          ? { type: 'CUSTOMER', label }
          : { type: 'ADMIN', userId: editor.userId, label },
      resourceType: 'seller_manual_carrier_booking',
      resourceId: booking.id,
      before: { carrierTrackingNumber: booking.carrierTrackingNumber, status: booking.status },
      after: {
        carrierTrackingNumber: trackingNumber ?? booking.carrierTrackingNumber,
        status: becomesBooked ? 'BOOKED' : booking.status,
      },
      summary: becomesBooked
        ? `Entered ${MANUAL_CARRIER_NAMES[provider]} tracking number ${trackingNumber ?? ''} for ${consignment.shipmentReference}.`
        : `Updated the ${MANUAL_CARRIER_NAMES[provider]} booking for ${consignment.shipmentReference}.`,
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    });
  }

  if (becomesBooked) {
    await resolveUnassignedConsignmentAlert(
      consignment.id,
      `Booked with ${MANUAL_CARRIER_NAMES[provider]}; tracking number entered.`,
    );
    await resolveCarrierBookingIncomplete({
      shipmentId: consignment.id,
      note: `Tracking number ${trackingNumber ?? ''} entered.`,
    });
  }

  const after = await prisma.sellerManualCarrierBooking.findUniqueOrThrow({ where: { id: booking.id } });
  const view = bookingView(after);
  if (view === null) throw notFound('Carrier booking');
  return view;
}

function parseCost(
  minor: string | null | undefined,
  currency: string | null | undefined,
  fallbackCurrency: string | null,
): { shippingCostMinor: bigint | null; currency: string | null } | undefined {
  if (minor === undefined) return undefined;
  if (minor === null || minor.trim() === '') return { shippingCostMinor: null, currency: null };

  if (!/^\d{1,15}$/.test(minor.trim())) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Enter the cost as a whole number of minor units.', [
      { field: 'shippingCostMinor', code: 'FORMAT' },
    ]);
  }

  const code = (currency ?? fallbackCurrency ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say which currency the cost is in.', [
      { field: 'currency', code: 'REQUIRED' },
    ]);
  }

  return { shippingCostMinor: BigInt(minor.trim()), currency: code };
}

/** Cancel the live hand-made booking, before collection, with a reason. */
export async function cancelManualBooking(input: {
  actor: SellerLogisticsActor;
  shipmentId: string;
  reason: string;
  correlationId?: string | null;
}): Promise<ConsignmentLogisticsState> {
  const booking = await prisma.sellerManualCarrierBooking.findFirst({
    where: { activeShipmentId: input.shipmentId, sellerAccountId: input.actor.sellerAccountId },
    select: { id: true },
  });

  if (booking === null) throw notFound('Carrier booking');

  return withdrawConsignmentCarrier(input);
}

// ---------------------------------------------------------------------------
// The journey, typed in by hand
// ---------------------------------------------------------------------------

/** The milestones a seller may record for their own outside carrier. */
export const SELLER_MILESTONES = Object.freeze([
  'PICKED_UP',
  'IN_TRANSIT',
  'DELAYED',
  'OUT_FOR_DELIVERY',
  'DELIVERY_ATTEMPTED',
  'DELIVERED',
  'DELIVERY_FAILED',
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
  'RETURNED',
] as const);
export type SellerMilestone = (typeof SELLER_MILESTONES)[number];

/** The sentence the buyer reads for each, naming the carrier. */
function milestoneSentence(status: SellerMilestone, carrier: string): string {
  switch (status) {
    case 'PICKED_UP':
      return `Collected by ${carrier}.`;
    case 'IN_TRANSIT':
      return `On its way with ${carrier}.`;
    case 'DELAYED':
      return `${carrier} reports a delay.`;
    case 'OUT_FOR_DELIVERY':
      return `Out for delivery with ${carrier}.`;
    case 'DELIVERY_ATTEMPTED':
      return `${carrier} tried to deliver and will try again.`;
    case 'DELIVERED':
      return `Delivered by ${carrier}.`;
    case 'DELIVERY_FAILED':
      return `${carrier} could not deliver it.`;
    case 'RETURN_REQUESTED':
      return 'A return has been arranged.';
    case 'RETURN_IN_TRANSIT':
      return `On its way back with ${carrier}.`;
    case 'RETURNED':
      return 'Returned to the seller.';
  }
}

/** Evidence the seller has attached that a delivery happened. */
const DELIVERY_EVIDENCE: readonly LogisticsDocumentKind[] = Object.freeze([
  'PROOF_OF_DELIVERY',
  'DELIVERY_PHOTO',
  'DELIVERY_SIGNATURE',
]);

/**
 * Record where the seller's own carrier says the parcel is.
 *
 * Only on a consignment with a live BOOKED hand-made booking and nobody on
 * this platform holding it, and only through the SELLER edges of the state
 * machine. Every event is stored with source SELLER_PORTAL, so it is never
 * mistaken for something DHL's own systems reported.
 *
 * DELIVERED needs evidence attached first - a photograph, a screenshot of the
 * carrier's proof - for the same reason a driver needs one: a parcel marked
 * delivered on somebody's say-so is exactly what the rule exists to prevent.
 */
export async function recordManualMilestone(input: {
  actor: SellerLogisticsActor;
  shipmentId: string;
  status: string;
  note?: string | null;
  reason?: string | null;
  occurredAt?: Date | null;
  idempotencyKey?: string | null;
  correlationId?: string | null;
}): Promise<ConsignmentLogisticsState> {
  const { actor } = input;

  if (!(SELLER_MILESTONES as readonly string[]).includes(input.status)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That is not a step you can record here.', [
      { field: 'status', code: 'NOT_A_SELLER_MILESTONE' },
    ]);
  }
  const status = input.status as SellerMilestone;

  const consignment = await requireOwnedConsignment(prisma, actor.sellerAccountId, input.shipmentId);

  const booking = await prisma.sellerManualCarrierBooking.findUnique({
    where: { activeShipmentId: consignment.id },
  });

  if (booking === null || consignment.assignedPartnerId !== null || !isManualCarrierProvider(booking.provider)) {
    // A delivery company on this platform reports its own progress. A seller
    // typing over it would put two versions of one parcel's journey on the
    // record.
    throw conflict(
      ErrorCode.SHIPMENT_TRANSITION_NOT_ALLOWED,
      'Only a consignment you booked yourself with DHL, FedEx or India Post can be updated here.',
      [{ code: 'NOT_A_MANUAL_BOOKING' }],
    );
  }

  if (booking.status !== 'BOOKED' || booking.carrierTrackingNumber === null) {
    throw conflict(
      ErrorCode.CARRIER_TRACKING_NUMBER_REQUIRED,
      `Enter the ${MANUAL_CARRIER_NAMES[booking.provider]} tracking number before recording where the parcel is.`,
      [{ field: 'carrierTrackingNumber', code: 'REQUIRED' }],
    );
  }

  const carrier = MANUAL_CARRIER_NAMES[booking.provider];

  const hasEvidence =
    status !== 'DELIVERED'
      ? false
      : (await prisma.logisticsShipmentDocument.count({
          where: {
            shipmentId: consignment.id,
            kind: { in: [...DELIVERY_EVIDENCE] },
            uploadedBySource: 'SELLER_PORTAL',
            deletedAt: null,
          },
        })) > 0;

  await recordShipmentEvent({
    shipmentId: consignment.id,
    status,
    actor: 'SELLER',
    source: 'SELLER_PORTAL',
    actorLabel: `Seller: ${actor.label}`,
    publicDescription: milestoneSentence(status, carrier),
    internalNote: input.note?.trim().slice(0, 1000) || null,
    reason: input.reason?.trim() || null,
    hasProofOfDelivery: hasEvidence,
    ...(input.occurredAt === undefined || input.occurredAt === null
      ? {}
      : { occurredAt: input.occurredAt }),
    ...(input.idempotencyKey === undefined || input.idempotencyKey === null
      ? {}
      : { idempotencyKey: `seller:${input.idempotencyKey}`.slice(0, 64) }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });

  await recordSellerAudit({
    sellerAccountId: actor.sellerAccountId,
    action: 'seller.carrier.manual_milestone',
    actor: { type: 'CUSTOMER', label: actor.label },
    resourceType: 'logistics_shipment',
    resourceId: consignment.id,
    after: { status },
    summary: `Recorded "${status.toLowerCase().replace(/_/g, ' ')}" for ${consignment.shipmentReference} from ${carrier}.`,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });

  return consignmentState(actor.sellerAccountId, consignment.id);
}

/** The kinds of paper a seller may attach to their own outside carrier's consignment. */
export const SELLER_DOCUMENT_KINDS: readonly LogisticsDocumentKind[] = Object.freeze([
  'SHIPPING_LABEL',
  'PACKING_LIST',
  'COMMERCIAL_INVOICE',
  'CUSTOMS_DOCUMENT',
  'PROOF_OF_DELIVERY',
  'DELIVERY_PHOTO',
  'OTHER',
]);

/**
 * Attach a photograph or a screenshot to a hand-booked consignment: the
 * carrier's own label, a customs form, a proof of delivery.
 *
 * A SHIPPING_LABEL here is the label the CARRIER issued the seller - Glovia
 * still produces none. Only on a consignment with a live hand-made booking:
 * a delivery company on this platform attaches its own evidence.
 */
export async function attachManualBookingDocument(input: {
  actor: SellerLogisticsActor;
  shipmentId: string;
  kind: string;
  fileName: string;
  bytes: Buffer;
  correlationId?: string | null;
}): Promise<{ id: string; kind: LogisticsDocumentKind; fileName: string; scanState: string }> {
  const { actor } = input;

  if (!(SELLER_DOCUMENT_KINDS as readonly string[]).includes(input.kind)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose what kind of document this is.', [
      { field: 'kind', code: 'NOT_ALLOWED' },
    ]);
  }
  const kind = input.kind as LogisticsDocumentKind;

  const consignment = await requireOwnedConsignment(prisma, actor.sellerAccountId, input.shipmentId);

  const booking = await prisma.sellerManualCarrierBooking.findUnique({
    where: { activeShipmentId: consignment.id },
    select: { id: true },
  });

  if (booking === null) {
    throw conflict(
      ErrorCode.SHIPMENT_TRANSITION_NOT_ALLOWED,
      'Documents can be attached here only to a consignment you booked yourself with DHL, FedEx or India Post.',
      [{ code: 'NOT_A_MANUAL_BOOKING' }],
    );
  }

  const stored = await storeShipmentFile({
    shipmentId: consignment.id,
    kind,
    // BOTH: the marketplace sees it, and so would a delivery company later
    // given this consignment. The buyer never does.
    audience: 'BOTH',
    fileName: input.fileName,
    bytes: input.bytes,
    uploadedByUserId: null,
    uploadedBySource: 'SELLER_PORTAL',
  });

  await recordSellerAudit({
    sellerAccountId: actor.sellerAccountId,
    action: 'seller.carrier.manual_document',
    actor: { type: 'CUSTOMER', label: actor.label },
    resourceType: 'logistics_shipment_document',
    resourceId: stored.id,
    after: { kind, scanState: stored.scanState },
    summary: `Attached ${input.fileName} to ${consignment.shipmentReference}.`,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });

  return { id: stored.id, kind, fileName: input.fileName, scanState: stored.scanState };
}

// ---------------------------------------------------------------------------
// Tracking, for the seller
// ---------------------------------------------------------------------------

export interface SellerTrackingView {
  state: ConsignmentLogisticsState;
  events: {
    id: string;
    status: ShipmentStatusName;
    description: string | null;
    occurredAt: string;
    /** Who said so: the carrier's system, the carrier's staff, or the seller. */
    source: string;
  }[];
  documents: { id: string; kind: LogisticsDocumentKind; fileName: string; createdAt: string }[];
}

/**
 * The consignment's journey as the seller may see it.
 *
 * The public descriptions and the source of each event - never the carrier's
 * internal notes, which are its dispatchers' own words about their own work.
 */
export async function readSellerTracking(
  sellerAccountId: string,
  shipmentId: string,
): Promise<SellerTrackingView> {
  const state = await consignmentState(sellerAccountId, shipmentId);

  const [events, documents] = await Promise.all([
    prisma.logisticsShipmentEvent.findMany({
      where: { shipmentId },
      orderBy: { occurredAt: 'asc' },
      select: { id: true, status: true, publicDescription: true, occurredAt: true, source: true },
    }),
    prisma.logisticsShipmentDocument.findMany({
      where: { shipmentId, uploadedBySource: 'SELLER_PORTAL', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, fileName: true, createdAt: true },
    }),
  ]);

  return {
    state,
    events: events.map((event) => ({
      id: event.id,
      status: event.status,
      description: event.publicDescription,
      occurredAt: event.occurredAt.toISOString(),
      source: event.source,
    })),
    documents: documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      fileName: document.fileName,
      createdAt: document.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// A confirmed order with no consignment
// ---------------------------------------------------------------------------

/**
 * Raise the consignment a confirmed order should already have.
 *
 * Normally it exists: payment raises one for every seller whose despatch
 * building is known, and confirmation raises the rest. This is the way back
 * for an order where neither happened - confirmed before consignments were
 * raised automatically, or on a day the raise failed and was only logged. The
 * seller would otherwise see a confirmed order with nothing to assign and no
 * way to fix it but a support ticket.
 *
 * Idempotent, like the raise itself: pressing it twice raises one.
 */
export async function raiseConsignmentForSellerOrder(input: {
  actor: SellerLogisticsActor;
  sellerOrderGroupId: string;
}): Promise<ConsignmentLogisticsState[]> {
  const group = await prisma.sellerOrderGroup.findFirst({
    where: { id: input.sellerOrderGroupId, sellerAccountId: input.actor.sellerAccountId },
    select: { id: true, orderId: true, status: true },
  });

  if (group === null) throw notFound('Order');

  if (!sellerHasConfirmed(group.status)) {
    throw conflict(
      ErrorCode.SELLER_ORDER_NOT_CONFIRMED,
      'Confirm this order before a consignment is raised for it.',
      [{ code: 'SELLER_ORDER_NOT_CONFIRMED', meta: { status: group.status } }],
    );
  }

  const { env } = await import('../../config/env.js');
  if (!env.FEATURE_LOGISTICS_PORTAL) {
    throw conflict(
      ErrorCode.CONFLICT,
      'Consignments are not used on this marketplace. Record the shipment on the order instead.',
    );
  }

  const { createShipmentsForOrder, handConsignmentOnAfterConfirmation } = await import(
    '../logistics/shipment-create.service.js'
  );

  await createShipmentsForOrder(group.orderId, null);

  const states = await consignmentStatesForGroup(input.actor.sellerAccountId, group.id);
  for (const state of states) await handConsignmentOnAfterConfirmation(state.id);

  return consignmentStatesForGroup(input.actor.sellerAccountId, group.id);
}

// ---------------------------------------------------------------------------
// The marketplace's view
// ---------------------------------------------------------------------------

/**
 * What the operator sees about a seller's consignment beyond the carrier's
 * own record: which delivery method the seller's rules chose and why, whether
 * it is carried by a partner or booked by hand, and the stage every other
 * portal shows.
 *
 * Null for the operator's own goods, which have no seller side.
 */
export async function adminSellerLogisticsView(shipmentId: string): Promise<{
  state: ConsignmentLogisticsState;
  sellerOrder: { id: string; number: string; status: string } | null;
  method: { name: string; mode: string } | null;
  selectionSource: string | null;
  selectionReason: string | null;
} | null> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: {
      sellerAccountId: true,
      fulfilmentSelectionSource: true,
      fulfilmentSelectionReason: true,
      sellerFulfilmentMethod: { select: { publicDisplayName: true, mode: true } },
      sellerOrderGroup: { select: { id: true, sellerOrderNumber: true, status: true } },
    },
  });

  if (shipment === null || shipment.sellerAccountId === null) return null;

  return {
    state: await consignmentState(null, shipmentId),
    sellerOrder:
      shipment.sellerOrderGroup === null
        ? null
        : {
            id: shipment.sellerOrderGroup.id,
            number: shipment.sellerOrderGroup.sellerOrderNumber,
            status: shipment.sellerOrderGroup.status,
          },
    method:
      shipment.sellerFulfilmentMethod === null
        ? null
        : {
            name: shipment.sellerFulfilmentMethod.publicDisplayName,
            mode: shipment.sellerFulfilmentMethod.mode,
          },
    selectionSource: shipment.fulfilmentSelectionSource,
    selectionReason: shipment.fulfilmentSelectionReason,
  };
}
