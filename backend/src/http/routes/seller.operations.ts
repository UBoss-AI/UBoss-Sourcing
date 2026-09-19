/**
 * Running the shop: the dashboard, stock, places, orders and money.
 *
 * One file because these are one workspace to a seller and because the guards
 * are the interesting part - each route declares the narrowest permission that
 * covers it, so a Finance Viewer reading settlements cannot reach the stock
 * adjustment two routes below it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { prisma } from '../../infra/prisma.js';
import { readDashboard } from '../../modules/seller/dashboard.service.js';
import {
  listInventory,
  listMovements,
  recordStockMovement,
  updateStockSettings,
} from '../../modules/seller/inventory.service.js';
import {
  forwardGeocode,
  mapConfig,
  suggestAddresses,
} from '../../modules/inventory/location.service.js';
import {
  archiveLocation,
  createLocation,
  listLocations,
  updateLocation,
} from '../../modules/seller/location.service.js';
import {
  listSellerOrders,
  readSellerOrder,
  recordShipment,
  transitionSellerOrder,
} from '../../modules/seller/order.service.js';
import {
  readPayoutAccount,
  refreshPayoutStep,
  startPayoutOnboarding,
} from '../../modules/seller/payout.service.js';
import { currentSeller, requireSeller, requireTradingSeller } from '../plugins/seller.js';

const idParam = z.object({ id: z.string().length(26) });

const locationSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(160),
  addressLine1: z.string().trim().min(1).max(255),
  addressLine2: z.string().trim().max(255).nullable().optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).nullable().optional(),
  postcode: z.string().trim().min(1).max(24),
  countryCode: z.string().trim().length(2).toUpperCase(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  timezone: z.string().trim().max(64).nullable().optional(),
  isPickupLocation: z.boolean().optional(),
  isReturnLocation: z.boolean().optional(),
  dispatchCutoff: z.string().trim().max(5).nullable().optional(),
  workingDaysMask: z.number().int().min(0).max(127).nullable().optional(),
  handlingTimeDays: z.number().int().min(0).max(365).nullable().optional(),
  shipsToCountries: z.array(z.string().trim().length(2).toUpperCase()).max(250).nullable().optional(),
  hasColdChain: z.boolean().optional(),
  hasControlledStorage: z.boolean().optional(),
  hasSterileStorage: z.boolean().optional(),
});

export function registerSellerOperationsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSeller());

  // --- Dashboard ----------------------------------------------------------

  /**
   * No cache header, ever.
   *
   * Every number here is the reason a seller opened the page - new orders,
   * overdue dispatches, stock that ran out. A proxy holding "3 new orders" for
   * sixty seconds is sixty seconds of a seller not packing an order.
   */
  app.get('/dashboard', async (request, reply) => {
    const query = z
      .object({ range: z.enum(['today', 'week', 'month', 'quarter']).default('today') })
      .parse(request.query);

    const dashboard = await readDashboard(currentSeller(request), query.range);
    return reply.header('cache-control', 'no-store').status(200).send(dashboard);
  });

  // --- Places -------------------------------------------------------------

  /**
   * The seller's dispatch addresses, and the map they are drawn on.
   *
   * The map settings travel with the list rather than from a second request,
   * for the same reason the console's warehouses response carries them: they
   * are the operator's, they cannot change while a screen is open, and a
   * separate call for them would be a round trip for a string.
   *
   * They are not on the public `/config` either, and that is deliberate. The
   * Google path carries the deployment's API key, and a key on an endpoint
   * every anonymous visitor reads is a key being spent by anyone who looks.
   * Behind a seller's session it reaches the people who need a map.
   */
  app.get(
    '/locations',
    { preHandler: requireSeller(SellerPermission.LOCATION_READ) },
    async (request, reply) => {
      const locations = await listLocations(currentSeller(request));
      return reply.status(200).send({ locations, map: mapConfig() });
    },
  );

  app.post(
    '/locations',
    { preHandler: requireSeller(SellerPermission.LOCATION_WRITE) },
    async (request, reply) => {
      const body = locationSchema.parse(request.body);
      const location = await createLocation(currentSeller(request), body, request.correlationId);
      return reply.status(201).send(location);
    },
  );

  /**
   * An address to coordinates, for the seller's own dispatch places.
   *
   * The same `forwardGeocode` the warehouse screen uses, behind the seller's
   * own permission. It exists because without it nothing ever filled
   * `SellerLocation.latitude`: the API has taken coordinates since the table
   * was written, the seller's screen had no way to produce any, and so every
   * seller place stayed unplaced and could not be drawn on a map.
   *
   * A POST so the address stays out of this server's access log and out of any
   * proxy in front of it, and 200 with `{ result: null }` for every way a
   * geocoder can fail to answer - unconfigured, slow, no match. The button it
   * feeds is a convenience beside two fields a seller can always leave empty,
   * and a warehouse must never fail to save because a third party had a bad
   * afternoon.
   */
  app.post(
    '/locations/geocode',
    { preHandler: requireSeller(SellerPermission.LOCATION_WRITE) },
    async (request, reply) => {
      const body = z.object({ query: z.string().trim().min(1).max(512) }).parse(request.body);

      const result = await forwardGeocode(body.query);

      return reply.status(200).send({ result });
    },
  );

  /**
   * Every candidate for what the seller has typed so far, not just the first.
   *
   * This is what makes a seller's address land on the map at all. The single
   * lookup above is a button pressed after the fact, which means a place is
   * only placed if somebody remembers to press it; a suggestion list is part
   * of typing the address, so the coordinates arrive with it.
   *
   * Empty for every failure, exactly like the endpoint above, and behind the
   * same permission: this sends the seller's half-written address to whatever
   * geocoder the operator configured, and only somebody already trusted to
   * write a dispatch address should be able to make that call.
   */
  app.post(
    '/locations/geocode/suggest',
    { preHandler: requireSeller(SellerPermission.LOCATION_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          query: z.string().trim().min(1).max(512),
          limit: z.number().int().min(1).max(10).optional(),
        })
        .parse(request.body);

      const suggestions = await suggestAddresses(body.query, body.limit ?? 6);

      return reply.status(200).send({ suggestions });
    },
  );

  app.patch(
    '/locations/:id',
    { preHandler: requireSeller(SellerPermission.LOCATION_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = locationSchema
        .partial()
        .extend({
          isOperational: z.boolean().optional(),
          closedReason: z.string().trim().max(255).nullable().optional(),
        })
        .parse(request.body);

      const location = await updateLocation(
        currentSeller(request),
        params.id,
        body,
        request.correlationId,
      );

      return reply.status(200).send(location);
    },
  );

  app.delete(
    '/locations/:id',
    { preHandler: requireSeller(SellerPermission.LOCATION_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      await archiveLocation(currentSeller(request), params.id, request.correlationId);
      return reply.status(204).send();
    },
  );

  // --- Stock --------------------------------------------------------------

  app.get(
    '/inventory',
    { preHandler: requireSeller(SellerPermission.INVENTORY_READ) },
    async (request, reply) => {
      const query = z
        .object({
          locationId: z.string().length(26).nullish(),
          search: z.string().trim().max(200).nullish(),
          lowOnly: z.coerce.boolean().optional(),
          expiringWithinDays: z.coerce.number().int().min(1).max(3650).nullish(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);

      const result = await listInventory(currentSeller(request), query);
      return reply.header('cache-control', 'no-store').status(200).send(result);
    },
  );

  app.post(
    '/inventory/movements',
    { preHandler: requireTradingSeller(SellerPermission.INVENTORY_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          offerId: z.string().length(26),
          locationId: z.string().length(26),
          type: z.enum([
            'RECEIPT',
            'ADJUSTMENT',
            'RETURN',
            'QUARANTINE',
            'QUARANTINE_RELEASE',
          ]),
          quantityDelta: z.number().int().min(-10_000_000).max(10_000_000),
          reason: z.string().trim().max(255).nullable().optional(),
          batchNumber: z.string().trim().max(64).nullable().optional(),
          /** Supplied by the client so a retried save cannot move stock twice. */
          idempotencyKey: z.string().trim().max(128).nullable().optional(),
        })
        .parse(request.body);

      const result = await recordStockMovement({
        membership: currentSeller(request),
        ...body,
        correlationId: request.correlationId,
      });

      return reply.status(200).send(result);
    },
  );

  app.patch(
    '/inventory/:offerId/:locationId',
    { preHandler: requireSeller(SellerPermission.INVENTORY_WRITE) },
    async (request, reply) => {
      const params = z
        .object({ offerId: z.string().length(26), locationId: z.string().length(26) })
        .parse(request.params);

      const body = z
        .object({
          reorderThreshold: z.number().int().min(0).nullable().optional(),
          batchNumber: z.string().trim().max(64).nullable().optional(),
          manufacturedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        })
        .parse(request.body);

      await updateStockSettings(currentSeller(request), params.offerId, params.locationId, body);
      return reply.status(204).send();
    },
  );

  app.get(
    '/inventory/:offerId/movements',
    { preHandler: requireSeller(SellerPermission.INVENTORY_READ) },
    async (request, reply) => {
      const params = z.object({ offerId: z.string().length(26) }).parse(request.params);
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
        .parse(request.query);

      const movements = await listMovements(currentSeller(request), params.offerId, query.limit);
      return reply.status(200).send({ movements });
    },
  );

  // --- Orders -------------------------------------------------------------

  app.get(
    '/orders',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const query = z
        .object({
          status: z
            .enum([
              'NEW',
              'ACCEPTED',
              'PROCESSING',
              'READY_FOR_DISPATCH',
              'SHIPPED',
              'DELIVERED',
              'CANCELLED',
              'RETURN_REQUESTED',
              'RETURNED',
              'REFUNDED',
              'DISPUTED',
            ])
            .nullish(),
          search: z.string().trim().max(200).nullish(),
          locationId: z.string().length(26).nullish(),
          overdueOnly: z.coerce.boolean().optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(request.query);

      const result = await listSellerOrders(currentSeller(request), query);
      return reply.header('cache-control', 'no-store').status(200).send(result);
    },
  );

  app.get(
    '/orders/:id',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const order = await readSellerOrder(currentSeller(request), params.id);
      return reply.header('cache-control', 'no-store').status(200).send(order);
    },
  );

  app.patch(
    '/orders/:id/status',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          status: z.enum([
            'ACCEPTED',
            'PROCESSING',
            'READY_FOR_DISPATCH',
            'SHIPPED',
            'DELIVERED',
            'CANCELLED',
            'RETURNED',
            'DISPUTED',
          ]),
          reason: z.string().trim().max(2000).nullable().optional(),
          locationId: z.string().length(26).nullable().optional(),
        })
        .parse(request.body);

      await transitionSellerOrder({
        membership: currentSeller(request),
        groupId: params.id,
        to: body.status,
        reason: body.reason ?? null,
        locationId: body.locationId ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(204).send();
    },
  );

  app.post(
    '/orders/:id/shipments',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          carrierName: z.string().trim().min(1).max(120),
          trackingNumber: z.string().trim().min(1).max(128),
          trackingUrl: z.string().trim().url().max(512).nullable().optional(),
          contents: z
            .array(
              z.object({
                orderItemId: z.string().length(26),
                quantity: z.number().int().min(1).max(10_000_000),
              }),
            )
            .max(200)
            .nullable()
            .optional(),
        })
        .parse(request.body);

      const result = await recordShipment({
        membership: currentSeller(request),
        groupId: params.id,
        ...body,
        correlationId: request.correlationId,
      });

      return reply.status(201).send(result);
    },
  );

  // --- Money --------------------------------------------------------------

  app.get(
    '/settlements',
    { preHandler: requireSeller(SellerPermission.FINANCE_READ) },
    async (request, reply) => {
      const seller = currentSeller(request);
      const query = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(request.query);

      const [rows, total] = await Promise.all([
        prisma.sellerSettlement.findMany({
          where: { sellerAccountId: seller.sellerAccountId },
          orderBy: { periodEnd: 'desc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        prisma.sellerSettlement.count({ where: { sellerAccountId: seller.sellerAccountId } }),
      ]);

      return reply.header('cache-control', 'no-store').status(200).send({
        // Every money column is serialised as a string of minor units. A
        // BigInt cannot be JSON-serialised at all, and turning it into a
        // number would silently lose precision on exactly the figures that
        // get disputed.
        settlements: rows.map((row) => ({
          id: row.id,
          reference: row.reference,
          status: row.status,
          periodStart: row.periodStart.toISOString(),
          periodEnd: row.periodEnd.toISOString(),
          currency: row.currency,
          grossMinor: row.grossMinor.toString(),
          taxMinor: row.taxMinor.toString(),
          shippingMinor: row.shippingMinor.toString(),
          commissionMinor: row.commissionMinor.toString(),
          processingFeeMinor: row.processingFeeMinor.toString(),
          refundsMinor: row.refundsMinor.toString(),
          adjustmentsMinor: row.adjustmentsMinor.toString(),
          netPayableMinor: row.netPayableMinor.toString(),
          holdReason: row.holdReason,
        })),
        total,
      });
    },
  );

  app.get(
    '/settlements/:id/lines',
    { preHandler: requireSeller(SellerPermission.FINANCE_READ) },
    async (request, reply) => {
      const seller = currentSeller(request);
      const params = idParam.parse(request.params);

      const settlement = await prisma.sellerSettlement.findUnique({
        where: { id: params.id },
        select: { sellerAccountId: true },
      });

      // Answering 404 rather than 403 for somebody else's settlement, on the
      // same reasoning as everywhere else: confirming it exists is the leak.
      if (settlement === null || settlement.sellerAccountId !== seller.sellerAccountId) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Settlement not found.' },
        });
      }

      const lines = await prisma.sellerSettlementLine.findMany({
        where: { settlementId: params.id },
        orderBy: { occurredAt: 'asc' },
      });

      return reply.status(200).send({
        lines: lines.map((line) => ({
          id: line.id,
          kind: line.kind,
          amountMinor: line.amountMinor.toString(),
          currency: line.currency,
          description: line.description,
          reason: line.reason,
          orderGroupId: line.orderGroupId,
          occurredAt: line.occurredAt.toISOString(),
        })),
      });
    },
  );

  app.get(
    '/payouts',
    { preHandler: requireSeller(SellerPermission.FINANCE_READ) },
    async (request, reply) => {
      const seller = currentSeller(request);

      const rows = await prisma.sellerPayout.findMany({
        where: { sellerAccountId: seller.sellerAccountId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      return reply.header('cache-control', 'no-store').status(200).send({
        payouts: rows.map((row) => ({
          id: row.id,
          reference: row.reference,
          status: row.status,
          amountMinor: row.amountMinor.toString(),
          currency: row.currency,
          scheduledFor: row.scheduledFor?.toISOString() ?? null,
          paidAt: row.paidAt?.toISOString() ?? null,
          failureReason: row.failureReason,
          // The whole point of storing this: a failed payout must leave the
          // seller with something to do, not a dead end.
          remediationHint: row.remediationHint,
        })),
      });
    },
  );

  app.get(
    '/payout-account',
    { preHandler: requireSeller(SellerPermission.FINANCE_READ) },
    async (request, reply) => {
      const account = await readPayoutAccount(currentSeller(request));
      return reply.header('cache-control', 'no-store').status(200).send(account);
    },
  );

  /**
   * Begin payout onboarding with the provider.
   *
   * On this deployment it throws `SELLER_PAYOUT_PROVIDER_UNCONFIGURED`, which
   * the frontend renders as a configuration-required panel naming the missing
   * environment variable. That is the honest outcome and it is deliberate - see
   * the header of `payout.service.ts`.
   */
  app.post(
    '/payout-account/onboarding',
    { preHandler: requireSeller(SellerPermission.PAYOUT_SETUP) },
    async (request, reply) => {
      const body = z
        .object({
          returnUrl: z.string().trim().url().max(1024),
          refreshUrl: z.string().trim().url().max(1024),
        })
        .parse(request.body);

      const link = await startPayoutOnboarding(
        currentSeller(request),
        body,
        request.correlationId,
      );

      return reply.status(200).send({ url: link.url, expiresAt: link.expiresAt.toISOString() });
    },
  );

  /** Re-read the provider after the seller comes back, and update the step. */
  app.post(
    '/payout-account/refresh',
    { preHandler: requireSeller(SellerPermission.PAYOUT_SETUP) },
    async (request, reply) => {
      await refreshPayoutStep(currentSeller(request));
      const account = await readPayoutAccount(currentSeller(request));
      return reply.status(200).send(account);
    },
  );

  // --- Notifications ------------------------------------------------------

  app.get('/notifications', async (request, reply) => {
    const seller = currentSeller(request);

    const rows = await prisma.sellerNotification.findMany({
      where: { sellerAccountId: seller.sellerAccountId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const profileId = seller.customerProfileId;

    return reply.header('cache-control', 'no-store').status(200).send({
      notifications: rows.map((row) => {
        const readBy = (row.readByJson ?? {}) as Record<string, string>;

        return {
          id: row.id,
          kind: row.kind,
          title: row.title,
          body: row.body,
          linkPath: row.linkPath,
          severity: row.severity,
          createdAt: row.createdAt.toISOString(),
          // Read state is per member rather than per row - a seller with twelve
          // staff would otherwise get twelve copies of every event.
          isRead: readBy[profileId] !== undefined,
        };
      }),
    });
  });

  app.post('/notifications/:id/read', async (request, reply) => {
    const seller = currentSeller(request);
    const params = idParam.parse(request.params);

    const row = await prisma.sellerNotification.findUnique({
      where: { id: params.id },
      select: { id: true, sellerAccountId: true, readByJson: true },
    });

    if (row === null || row.sellerAccountId !== seller.sellerAccountId) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Notification not found.' },
      });
    }

    const readBy = { ...((row.readByJson ?? {}) as Record<string, string>) };
    readBy[seller.customerProfileId] = new Date().toISOString();

    await prisma.sellerNotification.update({
      where: { id: row.id },
      data: { readByJson: readBy as never },
    });

    return reply.status(204).send();
  });

  return Promise.resolve();
}
