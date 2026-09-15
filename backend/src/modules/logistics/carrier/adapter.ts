/**
 * The carrier adapter interface.
 *
 * One shape for every provider, so the rest of this module never knows whether
 * a consignment is being moved by DHL, by a national courier with a REST API
 * somebody wired up last week, or by a two-van company typing events into this
 * portal.
 *
 * THE RULE THAT THIS FILE EXISTS TO ENFORCE
 *
 * **An adapter with no credentials refuses. It never pretends.**
 *
 * Every method on an unconfigured provider throws
 * `CARRIER_PROVIDER_UNCONFIGURED`, naming the environment variables the
 * deployment is missing. Nothing returns a fabricated tracking number, a
 * plausible-looking label or an invented ETA. This is the same posture
 * `SELLER_PAYOUT_PROVIDER_UNCONFIGURED` takes about a bank account, and for
 * the same reason: a screen that says "booked with DHL" when nothing was
 * booked is worse than a screen that says the operator has not finished
 * configuring DHL.
 *
 * WHAT IS ACTUALLY SHIPPED WORKING
 *
 * `MANUAL`. A logistics company doing the work inside this portal needs no
 * credential, and every deployment has it. `CUSTOM` is the generic HTTP
 * adapter an operator points at their own carrier's API. DHL, FedEx and UPS
 * are declared, mapped and unconfigured - the code that would call them is
 * written against this interface, and what is missing is a contract and a key,
 * neither of which lives in a repository.
 */
import type { CarrierProviderName } from '../../../domain/carrier-status-map.js';
import { ErrorCode, AppError } from '../../../domain/errors.js';
import type { ShipmentStatusName } from '../../../domain/logistics-shipment-state.js';

export interface CarrierAddress {
  companyName: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode: string;
  countryCode: string;
}

export interface CarrierParcel {
  reference: string;
  weightGrams: number;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
}

export interface CreateShipmentRequest {
  shipmentReference: string;
  serviceCode?: string | null;
  from: CarrierAddress;
  to: CarrierAddress;
  parcels: CarrierParcel[];
  /** Customs value, in minor units with its own currency. Never a float. */
  declaredValueMinor?: bigint | null;
  currency?: string | null;
  requiresColdChain?: boolean;
  isDangerousGoods?: boolean;
  /** Passed to the carrier so a retry cannot book a second consignment. */
  idempotencyKey: string;
}

export interface CreateShipmentResponse {
  carrierTrackingNumber: string;
  carrierShipmentId?: string | null;
  trackingUrl?: string | null;
  estimatedDeliveryAt?: Date | null;
  /** The label, where the carrier returned one inline. */
  label?: { contentType: string; bytes: Buffer } | null;
}

export interface RateRequest {
  from: CarrierAddress;
  to: CarrierAddress;
  parcels: CarrierParcel[];
  requiresColdChain?: boolean;
}

export interface RateQuote {
  serviceCode: string;
  serviceName: string;
  /** BigInt minor units with its own currency, like every amount in this system. */
  amountMinor: bigint;
  currency: string;
  estimatedTransitDays?: number | null;
}

export interface SchedulePickupRequest {
  from: CarrierAddress;
  windowStartAt: Date;
  windowEndAt: Date;
  parcelCount: number;
  instructions?: string | null;
  idempotencyKey: string;
}

export interface SchedulePickupResponse {
  carrierPickupId: string;
  confirmationNumber?: string | null;
}

export interface TrackingEvent {
  /** The carrier's own id for this event. Deduplicates a redelivered feed. */
  externalEventId: string | null;
  /** The carrier's own code, kept verbatim even after it is mapped. */
  externalStatusCode: string | null;
  /** What it resolved to, or null where nothing did - see `UNMAPPED`. */
  status: ShipmentStatusName | null;
  description: string | null;
  occurredAt: Date;
  locationLabel?: string | null;
  locationCountry?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface TrackingResult {
  carrierTrackingNumber: string;
  events: TrackingEvent[];
  /** The carrier's current view, where it reports one separately. */
  currentStatusCode: string | null;
  estimatedDeliveryAt: Date | null;
}

export interface ProofOfDeliveryResult {
  recipientName: string | null;
  deliveredAt: Date | null;
  /** The signature or photograph, where the carrier returns one. */
  document?: { contentType: string; bytes: Buffer } | null;
}

export interface AddressValidationResult {
  isValid: boolean;
  /** The carrier's corrected version, where it offers one. */
  normalised?: CarrierAddress | null;
  messages: string[];
}

/**
 * Every operation the brief names, in one interface.
 *
 * All nine, even for providers that support three of them. A provider that
 * cannot do something answers `CARRIER_PROVIDER_UNSUPPORTED` rather than
 * omitting the method, so the calling code is written once and the difference
 * between "this carrier will not" and "this deployment has not configured it"
 * stays visible.
 */
export interface CarrierAdapter {
  readonly provider: CarrierProviderName;
  /** False until the deployment supplies credentials. */
  readonly isConfigured: boolean;

  createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResponse>;
  cancelShipment(carrierTrackingNumber: string): Promise<void>;
  getRates(request: RateRequest): Promise<RateQuote[]>;
  schedulePickup(request: SchedulePickupRequest): Promise<SchedulePickupResponse>;
  cancelPickup(carrierPickupId: string): Promise<void>;
  getTracking(carrierTrackingNumber: string): Promise<TrackingResult>;
  getProofOfDelivery(carrierTrackingNumber: string): Promise<ProofOfDeliveryResult>;
  generateLabel(carrierTrackingNumber: string): Promise<{ contentType: string; bytes: Buffer }>;
  validateAddress(address: CarrierAddress): Promise<AddressValidationResult>;
}

/**
 * The refusal an unconfigured provider gives.
 *
 * It NAMES the variables, because "not configured" with nothing else in it
 * sends an operator to a support queue. The message is safe to show in the
 * admin panel and carries no secret - the whole point is that there is no
 * secret to carry.
 */
export function unconfigured(
  provider: CarrierProviderName,
  variables: readonly string[],
): AppError {
  return new AppError({
    statusCode: 503,
    code: ErrorCode.CARRIER_PROVIDER_UNCONFIGURED,
    message:
      `${provider} is not configured on this installation. ` +
      `Set ${variables.join(', ')} and test the connection before assigning shipments to it.`,
    details: variables.map((variable) => ({
      field: variable,
      code: 'MISSING_CONFIGURATION',
      meta: { provider },
    })),
  });
}

/** The refusal a provider gives for something it genuinely cannot do. */
export function unsupported(provider: CarrierProviderName, operation: string): AppError {
  return new AppError({
    statusCode: 501,
    code: ErrorCode.CARRIER_REQUEST_FAILED,
    message: `${provider} does not support ${operation} through this integration.`,
    details: [{ code: 'UNSUPPORTED_OPERATION', meta: { provider, operation } }],
  });
}

/**
 * A base every unconfigured provider extends.
 *
 * Nine methods that refuse, in one place. A new provider added tomorrow is
 * safe by default: it refuses everything until somebody deliberately overrides
 * a method, which is the correct direction for a class whose job is to move
 * medical freight.
 */
export abstract class UnconfiguredCarrierAdapter implements CarrierAdapter {
  abstract readonly provider: CarrierProviderName;
  abstract readonly requiredVariables: readonly string[];

  get isConfigured(): boolean {
    return false;
  }

  private refuse(): never {
    throw unconfigured(this.provider, this.requiredVariables);
  }

  createShipment(): Promise<CreateShipmentResponse> {
    this.refuse();
  }
  cancelShipment(): Promise<void> {
    this.refuse();
  }
  getRates(): Promise<RateQuote[]> {
    this.refuse();
  }
  schedulePickup(): Promise<SchedulePickupResponse> {
    this.refuse();
  }
  cancelPickup(): Promise<void> {
    this.refuse();
  }
  getTracking(): Promise<TrackingResult> {
    this.refuse();
  }
  getProofOfDelivery(): Promise<ProofOfDeliveryResult> {
    this.refuse();
  }
  generateLabel(): Promise<{ contentType: string; bytes: Buffer }> {
    this.refuse();
  }
  validateAddress(): Promise<AddressValidationResult> {
    this.refuse();
  }
}
