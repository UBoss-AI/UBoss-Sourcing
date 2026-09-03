/**
 * Public storefront configuration.
 *
 * Unauthenticated, because the storefront needs it before anyone signs in — the
 * header, the footer and the currency of every price depend on it.
 *
 * The response is built by an explicit allowlist in
 * `settings.service.getStorefrontConfig`, not by filtering the admin business
 * profile. Filtering by omission leaks the next field somebody adds; an
 * allowlist has to be edited on purpose.
 *
 * Cached at the edge for a minute. This changes about as often as a company
 * changes its name, and every page load asks for it.
 */
import type { FastifyInstance } from 'fastify';
import { getStorefrontConfig } from '../../modules/settings/settings.service.js';

export function registerPublicConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/config', async (_request, reply) => {
    const config = await getStorefrontConfig();

    return reply
      .header('cache-control', 'public, max-age=60, stale-while-revalidate=300')
      .status(200)
      .send(config);
  });

  return Promise.resolve();
}
