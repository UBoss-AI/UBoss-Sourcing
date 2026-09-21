/**
 * The sitemap, generated from the catalogue that actually exists.
 *
 * WHY THIS IS A SERVER ROUTE AND NOT A FILE
 *
 * The storefront is a static bundle. A sitemap committed next to it would list
 * whatever products existed on the day somebody last built it, which for a
 * marketplace taking listings from independent sellers is wrong within hours.
 * This reads the same visibility rules the catalogue itself reads, so a
 * product that is unpublished, archived, or in a category that was switched
 * off disappears from the sitemap in the same moment it disappears from the
 * shop.
 *
 * WHAT IT DELIBERATELY DOES NOT LIST
 *
 * Anything behind a sign-in, anything per-customer, and anything with a query
 * string. `robots.txt` says the same thing, and the two agree on purpose: a
 * sitemap that lists a URL robots.txt forbids is a contradiction a crawler
 * resolves by trusting neither.
 *
 * THE LANGUAGE ALTERNATES
 *
 * Every entry carries `xhtml:link` alternates for the eight languages, which
 * is the sitemap half of what the `hreflang` tags in the page head say. Both
 * halves are needed: the tags are what a crawler reads after rendering, and
 * these are what it reads before deciding whether rendering is worth it.
 */
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { prisma } from '../../infra/prisma.js';
import { publicCategoryWhere, publicProductWhere } from '../../modules/catalog/catalog.visibility.js';

/** Every language the storefront ships. Mirrors `apps/customer-web/src/lib/seo.ts`. */
const LANGUAGES = ['en', 'de', 'el', 'es', 'fr', 'it', 'nl', 'pl'] as const;

/**
 * A cap, because a sitemap is a public endpoint with no authentication.
 *
 * 50,000 is also the protocol's own limit per file. A catalogue past it needs
 * a sitemap index, which is a different shape; until then this is both the
 * spec's ceiling and a sensible bound on one unauthenticated query.
 */
const MAX_URLS = 50_000;

/**
 * XML text escaping.
 *
 * Product slugs are generated and should be safe, but "should be" is not a
 * property worth relying on in a document that is served to third parties: a
 * seller-supplied name that reached a slug could otherwise break the document
 * or inject an element.
 */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The public origin of the STOREFRONT, which is not this API own origin.
 *
 * They are usually different hosts, and a sitemap listing the API origin
 * would point a crawler at addresses that serve JSON. `CUSTOMER_WEB_PUBLIC_URL`
 * is already required and already validated as a URL - the same value the
 * e-mails build their links from - so there is no second setting to keep in
 * step and no way to deploy with one right and the other wrong.
 */
function storefrontOrigin(): string {
  return env.CUSTOMER_WEB_PUBLIC_URL.trim().replace(/\/+$/, '');
}

interface SitemapEntry {
  path: string;
  lastModified: Date | null;
  /** Relative to the other pages on this site, 0.0 to 1.0. */
  priority: string;
  changeFrequency: string;
}

function renderUrl(origin: string, entry: SitemapEntry): string {
  const location = `${origin}${entry.path}`;

  const alternates = LANGUAGES.map(
    (language) =>
      `    <xhtml:link rel="alternate" hreflang="${language}" href="${xml(`${location}?lang=${language}`)}"/>`,
  ).join('\n');

  return [
    '  <url>',
    `    <loc>${xml(location)}</loc>`,
    alternates,
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${xml(location)}"/>`,
    entry.lastModified === null
      ? ''
      : `    <lastmod>${entry.lastModified.toISOString().slice(0, 10)}</lastmod>`,
    `    <changefreq>${entry.changeFrequency}</changefreq>`,
    `    <priority>${entry.priority}</priority>`,
    '  </url>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function registerSitemapRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Public and unauthenticated, which is what a sitemap has to be.
   *
   * It discloses nothing a visitor could not find by browsing the catalogue -
   * the same products, at the same addresses, under the same visibility rules.
   */
  app.get('/sitemap.xml', async (_request, reply) => {
    const origin = storefrontOrigin();

    const [categories, products] = await Promise.all([
      prisma.category.findMany({
        where: publicCategoryWhere(),
        select: { slug: true, updatedAt: true },
        orderBy: { sortOrder: 'asc' },
        take: 2_000,
      }),
      prisma.product.findMany({
        where: publicProductWhere(),
        select: { slug: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: MAX_URLS - 2_100,
      }),
    ]);

    const entries: SitemapEntry[] = [
      { path: '/', lastModified: null, priority: '1.0', changeFrequency: 'daily' },
      { path: '/catalog', lastModified: null, priority: '0.9', changeFrequency: 'daily' },
      ...categories.map((category) => ({
        path: `/catalog/${category.slug}`,
        lastModified: category.updatedAt,
        priority: '0.8',
        changeFrequency: 'weekly',
      })),
      ...products.map((product) => ({
        path: `/product/${product.slug}`,
        lastModified: product.updatedAt,
        priority: '0.7',
        changeFrequency: 'weekly',
      })),
    ];

    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
      ...entries.slice(0, MAX_URLS).map((entry) => renderUrl(origin, entry)),
      '</urlset>',
      '',
    ].join('\n');

    // An hour. Long enough that a crawler hammering it costs nothing, short
    // enough that a newly published product is listed the same morning.
    return reply
      .header('cache-control', 'public, max-age=3600')
      .type('application/xml; charset=utf-8')
      .status(200)
      .send(body);
  });

  return Promise.resolve();
}
