/**
 * Pricing a consignment, and buying it.
 *
 * The two operations on this path that cost real money, and the two places a
 * mistake is expensive rather than merely wrong:
 *
 *   - a quote a seller agreed to that nobody can reproduce afterwards, and
 *   - a consignment bought twice because somebody double-clicked.
 *
 * WHY A QUOTE IS KEPT RATHER THAN RECOMPUTED
 *
 * A carrier reprices overnight. An exchange rate moves. A seller's own rate
 * card is republished. The figure the seller accepted has to remain
 * retrievable months later with the carrier's own reference beside it, because
 * the question "why was I charged this?" is asked after all three have
 * happened. Every component is stored separately, because a seller querying a
 * delivery charge is almost always querying one component of it.
 *
 * WHY THE PURCHASE IS AN IDEMPOTENCY ROW AND NOT A FLAG
 *
 * Creating a consignment at a carrier is a chargeable act that a retry, a
 * double click or a redelivered job will repeat. The defence is
 * `shipment_purchases.idempotencyKey`, which is UNIQUE: the second attempt
 * collides in the database rather than booking a second parcel, and the first
 * attempt's answer is returned. A check-then-insert loses that race, which is
 * exactly the race a slow carrier call creates.
 *
 * MONEY IS BigInt MINOR UNITS THROUGHOUT. The only place a float exists is
 * inside the adapter, converting what the carrier sent at the boundary.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import type { CarrierAddress, CarrierParcel } from '../logistics/carrier/adapter.js';
import { recordSellerAudit } from './audit.service.js';
import { adapterForSellerConnection } from './carrier-connection.service.js';
import { safeCarrierMessage } from './carrier-credential.service.js';
import {
  notifyConnectionFailed,
  resolveConnectionAlert,
} from './fulfilment-notification.service.js';
import type { SellerActor } from './fulfilment-method.service.js';

/** How long a stored quote stands before the shipment has to ask again. */
const QUOTE_LIFETIME_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Reading the consignment
// ---------------------------------------------------------------------------

interface ShipmentForCarrier {
  id: string;
  sellerAccountId: string;
  currency: string | null;
  from: CarrierAddress;
  to: CarrierAddress;
  parcels: CarrierParcel[];
  connectionId: string | null;
  methodId: string | null;
}

/**
 * Load one of this seller's consignments in the shape a carrier wants.
 *
 * Both ids in the same query. A consignment belonging to another seller is not
 * found, rather than found and then refused - which is the difference between
 * a boundary and a check.
 */
async function loadForCarrier(
  sellerAccountId: string,
  shipmentId: string,
): Promise<ShipmentForCarrier> {
  const shipment = await prisma.logisticsShipment.findFirst({
    where: { id: shipmentId, sellerAccountId },
    select: {
      id: true,
      sellerAccountId: true,
      currency: true,
      shipmentReference: true,
      sellerCompanyName: true,
      receivingCompanyName: true,
      pickupAddressJson: true,
      deliveryAddressJson: true,
      pickupContactName: true,
      pickupContactPhone: true,
      deliveryContactName: true,
      deliveryContactPhone: true,
      totalWeightGrams: true,
      sellerCarrierConnectionId: true,
      sellerFulfilmentMethodId: true,
      packages: {
        select: {
          packageReference: true,
          weightGrams: true,
          lengthMm: true,
          widthMm: true,
          heightMm: true,
        },
      },
    },
  });

  if (shipment === null) throw notFound('Consignment');

  const from = addressFrom(shipment.pickupAddressJson, shipment.sellerCompanyName, {
    name: shipment.pickupContactName,
    phone: shipment.pickupContactPhone,
  });

  const to = addressFrom(shipment.deliveryAddressJson, shipment.receivingCompanyName, {
    name: shipment.deliveryContactName,
    phone: shipment.deliveryContactPhone,
  });

  /*
   * One parcel where none were recorded.
   *
   * A consignment with no package rows is one nobody has weighed yet, and a
   * carrier will not price nothing. The total weight on the shipment is the
   * honest fallback; where that is zero too, the caller is told rather than
   * being quoted for a gram.
   */
  const parcels: CarrierParcel[] =
    shipment.packages.length > 0
      ? shipment.packages.map((parcel) => ({
          reference: parcel.packageReference,
          weightGrams: parcel.weightGrams,
          lengthMm: parcel.lengthMm,
          widthMm: parcel.widthMm,
          heightMm: parcel.heightMm,
        }))
      : [{ reference: shipment.shipmentReference, weightGrams: shipment.totalWeightGrams }];

  if (parcels.every((parcel) => parcel.weightGrams <= 0)) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'This consignment has no weight recorded, so no carrier can price it. Confirm the packages first.',
      [{ field: 'packages', code: 'NO_WEIGHT' }],
    );
  }

  return {
    id: shipment.id,
    // The argument, not the column: the query filtered on it, so it is this
    // seller by construction - and Prisma types the column nullable because an
    // operator's own consignment has no seller behind it.
    sellerAccountId,
    currency: shipment.currency,
    from,
    to,
    parcels,
    connectionId: shipment.sellerCarrierConnectionId,
    methodId: shipment.sellerFulfilmentMethodId,
  };
}

/** Read an address snapshot defensively - the column is JSON. */
function addressFrom(
  value: unknown,
  companyName: string,
  contact: { name: string | null; phone: string | null },
): CarrierAddress {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;

  const text = (key: string): string =>
    typeof record[key] === 'string' ? (record[key]) : '';

  return {
    companyName,
    contactName: contact.name,
    phone: contact.phone,
    line1: text('line1'),
    line2: typeof record.line2 === 'string' ? record.line2 : null,
    city: text('city'),
    region: typeof record.region === 'string' ? record.region : null,
    postalCode: text('postalCode'),
    countryCode: text('countryCode'),
  };
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export interface QuoteView {
  id: string;
  provider: string;
  serviceCode: string;
  serviceName: string | null;
  currency: string;
  /** Minor units, as strings. BigInt does not survive JSON. */
  baseChargeMinor: string;
  totalMinor: string;
  estimatedTransitDays: number | null;
  expiresAt: string | null;
  state: string;
  isSelected: boolean;
}

function toQuoteView(row: {
  id: string;
  provider: string;
  serviceCode: string;
  serviceName: string | null;
  currency: string;
  baseChargeMinor: bigint;
  totalMinor: bigint;
  estimatedTransitDays: number | null;
  expiresAt: Date | null;
  state: string;
  selectedForShipmentId: string | null;
}): QuoteView {
  return {
    id: row.id,
    provider: row.provider,
    serviceCode: row.serviceCode,
    serviceName: row.serviceName,
    currency: row.currency,
    // Strings, deliberately. A delivery charge that crossed the API as a
    // JavaScript number would be a float the moment it arrived.
    baseChargeMinor: row.baseChargeMinor.toString(),
    totalMinor: row.totalMinor.toString(),
    estimatedTransitDays: row.estimatedTransitDays,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    state: row.state,
    isSelected: row.selectedForShipmentId !== null,
  };
}

/**
 * Ask the carrier what this consignment costs, and keep the answers.
 *
 * Every previous OFFERED quote for the shipment is superseded first, so the
 * list a seller is looking at is the list from one moment rather than a pile
 * accumulated over a week. A SELECTED quote is left alone - it is what the
 * seller agreed to, and re-pricing must not silently replace it.
 */
export async function quoteConsignment(input: {
  sellerAccountId: string;
  actor: SellerActor;
  shipmentId: string;
}): Promise<QuoteView[]> {
  const shipment = await loadForCarrier(input.sellerAccountId, input.shipmentId);

  if (shipment.connectionId === null || shipment.methodId === null) {
    throw conflict(
      ErrorCode.SELLER_FULFILMENT_NO_ELIGIBLE_METHOD,
      'This consignment is not going by a carrier account, so there is nothing to price.',
      [{ code: 'NO_CARRIER_ACCOUNT' }],
    );
  }

  const adapter = await adapterForSellerConnection(shipment.connectionId);

  let rates;

  try {
    rates = await adapter.getRates({
      from: shipment.from,
      to: shipment.to,
      parcels: shipment.parcels,
    });
  } catch (error) {
    await recordConnectionFailure(shipment.connectionId, error);
    throw error;
  }

  await recordConnectionSuccess(shipment.connectionId);

  const expiresAt = new Date(Date.now() + QUOTE_LIFETIME_MS);

  await prisma.$transaction(async (tx) => {
    // Supersede, never delete. A quote a seller saw is worth keeping even
    // when a newer one replaced it.
    await tx.carrierRateQuote.updateMany({
      where: { shipmentId: shipment.id, state: 'OFFERED' },
      data: { state: 'SUPERSEDED' },
    });

    for (const rate of rates) {
      await tx.carrierRateQuote.create({
        data: {
          id: newId(),
          shipmentId: shipment.id,
          sellerAccountId: shipment.sellerAccountId,
          fulfilmentMethodId: shipment.methodId as string,
          sellerCarrierConnectionId: shipment.connectionId,
          provider: adapter.provider as never,
          serviceCode: rate.serviceCode,
          serviceName: rate.serviceName,
          currency: rate.currency,
          baseChargeMinor: rate.amountMinor,
          // The carrier quoted one figure. Surcharges and tax are not split
          // out unless they send them split, and inventing a breakdown would
          // be worse than showing the total it actually gave.
          totalMinor: rate.amountMinor,
          estimatedTransitDays: rate.estimatedTransitDays ?? null,
          expiresAt,
        },
      });
    }
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.carrier.quoted',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'LogisticsShipment',
    resourceId: shipment.id,
    after: { provider: adapter.provider, services: rates.length },
    summary: `Priced a consignment with ${adapter.provider}: ${String(rates.length)} services.`,
  });

  return listQuotes(input.sellerAccountId, shipment.id);
}

export async function listQuotes(
  sellerAccountId: string,
  shipmentId: string,
): Promise<QuoteView[]> {
  const rows = await prisma.carrierRateQuote.findMany({
    where: { shipmentId, sellerAccountId, state: { in: ['OFFERED', 'SELECTED'] } },
    orderBy: [{ state: 'asc' }, { totalMinor: 'asc' }],
  });

  return rows.map(toQuoteView);
}

/**
 * The seller picks one.
 *
 * `selectedForShipmentId` holds the shipment id while this quote is the chosen
 * one and NULL otherwise, and a UNIQUE index over it means exactly one quote
 * per consignment can be selected. Two selected quotes is two different
 * numbers on one invoice.
 */
export async function selectQuote(input: {
  sellerAccountId: string;
  actor: SellerActor;
  shipmentId: string;
  quoteId: string;
}): Promise<QuoteView[]> {
  const quote = await prisma.carrierRateQuote.findFirst({
    where: { id: input.quoteId, shipmentId: input.shipmentId, sellerAccountId: input.sellerAccountId },
    select: { id: true, state: true, expiresAt: true, serviceCode: true },
  });

  if (quote === null) throw notFound('Quote');

  if (quote.state === 'SUPERSEDED' || quote.state === 'EXPIRED') {
    throw conflict(
      ErrorCode.CARRIER_QUOTE_NOT_USABLE,
      'That price is out of date. Ask the carrier again.',
      [{ code: 'QUOTE_STALE', meta: { state: quote.state } }],
    );
  }

  if (quote.expiresAt !== null && quote.expiresAt.getTime() <= Date.now()) {
    // Marked, not silently re-priced. A consignment that quietly changed price
    // between the seller agreeing and the carrier booking is the failure this
    // whole file is arranged to prevent.
    await prisma.carrierRateQuote.update({
      where: { id: quote.id },
      data: { state: 'EXPIRED' },
    });

    throw conflict(
      ErrorCode.CARRIER_QUOTE_NOT_USABLE,
      'That price has expired. Ask the carrier again.',
      [{ code: 'QUOTE_EXPIRED' }],
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.carrierRateQuote.updateMany({
        where: { shipmentId: input.shipmentId, state: 'SELECTED' },
        data: { state: 'OFFERED', selectedForShipmentId: null },
      });

      await tx.carrierRateQuote.update({
        where: { id: quote.id },
        data: { state: 'SELECTED', selectedForShipmentId: input.shipmentId },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw conflict(
        ErrorCode.CARRIER_QUOTE_NOT_USABLE,
        'Somebody chose a price for this consignment at the same time. Open it again.',
        [{ code: 'QUOTE_RACE' }],
      );
    }

    throw error;
  }

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.carrier.quote.selected',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'CarrierRateQuote',
    resourceId: quote.id,
    after: { serviceCode: quote.serviceCode },
    summary: `Chose the ${quote.serviceCode} service for a consignment.`,
  });

  return listQuotes(input.sellerAccountId, input.shipmentId);
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

export interface PurchaseResult {
  trackingNumber: string;
  provider: string;
  /** True where this call did the buying; false where it returned an earlier one. */
  purchasedNow: boolean;
  labelDocumentId: string | null;
}

/**
 * Book the consignment at the carrier.
 *
 * THE IDEMPOTENCY KEY IS DERIVED, NOT GENERATED. It is a digest of the
 * shipment, the selected quote and the service, so a genuine retry of the SAME
 * purchase produces the same key and collides - while a deliberate second
 * purchase after a cancellation, against a different quote, produces a new one
 * and is allowed.
 *
 * The row is written BEFORE the carrier is called, in PENDING. That is the
 * point: a crash mid-call leaves evidence that something may have been bought,
 * which is the state a reconciliation has to be able to find. A row written
 * afterwards would leave a booked-and-unrecorded parcel invisible.
 */
export async function purchaseConsignment(input: {
  sellerAccountId: string;
  actor: SellerActor;
  shipmentId: string;
}): Promise<PurchaseResult> {
  const shipment = await loadForCarrier(input.sellerAccountId, input.shipmentId);

  if (shipment.connectionId === null) {
    throw conflict(
      ErrorCode.SELLER_FULFILMENT_NO_ELIGIBLE_METHOD,
      'This consignment is not going by a carrier account.',
      [{ code: 'NO_CARRIER_ACCOUNT' }],
    );
  }

  const selected = await prisma.carrierRateQuote.findFirst({
    where: { shipmentId: shipment.id, state: 'SELECTED' },
    select: { id: true, serviceCode: true, provider: true },
  });

  if (selected === null) {
    throw conflict(
      ErrorCode.CARRIER_QUOTE_NOT_USABLE,
      'Choose a service before booking this consignment.',
      [{ code: 'NO_SELECTED_QUOTE' }],
    );
  }

  const idempotencyKey = sha256Hex(
    `${shipment.id}:${selected.id}:${selected.serviceCode}`,
  ).slice(0, 64);

  /*
   * Already bought?
   *
   * Checked first so the common retry is a cheap read. The UNIQUE index below
   * is what actually prevents a second booking - this is the fast path, not
   * the guard.
   */
  const existing = await prisma.shipmentPurchase.findUnique({
    where: { idempotencyKey },
    select: { state: true, providerTrackingNumber: true, provider: true },
  });

  if (existing !== null && existing.state === 'SUCCEEDED') {
    return {
      trackingNumber: existing.providerTrackingNumber ?? '',
      provider: existing.provider,
      purchasedNow: false,
      labelDocumentId: null,
    };
  }

  const purchaseId = existing === null ? newId() : undefined;

  if (existing === null) {
    try {
      await prisma.shipmentPurchase.create({
        data: {
          id: purchaseId as string,
          shipmentId: shipment.id,
          sellerAccountId: shipment.sellerAccountId,
          idempotencyKey,
          provider: selected.provider,
          sellerCarrierConnectionId: shipment.connectionId,
          quoteId: selected.id,
          state: 'PENDING',
          createdBySellerMemberId: input.actor.memberId,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Somebody else got there in the same millisecond. Their row is the
        // one that counts.
        throw conflict(
          ErrorCode.SHIPMENT_ALREADY_PURCHASED,
          'This consignment is already being booked. Open it again in a moment.',
          [{ code: 'PURCHASE_IN_FLIGHT' }],
        );
      }

      throw error;
    }
  }

  const adapter = await adapterForSellerConnection(shipment.connectionId);

  let booked;

  try {
    booked = await adapter.createShipment({
      shipmentReference: shipment.id,
      serviceCode: selected.serviceCode,
      from: shipment.from,
      to: shipment.to,
      parcels: shipment.parcels,
      currency: shipment.currency,
      idempotencyKey,
    });
  } catch (error) {
    const message = safeCarrierMessage(error);

    await prisma.shipmentPurchase.updateMany({
      where: { idempotencyKey },
      data: { state: 'FAILED', failureMessage: message, completedAt: new Date() },
    });

    await recordConnectionFailure(shipment.connectionId, error);
    throw error;
  }

  /*
   * The label, stored privately.
   *
   * Never public, never guessable, and served later only through the existing
   * signed-link route - which sets `nosniff` and serves as an attachment. A
   * shipping label carries the consignee's full name and address; a public URL
   * for one is a disclosure with no authentication in front of it.
   */
  let labelDocumentId: string | null = null;

  if (booked.label !== null && booked.label !== undefined) {
    labelDocumentId = await storeLabel(shipment.id, booked.label);
  }

  await prisma.$transaction(async (tx) => {
    await tx.shipmentPurchase.updateMany({
      where: { idempotencyKey },
      data: {
        state: 'SUCCEEDED',
        providerShipmentId: booked.carrierShipmentId ?? null,
        providerTrackingNumber: booked.carrierTrackingNumber,
        purchasedShipmentId: shipment.id,
        completedAt: new Date(),
      },
    });

    /*
     * The carrier's number goes onto the consignment; OUR tracking number is
     * left alone. A customer who bookmarked a tracking page keeps it working
     * even if the consignment is later re-booked with somebody else.
     */
    await tx.logisticsShipment.update({
      where: { id: shipment.id },
      data: {
        carrierTrackingNumber: booked.carrierTrackingNumber,
        carrierTrackingUrl: booked.trackingUrl ?? null,
      },
    });
  });

  await recordConnectionSuccess(shipment.connectionId);

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.carrier.purchased',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'LogisticsShipment',
    resourceId: shipment.id,
    after: {
      provider: adapter.provider,
      service: selected.serviceCode,
      trackingNumber: booked.carrierTrackingNumber,
    },
    summary: `Booked a consignment with ${adapter.provider}.`,
  });

  return {
    trackingNumber: booked.carrierTrackingNumber,
    provider: adapter.provider,
    purchasedNow: true,
    labelDocumentId,
  };
}

/**
 * Put a label in private storage and record it against the consignment.
 *
 * Deliberately not `uploadShipmentDocument`, which requires a carrier
 * membership: this label arrived from the carrier's API in answer to the
 * SELLER's own purchase, and there may be no carrier user involved at all. The
 * row it writes is the same shape, so the existing document list and signed
 * download route serve it without knowing the difference.
 */
async function storeLabel(
  shipmentId: string,
  label: { contentType: string; bytes: Buffer },
): Promise<string> {
  const extension = label.contentType.includes('zpl') ? 'zpl' : 'pdf';
  const stored = await storage.put(label.bytes, label.contentType, extension, 'private');

  const id = newId();

  await prisma.logisticsShipmentDocument.create({
    data: {
      id,
      shipmentId,
      kind: 'SHIPPING_LABEL',
      fileName: `label.${extension}`,
      contentType: label.contentType,
      sizeBytes: label.bytes.byteLength,
      storageKey: stored.storageKey,
      // The bytes the carrier sent, hashed, so the label served later can be
      // shown to be the one that was issued.
      contentHash: sha256Hex(label.bytes.toString('base64')),
      /*
       * SKIPPED, never CLEAN. Nothing scanned it, and a value that claimed
       * otherwise would be read downstream as a guarantee nobody gave. It came
       * from the carrier's own API rather than from an upload form, which is
       * the reason it is allowed at all.
       */
      scanState: 'SKIPPED',
      // PARTNER: the carrier holding the consignment is who needs the label.
      audience: 'PARTNER',
      // It came from the carrier's own API, not from a person at a form.
      uploadedBySource: 'CARRIER_API',
    },
  });

  return id;
}

// ---------------------------------------------------------------------------
// Health, written from the one place that knows
// ---------------------------------------------------------------------------

export async function recordConnectionSuccess(connectionId: string): Promise<void> {
  await prisma.sellerCarrierConnection.update({
    where: { id: connectionId },
    data: { lastSuccessAt: new Date(), consecutiveFailures: 0, lastFailureMessage: null },
  });

  /*
   * Close the alert, keep the row.
   *
   * The problem is over, so it stops being counted - but the record of it
   * stays, because "was DHL down last Tuesday?" is asked a week later and a
   * notification that deleted itself when things got better would have no
   * answer.
   */
  await resolveConnectionAlert(connectionId);
}

export async function recordConnectionFailure(connectionId: string, error: unknown): Promise<void> {
  await prisma.sellerCarrierConnection.update({
    where: { id: connectionId },
    data: {
      lastFailureAt: new Date(),
      // Sanitised before it is stored. A failure message is the commonest
      // place a credential ends up in a database.
      lastFailureMessage: safeCarrierMessage(error),
      consecutiveFailures: { increment: 1 },
    },
  });

  /*
   * One alert per connection, not one per failure.
   *
   * The dedupe key is the connection, so a carrier that has been down for an
   * hour produces one notification rather than forty - and the seller sees a
   * problem rather than a stream they learn to ignore.
   */
  const connection = await prisma.sellerCarrierConnection.findUnique({
    where: { id: connectionId },
    select: { sellerAccountId: true, provider: true, lastSuccessAt: true },
  });

  if (connection !== null) {
    await notifyConnectionFailed({
      sellerAccountId: connection.sellerAccountId,
      connectionId,
      provider: connection.provider,
      message: safeCarrierMessage(error),
      // The last time it worked identifies this outage, and stays the same
      // for as long as the outage lasts.
      episode: connection.lastSuccessAt?.toISOString() ?? 'never',
    });
  }
}
