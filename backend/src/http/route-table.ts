/**
 * The route table, as Fastify actually registered it.
 *
 * Every route passes through `onRoute` on its way into the router, and this
 * file records each one: its method, its full path and the guards attached to
 * it. Nothing reads this at request time. It exists so that checks which must
 * hold for EVERY route - "a state change says whether it needs an
 * Idempotency-Key", "an anonymous caller is refused everywhere that is not
 * declared public" - are run over the real table rather than over a list
 * somebody keeps by hand and forgets to update.
 *
 * The idempotency hook is installed from here too (see
 * `idempotency-policy.ts`), because it has to see every route at the same
 * moment and attach itself to the ones that declare a key required.
 */
import type { FastifyInstance, RouteOptions } from 'fastify';
import { idempotencyHooksFor } from './idempotency-policy.js';

export interface RegisteredRoute {
  method: string;
  /** Full path including the `/api/v1` prefix, with `:param` placeholders. */
  url: string;
  /** Names of the route-level preHandler functions, in order. */
  guards: string[];
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isStateChanging(method: string): boolean {
  return STATE_CHANGING.has(method.toUpperCase());
}

/** One entry per (method, url). HEAD twins of GET routes are left out. */
export function routeTableOf(app: FastifyInstance): RegisteredRoute[] {
  const table = tables.get(app);
  if (table === undefined) throw new Error('installRouteTable() was not called on this app');
  return [...table.values()];
}

const tables = new WeakMap<FastifyInstance, Map<string, RegisteredRoute>>();

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Call once on the root instance, before any route plugin is registered. */
export function installRouteTable(app: FastifyInstance): void {
  const table = new Map<string, RegisteredRoute>();
  tables.set(app, table);

  app.addHook('onRoute', (route: RouteOptions) => {
    for (const method of asArray(route.method)) {
      const upper = String(method).toUpperCase();
      if (upper === 'HEAD' || upper === 'OPTIONS') continue;

      const guards = asArray(route.preHandler as ((...args: unknown[]) => unknown) | undefined).map(
        (fn) => fn.name || 'anonymous',
      );
      table.set(`${upper} ${route.url}`, { method: upper, url: route.url, guards });

      if (isStateChanging(upper)) {
        const hooks = idempotencyHooksFor(upper, route.url);
        if (hooks !== null) {
          // After the route's own guards: the key is scoped to the caller the
          // guard has just identified, and an unauthenticated request should be
          // told to sign in, not to send a header.
          route.preHandler = [...asArray(route.preHandler), hooks.preHandler] as never;
          route.onSend = [...asArray(route.onSend), hooks.onSend] as never;
          route.onError = [...asArray(route.onError), hooks.onError] as never;
        }
      }
    }
  });
}
