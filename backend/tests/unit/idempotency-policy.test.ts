/**
 * The idempotency policy, checked against the routes Fastify really registered.
 *
 * `src/http/idempotency-policy.ts` says it out loud: every POST, PUT, PATCH and
 * DELETE resolves to exactly one declaration, and THIS file is what fails when
 * one does not. Nobody keeps a list here by hand - the table is read from the
 * running app, so a route added tomorrow is covered tomorrow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import {
  declarationFor,
  explicitlyDeclaredRoutes,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from '../../src/http/idempotency-policy.js';
import { isStateChanging, routeTableOf, type RegisteredRoute } from '../../src/http/route-table.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let table: RegisteredRoute[];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  table = routeTableOf(app as never);
});

afterAll(async () => {
  await app.close();
});

describe('idempotency policy', () => {
  it('reads a real route table, not an empty one', () => {
    expect(table.length).toBeGreaterThan(200);
    expect(table.filter((r) => isStateChanging(r.method)).length).toBeGreaterThan(100);
  });

  it('gives every POST, PUT, PATCH and DELETE exactly one declaration', () => {
    const undeclared = table
      .filter((r) => isStateChanging(r.method))
      .filter((r) => declarationFor(r.method, r.url) === null)
      .map((r) => `${r.method} ${r.url}`);

    expect(
      undeclared,
      `Declare these in src/http/idempotency-policy.ts:\n${undeclared.join('\n')}`,
    ).toEqual([]);
  });

  it('explains every declaration with a source and a reason', () => {
    for (const route of table.filter((r) => isStateChanging(r.method))) {
      const declaration = declarationFor(route.method, route.url);
      expect(declaration?.source, `${route.method} ${route.url}`).toBeTruthy();
      expect(declaration?.reason, `${route.method} ${route.url}`).toBeTruthy();
    }
  });

  it('says who replays the first response on every REQUIRED route', () => {
    for (const route of table.filter((r) => isStateChanging(r.method))) {
      const declaration = declarationFor(route.method, route.url);
      if (declaration?.mode === 'REQUIRED') {
        expect(['service', 'central'], `${route.method} ${route.url}`).toContain(
          declaration.handledBy,
        );
      }
    }
  });

  it('leaves no explicit entry behind for a route that no longer exists', () => {
    const registered = new Set(table.map((r) => `${r.method} ${r.url}`));
    const stale = explicitlyDeclaredRoutes().filter((key) => !registered.has(key));

    expect(stale, `Remove these from src/http/idempotency-policy.ts:\n${stale.join('\n')}`).toEqual(
      [],
    );
  });

  it('marks a money-moving route as requiring the key', () => {
    expect(declarationFor('POST', '/api/v1/cart/checkout')?.mode).toBe('REQUIRED');
    expect(declarationFor('POST', '/api/v1/admin/orders/:id/refunds')?.mode).toBe('REQUIRED');
  });

  it('caps the key length at what the column can hold', () => {
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(128);
  });
});
