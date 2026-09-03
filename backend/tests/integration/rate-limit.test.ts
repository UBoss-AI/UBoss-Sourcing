/**
 * Rate limiting - integration.
 *
 * The regression this file exists for: `errorResponseBuilder` used to return a
 * plain envelope object. The plugin hands whatever it returns straight to
 * Fastify's error handler, and a plain object carries no `statusCode`, so it
 * fell through to the 500 branch. A caller who was merely going too fast was
 * told the server had broken - and a client cannot back off from a 500.
 *
 * The frontends branch on 429 specifically ("Too many attempts, wait a few
 * minutes"), so the status is part of the published contract, not an
 * implementation detail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { ErrorCode } from '../../src/domain/errors.js';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('rate limiting', () => {
  it('answers 429 with the RATE_LIMITED envelope, never 500', async () => {
    // The login limiter is the tightest, so it is the cheapest to exhaust.
    // A fixed, unusual IP keeps this from being tripped by other tests.
    const headers = { 'x-forwarded-for': '203.0.113.77' };

    let limited: Awaited<ReturnType<typeof app.inject>> | null = null;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        headers,
        payload: { email: 'nobody@uboss.local', password: 'WrongPassword!1' },
      });

      // A 500 here is the bug this test guards - fail loudly rather than
      // looping until the limiter happens to answer.
      expect(response.statusCode).toBeLessThan(500);

      if (response.statusCode === 429) {
        limited = response;
        break;
      }
    }

    expect(limited, 'the login limiter never triggered').not.toBeNull();

    const body = limited?.json<{
      error: { code: string; message: string; details: unknown[]; correlationId: string };
    }>();

    expect(body?.error.code).toBe(ErrorCode.RATE_LIMITED);
    // The message tells the caller how long to wait; without it a client can
    // only guess, and guessing means retrying immediately.
    expect(body?.error.message).toMatch(/retry in/i);
    expect(body?.error.correlationId).toBeTruthy();
    expect(Array.isArray(body?.error.details)).toBe(true);
  });

  it('does not count health checks against a caller budget', async () => {
    // A liveness probe runs on a fixed interval forever. Counting it would let
    // an orchestrator exhaust a real client's allowance.
    const headers = { 'x-forwarded-for': '203.0.113.78' };

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: '/health', headers });
      expect(response.statusCode).not.toBe(429);
    }
  });
});
