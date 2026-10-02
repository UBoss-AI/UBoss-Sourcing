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
  approveContentBlock,
  contentBlockInput,
  deleteContentBlock,
  listContentBlocks,
  listContentBlockVersions,
  liveContentBlocks,
  previewContentBlocks,
  restoreContentBlockVersion,
  returnContentBlock,
  saveContentBlock,
  submitContentBlock,
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
      reply.status(201).send(await saveContentBlock(null, contentBlockInput.parse(request.body), actorFrom(request))),
  );

  // Replace a banner or category block. Audited.
  app.put(
    '/content-blocks/:id',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply
        .status(200)
        .send(await saveContentBlock(id, contentBlockInput.parse(request.body), actorFrom(request)));
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

  // Send a draft block for approval by a second member of staff. Audited.
  app.post(
    '/content-blocks/:id/submit',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send({ block: await submitContentBlock(id, actorFrom(request)) });
    },
  );

  // Approve and publish a block someone else sent for approval; refused while a blocking conflict stands. Audited.
  app.post(
    '/content-blocks/:id/approve',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send({ block: await approveContentBlock(id, actorFrom(request)) });
    },
  );

  // Send a block back to draft: refuse an approval, or take a published block off the storefront. Audited.
  app.post(
    '/content-blocks/:id/return',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send({ block: await returnContentBlock(id, actorFrom(request)) });
    },
  );

  // Every saved version of a block, newest first.
  app.get('/content-blocks/:id/versions', { preHandler: requireAdmin(Permission.SETTINGS_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.status(200).send({ versions: await listContentBlockVersions(id) });
  });

  // Roll a block back to an earlier version, as a new draft that needs approval again. Audited.
  app.post(
    '/content-blocks/:id/versions/:revision/restore',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id, revision } = z
        .object({ id: z.string().length(26), revision: z.coerce.number().int().min(1) })
        .parse(request.params);
      return reply.status(200).send(await restoreContentBlockVersion(id, revision, actorFrom(request)));
    },
  );

  // Preview what the storefront would show for a country, language and moment, optionally with drafts and blocks waiting for approval.
  app.get('/content-blocks/preview', { preHandler: requireAdmin(Permission.SETTINGS_READ) }, async (request, reply) => {
    const query = z
      .object({
        placement: z.enum(['HOME_BANNER', 'CATEGORY_BLOCK']).default('HOME_BANNER'),
        country: z.string().trim().regex(/^[A-Za-z]{2}$/).optional(),
        language: z.string().trim().max(12).optional(),
        category: z.string().trim().max(255).optional(),
        at: z.coerce.date().optional(),
        includeUnpublished: z
          .enum(['true', 'false'])
          .default('true')
          .transform((value) => value === 'true'),
      })
      .parse(request.query);
    const blocks = await previewContentBlocks({
      placement: query.placement,
      country: query.country ?? null,
      language: query.language ?? null,
      categorySlug: query.category ?? null,
      at: query.at ?? new Date(),
      includeUnpublished: query.includeUnpublished,
    });
    return reply.header('cache-control', 'no-store').status(200).send({ blocks });
  });

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
