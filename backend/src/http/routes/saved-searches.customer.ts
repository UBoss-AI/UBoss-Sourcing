/**
 * A buyer's saved searches: list, save, rename or switch alerts, delete.
 *
 * Mounted at /account/saved-searches behind `requireCustomer`. Every call is
 * scoped by the buyer's own profile id, so another buyer's search is simply
 * not found. The alerts themselves are sent by the worker - see
 * `modules/catalog/saved-search.service.ts`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../domain/errors.js';
import {
  SAVED_SEARCH_LIMIT,
  createSavedSearch,
  createSavedSearchSchema,
  deleteSavedSearch,
  listSavedSearches,
  updateSavedSearch,
  updateSavedSearchSchema,
} from '../../modules/catalog/saved-search.service.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

function profileOf(request: FastifyRequest): string {
  const profileId = currentUser(request).customerProfileId;
  if (profileId === null || profileId === undefined) throw notFound('Customer profile');
  return profileId;
}

export function registerCustomerSavedSearchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  // The buyer's saved searches, newest first, with the most they may keep.
  app.get('/', async (request, reply) => {
    const items = await listSavedSearches(profileOf(request));
    return reply
      .header('cache-control', 'no-store')
      .status(200)
      .send({ items, limit: SAVED_SEARCH_LIMIT });
  });

  // Save a search term and its filters, with new-match e-mail alerts on unless asked otherwise.
  app.post(
    '/',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = createSavedSearchSchema.parse(request.body);
      const saved = await createSavedSearch(profileOf(request), body);
      return reply.status(201).send(saved);
    },
  );

  // Rename one of the buyer's saved searches, or switch its alerts on or off.
  app.patch('/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = updateSavedSearchSchema.parse(request.body);
    const saved = await updateSavedSearch(profileOf(request), id, body);
    return reply.status(200).send(saved);
  });

  // Delete one of the buyer's saved searches.
  app.delete('/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await deleteSavedSearch(profileOf(request), id);
    return reply.status(204).send();
  });

  return Promise.resolve();
}
