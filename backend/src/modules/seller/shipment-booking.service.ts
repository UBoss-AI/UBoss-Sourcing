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
import { decideInsurance, maxInsuredValueMinor, type InsuranceDecision } from '../../domain/cargo-insurance.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { INCOTERMS } from '../../domain/packaging.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { evaluateSellerOrderCompliance } from '../compliance/destination-compliance.service.js';
import { readInsuranceSettings } from '../compliance/trade-settings.service.js';
import { peekGate } from '../inspection/gate.service.js';
import { quoteLanes, type LaneQuote } from '../logistics/lane-rate.service.js';
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
  /** Cargo insurance (JOURNEY-046). Omit to keep it as it is. */
  insured?: boolean | undefined;
  /** Minor units as a string, in the consignment's currency. Required when insured. */
  insuredValueMinor?: string | null | undefined;
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
  insured: boolean;
  /** Minor units as strings, in `insuranceCurrency`. */
  insuredValueMinor: string | null;
  insurancePremiumMinor: string | null;
  /** The rate in force when it was booked. */
  insuranceBasisPointsApplied: number | null;
  insuranceCurrency: string | null;
  updatedByLabel: string;
  updatedAt: string;
}

/** What insurance this consignment may carry, from the operator's settings and the goods value. */
export interface InsuranceOffer {
  offered: boolean;
  basisPoints: number;
  maxInsuredBasisPoints: number;
  goodsValueMinor: string | null;
  maxInsuredValueMinor: string | null;
  currency: string | null;
}

/** Why the goods may not leave yet, for the note on the booking panel. */
export interface DispatchReadiness {
  /** Null when no inspection was decided for this order, or none is needed. */
  inspection: { open: boolean; reason: string } | null;
  compliance: { open: boolean; holds: number; overridden: boolean };
}

export interface CarrierSummary {
  /** How it is carried: a platform partner, a hand booking, a label bought through the seller's own account, or not yet. */
  kind: 'NONE' | 'PARTNER' | 'MANUAL_CARRIER' | 'OWN_ACCOUNT';
  name: string | null;
  trackingNumber: string | null;
}

/** The shipping terms an RFQ purchase order fixed for the order a consignment belongs to. */
export interface ContractShippingTerms {
  purchaseOrderReference: string;
  incoterm: string | null;
  incotermPlace: string | null;
  /** The export documents the supplier promised on the accepted quote. */
  exportDocuments: string[];
}

async function contractTermsFor(orderId: string | null): Promise<ContractShippingTerms | null> {
  if (orderId === null) return null;
  const { purchaseOrderForOrder } = await import('../rfq/purchase-order-order.service.js');
  const po = await purchaseOrderForOrder(orderId);
  if (po === null) return null;
  return {
    purchaseOrderReference: po.reference,
    incoterm: po.incoterm,
    incotermPlace: po.incotermPlace,
    exportDocuments: po.exportDocuments,
  };
}

export interface SellerShipmentBooking {
  shipmentId: string;
  reference: string;
  crossBorder: boolean;
  originCountry: string;
  destinationCountry: string;
  insurance: InsuranceOffer;
  dispatchReadiness: DispatchReadiness;
  /** Set when the order was made from an RFQ purchase order: the Incoterm, place and documents it fixed. */
  contractTerms: ContractShippingTerms | null;
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
  insured: true,
  insuredValueMinor: true,
  insurancePremiumMinor: true,
  insuranceBasisPointsApplied: true,
  currency: true,
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
  insured: boolean;
  insuredValueMinor: bigint | null;
  insurancePremiumMinor: bigint | null;
  insuranceBasisPointsApplied: number | null;
  currency: string | null;
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
    insured: row.insured,
    insuredValueMinor: row.insuredValueMinor?.toString() ?? null,
    insurancePremiumMinor: row.insurancePremiumMinor?.toString() ?? null,
    insuranceBasisPointsApplied: row.insuranceBasisPointsApplied,
    insuranceCurrency: row.currency,
    updatedByLabel: row.updatedByLabel,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The value of the goods on a consignment: its declared value, else its seller order's goods total. */
async function goodsValueOf(shipmentId: string): Promise<{ valueMinor: bigint | null; currency: string | null }> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: {
      declaredValueMinor: true,
      currency: true,
      sellerOrderGroup: { select: { goodsTotalMinor: true, currency: true } },
    },
  });
  if (shipment === null) return { valueMinor: null, currency: null };
  if (shipment.declaredValueMinor !== null && shipment.declaredValueMinor > 0n && shipment.currency !== null) {
    return { valueMinor: shipment.declaredValueMinor, currency: shipment.currency };
  }
  const group = shipment.sellerOrderGroup;
  if (group !== null && group.goodsTotalMinor > 0n) return { valueMinor: group.goodsTotalMinor, currency: group.currency };
  return { valueMinor: null, currency: null };
}

async function insuranceOfferFor(shipmentId: string): Promise<InsuranceOffer> {
  const [settings, goods] = await Promise.all([readInsuranceSettings(), goodsValueOf(shipmentId)]);
  return {
    offered: settings.insuranceOffered,
    basisPoints: settings.insuranceBasisPoints,
    maxInsuredBasisPoints: settings.maxInsuredBasisPoints,
    goodsValueMinor: goods.valueMinor?.toString() ?? null,
    maxInsuredValueMinor:
      goods.valueMinor === null ? null : maxInsuredValueMinor(goods.valueMinor, settings.maxInsuredBasisPoints).toString(),
    currency: goods.currency,
  };
}

/**
 * Whether the goods may leave yet: the pre-shipment inspection release (read
 * only - this never decides a requirement) and the destination documents hold.
 */
async function dispatchReadinessFor(sellerOrderGroupId: string | null): Promise<DispatchReadiness> {
  if (sellerOrderGroupId === null) {
    return { inspection: null, compliance: { open: true, holds: 0, overridden: false } };
  }
  const [requirement, compliance] = await Promise.all([
    prisma.inspectionRequirement.findUnique({
      where: { sellerOrderGroupId },
      select: { id: true, level: true },
    }),
    evaluateSellerOrderCompliance(prisma, sellerOrderGroupId),
  ]);
  let inspection: DispatchReadiness['inspection'] = null;
  if (requirement !== null && requirement.level !== 'NOT_REQUIRED') {
    const verdict = await peekGate(requirement.id);
    inspection = { open: verdict.open, reason: verdict.reason };
  }
  return {
    inspection,
    compliance: {
      open: compliance.open,
      holds: compliance.holds.filter((hold) => !hold.covered).length,
      overridden: compliance.overridden,
    },
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
  const [shipment, terms, carrier, insurance] = await Promise.all([
    prisma.logisticsShipment.findUnique({
      where: { id: shipmentId },
      select: { originCountry: true, destinationCountry: true, sellerOrderGroupId: true, orderId: true },
    }),
    prisma.consignmentBookingTerms.findUnique({ where: { shipmentId }, select: TERMS_SELECT }),
    carrierSummaryFor(shipmentId),
    insuranceOfferFor(shipmentId),
  ]);
  if (shipment === null) throw notFound('Consignment');

  return {
    shipmentId,
    reference: state.reference,
    crossBorder: shipment.originCountry !== shipment.destinationCountry,
    originCountry: shipment.originCountry,
    destinationCountry: shipment.destinationCountry,
    insurance,
    dispatchReadiness: await dispatchReadinessFor(shipment.sellerOrderGroupId),
    contractTerms: await contractTermsFor(shipment.orderId),
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
    select: { originCountry: true, destinationCountry: true, orderId: true },
  });
  if (shipment === null) throw notFound('Consignment');
  const crossBorder = shipment.originCountry !== shipment.destinationCountry;

  // An order made from an RFQ purchase order ships on the Incoterm both sides
  // signed for (LIVE-004). The booking may add detail; it may not change it.
  const contracted = await contractTermsFor(shipment.orderId);
  if (contracted !== null && contracted.incoterm !== null && contracted.incoterm !== incoterm) {
    invalid(
      `Purchase order ${contracted.purchaseOrderReference} was agreed on ${contracted.incoterm}. Book this consignment on the same Incoterm.`,
      'incoterm',
      'PURCHASE_ORDER_INCOTERM',
    );
  }

  if (crossBorder && (mode === 'AIR' || mode === 'SEA')) {
    if (originPort === null) invalid('Name the port the goods leave from.', 'originPort', 'REQUIRED');
    if (destinationPort === null) invalid('Name the port the goods arrive at.', 'destinationPort', 'REQUIRED');
  }

  // Cargo insurance (JOURNEY-046): checked against the operator's rate and
  // cap, the premium worked out in BigInt minor units. Omitted keeps it.
  let insurance: InsuranceDecision | null = null;
  if (booking.insured !== undefined) {
    const [settings, goods] = await Promise.all([readInsuranceSettings(), goodsValueOf(input.shipmentId)]);
    insurance = decideInsurance({
      insured: booking.insured,
      insuredValueMinor: booking.insuredValueMinor ?? null,
      settings,
      goods,
    });
  }

  const data = {
    ...(insurance === null ? {} : insurance),
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
    after: {
      ...data,
      pickupDate: pickupDateText,
      manualCarrier,
      ...(insurance === null
        ? {}
        : {
            insuredValueMinor: insurance.insuredValueMinor?.toString() ?? null,
            insurancePremiumMinor: insurance.insurancePremiumMinor?.toString() ?? null,
          }),
    },
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

// ---------------------------------------------------------------------------
// Freight options
// ---------------------------------------------------------------------------

export interface FreightOptions {
  originCountry: string;
  destinationCountry: string;
  weightGrams: number;
  /** The operator's rate cards in force for this route and weight, cheapest first, each with its validity. */
  options: LaneQuote[];
}

/**
 * The operator's own lanes that can carry one of the seller's consignments
 * today (JOURNEY-046): route, mode, carrier, transit, price and how long the
 * rate card is valid. Nothing is booked by asking; a consignment with no
 * weight yet has no options, because every band is priced by weight.
 */
export async function listFreightOptions(sellerAccountId: string, shipmentId: string): Promise<FreightOptions> {
  // `consignmentState` refuses another seller's consignment with a 404.
  await consignmentState(sellerAccountId, shipmentId);
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: { originCountry: true, destinationCountry: true, totalWeightGrams: true },
  });
  if (shipment === null) throw notFound('Consignment');
  const options =
    shipment.totalWeightGrams > 0
      ? await quoteLanes({
          originCountry: shipment.originCountry,
          destinationCountry: shipment.destinationCountry,
          weightGrams: shipment.totalWeightGrams,
        })
      : [];
  return {
    originCountry: shipment.originCountry,
    destinationCountry: shipment.destinationCountry,
    weightGrams: shipment.totalWeightGrams,
    options,
  };
}
