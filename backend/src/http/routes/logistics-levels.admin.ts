/**
 * The marketplace's side of the four delivery levels, and of the platform fee.
 *
 * Three different authorities, deliberately:
 *
 *   - `logistics.read` to see every seller's policy, prices and legs;
 *   - `logistics.write` to price the levels UBOSS controls, and
 *     `logistics.assign` to put a carrier on a UBOSS leg - the same split the
 *     consignment desk already draws between contracts and daily dispatch;
 *   - `finance.policy.*` for what sellers are charged and the tax on it,
 *     which a general administrator does not hold.
 *
 * Every UBOSS write is re-authorised in the service against who controls the
 * level: staff pricing a level the seller controls are refused there.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../../modules/audit/audit.service.js';
import {
  deactivateRate,
  listManagedLevels,
  publishRate,
  readPolicy,
  readPolicyHistory,
  saveRate,
  type UbossLogisticsEditor,
} from '../../modules/logistics/level-policy.service.js';
import {
  assignLeg,
  legForAdmin,
  legForPartner,
  legsForAdmin,
  legsForPartner,
  priceBreakdownForCustomer,
  setLegDriver,
  transitionLeg,
  updateLegReferences,
} from '../../modules/logistics/shipment-leg.service.js';
import {
  createDraftPolicy,
  listPolicies,
  ordersUsingPolicy,
  previewSettlement,
  publishPolicy as publishFeePolicy,
  retirePolicy,
  updateDraftPolicy,
  verifyTaxRule,
  type FinanceActor,
} from '../../modules/settings/platform-fee.service.js';
import { resolveCart, toCartView } from '../../modules/cart/cart.service.js';
import { currentUser, requireAdmin, requireCustomer } from '../plugins/auth.js';
import { currentLogistics, requireLogistics } from '../plugins/logistics.js';
import { assignBody, rateBody, referencesBody, toRateInput, transitionBody } from './seller.logistics.js';
import { destinationOf } from './cart.customer.js';

const idParam = z.object({ id: z.string().length(26) });
const rateParam = z.object({ rateId: z.string().length(26) });
const sellerParam = z.object({ sellerAccountId: z.string().length(26) });

const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

function ubossEditor(request: FastifyRequest): UbossLogisticsEditor {
  const user = currentUser(request);
  return {
    kind: 'UBOSS',
    userId: user.id,
    email: user.email,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

function financeActor(request: FastifyRequest): FinanceActor {
  const user = currentUser(request);
  return { userId: user.id, email: user.email, ipAddress: request.ip, correlationId: request.correlationId };
}

const feePolicyBody = z
  .object({
    scope: z.enum(['GLOBAL', 'MARKET', 'CATEGORY', 'SELLER']),
    sellerAccountId: z.string().length(26).nullable().optional(),
    categoryId: z.string().length(26).nullable().optional(),
    marketCountry: z.string().trim().length(2).nullable().optional(),
    name: z.string().trim().min(2).max(160),
    feeType: z.enum(['PERCENT', 'FLAT', 'PERCENT_PLUS_FLAT']),
    feeBasis: z.enum(['PRODUCT_SUBTOTAL', 'PRODUCT_SUBTOTAL_PLUS_SELLER_DELIVERY']).default('PRODUCT_SUBTOTAL'),
    percentRate: z.string().trim().max(12).default('0'),
    flatFeeMinor: z.string().trim().max(20).nullable().optional(),
    minFeeMinor: z.string().trim().max(20).nullable().optional(),
    maxFeeMinor: z.string().trim().max(20).nullable().optional(),
    currency: z.string().trim().max(3).nullable().optional(),
    taxRatePercent: z.string().trim().max(12),
    taxLabel: z.string().trim().max(64).nullable().optional(),
    taxJurisdiction: z.string().trim().max(2).nullable().optional(),
    effectiveFrom: z.coerce.date().nullable().optional(),
    effectiveTo: z.coerce.date().nullable().optional(),
    notes: z.string().trim().max(1024).nullable().optional(),
  })
  .strict();

export function registerAdminLogisticsLevelRoutes(app: FastifyInstance): Promise<void> {
  // --- Managed levels ------------------------------------------------------

  /**
   * Every seller's delivery-level policy in force: who runs each of the four
   * levels and which still have no published price. Can be narrowed to sellers
   * with a UBOSS-run level, those missing a UBOSS price, or by seller name.
   */
  app.get('/logistics/managed-levels', { preHandler: requireAdmin(Permission.LOGISTICS_READ) }, async (request, reply) => {
    const query = z
      .object({
        ubossOnly: z.enum(['true', 'false']).optional(),
        missingOnly: z.enum(['true', 'false']).optional(),
        search: z.string().trim().max(160).optional(),
      })
      .parse(request.query);
    const rows = await listManagedLevels({
      ubossOnly: query.ubossOnly === 'true',
      missingOnly: query.missingOnly === 'true',
      search: query.search ?? null,
    });
    return reply.status(200).send({ sellers: rows });
  });

  /**
   * One seller's delivery-level policy as UBOSS sees it, with its version and
   * change history and the marketplace carriers that can be named on it.
   */
  app.get(
    '/logistics/managed-levels/sellers/:sellerAccountId',
    { preHandler: requireAdmin(Permission.LOGISTICS_READ) },
    async (request, reply) => {
      const params = sellerParam.parse(request.params);
      const [policy, history] = await Promise.all([
        readPolicy(params.sellerAccountId, 'UBOSS'),
        readPolicyHistory(params.sellerAccountId),
      ]);
      const marketplaceCarriers = await prisma.logisticsPartner.findMany({
        where: { status: 'ACTIVE', archivedAt: null, partnerKind: 'MARKETPLACE_CARRIER' },
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
      });
      return reply.status(200).send({ policy, history, marketplaceCarriers });
    },
  );

  /**
   * Add a draft price for a delivery level UBOSS controls for this seller.
   * Refused on a level the seller controls. Recorded in both the admin audit
   * log and the seller's own history.
   */
  app.post(
    '/logistics/managed-levels/sellers/:sellerAccountId/rates',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = sellerParam.parse(request.params);
      const body = rateBody.parse(request.body);
      const rate = await saveRate(ubossEditor(request), { ...toRateInput(body), sellerAccountId: params.sellerAccountId });
      return reply.status(201).send({ rate });
    },
  );

  /**
   * Edit a delivery-level price UBOSS sets for a seller. Editing a published
   * price creates a new draft that replaces it once published. Refused on a
   * level the seller controls. Recorded in both audit logs.
   */
  app.put(
    '/logistics/managed-levels/rates/:rateId',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = rateParam.parse(request.params);
      const body = rateBody.parse(request.body);
      const existing = await prisma.logisticsLevelRate.findUnique({ where: { id: params.rateId }, select: { sellerAccountId: true } });
      if (existing === null) throw notFound('Price');
      const rate = await saveRate(ubossEditor(request), {
        ...toRateInput(body),
        sellerAccountId: existing.sellerAccountId,
        rateId: params.rateId,
      });
      return reply.status(200).send({ rate });
    },
  );

  /**
   * Publish a draft delivery-level price for a seller, replacing the price it
   * supersedes. Recorded in both the admin audit log and the seller's own
   * history.
   */
  app.post(
    '/logistics/managed-levels/rates/:rateId/publish-price',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = rateParam.parse(request.params);
      const existing = await prisma.logisticsLevelRate.findUnique({ where: { id: params.rateId }, select: { sellerAccountId: true } });
      if (existing === null) throw notFound('Price');
      const rate = await publishRate(ubossEditor(request), { sellerAccountId: existing.sellerAccountId, rateId: params.rateId });
      return reply.status(200).send({ rate });
    },
  );

  /**
   * Switch off a delivery-level price that UBOSS sets for a seller. It stays on
   * record, and orders already charged at it keep it. Recorded in both the
   * admin audit log and the seller's own history.
   */
  app.post(
    '/logistics/managed-levels/rates/:rateId/deactivate',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = rateParam.parse(request.params);
      const existing = await prisma.logisticsLevelRate.findUnique({ where: { id: params.rateId }, select: { sellerAccountId: true } });
      if (existing === null) throw notFound('Price');
      const rate = await deactivateRate(ubossEditor(request), { sellerAccountId: existing.sellerAccountId, rateId: params.rateId });
      return reply.status(200).send({ rate });
    },
  );

  /** Whether buyers see each level's price or one delivery line. */
  app.get('/logistics/presentation', { preHandler: requireAdmin(Permission.SETTINGS_READ) }, async (_request, reply) => {
    const profile = await prisma.businessProfile.findFirst({ select: { showLogisticsLevelBreakdown: true } });
    return reply.status(200).send({ showLevelBreakdown: profile?.showLogisticsLevelBreakdown ?? true });
  });

  /**
   * Choose whether buyers see a price for each delivery level or a single
   * delivery line. Writes an audit entry.
   */
  app.put(
    '/logistics/presentation',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const body = z.object({ showLevelBreakdown: z.boolean() }).strict().parse(request.body);
      const profile = await prisma.businessProfile.findFirst({ select: { id: true, showLogisticsLevelBreakdown: true } });
      if (profile === null) throw notFound('Business profile');
      await prisma.businessProfile.update({
        where: { id: profile.id },
        data: { showLogisticsLevelBreakdown: body.showLevelBreakdown },
      });
      const user = currentUser(request);
      await recordAudit({
        action: AuditAction.LOGISTICS_PRESENTATION_CHANGED,
        resourceType: 'business_profile',
        resourceId: profile.id,
        actorType: 'ADMIN',
        actorUserId: user.id,
        actorEmail: user.email,
        before: { showLogisticsLevelBreakdown: profile.showLogisticsLevelBreakdown },
        after: { showLogisticsLevelBreakdown: body.showLevelBreakdown },
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });
      return reply.status(200).send({ showLevelBreakdown: body.showLevelBreakdown });
    },
  );

  // --- Legs ------------------------------------------------------------------

  /**
   * Every delivery leg across all orders, newest first, filterable by who runs
   * it, its status, one order, or only the legs still waiting for a carrier.
   */
  app.get('/logistics/legs', { preHandler: requireAdmin(Permission.LOGISTICS_READ) }, async (request, reply) => {
    const query = z
      .object({
        owner: z.enum(['SELLER', 'UBOSS']).optional(),
        status: z.enum(['PENDING', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
        needsAssignment: z.enum(['true', 'false']).optional(),
        orderId: z.string().length(26).optional(),
      })
      .parse(request.query);
    const legs = await legsForAdmin({
      owner: query.owner ?? null,
      status: query.status ?? null,
      needsAssignment: query.needsAssignment === 'true',
      orderId: query.orderId ?? null,
    });
    return reply.status(200).send({ legs });
  });

  /**
   * One delivery leg with the rest of its order's journey beside it, and the
   * marketplace carriers it could be given to.
   */
  app.get('/logistics/legs/:id', { preHandler: requireAdmin(Permission.LOGISTICS_READ) }, async (request, reply) => {
    const params = idParam.parse(request.params);
    const detail = await legForAdmin(params.id);
    const marketplaceCarriers = await prisma.logisticsPartner.findMany({
      where: { status: 'ACTIVE', archivedAt: null, partnerKind: 'MARKETPLACE_CARRIER' },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });
    return reply.status(200).send({ ...detail, marketplaceCarriers });
  });

  /**
   * Name who carries a UBOSS-run leg: an outside carrier or a delivery company
   * on the platform. The company gets a notification, the seller is told, and
   * a company that loses the leg is told why. Refused once the leg is moving;
   * a leg the seller runs can only be assigned by the seller.
   */
  app.post(
    '/logistics/legs/:id/assign',
    { preHandler: requireAdmin(Permission.LOGISTICS_ASSIGN), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = assignBody.parse(request.body);
      await assignLeg(ubossEditor(request), params.id, { ...body, provider: (body.provider ?? null) as never });
      return reply.status(200).send(await legForAdmin(params.id));
    },
  );

  /**
   * Enter the carrier's tracking number, pickup reference or expected dates on
   * a UBOSS-run leg. Refused until a carrier is named, and once the leg is
   * finished. Writes an audit entry.
   */
  app.patch(
    '/logistics/legs/:id',
    { preHandler: requireAdmin(Permission.LOGISTICS_ASSIGN), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = referencesBody.parse(request.body);
      await updateLegReferences(ubossEditor(request), params.id, body);
      return reply.status(200).send(await legForAdmin(params.id));
    },
  );

  /**
   * Move a UBOSS-run leg on: accept, start, hand over, or take it back from a
   * delivery company. Handing over makes the next leg ready; the seller is
   * told and an audit entry is written. A leg a delivery company holds is
   * progressed by that company, not here.
   */
  app.post(
    '/logistics/legs/:id/transition',
    { preHandler: requireAdmin(Permission.LOGISTICS_ASSIGN), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = transitionBody.parse(request.body);
      await transitionLeg(ubossEditor(request), params.id, body);
      return reply.status(200).send(await legForAdmin(params.id));
    },
  );

  // --- Platform fee (finance) -----------------------------------------------

  /**
   * List the platform fee policies, every version, optionally only drafts,
   * published or retired ones, with how many seller orders each has settled.
   */
  app.get('/platform-fees', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => {
    const query = z.object({ status: z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']).optional() }).parse(request.query);
    return reply.status(200).send({ policies: await listPolicies({ status: query.status ?? null }) });
  });

  /**
   * Create a new draft platform fee policy: what sellers are charged, for the
   * whole marketplace or one market, category or seller, and the tax on it.
   * Nothing is charged until it is published. Writes an audit entry.
   */
  app.post(
    '/platform-fees',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const body = feePolicyBody.parse(request.body);
      return reply.status(201).send({ policy: await createDraftPolicy(financeActor(request), body) });
    },
  );

  /**
   * Change a draft platform fee policy. Refused once it is published or
   * retired, or if the change would move it to a different scope. Writes an
   * audit entry.
   */
  app.put(
    '/platform-fees/:id',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = feePolicyBody.parse(request.body);
      return reply.status(200).send({ policy: await updateDraftPolicy(financeActor(request), params.id, body) });
    },
  );

  /**
   * Make a draft platform fee policy the live one for its scope, retiring the
   * version it replaces. Writes an audit entry, and alerts finance staff when
   * the policy charges tax whose rule nobody has verified yet.
   */
  app.post(
    '/platform-fees/:id/publish',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      return reply.status(200).send({ policy: await publishFeePolicy(financeActor(request), params.id) });
    },
  );

  /**
   * Retire a platform fee policy so it no longer applies to new orders.
   * Retiring one that is already retired changes nothing. Writes an audit
   * entry.
   */
  app.post(
    '/platform-fees/:id/retire',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      return reply.status(200).send({ policy: await retirePolicy(financeActor(request), params.id) });
    },
  );

  /**
   * Record, with a note, that the tax rule on a platform fee policy is the
   * legally correct one. Changes no figure. Refused on a retired policy.
   * Writes an audit entry.
   */
  app.post(
    '/platform-fees/:id/verify-tax',
    { preHandler: requireAdmin(Permission.FINANCE_TAX_VERIFY), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ note: z.string().trim().min(10).max(512) }).strict().parse(request.body);
      return reply.status(200).send({ policy: await verifyTaxRule(financeActor(request), params.id, body) });
    },
  );

  /**
   * The seller orders that were settled on one platform fee policy version,
   * newest first, with the fee and fee tax charged on each.
   */
  app.get('/platform-fees/:id/orders', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => {
    const params = idParam.parse(request.params);
    return reply.status(200).send(await ordersUsingPolicy(params.id));
  });

  /**
   * Work out what a seller would be charged and paid on a given sale, using
   * the platform fee policies in force now. Read-only: nothing is saved.
   */
  app.post('/platform-fees/preview', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => {
    const body = z
      .object({
        sellerAccountId: z.string().length(26),
        goodsMinor: z.string().regex(/^\d{1,18}$/),
        sellerDeliveryMinor: z.string().regex(/^\d{1,18}$/).default('0'),
        currency: z.string().length(3).optional(),
        marketCountry: z.string().length(2).optional(),
        // The category whose fee policy applies, directly or from one of the
        // seller's listings - so a category policy is previewed as it charges.
        categoryId: z.string().length(26).optional(),
        offerId: z.string().length(26).optional(),
      })
      .strict()
      .parse(request.body);
    const estimate = await previewSettlement({
      sellerAccountId: body.sellerAccountId,
      goodsMinor: BigInt(body.goodsMinor),
      sellerDeliveryMinor: BigInt(body.sellerDeliveryMinor),
      currency: body.currency ?? null,
      marketCountry: body.marketCountry ?? null,
      categoryId: body.categoryId ?? null,
      offerId: body.offerId ?? null,
    });
    return reply.status(200).send({ estimate });
  });

  return Promise.resolve();
}

/**
 * The buyer's side: a delivery quote for an address, and what an order paid
 * for delivery. Both scoped to the signed-in customer's own records.
 */
export function registerCustomerLogisticsPricingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  /**
   * L1-L4 for the basket, to one of the customer's addresses. The same
   * pricing run as the cart - there is one answer to what delivery costs.
   */
  app.post('/logistics/quote', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const auth = currentUser(request);
    const body = z.object({ shippingAddressId: z.string().length(26) }).strict().parse(request.body);
    const resolved = await resolveCart(auth.customerProfileId ?? '', {
      ...(await destinationOf(auth.customerProfileId ?? '', body.shippingAddressId)),
    });
    const cart = toCartView(resolved);
    return reply.status(200).send({ delivery: cart.delivery, totals: cart.totals, checkoutReady: cart.checkoutReady, blockingIssues: cart.blockingIssues });
  });

  return Promise.resolve();
}

export function registerCustomerOrderBreakdownRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  /**
   * What the signed-in customer paid on one of their own orders, including
   * delivery level by level and where each level has got to. Another
   * customer's order is not found.
   */
  app.get('/:id/price-breakdown', async (request, reply) => {
    const auth = currentUser(request);
    const params = idParam.parse(request.params);
    return reply.status(200).send({ breakdown: await priceBreakdownForCustomer(auth.customerProfileId ?? '', params.id) });
  });

  return Promise.resolve();
}

/**
 * The logistics portal's legs: only the ones this company holds.
 *
 * The partner id comes from the session and from nowhere else; a leg another
 * company holds is "not found".
 */
export function registerLogisticsPortalLegRoutes(app: FastifyInstance): Promise<void> {
  function partnerEditor(request: FastifyRequest) {
    const membership = currentLogistics(request);
    return {
      kind: 'PARTNER' as const,
      logisticsPartnerId: membership.logisticsPartnerId,
      userId: membership.userId,
      label: membership.displayName,
      correlationId: request.correlationId,
    };
  }

  /** The delivery legs this company holds, most recently changed first. */
  app.get('/legs', { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ) }, async (request, reply) => {
    return reply.status(200).send({ legs: await legsForPartner(currentLogistics(request).logisticsPartnerId) });
  });

  /** One leg this delivery company holds. A leg held by another company is not found. */
  app.get('/legs/:id', { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ) }, async (request, reply) => {
    const params = idParam.parse(request.params);
    return reply.status(200).send({ leg: await legForPartner(currentLogistics(request).logisticsPartnerId, params.id) });
  });

  /**
   * Accept a leg offered to this delivery company, confirming it will carry
   * it. The seller is told, and it is recorded in their history.
   */
  app.post(
    '/legs/:id/accept',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_ACCEPT), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      await transitionLeg(partnerEditor(request), params.id, { to: 'ACCEPTED' });
      return reply.status(200).send({ leg: await legForPartner(currentLogistics(request).logisticsPartnerId, params.id) });
    },
  );

  /**
   * Refuse a leg offered to this delivery company, with a reason. The leg goes
   * back to waiting for a carrier, and the seller is told it needs a new one.
   */
  app.post(
    '/legs/:id/reject',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_ACCEPT), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ reason: z.string().trim().min(4).max(512) }).strict().parse(request.body);
      await transitionLeg(partnerEditor(request), params.id, { to: 'AWAITING_ASSIGNMENT', note: body.reason });
      return reply.status(200).send({ rejected: true });
    },
  );

  /**
   * Mark a leg this delivery company holds as started or handed over. Handing
   * it over makes the next leg of the journey ready. The seller is told and it
   * is recorded in their history; a repeated request with the same
   * idempotency key changes nothing.
   */
  app.post(
    '/legs/:id/progress',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_STATUS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          to: z.enum(['IN_PROGRESS', 'COMPLETED']),
          note: z.string().trim().max(512).nullable().optional(),
          idempotencyKey: z.string().trim().min(8).max(80).nullable().optional(),
        })
        .strict()
        .parse(request.body);
      await transitionLeg(partnerEditor(request), params.id, body);
      return reply.status(200).send({ leg: await legForPartner(currentLogistics(request).logisticsPartnerId, params.id) });
    },
  );

  /**
   * Enter the tracking number, pickup reference or expected dates on a leg
   * this delivery company holds. Refused once the leg is finished or
   * cancelled. Recorded in the seller's history.
   */
  app.patch(
    '/legs/:id',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_STATUS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = referencesBody.parse(request.body);
      await updateLegReferences(partnerEditor(request), params.id, body);
      return reply.status(200).send({ leg: await legForPartner(currentLogistics(request).logisticsPartnerId, params.id) });
    },
  );

  /**
   * Put one of this delivery company's own drivers on a leg it holds, or take
   * the driver off. Refused when the leg is finished or cancelled, or the
   * driver is not this company's.
   */
  app.post(
    '/legs/:id/driver',
    { preHandler: requireLogistics(LogisticsPermission.DRIVER_ASSIGN), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ driverProfileId: z.string().length(26).nullable() }).strict().parse(request.body);
      await setLegDriver(partnerEditor(request), params.id, body.driverProfileId);
      return reply.status(200).send({ leg: await legForPartner(currentLogistics(request).logisticsPartnerId, params.id) });
    },
  );

  return Promise.resolve();
}
