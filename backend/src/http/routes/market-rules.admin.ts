/**
 * Country / compliance rules (Master row 69) and the operator's lane rate
 * cards (Master row 71) - staff routes.
 *
 * Country rules need settings permissions; rate cards need logistics ones.
 * Every write is audited by the service.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import {
  deleteMarketRule,
  labelRequirements,
  listMarketRules,
  listMarketRuleVersions,
  marketRuleInput,
  saveMarketRule,
} from '../../modules/catalog/market-rule-admin.service.js';
import { laneInput, laneQuoteInput, listLanes, quoteLanes, saveLane } from '../../modules/logistics/lane-rate.service.js';
import type { SettingsActor } from '../../modules/settings/settings.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });
const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

function actorFrom(request: FastifyRequest): SettingsActor {
  const user = currentUser(request);
  return { userId: user.id, email: user.email, ipAddress: request.ip, correlationId: request.correlationId };
}

export function registerAdminMarketRuleRoutes(app: FastifyInstance): Promise<void> {
  // Every country rule, optionally for one destination country.
  app.get('/market-rules', { preHandler: requireAdmin(Permission.SETTINGS_READ) }, async (request, reply) => {
    const query = z.object({ country: z.string().trim().length(2).optional() }).parse(request.query);
    return reply.status(200).send({ rules: await listMarketRules({ countryCode: query.country }) });
  });

  // Add a country rule: block or require documents, optionally above an order value. Audited.
  app.post(
    '/market-rules',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) =>
      reply.status(201).send({ rule: await saveMarketRule(null, marketRuleInput.parse(request.body), actorFrom(request)) }),
  );

  // Replace a country rule. Audited.
  app.put(
    '/market-rules/:id',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send({ rule: await saveMarketRule(id, marketRuleInput.parse(request.body), actorFrom(request)) });
    },
  );

  // A country rule's history, newest first: every save and the deletion, with who made it and what the rule said.
  app.get('/market-rules/:id/versions', { preHandler: requireAdmin(Permission.SETTINGS_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.status(200).send({ versions: await listMarketRuleVersions(id) });
  });

  // Delete a country rule. Audited.
  app.delete(
    '/market-rules/:id',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await deleteMarketRule(id, actorFrom(request));
      return reply.status(204).send();
    },
  );

  // Every operator rate card (lane) with its weight bands.
  app.get('/logistics/lanes', { preHandler: requireAdmin(Permission.LOGISTICS_READ) }, async (_request, reply) =>
    reply.status(200).send({ lanes: await listLanes() }),
  );

  // Add a rate card: route, mode, carrier, transit, currency and weight bands. Audited.
  app.post(
    '/logistics/lanes',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) =>
      reply.status(201).send({ lane: await saveLane(null, laneInput.parse(request.body), actorFrom(request)) }),
  );

  // Replace a rate card and its bands; bumps its version. Audited.
  app.put(
    '/logistics/lanes/:id',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send({ lane: await saveLane(id, laneInput.parse(request.body), actorFrom(request)) });
    },
  );

  // Test a rate: every serviceable rate card that carries this weight on this route, cheapest first.
  app.post('/logistics/lanes/quote', { preHandler: requireAdmin(Permission.LOGISTICS_READ) }, async (request, reply) =>
    reply.status(200).send({ quotes: await quoteLanes(laneQuoteInput.parse(request.body)) }),
  );

  return Promise.resolve();
}

export function registerPublicLabelRuleRoutes(app: FastifyInstance): Promise<void> {
  // The labelling the products in a basket must carry for a delivery country, for checkout to show.
  app.get('/label-requirements', async (request, reply) => {
    const query = z
      .object({
        country: z.string().trim().regex(/^[A-Za-z]{2}$/),
        products: z
          .string()
          .trim()
          .max(26 * 100 + 99)
          .transform((value) => value.split(',').filter((id) => id.length === 26)),
      })
      .parse(request.query);
    const requirements = await labelRequirements(query.country, query.products.slice(0, 100));
    return reply.header('cache-control', 'public, max-age=60').status(200).send({ requirements });
  });

  return Promise.resolve();
}
