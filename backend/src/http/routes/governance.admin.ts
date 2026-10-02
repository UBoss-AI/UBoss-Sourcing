/**
 * Admin governance: maker-checker requests, the exception queues and the
 * integration monitor (JOURNEY-061, 065, LIVE-011).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import {
  approvePendingAction,
  listPendingActions,
  PENDING_ACTION_PERMISSION,
  rejectPendingAction,
  type StaffActor,
} from '../../modules/governance/pending-action.service.js';
import {
  exceptionQueueSettingInput,
  readExceptionQueues,
  saveExceptionQueueSetting,
} from '../../modules/governance/exception-queue.service.js';
import {
  paymentsDegraded,
  readIntegrationHealth,
  requeueCarrierDeadLetters,
} from '../../modules/governance/integration-health.service.js';
import { sendAccountMessage, accountMessageInput } from '../../modules/governance/account-message.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });
const WRITE_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

/** The member of staff behind a request, as the governance services take it. */
export function staffActorFrom(request: FastifyRequest): StaffActor {
  const user = currentUser(request);
  return {
    userId: user.id,
    email: user.email,
    permissions: user.permissions,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

const APPROVER_GRANTS = [...new Set(Object.values(PENDING_ACTION_PERMISSION))];

export function registerAdminGovernanceRoutes(app: FastifyInstance): Promise<void> {
  // Critical account actions waiting for (or decided by) a second member of staff, newest first; filter by status or record.
  app.get('/pending-actions', { preHandler: requireAdmin() }, async (request, reply) => {
    const actor = staffActorFrom(request);
    if (!APPROVER_GRANTS.some((grant) => actor.permissions.includes(grant))) throw forbidden();
    const query = z
      .object({
        status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FAILED']).optional(),
        resourceType: z.string().trim().min(1).max(48).optional(),
        resourceId: z.string().length(26).optional(),
      })
      .parse(request.query);
    return reply.header('cache-control', 'no-store').status(200).send({ actions: await listPendingActions(query) });
  });

  // Approve a critical account action someone else asked for, which runs it. The person who asked cannot approve. Audited.
  app.post(
    '/pending-actions/:id/approve',
    { preHandler: requireAdmin(), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ note: z.string().trim().max(1000).nullable().optional() }).parse(request.body ?? {});
      const action = await approvePendingAction(id, staffActorFrom(request), body.note ?? null);
      return reply.status(200).send({ action });
    },
  );

  // Reject a critical account action, or withdraw your own request. Audited.
  app.post(
    '/pending-actions/:id/reject',
    { preHandler: requireAdmin(), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ note: z.string().trim().max(1000).nullable().optional() }).parse(request.body ?? {});
      const action = await rejectPendingAction(id, staffActorFrom(request), body.note ?? null);
      return reply.status(200).send({ action });
    },
  );

  // Every admin exception queue the caller may see: SLA hours, owner and escalation role, items waiting, the oldest one's age and how many are past the SLA.
  app.get('/exception-queues', { preHandler: requireAdmin() }, async (request, reply) => {
    const actor = staffActorFrom(request);
    return reply
      .header('cache-control', 'no-store')
      .status(200)
      .send(await readExceptionQueues({ permissions: actor.permissions }));
  });

  // Change one exception queue's SLA hours, owner role or escalation role. Audited.
  app.put(
    '/exception-queues/:key',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { key } = z.object({ key: z.string().trim().min(1).max(48) }).parse(request.params);
      const body = exceptionQueueSettingInput.parse(request.body);
      const queue = await saveExceptionQueueSetting(key, body, staffActorFrom(request));
      return reply.status(200).send({ queue });
    },
  );

  // Health of every integration in one place: payment gateway, carriers, ERP feeds, inspection agencies and each webhook source's last delivery with accepted and rejected counts.
  app.get('/integrations/health', { preHandler: requireAdmin() }, async (request, reply) => {
    const actor = staffActorFrom(request);
    return reply
      .header('cache-control', 'no-store')
      .status(200)
      .send(await readIntegrationHealth({ permissions: actor.permissions }));
  });

  // Put dead-lettered carrier webhooks back on the retry queue, for one carrier integration or all. Audited.
  app.post(
    '/integrations/carrier-webhooks/requeue',
    { preHandler: requireAdmin(Permission.LOGISTICS_INTEGRATION_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const body = z
        .object({ carrierIntegrationId: z.string().length(26).nullable().optional() })
        .parse(request.body ?? {});
      const result = await requeueCarrierDeadLetters(body.carrierIntegrationId ?? null, staffActorFrom(request));
      return reply.status(200).send(result);
    },
  );

  // Send a customer or a seller a message: an in-app notice and an email. Audited.
  app.post(
    '/account-messages',
    { preHandler: requireAdmin(Permission.CUSTOMER_WRITE), config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = accountMessageInput.parse(request.body);
      const result = await sendAccountMessage(body, staffActorFrom(request));
      return reply.status(201).send(result);
    },
  );

  return Promise.resolve();
}

export function registerPublicServiceStatusRoutes(app: FastifyInstance): Promise<void> {
  // Whether card payments may be failing right now, as a yes or no for the storefront's notice. No detail.
  app.get('/service-status', async (_request, reply) => {
    const degraded = await paymentsDegraded();
    return reply.header('cache-control', 'public, max-age=60').status(200).send({ paymentsDegraded: degraded });
  });

  return Promise.resolve();
}
