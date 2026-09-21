/**
 * The headers the API actually sends, read off real responses.
 *
 * `tests/unit/shipped-security-headers.test.ts` reads the nginx and Netlify
 * configuration, which is the right way to check the SPAs - nginx serves
 * those and this process never sees the request. It cannot check the API's
 * own headers, because those come from `@fastify/helmet` at runtime and the
 * only honest way to know what helmet emitted is to make a request and look.
 *
 * Nothing did, until the September 2026 audit. The audit report already
 * claimed "HSTS, frame denial, MIME sniffing protection, referrer policy and
 * enforcing API CSP are configured", and every word of it rested on reading
 * `app.ts`. Helmet merges what it is given with its own defaults, which means
 * the set that actually goes out is not the set written in the source - so
 * reading the source is exactly the thing that cannot answer the question.
 *
 * Four response shapes are checked, because a header set on the happy path
 * and lost on a 404 is a header that is absent when it matters:
 *
 *   - a 200 from a public route,
 *   - a 401 from a guarded route,
 *   - a 404 from the not-found handler,
 *   - a 400 from the error handler.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { isProduction } from '../../src/config/env.js';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** One response of each shape the error handling can produce. */
async function responses(): Promise<{ label: string; response: LightMyRequestResponse }[]> {
  return [
    {
      label: '200 from a public route',
      response: await app.inject({ method: 'GET', url: '/api/v1/config' }),
    },
    {
      label: '401 from a guarded route',
      response: await app.inject({ method: 'GET', url: '/api/v1/auth/me' }),
    },
    {
      label: '404 from the not-found handler',
      response: await app.inject({ method: 'GET', url: '/api/v1/there-is-no-such-route' }),
    },
    {
      label: '400 from the error handler',
      response: await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: 'this is not json',
      }),
    },
  ];
}

describe('every API response carries the security headers', () => {
  it('sets nosniff, frame denial and a referrer policy on all four shapes', async () => {
    for (const { label, response } of await responses()) {
      expect(response.headers['x-content-type-options'], label).toBe('nosniff');
      // Helmet's default; `frame-ancestors 'none'` in the CSP says the same
      // thing to a modern browser and this covers the rest.
      expect(response.headers['x-frame-options'], label).toBe('SAMEORIGIN');
      expect(response.headers['referrer-policy'], label).toBe('no-referrer');
    }
  });

  it('sets an enforcing Content-Security-Policy, never a report-only one', async () => {
    for (const { label, response } of await responses()) {
      const policy = response.headers['content-security-policy'];

      expect(policy, `${label} has no CSP`).toBeDefined();
      expect(response.headers['content-security-policy-report-only'], label).toBeUndefined();
      expect(String(policy), label).toContain("default-src 'none'");
      expect(String(policy), label).toContain("frame-ancestors 'none'");
    }
  });

  /**
   * The directive-by-directive check, and the reason this file exists.
   *
   * Helmet MERGES the `directives` it is given with its own defaults, which
   * are written for a web page. `app.ts` named `default-src`, `img-src` and
   * `frame-ancestors`, and the header that actually went out carried
   * `style-src 'self' https: 'unsafe-inline'`, `font-src 'self' https: data:`
   * and `script-src 'self'` underneath them — none of it intended, none of it
   * visible in the source, and `default-src 'none'` reading as though it
   * settled the matter.
   *
   * So this asserts the real header, directive by directive. An API that
   * returns JSON and images has no use for script, style, font or connect,
   * and each is pinned to 'none' rather than left to a default.
   */
  it('names every fetch directive rather than inheriting a default', async () => {
    const policy = String(
      (await app.inject({ method: 'GET', url: '/api/v1/config' })).headers[
        'content-security-policy'
      ],
    );

    const directives = new Map(
      policy
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => {
          const [name, ...values] = part.split(/\s+/);
          return [name ?? '', values.join(' ')] as const;
        }),
    );

    expect(directives.get('default-src')).toBe("'none'");
    // The one thing a browser may fetch from this origin: uploaded media.
    expect(directives.get('img-src')).toBe("'self' data:");

    for (const directive of ['script-src', 'style-src', 'font-src', 'connect-src']) {
      expect(directives.get(directive), `${directive} is not locked down`).toBe("'none'");
    }

    expect(directives.get('base-uri')).toBe("'self'");
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('form-action')).toBe("'self'");
    expect(directives.get('frame-ancestors')).toBe("'none'");

    // Nothing anywhere in the policy re-opens what the four above closed.
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toContain('https:');
  });

  it('carries a correlation id on every response, including failures', async () => {
    for (const { label, response } of await responses()) {
      expect(response.headers['x-correlation-id'], label).toMatch(/^[0-9A-Za-z_-]{1,64}$/);
    }
  });

  /**
   * HSTS is production-only on purpose: sent over plain HTTP in development
   * it would pin `localhost` to HTTPS in the developer's browser, which is a
   * genuinely unpleasant thing to undo.
   */
  it('sends HSTS in production and not outside it', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const hsts = response.headers['strict-transport-security'];

    if (isProduction) {
      expect(String(hsts)).toContain('max-age=31536000');
      expect(String(hsts)).toContain('includeSubDomains');
    } else {
      expect(hsts).toBeUndefined();
    }
  });
});

describe('an unexpected failure discloses nothing', () => {
  /**
   * The 500 branch of the error handler is the one that must never leak. It
   * cannot be provoked from outside without breaking something real, so this
   * asserts the shape of what a client CAN provoke and checks that none of
   * the four carries a stack trace, a driver message or a SQL fragment.
   */
  it('never returns a stack trace, a driver message or a SQL fragment', async () => {
    for (const { label, response } of await responses()) {
      const body = response.body;

      for (const leak of [
        'at Object.',
        'node_modules',
        'PrismaClient',
        'SELECT ',
        'INSERT INTO',
        'mysql',
        'ECONNREFUSED',
        '.ts:',
      ]) {
        expect(body, `${label} leaks "${leak}"`).not.toContain(leak);
      }
    }
  });
});
