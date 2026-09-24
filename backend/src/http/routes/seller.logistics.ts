/**
 * Seller Hub -> Logistics: the four-level policy, its carriers and prices,
 * the legs of confirmed orders, and the read-only settlement preview.
 *
 * The seller is taken from the SESSION on every route - there is no seller id
 * in any path, so another seller's policy, price or leg cannot even be named.
 * Every write is re-authorised in the service against who controls the level:
 * a seller who crafts a request for a UBOSS-controlled level is refused there,
 * whatever this file's guards allowed through.
 *
 * Nothing here can change a platform fee or the tax on it. The settlement
 * routes read.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LOGISTICS_LEVELS, policyForLevelChange } from '../../domain/logistics-levels.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import {
  MANAGED_PROVIDERS,
  deactivateRate,
  listProviders,
  publishPolicy,
  publishRate,
  readPolicy,
  readPolicyHistory,
  savePolicyDraft,
  saveRate,
  setProvider,
  type SellerLogisticsEditor,
} from '../../modules/logistics/level-policy.service.js';
import {
  assignLeg,
  legsForSellerOrder,
  transitionLeg,
  updateLegReferences,
} from '../../modules/logistics/shipment-leg.service.js';
import { listSellerSettlements, previewSettlement } from '../../modules/settings/platform-fee.service.js';
import { currentUser } from '../plugins/auth.js';
import { currentSeller, requireSeller, requireTradingSeller } from '../plugins/seller.js';

/** Generous for a person at a screen; low enough that a script cannot churn prices. */
const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;
const ASSIGN_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

const owner = z.enum(['SELLER', 'UBOSS']);
const level = z.enum(LOGISTICS_LEVELS);
const provider = z.enum(MANAGED_PROVIDERS as unknown as [string, ...string[]]);
const idParam = z.object({ id: z.string().length(26) });
const rateParam = z.object({ rateId: z.string().length(26) });

/** The fields of a level price, shared by the seller and the admin routes. */
export const rateBody = z
  .object({
    level,
    originLocationId: z.string().length(26).nullable().optional(),
    originPortCode: z.string().trim().max(8).nullable().optional(),
    destinationPortCode: z.string().trim().max(8).nullable().optional(),
    destinationHubCode: z.string().trim().max(64).nullable().optional(),
    destinationHubName: z.string().trim().max(160).nullable().optional(),
    destinationCountry: z.string().trim().length(2).nullable().optional().or(z.literal('')),
    destinationPostalPrefix: z.string().trim().max(16).nullable().optional(),
    packageClass: z.enum(['PARCEL', 'PALLET', 'CONTAINER']).nullable().optional(),
    minWeightGrams: z.number().int().min(0).max(100_000_000).nullable().optional(),
    maxWeightGrams: z.number().int().min(0).max(100_000_000).nullable().optional(),
    isWorldwideFlat: z.boolean().optional(),
    transportMode: z.enum(['ROAD', 'AIR', 'SEA', 'RAIL', 'POSTAL']),
    provider: provider.nullable().optional(),
    logisticsPartnerId: z.string().length(26).nullable().optional(),
    providerLabel: z.string().trim().max(160).nullable().optional(),
    serviceName: z.string().trim().max(120).nullable().optional(),
    trackingReferenceKind: z.enum(['AWB', 'BOL', 'CONTAINER', 'TRACKING']).nullable().optional(),
    requiresCustomsRelease: z.boolean().optional(),
    transitDaysMin: z.number().int().min(0).max(365).nullable().optional(),
    transitDaysMax: z.number().int().min(0).max(365).nullable().optional(),
    // Minor units as a string, never a number. Empty or null = not priced yet.
    amountMinor: z.string().trim().max(20).nullable().optional(),
    currency: z.string().trim().max(3).nullable().optional(),
    isFree: z.boolean().optional(),
    confirmFree: z.boolean().optional(),
    taxInclusive: z.boolean().optional(),
    priceSource: z.enum(['MANUAL', 'PROVIDER_QUOTE', 'UBOSS_RATE', 'RATE_CARD']).optional(),
    effectiveFrom: z.coerce.date().nullable().optional(),
  })
  .strict();

export type RateBody = z.infer<typeof rateBody>;

/** The service's input, with the provider narrowed and empties normalised. */
export function toRateInput(body: RateBody) {
  return {
    ...body,
    provider: (body.provider ?? null) as (typeof MANAGED_PROVIDERS)[number] | null,
    destinationCountry: body.destinationCountry === '' ? null : (body.destinationCountry ?? null),
  };
}

export const assignBody = z
  .object({
    provider: provider.nullable().optional(),
    logisticsPartnerId: z.string().length(26).nullable().optional(),
    providerLabel: z.string().trim().max(160).nullable().optional(),
    serviceName: z.string().trim().max(120).nullable().optional(),
    trackingNumber: z.string().trim().max(64).nullable().optional(),
    trackingReferenceKind: z.enum(['AWB', 'BOL', 'CONTAINER', 'TRACKING']).nullable().optional(),
    pickupReference: z.string().trim().max(64).nullable().optional(),
    expectedStartAt: z.coerce.date().nullable().optional(),
    expectedCompleteAt: z.coerce.date().nullable().optional(),
    reason: z.string().trim().max(512).nullable().optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();

export const referencesBody = z
  .object({
    trackingNumber: z.string().trim().max(64).nullable().optional(),
    trackingReferenceKind: z.enum(['AWB', 'BOL', 'CONTAINER', 'TRACKING']).nullable().optional(),
    pickupReference: z.string().trim().max(64).nullable().optional(),
    expectedStartAt: z.coerce.date().nullable().optional(),
    expectedCompleteAt: z.coerce.date().nullable().optional(),
  })
  .strict();

export const transitionBody = z
  .object({
    to: z.enum(['AWAITING_ASSIGNMENT', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED']),
    note: z.string().trim().max(512).nullable().optional(),
    idempotencyKey: z.string().trim().min(8).max(80).nullable().optional(),
  })
  .strict();

function editor(request: Parameters<typeof currentSeller>[0]): SellerLogisticsEditor {
  const seller = currentSeller(request);
  return {
    kind: 'SELLER',
    sellerAccountId: seller.sellerAccountId,
    userId: currentUser(request).id,
    label: seller.displayName,
    correlationId: request.correlationId,
  };
}

/** A seller order of THIS seller, by id, or 404. */
async function ownGroup(sellerAccountId: string, groupId: string): Promise<string> {
  const group = await prisma.sellerOrderGroup.findFirst({
    where: { id: groupId, sellerAccountId },
    select: { id: true },
  });
  if (group === null) {
    throw notFound('Order');
  }
  return group.id;
}

async function legOf(sellerAccountId: string, groupId: string, levelKey: string): Promise<string> {
  await ownGroup(sellerAccountId, groupId);
  const leg = await prisma.shipmentLeg.findFirst({
    where: { sellerOrderGroupId: groupId, sellerAccountId, level: levelKey as never },
    select: { id: true },
  });
  if (leg === null) throw notFound('Leg');
  return leg.id;
}

export function registerSellerLogisticsRoutes(app: FastifyInstance): Promise<void> {
  // --- The policy --------------------------------------------------------

  /**
   * The seller's delivery policy: who handles each of the four delivery stages,
   * both as published and as in the unpublished draft, with the carriers and
   * prices set on each.
   */
  app.get('/logistics/policy', { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) }, async (request, reply) => {
    const seller = currentSeller(request);
    return reply.status(200).send({ policy: await readPolicy(seller.sellerAccountId, 'SELLER') });
  });

  /**
   * Save the draft delivery policy: self-managed, UBOSS-managed or a mix, and who
   * handles each stage. Buyers see no change until it is published; changing
   * who handles a stage of a published policy must be confirmed.
   */
  app.put(
    '/logistics/policy',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const body = z
        .object({
          mode: z.enum(['SELF', 'UBOSS', 'HYBRID']),
          l1Owner: owner.optional(),
          l2Owner: owner.optional(),
          l3Owner: owner.optional(),
          l4Owner: owner.optional(),
          expectedVersion: z.number().int().min(1).optional(),
          confirmOwnershipChange: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);

      const policy = await savePolicyDraft(editor(request), body);
      return reply.status(200).send({ policy });
    },
  );

  /**
   * One level's owner in the draft. The checkbox "I will manage this level":
   * checked is SELLER, unchecked is UBOSS. The draft keeps its mode unless the
   * change takes it out of Self or UBOSS, which makes it Self + UBOSS. Handing
   * L1 to UBOSS is refused. Against a published policy a change of owner must
   * be confirmed, and a stale version is refused.
   */
  app.put(
    '/logistics/levels/:level',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = z.object({ level }).parse(request.params);
      const body = z
        .object({
          owner,
          expectedVersion: z.number().int().min(1).optional(),
          confirmOwnershipChange: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);

      const who = editor(request);
      const current = await readPolicy(who.sellerAccountId, 'SELLER');

      // The draft's own mode is kept wherever the change still fits it, and
      // every level - L1 included - carries the version and the confirmation,
      // so a stale screen and an unconfirmed change are refused the same way
      // as on PUT /logistics/policy.
      const shape = policyForLevelChange(current.draft, params.level, body.owner);
      const policy = await savePolicyDraft(who, {
        ...shape,
        ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
        ...(body.confirmOwnershipChange === undefined ? {} : { confirmOwnershipChange: body.confirmOwnershipChange }),
      });
      return reply.status(200).send({ policy });
    },
  );

  /**
   * Publish the draft delivery policy so it applies to new carts and orders.
   * The previous version is kept, because orders already placed still refer to it.
   */
  app.post(
    '/logistics/policy/publish',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = z
        .object({
          confirmOwnershipChange: z.boolean().optional(),
          changeNote: z.string().trim().max(512).nullable().optional(),
        })
        .strict()
        .parse(request.body ?? {});
      const policy = await publishPolicy(editor(request), body);
      return reply.status(200).send({ policy });
    },
  );

  /** The seller's past delivery policy versions and the log of changes to its policy, carriers, prices and stage assignments. */
  app.get('/logistics/history', { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) }, async (request, reply) => {
    const seller = currentSeller(request);
    return reply.status(200).send(await readPolicyHistory(seller.sellerAccountId));
  });

  // --- Carriers ---------------------------------------------------------

  /** The carriers the seller can use on their own delivery stages, whether each is switched on, and the state of any carrier account connection. */
  app.get('/logistics/providers', { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) }, async (request, reply) => {
    const seller = currentSeller(request);
    return reply.status(200).send({ providers: await listProviders(seller.sellerAccountId) });
  });

  /**
   * Switch a carrier on for the seller's own delivery stages, either booked by
   * hand or marked for an account connection. This does not connect an account;
   * that is done in carrier setup.
   */
  app.post(
    '/logistics/providers/:provider/enable',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = z.object({ provider }).parse(request.params);
      const body = z
        .object({ connectionMode: z.enum(['MANUAL_ONLY', 'API']).default('MANUAL_ONLY') })
        .strict()
        .parse(request.body ?? {});
      const view = await setProvider({
        editor: editor(request),
        provider: params.provider as (typeof MANAGED_PROVIDERS)[number],
        enabled: true,
        connectionMode: body.connectionMode,
      });
      return reply.status(200).send({ provider: view });
    },
  );

  /** Switch a carrier off for the seller's own delivery stages. */
  app.post(
    '/logistics/providers/:provider/disable',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = z.object({ provider }).parse(request.params);
      const view = await setProvider({
        editor: editor(request),
        provider: params.provider as (typeof MANAGED_PROVIDERS)[number],
        enabled: false,
        connectionMode: 'MANUAL_ONLY',
      });
      return reply.status(200).send({ provider: view });
    },
  );

  /** Delivery companies this seller may put on a level: their own, and approved ones. */
  app.get('/logistics/partners', { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) }, async (request, reply) => {
    const seller = currentSeller(request);
    const partners = await prisma.logisticsPartner.findMany({
      where: {
        status: 'ACTIVE',
        archivedAt: null,
        OR: [
          { ownerSellerAccountId: seller.sellerAccountId },
          { sellerLinks: { some: { sellerAccountId: seller.sellerAccountId, status: 'APPROVED' } } },
        ],
      },
      select: { id: true, displayName: true, partnerKind: true },
      orderBy: { displayName: 'asc' },
    });
    return reply.status(200).send({ partners });
  });

  // --- Level prices ------------------------------------------------------

  /** The seller's delivery prices, optionally for one stage only. */
  app.get('/logistics/rates', { preHandler: requireSeller(SellerPermission.FULFILMENT_READ) }, async (request, reply) => {
    const seller = currentSeller(request);
    const query = z.object({ level: level.optional() }).parse(request.query);
    const policy = await readPolicy(seller.sellerAccountId, 'SELLER');
    const rates = policy.levels
      .filter((row) => query.level === undefined || row.level === query.level)
      .flatMap((row) => row.rates);
    return reply.status(200).send({ rates });
  });

  /**
   * Add a draft delivery price for one of the seller's stages. Buyers are not
   * charged it until it is published. Refused for a stage UBOSS handles.
   */
  app.post(
    '/logistics/rates',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const body = rateBody.parse(request.body);
      const who = editor(request);
      const rate = await saveRate(who, { ...toRateInput(body), sellerAccountId: who.sellerAccountId });
      return reply.status(201).send({ rate });
    },
  );

  /**
   * Change a delivery price. Editing a published price creates a new draft that
   * replaces it once published; the published one is never altered.
   */
  app.put(
    '/logistics/rates/:rateId',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = rateParam.parse(request.params);
      const body = rateBody.parse(request.body);
      const who = editor(request);
      const rate = await saveRate(who, { ...toRateInput(body), sellerAccountId: who.sellerAccountId, rateId: params.rateId });
      return reply.status(200).send({ rate });
    },
  );

  /** Publish a draft delivery price so buyers are charged it, replacing the price it supersedes. */
  app.post(
    '/logistics/rates/:rateId/publish',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = rateParam.parse(request.params);
      const who = editor(request);
      const rate = await publishRate(who, { sellerAccountId: who.sellerAccountId, rateId: params.rateId });
      return reply.status(200).send({ rate });
    },
  );

  /**
   * Switch a delivery price off. It stays on record, and orders already charged
   * at it keep it.
   */
  app.post(
    '/logistics/rates/:rateId/deactivate',
    { preHandler: requireSeller(SellerPermission.FULFILMENT_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = rateParam.parse(request.params);
      const who = editor(request);
      const rate = await deactivateRate(who, { sellerAccountId: who.sellerAccountId, rateId: params.rateId });
      return reply.status(200).send({ rate });
    },
  );

  // --- Legs of confirmed orders -----------------------------------------------

  /** The four delivery stages of one of the seller's confirmed orders, with who carries each and how far it has got. */
  app.get('/orders/:id/legs', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const params = idParam.parse(request.params);
    const seller = currentSeller(request);
    return reply.status(200).send({ legs: await legsForSellerOrder(seller.sellerAccountId, params.id) });
  });

  /**
   * Name the carrier for one of the seller's own delivery stages on an order:
   * a carrier booked by hand or a delivery company on the platform. Changing
   * the carrier after one is named needs a reason, and the company that loses
   * the work is told.
   */
  app.post(
    '/orders/:id/legs/:level/assign',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: ASSIGN_RATE_LIMIT } },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26), level }).parse(request.params);
      const body = assignBody.parse(request.body);
      const who = editor(request);
      const legId = await legOf(who.sellerAccountId, params.id, params.level);
      await assignLeg(who, legId, {
        ...body,
        provider: (body.provider ?? null) as (typeof MANAGED_PROVIDERS)[number] | null,
      });
      return reply.status(200).send({ legs: await legsForSellerOrder(who.sellerAccountId, params.id) });
    },
  );

  /** Enter the tracking number, pickup reference and expected dates on a delivery stage that already has a carrier. */
  app.patch(
    '/orders/:id/legs/:level',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: ASSIGN_RATE_LIMIT } },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26), level }).parse(request.params);
      const body = referencesBody.parse(request.body);
      const who = editor(request);
      const legId = await legOf(who.sellerAccountId, params.id, params.level);
      await updateLegReferences(who, legId, body);
      return reply.status(200).send({ legs: await legsForSellerOrder(who.sellerAccountId, params.id) });
    },
  );

  /**
   * Move one of the seller's delivery stages on an order forward: accepted,
   * started or handed over. A stage can start only once the one before it has
   * been handed over.
   *
   * An `idempotencyKey` makes a retried request return the earlier answer instead of moving the stage twice.
   */
  app.post(
    '/orders/:id/legs/:level/transition',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: ASSIGN_RATE_LIMIT } },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26), level }).parse(request.params);
      const body = transitionBody.parse(request.body);
      const who = editor(request);
      const legId = await legOf(who.sellerAccountId, params.id, params.level);
      await transitionLeg(who, legId, body);
      return reply.status(200).send({ legs: await legsForSellerOrder(who.sellerAccountId, params.id) });
    },
  );

  // --- Settlement, read-only ---------------------------------------------------

  /**
   * Estimate what the seller would be paid for a given sale amount and
   * delivery charge, after platform fees and the tax on them, using the fee
   * rules in force today. Read-only.
   */
  app.get('/settlements/estimate', { preHandler: requireSeller(SellerPermission.FINANCE_READ) }, async (request, reply) => {
    const seller = currentSeller(request);
    const query = z
      .object({
        goodsMinor: z.string().regex(/^\d{1,18}$/).default('0'),
        sellerDeliveryMinor: z.string().regex(/^\d{1,18}$/).default('0'),
        currency: z.string().length(3).optional(),
        marketCountry: z.string().length(2).optional(),
        // One of the seller's own listings, for its category's fee policy.
        offerId: z.string().length(26).optional(),
      })
      .parse(request.query);
    const estimate = await previewSettlement({
      sellerAccountId: seller.sellerAccountId,
      goodsMinor: BigInt(query.goodsMinor),
      sellerDeliveryMinor: BigInt(query.sellerDeliveryMinor),
      currency: query.currency ?? null,
      marketCountry: query.marketCountry ?? null,
      offerId: query.offerId ?? null,
    });
    return reply.status(200).send({ estimate });
  });

  /** The payouts already worked out for the seller's orders, newest first. */
  app.get('/settlements/orders', { preHandler: requireSeller(SellerPermission.FINANCE_READ) }, async (request, reply) => {
    const seller = currentSeller(request);
    return reply.status(200).send({ settlements: await listSellerSettlements(seller.sellerAccountId) });
  });

  return Promise.resolve();
}
