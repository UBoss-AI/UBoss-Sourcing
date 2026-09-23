/**
 * How a seller's own goods get delivered: the modes, the rules that pick one,
 * and the states a method moves between.
 *
 * Pure decision logic. No Prisma, no HTTP, no clock it did not receive - it
 * takes facts and returns a verdict with a reason, so every rule here can be
 * tested without a database and so the answer cannot differ between the screen
 * that shows a seller their options and the endpoint that accepts a choice.
 *
 * WHAT THIS FILE IS FOR, IN ONE SENTENCE
 *
 * A seller has several ways of getting a parcel to a buyer; this decides which
 * one carries a given consignment, and refuses in a way the seller can act on
 * when none of them can.
 *
 * THE COMPANION FILE
 *
 * `seller-logistics.ts` answers a narrower and older question: may this seller
 * hand work to that marketplace carrier. It is still the authority on that and
 * is not duplicated here. This file sits above it - it decides WHICH METHOD,
 * and where that method is a carrier relationship, the eligibility check in
 * that file is what says yes.
 *
 * THE LINE THIS FILE DOES NOT CROSS
 *
 * Nothing here knows whether a shipment belongs to the seller asking about it.
 * That is ownership, it is checked in the service against the session, and it
 * is never checked against anything a browser sent. Mixing eligibility and
 * ownership is how a tenant boundary gets satisfied with a request body.
 */
import type {
  CarrierProvider,
  SellerFulfilmentMethodStatus,
  SellerFulfilmentMode,
  SellerFulfilmentRuleScope,
} from '../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict } from './errors.js';

// ---------------------------------------------------------------------------
// WHO DOES WHAT
// ---------------------------------------------------------------------------

/**
 * The responsibility matrix, as data rather than as prose in a document.
 *
 * Every screen that explains a mode to a seller reads this, so the onboarding
 * card, the settings page and the documentation cannot drift apart - which
 * they do within one release when each restates it. The admin panel reads it
 * too, because an operator reviewing an application is answering the same
 * question the seller was asked.
 *
 * `driversManagedHere` is the row that matters most and is the one most often
 * got wrong. It is FALSE for every external carrier, and that is not a missing
 * feature: DHL's couriers are DHL's staff, their names and shifts are not
 * this system's to hold, and a screen offering to assign one would be
 * inventing a person.
 */
export interface FulfilmentModeProfile {
  mode: SellerFulfilmentMode;
  /** Who holds the stock until it is sold. */
  storage: 'SELLER' | 'OPERATOR';
  /** Who puts it in a box. */
  packing: 'SELLER' | 'OPERATOR';
  /** Who chooses the company that carries it. */
  carrierSelection: 'SELLER' | 'OPERATOR';
  /**
   * Whether drivers are named, managed and assigned inside this software.
   *
   * False for INTEGRATED_CARRIER, always. See the note above.
   */
  driversManagedHere: boolean;
  /** Whether the seller must supply API credentials of their own. */
  requiresSellerCredentials: boolean;
  /** Whether the marketplace has to approve it before it may carry anything. */
  requiresMarketplaceApproval: boolean;
}

export const FULFILMENT_MODE_PROFILES: Readonly<
  Record<SellerFulfilmentMode, FulfilmentModeProfile>
> = Object.freeze({
  INTEGRATED_CARRIER: {
    mode: 'INTEGRATED_CARRIER',
    storage: 'SELLER',
    packing: 'SELLER',
    carrierSelection: 'SELLER',
    // The carrier's own people. Never ours to name.
    driversManagedHere: false,
    requiresSellerCredentials: true,
    // The marketplace does not approve a seller's own commercial account with
    // DHL. It is not a party to it, and pretending to approve it would be
    // theatre. What IS gated is the connection going live, and that gate is a
    // real test plus the seller's own confirmation.
    requiresMarketplaceApproval: false,
  },
  SELF_MANAGED: {
    mode: 'SELF_MANAGED',
    storage: 'SELLER',
    packing: 'SELLER',
    carrierSelection: 'SELLER',
    driversManagedHere: true,
    requiresSellerCredentials: false,
    // Approved, because the seller is asserting capabilities - cold chain,
    // dangerous goods, a service area - that decide what the marketplace lets
    // them accept orders for.
    requiresMarketplaceApproval: true,
  },
  DEDICATED_PARTNER: {
    mode: 'DEDICATED_PARTNER',
    storage: 'SELLER',
    packing: 'SELLER',
    carrierSelection: 'SELLER',
    driversManagedHere: true,
    requiresSellerCredentials: false,
    requiresMarketplaceApproval: true,
  },
  OPERATOR_FULFILLED: {
    mode: 'OPERATOR_FULFILLED',
    storage: 'OPERATOR',
    packing: 'OPERATOR',
    carrierSelection: 'OPERATOR',
    driversManagedHere: true,
    requiresSellerCredentials: false,
    requiresMarketplaceApproval: false,
  },
});

/**
 * Whether this software may offer to manage drivers for a given mode.
 *
 * Read by the Seller Hub, the Logistics Portal and the admin panel before any
 * fleet screen is rendered. A single source for it, because three screens each
 * deciding independently is three chances to show a DHL seller a driver list.
 */
export function driversAreManagedHere(mode: SellerFulfilmentMode): boolean {
  return FULFILMENT_MODE_PROFILES[mode].driversManagedHere;
}

// ---------------------------------------------------------------------------
// WHAT A PROVIDER CAN HONESTLY CLAIM
// ---------------------------------------------------------------------------

/**
 * The tracking a provider can honestly offer before anybody configures it.
 *
 * The function that stops a screen lying. India Post is the reason it exists:
 * there is no openly documented authenticated API for booking, labels or
 * tracking that this repository can verify, so a connection to it starts as
 * EXTERNAL_LINK - the consignment number is real, the tracking lives on India
 * Post's own page, and this system links to it and claims nothing further.
 *
 * MANUAL is the logistics company working inside this portal, whose events are
 * typed in by its own dispatchers. That is not a limitation; it is what the
 * portal is.
 *
 * DHL, FedEx and UPS can offer AUTOMATIC_API - once, and only once, a
 * credential exists and a test has passed. This function says what the
 * provider is CAPABLE of, not what any particular connection has achieved;
 * `SellerCarrierConnection.state` is what says that.
 */
export function defaultTrackingModeFor(
  provider: CarrierProvider,
): 'AUTOMATIC_API' | 'MANUAL_ENTRY' | 'EXTERNAL_LINK' {
  switch (provider) {
    case 'DHL':
    case 'FEDEX':
    case 'UPS':
    case 'CUSTOM':
      return 'AUTOMATIC_API';
    case 'INDIA_POST':
      return 'EXTERNAL_LINK';
    case 'MANUAL':
      return 'MANUAL_ENTRY';
  }
}

/**
 * Whether a provider has a verified official API this repository can call.
 *
 * FALSE for India Post, and that is the honest answer rather than a temporary
 * one. It is used to decide whether a connection screen may ever show a
 * "connected" state at all - a provider that answers false here shows
 * "Manual tracking" or "Official API access not verified" and has no green
 * badge available to it, whatever a seller types into it.
 */
export function hasVerifiedOfficialApi(provider: CarrierProvider): boolean {
  return provider !== 'INDIA_POST' && provider !== 'MANUAL';
}

// ---------------------------------------------------------------------------
// THE SURROGATE KEYS
//
// Both of these produce the NOT NULL string that makes a uniqueness rule
// expressible at all. Two of the three target columns on a method are NULL on
// any given row, and three of the four match columns on a rule are - and
// MariaDB treats every NULL in a UNIQUE index as distinct, so a composite
// unique over nullable columns enforces nothing whatsoever.
//
// They are functions rather than inline string building because the key is
// written by one service and read by a second that has to reproduce it
// exactly. A seller whose two services disagree about the key gets two rows
// that the database was supposed to make impossible.
// ---------------------------------------------------------------------------

export interface MethodKeyInput {
  mode: SellerFulfilmentMode;
  provider?: CarrierProvider | null;
  environment?: 'SANDBOX' | 'PRODUCTION' | null;
  logisticsPartnerId?: string | null;
}

export function methodKeyFor(input: MethodKeyInput): string {
  switch (input.mode) {
    case 'INTEGRATED_CARRIER': {
      if (input.provider === null || input.provider === undefined) {
        throw badRequest(
          ErrorCode.VALIDATION_FAILED,
          'An integrated-carrier method needs a provider.',
          [{ field: 'provider', code: 'REQUIRED' }],
        );
      }

      // The environment is part of the key because a seller's sandbox account
      // and their production account are two different accounts, and a seller
      // testing one while the other carries real parcels is the ordinary case.
      return `CARRIER:${input.provider}:${input.environment ?? 'SANDBOX'}`;
    }

    case 'SELF_MANAGED':
    case 'DEDICATED_PARTNER': {
      if (
        input.logisticsPartnerId === null ||
        input.logisticsPartnerId === undefined ||
        input.logisticsPartnerId.length === 0
      ) {
        // A method still in DRAFT has no organisation yet, which is legitimate
        // and is what the onboarding step saves. It gets a key naming the mode
        // alone, so a seller cannot end up with two draft self-managed
        // methods - and the key is rewritten when the organisation is created.
        return `PENDING:${input.mode}`;
      }

      return `PARTNER:${input.logisticsPartnerId}`;
    }

    case 'OPERATOR_FULFILLED':
      return 'OPERATOR';
  }
}

/**
 * Which carrier an integrated-carrier method is for, read back out of its key.
 *
 * The inverse of `methodKeyFor`, and the only reader of that format. It exists
 * because a method is created the moment a seller presses the FedEx card - long
 * before any carrier connection exists - and until this was read, the only
 * place a method's provider appeared was `connection.provider`. A method with
 * no connection therefore had no provider at all, the setup panel fell back to
 * DHL, and the FedEx card said "Your DHL account" and created a DHL connection
 * when its button was pressed.
 *
 * Null for every other mode, and for a key this build does not recognise,
 * rather than a guess. A guess is exactly the bug this replaces.
 */
export function carrierFromMethodKey(methodKey: string): {
  provider: CarrierProvider;
  environment: 'SANDBOX' | 'PRODUCTION';
} | null {
  const match = /^CARRIER:([A-Z_]+):(SANDBOX|PRODUCTION)$/.exec(methodKey);
  if (match === null) return null;

  const provider = match[1] as string;
  const environment = match[2] as 'SANDBOX' | 'PRODUCTION';

  return (CARRIER_PROVIDERS as readonly string[]).includes(provider)
    ? { provider: provider as CarrierProvider, environment }
    : null;
}

/** Every `CarrierProvider`, for validating a value read back out of a string. */
const CARRIER_PROVIDERS: readonly CarrierProvider[] = Object.freeze([
  'MANUAL',
  'CUSTOM',
  'DHL',
  'FEDEX',
  'UPS',
  'INDIA_POST',
]);

// ---------------------------------------------------------------------------
// WHAT A CARRIER SETUP SCREEN MAY CLAIM
// ---------------------------------------------------------------------------

/**
 * The state of a seller's own carrier account, in the words a setup screen uses.
 *
 * Derived, never stored, and derived from the ONE thing that can prove a
 * connection works: `SellerCarrierConnection.state`, which reaches ACTIVE only
 * after a real call reached the carrier and a person confirmed it. Nothing a
 * seller types can produce CONNECTED.
 *
 *   NOT_CONFIGURED         nothing declared yet.
 *   CREDENTIALS_REQUIRED   the account is declared; no key has been saved.
 *   PENDING_VERIFICATION   a key is saved, or tested and waiting for the
 *                          seller's go-live. Not connected.
 *   CONNECTED              tested AND confirmed. The only state that is.
 *   CONNECTION_FAILED      the last test, or live traffic, failed.
 *   PAUSED                 tested once, deliberately out of service.
 *   MANUAL_MODE_AVAILABLE  the provider has no API this software can call -
 *                          India Post - so there is nothing to connect, and
 *                          the carrier is used by booking outside and typing
 *                          the result in.
 *
 * Manual booking is available for every provider in every one of these
 * states; that is a separate fact, carried separately by the caller.
 */
export type CarrierSetupStatus =
  | 'NOT_CONFIGURED'
  | 'CREDENTIALS_REQUIRED'
  | 'PENDING_VERIFICATION'
  | 'CONNECTED'
  | 'CONNECTION_FAILED'
  | 'PAUSED'
  | 'MANUAL_MODE_AVAILABLE';

export function carrierSetupStatus(input: {
  provider: CarrierProvider;
  connection: {
    state: string;
    hasCredential: boolean;
    lastTestAt: Date | string | null;
    lastTestPassedAt: Date | string | null;
  } | null;
}): CarrierSetupStatus {
  if (!hasVerifiedOfficialApi(input.provider)) return 'MANUAL_MODE_AVAILABLE';

  const connection = input.connection;
  if (connection === null || connection.state === 'DISCONNECTED') return 'NOT_CONFIGURED';

  switch (connection.state) {
    case 'ACTIVE':
      // Belt and braces: ACTIVE without a passed test cannot be reached through
      // the service, and if a hand-edited row ever produces it, the screen
      // does not repeat the claim.
      return connection.lastTestPassedAt === null ? 'PENDING_VERIFICATION' : 'CONNECTED';
    case 'ERROR':
      return 'CONNECTION_FAILED';
    case 'PAUSED':
      return 'PAUSED';
    default:
      break;
  }

  if (!connection.hasCredential) return 'CREDENTIALS_REQUIRED';

  // A test was run and did not pass. The key is there; it is wrong or the
  // carrier refused it, and "pending" would hide that.
  if (connection.lastTestAt !== null && connection.lastTestPassedAt === null) {
    return 'CONNECTION_FAILED';
  }

  return 'PENDING_VERIFICATION';
}

/**
 * The precedence stored beside a rule's scope.
 *
 * MUST agree with `chk_seller_fulfilment_rule_precedence` in
 * `20260922160000_seller_fulfilment_modes`. The database refuses a row whose
 * precedence is not its scope's, so a change here without a migration makes
 * every insert fail rather than quietly reordering a seller's routing - which
 * is the failure direction to want.
 */
export function precedenceForScope(scope: SellerFulfilmentRuleScope): number {
  switch (scope) {
    case 'PRODUCT':
      return 10;
    case 'WAREHOUSE':
      return 20;
    case 'DESTINATION':
      return 30;
    case 'SELLER_DEFAULT':
      return 40;
  }
}

export interface RuleKeyInput {
  scope: SellerFulfilmentRuleScope;
  sellerOfferId?: string | null;
  sellerLocationId?: string | null;
  destinationCountry?: string | null;
  destinationPostalPrefix?: string | null;
}

export function ruleKeyFor(input: RuleKeyInput): string {
  switch (input.scope) {
    case 'PRODUCT':
      return `PRODUCT:${input.sellerOfferId ?? ''}`;
    case 'WAREHOUSE':
      return `WAREHOUSE:${input.sellerLocationId ?? ''}`;
    case 'DESTINATION':
      // The prefix is part of the key, so "anywhere in Germany" and "Germany,
      // postcodes beginning 10" are two rules rather than one overwriting the
      // other. Normalised, so a seller typing "sw1 " and "SW1" does not create
      // two rules that can never both match.
      return `DESTINATION:${normaliseCountry(input.destinationCountry)}:${normalisePostalPrefix(
        input.destinationPostalPrefix,
      )}`;
    case 'SELLER_DEFAULT':
      return 'DEFAULT';
  }
}

/** Upper-cased, trimmed. Empty where absent - never null, for the key above. */
export function normaliseCountry(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

/**
 * Upper-cased, and stripped of everything that is not a letter or a digit.
 *
 * A postcode's formatting is the least stable thing about it: the same
 * district arrives as "SW1", "sw1 " and "SW-1" from three different address
 * forms. Matching on the raw text means a rule silently stops applying the day
 * somebody types a space.
 */
export function normalisePostalPrefix(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// THE STATE MACHINE
// ---------------------------------------------------------------------------

/**
 * Where a fulfilment method may go from where it is.
 *
 * The same shape as `order-state-machine.ts` and `schedule-state.ts`, and for
 * the same reason: a status that can be set to anything from anywhere is a
 * status that eventually is. Nothing writes `SellerFulfilmentMethod.status`
 * except through `assertMethodTransition`.
 *
 * Two things worth pointing at:
 *
 *   * REJECTED is not terminal. A seller who was refused may fix what was
 *     wrong and try again, and that moves this row back to PENDING_SETUP
 *     rather than creating a second one - so "how does this seller ship" is
 *     always answered by one row per target and can never be answered twice
 *     with different answers.
 *   * DISCONNECTED is terminal, and is the only one that is. It is reached by
 *     destroying a credential or ending a relationship, and there is nothing
 *     left to restore; a seller reconnecting gets a new row with a new key.
 */
const METHOD_TRANSITIONS: Readonly<
  Record<SellerFulfilmentMethodStatus, readonly SellerFulfilmentMethodStatus[]>
> = Object.freeze({
  DRAFT: ['PENDING_SETUP', 'DISCONNECTED'],
  PENDING_SETUP: ['PENDING_APPROVAL', 'APPROVED', 'DRAFT', 'DISCONNECTED'],
  PENDING_APPROVAL: ['APPROVED', 'CHANGES_REQUESTED', 'REJECTED'],
  APPROVED: ['PAUSED', 'CHANGES_REQUESTED', 'DISCONNECTED'],
  CHANGES_REQUESTED: ['PENDING_SETUP', 'PENDING_APPROVAL', 'DISCONNECTED'],
  REJECTED: ['PENDING_SETUP', 'DISCONNECTED'],
  PAUSED: ['APPROVED', 'DISCONNECTED'],
  DISCONNECTED: [],
});

export function canTransitionMethod(
  from: SellerFulfilmentMethodStatus,
  to: SellerFulfilmentMethodStatus,
): boolean {
  return METHOD_TRANSITIONS[from].includes(to);
}

/**
 * Statuses whose change must carry a reason, because somebody will ask.
 *
 * PAUSED is on the list and looks like it should not be: the seller paused it
 * themselves, so who is asking? The operator, three weeks later, working out
 * why a seller with an approved carrier has been shipping nothing.
 */
export function methodTransitionRequiresReason(to: SellerFulfilmentMethodStatus): boolean {
  return to === 'REJECTED' || to === 'CHANGES_REQUESTED' || to === 'PAUSED';
}

export function assertMethodTransition(
  from: SellerFulfilmentMethodStatus,
  to: SellerFulfilmentMethodStatus,
  reason: string | null,
): void {
  if (from === to) {
    throw conflict(
      ErrorCode.SELLER_FULFILMENT_TRANSITION_INVALID,
      `This delivery method is already ${describeMethodStatus(to)}.`,
      [{ code: 'SAME_STATUS', meta: { from, to } }],
    );
  }

  if (!canTransitionMethod(from, to)) {
    throw conflict(
      ErrorCode.SELLER_FULFILMENT_TRANSITION_INVALID,
      `A delivery method cannot move from ${describeMethodStatus(from)} to ${describeMethodStatus(to)}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from, to } }],
    );
  }

  if (methodTransitionRequiresReason(to) && (reason === null || reason.trim().length === 0)) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `Moving a delivery method to ${describeMethodStatus(to)} needs a reason.`,
      [{ field: 'reason', code: 'REQUIRED', meta: { to } }],
    );
  }
}

/** The status in words a seller reads, rather than the stored token. */
export function describeMethodStatus(status: SellerFulfilmentMethodStatus): string {
  switch (status) {
    case 'DRAFT':
      return 'not started';
    case 'PENDING_SETUP':
      return 'waiting for you to finish setting it up';
    case 'PENDING_APPROVAL':
      return 'with us for review';
    case 'APPROVED':
      return 'ready to use';
    case 'CHANGES_REQUESTED':
      return 'waiting for changes';
    case 'REJECTED':
      return 'not approved';
    case 'PAUSED':
      return 'paused';
    case 'DISCONNECTED':
      return 'disconnected';
  }
}

/** Whether new consignments may be sent this way. */
export function methodAcceptsNewWork(status: SellerFulfilmentMethodStatus): boolean {
  return status === 'APPROVED';
}

/**
 * Whether consignments already sent this way may still be worked.
 *
 * PAUSED is true and that is the distinction it exists for: pausing a method
 * stops new parcels and leaves the ones already on a van alone. Ending it the
 * other way would strand them, which is worse than the problem pausing is
 * usually reaching for. The same rule `linkAllowsExistingWork` applies to a
 * carrier arrangement, for the same reason.
 */
export function methodAllowsExistingWork(status: SellerFulfilmentMethodStatus): boolean {
  return status === 'APPROVED' || status === 'PAUSED' || status === 'CHANGES_REQUESTED';
}

// ---------------------------------------------------------------------------
// PICKING ONE
// ---------------------------------------------------------------------------

/** Why a method could not carry a particular consignment. */
export type MethodRefusal =
  /** Draft, in setup, awaiting review, paused, rejected or disconnected. */
  | 'NOT_APPROVED'
  /** The seller's own carrier account is not live. */
  | 'CONNECTION_NOT_ACTIVE'
  /** It cannot reach the collection or the delivery country. */
  | 'OUTSIDE_SERVICE_AREA'
  /** The consignment needs handling this method is not approved for. */
  | 'CAPABILITY_MISSING'
  /** It crosses a border and this method is not set up for customs. */
  | 'INTERNATIONAL_NOT_ENABLED'
  /** Heavier or larger than this method accepts. */
  | 'EXCEEDS_LIMITS';

/** One of a seller's ways of shipping, reduced to what the picker needs. */
export interface CandidateMethod {
  id: string;
  mode: SellerFulfilmentMode;
  status: SellerFulfilmentMethodStatus;
  role: 'PRIMARY' | 'FALLBACK' | 'ADDITIONAL';
  publicDisplayName: string;
  allowsInternational: boolean;
  /**
   * Whether the underlying connection or organisation is live.
   *
   * Resolved by the caller, because what "live" means differs per mode - an
   * ACTIVE carrier connection, or an ACTIVE logistics partner - and this file
   * does not read a database to find out.
   */
  targetIsLive: boolean;
  /**
   * Countries this method reaches. Null means "no declared restriction", which
   * is the honest reading of an empty service-area table: it is unconfigured,
   * not empty.
   */
  serviceCountries: readonly string[] | null;
  /** Capability names this method is APPROVED for. Null means unrestricted. */
  approvedCapabilities: readonly string[] | null;
  maxWeightGrams: number | null;
}

/** What the consignment needs of whoever carries it. */
export interface ConsignmentNeeds {
  originCountry: string;
  destinationCountry: string;
  requiredCapabilities: readonly string[];
  weightGrams: number | null;
}

/** One rule, reduced to what the picker needs. */
export interface CandidateRule {
  id: string;
  scope: SellerFulfilmentRuleScope;
  precedence: number;
  fulfilmentMethodId: string;
  isActive: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  note: string | null;
  /** The normalised match values, as `ruleKeyFor` would produce them. */
  sellerOfferId: string | null;
  sellerLocationId: string | null;
  destinationCountry: string | null;
  destinationPostalPrefix: string | null;
}

/** What is known about where this consignment starts and ends. */
export interface RuleContext {
  sellerOfferIds: readonly string[];
  sellerLocationId: string | null;
  destinationCountry: string;
  destinationPostalCode: string | null;
}

export type FulfilmentSelection =
  | {
      chosen: true;
      method: CandidateMethod;
      source: 'AUTOMATIC_RULE' | 'SELLER_DEFAULT' | 'FALLBACK';
      ruleId: string | null;
      /** The decision in words, stored on the shipment and shown to the seller. */
      reason: string;
    }
  | {
      chosen: false;
      /** Every method considered and why it was passed over. */
      considered: readonly { methodId: string; name: string; refusal: MethodRefusal }[];
    };

/**
 * Decide which of a seller's methods carries this consignment.
 *
 * THE ORDER IS THE PRODUCT, and it is the order the brief asks for: a rule
 * about this listing beats a rule about this building, which beats a rule
 * about where it is going, which beats the seller's default. Within that, the
 * primary method is tried before the fallback, and the fallback only where the
 * primary was genuinely ineligible rather than merely slower.
 *
 * A RULE GRANTS NOTHING. It selects among methods the seller already has, and
 * the eligibility check runs afterwards every time. A rule naming a method
 * that has since been paused selects nothing and the next rule down is tried -
 * which is why a seller who pauses their primary keeps shipping instead of
 * discovering at midnight that every rule points at a dead method.
 *
 * WHEN NOTHING IS ELIGIBLE this returns the list of what was considered and
 * why, and the caller parks the consignment for a person. It never picks
 * something unapproved because nothing else was left: a parcel that waits is
 * recoverable and a parcel sent by a carrier that is not allowed to hold it is
 * not.
 */
export function selectFulfilmentMethod(
  rules: readonly CandidateRule[],
  methods: readonly CandidateMethod[],
  needs: ConsignmentNeeds,
  context: RuleContext,
  now: Date = new Date(),
): FulfilmentSelection {
  const byId = new Map(methods.map((method) => [method.id, method]));
  const considered = new Map<string, { methodId: string; name: string; refusal: MethodRefusal }>();

  function record(method: CandidateMethod, refusal: MethodRefusal): void {
    // First refusal wins. A method passed over by a product rule and again by
    // the default is one method with one reason, not two lines in a list the
    // seller has to read twice.
    if (!considered.has(method.id)) {
      considered.set(method.id, {
        methodId: method.id,
        name: method.publicDisplayName,
        refusal,
      });
    }
  }

  const applicable = rules
    .filter((rule) => ruleApplies(rule, context, now))
    .sort((left, right) =>
      left.precedence === right.precedence
        ? // A stable tie-break so two rules of the same scope resolve the same
          // way on every call. Without it the answer depends on row order,
          // which changes when a seller edits something unrelated.
          left.id.localeCompare(right.id)
        : left.precedence - right.precedence,
    );

  for (const rule of applicable) {
    const method = byId.get(rule.fulfilmentMethodId);
    if (method === undefined) continue;

    const refusal = refuseMethod(method, needs);

    if (refusal === null) {
      return {
        chosen: true,
        method,
        source: rule.scope === 'SELLER_DEFAULT' ? 'SELLER_DEFAULT' : 'AUTOMATIC_RULE',
        ruleId: rule.id,
        reason:
          rule.note !== null && rule.note.trim().length > 0
            ? rule.note.trim()
            : describeRule(rule, method),
      };
    }

    record(method, refusal);
  }

  // No rule matched, or every rule that did named something ineligible. Fall
  // back to the seller's own primary and then to their declared fallback -
  // which is what those two roles are for, and is the last automatic step
  // before a person is asked.
  for (const role of ['PRIMARY', 'FALLBACK'] as const) {
    const method = methods.find((candidate) => candidate.role === role);
    if (method === undefined) continue;

    const refusal = refuseMethod(method, needs);

    if (refusal === null) {
      return {
        chosen: true,
        method,
        source: role === 'PRIMARY' ? 'SELLER_DEFAULT' : 'FALLBACK',
        ruleId: null,
        reason:
          role === 'PRIMARY'
            ? `Your default delivery method, ${method.publicDisplayName}.`
            : `Your fallback delivery method, ${method.publicDisplayName}, because nothing above it could take this consignment.`,
      };
    }

    record(method, refusal);
  }

  // Everything else the seller has, in case one of them can take it even
  // though no rule and no role pointed at it. A seller with one approved
  // method and no rules configured at all is the commonest shape on day one,
  // and refusing them because they never pressed "make this primary" would be
  // refusing them over a checkbox.
  for (const method of methods) {
    if (method.role !== 'ADDITIONAL') continue;

    const refusal = refuseMethod(method, needs);

    if (refusal === null) {
      return {
        chosen: true,
        method,
        source: 'SELLER_DEFAULT',
        ruleId: null,
        reason: `${method.publicDisplayName}, the only method set up that can take this consignment.`,
      };
    }

    record(method, refusal);
  }

  return { chosen: false, considered: [...considered.values()] };
}

/** Whether a rule's conditions are true of this consignment, right now. */
function ruleApplies(rule: CandidateRule, context: RuleContext, now: Date): boolean {
  if (!rule.isActive) return false;
  if (rule.effectiveFrom.getTime() > now.getTime()) return false;
  if (rule.effectiveTo !== null && rule.effectiveTo.getTime() <= now.getTime()) return false;

  switch (rule.scope) {
    case 'PRODUCT':
      return rule.sellerOfferId !== null && context.sellerOfferIds.includes(rule.sellerOfferId);

    case 'WAREHOUSE':
      return rule.sellerLocationId !== null && rule.sellerLocationId === context.sellerLocationId;

    case 'DESTINATION': {
      if (normaliseCountry(rule.destinationCountry) !== normaliseCountry(context.destinationCountry)) {
        return false;
      }

      const prefix = normalisePostalPrefix(rule.destinationPostalPrefix);
      // No prefix means the whole country, which is the common case.
      if (prefix.length === 0) return true;

      return normalisePostalPrefix(context.destinationPostalCode).startsWith(prefix);
    }

    case 'SELLER_DEFAULT':
      return true;
  }
}

/**
 * Why this method cannot carry this consignment, or null where it can.
 *
 * Ordered from "nothing to do with this consignment" to "this consignment
 * specifically", so the reason a seller is shown is the most general true one.
 * Telling somebody their carrier does not cover Portugal, when the real
 * problem is that the connection was never activated, sends them to fix the
 * wrong thing.
 */
export function refuseMethod(
  method: CandidateMethod,
  needs: ConsignmentNeeds,
): MethodRefusal | null {
  if (!methodAcceptsNewWork(method.status)) return 'NOT_APPROVED';
  if (!method.targetIsLive) return 'CONNECTION_NOT_ACTIVE';

  const crossesBorder =
    normaliseCountry(needs.originCountry) !== normaliseCountry(needs.destinationCountry);

  if (crossesBorder && !method.allowsInternational) return 'INTERNATIONAL_NOT_ENABLED';

  if (method.serviceCountries !== null) {
    const served = new Set(method.serviceCountries.map((code) => normaliseCountry(code)));

    // BOTH ends. A method set up to collect in Poland and deliver in Poland has
    // not agreed to take a parcel from Poland to Portugal, and checking only
    // the destination would let exactly that through.
    if (
      !served.has(normaliseCountry(needs.originCountry)) ||
      !served.has(normaliseCountry(needs.destinationCountry))
    ) {
      return 'OUTSIDE_SERVICE_AREA';
    }
  }

  if (method.approvedCapabilities !== null) {
    const approved = new Set(method.approvedCapabilities.map((name) => name.toUpperCase()));
    const missing = needs.requiredCapabilities.filter((name) => !approved.has(name.toUpperCase()));

    if (missing.length > 0) return 'CAPABILITY_MISSING';
  }

  if (
    method.maxWeightGrams !== null &&
    needs.weightGrams !== null &&
    needs.weightGrams > method.maxWeightGrams
  ) {
    return 'EXCEEDS_LIMITS';
  }

  return null;
}

/**
 * The refusal in words a seller can act on.
 *
 * Deliberately says nothing about another tenant's state. Why a dedicated
 * partner is suspended is between that company and the marketplace, and a
 * seller learning it from a dropdown is a disclosure nobody authorised.
 */
export function explainMethodRefusal(refusal: MethodRefusal, methodName: string): string {
  switch (refusal) {
    case 'NOT_APPROVED':
      return `${methodName} is not ready to use yet.`;
    case 'CONNECTION_NOT_ACTIVE':
      return `${methodName} is not connected right now, so it cannot take new consignments.`;
    case 'OUTSIDE_SERVICE_AREA':
      return `${methodName} does not cover this collection or delivery country.`;
    case 'CAPABILITY_MISSING':
      return `${methodName} is not approved for the handling this consignment needs.`;
    case 'INTERNATIONAL_NOT_ENABLED':
      return `${methodName} is not set up for international delivery, and this consignment crosses a border.`;
    case 'EXCEEDS_LIMITS':
      return `This consignment is heavier than ${methodName} accepts.`;
  }
}

/** A rule in words, for the trail stored on the consignment. */
function describeRule(rule: CandidateRule, method: CandidateMethod): string {
  switch (rule.scope) {
    case 'PRODUCT':
      return `Product rule: this listing ships by ${method.publicDisplayName}.`;
    case 'WAREHOUSE':
      return `Warehouse rule: anything leaving this place ships by ${method.publicDisplayName}.`;
    case 'DESTINATION': {
      const prefix = normalisePostalPrefix(rule.destinationPostalPrefix);
      const where =
        prefix.length === 0
          ? normaliseCountry(rule.destinationCountry)
          : `${normaliseCountry(rule.destinationCountry)} ${prefix}`;

      return `Destination rule: deliveries to ${where} ship by ${method.publicDisplayName}.`;
    }
    case 'SELLER_DEFAULT':
      return `Your default delivery method, ${method.publicDisplayName}.`;
  }
}
