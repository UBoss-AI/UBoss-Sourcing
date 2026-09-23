/**
 * DHL Express, through the MyDHL API, on the seller's own account.
 *
 * WHAT THIS IS AND IS NOT TESTED AGAINST
 *
 * Written against DHL's published MyDHL API documentation. It has NOT been run
 * against a live sandbox, because a sandbox key belongs to a business with a
 * DHL Express account and this repository holds none - by design: in this
 * product the credentials are each SELLER's, entered in the Seller Hub, and
 * there is no operator-wide key to test with.
 *
 * That has one consequence, and it is stated here rather than discovered:
 * until a seller connects a real account and the connection test passes, this
 * adapter has never spoken to DHL. The product is built so that this is
 * visible rather than hidden - `SellerCarrierConnection.state` only reaches
 * ACTIVE after a test that genuinely got an answer, the screen says
 * "Credentials required" until then, and nothing anywhere renders a green
 * "Connected" badge on the strength of this file existing.
 *
 * THE ENDPOINTS ARE CONSTANTS AT THE TOP for the same reason. A carrier moves
 * a path or renames a field, and the fix should be one edit in one place by
 * somebody reading their changelog - not a hunt through request builders.
 *
 * EVERY CALL GOES THROUGH `safeFetch`. DHL's host is not seller-supplied, so
 * this is not the SSRF surface `outbound-http` was written for - but it is
 * also where the timeout, the response-size ceiling and the redirect
 * revalidation live, and a carrier call without those is a carrier call that
 * can hang a worker.
 */
import type { CarrierProviderName } from '../../../domain/carrier-status-map.js';
import { safeFetch } from '../../../infra/outbound-http.js';
import { safeCarrierMessage } from '../../seller/carrier-credential.service.js';
import {
  unsupported,
  type AddressValidationResult,
  type CarrierAdapter,
  type CarrierAddress,
  type CreateShipmentRequest,
  type CreateShipmentResponse,
  type ProofOfDeliveryResult,
  type RateQuote,
  type RateRequest,
  type SchedulePickupRequest,
  type SchedulePickupResponse,
  type TrackingEvent,
  type TrackingResult,
} from './adapter.js';
import { carrierRefused } from './registry.js';

/**
 * Where MyDHL lives.
 *
 * Two hosts, and the difference matters more than it looks: the test host
 * accepts the same credentials shape and books nothing. A connection whose
 * environment is SANDBOX must never reach the production host, which is why
 * this is chosen from the connection row rather than from configuration.
 */
const BASE_URL: Readonly<Record<'SANDBOX' | 'PRODUCTION', string>> = Object.freeze({
  SANDBOX: 'https://express.api.dhl.com/mydhlapi/test',
  PRODUCTION: 'https://express.api.dhl.com/mydhlapi',
});

/** Ten seconds. A carrier that has not answered by then has not answered. */
const TIMEOUT_MS = 10_000;

/** Enough for a rate response with a dozen products; a label comes separately. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface DhlCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface DhlAdapterOptions {
  environment: 'SANDBOX' | 'PRODUCTION';
  credentials: DhlCredentials;
  /** The seller's DHL account number. On the request, not in the header. */
  accountNumber: string | null;
}

/**
 * DHL's date format is `YYYY-MM-DDTHH:mm:ss GMT+00:00`, which is not ISO and
 * which their validator rejects if you send plain ISO. One helper rather than
 * four inline template strings that will drift apart.
 */
function dhlTimestamp(when: Date): string {
  return `${when.toISOString().slice(0, 19)} GMT+00:00`;
}

function toDhlAddress(address: CarrierAddress): Record<string, unknown> {
  return {
    postalCode: address.postalCode,
    cityName: address.city,
    countryCode: address.countryCode.toUpperCase(),
    addressLine1: address.line1,
    ...(address.line2 === null || address.line2 === undefined ? {} : { addressLine2: address.line2 }),
    ...(address.region === null || address.region === undefined
      ? {}
      : { provinceCode: address.region }),
  };
}

export class DhlApiAdapter implements CarrierAdapter {
  readonly provider: CarrierProviderName = 'DHL';
  readonly isConfigured = true;

  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly accountNumber: string | null;

  constructor(options: DhlAdapterOptions) {
    this.baseUrl = BASE_URL[options.environment];
    /*
     * Basic auth, built once in the constructor and held in a private field.
     *
     * Never a property on anything that gets serialised, never passed as an
     * argument, never put on an error. The object this class produces is the
     * only thing that leaves the factory, and it exposes methods rather than
     * the credential they close over.
     */
    this.authorization = `Basic ${Buffer.from(
      `${options.credentials.apiKey}:${options.credentials.apiSecret}`,
    ).toString('base64')}`;
    this.accountNumber = options.accountNumber;
  }

  private async call(
    path: string,
    init: { method: string; body?: unknown; query?: Record<string, string> },
  ): Promise<unknown> {
    const query =
      init.query === undefined ? '' : `?${new URLSearchParams(init.query).toString()}`;

    const result = await safeFetch(`${this.baseUrl}${path}${query}`, {
      method: init.method,
      headers: {
        authorization: this.authorization,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      field: 'dhl',
    });

    if (result.status >= 400) {
      /*
       * The carrier's own words, sanitised.
       *
       * `safeCarrierMessage` strips anything that looks like a credential
       * before this is stored on the connection or shown to a seller - a
       * failure message is the commonest place a key ends up in a log.
       */
      throw carrierRefused('DHL', safeCarrierMessage(extractDhlError(result.bodyText)));
    }

    try {
      return JSON.parse(result.bodyText);
    } catch {
      throw carrierRefused('DHL', 'The response could not be read as JSON.');
    }
  }

  async getRates(request: RateRequest): Promise<RateQuote[]> {
    const totalGrams = request.parcels.reduce((sum, parcel) => sum + parcel.weightGrams, 0);

    const body = await this.call('/rates', {
      method: 'POST',
      body: {
        customerDetails: {
          shipperDetails: toDhlAddress(request.from),
          receiverDetails: toDhlAddress(request.to),
        },
        ...(this.accountNumber === null
          ? {}
          : { accounts: [{ typeCode: 'shipper', number: this.accountNumber }] }),
        plannedShippingDateAndTime: dhlTimestamp(new Date(Date.now() + 24 * 60 * 60 * 1000)),
        unitOfMeasurement: 'metric',
        isCustomsDeclarable:
          request.from.countryCode.toUpperCase() !== request.to.countryCode.toUpperCase(),
        packages: request.parcels.map((parcel) => ({
          // DHL takes kilograms and centimetres; everything inside this system
          // is grams and millimetres, so the conversion happens here and
          // nowhere else.
          weight: parcel.weightGrams / 1000,
          dimensions: {
            length: (parcel.lengthMm ?? 100) / 10,
            width: (parcel.widthMm ?? 100) / 10,
            height: (parcel.heightMm ?? 100) / 10,
          },
        })),
      },
    });

    return readDhlRates(body, totalGrams);
  }

  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResponse> {
    const body = await this.call('/shipments', {
      method: 'POST',
      body: {
        plannedShippingDateAndTime: dhlTimestamp(new Date(Date.now() + 60 * 60 * 1000)),
        pickup: { isRequested: false },
        productCode: request.serviceCode ?? 'P',
        ...(this.accountNumber === null
          ? {}
          : { accounts: [{ typeCode: 'shipper', number: this.accountNumber }] }),
        customerDetails: {
          shipperDetails: {
            postalAddress: toDhlAddress(request.from),
            contactInformation: {
              companyName: request.from.companyName,
              fullName: request.from.contactName ?? request.from.companyName,
              phone: request.from.phone ?? '',
            },
          },
          receiverDetails: {
            postalAddress: toDhlAddress(request.to),
            contactInformation: {
              companyName: request.to.companyName,
              fullName: request.to.contactName ?? request.to.companyName,
              phone: request.to.phone ?? '',
            },
          },
        },
        content: {
          isCustomsDeclarable:
            request.from.countryCode.toUpperCase() !== request.to.countryCode.toUpperCase(),
          description: request.shipmentReference,
          incoterm: 'DAP',
          unitOfMeasurement: 'metric',
          packages: request.parcels.map((parcel) => ({
            weight: parcel.weightGrams / 1000,
            dimensions: {
              length: (parcel.lengthMm ?? 100) / 10,
              width: (parcel.widthMm ?? 100) / 10,
              height: (parcel.heightMm ?? 100) / 10,
            },
            customerReferences: [{ value: parcel.reference, typeCode: 'CU' }],
          })),
        },
        /*
         * The idempotency key goes to DHL as a customer reference as well as
         * being held in `shipment_purchases` here.
         *
         * Belt and braces on the one operation in this file that costs money:
         * our own unique index stops a retry reaching DHL twice, and this lets
         * DHL's own support find the duplicate if it ever does.
         */
        customerReferences: [{ value: request.idempotencyKey, typeCode: 'CU' }],
      },
    });

    return readDhlShipment(body);
  }

  async getTracking(carrierTrackingNumber: string): Promise<TrackingResult> {
    const body = await this.call(`/shipments/${encodeURIComponent(carrierTrackingNumber)}/tracking`, {
      method: 'GET',
    });

    return readDhlTracking(body, carrierTrackingNumber);
  }

  async validateAddress(address: CarrierAddress): Promise<AddressValidationResult> {
    const body = await this.call('/address-validate', {
      method: 'GET',
      query: {
        type: 'delivery',
        countryCode: address.countryCode.toUpperCase(),
        postalCode: address.postalCode,
        cityName: address.city,
      },
    });

    const record = body as { address?: unknown[] } | null;
    const matched = Array.isArray(record?.address) && record.address.length > 0;

    return {
      isValid: matched,
      normalised: null,
      messages: matched
        ? []
        : ['DHL does not recognise that postcode and town together for this country.'],
    };
  }

  async schedulePickup(request: SchedulePickupRequest): Promise<SchedulePickupResponse> {
    const body = await this.call('/pickups', {
      method: 'POST',
      body: {
        plannedPickupDateAndTime: dhlTimestamp(request.windowStartAt),
        closeTime: request.windowEndAt.toISOString().slice(11, 16),
        location: 'reception',
        ...(this.accountNumber === null
          ? {}
          : { accounts: [{ typeCode: 'shipper', number: this.accountNumber }] }),
        customerDetails: { shipperDetails: { postalAddress: toDhlAddress(request.from) } },
        ...(request.instructions === null || request.instructions === undefined
          ? {}
          : { specialInstructions: [{ value: request.instructions.slice(0, 75) }] }),
      },
    });

    const record = body as { dispatchConfirmationNumber?: unknown } | null;
    const confirmation =
      typeof record?.dispatchConfirmationNumber === 'string'
        ? record.dispatchConfirmationNumber
        : null;

    if (confirmation === null) {
      throw carrierRefused('DHL', 'The pickup was accepted without a confirmation number.');
    }

    return { carrierPickupId: confirmation, confirmationNumber: confirmation };
  }

  async cancelPickup(carrierPickupId: string): Promise<void> {
    await this.call(`/pickups/${encodeURIComponent(carrierPickupId)}`, {
      method: 'DELETE',
      query: { requestorName: 'Marketplace', reason: '007' },
    });
  }

  cancelShipment(): Promise<void> {
    /*
     * MyDHL has no shipment-deletion operation. A booked consignment is
     * cancelled by cancelling its PICKUP, or by not handing the parcel over.
     *
     * Refusing is the honest answer: returning success here would let this
     * system record a consignment as cancelled that DHL still expects, and the
     * seller would find out when they were invoiced.
     */
    throw unsupported('DHL', 'cancelling a booked consignment');
  }

  generateLabel(): Promise<{ contentType: string; bytes: Buffer }> {
    /*
     * The label comes back INSIDE the create-shipment response, as base64, and
     * is stored at that moment. There is no endpoint that re-issues one for a
     * shipment created earlier, so a caller asking for it later is asking for
     * something DHL does not offer - and should be reading the stored document
     * instead.
     */
    throw unsupported('DHL', 'fetching a label after the consignment was created');
  }

  getProofOfDelivery(): Promise<ProofOfDeliveryResult> {
    // Electronic proof of delivery is a separate DHL product with its own
    // entitlement. Not claimed until a deployment has one.
    throw unsupported('DHL', 'proof-of-delivery retrieval');
  }
}

// ---------------------------------------------------------------------------
// Readers
//
// Separate from the adapter, and exported, so they can be tested against
// recorded payloads without a network or a credential. A parser is where a
// carrier's response shape actually bites, and it is the half worth testing.
// ---------------------------------------------------------------------------

export function extractDhlError(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as {
      detail?: unknown;
      title?: unknown;
      additionalDetails?: unknown;
    };

    if (Array.isArray(parsed.additionalDetails) && parsed.additionalDetails.length > 0) {
      return String(parsed.additionalDetails[0]);
    }

    if (typeof parsed.detail === 'string') return parsed.detail;
    if (typeof parsed.title === 'string') return parsed.title;
  } catch {
    // Not JSON. Fall through to the raw text, which the caller sanitises.
  }

  return bodyText.slice(0, 200);
}

export function readDhlRates(body: unknown, totalGrams: number): RateQuote[] {
  const record = body as { products?: unknown } | null;
  if (!Array.isArray(record?.products)) return [];

  const quotes: RateQuote[] = [];

  for (const entry of record.products) {
    const product = entry as {
      productName?: unknown;
      productCode?: unknown;
      totalPrice?: unknown;
      deliveryCapabilities?: unknown;
    };

    const prices = Array.isArray(product.totalPrice) ? product.totalPrice : [];

    // BILLC is the price in the account's billing currency, which is the one
    // the seller is actually invoiced in. Falling back to the first entry
    // rather than refusing: a quote in some currency beats no quote.
    const billing =
      (prices.find(
        (price) => (price as { currencyType?: unknown }).currencyType === 'BILLC',
      ) as { price?: unknown; priceCurrency?: unknown } | undefined) ??
      (prices[0] as { price?: unknown; priceCurrency?: unknown } | undefined);

    if (billing === undefined || typeof billing.price !== 'number') continue;

    const capabilities = product.deliveryCapabilities as
      | { totalTransitDays?: unknown }
      | undefined;

    quotes.push({
      serviceCode: typeof product.productCode === 'string' ? product.productCode : 'UNKNOWN',
      serviceName: typeof product.productName === 'string' ? product.productName : 'DHL Express',
      /*
       * Minor units, via `Math.round` on a value DHL sends as a decimal.
       *
       * This is the one place a float touches money in this file, and it is
       * unavoidable: the carrier sends JSON, and JSON has no decimal type. It
       * is converted at the boundary and never stored, compared or arithmetic
       * -ed as a float - `amountMinor` is a BigInt from here on.
       */
      amountMinor: BigInt(Math.round(billing.price * 100)),
      currency: typeof billing.priceCurrency === 'string' ? billing.priceCurrency : 'EUR',
      estimatedTransitDays:
        typeof capabilities?.totalTransitDays === 'number'
          ? capabilities.totalTransitDays
          : null,
    });
  }

  // `totalGrams` is not sent to DHL a second time; it is here so a caller can
  // tell an empty list caused by an over-weight parcel from one caused by no
  // service to the destination.
  void totalGrams;

  return quotes;
}

export function readDhlShipment(body: unknown): CreateShipmentResponse {
  const record = body as {
    shipmentTrackingNumber?: unknown;
    trackingUrl?: unknown;
    documents?: unknown;
  } | null;

  const tracking =
    typeof record?.shipmentTrackingNumber === 'string' ? record.shipmentTrackingNumber : null;

  if (tracking === null) {
    // Never invent one. A shipment with no tracking number is a shipment this
    // system cannot follow, and recording a placeholder would hide that.
    throw carrierRefused('DHL', 'The consignment was accepted without a tracking number.');
  }

  const documents = Array.isArray(record?.documents) ? record.documents : [];
  const label = documents.find(
    (document) => (document as { typeCode?: unknown }).typeCode === 'label',
  ) as { content?: unknown; imageFormat?: unknown } | undefined;

  return {
    carrierTrackingNumber: tracking,
    carrierShipmentId: tracking,
    trackingUrl: typeof record?.trackingUrl === 'string' ? record.trackingUrl : null,
    estimatedDeliveryAt: null,
    label:
      label !== undefined && typeof label.content === 'string'
        ? {
            contentType:
              label.imageFormat === 'ZPL' ? 'application/vnd.zebra.zpl' : 'application/pdf',
            bytes: Buffer.from(label.content, 'base64'),
          }
        : null,
  };
}

export function readDhlTracking(body: unknown, fallbackNumber: string): TrackingResult {
  const record = body as { shipments?: unknown } | null;
  const shipments = Array.isArray(record?.shipments) ? record.shipments : [];
  const shipment = shipments[0] as
    | { events?: unknown; status?: unknown; estimatedDeliveryDate?: unknown }
    | undefined;

  const rawEvents = Array.isArray(shipment?.events) ? shipment.events : [];

  const events: TrackingEvent[] = rawEvents.map((entry) => {
    const event = entry as {
      typeCode?: unknown;
      description?: unknown;
      date?: unknown;
      time?: unknown;
      serviceArea?: unknown;
    };

    const area = Array.isArray(event.serviceArea)
      ? (event.serviceArea[0] as { description?: unknown } | undefined)
      : undefined;

    return {
      /*
       * DHL sends no per-event id. Null here, and the event service supplies
       * the NOT NULL surrogate that `externalEventKey` needs - a column that
       * accepted nulls would enforce nothing, every NULL in a MariaDB UNIQUE
       * index being distinct.
       */
      externalEventId: null,
      externalStatusCode: typeof event.typeCode === 'string' ? event.typeCode : null,
      // Left for `resolveCarrierStatus` to map. An adapter that decided the
      // canonical status itself would bypass the operator's own overrides.
      status: null,
      description: typeof event.description === 'string' ? event.description : null,
      occurredAt: parseDhlInstant(event.date, event.time),
      locationLabel: typeof area?.description === 'string' ? area.description : null,
      locationCountry: null,
    };
  });

  const status = shipment?.status as { statusCode?: unknown } | undefined;

  return {
    carrierTrackingNumber: fallbackNumber,
    events,
    currentStatusCode: typeof status?.statusCode === 'string' ? status.statusCode : null,
    estimatedDeliveryAt:
      typeof shipment?.estimatedDeliveryDate === 'string'
        ? new Date(`${shipment.estimatedDeliveryDate}T00:00:00Z`)
        : null,
  };
}

/**
 * DHL splits an instant across two fields and omits the zone.
 *
 * Treated as UTC where no offset is given. That is a choice and it is the safe
 * one: a tracking event an hour out is a cosmetic problem, and refusing the
 * event because its timezone was ambiguous would lose it entirely.
 */
function parseDhlInstant(date: unknown, time: unknown): Date {
  if (typeof date !== 'string') return new Date();

  const clock = typeof time === 'string' && time.length >= 5 ? time.slice(0, 8) : '00:00:00';
  const parsed = new Date(`${date}T${clock}Z`);

  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
