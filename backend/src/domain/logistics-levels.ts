/**
 * The four delivery levels, who controls each one, and what each one costs.
 *
 * A delivery from a seller's plant to a buyer is four legs:
 *
 *   L1  first mile          plant / origin warehouse  -> port or airport of loading
 *   L2  international haul  port of loading           -> destination port or airport
 *   L3  destination inland  destination port          -> destination warehouse
 *   L4  last mile           destination warehouse     -> the buyer
 *
 * Every rule about them lives in this file, as pure functions, so the Seller
 * Hub, the admin panel, checkout and the worker cannot come to different
 * answers. The database says the same things again as CHECK constraints
 * (`20260924090000_seller_logistics_levels`); this file is what turns a
 * refused request into a sentence before the database refuses it with a
 * constraint name.
 *
 * SELF, UBOSS and HYBRID say WHO is in control of a level. They are not
 * carriers. The carrier is on the level's price row.
 */
import { sumMinor, type Minor } from './money.js';

export const LOGISTICS_LEVELS = ['L1', 'L2', 'L3', 'L4'] as const;
export type LogisticsLevel = (typeof LOGISTICS_LEVELS)[number];

export type LogisticsControlMode = 'SELF' | 'UBOSS' | 'HYBRID';
export type LogisticsControlOwner = 'SELLER' | 'UBOSS';
export type LogisticsTransportMode = 'ROAD' | 'AIR' | 'SEA' | 'RAIL' | 'POSTAL';

/** The levels whose control can move. L1 is the seller's, always. */
export const SWITCHABLE_LEVELS = ['L2', 'L3', 'L4'] as const;
export type SwitchableLevel = (typeof SWITCHABLE_LEVELS)[number];

export interface LevelOwners {
  L1: 'SELLER';
  L2: LogisticsControlOwner;
  L3: LogisticsControlOwner;
  L4: LogisticsControlOwner;
}

/** 1 for L1 through 4 for L4: the order the legs are carried in. */
export function levelSequence(level: LogisticsLevel): number {
  return LOGISTICS_LEVELS.indexOf(level) + 1;
}

export function levelAt(sequence: number): LogisticsLevel | null {
  return LOGISTICS_LEVELS[sequence - 1] ?? null;
}

/**
 * Why a policy shape is refused. Each has its own error code, because each
 * sends the seller somewhere different:
 *
 *  - `L1_OWNER_FIXED` - somebody tried to hand L1 to UBOSS. Nothing to do but
 *    stop trying.
 *  - `HYBRID_ALL_SELLER` - the mixed mode with the seller on all three of
 *    L2-L4. That is the Self tab, and the answer is to use it.
 *  - `MODE_OWNERS_MISMATCH` - owners that the chosen mode does not allow,
 *    e.g. SELF with UBOSS on L3. Only reachable by a hand-made request.
 */
export type PolicyShapeProblem = 'L1_OWNER_FIXED' | 'HYBRID_ALL_SELLER' | 'MODE_OWNERS_MISMATCH';

export interface PolicyShapeInput {
  mode: LogisticsControlMode;
  /** Optional, and only ever accepted as SELLER - see `L1_OWNER_FIXED`. */
  l1Owner?: LogisticsControlOwner;
  l2Owner: LogisticsControlOwner;
  l3Owner: LogisticsControlOwner;
  l4Owner: LogisticsControlOwner;
}

export function policyShapeProblem(input: PolicyShapeInput): PolicyShapeProblem | null {
  if (input.l1Owner !== undefined && input.l1Owner !== 'SELLER') return 'L1_OWNER_FIXED';

  const owners = [input.l2Owner, input.l3Owner, input.l4Owner];

  switch (input.mode) {
    case 'SELF':
      return owners.every((owner) => owner === 'SELLER') ? null : 'MODE_OWNERS_MISMATCH';
    case 'UBOSS':
      return owners.every((owner) => owner === 'UBOSS') ? null : 'MODE_OWNERS_MISMATCH';
    case 'HYBRID':
      // The seller may take any of L2-L4, but not all three: a policy with
      // the seller on every level is Self, and letting it be saved as the
      // mixed mode would leave two tabs meaning the same thing.
      return owners.every((owner) => owner === 'SELLER') ? 'HYBRID_ALL_SELLER' : null;
  }
}

/**
 * The owners a mode implies, filling in what the mode decides by itself.
 *
 * SELF and UBOSS decide L2-L4 on their own, so whatever a caller sent for
 * them is replaced - a Self policy cannot carry a stray UBOSS level into the
 * database. HYBRID keeps what the seller chose.
 */
export function ownersForMode(
  mode: LogisticsControlMode,
  chosen: { l2Owner: LogisticsControlOwner; l3Owner: LogisticsControlOwner; l4Owner: LogisticsControlOwner },
): LevelOwners {
  if (mode === 'SELF') return { L1: 'SELLER', L2: 'SELLER', L3: 'SELLER', L4: 'SELLER' };
  if (mode === 'UBOSS') return { L1: 'SELLER', L2: 'UBOSS', L3: 'UBOSS', L4: 'UBOSS' };
  return { L1: 'SELLER', L2: chosen.l2Owner, L3: chosen.l3Owner, L4: chosen.l4Owner };
}

export function ownerOf(owners: LevelOwners, level: LogisticsLevel): LogisticsControlOwner {
  return owners[level];
}

/** Whether two policies put any level under a different owner. */
export function ownershipChanged(before: LevelOwners, after: LevelOwners): boolean {
  return SWITCHABLE_LEVELS.some((level) => before[level] !== after[level]);
}

// --- Carriers ------------------------------------------------------------

/**
 * Who a level can be carried by. `PARTNER` is a delivery company on this
 * platform - the seller's own operation, a courier contracted to them, or a
 * marketplace carrier - and `MANUAL` is a forwarder booked by hand and named
 * in free text.
 */
export type LevelCarrier = 'DHL' | 'FEDEX' | 'INDIA_POST' | 'MANUAL' | 'PARTNER';

export type PackageClass = 'PARCEL' | 'PALLET' | 'CONTAINER';

/**
 * What each carrier can honestly be asked to do.
 *
 * A claim about the carrier as this software uses it, not about the company:
 * DHL and FedEx here are their parcel and express services, reached through a
 * seller's own account or booked by hand. Neither books an ocean container
 * through anything this repository calls, so SEA is not listed for them -
 * a seller moving a container by sea names the forwarder (`MANUAL`). India
 * Post carries post, collects only in India, and takes neither pallets nor
 * containers.
 */
const CARRIER_CAPABILITY: Record<
  LevelCarrier,
  { modes: readonly LogisticsTransportMode[]; packageClasses: readonly PackageClass[] }
> = {
  DHL: { modes: ['ROAD', 'AIR'], packageClasses: ['PARCEL', 'PALLET'] },
  FEDEX: { modes: ['ROAD', 'AIR'], packageClasses: ['PARCEL', 'PALLET'] },
  INDIA_POST: { modes: ['POSTAL'], packageClasses: ['PARCEL'] },
  MANUAL: { modes: ['ROAD', 'AIR', 'SEA', 'RAIL', 'POSTAL'], packageClasses: ['PARCEL', 'PALLET', 'CONTAINER'] },
  PARTNER: { modes: ['ROAD', 'RAIL'], packageClasses: ['PARCEL', 'PALLET', 'CONTAINER'] },
};

/** The ways each level can move goods. */
const LEVEL_TRANSPORT_MODES: Record<LogisticsLevel, readonly LogisticsTransportMode[]> = {
  L1: ['ROAD', 'RAIL'],
  L2: ['AIR', 'SEA', 'ROAD', 'RAIL', 'POSTAL'],
  L3: ['ROAD', 'RAIL'],
  L4: ['ROAD', 'POSTAL'],
};

export function transportModesForLevel(level: LogisticsLevel): readonly LogisticsTransportMode[] {
  return LEVEL_TRANSPORT_MODES[level];
}

export type CarrierProblem = 'MODE_NOT_ON_LEVEL' | 'CARRIER_CANNOT_DO_MODE' | 'CARRIER_CANNOT_TAKE_PACKAGE';

/** Why this carrier cannot do this level this way, or null when it can. */
export function carrierProblem(input: {
  level: LogisticsLevel;
  carrier: LevelCarrier;
  transportMode: LogisticsTransportMode;
  packageClass: PackageClass | null;
}): CarrierProblem | null {
  if (!LEVEL_TRANSPORT_MODES[input.level].includes(input.transportMode)) return 'MODE_NOT_ON_LEVEL';

  const capability = CARRIER_CAPABILITY[input.carrier];
  if (!capability.modes.includes(input.transportMode)) return 'CARRIER_CANNOT_DO_MODE';
  if (input.packageClass !== null && !capability.packageClasses.includes(input.packageClass)) {
    return 'CARRIER_CANNOT_TAKE_PACKAGE';
  }
  return null;
}

export function carrierModes(carrier: LevelCarrier): readonly LogisticsTransportMode[] {
  return CARRIER_CAPABILITY[carrier].modes;
}

/**
 * The honest connection state of one carrier for one seller.
 *
 * Derived, never stored. `CONNECTED` is only reachable from the carrier setup
 * status `CONNECTED`, which itself needs a test that genuinely reached the
 * carrier and a person's go-live - so nothing in this file can manufacture it.
 */
export type ProviderConnectionState =
  | 'NOT_CONFIGURED'
  | 'CREDENTIALS_REQUIRED'
  | 'MANUAL_ONLY'
  | 'PENDING_VERIFICATION'
  | 'CONNECTED'
  | 'CONNECTION_FAILED';

export function providerConnectionState(input: {
  /** From `carrierSetupStatus`, or null when the seller has no account row. */
  setupStatus:
    | 'NOT_CONFIGURED'
    | 'CREDENTIALS_REQUIRED'
    | 'PENDING_VERIFICATION'
    | 'CONNECTED'
    | 'CONNECTION_FAILED'
    | 'PAUSED'
    | 'MANUAL_MODE_AVAILABLE'
    | null;
  /** Whether the seller has switched the carrier on under Logistics. */
  enabled: boolean;
  requestedMode: 'MANUAL_ONLY' | 'API' | null;
}): ProviderConnectionState {
  const status = input.setupStatus;

  if (input.enabled && input.requestedMode === 'MANUAL_ONLY') return 'MANUAL_ONLY';
  if (status === null || status === 'NOT_CONFIGURED') {
    return input.enabled ? 'MANUAL_ONLY' : 'NOT_CONFIGURED';
  }
  // India Post has nothing to connect; booking by hand is the whole offer.
  if (status === 'MANUAL_MODE_AVAILABLE') return input.enabled ? 'MANUAL_ONLY' : 'NOT_CONFIGURED';
  // A paused account is not a working one, and saying "connected" about it
  // would be the lie this function exists not to tell.
  if (status === 'PAUSED') return input.enabled ? 'MANUAL_ONLY' : 'NOT_CONFIGURED';
  return status;
}

// --- Prices --------------------------------------------------------------

/**
 * A level's pricing, as the Logistics page shows it.
 *
 *  - `PRICE_REQUIRED` - the seller controls it and has published no price.
 *  - `PENDING_UBOSS_PRICE` - UBOSS controls it and has published no price.
 *  - `DRAFT` - a price exists, unfinished.
 *  - `READY` - a finished draft, not yet published.
 *  - `PUBLISHED` - at least one live price.
 *  - `INACTIVE` - every price was switched off.
 *
 * `QUOTE_REQUIRED` is a ROUTE's state rather than a level's - see
 * `resolveRoute` - because a level can be fully priced for Rotterdam and have
 * nothing for Dubai.
 */
export type LevelPricingStatus =
  | 'DRAFT'
  | 'PRICE_REQUIRED'
  | 'QUOTE_REQUIRED'
  | 'PENDING_UBOSS_PRICE'
  | 'READY'
  | 'PUBLISHED'
  | 'INACTIVE';

export function levelPricingStatus(input: {
  owner: LogisticsControlOwner;
  publishedCount: number;
  draftCount: number;
  readyDraftCount: number;
  inactiveCount: number;
}): LevelPricingStatus {
  if (input.publishedCount > 0) return 'PUBLISHED';
  if (input.readyDraftCount > 0) return 'READY';
  if (input.draftCount > 0) return 'DRAFT';
  if (input.inactiveCount > 0) return 'INACTIVE';
  return input.owner === 'UBOSS' ? 'PENDING_UBOSS_PRICE' : 'PRICE_REQUIRED';
}

/**
 * An entered price, checked. EMPTY IS NOT ZERO.
 *
 * `null` or '' is "nobody has priced this", and stays null - it is the
 * `PRICE_REQUIRED` state, never a free level. Zero is accepted only with
 * `isFree` and an explicit confirmation, because a blank field read as zero is
 * free international freight nobody agreed to give away.
 */
export type PriceProblem = 'NOT_A_NUMBER' | 'NEGATIVE' | 'ZERO_WITHOUT_FREE' | 'FREE_NOT_CONFIRMED' | 'FREE_WITH_AMOUNT';

export function checkEnteredPrice(input: {
  amountMinor: string | null | undefined;
  isFree: boolean;
  freeConfirmed: boolean;
}): { amountMinor: bigint | null; problem: PriceProblem | null } {
  const raw = input.amountMinor === undefined || input.amountMinor === null ? '' : input.amountMinor.trim();

  if (input.isFree) {
    if (!input.freeConfirmed) return { amountMinor: null, problem: 'FREE_NOT_CONFIRMED' };
    if (raw !== '' && raw !== '0') return { amountMinor: null, problem: 'FREE_WITH_AMOUNT' };
    return { amountMinor: 0n, problem: null };
  }

  if (raw === '') return { amountMinor: null, problem: null };
  if (!/^-?\d{1,18}$/.test(raw)) return { amountMinor: null, problem: 'NOT_A_NUMBER' };

  const amount = BigInt(raw);
  if (amount < 0n) return { amountMinor: null, problem: 'NEGATIVE' };
  if (amount === 0n) return { amountMinor: null, problem: 'ZERO_WITHOUT_FREE' };
  return { amountMinor: amount, problem: null };
}

/** Whether a draft carries everything publishing it needs. */
export function rateIsComplete(rate: {
  amountMinor: bigint | null;
  isFree: boolean;
  provider: string | null;
  logisticsPartnerId: string | null;
}): boolean {
  const priced = rate.amountMinor !== null && (rate.amountMinor > 0n || rate.isFree);
  const carried = rate.provider !== null || rate.logisticsPartnerId !== null;
  return priced && carried;
}

// --- Choosing the price for a route ---------------------------------------

/** One published price, as route resolution needs it. */
export interface RouteRate {
  id: string;
  level: LogisticsLevel;
  owner: LogisticsControlOwner;
  originLocationId: string | null;
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
  amountMinor: bigint;
  currency: string;
  publishedAt: Date | null;
}

export interface RouteRequest {
  /** The seller's warehouse the goods leave from, where known. */
  originLocationId: string | null;
  destinationCountry: string;
  destinationPostcode: string | null;
  weightGrams: number | null;
  packageClass: PackageClass | null;
}

export interface ResolvedRouteLevel<R extends RouteRate> {
  level: LogisticsLevel;
  owner: LogisticsControlOwner;
  rate: R | null;
}

/**
 * The route a basket takes through the four levels, one price per level.
 *
 * Chained, because the levels are one journey: L1 ends at a port of loading,
 * and L2 is chosen among prices that START there; L2 ends at a destination
 * port and L3 starts at it; L3 ends at a warehouse and L4 starts at it. A
 * price that does not join up with the level before it is not this route.
 *
 * Only prices whose `owner` is the level's current controller count. A price
 * the seller typed for a level UBOSS now controls is kept and ignored - the
 * seller has not been given the level back by leaving an old number behind.
 *
 * ONE NUMBER FOR THE WHOLE WORLD IS NOT A DEFAULT. For L2-L4 a price with no
 * destination country matches only when its author marked it worldwide flat;
 * otherwise Mumbai-Rotterdam would silently price Mumbai-Dubai.
 *
 * The most specific match wins (exact port over any port, a postcode prefix
 * over the whole country, the longer prefix over the shorter), and among
 * equals the most recently published - deterministic, so the review screen
 * and the charge agree.
 */
export function resolveRoute<R extends RouteRate>(
  rates: readonly R[],
  owners: LevelOwners,
  request: RouteRequest,
): ResolvedRouteLevel<R>[] {
  const resolved: ResolvedRouteLevel<R>[] = [];

  let loadingPort: string | null = null;
  let destinationPort: string | null = null;
  let hub: string | null = null;

  for (const level of LOGISTICS_LEVELS) {
    const owner = owners[level];
    const candidates = rates.filter(
      (rate) =>
        rate.level === level &&
        rate.owner === owner &&
        fitsLoad(rate, request) &&
        fitsLevelScope(rate, level, request, { loadingPort, destinationPort, hub }),
    );

    const best: R | null = pickMostSpecific(candidates, level, { loadingPort, destinationPort, hub });
    resolved.push({ level, owner, rate: best });

    if (best !== null) {
      if (level === 'L1') loadingPort = best.originPortCode;
      if (level === 'L2') destinationPort = best.destinationPortCode;
      if (level === 'L3') hub = best.destinationHubCode;
    }
  }

  return resolved;
}

interface ChainPoints {
  loadingPort: string | null;
  destinationPort: string | null;
  hub: string | null;
}

function fitsLoad(rate: RouteRate, request: RouteRequest): boolean {
  if (rate.packageClass !== null && request.packageClass !== null && rate.packageClass !== request.packageClass) {
    return false;
  }
  // An unknown weight matches only an unbounded price: a weight band is a
  // promise about what fits, and a basket nobody weighed cannot be held to it.
  if (rate.minWeightGrams !== null) {
    if (request.weightGrams === null || request.weightGrams < rate.minWeightGrams) return false;
  }
  if (rate.maxWeightGrams !== null) {
    if (request.weightGrams === null || request.weightGrams > rate.maxWeightGrams) return false;
  }
  return true;
}

function fitsDestination(rate: RouteRate, request: RouteRequest): boolean {
  if (rate.destinationCountry === null) return rate.isWorldwideFlat;
  if (rate.destinationCountry !== request.destinationCountry) return false;
  if (rate.destinationPostalPrefix === '') return true;
  const postcode = normalisePostcode(request.destinationPostcode);
  return postcode !== '' && postcode.startsWith(normalisePostcode(rate.destinationPostalPrefix));
}

function fitsLevelScope(rate: RouteRate, level: LogisticsLevel, request: RouteRequest, chain: ChainPoints): boolean {
  switch (level) {
    case 'L1':
      // A price for "any of my warehouses" is fine; a price for a different
      // warehouse is not this basket's.
      return rate.originLocationId === null || rate.originLocationId === request.originLocationId;
    case 'L2':
      return joins(rate.originPortCode, chain.loadingPort) && fitsDestination(rate, request);
    case 'L3':
      return joins(rate.destinationPortCode, chain.destinationPort) && fitsDestination(rate, request);
    case 'L4':
      return joins(rate.destinationHubCode, chain.hub) && fitsDestination(rate, request);
  }
}

/** A price starts where the last level ended, or says it starts anywhere. */
function joins(start: string | null, previousEnd: string | null): boolean {
  if (start === null) return true;
  if (previousEnd === null) return true;
  return start.toUpperCase() === previousEnd.toUpperCase();
}

function specificity(rate: RouteRate, level: LogisticsLevel, chain: ChainPoints): number {
  let score = 0;
  if (level === 'L1' && rate.originLocationId !== null) score += 100;
  if (level === 'L2' && rate.originPortCode !== null && chain.loadingPort !== null) score += 100;
  if (level === 'L3' && rate.destinationPortCode !== null && chain.destinationPort !== null) score += 100;
  if (level === 'L4' && rate.destinationHubCode !== null && chain.hub !== null) score += 100;
  if (rate.destinationCountry !== null) score += 50;
  score += normalisePostcode(rate.destinationPostalPrefix).length * 5;
  if (rate.packageClass !== null) score += 3;
  if (rate.minWeightGrams !== null || rate.maxWeightGrams !== null) score += 2;
  return score;
}

/** Most specific first, then most recently published, then the later id. */
function pickMostSpecific<R extends RouteRate>(
  candidates: readonly R[],
  level: LogisticsLevel,
  chain: ChainPoints,
): R | null {
  const ranked = [...candidates].sort((a, b) => {
    const bySpecificity = specificity(b, level, chain) - specificity(a, level, chain);
    if (bySpecificity !== 0) return bySpecificity;
    const byPublished = (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
    if (byPublished !== 0) return byPublished;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return ranked[0] ?? null;
}

function normalisePostcode(value: string | null): string {
  return (value ?? '').replace(/\s+/g, '').toUpperCase();
}

/** L1 + L2 + L3 + L4, in minor units. Every level must be priced to call it. */
export function deliveryTotal(amounts: readonly Minor[]): Minor {
  return sumMinor(amounts);
}

// --- Legs ----------------------------------------------------------------

export type ShipmentLegStatus =
  | 'PENDING'
  | 'AWAITING_ASSIGNMENT'
  | 'ASSIGNED'
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';

/** Who moved a leg. The owner of the level, the partner holding it, or the system. */
export type LegActor = 'OWNER' | 'PARTNER' | 'SYSTEM';

const LEG_TRANSITIONS: Record<ShipmentLegStatus, readonly { to: ShipmentLegStatus; by: readonly LegActor[] }[]> = {
  // Its turn comes when the leg before it is handed over.
  PENDING: [
    { to: 'AWAITING_ASSIGNMENT', by: ['SYSTEM'] },
    { to: 'ASSIGNED', by: ['SYSTEM'] },
    { to: 'CANCELLED', by: ['SYSTEM'] },
  ],
  AWAITING_ASSIGNMENT: [
    { to: 'ASSIGNED', by: ['OWNER'] },
    { to: 'CANCELLED', by: ['SYSTEM'] },
  ],
  ASSIGNED: [
    { to: 'ACCEPTED', by: ['PARTNER'] },
    // A refusal, or the owner taking it back, puts it back in the queue.
    { to: 'AWAITING_ASSIGNMENT', by: ['PARTNER', 'OWNER'] },
    // A carrier booked by hand has no "accept": the owner records the start.
    { to: 'IN_PROGRESS', by: ['OWNER'] },
    { to: 'CANCELLED', by: ['SYSTEM'] },
  ],
  ACCEPTED: [
    { to: 'IN_PROGRESS', by: ['PARTNER', 'OWNER'] },
    { to: 'AWAITING_ASSIGNMENT', by: ['OWNER'] },
    { to: 'CANCELLED', by: ['SYSTEM'] },
  ],
  IN_PROGRESS: [
    { to: 'COMPLETED', by: ['PARTNER', 'OWNER'] },
    { to: 'CANCELLED', by: ['SYSTEM'] },
  ],
  COMPLETED: [],
  CANCELLED: [],
};

export function legTransitionAllowed(from: ShipmentLegStatus, to: ShipmentLegStatus, by: LegActor): boolean {
  return LEG_TRANSITIONS[from].some((edge) => edge.to === to && edge.by.includes(by));
}

export class LegTransitionError extends Error {
  constructor(
    readonly from: ShipmentLegStatus,
    readonly to: ShipmentLegStatus,
    readonly by: LegActor,
  ) {
    super(`A leg cannot move from ${from} to ${to} (${by}).`);
    this.name = 'LegTransitionError';
  }
}

/** The one gate every leg status change goes through. */
export function assertLegTransition(from: ShipmentLegStatus, to: ShipmentLegStatus, by: LegActor): void {
  if (!legTransitionAllowed(from, to, by)) throw new LegTransitionError(from, to, by);
}

/** A carrier may be named while the leg waits its turn, or when it is its turn. */
export function legMayBeAssigned(status: ShipmentLegStatus): boolean {
  return status === 'PENDING' || status === 'AWAITING_ASSIGNMENT' || status === 'ASSIGNED' || status === 'ACCEPTED';
}

export const TERMINAL_LEG_STATUSES: readonly ShipmentLegStatus[] = ['COMPLETED', 'CANCELLED'];
