/**
 * Fee rules and the maker-checker around fee changes - finance staff only.
 *
 * Value bands, volume tiers, seller tiers and promotions sit on top of the
 * platform-fee policy (see `modules/settings/platform-fee-rule.service.ts`).
 * Every one, like every policy, is drafted by one person and approved by
 * another. The routes here are the submit / approve / reject half of that for
 * both, plus setting a seller's fee tier.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import {
  approveFeeRule,
  createDraftFeeRule,
  listFeeRules,
  listSellerFeeTiers,
  ordersUsingFeeRule,
  rejectFeeRule,
  retireFeeRule,
  setSellerFeeTier,
  submitFeeRule,
  updateDraftFeeRule,
} from '../../modules/settings/platform-fee-rule.service.js';
import { rejectPolicy, submitPolicy, type FinanceActor } from '../../modules/settings/platform-fee.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });
const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;
const DECISION_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

function financeActor(request: FastifyRequest): FinanceActor {
  const user = currentUser(request);
  return { userId: user.id, email: user.email, ipAddress: request.ip, correlationId: request.correlationId };
}

const minorText = z.string().trim().max(20).nullable().optional();
const rateText = z.string().trim().max(12).nullable().optional();

const feeRuleBody = z
  .object({
    kind: z.enum(['VALUE_BAND', 'VOLUME_TIER', 'SELLER_TIER', 'PROMOTION']),
    scope: z.enum(['GLOBAL', 'MARKET', 'CATEGORY', 'SELLER']),
    sellerAccountId: z.string().length(26).nullable().optional(),
    categoryId: z.string().length(26).nullable().optional(),
    marketCountry: z.string().trim().length(2).nullable().optional(),
    name: z.string().trim().min(2).max(160),
    currency: z.string().trim().max(3).nullable().optional(),
    minValueMinor: minorText,
    maxValueMinor: minorText,
    volumeThresholdMinor: minorText,
    volumeWindowDays: z.number().int().min(1).max(3660).nullable().optional(),
    sellerTier: z.string().trim().max(32).nullable().optional(),
    percentRate: rateText,
    discountPercent: rateText,
    effectiveFrom: z.coerce.date().nullable().optional(),
    effectiveTo: z.coerce.date().nullable().optional(),
    notes: z.string().trim().max(1024).nullable().optional(),
    supersedesRuleId: z.string().length(26).nullable().optional(),
  })
  .strict();

const reasonBody = z.object({ reason: z.string().trim().min(10).max(1000) }).strict();

export function registerAdminPlatformFeeRuleRoutes(app: FastifyInstance): Promise<void> {
  // --- Maker-checker on fee policies -------------------------------------------

  /**
   * Submit a draft platform fee policy for approval by a second member of
   * finance staff. Writes an audit entry.
   */
  app.post(
    '/platform-fees/:id/submit',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: DECISION_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      return reply.status(200).send({ policy: await submitPolicy(financeActor(request), params.id) });
    },
  );

  /**
   * Send a submitted platform fee policy back to draft, with a reason of at
   * least ten characters. Writes an audit entry.
   */
  app.post(
    '/platform-fees/:id/reject',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: DECISION_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = reasonBody.parse(request.body);
      return reply.status(200).send({ policy: await rejectPolicy(financeActor(request), params.id, body) });
    },
  );

  // --- Fee rules -----------------------------------------------------------------

  /**
   * List the fee rules (value bands, volume tiers, seller tiers, promotions),
   * optionally by status, with how many seller orders each has changed.
   */
  app.get('/platform-fee-rules', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => {
    const query = z
      .object({ status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'RETIRED']).optional() })
      .parse(request.query);
    return reply.status(200).send({ rules: await listFeeRules({ status: query.status ?? null }) });
  });

  /**
   * Create a draft fee rule. It changes nothing until a second member of
   * finance staff approves it. Writes an audit entry.
   */
  app.post(
    '/platform-fee-rules',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const body = feeRuleBody.parse(request.body);
      return reply.status(201).send({ rule: await createDraftFeeRule(financeActor(request), body) });
    },
  );

  /**
   * Change a draft fee rule. Refused once it is submitted, published or
   * retired, or if the change would alter its kind or scope. Writes an audit
   * entry.
   */
  app.put(
    '/platform-fee-rules/:id',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = feeRuleBody.parse(request.body);
      return reply.status(200).send({ rule: await updateDraftFeeRule(financeActor(request), params.id, body) });
    },
  );

  /** Submit a draft fee rule for a second person's approval. Writes an audit entry. */
  app.post(
    '/platform-fee-rules/:id/submit',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: DECISION_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      return reply.status(200).send({ rule: await submitFeeRule(financeActor(request), params.id) });
    },
  );

  /**
   * Approve a submitted fee rule, publishing it and retiring any rule it
   * replaces. Refused for whoever created, edited or submitted it. Writes an
   * audit entry.
   */
  app.post(
    '/platform-fee-rules/:id/approve',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: DECISION_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      return reply.status(200).send({ rule: await approveFeeRule(financeActor(request), params.id) });
    },
  );

  /** Send a submitted fee rule back to draft, with a reason. Writes an audit entry. */
  app.post(
    '/platform-fee-rules/:id/reject',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: DECISION_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = reasonBody.parse(request.body);
      return reply.status(200).send({ rule: await rejectFeeRule(financeActor(request), params.id, body) });
    },
  );

  /** Retire a fee rule so it stops applying to new orders. Writes an audit entry. */
  app.post(
    '/platform-fee-rules/:id/retire',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: DECISION_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      return reply.status(200).send({ rule: await retireFeeRule(financeActor(request), params.id) });
    },
  );

  /** The seller orders whose fee one fee rule changed, and by how much. */
  app.get('/platform-fee-rules/:id/orders', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (request, reply) => {
    const params = idParam.parse(request.params);
    return reply.status(200).send(await ordersUsingFeeRule(params.id));
  });

  // --- Seller fee tiers --------------------------------------------------------

  /** The sellers placed in a fee tier, and which tier. */
  app.get('/seller-fee-tiers', { preHandler: requireAdmin(Permission.FINANCE_POLICY_READ) }, async (_request, reply) => {
    return reply.status(200).send({ sellers: await listSellerFeeTiers() });
  });

  /**
   * Put a seller in a fee tier, or take them out of one, with a reason. Only
   * their next orders are affected. Writes an audit entry.
   */
  app.put(
    '/seller-fee-tiers/:id',
    { preHandler: requireAdmin(Permission.FINANCE_POLICY_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({ tier: z.string().trim().max(32).nullable(), reason: z.string().trim().min(10).max(1000) })
        .strict()
        .parse(request.body);
      return reply.status(200).send(await setSellerFeeTier(financeActor(request), params.id, body));
    },
  );

  return Promise.resolve();
}
