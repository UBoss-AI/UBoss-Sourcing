/**
 * A seller choosing how their goods get delivered, and changing their mind.
 *
 * The service behind the Logistics Partner onboarding step and the Seller Hub
 * screen that step turns into once the application is approved. It owns the
 * `SellerFulfilmentMethod` rows, the roles on them, and the rules that route a
 * parcel to one.
 *
 * THREE RULES, AND EVERY FUNCTION HERE IS ONE OF THEM
 *
 *   1. **Ownership comes from the session, never from the request.** Every
 *      function takes the authenticated seller's account id as its first
 *      argument and filters by it in the same query that finds the row. There
 *      is deliberately no function here that takes a method id alone and
 *      trusts a `sellerAccountId` from a body - that shape is how a tenant
 *      boundary gets crossed, and it is not available.
 *
 *   2. **Eligibility is decided by `domain/seller-fulfilment.ts`.** One pure
 *      module, used by the screen that lists a seller's options and by the
 *      endpoint that accepts a choice, so what a seller is shown and what the
 *      server will accept cannot drift apart.
 *
 *   3. **Uniqueness is decided by the database.** One primary and one fallback
 *      per seller are UNIQUE indexes, not checks in this file. Two browser
 *      tabs saving at once is exactly the race a pre-check loses, and the
 *      loser gets a P2002 that is mapped to a readable refusal here.
 *
 * WHAT A SELLER STILL CANNOT DO, BY CONSTRUCTION
 *
 * Create, edit, activate, deactivate or assign a driver. None of those
 * functions exist in this file, the seller routes do not import the driver
 * service, and `logistics-permissions.ts` refuses a caller who is not a member
 * of the owning carrier. A seller who runs their own delivery arm gets a
 * SECOND, explicit membership of that organisation - being a seller owner does
 * not make somebody a fleet administrator, which is the distinction the brief
 * is most insistent about and the easiest one to lose.
 */
import { Prisma } from '../../generated/prisma/client.js';
import type {
  CarrierProvider,
  SellerFulfilmentMethodStatus,
  SellerFulfilmentMode,
  SellerFulfilmentRuleScope,
} from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  assertMethodTransition,
  carrierFromMethodKey,
  carrierSetupStatus,
  defaultTrackingModeFor,
  describeMethodStatus,
  hasVerifiedOfficialApi,
  methodKeyFor,
  type CarrierSetupStatus,
  normaliseCountry,
  normalisePostalPrefix,
  precedenceForScope,
  ruleKeyFor,
} from '../../domain/seller-fulfilment.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import { notifyMethodDecision } from './fulfilment-notification.service.js';

/** Who is acting, for the audit trail. Never used for authorisation. */
export interface SellerActor {
  memberId: string | null;
  userId: string | null;
  label: string | null;
}

// ---------------------------------------------------------------------------
// THE FIVE CARDS
// ---------------------------------------------------------------------------

/**
 * One option on the onboarding step, before a seller has chosen anything.
 *
 * The catalogue is code rather than a table: which ways of delivering exist is
 * the shape of the product, not a per-deployment setting, and an operator who
 * could delete `SELF_MANAGED` from a table would leave sellers holding rows
 * pointing at a mode nothing can explain. WHICH of them a given deployment
 * offers IS configurable - see `availableOptions` - but the list itself is
 * fixed.
 *
 * Every field here is something the brief asks each card to show, and they are
 * computed rather than written into the frontend so that the Seller Hub, the
 * admin panel and the documentation cannot disagree about what a mode means.
 */
export interface FulfilmentOptionCard {
  key: string;
  mode: SellerFulfilmentMode;
  provider: CarrierProvider | null;
  /** The name shown on the card. Translated in the frontend by `key`. */
  name: string;
  description: string;
  whoStores: 'SELLER' | 'OPERATOR';
  whoPacks: 'SELLER' | 'OPERATOR';
  whoDelivers: string;
  requiresApiCredentials: boolean;
  driversManagedHere: boolean;
  trackingMode: 'AUTOMATIC_API' | 'MANUAL_ENTRY' | 'EXTERNAL_LINK';
  /**
   * Whether this provider has an official API this repository can call.
   *
   * FALSE for India Post, and the card says so in those words rather than
   * showing a connect button that leads nowhere. See the adapter's own note.
   */
  hasVerifiedApi: boolean;
  requiresMarketplaceApproval: boolean;
  /** Where this option can be used, in one line. Null means no restriction. */
  originRestriction: string | null;
  /** The seller's existing method for this option, where they have one. */
  existing: FulfilmentMethodView | null;
}

/**
 * The five options, in the order the onboarding step shows them.
 *
 * `OPERATOR_FULFILLED` is deliberately last and deliberately present. It is
 * what this software did before any of the others existed, it needs nothing
 * from anybody, and it is the answer for a seller who has not decided yet -
 * which is most sellers on the day they apply. Leaving it off the list would
 * make a required step unanswerable for them.
 */
const OPTION_CATALOGUE: readonly Omit<FulfilmentOptionCard, 'existing' | 'name' | 'description'>[] =
  Object.freeze([
    {
      key: 'dhl',
      mode: 'INTEGRATED_CARRIER',
      provider: 'DHL',
      whoStores: 'SELLER',
      whoPacks: 'SELLER',
      whoDelivers: 'DHL',
      requiresApiCredentials: true,
      driversManagedHere: false,
      trackingMode: 'AUTOMATIC_API',
      hasVerifiedApi: true,
      requiresMarketplaceApproval: false,
      originRestriction: null,
    },
    {
      key: 'fedex',
      mode: 'INTEGRATED_CARRIER',
      provider: 'FEDEX',
      whoStores: 'SELLER',
      whoPacks: 'SELLER',
      whoDelivers: 'FedEx',
      requiresApiCredentials: true,
      driversManagedHere: false,
      trackingMode: 'AUTOMATIC_API',
      hasVerifiedApi: true,
      requiresMarketplaceApproval: false,
      originRestriction: null,
    },
    {
      key: 'india_post',
      mode: 'INTEGRATED_CARRIER',
      provider: 'INDIA_POST',
      whoDelivers: 'India Post — Department of Posts',
      whoStores: 'SELLER',
      whoPacks: 'SELLER',
      // FALSE, and this is the field that keeps the card honest: there is no
      // credential to collect because there is no API to authenticate to.
      requiresApiCredentials: false,
      driversManagedHere: false,
      trackingMode: 'EXTERNAL_LINK',
      hasVerifiedApi: false,
      requiresMarketplaceApproval: false,
      originRestriction: 'IN',
    },
    {
      key: 'self_managed',
      mode: 'SELF_MANAGED',
      provider: null,
      whoDelivers: 'Your own delivery team',
      whoStores: 'SELLER',
      whoPacks: 'SELLER',
      requiresApiCredentials: false,
      driversManagedHere: true,
      trackingMode: 'MANUAL_ENTRY',
      hasVerifiedApi: false,
      requiresMarketplaceApproval: true,
      originRestriction: null,
    },
    {
      key: 'dedicated_partner',
      mode: 'DEDICATED_PARTNER',
      provider: null,
      whoDelivers: 'A delivery company that works with you',
      whoStores: 'SELLER',
      whoPacks: 'SELLER',
      requiresApiCredentials: false,
      driversManagedHere: true,
      trackingMode: 'MANUAL_ENTRY',
      hasVerifiedApi: false,
      requiresMarketplaceApproval: true,
      originRestriction: null,
    },
    {
      key: 'operator_fulfilled',
      mode: 'OPERATOR_FULFILLED',
      provider: null,
      whoDelivers: 'The marketplace',
      whoStores: 'SELLER',
      whoPacks: 'SELLER',
      requiresApiCredentials: false,
      driversManagedHere: true,
      trackingMode: 'MANUAL_ENTRY',
      hasVerifiedApi: false,
      requiresMarketplaceApproval: false,
      originRestriction: null,
    },
  ]);

/**
 * The English copy for each card.
 *
 * Here rather than only in the frontend because the admin panel and the
 * generated feature guide read the same strings, and because an API that
 * returns a bare key forces every consumer to carry a copy of the words. The
 * frontends translate by `key` and fall back to these.
 */
const OPTION_COPY: Readonly<Record<string, { name: string; description: string }>> = Object.freeze({
  dhl: {
    name: 'DHL',
    description:
      'Connect your DHL business account for eligible rates, labels, pickup and tracking services.',
  },
  fedex: {
    name: 'FedEx',
    description:
      'Connect your FedEx business account for eligible shipment, label, pickup, tracking and return services.',
  },
  india_post: {
    name: 'India Post (IPS)',
    description:
      'Use supported India Post parcel and tracking services for eligible Indian destinations.',
  },
  self_managed: {
    name: 'Self-Managed Logistics',
    description: 'Deliver using your own logistics team, drivers, vehicles and service areas.',
  },
  dedicated_partner: {
    name: 'Dedicated Logistics Partner',
    description:
      'Connect a delivery company that works with your business and manages its own drivers.',
  },
  operator_fulfilled: {
    name: 'Marketplace delivery',
    description:
      'Let the marketplace arrange a carrier for your orders. Nothing to set up, and you can change this later.',
  },
});

// ---------------------------------------------------------------------------
// READING
// ---------------------------------------------------------------------------

export interface FulfilmentMethodView {
  id: string;
  mode: SellerFulfilmentMode;
  status: SellerFulfilmentMethodStatus;
  statusLabel: string;
  role: 'PRIMARY' | 'FALLBACK' | 'ADDITIONAL';
  publicDisplayName: string;
  allowsInternational: boolean;
  statusReason: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  /**
   * Which carrier this method is for. Null for every mode but
   * INTEGRATED_CARRIER.
   *
   * Read from the method itself, not from its connection. A method exists
   * from the moment the seller chooses the card, and it has no connection
   * until they add one - a screen that took the provider from the connection
   * had to guess until then, and it guessed DHL.
   */
  provider: CarrierProvider | null;
  environment: 'SANDBOX' | 'PRODUCTION' | null;
  /**
   * What a setup screen may say about the account, derived from the
   * connection's proven state. Null for modes with no carrier account. See
   * `carrierSetupStatus` - nothing a seller types can make this CONNECTED.
   */
  carrierSetupStatus: CarrierSetupStatus | null;
  /**
   * Whether this carrier can be used by booking outside and typing the result
   * in. True for every integrated carrier whatever its connection state: a
   * seller without an API account can still send a parcel with DHL.
   */
  manualBookingAvailable: boolean;
  /** The carrier account behind it, where the mode has one. Never its secret. */
  connection: {
    id: string;
    provider: CarrierProvider;
    environment: 'SANDBOX' | 'PRODUCTION';
    state: string;
    trackingMode: string;
    accountNumberHint: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastFailureMessage: string | null;
  } | null;
  /** The delivery organisation behind it, where the mode has one. */
  partner: {
    id: string;
    displayName: string;
    partnerKind: string;
    status: string;
  } | null;
  ruleCount: number;
}

/**
 * Every way this seller can ship, with the state of each.
 *
 * Reads no secret and cannot be asked for one: the credential lives in its own
 * table and this query does not touch it. What a seller sees of their own DHL
 * connection is its state, the last four characters of the account number and
 * when it last worked.
 */
export async function listFulfilmentMethods(
  sellerAccountId: string,
): Promise<FulfilmentMethodView[]> {
  const rows = await prisma.sellerFulfilmentMethod.findMany({
    where: { sellerAccountId, archivedAt: null },
    include: {
      carrierConnection: {
        select: {
          id: true,
          provider: true,
          environment: true,
          state: true,
          trackingMode: true,
          accountNumber: true,
          lastSuccessAt: true,
          lastFailureAt: true,
          lastFailureMessage: true,
          lastTestAt: true,
          lastTestPassedAt: true,
          credential: { select: { id: true } },
        },
      },
      logisticsPartner: {
        select: { id: true, displayName: true, partnerKind: true, status: true },
      },
      _count: { select: { rules: true } },
    },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });

  return rows.map((row) => {
    const carrier = row.mode === 'INTEGRATED_CARRIER' ? carrierFromMethodKey(row.methodKey) : null;

    return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    statusLabel: describeMethodStatus(row.status),
    role: row.role,
    publicDisplayName: row.publicDisplayName,
    allowsInternational: row.allowsInternational,
    statusReason: row.statusReason,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    provider: carrier?.provider ?? null,
    environment: carrier?.environment ?? null,
    carrierSetupStatus:
      carrier === null
        ? null
        : carrierSetupStatus({
            provider: carrier.provider,
            connection:
              row.carrierConnection === null
                ? null
                : {
                    state: row.carrierConnection.state,
                    hasCredential: row.carrierConnection.credential !== null,
                    lastTestAt: row.carrierConnection.lastTestAt,
                    lastTestPassedAt: row.carrierConnection.lastTestPassedAt,
                  },
          }),
    manualBookingAvailable: carrier !== null,
    connection:
      row.carrierConnection === null
        ? null
        : {
            id: row.carrierConnection.id,
            provider: row.carrierConnection.provider,
            environment: row.carrierConnection.environment,
            state: row.carrierConnection.state,
            trackingMode: row.carrierConnection.trackingMode,
            // The last four characters and nothing else. An account number is
            // not a secret, but the whole of it on a screen is more than the
            // screen needs to confirm which account this is.
            accountNumberHint: maskTail(row.carrierConnection.accountNumber),
            lastSuccessAt: row.carrierConnection.lastSuccessAt?.toISOString() ?? null,
            lastFailureAt: row.carrierConnection.lastFailureAt?.toISOString() ?? null,
            lastFailureMessage: row.carrierConnection.lastFailureMessage,
          },
    partner:
      row.logisticsPartner === null
        ? null
        : {
            id: row.logisticsPartner.id,
            displayName: row.logisticsPartner.displayName,
            partnerKind: row.logisticsPartner.partnerKind,
            status: row.logisticsPartner.status,
          },
    ruleCount: row._count.rules,
    };
  });
}

/** The last four characters, for confirming which account this is. */
function maskTail(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  return value.length <= 4 ? value : `…${value.slice(-4)}`;
}

/**
 * The five cards, with this seller's own state folded into each.
 *
 * One call for the whole onboarding step: the option list, what the seller has
 * already done about each, and what each would require. A screen that fetched
 * the catalogue and the methods separately would render the cards before it
 * knew which were already set up, which is a flash of "not started" against
 * something the seller finished last week.
 */
export async function describeFulfilmentOptions(sellerAccountId: string): Promise<{
  options: FulfilmentOptionCard[];
  methods: FulfilmentMethodView[];
}> {
  const methods = await listFulfilmentMethods(sellerAccountId);

  const options = OPTION_CATALOGUE.map((option) => {
    const copy = OPTION_COPY[option.key] ?? { name: option.key, description: '' };

    /*
     * Match the seller's existing method to the card.
     *
     * By provider for an integrated carrier and by mode for the rest, because
     * a seller can hold a DHL method and a FedEx method at once and those are
     * two cards, while they hold at most one self-managed operation.
     */
    const existing =
      methods.find((method) =>
        option.provider === null
          ? method.mode === option.mode
          : method.mode === option.mode && method.provider === option.provider,
      ) ?? null;

    return { ...option, ...copy, existing };
  });

  return { options, methods };
}

// ---------------------------------------------------------------------------
// CHOOSING ONE
// ---------------------------------------------------------------------------

export interface ChooseMethodInput {
  sellerAccountId: string;
  actor: SellerActor;
  mode: SellerFulfilmentMode;
  /** Required for INTEGRATED_CARRIER, ignored otherwise. */
  provider?: CarrierProvider | null;
  environment?: 'SANDBOX' | 'PRODUCTION' | null;
  /** What buyers are told carried the parcel. Defaulted where the seller gives none. */
  publicDisplayName?: string | null;
  /** Whether to make this the seller's default straight away. */
  makePrimary?: boolean;
}

/**
 * Record that this seller intends to deliver a particular way.
 *
 * WHAT THIS DOES AND DOES NOT DO. It creates the METHOD - the seller's
 * statement of intent and the row everything else hangs off. It does not
 * create a carrier connection, a logistics organisation or an invitation;
 * those are separate, deliberate acts with their own screens, and a single
 * call that did all of them would make "I want to look at what DHL involves"
 * indistinguishable from "store my DHL credentials".
 *
 * THE ONE MODE THAT FINISHES IMMEDIATELY is OPERATOR_FULFILLED. It needs no
 * target, no credential and no approval - it is what happens today - so it is
 * created APPROVED and the onboarding step goes green. That is what makes a
 * required step answerable in one click by a seller who has not decided yet.
 *
 * Idempotent per target. A seller pressing the DHL card twice moves the one
 * row rather than creating a second, because `methodKey` is unique per seller.
 */
export async function chooseFulfilmentMethod(
  input: ChooseMethodInput,
): Promise<FulfilmentMethodView> {
  if (input.mode === 'INTEGRATED_CARRIER' && (input.provider ?? null) === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Choose which carrier you want to connect.',
      [{ field: 'provider', code: 'REQUIRED' }],
    );
  }

  const environment = input.environment ?? 'SANDBOX';
  const methodKey = methodKeyFor({
    mode: input.mode,
    provider: input.provider ?? null,
    environment,
  });

  const displayName =
    input.publicDisplayName?.trim() ??
    (await defaultDisplayNameFor(input.mode, input.provider ?? null));

  /*
   * OPERATOR_FULFILLED is approved on creation; everything else starts in
   * PENDING_SETUP, which is the honest description of a card the seller has
   * just pressed: they have said what they want and configured none of it.
   *
   * Not DRAFT. DRAFT is for a row a form is still being filled in against, and
   * nothing here leaves a half-written form behind.
   */
  const status: SellerFulfilmentMethodStatus =
    input.mode === 'OPERATOR_FULFILLED' ? 'APPROVED' : 'PENDING_SETUP';

  const existing = await prisma.sellerFulfilmentMethod.findUnique({
    where: { sellerAccountId_methodKey: { sellerAccountId: input.sellerAccountId, methodKey } },
    select: { id: true, status: true, archivedAt: true },
  });

  const created = await prisma.$transaction(async (tx) => {
    if (existing !== null) {
      /*
       * Reviving a method the seller previously abandoned. The state machine
       * decides whether that is allowed - a DISCONNECTED row is terminal and
       * a seller reconnecting gets told to start a new one rather than
       * silently resurrecting a credential that was destroyed.
       */
      if (existing.status !== status) {
        assertMethodTransition(existing.status, status, 'Chosen again by the seller.');
      }

      return tx.sellerFulfilmentMethod.update({
        where: { id: existing.id },
        data: {
          status,
          publicDisplayName: displayName,
          archivedAt: null,
          statusReason: null,
        },
        select: { id: true },
      });
    }

    return tx.sellerFulfilmentMethod.create({
      data: {
        id: newId(),
        sellerAccountId: input.sellerAccountId,
        mode: input.mode,
        status,
        role: 'ADDITIONAL',
        methodKey,
        publicDisplayName: displayName,
        // False until customs responsibilities are configured. A parcel
        // stopped at a border is worse than one never offered the option.
        allowsInternational: false,
      },
      select: { id: true },
    });
  });

  /*
   * A seller who added their FedEx account before choosing the FedEx card -
   * or who is choosing it again after archiving it - already has the
   * connection. Join them now, or the card forgets the account it has.
   */
  if (input.mode === 'INTEGRATED_CARRIER' && input.provider !== undefined && input.provider !== null) {
    const connection = await prisma.sellerCarrierConnection.findUnique({
      where: {
        sellerAccountId_provider_environment: {
          sellerAccountId: input.sellerAccountId,
          provider: input.provider,
          environment,
        },
      },
      select: { id: true, state: true },
    });

    if (connection !== null && connection.state !== 'DISCONNECTED') {
      await prisma.sellerFulfilmentMethod.update({
        where: { id: created.id },
        data: { sellerCarrierConnectionId: connection.id },
      });
    }
  }

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.fulfilment.method.chosen',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerFulfilmentMethod',
    resourceId: created.id,
    after: { mode: input.mode, provider: input.provider ?? null, status },
    summary: `Chose ${displayName} as a way of delivering.`,
  });

  /*
   * Make it the default where the seller asked, or where they have none.
   *
   * The second half matters more than the first: a seller who sets up one
   * method and never presses "make this primary" still has to be able to ship,
   * and the picker prefers an explicit primary. Doing it here rather than
   * making the seller do it removes a step nobody would understand the purpose
   * of.
   */
  if (input.makePrimary === true || (await countPrimaries(input.sellerAccountId)) === 0) {
    if (status === 'APPROVED') {
      await setMethodRole({
        sellerAccountId: input.sellerAccountId,
        actor: input.actor,
        methodId: created.id,
        role: 'PRIMARY',
      });
    }
  }

  const view = await findMethod(input.sellerAccountId, created.id);
  if (view === null) throw notFound('Delivery method');
  return view;
}

async function countPrimaries(sellerAccountId: string): Promise<number> {
  return prisma.sellerFulfilmentMethod.count({
    where: { sellerAccountId, role: 'PRIMARY', archivedAt: null },
  });
}

/**
 * The name a buyer is shown, where the seller supplied none.
 *
 * The operator's own configured display name for OPERATOR_FULFILLED - read
 * from `BusinessProfile`, never hard-coded, because this software is run by
 * whoever bought it and "UBOSS" on a customer's tracking page would be this
 * repository naming somebody else's business.
 */
async function defaultDisplayNameFor(
  mode: SellerFulfilmentMode,
  provider: CarrierProvider | null,
): Promise<string> {
  if (mode === 'INTEGRATED_CARRIER' && provider !== null) {
    const card = OPTION_CATALOGUE.find(
      (option) => option.mode === mode && option.provider === provider,
    );

    return card === undefined ? provider : (OPTION_COPY[card.key]?.name ?? provider);
  }

  if (mode === 'OPERATOR_FULFILLED') {
    const profile = await prisma.businessProfile.findFirst({ select: { displayName: true } });

    // A deployment that has not filled in its own name yet gets a neutral
    // phrase rather than an empty string on a customer's tracking page.
    return profile?.displayName?.trim() !== undefined && profile.displayName.trim().length > 0
      ? profile.displayName.trim()
      : 'Marketplace delivery';
  }

  // The seller names their own operation on the configuration screen. Until
  // then it is described by what it is.
  return mode === 'SELF_MANAGED' ? 'Our own delivery team' : 'Our delivery partner';
}

// ---------------------------------------------------------------------------
// ROLES
// ---------------------------------------------------------------------------

export interface SetRoleInput {
  sellerAccountId: string;
  actor: SellerActor;
  methodId: string;
  role: 'PRIMARY' | 'FALLBACK' | 'ADDITIONAL';
}

/**
 * Make a method the seller's default, their fallback, or neither.
 *
 * THE UNIQUENESS IS THE DATABASE'S. `primaryForSellerAccountId` holds the
 * seller's own id while this row is the primary and NULL when it is not, and a
 * UNIQUE index over it means a second primary collides. So this clears the
 * previous holder and sets the new one INSIDE ONE TRANSACTION, and a P2002
 * from a concurrent save becomes a readable refusal rather than a stack trace.
 *
 * Changing the default does NOT touch consignments already raised. The method
 * chosen for a parcel is written onto the shipment when it is chosen, which is
 * the whole reason it is stored there rather than looked up.
 */
export async function setMethodRole(input: SetRoleInput): Promise<FulfilmentMethodView> {
  const method = await prisma.sellerFulfilmentMethod.findFirst({
    // Both ids in the same query. A method belonging to another seller is not
    // found, rather than found and then refused.
    where: { id: input.methodId, sellerAccountId: input.sellerAccountId, archivedAt: null },
    select: { id: true, status: true, role: true, publicDisplayName: true },
  });

  if (method === null) throw notFound('Delivery method');

  if (input.role !== 'ADDITIONAL' && method.status !== 'APPROVED') {
    throw conflict(
      ErrorCode.SELLER_FULFILMENT_METHOD_NOT_APPROVED,
      `${method.publicDisplayName} is ${describeMethodStatus(method.status)}, so it cannot be your ${input.role === 'PRIMARY' ? 'default' : 'fallback'} yet.`,
      [{ code: 'NOT_APPROVED', meta: { methodId: method.id, status: method.status } }],
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (input.role === 'PRIMARY') {
        await tx.sellerFulfilmentMethod.updateMany({
          where: { sellerAccountId: input.sellerAccountId, role: 'PRIMARY' },
          data: { role: 'ADDITIONAL', primaryForSellerAccountId: null },
        });
      }

      if (input.role === 'FALLBACK') {
        await tx.sellerFulfilmentMethod.updateMany({
          where: { sellerAccountId: input.sellerAccountId, role: 'FALLBACK' },
          data: { role: 'ADDITIONAL', fallbackForSellerAccountId: null },
        });
      }

      await tx.sellerFulfilmentMethod.update({
        where: { id: method.id },
        data: {
          role: input.role,
          // Set together with the role, cleared together with it. The two
          // columns are the mechanism behind the uniqueness and must never
          // disagree with the enum beside them.
          primaryForSellerAccountId:
            input.role === 'PRIMARY' ? input.sellerAccountId : null,
          fallbackForSellerAccountId:
            input.role === 'FALLBACK' ? input.sellerAccountId : null,
        },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw conflict(
        ErrorCode.SELLER_FULFILMENT_ROLE_TAKEN,
        'Somebody else changed your delivery defaults at the same time. Open the page again and try once more.',
        [{ code: 'ROLE_TAKEN', meta: { role: input.role } }],
      );
    }

    throw error;
  }

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.fulfilment.method.role',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerFulfilmentMethod',
    resourceId: method.id,
    before: { role: method.role },
    after: { role: input.role },
    summary: `Made ${method.publicDisplayName} the ${input.role.toLowerCase()} way of delivering.`,
  });

  const view = await findMethod(input.sellerAccountId, method.id);
  if (view === null) throw notFound('Delivery method');
  return view;
}

// ---------------------------------------------------------------------------
// PAUSING, RESUMING, DISCONNECTING
// ---------------------------------------------------------------------------

export interface ChangeMethodStatusInput {
  sellerAccountId: string;
  actor: SellerActor;
  methodId: string;
  status: SellerFulfilmentMethodStatus;
  reason: string | null;
}

/**
 * Move a method between statuses, through the state machine and nothing else.
 *
 * The seller's half of it: pause, resume and disconnect. The marketplace's
 * half - approve, refuse, ask for changes - lives in the admin service and
 * goes through the same assertion, for the same reason order status does.
 *
 * A PAUSED method keeps its consignments. Parcels already on a van finish;
 * new ones go elsewhere. Ending it the other way would strand them, which is
 * worse than the problem pausing is usually reaching for.
 */
export async function changeMethodStatus(
  input: ChangeMethodStatusInput,
): Promise<FulfilmentMethodView> {
  const method = await prisma.sellerFulfilmentMethod.findFirst({
    where: { id: input.methodId, sellerAccountId: input.sellerAccountId, archivedAt: null },
    select: { id: true, status: true, role: true, publicDisplayName: true },
  });

  if (method === null) throw notFound('Delivery method');

  assertMethodTransition(method.status, input.status, input.reason);

  await prisma.sellerFulfilmentMethod.update({
    where: { id: method.id },
    data: {
      status: input.status,
      statusReason: input.reason,
      /*
       * A method that can no longer carry anything cannot stay the default.
       * Leaving it as primary would make the picker try it first on every
       * order and fall through on every order, which reads to the seller as
       * "the marketplace ignores my settings".
       */
      ...(input.status === 'APPROVED'
        ? {}
        : {
            role: 'ADDITIONAL',
            primaryForSellerAccountId: null,
            fallbackForSellerAccountId: null,
          }),
    },
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.fulfilment.method.status',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerFulfilmentMethod',
    resourceId: method.id,
    before: { status: method.status, role: method.role },
    after: { status: input.status },
    summary: `${method.publicDisplayName} is now ${describeMethodStatus(input.status)}.`,
  });

  const view = await findMethod(input.sellerAccountId, method.id);
  if (view === null) throw notFound('Delivery method');
  return view;
}

// ---------------------------------------------------------------------------
// THE MARKETPLACE'S HALF OF THE STATE MACHINE
// ---------------------------------------------------------------------------

export interface DecideMethodInput {
  fulfilmentMethodId: string;
  to: 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED';
  decidedByUserId: string;
  reason: string | null;
  /**
   * Whether this method may carry consignments that cross a border.
   *
   * Decided here rather than by the seller, and left alone when omitted. It
   * turns on whether customs responsibilities have been settled, which is a
   * question about paperwork the marketplace has seen - not one a seller can
   * answer about themselves by ticking a box.
   */
  allowsInternational?: boolean;
}

/**
 * Approve a seller's delivery method, refuse it, or ask for changes.
 *
 * The counterpart of `changeMethodStatus`, which is the seller's half. Both go
 * through `assertMethodTransition`, so there is exactly one definition of
 * which moves are legal and neither side can invent one - the same rule order
 * status has followed since the beginning.
 *
 * WHY THE MARKETPLACE APPROVES THIS AT ALL, given that it does not approve a
 * seller's own DHL account: a self-managed or dedicated method is a claim
 * about what the seller's vans can carry - cold chain, dangerous goods, a
 * service area - and those claims decide which orders the marketplace lets
 * them accept. A commercial account with DHL makes no such claim.
 */
export async function decideFulfilmentMethod(
  input: DecideMethodInput,
): Promise<FulfilmentMethodView> {
  const method = await prisma.sellerFulfilmentMethod.findUnique({
    where: { id: input.fulfilmentMethodId },
    select: {
      id: true,
      sellerAccountId: true,
      status: true,
      role: true,
      publicDisplayName: true,
    },
  });

  if (method === null) throw notFound('Delivery method');

  assertMethodTransition(method.status, input.to, input.reason);

  await prisma.sellerFulfilmentMethod.update({
    where: { id: method.id },
    data: {
      status: input.to,
      statusReason: input.reason,
      decidedByUserId: input.decidedByUserId,
      decidedAt: new Date(),
      ...(input.allowsInternational === undefined
        ? {}
        : { allowsInternational: input.allowsInternational }),
      /*
       * A method that is no longer approved cannot stay the default. Leaving
       * it there would make the picker try it first on every order and fall
       * through on every order, which reads to the seller as the marketplace
       * ignoring their settings.
       */
      ...(input.to === 'APPROVED'
        ? {}
        : { role: 'ADDITIONAL', primaryForSellerAccountId: null, fallbackForSellerAccountId: null }),
    },
  });

  await recordSellerAudit({
    sellerAccountId: method.sellerAccountId,
    action: 'seller.fulfilment.method.decided',
    // ADMIN, not CUSTOMER: this is the marketplace acting on the seller's
    // record, and the audit trail has to be able to tell the two apart.
    actor: { type: 'ADMIN', userId: input.decidedByUserId, label: 'Marketplace' },
    resourceType: 'SellerFulfilmentMethod',
    resourceId: method.id,
    before: { status: method.status },
    after: { status: input.to },
    summary: `${method.publicDisplayName} is now ${describeMethodStatus(input.to)}.`,
  });

  /*
   * The seller finds out.
   *
   * Without this, a decision made by somebody else in another application is
   * invisible until the seller happens to open the right screen - which for a
   * refusal means they carry on believing they can ship.
   */
  await notifyMethodDecision({
    sellerAccountId: method.sellerAccountId,
    fulfilmentMethodId: method.id,
    methodName: method.publicDisplayName,
    status: input.to,
    reason: input.reason,
  });

  const view = await findMethod(method.sellerAccountId, method.id);
  if (view === null) throw notFound('Delivery method');
  return view;
}

/**
 * The approvals queue.
 *
 * Across every seller, which is what makes it a queue rather than a screen you
 * have to already be on the right seller to find.
 */
export async function listMethodsAwaitingDecision(limit = 50): Promise<
  {
    id: string;
    sellerAccountId: string;
    sellerDisplayName: string;
    mode: SellerFulfilmentMode;
    publicDisplayName: string;
    partnerDisplayName: string | null;
    submittedAt: string | null;
  }[]
> {
  const rows = await prisma.sellerFulfilmentMethod.findMany({
    where: { status: 'PENDING_APPROVAL', archivedAt: null },
    include: {
      sellerAccount: { select: { displayName: true } },
      logisticsPartner: { select: { displayName: true } },
    },
    orderBy: { submittedAt: 'asc' },
    take: Math.min(limit, 200),
  });

  return rows.map((row) => ({
    id: row.id,
    sellerAccountId: row.sellerAccountId,
    sellerDisplayName: row.sellerAccount.displayName,
    mode: row.mode,
    publicDisplayName: row.publicDisplayName,
    partnerDisplayName: row.logisticsPartner?.displayName ?? null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------------

export interface RuleView {
  id: string;
  scope: SellerFulfilmentRuleScope;
  precedence: number;
  fulfilmentMethodId: string;
  methodName: string;
  sellerOfferId: string | null;
  sellerLocationId: string | null;
  destinationCountry: string | null;
  destinationPostalPrefix: string | null;
  note: string | null;
  isActive: boolean;
}

export async function listFulfilmentRules(sellerAccountId: string): Promise<RuleView[]> {
  const rows = await prisma.sellerFulfilmentRule.findMany({
    where: { sellerAccountId, archivedAt: null },
    include: { fulfilmentMethod: { select: { publicDisplayName: true } } },
    orderBy: [{ precedence: 'asc' }, { createdAt: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    precedence: row.precedence,
    fulfilmentMethodId: row.fulfilmentMethodId,
    methodName: row.fulfilmentMethod.publicDisplayName,
    sellerOfferId: row.sellerOfferId,
    sellerLocationId: row.sellerLocationId,
    destinationCountry: row.destinationCountry,
    destinationPostalPrefix: row.destinationPostalPrefix,
    note: row.note,
    isActive: row.isActive,
  }));
}

export interface UpsertRuleInput {
  sellerAccountId: string;
  actor: SellerActor;
  scope: SellerFulfilmentRuleScope;
  fulfilmentMethodId: string;
  sellerOfferId?: string | null;
  sellerLocationId?: string | null;
  destinationCountry?: string | null;
  destinationPostalPrefix?: string | null;
  note?: string | null;
}

/**
 * Write the rule that routes a parcel, or move the one that already exists.
 *
 * EVERY ID IN THE BODY IS RE-CHECKED AGAINST THE SESSION'S SELLER. The method,
 * the listing and the warehouse are each loaded with `sellerAccountId` in the
 * same `where`, so a request naming another seller's warehouse finds nothing
 * rather than finding something and being refused afterwards. A foreign key
 * cannot express "these two ids must belong to the same third row", which is
 * exactly the check a cross-tenant write needs.
 *
 * `precedence` and `ruleKey` are computed here from the scope rather than
 * accepted from the caller. The database refuses a row whose precedence is not
 * its scope's, so a client that sent its own would be refused - but computing
 * it means the client never has to know the numbers at all.
 */
export async function upsertFulfilmentRule(input: UpsertRuleInput): Promise<RuleView> {
  const method = await prisma.sellerFulfilmentMethod.findFirst({
    where: {
      id: input.fulfilmentMethodId,
      sellerAccountId: input.sellerAccountId,
      archivedAt: null,
    },
    select: { id: true, publicDisplayName: true },
  });

  if (method === null) {
    throw badRequest(
      ErrorCode.SELLER_FULFILMENT_RULE_INVALID,
      'That delivery method is not one of yours.',
      [{ field: 'fulfilmentMethodId', code: 'NOT_FOUND' }],
    );
  }

  const offerId = input.sellerOfferId ?? null;
  const locationId = input.sellerLocationId ?? null;
  const country = input.destinationCountry === null ? null : normaliseCountry(input.destinationCountry);
  const prefixRaw = normalisePostalPrefix(input.destinationPostalPrefix);
  const prefix = prefixRaw.length === 0 ? null : prefixRaw;

  // --- The scope's own field must be present, and must be the seller's ------

  if (input.scope === 'PRODUCT') {
    if (offerId === null) {
      throw badRequest(ErrorCode.SELLER_FULFILMENT_RULE_INVALID, 'Choose a listing for this rule.', [
        { field: 'sellerOfferId', code: 'REQUIRED' },
      ]);
    }

    const owned = await prisma.sellerOffer.count({
      where: { id: offerId, sellerAccountId: input.sellerAccountId },
    });

    if (owned === 0) {
      throw badRequest(
        ErrorCode.SELLER_FULFILMENT_RULE_INVALID,
        'That listing is not one of yours.',
        [{ field: 'sellerOfferId', code: 'NOT_FOUND' }],
      );
    }
  }

  if (input.scope === 'WAREHOUSE') {
    if (locationId === null) {
      throw badRequest(
        ErrorCode.SELLER_FULFILMENT_RULE_INVALID,
        'Choose a place for this rule.',
        [{ field: 'sellerLocationId', code: 'REQUIRED' }],
      );
    }

    const owned = await prisma.sellerLocation.count({
      where: { id: locationId, sellerAccountId: input.sellerAccountId, archivedAt: null },
    });

    if (owned === 0) {
      throw badRequest(
        ErrorCode.SELLER_FULFILMENT_RULE_INVALID,
        'That place is not one of yours.',
        [{ field: 'sellerLocationId', code: 'NOT_FOUND' }],
      );
    }
  }

  if (input.scope === 'DESTINATION' && (country === null || country.length !== 2)) {
    throw badRequest(
      ErrorCode.SELLER_FULFILMENT_RULE_INVALID,
      'Choose a destination country for this rule.',
      [{ field: 'destinationCountry', code: 'REQUIRED' }],
    );
  }

  // Only the scope's own columns are written. A PRODUCT rule that carried a
  // leftover country from a half-edited form would be refused by
  // `chk_seller_fulfilment_rule_scope`, which is the backstop - this is what
  // stops it reaching the constraint at all.
  const match = {
    sellerOfferId: input.scope === 'PRODUCT' ? offerId : null,
    sellerLocationId: input.scope === 'WAREHOUSE' ? locationId : null,
    destinationCountry: input.scope === 'DESTINATION' ? country : null,
    destinationPostalPrefix: input.scope === 'DESTINATION' ? prefix : null,
  };

  const ruleKey = ruleKeyFor({ scope: input.scope, ...match });

  const row = await prisma.sellerFulfilmentRule.upsert({
    where: { sellerAccountId_ruleKey: { sellerAccountId: input.sellerAccountId, ruleKey } },
    create: {
      id: newId(),
      sellerAccountId: input.sellerAccountId,
      fulfilmentMethodId: method.id,
      scope: input.scope,
      precedence: precedenceForScope(input.scope),
      ruleKey,
      note: input.note ?? null,
      createdBySellerMemberId: input.actor.memberId,
      ...match,
    },
    update: {
      fulfilmentMethodId: method.id,
      note: input.note ?? null,
      isActive: true,
      archivedAt: null,
    },
    include: { fulfilmentMethod: { select: { publicDisplayName: true } } },
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.fulfilment.rule.saved',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerFulfilmentRule',
    resourceId: row.id,
    after: { scope: input.scope, ruleKey, method: method.publicDisplayName },
    summary: `Routed ${describeScope(input.scope)} to ${method.publicDisplayName}.`,
  });

  return {
    id: row.id,
    scope: row.scope,
    precedence: row.precedence,
    fulfilmentMethodId: row.fulfilmentMethodId,
    methodName: row.fulfilmentMethod.publicDisplayName,
    sellerOfferId: row.sellerOfferId,
    sellerLocationId: row.sellerLocationId,
    destinationCountry: row.destinationCountry,
    destinationPostalPrefix: row.destinationPostalPrefix,
    note: row.note,
    isActive: row.isActive,
  };
}

function describeScope(scope: SellerFulfilmentRuleScope): string {
  switch (scope) {
    case 'PRODUCT':
      return 'a listing';
    case 'WAREHOUSE':
      return 'a place';
    case 'DESTINATION':
      return 'a destination';
    case 'SELLER_DEFAULT':
      return 'everything else';
  }
}

/**
 * Retire a rule.
 *
 * Archived rather than deleted, because consignments point at it: a shipment
 * carries `fulfilmentSelectionRuleId` so that "why did this go by DHL?" has an
 * answer months later, and hard-deleting the row would turn that answer into a
 * null.
 */
export async function archiveFulfilmentRule(input: {
  sellerAccountId: string;
  actor: SellerActor;
  ruleId: string;
}): Promise<void> {
  const rule = await prisma.sellerFulfilmentRule.findFirst({
    where: { id: input.ruleId, sellerAccountId: input.sellerAccountId, archivedAt: null },
    select: { id: true, scope: true },
  });

  if (rule === null) throw notFound('Rule');

  await prisma.sellerFulfilmentRule.update({
    where: { id: rule.id },
    data: { isActive: false, archivedAt: new Date() },
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.fulfilment.rule.archived',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerFulfilmentRule',
    resourceId: rule.id,
    summary: `Stopped routing ${describeScope(rule.scope)} by a rule.`,
  });
}

// ---------------------------------------------------------------------------

async function findMethod(
  sellerAccountId: string,
  methodId: string,
): Promise<FulfilmentMethodView | null> {
  const all = await listFulfilmentMethods(sellerAccountId);
  return all.find((method) => method.id === methodId) ?? null;
}

/**
 * What a card should say about a provider whose API nobody has verified.
 *
 * Exported for the routes and for the admin panel, so the phrase a seller sees
 * and the phrase an operator sees are the same phrase. Returns null where
 * there is nothing to warn about.
 */
export function integrationCaveatFor(provider: CarrierProvider): string | null {
  if (hasVerifiedOfficialApi(provider)) return null;

  if (provider === 'INDIA_POST') {
    return (
      'Official API access is not verified for India Post. Consignments are recorded here and ' +
      'tracked by hand, with a link to India Post’s own tracking page. No rates, labels or ' +
      'automatic tracking are available.'
    );
  }

  return defaultTrackingModeFor(provider) === 'MANUAL_ENTRY'
    ? 'Tracking for this method is entered by hand.'
    : null;
}
