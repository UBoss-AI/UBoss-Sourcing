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
import { prisma } from '../../src/infra/prisma.js';

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
  marketplace: Record<string, unknown>;
  assistant: Record<string, unknown>;
  fulfilment: Record<string, unknown>;
  ordering: Record<string, unknown>;
}

describe('GET /api/v1/config', () => {
  it('is readable without authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });

    expect(response.statusCode).toBe(200);
  });

  it('exposes exactly the allowlisted fields and nothing else', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const body = response.json<ConfigResponse>();

    expect(Object.keys(body).sort()).toEqual([
      // AI Act Art. 50(1): the widget has to say it is a machine before
      // anybody types, so the disclosure is its own block rather than a
      // boolean the storefront has to interpret.
      'assistant',
      'business',
      'features',
      // The two rules the storefront has to draw a calendar and a warehouse
      // list from rather than hard-code. Both are deployment settings, and a
      // figure baked into a browser bundle is a figure an operator cannot
      // change.
      'fulfilment',
      'localisation',
      // Who runs the marketplace. Unlike `business`, never replaced by a
      // seller's name on a seller's shop front, so a sentence about the
      // marketplace names the operator on every host.
      'marketplace',
      // The selling unit. Every price the storefront prints is the price of
      // one carton, worked out from the catalogue's piece price and this
      // figure, so the browser cannot render a price without it.
      'ordering',
    ]);

    expect(Object.keys(body.ordering).sort()).toEqual(['piecesPerCarton']);

    // The chat team's name is shown to every customer who opens a chat, so it
    // is public by nature (PREORDER_CHAT_TEAM_NAME, else the trading name).
    expect(Object.keys(body.marketplace).sort()).toEqual(['chatTeamName', 'displayName']);

    expect(Object.keys(body.fulfilment).sort()).toEqual([
      // How long a warehouse option stays an offer, so the checkout page can
      // re-ask before it lapses rather than after.
      'fulfilmentQuoteTtlSeconds',
      // How much notice a first delivery needs. It greys out the first week
      // of the delivery-date picker; the exact floor for a given address and
      // warehouse comes from the signed-in endpoint, which knows about lanes
      // this one has no business publishing to anonymous visitors.
      'scheduleMinNoticeDays',
    ]);

    expect(Object.keys(body.assistant).sort()).toEqual([
      // Whether a visitor with no account may ask anything. Published because
      // the storefront has to know it BEFORE it draws the page: the alternative
      // is offering a composer whose only outcome is a 401, which somebody
      // discovers after typing out what they needed.
      'allowsGuests',
      'available',
      'isAi',
      'model',
      // Named on purpose: the provider receives whatever the visitor types, so
      // GDPR Art. 13(1)(e) puts them in the privacy notice, and a notice that
      // says "a third-party AI provider" names nobody.
      'vendor',
    ]);

    expect(Object.keys(body.business).sort()).toEqual([
      'currency',
      'displayName',
      'logo',
      'policyLinks',
      'supportEmail',
      'supportPhone',
      'timezone',
    ]);

    expect(Object.keys(body.features).sort()).toEqual([
      // Whether this deployment has an AI key configured. A boolean, never the
      // key or the model name: the storefront only needs to know whether to
      // offer AI Mode.
      'assistant',
      // Whether the camera button on the search bar can do anything. Tracks
      // `assistant` today — image search is a vision call on the same provider
      // — but travels as its own field so the storefront never infers one
      // capability from another.
      'imageSearch',
      'recurringOrders',
      'selfRegistration',
      // Whether a confirmed sign-up still waits for a member of staff. The
      // storefront says so on the form rather than only afterwards.
      'selfRegistrationRequiresApproval',
    ]);

    // The storefront asks a first-time shopper where they are before it can
    // price anything, so both lists are public. They carry no internal data:
    // a currency's code, name, symbol and exponent, and a country's dialling
    // prefix, are all facts a shopper is shown anyway.
    expect(Object.keys(body.localisation).sort()).toEqual([
      'baseCurrency',
      'countries',
      'currencies',
      // Whether a price here depends on where the buyer is - true once the
      // seller has a VAT country. A boolean, never the country itself: the
      // registration is not public, and an interface only needs to know
      // whether asking somebody where they are would change a number.
      'locationPricing',
    ]);
  });

  it('never carries the registered entity details', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const raw = response.body.toLowerCase();

    // The trading name is public; the filing is not. Nor is internal numbering,
    // which hints at order volume. `vatCountry` and `vatNumber` are read by
    // this response - the first decides `localisation.locationPricing` - and
    // neither may travel with it: a tax registration is a filing, and the
    // boolean is the whole of what a storefront or a console needs.
    for (const field of [
      'gstin',
      'legalname',
      'invoiceprefix',
      'orderprefix',
      'addressjson',
      'vatcountry',
      'vatnumber',
    ]) {
      expect(raw).not.toContain(field);
    }
  });

  it('reports the capability flags the storefront branches on', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const body = response.json<ConfigResponse>();

    // Booleans, not strings: the storefront uses these directly in a condition,
    // and the string "false" is truthy.
    expect(typeof body.features.selfRegistration).toBe('boolean');
    expect(typeof body.features.selfRegistrationRequiresApproval).toBe('boolean');
    expect(typeof body.features.recurringOrders).toBe('boolean');
  });

  /*
   * The brand, and the one thing about it that is not ours to decide.
   *
   * The product is called Glovia and the company behind it is UBOSS, and both
   * of those are constants in the browser bundles — see
   * `apps/customer-web/src/lib/brand.ts`. What THIS endpoint publishes is
   * neither of them: it is the operator's own trading name, because every
   * buyer runs their own deployment and the header of their storefront is
   * their name. The rename must not have turned that into a constant, which
   * is exactly the mistake a global search and replace would have made, and
   * exactly the mistake a test pinned to the string "Glovia" would have
   * blessed.
   */
  it('publishes the operator’s own trading name, not the product’s', async () => {
    const profile = await prisma.businessProfile.findFirst({ select: { displayName: true } });
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const body = response.json<ConfigResponse>();

    expect(typeof body.business.displayName).toBe('string');
    expect(String(body.business.displayName).length).toBeGreaterThan(0);

    if (profile !== null) {
      expect(body.business.displayName).toBe(profile.displayName);
    }
  });

  it('names the operator as the marketplace, from the same profile', async () => {
    const profile = await prisma.businessProfile.findFirst({ select: { displayName: true } });
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const body = response.json<ConfigResponse>();

    // Screens that say who manages a delivery level or who assigned a
    // consignment read this, so it must be the operator's own name.
    expect(body.marketplace.displayName).toBe(profile?.displayName.trim() || 'Glovia');
  });

  it('never carries the product’s former name', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });

    // "UBOSS Sourcing" was the product's name and the demo profile's trading
    // name at once, which is how it ended up in a hard-coded fallback in this
    // module and in the storefront bundle. Neither is there now, and an
    // operator who has genuinely registered a business by that name still gets
    // it back from their own profile — which the assertion above covers.
    expect(response.body).not.toContain('UBOSS Sourcing');
  });

  it('is cacheable, because it changes about as often as a company name', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });

    expect(response.headers['cache-control']).toContain('max-age=');
  });
});
