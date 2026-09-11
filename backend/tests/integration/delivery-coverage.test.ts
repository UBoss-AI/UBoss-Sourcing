/**
 * Delivery coverage over HTTP - integration, against a real MariaDB.
 *
 * The geometry itself is proved in `tests/unit/delivery-coverage.test.ts`, at
 * real coordinates with answers checked against the ground. This file covers
 * everything around it that a unit test cannot reach:
 *
 *   - **Authorisation.** It is INVENTORY_READ, the same permission as the list
 *     the panel opens it from, and an anonymous caller gets nothing.
 *   - **The two refusals are different.** A warehouse that does not exist is a
 *     404; one that exists with no plottable position is a 422 carrying
 *     `LOCATION_NOT_PLACED`, because the fixes differ and the panel says
 *     something different about each.
 *   - **The radius is a parameter with a configured default**, bounded at both
 *     ends, and the response says which radius it actually measured.
 *   - **The response carries the ring it measured**, so the browser draws that
 *     rather than its own approximation of a circle.
 *   - **The operator's own country name wins**, which needs the `countries`
 *     table and therefore a database.
 *
 * Cleanup is in `afterAll` and removes every row this file made. Warehouses
 * are ON DELETE RESTRICT from half the schema, so a leftover fixture breaks
 * whichever file the suite runs next.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signInAdmin } from '../support/admin-session.js';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { env } from '../../src/config/env.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let cookies: string;

const EMAIL = 'coverage-reader@test.local';
const PASSWORD = 'Coverage!2026';

/** Every code this file creates starts here, so cleanup can find them all. */
const PREFIX = 'DCT-';

/** Antwerp. 15 km from the Dutch border, 150 km from the German one. */
const ANTWERP = { latitude: 51.2194, longitude: 4.4025 };
/** Central Madrid. 244 km from the nearest foreign border. */
const MADRID = { latitude: 40.4168, longitude: -3.7038 };

interface CoveredCountry {
  code: string | null;
  name: string;
  flag: string;
  distanceKm: number;
  nearestPoint: { latitude: number; longitude: number };
  area: { type: string; coordinates: unknown } | null;
  isExcluded: boolean;
  exclusionReason: string | null;
}

interface CoverageResponse {
  warehouse: { id: string; code: string; name: string; latitude: number; longitude: number };
  radiusKm: number;
  radiusSource: 'REQUEST' | 'WAREHOUSE' | 'DEPLOYMENT_DEFAULT';
  home: {
    code: string | null;
    name: string;
    flag: string;
    isExcluded: boolean;
    exclusionReason: string | null;
  } | null;
  countries: CoveredCountry[];
  dormantExclusions: { code: string; name: string; flag: string; reason: string | null }[];
  ring: { type: string; coordinates: number[][][] };
  computedAt: string;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

/**
 * A warehouse, written straight to the database.
 *
 * Not through the API, and the reason matters: `createWarehouse` makes the
 * first warehouse in an empty database the default whatever the form said, and
 * this file has no business changing which warehouse a deployment receives
 * unqualified stock into. Writing the row directly leaves the default alone.
 */
async function warehouse(options: {
  code: string;
  latitude?: number | null;
  longitude?: number | null;
  countryCode?: string;
}): Promise<string> {
  const id = newId();

  await prisma.inventoryLocation.create({
    data: {
      id,
      code: options.code,
      name: `Coverage ${options.code}`,
      isActive: true,
      isDefault: false,
      ...(options.countryCode === undefined ? {} : { countryCode: options.countryCode }),
      ...(options.latitude === undefined || options.latitude === null
        ? {}
        : { latitude: options.latitude }),
      ...(options.longitude === undefined || options.longitude === null
        ? {}
        : { longitude: options.longitude }),
    },
  });

  return id;
}

function get(
  id: string,
  query = '',
  headers: Record<string, string> = { cookie: cookies },
): Promise<ReturnType<typeof app.inject> extends Promise<infer T> ? T : never> {
  return app.inject({
    method: 'GET',
    url: `/api/v1/admin/inventory/warehouses/${id}/delivery-coverage${query === '' ? '' : `?${query}`}`,
    headers,
  });
}

async function coverage(id: string, query = ''): Promise<CoverageResponse> {
  const response = await get(id, query);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CoverageResponse>();
}

let antwerpId: string;
let madridId: string;
let unplacedId: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await prisma.inventoryLocation.deleteMany({ where: { code: { startsWith: PREFIX } } });

  antwerpId = await warehouse({ code: `${PREFIX}ANR`, ...ANTWERP, countryCode: 'BE' });
  madridId = await warehouse({ code: `${PREFIX}MAD`, ...MADRID, countryCode: 'ES' });
  unplacedId = await warehouse({ code: `${PREFIX}NOWHERE` });

  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });

  // An Order Manager: holds inventory.read and nothing that writes a
  // warehouse, which is exactly the permission this endpoint asks for.
  const role = await prisma.role.findUniqueOrThrow({
    where: { key: Role.ORDER_MANAGER },
    select: { id: true },
  });

  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });

  // Its own IP, so this file does not spend a neighbouring one's login budget.
  ({ cookies } = await signInAdmin(app, {
    email: EMAIL,
    password: PASSWORD,
    ip: '203.0.113.160',
  }));
});

afterAll(async () => {
  // The exclusions cascade with their warehouse, but a test that failed
  // part-way through its own `finally` would leave one behind - and an
  // exclusion on a warehouse this file did not create would change what the
  // next file measures.
  await prisma.warehouseCountryExclusion.deleteMany({
    where: { location: { code: { startsWith: PREFIX } } },
  });
  await prisma.inventoryLocation.deleteMany({ where: { code: { startsWith: PREFIX } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
  await app.close();
});

describe('a warehouse near one border', () => {
  it('reports the country it stands in separately from the ones it reaches', async () => {
    const body = await coverage(antwerpId, 'radiusKm=100');

    expect(body.home?.code).toBe('BE');
    expect(body.countries.map((country) => country.code)).toEqual(['NL']);
  });

  it('carries the distance to the nearest border and a point on it', async () => {
    const [netherlands] = (await coverage(antwerpId, 'radiusKm=100')).countries;

    expect(netherlands?.distanceKm).toBeGreaterThan(5);
    expect(netherlands?.distanceKm).toBeLessThan(30);
    // The point has to be north of Antwerp and inside the ring, or the curved
    // route the panel draws to it would point at open sea.
    expect(netherlands?.nearestPoint.latitude).toBeGreaterThan(ANTWERP.latitude);
    expect(netherlands?.nearestPoint.longitude).toBeGreaterThan(2);
    expect(netherlands?.nearestPoint.longitude).toBeLessThan(7);
  });

  it('carries a flag and the covered slice for drawing', async () => {
    const [netherlands] = (await coverage(antwerpId, 'radiusKm=100')).countries;

    expect(netherlands?.flag).not.toBe('');
    expect(['Polygon', 'MultiPolygon']).toContain(netherlands?.area?.type);
  });

  /**
   * The ring travels with the answer.
   *
   * Two implementations of "a 100 km circle" drift - one geodesic, one in
   * projected degrees - and a ring that disagrees with the list beside it is
   * worse than no ring at all. So the server sends the polygon it measured.
   */
  it('returns the ring it measured, closed and centred on the warehouse', async () => {
    const body = await coverage(antwerpId, 'radiusKm=100');
    const outer = body.ring.coordinates[0] ?? [];

    expect(body.ring.type).toBe('Polygon');
    expect(outer.length).toBeGreaterThan(100);
    expect(outer[0]).toEqual(outer[outer.length - 1]);

    const latitudes = outer.map((position) => position[1] ?? 0);
    // ~0.9° of latitude per 100 km, so the ring spans about 1.8°.
    expect(Math.max(...latitudes) - Math.min(...latitudes)).toBeGreaterThan(1.5);
    expect(Math.max(...latitudes) - Math.min(...latitudes)).toBeLessThan(2.1);
  });

  it('echoes the warehouse and the radius it was asked for', async () => {
    const body = await coverage(antwerpId, 'radiusKm=100');

    expect(body.warehouse.id).toBe(antwerpId);
    expect(body.warehouse.code).toBe(`${PREFIX}ANR`);
    expect(body.warehouse.latitude).toBeCloseTo(ANTWERP.latitude, 3);
    expect(body.radiusKm).toBe(100);
  });

  /**
   * The name comes from the deployment's own table where it has a row, so the
   * flap on the map agrees with the country filter three inches below it.
   */
  it('prefers the operator country name over the ISO one', async () => {
    const original = await prisma.country.findUnique({
      where: { code: 'NL' },
      select: { name: true },
    });

    if (original === null) {
      // A database whose reference data was never seeded. Nothing to prove.
      expect((await coverage(antwerpId)).countries[0]?.name).toBe('Netherlands');
      return;
    }

    await prisma.country.update({ where: { code: 'NL' }, data: { name: 'Holland (test)' } });

    try {
      expect((await coverage(antwerpId, 'radiusKm=100')).countries[0]?.name).toBe(
        'Holland (test)',
      );
    } finally {
      await prisma.country.update({ where: { code: 'NL' }, data: { name: original.name } });
    }
  });
});

/**
 * The case the whole feature is judged on: an empty list is an answer, not a
 * failure, and nothing may be invented to fill it.
 */
describe('a warehouse with no foreign border in range', () => {
  it('reaches nothing, and says which country it is in', async () => {
    const body = await coverage(madridId, 'radiusKm=100');

    expect(body.home?.code).toBe('ES');
    expect(body.countries).toEqual([]);
  });

  it('does not offer the nearest country just because it is nearest', async () => {
    const body = await coverage(madridId, 'radiusKm=100');

    expect(body.countries.map((country) => country.code)).not.toContain('PT');
  });

  it('finds it once the radius is honestly big enough', async () => {
    const body = await coverage(madridId, 'radiusKm=250');

    expect(body.countries.map((country) => country.code)).toContain('PT');
  });
});

describe('the radius parameter', () => {
  it('falls back to the configured default when none is given', async () => {
    // tests/setup.ts leaves DELIVERY_COVERAGE_RADIUS_KM at its own default,
    // which the geofencing work moved from 100 km to 500. These fixtures carry
    // no radius of their own, so the deployment's is what applies - and the
    // answer says so, which is the assertion below it.
    const body = await coverage(antwerpId);

    expect(body.radiusKm).toBe(env.DELIVERY_COVERAGE_RADIUS_KM);
    expect(body.radiusSource).toBe('DEPLOYMENT_DEFAULT');
  });

  it('accepts a fractional radius', async () => {
    expect((await coverage(antwerpId, 'radiusKm=12.5')).radiusKm).toBe(12.5);
  });

  it('refuses a radius past the ceiling', async () => {
    const response = await get(antwerpId, 'radiusKm=5000');

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses zero and negative radii', async () => {
    expect((await get(antwerpId, 'radiusKm=0')).statusCode).toBe(400);
    expect((await get(antwerpId, 'radiusKm=-10')).statusCode).toBe(400);
  });

  it('refuses a radius that is not a number', async () => {
    expect((await get(antwerpId, 'radiusKm=soon')).statusCode).toBe(400);
  });
});

describe('warehouses it cannot measure', () => {
  it('is a 404 for a warehouse that does not exist', async () => {
    const response = await get(newId());

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorResponse>().error.code).toBe('NOT_FOUND');
  });

  it('is a 400 for an id that is not one', async () => {
    expect((await get('nonsense')).statusCode).toBe(400);
  });

  /**
   * A warehouse with no coordinates is not a bad request - the caller sent a
   * perfectly good one - and it is not a 404, because the warehouse is right
   * there in the list. Its own code, so the panel can offer "add coordinates"
   * instead of "try again".
   */
  it('is a 422 LOCATION_NOT_PLACED for a warehouse with no coordinates', async () => {
    const response = await get(unplacedId);

    expect(response.statusCode).toBe(422);

    const body = response.json<ErrorResponse>();
    expect(body.error.code).toBe('LOCATION_NOT_PLACED');
    expect(body.error.message).toContain(`${PREFIX}NOWHERE`);
  });
});

/**
 * The geofence: a radius the warehouse owns, and the countries it refuses.
 *
 * These are the assertions the whole feature turns on, and they are all about
 * the same distinction: what geometry can *reach* against what the business
 * will *serve*. Getting them the wrong way round means either promising a
 * country somebody deliberately closed, or hiding a decision an operator has
 * to be able to see and undo.
 */
describe('a warehouse with a radius of its own', () => {
  it('measures its own radius rather than the deployment default', async () => {
    await prisma.inventoryLocation.update({
      where: { id: madridId },
      data: { deliveryRadiusKm: 300 },
    });

    try {
      const body = await coverage(madridId);

      expect(body.radiusKm).toBe(300);
      expect(body.radiusSource).toBe('WAREHOUSE');
      // 300 km out of central Madrid reaches Portugal and nothing else.
      expect(body.countries.map((country) => country.code)).toContain('PT');
    } finally {
      await prisma.inventoryLocation.update({
        where: { id: madridId },
        data: { deliveryRadiusKm: null },
      });
    }
  });

  /**
   * A radius the caller asked for beats the warehouse's own, and says so.
   *
   * That is what the panel's slider needs: trying 800 km on a warehouse that
   * promises 300 must show what 800 would reach, and must not be presented as
   * the warehouse's promise.
   */
  it('lets a requested radius override it, marked as a request', async () => {
    await prisma.inventoryLocation.update({
      where: { id: madridId },
      data: { deliveryRadiusKm: 300 },
    });

    try {
      const body = await coverage(madridId, 'radiusKm=100');

      expect(body.radiusKm).toBe(100);
      expect(body.radiusSource).toBe('REQUEST');
      expect(body.countries).toEqual([]);
    } finally {
      await prisma.inventoryLocation.update({
        where: { id: madridId },
        data: { deliveryRadiusKm: null },
      });
    }
  });
});

describe('countries the operator has closed', () => {
  async function close(locationId: string, countryCode: string, reason: string): Promise<void> {
    await prisma.warehouseCountryExclusion.create({
      data: { id: newId(), locationId, countryCode, reason },
    });
  }

  /**
   * **The exclusion is reported, not filtered out.**
   *
   * A closed country dropped from this answer would be indistinguishable from
   * one that is forty kilometres too far away - and the first is a decision
   * somebody made and may want to undo, where the second is a fact about the
   * ground. The panel draws it in the refusing colour; the storefront is what
   * withholds it from a buyer.
   */
  it('keeps a closed country in the list, flagged and with its reason', async () => {
    await close(antwerpId, 'NL', 'No customs broker for the Netherlands.');

    try {
      const body = await coverage(antwerpId, 'radiusKm=100');
      const netherlands = body.countries.find((country) => country.code === 'NL');

      expect(netherlands).toBeDefined();
      expect(netherlands?.isExcluded).toBe(true);
      expect(netherlands?.exclusionReason).toBe('No customs broker for the Netherlands.');
      // Still measured, still shaded: the geometry is unaffected by the
      // business decision laid over it.
      expect(netherlands?.distanceKm).toBeGreaterThan(5);
      expect(netherlands?.area).not.toBeNull();
    } finally {
      await prisma.warehouseCountryExclusion.deleteMany({ where: { locationId: antwerpId } });
    }
  });

  it('leaves every other country in range unflagged', async () => {
    await close(antwerpId, 'NL', 'Closed.');

    try {
      const body = await coverage(antwerpId, 'radiusKm=250');
      const others = body.countries.filter((country) => country.code !== 'NL');

      expect(others.length).toBeGreaterThan(0);
      expect(others.every((country) => !country.isExcluded)).toBe(true);
    } finally {
      await prisma.warehouseCountryExclusion.deleteMany({ where: { locationId: antwerpId } });
    }
  });

  /**
   * An exclusion outside the radius is kept and reported separately.
   *
   * A radius grows. Somebody who closed a country at 100 km has said something
   * that must still hold at 800, so the row is never cleaned up for being
   * inactive - and listing it is how an exclusion added to the wrong warehouse
   * gets found before the day it starts to bite.
   */
  it('reports an exclusion the radius does not reach as dormant', async () => {
    await close(antwerpId, 'GR', 'Distributor holds Greece.');

    try {
      const body = await coverage(antwerpId, 'radiusKm=100');

      expect(body.countries.map((country) => country.code)).not.toContain('GR');
      expect(body.dormantExclusions.map((entry) => entry.code)).toEqual(['GR']);
      expect(body.dormantExclusions[0]?.reason).toBe('Distributor holds Greece.');
      expect(body.dormantExclusions[0]?.name).not.toBe('');
    } finally {
      await prisma.warehouseCountryExclusion.deleteMany({ where: { locationId: antwerpId } });
    }
  });

  it('moves an exclusion out of dormant once the radius reaches it', async () => {
    await close(antwerpId, 'DE', 'Closed.');

    try {
      const near = await coverage(antwerpId, 'radiusKm=100');
      expect(near.dormantExclusions.map((entry) => entry.code)).toEqual(['DE']);

      const far = await coverage(antwerpId, 'radiusKm=250');
      expect(far.dormantExclusions).toEqual([]);
      expect(
        far.countries.find((country) => country.code === 'DE')?.isExcluded,
      ).toBe(true);
    } finally {
      await prisma.warehouseCountryExclusion.deleteMany({ where: { locationId: antwerpId } });
    }
  });

  /**
   * A warehouse may be told not to deliver in its own country.
   *
   * Rare and entirely legitimate - a bonded site serving export markets only,
   * or one whose domestic sales go through a distributor - so the home country
   * carries the same flag as every other rather than being assumed served.
   */
  it('flags the home country when that is the one closed', async () => {
    await close(antwerpId, 'BE', 'Domestic sales go through the distributor.');

    try {
      const body = await coverage(antwerpId, 'radiusKm=100');

      expect(body.home?.code).toBe('BE');
      expect(body.home?.isExcluded).toBe(true);
      expect(body.home?.exclusionReason).toBe('Domestic sales go through the distributor.');
      // Not counted as dormant: the radius plainly reaches the country the
      // warehouse is standing in.
      expect(body.dormantExclusions).toEqual([]);
    } finally {
      await prisma.warehouseCountryExclusion.deleteMany({ where: { locationId: antwerpId } });
    }
  });
});

describe('authorisation', () => {
  it('refuses an anonymous caller', async () => {
    const response = await get(antwerpId, '', {});

    expect(response.statusCode).toBe(401);
  });
});
