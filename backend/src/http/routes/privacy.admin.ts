/**
 * The data subject request queue - admin only.
 *
 * Four routes and no more, because there are only four things a member of
 * staff can do with a request: see the queue, open one, action it, or refuse
 * it. There is deliberately no "erase this customer" endpoint that skips the
 * request record. Art. 5(2) requires the controller be able to demonstrate
 * compliance, and an erasure with no request behind it demonstrates nothing -
 * it is just a destructive admin action.
 *
 * `data_request.read` and `data_request.action` are separate grants. Reading
 * the queue is close to ordinary customer-service work; approving an erasure
 * destroys data irreversibly, and refusing one is a decision the subject may
 * take to a supervisory authority.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import {
  approveRequest,
  getRequestForAdmin,
  listRequests,
  rejectRequest,
} from '../../modules/privacy/data-request.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const listQuery = z.object({
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'FAILED']).optional(),
  type: z.enum(['EXPORT', 'ERASURE']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const idParam = z.object({ requestId: z.string().length(26) });

/**
 * A decision.
 *
 * The note is optional on approval - "yes" needs no explanation - and required
 * on refusal, which the service enforces rather than the schema, so that the
 * error names the obligation instead of reading as a missing field.
 */
const decisionSchema = z.object({
  note: z.string().max(1024).nullable().optional(),
});

function actorFrom(request: FastifyRequest): { userId: string; email: string } {
  const auth = currentUser(request);
  return { userId: auth.id, email: auth.email };
}

export function registerAdminPrivacyRoutes(app: FastifyInstance): Promise<void> {
  /** The queue, soonest deadline first. */
  app.get(
    '/data-requests',
    { preHandler: requireAdmin(Permission.DATA_REQUEST_READ) },
    async (request, reply) => {
      const query = listQuery.parse(request.query);
      const result = await listRequests(query);
      return reply.status(200).send(result);
    },
  );

  /**
   * One request, with the blockers.
   *
   * For a pending erasure this recomputes what stands in the way - unpaid
   * orders, open returns - so the person deciding sees the position now rather
   * than whatever it was when the row was written.
   */
  app.get(
    '/data-requests/:requestId',
    { preHandler: requireAdmin(Permission.DATA_REQUEST_READ) },
    async (request, reply) => {
      const { requestId } = idParam.parse(request.params);
      const result = await getRequestForAdmin(requestId);
      return reply.status(200).send(result);
    },
  );

  /**
   * Action it.
   *
   * Returns 202: approving queues the work rather than doing it here. An
   * erasure rewrites rows across a dozen tables and must not be tied to
   * whether the browser stayed connected.
   */
  app.post(
    '/data-requests/:requestId/approve',
    { preHandler: requireAdmin(Permission.DATA_REQUEST_ACTION) },
    async (request, reply) => {
      const { requestId } = idParam.parse(request.params);
      const body = decisionSchema.parse(request.body ?? {});
      const actor = actorFrom(request);

      await approveRequest({
        requestId,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        note: body.note ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(202).send({ approved: true });
    },
  );

  /** Refuse it. The reason is not optional - see `rejectRequest`. */
  app.post(
    '/data-requests/:requestId/reject',
    { preHandler: requireAdmin(Permission.DATA_REQUEST_ACTION) },
    async (request, reply) => {
      const { requestId } = idParam.parse(request.params);
      const body = decisionSchema.parse(request.body ?? {});
      const actor = actorFrom(request);

      await rejectRequest({
        requestId,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        note: body.note ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ rejected: true });
    },
  );

  return Promise.resolve();
}
