/**
 * FedEx, on the seller's own account.
 *
 * The same posture as the DHL adapter beside it, and the same caveat: written
 * against FedEx's published developer documentation, NOT run against a live
 * sandbox, because the credentials in this product belong to each seller and
 * this repository holds none. Until a seller connects a real account and the
 * connection test passes, this adapter has never spoken to FedEx - and the
 * product shows that rather than hiding it.
 *
 * WHAT IS DIFFERENT FROM DHL, AND IT IS THE INTERESTING PART
 *
 * FedEx is OAuth2 client-credentials rather than HTTP Basic. That means a
 * token, which means a token lifetime, which means one more thing that can be
 * stale at the worst moment. The handling here:
 *
 *   - The token is held in memory on the adapter instance, never written to
 *     the database. A cached credential in a row is a credential that outlives
 *     the process that earned it and has to be invalidated by hand.
 *   - It is refreshed sixty seconds before FedEx says it expires, because a
 *     token that expires mid-flight produces a 401 on an operation that may
 *     already have booked a consignment.
 *   - A 401 on a real call refreshes ONCE and retries ONCE. Not a loop: a
 *     credential that is genuinely wrong must fail fast and visibly, not
 *     hammer FedEx until they rate-limit the seller's account.
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
  type SchedulePickupResponse,
  type TrackingEvent,
  type TrackingResult,
} from './adapter.js';
import { carrierRefused } from './registry.js';

const BASE_URL: Readonly<Record<'SANDBOX' | 'PRODUCTION', string>> = Object.freeze({
  SANDBOX: 'https://apis-sandbox.fedex.com',
  PRODUCTION: 'https://apis.fedex.com',
});

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Refresh this long before FedEx says the token dies. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

export interface FedExCredentials {
  clientId: string;
  clientSecret: string;
}

export interface FedExAdapterOptions {
  environment: 'SANDBOX' | 'PRODUCTION';
  credentials: FedExCredentials;
  accountNumber: string | null;
}

function toFedExAddress(address: CarrierAddress): Record<string, unknown> {
  return {
    streetLines: [address.line1, ...(address.line2 === null || address.line2 === undefined ? [] : [address.line2])],
    city: address.city,
    ...(address.region === null || address.region === undefined
      ? {}
      : { stateOrProvinceCode: address.region }),
    postalCode: address.postalCode,
    countryCode: address.countryCode.toUpperCase(),
  };
}

export class FedExApiAdapter implements CarrierAdapter {
  readonly provider: CarrierProviderName = 'FEDEX';
  readonly isConfigured = true;

  private readonly baseUrl: string;
  private readonly credentials: FedExCredentials;
  private readonly accountNumber: string | null;

  /** In memory only. Never persisted, never returned, never logged. */
  private token: { value: string; expiresAt: number } | null = null;

  constructor(options: FedExAdapterOptions) {
    this.baseUrl = BASE_URL[options.environment];
    this.credentials = options.credentials;
    this.accountNumber = options.accountNumber;
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token !== null && this.token.expiresAt > Date.now()) {
      return this.token.value;
    }

    const result = await safeFetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      }).toString(),
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: 64 * 1024,
      field: 'fedex',
    });

    if (result.status >= 400) {
      /*
       * Deliberately does NOT repeat FedEx's body here.
       *
       * A token endpoint's refusal is the one response most likely to echo
       * part of what was sent, and what was sent is the client secret. The
       * status is enough for a seller to act on: the credentials were not
       * accepted.
       */
      throw carrierRefused('FEDEX', `The credentials were not accepted (HTTP ${String(result.status)}).`);
    }

    let parsed: { access_token?: unknown; expires_in?: unknown };

    try {
      parsed = JSON.parse(result.bodyText) as typeof parsed;
    } catch {
      throw carrierRefused('FEDEX', 'The token response could not be read as JSON.');
    }

    if (typeof parsed.access_token !== 'string') {
      throw carrierRefused('FEDEX', 'The token response carried no access token.');
    }

    const lifetimeSeconds = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;

    this.token = {
      value: parsed.access_token,
      expiresAt: Date.now() + lifetimeSeconds * 1000 - TOKEN_SAFETY_MARGIN_MS,
    };

    return this.token.value;
  }

  private async call(path: string, body: unknown, attempt = 0): Promise<unknown> {
    const token = await this.accessToken(attempt > 0);

    const result = await safeFetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      field: 'fedex',
    });

    /*
     * One retry on 401, and one only.
     *
     * A token that expired between the check and the call is worth a second
     * attempt. A credential that is wrong is not - and a loop here would
     * hammer FedEx until they rate-limited the SELLER's account, which is a
     * consequence this system would be inflicting on somebody else's
     * commercial relationship.
     */
    if (result.status === 401 && attempt === 0) {
      this.token = null;
      return this.call(path, body, 1);
    }

    if (result.status >= 400) {
      throw carrierRefused('FEDEX', safeCarrierMessage(extractFedExError(result.bodyText)));
    }

    try {
      return JSON.parse(result.bodyText);
    } catch {
      throw carrierRefused('FEDEX', 'The response could not be read as JSON.');
    }
  }

  async getRates(request: RateRequest): Promise<RateQuote[]> {
    if (this.accountNumber === null) {
      throw carrierRefused('FEDEX', 'A FedEx account number is needed before rates can be quoted.');
    }

    const body = await this.call('/rate/v1/rates/quotes', {
      accountNumber: { value: this.accountNumber },
      requestedShipment: {
        shipper: { address: toFedExAddress(request.from) },
        recipient: { address: toFedExAddress(request.to) },
        pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
        rateRequestType: ['ACCOUNT', 'LIST'],
        requestedPackageLineItems: request.parcels.map((parcel) => ({
          weight: { units: 'KG', value: parcel.weightGrams / 1000 },
          dimensions: {
            length: Math.round((parcel.lengthMm ?? 100) / 10),
            width: Math.round((parcel.widthMm ?? 100) / 10),
            height: Math.round((parcel.heightMm ?? 100) / 10),
            units: 'CM',
          },
        })),
      },
    });

    return readFedExRates(body);
  }

  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResponse> {
    if (this.accountNumber === null) {
      throw carrierRefused(
        'FEDEX',
        'A FedEx account number is needed before a consignment can be booked.',
      );
    }

    const body = await this.call('/ship/v1/shipments', {
      labelResponseOptions: 'LABEL',
      accountNumber: { value: this.accountNumber },
      requestedShipment: {
        shipper: {
          contact: {
            personName: request.from.contactName ?? request.from.companyName,
            phoneNumber: request.from.phone ?? '',
            companyName: request.from.companyName,
          },
          address: toFedExAddress(request.from),
        },
        recipients: [
          {
            contact: {
              personName: request.to.contactName ?? request.to.companyName,
              phoneNumber: request.to.phone ?? '',
              companyName: request.to.companyName,
            },
            address: toFedExAddress(request.to),
          },
        ],
        shipDatestamp: new Date().toISOString().slice(0, 10),
        serviceType: request.serviceCode ?? 'FEDEX_INTERNATIONAL_PRIORITY',
        packagingType: 'YOUR_PACKAGING',
        pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
        blockInsightVisibility: false,
        shippingChargesPayment: { paymentType: 'SENDER' },
        labelSpecification: { imageType: 'PDF', labelStockType: 'PAPER_4X6' },
        requestedPackageLineItems: request.parcels.map((parcel) => ({
          weight: { units: 'KG', value: parcel.weightGrams / 1000 },
          dimensions: {
            length: Math.round((parcel.lengthMm ?? 100) / 10),
            width: Math.round((parcel.widthMm ?? 100) / 10),
            height: Math.round((parcel.heightMm ?? 100) / 10),
            units: 'CM',
          },
          customerReferences: [
            { customerReferenceType: 'CUSTOMER_REFERENCE', value: parcel.reference },
          ],
        })),
      },
    });

    return readFedExShipment(body);
  }

  async getTracking(carrierTrackingNumber: string): Promise<TrackingResult> {
    const body = await this.call('/track/v1/trackingnumbers', {
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber: carrierTrackingNumber } }],
    });

    return readFedExTracking(body, carrierTrackingNumber);
  }

  async validateAddress(address: CarrierAddress): Promise<AddressValidationResult> {
    const body = await this.call('/address/v1/addresses/resolve', {
      addressesToValidate: [{ address: toFedExAddress(address) }],
    });

    return readFedExAddress(body);
  }

  schedulePickup(): Promise<SchedulePickupResponse> {
    /*
     * FedEx pickup is a separate entitlement on the account, and booking one
     * for an account that does not hold it fails at dispatch rather than at
     * booking. Not claimed until a deployment has an account that proves it.
     */
    throw unsupported('FEDEX', 'booking a collection');
  }

  cancelPickup(): Promise<void> {
    throw unsupported('FEDEX', 'cancelling a collection');
  }

  async cancelShipment(carrierTrackingNumber: string): Promise<void> {
    if (this.accountNumber === null) {
      throw carrierRefused('FEDEX', 'A FedEx account number is needed to cancel a consignment.');
    }

    await this.call('/ship/v1/shipments/cancel', {
      accountNumber: { value: this.accountNumber },
      trackingNumber: carrierTrackingNumber,
      deletionControl: 'DELETE_ALL_PACKAGES',
    });
  }

  generateLabel(): Promise<{ contentType: string; bytes: Buffer }> {
    // Same as DHL: the label arrives with the booking and is stored then.
    throw unsupported('FEDEX', 'fetching a label after the consignment was created');
  }

  getProofOfDelivery(): Promise<ProofOfDeliveryResult> {
    throw unsupported('FEDEX', 'proof-of-delivery retrieval');
  }
}

// ---------------------------------------------------------------------------
// Readers, exported so they can be tested against recorded payloads.
// ---------------------------------------------------------------------------

export function extractFedExError(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { errors?: unknown };

    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const first = parsed.errors[0] as { message?: unknown; code?: unknown };
      if (typeof first.message === 'string') return first.message;
      if (typeof first.code === 'string') return first.code;
    }
  } catch {
    // Not JSON.
  }

  return bodyText.slice(0, 200);
}

export function readFedExRates(body: unknown): RateQuote[] {
  const record = body as { output?: { rateReplyDetails?: unknown } } | null;
  const details = record?.output?.rateReplyDetails;

  if (!Array.isArray(details)) return [];

  const quotes: RateQuote[] = [];

  for (const entry of details) {
    const detail = entry as {
      serviceType?: unknown;
      serviceName?: unknown;
      ratedShipmentDetails?: unknown;
      operationalDetail?: unknown;
    };

    const rated = Array.isArray(detail.ratedShipmentDetails) ? detail.ratedShipmentDetails : [];

    /*
     * ACCOUNT beats LIST. The account rate is what this seller is actually
     * billed; the list rate is the published one and is almost always higher.
     * Quoting a buyer the list price would overcharge them for delivery.
     */
    const preferred =
      (rated.find(
        (item) => (item as { rateType?: unknown }).rateType === 'ACCOUNT',
      ) as { totalNetCharge?: unknown; currency?: unknown } | undefined) ??
      (rated[0] as { totalNetCharge?: unknown; currency?: unknown } | undefined);

    if (preferred === undefined || typeof preferred.totalNetCharge !== 'number') continue;

    const operational = detail.operationalDetail as { transitTime?: unknown } | undefined;

    quotes.push({
      serviceCode: typeof detail.serviceType === 'string' ? detail.serviceType : 'UNKNOWN',
      serviceName: typeof detail.serviceName === 'string' ? detail.serviceName : 'FedEx',
      // Converted at the boundary, held as BigInt from here on. See the note
      // on the DHL reader: JSON has no decimal type and this is where that
      // stops being our problem.
      amountMinor: BigInt(Math.round(preferred.totalNetCharge * 100)),
      currency: typeof preferred.currency === 'string' ? preferred.currency : 'USD',
      estimatedTransitDays: transitDaysFrom(operational?.transitTime),
    });
  }

  return quotes;
}

/** FedEx says `TWO_DAYS`, not `2`. Unmapped words give null rather than a guess. */
function transitDaysFrom(value: unknown): number | null {
  if (typeof value !== 'string') return null;

  const words: Record<string, number> = {
    ONE_DAY: 1,
    TWO_DAYS: 2,
    THREE_DAYS: 3,
    FOUR_DAYS: 4,
    FIVE_DAYS: 5,
    SIX_DAYS: 6,
    SEVEN_DAYS: 7,
    EIGHT_DAYS: 8,
    NINE_DAYS: 9,
    TEN_DAYS: 10,
  };

  return words[value] ?? null;
}

export function readFedExShipment(body: unknown): CreateShipmentResponse {
  const record = body as { output?: { transactionShipments?: unknown } } | null;
  const shipments = record?.output?.transactionShipments;
  const shipment = Array.isArray(shipments)
    ? (shipments[0] as { masterTrackingNumber?: unknown; pieceResponses?: unknown } | undefined)
    : undefined;

  const tracking =
    typeof shipment?.masterTrackingNumber === 'string' ? shipment.masterTrackingNumber : null;

  if (tracking === null) {
    throw carrierRefused('FEDEX', 'The consignment was accepted without a tracking number.');
  }

  const pieces = Array.isArray(shipment?.pieceResponses) ? shipment.pieceResponses : [];
  const documents = Array.isArray(
    (pieces[0] as { packageDocuments?: unknown } | undefined)?.packageDocuments,
  )
    ? ((pieces[0] as { packageDocuments: unknown[] }).packageDocuments)
    : [];

  const label = documents[0] as { encodedLabel?: unknown } | undefined;

  return {
    carrierTrackingNumber: tracking,
    carrierShipmentId: tracking,
    trackingUrl: null,
    estimatedDeliveryAt: null,
    label:
      label !== undefined && typeof label.encodedLabel === 'string'
        ? { contentType: 'application/pdf', bytes: Buffer.from(label.encodedLabel, 'base64') }
        : null,
  };
}

export function readFedExTracking(body: unknown, fallbackNumber: string): TrackingResult {
  const record = body as { output?: { completeTrackResults?: unknown } } | null;
  const results = record?.output?.completeTrackResults;
  const first = Array.isArray(results)
    ? (results[0] as { trackResults?: unknown } | undefined)
    : undefined;

  const tracks = Array.isArray(first?.trackResults) ? first.trackResults : [];
  const track = tracks[0] as
    | { scanEvents?: unknown; latestStatusDetail?: unknown; dateAndTimes?: unknown }
    | undefined;

  const scans = Array.isArray(track?.scanEvents) ? track.scanEvents : [];

  const events: TrackingEvent[] = scans.map((entry) => {
    const scan = entry as {
      eventType?: unknown;
      eventDescription?: unknown;
      date?: unknown;
      scanLocation?: unknown;
    };

    const location = scan.scanLocation as
      | { city?: unknown; countryCode?: unknown }
      | undefined;

    return {
      externalEventId: null,
      externalStatusCode: typeof scan.eventType === 'string' ? scan.eventType : null,
      // Mapped downstream by `resolveCarrierStatus`, so an operator's own
      // override still wins over the built-in table.
      status: null,
      description: typeof scan.eventDescription === 'string' ? scan.eventDescription : null,
      occurredAt: typeof scan.date === 'string' ? new Date(scan.date) : new Date(),
      locationLabel: typeof location?.city === 'string' ? location.city : null,
      locationCountry: typeof location?.countryCode === 'string' ? location.countryCode : null,
    };
  });

  const latest = track?.latestStatusDetail as { code?: unknown } | undefined;

  return {
    carrierTrackingNumber: fallbackNumber,
    events,
    currentStatusCode: typeof latest?.code === 'string' ? latest.code : null,
    estimatedDeliveryAt: null,
  };
}

export function readFedExAddress(body: unknown): AddressValidationResult {
  const record = body as { output?: { resolvedAddresses?: unknown } } | null;
  const addresses = record?.output?.resolvedAddresses;
  const first = Array.isArray(addresses)
    ? (addresses[0] as { attributes?: unknown } | undefined)
    : undefined;

  const attributes = first?.attributes as Record<string, unknown> | undefined;

  /*
   * FedEx answers with attributes rather than a verdict, and the strings are
   * "true"/"false" rather than booleans. Resolved AND deliverable: an address
   * FedEx could parse but will not deliver to is not a valid delivery address,
   * which is the question being asked.
   */
  const resolved = attributes?.Resolved === 'true' || attributes?.Resolved === true;
  const deliverable =
    attributes?.DPV === 'true' || attributes?.DPV === true || attributes?.DPV === undefined;

  return {
    isValid: resolved && deliverable,
    normalised: null,
    messages:
      resolved && deliverable
        ? []
        : ['FedEx does not recognise that address as one it can deliver to.'],
  };
}
