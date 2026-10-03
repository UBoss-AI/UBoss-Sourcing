import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import { newId } from '../../src/infra/ids.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';
let app: Awaited<ReturnType<typeof buildApp>>;
const categoryId = newId(), productId = newId(), slug = 'original-copy-' + productId.toLowerCase();
let currency = '', taxClassId = '', ownTax = false;
beforeAll(async () => {
  app = await buildApp(); await app.ready(); currency = await getBaseCurrency();
  taxClassId = (await prisma.taxClass.findFirst({ select: { id: true } }))?.id ?? '';
  if (taxClassId === '') { taxClassId = newId(); ownTax = true; await prisma.taxClass.create({ data: { id: taxClassId, code: 'ORIG-' + taxClassId.slice(-6), name: 'Original copy fixture', ratePercent: 0, isInclusive: false } }); }
  await prisma.category.create({ data: { id: categoryId, name: 'Original copy fixture', slug, path: '/', depth: 0, isActive: true } });
  await prisma.product.create({ data: { id: productId, categoryId, taxClassId, slug, sku: slug, name: 'Original gloves', shortDescription: 'Original short description', description: 'Original detailed description', basePriceMinor: 1000n, currency, status: 'ACTIVE', isPublished: true, publishedAt: new Date() } });
  await prisma.productPrice.create({ data: { id: newId(), productId, currencyCode: currency, variantKey: '', basePriceMinor: 1000n } });
  await prisma.productTranslation.create({ data: { id: newId(), productId, language: 'pl', name: 'Polskie rękawice', shortDescription: 'Polski opis', description: 'Polski szczegółowy opis' } });
});
afterAll(async () => {
  await prisma.productTranslation.deleteMany({ where: { productId } }); await prisma.productPrice.deleteMany({ where: { productId } }); await prisma.product.deleteMany({ where: { id: productId } }); await prisma.category.deleteMany({ where: { id: categoryId } }); if (ownTax) await prisma.taxClass.deleteMany({ where: { id: taxClassId } }); await app?.close(); await prisma.$disconnect();
});
function read(language?: string) { return app.inject({ method: 'GET', url: '/api/v1/catalog/products/' + slug + '?currency=' + currency + '&country=IN' + (language === undefined ? '' : '&language=' + language), remoteAddress: '198.19.237.21' }); }
describe('original public catalogue copy', () => {
  it('returns translated and base copy through the same public detail route without changing either stored version', async () => {
    const translated = await read('pl'), original = await read(); expect(translated.statusCode, translated.body).toBe(200); expect(original.statusCode, original.body).toBe(200);
    expect(translated.json<{ product: unknown }>().product).toMatchObject({ id: productId, name: 'Polskie rękawice', shortDescription: 'Polski opis', description: 'Polski szczegółowy opis' }); expect(original.json<{ product: unknown }>().product).toMatchObject({ id: productId, name: 'Original gloves', shortDescription: 'Original short description', description: 'Original detailed description' }); expect(original.json()).toMatchObject({ currency, country: 'IN' });
    const stored = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { name: true, description: true, translations: { select: { name: true, description: true } } } }); expect(stored).toMatchObject({ name: 'Original gloves', description: 'Original detailed description', translations: [{ name: 'Polskie rękawice', description: 'Polski szczegółowy opis' }] });
  });
  it('cannot use original copy to bypass unpublished-product visibility', async () => {
    await prisma.product.update({ where: { id: productId }, data: { isPublished: false } });
    try { for (const language of [undefined, 'pl']) { const response = await read(language); expect(response.statusCode, response.body).toBe(404); expect(response.body).not.toContain('Original detailed description'); } }
    finally { await prisma.product.update({ where: { id: productId }, data: { isPublished: true } }); }
  });
});
