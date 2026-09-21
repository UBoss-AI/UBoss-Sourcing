/**
 * The sitemap, against a real database.
 *
 * What is worth pinning here is not the XML - it is that the sitemap and the
 * shop agree about what exists. A sitemap that lists an unpublished product
 * sends a crawler to a 404 and, worse, publishes the existence of something
 * the operator has deliberately taken down.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const SLUG_PREFIX = 'sitemap-test';

let liveSlug = '';
let draftSlug = '';
let archivedSlug = '';

async function cleanUp(): Promise<void> {
  await prisma.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  await prisma.taxClass.deleteMany({ where: { code: 'SITEMAPTAX' } });
}

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'SITEMAPTAX',
      name: 'Sitemap test',
      ratePercent: '0.000000',
      isInclusive: false,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Sitemap Tools', slug: `${SLUG_PREFIX}-tools`, isActive: true },
  });
  await prisma.category.update({
    where: { id: category.id },
    data: { path: `/${category.id}/` },
  });

  const make = async (
    slug: string,
    overrides: Record<string, unknown>,
  ): Promise<string> => {
    await prisma.product.create({
      data: {
        id: newId(),
        categoryId: category.id,
        taxClassId: taxClass.id,
        name: slug,
        slug,
        sku: slug.toUpperCase(),
        basePriceMinor: 1_000n,
        currency: 'INR',
        status: 'ACTIVE',
        isPublished: true,
        publishedAt: new Date(),
        minOrderQty: 1,
        qtyIncrement: 1,
        ...overrides,
      },
    });
    return slug;
  };

  liveSlug = await make(`${SLUG_PREFIX}-live`, {});
  draftSlug = await make(`${SLUG_PREFIX}-draft`, { isPublished: false });
  archivedSlug = await make(`${SLUG_PREFIX}-archived`, { archivedAt: new Date() });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
  await prisma.$disconnect();
});

async function fetchSitemap() {
  return app.inject({ method: 'GET', url: '/api/v1/sitemap.xml' });
}

describe('the sitemap', () => {
  it('is public, XML, and cacheable', async () => {
    const response = await fetchSitemap();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/xml');
    expect(response.headers['cache-control']).toContain('max-age=3600');
    expect(response.body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(response.body).toContain('<urlset');
  });

  it('lists a published product', async () => {
    expect((await fetchSitemap()).body).toContain(`/product/${liveSlug}`);
  });

  it('does not list an unpublished or archived one', async () => {
    // The claim that matters. A sitemap listing a product the operator took
    // down is both a 404 for a crawler and a disclosure of something withdrawn.
    const body = (await fetchSitemap()).body;

    expect(body).not.toContain(`/product/${draftSlug}`);
    expect(body).not.toContain(`/product/${archivedSlug}`);
  });

  it('carries a language alternate for each of the eight, plus x-default', async () => {
    const body = (await fetchSitemap()).body;

    for (const language of ['en', 'de', 'el', 'es', 'fr', 'it', 'nl', 'pl']) {
      expect(body, language).toContain(`hreflang="${language}"`);
    }

    expect(body).toContain('hreflang="x-default"');
  });

  it('points at the storefront, not at this API', async () => {
    // They are different hosts in every real deployment, and a sitemap full of
    // API addresses asks a crawler to index JSON.
    const body = (await fetchSitemap()).body;
    const origin = process.env['CUSTOMER_WEB_PUBLIC_URL'] ?? '';

    expect(origin.length).toBeGreaterThan(0);
    expect(body).toContain(`<loc>${origin.replace(/\/+$/, '')}/</loc>`);
  });

  it('never lists a page that needs a sign-in', async () => {
    const body = (await fetchSitemap()).body;

    for (const path of ['/account', '/cart', '/checkout', '/orders', '/seller']) {
      expect(body, path).not.toContain(`<loc>${path}`);
      expect(body, path).not.toContain(`${path}</loc>`);
    }
  });

  it('escapes its own output', async () => {
    // Slugs are generated and should be safe. "Should be" is not a property
    // worth relying on in a document served to third parties.
    const body = (await fetchSitemap()).body;

    // No raw ampersand outside an entity.
    expect(/&(?!amp;|lt;|gt;|quot;|apos;)/.test(body)).toBe(false);
  });
});
