/**
 * A seller's four-level logistics policy, its carriers and its level prices.
 *
 * Two kinds of editor reach this file, and the whole of its authority model is
 * which of them may touch which level:
 *
 *   - the SELLER, from Seller Hub -> Logistics, on the levels their policy
 *     gives to the seller - L1 always, and L2-L4 when the mode says so;
 *   - UBOSS staff, from the admin panel, on the levels the policy gives to
 *     UBOSS - never L1, and never a level the seller controls.
 *
 * That is decided HERE, on every write, against the database - not by a
 * disabled input. A seller who crafts a request to price a UBOSS level is
 * refused with `LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED`, and a member of staff
 * who tries to price the seller's L1 with `LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED`.
 *
 * The seller is always taken from the session by the caller; there is no
 * seller id on any seller route, so another seller's policy cannot even be
 * named.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import {
  checkEnteredPrice,
  carrierProblem,
  levelPricingStatus,
  levelSequence,
  LOGISTICS_LEVELS,
  ownersForMode,
  ownershipChanged,
  policyShapeProblem,
  providerConnectionState,
  rateIsComplete,
  transportModesForLevel,
  type LevelCarrier,
  type LevelOwners,
  type LogisticsControlMode,
  type LogisticsControlOwner,
  type LogisticsLevel,
  type LogisticsTransportMode,
  type PackageClass,
  type PolicyShapeProblem,
  type ProviderConnectionState,
} from '../../domain/logistics-levels.js';
import { carrierSetupStatus } from '../../domain/seller-fulfilment.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound, type AppError } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { recordSellerAudit } from '../seller/audit.service.js';
import { notifySeller, resolveSellerNotifications } from '../seller/notification.service.js';
import {
  AdminNotificationKind,
  ResolutionKey,
  createAdminNotification,
  resolveAdminNotifications,
} from '../notifications/admin-notification.service.js';
import { Permission } from '../../domain/permissions.js';
import { assertSellableCurrency, currencyForCountry, getBaseCurrency } from '../settings/currency.service.js';

type Tx = Prisma.TransactionClient;

// --- Who is editing --------------------------------------------------------

export interface SellerLogisticsEditor {
  kind: 'SELLER';
  sellerAccountId: string;
  userId: string | null;
  label: string;
  correlationId?: string | null;
}

export interface UbossLogisticsEditor {
  kind: 'UBOSS';
  userId: string | null;
  email: string | null;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export type LogisticsEditor = SellerLogisticsEditor | UbossLogisticsEditor;

function editorOwner(editor: LogisticsEditor): LogisticsControlOwner {
  return editor.kind === 'SELLER' ? 'SELLER' : 'UBOSS';
}

// --- Views -----------------------------------------------------------------

export type ManagedProvider = 'DHL' | 'FEDEX' | 'INDIA_POST' | 'MANUAL';
export const MANAGED_PROVIDERS: readonly ManagedProvider[] = ['DHL', 'FEDEX', 'INDIA_POST', 'MANUAL'];

export interface ProviderView {
  provider: ManagedProvider;
  enabled: boolean;
  requestedMode: 'MANUAL_ONLY' | 'API' | null;
  connectionState: ProviderConnectionState;
  /** Whether this carrier offers an API this software can call at all. */
  hasVerifiedApi: boolean;
  transportModes: readonly LogisticsTransportMode[];
}

export interface RateView {
  id: string;
  level: LogisticsLevel;
  owner: LogisticsControlOwner;
  status: string;
  versionNumber: number;
  supersedesRateId: string | null;
  originLocationId: string | null;
  originLocationName: string | null;
  originPortCode: string | null;
  destinationPortCode: string | null;
  destinationHubCode: string | null;
  destinationHubName: string | null;
  destinationCountry: string | null;
  destinationPostalPrefix: string;
  packageClass: string | null;
  minWeightGrams: number | null;
  maxWeightGrams: number | null;
  isWorldwideFlat: boolean;
  transportMode: LogisticsTransportMode;
  provider: string | null;
  logisticsPartnerId: string | null;
  logisticsPartnerName: string | null;
  providerLabel: string | null;
  serviceName: string | null;
  trackingReferenceKind: string | null;
  requiresCustomsRelease: boolean;
  transitDaysMin: number | null;
  transitDaysMax: number | null;
  /** Null when nobody has priced it. Never "0" unless `isFree`. */
  price: ReturnType<typeof serialiseMoney> | null;
  currency: string;
  isFree: boolean;
  taxInclusive: boolean;
  priceSource: string;
  effectiveFrom: string;
  isComplete: boolean;
  updatedBy: { role: LogisticsControlOwner; label: string | null };
  updatedAt: string;
  publishedAt: string | null;
}

export interface LevelView {
  level: LogisticsLevel;
  sequence: number;
  /** Who controls it in the draft being edited. */
  owner: LogisticsControlOwner;
  /** Who controls it in the version in force, or null before the first publish. */
  activeOwner: LogisticsControlOwner | null;
  /** True when the SELLER may edit this level's prices right now. */
  editableBySeller: boolean;
  pricingStatus: ReturnType<typeof levelPricingStatus>;
  transportModes: readonly LogisticsTransportMode[];
  rates: RateView[];
  warnings: string[];
}

export interface PolicyView {
  sellerAccountId: string;
  sellerName: string;
  settlementCurrency: string;
  draft: {
    mode: LogisticsControlMode;
    owners: LevelOwners;
    version: number;
    updatedAt: string | null;
  };
  active: {
    versionId: string;
    versionNumber: number;
    mode: LogisticsControlMode;
    owners: LevelOwners;
    publishedAt: string;
  } | null;
  hasUnpublishedChanges: boolean;
  levels: LevelView[];
  providers: ProviderView[];
  /** True when every level in force has at least one published price. */
  routesCanBeOffered: boolean;
  locations: { id: string; name: string; code: string; countryCode: string }[];
}

// --- Reading ---------------------------------------------------------------

async function ensurePolicy(sellerAccountId: string, client: Tx | typeof prisma = prisma) {
  const existing = await client.sellerLogisticsPolicy.findUnique({
    where: { sellerAccountId },
    include: { activeVersion: true },
  });
  if (existing !== null) return existing;

  try {
    return await client.sellerLogisticsPolicy.create({
      data: { id: newId(), sellerAccountId },
      include: { activeVersion: true },
    });
  } catch {
    // Two first visits in the same second; the other one made it.
    return client.sellerLogisticsPolicy.findUniqueOrThrow({
      where: { sellerAccountId },
      include: { activeVersion: true },
    });
  }
}

function ownersOf(row: {
  mode: LogisticsControlMode;
  l2Owner: LogisticsControlOwner;
  l3Owner: LogisticsControlOwner;
  l4Owner: LogisticsControlOwner;
}): LevelOwners {
  return ownersForMode(row.mode, row);
}

/** The currency a seller's prices default to: their country's, else the base. */
export async function settlementCurrencyFor(sellerAccountId: string): Promise<string> {
  const seller = await prisma.sellerAccount.findUnique({
    where: { id: sellerAccountId },
    select: { registrationCountry: true },
  });
  const byCountry = seller === null ? null : await currencyForCountry(seller.registrationCountry);
  return byCountry ?? (await getBaseCurrency());
}

export async function readPolicy(
  sellerAccountId: string,
  viewer: 'SELLER' | 'UBOSS',
): Promise<PolicyView> {
  const seller = await prisma.sellerAccount.findUnique({
    where: { id: sellerAccountId },
    select: { id: true, displayName: true },
  });
  if (seller === null) throw notFound('Seller');

  const policy = await ensurePolicy(sellerAccountId);
  const draftOwners = ownersOf(policy);
  const activeOwners = policy.activeVersion === null ? null : ownersOf(policy.activeVersion);

  const [rates, providers, locations, settlementCurrency] = await Promise.all([
    prisma.logisticsLevelRate.findMany({
      where: { sellerAccountId, status: { in: ['DRAFT', 'PUBLISHED', 'INACTIVE'] } },
      orderBy: [{ level: 'asc' }, { createdAt: 'asc' }],
      include: {
        originLocation: { select: { name: true } },
        logisticsPartner: { select: { displayName: true } },
      },
    }),
    listProviders(sellerAccountId),
    prisma.sellerLocation.findMany({
      where: { sellerAccountId, archivedAt: null },
      select: { id: true, name: true, code: true, countryCode: true },
      orderBy: { name: 'asc' },
    }),
    settlementCurrencyFor(sellerAccountId),
  ]);

  const authorIds = [...new Set(rates.map((rate) => rate.updatedByUserId).filter((id): id is string => id !== null))];
  const authors =
    authorIds.length === 0
      ? []
      : await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, email: true } });
  const emailById = new Map(authors.map((author) => [author.id, author.email]));

  const enabledProviders = new Set(providers.filter((p) => p.enabled).map((p) => p.provider));

  const levels: LevelView[] = LOGISTICS_LEVELS.map((level) => {
    const owner = draftOwners[level];
    const inForce = activeOwners?.[level] ?? owner;
    // A level's prices, as seen from the owner who counts: the draft's for
    // editing, and a price row by the other owner is shown only to UBOSS.
    const levelRates = rates.filter(
      (rate) => rate.level === level && (viewer === 'UBOSS' || rate.owner === owner || rate.owner === inForce),
    );
    const mine = levelRates.filter((rate) => rate.owner === owner);

    const views = levelRates.map((rate) =>
      toRateView(rate, {
        viewer,
        authorLabel:
          rate.owner === 'UBOSS' && viewer === 'SELLER'
            ? 'UBOSS'
            : (emailById.get(rate.updatedByUserId ?? '') ?? null),
      }),
    );

    const warnings: string[] = [];
    const published = mine.filter((rate) => rate.status === 'PUBLISHED');
    if (published.length === 0) {
      warnings.push(owner === 'UBOSS' ? 'PENDING_UBOSS_PRICE' : 'PRICE_REQUIRED');
    }
    if (owner === 'SELLER') {
      for (const rate of mine) {
        if (rate.provider !== null && !enabledProviders.has(rate.provider as ManagedProvider)) {
          warnings.push('PROVIDER_NOT_ENABLED');
          break;
        }
      }
    }
    if (mine.some((rate) => rate.status === 'PUBLISHED' && rate.destinationCountry === null && !rate.isWorldwideFlat && level !== 'L1')) {
      warnings.push('NO_DESTINATION_SCOPE');
    }

    return {
      level,
      sequence: levelSequence(level),
      owner,
      activeOwner: activeOwners?.[level] ?? null,
      editableBySeller: owner === 'SELLER',
      pricingStatus: levelPricingStatus({
        owner,
        publishedCount: published.length,
        draftCount: mine.filter((rate) => rate.status === 'DRAFT').length,
        readyDraftCount: mine.filter((rate) => rate.status === 'DRAFT' && rateIsComplete(rate)).length,
        inactiveCount: mine.filter((rate) => rate.status === 'INACTIVE').length,
      }),
      transportModes: transportModesForLevel(level),
      rates: views,
      warnings,
    };
  });

  const hasUnpublishedChanges =
    policy.activeVersion === null ||
    policy.activeVersion.mode !== policy.mode ||
    (activeOwners !== null && ownershipChanged(activeOwners, draftOwners));

  const routesCanBeOffered =
    activeOwners !== null &&
    LOGISTICS_LEVELS.every((level) =>
      rates.some(
        (rate) => rate.level === level && rate.owner === activeOwners[level] && rate.status === 'PUBLISHED',
      ),
    );

  return {
    sellerAccountId,
    sellerName: seller.displayName,
    settlementCurrency,
    draft: {
      mode: policy.mode,
      owners: draftOwners,
      version: policy.version,
      updatedAt: policy.updatedAt.toISOString(),
    },
    active:
      policy.activeVersion === null || activeOwners === null
        ? null
        : {
            versionId: policy.activeVersion.id,
            versionNumber: policy.activeVersion.versionNumber,
            mode: policy.activeVersion.mode,
            owners: activeOwners,
            publishedAt: policy.activeVersion.publishedAt.toISOString(),
          },
    hasUnpublishedChanges,
    levels,
    providers,
    routesCanBeOffered,
    locations,
  };
}

type RateRow = Prisma.LogisticsLevelRateGetPayload<{
  include: {
    originLocation: { select: { name: true } };
    logisticsPartner: { select: { displayName: true } };
  };
}>;

function toRateView(rate: RateRow, context: { viewer: 'SELLER' | 'UBOSS'; authorLabel: string | null }): RateView {
  return {
    id: rate.id,
    level: rate.level,
    owner: rate.owner,
    status: rate.status,
    versionNumber: rate.versionNumber,
    supersedesRateId: rate.supersedesRateId,
    originLocationId: rate.originLocationId,
    originLocationName: rate.originLocation?.name ?? null,
    originPortCode: rate.originPortCode,
    destinationPortCode: rate.destinationPortCode,
    destinationHubCode: rate.destinationHubCode,
    destinationHubName: rate.destinationHubName,
    destinationCountry: rate.destinationCountry,
    destinationPostalPrefix: rate.destinationPostalPrefix,
    packageClass: rate.packageClass,
    minWeightGrams: rate.minWeightGrams,
    maxWeightGrams: rate.maxWeightGrams,
    isWorldwideFlat: rate.isWorldwideFlat,
    transportMode: rate.transportMode,
    provider: rate.provider,
    logisticsPartnerId: rate.logisticsPartnerId,
    logisticsPartnerName: rate.logisticsPartner?.displayName ?? null,
    providerLabel: rate.providerLabel,
    serviceName: rate.serviceName,
    trackingReferenceKind: rate.trackingReferenceKind,
    requiresCustomsRelease: rate.requiresCustomsRelease,
    transitDaysMin: rate.transitDaysMin,
    transitDaysMax: rate.transitDaysMax,
    price: rate.amountMinor === null ? null : serialiseMoney(rate.amountMinor, rate.currency),
    currency: rate.currency,
    isFree: rate.isFree,
    taxInclusive: rate.taxInclusive,
    priceSource: rate.priceSource,
    effectiveFrom: rate.effectiveFrom.toISOString(),
    isComplete: rateIsComplete(rate),
    updatedBy: { role: rate.owner, label: context.authorLabel },
    updatedAt: rate.updatedAt.toISOString(),
    publishedAt: rate.publishedAt?.toISOString() ?? null,
  };
}

// --- Providers -------------------------------------------------------------

export async function listProviders(sellerAccountId: string): Promise<ProviderView[]> {
  const [settings, connections] = await Promise.all([
    prisma.sellerLogisticsProvider.findMany({ where: { sellerAccountId } }),
    prisma.sellerCarrierConnection.findMany({
      where: { sellerAccountId, provider: { in: ['DHL', 'FEDEX', 'INDIA_POST'] } },
      select: {
        provider: true,
        state: true,
        lastTestAt: true,
        lastTestPassedAt: true,
        environment: true,
        credential: { select: { id: true } },
      },
    }),
  ]);

  return MANAGED_PROVIDERS.map((provider) => {
    const setting = settings.find((row) => row.provider === provider) ?? null;
    const enabled = setting !== null && setting.enabledAt !== null && setting.disabledAt === null;
    // Production before sandbox: the account a real parcel would go on.
    const connection =
      connections.find((row) => row.provider === provider && row.environment === 'PRODUCTION') ??
      connections.find((row) => row.provider === provider) ??
      null;

    const setupStatus =
      provider === 'MANUAL'
        ? null
        : carrierSetupStatus({
            provider,
            connection:
              connection === null
                ? null
                : {
                    state: connection.state,
                    hasCredential: connection.credential !== null,
                    lastTestAt: connection.lastTestAt,
                    lastTestPassedAt: connection.lastTestPassedAt,
                  },
          });

    return {
      provider,
      enabled,
      requestedMode: setting?.connectionMode ?? null,
      connectionState: providerConnectionState({
        setupStatus,
        enabled,
        requestedMode: setting?.connectionMode ?? null,
      }),
      hasVerifiedApi: provider === 'DHL' || provider === 'FEDEX',
      transportModes: provider === 'MANUAL' ? ['ROAD', 'AIR', 'SEA', 'RAIL', 'POSTAL'] : carrierModesFor(provider),
    };
  });
}

function carrierModesFor(provider: 'DHL' | 'FEDEX' | 'INDIA_POST'): LogisticsTransportMode[] {
  return provider === 'INDIA_POST' ? ['POSTAL'] : ['ROAD', 'AIR'];
}

/**
 * Switch a carrier on or off for the seller's own levels.
 *
 * Never a connection, and never a claim that one exists. MANUAL_ONLY means
 * "I will book this carrier on its own site and type the tracking number in";
 * API means "I intend to connect an account", which is then done - and only
 * ever shown as connected - through the carrier setup screens.
 */
export async function setProvider(input: {
  editor: SellerLogisticsEditor;
  provider: ManagedProvider;
  enabled: boolean;
  connectionMode: 'MANUAL_ONLY' | 'API';
}): Promise<ProviderView> {
  const { editor } = input;
  // India Post and a hand-booked forwarder have nothing to connect to.
  const connectionMode =
    input.provider === 'INDIA_POST' || input.provider === 'MANUAL' ? 'MANUAL_ONLY' : input.connectionMode;
  const now = new Date();

  const before = await prisma.sellerLogisticsProvider.findUnique({
    where: { sellerAccountId_provider: { sellerAccountId: editor.sellerAccountId, provider: input.provider } },
  });

  await prisma.sellerLogisticsProvider.upsert({
    where: { sellerAccountId_provider: { sellerAccountId: editor.sellerAccountId, provider: input.provider } },
    create: {
      id: newId(),
      sellerAccountId: editor.sellerAccountId,
      provider: input.provider,
      connectionMode,
      enabledAt: input.enabled ? now : null,
      disabledAt: input.enabled ? null : now,
      updatedByUserId: editor.userId,
    },
    update: {
      connectionMode,
      enabledAt: input.enabled ? (before?.enabledAt ?? now) : before?.enabledAt ?? null,
      disabledAt: input.enabled ? null : now,
      updatedByUserId: editor.userId,
    },
  });

  await recordSellerAudit({
    sellerAccountId: editor.sellerAccountId,
    action: AuditAction.LOGISTICS_PROVIDER_CHANGED,
    actor: { type: 'CUSTOMER', userId: editor.userId, label: editor.label },
    resourceType: 'seller_logistics_provider',
    resourceId: input.provider,
    before: before === null ? null : { enabled: before.disabledAt === null && before.enabledAt !== null, connectionMode: before.connectionMode },
    after: { enabled: input.enabled, connectionMode },
    summary: `${input.provider} ${input.enabled ? 'switched on' : 'switched off'} (${connectionMode === 'MANUAL_ONLY' ? 'booked by hand' : 'API account'}).`,
    correlationId: editor.correlationId ?? null,
  });

  const views = await listProviders(editor.sellerAccountId);
  const view = views.find((row) => row.provider === input.provider);
  if (view === undefined) throw notFound('Carrier');
  return view;
}

// --- The policy --------------------------------------------------------------

function shapeError(problem: PolicyShapeProblem): AppError {
  switch (problem) {
    case 'L1_OWNER_FIXED':
      return badRequest(
        ErrorCode.LOGISTICS_L1_OWNER_FIXED,
        'L1, the first mile, is always managed by the seller.',
        [{ field: 'l1Owner', code: 'L1_OWNER_FIXED' }],
      );
    case 'HYBRID_ALL_SELLER':
      return badRequest(
        ErrorCode.LOGISTICS_HYBRID_ALL_SELLER,
        'In Self + UBOSS at least one of L2, L3 and L4 must be managed by UBOSS. To manage all of them yourself, use the Self tab.',
        [{ field: 'l4Owner', code: 'HYBRID_ALL_SELLER' }],
      );
    case 'MODE_OWNERS_MISMATCH':
      return badRequest(
        ErrorCode.LOGISTICS_MODE_OWNERS_MISMATCH,
        'Those owners do not match the chosen mode.',
        [{ field: 'mode', code: 'MODE_OWNERS_MISMATCH' }],
      );
  }
}

export interface PolicyDraftInput {
  mode: LogisticsControlMode;
  l1Owner?: LogisticsControlOwner;
  l2Owner?: LogisticsControlOwner;
  l3Owner?: LogisticsControlOwner;
  l4Owner?: LogisticsControlOwner;
  /** The draft version the editor read. A stale one is refused. */
  expectedVersion?: number;
  /** Required when the change moves a published level to a different owner. */
  confirmOwnershipChange?: boolean;
}

/** The owners a request means, with SELF and UBOSS filling in their own. */
function requestedOwners(input: PolicyDraftInput): LevelOwners {
  // Self and UBOSS decide L2-L4 themselves, so a request may leave them out;
  // one that sends them must send the owners that mode means. The mixed mode
  // defaults an omitted level to UBOSS - the conservative reading.
  const implied = ownersForMode(input.mode, {
    l2Owner: input.l2Owner ?? 'UBOSS',
    l3Owner: input.l3Owner ?? 'UBOSS',
    l4Owner: input.l4Owner ?? 'UBOSS',
  });

  const problem = policyShapeProblem({
    mode: input.mode,
    ...(input.l1Owner === undefined ? {} : { l1Owner: input.l1Owner }),
    l2Owner: input.l2Owner ?? implied.L2,
    l3Owner: input.l3Owner ?? implied.L3,
    l4Owner: input.l4Owner ?? implied.L4,
  });
  if (problem !== null) throw shapeError(problem);

  return implied;
}

/**
 * Save the draft. Changes nothing a buyer sees until it is published.
 *
 * A change of mode or of a level's owner against a PUBLISHED policy needs
 * `confirmOwnershipChange`, so the screen's "are you sure?" is also the API's.
 */
export async function savePolicyDraft(
  editor: SellerLogisticsEditor,
  input: PolicyDraftInput,
): Promise<PolicyView> {
  const owners = requestedOwners(input);
  const policy = await ensurePolicy(editor.sellerAccountId);

  if (input.expectedVersion !== undefined && input.expectedVersion !== policy.version) {
    throw conflict(
      ErrorCode.LOGISTICS_POLICY_VERSION_CONFLICT,
      'Your logistics policy was changed somewhere else. Reload it and try again.',
      [{ field: 'expectedVersion', code: 'STALE', meta: { current: policy.version } }],
    );
  }

  const active = policy.activeVersion === null ? null : ownersOf(policy.activeVersion);
  const changesPublished =
    policy.activeVersion !== null &&
    active !== null &&
    (policy.activeVersion.mode !== input.mode || ownershipChanged(active, owners));

  if (changesPublished && input.confirmOwnershipChange !== true) {
    throw conflict(
      ErrorCode.LOGISTICS_CHANGE_NOT_CONFIRMED,
      'This changes who manages a published delivery level. Confirm the change to continue. Orders already placed keep their original arrangement.',
      [{ field: 'confirmOwnershipChange', code: 'CONFIRMATION_REQUIRED' }],
    );
  }

  const before = { mode: policy.mode, l2Owner: policy.l2Owner, l3Owner: policy.l3Owner, l4Owner: policy.l4Owner };
  const after = { mode: input.mode, l2Owner: owners.L2, l3Owner: owners.L3, l4Owner: owners.L4 };

  const updated = await prisma.sellerLogisticsPolicy.updateMany({
    where: { id: policy.id, version: policy.version },
    data: { ...after, version: { increment: 1 }, updatedByUserId: editor.userId },
  });
  if (updated.count === 0) {
    throw conflict(
      ErrorCode.LOGISTICS_POLICY_VERSION_CONFLICT,
      'Your logistics policy was changed somewhere else. Reload it and try again.',
    );
  }

  await recordSellerAudit({
    sellerAccountId: editor.sellerAccountId,
    action: AuditAction.LOGISTICS_POLICY_SAVED,
    actor: { type: 'CUSTOMER', userId: editor.userId, label: editor.label },
    resourceType: 'seller_logistics_policy',
    resourceId: policy.id,
    before,
    after,
    summary: `Logistics policy draft saved: ${describeMode(after.mode, owners)}.`,
    correlationId: editor.correlationId ?? null,
  });

  await notifySeller({
    sellerAccountId: editor.sellerAccountId,
    kind: 'LOGISTICS_POLICY_UPDATE',
    title: 'Logistics policy saved',
    body: `Draft saved: ${describeMode(after.mode, owners)}. Publish it to use it for new orders.`,
    linkPath: '/seller/logistics',
    severity: 'INFO',
    subjectType: 'seller_logistics_policy',
    subjectId: policy.id,
    dedupeKey: `logistics-policy-saved:${policy.id}:${String(policy.version + 1)}`,
  });

  return readPolicy(editor.sellerAccountId, 'SELLER');
}

function describeMode(mode: LogisticsControlMode, owners: LevelOwners): string {
  const who = (owner: LogisticsControlOwner): string => (owner === 'SELLER' ? 'you' : 'UBOSS');
  if (mode === 'SELF') return 'you manage L1 to L4';
  if (mode === 'UBOSS') return 'you manage L1, UBOSS manages L2 to L4';
  return `you manage L1; L2 ${who(owners.L2)}, L3 ${who(owners.L3)}, L4 ${who(owners.L4)}`;
}

/**
 * Publish the draft as the policy in force for NEW carts and orders.
 *
 * A new immutable version, and the pointer moves to it in the same
 * transaction; the previous version is marked superseded and kept, because
 * every order placed under it names it.
 */
export async function publishPolicy(
  editor: SellerLogisticsEditor,
  input: { confirmOwnershipChange?: boolean; changeNote?: string | null },
): Promise<PolicyView> {
  const policy = await ensurePolicy(editor.sellerAccountId);
  const owners = ownersOf(policy);

  const problem = policyShapeProblem({
    mode: policy.mode,
    l2Owner: policy.l2Owner,
    l3Owner: policy.l3Owner,
    l4Owner: policy.l4Owner,
  });
  if (problem !== null) throw shapeError(problem);

  const active = policy.activeVersion === null ? null : ownersOf(policy.activeVersion);
  const changesOwners =
    policy.activeVersion !== null &&
    active !== null &&
    (policy.activeVersion.mode !== policy.mode || ownershipChanged(active, owners));

  if (policy.activeVersion !== null && !changesOwners) {
    // Nothing to publish: the draft is the version in force. An answer, not
    // an error - a double click must not mint a second identical version.
    return readPolicy(editor.sellerAccountId, 'SELLER');
  }

  if (changesOwners && input.confirmOwnershipChange !== true) {
    throw conflict(
      ErrorCode.LOGISTICS_CHANGE_NOT_CONFIRMED,
      'Publishing changes who manages a delivery level. Confirm the change to continue. Orders already placed keep their original arrangement.',
      [{ field: 'confirmOwnershipChange', code: 'CONFIRMATION_REQUIRED' }],
    );
  }

  const version = await prisma.$transaction(async (tx) => {
    const latest = await tx.sellerLogisticsPolicyVersion.findFirst({
      where: { policyId: policy.id },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });

    const created = await tx.sellerLogisticsPolicyVersion.create({
      data: {
        id: newId(),
        policyId: policy.id,
        sellerAccountId: editor.sellerAccountId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        mode: policy.mode,
        l2Owner: owners.L2,
        l3Owner: owners.L3,
        l4Owner: owners.L4,
        changeNote: input.changeNote ?? null,
        publishedByUserId: editor.userId,
      },
    });

    if (policy.activeVersionId !== null) {
      await tx.sellerLogisticsPolicyVersion.update({
        where: { id: policy.activeVersionId },
        data: { supersededAt: new Date() },
      });
    }

    const moved = await tx.sellerLogisticsPolicy.updateMany({
      where: { id: policy.id, version: policy.version },
      data: { activeVersionId: created.id, version: { increment: 1 }, updatedByUserId: editor.userId },
    });
    if (moved.count === 0) {
      throw conflict(
        ErrorCode.LOGISTICS_POLICY_VERSION_CONFLICT,
        'Your logistics policy was changed somewhere else. Reload it and try again.',
      );
    }

    await recordSellerAudit({
      sellerAccountId: editor.sellerAccountId,
      action: AuditAction.LOGISTICS_POLICY_PUBLISHED,
      actor: { type: 'CUSTOMER', userId: editor.userId, label: editor.label },
      resourceType: 'seller_logistics_policy_version',
      resourceId: created.id,
      before: active === null ? null : { mode: policy.activeVersion?.mode, owners: active },
      after: { mode: policy.mode, owners, versionNumber: created.versionNumber },
      summary: `Logistics policy version ${String(created.versionNumber)} published: ${describeMode(policy.mode, owners)}.`,
      correlationId: editor.correlationId ?? null,
      tx,
    });

    return created;
  });

  await notifySeller({
    sellerAccountId: editor.sellerAccountId,
    kind: 'LOGISTICS_POLICY_UPDATE',
    title: `Logistics policy version ${String(version.versionNumber)} published`,
    body: `New orders now use it: ${describeMode(policy.mode, owners)}. Orders already placed keep their original arrangement.`,
    linkPath: '/seller/logistics',
    severity: 'SUCCESS',
    subjectType: 'seller_logistics_policy_version',
    subjectId: version.id,
    dedupeKey: `logistics-policy-published:${version.id}`,
  });

  await raiseMissingPriceAlerts(editor.sellerAccountId);

  return readPolicy(editor.sellerAccountId, 'SELLER');
}

/**
 * Tell whoever controls a level that has no published price that it has none.
 *
 * The seller about their own levels, UBOSS about its levels - each an ALERT
 * that closes itself when a price is published there. Raised after a publish
 * and after a price is switched off, which are the two moments a gap appears.
 */
export async function raiseMissingPriceAlerts(sellerAccountId: string): Promise<void> {
  const policy = await prisma.sellerLogisticsPolicy.findUnique({
    where: { sellerAccountId },
    include: { activeVersion: true, sellerAccount: { select: { displayName: true } } },
  });
  if (policy === null || policy.activeVersion === null) return;
  const owners = ownersOf(policy.activeVersion);

  const published = await prisma.logisticsLevelRate.findMany({
    where: { sellerAccountId, status: 'PUBLISHED' },
    select: { level: true, owner: true },
  });

  for (const level of LOGISTICS_LEVELS) {
    const owner = owners[level];
    const has = published.some((rate) => rate.level === level && rate.owner === owner);
    const key = ResolutionKey.levelPrice(sellerAccountId, level);

    if (has) continue;

    if (owner === 'SELLER') {
      await notifySeller({
        sellerAccountId,
        kind: 'LOGISTICS_PRICE_REQUIRED',
        title: `${level} needs a delivery price`,
        body: 'Complete delivery pricing before this route can be offered to customers.',
        linkPath: '/seller/logistics',
        severity: 'WARNING',
        subjectType: 'logistics_level',
        subjectId: level,
        class: 'ALERT',
        resolutionKey: key,
        dedupeKey: `${key}:${policy.activeVersion.id}`,
      });
    } else {
      await createAdminNotification({
        kind: AdminNotificationKind.LOGISTICS_LEVEL_PRICE_REQUIRED,
        variables: { sellerName: policy.sellerAccount.displayName, level },
        linkPath: `/logistics/managed-levels?seller=${sellerAccountId}`,
        requiredPermission: Permission.LOGISTICS_READ,
        relatedType: 'seller_account',
        relatedId: sellerAccountId,
        dedupeKey: `${key}:${policy.activeVersion.id}`,
        resolutionKey: key,
      });
    }
  }
}

async function resolveMissingPriceAlert(sellerAccountId: string, level: LogisticsLevel, owner: LogisticsControlOwner, userId: string | null): Promise<void> {
  const key = ResolutionKey.levelPrice(sellerAccountId, level);
  if (owner === 'SELLER') {
    await resolveSellerNotifications({ resolutionKey: key, source: 'DOMAIN_EVENT', note: 'A price was published.' });
  } else {
    await resolveAdminNotifications({
      resolutionKey: key,
      reason: 'A price was published for the level.',
      source: 'DOMAIN_EVENT',
      resolvedByUserId: userId,
    });
  }
}

// --- Level prices ------------------------------------------------------------

export interface RateInput {
  level: LogisticsLevel;
  originLocationId?: string | null;
  originPortCode?: string | null;
  destinationPortCode?: string | null;
  destinationHubCode?: string | null;
  destinationHubName?: string | null;
  destinationCountry?: string | null;
  destinationPostalPrefix?: string | null;
  packageClass?: PackageClass | null;
  minWeightGrams?: number | null;
  maxWeightGrams?: number | null;
  isWorldwideFlat?: boolean;
  transportMode: LogisticsTransportMode;
  provider?: ManagedProvider | null;
  logisticsPartnerId?: string | null;
  providerLabel?: string | null;
  serviceName?: string | null;
  trackingReferenceKind?: 'AWB' | 'BOL' | 'CONTAINER' | 'TRACKING' | null;
  requiresCustomsRelease?: boolean;
  transitDaysMin?: number | null;
  transitDaysMax?: number | null;
  /** Minor units as a string. Empty or null = not priced yet, never zero. */
  amountMinor?: string | null;
  currency?: string | null;
  isFree?: boolean;
  confirmFree?: boolean;
  taxInclusive?: boolean;
  priceSource?: 'MANUAL' | 'PROVIDER_QUOTE' | 'UBOSS_RATE' | 'RATE_CARD';
  effectiveFrom?: Date | null;
}

/**
 * The level must currently be the editor's to price.
 *
 * Read against the DRAFT, so a seller who has just ticked "I will manage this
 * level" can prepare its price before publishing - the price counts for a
 * buyer only once the published policy gives them the level. A UBOSS editor is
 * judged against the draft AND the version in force: UBOSS may price a level
 * that either gives it, so a seller moving L3 to UBOSS can have the price
 * waiting on the day the change goes live.
 */
async function assertEditorControlsLevel(
  editor: LogisticsEditor,
  sellerAccountId: string,
  level: LogisticsLevel,
): Promise<void> {
  if (editor.kind === 'SELLER' && editor.sellerAccountId !== sellerAccountId) {
    // Unreachable through the routes, which take the seller from the session.
    throw forbidden();
  }

  const policy = await ensurePolicy(sellerAccountId);
  const draft = ownersOf(policy);
  const active = policy.activeVersion === null ? null : ownersOf(policy.activeVersion);

  if (editor.kind === 'SELLER') {
    if (draft[level] !== 'SELLER') {
      throw forbidden(
        ErrorCode.LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED,
        `${level} is managed by UBOSS. Its carrier and price are set by UBOSS.`,
      );
    }
    return;
  }

  if (level === 'L1' || (draft[level] !== 'UBOSS' && active?.[level] !== 'UBOSS')) {
    throw forbidden(
      ErrorCode.LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED,
      `${level} is managed by the seller. Only the seller can set its carrier and price.`,
    );
  }
}

const PORT_CODE = /^[A-Z]{3}$|^[A-Z]{2}[A-Z0-9]{3}$/;

function normalisedCode(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const code = value.trim().toUpperCase();
  if (!PORT_CODE.test(code)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Use a three-letter airport code or a five-character UN/LOCODE.', [
      { field, code: 'PORT_CODE' },
    ]);
  }
  return code;
}

async function validateRate(
  editor: LogisticsEditor,
  sellerAccountId: string,
  input: RateInput,
): Promise<Omit<Prisma.LogisticsLevelRateUncheckedCreateInput, 'id' | 'sellerAccountId' | 'owner' | 'status' | 'versionNumber'>> {
  const provider = input.provider ?? null;
  const partnerId = input.logisticsPartnerId ?? null;

  if (provider !== null && partnerId !== null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose a carrier or a delivery company, not both.', [
      { field: 'provider', code: 'ONE_CARRIER' },
    ]);
  }

  // What the carrier can honestly do on this level.
  const carrier: LevelCarrier | null = provider ?? (partnerId === null ? null : 'PARTNER');
  const problem =
    carrier === null
      ? transportModesForLevel(input.level).includes(input.transportMode)
        ? null
        : 'MODE_NOT_ON_LEVEL'
      : carrierProblem({
          level: input.level,
          carrier,
          transportMode: input.transportMode,
          packageClass: input.packageClass ?? null,
        });
  if (problem !== null) {
    throw badRequest(
      ErrorCode.LOGISTICS_CARRIER_UNSUITABLE,
      problem === 'MODE_NOT_ON_LEVEL'
        ? `${input.level} does not move goods by ${input.transportMode.toLowerCase()}.`
        : problem === 'CARRIER_CANNOT_DO_MODE'
          ? `${carrier ?? 'That carrier'} cannot be booked by ${input.transportMode.toLowerCase()} here. For sea freight, name the forwarder instead.`
          : `${carrier ?? 'That carrier'} does not take that kind of load.`,
      [{ field: 'transportMode', code: problem }],
    );
  }

  // A seller's own level uses a carrier they have switched on. UBOSS chooses
  // its own carriers and is not bound by the seller's list.
  if (editor.kind === 'SELLER' && provider !== null) {
    const setting = await prisma.sellerLogisticsProvider.findUnique({
      where: { sellerAccountId_provider: { sellerAccountId, provider } },
    });
    if (setting === null || setting.enabledAt === null || setting.disabledAt !== null) {
      throw badRequest(
        ErrorCode.LOGISTICS_PROVIDER_NOT_ENABLED,
        `Switch ${provider === 'MANUAL' ? 'booking a forwarder by hand' : provider} on under Carriers first.`,
        [{ field: 'provider', code: 'NOT_ENABLED' }],
      );
    }
  }

  if (partnerId !== null) {
    const partner = await prisma.logisticsPartner.findUnique({
      where: { id: partnerId },
      select: { status: true, ownerSellerAccountId: true, sellerLinks: { where: { sellerAccountId }, select: { status: true } } },
    });
    const linked =
      partner !== null &&
      (partner.ownerSellerAccountId === sellerAccountId || partner.sellerLinks.some((link) => link.status === 'APPROVED'));
    if (partner === null || partner.status !== 'ACTIVE' || (editor.kind === 'SELLER' && !linked)) {
      throw badRequest(
        ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE,
        'That delivery company cannot carry this level for you.',
        [{ field: 'logisticsPartnerId', code: 'NOT_ELIGIBLE' }],
      );
    }
  }

  if (input.originLocationId !== undefined && input.originLocationId !== null) {
    const location = await prisma.sellerLocation.findFirst({
      where: { id: input.originLocationId, sellerAccountId, archivedAt: null },
      select: { id: true },
    });
    if (location === null) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'That warehouse is not one of yours.', [
        { field: 'originLocationId', code: 'NOT_FOUND' },
      ]);
    }
  }

  const price = checkEnteredPrice({
    amountMinor: input.amountMinor ?? null,
    isFree: input.isFree === true,
    freeConfirmed: input.confirmFree === true,
  });
  if (price.problem === 'FREE_NOT_CONFIRMED') {
    throw badRequest(
      ErrorCode.LOGISTICS_FREE_NOT_CONFIRMED,
      'Confirm that this level is free for the customer before saving it as free.',
      [{ field: 'confirmFree', code: 'FREE_NOT_CONFIRMED' }],
    );
  }
  if (price.problem !== null) {
    throw badRequest(
      ErrorCode.LOGISTICS_PRICE_INVALID,
      price.problem === 'ZERO_WITHOUT_FREE'
        ? 'A price of zero is only allowed when the level is marked free.'
        : 'Enter the price as a whole number of the smallest currency unit.',
      [{ field: 'amountMinor', code: price.problem }],
    );
  }

  const currency = await assertSellableCurrency(
    (input.currency ?? '').trim() === '' ? await settlementCurrencyFor(sellerAccountId) : (input.currency ?? '').trim().toUpperCase(),
  );

  const minW = input.minWeightGrams ?? null;
  const maxW = input.maxWeightGrams ?? null;
  if (minW !== null && maxW !== null && minW > maxW) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The minimum weight is above the maximum.', [
      { field: 'minWeightGrams', code: 'RANGE' },
    ]);
  }
  const tMin = input.transitDaysMin ?? null;
  const tMax = input.transitDaysMax ?? null;
  if (tMin !== null && tMax !== null && tMin > tMax) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The shortest transit time is longer than the longest.', [
      { field: 'transitDaysMin', code: 'RANGE' },
    ]);
  }

  const destinationCountry =
    input.destinationCountry === undefined || input.destinationCountry === null || input.destinationCountry.trim() === ''
      ? null
      : input.destinationCountry.trim().toUpperCase();

  return {
    level: input.level,
    originLocationId: input.level === 'L1' ? (input.originLocationId ?? null) : null,
    originPortCode: normalisedCode(input.originPortCode, 'originPortCode'),
    destinationPortCode: normalisedCode(input.destinationPortCode, 'destinationPortCode'),
    destinationHubCode: (input.destinationHubCode ?? '').trim() === '' ? null : (input.destinationHubCode ?? '').trim().toUpperCase(),
    destinationHubName: (input.destinationHubName ?? '').trim() === '' ? null : (input.destinationHubName ?? '').trim(),
    destinationCountry,
    destinationPostalPrefix: (input.destinationPostalPrefix ?? '').replace(/\s+/g, '').toUpperCase(),
    packageClass: input.packageClass ?? null,
    minWeightGrams: minW,
    maxWeightGrams: maxW,
    isWorldwideFlat: destinationCountry === null && input.isWorldwideFlat === true,
    transportMode: input.transportMode,
    provider,
    logisticsPartnerId: partnerId,
    providerLabel: (input.providerLabel ?? '').trim() === '' ? null : (input.providerLabel ?? '').trim(),
    serviceName: (input.serviceName ?? '').trim() === '' ? null : (input.serviceName ?? '').trim(),
    trackingReferenceKind: input.trackingReferenceKind ?? null,
    requiresCustomsRelease: input.level === 'L3' && input.requiresCustomsRelease === true,
    transitDaysMin: tMin,
    transitDaysMax: tMax,
    amountMinor: price.amountMinor,
    currency,
    isFree: input.isFree === true,
    freeConfirmedAt: input.isFree === true ? new Date() : null,
    taxInclusive: input.taxInclusive === true,
    priceSource: input.priceSource ?? (editor.kind === 'UBOSS' ? 'UBOSS_RATE' : 'MANUAL'),
    effectiveFrom: input.effectiveFrom ?? new Date(),
    updatedByUserId: editor.userId,
  };
}

const RATE_INCLUDE = {
  originLocation: { select: { name: true } },
  logisticsPartner: { select: { displayName: true } },
} as const;

/**
 * Save a price for a level: a new draft, or an edit to a draft.
 *
 * `rateId` naming a PUBLISHED price makes a new DRAFT version that will
 * replace it when published - a published price is never edited, because
 * orders point at it.
 */
export async function saveRate(
  editor: LogisticsEditor,
  input: RateInput & { sellerAccountId: string; rateId?: string | null },
): Promise<RateView> {
  const sellerAccountId = input.sellerAccountId;
  await assertEditorControlsLevel(editor, sellerAccountId, input.level);
  const data = await validateRate(editor, sellerAccountId, input);
  const owner = editorOwner(editor);

  let saved: RateRow;
  let before: RateRow | null = null;

  if (input.rateId !== undefined && input.rateId !== null) {
    before = await prisma.logisticsLevelRate.findFirst({
      where: { id: input.rateId, sellerAccountId, owner },
      include: RATE_INCLUDE,
    });
    if (before === null) throw notFound('Price');
    if (before.level !== input.level) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'A price cannot move to a different level.', [
        { field: 'level', code: 'IMMUTABLE' },
      ]);
    }

    if (before.status === 'DRAFT') {
      saved = await prisma.logisticsLevelRate.update({ where: { id: before.id }, data, include: RATE_INCLUDE });
    } else if (before.status === 'PUBLISHED') {
      saved = await prisma.logisticsLevelRate.create({
        data: {
          ...data,
          id: newId(),
          sellerAccountId,
          owner,
          status: 'DRAFT',
          versionNumber: before.versionNumber + 1,
          supersedesRateId: before.id,
        },
        include: RATE_INCLUDE,
      });
    } else {
      throw conflict(ErrorCode.LOGISTICS_RATE_NOT_EDITABLE, 'This price is no longer in use and cannot be changed.');
    }
  } else {
    saved = await prisma.logisticsLevelRate.create({
      data: { ...data, id: newId(), sellerAccountId, owner, status: 'DRAFT', versionNumber: 1 },
      include: RATE_INCLUDE,
    });
  }

  await auditRate(editor, sellerAccountId, AuditAction.LOGISTICS_LEVEL_RATE_SAVED, before, saved);
  return toRateView(saved, { viewer: editor.kind, authorLabel: editor.kind === 'SELLER' ? editor.label : editor.email });
}

/** Publish a draft price. Replaces the published price it supersedes, if any. */
export async function publishRate(
  editor: LogisticsEditor,
  input: { sellerAccountId: string; rateId: string },
): Promise<RateView> {
  const owner = editorOwner(editor);
  const rate = await prisma.logisticsLevelRate.findFirst({
    where: { id: input.rateId, sellerAccountId: input.sellerAccountId, owner },
    include: RATE_INCLUDE,
  });
  if (rate === null) throw notFound('Price');
  await assertEditorControlsLevel(editor, input.sellerAccountId, rate.level);

  if (rate.status === 'PUBLISHED') {
    return toRateView(rate, { viewer: editor.kind, authorLabel: null });
  }
  if (rate.status !== 'DRAFT') {
    throw conflict(ErrorCode.LOGISTICS_RATE_NOT_EDITABLE, 'This price is no longer in use and cannot be published.');
  }
  if (!rateIsComplete(rate)) {
    throw badRequest(
      ErrorCode.LOGISTICS_RATE_INCOMPLETE,
      'Enter a price (or confirm the level is free) and choose a carrier before publishing.',
      [{ field: rate.amountMinor === null ? 'amountMinor' : 'provider', code: 'REQUIRED' }],
    );
  }

  const now = new Date();
  const published = await prisma.$transaction(async (tx) => {
    if (rate.supersedesRateId !== null) {
      await tx.logisticsLevelRate.updateMany({
        where: { id: rate.supersedesRateId, status: 'PUBLISHED' },
        data: { status: 'SUPERSEDED' },
      });
    }
    return tx.logisticsLevelRate.update({
      where: { id: rate.id },
      data: { status: 'PUBLISHED', publishedAt: now, publishedByUserId: editor.userId },
      include: RATE_INCLUDE,
    });
  });

  await auditRate(editor, input.sellerAccountId, AuditAction.LOGISTICS_LEVEL_RATE_PUBLISHED, rate, published);
  await resolveMissingPriceAlert(input.sellerAccountId, rate.level, owner, editor.userId);

  if (editor.kind === 'UBOSS') {
    await notifySeller({
      sellerAccountId: input.sellerAccountId,
      kind: 'LOGISTICS_UBOSS_PRICE_PUBLISHED',
      title: `UBOSS published the ${rate.level} price`,
      body: `${rate.level} is managed by UBOSS. The new price applies to new orders only.`,
      linkPath: '/seller/logistics',
      severity: 'INFO',
      subjectType: 'logistics_level_rate',
      subjectId: published.id,
      dedupeKey: `uboss-price-published:${published.id}`,
    });
  }

  return toRateView(published, { viewer: editor.kind, authorLabel: editor.kind === 'SELLER' ? editor.label : editor.email });
}

/** Switch a price off. It stays on record; orders charged at it keep it. */
export async function deactivateRate(
  editor: LogisticsEditor,
  input: { sellerAccountId: string; rateId: string },
): Promise<RateView> {
  const owner = editorOwner(editor);
  const rate = await prisma.logisticsLevelRate.findFirst({
    where: { id: input.rateId, sellerAccountId: input.sellerAccountId, owner },
    include: RATE_INCLUDE,
  });
  if (rate === null) throw notFound('Price');
  await assertEditorControlsLevel(editor, input.sellerAccountId, rate.level);
  if (rate.status === 'INACTIVE' || rate.status === 'SUPERSEDED') {
    return toRateView(rate, { viewer: editor.kind, authorLabel: null });
  }

  const updated = await prisma.logisticsLevelRate.update({
    where: { id: rate.id },
    data: { status: 'INACTIVE', updatedByUserId: editor.userId },
    include: RATE_INCLUDE,
  });
  await auditRate(editor, input.sellerAccountId, AuditAction.LOGISTICS_LEVEL_RATE_DEACTIVATED, rate, updated);
  await raiseMissingPriceAlerts(input.sellerAccountId);
  return toRateView(updated, { viewer: editor.kind, authorLabel: null });
}

function rateAuditShape(rate: RateRow | null): Record<string, unknown> | null {
  if (rate === null) return null;
  return {
    level: rate.level,
    owner: rate.owner,
    status: rate.status,
    versionNumber: rate.versionNumber,
    route: {
      originLocationId: rate.originLocationId,
      originPortCode: rate.originPortCode,
      destinationPortCode: rate.destinationPortCode,
      destinationHubCode: rate.destinationHubCode,
      destinationCountry: rate.destinationCountry,
      destinationPostalPrefix: rate.destinationPostalPrefix,
    },
    transportMode: rate.transportMode,
    provider: rate.provider,
    logisticsPartnerId: rate.logisticsPartnerId,
    amountMinor: rate.amountMinor === null ? null : rate.amountMinor.toString(),
    currency: rate.currency,
    isFree: rate.isFree,
  };
}

async function auditRate(
  editor: LogisticsEditor,
  sellerAccountId: string,
  action: string,
  before: RateRow | null,
  after: RateRow,
): Promise<void> {
  const price = after.amountMinor === null ? 'no price yet' : serialiseMoney(after.amountMinor, after.currency).formatted;
  const summary = `${after.level} price ${action.endsWith('published') ? 'published' : action.endsWith('deactivated') ? 'switched off' : 'saved'} by ${editor.kind === 'SELLER' ? editor.label : 'UBOSS'}: ${after.isFree ? 'free' : price}.`;

  // The seller's own trail always hears about their levels - including a
  // UBOSS price on one of them, which is exactly what they will ask about.
  await recordSellerAudit({
    sellerAccountId,
    action,
    actor:
      editor.kind === 'SELLER'
        ? { type: 'CUSTOMER', userId: editor.userId, label: editor.label }
        : { type: 'ADMIN', userId: editor.userId, label: 'UBOSS logistics' },
    resourceType: 'logistics_level_rate',
    resourceId: after.id,
    before: rateAuditShape(before),
    after: rateAuditShape(after),
    summary,
    correlationId: editor.correlationId ?? null,
  });

  if (editor.kind === 'UBOSS') {
    await recordAudit({
      action: action as never,
      resourceType: 'logistics_level_rate',
      resourceId: after.id,
      actorType: 'ADMIN',
      actorUserId: editor.userId,
      actorEmail: editor.email,
      before: rateAuditShape(before),
      after: { ...rateAuditShape(after), sellerAccountId },
      ipAddress: editor.ipAddress ?? null,
      correlationId: editor.correlationId ?? null,
    });
  }
}

// --- The admin overview ------------------------------------------------------

export interface ManagedLevelRow {
  sellerAccountId: string;
  sellerName: string;
  mode: LogisticsControlMode | null;
  versionNumber: number | null;
  owners: LevelOwners | null;
  levels: { level: LogisticsLevel; owner: LogisticsControlOwner; hasPublishedPrice: boolean }[];
  missingUbossPrices: number;
  missingSellerPrices: number;
}

/**
 * Every seller's policy in force, one row each, for the admin overview.
 * `ubossOnly` keeps the sellers with at least one UBOSS-controlled level.
 */
export async function listManagedLevels(input: { ubossOnly?: boolean; missingOnly?: boolean; search?: string | null }): Promise<ManagedLevelRow[]> {
  const policies = await prisma.sellerLogisticsPolicy.findMany({
    where: {
      activeVersionId: { not: null },
      ...(input.search === undefined || input.search === null || input.search.trim() === ''
        ? {}
        : { sellerAccount: { displayName: { contains: input.search.trim() } } }),
    },
    include: { activeVersion: true, sellerAccount: { select: { displayName: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });

  const sellerIds = policies.map((policy) => policy.sellerAccountId);
  const published =
    sellerIds.length === 0
      ? []
      : await prisma.logisticsLevelRate.findMany({
          where: { sellerAccountId: { in: sellerIds }, status: 'PUBLISHED' },
          select: { sellerAccountId: true, level: true, owner: true },
        });

  const rows: ManagedLevelRow[] = [];
  for (const policy of policies) {
    if (policy.activeVersion === null) continue;
    const owners = ownersOf(policy.activeVersion);
    const levels = LOGISTICS_LEVELS.map((level) => ({
      level,
      owner: owners[level],
      hasPublishedPrice: published.some(
        (rate) => rate.sellerAccountId === policy.sellerAccountId && rate.level === level && rate.owner === owners[level],
      ),
    }));
    const missingUbossPrices = levels.filter((level) => level.owner === 'UBOSS' && !level.hasPublishedPrice).length;
    const missingSellerPrices = levels.filter((level) => level.owner === 'SELLER' && !level.hasPublishedPrice).length;

    if (input.ubossOnly === true && !levels.some((level) => level.owner === 'UBOSS')) continue;
    if (input.missingOnly === true && missingUbossPrices === 0) continue;

    rows.push({
      sellerAccountId: policy.sellerAccountId,
      sellerName: policy.sellerAccount.displayName,
      mode: policy.activeVersion.mode,
      versionNumber: policy.activeVersion.versionNumber,
      owners,
      levels,
      missingUbossPrices,
      missingSellerPrices,
    });
  }
  return rows;
}

/** The policy's audit trail, for the admin panel. */
export async function readPolicyHistory(sellerAccountId: string) {
  const [versions, audit] = await Promise.all([
    prisma.sellerLogisticsPolicyVersion.findMany({
      where: { sellerAccountId },
      orderBy: { versionNumber: 'desc' },
      take: 50,
    }),
    prisma.sellerAuditLog.findMany({
      where: {
        sellerAccountId,
        action: {
          in: [
            AuditAction.LOGISTICS_POLICY_SAVED,
            AuditAction.LOGISTICS_POLICY_PUBLISHED,
            AuditAction.LOGISTICS_PROVIDER_CHANGED,
            AuditAction.LOGISTICS_LEVEL_RATE_SAVED,
            AuditAction.LOGISTICS_LEVEL_RATE_PUBLISHED,
            AuditAction.LOGISTICS_LEVEL_RATE_DEACTIVATED,
            AuditAction.LOGISTICS_LEG_ASSIGNED,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, action: true, actorType: true, actorLabel: true, summary: true, beforeJson: true, afterJson: true, createdAt: true },
    }),
  ]);

  return {
    versions: versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      mode: version.mode,
      owners: ownersOf(version),
      publishedAt: version.publishedAt.toISOString(),
      supersededAt: version.supersededAt?.toISOString() ?? null,
      changeNote: version.changeNote,
    })),
    events: audit.map((row) => ({
      id: row.id,
      action: row.action,
      actorType: row.actorType,
      actorLabel: row.actorLabel,
      summary: row.summary,
      before: row.beforeJson,
      after: row.afterJson,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
