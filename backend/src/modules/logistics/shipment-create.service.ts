/**
 * Raising a consignment from an order.
 *
 * Where the commerce side of this system meets the logistics side. Called when
 * an order becomes fulfilment-ready, and by the operator by hand for a
 * movement that has no order behind it at all - a warehouse transfer, a
 * sample, a replacement.
 *
 * IDEMPOTENT BY CONSTRUCTION
 *
 * One consignment per (order, seller group, warehouse). Re-running this for an
 * order that already has its consignments returns them rather than creating a
 * second set, and the check is a query inside the same transaction as the
 * insert. A payment provider re-delivering a confirmation webhook is the
 * ordinary case, not the exotic one.
 *
 * WHAT IS COPIED RATHER THAN JOINED
 *
 * Company names, addresses, contacts and the category summary are snapshots,
 * exactly as `Order.shippingAddressJson` is. A carrier holding a parcel must
 * be able to read the address it is going to even if the buyer edits their
 * address book that afternoon, and the record of where a consignment was
 * actually sent must not change afterwards.
 *
 * WHAT IS DELIBERATELY NOT COPIED
 *
 * Prices, quantities, product names, order lines. The carrier gets a CATEGORY
 * SUMMARY - "sterile consumables, diagnostic reagents" - because that is what
 * a driver needs to know how to handle the load, and nothing that would let
 * them price it or identify the goods.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { LogisticsServiceType } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { dueAtFrom } from '../../domain/logistics-sla.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

/**
 * A human-facing consignment reference, `LS-2026-000123`.
 *
 * A counter row incremented with `value = value + 1` takes an InnoDB row lock,
 * so two concurrent confirmations cannot receive the same number. Gaps are
 * fine - a rolled-back transaction consumes one - and duplicates are not,
 * which `uq_logistics_shipment_reference` refuses anyway.
 */
async function nextShipmentReference(tx: PrismaTransaction): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `logistics-shipment:${String(year)}`;

  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: 'LS', padding: 6 },
  });

  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  const padded = sequence.value.toString().padStart(sequence.padding, '0');

  return `${sequence.prefix}-${String(year)}-${padded}`;
}

/**
 * The tracking number a CUSTOMER is given.
 *
 * Ours, not the carrier's, and that is the point: a consignment reassigned to
 * a second carrier keeps this number, so a buyer who bookmarked a tracking
 * page does not lose it when the marketplace changes haulier. The carrier's
 * own number is stored beside it in `carrierTrackingNumber`.
 *
 * Derived from a ULID rather than from the sequence above, because a tracking
 * number is quoted publicly and a sequential one tells anybody who looks how
 * much this marketplace ships.
 */
function newTrackingNumber(): string {
  return `UB${newId().slice(-12).toUpperCase()}`;
}

export interface ShipmentAddressSnapshot {
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode: string;
  countryCode: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface CreateShipmentInput {
  /** All optional: a consignment can exist without an order behind it. */
  orderId?: string | null;
  sellerOrderGroupId?: string | null;
  operatorShipmentId?: string | null;
  originLocationId?: string | null;

  serviceType?: LogisticsServiceType;

  sellerAccountId?: string | null;
  sellerCompanyName: string;
  receivingCustomerProfileId?: string | null;
  receivingCompanyName: string;

  pickupAddress: ShipmentAddressSnapshot;
  deliveryAddress: ShipmentAddressSnapshot;

  pickupContactName?: string | null;
  pickupContactPhone?: string | null;
  pickupContactEmail?: string | null;
  deliveryContactName?: string | null;
  deliveryContactPhone?: string | null;
  deliveryContactEmail?: string | null;

  packageCount?: number;
  totalWeightGrams?: number;
  totalVolumeCm3?: number | null;
  productCategorySummary?: string | null;

  requiresColdChain?: boolean;
  requiresTemperatureRange?: boolean;
  temperatureMinC?: number | null;
  temperatureMaxC?: number | null;
  requiresSterileHandling?: boolean;
  isFragile?: boolean;
  isDangerousGoods?: boolean;
  dangerousGoodsClass?: string | null;
  handlingNotes?: string | null;

  /** Customs and insurance. BigInt minor units, like every amount here. */
  declaredValueMinor?: bigint | null;
  currency?: string | null;

  expectedPickupAt?: Date | null;
  estimatedDeliveryAt?: Date | null;

  packages?: {
    weightGrams?: number;
    lengthMm?: number | null;
    widthMm?: number | null;
    heightMm?: number | null;
    packagingType?: string | null;
    isFragile?: boolean;
    requiresColdChain?: boolean;
    batchReference?: string | null;
  }[];

  createdById?: string | null;
}

export interface CreatedShipment {
  id: string;
  shipmentReference: string;
  trackingNumber: string;
  /** False when an existing consignment was returned instead of a new one. */
  created: boolean;
}

/**
 * Create one consignment, or return the one that already exists.
 *
 * `dedupeOn` is what makes this idempotent, and the caller chooses it: an
 * order-driven creation passes the order and the seller group, a manual one
 * passes nothing and always creates. Without a dedupe key there is nothing to
 * be idempotent ABOUT, which is why it is explicit rather than inferred.
 */
export async function createShipment(
  input: CreateShipmentInput,
  dedupeOn?: { orderId: string; sellerOrderGroupId?: string | null; originLocationId?: string | null },
  tx?: PrismaTransaction,
): Promise<CreatedShipment> {
  const run = async (client: PrismaTransaction): Promise<CreatedShipment> => {
    if (dedupeOn !== undefined) {
      const existing = await client.logisticsShipment.findFirst({
        where: {
          orderId: dedupeOn.orderId,
          sellerOrderGroupId: dedupeOn.sellerOrderGroupId ?? null,
          originLocationId: dedupeOn.originLocationId ?? null,
        },
        select: { id: true, shipmentReference: true, trackingNumber: true },
      });

      if (existing !== null) {
        return { ...existing, created: false };
      }
    }

    const id = newId();
    const shipmentReference = await nextShipmentReference(client);
    const packageCount = Math.max(1, input.packageCount ?? input.packages?.length ?? 1);

    await client.logisticsShipment.create({
      data: {
        id,
        shipmentReference,
        trackingNumber: newTrackingNumber(),
        orderId: input.orderId ?? null,
        sellerOrderGroupId: input.sellerOrderGroupId ?? null,
        operatorShipmentId: input.operatorShipmentId ?? null,
        originLocationId: input.originLocationId ?? null,
        // CREATED, always. Nothing is assigned at creation - the operator or
        // the assignment engine does that, and a consignment that arrived
        // pre-assigned would have no record of who chose the carrier.
        status: 'CREATED',
        serviceType: input.serviceType ?? 'STANDARD',

        sellerAccountId: input.sellerAccountId ?? null,
        sellerCompanyName: input.sellerCompanyName.slice(0, 255),
        receivingCustomerProfileId: input.receivingCustomerProfileId ?? null,
        receivingCompanyName: input.receivingCompanyName.slice(0, 255),

        pickupAddressJson: input.pickupAddress as unknown as Prisma.InputJsonValue,
        deliveryAddressJson: input.deliveryAddress as unknown as Prisma.InputJsonValue,

        pickupContactName: input.pickupContactName ?? null,
        pickupContactPhone: input.pickupContactPhone ?? null,
        pickupContactEmail: input.pickupContactEmail ?? null,
        deliveryContactName: input.deliveryContactName ?? null,
        deliveryContactPhone: input.deliveryContactPhone ?? null,
        deliveryContactEmail: input.deliveryContactEmail ?? null,

        // Denormalised out of the addresses so the list can filter and group
        // on them without opening JSON on every row.
        originCountry: input.pickupAddress.countryCode.toUpperCase(),
        destinationCountry: input.deliveryAddress.countryCode.toUpperCase(),
        destinationCity: input.deliveryAddress.city,
        destinationPostalCode: input.deliveryAddress.postalCode,

        packageCount,
        totalWeightGrams: input.totalWeightGrams ?? 0,
        totalVolumeCm3: input.totalVolumeCm3 ?? null,
        productCategorySummary: input.productCategorySummary ?? null,

        requiresColdChain: input.requiresColdChain ?? false,
        requiresTemperatureRange: input.requiresTemperatureRange ?? false,
        temperatureMinC: input.temperatureMinC ?? null,
        temperatureMaxC: input.temperatureMaxC ?? null,
        requiresSterileHandling: input.requiresSterileHandling ?? false,
        isFragile: input.isFragile ?? false,
        isDangerousGoods: input.isDangerousGoods ?? false,
        dangerousGoodsClass: input.dangerousGoodsClass ?? null,
        handlingNotes: input.handlingNotes ?? null,

        declaredValueMinor: input.declaredValueMinor ?? null,
        currency: input.currency ?? null,

        expectedPickupAt: input.expectedPickupAt ?? null,
        estimatedDeliveryAt: input.estimatedDeliveryAt ?? null,

        createdById: input.createdById ?? null,
      },
    });

    /*
     * The packages.
     *
     * Rows rather than JSON, unlike `SellerShipment.contentsJson`, because
     * these are SCANNED: a driver reads a barcode off a carton at a loading
     * bay and the system has to find that carton. A JSON blob cannot be
     * indexed by the thing a scanner emits.
     *
     * A consignment with no package detail still gets one row, so every
     * parcel has something to scan.
     */
    type PackageInput = NonNullable<CreateShipmentInput['packages']>[number];

    const declared = input.packages ?? [];
    const rows: PackageInput[] =
      declared.length > 0 ? declared : Array.from({ length: packageCount }, (): PackageInput => ({}));

    await client.logisticsShipmentPackage.createMany({
      data: rows.map((entry, index) => ({
        id: newId(),
        shipmentId: id,
        packageReference: `${shipmentReference}-${String(index + 1).padStart(2, '0')}`,
        sequence: index + 1,
        weightGrams: entry.weightGrams ?? 0,
        lengthMm: entry.lengthMm ?? null,
        widthMm: entry.widthMm ?? null,
        heightMm: entry.heightMm ?? null,
        packagingType: entry.packagingType ?? null,
        isFragile: entry.isFragile ?? input.isFragile ?? false,
        requiresColdChain: entry.requiresColdChain ?? input.requiresColdChain ?? false,
        batchReference: entry.batchReference ?? null,
      })),
    });

    // The first event. A consignment with no timeline entry for its own
    // creation has a timeline that starts in the middle.
    await client.logisticsShipmentEvent.create({
      data: {
        id: newId(),
        shipmentId: id,
        previousStatus: null,
        status: 'CREATED',
        publicDescription: 'We are preparing your order for despatch.',
        occurredAt: new Date(),
        source: 'SYSTEM_AUTOMATION',
        actorUserId: input.createdById ?? null,
        externalEventKey: newId(),
        idempotencyKey: newId(),
      },
    });

    return { id, shipmentReference, trackingNumber: newTrackingNumber(), created: true };
  };

  // The tracking number has to be the one that was actually stored, so read
  // it back rather than regenerating. Cheap, and the alternative is a customer
  // quoting a number that matches no row.
  const result = tx !== undefined ? await run(tx) : await prisma.$transaction(run);

  if (!result.created) return result;

  const stored = await prisma.logisticsShipment.findUniqueOrThrow({
    where: { id: result.id },
    select: { trackingNumber: true },
  });

  return { ...result, trackingNumber: stored.trackingNumber };
}

/**
 * Where a seller's part of an order is collected from.
 *
 * A seller's goods leave the SELLER's building, not the operator's warehouse.
 * Reading the operator's own despatch point here is what made a marketplace
 * order impossible to raise a consignment for at all: an order made entirely
 * of sellers' lines has no warehouse of the operator's, so the origin was null
 * and the whole order was refused.
 *
 * The place is only taken where there is no room for doubt about it:
 *
 *   - the one the seller NAMED when they accepted the order, or
 *   - their only operational pickup place, where they have exactly one.
 *
 * A seller with several places who has not yet accepted is skipped rather than
 * guessed at. A consignment tells a driver which door to knock on, and a
 * guessed door sends them to a building where nobody is expecting them - so
 * that group waits for the acceptance, which raises it a moment later.
 */
interface SellerPickup {
  address: ShipmentAddressSnapshot;
  contactName: string;
}

async function pickupsForSellerGroups(
  groups: { id: string; locationId: string | null; sellerAccountId: string }[],
): Promise<Map<string, SellerPickup>> {
  const pickups = new Map<string, SellerPickup>();
  if (groups.length === 0) return pickups;

  const named = groups
    .map((group) => group.locationId)
    .filter((locationId): locationId is string => locationId !== null);

  // One query for both questions - the places the sellers named, and the
  // candidates for the ones who have not - so a ten-seller order is one round
  // trip rather than twenty.
  const locations = await prisma.sellerLocation.findMany({
    where: {
      archivedAt: null,
      OR: [
        ...(named.length === 0 ? [] : [{ id: { in: named } }]),
        {
          sellerAccountId: { in: [...new Set(groups.map((group) => group.sellerAccountId))] },
          isPickupLocation: true,
          isOperational: true,
        },
      ],
    },
    select: {
      id: true,
      sellerAccountId: true,
      name: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postcode: true,
      countryCode: true,
      latitude: true,
      longitude: true,
      isPickupLocation: true,
      isOperational: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  type SellerLocationRow = (typeof locations)[number];

  const byId = new Map<string, SellerLocationRow>(
    locations.map((location) => [location.id, location]),
  );
  const candidates = new Map<string, SellerLocationRow[]>();

  for (const location of locations) {
    if (!location.isPickupLocation || !location.isOperational) continue;
    const forSeller = candidates.get(location.sellerAccountId) ?? [];
    forSeller.push(location);
    candidates.set(location.sellerAccountId, forSeller);
  }

  for (const group of groups) {
    const forSeller = candidates.get(group.sellerAccountId) ?? [];
    const chosen =
      (group.locationId === null ? undefined : byId.get(group.locationId)) ??
      (forSeller.length === 1 ? forSeller[0] : undefined);

    if (chosen === undefined) continue;

    pickups.set(group.id, {
      contactName: chosen.name,
      address: {
        line1: chosen.addressLine1,
        line2: chosen.addressLine2,
        city: chosen.city,
        region: chosen.region,
        postalCode: chosen.postcode,
        countryCode: chosen.countryCode.toUpperCase(),
        // Decimal on the way out of Prisma, and null where nobody has
        // geocoded the place - which is not the same as 0,0.
        latitude: chosen.latitude === null ? null : Number(chosen.latitude),
        longitude: chosen.longitude === null ? null : Number(chosen.longitude),
      },
    });
  }

  return pickups;
}

/**
 * Raise consignments for an order that is ready to be fulfilled.
 *
 * ONE PER SELLER GROUP, and one for the operator's own lines where there are
 * any. That split is not cosmetic: two sellers' goods leave two buildings, on
 * two days, with two carriers, and a single consignment covering both would be
 * a consignment nobody can collect. An order carrying both the operator's own
 * stock and a seller's raises one of each, for the same reason.
 *
 * Each part is raised INDEPENDENTLY. A seller who has not yet said which of
 * their buildings a parcel leaves from does not hold up the other seller's
 * consignment, or the operator's - theirs is simply not raised yet, and their
 * acceptance raises it. Only when nothing at all can be raised is this
 * refused, and then it says what it is waiting for.
 *
 * Idempotent per part, so a re-delivered confirmation webhook produces nothing
 * new.
 */
export async function createShipmentsForOrder(
  orderId: string,
  createdById: string | null,
): Promise<CreatedShipment[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      shippingAddressJson: true,
      fulfilmentLocationId: true,
      currency: true,
      // Whose goods are on this order. A line with no offer behind it is the
      // operator's own stock, and it is the only thing that makes the
      // operator's warehouse part of the answer - see `hasOperatorLines`.
      items: { select: { sellerOfferId: true } },
      customerProfile: {
        select: {
          id: true,
          // The BUSINESS this is going to, not the individual who ordered it.
          // A carrier delivering to a hospital needs the hospital's name on
          // the paperwork; the buyer's own name is masked to a given name and
          // an initial on the way out - see `logistics-masking.ts`.
          organization: true,
          fullName: true,
          phone: true,
          user: { select: { email: true } },
        },
      },
      fulfilmentLocation: {
        select: { id: true, name: true, addressJson: true, countryCode: true },
      },
      sellerOrderGroups: {
        select: {
          id: true,
          // Where the seller said it ships from, once they have accepted it.
          locationId: true,
          sellerAccount: { select: { id: true, displayName: true } },
        },
      },
    },
  });

  if (order === null) throw notFound('Order');

  const delivery = parseAddress(order.shippingAddressJson);
  if (delivery === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'This order has no usable delivery address, so no consignment can be raised for it.',
      [{ field: 'shippingAddressJson', code: 'ADDRESS_UNUSABLE' }],
    );
  }

  const pickup =
    parseAddress(order.fulfilmentLocation?.addressJson ?? null) ??
    // A warehouse with no structured address still has a country, and a
    // consignment with a named origin and a blank street is more useful to a
    // dispatcher than no consignment at all. They fill the rest in.
    (order.fulfilmentLocation === null
      ? null
      : {
          line1: order.fulfilmentLocation.name,
          city: '',
          postalCode: '',
          countryCode: order.fulfilmentLocation.countryCode ?? delivery.countryCode,
        });

  /*
   * Who the consignment is addressed to.
   *
   * The organisation where there is one, the buyer's own name where there is
   * not - a sole trader ordering for a single-handed practice is an ordinary
   * customer here - and the order number as a last resort, so a consignment is
   * never addressed to an empty string.
   */
  const receivingCompanyName =
    order.customerProfile.organization !== null &&
    order.customerProfile.organization.trim().length > 0
      ? order.customerProfile.organization
      : order.customerProfile.fullName.trim().length > 0
        ? order.customerProfile.fullName
        : order.orderNumber;

  const common = {
    orderId: order.id,
    receivingCustomerProfileId: order.customerProfile.id,
    receivingCompanyName,
    deliveryAddress: delivery,
    deliveryContactName: order.customerProfile.fullName,
    deliveryContactPhone: order.customerProfile.phone,
    deliveryContactEmail: order.customerProfile.user.email,
    currency: order.currency,
    createdById,
  } satisfies Partial<CreateShipmentInput> & { orderId: string };

  const created: CreatedShipment[] = [];
  /** What each unraised part is waiting for, for the refusal at the end. */
  const waiting: string[] = [];

  /*
   * The operator's own goods, where there are any.
   *
   * Read off the lines rather than from the absence of seller groups: an order
   * can carry both, and taking "no groups" to mean "the operator's" raised a
   * consignment from the operator's warehouse for goods that are sitting in
   * somebody else's building.
   */
  const hasOperatorLines = order.items.some((item) => item.sellerOfferId === null);

  if (hasOperatorLines) {
    if (pickup === null) {
      waiting.push('the shop’s own lines have no despatch warehouse');
    } else {
      created.push(
        await createShipment(
          {
            ...common,
            originLocationId: order.fulfilmentLocationId,
            pickupAddress: pickup,
            pickupContactName: order.fulfilmentLocation?.name ?? null,
            sellerCompanyName: order.fulfilmentLocation?.name ?? 'Warehouse',
          },
          {
            orderId: order.id,
            sellerOrderGroupId: null,
            originLocationId: order.fulfilmentLocationId,
          },
        ),
      );
    }
  }

  const sellerPickups = await pickupsForSellerGroups(
    order.sellerOrderGroups.map((group) => ({
      id: group.id,
      locationId: group.locationId,
      sellerAccountId: group.sellerAccount.id,
    })),
  );

  for (const group of order.sellerOrderGroups) {
    const sellerPickup = sellerPickups.get(group.id);

    if (sellerPickup === undefined) {
      waiting.push(
        `${group.sellerAccount.displayName} has not said which of its places this ships from`,
      );
      continue;
    }

    created.push(
      await createShipment(
        {
          ...common,
          sellerOrderGroupId: group.id,
          sellerAccountId: group.sellerAccount.id,
          sellerCompanyName: group.sellerAccount.displayName,
          // A seller's building is not one of the operator's warehouses, so
          // there is no `InventoryLocation` to point at. The snapshot carries
          // the address, which is the whole of what a carrier needs.
          originLocationId: null,
          pickupAddress: sellerPickup.address,
          pickupContactName: sellerPickup.contactName,
        },
        {
          orderId: order.id,
          sellerOrderGroupId: group.id,
          originLocationId: null,
        },
      ),
    );
  }

  if (created.length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      waiting.length === 0
        ? 'This order has nothing to despatch, so no consignment can be raised for it.'
        : `No consignment can be raised for this order yet: ${waiting.join('; ')}.`,
      [{ field: 'fulfilmentLocationId', code: 'ORIGIN_UNKNOWN' }],
    );
  }

  return created;
}

/**
 * Read an address snapshot out of the JSON an order stored.
 *
 * Defensive, because the column is JSON and what comes back is whatever was
 * written - including, on an order imported from elsewhere, something with
 * different key names. Returns null rather than a half-built address: a
 * consignment addressed to `undefined, undefined` is worse than a refusal an
 * operator can act on.
 */
function parseAddress(value: unknown): ShipmentAddressSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;

  const raw = value as Record<string, unknown>;
  const read = (...keys: string[]): string | null => {
    for (const key of keys) {
      const entry = raw[key];
      if (typeof entry === 'string' && entry.trim().length > 0) return entry.trim();
    }
    return null;
  };

  const line1 = read('line1', 'addressLine1', 'street', 'address1');
  const countryCode = read('countryCode', 'country');

  if (line1 === null || countryCode === null || countryCode.length !== 2) return null;

  return {
    line1,
    line2: read('line2', 'addressLine2', 'address2'),
    city: read('city', 'town', 'locality') ?? '',
    region: read('region', 'state', 'province'),
    postalCode: read('postalCode', 'postcode', 'zip') ?? '',
    countryCode: countryCode.toUpperCase(),
  };
}

/**
 * Apply a carrier's SLA policy to a consignment, once it has a carrier.
 *
 * Deliberately NOT done at creation: the promise depends on who is carrying
 * it, and at creation nobody is. Called by the assignment path after an
 * acceptance, which is the first moment both facts exist.
 */
export async function applySlaPolicy(
  shipmentId: string,
  logisticsPartnerId: string,
): Promise<void> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, serviceType: true, acceptedAt: true, pickedUpAt: true },
  });

  if (shipment === null) return;

  const policy =
    (await prisma.logisticsSlaPolicy.findFirst({
      where: { logisticsPartnerId, serviceType: shipment.serviceType, isActive: true },
      orderBy: { isDefault: 'desc' },
      select: { id: true, pickupHours: true, deliveryHours: true },
    })) ??
    (await prisma.logisticsSlaPolicy.findFirst({
      where: { logisticsPartnerId, isDefault: true, isActive: true },
      select: { id: true, pickupHours: true, deliveryHours: true },
    }));

  if (policy === null) return;

  const anchor = shipment.acceptedAt ?? new Date();

  await prisma.logisticsShipment.update({
    where: { id: shipment.id },
    data: {
      slaPolicyId: policy.id,
      pickupDueAt: dueAtFrom(anchor, policy.pickupHours),
      // Delivery is measured from COLLECTION where the parcel has been
      // collected, and from acceptance before that. A carrier that has not
      // collected yet is already burning its delivery window, which is what an
      // operator wants to see.
      deliveryDueAt: dueAtFrom(shipment.pickedUpAt ?? anchor, policy.deliveryHours),
    },
  });
}
