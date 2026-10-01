/**
 * Shipment booking for a seller's consignment (Master row 56).
 *
 * A booking is the commercial and physical plan for one consignment: how it
 * travels (mode), on what terms (Incoterm and the named place), between which
 * ports, when it should be collected (date and window), and by which carrier.
 *
 * The carrier part is NOT re-implemented here. A seller hands a consignment to
 * a delivery company on this platform, buys a label through their own carrier
 * account (their own credentials, `ConsignmentCarrierPurchasePanel`), or books
 * DHL, FedEx or India Post by hand. This service stores the terms and, when
 * the seller names an outside carrier, calls the existing hand-booking path -
 * which calls no carrier API and invents no tracking number.
 *
 * The buyer is shown the same booking as their shipment details.
 */
import type { CarrierProvider, ShipmentTransportMode } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { INCOTERMS } from '../../domain/packaging.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import {
  MANUAL_CARRIER_NAMES,
  consignmentState,
  createManualBooking,
  isManualCarrierProvider,
  type ConsignmentLogisticsState,
  type SellerLogisticsActor,
} from './consignment-logistics.service.js';

export const TRANSPORT_MODES: readonly ShipmentTransportMode[] = Object.freeze([
  'ROAD',
  'AIR',
  'SEA',
  'RAIL',
  'COURIER',
  'MULTIMODAL',
]);

/** UN/LOCODE: two letters of country, three of place (letters or 2-9). */
const LOCODE = /^[A-Z]{2}[A-Z2-9]{3}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ShipmentBookingInput {
  mode: string;
  incoterm: string;
  incotermPlace?: string | null;
  originPort?: string | null;
  destinationPort?: string | null;
  routeNote?: string | null;
  /** YYYY-MM-DD, local to the pickup address. */
  pickupDate?: string | null;
  pickupWindowFrom?: string | null;
  pickupWindowTo?: string | null;
  /** DHL, FEDEX or INDIA_POST, booked by hand. Omit to keep the carrier as it is. */
  manualCarrier?: string | null;
}

export interface BookingTermsView {
  mode: ShipmentTransportMode;
  incoterm: string;
  incotermPlace: string | null;
  originPort: string | null;
  destinationPort: string | null;
  routeNote: string | null;
  pickupDate: string | null;
  pickupWindowFrom: string | null;
  pickupWindowTo: string | null;
  updatedByLabel: string;
  updatedAt: string;
}

export interface CarrierSummary {
  /** How it is carried: a platform partner, a hand booking, a label bought through the seller's own account, or not yet. */
  kind: 'NONE' | 'PARTNER' | 'MANUAL_CARRIER' | 'OWN_ACCOUNT';
  name: string | null;
  trackingNumber: string | null;
}

export interface SellerShipmentBooking {
  shipmentId: string;
  reference: string;
  crossBorder: boolean;
  terms: BookingTermsView | null;
  carrier: CarrierSummary;
  /** False once the parcel has been collected: a booking after that would be fiction. */
  canEdit: boolean;
}

function invalid(message: string, field: string, code: string): never {
  throw badRequest(ErrorCode.BOOKING_TERMS_INVALID, message, [{ field, code }]);
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

const TERMS_SELECT = {
  mode: true,
  incoterm: true,
  incotermPlace: true,
  originPort: true,
  destinationPort: true,
  routeNote: true,
  pickupDate: true,
  pickupWindowFrom: true,
  pickupWindowTo: true,
  updatedByLabel: true,
  updatedAt: true,
} as const;

function termsView(row: {
  mode: ShipmentTransportMode;
  incoterm: string;
  incotermPlace: string | null;
  originPort: string | null;
  destinationPort: string | null;
  routeNote: string | null;
  pickupDate: Date | null;
  pickupWindowFrom: string | null;
  pickupWindowTo: string | null;
  updatedByLabel: string;
  updatedAt: Date;
}): BookingTermsView {
  return {
    mode: row.mode,
    incoterm: row.incoterm,
    incotermPlace: row.incotermPlace,
    originPort: row.originPort,
    destinationPort: row.destinationPort,
    routeNote: row.routeNote,
    pickupDate: row.pickupDate === null ? null : row.pickupDate.toISOString().slice(0, 10),
    pickupWindowFrom: row.pickupWindowFrom,
    pickupWindowTo: row.pickupWindowTo,
    updatedByLabel: row.updatedByLabel,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const PROVIDER_NAMES: Readonly<Partial<Record<CarrierProvider, string>>> = Object.freeze({
  DHL: 'DHL',
  FEDEX: 'FedEx',
  INDIA_POST: 'India Post',
});

/** Who carries one consignment, read the same way for the seller and the buyer. */
export async function carrierSummaryFor(shipmentId: string): Promise<CarrierSummary> {
  const [manual, assignment, purchase, shipment] = await Promise.all([
    prisma.sellerManualCarrierBooking.findUnique({
      where: { activeShipmentId: shipmentId },
      select: { provider: true, carrierTrackingNumber: true },
    }),
    prisma.logisticsShipmentAssignment.findFirst({
      where: { shipmentId, state: { in: ['OFFERED', 'ACCEPTED'] } },
      orderBy: { offeredAt: 'desc' },
      select: { partner: { select: { displayName: true } } },
    }),
    prisma.shipmentPurchase.findFirst({
      where: { shipmentId, purchasedShipmentId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { provider: true },
    }),
    prisma.logisticsShipment.findUnique({
      where: { id: shipmentId },
      select: { carrierTrackingNumber: true },
    }),
  ]);

  if (manual !== null) {
    const name = isManualCarrierProvider(manual.provider)
      ? MANUAL_CARRIER_NAMES[manual.provider]
      : (PROVIDER_NAMES[manual.provider] ?? manual.provider);
    return {
      kind: 'MANUAL_CARRIER',
      name,
      trackingNumber: manual.carrierTrackingNumber ?? shipment?.carrierTrackingNumber ?? null,
    };
  }
  if (purchase !== null) {
    return {
      kind: 'OWN_ACCOUNT',
      name: PROVIDER_NAMES[purchase.provider] ?? purchase.provider,
      trackingNumber: shipment?.carrierTrackingNumber ?? null,
    };
  }
  if (assignment !== null) {
    return {
      kind: 'PARTNER',
      name: assignment.partner.displayName,
      trackingNumber: shipment?.carrierTrackingNumber ?? null,
    };
  }
  return { kind: 'NONE', name: null, trackingNumber: null };
}

function canEditFrom(state: ConsignmentLogisticsState): boolean {
  return state.assignBlock !== 'COLLECTED' && state.assignBlock !== 'FINISHED';
}

/** The booking of one of the seller's consignments. */
export async function readShipmentBooking(
  sellerAccountId: string,
  shipmentId: string,
): Promise<SellerShipmentBooking> {
  // `consignmentState` refuses another seller's consignment with a 404.
  const state = await consignmentState(sellerAccountId, shipmentId);
  const [shipment, terms, carrier] = await Promise.all([
    prisma.logisticsShipment.findUnique({
      where: { id: shipmentId },
      select: { originCountry: true, destinationCountry: true },
    }),
    prisma.consignmentBookingTerms.findUnique({ where: { shipmentId }, select: TERMS_SELECT }),
    carrierSummaryFor(shipmentId),
  ]);
  if (shipment === null) throw notFound('Consignment');

  return {
    shipmentId,
    reference: state.reference,
    crossBorder: shipment.originCountry !== shipment.destinationCountry,
    terms: terms === null ? null : termsView(terms),
    carrier,
    canEdit: canEditFrom(state),
  };
}

/**
 * Book a consignment: store its terms and, where the seller names an outside
 * carrier, record a hand booking with it.
 *
 * A cross-border AIR or SEA consignment must name both ports; that is what
 * the carrier and customs will ask for first.
 */
export async function saveShipmentBooking(input: {
  actor: SellerLogisticsActor;
  shipmentId: string;
  booking: ShipmentBookingInput;
  correlationId?: string | null;
}): Promise<SellerShipmentBooking> {
  const { actor, booking } = input;

  const mode = booking.mode.trim().toUpperCase();
  if (!(TRANSPORT_MODES as readonly string[]).includes(mode)) {
    invalid('Choose how the goods travel.', 'mode', 'UNKNOWN_MODE');
  }
  const incoterm = booking.incoterm.trim().toUpperCase();
  if (!INCOTERMS.includes(incoterm)) invalid('That is not an Incoterms 2020 code.', 'incoterm', 'INCOTERM_UNKNOWN');

  const originPort = blankToNull(booking.originPort)?.toUpperCase() ?? null;
  const destinationPort = blankToNull(booking.destinationPort)?.toUpperCase() ?? null;
  if (originPort !== null && !LOCODE.test(originPort)) {
    invalid('Enter the port as a five-character UN/LOCODE, such as INNSA.', 'originPort', 'NOT_A_LOCODE');
  }
  if (destinationPort !== null && !LOCODE.test(destinationPort)) {
    invalid('Enter the port as a five-character UN/LOCODE, such as DEHAM.', 'destinationPort', 'NOT_A_LOCODE');
  }

  const pickupDateText = blankToNull(booking.pickupDate);
  let pickupDate: Date | null = null;
  if (pickupDateText !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDateText) || Number.isNaN(Date.parse(`${pickupDateText}T00:00:00Z`))) {
      invalid('Enter the pickup date as a date.', 'pickupDate', 'NOT_A_DATE');
    }
    pickupDate = new Date(`${pickupDateText}T00:00:00Z`);
    // A day of grace either side of UTC: the pickup address has its own clock.
    if (pickupDate.getTime() < Date.now() - 2 * 86_400_000) {
      invalid('The pickup date has already passed.', 'pickupDate', 'IN_THE_PAST');
    }
  }

  const from = blankToNull(booking.pickupWindowFrom);
  const to = blankToNull(booking.pickupWindowTo);
  if (from !== null && !CLOCK.test(from)) invalid('Enter the time as HH:MM.', 'pickupWindowFrom', 'NOT_A_TIME');
  if (to !== null && !CLOCK.test(to)) invalid('Enter the time as HH:MM.', 'pickupWindowTo', 'NOT_A_TIME');
  if ((from !== null || to !== null) && pickupDate === null) {
    invalid('Choose the pickup date for this window.', 'pickupDate', 'REQUIRED');
  }
  if (from !== null && to !== null && to <= from) {
    invalid('The window must end after it starts.', 'pickupWindowTo', 'BEFORE_START');
  }

  const manualCarrier = blankToNull(booking.manualCarrier);
  if (manualCarrier !== null && !isManualCarrierProvider(manualCarrier)) {
    invalid('Choose DHL, FedEx or India Post.', 'manualCarrier', 'NOT_A_MANUAL_CARRIER');
  }

  const state = await consignmentState(actor.sellerAccountId, input.shipmentId);
  if (!canEditFrom(state)) {
    throw conflict(
      ErrorCode.SHIPMENT_TRANSITION_NOT_ALLOWED,
      'This consignment has been collected; its booking can no longer change.',
      [{ code: state.assignBlock ?? 'COLLECTED' }],
    );
  }

  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: input.shipmentId },
    select: { originCountry: true, destinationCountry: true },
  });
  if (shipment === null) throw notFound('Consignment');
  const crossBorder = shipment.originCountry !== shipment.destinationCountry;

  if (crossBorder && (mode === 'AIR' || mode === 'SEA')) {
    if (originPort === null) invalid('Name the port the goods leave from.', 'originPort', 'REQUIRED');
    if (destinationPort === null) invalid('Name the port the goods arrive at.', 'destinationPort', 'REQUIRED');
  }

  const data = {
    mode: mode as ShipmentTransportMode,
    incoterm,
    incotermPlace: blankToNull(booking.incotermPlace)?.slice(0, 120) ?? null,
    originPort,
    destinationPort,
    routeNote: blankToNull(booking.routeNote)?.slice(0, 500) ?? null,
    pickupDate,
    pickupWindowFrom: from,
    pickupWindowTo: to,
    updatedByLabel: actor.label.slice(0, 160),
  };

  const before = await prisma.consignmentBookingTerms.findUnique({
    where: { shipmentId: input.shipmentId },
    select: TERMS_SELECT,
  });

  // The hand booking first: if the carrier cannot carry it, nothing is saved
  // and the seller is told why, rather than left with terms for a booking
  // that never happened.
  if (manualCarrier !== null) {
    await createManualBooking({
      actor,
      shipmentId: input.shipmentId,
      provider: manualCarrier,
      reason: state.mode === 'NONE' ? null : 'Changed carrier while booking the shipment.',
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    });
  }

  await prisma.consignmentBookingTerms.upsert({
    where: { shipmentId: input.shipmentId },
    create: { id: newId(), shipmentId: input.shipmentId, sellerAccountId: actor.sellerAccountId, ...data },
    update: data,
  });

  await recordSellerAudit({
    sellerAccountId: actor.sellerAccountId,
    action: 'seller.shipment.booking_saved',
    actor: { type: 'CUSTOMER', label: actor.label },
    resourceType: 'consignment_booking_terms',
    resourceId: input.shipmentId,
    ...(before === null ? {} : { before: termsView(before) }),
    after: { ...data, pickupDate: pickupDateText, manualCarrier },
    summary: `Booked ${state.reference}: ${mode}, ${incoterm}.`,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });

  return readShipmentBooking(actor.sellerAccountId, input.shipmentId);
}

// ---------------------------------------------------------------------------
// The buyer
// ---------------------------------------------------------------------------

export interface BuyerShipmentDetails {
  shipmentId: string;
  reference: string;
  sellerName: string | null;
  terms: Omit<BookingTermsView, 'updatedByLabel' | 'updatedAt'> | null;
  carrier: CarrierSummary;
}

/** The booking of every consignment on one of the buyer's own orders. */
export async function listBuyerShipmentDetails(
  scope: { customerProfileId?: string; buyerCompanyId: string | null },
  orderId: string,
): Promise<BuyerShipmentDetails[]> {
  const order = await prisma.order.findFirst({ where: { id: orderId, ...scope }, select: { id: true } });
  if (order === null) throw notFound('Order');

  const shipments = await prisma.logisticsShipment.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      shipmentReference: true,
      sellerOrderGroup: { select: { sellerAccount: { select: { displayName: true } } } },
      bookingTerms: { select: TERMS_SELECT },
    },
  });

  return Promise.all(
    shipments.map(async (shipment) => {
      let terms: BuyerShipmentDetails['terms'] = null;
      if (shipment.bookingTerms !== null) {
        // The buyer is not told which of the seller's staff typed it.
        const { updatedByLabel: _by, updatedAt: _at, ...rest } = termsView(shipment.bookingTerms);
        terms = rest;
      }
      return {
        shipmentId: shipment.id,
        reference: shipment.shipmentReference,
        sellerName: shipment.sellerOrderGroup?.sellerAccount.displayName ?? null,
        terms,
        carrier: await carrierSummaryFor(shipment.id),
      };
    }),
  );
}
