/**
 * Who can deliver this basket - integration, over HTTP, against a real
 * MariaDB.
 *
 * The storefront half of geofencing, and the file that proves the four
 * refusals the feature is worth having for. Each of them is a way of being
 * wrong that *looks* right on screen:
 *
 *   - **Reach is not enough.** A warehouse 200 km away that does not hold the
 *     item cannot deliver it, and offering it would be a promise broken at the
 *     picking face rather than at checkout. So it comes back under `partial`,
 *     which is reported and not hidden - a buyer who can split an order wants
 *     to see it, and one who cannot needs to know why the depot in their own
 *     city is missing from the list.
 *   - **An excluded country is not offered.** The admin panel keeps a closed
 *     country visible so an operator can see the decision; a buyer must simply
 *     not be offered it. Same rows, different audience.
 *   - **A warehouse that cannot ship today is not offered either.** LIMITED
 *     can ship and is offered with a flag; MAINTENANCE and SUSPENDED cannot.
 *   - **Nothing is invented.** A warehouse with no lead time and no fee comes
 *     back with nulls rather than a made-up "3-5 days, free".
 *
 * The endpoint is public, which is itself under test: a buyer asks "can you
 * get this to Belgium" before they have an account.
 *
 * Cleanup is in `afterAll` and removes every row this file made. Balances are
 * ON DELETE RESTRICT from `inventory_locations`, so a leftover fixture breaks
 * whichever file the suite runs next.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;

/** Every code and SKU this file creates starts here, so cleanup finds them. */
const PREFIX = 'DOT-';

/** Antwerp. 15 km from the Dutch border, ~100 km from the French one. */
const ANTWERP = { latitude: 51.2194, longitude: 4.4025 };
/** Villaverde, south Madrid. ~350 km from France, ~510 km from Morocco. */
const MADRID = { latitude: 40.345, longitude: -3.69 };

interface OptionLine {
  productId: string;
  variantId: string | null;
  productName: string;
  sku: string;
  quantity: number;
  availableQty: number;
  isStockTracked: boolean;
  isFulfillable: boolean;
}

interface Option {
  warehouse: {
    id: string;
    code: string;
    name: string;
    countryCode: string | null;
    countryName: string | null;
    city: string | null;
    operationalStatus: string;
  };
  distanceKm: number;
  radiusKm: number;
  leadTimeDays: { min: number; max: number } | null;
  fee: { minor: string; formatted: string; currency: string } | null;
  canFulfilAll: boolean;
  fulfillableLines: number;
  lines: OptionLine[];
  isFastest: boolean;
  isCheapest: boolean;
}

interface OptionsResponse {
  destination: { countryCode: string; countryName: string };
  options: Option[];
  partial: Option[];
  closedByOperator: number;
  computedAt: string;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

let categoryId: string;
let taxClassId: string;
let antwerpId: string;
let madridId: string;
let maintenanceId: string;

/** Held at both warehouses. */
let sharedProductId: string;
/** Held only at Madrid, which is what proves the stock rule. */
let madridOnlyProductId: string;
/** Made to order: no quantity anywhere, and fulfillable from anywhere in range. */
let untrackedProductId: string;

async function warehouse(options: {
  code: string;
  latitude: number;
  longitude: number;
  countryCode: string;
  city: string;
  radiusKm: number | null;
  leadTime: { min: number; max: number } | null;
  fee: { minor: bigint; currency: string } | null;
  operationalStatus?: 'OPERATIONAL' | 'LIMITED' | 'MAINTENANCE' | 'SUSPENDED';
}): Promise<string> {
  const id = newId();

  await prisma.inventoryLocation.create({
    data: {
      id,
      code: options.code,
      name: `Delivery ${options.code}`,
      isActive: true,
      isDefault: false,
      countryCode: options.countryCode,
      addressJson: { city: options.city },
      latitude: options.latitude.toFixed(6),
      longitude: options.longitude.toFixed(6),
      operationalStatus: options.operationalStatus ?? 'OPERATIONAL',
      deliveryRadiusKm: options.radiusKm,
      deliveryLeadTimeMinDays: options.leadTime?.min ?? null,
      deliveryLeadTimeMaxDays: options.leadTime?.max ?? null,
      deliveryFeeMinor: options.fee?.minor ?? null,
      deliveryFeeCurrency: options.fee?.currency ?? null,
    },
  });

  return id;
}

async function product(sku: string, isStockTracked = true): Promise<string> {
  const id = newId();

  await prisma.product.create({
    data: {
      id,
      categoryId,
      taxClassId,
      name: `Product ${sku}`,
      slug: `delivery-options-${sku.toLowerCase()}`,
      sku,
      status: 'ACTIVE',
      isPublished: true,
      basePriceMinor: 1000n,
      currency: 'EUR',
      isStockTracked,
    },
  });

  return id;
}

async function balance(locationId: string, productId: string, onHand: number): Promise<void> {
  await prisma.inventoryBalance.create({
    data: { id: newId(), productId, variantKey: '', locationId, onHandQty: onHand },
  });
}

function post(payload: Record<string, unknown>): Promise<ReturnType<typeof app.inject> extends Promise<infer T> ? T : never> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/delivery/options',
    payload,
  });
}

async function options(payload: Record<string, unknown>): Promise<OptionsResponse> {
  const response = await post(payload);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<OptionsResponse>();
}

/** Only the warehouses this file made: the database is shared with the suite. */
function own(list: Option[]): Option[] {
  return list.filter((option) => option.warehouse.code.startsWith(PREFIX));
}

function codes(list: Option[]): string[] {
  return own(list)
    .map((option) => option.warehouse.code)
    .sort();
}

async function cleanUp(): Promise<void> {
  await prisma.warehouseCountryExclusion.deleteMany({
    where: { location: { code: { startsWith: PREFIX } } },
  });
  await prisma.inventoryBalance.deleteMany({
    where: { product: { sku: { startsWith: PREFIX } } },
  });
  await prisma.product.deleteMany({ where: { sku: { startsWith: PREFIX } } });
  await prisma.inventoryLocation.deleteMany({ where: { code: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: 'delivery-options-test' } });
  await prisma.taxClass.deleteMany({ where: { code: `${PREFIX}TAX` } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await cleanUp();

  taxClassId = newId();
  await prisma.taxClass.create({
    data: { id: taxClassId, code: `${PREFIX}TAX`, name: 'Delivery options test', ratePercent: '21' },
  });

  categoryId = newId();
  await prisma.category.create({
    data: {
      id: categoryId,
      name: 'Delivery options test',
      slug: 'delivery-options-test',
      path: 'delivery-options-test',
      depth: 0,
      isActive: true,
    },
  });

  antwerpId = await warehouse({
    code: `${PREFIX}ANR`,
    ...ANTWERP,
    countryCode: 'BE',
    city: 'Antwerpen',
    radiusKm: 500,
    leadTime: { min: 2, max: 4 },
    fee: { minor: 1200n, currency: 'EUR' },
  });

  madridId = await warehouse({
    code: `${PREFIX}MAD`,
    ...MADRID,
    countryCode: 'ES',
    city: 'Madrid',
    radiusKm: 800,
    leadTime: { min: 3, max: 6 },
    fee: { minor: 995n, currency: 'EUR' },
  });

  // Under MAINTENANCE and otherwise identical to Antwerp: no boxes are leaving
  // the building, so it must never be offered however near it is.
  maintenanceId = await warehouse({
    code: `${PREFIX}CLOSED`,
    ...ANTWERP,
    countryCode: 'BE',
    city: 'Antwerpen',
    radiusKm: 500,
    leadTime: { min: 1, max: 1 },
    fee: { minor: 0n, currency: 'EUR' },
    operationalStatus: 'MAINTENANCE',
  });

  sharedProductId = await product(`${PREFIX}SHARED`);
  madridOnlyProductId = await product(`${PREFIX}MADONLY`);
  untrackedProductId = await product(`${PREFIX}MADETOORDER`, false);

  await balance(antwerpId, sharedProductId, 500);
  await balance(madridId, sharedProductId, 500);
  await balance(maintenanceId, sharedProductId, 500);

  // Antwerp has a row and none of it: out of stock, which is different from
  // never having stocked it and the same answer either way for a buyer.
  await balance(antwerpId, madridOnlyProductId, 0);
  await balance(madridId, madridOnlyProductId, 250);
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('a country two warehouses can reach', () => {
  /**
   * The case the whole feature exists for.
   *
   * France is inside Antwerp's 500 km and Madrid's 800 km, and the two do not
   * offer the same thing - which is the trade a buyer gets to make.
   */
  it('offers both, with their own timings and prices', async () => {
    const body = await options({
      countryCode: 'FR',
      items: [{ productId: sharedProductId, quantity: 5 }],
    });

    expect(codes(body.options)).toEqual([`${PREFIX}ANR`, `${PREFIX}MAD`]);

    const antwerp = body.options.find((o) => o.warehouse.code === `${PREFIX}ANR`);
    const madrid = body.options.find((o) => o.warehouse.code === `${PREFIX}MAD`);

    expect(antwerp?.leadTimeDays).toEqual({ min: 2, max: 4 });
    expect(antwerp?.fee?.minor).toBe('1200');
    expect(madrid?.leadTimeDays).toEqual({ min: 3, max: 6 });
    expect(madrid?.fee?.minor).toBe('995');
  });

  it('flags the soonest and the cheapest, and they need not be the same one', async () => {
    const body = await options({
      countryCode: 'FR',
      items: [{ productId: sharedProductId, quantity: 5 }],
    });

    const antwerp = body.options.find((o) => o.warehouse.code === `${PREFIX}ANR`);
    const madrid = body.options.find((o) => o.warehouse.code === `${PREFIX}MAD`);

    expect(antwerp?.isFastest).toBe(true);
    expect(antwerp?.isCheapest).toBe(false);
    expect(madrid?.isCheapest).toBe(true);
    expect(madrid?.isFastest).toBe(false);
  });

  it('orders them soonest first', async () => {
    const body = await options({
      countryCode: 'FR',
      items: [{ productId: sharedProductId, quantity: 5 }],
    });

    expect(own(body.options)[0]?.warehouse.code).toBe(`${PREFIX}ANR`);
  });

  it('says where each one ships from', async () => {
    const body = await options({ countryCode: 'FR' });
    const antwerp = body.options.find((o) => o.warehouse.code === `${PREFIX}ANR`);

    expect(antwerp?.warehouse.city).toBe('Antwerpen');
    expect(antwerp?.warehouse.countryCode).toBe('BE');
    expect(antwerp?.warehouse.countryName).not.toBeNull();
  });

  /**
   * Distance is to the destination *country's* nearest border, not to an
   * address. An option is offered before an address is chosen, and a promise
   * that changed once a postcode was typed would be a different promise.
   */
  it('measures to the destination country, not to an address', async () => {
    const body = await options({ countryCode: 'FR' });
    const antwerp = body.options.find((o) => o.warehouse.code === `${PREFIX}ANR`);

    expect(antwerp?.distanceKm).toBeGreaterThan(50);
    expect(antwerp?.distanceKm).toBeLessThan(200);
    expect(antwerp?.radiusKm).toBe(500);
  });

  /** Zero for a warehouse standing inside the destination country. */
  it('reports zero distance for a warehouse in the destination country', async () => {
    const body = await options({ countryCode: 'BE' });
    const antwerp = body.options.find((o) => o.warehouse.code === `${PREFIX}ANR`);

    expect(antwerp?.distanceKm).toBe(0);
  });
});

describe('stock decides who can actually deliver', () => {
  /**
   * The third geofencing rule: only the warehouse that holds the item may
   * offer it.
   *
   * Both warehouses reach France. Only Madrid has the product, so Antwerp is
   * reported as `partial` rather than dropped or offered.
   */
  it('offers only the warehouse that holds the item', async () => {
    const body = await options({
      countryCode: 'FR',
      items: [{ productId: madridOnlyProductId, quantity: 5 }],
    });

    expect(codes(body.options)).toEqual([`${PREFIX}MAD`]);
    expect(codes(body.partial)).toEqual([`${PREFIX}ANR`]);
  });

  it('names the line a partial warehouse is short of, with the quantities', async () => {
    const body = await options({
      countryCode: 'FR',
      items: [{ productId: madridOnlyProductId, quantity: 5 }],
    });

    const [line] = own(body.partial)[0]?.lines ?? [];

    expect(line?.quantity).toBe(5);
    expect(line?.availableQty).toBe(0);
    expect(line?.isFulfillable).toBe(false);
    expect(line?.productName).toContain(`${PREFIX}MADONLY`);
  });

  it('refuses a warehouse that holds some but not enough', async () => {
    const body = await options({
      countryCode: 'FR',
      items: [{ productId: madridOnlyProductId, quantity: 400 }],
    });

    // Madrid holds 250 of 400. In range, and cannot fill it.
    expect(codes(body.options)).toEqual([]);
    expect(codes(body.partial)).toEqual([`${PREFIX}ANR`, `${PREFIX}MAD`]);
  });

  it('counts how many lines a partial warehouse could cover', async () => {
    const body = await options({
      countryCode: 'FR',
      items: [
        { productId: sharedProductId, quantity: 5 },
        { productId: madridOnlyProductId, quantity: 5 },
      ],
    });

    const antwerp = own(body.partial).find((o) => o.warehouse.code === `${PREFIX}ANR`);

    expect(antwerp?.fulfillableLines).toBe(1);
    expect(antwerp?.lines).toHaveLength(2);
    expect(antwerp?.canFulfilAll).toBe(false);
  });

  /**
   * A product nobody tracks the quantity of is fulfillable from anywhere in
   * range: there is no number to be short of.
   */
  it('treats a product with no stock tracking as available everywhere in range', async () => {
    const body = await options({
      countryCode: 'FR',
      items: [{ productId: untrackedProductId, quantity: 999 }],
    });

    expect(codes(body.options)).toEqual([`${PREFIX}ANR`, `${PREFIX}MAD`]);
    expect(own(body.options)[0]?.lines[0]?.isStockTracked).toBe(false);
  });

  /**
   * An empty basket is a real question - "who could ever deliver here" - which
   * is what a product page asks before anything is in a cart.
   */
  it('answers an empty basket with everyone in range', async () => {
    const body = await options({ countryCode: 'FR' });

    expect(codes(body.options)).toEqual([`${PREFIX}ANR`, `${PREFIX}MAD`]);
    expect(own(body.options)[0]?.lines).toEqual([]);
    expect(own(body.options)[0]?.canFulfilAll).toBe(true);
  });
});

describe('countries the operator has closed', () => {
  it('withholds a warehouse whose exclusion names the destination', async () => {
    await prisma.warehouseCountryExclusion.create({
      data: { id: newId(), locationId: antwerpId, countryCode: 'FR', reason: 'No agent.' },
    });

    try {
      const body = await options({
        countryCode: 'FR',
        items: [{ productId: sharedProductId, quantity: 5 }],
      });

      expect(codes(body.options)).toEqual([`${PREFIX}MAD`]);
      // Not in `partial` either: it is not short of stock, it is not on offer.
      expect(codes(body.partial)).toEqual([]);
      expect(body.closedByOperator).toBeGreaterThanOrEqual(1);
    } finally {
      await prisma.warehouseCountryExclusion.deleteMany({ where: { locationId: antwerpId } });
    }
  });

  /**
   * `closedByOperator` is a count and never a list.
   *
   * A buyer has no business reading an operator's internal reason for not
   * shipping somewhere, and a screen that said "we could serve you from
   * Antwerp but choose not to" would be worse than silence. The count exists
   * only so the storefront can tell "nobody is near enough" from "nobody
   * serves your country".
   */
  it('reports the withholding as a count with no reason attached', async () => {
    await prisma.warehouseCountryExclusion.create({
      data: { id: newId(), locationId: antwerpId, countryCode: 'FR', reason: 'Commercial.' },
    });

    try {
      const body = await options({ countryCode: 'FR' });

      expect(typeof body.closedByOperator).toBe('number');
      expect(JSON.stringify(body)).not.toContain('Commercial.');
    } finally {
      await prisma.warehouseCountryExclusion.deleteMany({ where: { locationId: antwerpId } });
    }
  });

  it('leaves the count at zero when nothing is closed for that country', async () => {
    await prisma.warehouseCountryExclusion.create({
      data: { id: newId(), locationId: antwerpId, countryCode: 'GB', reason: 'No agent.' },
    });

    try {
      // The exclusion names GB; the buyer is in France.
      const body = await options({ countryCode: 'FR' });

      expect(codes(body.options)).toContain(`${PREFIX}ANR`);
      expect(body.closedByOperator).toBe(0);
    } finally {
      await prisma.warehouseCountryExclusion.deleteMany({ where: { locationId: antwerpId } });
    }
  });
});

describe('warehouses that cannot ship', () => {
  /**
   * MAINTENANCE means no boxes are leaving the building.
   *
   * The fixture sits at Antwerp's own coordinates with the fastest lead time
   * and a free fee, so a query that had forgotten the status filter would put
   * it at the top of the list.
   */
  it('never offers a warehouse under maintenance', async () => {
    const body = await options({
      countryCode: 'FR',
      items: [{ productId: sharedProductId, quantity: 5 }],
    });

    expect(codes(body.options)).not.toContain(`${PREFIX}CLOSED`);
    expect(codes(body.partial)).not.toContain(`${PREFIX}CLOSED`);
  });

  it('offers a warehouse that is running limited, and says so', async () => {
    await prisma.inventoryLocation.update({
      where: { id: maintenanceId },
      data: { operationalStatus: 'LIMITED' },
    });

    try {
      const body = await options({
        countryCode: 'FR',
        items: [{ productId: sharedProductId, quantity: 5 }],
      });

      const limited = body.options.find((o) => o.warehouse.code === `${PREFIX}CLOSED`);

      expect(limited).toBeDefined();
      expect(limited?.warehouse.operationalStatus).toBe('LIMITED');
    } finally {
      await prisma.inventoryLocation.update({
        where: { id: maintenanceId },
        data: { operationalStatus: 'MAINTENANCE' },
      });
    }
  });

  it('never offers a retired warehouse', async () => {
    await prisma.inventoryLocation.update({
      where: { id: antwerpId },
      data: { isActive: false },
    });

    try {
      const body = await options({ countryCode: 'FR' });

      expect(codes(body.options)).not.toContain(`${PREFIX}ANR`);
    } finally {
      await prisma.inventoryLocation.update({
        where: { id: antwerpId },
        data: { isActive: true },
      });
    }
  });

  /**
   * A warehouse nobody has placed cannot be measured from, and is left out
   * silently: a buyer cannot fix a missing coordinate, and the admin panel
   * already names every unplaced warehouse on its own screen.
   */
  it('leaves out a warehouse with no coordinates', async () => {
    const unplacedId = newId();

    await prisma.inventoryLocation.create({
      data: {
        id: unplacedId,
        code: `${PREFIX}NOWHERE`,
        name: 'Delivery nowhere',
        isActive: true,
        isDefault: false,
        deliveryRadiusKm: 2000,
      },
    });

    try {
      const body = await options({ countryCode: 'FR' });

      expect(codes(body.options)).not.toContain(`${PREFIX}NOWHERE`);
      expect(codes(body.partial)).not.toContain(`${PREFIX}NOWHERE`);
    } finally {
      await prisma.inventoryLocation.delete({ where: { id: unplacedId } });
    }
  });
});

describe('the geofence', () => {
  it('does not offer a warehouse the destination is outside the radius of', async () => {
    // Iceland is thousands of kilometres from both fixtures.
    const body = await options({ countryCode: 'IS' });

    expect(codes(body.options)).toEqual([]);
    expect(codes(body.partial)).toEqual([]);
    expect(body.closedByOperator).toBe(0);
  });

  it('starts offering it once its own radius is big enough', async () => {
    const body = await options({ countryCode: 'MA' });
    // 800 km out of Madrid reaches Morocco; 500 out of Antwerp does not.
    expect(codes(body.options)).toEqual([`${PREFIX}MAD`]);
  });

  it('falls back to the deployment default for a warehouse with no radius', async () => {
    await prisma.inventoryLocation.update({
      where: { id: madridId },
      data: { deliveryRadiusKm: null },
    });

    try {
      const body = await options({ countryCode: 'FR' });
      const madrid = body.options.find((o) => o.warehouse.code === `${PREFIX}MAD`);

      // 500 km out of Villaverde still reaches France, so it is offered - and
      // the radius it reports is the deployment's rather than its own 800.
      expect(madrid?.radiusKm).not.toBe(800);
    } finally {
      await prisma.inventoryLocation.update({
        where: { id: madridId },
        data: { deliveryRadiusKm: 800 },
      });
    }
  });
});

describe('a warehouse that has published no terms', () => {
  /**
   * Nulls, not a made-up promise.
   *
   * "3-5 days, free" put on screen because the field was null would be a
   * delivery promise this software invented on the operator's behalf.
   */
  it('reports null terms rather than substituting any', async () => {
    await prisma.inventoryLocation.update({
      where: { id: madridId },
      data: {
        deliveryLeadTimeMinDays: null,
        deliveryLeadTimeMaxDays: null,
        deliveryFeeMinor: null,
        deliveryFeeCurrency: null,
      },
    });

    try {
      const body = await options({ countryCode: 'FR' });
      const madrid = body.options.find((o) => o.warehouse.code === `${PREFIX}MAD`);

      expect(madrid).toBeDefined();
      expect(madrid?.leadTimeDays).toBeNull();
      expect(madrid?.fee).toBeNull();
      // And it sorts behind every warehouse that has published a lead time:
      // silence is not speed.
      expect(own(body.options).at(-1)?.warehouse.code).toBe(`${PREFIX}MAD`);
    } finally {
      await prisma.inventoryLocation.update({
        where: { id: madridId },
        data: {
          deliveryLeadTimeMinDays: 3,
          deliveryLeadTimeMaxDays: 6,
          deliveryFeeMinor: 995n,
          deliveryFeeCurrency: 'EUR',
        },
      });
    }
  });
});

describe('the destination', () => {
  it('names the country as this deployment calls it', async () => {
    const body = await options({ countryCode: 'FR' });

    expect(body.destination.countryCode).toBe('FR');
    expect(body.destination.countryName).not.toBe('');
  });

  it('accepts a lower-case code', async () => {
    expect((await options({ countryCode: 'fr' })).destination.countryCode).toBe('FR');
  });

  it('refuses a code that is not an ISO one', async () => {
    const response = await post({ countryCode: 'XX' });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a code of the wrong shape', async () => {
    expect((await post({ countryCode: 'FRA' })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
  });

  /**
   * Nobody in range is a 200 and a real answer.
   *
   * An error there would make "we do not ship to Iceland yet" indistinguishable
   * from a request the endpoint could not understand, and the buyer would be
   * shown a fault instead of a fact.
   */
  it('answers 200 when nobody can deliver', async () => {
    expect((await post({ countryCode: 'IS' })).statusCode).toBe(200);
  });
});

describe('the endpoint is public', () => {
  /**
   * No session, and that is deliberate: a buyer asks "can you get this to
   * Belgium, and when" before they have an account, and an answer that waits
   * for a sign-in is an answer given too late.
   */
  it('answers an anonymous caller', async () => {
    const response = await post({ countryCode: 'FR' });

    expect(response.statusCode).toBe(200);
  });

  it('is never cached, because availability is the input that moves fastest', async () => {
    const response = await post({ countryCode: 'FR' });

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses a basket longer than the cap', async () => {
    const items = Array.from({ length: 101 }, () => ({
      productId: sharedProductId,
      quantity: 1,
    }));

    expect((await post({ countryCode: 'FR', items })).statusCode).toBe(400);
  });
});
