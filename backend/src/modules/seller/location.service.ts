/**
 * A seller's own places: where orders are picked from and where returns go.
 *
 * Separate from the operator's `InventoryLocation` rather than shared, and the
 * separation is not tidiness. The operator's warehouses are the operator's:
 * their codes appear on the operator's movements, their delivery zones decide
 * the operator's shipping, and a seller who could write a row into that table
 * would be adding a warehouse to somebody else's business. These are the
 * seller's, they carry the seller's id, and nothing in the operator's
 * fulfilment path reads them.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';
import { markStep } from './onboarding.service.js';

export interface LocationInput {
  code: string;
  name: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  region?: string | null;
  postcode: string;
  countryCode: string;
  latitude?: number | null;
  longitude?: number | null;
  timezone?: string | null;
  isPickupLocation?: boolean;
  isReturnLocation?: boolean;
  dispatchCutoff?: string | null;
  workingDaysMask?: number | null;
  handlingTimeDays?: number | null;
  shipsToCountries?: string[] | null;
  hasColdChain?: boolean;
  hasControlledStorage?: boolean;
  hasSterileStorage?: boolean;
}

export interface LocationView {
  id: string;
  code: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postcode: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  isPickupLocation: boolean;
  isReturnLocation: boolean;
  dispatchCutoff: string | null;
  workingDaysMask: number;
  handlingTimeDays: number;
  shipsToCountries: string[];
  hasColdChain: boolean;
  hasControlledStorage: boolean;
  hasSterileStorage: boolean;
  isOperational: boolean;
  closedReason: string | null;
}

function toView(row: {
  id: string;
  code: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postcode: string;
  countryCode: string;
  latitude: unknown;
  longitude: unknown;
  timezone: string;
  isPickupLocation: boolean;
  isReturnLocation: boolean;
  dispatchCutoff: string | null;
  workingDaysMask: number;
  handlingTimeDays: number;
  shipsToCountriesJson: unknown;
  hasColdChain: boolean;
  hasControlledStorage: boolean;
  hasSterileStorage: boolean;
  isOperational: boolean;
  closedReason: string | null;
}): LocationView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postcode: row.postcode,
    countryCode: row.countryCode,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    timezone: row.timezone,
    isPickupLocation: row.isPickupLocation,
    isReturnLocation: row.isReturnLocation,
    dispatchCutoff: row.dispatchCutoff,
    workingDaysMask: row.workingDaysMask,
    handlingTimeDays: row.handlingTimeDays,
    shipsToCountries: Array.isArray(row.shipsToCountriesJson)
      ? (row.shipsToCountriesJson as string[])
      : [],
    hasColdChain: row.hasColdChain,
    hasControlledStorage: row.hasControlledStorage,
    hasSterileStorage: row.hasSterileStorage,
    isOperational: row.isOperational,
    closedReason: row.closedReason,
  };
}

export async function listLocations(membership: SellerMembership): Promise<LocationView[]> {
  assertSellerPermission(membership, SellerPermission.LOCATION_READ);

  const rows = await prisma.sellerLocation.findMany({
    where: { sellerAccountId: membership.sellerAccountId, archivedAt: null },
    orderBy: [{ isOperational: 'desc' }, { name: 'asc' }],
  });

  return rows.map(toView);
}

/**
 * Validate the parts a database CHECK cannot express.
 *
 * The cutoff is the one worth spelling out: it is a WALL-CLOCK time at the
 * warehouse, so "17:00" means five in the afternoon wherever that place is, and
 * without the timezone beside it the whole field is meaningless. An unparseable
 * cutoff silently becomes "never" in the dispatch calculation, which shows up
 * weeks later as every order at that location breaching its SLA.
 */
function validate(input: LocationInput): void {
  if (input.dispatchCutoff !== null && input.dispatchCutoff !== undefined && input.dispatchCutoff.length > 0) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.dispatchCutoff)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'The dispatch cutoff must be a time like 17:00.', [
        { field: 'dispatchCutoff', code: 'NOT_A_TIME' },
      ]);
    }
  }

  if (input.workingDaysMask !== null && input.workingDaysMask !== undefined && (input.workingDaysMask < 0 || input.workingDaysMask > 127)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose which days this location works.', [
      { field: 'workingDaysMask', code: 'OUT_OF_RANGE' },
    ]);
  }

  if (input.workingDaysMask === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A location that works no days can never dispatch an order. Close it instead.',
      [{ field: 'workingDaysMask', code: 'NO_WORKING_DAYS' }],
    );
  }

  // 0,0 is a real point in the Gulf of Guinea and several systems have shipped
  // to it. Treated as "not geocoded" rather than as a position.
  if (input.latitude === 0 && input.longitude === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Those coordinates are in the middle of the Atlantic. Search for the address again.',
      [{ field: 'latitude', code: 'NULL_ISLAND' }],
    );
  }
}

export async function createLocation(
  membership: SellerMembership,
  input: LocationInput,
  correlationId?: string | null,
): Promise<LocationView> {
  assertSellerPermission(membership, SellerPermission.LOCATION_WRITE);
  validate(input);

  const code = input.code.trim().toUpperCase();

  const clash = await prisma.sellerLocation.findFirst({
    where: { sellerAccountId: membership.sellerAccountId, code },
    select: { id: true },
  });

  if (clash !== null) {
    throw conflict(
      ErrorCode.SELLER_LOCATION_CODE_EXISTS,
      `You already have a location with the code ${code}.`,
      [{ field: 'code', code: 'DUPLICATE' }],
    );
  }

  const id = newId();

  await prisma.sellerLocation.create({
    data: {
      id,
      sellerAccountId: membership.sellerAccountId,
      code,
      name: input.name.trim(),
      addressLine1: input.addressLine1.trim(),
      addressLine2: input.addressLine2 ?? null,
      city: input.city.trim(),
      region: input.region ?? null,
      postcode: input.postcode.trim(),
      countryCode: input.countryCode.toUpperCase(),
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      timezone: input.timezone ?? 'UTC',
      isPickupLocation: input.isPickupLocation ?? true,
      isReturnLocation: input.isReturnLocation ?? true,
      dispatchCutoff: input.dispatchCutoff ?? null,
      workingDaysMask: input.workingDaysMask ?? 31,
      handlingTimeDays: input.handlingTimeDays ?? 1,
      shipsToCountriesJson: (input.shipsToCountries ?? []) as never,
      hasColdChain: input.hasColdChain ?? false,
      hasControlledStorage: input.hasControlledStorage ?? false,
      hasSterileStorage: input.hasSterileStorage ?? false,
    },
  });

  // The locations step is complete as soon as one place can both dispatch and
  // receive returns. Not "one place exists": a seller with one return-only
  // address has nowhere to ship from and would otherwise pass this step and
  // fail at the first order.
  await refreshLocationStep(membership);

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.location.created',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_location',
    resourceId: id,
    summary: `Added the location ${input.name.trim()} (${code}).`,
    correlationId: correlationId ?? null,
  });

  const row = await prisma.sellerLocation.findUniqueOrThrow({ where: { id } });
  return toView(row);
}

export async function updateLocation(
  membership: SellerMembership,
  locationId: string,
  input: Partial<LocationInput> & { isOperational?: boolean; closedReason?: string | null },
  correlationId?: string | null,
): Promise<LocationView> {
  assertSellerPermission(membership, SellerPermission.LOCATION_WRITE);

  const existing = await prisma.sellerLocation.findUnique({
    where: { id: locationId },
    select: { id: true, sellerAccountId: true, code: true, name: true },
  });

  if (existing === null) throw notFound('Location');
  assertSellerOwnership(membership, existing.sellerAccountId, 'Location');

  validate(input as LocationInput);

  await prisma.sellerLocation.update({
    where: { id: locationId },
    data: {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.addressLine1 === undefined ? {} : { addressLine1: input.addressLine1.trim() }),
      ...(input.addressLine2 === undefined ? {} : { addressLine2: input.addressLine2 }),
      ...(input.city === undefined ? {} : { city: input.city.trim() }),
      ...(input.region === undefined ? {} : { region: input.region }),
      ...(input.postcode === undefined ? {} : { postcode: input.postcode.trim() }),
      ...(input.countryCode === undefined ? {} : { countryCode: input.countryCode.toUpperCase() }),
      ...(input.latitude === undefined ? {} : { latitude: input.latitude }),
      ...(input.longitude === undefined ? {} : { longitude: input.longitude }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone ?? 'UTC' }),
      ...(input.isPickupLocation === undefined ? {} : { isPickupLocation: input.isPickupLocation }),
      ...(input.isReturnLocation === undefined ? {} : { isReturnLocation: input.isReturnLocation }),
      ...(input.dispatchCutoff === undefined ? {} : { dispatchCutoff: input.dispatchCutoff }),
      ...(input.workingDaysMask === null || input.workingDaysMask === undefined ? {} : { workingDaysMask: input.workingDaysMask }),
      ...(input.handlingTimeDays === null || input.handlingTimeDays === undefined ? {} : { handlingTimeDays: input.handlingTimeDays }),
      ...(input.shipsToCountries === undefined
        ? {}
        : { shipsToCountriesJson: input.shipsToCountries as never }),
      ...(input.hasColdChain === undefined ? {} : { hasColdChain: input.hasColdChain }),
      ...(input.hasControlledStorage === undefined
        ? {}
        : { hasControlledStorage: input.hasControlledStorage }),
      ...(input.hasSterileStorage === undefined
        ? {}
        : { hasSterileStorage: input.hasSterileStorage }),
      ...(input.isOperational === undefined ? {} : { isOperational: input.isOperational }),
      ...(input.closedReason === undefined ? {} : { closedReason: input.closedReason }),
    },
  });

  await refreshLocationStep(membership);

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.location.updated',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_location',
    resourceId: locationId,
    summary: `Updated the location ${existing.name} (${existing.code}).`,
    correlationId: correlationId ?? null,
  });

  const row = await prisma.sellerLocation.findUniqueOrThrow({ where: { id: locationId } });
  return toView(row);
}

/**
 * Close a location without deleting it.
 *
 * Never a hard delete, and the reason is the same one that keeps
 * `InventoryLocation` soft-deleted: the code is on every movement ever recorded
 * against the place, and a stock ledger whose locations have disappeared cannot
 * be read. Stock still there is refused, because closing a place that holds
 * units would make them unreachable rather than gone.
 */
export async function archiveLocation(
  membership: SellerMembership,
  locationId: string,
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.LOCATION_WRITE);

  const existing = await prisma.sellerLocation.findUnique({
    where: { id: locationId },
    select: { id: true, sellerAccountId: true, name: true },
  });

  if (existing === null) throw notFound('Location');
  assertSellerOwnership(membership, existing.sellerAccountId, 'Location');

  const held = await prisma.sellerInventory.aggregate({
    where: { locationId },
    _sum: { availableQuantity: true, reservedQuantity: true },
  });

  const available = held._sum.availableQuantity ?? 0;
  const reserved = held._sum.reservedQuantity ?? 0;

  if (available > 0 || reserved > 0) {
    throw conflict(
      ErrorCode.LOCATION_STILL_IN_USE,
      `${existing.name} still holds ${String(available + reserved)} units. Move or write them off first.`,
    );
  }

  await prisma.sellerLocation.update({
    where: { id: locationId },
    data: { archivedAt: new Date(), isOperational: false },
  });

  await refreshLocationStep(membership);

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.location.archived',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_location',
    resourceId: locationId,
    summary: `Closed the location ${existing.name}.`,
    correlationId: correlationId ?? null,
  });
}

/** Recompute whether the onboarding's locations step is satisfied. */
async function refreshLocationStep(membership: SellerMembership): Promise<void> {
  const rows = await prisma.sellerLocation.findMany({
    where: { sellerAccountId: membership.sellerAccountId, archivedAt: null, isOperational: true },
    select: { isPickupLocation: true, isReturnLocation: true },
  });

  const canDispatch = rows.some((row) => row.isPickupLocation);
  const canReceiveReturns = rows.some((row) => row.isReturnLocation);

  await markStep({
    membership,
    stepKey: 'locations',
    state: canDispatch && canReceiveReturns ? 'COMPLETE' : rows.length > 0 ? 'IN_PROGRESS' : 'NOT_STARTED',
    message: canDispatch
      ? canReceiveReturns
        ? null
        : 'Add an address where returns can be sent back to.'
      : 'Add an address that orders can be dispatched from.',
  });
}
