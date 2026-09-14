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
  app.get('/config', async (request, reply) => {
    const config = await getStorefrontConfig();

    /*
     * Whose shop this is, when it is a seller's.
     *
     * The storefront reads this before its first render, because it decides the
     * name in the header, the support address in the footer and the wording on
     * every page that says who you are buying from. Null for the operator's own
     * shop, which is what every deployment without seller subdomains returns.
     *
     * The seller's own contact details replace the operator's on their shop.
     * Sending a shopper on `northwind.uboss.example` to the operator's support
     * address about Northwind's order is a support ticket neither of them can
     * answer.
     */
    const seller = request.storefront;

    const body =
      seller === null
        ? config
        : {
            ...config,
            business: {
              ...(config['business'] as Record<string, unknown>),
              displayName: seller.displayName,
              legalName: seller.legalName,
              supportEmail: seller.supportEmail,
              supportPhone: seller.supportPhone,
              /*
               * Theirs, or nothing.
               *
               * Never the operator's. A seller's shop front showing the
               * marketplace's mark above the seller's name tells a buyer they
               * are somewhere they are not, which is the exact confusion a
               * per-seller shop front exists to remove. Where a seller has
               * uploaded none, the storefront renders their initial instead.
               */
              logo:
                seller.logoUrl === null
                  ? null
                  : { url: seller.logoUrl, altText: seller.displayName },
            },
            seller: {
              id: seller.sellerAccountId,
              slug: seller.slug,
              displayName: seller.displayName,
              legalName: seller.legalName,
              description: seller.description,
            },
          };

    return (
      reply
        /*
         * Private, and only on a seller's shop.
         *
         * The operator's config is the same for everybody and is worth caching
         * at the edge. A seller's is host-dependent, and a shared cache that
         * ignores the Host header would serve one seller's name and support
         * address on another seller's domain.
         */
        .header(
          'cache-control',
          seller === null
            ? 'public, max-age=60, stale-while-revalidate=300'
            : 'private, max-age=60',
        )
        .header('vary', 'host')
        .status(200)
        .send(body)
    );
  });

  return Promise.resolve();
}
