/**
 * The fraud and risk review queue (checklist SEC-008).
 *
 * Signals are raised by the worker (`modules/risk/risk.service.ts`). Here a
 * reviewer reads them and decides each one, and the Business Owner tunes the
 * rules. Reading needs `risk.read`, deciding `risk.review`, changing a rule
 * `risk.rule.write`. Nothing here suspends, cancels or holds anything.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import {
  listRiskRules,
  listRiskSignals,
  reviewRiskSignal,
  updateRiskRule,
  type RiskActor,
} from '../../modules/risk/risk.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

function actorOf(request: FastifyRequest): RiskActor {
  const auth = currentUser(request);
  return { userId: auth.id, email: auth.email, ipAddress: request.ip, correlationId: request.correlationId };
}

export function registerAdminRiskRoutes(app: FastifyInstance): Promise<void> {
  // Risk signals, newest first, filtered by status or rule.
  app.get('/risk/signals', { preHandler: requireAdmin(Permission.RISK_READ) }, async (request, reply) => {
    const query = z
      .object({
        status: z.enum(['OPEN', 'CONFIRMED', 'FALSE_POSITIVE']).optional(),
        ruleCode: z.string().max(48).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);
    return reply.header('cache-control', 'no-store').send({ signals: await listRiskSignals(query) });
  });

  // Decide a risk signal: confirmed or a false positive, with a reason. Changing an earlier decision is recorded as an override.
  app.post('/risk/signals/:id/decision', { preHandler: requireAdmin(Permission.RISK_REVIEW) }, async (request, reply) => {
    const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
    const body = z
      .object({ decision: z.enum(['CONFIRMED', 'FALSE_POSITIVE']), reason: z.string().max(1024) })
      .parse(request.body);
    await reviewRiskSignal(id, body, actorOf(request));
    return reply.status(204).send();
  });

  // The fraud rules, their thresholds and whether the business has approved them for production.
  app.get('/risk/rules', { preHandler: requireAdmin(Permission.RISK_READ) }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ rules: await listRiskRules() }),
  );

  // Change one rule or approve its values for production. Needs the version you read.
  app.patch('/risk/rules/:code', { preHandler: requireAdmin(Permission.RISK_RULE_WRITE) }, async (request, reply) => {
    const { code } = z.object({ code: z.string().regex(/^[A-Z_]{3,48}$/) }).parse(request.params);
    const body = z
      .object({
        expectedVersion: z.number().int().min(1),
        enabled: z.boolean().optional(),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
        threshold: z.number().int().min(1).max(1_000_000).optional(),
        windowMinutes: z.number().int().min(1).max(1_051_200).optional(),
        thresholdMinor: z.string().regex(/^\d{1,18}$/).nullable().optional(),
        currency: z.string().length(3).toUpperCase().nullable().optional(),
        approvedForProduction: z.boolean().optional(),
      })
      .parse(request.body);
    const { thresholdMinor, ...rest } = body;
    const rule = await updateRiskRule(
      code,
      { ...rest, ...(thresholdMinor === undefined ? {} : { thresholdMinor: thresholdMinor === null ? null : BigInt(thresholdMinor) }) },
      actorOf(request),
    );
    return reply.send({ rule });
  });

  return Promise.resolve();
}
