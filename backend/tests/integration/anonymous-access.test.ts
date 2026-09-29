/**
 * Deny by default: an anonymous caller is refused everywhere that is not
 * declared public.
 *
 * The route table is read from the running app, so a route added tomorrow is
 * walked tomorrow. Every route is called with no cookie and no header; unless
 * it is on the PUBLIC list below (a route somebody decided, on purpose, to open
 * to the world), the answer must be 401 or 403. A new route that forgets its
 * guard answers 200 or 400 here and fails this file, naming the route.
 *
 * Bodies are empty. A guard that only fires after validation would answer 400
 * to an empty body, and that is exactly the kind of route this test is for:
 * the refusal has to come first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { buildApp } from '../../src/http/app.js';
import { routeTableOf, type RegisteredRoute } from '../../src/http/route-table.js';

/**
 * Routes that are open to a signed-out caller on purpose. Matched as
 * "METHOD path", written as Fastify registered it.
 */
const PUBLIC: string[] = [
  // Sign-in, sign-up and password recovery (POST /auth/*), health probes, metrics,
  // the catalogue, legal documents, payment links and signed webhooks, the
  // preorder chat's anonymous entry points, and one-time download tokens.
  // Device-token and upgrade-time authentication (the two /socket routes and
  // driver location pings) answer 400/404 to a plain call and refuse inside.
  'GET /api/v1/account/config',
  'GET /api/v1/admin/preorder-chats/socket',
  'GET /api/v1/catalog/assurance',
  'GET /api/v1/catalog/bulk-pricing',
  'GET /api/v1/catalog/categories',
  'GET /api/v1/catalog/categories/:slug',
  'GET /api/v1/catalog/filters',
  'GET /api/v1/catalog/markets/:country',
  'GET /api/v1/catalog/product-cards',
  'GET /api/v1/catalog/products',
  'GET /api/v1/catalog/products/:slug',
  'GET /api/v1/catalog/products/:slug/reviews',
  'GET /api/v1/catalog/suppliers',
  'GET /api/v1/catalog/suppliers/:slug',
  'GET /api/v1/catalog/variant-axes',
  'GET /api/v1/config',
  'GET /api/v1/documents/verify',
  'GET /api/v1/exports/download/:token',
  'GET /api/v1/legal/current',
  'GET /api/v1/legal/documents/:id',
  'GET /api/v1/legal/documents/:id/pdf',
  'GET /api/v1/legal/in-force',
  'GET /api/v1/legal/versions',
  'GET /api/v1/my-data/download/:token',
  'GET /api/v1/payments/links/:token',
  'GET /api/v1/preorder-chats/availability',
  'GET /api/v1/preorder-chats/socket',
  'GET /api/v1/preorders/eligibility',
  'GET /api/v1/sitemap.xml',
  'GET /health/live',
  'GET /health/ready',
  'GET /media/products/*',
  'GET /metrics',
  'POST /api/v1/admin/auth/login',
  'POST /api/v1/admin/auth/password/forgot',
  'POST /api/v1/admin/auth/password/reset',
  'POST /api/v1/assistant/chat',
  'POST /api/v1/assistant/start',
  'POST /api/v1/auth/invitations/accept',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/password/forgot',
  'POST /api/v1/auth/password/reset',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/verify-email',
  'POST /api/v1/auth/verify-email/resend',
  'POST /api/v1/delivery/options',
  'POST /api/v1/erp-inbound/:slug',
  'POST /api/v1/logistics/auth/invitations/accept',
  'POST /api/v1/logistics/auth/login',
  'POST /api/v1/logistics/auth/password/forgot',
  'POST /api/v1/logistics/auth/password/reset',
  'POST /api/v1/logistics/driver/location-pings',
  'POST /api/v1/partner-invitations/accept',
  'POST /api/v1/partner-invitations/describe',
  'POST /api/v1/payments/links/:token/pay',
  'POST /api/v1/payments/webhooks/:provider',
  'POST /api/v1/preorder-chats/assistant',
  'POST /api/v1/preorder-chats/assistant/answer',
];

let app: Awaited<ReturnType<typeof buildApp>>;
let table: RegisteredRoute[];

beforeAll(async () => {
  // Every route is called once from one address; the global budget would answer 429 to the second half of the table and hide what this test is for.
  Object.assign(env as unknown as { RATE_LIMIT_GLOBAL_PER_MINUTE: number }, {
    RATE_LIMIT_GLOBAL_PER_MINUTE: 1_000_000,
  });
  app = await buildApp();
  await app.ready();
  table = routeTableOf(app as never);
});

afterAll(async () => {
  await app.close();
});

function isPublic(route: RegisteredRoute): boolean {
  return PUBLIC.includes(route.method + ' ' + route.url);
}

function concrete(url: string): string {
  return url.replace(/:[A-Za-z0-9_]+/g, '0190e0a0-0000-7000-8000-000000000000').replace(/\*/g, 'x');
}

describe('anonymous access', () => {
  it('walks a real route table', () => {
    expect(table.length).toBeGreaterThan(300);
  });

  it('refuses an anonymous caller on every route not declared public', async () => {
    const answered: string[] = [];

    for (const route of table) {
      if (isPublic(route)) continue;
      const mutating = route.method !== 'GET';
      const response = await app.inject({
        method: route.method as 'GET',
        url: concrete(route.url),
        ...(mutating ? { payload: {} } : {}),
      });
      if (response.statusCode !== 401 && response.statusCode !== 403) {
        answered.push(`${response.statusCode} ${route.method} ${route.url}`);
      }
    }

    expect(
      answered,
      `Answered a signed-out caller. Guard them, or add to PUBLIC on purpose:\n${answered.join('\n')}`,
    ).toEqual([]);
  }, 300_000);
});
