/**
 * Getting a price for a load no parcel carrier can take.
 *
 * WHY THIS EXISTS AT ALL
 *
 * A pallet is not a parcel and a container is not a big parcel. DHL, FedEx and
 * India Post are wired into this system as PARCEL carriers - their adapters
 * build a box with a weight and three dimensions, and their APIs price
 * something a courier can lift. Asking one of them for a twenty-tonne
 * container booking produces one of two outcomes, and the second is the
 * dangerous one:
 *
 *   1. It refuses, and the seller sees a provider error they cannot act on.
 *   2. It ANSWERS - with a price for something nobody will ever collect. The
 *      buyer is charged it, the pallet sits on the dock, and the difference is
 *      found when somebody rings to ask where it is.
 *
 * So where no configured carrier can express the load, the honest answer is a
 * QUOTATION: a request a person answers, with the load described well enough
 * for them to answer it. Nothing in this file invents a shipping figure, and
 * `state` is never `QUOTED` without an amount and a currency - the database
 * CHECK refuses that row even if a service forgets.
 *
 * WHAT IS NOT IN A QUOTE REQUEST
 *
 * The buyer's name, address or contact details. A freight desk prices a load
 * from its weight, its volume, its origin and its destination COUNTRY, and a
 * request carrying a hospital's delivery address is personal data travelling
 * to somebody who does not need it to do the job. The address is on the order,
 * where the carrier who actually collects reads it.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  consignmentLoadType,
  loadTypeForPackage,
  needsManualFreight,
  type FreightLoadTypeName,
} from '../../domain/freight-load.js';
import type { PackageType } from '../../domain/packaging.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';
import { notifySeller } from './notification.service.js';

export type FreightQuoteStateName =
  | 'REQUESTED'
  | 'QUOTED'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface FreightQuoteView {
  id: string;
  state: FreightQuoteStateName;
  loadType: FreightLoadTypeName;
  orderId: string | null;
  cartId: string | null;
  sellerOrderGroupId: string | null;

  totalPackages: number;
  totalBaseUnits: number;
  totalCartons: number | null;
  totalPallets: number | null;
  totalContainers: number | null;
  grossWeightGrams: string | null;
  volumeCm3: string | null;

  originCountry: string | null;
  destinationCountry: string | null;
  originPortLabel: string | null;
  incoterm: string | null;
  isHazardous: boolean;
  requiresColdChain: boolean;

  quotedAmountMinor: string | null;
  quotedCurrency: string | null;
  serviceName: string | null;
  carrierReference: string | null;
  trackingReference: string | null;
  expectedPickupAt: string | null;
  expectedDeliveryAt: string | null;
  quoteExpiresAt: string | null;
  responseNote: string | null;

  quotedAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One line of the load, as the freight desk needs to see it. */
export interface FreightLineSummary {
  packageType: PackageType;
  packageQuantity: number;
  unitsPerPackage: number;
  totalBaseUnits: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  grossWeightGrams: string | null;
}

/**
 * Raise a request for one seller's part of an order.
 *
 * Built from the FROZEN packaging snapshots on the order lines, never from the
 * seller's live configuration: the load being quoted is the load that was
 * bought, and a seller who re-specified a pallet between the order and the
 * quote must not have the lorry booked for a different pallet.
 *
 * Idempotent per order group and load type. Pressing "request a quote" twice
 * returns the request that already exists rather than creating a second one -
 * two open requests for one consignment is two freight desks pricing the same
 * load and one of them wasting an afternoon.
 */
export async function requestFreightQuote(input: {
  sellerAccountId: string;
  sellerOrderGroupId: string;
  requestedByProfileId: string | null;
  correlationId: string | null;
}): Promise<FreightQuoteView> {
  const group = await prisma.sellerOrderGroup.findUnique({
    where: { id: input.sellerOrderGroupId },
    include: {
      order: { select: { id: true, shippingAddressJson: true } },
      lines: { select: { orderItemId: true, quantity: true } },
    },
  });

  if (group === null) throw notFound('Order');
  if (group.sellerAccountId !== input.sellerAccountId) throw notFound('Order');

  const items = await prisma.orderItem.findMany({
    where: { id: { in: group.lines.map((line) => line.orderItemId) } },
    include: { packaging: true },
  });

  const snapshots = items
    .map((item) => item.packaging)
    .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);

  if (snapshots.length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Nothing on this order was bought by the pallet or the container, so there is no freight to quote.',
      [{ field: 'sellerOrderGroupId', code: 'NO_BULK_LINES' }],
    );
  }

  const loadType = consignmentLoadType(
    snapshots.map((snapshot) =>
      loadTypeForPackage(
        snapshot.packageType,
        snapshot.containerLoadMode,
      ),
    ),
  );

  // One open request per consignment per load type. A second press returns the
  // first rather than creating a rival.
  const existing = await prisma.sellerFreightQuoteRequest.findFirst({
    where: {
      sellerOrderGroupId: input.sellerOrderGroupId,
      loadType,
      state: { in: ['REQUESTED', 'QUOTED'] },
    },
  });

  if (existing !== null) return toView(existing);

  const totals = summarise(snapshots);

  /*
   * The DESTINATION COUNTRY only, out of the shipping address.
   *
   * A freight desk prices from weight, volume, origin and destination country.
   * The street address is on the order, for the carrier who actually collects;
   * putting it on a quote request would be sending a hospital's delivery
   * address to somebody whose job is to quote a rate.
   */
  const shipping = group.order.shippingAddressJson as { countryCode?: unknown } | null;
  const destinationCountry =
    typeof shipping?.countryCode === 'string' ? shipping.countryCode.slice(0, 2) : null;

  /*
   * Where it leaves from, read separately.
   *
   * `SellerOrderGroup` carries `locationId` and no relation to the location -
   * deliberately, because a seller may archive a place they no longer ship
   * from and an order that named it must still read back. Null is an honest
   * answer here: an order the seller has not yet accepted has no location
   * chosen, and a freight desk quoting one asks where it is coming from.
   */
  const origin =
    group.locationId === null
      ? null
      : await prisma.sellerLocation.findUnique({
          where: { id: group.locationId },
          select: { countryCode: true },
        });

  const originCountry = origin?.countryCode ?? null;

  const id = newId();

  const created = await prisma.sellerFreightQuoteRequest.create({
    data: {
      id,
      sellerAccountId: input.sellerAccountId,
      orderId: group.orderId,
      sellerOrderGroupId: group.id,
      state: 'REQUESTED',
      loadType,
      totalPackages: totals.totalPackages,
      totalBaseUnits: totals.totalBaseUnits,
      totalCartons: totals.totalCartons,
      totalPallets: totals.totalPallets,
      totalContainers: totals.totalContainers,
      grossWeightGrams: totals.grossWeightGrams,
      volumeCm3: totals.volumeCm3,
      originCountry: originCountry,
      destinationCountry,
      originPortLabel: snapshots.find((s) => s.originPortLabelSnapshot !== null)?.originPortLabelSnapshot ?? null,
      incoterm: snapshots.find((s) => s.incotermSnapshot !== null)?.incotermSnapshot ?? null,
      isHazardous: false,
      requiresColdChain: false,
      linesJson: totals.lines as never,
      requestedByProfileId: input.requestedByProfileId,
      correlationId: input.correlationId,
    },
  });

  await notifySeller({
    sellerAccountId: input.sellerAccountId,
    kind: 'FREIGHT_QUOTE_REQUESTED',
    title: `A freight price is needed for ${group.sellerOrderNumber}`,
    body:
      `${describeLoad(loadType, totals)} No carrier on this account can price this automatically, ` +
      'so a figure has to be entered by hand before it can be despatched.',
    linkPath: `/seller/orders/${group.id}`,
    severity: 'WARNING',
    subjectType: 'seller_freight_quote',
    subjectId: id,
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.freight_quote.requested',
    actor: { type: 'SYSTEM', label: 'Glovia' },
    resourceType: 'seller_freight_quote_request',
    resourceId: id,
    summary: `A freight quotation was raised for ${group.sellerOrderNumber}.`,
    correlationId: input.correlationId,
  });

  return toView(created);
}

/**
 * Answer a request with a real figure.
 *
 * `QUOTED` requires an amount AND a currency, here and in the database - the
 * `chk_freight_quote_amounts` CHECK refuses the row otherwise. That is the one
 * invariant this table exists to hold: a quote with no number is not a quote,
 * and a screen that showed one would be showing a price that does not exist.
 */
export async function answerFreightQuote(input: {
  membership: SellerMembership;
  requestId: string;
  amountMinor: string;
  currency: string;
  serviceName: string | null;
  carrierReference: string | null;
  trackingReference: string | null;
  expectedPickupAt: Date | null;
  expectedDeliveryAt: Date | null;
  quoteExpiresAt: Date | null;
  responseNote: string | null;
  actorUserId: string | null;
  correlationId: string | null;
}): Promise<FreightQuoteView> {
  assertSellerPermission(input.membership, SellerPermission.FULFILMENT_WRITE);

  const request = await prisma.sellerFreightQuoteRequest.findUnique({
    where: { id: input.requestId },
  });

  assertSellerOwnership(input.membership, request?.sellerAccountId ?? null, 'Freight request');
  if (request === null) throw notFound('Freight request');

  if (request.state !== 'REQUESTED' && request.state !== 'QUOTED') {
    throw conflict(
      ErrorCode.FREIGHT_QUOTE_NOT_ACTIONABLE,
      'That freight request has already been settled.',
      [{ code: 'NOT_ACTIONABLE', meta: { state: request.state } }],
    );
  }

  if (!/^\d{1,19}$/.test(input.amountMinor)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That is not an amount we can use.', [
      { field: 'amountMinor', code: 'INVALID' },
    ]);
  }

  const updated = await prisma.sellerFreightQuoteRequest.update({
    where: { id: request.id },
    data: {
      state: 'QUOTED',
      quotedAmountMinor: BigInt(input.amountMinor),
      quotedCurrency: input.currency.toUpperCase().slice(0, 3),
      serviceName: input.serviceName?.slice(0, 160) ?? null,
      carrierReference: input.carrierReference?.slice(0, 120) ?? null,
      trackingReference: input.trackingReference?.slice(0, 120) ?? null,
      expectedPickupAt: input.expectedPickupAt,
      expectedDeliveryAt: input.expectedDeliveryAt,
      quoteExpiresAt: input.quoteExpiresAt,
      responseNote: input.responseNote?.slice(0, 1000) ?? null,
      quotedByUserId: input.actorUserId,
      quotedAt: new Date(),
    },
  });

  await notifySeller({
    sellerAccountId: request.sellerAccountId,
    kind: 'FREIGHT_QUOTE_AVAILABLE',
    title: 'A freight price has been entered',
    body: input.serviceName === null
      ? 'The consignment can now be despatched.'
      : `${input.serviceName}. The consignment can now be despatched.`,
    linkPath:
      request.sellerOrderGroupId === null
        ? '/seller/orders'
        : `/seller/orders/${request.sellerOrderGroupId}`,
    severity: 'SUCCESS',
    subjectType: 'seller_freight_quote',
    subjectId: request.id,
  });

  await recordSellerAudit({
    sellerAccountId: request.sellerAccountId,
    action: 'seller.freight_quote.answered',
    actor: { type: 'CUSTOMER', userId: input.actorUserId, label: input.membership.displayName },
    resourceType: 'seller_freight_quote_request',
    resourceId: request.id,
    summary: `A freight price of ${input.amountMinor} ${input.currency} was entered.`,
    correlationId: input.correlationId,
  });

  return toView(updated);
}

/** Refuse to carry it, with a reason the seller can act on. */
export async function declineFreightQuote(input: {
  membership: SellerMembership;
  requestId: string;
  reason: string;
  actorUserId: string | null;
}): Promise<FreightQuoteView> {
  assertSellerPermission(input.membership, SellerPermission.FULFILMENT_WRITE);

  const request = await prisma.sellerFreightQuoteRequest.findUnique({
    where: { id: input.requestId },
  });

  assertSellerOwnership(input.membership, request?.sellerAccountId ?? null, 'Freight request');
  if (request === null) throw notFound('Freight request');

  if (request.state !== 'REQUESTED' && request.state !== 'QUOTED') {
    throw conflict(
      ErrorCode.FREIGHT_QUOTE_NOT_ACTIONABLE,
      'That freight request has already been settled.',
      [{ code: 'NOT_ACTIONABLE', meta: { state: request.state } }],
    );
  }

  const updated = await prisma.sellerFreightQuoteRequest.update({
    where: { id: request.id },
    data: {
      state: 'DECLINED',
      responseNote: input.reason.slice(0, 1000),
      decidedAt: new Date(),
      quotedByUserId: input.actorUserId,
    },
  });

  return toView(updated);
}

/** Every freight request on this seller's account. */
export async function listFreightQuotes(input: {
  membership: SellerMembership;
  state?: FreightQuoteStateName | null;
  orderGroupId?: string | null;
}): Promise<FreightQuoteView[]> {
  assertSellerPermission(input.membership, SellerPermission.FULFILMENT_READ);

  const rows = await prisma.sellerFreightQuoteRequest.findMany({
    where: {
      sellerAccountId: input.membership.sellerAccountId,
      ...(input.state === null || input.state === undefined ? {} : { state: input.state }),
      ...(input.orderGroupId === null || input.orderGroupId === undefined
        ? {}
        : { sellerOrderGroupId: input.orderGroupId }),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return rows.map(toView);
}

/**
 * Whether this consignment can go through a carrier at all.
 *
 * The one place the question is answered for a seller's screen, so the button
 * that books a carrier and the panel that explains why it is disabled cannot
 * disagree. It returns a DECISION and never a price - see `domain/freight-load.ts`.
 */
export async function freightNeedsQuote(sellerOrderGroupId: string): Promise<{
  needsQuote: boolean;
  loadType: FreightLoadTypeName;
}> {
  const group = await prisma.sellerOrderGroup.findUnique({
    where: { id: sellerOrderGroupId },
    select: { lines: { select: { orderItemId: true } } },
  });

  if (group === null) return { needsQuote: false, loadType: 'PARCEL' };

  const items = await prisma.orderItem.findMany({
    where: { id: { in: group.lines.map((line) => line.orderItemId) } },
    select: {
      packaging: { select: { packageType: true, containerLoadMode: true } },
    },
  });

  const loadType = consignmentLoadType(
    items
      .map((item) => item.packaging)
      .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null)
      .map((snapshot) =>
        loadTypeForPackage(
          snapshot.packageType,
          snapshot.containerLoadMode,
        ),
      ),
  );

  return { needsQuote: needsManualFreight(loadType), loadType };
}

// ---------------------------------------------------------------------------

interface LoadTotals {
  totalPackages: number;
  totalBaseUnits: number;
  totalCartons: number | null;
  totalPallets: number | null;
  totalContainers: number | null;
  grossWeightGrams: bigint | null;
  volumeCm3: bigint | null;
  lines: FreightLineSummary[];
}

/**
 * Add the load up.
 *
 * `bigint` for the weight and the volume, like every other large integer here.
 * A consignment of forty pallets at thirty kilograms each is well inside JS's
 * safe range today; the habit is what keeps it safe when somebody adds a
 * container of steel.
 */
function summarise(
  snapshots: readonly {
    packageType: string;
    packageQuantity: number;
    unitsPerPackage: number;
    totalBaseUnits: number;
    cartonsPerPallet: number | null;
    palletsPerContainer: number | null;
    cartonsPerContainer: number | null;
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    grossWeightGrams: bigint | null;
    cargoVolumeCm3: bigint | null;
  }[],
): LoadTotals {
  let totalPackages = 0;
  let totalBaseUnits = 0;
  let totalCartons = 0;
  let totalPallets = 0;
  let totalContainers = 0;
  let grossWeightGrams = 0n;
  let volumeCm3 = 0n;

  const lines: FreightLineSummary[] = [];

  for (const snapshot of snapshots) {
    const type = snapshot.packageType as PackageType;

    totalPackages += snapshot.packageQuantity;
    totalBaseUnits += snapshot.totalBaseUnits;

    if (type === 'CARTON') totalCartons += snapshot.packageQuantity;
    if (type === 'UK_PALLET' || type === 'US_PALLET') {
      totalPallets += snapshot.packageQuantity;
      totalCartons += snapshot.packageQuantity * (snapshot.cartonsPerPallet ?? 0);
    }
    if (type === 'CONTAINER') {
      totalContainers += snapshot.packageQuantity;
      totalPallets += snapshot.packageQuantity * (snapshot.palletsPerContainer ?? 0);
      totalCartons += snapshot.packageQuantity * (snapshot.cartonsPerContainer ?? 0);
    }

    if (snapshot.grossWeightGrams !== null) {
      grossWeightGrams += snapshot.grossWeightGrams * BigInt(snapshot.packageQuantity);
    }
    if (snapshot.cargoVolumeCm3 !== null) {
      volumeCm3 += snapshot.cargoVolumeCm3 * BigInt(snapshot.packageQuantity);
    }

    lines.push({
      packageType: type,
      packageQuantity: snapshot.packageQuantity,
      unitsPerPackage: snapshot.unitsPerPackage,
      totalBaseUnits: snapshot.totalBaseUnits,
      lengthMm: snapshot.lengthMm,
      widthMm: snapshot.widthMm,
      heightMm: snapshot.heightMm,
      grossWeightGrams: snapshot.grossWeightGrams?.toString() ?? null,
    });
  }

  return {
    totalPackages,
    totalBaseUnits,
    totalCartons: totalCartons > 0 ? totalCartons : null,
    totalPallets: totalPallets > 0 ? totalPallets : null,
    totalContainers: totalContainers > 0 ? totalContainers : null,
    grossWeightGrams: grossWeightGrams > 0n ? grossWeightGrams : null,
    volumeCm3: volumeCm3 > 0n ? volumeCm3 : null,
    lines,
  };
}

/** A sentence for the seller's notification. English, like every other one. */
function describeLoad(loadType: FreightLoadTypeName, totals: LoadTotals): string {
  const parts: string[] = [];

  if (totals.totalContainers !== null) {
    parts.push(`${String(totals.totalContainers)} container${totals.totalContainers === 1 ? '' : 's'}`);
  }
  if (totals.totalPallets !== null) {
    parts.push(`${String(totals.totalPallets)} pallet${totals.totalPallets === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) {
    parts.push(`${String(totals.totalPackages)} package${totals.totalPackages === 1 ? '' : 's'}`);
  }

  const weight =
    totals.grossWeightGrams === null
      ? ''
      : `, about ${(Number(totals.grossWeightGrams) / 1000).toLocaleString('en-GB', { maximumFractionDigits: 0 })} kg`;

  return `${parts.join(' and ')}${weight} (${loadType}).`;
}

function toView(row: {
  id: string;
  state: string;
  loadType: string;
  orderId: string | null;
  cartId: string | null;
  sellerOrderGroupId: string | null;
  totalPackages: number;
  totalBaseUnits: number;
  totalCartons: number | null;
  totalPallets: number | null;
  totalContainers: number | null;
  grossWeightGrams: bigint | null;
  volumeCm3: bigint | null;
  originCountry: string | null;
  destinationCountry: string | null;
  originPortLabel: string | null;
  incoterm: string | null;
  isHazardous: boolean;
  requiresColdChain: boolean;
  quotedAmountMinor: bigint | null;
  quotedCurrency: string | null;
  serviceName: string | null;
  carrierReference: string | null;
  trackingReference: string | null;
  expectedPickupAt: Date | null;
  expectedDeliveryAt: Date | null;
  quoteExpiresAt: Date | null;
  responseNote: string | null;
  quotedAt: Date | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): FreightQuoteView {
  return {
    id: row.id,
    state: row.state as FreightQuoteStateName,
    loadType: row.loadType as FreightLoadTypeName,
    orderId: row.orderId,
    cartId: row.cartId,
    sellerOrderGroupId: row.sellerOrderGroupId,
    totalPackages: row.totalPackages,
    totalBaseUnits: row.totalBaseUnits,
    totalCartons: row.totalCartons,
    totalPallets: row.totalPallets,
    totalContainers: row.totalContainers,
    grossWeightGrams: row.grossWeightGrams?.toString() ?? null,
    volumeCm3: row.volumeCm3?.toString() ?? null,
    originCountry: row.originCountry,
    destinationCountry: row.destinationCountry,
    originPortLabel: row.originPortLabel,
    incoterm: row.incoterm,
    isHazardous: row.isHazardous,
    requiresColdChain: row.requiresColdChain,
    quotedAmountMinor: row.quotedAmountMinor?.toString() ?? null,
    quotedCurrency: row.quotedCurrency,
    serviceName: row.serviceName,
    carrierReference: row.carrierReference,
    trackingReference: row.trackingReference,
    expectedPickupAt: row.expectedPickupAt?.toISOString() ?? null,
    expectedDeliveryAt: row.expectedDeliveryAt?.toISOString() ?? null,
    quoteExpiresAt: row.quoteExpiresAt?.toISOString() ?? null,
    responseNote: row.responseNote,
    quotedAt: row.quotedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
