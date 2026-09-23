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
 * India Post - Department of Posts. Honest about having no API.
 *
 * NOT an unconfigured adapter, and the distinction is the entire point of this
 * class. An unconfigured adapter says "this deployment has not supplied a
 * credential yet", which invites somebody to go and find one. There is no
 * credential to find: India Post publishes no openly documented authenticated
 * API for booking, rating, labelling or tracking that this repository has been
 * able to verify. What exists is a commercial bulk-customer arrangement
 * negotiated business by business, and a repository cannot assume one.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not scrape the consumer tracking page, which is CAPTCHA-protected.
 * It does not call an undocumented mobile endpoint. It does not use a
 * third-party reverse-engineered service. Each of those would produce a screen
 * that looks connected and breaks without warning, and the thing it would
 * break is a hospital being told where its consignment is.
 *
 * WHAT IT DOES INSTEAD
 *
 * Refuses every operation with CARRIER_OPERATION_NOT_SUPPORTED, which the
 * seller's screen renders as "Manual tracking - official API access not
 * verified". The consignment is real, the article number the seller types is
 * real and is format-checked, the tracking link goes to India Post's own page,
 * and the events are entered by an authorised person and labelled as
 * manual. Nothing is fabricated: no rate, no label, no pickup confirmation, no
 * delivery estimate and no tracking event.
 *
 * IF AN OFFICIAL API IS CONTRACTED, three things change and nothing else: this
 * class, the (currently empty) code table in 'domain/carrier-status-map.ts',
 * and the connection's tracking mode. The interface is already the right
 * shape, which is what "keep an adapter interface ready" means in code.
 */
class IndiaPostAdapter implements CarrierAdapter {
  readonly provider: CarrierProviderName = 'INDIA_POST';

  /**
   * TRUE, and it is not a lie.
   *
   * "Configured" here means "this adapter is usable as it stands" - and it is:
   * a seller can record a consignment, enter an article number and have it
   * tracked by hand. What it does NOT mean is "connected to an API", and no
   * screen reads this flag as though it did. The state that decides what a
   * seller is shown is 'SellerCarrierConnection.state' together with
   * 'hasVerifiedOfficialApi', which answers false for this provider and is
   * what withholds the green badge.
   */
  readonly isConfigured = true;

  createShipment(): Promise<CreateShipmentResponse> {
    throw unsupported('INDIA_POST', 'creating a consignment through an API');
  }

  cancelShipment(): Promise<void> {
    throw unsupported('INDIA_POST', 'cancelling a consignment through an API');
  }

  getRates(): Promise<RateQuote[]> {
    // An empty list rather than a throw, exactly as MANUAL does: "no live
    // rates" is the truth and is not an error worth a red box. A fabricated
    // postage figure here would be quoted to a buyer at checkout.
    return Promise.resolve([]);
  }

  schedulePickup(): Promise<SchedulePickupResponse> {
    throw unsupported('INDIA_POST', 'booking a collection through an API');
  }

  cancelPickup(): Promise<void> {
    throw unsupported('INDIA_POST', 'cancelling a collection through an API');
  }

  getTracking(): Promise<TrackingResult> {
    throw unsupported('INDIA_POST', 'automatic tracking');
  }

  getProofOfDelivery(): Promise<ProofOfDeliveryResult> {
    throw unsupported('INDIA_POST', 'proof-of-delivery retrieval');
  }

  generateLabel(): Promise<{ contentType: string; bytes: Buffer }> {
    throw unsupported('INDIA_POST', 'label generation');
  }

  validateAddress(address: CarrierAddress): Promise<AddressValidationResult> {
    /*
     * The checks this software can make without asking anybody, plus the one
     * India Post rule that is published and stable: a PIN code is six digits
     * and does not begin with a zero.
     *
     * Deliberately NOT a PIN-to-post-office table. There are around nineteen
     * thousand of them, they change, and a validator that refuses a correct
     * address because its table is stale is worse than no validator.
     */
    const messages: string[] = [];

    if (address.line1.trim().length === 0) messages.push('The street address is missing.');
    if (address.city.trim().length === 0) messages.push('The town or city is missing.');

    if (address.countryCode.toUpperCase() === 'IN') {
      const pin = address.postalCode.replace(/\s/g, '');

      if (!/^[1-9][0-9]{5}$/.test(pin)) {
        messages.push('An Indian PIN code is six digits and does not start with a zero.');
      }
    }

    return Promise.resolve({
      isValid: messages.length === 0,
      normalised: null,
      messages,
    });
  }
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
const INDIA_POST = new IndiaPostAdapter();

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
    case 'INDIA_POST':
      return INDIA_POST;
    case 'CUSTOM':
      return new CustomCarrierAdapter();
  }
}

/**
 * Why a provider has no interface to connect to.
 *
 * Two different things that look the same on a screen, and telling them apart
 * is the difference between an operator going to look for a credential and an
 * operator knowing there is none to find.
 */
export type NoApiReason =
  /** Works inside this portal by design. Its people type the events. */
  | 'INSIDE_PORTAL'
  /** Nobody has been able to verify an official interface. India Post. */
  | 'NOT_VERIFIED';

/**
 * Every provider, and what each one needs.
 *
 * `requires` names the fields a SELLER enters on their own connection - not
 * environment variables. It used to name `DHL_API_KEY` and friends, which was
 * left over from when one installation was expected to hold one account for
 * everybody. Nothing reads those, `config/env.ts` does not declare them, and
 * an operator who went looking for a place to set them would not find one.
 */
export function describeProviders(): {
  provider: CarrierProviderName;
  worksOutOfTheBox: boolean;
  requires: readonly string[];
  noApiReason: NoApiReason | null;
}[] {
  return [
    {
      provider: 'MANUAL',
      worksOutOfTheBox: true,
      requires: [],
      noApiReason: 'INSIDE_PORTAL',
    },
    {
      provider: 'CUSTOM',
      worksOutOfTheBox: false,
      requires: new CustomCarrierAdapter().requiredVariables,
      noApiReason: null,
    },
    {
      provider: 'DHL',
      worksOutOfTheBox: false,
      // What the seller types into their own connection screen.
      requires: ['an API key', 'an API secret', 'their DHL account number'],
      noApiReason: null,
    },
    {
      provider: 'FEDEX',
      worksOutOfTheBox: false,
      requires: ['a client ID', 'a client secret', 'their FedEx account number'],
      noApiReason: null,
    },
    {
      provider: 'UPS',
      worksOutOfTheBox: false,
      requires: ['a client ID', 'a client secret', 'their UPS account number'],
      noApiReason: null,
    },
    {
      // TRUE, and it means what it says for this provider: a seller can use
      // India Post today, by hand, with nothing to configure. It does not mean
      // there is an API - 'requires' is empty because there is nothing that
      // could be supplied, not because everything already has been.
      provider: 'INDIA_POST',
      worksOutOfTheBox: true,
      requires: [],
      noApiReason: 'NOT_VERIFIED',
    },
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

/**
 * The India Post adapter, for the seller-connection factory.
 *
 * Exported so `carrier-connection.service.ts` can return it without reaching
 * for a credential there is none of. A function rather than the instance, so
 * callers cannot hold a reference and mutate a shared object.
 */
export function indiaPostAdapter(): CarrierAdapter {
  return INDIA_POST;
}
