import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { as, buildRfqWorld, cleanRfqWorld, completeDraft, key, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'saq18-';
let world: RfqWorld;
let rfqId = '';

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  await cleanRfqWorld(PREFIX);
  world = await buildRfqWorld(app, PREFIX);
  const created = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world, { quantity: '1000' }), { 'idempotency-key': key() });
  const draft = created.json<{ rfq: { id: string; version: number } }>().rfq;
  const sent = await as(world, world.buyer, 'POST', `/rfqs/${draft.id}/submit`, { expectedVersion: draft.version }, { 'idempotency-key': key() });
  expect(sent.statusCode, sent.body).toBe(200);
  rfqId = draft.id;
}, 240_000);

afterAll(async () => {
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

describe('seller action queue (ENH-018)', () => {
  it('lists an open invitation as a quote task with its deadline and link, uncached', async () => {
    const response = await as(world, world.sellers.alpha.owner, 'GET', '/seller/action-queue');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const tasks = response.json<{ tasks: { kind: string; id: string; href: string; dueAt: string; overdue: boolean }[] }>().tasks;
    const quote = tasks.find((task) => task.id === rfqId);
    expect(quote).toMatchObject({ kind: 'QUOTE', href: `/seller/rfqs/${rfqId}`, overdue: false });
    expect(Number.isNaN(Date.parse(quote?.dueAt ?? ''))).toBe(false);
  });
  it('shows nothing of this request to a seller who was not asked, and refuses a buyer', async () => {
    const other = await as(world, world.sellers.pending.owner, 'GET', '/seller/action-queue');
    if (other.statusCode === 200) expect(other.json<{ tasks: { id: string }[] }>().tasks.some((task) => task.id === rfqId)).toBe(false);
    else expect([403, 404]).toContain(other.statusCode);
    expect([403, 404]).toContain((await as(world, world.buyer, 'GET', '/seller/action-queue')).statusCode);
  });
});
