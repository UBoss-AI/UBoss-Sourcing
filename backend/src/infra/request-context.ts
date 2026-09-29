/**
 * Facts about the HTTP request the current code is running for.
 *
 * Carried in an AsyncLocalStorage so code deep inside a service - `recordAudit`
 * above all - can know the caller's address and browser without every one of
 * ~80 call sites threading them through. Entered in the first `onRequest` hook
 * in app.ts and re-entered in `preValidation` (see `enterRequestContext`).
 *
 * Outside a request - the worker, a scheduled sweep, a script - there is no
 * store, and `currentRequestContext()` returns undefined. That is the point:
 * a row a background job writes must not borrow some request's address.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Run `fn` with `context` as the current request context. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}
