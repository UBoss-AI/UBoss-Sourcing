import { buildApp } from '../../src/http/app.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infra/prisma.js';
import { newId } from '../../src/infra/ids.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';
import { searchCatalogue, type DiscoveryQuery } from '../../src/modules/catalog/catalogue-search.service.js';

const categoryId = newId(), productId = newId(), sellerId = newId(), otherSellerId = newId();
const token = 'discover' + productId.slice(-8).toLowerCase(), slug = token + '-gloves';
let currency = '', taxClassId = '', ownTax = false;
let input: DiscoveryQuery;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp(); await app.ready();
  currency = await getBaseCurrency();
  taxClassId = (await prisma.taxClass.findFirst({ select: { id: true } }))?.id ?? '';
  if (taxClassId === '') { taxClassId = newId(); ownTax = true; await prisma.taxClass.create({ data: { id: taxClassId, code: token, name: 'Discovery fixture', ratePercent: 0, isInclusive: false } }); }
  await prisma.category.create({ data: { id: categoryId, name: token + ' gloves category', slug: token, path: '/', depth: 0, isActive: true } });
  await prisma.product.create({ data: { id: productId, categoryId, taxClassId, name: token + ' sterile gloves', slug, sku: slug, basePriceMinor: 1000n, currency, status: 'ACTIVE', isPublished: true, publishedAt: new Date() } });
  await prisma.productPrice.create({ data: { id: newId(), productId, currencyCode: currency, variantKey: '', basePriceMinor: 1000n } });
  await prisma.productTranslation.create({ data: { id: newId(), productId, language: 'pl', name: token + ' rękawice' } });
  for (const id of [sellerId, otherSellerId]) {
    await prisma.sellerAccount.create({ data: { id, legalName: token + id, displayName: token + ' supplier ' + id, displayNameNormalized: token + ' supplier ' + id.toLowerCase(), slug: token + '-' + id.toLowerCase(), kind: 'MANUFACTURER', registrationCountry: 'IN', status: 'APPROVED', approvedAt: new Date() } });
    await prisma.sellerOffer.create({ data: { id: newId(), sellerAccountId: id, productId, variantKey: '', sellerSku: token + id, status: 'ACTIVE', priceMinor: 1000n, currency } });
    await prisma.sellerTrustProfile.create({ data: { id: newId(), sellerAccountId: id, capabilitiesJson: ['OEM', 'CUSTOM_PACKAGING', token.toUpperCase() + '_MANUFACTURING'] } });
  }
  await prisma.searchSynonym.create({ data: { id: newId(), term: token + ' mitts', synonymsJson: [token + ' sterile gloves'], isActive: true } });
  input = { q: token, currency, country: 'IN', language: null, sellerAccountId: null };
});
afterAll(async () => {
  await prisma.marketRule.deleteMany({ where: { productId } });
  await prisma.searchSynonym.deleteMany({ where: { term: token + ' mitts' } });
  await prisma.sellerTrustProfile.deleteMany({ where: { sellerAccountId: { in: [sellerId, otherSellerId] } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: [sellerId, otherSellerId] } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: [sellerId, otherSellerId] } } });
  await prisma.productTranslation.deleteMany({ where: { productId } });
  await prisma.productPrice.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.category.deleteMany({ where: { id: categoryId } });
  if (ownTax) await prisma.taxClass.deleteMany({ where: { id: taxClassId } });
  await app?.close(); await prisma.$disconnect();
});
describe('real public catalogue discovery', () => {
  it('finds all four scopes from public records and returns only display labels and destinations', async () => {
    const result = await searchCatalogue(input);
    expect(new Set(result.items.filter(row => row.label.includes(token)).map(row => row.scope))).toEqual(new Set(['product', 'category', 'supplier', 'capability']));
    expect(result.items.every(row => Object.keys(row).sort().join(',') === 'href,label,scope')).toBe(true);
  });
  it('reads an explicit natural-language request and an operator-maintained phrase synonym', async () => {
    for (const q of ['Please find me sterile ' + token + ' gloves', 'find ' + token + ' mitts']) expect((await searchCatalogue({ ...input, q })).items).toContainEqual({ scope: 'product', label: token + ' sterile gloves', href: '/product/' + slug });
  });
  it('finds stored selected-language product words', async () => {
    expect((await searchCatalogue({ ...input, q: token + ' rękawice', language: 'pl' })).items).toContainEqual({ scope: 'product', label: token + ' rękawice', href: '/product/' + slug });
  });
  it('keeps suspended suppliers and their capabilities out of every supplier result', async () => {
    await prisma.sellerAccount.update({ where: { id: sellerId }, data: { suspendedAt: new Date() } });
    try { expect((await searchCatalogue(input)).items.some(row => row.href.endsWith(sellerId.toLowerCase()))).toBe(false); }
    finally { await prisma.sellerAccount.update({ where: { id: sellerId }, data: { suspendedAt: null } }); }
  });
  it('cannot disclose unpublished products through suggestions, categories or supplier capabilities', async () => {
    await prisma.product.update({ where: { id: productId }, data: { isPublished: false } });
    try { expect((await searchCatalogue(input)).items.filter(row => row.label.includes(token))).toEqual([]); }
    finally { await prisma.product.update({ where: { id: productId }, data: { isPublished: true } }); }
  });
  it('narrows seller-shop discovery to that seller and its live catalogue', async () => {
    const result = await searchCatalogue({ ...input, sellerAccountId: sellerId });
    expect(result.items.filter(row => row.scope === 'supplier' || row.scope === 'capability').every(row => row.href.endsWith(sellerId.toLowerCase()))).toBe(true);
    expect(result.items.some(row => row.scope === 'product')).toBe(true);
  });
  it('does not turn wildcard input into all capability matches', async () => {
    const result = await searchCatalogue({ ...input, q: token + '%' });
    expect(result.items.filter(row => row.scope === 'capability')).toEqual([]);
  });
  it('uses actual capability tags without a case-sensitive mismatch', async () => {
    const result = await searchCatalogue({ ...input, q: token + ' manufacturing' });
    expect(result.items.filter(row => row.scope === 'capability').length).toBe(2);
  });
  it('applies destination blocks to all four search scopes', async () => {
    const ruleId = newId();
    await prisma.marketRule.create({ data: { id: ruleId, scope: 'PRODUCT', productId, countryCode: 'IN', effect: 'BLOCK', reason: 'Discovery fixture block', source: 'fixture', version: '1', ownerName: 'fixture', effectiveFrom: new Date(Date.now() - 60000) } });
    try {
      expect((await searchCatalogue(input)).items.filter(row => row.label.includes(token))).toEqual([]);
      expect((await searchCatalogue({ ...input, country: null })).items.some(row => row.scope === 'product')).toBe(true);
    } finally { await prisma.marketRule.delete({ where: { id: ruleId } }); }
  });
  it('suggests only visible source words and retains the original misspelling', async () => {
    const misspelled = token + 'x';
    const result = await searchCatalogue({ ...input, q: misspelled });
    expect(result.query).toBe(misspelled); expect(result.suggestions).toContain(token);
    await prisma.product.update({ where: { id: productId }, data: { isPublished: false } });
    try { expect((await searchCatalogue({ ...input, q: misspelled })).suggestions).not.toContain(token); }
    finally { await prisma.product.update({ where: { id: productId }, data: { isPublished: true } }); }
  });
  it('does not expand a deactivated maintained synonym', async () => {
    await prisma.searchSynonym.update({ where: { term: token + ' mitts' }, data: { isActive: false } });
    try { expect((await searchCatalogue({ ...input, q: token + ' mitts' })).items).toEqual([]); }
    finally { await prisma.searchSynonym.update({ where: { term: token + ' mitts' }, data: { isActive: true } }); }
  });
  it('serves public discovery through the validated actual route in the selected market', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/catalog/search?q=' + encodeURIComponent(token) + '&currency=' + currency + '&country=IN&language=pl', remoteAddress: '198.19.237.22' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ query: token, currency, country: 'IN', items: expect.arrayContaining([{ scope: 'product', label: token + ' rękawice', href: '/product/' + slug }]) });
  });
  it('applies plain-language and maintained synonym words to the actual product grid too', async () => {
    for (const q of ['Please find me ' + token + ' sterile gloves', 'find ' + token + ' mitts']) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/catalog/products?q=' + encodeURIComponent(q) + '&currency=' + currency + '&country=IN', remoteAddress: '198.19.237.22' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ products: expect.arrayContaining([expect.objectContaining({ slug })]) });
    }
  });
  it('rejects oversized search input and invalid destination codes at the actual route', async () => {
    for (const query of ['q=' + 'x'.repeat(121), 'q=' + token + '&country=INVALID']) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/catalog/search?' + query, remoteAddress: '198.19.237.22' });
      expect(response.statusCode).toBe(400); expect(response.body).not.toContain(token + ' sterile gloves');
    }
  });
  it('does not offer any discovery scope when the selected currency has no price or live offer', async () => {
    expect((await searchCatalogue({ ...input, currency: 'ZZZ' })).items.filter(row => row.label.includes(token))).toEqual([]);
  });
  it('does not use another seller’s offer when the own-shop offer is paused', async () => {
    await prisma.sellerOffer.updateMany({ where: { sellerAccountId: sellerId, productId }, data: { status: 'PAUSED' } });
    try { expect((await searchCatalogue({ ...input, sellerAccountId: sellerId })).items).toEqual([]); }
    finally { await prisma.sellerOffer.updateMany({ where: { sellerAccountId: sellerId, productId }, data: { status: 'ACTIVE' } }); }
  });
  it('finds a public parent department through its visible descendant shelf', async () => {
    const parentId = newId();
    await prisma.category.create({ data: { id: parentId, name: token + ' parent', slug: token + '-parent', path: '/' + parentId + '/', depth: 0, isActive: true } });
    await prisma.category.update({ where: { id: categoryId }, data: { parentId, depth: 1, path: '/' + parentId + '/' + categoryId + '/' } });
    try {
      expect((await searchCatalogue({ ...input, q: token + ' parent' })).items).toContainEqual({ scope: 'category', label: token + ' parent', href: '/category/' + token + '-parent' });
      expect((await searchCatalogue({ ...input, q: token + ' parent', currency: 'ZZZ' })).items).toEqual([]);
    } finally {
      await prisma.category.update({ where: { id: categoryId }, data: { parentId: null, depth: 0, path: '/' } });
      await prisma.category.delete({ where: { id: parentId } });
    }
  });
  it('never presents malformed or nested capability JSON as a public declared tag', async () => {
    try {
      for (const capabilitiesJson of [{ internalValue: token }, [{ internalValue: token }], [null, 12]]) {
        await prisma.sellerTrustProfile.update({ where: { sellerAccountId: sellerId }, data: { capabilitiesJson } });
        const result = await searchCatalogue(input);
        expect(result.items.filter(row => row.scope === 'capability').some(row => row.href.endsWith(sellerId.toLowerCase()))).toBe(false);
      }
    } finally { await prisma.sellerTrustProfile.update({ where: { sellerAccountId: sellerId }, data: { capabilitiesJson: ['OEM', 'CUSTOM_PACKAGING', token.toUpperCase() + '_MANUFACTURING'] } }); }
  });
  it('returns an empty result for an empty query', async () => {
    expect(await searchCatalogue({ ...input, q: '  ' })).toEqual({ query: '', terms: [], items: [], suggestions: [] });
  });
});
