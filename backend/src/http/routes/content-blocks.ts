/**
 * Storefront banners and category content blocks (Master row 72).
 *
 * Staff write them under /admin/content-blocks (settings permissions, every
 * write audited); the storefront reads the live ones for the shopper's
 * country and language from /catalog/content-blocks, signed in or not.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import {
  contentBlockInput,
  deleteContentBlock,
  listContentBlocks,
  liveContentBlocks,
  saveContentBlock,
} from '../../modules/settings/content-block.service.js';
import type { SettingsActor } from '../../modules/settings/settings.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });
const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

function actorFrom(request: FastifyRequest): SettingsActor {
  const user = currentUser(request);
  return { userId: user.id, email: user.email, ipAddress: request.ip, correlationId: request.correlationId };
}

export function registerAdminContentBlockRoutes(app: FastifyInstance): Promise<void> {
  // Every banner and category block, drafts included.
  app.get('/content-blocks', { preHandler: requireAdmin(Permission.SETTINGS_READ) }, async (_request, reply) =>
    reply.status(200).send({ blocks: await listContentBlocks() }),
  );

  // Add a banner or category block with its targeting and schedule. Audited.
  app.post(
    '/content-blocks',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) =>
      reply.status(201).send({ block: await saveContentBlock(null, contentBlockInput.parse(request.body), actorFrom(request)) }),
  );

  // Replace a banner or category block. Audited.
  app.put(
    '/content-blocks/:id',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply
        .status(200)
        .send({ block: await saveContentBlock(id, contentBlockInput.parse(request.body), actorFrom(request)) });
    },
  );

  // Delete a banner or category block. Audited.
  app.delete(
    '/content-blocks/:id',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await deleteContentBlock(id, actorFrom(request));
      return reply.status(204).send();
    },
  );

  return Promise.resolve();
}

export function registerPublicContentBlockRoutes(app: FastifyInstance): Promise<void> {
  // The published banners or category blocks live now for a country and language.
  app.get('/content-blocks', async (request, reply) => {
    const query = z
      .object({
        placement: z.enum(['HOME_BANNER', 'CATEGORY_BLOCK']).default('HOME_BANNER'),
        country: z.string().trim().regex(/^[A-Za-z]{2}$/).optional(),
        language: z.string().trim().max(12).optional(),
        category: z.string().trim().max(255).optional(),
      })
      .parse(request.query);
    const blocks = await liveContentBlocks({
      placement: query.placement,
      country: query.country ?? null,
      language: query.language ?? null,
      categorySlug: query.category ?? null,
    });
    return reply.header('cache-control', 'public, max-age=60').status(200).send({ blocks });
  });

  return Promise.resolve();
}
