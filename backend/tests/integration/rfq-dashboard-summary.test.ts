/**
 * The sourcing block of the buyer dashboard (checklist Master row 15): counts
 * and next actions come from the buyer's own rows, another buyer sees none of
 * them, and one failing block is reported as unavailable instead of failing
 * the whole answer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import { as, buildRfqWorld, cleanRfqWorld, completeDraft, key, submitted, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'rfqd-';
let world: RfqWorld;

interface Summary {
  requests: { draft: number; open: number; awarded: number; closed: number } | null;
  quotes: { open: number; awaitingYou: number; shortlisted: number } | null;
  negotiations: { active: number; awaitingYou: number; accepted: number } | null;
  samples: { inProgress: number; awaitingYou: number; approved: number } | null;
  nextActions: { kind: string; rfqId: string; quoteId: string | null }[] | null;
  unavailable: string[];
}
const summaryOf = (response: LightMyRequestResponse): Summary => response.json<Summary>();

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  world = await buildRfqWorld(app, PREFIX);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

describe('the dashboard sourcing summary', () => {
  it('counts requests, quotes and negotiations from real rows and lists what is waiting on the buyer', async () => {
    const draft = await as(world, world.buyer, 'POST', '/rfqs', completeDraft(world), { 'idempotency-key': key() });
    expect(draft.statusCode, draft.body).toBe(201);
    const sent = await submitted(world);
    const quote = await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, {
      currency: 'INR',
      unitPriceMinor: '90000',
      quantity: '12000',
      expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    });
    expect(quote.statusCode, quote.body).toBe(201);
    const quoteId = quote.json<{ quote: { id: string } }>().quote.id;

    const before = summaryOf(await as(world, world.buyer, 'GET', '/rfqs/summary'));
    expect(before.unavailable).toEqual([]);
    expect(before.requests).toMatchObject({ draft: 1, open: 1 });
    expect(before.quotes).toEqual({ open: 1, awaitingYou: 1, shortlisted: 0 });
    expect(before.negotiations).toEqual({ active: 0, awaitingYou: 0, accepted: 0 });
    expect(before.samples).toEqual({ inProgress: 0, awaitingYou: 0, approved: 0 });
    expect(before.nextActions?.map((action) => action.kind)).toEqual(['REVIEW_OFFER', 'FINISH_DRAFT']);
    expect(before.nextActions?.[0]).toMatchObject({ rfqId: sent.id, quoteId });

    const counter = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${quoteId}/offers`, {
      expectedVersionNumber: 1,
      unitPriceMinor: '86000',
      quantity: '12000',
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    expect(counter.statusCode, counter.body).toBe(201);
    const after = summaryOf(await as(world, world.buyer, 'GET', '/rfqs/summary'));
    expect(after.quotes).toMatchObject({ open: 1, awaitingYou: 0 });
    expect(after.negotiations).toMatchObject({ active: 1, awaitingYou: 0 });
    expect(after.nextActions?.map((action) => action.kind)).toEqual(['FINISH_DRAFT']);

    const rival = summaryOf(await as(world, world.rival, 'GET', '/rfqs/summary'));
    expect(rival.requests).toEqual({ draft: 0, open: 0, awarded: 0, closed: 0 });
    expect(rival.quotes?.open).toBe(0);
    expect(rival.nextActions).toEqual([]);
  });

  it('reports a failing block as unavailable and still answers with the rest', async () => {
    const spy = vi.spyOn(prisma.rfqSample, 'findMany').mockRejectedValueOnce(new Error('samples down'));
    const response = await as(world, world.buyer, 'GET', '/rfqs/summary');
    spy.mockRestore();
    expect(response.statusCode).toBe(200);
    const summary = summaryOf(response);
    expect(summary.samples).toBeNull();
    expect(summary.nextActions).toBeNull();
    expect(summary.unavailable.sort()).toEqual(['nextActions', 'samples']);
    expect(summary.requests?.open).toBe(1);
    expect(summary.quotes?.open).toBe(1);
  });
});
