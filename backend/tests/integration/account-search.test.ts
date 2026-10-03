import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { as, buildRfqWorld, cleanRfqWorld, completeDraft, key, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'asr04-';
let world: RfqWorld;
let reference = '';
let rfqId = '';

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  await cleanRfqWorld(PREFIX);
  world = await buildRfqWorld(app, PREFIX);
  const created = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world, { title: 'Zircon widget asr04' }), { 'idempotency-key': key() });
  expect(created.statusCode, created.body).toBe(201);
  ({ id: rfqId, reference } = created.json<{ rfq: { id: string; reference: string } }>().rfq);
}, 240_000);

afterAll(async () => {
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

type Result = { orders: unknown[]; invoices: unknown[]; shipments: unknown[]; rfqs: { id: string }[] };

describe('universal account search (ENH-004)', () => {
  it('finds the buyer’s own request by title and by reference, uncached', async () => {
    const byTitle = await as(world, world.buyer, 'GET', '/account/search?q=zircon%20widget');
    expect(byTitle.statusCode, byTitle.body).toBe(200);
    expect(byTitle.headers['cache-control']).toBe('no-store');
    expect(byTitle.json<Result>().rfqs.map((r) => r.id)).toContain(rfqId);
    expect((await as(world, world.buyer, 'GET', `/account/search?q=${encodeURIComponent(reference)}`)).json<Result>().rfqs.map((r) => r.id)).toContain(rfqId);
  });
  it('never shows another buyer’s records, ignores one-letter terms, and needs a session', async () => {
    expect((await as(world, world.rival, 'GET', '/account/search?q=zircon%20widget')).json<Result>().rfqs).toEqual([]);
    expect((await as(world, world.buyer, 'GET', '/account/search?q=z')).json<Result>()).toEqual({ orders: [], invoices: [], shipments: [], rfqs: [] });
    expect((await world.app.inject({ method: 'GET', url: '/api/v1/account/search?q=zircon' })).statusCode).toBe(401);
  });
  it('lists open inspections only for the caller (DYNAMIC-004)', async () => {
    const mine = await as(world, world.buyer, 'GET', '/account/inspections');
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.headers['cache-control']).toBe('no-store');
    expect(Array.isArray(mine.json<{ inspections: unknown[] }>().inspections)).toBe(true);
    expect((await world.app.inject({ method: 'GET', url: '/api/v1/account/inspections' })).statusCode).toBe(401);
  });
});
