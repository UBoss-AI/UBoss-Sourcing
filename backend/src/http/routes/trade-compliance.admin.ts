/**
 * Destination compliance and cargo insurance - staff routes (JOURNEY-046 and
 * JOURNEY-049). Under `/admin`.
 *
 * Trade rules need settings permissions; insurance settings and the dispatch
 * hold override need logistics ones; the HS code queue needs product ones.
 * Every write is audited by its service.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import {
  adminOrderCompliance,
  grantComplianceOverride,
  revokeComplianceOverride,
} from '../../modules/compliance/destination-compliance.service.js';
import { decideHsCode, hsDecisionInput, listHsReviews } from '../../modules/compliance/hs-verification.service.js';
import {
  deleteTradeRule,
  listTradeRules,
  saveTradeRule,
  tradeRuleInput,
} from '../../modules/compliance/trade-rule-admin.service.js';
import {
  readInsuranceSettings,
  saveInsuranceSettings,
  tradeSettingsInput,
} from '../../modules/compliance/trade-settings.service.js';
import type { SettingsActor } from '../../modules/settings/settings.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });
const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

function actorFrom(request: FastifyRequest): SettingsActor {
  const user = currentUser(request);
  return { userId: user.id, email: user.email, ipAddress: request.ip, correlationId: request.correlationId };
}

export function registerAdminTradeComplianceRoutes(app: FastifyInstance): Promise<void> {
  // Every destination and category trade rule, optionally for one destination country.
  app.get('/trade-rules', { preHandler: requireAdmin(Permission.SETTINGS_READ) }, async (request, reply) => {
    const query = z.object({ country: z.string().trim().length(2).optional() }).parse(request.query);
    return reply.send({ rules: await listTradeRules({ destinationCountry: query.country }) });
  });

  // Add a trade rule: restricted or prohibited goods, a required document and who produces it, HS verification. Audited.
  app.post(
    '/trade-rules',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) =>
      reply.status(201).send({ rule: await saveTradeRule(null, tradeRuleInput.parse(request.body), actorFrom(request)) }),
  );

  // Replace a trade rule. Audited.
  app.put(
    '/trade-rules/:id',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send({ rule: await saveTradeRule(id, tradeRuleInput.parse(request.body), actorFrom(request)) });
    },
  );

  // Delete a trade rule. Audited.
  app.delete(
    '/trade-rules/:id',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await deleteTradeRule(id, actorFrom(request));
      return reply.status(204).send();
    },
  );

  // The cargo insurance rate and the most that may be insured, in basis points. 0 means insurance is not offered.
  app.get('/logistics/trade-settings', { preHandler: requireAdmin(Permission.LOGISTICS_READ) }, async (_request, reply) =>
    reply.send({ settings: await readInsuranceSettings() }),
  );

  // Change the cargo insurance rate and cap. Audited.
  app.put(
    '/logistics/trade-settings',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) =>
      reply.send({ settings: await saveInsuranceSettings(tradeSettingsInput.parse(request.body), actorFrom(request)) }),
  );

  // Listings whose declared HS code is in one review state (DECLARED by default): the HS verification queue.
  app.get('/hs-verifications', { preHandler: requireAdmin(Permission.PRODUCT_READ) }, async (request, reply) => {
    const query = z
      .object({ state: z.enum(['DECLARED', 'VERIFIED', 'REJECTED']).default('DECLARED') })
      .parse(request.query);
    return reply.header('cache-control', 'no-store').send({ reviews: await listHsReviews(query.state) });
  });

  // Verify a listing's HS code, optionally correcting it, or reject it with a note. Audited; the seller is told.
  app.post(
    '/hs-verifications/:id/decision',
    { preHandler: requireAdmin(Permission.PRODUCT_PUBLISH), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send({ review: await decideHsCode(id, hsDecisionInput.parse(request.body), actorFrom(request)) });
    },
  );

  // Destination readiness of every seller order on one order: rules that apply, what holds the goods, any override.
  app.get('/orders/:id/compliance', { preHandler: requireAdmin(Permission.ORDER_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.header('cache-control', 'no-store').send({ sellerOrders: await adminOrderCompliance(id) });
  });

  // Let one seller order's goods leave despite its current compliance holds, with a written reason. Audited.
  app.post(
    '/seller-orders/:id/compliance-override',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ reason: z.string().trim().min(1).max(1000) }).strict().parse(request.body);
      const sellerOrder = await grantComplianceOverride({
        sellerOrderGroupId: id,
        reason: body.reason,
        actor: actorFrom(request),
      });
      return reply.send({ sellerOrder });
    },
  );

  // Withdraw a compliance override: the holds apply again. Audited.
  app.delete(
    '/seller-orders/:id/compliance-override',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send({ sellerOrder: await revokeComplianceOverride({ sellerOrderGroupId: id, actor: actorFrom(request) }) });
    },
  );

  return Promise.resolve();
}
