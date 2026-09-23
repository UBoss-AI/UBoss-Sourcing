/**
 * Configuring a seller's own delivery operation.
 *
 * Four things a self-managed or dedicated method needs before it is more than
 * a name: where it collects from, where it delivers to, what it is allowed to
 * carry, and what it charges.
 *
 * THE ONE RULE THAT SHAPES EVERY FUNCTION HERE
 *
 * A seller may configure the organisation they OWN, and nothing else. Every
 * function resolves the organisation from the seller's own method rather than
 * accepting an organisation id, so there is no shape of request that could
 * point at another company's coverage, fleet or prices. A dedicated partner
 * the seller merely contracts with is NOT theirs to configure either - that
 * company sets its own areas in its own portal, and a seller editing them
 * would be a marketplace letting one business rewrite another's service
 * promises.
 *
 * WHAT THE SELLER MAY NOT DECIDE
 *
 * Capabilities. A seller may REQUEST cold-chain or dangerous-goods handling;
 * only the marketplace approves one, because the approval is the difference
 * between a claim and a fact, and only an approved capability is matched
 * against a consignment that needs it.
 */
import type { LogisticsCapabilityKind, LogisticsRegionScope } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import type { SellerActor } from './fulfilment-method.service.js';

/**
 * The organisation behind one of this seller's methods, if it is theirs.
 *
 * Returns the partner id only where the seller OWNS it. A dedicated partner
 * the seller contracts with has `ownerSellerAccountId` set to that seller too -
 * which is deliberate and is what keeps it off other sellers' pickers - so the
 * caller passes `selfManagedOnly` to say whether contracting is enough.
 */
async function resolveOwnOrganisation(
  sellerAccountId: string,
  fulfilmentMethodId: string,
  options: { selfManagedOnly?: boolean } = {},
): Promise<{ partnerId: string; methodId: string }> {
  const method = await prisma.sellerFulfilmentMethod.findFirst({
    // Both ids in one query: another seller's method is not found.
    where: { id: fulfilmentMethodId, sellerAccountId, archivedAt: null },
    select: {
      id: true,
      mode: true,
      logisticsPartnerId: true,
      logisticsPartner: { select: { id: true, ownerSellerAccountId: true } },
    },
  });

  if (method === null) throw notFound('Delivery method');

  if (method.logisticsPartner === null) {
    throw conflict(
      ErrorCode.SELLER_FULFILMENT_METHOD_NOT_APPROVED,
      'This delivery method has no delivery operation behind it yet.',
      [{ code: 'NO_ORGANISATION' }],
    );
  }

  if (method.logisticsPartner.ownerSellerAccountId !== sellerAccountId) {
    throw badRequest(
      ErrorCode.SELLER_LOGISTICS_PARTNER_NOT_YOURS,
      'That delivery company is not yours to configure.',
      [{ code: 'NOT_OWNED' }],
    );
  }

  /*
   * Areas and prices belong to whoever runs the vans.
   *
   * For SELF_MANAGED that is the seller. For DEDICATED_PARTNER it is the
   * courier, who sets its own coverage in its own portal - a seller editing it
   * would be one business rewriting another's service promise, which is not
   * something a marketplace should make possible however convenient.
   */
  if (options.selfManagedOnly === true && method.mode !== 'SELF_MANAGED') {
    throw badRequest(
      ErrorCode.SELLER_LOGISTICS_PARTNER_NOT_YOURS,
      'Only your own delivery operation can be configured here. A delivery company that works ' +
        'for you sets its own coverage and prices.',
      [{ code: 'NOT_SELF_MANAGED', meta: { mode: method.mode } }],
    );
  }

  return { partnerId: method.logisticsPartner.id, methodId: method.id };
}

// ---------------------------------------------------------------------------
// WHERE IT COLLECTS FROM
// ---------------------------------------------------------------------------

export interface PickupProfileView {
  id: string;
  sellerLocationId: string;
  locationName: string;
  pickupDaysMask: number;
  windowStart: string | null;
  windowEnd: string | null;
  cutoffOverride: string | null;
  handlingTimeDaysOverride: number | null;
  maxDailyShipments: number | null;
  contactName: string | null;
  contactPhone: string | null;
  instructions: string | null;
  maxPackageWeightGrams: number | null;
  isActive: boolean;
}

export async function listPickupProfiles(
  sellerAccountId: string,
  fulfilmentMethodId: string,
): Promise<PickupProfileView[]> {
  const rows = await prisma.sellerLogisticsPickupProfile.findMany({
    where: { sellerAccountId, fulfilmentMethodId },
    include: { sellerLocation: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((row) => ({
    id: row.id,
    sellerLocationId: row.sellerLocationId,
    locationName: row.sellerLocation.name,
    pickupDaysMask: row.pickupDaysMask,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    cutoffOverride: row.cutoffOverride,
    handlingTimeDaysOverride: row.handlingTimeDaysOverride,
    maxDailyShipments: row.maxDailyShipments,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    instructions: row.instructions,
    maxPackageWeightGrams: row.maxPackageWeightGrams,
    isActive: row.isActive,
  }));
}

export interface SavePickupProfileInput {
  sellerAccountId: string;
  actor: SellerActor;
  fulfilmentMethodId: string;
  sellerLocationId: string;
  pickupDaysMask?: number;
  windowStart?: string | null;
  windowEnd?: string | null;
  cutoffOverride?: string | null;
  handlingTimeDaysOverride?: number | null;
  maxDailyShipments?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  instructions?: string | null;
  maxPackageWeightGrams?: number | null;
}

/**
 * How goods leave one building under one method.
 *
 * DELIBERATELY THIN. The address, the timezone, the dispatch cutoff, the
 * working days and the handling time are facts about the BUILDING and already
 * live on the location - they do not change because the seller switched
 * carrier. What is here is what genuinely differs per method: the window a
 * courier calls in, how many parcels it will take in a day, and the limits it
 * imposes on one package.
 */
export async function savePickupProfile(
  input: SavePickupProfileInput,
): Promise<PickupProfileView> {
  await resolveOwnOrganisation(input.sellerAccountId, input.fulfilmentMethodId);

  /*
   * The location must be the seller's own.
   *
   * A foreign key cannot express "these two ids belong to the same third row",
   * so this is the check - and it is the one a cross-tenant write would try to
   * get past.
   */
  const location = await prisma.sellerLocation.findFirst({
    where: {
      id: input.sellerLocationId,
      sellerAccountId: input.sellerAccountId,
      archivedAt: null,
    },
    select: { id: true, name: true },
  });

  if (location === null) {
    throw badRequest(
      ErrorCode.SELLER_FULFILMENT_RULE_INVALID,
      'That place is not one of yours.',
      [{ field: 'sellerLocationId', code: 'NOT_FOUND' }],
    );
  }

  const data = {
    pickupDaysMask: input.pickupDaysMask ?? 31,
    windowStart: input.windowStart ?? null,
    windowEnd: input.windowEnd ?? null,
    cutoffOverride: input.cutoffOverride ?? null,
    handlingTimeDaysOverride: input.handlingTimeDaysOverride ?? null,
    maxDailyShipments: input.maxDailyShipments ?? null,
    contactName: input.contactName ?? null,
    contactPhone: input.contactPhone ?? null,
    instructions: input.instructions ?? null,
    maxPackageWeightGrams: input.maxPackageWeightGrams ?? null,
    isActive: true,
  };

  await prisma.sellerLogisticsPickupProfile.upsert({
    where: {
      sellerAccountId_fulfilmentMethodId_sellerLocationId: {
        sellerAccountId: input.sellerAccountId,
        fulfilmentMethodId: input.fulfilmentMethodId,
        sellerLocationId: location.id,
      },
    },
    create: {
      id: newId(),
      sellerAccountId: input.sellerAccountId,
      fulfilmentMethodId: input.fulfilmentMethodId,
      sellerLocationId: location.id,
      ...data,
    },
    update: data,
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.fulfilment.pickup.saved',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerLogisticsPickupProfile',
    resourceId: location.id,
    summary: `Set how goods leave ${location.name}.`,
  });

  const profiles = await listPickupProfiles(input.sellerAccountId, input.fulfilmentMethodId);
  const saved = profiles.find((profile) => profile.sellerLocationId === location.id);

  if (saved === undefined) throw notFound('Pickup profile');
  return saved;
}

// ---------------------------------------------------------------------------
// WHERE IT DELIVERS TO
// ---------------------------------------------------------------------------

export interface ServiceAreaView {
  id: string;
  scope: LogisticsRegionScope;
  countryCode: string;
  regionValue: string;
  isExclusion: boolean;
  supportsPickup: boolean;
  supportsDelivery: boolean;
  deliveryDaysMask: number;
  transitDaysMin: number | null;
  transitDaysMax: number | null;
  remoteAreaSurchargeMinor: string | null;
  maxShipmentWeightGrams: number | null;
  isActive: boolean;
}

export async function listServiceAreas(
  sellerAccountId: string,
  fulfilmentMethodId: string,
): Promise<ServiceAreaView[]> {
  const { partnerId } = await resolveOwnOrganisation(sellerAccountId, fulfilmentMethodId);

  const rows = await prisma.logisticsServiceRegion.findMany({
    where: { logisticsPartnerId: partnerId },
    orderBy: [{ countryCode: 'asc' }, { regionValue: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    countryCode: row.countryCode,
    regionValue: row.regionValue,
    isExclusion: row.isExclusion,
    supportsPickup: row.supportsPickup,
    supportsDelivery: row.supportsDelivery,
    deliveryDaysMask: row.deliveryDaysMask,
    transitDaysMin: row.transitDaysMin,
    transitDaysMax: row.transitDaysMax,
    // Minor units as a string: a surcharge that crossed the API as a number
    // would be a float the moment it arrived.
    remoteAreaSurchargeMinor: row.remoteAreaSurchargeMinor?.toString() ?? null,
    maxShipmentWeightGrams: row.maxShipmentWeightGrams,
    isActive: row.isActive,
  }));
}

export interface SaveServiceAreaInput {
  sellerAccountId: string;
  actor: SellerActor;
  fulfilmentMethodId: string;
  scope: LogisticsRegionScope;
  countryCode: string;
  /** A state, city or postcode prefix. Empty for a whole country. */
  regionValue?: string | null;
  isExclusion?: boolean;
  supportsPickup?: boolean;
  supportsDelivery?: boolean;
  deliveryDaysMask?: number;
  transitDaysMin?: number | null;
  transitDaysMax?: number | null;
  remoteAreaSurchargeMinor?: bigint | null;
  maxShipmentWeightGrams?: number | null;
}

/**
 * Say where this operation goes.
 *
 * An EXCLUSION wins over any inclusion that overlaps it, which is how "the
 * whole of France except Corsica" is expressed - the shape most real coverage
 * takes, and one an inclusion-only model can only approximate by enumerating
 * departments.
 *
 * `regionValue` is an empty string rather than null for a whole country,
 * because MariaDB treats every NULL in a UNIQUE index as distinct and a
 * nullable column here would let one organisation hold two "the whole of
 * Belgium" rows.
 */
export async function saveServiceArea(input: SaveServiceAreaInput): Promise<ServiceAreaView> {
  const { partnerId } = await resolveOwnOrganisation(
    input.sellerAccountId,
    input.fulfilmentMethodId,
    { selfManagedOnly: true },
  );

  if (
    input.transitDaysMin !== null &&
    input.transitDaysMin !== undefined &&
    input.transitDaysMax !== null &&
    input.transitDaysMax !== undefined &&
    input.transitDaysMax < input.transitDaysMin
  ) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The longest transit time cannot be shorter than the shortest.',
      [{ field: 'transitDaysMax', code: 'RANGE_INVERTED' }],
    );
  }

  const countryCode = input.countryCode.trim().toUpperCase();
  const regionValue = (input.regionValue ?? '').trim().toUpperCase();

  const data = {
    isExclusion: input.isExclusion ?? false,
    supportsPickup: input.supportsPickup ?? true,
    supportsDelivery: input.supportsDelivery ?? true,
    deliveryDaysMask: input.deliveryDaysMask ?? 31,
    transitDaysMin: input.transitDaysMin ?? null,
    transitDaysMax: input.transitDaysMax ?? null,
    remoteAreaSurchargeMinor: input.remoteAreaSurchargeMinor ?? null,
    maxShipmentWeightGrams: input.maxShipmentWeightGrams ?? null,
    isActive: true,
  };

  const row = await prisma.logisticsServiceRegion.upsert({
    where: {
      logisticsPartnerId_scope_countryCode_regionValue: {
        logisticsPartnerId: partnerId,
        scope: input.scope,
        countryCode,
        regionValue,
      },
    },
    create: {
      id: newId(),
      logisticsPartnerId: partnerId,
      scope: input.scope,
      countryCode,
      regionValue,
      ...data,
    },
    update: data,
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.fulfilment.area.saved',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'LogisticsServiceRegion',
    resourceId: row.id,
    after: { countryCode, regionValue, isExclusion: data.isExclusion },
    summary: `${data.isExclusion ? 'Excluded' : 'Added'} ${countryCode}${regionValue.length > 0 ? ` ${regionValue}` : ''}.`,
  });

  const areas = await listServiceAreas(input.sellerAccountId, input.fulfilmentMethodId);
  const saved = areas.find((area) => area.id === row.id);

  if (saved === undefined) throw notFound('Service area');
  return saved;
}

export async function removeServiceArea(input: {
  sellerAccountId: string;
  actor: SellerActor;
  fulfilmentMethodId: string;
  areaId: string;
}): Promise<void> {
  const { partnerId } = await resolveOwnOrganisation(
    input.sellerAccountId,
    input.fulfilmentMethodId,
    { selfManagedOnly: true },
  );

  const deleted = await prisma.logisticsServiceRegion.deleteMany({
    // The partner id comes from the seller's own method, so an area belonging
    // to another organisation matches nothing.
    where: { id: input.areaId, logisticsPartnerId: partnerId },
  });

  if (deleted.count === 0) throw notFound('Service area');

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.fulfilment.area.removed',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'LogisticsServiceRegion',
    resourceId: input.areaId,
    summary: 'Removed a delivery area.',
  });
}

// ---------------------------------------------------------------------------
// WHAT IT IS ALLOWED TO CARRY
// ---------------------------------------------------------------------------

export interface CapabilityView {
  id: string;
  kind: LogisticsCapabilityKind;
  state: string;
  evidenceReference: string | null;
  evidenceExpiresAt: string | null;
  decisionNote: string | null;
}

export async function listCapabilities(
  sellerAccountId: string,
  fulfilmentMethodId: string,
): Promise<CapabilityView[]> {
  const { partnerId } = await resolveOwnOrganisation(sellerAccountId, fulfilmentMethodId);

  const rows = await prisma.logisticsCapability.findMany({
    where: { logisticsPartnerId: partnerId },
    orderBy: { kind: 'asc' },
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    state: row.state,
    evidenceReference: row.evidenceReference,
    evidenceExpiresAt: row.evidenceExpiresAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
  }));
}

/**
 * Ask to be allowed to carry something.
 *
 * REQUESTED, always - a seller cannot approve their own capability, and this
 * function has no parameter that would let them try. The marketplace decides,
 * because the approval is the difference between "our vans have a fridge" and
 * "somebody checked", and only an approved capability is matched against a
 * consignment that needs it.
 *
 * Re-asking after a refusal moves the same row back to REQUESTED rather than
 * creating a second, so "may this organisation carry reagents" is always
 * answered by exactly one row.
 */
export async function requestCapability(input: {
  sellerAccountId: string;
  actor: SellerActor;
  fulfilmentMethodId: string;
  kind: LogisticsCapabilityKind;
  evidenceReference?: string | null;
  evidenceExpiresAt?: Date | null;
}): Promise<CapabilityView> {
  const { partnerId } = await resolveOwnOrganisation(
    input.sellerAccountId,
    input.fulfilmentMethodId,
    { selfManagedOnly: true },
  );

  const row = await prisma.logisticsCapability.upsert({
    where: {
      logisticsPartnerId_kind: { logisticsPartnerId: partnerId, kind: input.kind },
    },
    create: {
      id: newId(),
      logisticsPartnerId: partnerId,
      kind: input.kind,
      state: 'REQUESTED',
      evidenceReference: input.evidenceReference ?? null,
      evidenceExpiresAt: input.evidenceExpiresAt ?? null,
    },
    update: {
      // Back to REQUESTED. A seller who has re-sent their certificate is
      // asking again, and leaving it APPROVED on the strength of the old one
      // would approve evidence nobody looked at.
      state: 'REQUESTED',
      evidenceReference: input.evidenceReference ?? null,
      evidenceExpiresAt: input.evidenceExpiresAt ?? null,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
    },
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.fulfilment.capability.requested',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'LogisticsCapability',
    resourceId: row.id,
    after: { kind: input.kind },
    summary: `Asked to be approved for ${input.kind}.`,
  });

  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    evidenceReference: row.evidenceReference,
    evidenceExpiresAt: row.evidenceExpiresAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
  };
}

// ---------------------------------------------------------------------------
// WHAT IT CHARGES
// ---------------------------------------------------------------------------

export interface RateBandInput {
  basis: 'FLAT' | 'WEIGHT' | 'DISTANCE' | 'POSTAL_ZONE' | 'PACKAGE_SIZE';
  serviceType?: 'STANDARD' | 'EXPRESS' | 'SAME_DAY' | 'ECONOMY' | 'FREIGHT' | 'WHITE_GLOVE';
  minValue?: number;
  maxValue?: number | null;
  postalPrefix?: string;
  /** Minor units, as a string on the wire. Never a float. */
  amountMinor: string;
  perUnitMinor?: string | null;
  sortOrder?: number;
}

export interface RateCardView {
  id: string;
  name: string;
  version: number;
  currency: string;
  isActive: boolean;
  minimumChargeMinor: string | null;
  freeShippingThresholdMinor: string | null;
  taxInclusive: boolean;
  bands: {
    basis: string;
    serviceType: string;
    minValue: number;
    maxValue: number | null;
    postalPrefix: string;
    amountMinor: string;
    perUnitMinor: string | null;
  }[];
}

export async function listRateCards(
  sellerAccountId: string,
  fulfilmentMethodId: string,
): Promise<RateCardView[]> {
  const rows = await prisma.sellerLogisticsRateCard.findMany({
    where: { sellerAccountId, fulfilmentMethodId },
    include: { bands: { orderBy: { sortOrder: 'asc' } } },
    orderBy: [{ name: 'asc' }, { version: 'desc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    version: row.version,
    currency: row.currency,
    isActive: row.isActive,
    minimumChargeMinor: row.minimumChargeMinor?.toString() ?? null,
    freeShippingThresholdMinor: row.freeShippingThresholdMinor?.toString() ?? null,
    taxInclusive: row.taxInclusive,
    bands: row.bands.map((band) => ({
      basis: band.basis,
      serviceType: band.serviceType,
      minValue: band.minValue,
      maxValue: band.maxValue,
      postalPrefix: band.postalPrefix,
      amountMinor: band.amountMinor.toString(),
      perUnitMinor: band.perUnitMinor?.toString() ?? null,
    })),
  }));
}

/**
 * Publish what this operation charges.
 *
 * VERSIONED, AND A REPUBLISH MAKES A NEW VERSION. The previous one stays,
 * inactive, because quotes point at the version they were priced from - and a
 * customer disputing a delivery charge six weeks later has to be shown the card
 * as it stood on the day, not as it stands now. A card edited in place makes
 * that impossible, which is how a marketplace ends up unable to explain a
 * number it charged.
 *
 * Only for SELF_MANAGED. DHL, FedEx and India Post price their own work, and
 * this system never invents a figure on their behalf.
 */
export async function publishRateCard(input: {
  sellerAccountId: string;
  actor: SellerActor;
  fulfilmentMethodId: string;
  name: string;
  currency: string;
  minimumChargeMinor?: bigint | null;
  freeShippingThresholdMinor?: bigint | null;
  taxInclusive?: boolean;
  bands: readonly RateBandInput[];
}): Promise<RateCardView> {
  await resolveOwnOrganisation(input.sellerAccountId, input.fulfilmentMethodId, {
    selfManagedOnly: true,
  });

  if (input.bands.length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A price list needs at least one line.',
      [{ field: 'bands', code: 'REQUIRED' }],
    );
  }

  const name = input.name.trim().slice(0, 120);

  const previous = await prisma.sellerLogisticsRateCard.findFirst({
    where: { fulfilmentMethodId: input.fulfilmentMethodId, name },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const version = (previous?.version ?? 0) + 1;
  const cardId = newId();

  await prisma.$transaction(async (tx) => {
    // The previous version stops being the live one and stays on the record.
    await tx.sellerLogisticsRateCard.updateMany({
      where: { fulfilmentMethodId: input.fulfilmentMethodId, name, isActive: true },
      data: { isActive: false, effectiveTo: new Date() },
    });

    await tx.sellerLogisticsRateCard.create({
      data: {
        id: cardId,
        sellerAccountId: input.sellerAccountId,
        fulfilmentMethodId: input.fulfilmentMethodId,
        name,
        version,
        currency: input.currency.trim().toUpperCase(),
        minimumChargeMinor: input.minimumChargeMinor ?? null,
        freeShippingThresholdMinor: input.freeShippingThresholdMinor ?? null,
        taxInclusive: input.taxInclusive ?? false,
        isActive: true,
        createdBySellerMemberId: input.actor.memberId,
      },
    });

    for (const [index, band] of input.bands.entries()) {
      await tx.sellerLogisticsRateBand.create({
        data: {
          id: newId(),
          rateCardId: cardId,
          basis: band.basis,
          serviceType: band.serviceType ?? 'STANDARD',
          minValue: band.minValue ?? 0,
          maxValue: band.maxValue ?? null,
          postalPrefix: (band.postalPrefix ?? '').trim().toUpperCase(),
          // BigInt from a string. The wire carries minor units as text so a
          // price never passes through a JavaScript number.
          amountMinor: BigInt(band.amountMinor),
          perUnitMinor: band.perUnitMinor === null || band.perUnitMinor === undefined
            ? null
            : BigInt(band.perUnitMinor),
          sortOrder: band.sortOrder ?? index,
        },
      });
    }
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.fulfilment.rate_card.published',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerLogisticsRateCard',
    resourceId: cardId,
    after: { name, version, bands: input.bands.length },
    summary: `Published ${name} version ${String(version)}.`,
  });

  const cards = await listRateCards(input.sellerAccountId, input.fulfilmentMethodId);
  const published = cards.find((card) => card.id === cardId);

  if (published === undefined) throw notFound('Price list');
  return published;
}
