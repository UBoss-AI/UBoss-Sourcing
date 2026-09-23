/**
 * What kind of transport a consignment actually needs, and whether a carrier
 * can take it.
 *
 * WHY THIS FILE EXISTS
 *
 * A pallet is not a parcel, and a container is not a big parcel. DHL, FedEx
 * and India Post are wired into this system as PARCEL carriers - their
 * adapters build a `CarrierParcel` with a weight and three dimensions, and
 * their APIs price a box a courier can lift. Handing one of them a twenty
 * tonne container booking produces one of two outcomes, and the second is far
 * worse than the first:
 *
 *   1. The API refuses, and the seller sees a provider error they cannot act
 *      on.
 *   2. The API ANSWERS - with a price for something nobody will ever collect.
 *      The buyer is charged it, the pallet sits on the dock, and the
 *      difference is found when somebody rings to ask where it is.
 *
 * So the load type is worked out from what is actually being shipped, the
 * carrier's declared capability is checked against it, and where nothing
 * matches the answer is A QUOTATION rather than a number. Nothing in this file
 * invents a shipping price, and nothing downstream is allowed to either.
 *
 * WHAT DECLARES A CAPABILITY
 *
 * Two things, and they are deliberately different in kind:
 *
 *   - **A provider's adapter** declares what that integration can express at
 *     all. DHL's cannot express a container booking, so no amount of
 *     configuration makes DHL an FCL carrier here.
 *   - **A logistics organisation** declares what it will actually do, through
 *     its approved `LogisticsCapability` rows. A carrier with an approved
 *     PALLET capability takes pallets; one without does not, whatever its
 *     lorries could theoretically carry.
 *
 * A manual or self-managed operation is checked on the second only, because
 * there is no API to be limited by - which is exactly why a seller with their
 * own lorry can move a pallet through this system today.
 */
import type { PackageType } from './packaging.js';

export type FreightLoadTypeName = 'PARCEL' | 'CARTON' | 'PALLET' | 'FCL' | 'LCL';

/** Ordered lightest to heaviest. A carrier that takes one takes those before it. */
export const LOAD_TYPE_ORDER: readonly FreightLoadTypeName[] = [
  'PARCEL',
  'CARTON',
  'PALLET',
  'LCL',
  'FCL',
] as const;

/**
 * The load type one package type implies.
 *
 * A container's mode decides between FCL and LCL, because they are genuinely
 * different services: a full container is a box handed over sealed, and a part
 * container is goods consolidated with somebody else's at a depot. A carrier
 * commonly does one and not the other.
 */
export function loadTypeForPackage(
  packageType: PackageType,
  containerLoadMode: 'FCL' | 'LCL' | null,
): FreightLoadTypeName {
  switch (packageType) {
    case 'CARTON':
      return 'CARTON';
    case 'UK_PALLET':
    case 'US_PALLET':
      return 'PALLET';
    case 'CONTAINER':
      return containerLoadMode === 'LCL' ? 'LCL' : 'FCL';
  }
}

/**
 * The load type for a whole consignment of mixed lines.
 *
 * The HEAVIEST wins. A consignment holding one pallet and forty loose units is
 * a pallet shipment: the pallet has to go on a lorry whatever else is on the
 * order, and quoting it as a parcel because most of the lines are parcels is
 * the exact mistake this module exists to prevent.
 */
export function consignmentLoadType(
  lineLoadTypes: readonly FreightLoadTypeName[],
): FreightLoadTypeName {
  let heaviest: FreightLoadTypeName = 'PARCEL';
  for (const type of lineLoadTypes) {
    if (LOAD_TYPE_ORDER.indexOf(type) > LOAD_TYPE_ORDER.indexOf(heaviest)) heaviest = type;
  }
  return heaviest;
}

/**
 * What each carrier INTEGRATION can express.
 *
 * This is a statement about the adapter, not about the company. DHL Freight
 * moves pallets across Europe every day; DHL's adapter in this repository
 * builds a parcel request against the Express API and cannot describe a pallet
 * booking, so a pallet must not be routed through it. The day a freight
 * adapter is written, this table is where it is declared, and the routing
 * changes with no other caller touched.
 *
 * MANUAL and CUSTOM carry everything, and that is honest rather than lax:
 * MANUAL means a person books it by telephone and types the reference in, and
 * CUSTOM means the operator wired up an API themselves and knows what it does.
 * Neither is a fabricated quote - both end in a human entering a real figure.
 */
const PROVIDER_LOAD_TYPES: Readonly<Record<string, readonly FreightLoadTypeName[]>> = {
  MANUAL: ['PARCEL', 'CARTON', 'PALLET', 'LCL', 'FCL'],
  CUSTOM: ['PARCEL', 'CARTON', 'PALLET', 'LCL', 'FCL'],
  DHL: ['PARCEL', 'CARTON'],
  FEDEX: ['PARCEL', 'CARTON'],
  UPS: ['PARCEL', 'CARTON'],
  /*
   * India Post has no verified booking API here at all - the adapter refuses
   * every operation with CARRIER_PROVIDER_UNSUPPORTED and the tracking number
   * is typed by hand. It is listed as parcel-only because that is what the
   * service is, and because listing it as capable of freight would offer a
   * seller a route that ends in a refusal three screens later.
   */
  INDIA_POST: ['PARCEL', 'CARTON'],
} as const;

/** Can this carrier integration express a booking for this load? */
export function providerSupportsLoad(
  provider: string,
  loadType: FreightLoadTypeName,
): boolean {
  const supported = PROVIDER_LOAD_TYPES[provider];
  if (supported === undefined) return false;
  return supported.includes(loadType);
}

/** Every load type a provider can express. For the "why not?" message. */
export function providerLoadTypes(provider: string): readonly FreightLoadTypeName[] {
  return PROVIDER_LOAD_TYPES[provider] ?? [];
}

/**
 * The `LogisticsCapabilityKind` a load type requires of a delivery company.
 *
 * Only the loads that need one appear here. A parcel needs no capability -
 * carrying parcels is what a carrier IS - so requiring one would make every
 * existing carrier ineligible for the work it already does.
 */
export function requiredCapabilityFor(loadType: FreightLoadTypeName): string | null {
  switch (loadType) {
    case 'PARCEL':
    case 'CARTON':
      return null;
    case 'PALLET':
      return 'PALLET';
    case 'LCL':
    case 'FCL':
      // A container crosses a border in almost every real case, and the
      // capability that matters is whether the company handles international
      // freight at all. OVERSIZED is not it: a container is not an awkward
      // parcel.
      return 'INTERNATIONAL';
  }
}

export type FreightRoutingDecision =
  | { kind: 'CARRIER_OK' }
  | { kind: 'QUOTE_REQUIRED'; reason: 'PROVIDER_CANNOT_CARRY' | 'CAPABILITY_MISSING' | 'NO_METHOD' };

/**
 * May this consignment go by this method, or does it need a quotation?
 *
 * Returns a DECISION and never a price. The caller either books through the
 * carrier or raises a `SellerFreightQuoteRequest`; there is deliberately no
 * third branch in which a figure is estimated, because an estimate on a
 * freight movement is a number somebody will be invoiced for.
 */
export function routeConsignment(input: {
  loadType: FreightLoadTypeName;
  /** The carrier provider, for an INTEGRATED_CARRIER method. Null otherwise. */
  provider: string | null;
  /** Approved capability kinds the delivery organisation holds. */
  approvedCapabilities: readonly string[];
  /** False when nothing at all is available to carry it. */
  hasMethod: boolean;
}): FreightRoutingDecision {
  if (!input.hasMethod) return { kind: 'QUOTE_REQUIRED', reason: 'NO_METHOD' };

  if (input.provider !== null && !providerSupportsLoad(input.provider, input.loadType)) {
    return { kind: 'QUOTE_REQUIRED', reason: 'PROVIDER_CANNOT_CARRY' };
  }

  const required = requiredCapabilityFor(input.loadType);
  if (required !== null && !input.approvedCapabilities.includes(required)) {
    return { kind: 'QUOTE_REQUIRED', reason: 'CAPABILITY_MISSING' };
  }

  return { kind: 'CARRIER_OK' };
}

/**
 * Is this load one a carrier API should never be asked to price?
 *
 * A convenience over `routeConsignment` for the several places that only need
 * the yes/no - the rate screen, the quote button's disabled state - and a
 * single place to change if a freight adapter is ever added.
 */
export function needsManualFreight(loadType: FreightLoadTypeName): boolean {
  return loadType === 'PALLET' || loadType === 'FCL' || loadType === 'LCL';
}
