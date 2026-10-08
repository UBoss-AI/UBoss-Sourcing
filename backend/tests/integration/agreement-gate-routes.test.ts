/**
 * Which routes can be reached before the agreement screen is done - read from
 * the route table Fastify actually built, not from a list kept by hand.
 *
 * Every application guard (`requireCustomer`, `requireSeller`, `requireAdmin`,
 * `requireLogistics`, `requireAudit` and their variants) asks for the Terms and
 * the Privacy Policy. A route reaches the app without them only through a
 * guard that deliberately skips the screen, and this test holds those guards
 * to the routes that are allowed to: signing in and out and the rest of
 * `/auth`, the agreement routes themselves, support, and privacy requests. A
 * new route that borrows one of these guards fails here until somebody
 * decides, in this file, that it may.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { routeTableOf, type RegisteredRoute } from '../../src/http/route-table.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let table: RegisteredRoute[];

/** Guards that admit a person without the agreement screen, by function name. */
const BEFORE_AGREEMENT_GUARDS = new Set([
  // requireAuthenticated(kind) - sign-in, sign-out, /me, two-step codes.
  'guard',
  'requireLogisticsSession',
  'requireAuditSession',
  // The deliberate exceptions.
  'requireCustomerBeforeAgreements',
  'sellerSupportGuard',
  'logisticsSupportGuard',
  'adminAgreementGuard',
  'auditAgreementGuard',
]);

const ALLOWED = [
  /^\/api\/v1(\/admin|\/logistics|\/audit)?\/auth(\/|$)/,
  /^\/api\/v1(\/seller|\/logistics)?\/support(\/|$)/,
  /^\/api\/v1\/account\/data-requests$/,
];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  table = routeTableOf(app as never);
});

afterAll(async () => {
  await app?.close();
});

describe('routes reachable before the agreement screen', () => {
  it('are only the sign-in, agreement, support and privacy-request routes', () => {
    const exempt = table.filter((route) => route.guards.some((name) => BEFORE_AGREEMENT_GUARDS.has(name)));
    const strays = exempt.filter((route) => !ALLOWED.some((pattern) => pattern.test(route.url)));
    expect(strays.map((route) => `${route.method} ${route.url} [${route.guards.join(', ')}]`)).toEqual([]);
  });

  it('include the agreement routes on all four surfaces, and support and privacy requests', () => {
    const exempt = new Set(
      table
        .filter((route) => route.guards.some((name) => BEFORE_AGREEMENT_GUARDS.has(name)))
        .map((route) => `${route.method} ${route.url}`),
    );
    for (const prefix of ['/api/v1/auth', '/api/v1/admin/auth', '/api/v1/logistics/auth', '/api/v1/audit/auth']) {
      for (const route of ['GET /agreements', 'POST /agreements/terms', 'POST /agreements/privacy', 'DELETE /agreements/terms', 'DELETE /agreements/privacy', 'GET /agreements/history']) {
        const [method, path] = route.split(' ');
        expect(exempt, `${route} on ${prefix}`).toContain(`${method ?? ''} ${prefix}${path ?? ''}`);
      }
    }
    expect(exempt).toContain('POST /api/v1/support/tickets');
    expect(exempt).toContain('POST /api/v1/seller/support/tickets');
    expect(exempt).toContain('POST /api/v1/logistics/support/tickets');
    expect(exempt).toContain('POST /api/v1/account/data-requests');
  });

  it('do not include the payment and integration webhooks, which no person signs in to', () => {
    // Inbound webhooks only - not a staff action that happens to mention them.
    const webhooks = table.filter(
      (route) => /webhook/i.test(route.url) && route.method === 'POST' && !route.url.startsWith('/api/v1/admin/'),
    );
    expect(webhooks.length).toBeGreaterThan(0);
    for (const route of webhooks) {
      // Signature-checked, never session-guarded: the agreement gate is never in their way.
      expect(route.guards.filter((name) => name !== 'anonymous' && /guard|require/i.test(name)), route.url).toEqual([]);
    }
  });
});
