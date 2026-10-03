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
  await prisma.sellerOffer.updateMany({ where: { sellerAccountId: alpha.id }, data: { capacityUnitsPerWeek: 100, minimumOrderQuantity: 500 } });
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
    expect(alpha?.reasons).toEqual(['LIVE_IN_CATEGORY', 'EXPORTS_TO_DESTINATION', 'VERIFIED_CERTIFICATE', 'MOQ_FITS_QUANTITY']);
    expect(alpha?.flags).toEqual(['RESPONSE_RECORD_UNKNOWN', 'CAPACITY_BELOW_QUANTITY']);
    expect(beta?.reasons).toEqual(['LIVE_IN_CATEGORY', 'MOQ_FITS_QUANTITY']);
    expect(beta?.flags).toEqual(['RESPONSE_RECORD_UNKNOWN', 'CAPACITY_UNKNOWN']);
  });

  it('drops the capacity flag when the stated capacity can make the quantity', async () => {
    const suppliers = await preview({ quantity: '500' });
    expect(suppliers.find((card) => card.sellerAccountId === world.sellers.alpha.id)?.flags).toEqual(['RESPONSE_RECORD_UNKNOWN']);
  });

  it('flags a minimum order above the quantity asked (ENH-008)', async () => {
    const suppliers = await preview({ quantity: '100' });
    const alpha = suppliers.find((card) => card.sellerAccountId === world.sellers.alpha.id);
    expect(alpha?.reasons).not.toContain('MOQ_FITS_QUANTITY');
    expect(alpha?.flags).toEqual(['MOQ_ABOVE_QUANTITY', 'RESPONSE_RECORD_UNKNOWN']);
  });

  it('explains the response record from closed invitations of the last year only (ENH-008)', async () => {
    const { alpha, beta } = world.sellers;
    const rfqs: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world), { 'idempotency-key': key() });
      rfqs.push(created.json<{ rfq: { id: string } }>().rfq.id);
    }
    const old = new Date(Date.now() - 400 * 86_400_000);
    const rows = [
      ...(['QUOTED', 'QUOTED', 'DECLINED', 'EXPIRED', 'VIEWED'] as const).map((status, i) => ({ rfqId: rfqs[i]!, sellerAccountId: alpha.id, status })),
      ...(['DECLINED', 'EXPIRED', 'EXPIRED', 'EXPIRED', 'QUOTED'] as const).map((status, i) => ({ rfqId: rfqs[i]!, sellerAccountId: beta.id, status, createdAt: i === 4 ? old : undefined })),
    ];
    await prisma.rfqInvitation.createMany({ data: rows.map((row) => ({ id: newId(), source: 'MATCHED' as const, ...row })) });
    try {
      const suppliers = await preview({ quantity: '500' });
      const a = suppliers.find((card) => card.sellerAccountId === alpha.id);
      const b = suppliers.find((card) => card.sellerAccountId === beta.id);
      expect(a?.reasons).toContain('RESPONDS_TO_RFQS');
      expect(a?.flags).toEqual([]);
      expect(b?.reasons).not.toContain('RESPONDS_TO_RFQS');
      expect(b?.flags).toEqual(['RESPONSE_RECORD_LOW', 'CAPACITY_UNKNOWN']);
    } finally {
      await prisma.rfqInvitation.deleteMany({ where: { rfqId: { in: rfqs } } });
    }
  });
});
