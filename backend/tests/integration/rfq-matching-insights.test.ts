/**
 * Supplier match explanation and flags (checklist JOURNEY-014).
 *
 * Every matched supplier says why it matched (live in the category, exports
 * to the destination, holds a verified certificate) and what the buyer should
 * know (no stated capacity, or capacity that cannot make the quantity in time).
 * Flags never remove a supplier; the buyer can still exclude any of them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { as, buildRfqWorld, cleanRfqWorld, completeDraft, key, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'rmi8-';
let world: RfqWorld;
let certId = '';

interface Card { sellerAccountId: string; reasons?: string[]; flags?: string[] }

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  await cleanRfqWorld(PREFIX);
  world = await buildRfqWorld(app, PREFIX);
  const { alpha, beta } = world.sellers;
  // ALPHA exports to the destination, holds a verified certificate and can make 100 a week.
  await prisma.sellerTrustProfile.create({ data: { id: newId(), sellerAccountId: alpha.id, exportCapable: true, exportMarketsJson: ['IN', 'DE'] } });
  certId = newId();
  await prisma.sellerCertification.create({
    data: { id: certId, sellerAccountId: alpha.id, standard: 'EN 455', issuer: 'TUV', state: 'VERIFIED', expiresOn: new Date(Date.now() + 300 * 86_400_000) },
  });
  await prisma.sellerOffer.updateMany({ where: { sellerAccountId: alpha.id }, data: { capacityUnitsPerWeek: 100 } });
  // BETA states no capacity at all.
  await prisma.sellerOffer.updateMany({ where: { sellerAccountId: beta.id }, data: { capacityUnitsPerWeek: null } });
}, 240_000);

afterAll(async () => {
  await prisma.sellerCertification.deleteMany({ where: { id: certId } });
  await prisma.sellerTrustProfile.deleteMany({ where: { sellerAccountId: world.sellers.alpha.id } });
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

async function preview(overrides: Record<string, unknown>): Promise<Card[]> {
  const created = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world, overrides), { 'idempotency-key': key() });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ rfq: { id: string } }>().rfq.id;
  const matches = await as(world, world.buyer, 'GET', `/rfqs/${id}/matches`);
  expect(matches.statusCode, matches.body).toBe(200);
  const body = matches.json<{ suppliers?: Card[]; match?: { suppliers: Card[] } }>();
  return body.suppliers ?? body.match?.suppliers ?? [];
}

describe('supplier matches', () => {
  it('explains each match and flags unknown or insufficient capacity', async () => {
    // 12,000 boxes in ~40 days: ALPHA's 100 a week cannot make it; BETA states nothing.
    const suppliers = await preview({});
    const alpha = suppliers.find((card) => card.sellerAccountId === world.sellers.alpha.id);
    const beta = suppliers.find((card) => card.sellerAccountId === world.sellers.beta.id);
    expect(alpha?.reasons).toEqual(['LIVE_IN_CATEGORY', 'EXPORTS_TO_DESTINATION', 'VERIFIED_CERTIFICATE']);
    expect(alpha?.flags).toEqual(['CAPACITY_BELOW_QUANTITY']);
    expect(beta?.reasons).toEqual(['LIVE_IN_CATEGORY']);
    expect(beta?.flags).toEqual(['CAPACITY_UNKNOWN']);
  });

  it('drops the capacity flag when the stated capacity can make the quantity', async () => {
    const suppliers = await preview({ quantity: '100' });
    expect(suppliers.find((card) => card.sellerAccountId === world.sellers.alpha.id)?.flags).toEqual([]);
  });
});
