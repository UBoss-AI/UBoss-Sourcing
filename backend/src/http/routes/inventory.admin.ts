/**
 * Admin inventory routes.
 *
 * The service layer and its ledger were built in Prompt 1 step 5; this is the
 * HTTP surface the Admin Panel's Inventory screen needs.
 *
 * One rule shapes every route here: **computed balances are never writable.**
 * `onHandQty` and `reservedQty` are the result of the movement ledger. The API
 * exposes receipts and adjustments, which append movements; it exposes no way
 * to set a balance directly. An admin who could type a number into on-hand
 * could erase the audit trail that explains where stock went.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { Permission } from '../../domain/permissions.js';
import { variantKeyOf } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  adjustStock,
  getAvailability,
  receiveStock,
} from '../../modules/inventory/inventory.service.js';
import {
  ERP_SYNC_STATUSES,
  OPERATIONAL_STATUSES,
  createWarehouse,
  deleteWarehouse,
  forwardGeocode,
  listWarehouses,
  mapConfig,
  recordErpSync,
  updateWarehouse,
} from '../../modules/inventory/location.service.js';
import { deliveryCoverage } from '../../modules/inventory/delivery-coverage.service.js';
import { warehouseInventory } from '../../modules/inventory/warehouse-inventory.service.js';
import { isoCountries } from '../../domain/country-boundaries.js';
import { env } from '../../config/env.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

/**
 * The largest radius this endpoint will measure.
 *
 * Not a business rule - `DELIVERY_COVERAGE_RADIUS_KM` is that - but a guard on
 * the work one request can ask for. A radius of a few thousand kilometres
 * intersects most of a continent, and the reply would carry a hundred
 * countries' clipped polygons to draw a promise nobody makes. 1,000 km is
 * comfortably past any same-week delivery claim.
 */
const MAX_COVERAGE_RADIUS_KM = 1000;

const stockKeySchema = z.object({
  productId: z.string().length(26),
  variantId: z.string().length(26).nullable().optional(),
  locationId: z.string().length(26).optional(),
});

/**
 * A warehouse's street address. Free text: it is written to be read.
 *
 * The country is not in here - it is a top-level field with a foreign key to
 * `countries`, because the console filters and searches on it. See the
 * 20260908140000 migration.
 */
const warehouseAddressSchema = z.object({
  line1: z.string().trim().max(160).nullable().optional(),
  line2: z.string().trim().max(160).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  region: z.string().trim().max(120).nullable().optional(),
  postalCode: z.string().trim().max(32).nullable().optional(),
});

const operationalStatusSchema = z.enum(OPERATIONAL_STATUSES);

/**
 * A warehouse, as create sends it. `.partial()` of this is what update takes.
 *
 * Every coordinate field is nullable *and* optional, and the two do not mean
 * the same thing: absent leaves the position alone, explicit null unplaces the
 * warehouse. Without that distinction a PATCH that renamed a building would
 * silently take it off the map.
 *
 * The ranges are checked here, again in the service, and again by a CHECK
 * constraint. The duplication is deliberate - this is the only one of the
 * three that can put the message on the field somebody typed in.
 */
const warehouseSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(128),
  address: warehouseAddressSchema.nullable().optional(),
  // Two letters here, and checked against the `countries` table in the
  // service. "XX" passes this and names nothing, which is why the shape is not
  // the whole test.
  countryCode: z.string().trim().length(2).toUpperCase().nullable().optional(),
  // An IANA zone name. Validated against ICU in the service, because a list of
  // zone names in this file would be out of date the next time a country
  // changes its rules.
  timezone: z.string().trim().max(64).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  operationalStatus: operationalStatusSchema.optional(),
  erpExternalId: z.string().trim().max(64).nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),

  /**
   * The geofence, in kilometres.
   *
   * Nullable *and* optional, the same distinction the coordinates carry:
   * absent leaves the stored radius alone, explicit null puts the warehouse
   * back on the deployment's default. Without the difference, a PATCH that
   * renamed a building would silently change what it promises.
   *
   * The ceiling here is the commercial one from the service, not the
   * database's physical bound - see MAX_DELIVERY_RADIUS_KM in
   * location.service.ts.
   */
  deliveryRadiusKm: z.number().int().min(1).max(2000).nullable().optional(),

  /** The lead-time window in days. Both, or neither - checked in the service. */
  deliveryLeadTimeMinDays: z.number().int().min(0).max(365).nullable().optional(),
  deliveryLeadTimeMaxDays: z.number().int().min(0).max(365).nullable().optional(),

  /**
   * The delivery fee, in minor units, as a digit string.
   *
   * A string and not a number, because that is how money crosses this API
   * everywhere: a JSON number cannot hold a paise-exact amount past 2^53, and
   * accepting one here would be the one place a float could get into a money
   * path. Parsed to BigInt in the service.
   */
  deliveryFeeMinor: z
    .string()
    .trim()
    .regex(/^\d+$/, 'A delivery fee is a whole number of minor units.')
    .max(19)
    .nullable()
    .optional(),
  deliveryFeeCurrency: z.string().trim().length(3).toUpperCase().nullable().optional(),

  /**
   * The countries this warehouse will not deliver to - the whole list.
   *
   * Replaces the stored set; `[]` clears it; absent leaves it alone. Not an
   * add/remove pair, because a delta computed in the browser from a list that
   * has gone stale closes the wrong country. The codes are checked against ISO
   * 3166-1 in the service rather than against the `countries` reference table,
   * which is a much shorter list - see the model comment on
   * `WarehouseCountryExclusion`.
   *
   * Capped at 250 entries: there are fewer countries than that, so a longer
   * list is a bug in the caller rather than an operator with a lot of opinions.
   */
  excludedCountries: z
    .array(
      z.object({
        code: z.string().trim().length(2).toUpperCase(),
        reason: z.string().trim().max(256).nullable().optional(),
      }),
    )
    .max(250)
    .optional(),

  /**
   * The lanes this warehouse delivers on - the whole list.
   *
   * Replaces the stored set, `[]` clears it, absent leaves it alone: the
   * same contract as `excludedCountries` above, and for the same reason.
   *
   * **This is what decides whether checkout offers this warehouse**, which
   * the radius above deliberately does not. See `WarehouseDeliveryZone` in
   * the schema. Capped at 500: an operator with more lanes than that on one
   * building is describing a carrier's rate card rather than a warehouse,
   * and should be importing it rather than typing it into a form.
   */
  deliveryZones: z
    .array(
      z.object({
        countryCode: z.string().trim().length(2).toUpperCase(),
        /** Comma-separated prefixes. Empty means the whole country. */
        postalPrefixes: z.string().trim().max(512).nullable().optional(),
        carrierName: z.string().trim().min(1).max(64),
        serviceLevel: z.string().trim().min(1).max(64),
        handlingDays: z.number().int().min(0).max(90).optional(),
        transitMinDays: z.number().int().min(0).max(365),
        transitMaxDays: z.number().int().min(0).max(365),
        usesBusinessDays: z.boolean().optional(),
        // Money as a digit string, as everywhere else in this API: a JSON
        // number cannot hold a paise-exact amount past 2^53.
        shippingFeeMinor: z
          .string()
          .trim()
          .regex(/^[0-9]+$/, 'A delivery fee is a whole number of minor units.')
          .max(19)
          .optional(),
        shippingFeeCurrency: z.string().trim().length(3).toUpperCase(),
        freeAboveMinor: z
          .string()
          .trim()
          .regex(/^[0-9]+$/, 'A free-delivery threshold is a whole number of minor units.')
          .max(19)
          .nullable()
          .optional(),
        supportsColdChain: z.boolean().optional(),
        maxWeightGrams: z.number().int().min(1).max(100_000_000).nullable().optional(),
        isActive: z.boolean().optional(),
        priority: z.number().int().min(0).max(1000).optional(),
      }),
    )
    .max(500)
    .optional(),
});

/**
 * The delivery settings, forwarded only where the caller mentioned them.
 *
 * Shared by POST and PATCH because they must behave identically: absent leaves
 * the stored value alone and explicit null clears it, and a service that
 * cannot tell the two apart would let a PATCH renaming a warehouse blank its
 * geofence. Written once rather than twice so the two routes cannot drift.
 *
 * `exactOptionalPropertyTypes` is why this spreads instead of assigning: a key
 * present with the value `undefined` is not the same as an absent key to the
 * service's `?? before.x` reads.
 */
function deliveryFields(body: {
  deliveryRadiusKm?: number | null;
  deliveryLeadTimeMinDays?: number | null;
  deliveryLeadTimeMaxDays?: number | null;
  deliveryFeeMinor?: string | null;
  deliveryFeeCurrency?: string | null;
  excludedCountries?: { code: string; reason?: string | null }[];
  deliveryZones?: {
    countryCode: string;
    postalPrefixes?: string | null;
    carrierName: string;
    serviceLevel: string;
    handlingDays?: number;
    transitMinDays: number;
    transitMaxDays: number;
    usesBusinessDays?: boolean;
    shippingFeeMinor?: string;
    shippingFeeCurrency: string;
    freeAboveMinor?: string | null;
    supportsColdChain?: boolean;
    maxWeightGrams?: number | null;
    isActive?: boolean;
    priority?: number;
  }[];
}): {
  deliveryRadiusKm?: number | null;
  deliveryLeadTimeMinDays?: number | null;
  deliveryLeadTimeMaxDays?: number | null;
  deliveryFeeMinor?: string | null;
  deliveryFeeCurrency?: string | null;
  excludedCountries?: { code: string; reason?: string | null }[];
  deliveryZones?: {
    countryCode: string;
    postalPrefixes?: string | null;
    carrierName: string;
    serviceLevel: string;
    handlingDays?: number;
    transitMinDays: number;
    transitMaxDays: number;
    usesBusinessDays?: boolean;
    shippingFeeMinor?: string;
    shippingFeeCurrency: string;
    freeAboveMinor?: string | null;
    supportsColdChain?: boolean;
    maxWeightGrams?: number | null;
    isActive?: boolean;
    priority?: number;
  }[];
} {
  return {
    ...(body.deliveryRadiusKm === undefined ? {} : { deliveryRadiusKm: body.deliveryRadiusKm }),
    ...(body.deliveryLeadTimeMinDays === undefined
      ? {}
      : { deliveryLeadTimeMinDays: body.deliveryLeadTimeMinDays }),
    ...(body.deliveryLeadTimeMaxDays === undefined
      ? {}
      : { deliveryLeadTimeMaxDays: body.deliveryLeadTimeMaxDays }),
    ...(body.deliveryFeeMinor === undefined ? {} : { deliveryFeeMinor: body.deliveryFeeMinor }),
    ...(body.deliveryFeeCurrency === undefined
      ? {}
      : { deliveryFeeCurrency: body.deliveryFeeCurrency }),
    ...(body.excludedCountries === undefined
      ? {}
      : { excludedCountries: body.excludedCountries }),
    ...(body.deliveryZones === undefined ? {} : { deliveryZones: body.deliveryZones }),
  };
}

function actorFrom(request: FastifyRequest): {
  userId: string;
  email: string;
  ipAddress: string;
  correlationId: string;
} {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

export function registerAdminInventoryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Stock levels, one row per SKU and location.
   *
   * Joined to the product so the screen can show name, SKU and threshold
   * without a second round trip per row.
   */
  app.get(
    '/inventory',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (request, reply) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          q: z.string().trim().max(120).optional(),
          locationId: z.string().length(26).optional(),
          lowStockOnly: z.enum(['true', 'false']).default('false'),
        })
        .parse(request.query);

      const where = {
        product: {
          archivedAt: null,
          isStockTracked: true,
          ...(query.q !== undefined && query.q.length > 0
            ? { OR: [{ name: { contains: query.q } }, { sku: { contains: query.q } }] }
            : {}),
        },
        ...(query.locationId !== undefined ? { locationId: query.locationId } : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.inventoryBalance.findMany({
          where,
          // `id` as a tiebreaker keeps pagination stable.
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          include: {
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                reorderThreshold: true,
                basePriceMinor: true,
                currency: true,
              },
            },
            variant: { select: { id: true, name: true, sku: true } },
            location: { select: { id: true, code: true, name: true } },
          },
        }),
        prisma.inventoryBalance.count({ where }),
      ]);

      const mapped = rows.map((row) => {
        const available = row.onHandQty - row.reservedQty;
        const isLowStock =
          row.product.reorderThreshold > 0 && available <= row.product.reorderThreshold;

        return {
          balanceId: row.id,
          productId: row.product.id,
          productName: row.product.name,
          sku: row.variant?.sku ?? row.product.sku,
          variantId: row.variant?.id ?? null,
          variantName: row.variant?.name ?? null,
          location: row.location,
          onHandQty: row.onHandQty,
          reservedQty: row.reservedQty,
          // Derived, and clearly labelled as such: the UI must show this as
          // read-only, not as an editable field.
          availableQty: available,
          reorderThreshold: row.product.reorderThreshold,
          isLowStock,
          unitPrice: serialiseMoney(row.product.basePriceMinor, row.product.currency),
          valuation: serialiseMoney(
            row.product.basePriceMinor * BigInt(row.onHandQty),
            row.product.currency,
          ),
          updatedAt: row.updatedAt.toISOString(),
        };
      });

      // Filtering on a derived value has to happen after the join. The page is
      // capped at 100 rows, so this is bounded work.
      const filtered = query.lowStockOnly === 'true' ? mapped.filter((row) => row.isLowStock) : mapped;

      return reply.status(200).send({
        inventory: filtered,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      });
    },
  );

  /** Live availability for one SKU. Used by the receipt and adjustment dialogs. */
  app.get(
    '/inventory/availability',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (request, reply) => {
      const query = stockKeySchema.parse(request.query);

      const product = await prisma.product.findUnique({
        where: { id: query.productId },
        select: { id: true, name: true, sku: true, isStockTracked: true, archivedAt: true },
      });

      if (product === null || product.archivedAt !== null) throw notFound('Product');

      if (!product.isStockTracked) {
        throw badRequest(
          ErrorCode.STOCK_NOT_TRACKED,
          `${product.name} is not stock-tracked, so it has no balance.`,
          [{ field: 'productId', code: 'NOT_TRACKED' }],
        );
      }

      const availability = await getAvailability({
        productId: query.productId,
        variantId: query.variantId ?? null,
        ...(query.locationId !== undefined ? { locationId: query.locationId } : {}),
      });

      return reply.status(200).send({
        product: { id: product.id, name: product.name, sku: product.sku },
        ...availability,
      });
    },
  );

  /**
   * Movement history.
   *
   * The append-only ledger. Every row names the actor, the reason and the
   * order or reference that caused it - which is what makes a stock
   * discrepancy investigable rather than a mystery.
   */
  app.get(
    '/inventory/movements',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (request, reply) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          productId: z.string().length(26).optional(),
          variantId: z.string().length(26).optional(),
          locationId: z.string().length(26).optional(),
          type: z
            .enum([
              'RECEIPT',
              'ADJUSTMENT',
              'RESERVATION_COMMIT',
              'ORDER_CANCEL_RESTOCK',
              'RETURN_RESTOCK',
              'RETURN_QUARANTINE',
              'SYNC_CORRECTION',
            ])
            .optional(),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        })
        .parse(request.query);

      const where = {
        ...(query.productId !== undefined ? { productId: query.productId } : {}),
        ...(query.variantId !== undefined
          ? { variantKey: variantKeyOf(query.variantId) }
          : {}),
        ...(query.locationId !== undefined ? { locationId: query.locationId } : {}),
        ...(query.type !== undefined ? { type: query.type } : {}),
        ...(query.from !== undefined || query.to !== undefined
          ? {
              createdAt: {
                ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
                ...(query.to !== undefined ? { lt: new Date(query.to) } : {}),
              },
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.inventoryMovement.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          include: {
            product: { select: { id: true, name: true, sku: true } },
            variant: { select: { id: true, name: true, sku: true } },
            location: { select: { id: true, code: true } },
          },
        }),
        prisma.inventoryMovement.count({ where }),
      ]);

      // The actor is stored as an id; resolve the emails in one query rather
      // than per row.
      const actorIds = [
        ...new Set(rows.map((row) => row.actorUserId).filter((id): id is string => id !== null)),
      ];

      const actors =
        actorIds.length === 0
          ? []
          : await prisma.user.findMany({
              where: { id: { in: actorIds } },
              select: { id: true, email: true },
            });

      const emailById = new Map(actors.map((actor) => [actor.id, actor.email]));

      return reply.status(200).send({
        movements: rows.map((row) => ({
          id: row.id,
          type: row.type,
          product: row.product,
          variant: row.variant,
          location: row.location,
          quantityDelta: row.quantityDelta,
          resultingOnHand: row.resultingOnHand,
          reason: row.reason,
          referenceType: row.referenceType,
          referenceId: row.referenceId,
          actorType: row.actorType,
          actorUserId: row.actorUserId,
          actorEmail: row.actorUserId === null ? null : (emailById.get(row.actorUserId) ?? null),
          createdAt: row.createdAt.toISOString(),
        })),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      });
    },
  );

  /**
   * Receive stock.
   *
   * Positive only. Correcting a mistaken receipt is an adjustment with a
   * reason, not a negative receipt - the ledger should say what happened.
   */
  app.post(
    '/inventory/receipts',
    { preHandler: requireAdmin(Permission.INVENTORY_RECEIVE) },
    async (request, reply) => {
      const body = stockKeySchema
        .extend({
          quantity: z.number().int().min(1).max(10_000_000),
          reference: z.string().max(128).nullable().optional(),
          note: z.string().max(512).nullable().optional(),
        })
        .parse(request.body);

      const result = await receiveStock(
        {
          productId: body.productId,
          variantId: body.variantId ?? null,
          ...(body.locationId !== undefined ? { locationId: body.locationId } : {}),
          quantity: body.quantity,
          reference: body.reference ?? null,
          note: body.note ?? null,
        },
        actorFrom(request),
      );

      return reply.status(201).send(result);
    },
  );

  /**
   * Adjust stock.
   *
   * A reason is mandatory (SOP §6). An adjustment can conjure or destroy
   * stock, so an unexplained one is indistinguishable from theft or a
   * data-entry error.
   */
  app.post(
    '/inventory/adjustments',
    { preHandler: requireAdmin(Permission.INVENTORY_ADJUST) },
    async (request, reply) => {
      const body = stockKeySchema
        .extend({
          // Signed and non-zero. Refusing 0 here gives a field-level error
          // rather than letting the service reject it generically.
          quantityDelta: z
            .number()
            .int()
            .min(-10_000_000)
            .max(10_000_000)
            .refine((value) => value !== 0, 'An adjustment cannot be zero.'),
          reason: z.string().trim().min(1).max(512),
        })
        .parse(request.body);

      const result = await adjustStock(
        {
          productId: body.productId,
          variantId: body.variantId ?? null,
          ...(body.locationId !== undefined ? { locationId: body.locationId } : {}),
          quantityDelta: body.quantityDelta,
          reason: body.reason,
        },
        actorFrom(request),
      );

      return reply.status(201).send(result);
    },
  );

  /** Locations, for the receipt and adjustment dialogs. */
  app.get(
    '/inventory/locations',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (_request, reply) => {
      const locations = await prisma.inventoryLocation.findMany({
        where: { isActive: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: { id: true, code: true, name: true, isDefault: true },
      });

      return reply.status(200).send({ locations });
    },
  );

  /**
   * Warehouses, for the screen that manages them and draws them on a map.
   *
   * Deliberately not the same endpoint as `/inventory/locations` above, which
   * fills the pickers on the Inventory screen. That one answers "where may I
   * send this stock" and must never offer a retired warehouse; this one
   * answers "what warehouses does this business have", and has to include the
   * retired ones or bringing one back would be impossible from the panel.
   * They also cost different amounts - the stock roll-up here is three
   * aggregate queries, and a dropdown should not pay for them.
   *
   * What to draw the warehouses on travels with them rather than sitting
   * behind a request of its own. One response fills the whole screen, and the
   * alternative is a map that renders bare and reflows when a second request
   * lands. It also decides which map library the browser downloads, so it has
   * to arrive before the map component mounts rather than after.
   */
  app.get(
    '/inventory/warehouses',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (request, reply) => {
      const query = z
        .object({
          includeInactive: z.enum(['true', 'false']).default('true'),
          /** Matched against name, code and the country's name. */
          q: z.string().trim().max(120).optional(),
          countryCode: z.string().trim().length(2).toUpperCase().optional(),
          /**
           * Repeatable, so `?status=OPERATIONAL&status=LIMITED` narrows to
           * two. Fastify hands a single occurrence over as a string and
           * several as an array; both are coerced to an array here so the
           * service sees one shape.
           */
          status: z
            .union([z.enum(OPERATIONAL_STATUSES), z.array(z.enum(OPERATIONAL_STATUSES))])
            .optional(),
        })
        .parse(request.query);

      const warehouses = await listWarehouses({
        includeInactive: query.includeInactive === 'true',
        ...(query.q === undefined ? {} : { search: query.q }),
        ...(query.countryCode === undefined ? {} : { countryCode: query.countryCode }),
        ...(query.status === undefined
          ? {}
          : { operationalStatus: Array.isArray(query.status) ? query.status : [query.status] }),
      });

      return reply.status(200).send({
        warehouses,
        // What to draw them on: a Google map, a raster tile layer, or nothing
        // at all. `{ provider: 'NONE' }` is the default rather than a
        // fallback, and the panel reads it as "plot the markers on a plain
        // grid" - see `MapConfig` in location.service.ts for why.
        //
        // Carried in this response rather than behind a request of its own,
        // for the same reason the warehouses and their stock roll-up are: one
        // response fills the whole screen, and the alternative is a map that
        // renders bare and then reflows when a second request lands.
        map: mapConfig(),
        // How far this deployment says it delivers, which the panel needs
        // before it can label a single thing "delivers to". It travels here
        // rather than in /config because that endpoint is the *storefront's*
        // public configuration, built from an allowlist, and where a
        // wholesaler's vans reach is not something to publish to anonymous
        // visitors. See DELIVERY_COVERAGE_RADIUS_KM in config/env.ts.
        coverage: { radiusKm: env.DELIVERY_COVERAGE_RADIUS_KM },
      });
    },
  );

  /**
   * Open a warehouse.
   *
   * Its own permission rather than INVENTORY_RECEIVE: this is master data, and
   * the code created here is stamped on every movement ever booked against the
   * place. See `INVENTORY_LOCATION_WRITE` in domain/permissions.ts.
   */
  app.post(
    '/inventory/warehouses',
    { preHandler: requireAdmin(Permission.INVENTORY_LOCATION_WRITE) },
    async (request, reply) => {
      const body = warehouseSchema.parse(request.body);

      const warehouse = await createWarehouse(
        {
          code: body.code,
          name: body.name,
          ...(body.address === undefined ? {} : { address: body.address }),
          ...(body.countryCode === undefined ? {} : { countryCode: body.countryCode }),
          ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
          ...(body.latitude === undefined ? {} : { latitude: body.latitude }),
          ...(body.longitude === undefined ? {} : { longitude: body.longitude }),
          ...(body.operationalStatus === undefined
            ? {}
            : { operationalStatus: body.operationalStatus }),
          ...(body.erpExternalId === undefined ? {} : { erpExternalId: body.erpExternalId }),
          ...(body.isDefault === undefined ? {} : { isDefault: body.isDefault }),
          ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
          ...deliveryFields(body),
        },
        actorFrom(request),
      );

      return reply.status(201).send({ warehouse });
    },
  );

  /**
   * Correct a warehouse, move it, retire it, or make it the default.
   *
   * Retiring is `isActive: false`, and it is refused while the place still
   * holds stock - see `assertRetirable` in the service. It is the answer for
   * any warehouse that has been used; the DELETE below only removes one that
   * never was.
   */
  app.patch(
    '/inventory/warehouses/:id',
    { preHandler: requireAdmin(Permission.INVENTORY_LOCATION_WRITE) },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26) }).parse(request.params);
      const body = warehouseSchema.partial().parse(request.body);

      const warehouse = await updateWarehouse(
        params.id,
        {
          ...(body.code === undefined ? {} : { code: body.code }),
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.address === undefined ? {} : { address: body.address }),
          ...(body.countryCode === undefined ? {} : { countryCode: body.countryCode }),
          ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
          ...(body.latitude === undefined ? {} : { latitude: body.latitude }),
          ...(body.longitude === undefined ? {} : { longitude: body.longitude }),
          ...(body.operationalStatus === undefined
            ? {}
            : { operationalStatus: body.operationalStatus }),
          ...(body.erpExternalId === undefined ? {} : { erpExternalId: body.erpExternalId }),
          ...(body.isDefault === undefined ? {} : { isDefault: body.isDefault }),
          ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
          ...deliveryFields(body),
        },
        actorFrom(request),
      );

      return reply.status(200).send({ warehouse });
    },
  );

  /**
   * Delete a warehouse that was never used.
   *
   * Narrow on purpose, and the narrowness is the feature. This removes the
   * duplicate somebody created with a typo in its code and the site that was
   * planned and never opened - a row nothing has ever been booked against.
   * The moment a movement, a balance, a reservation or a scheduled order
   * points at it, the answer is `LOCATION_HAS_HISTORY` and a message naming
   * what is in the way, and retiring through the PATCH above is what the
   * operator wants instead. Deleting a warehouse with history would leave the
   * ledger unable to say where that stock went, which is a worse outcome than
   * a tidy list.
   *
   * The default warehouse is refused too, whatever its history: unqualified
   * receipts land there, and a deployment with no default cannot book stock at
   * all. Since the only warehouse is always the default, that is also what
   * stops the last one being deleted.
   *
   * 404 for a warehouse that is not there, which is also the answer to a
   * second press of the button - and the right one, because the row is gone
   * either way.
   */
  app.delete(
    '/inventory/warehouses/:id',
    { preHandler: requireAdmin(Permission.INVENTORY_LOCATION_WRITE) },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26) }).parse(request.params);

      await deleteWarehouse(params.id, actorFrom(request));

      return reply.status(200).send({ deleted: true });
    },
  );

  /**
   * The countries a warehouse may be in, for the form and the filter.
   *
   * Read from `countries` rather than shipped as a list in the frontend: that
   * table is what already decides a country's currency, its interface
   * language and whether it is inside the EU VAT area, and a second list in
   * the browser is a second list to get wrong.
   */
  app.get(
    '/inventory/warehouse-countries',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (_request, reply) => {
      const countries = await prisma.country.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { code: true, name: true },
      });

      return reply.status(200).send({ countries });
    },
  );

  /**
   * Which countries this warehouse can deliver to inside a radius.
   *
   * Its own request rather than a field on the warehouses list, and that is
   * about cost: this walks real country polygons, and doing it for every
   * warehouse on a screen that lists twenty would be twenty times the work for
   * a panel that only ever shows one at a time. It is asked for when somebody
   * points at a warehouse, and the answer is small.
   *
   * INVENTORY_READ, the same permission as the list it is opened from. This
   * discloses no stock, no money and no customer - it is the geography of a
   * building whose coordinates the caller can already see.
   *
   * **The radius is a parameter with a configured default**, because "how far
   * do we deliver" is the operator's promise and not this repository's. See
   * DELIVERY_COVERAGE_RADIUS_KM in config/env.ts.
   */
  app.get(
    '/inventory/warehouses/:id/delivery-coverage',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26) }).parse(request.params);

      const query = z
        .object({
          /**
           * Coerced rather than parsed as a number, because it arrives as a
           * string in a query. Fractional values are accepted - a 12.5 km
           * urban radius is a real thing - and the bounds are what stop a
           * request asking for the whole hemisphere.
           *
           * **No default any more.** Omitting it means "measure what this
           * warehouse actually promises", which is its own `deliveryRadiusKm`
           * and the deployment's default where it has none - resolved in the
           * service, in one place. Filling a default in here would have made
           * every caller that simply wants the truth pass a number, and the
           * moment one of them passed the wrong one the panel would be drawing
           * a ring the warehouse does not stand behind. The panel still sends
           * one, because its slider is how an operator tries a radius before
           * committing to it.
           */
          radiusKm: z.coerce.number().positive().max(MAX_COVERAGE_RADIUS_KM).optional(),
        })
        .parse(request.query);

      const coverage = await deliveryCoverage({
        warehouseId: params.id,
        ...(query.radiusKm === undefined ? {} : { radiusKm: query.radiusKm }),
      });

      return reply.status(200).send(coverage);
    },
  );

  /**
   * Every country there is, for the exclusion picker.
   *
   * **Not `/inventory/warehouse-countries` above, and the difference matters.**
   * That one lists the countries this deployment *prices in* - the reference
   * table, a few dozen rows with a currency behind each - and it is the right
   * list for "where is this warehouse". This one is the ISO 3166-1 list, all
   * two hundred and fifty of it, and it is the right list for "which countries
   * may this warehouse be told not to deliver to": a 500 km circle reaches
   * countries nobody has ever sold into, and those are exactly the ones an
   * operator most wants to close. A picker built from the reference table
   * would offer forty and hide the rest.
   *
   * Static for the life of the process - it is a list of countries, not of
   * anything this deployment owns - so it carries a long cache header. The
   * browser asks once.
   */
  app.get(
    '/inventory/world-countries',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (_request, reply) => {
      return reply
        .header('cache-control', 'private, max-age=86400')
        .status(200)
        .send({ countries: isoCountries() });
    },
  );

  /**
   * Everything one warehouse holds, product by product.
   *
   * The screen behind "click a warehouse, see its inventory". Distinct from
   * `GET /inventory?locationId=`, which pages over *balance rows* - and so
   * cannot show a product the warehouse has none of, because there is no row
   * to show. This is driven from the catalogue, so every product appears for
   * every warehouse and an absence is visible as an absence. See the header of
   * `warehouse-inventory.service.ts`.
   *
   * INVENTORY_READ: it is the same stock the Inventory screen already shows,
   * arranged differently.
   */
  app.get(
    '/inventory/warehouses/:id/inventory',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26) }).parse(request.params);

      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          // Products per page, not SKUs - a page boundary never falls inside
          // one product's variants.
          limit: z.coerce.number().int().min(1).max(100).default(25),
          q: z.string().trim().max(120).optional(),
          categoryId: z.string().length(26).optional(),
          presence: z
            .enum(['ALL', 'IN_STOCK', 'OUT_OF_STOCK', 'LOW_STOCK', 'NEVER_STOCKED'])
            .default('ALL'),
        })
        .parse(request.query);

      const inventory = await warehouseInventory({
        warehouseId: params.id,
        page: query.page,
        limit: query.limit,
        presence: query.presence,
        ...(query.q === undefined ? {} : { search: query.q }),
        ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      });

      return reply.status(200).send(inventory);
    },
  );

  /**
   * Where a warehouse stands with the ERP.
   *
   * A separate route because it has a separate writer: this is called by
   * whatever syncs stock with the ERP, and the warehouse form deliberately
   * cannot reach these columns. A sync state somebody typed into a form is a
   * sync state that lies - the whole value of the field is that the thing
   * which did the syncing is what wrote it.
   *
   * PUT rather than PATCH: a report replaces the warehouse's sync state
   * outright. There is no merging two connectors' opinions about it.
   */
  app.put(
    '/inventory/warehouses/:id/erp-status',
    { preHandler: requireAdmin(Permission.INVENTORY_LOCATION_WRITE) },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26) }).parse(request.params);

      const body = z
        .object({
          status: z.enum(ERP_SYNC_STATUSES),
          message: z.string().trim().max(512).nullable().optional(),
          /** When the work actually happened, for a connector that batches. */
          syncedAt: z.string().datetime().optional(),
        })
        .parse(request.body);

      const warehouse = await recordErpSync(
        params.id,
        {
          status: body.status,
          ...(body.message === undefined ? {} : { message: body.message }),
          ...(body.syncedAt === undefined ? {} : { syncedAt: new Date(body.syncedAt) }),
        },
        actorFrom(request),
      );

      return reply.status(200).send({ warehouse });
    },
  );

  /**
   * An address to coordinates, so nobody has to look up a warehouse's
   * latitude by hand.
   *
   * A POST rather than a GET with a query parameter, even though it changes
   * nothing here: the address would otherwise sit in this server's access log
   * and in any proxy's in front of it, and a body keeps it out of both.
   *
   * Answers 200 with `{ result: null }` when nothing was found, when no
   * geocoder is configured, and when the one that is configured did not answer
   * in time. None of those is an error for this endpoint - the caller is a
   * convenience button beside two fields somebody can always type - and a 502
   * for a slow third party would put a red banner on a screen that is working
   * exactly as intended.
   */
  app.post(
    '/inventory/warehouses/geocode',
    { preHandler: requireAdmin(Permission.INVENTORY_LOCATION_WRITE) },
    async (request, reply) => {
      const body = z.object({ query: z.string().trim().min(1).max(512) }).parse(request.body);

      const result = await forwardGeocode(body.query);

      return reply.status(200).send({ result });
    },
  );

  return Promise.resolve();
}
