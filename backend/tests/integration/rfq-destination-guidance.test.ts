import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { basketDestinationGuidance, destinationGuidance } from '../../src/modules/rfq/destination-guidance.service.js';
import { as, buildRfqWorld, cleanRfqWorld, completeDraft, key, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'rfq-guidance-' + newId().toLowerCase() + '-';
const NOW = new Date('2026-10-03T12:00:00.000Z');
let world: RfqWorld;
let country = '';
const mutableEnv = env as unknown as Record<string, unknown>;

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  world = await buildRfqWorld(app, PREFIX);
  const candidates = ['BV', 'HM', 'TF', 'PN', 'GS'];
  const profiles = await prisma.marketProfile.findMany({ where: { countryCode: { in: candidates } }, select: { countryCode: true } });
  country = candidates.find(code => !profiles.some(profile => profile.countryCode === code)) ?? '';
  expect(country).not.toBe('');
  await prisma.marketProfile.create({ data: { countryCode: country, complianceNotes: PREFIX + ' importer registration instructions', isPublished: true } });
  for (const rule of [
    { effect: 'DOCUMENTS_REQUIRED' as const, categoryId: world.rootCategoryId, reason: 'ancestor documents', requiredDocumentsJson: ['Import licence'] },
    { effect: 'LABEL_REQUIRED' as const, categoryId: world.categoryId, reason: 'exact labels', labelText: '<script>Destination label</script>' },
    { effect: 'BLOCK' as const, categoryId: world.categoryId, reason: 'conditional block', minOrderValueMinor: 9007199254740993123n, thresholdCurrency: 'USD' },
    { effect: 'BLOCK' as const, categoryId: world.categoryId, reason: 'inactive', isActive: false },
    { effect: 'BLOCK' as const, categoryId: world.categoryId, reason: 'future', effectiveFrom: new Date('2999-01-01T00:00:00.000Z') },
    { effect: 'BLOCK' as const, categoryId: world.categoryId, reason: 'expired', effectiveUntil: new Date('2000-01-01T00:00:00.000Z') },
    { effect: 'BLOCK' as const, categoryId: world.categoryId, reason: 'exact until', effectiveUntil: NOW },
  ]) {
    await prisma.marketRule.create({ data: { id: newId(), scope: 'CATEGORY', countryCode: country, source: PREFIX, version: '1', ownerName: 'Test operator', effectiveFrom: new Date('1999-01-01T00:00:00.000Z'), ...rule, reason: PREFIX + rule.reason } });
  }
});

afterAll(async () => {
  if (country !== '') await prisma.marketProfile.deleteMany({ where: { countryCode: country, complianceNotes: { startsWith: PREFIX } } });
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

const read = (query: string) => as(world, world.buyer, 'GET', '/rfqs/destination-guidance?' + query);

describe('RFQ selected-destination guidance', () => {
  it('exposes only published prose and matching current exact/ancestor rules with exact monetary qualifiers', async () => {
    const result = await destinationGuidance({ country, categoryId: world.categoryId }, NOW);
    expect(result.country).toBe(country);
    expect(result.complianceNotes).toContain('importer registration');
    expect(result.notes.map(note => note.reason)).toEqual(expect.arrayContaining([PREFIX + 'ancestor documents', PREFIX + 'exact labels', PREFIX + 'conditional block']));
    expect(result.notes).toHaveLength(3);
    expect(result.notes.find(note => note.effect === 'DOCUMENTS_REQUIRED')?.requiredDocuments).toEqual(['Import licence']);
    expect(result.notes.find(note => note.effect === 'LABEL_REQUIRED')?.labelText).toBe('<script>Destination label</script>');
    expect(result.notes.find(note => note.effect === 'BLOCK')).toMatchObject({ minOrderValueMinor: '9007199254740993123', thresholdCurrency: 'USD' });
    expect(result.blockedReason).toBeNull();
    const justBeforeUntil = await destinationGuidance({ country, categoryId: world.categoryId }, new Date(NOW.getTime() - 1));
    expect(justBeforeUntil.blockedReason).toBe(PREFIX + 'exact until');
    expect(justBeforeUntil.notes).toHaveLength(4);
    expect(Object.keys(result).sort()).toEqual(['blockedReason', 'categoryId', 'complianceNotes', 'country', 'notes']);
    expect(JSON.stringify(result)).not.toContain(world.buyer.email);
    expect(JSON.stringify(result)).not.toContain(world.sellers.alpha.id);
  });
  it('normalizes country, permits category omission, is no-store, and isolates country/category', async () => {
    const response = await read('country=' + country.toLowerCase());
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ country, categoryId: null, notes: [], blockedReason: null });
    expect((await destinationGuidance({ country: 'US', categoryId: world.categoryId }, NOW)).notes).toEqual([]);
    expect((await destinationGuidance({ country, categoryId: world.otherCategoryId }, NOW)).notes).toEqual([]);
  });
  it('never exposes an unpublished profile', async () => {
    await prisma.marketProfile.update({ where: { countryCode: country }, data: { isPublished: false } });
    try { expect((await read('country=' + country)).json()).toMatchObject({ complianceNotes: null }); }
    finally { await prisma.marketProfile.update({ where: { countryCode: country }, data: { isPublished: true } }); }
  });
  it.each(['country=ZZ', 'country=USA', 'country=', 'country=IN&categoryId=bad', 'country=IN&categoryId=00000000000000000000000000'])('refuses malformed or unknown input %s', async query => {
    expect((await read(query)).statusCode).toBe(400);
  });
  it.each([{ isActive: false }, { archivedAt: NOW }])('refuses an unavailable category %#', async changes => {
    await prisma.category.update({ where: { id: world.emptyCategoryId }, data: changes });
    try { expect((await read('country=' + country + '&categoryId=' + world.emptyCategoryId)).statusCode).toBe(400); }
    finally { await prisma.category.update({ where: { id: world.emptyCategoryId }, data: { isActive: true, archivedAt: null } }); }
  });
  it('requires a customer session and the RFQ feature', async () => {
    expect((await world.app.inject({ method: 'GET', url: '/api/v1/rfqs/destination-guidance?country=IN' })).statusCode).toBe(401);
    const previous = mutableEnv['FEATURE_RFQ']; mutableEnv['FEATURE_RFQ'] = false;
    try { expect((await read('country=IN')).statusCode).toBe(404); }
    finally { mutableEnv['FEATURE_RFQ'] = previous; }
  });
  it('explains unconditional category blocks while submission and amendments still refuse them', async () => {
    const result = await destinationGuidance({ country: 'BR', categoryId: world.categoryId });
    expect(result.blockedReason).not.toBeNull();
    const created = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world, { destinationCountry: 'BR' }), { 'idempotency-key': key() });
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json<{ rfq: { id: string; version: number } }>().rfq;
    const submit = await as(world, world.buyer, 'POST', '/rfqs/' + draft.id + '/submit', { expectedVersion: draft.version }, { 'idempotency-key': key() });
    expect(submit.statusCode, submit.body).toBe(409);
    expect(submit.json()).toMatchObject({ error: { code: 'RFQ_DESTINATION_BLOCKED' } });
    const second = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world), { 'idempotency-key': key() });
    const open = second.json<{ rfq: { id: string; version: number } }>().rfq;
    const sent = await as(world, world.buyer, 'POST', '/rfqs/' + open.id + '/submit', { expectedVersion: open.version }, { 'idempotency-key': key() });
    expect(sent.statusCode, sent.body).toBe(200);
    const version = sent.json<{ rfq: { version: number } }>().rfq.version;
    const amendment = { ...completeDraft(world, { destinationCountry: 'BR' }) };
    delete amendment['includeSellerIds']; delete amendment['excludeSellerIds'];
    const amend = await as(world, world.buyer, 'POST', '/rfqs/' + open.id + '/versions', { ...amendment, expectedVersion: version, changeSummary: 'Different destination' });
    expect(amend.statusCode, amend.body).toBe(409);
    expect(amend.json()).toMatchObject({ error: { code: 'RFQ_DESTINATION_BLOCKED' } });
  });
  it('gives checkout importer prose and deduplicated basket documents, without labels or blocks', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { categoryId: world.categoryId, slug: { startsWith: PREFIX } }, select: { id: true } });
    const other = await prisma.product.findFirst({ where: { categoryId: world.categoryId, slug: { startsWith: PREFIX }, id: { not: product.id } }, select: { id: true } });
    const ids = other === null ? [product.id] : [product.id, other.id];
    const result = await basketDestinationGuidance(country.toLowerCase(), ids, NOW);
    expect(result).toEqual({ country, complianceNotes: PREFIX + ' importer registration instructions', documentRequirements: [{ reason: PREFIX + 'ancestor documents', requiredDocuments: ['Import licence'] }] });
    const response = await world.app.inject({ method: 'GET', url: '/api/v1/catalog/destination-guidance?country=' + country + '&products=' + ids.join(',') });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(result);
    expect((await basketDestinationGuidance('US', ids, NOW)).documentRequirements).toEqual([]);
    expect((await world.app.inject({ method: 'GET', url: '/api/v1/catalog/destination-guidance?country=USA&products=' + product.id })).statusCode).toBe(400);
  });
});
