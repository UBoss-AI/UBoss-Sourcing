/**
 * Public storefront config - integration.
 *
 * This endpoint is unauthenticated, so its field list is a security boundary
 * rather than a convenience. The test below asserts the *exact* set of keys,
 * not merely that the expected ones are present: a test that only checks for
 * presence passes happily the day somebody adds `gstin` to the response.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

interface ConfigResponse {
  business: Record<string, unknown>;
  features: Record<string, unknown>;
  localisation: Record<string, unknown>;
}

describe('GET /api/v1/config', () => {
  it('is readable without authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });

    expect(response.statusCode).toBe(200);
  });

  it('exposes exactly the allowlisted fields and nothing else', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const body = response.json<ConfigResponse>();

    expect(Object.keys(body).sort()).toEqual(['business', 'features', 'localisation']);

    expect(Object.keys(body.business).sort()).toEqual([
      'currency',
      'displayName',
      'logo',
      'policyLinks',
      'supportEmail',
      'supportPhone',
      'timezone',
    ]);

    expect(Object.keys(body.features).sort()).toEqual(['recurringOrders', 'selfRegistration']);

    // The storefront asks a first-time shopper where they are before it can
    // price anything, so both lists are public. They carry no internal data:
    // a currency's code, name, symbol and exponent, and a country's dialling
    // prefix, are all facts a shopper is shown anyway.
    expect(Object.keys(body.localisation).sort()).toEqual([
      'baseCurrency',
      'countries',
      'currencies',
    ]);
  });

  it('never carries the registered entity details', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const raw = response.body.toLowerCase();

    // The trading name is public; the filing is not. Nor is internal numbering,
    // which hints at order volume.
    for (const field of ['gstin', 'legalname', 'invoiceprefix', 'orderprefix', 'addressjson']) {
      expect(raw).not.toContain(field);
    }
  });

  it('reports the capability flags the storefront branches on', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const body = response.json<ConfigResponse>();

    // Booleans, not strings: the storefront uses these directly in a condition,
    // and the string "false" is truthy.
    expect(typeof body.features.selfRegistration).toBe('boolean');
    expect(typeof body.features.recurringOrders).toBe('boolean');
  });

  it('is cacheable, because it changes about as often as a company name', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });

    expect(response.headers['cache-control']).toContain('max-age=');
  });
});
