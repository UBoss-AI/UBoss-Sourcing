/**
 * Privacy-first analytics (Section 17 global rule, LIVE-020).
 *
 * The public counter takes route patterns only and refuses anything that
 * looks like an address with an id in it; the counts carry no identifier;
 * staff with report.read see totals and a reconciliation against the source
 * tables; everybody else is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import { asStaff, cleanUpOrderDesk, staff, type StaffSession } from '../support/order-desk-fixture.js';

const TAG = 'anl8';
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: StaffSession;
let support: StaffSession;
const today = new Date().toISOString().slice(0, 10);
const day = new Date(`${today}T00:00:00.000Z`);
const SCREEN = '/anl8-test/:slug';

function post(events: unknown, ip = '10.83.0.1') {
  return app.inject({ method: 'POST', url: '/api/v1/analytics/events', headers: { 'x-forwarded-for': ip }, payload: { events } as Record<string, unknown> });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUpOrderDesk(TAG);
  await prisma.analyticsDailyCount.deleteMany({ where: { screen: { startsWith: '/anl8-test' } } });
  owner = await staff(app, TAG, 'inspadmin', Role.BUSINESS_OWNER, '10.83.0.20');
  support = await staff(app, TAG, 'support', Role.SUPPORT_AGENT, '10.83.0.21');
}, 120_000);

afterAll(async () => {
  await prisma.analyticsDailyCount.deleteMany({ where: { screen: { startsWith: '/anl8-test' } } });
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('the public counter', () => {
  it('counts a batch without a session and stores no identifier', async () => {
    const response = await post([
      { event: 'screen_view', screen: SCREEN },
      { event: 'screen_view', screen: SCREEN },
      { event: 'search_submitted', screen: '/anl8-test' },
    ]);
    expect(response.statusCode, response.body).toBe(204);
    const row = await prisma.analyticsDailyCount.findUniqueOrThrow({ where: { day_event_screen: { day, event: 'screen_view', screen: SCREEN } } });
    expect(row.count).toBe(2);
    expect(row.surface).toBe('STOREFRONT');
    expect(Object.keys(row).sort()).toEqual(['count', 'createdAt', 'day', 'event', 'screen', 'surface', 'updatedAt']);
    await post([{ event: 'screen_view', screen: SCREEN }]);
    expect((await prisma.analyticsDailyCount.findUniqueOrThrow({ where: { day_event_screen: { day, event: 'screen_view', screen: SCREEN } } })).count).toBe(3);
  });

  it('refuses unknown events, real addresses with ids and oversized batches', async () => {
    expect((await post([{ event: 'purchase_made', screen: SCREEN }])).statusCode).toBe(400);
    expect((await post([{ event: 'screen_view', screen: '/anl8-test/01JABCDEFGHJKMNPQRSTVWXYZ0' }])).statusCode).toBe(400);
    expect((await post([{ event: 'screen_view', screen: '/anl8-test/123456' }])).statusCode).toBe(400);
    expect((await post([{ event: 'screen_view', screen: 'https://evil.example/x' }])).statusCode).toBe(400);
    expect((await post(Array.from({ length: 21 }, () => ({ event: 'screen_view', screen: SCREEN })))).statusCode).toBe(400);
    expect(await prisma.analyticsDailyCount.count({ where: { screen: { contains: '0123' } } })).toBe(0);
  });
});

describe('staff reports', () => {
  it('reports totals and reconciles client events against the source tables', async () => {
    const summary = await asStaff(app, owner, 'GET', `/analytics/summary?from=${today}&to=${today}`);
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json<{ topScreens: { screen: string; views: number }[] }>().topScreens).toContainEqual(expect.objectContaining({ screen: SCREEN, views: 3 }));

    const reconciliation = await asStaff(app, owner, 'GET', `/analytics/reconciliation?from=${today}&to=${today}`);
    expect(reconciliation.statusCode, reconciliation.body).toBe(200);
    const body = reconciliation.json<{ timeZone: string; rows: { event: string; sourceCount: number; analytics: number; difference: number }[] }>();
    expect(body.timeZone).toBe('UTC');
    const orders = await prisma.order.count({ where: { source: 'ONE_TIME', createdAt: { gte: day, lt: new Date(day.getTime() + 86_400_000) } } });
    const checkout = body.rows.find((row) => row.event === 'checkout_completed');
    expect(checkout?.sourceCount).toBe(orders);
    expect(checkout?.difference).toBe((checkout?.analytics ?? 0) - orders);
    expect(body.rows.map((row) => row.event)).toEqual(['checkout_completed', 'rfq_submitted', 'return_requested', 'dispute_opened']);
  });

  it('refuses staff without report.read and an over-long range', async () => {
    expect((await asStaff(app, support, 'GET', `/analytics/summary?from=${today}&to=${today}`)).statusCode).toBe(403);
    expect((await asStaff(app, owner, 'GET', '/analytics/summary?from=2020-01-01&to=2026-01-01')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/analytics/summary?from=${today}&to=${today}` })).statusCode).toBe(401);
  });
});
