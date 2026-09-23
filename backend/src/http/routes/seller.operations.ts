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
import {
  listQuotes,
  purchaseConsignment,
  quoteConsignment,
  selectQuote,
} from '../../modules/seller/carrier-purchase.service.js';
import {
  cancelPickup,
  confirmReadiness,
  listPickups,
  schedulePickup,
} from '../../modules/seller/pickup.service.js';
import {
  carrierChoicesForShipment,
  listSellerCarriers,
  requestSellerCarrier,
  sellerAssignCarrier,
} from '../../modules/seller/logistics-partner.service.js';
import {
  attachManualBookingDocument,
  cancelManualBooking,
  createManualBooking,
  logisticsOptionsForConsignment,
  raiseConsignmentForSellerOrder,
  readSellerTracking,
  recordManualMilestone,
  updateManualBooking,
  withdrawConsignmentCarrier,
  type SellerLogisticsActor,
} from '../../modules/seller/consignment-logistics.service.js';
import {
  answerFreightQuote,
  declineFreightQuote,
  freightNeedsQuote,
  listFreightQuotes,
  requestFreightQuote,
} from '../../modules/seller/freight-quote.service.js';
import { currentSeller, requireSeller, requireTradingSeller } from '../plugins/seller.js';

const idParam = z.object({ id: z.string().length(26) });

/**
 * The ceiling on every request that hands a consignment to somebody, or says
 * where it is. Generous for a person at a screen, and low enough that a script
 * cannot flood a carrier's inbox with offers and withdrawals.
 */
const ASSIGNMENT_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

/** Who is acting, as the logistics services want it. From the session only. */
function logisticsActor(seller: ReturnType<typeof currentSeller>): SellerLogisticsActor {
  return {
    sellerAccountId: seller.sellerAccountId,
    memberId: seller.memberId,
    label: seller.displayName,
  };
}

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
      /*
       * ARCHIVED rows are excluded and everything else is not.
       *
       * A RESOLVED alert stays in the list on purpose - "the carrier accepted
       * after all" is worth reading once, and a row that vanished the instant
       * the problem fixed itself would leave a seller wondering whether they
       * imagined the warning. What it does not do is count towards the bell;
       * that is `status` and `class` below, and it is the caller's job.
       */
      where: { sellerAccountId: seller.sellerAccountId, status: { not: 'ARCHIVED' } },
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
          /*
           * The two columns the bell counts on.
           *
           * `class` separates news from a problem: "a customer placed an
           * order" has nothing to resolve, and a badge that counted it would
           * never reach zero. `status` says whether the problem is still
           * true - resolved alerts are shown and not counted.
           */
          notificationClass: row.class,
          status: row.status,
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
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

  // -------------------------------------------------------------------------
  // Carriers
  //
  // The seller half of the fulfilment split: a seller picks a CARRIER for
  // their own consignment, and the carrier picks a DRIVER for the ones it has
  // accepted. Note what is absent from this file and will stay absent - there
  // is no route here that touches a driver, a vehicle or another seller's
  // consignment, and the service these call has no function that would let one
  // be written.
  //
  // Every handler passes `currentSeller(request).sellerAccountId`. None of
  // them reads a seller id from a body or a path, which is the difference
  // between an authorisation check and a suggestion.
  // -------------------------------------------------------------------------

  app.get(
    '/carriers',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const carriers = await listSellerCarriers(currentSeller(request).sellerAccountId);
      return reply.header('cache-control', 'no-store').status(200).send({ carriers });
    },
  );

  app.post(
    '/carriers',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const body = z
        .object({
          logisticsPartnerId: z.string().length(26),
          /** The seller's own account number with the carrier, if they have one. */
          sellerReference: z.string().trim().max(64).nullable().optional(),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const result = await requestSellerCarrier({
        sellerAccountId: seller.sellerAccountId,
        logisticsPartnerId: body.logisticsPartnerId,
        sellerMemberId: seller.memberId,
        actorEmail: seller.displayName,
        sellerReference: body.sellerReference ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(201).send(result);
    },
  );

  // --- Pricing a consignment, and buying it --------------------------------
  //
  // The two operations on this path that cost real money. Both are scoped to
  // the session's seller in the query that finds the consignment, so one
  // belonging to somebody else is not found rather than found and refused.

  /**
   * Ask the carrier what this consignment costs.
   *
   * Supersedes the previous offers, so the list is from one moment rather than
   * a pile accumulated over a week. A quote the seller has already SELECTED is
   * left alone - re-pricing must not silently replace what they agreed to.
   */
  app.post(
    '/consignments/:id/quotes',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const seller = currentSeller(request);

      const quotes = await quoteConsignment({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        shipmentId: params.id,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ quotes });
    },
  );

  app.get(
    '/consignments/:id/quotes',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const seller = currentSeller(request);

      const quotes = await listQuotes(seller.sellerAccountId, params.id);

      return reply.header('cache-control', 'no-store').status(200).send({ quotes });
    },
  );

  /** The seller picks one service. Exactly one can be selected per consignment. */
  app.post(
    '/consignments/:id/quotes/:quoteId/select',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().length(26), quoteId: z.string().length(26) })
        .parse(request.params);

      const seller = currentSeller(request);

      const quotes = await selectQuote({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        shipmentId: params.id,
        quoteId: params.quoteId,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ quotes });
    },
  );

  /**
   * Book it at the carrier.
   *
   * IDEMPOTENT, and that is the whole point of the endpoint's shape: the key
   * is derived from the consignment and the chosen quote, so a retry, a double
   * click or a redelivered job collides in the database rather than booking a
   * second parcel. `purchasedNow` says which happened, so a client can tell a
   * fresh booking from a replayed answer.
   */
  app.post(
    '/consignments/:id/purchase',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const seller = currentSeller(request);

      const result = await purchaseConsignment({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        shipmentId: params.id,
      });

      /*
       * 200 rather than 201 on a replay, because nothing was created. The
       * label is NOT in this response - it is stored privately and served
       * through the signed-link route, since a shipping label carries the
       * consignee's full name and address.
       */
      return reply
        .header('cache-control', 'no-store')
        .status(result.purchasedNow ? 201 : 200)
        .send(result);
    },
  );

  /**
   * Which of this seller's carriers may take this consignment.
   *
   * Returns the ineligible ones with their reasons too. A seller staring at an
   * empty dropdown cannot tell whether they have no carriers, their one
   * carrier is suspended, or it does not reach the destination - and those are
   * three different next actions.
   */
  app.get(
    '/consignments/:id/carrier-options',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);

      const sellerAccountId = currentSeller(request).sellerAccountId;

      /*
       * `options` is the original shape and stays for anything reading it.
       * The rest is what the "Assign logistics partner" screen draws: the
       * consignment itself, who has it now, every partner with its reason,
       * and DHL, FedEx and India Post with what using each would involve.
       */
      const [options, logistics] = await Promise.all([
        carrierChoicesForShipment(sellerAccountId, params.id),
        logisticsOptionsForConsignment(sellerAccountId, params.id),
      ]);

      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send({ options, ...logistics });
    },
  );

  /**
   * Hand the consignment to one of them.
   *
   * `requireTradingSeller` rather than `requireSeller`: offering work creates
   * an obligation on a third party, and a seller who is suspended or still in
   * onboarding should not be able to create one.
   */
  app.post(
    '/consignments/:id/carrier',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: ASSIGNMENT_RATE_LIMIT },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          logisticsPartnerId: z.string().length(26),
          /** Required by the service when this displaces a carrier already chosen. */
          reason: z.string().trim().max(512).nullable().optional(),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const result = await sellerAssignCarrier({
        sellerAccountId: seller.sellerAccountId,
        shipmentId: params.id,
        logisticsPartnerId: body.logisticsPartnerId,
        sellerMemberId: seller.memberId,
        actorEmail: seller.displayName,
        reason: body.reason ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(200).send(result);
    },
  );

  /** Take the consignment back from whoever has it, before collection. */
  app.post(
    '/consignments/:id/withdraw',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: ASSIGNMENT_RATE_LIMIT },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ reason: z.string().trim().min(4).max(512) }).parse(request.body);

      const state = await withdrawConsignmentCarrier({
        actor: logisticsActor(currentSeller(request)),
        shipmentId: params.id,
        reason: body.reason,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ state });
    },
  );

  // --- DHL, FedEx and India Post, booked by hand ---------------------------
  //
  // Nothing below calls a carrier. The seller books the parcel on the
  // carrier's own site or at its counter and records here what it gave them.
  // No label, no rate, no tracking number is ever produced by these routes.

  app.post(
    '/consignments/:id/manual-booking',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: ASSIGNMENT_RATE_LIMIT },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          provider: z.enum(['DHL', 'FEDEX', 'INDIA_POST']),
          reason: z.string().trim().max(512).nullable().optional(),
        })
        .parse(request.body);

      const result = await createManualBooking({
        actor: logisticsActor(currentSeller(request)),
        shipmentId: params.id,
        provider: body.provider,
        reason: body.reason ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(result.idempotent ? 200 : 201).send(result);
    },
  );

  app.patch(
    '/consignments/:id/manual-booking',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: ASSIGNMENT_RATE_LIMIT },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          serviceName: z.string().trim().max(120).nullable().optional(),
          pickupReference: z.string().trim().max(64).nullable().optional(),
          carrierTrackingNumber: z.string().trim().max(64).nullable().optional(),
          expectedPickupAt: z.coerce.date().nullable().optional(),
          expectedDeliveryAt: z.coerce.date().nullable().optional(),
          // Minor units as a string, never a number: money does not cross the
          // API as a float.
          shippingCostMinor: z.string().trim().max(16).nullable().optional(),
          currency: z.string().trim().length(3).nullable().optional(),
        })
        .strict()
        .parse(request.body);

      const details = Object.fromEntries(
        Object.entries(body).filter(([, value]) => value !== undefined),
      );

      const booking = await updateManualBooking({
        editor: { kind: 'SELLER', actor: logisticsActor(currentSeller(request)) },
        shipmentId: params.id,
        details,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ booking });
    },
  );

  app.post(
    '/consignments/:id/manual-booking/cancel',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: ASSIGNMENT_RATE_LIMIT },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ reason: z.string().trim().min(4).max(512) }).parse(request.body);

      const state = await cancelManualBooking({
        actor: logisticsActor(currentSeller(request)),
        shipmentId: params.id,
        reason: body.reason,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ state });
    },
  );

  /** Where the seller's own outside carrier says the parcel is. */
  app.post(
    '/consignments/:id/milestones',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: ASSIGNMENT_RATE_LIMIT },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          status: z.string().trim().min(1).max(32),
          note: z.string().trim().max(1000).nullable().optional(),
          reason: z.string().trim().max(512).nullable().optional(),
          occurredAt: z.coerce.date().nullable().optional(),
          idempotencyKey: z.string().trim().max(56).nullable().optional(),
        })
        .parse(request.body);

      const state = await recordManualMilestone({
        actor: logisticsActor(currentSeller(request)),
        shipmentId: params.id,
        status: body.status,
        note: body.note ?? null,
        reason: body.reason ?? null,
        occurredAt: body.occurredAt ?? null,
        idempotencyKey: body.idempotencyKey ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ state });
    },
  );

  app.post(
    '/consignments/:id/documents',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: ASSIGNMENT_RATE_LIMIT },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const file = await request.file();

      if (file === undefined) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Attach a file.',
            details: [{ field: 'file', code: 'REQUIRED' }],
            correlationId: request.correlationId,
          },
        });
      }

      const kindField = file.fields['kind'];
      const kind =
        typeof kindField === 'object' && kindField !== null && 'value' in kindField
          ? String((kindField as { value: unknown }).value)
          : 'OTHER';

      const document = await attachManualBookingDocument({
        actor: logisticsActor(currentSeller(request)),
        shipmentId: params.id,
        kind,
        fileName: file.filename,
        bytes: await file.toBuffer(),
        correlationId: request.correlationId,
      });

      return reply.status(201).send({ document });
    },
  );

  /** The journey as the seller may see it: public descriptions, never internal notes. */
  app.get(
    '/consignments/:id/tracking',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const tracking = await readSellerTracking(currentSeller(request).sellerAccountId, params.id);
      return reply.header('cache-control', 'no-store').status(200).send(tracking);
    },
  );

  /** Raise the consignment a confirmed order is missing. Idempotent. */
  app.post(
    '/orders/:id/consignments',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: ASSIGNMENT_RATE_LIMIT },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const consignments = await raiseConsignmentForSellerOrder({
        actor: logisticsActor(currentSeller(request)),
        sellerOrderGroupId: params.id,
      });
      return reply.status(200).send({ consignments });
    },
  );

  // --- Booking the van ----------------------------------------------------
  //
  // Who is actually called depends on how the consignment is going out. On the
  // seller's own carrier account the collection is booked WITH that carrier
  // and a confirmation number comes back; through a delivery company inside
  // the platform nothing is called, and the request lands on that company's
  // board for a person to schedule. The seller sees the difference, because it
  // is a real one.

  app.get(
    '/pickups',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const query = z
        .object({
          shipmentId: z.string().length(26).optional(),
          liveOnly: z.coerce.boolean().optional(),
        })
        .parse(request.query);

      const seller = currentSeller(request);

      const pickups = await listPickups(seller.sellerAccountId, {
        ...(query.shipmentId === undefined ? {} : { shipmentId: query.shipmentId }),
        ...(query.liveOnly === undefined ? {} : { liveOnly: query.liveOnly }),
      });

      return reply.header('cache-control', 'no-store').status(200).send({ pickups });
    },
  );

  /**
   * Ask for the parcels to be collected.
   *
   * `requireTradingSeller`: booking a van is an obligation on somebody else and
   * usually costs money, so a seller who is suspended or still in onboarding
   * cannot create one.
   *
   * A second live collection for the same consignment is refused by the
   * database rather than by a check, because two dispatchers pressing this in
   * the same second is exactly the case a check loses.
   */
  app.post(
    '/consignments/:id/pickups',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          windowStartAt: z.coerce.date(),
          windowEndAt: z.coerce.date(),
          timezone: z.string().trim().max(64).nullable().optional(),
          instructions: z.string().trim().max(1024).nullable().optional(),
        })
        .parse(request.body);

      const seller = currentSeller(request);

      const pickup = await schedulePickup({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        shipmentId: params.id,
        windowStartAt: body.windowStartAt,
        windowEndAt: body.windowEndAt,
        timezone: body.timezone ?? null,
        instructions: body.instructions ?? null,
      });

      return reply.header('cache-control', 'no-store').status(201).send({ pickup });
    },
  );

  /** The goods are on the dock - the handshake that stops a wasted van call. */
  app.post(
    '/pickups/:pickupId/ready',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const params = z.object({ pickupId: z.string().length(26) }).parse(request.params);
      const seller = currentSeller(request);

      const pickup = await confirmReadiness({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        pickupId: params.pickupId,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ pickup });
    },
  );

  /**
   * Call the van off.
   *
   * A POST rather than a DELETE: the collection is not removed, it is recorded
   * as cancelled with the reason, and a carrier that refused the cancellation
   * is reported rather than swallowed - a seller told no van is coming when one
   * still is makes the more expensive of the two mistakes.
   */
  app.post(
    '/pickups/:pickupId/cancel',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const params = z.object({ pickupId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({ reason: z.string().trim().max(512).nullable().optional() })
        .parse(request.body ?? {});

      const seller = currentSeller(request);

      const pickup = await cancelPickup({
        sellerAccountId: seller.sellerAccountId,
        actor: { memberId: seller.memberId, userId: null, label: seller.displayName },
        pickupId: params.pickupId,
        reason: body.reason ?? null,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ pickup });
    },
  );

  // --- Freight for loads a parcel carrier cannot take ----------------------
  //
  // A pallet is not a parcel and a container is not a big parcel. Where no
  // carrier on this seller's account can express the load, the answer is a
  // QUOTATION rather than a fabricated price - see `domain/freight-load.ts`.

  app.get(
    '/freight-quotes',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) },
    async (request, reply) => {
      const query = z
        .object({
          state: z
            .enum(['REQUESTED', 'QUOTED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'])
            .nullable()
            .optional(),
          orderGroupId: z.string().length(26).nullable().optional(),
        })
        .parse(request.query);

      const quotes = await listFreightQuotes({
        membership: currentSeller(request),
        state: query.state ?? null,
        orderGroupId: query.orderGroupId ?? null,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ quotes });
    },
  );

  /**
   * Raise a request for one consignment.
   *
   * Idempotent per consignment per load type: pressing it twice returns the
   * request that already exists rather than creating a rival. Two open
   * requests for one load is two freight desks pricing the same pallets and
   * one of them wasting an afternoon.
   */
  app.post(
    '/orders/:id/freight-quote',
    { preHandler: requireSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const seller = currentSeller(request);

      const quote = await requestFreightQuote({
        sellerAccountId: seller.sellerAccountId,
        sellerOrderGroupId: params.id,
        requestedByProfileId: seller.customerProfileId,
        correlationId: request.correlationId,
      });

      return reply.status(201).send(quote);
    },
  );

  /** Whether this consignment can go by carrier at all, or needs quoting. */
  app.get(
    '/orders/:id/freight',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const seller = currentSeller(request);

      // Ownership first: a group id from another seller's account must not be
      // answerable even with a boolean.
      const group = await prisma.sellerOrderGroup.findFirst({
        where: { id: params.id, sellerAccountId: seller.sellerAccountId },
        select: { id: true },
      });

      if (group === null) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Order not found.' },
        });
      }

      const freight = await freightNeedsQuote(params.id);
      const quotes = await listFreightQuotes({ membership: seller, orderGroupId: params.id });

      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send({ ...freight, quotes });
    },
  );

  /**
   * Enter a real figure.
   *
   * `FULFILMENT_WRITE` rather than `ORDER_FULFIL`: this is a delivery
   * arrangement and a cost, which is the fulfilment desk's authority, not the
   * authority to pack and ship an order.
   */
  app.post(
    '/freight-quotes/:id/answer',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);

      const body = z
        .object({
          // Money as a STRING, like everywhere else in this API.
          amountMinor: z.string().regex(/^\d{1,19}$/),
          currency: z.string().trim().length(3),
          serviceName: z.string().trim().max(160).nullable().optional(),
          carrierReference: z.string().trim().max(120).nullable().optional(),
          trackingReference: z.string().trim().max(120).nullable().optional(),
          expectedPickupAt: z.coerce.date().nullable().optional(),
          expectedDeliveryAt: z.coerce.date().nullable().optional(),
          quoteExpiresAt: z.coerce.date().nullable().optional(),
          responseNote: z.string().trim().max(1000).nullable().optional(),
        })
        .parse(request.body);

      const quote = await answerFreightQuote({
        membership: currentSeller(request),
        requestId: params.id,
        amountMinor: body.amountMinor,
        currency: body.currency,
        serviceName: body.serviceName ?? null,
        carrierReference: body.carrierReference ?? null,
        trackingReference: body.trackingReference ?? null,
        expectedPickupAt: body.expectedPickupAt ?? null,
        expectedDeliveryAt: body.expectedDeliveryAt ?? null,
        quoteExpiresAt: body.quoteExpiresAt ?? null,
        responseNote: body.responseNote ?? null,
        actorUserId: request.auth?.id ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(200).send(quote);
    },
  );

  app.post(
    '/freight-quotes/:id/decline',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(request.body);

      const quote = await declineFreightQuote({
        membership: currentSeller(request),
        requestId: params.id,
        reason: body.reason,
        actorUserId: request.auth?.id ?? null,
      });

      return reply.status(200).send(quote);
    },
  );

  return Promise.resolve();
}
