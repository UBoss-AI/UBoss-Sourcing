/**
 * Translating what a carrier says into what this system means.
 *
 * Every integrated carrier has its own tracking vocabulary and none of them is
 * ours. DHL reports a lifecycle state beside a scan-event code, FedEx reports
 * a two-letter scan type, UPS reports a single-letter activity type with a
 * detailed code beside it. This file is the ONE place any of those becomes a
 * `ShipmentStatusName`.
 *
 * THE RULE THAT MATTERS MOST
 *
 * **An unrecognised code is never discarded and never guessed at.** It maps to
 * `UNMAPPED`, and the caller's obligation is then fixed: store the original
 * event verbatim, leave the shipment's status alone, raise an operations
 * alert, and let a person decide. A carrier adding a code to their API must
 * not be able to crash this service, and it must not be able to silently mark
 * a consignment delivered either.
 *
 * WHY THE TABLE IS IN CODE AND ALSO IN THE DATABASE
 *
 * The defaults here are what a deployment gets for free and are versioned with
 * the software. `CarrierStatusMapping` rows override them per integration,
 * because a carrier can change a code on a Tuesday and an operator must be
 * able to fix it that afternoon without waiting for a release. `resolveStatus`
 * is given the overrides and consults them first.
 *
 * NOTHING HERE IS COPIED FROM ANY CARRIER'S DOCUMENTATION. These are the
 * identifiers their public APIs emit - facts about a wire format, the same way
 * an HTTP status code is - paired with our own decision about what each one
 * means to us. No carrier's wording, ordering, branding or description is
 * reproduced.
 */
import type { ShipmentStatusName } from './logistics-shipment-state.js';

/**
 * Carriers this software knows how to talk to.
 *
 * `MANUAL` is the important one and is not a third party at all: it is a
 * logistics company working entirely inside this portal, typing its own
 * events. Every deployment has it, it needs no credential, and it is the only
 * provider that is fully working out of the box.
 *
 * `CUSTOM` is a carrier with an API this operator has wired up themselves
 * through the generic adapter and the mapping table.
 */
export const CarrierProviderValues = ['MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS'] as const;

export type CarrierProviderName = (typeof CarrierProviderValues)[number];

/**
 * What a provider code resolved to.
 *
 * `UNMAPPED` is a first-class answer rather than a failure, which is why this
 * is a discriminated union and not `ShipmentStatusName | null`: a null would
 * be tested with `if (!status)` somewhere and quietly become "no change", and
 * "no change" is not what an unknown code means. It means somebody has to
 * look.
 */
export type CarrierStatusResolution =
  | { kind: 'MAPPED'; status: ShipmentStatusName }
  | {
      kind: 'IGNORED';
      /** Why this code deliberately moves nothing. */
      note: string;
    }
  | { kind: 'UNMAPPED' };

const MAPPED = (status: ShipmentStatusName): CarrierStatusResolution => ({
  kind: 'MAPPED',
  status,
});

const IGNORED = (note: string): CarrierStatusResolution => ({ kind: 'IGNORED', note });

/**
 * DHL's unified tracking vocabulary.
 *
 * Two layers: a coarse lifecycle value (`pre-transit`, `transit`, `delivered`,
 * `failure`, `unknown`) and a finer scan-event code beside it. Both are keyed
 * here, lower-cased, because the coarse value is all some responses carry.
 */
const DHL_CODES: Readonly<Record<string, CarrierStatusResolution>> = Object.freeze({
  // Lifecycle
  'pre-transit': MAPPED('ACCEPTED'),
  transit: MAPPED('IN_TRANSIT'),
  delivered: MAPPED('DELIVERED'),
  failure: MAPPED('DELIVERY_FAILED'),
  // Deliberately not mapped to anything: "unknown" is the carrier telling us
  // it does not know, and inventing a status from that is the exact mistake
  // this file exists to prevent.
  unknown: IGNORED('The carrier reported no known state for this tracking number.'),

  // Scan events
  pu: MAPPED('PICKED_UP'),
  af: MAPPED('AT_ORIGIN_HUB'),
  pl: MAPPED('DISPATCHED'),
  df: MAPPED('IN_TRANSIT'),
  ar: MAPPED('AT_DESTINATION_HUB'),
  pd: MAPPED('AT_DESTINATION_HUB'),
  wc: MAPPED('OUT_FOR_DELIVERY'),
  ok: MAPPED('DELIVERED'),
  cc: MAPPED('CUSTOMS_HOLD'),
  hp: MAPPED('ON_HOLD'),
  ne: MAPPED('DELIVERY_ATTEMPTED'),
  ba: MAPPED('ADDRESS_ISSUE'),
  rt: MAPPED('RETURN_IN_TRANSIT'),
  // A label was created and nothing physical has happened. Recording it as a
  // movement would start the transit clock before the parcel exists.
  sd: IGNORED('Label created only; no physical movement yet.'),
});

/** FedEx scan-event types, and the derived status codes that share the space. */
const FEDEX_CODES: Readonly<Record<string, CarrierStatusResolution>> = Object.freeze({
  oc: IGNORED('Shipment information sent to the carrier; nothing has moved.'),
  pu: MAPPED('PICKED_UP'),
  dp: MAPPED('DISPATCHED'),
  ar: MAPPED('AT_DESTINATION_HUB'),
  it: MAPPED('IN_TRANSIT'),
  ii: MAPPED('IN_TRANSIT'),
  od: MAPPED('OUT_FOR_DELIVERY'),
  dl: MAPPED('DELIVERED'),
  de: MAPPED('DELIVERY_ATTEMPTED'),
  se: MAPPED('DELAYED'),
  ca: MAPPED('CANCELLED'),
  ch: MAPPED('ON_HOLD'),
  cd: MAPPED('CUSTOMS_HOLD'),
  rs: MAPPED('RETURN_IN_TRANSIT'),
  rd: MAPPED('RETURNED'),
  ds: MAPPED('AT_ORIGIN_HUB'),
});

/**
 * UPS activity types, plus the detailed status codes worth distinguishing.
 *
 * The single letters are the coarse type; the numeric codes are the detail.
 * Only the details that change what we would do are listed - a detail nothing
 * maps to falls back to its coarse type, which is handled by the caller trying
 * the detail first and the type second.
 */
const UPS_CODES: Readonly<Record<string, CarrierStatusResolution>> = Object.freeze({
  m: IGNORED('Billing information received; the parcel has not been handed over.'),
  p: MAPPED('PICKED_UP'),
  i: MAPPED('IN_TRANSIT'),
  o: MAPPED('OUT_FOR_DELIVERY'),
  d: MAPPED('DELIVERED'),
  x: MAPPED('DELAYED'),
  rs: MAPPED('RETURN_IN_TRANSIT'),
  mp: IGNORED('Manifest pickup record; no movement.'),

  // Details
  '003': MAPPED('AT_ORIGIN_HUB'),
  '005': MAPPED('IN_TRANSIT'),
  '011': MAPPED('DELIVERED'),
  '021': MAPPED('OUT_FOR_DELIVERY'),
  '029': MAPPED('DELIVERY_ATTEMPTED'),
  '038': MAPPED('ADDRESS_ISSUE'),
  '043': MAPPED('CUSTOMS_HOLD'),
  '044': MAPPED('DAMAGED'),
  '048': MAPPED('ON_HOLD'),
});

/**
 * The manual provider's codes are our own canonical statuses.
 *
 * It exists so that `resolveCarrierStatus` has one shape for every provider,
 * including the one where no translation is needed. A portal event never goes
 * through here - it names a status directly - but a CSV import or a partner's
 * own thin API does.
 */
const MANUAL_CODES: Readonly<Record<string, CarrierStatusResolution>> = Object.freeze({});

const PROVIDER_TABLES: Readonly<
  Record<CarrierProviderName, Readonly<Record<string, CarrierStatusResolution>>>
> = Object.freeze({
  MANUAL: MANUAL_CODES,
  CUSTOM: MANUAL_CODES,
  DHL: DHL_CODES,
  FEDEX: FEDEX_CODES,
  UPS: UPS_CODES,
});

/** An operator-supplied override, as stored in `CarrierStatusMapping`. */
export interface CarrierStatusOverride {
  providerCode: string;
  /** Null means "deliberately ignore this code", which is a real answer. */
  canonicalStatus: ShipmentStatusName | null;
  note?: string | null;
}

function normaliseCode(code: string): string {
  return code.trim().toLowerCase();
}

/**
 * Resolve one provider code, consulting operator overrides first.
 *
 * Overrides win over the built-in table unconditionally. That direction is
 * deliberate: the table ships with the software and the override is the
 * operator's reaction to something happening to their parcels today.
 *
 * `candidates` is tried in order, so a caller with both a detailed code and a
 * coarse type passes `[detail, type]` and gets the most specific answer that
 * anything knows about.
 */
export function resolveCarrierStatus(
  provider: CarrierProviderName,
  candidates: readonly string[],
  overrides: readonly CarrierStatusOverride[] = [],
): CarrierStatusResolution {
  const overrideByCode = new Map<string, CarrierStatusOverride>(
    overrides.map((entry) => [normaliseCode(entry.providerCode), entry]),
  );

  const table = PROVIDER_TABLES[provider];

  for (const raw of candidates) {
    if (raw.trim().length === 0) continue;
    const code = normaliseCode(raw);

    const override = overrideByCode.get(code);
    if (override !== undefined) {
      return override.canonicalStatus === null
        ? IGNORED(override.note ?? 'Ignored by an operator mapping.')
        : MAPPED(override.canonicalStatus);
    }

    const builtIn = table[code];
    if (builtIn !== undefined) return builtIn;

    // A MANUAL or CUSTOM feed may send our own vocabulary straight through.
    if (provider === 'MANUAL' || provider === 'CUSTOM') {
      const upper = raw.trim().toUpperCase();
      if (isCanonicalStatusName(upper)) return MAPPED(upper);
    }
  }

  return { kind: 'UNMAPPED' };
}

/**
 * Every code this software knows for a provider, for the admin screen that
 * shows an operator what they are overriding.
 *
 * Sorted, because it is rendered as a list a person reads.
 */
export function knownCarrierCodes(provider: CarrierProviderName): {
  code: string;
  resolution: CarrierStatusResolution;
}[] {
  return Object.entries(PROVIDER_TABLES[provider])
    .map(([code, resolution]) => ({ code, resolution }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function isCarrierProvider(value: string): value is CarrierProviderName {
  return (CarrierProviderValues as readonly string[]).includes(value);
}

/**
 * Local, deliberately duplicated check.
 *
 * Importing `isShipmentStatus` from the state machine would make this module
 * depend on it at runtime purely to validate a string, and the state machine
 * already imports the permission catalogue. A three-line type guard keeps the
 * dependency graph a tree; the `ShipmentStatusName` type import above is what
 * keeps the two in step at compile time.
 */
function isCanonicalStatusName(value: string): value is ShipmentStatusName {
  return CANONICAL_STATUS_NAMES.has(value);
}

const CANONICAL_STATUS_NAMES: ReadonlySet<string> = new Set<ShipmentStatusName>([
  'CREATED',
  'AWAITING_ASSIGNMENT',
  'ASSIGNED',
  'ACCEPTANCE_PENDING',
  'ACCEPTED',
  'PICKUP_SCHEDULED',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'DISPATCHED',
  'AT_ORIGIN_HUB',
  'IN_TRANSIT',
  'AT_DESTINATION_HUB',
  'OUT_FOR_DELIVERY',
  'DELIVERY_ATTEMPTED',
  'DELIVERED',
  'DELAYED',
  'ON_HOLD',
  'ADDRESS_ISSUE',
  'CUSTOMS_HOLD',
  'DAMAGED',
  'TEMPERATURE_EXCEPTION',
  'DELIVERY_FAILED',
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
  'RETURNED',
  'LOST',
  'CANCELLED',
]);
