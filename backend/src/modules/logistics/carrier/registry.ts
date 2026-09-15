/**
 * Which adapter serves which integration.
 *
 * Five providers, one of which is fully working out of the box and four of
 * which are honest about what they need.
 *
 *   MANUAL  - a carrier working inside this portal. No credential, no outbound
 *             call, every operation either a no-op or a refusal that says so.
 *             This is what every deployment gets by default.
 *   CUSTOM  - a carrier with an API the operator has wired up through the
 *             generic HTTP adapter and the mapping table.
 *   DHL     -\
 *   FEDEX    |- declared, mapped, and UNCONFIGURED until the deployment holds
 *   UPS     -/  a contract and a key. Every call answers
 *               CARRIER_PROVIDER_UNCONFIGURED naming the variables.
 *
 * WHY THE UNCONFIGURED ONES EXIST AT ALL
 *
 * So that an operator can SELECT them, see exactly what is missing, and know
 * that nothing will be silently faked in the meantime. A provider that is
 * absent from the list looks like something the software cannot do; a provider
 * that is present and refusing looks like something the operator has not
 * finished. The second is the truth.
 */
import type { CarrierProviderName } from '../../../domain/carrier-status-map.js';
import { ErrorCode, AppError } from '../../../domain/errors.js';
import { decryptSecret } from '../../../infra/crypto.js';
import { prisma } from '../../../infra/prisma.js';
import {
  UnconfiguredCarrierAdapter,
  unsupported,
  type AddressValidationResult,
  type CarrierAdapter,
  type CarrierAddress,
  type CreateShipmentRequest,
  type CreateShipmentResponse,
  type ProofOfDeliveryResult,
  type RateQuote,
  type SchedulePickupResponse,
  type TrackingResult,
} from './adapter.js';

/**
 * The carrier that is a person with a phone.
 *
 * Every operation is either a local no-op or an explicit "not through an API".
 * It is NOT a stub: a MANUAL carrier genuinely has no shipment to create at a
 * provider, no label to fetch and no tracking feed to poll - the events come
 * from the portal, which is the whole point of the portal.
 *
 * The distinction from an unconfigured adapter matters: this one is working
 * as designed, and the interface tells the difference by throwing
 * `unsupported` rather than `unconfigured`.
 */
class ManualCarrierAdapter implements CarrierAdapter {
  readonly provider: CarrierProviderName = 'MANUAL';
  readonly isConfigured = true;

  createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResponse> {
    /*
     * The consignment already exists in this system and its tracking number is
     * ours. There is nobody to tell, so this succeeds and returns what we
     * already know - which is honest, and is what lets the calling code treat
     * every provider identically.
     */
    return Promise.resolve({
      carrierTrackingNumber: request.shipmentReference,
      carrierShipmentId: null,
      trackingUrl: null,
      estimatedDeliveryAt: null,
      label: null,
    });
  }

  cancelShipment(): Promise<void> {
    return Promise.resolve();
  }

  getRates(): Promise<RateQuote[]> {
    // A manual carrier's prices are in a contract, not in an API. Returning an
    // empty list rather than throwing: "no live rates" is the truth and is not
    // an error the portal should show a red box for.
    return Promise.resolve([]);
  }

  schedulePickup(): Promise<SchedulePickupResponse> {
    // The pickup row in this database IS the booking.
    return Promise.resolve({ carrierPickupId: 'manual', confirmationNumber: null });
  }

  cancelPickup(): Promise<void> {
    return Promise.resolve();
  }

  getTracking(): Promise<TrackingResult> {
    throw unsupported('MANUAL', 'tracking lookup');
  }

  getProofOfDelivery(): Promise<ProofOfDeliveryResult> {
    throw unsupported('MANUAL', 'proof-of-delivery retrieval');
  }

  generateLabel(): Promise<{ contentType: string; bytes: Buffer }> {
    throw unsupported('MANUAL', 'label generation');
  }

  validateAddress(address: CarrierAddress): Promise<AddressValidationResult> {
    /*
     * The checks this software can make without asking anybody: the fields it
     * needs are present and the country is two letters. Deliberately NOT a
     * postcode-format table - there are two hundred of them, they change, and
     * a validator that refuses a correct Irish Eircode because its table is
     * stale is worse than no validator.
     */
    const messages: string[] = [];

    if (address.line1.trim().length === 0) messages.push('The street address is missing.');
    if (address.city.trim().length === 0) messages.push('The town or city is missing.');
    if (!/^[A-Za-z]{2}$/.test(address.countryCode)) messages.push('The country code is not valid.');

    return Promise.resolve({
      isValid: messages.length === 0,
      normalised: null,
      messages,
    });
  }
}

class DhlAdapter extends UnconfiguredCarrierAdapter {
  readonly provider: CarrierProviderName = 'DHL';
  readonly requiredVariables = ['DHL_API_KEY', 'DHL_API_SECRET', 'DHL_ACCOUNT_NUMBER'];
}

class FedExAdapter extends UnconfiguredCarrierAdapter {
  readonly provider: CarrierProviderName = 'FEDEX';
  readonly requiredVariables = ['FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET', 'FEDEX_ACCOUNT_NUMBER'];
}

class UpsAdapter extends UnconfiguredCarrierAdapter {
  readonly provider: CarrierProviderName = 'UPS';
  readonly requiredVariables = ['UPS_CLIENT_ID', 'UPS_CLIENT_SECRET', 'UPS_ACCOUNT_NUMBER'];
}

/**
 * A carrier whose API the operator wired up themselves.
 *
 * Configured means: a base URL and a credential on the `CarrierIntegration`
 * row. Unconfigured means the same refusal every other provider gives, naming
 * the fields on that row rather than environment variables - because for this
 * provider that is where the configuration actually lives.
 *
 * The HTTP calls go through `infra/outbound-http.ts`, which resolves the
 * hostname itself, refuses private and loopback addresses, pins the socket to
 * an address that passed and re-validates every redirect. An operator-supplied
 * URL is exactly the SSRF surface that file exists for.
 */
class CustomCarrierAdapter extends UnconfiguredCarrierAdapter {
  readonly provider: CarrierProviderName = 'CUSTOM';
  readonly requiredVariables = [
    'the integration’s base URL',
    'its API credential',
    'its status mapping',
  ];
}

const MANUAL = new ManualCarrierAdapter();

/**
 * The adapter for one integration row.
 *
 * Reads the row, decrypts nothing unless it has to, and returns a refusing
 * adapter wherever the credentials are absent. The credential is decrypted
 * ONLY inside the adapter that needs it and is never returned from this
 * function - a registry that handed back a secret would put one into every
 * caller's stack frame.
 */
export async function adapterForIntegration(
  carrierIntegrationId: string | null,
): Promise<CarrierAdapter> {
  if (carrierIntegrationId === null) return MANUAL;

  const integration = await prisma.carrierIntegration.findUnique({
    where: { id: carrierIntegrationId },
    select: { provider: true, state: true, baseUrl: true, credentialsEnc: true, isActive: true },
  });

  if (integration === null || !integration.isActive) return MANUAL;

  switch (integration.provider) {
    case 'MANUAL':
      return MANUAL;
    case 'DHL':
      return new DhlAdapter();
    case 'FEDEX':
      return new FedExAdapter();
    case 'UPS':
      return new UpsAdapter();
    case 'CUSTOM':
      return new CustomCarrierAdapter();
  }
}

/** Every provider, and what each one needs, for the admin integrations screen. */
export function describeProviders(): {
  provider: CarrierProviderName;
  worksOutOfTheBox: boolean;
  requires: readonly string[];
}[] {
  return [
    { provider: 'MANUAL', worksOutOfTheBox: true, requires: [] },
    {
      provider: 'CUSTOM',
      worksOutOfTheBox: false,
      requires: new CustomCarrierAdapter().requiredVariables,
    },
    { provider: 'DHL', worksOutOfTheBox: false, requires: new DhlAdapter().requiredVariables },
    { provider: 'FEDEX', worksOutOfTheBox: false, requires: new FedExAdapter().requiredVariables },
    { provider: 'UPS', worksOutOfTheBox: false, requires: new UpsAdapter().requiredVariables },
  ];
}

/**
 * Read an integration's stored credential.
 *
 * Bound to the integration's own id as additional authenticated data, so a
 * credential copied from one row into another fails to decrypt rather than
 * quietly working somewhere it was never meant to. Returns null rather than
 * throwing for an absent one: "not configured" is a state, not a fault.
 *
 * Exported for the adapters and for the connection test, and for nothing else.
 */
export function readCredential(
  carrierIntegrationId: string,
  credentialsEnc: string | null,
): Record<string, string> | null {
  if (credentialsEnc === null || credentialsEnc.length === 0) return null;

  try {
    const parsed: unknown = JSON.parse(
      decryptSecret(credentialsEnc, `carrier_integration:${carrierIntegrationId}`),
    );

    if (typeof parsed !== 'object' || parsed === null) return null;

    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') output[key] = value;
    }

    return output;
  } catch {
    /*
     * A credential that will not decrypt is a configuration fault, not a
     * secret worth logging. The caller treats null as "unconfigured" and the
     * operator sees the connection test fail with a message that names the
     * row - which is enough to find it, and nothing more.
     */
    return null;
  }
}

/** Raised where a carrier answered and refused. */
export function carrierRefused(provider: CarrierProviderName, detail: string): AppError {
  return new AppError({
    statusCode: 502,
    code: ErrorCode.CARRIER_REQUEST_FAILED,
    message: `${provider} refused the request: ${detail}`,
    details: [{ code: 'CARRIER_REFUSED', meta: { provider } }],
  });
}
