/**
 * What the customer is asked to pay with, and how that becomes a gateway.
 *
 * The storefront names **instruments**, never gateways. "Pay with Credit Card"
 * is a question a person can answer; "Razorpay or Stripe" is the operator's
 * plumbing, and a customer asked to choose between two acquirers has no basis
 * for preferring one. So the choice on screen is the instrument, and the
 * gateway is resolved here from what the operator has actually connected.
 *
 * Everything in this file is pure. It is handed the offer - which gateways are
 * connected, what currency they settle, which of them has UPI switched on -
 * and answers which gateway serves a given instrument. It reads no database
 * and calls no provider, so the rule can be tested exhaustively without one.
 *
 * Two things it deliberately does NOT decide:
 *
 *   1. **Whether a card is credit or debit.** No gateway can tell before the
 *      card is entered, so the instrument is a routing hint on the way in and
 *      a filter on the way out. `fundingFor` maps a provider's own answer back
 *      onto an instrument once the card exists; nothing infers it earlier.
 *
 *   2. **Whether a card may be stored.** That is consent, and it belongs to
 *      the customer rather than to the routing table. See
 *      `PaymentConsentScope` in the schema.
 */
import { ErrorCode, badRequest } from './errors.js';

export const PaymentInstrumentValues = ['CREDIT_CARD', 'DEBIT_CARD', 'UPI'] as const;

export type PaymentInstrument = (typeof PaymentInstrumentValues)[number];

/** The gateways this application can be wired to. Mirrors `ProviderKind`. */
export type GatewayKind = 'RAZORPAY' | 'STRIPE';

export function isPaymentInstrument(value: unknown): value is PaymentInstrument {
  return (
    typeof value === 'string' &&
    (PaymentInstrumentValues as readonly string[]).includes(value)
  );
}

/** True for the two instruments that are a card underneath. */
export function isCardInstrument(instrument: PaymentInstrument): boolean {
  return instrument === 'CREDIT_CARD' || instrument === 'DEBIT_CARD';
}

/**
 * Which instrument a stored card belongs under, from the provider's own word
 * for it.
 *
 * Stripe calls it `funding` (`credit`, `debit`, `prepaid`, `unknown`);
 * Razorpay calls it `card.type` and uses the same first two spellings. Both
 * arrive here lowercased by their adapter.
 *
 * A prepaid card, or one whose funding the provider would not say, comes back
 * null rather than being guessed into one of the lists. It is still a usable
 * card - it simply appears under both headings rather than being filed wrongly
 * under one, because telling a customer their credit card is a debit card is
 * worse than telling them nothing.
 */
export function fundingFor(providerFunding: string | null): PaymentInstrument | null {
  if (providerFunding === null) return null;

  const normalised = providerFunding.trim().toLowerCase();

  if (normalised === 'credit') return 'CREDIT_CARD';
  if (normalised === 'debit') return 'DEBIT_CARD';

  return null;
}

/**
 * Whether a stored card should be offered under a given instrument.
 *
 * A card of unknown funding is offered under both card headings - see
 * `fundingFor`. A card is never offered under UPI, which is not a card at all.
 */
export function cardSuitsInstrument(
  providerFunding: string | null,
  instrument: PaymentInstrument,
): boolean {
  if (!isCardInstrument(instrument)) return false;

  const known = fundingFor(providerFunding);
  return known === null || known === instrument;
}

/**
 * One gateway, as far as this decision is concerned.
 *
 * Deliberately not the full `AvailableGateway`: this file must not grow a
 * dependency on the payments module, or the pure rule stops being testable
 * without one.
 */
export interface GatewayOffer {
  provider: GatewayKind;
  /**
   * ISO-4217 codes this gateway may be offered for, or null for no limit.
   *
   * Razorpay settles to an Indian account; Stripe imposes no limit here.
   */
  currencies: string[] | null;
  /** True when this gateway's account actually has UPI switched on. */
  hasUpi: boolean;
  /** True when this gateway can store a card and hand back a token. */
  canStoreCards: boolean;
}

export interface ResolvedInstrument {
  provider: GatewayKind;
  /**
   * The hint the gateway's sheet is opened on.
   *
   * `UPI` only ever reaches a gateway that reported having it. A card
   * instrument asks for `ANY` rather than naming cards, because no gateway
   * here can be told "cards only" without also hiding methods the customer may
   * legitimately want to fall back to once the sheet is open.
   */
  methodHint: 'ANY' | 'UPI';
  /** Whether a card paid with here can be offered back at the next checkout. */
  canStoreCards: boolean;
}

/** Whether a gateway can settle a given currency. */
function handles(offer: GatewayOffer, currency: string): boolean {
  return offer.currencies === null || offer.currencies.includes(currency.toUpperCase());
}

/**
 * Which instruments may be put in front of a customer paying in this currency.
 *
 * Order is the order they are shown in, and it is fixed rather than derived:
 * the two card options first, because they are what most customers use, and
 * UPI last because it is present for only some deployments and a list whose
 * first entry moves about is hard to build a habit on.
 */
export function offerableInstruments(
  offers: GatewayOffer[],
  currency: string,
): PaymentInstrument[] {
  const usable = offers.filter((offer) => handles(offer, currency));

  if (usable.length === 0) return [];

  const instruments: PaymentInstrument[] = ['CREDIT_CARD', 'DEBIT_CARD'];

  // Never inferred from the gateway being Razorpay. A Razorpay account can
  // have UPI switched off, and its sheet then has no UPI tab to open on -
  // promising one lands the customer on a card form with nothing to explain
  // the difference.
  if (usable.some((offer) => offer.hasUpi)) instruments.push('UPI');

  return instruments;
}

/**
 * Pick the gateway for an instrument.
 *
 * `preferred` is the operator's configured default, honoured whenever it can
 * serve the request. Otherwise the first gateway that can, so a deployment
 * whose default cannot settle this cart still takes the payment rather than
 * refusing it.
 *
 * Throws rather than falling back to a gateway that cannot do the job. A
 * customer who chose UPI and is silently handed a card form has been told
 * something untrue by this application, and that is worse than being told the
 * option is unavailable.
 */
export function resolveInstrument(
  instrument: PaymentInstrument,
  currency: string,
  offers: GatewayOffer[],
  preferred: GatewayKind | null,
): ResolvedInstrument {
  const usable = offers.filter(
    (offer) => handles(offer, currency) && (instrument !== 'UPI' || offer.hasUpi),
  );

  const chosen =
    usable.find((offer) => offer.provider === preferred) ?? usable[0] ?? null;

  if (chosen === null) {
    throw badRequest(
      ErrorCode.PAYMENT_INSTRUMENT_UNAVAILABLE,
      instrument === 'UPI'
        ? 'UPI is not available for this order. Please pay by card instead.'
        : `No card payment is available for orders in ${currency.toUpperCase()} just now.`,
      [{ field: 'instrument', code: 'INSTRUMENT_UNAVAILABLE', meta: { instrument, currency } }],
    );
  }

  return {
    provider: chosen.provider,
    methodHint: instrument === 'UPI' ? 'UPI' : 'ANY',
    // A UPI payment produces nothing to store, whatever the gateway can do.
    canStoreCards: isCardInstrument(instrument) && chosen.canStoreCards,
  };
}
