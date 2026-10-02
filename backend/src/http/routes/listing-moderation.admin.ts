/**
 * Listing moderation rules and appeal decisions (JOURNEY-062).
 *
 * The prohibited-terms list is catalogue authority: reading it needs
 * `product.read`, changing it and deciding an appeal need `product.publish`,
 * the same grant that approves a listing.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import {
  decideListingAppeal,
  deleteProhibitedTerm,
  listProhibitedTerms,
  prohibitedTermInput,
  saveProhibitedTerm,
} from '../../modules/seller/listing-moderation.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });
const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

export function registerAdminListingModerationRoutes(app: FastifyInstance): Promise<void> {
  // Every prohibited listing term, with its reason, severity and whether it is switched on.
  app.get('/listing-moderation/terms', { preHandler: requireAdmin(Permission.PRODUCT_READ) }, async (_request, reply) =>
    reply.status(200).send({ terms: await listProhibitedTerms() }),
  );

  // Add a prohibited term. Submitted listings containing it are flagged for the moderator. Audited.
  app.post(
    '/listing-moderation/terms',
    { preHandler: requireAdmin(Permission.PRODUCT_PUBLISH), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const user = currentUser(request);
      const term = await saveProhibitedTerm(null, prohibitedTermInput.parse(request.body), {
        userId: user.id,
        email: user.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });
      return reply.status(201).send({ term });
    },
  );

  // Change a prohibited term. Audited.
  app.put(
    '/listing-moderation/terms/:id',
    { preHandler: requireAdmin(Permission.PRODUCT_PUBLISH), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const user = currentUser(request);
      const term = await saveProhibitedTerm(id, prohibitedTermInput.parse(request.body), {
        userId: user.id,
        email: user.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });
      return reply.status(200).send({ term });
    },
  );

  // Remove a prohibited term. Audited.
  app.delete(
    '/listing-moderation/terms/:id',
    { preHandler: requireAdmin(Permission.PRODUCT_PUBLISH), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const user = currentUser(request);
      await deleteProhibitedTerm(id, { userId: user.id, email: user.email, ipAddress: request.ip, correlationId: request.correlationId });
      return reply.status(204).send();
    },
  );

  // Decide a seller's appeal against a refused listing: upheld sends it back for review, refused keeps it refused. Not by the moderator who refused it. Audited.
  app.post(
    '/seller-listings/:id/appeal-decision',
    { preHandler: requireAdmin(Permission.PRODUCT_PUBLISH), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ outcome: z.enum(['UPHELD', 'REFUSED']), comment: z.string().trim().min(3).max(4000) })
        .parse(request.body);
      const user = currentUser(request);
      const result = await decideListingAppeal({
        draftId: id,
        outcome: body.outcome,
        comment: body.comment,
        actor: { userId: user.id, email: user.email, ipAddress: request.ip, correlationId: request.correlationId },
      });
      return reply.status(200).send(result);
    },
  );

  return Promise.resolve();
}
