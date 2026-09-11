/**
 * Warehouses - integration, over HTTP, against a real MariaDB.
 *
 * The rules under test here are the ones that cannot be proved anywhere else:
 *
 *   - **Exactly one default, always active.** `defaultLocationId` in the
 *     inventory service resolves an unqualified receipt against
 *     `isDefault: true, isActive: true`. Two defaults and it chooses
 *     arbitrarily; none and it refuses to book stock at all. So promoting must
 *     clear the previous holder in the same breath, and demoting the only one
 *     must be refused rather than obeyed.
 *   - **Retiring never hides stock.** `isActive: false` takes a warehouse out
 *     of the pickers, which is exactly what makes it dangerous while stock is
 *     still sitting in it - the only place from which it could be adjusted
 *     back out stops being offered.
 *   - **Both coordinates or neither.** Enforced in the service *and* by a
 *     CHECK constraint, and it is the constraint that needs a real database to
 *     prove.
 *   - **The picker and the management list are different questions.** A
 *     retired warehouse must vanish from one and stay in the other.
 *
 * The stock roll-up is here rather than in a unit test for the same reason the
 * product filters are: the low-stock count compares a derived value against a
 * column on a joined table, in raw SQL, and it either translates to something
 * MariaDB accepts or it does not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signInAdmin } from '../support/admin-session.js';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { env } from '../../src/config/env.js';

let app: Awaited<ReturnType<typeof buildApp>>;
/** An Inventory Manager: holds inventory.location.write. */
let cookies: string;
let csrfToken: string;
/** An Order Manager: holds inventory.read and must be refused every write. */
let readerCookies: string;
let readerCsrf: string;

let categoryId: string;
let taxClassId: string;

/**
 * Whichever warehouse was the default before this file ran, if any.
 *
 * Captured so it can be handed back in `afterAll`. This file promotes its own
 * warehouses to prove that promotion works, and the suite shares one database
 * - leaving somebody else's fixture demoted would break a later file for
 * reasons it could never diagnose.
 *
 * Usually null, and that is the case worth knowing about: `inventory.test.ts`
 * empties `inventory_locations` in its own `afterAll`, so depending on the
 * order the suite runs in, this file can arrive at a database with no
 * warehouses at all. Hence the anchor below.
 */
let previousDefaultId: string | null = null;

/**
 * A warehouse that exists only to hold the default flag.
 *
 * Without it, `createWarehouse`'s rule that *the first warehouse is the
 * default whatever the form said* would make every warehouse this file creates
 * the default - and the default cannot be retired, which is the thing half the
 * tests below are trying to do. Naming the state a test needs, rather than
 * inheriting it from whatever ran first, is what stops this file passing alone
 * and failing in the suite.
 *
 * Its code deliberately does not start with `PREFIX`, so the per-test cleanup
 * leaves it alone.
 */
const ANCHOR_CODE = 'WHTA-ANCHOR';
let anchorId: string;

const EMAIL = 'warehouses@test.local';
const PASSWORD = 'Warehouses!2026';
const READER_EMAIL = 'warehouse-reader@test.local';
const READER_PASSWORD = 'WarehouseRead!2026';

/** Every code this file creates starts here, so cleanup can find them all. */
const PREFIX = 'WHT-';

interface Warehouse {
  id: string;
  code: string;
  name: string;
  address: Record<string, unknown> | null;
  countryCode: string | null;
  countryName: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinatesInvalid: boolean;
  operationalStatus: string;
  isDefault: boolean;
  isActive: boolean;
  erp: {
    status: string;
    lastSyncAt: string | null;
    message: string | null;
    externalId: string | null;
  };
  /** The geofence, the timing, the price and the closed countries. */
  delivery: {
    /** Never null: the server resolves the deployment fallback for every reader. */
    radiusKm: number;
    /** True when `radiusKm` came from the deployment rather than this warehouse. */
    radiusIsDefault: boolean;
    leadTimeDays: { min: number; max: number } | null;
    fee: { minor: string; formatted: string; currency: string } | null;
    excludedCountries: { code: string; name: string; flag: string; reason: string | null }[];
  };
  stock: {
    skuCount: number;
    onHandQty: number;
    reservedQty: number;
    lowStockCount: number;
    activeReservations: number;
  };
}

interface WarehouseListResponse {
  warehouses: Warehouse[];
  /**
   * Loosely typed on purpose. The service's own union is exhaustive; this file
   * only ever asserts against the `NONE` arm, because `tests/setup.ts` clears
   * every map setting so the suite cannot disagree with a developer's `.env`
   * about which provider is configured. The precedence between the three is
   * unit-tested in tests/unit/map-config.test.ts, where it can be tried four
   * ways without a process each.
   */
  map: { provider: string; tiles?: { urlTemplate: string; attribution: string } };
}

interface ErrorResponse {
  error: { code: string; message: string; details?: { field?: string; code?: string }[] };
}

async function listWarehouses(query = ''): Promise<WarehouseListResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/inventory/warehouses${query === '' ? '' : `?${query}`}`,
    headers: { cookie: cookies },
  });

  expect(response.statusCode, response.body).toBe(200);
  return response.json<WarehouseListResponse>();
}

/** Only the warehouses this file made, so other files' fixtures cannot answer. */
async function ownWarehouses(query = ''): Promise<Warehouse[]> {
  const { warehouses } = await listWarehouses(query);
  return warehouses.filter((warehouse) => warehouse.code.startsWith(PREFIX));
}

async function findOwn(code: string, query = ''): Promise<Warehouse | undefined> {
  return (await ownWarehouses(query)).find((warehouse) => warehouse.code === code);
}

interface CreateOptions {
  code: string;
  name?: string;
  countryCode?: string | null;
  timezone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  operationalStatus?: string;
  erpExternalId?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  address?: Record<string, unknown> | null;

  /** The geofence. Every one is nullable *and* optional - see the route schema. */
  deliveryRadiusKm?: number | null;
  deliveryLeadTimeMinDays?: number | null;
  deliveryLeadTimeMaxDays?: number | null;
  /** Minor units as a string, the way money crosses this API. */
  deliveryFeeMinor?: string | null;
  deliveryFeeCurrency?: string | null;
  excludedCountries?: { code: string; reason?: string | null }[];
}

/**
 * A country every one of these fixtures sits in unless it says otherwise.
 *
 * The country is required on create, so a helper that did not supply one would
 * make every test below a test of that rule. `BE` is in the reference data of
 * any database the seed has touched.
 */
const DEFAULT_COUNTRY = 'BE';

function create(
  options: CreateOptions,
  session: { cookies: string; csrfToken: string } = { cookies, csrfToken },
): Promise<ReturnType<typeof app.inject> extends Promise<infer T> ? T : never> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/inventory/warehouses',
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken },
    payload: {
      name: `Warehouse ${options.code}`,
      countryCode: DEFAULT_COUNTRY,
      ...options,
    },
  });
}

function patch(
  id: string,
  body: Record<string, unknown>,
  session: { cookies: string; csrfToken: string } = { cookies, csrfToken },
): Promise<ReturnType<typeof app.inject> extends Promise<infer T> ? T : never> {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/admin/inventory/warehouses/${id}`,
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken },
    payload: body,
  });
}

function remove(
  id: string,
  session: { cookies: string; csrfToken: string } = { cookies, csrfToken },
): Promise<ReturnType<typeof app.inject> extends Promise<infer T> ? T : never> {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/admin/inventory/warehouses/${id}`,
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken },
  });
}

/**
 * Report a sync outcome, the way a connector would.
 *
 * `Record<string, unknown>` rather than a typed body, because several tests
 * here deliberately send a status that is not one of the four.
 */
function erpStatus(
  id: string,
  body: Record<string, unknown>,
  session: { cookies: string; csrfToken: string } = { cookies, csrfToken },
): Promise<ReturnType<typeof app.inject> extends Promise<infer T> ? T : never> {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/admin/inventory/warehouses/${id}/erp-status`,
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken },
    payload: body,
  });
}

/** Create and assert it worked, for the cases where creation is the setup. */
async function created(options: CreateOptions): Promise<Warehouse> {
  const response = await create(options);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ warehouse: Warehouse }>().warehouse;
}

/** The same, for the many tests that only need the id to PATCH against. */
async function createdWarehouseId(options: CreateOptions): Promise<string> {
  return (await created(options)).id;
}

/**
 * A stock-tracked product with a balance at one warehouse.
 *
 * `reorderThreshold` is what makes the low-stock count meaningful: the service
 * counts a SKU as low when on-hand minus reserved falls to or below it, and
 * skips any product whose threshold is zero.
 */
async function trackedProduct(sku: string, threshold = 0): Promise<string> {
  const productId = newId();

  await prisma.product.create({
    data: {
      id: productId,
      categoryId,
      taxClassId,
      name: `Product ${sku}`,
      slug: `warehouse-test-${sku.toLowerCase()}`,
      sku,
      status: 'ACTIVE',
      basePriceMinor: 1000n,
      currency: 'INR',
      isStockTracked: true,
      reorderThreshold: threshold,
    },
  });

  return productId;
}

async function stockAt(
  locationId: string,
  options: { sku: string; onHand: number; reserved?: number; threshold?: number },
): Promise<void> {
  const productId = await trackedProduct(options.sku, options.threshold ?? 0);

  await prisma.inventoryBalance.create({
    data: {
      id: newId(),
      productId,
      variantKey: '',
      locationId,
      onHandQty: options.onHand,
      reservedQty: options.reserved ?? 0,
    },
  });
}

/**
 * One movement in the ledger, and nothing else.
 *
 * Written directly rather than through the receipt endpoint, so the warehouse
 * ends up in the state the delete guard exists for and no other: a movement
 * against it, no balance, no stock. Through the API the two always arrive
 * together, and a test that could not tell them apart would not prove that the
 * ledger alone is enough to hold the row in place.
 */
async function movementAt(locationId: string, sku: string): Promise<void> {
  await prisma.inventoryMovement.create({
    data: {
      id: newId(),
      productId: await trackedProduct(sku),
      variantKey: '',
      locationId,
      type: 'RECEIPT',
      quantityDelta: 7,
      resultingOnHand: 7,
      reason: 'Warehouse delete guard fixture',
    },
  });
}

/** Remove only what this file made. */
async function removeOwn(): Promise<void> {
  const own = await prisma.inventoryLocation.findMany({
    where: { code: { startsWith: PREFIX } },
    select: { id: true },
  });
  const locationIds = own.map((location) => location.id);

  const products = await prisma.product.findMany({
    where: { categoryId },
    select: { id: true },
  });
  const productIds = products.map((product) => product.id);

  if (locationIds.length > 0) {
    await prisma.stockReservation.deleteMany({ where: { locationId: { in: locationIds } } });
    await prisma.inventoryMovement.deleteMany({ where: { locationId: { in: locationIds } } });
    await prisma.inventoryBalance.deleteMany({ where: { locationId: { in: locationIds } } });
  }

  if (productIds.length > 0) {
    await prisma.inventoryBalance.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  }

  // The default cannot be deleted while it is the default in the eyes of the
  // rest of the system, but nothing stops the row going - so clear the flag
  // first and hand it back to whoever held it in afterAll.
  if (locationIds.length > 0) {
    await prisma.inventoryLocation.updateMany({
      where: { id: { in: locationIds } },
      data: { isDefault: false },
    });
    await prisma.inventoryLocation.deleteMany({ where: { id: { in: locationIds } } });
  }
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const existingDefault = await prisma.inventoryLocation.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  previousDefaultId = existingDefault?.id ?? null;

  // The anchor. Created directly rather than through the API, because at this
  // point the database may have no warehouses at all and the API would
  // (correctly) make the first one the default whatever was asked for.
  await prisma.inventoryLocation.deleteMany({ where: { code: ANCHOR_CODE } });
  anchorId = newId();
  await prisma.inventoryLocation.create({
    data: {
      id: anchorId,
      code: ANCHOR_CODE,
      name: 'Warehouse test anchor',
      // Only takes the flag if nothing else holds it, so a file that ran
      // before this one keeps its own default.
      isDefault: previousDefaultId === null,
      isActive: true,
    },
  });

  for (const email of [EMAIL, READER_EMAIL]) {
    await prisma.userRole.deleteMany({ where: { user: { emailNormalized: email } } });
    await prisma.user.deleteMany({ where: { emailNormalized: email } });
  }

  const inventoryRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.INVENTORY_MANAGER },
    select: { id: true },
  });

  const orderRole = await prisma.role.findUniqueOrThrow({
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
      roles: { create: { roleId: inventoryRole.id } },
    },
  });

  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: READER_EMAIL,
      emailNormalized: READER_EMAIL,
      passwordHash: await hashPassword(READER_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: orderRole.id } },
    },
  });

  // Distinct IPs, so neither account spends the other's login budget - or a
  // neighbouring test file's.
  ({ cookies, csrfToken } = await signInAdmin(app, {
    email: EMAIL,
    password: PASSWORD,
    ip: '203.0.113.140',
  }));

  ({ cookies: readerCookies, csrfToken: readerCsrf } = await signInAdmin(app, {
    email: READER_EMAIL,
    password: READER_PASSWORD,
    ip: '203.0.113.141',
  }));

  taxClassId = newId();
  await prisma.taxClass.create({
    data: { id: taxClassId, code: 'WHT', name: 'Warehouse test', ratePercent: '18' },
  });

  categoryId = newId();
  await prisma.category.create({
    data: {
      id: categoryId,
      name: 'Warehouse test',
      slug: 'warehouse-test',
      path: 'warehouse-test',
      depth: 0,
      isActive: true,
    },
  });
});

/**
 * Put the default back where this file expects to find it.
 *
 * Called after every cleanup, because a test that promotes one of this file's
 * warehouses demotes the anchor, and deleting that warehouse then leaves the
 * database with no default at all - which is the state that makes the next
 * test's `create` silently produce a default it cannot retire.
 */
async function restoreDefault(): Promise<void> {
  const holder = previousDefaultId ?? anchorId;

  await prisma.inventoryLocation.updateMany({
    where: { isDefault: true, id: { not: holder } },
    data: { isDefault: false },
  });
  await prisma.inventoryLocation.updateMany({
    where: { id: holder },
    data: { isDefault: true },
  });
}

afterAll(async () => {
  await removeOwn();
  await restoreDefault();

  // The anchor goes last, and only after the default is back with whoever
  // held it first. Where nobody did, the database is left with no warehouses,
  // which is exactly how this file found it.
  await prisma.inventoryLocation.updateMany({
    where: { id: anchorId },
    data: { isDefault: false },
  });
  await prisma.inventoryLocation.deleteMany({ where: { id: anchorId } });

  await prisma.category.deleteMany({ where: { id: categoryId } });
  await prisma.taxClass.deleteMany({ where: { id: taxClassId } });

  for (const email of [EMAIL, READER_EMAIL]) {
    await prisma.userRole.deleteMany({ where: { user: { emailNormalized: email } } });
    await prisma.user.deleteMany({ where: { emailNormalized: email } });
  }

  await app.close();
});

beforeEach(async () => {
  await removeOwn();
  // Every test starts with the default held by something it does not own, so
  // the warehouses it creates are retirable.
  await restoreDefault();
});

describe('creating a warehouse', () => {
  it('stores the code upper-cased and the coordinates to six places', async () => {
    const warehouse = await created({
      code: `${PREFIX}pune`.toLowerCase(),
      name: 'Pune North',
      latitude: 18.52043789,
      longitude: 73.85674321,
    });

    // MariaDB's default collation is case-insensitive, so a code stored in
    // mixed case would collide with itself on the unique index later.
    expect(warehouse.code).toBe(`${PREFIX}PUNE`);
    expect(warehouse.name).toBe('Pune North');
    expect(warehouse.latitude).toBe(18.520438);
    expect(warehouse.longitude).toBe(73.856743);
  });

  it('accepts a warehouse with no coordinates at all', async () => {
    const warehouse = await created({ code: `${PREFIX}UNPLACED` });

    // The unplaced state is ordinary, not an error: a warehouse nobody has
    // geocoded yet still holds stock.
    expect(warehouse.latitude).toBeNull();
    expect(warehouse.longitude).toBeNull();
    expect(warehouse.isActive).toBe(true);
  });

  it('keeps the postal address, and the country beside it rather than in it', async () => {
    const warehouse = await created({
      code: `${PREFIX}ADDR`,
      countryCode: 'ES',
      address: { line1: 'Carrer A, 41', city: 'Barcelona', postalCode: '08040' },
    });

    expect(warehouse.address).toMatchObject({ city: 'Barcelona', postalCode: '08040' });

    // The country is a field on the warehouse with a foreign key, not a key
    // inside the address JSON - which is what lets the console filter on it -
    // and the reference table's name travels with it for a label.
    expect(warehouse.countryCode).toBe('ES');
    expect(warehouse.countryName).toBe('Spain');
    expect(warehouse.address).not.toHaveProperty('countryCode');
  });

  it('refuses a code another warehouse already holds, and names the holder', async () => {
    await created({ code: `${PREFIX}DUP`, name: 'The first one' });

    const response = await create({ code: `${PREFIX}DUP`, name: 'The second one' });

    expect(response.statusCode).toBe(409);

    const body = response.json<ErrorResponse>();
    expect(body.error.code).toBe('LOCATION_CODE_EXISTS');
    // The whole value of the message is that it says which warehouse is in the
    // way - otherwise the reader is hunting for an invisible row.
    expect(body.error.message).toContain('The first one');
  });

  it('refuses a code held by a retired warehouse, and says it is retired', async () => {
    const retired = await created({ code: `${PREFIX}GONE`, name: 'Old depot' });
    expect((await patch(retired.id, { isActive: false })).statusCode).toBe(200);

    const response = await create({ code: `${PREFIX}GONE`, name: 'New depot' });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponse>().error.message).toContain('retired');
  });

  it('refuses half a coordinate pair', async () => {
    const response = await create({ code: `${PREFIX}HALF`, latitude: 18.5 });

    expect(response.statusCode).toBe(400);

    const body = response.json<ErrorResponse>();
    // A latitude with no longitude names a line around the planet, not a place.
    expect(body.error.details?.[0]?.field).toBe('longitude');
  });

  it('refuses a latitude outside the poles', async () => {
    const response = await create({ code: `${PREFIX}BAD`, latitude: 91, longitude: 0 });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('the default warehouse', () => {
  it('promotes one and demotes the previous holder in the same write', async () => {
    const first = await created({ code: `${PREFIX}D1`, isDefault: true });
    expect((await findOwn(first.code))?.isDefault).toBe(true);

    const second = await created({ code: `${PREFIX}D2` });
    expect((await patch(second.id, { isDefault: true })).statusCode).toBe(200);

    // Exactly one, across the whole table - not merely "the new one is set".
    const defaults = await prisma.inventoryLocation.count({ where: { isDefault: true } });
    expect(defaults).toBe(1);
    expect((await findOwn(second.code))?.isDefault).toBe(true);
    expect((await findOwn(first.code))?.isDefault).toBe(false);
  });

  it('refuses to demote the default without another being promoted', async () => {
    const only = await created({ code: `${PREFIX}ONLY`, isDefault: true });

    const response = await patch(only.id, { isDefault: false });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponse>().error.code).toBe('LOCATION_STILL_IN_USE');
    // Still the default: a refused request changes nothing.
    expect((await findOwn(only.code))?.isDefault).toBe(true);
  });

  it('refuses to retire the default', async () => {
    const current = await created({ code: `${PREFIX}DEF`, isDefault: true });

    const response = await patch(current.id, { isActive: false });

    expect(response.statusCode).toBe(409);
    // Naming the fix, because "you cannot" without "instead, do this" is where
    // a support ticket comes from.
    expect(response.json<ErrorResponse>().error.message).toContain('default');
    expect((await findOwn(current.code))?.isActive).toBe(true);
  });

  it('refuses to create a warehouse that is both the default and retired', async () => {
    // The country is supplied by the helper, so the only thing wrong with this
    // request is the combination under test.
    const response = await create({ code: `${PREFIX}IMP`, isDefault: true, isActive: false });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.details?.[0]?.code).toBe(
      'DEFAULT_MUST_BE_ACTIVE',
    );
  });
});

describe('retiring a warehouse', () => {
  it('refuses while stock is still sitting in it, and says how much', async () => {
    const warehouse = await created({ code: `${PREFIX}FULL` });
    await stockAt(warehouse.id, { sku: 'WHT-FULL-1', onHand: 42 });

    const response = await patch(warehouse.id, { isActive: false });

    expect(response.statusCode).toBe(409);

    const body = response.json<ErrorResponse>();
    expect(body.error.code).toBe('LOCATION_STILL_IN_USE');
    // The count is the whole answer to "so what do I do about it".
    expect(body.error.message).toContain('42');
  });

  it('allows it once the warehouse is empty', async () => {
    const warehouse = await created({ code: `${PREFIX}EMPTY` });

    expect((await patch(warehouse.id, { isActive: false })).statusCode).toBe(200);
    expect((await findOwn(warehouse.code))?.isActive).toBe(false);
  });

  it('takes it out of the stock pickers but leaves it on the management list', async () => {
    const warehouse = await created({ code: `${PREFIX}HIDDEN` });
    expect((await patch(warehouse.id, { isActive: false })).statusCode).toBe(200);

    // The picker answers "where may this stock go", so a retired warehouse has
    // to be gone from it.
    const picker = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/inventory/locations',
      headers: { cookie: cookies },
    });
    expect(picker.statusCode).toBe(200);
    const offered = picker.json<{ locations: { code: string }[] }>().locations;
    expect(offered.map((location) => location.code)).not.toContain(warehouse.code);

    // The management list answers "what warehouses exist", so it has to keep
    // it - it is the only screen from which it can be brought back.
    expect(await findOwn(warehouse.code)).toBeDefined();

    // And asking that list to hide them works, for the screens that want it.
    expect(await findOwn(warehouse.code, 'includeInactive=false')).toBeUndefined();
  });

  it('brings a retired warehouse back', async () => {
    const warehouse = await created({ code: `${PREFIX}BACK` });
    expect((await patch(warehouse.id, { isActive: false })).statusCode).toBe(200);
    expect((await patch(warehouse.id, { isActive: true })).statusCode).toBe(200);

    expect((await findOwn(warehouse.code))?.isActive).toBe(true);
  });
});

/**
 * Deleting a warehouse, which is a narrower act than retiring one.
 *
 * The two are not variations of each other and the tests here are mostly about
 * keeping them apart. Retiring archives a warehouse that has been used and
 * leaves every movement booked against it readable; deleting removes a row
 * nothing was ever booked against - the duplicate created with a typo in its
 * code, the site that was planned and never opened.
 *
 * Which of the two a warehouse is cannot be answered from the row itself, only
 * from what points at it, and four tables do: balances, movements,
 * reservations and the scheduled orders that pin a plan to one warehouse. Each
 * of them holds the row in place with `onDelete: Restrict`, so the guard is
 * not what makes deleting safe - the database is. The guard is what makes the
 * refusal explain itself instead of surfacing as a foreign-key error.
 */
describe('deleting a warehouse', () => {
  it('removes a warehouse nothing was ever booked against', async () => {
    const warehouse = await created({ code: `${PREFIX}GONE` });

    expect((await remove(warehouse.id)).statusCode).toBe(200);

    // Gone from the list that keeps retired warehouses too, which is the
    // difference between this and retiring: there is nothing left to bring
    // back.
    expect(await findOwn(warehouse.code)).toBeUndefined();
    expect(await prisma.inventoryLocation.findUnique({ where: { id: warehouse.id } })).toBeNull();
  });

  it('frees the code, unlike retiring, which holds it', async () => {
    const warehouse = await created({ code: `${PREFIX}REUSE` });
    expect((await remove(warehouse.id)).statusCode).toBe(200);

    // A retired warehouse still owns its code and creating a second with it is
    // refused, naming the holder. A deleted one owns nothing.
    const again = await create({ code: `${PREFIX}REUSE`, name: 'The replacement' });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('removes a retired warehouse that was never used', async () => {
    const warehouse = await created({ code: `${PREFIX}RETGONE` });
    expect((await patch(warehouse.id, { isActive: false })).statusCode).toBe(200);

    expect((await remove(warehouse.id)).statusCode).toBe(200);
    expect(await findOwn(warehouse.code)).toBeUndefined();
  });

  it('refuses one with a movement against it, and says to retire it instead', async () => {
    const warehouse = await created({ code: `${PREFIX}LEDGER` });
    await movementAt(warehouse.id, 'WHT-LEDGER-1');

    const response = await remove(warehouse.id);
    expect(response.statusCode).toBe(409);

    const body = response.json<ErrorResponse>();
    expect(body.error.code).toBe('LOCATION_HAS_HISTORY');
    // Named rather than implied. A movement whose warehouse cannot be named is
    // a hole in the record of where stock went, and the message has to say
    // that retiring is the way out.
    expect(body.error.message).toContain('Retire');

    // Still there, and still retirable - the refusal must not have been a
    // half-finished delete.
    expect(await findOwn(warehouse.code)).toBeDefined();
    expect((await patch(warehouse.id, { isActive: false })).statusCode).toBe(200);
  });

  it('refuses one that still holds stock, and names the units', async () => {
    const warehouse = await created({ code: `${PREFIX}HELD` });
    await stockAt(warehouse.id, { sku: 'WHT-HELD-1', onHand: 13 });

    const response = await remove(warehouse.id);
    expect(response.statusCode).toBe(409);

    const body = response.json<ErrorResponse>();
    expect(body.error.code).toBe('LOCATION_HAS_HISTORY');
    expect(body.error.message).toContain('13');
  });

  it('refuses one a reservation points at, finished or not', async () => {
    const warehouse = await created({ code: `${PREFIX}RESV` });

    // Released, not active. It is over, and its row still holds the warehouse
    // in place with a foreign key - which is why the guard counts every status
    // rather than the live ones the retire guard cares about.
    await prisma.stockReservation.create({
      data: {
        id: newId(),
        productId: await trackedProduct('WHT-RESV-1'),
        variantKey: '',
        locationId: warehouse.id,
        quantity: 2,
        status: 'RELEASED',
        expiresAt: new Date(Date.now() - 60_000),
        releasedAt: new Date(),
        releaseReason: 'Warehouse delete guard fixture',
      },
    });

    const response = await remove(warehouse.id);
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponse>().error.code).toBe('LOCATION_HAS_HISTORY');
  });

  it('refuses the default, which is also what stops the last one going', async () => {
    const warehouse = await created({ code: `${PREFIX}DEFGONE`, isDefault: true });

    const response = await remove(warehouse.id);
    expect(response.statusCode).toBe(409);

    const body = response.json<ErrorResponse>();
    expect(body.error.code).toBe('LOCATION_STILL_IN_USE');
    expect(body.error.details?.[0]?.code).toBe('IS_DEFAULT');

    // Hand the flag back before the next test, and prove the way out of the
    // refusal is the documented one: promote another, then delete this.
    await patch(anchorId, { isDefault: true });
    expect((await remove(warehouse.id)).statusCode).toBe(200);
  });

  it('answers 404 for a warehouse that does not exist, and for a second press', async () => {
    const warehouse = await created({ code: `${PREFIX}TWICE` });

    expect((await remove(warehouse.id)).statusCode).toBe(200);
    // The right answer to pressing the button again: the row is gone either
    // way, and nothing about the second press is a server error.
    expect((await remove(warehouse.id)).statusCode).toBe(404);
    expect((await remove(newId())).statusCode).toBe(404);
  });

  it('records the whole record, because the audit entry is all that is left', async () => {
    const warehouse = await created({
      code: `${PREFIX}TRACE`,
      name: 'Warehouse that was a typo',
      latitude: 18.52,
      longitude: 73.85,
    });

    expect((await remove(warehouse.id)).statusCode).toBe(200);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'inventory_location.deleted', resourceId: warehouse.id },
    });

    // The code and the name, not just an id: there is no row to look them up
    // in any more, and "which warehouse was that" is the first question asked.
    const before = JSON.stringify(entry.beforeJson);
    expect(before).toContain(`${PREFIX}TRACE`);
    expect(before).toContain('Warehouse that was a typo');
    expect(entry.actorEmail).toBe(EMAIL);
  });
});

describe('editing a warehouse', () => {
  it('renames without unplacing it', async () => {
    const warehouse = await created({
      code: `${PREFIX}MOVE`,
      latitude: 18.5204,
      longitude: 73.8567,
    });

    expect((await patch(warehouse.id, { name: 'Renamed only' })).statusCode).toBe(200);

    const after = await findOwn(warehouse.code);
    expect(after?.name).toBe('Renamed only');
    // Absent is not the same as null: a rename must not take the marker off
    // the map.
    expect(after?.latitude).toBe(18.5204);
    expect(after?.longitude).toBe(73.8567);
  });

  it('unplaces it when both coordinates are explicitly null', async () => {
    const warehouse = await created({
      code: `${PREFIX}UNSET`,
      latitude: 18.5204,
      longitude: 73.8567,
    });

    expect(
      (await patch(warehouse.id, { latitude: null, longitude: null })).statusCode,
    ).toBe(200);

    const after = await findOwn(warehouse.code);
    expect(after?.latitude).toBeNull();
    expect(after?.longitude).toBeNull();
  });

  it('answers 404 for a warehouse that does not exist', async () => {
    const response = await patch(newId(), { name: 'Nowhere' });

    expect(response.statusCode).toBe(404);
  });
});

describe('stock per warehouse', () => {
  it('rolls up units, SKUs and the low-stock count', async () => {
    const warehouse = await created({ code: `${PREFIX}ROLL` });

    // Two SKUs below their threshold, one comfortably above, and one with no
    // threshold at all - which is never counted as low however little is left.
    await stockAt(warehouse.id, { sku: 'WHT-ROLL-LOW1', onHand: 2, threshold: 5 });
    await stockAt(warehouse.id, { sku: 'WHT-ROLL-LOW2', onHand: 5, threshold: 5 });
    await stockAt(warehouse.id, { sku: 'WHT-ROLL-OK', onHand: 100, threshold: 5 });
    await stockAt(warehouse.id, { sku: 'WHT-ROLL-NONE', onHand: 1, threshold: 0 });

    const after = await findOwn(warehouse.code);

    expect(after?.stock.skuCount).toBe(4);
    expect(after?.stock.onHandQty).toBe(108);
    // At the threshold counts as low - "5 left, reorder at 5" is the moment to
    // act, not the moment after.
    expect(after?.stock.lowStockCount).toBe(2);
  });

  it('counts reserved units against availability, not against on hand', async () => {
    const warehouse = await created({ code: `${PREFIX}RES` });
    await stockAt(warehouse.id, { sku: 'WHT-RES-1', onHand: 10, reserved: 8, threshold: 5 });

    const after = await findOwn(warehouse.code);

    expect(after?.stock.onHandQty).toBe(10);
    expect(after?.stock.reservedQty).toBe(8);
    // Ten on hand looks healthy; two of them are actually sellable, which is
    // below the threshold and is what the operator needs told.
    expect(after?.stock.lowStockCount).toBe(1);
  });

  it('reports zeroes for a warehouse that has never held anything', async () => {
    const warehouse = await created({ code: `${PREFIX}NEW` });

    const after = await findOwn(warehouse.code);

    expect(after?.stock).toEqual({
      skuCount: 0,
      onHandQty: 0,
      reservedQty: 0,
      lowStockCount: 0,
      activeReservations: 0,
    });
  });
});

describe('the country', () => {
  it('is required when a warehouse is created', async () => {
    const response = await create({ code: `${PREFIX}NOCTRY`, countryCode: null });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.details?.[0]?.field).toBe('countryCode');
  });

  it('refuses a code that names no country this deployment carries', async () => {
    // Two letters, so the shape check passes and only the reference table can
    // catch it. This is the case a regex would have let through.
    const response = await create({ code: `${PREFIX}XX`, countryCode: 'XX' });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.details?.[0]?.code).toBe('UNKNOWN_COUNTRY');
  });

  it('accepts a lower-case code and stores it upper-cased', async () => {
    const warehouse = await created({ code: `${PREFIX}LOWER`, countryCode: 'gr' });

    expect(warehouse.countryCode).toBe('GR');
    expect(warehouse.countryName).toBe('Greece');
  });

  it('can be changed but not taken away', async () => {
    const warehouse = await created({ code: `${PREFIX}MOVED`, countryCode: 'BE' });

    expect((await patch(warehouse.id, { countryCode: 'PL' })).statusCode).toBe(200);
    expect((await findOwn(warehouse.code))?.countryCode).toBe('PL');

    const cleared = await patch(warehouse.id, { countryCode: null });
    expect(cleared.statusCode).toBe(400);
    expect((await findOwn(warehouse.code))?.countryCode).toBe('PL');
  });
});

describe('the time zone', () => {
  it('accepts an IANA name', async () => {
    const warehouse = await created({ code: `${PREFIX}TZ`, timezone: 'Europe/Athens' });

    expect(warehouse.timezone).toBe('Europe/Athens');
  });

  it('refuses a UTC offset, which is the thing people type instead', async () => {
    const response = await create({ code: `${PREFIX}TZBAD`, timezone: '+02:00' });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.details?.[0]?.field).toBe('timezone');
  });

  it('refuses a Windows zone name, which is the other one', async () => {
    const response = await create({
      code: `${PREFIX}TZWIN`,
      timezone: 'W. Europe Standard Time',
    });

    expect(response.statusCode).toBe(400);
  });

  it('treats an empty string as "not set" rather than as a value', async () => {
    const warehouse = await created({ code: `${PREFIX}TZNONE`, timezone: '' });

    expect(warehouse.timezone).toBeNull();
  });
});

describe('the operational status', () => {
  it('defaults to operational, because a recorded warehouse is one somebody means to use', async () => {
    const warehouse = await created({ code: `${PREFIX}OPDEF` });

    expect(warehouse.operationalStatus).toBe('OPERATIONAL');
  });

  it('is a separate axis from being active', async () => {
    const warehouse = await created({
      code: `${PREFIX}BOTH`,
      operationalStatus: 'MAINTENANCE',
    });

    // The whole point of the second field: this warehouse is thoroughly part
    // of the business and cannot ship a thing today.
    expect(warehouse.isActive).toBe(true);
    expect(warehouse.operationalStatus).toBe('MAINTENANCE');
  });

  it('survives a PATCH that does not mention it', async () => {
    const warehouse = await created({
      code: `${PREFIX}KEEP`,
      operationalStatus: 'SUSPENDED',
    });

    expect((await patch(warehouse.id, { name: 'Renamed' })).statusCode).toBe(200);
    expect((await findOwn(warehouse.code))?.operationalStatus).toBe('SUSPENDED');
  });

  it('rejects a status that is not one of the four', async () => {
    const response = await create({ code: `${PREFIX}OPBAD`, operationalStatus: 'ON_FIRE' });

    expect(response.statusCode).toBe(400);
  });
});

describe('search and filtering', () => {
  /**
   * The set every test in here narrows.
   *
   * Three countries and three statuses, so each filter has something to
   * exclude - a filter tested against one row passes whatever it does.
   */
  async function seedSet(): Promise<void> {
    await created({
      code: `${PREFIX}BE1`,
      name: 'Antwerp docks',
      countryCode: 'BE',
      operationalStatus: 'OPERATIONAL',
    });
    await created({
      code: `${PREFIX}ES1`,
      name: 'Barcelona south',
      countryCode: 'ES',
      operationalStatus: 'LIMITED',
    });
    await created({
      code: `${PREFIX}GR1`,
      name: 'Athens west',
      countryCode: 'GR',
      operationalStatus: 'MAINTENANCE',
    });
  }

  it('matches part of a name', async () => {
    await seedSet();

    const codes = (await ownWarehouses('q=barcel')).map((warehouse) => warehouse.code);
    expect(codes).toEqual([`${PREFIX}ES1`]);
  });

  it('matches part of a code', async () => {
    await seedSet();

    const codes = (await ownWarehouses(`q=${PREFIX}GR1`)).map((warehouse) => warehouse.code);
    expect(codes).toEqual([`${PREFIX}GR1`]);
  });

  it("matches the country's name, not only its code", async () => {
    await seedSet();

    // The reason the search is on the server: somebody hunting for the Greek
    // warehouse types "greece", and no row carries that string.
    const codes = (await ownWarehouses('q=greece')).map((warehouse) => warehouse.code);
    expect(codes).toEqual([`${PREFIX}GR1`]);
  });

  it('is case-insensitive', async () => {
    await seedSet();

    expect((await ownWarehouses('q=ANTWERP')).map((w) => w.code)).toEqual([`${PREFIX}BE1`]);
  });

  it('narrows by operational status', async () => {
    await seedSet();

    const codes = (await ownWarehouses('status=LIMITED')).map((warehouse) => warehouse.code);
    expect(codes).toEqual([`${PREFIX}ES1`]);
  });

  it('takes more than one status at a time', async () => {
    await seedSet();

    const codes = (await ownWarehouses('status=LIMITED&status=MAINTENANCE'))
      .map((warehouse) => warehouse.code)
      .sort();

    expect(codes).toEqual([`${PREFIX}ES1`, `${PREFIX}GR1`]);
  });

  it('narrows by country', async () => {
    await seedSet();

    const codes = (await ownWarehouses('countryCode=BE')).map((warehouse) => warehouse.code);
    expect(codes).toEqual([`${PREFIX}BE1`]);
  });

  it('combines a search with a filter', async () => {
    await seedSet();

    // The search alone would match the Belgian one too.
    expect(await ownWarehouses('q=a&countryCode=GR')).toHaveLength(1);
  });

  it('answers an empty list rather than an error when nothing matches', async () => {
    await seedSet();

    // A no-data state, not a failure: the panel has a message for this and it
    // is not the error message.
    const response = await listWarehouses('q=nothinglikethis');
    expect(response.warehouses).toEqual([]);
  });
});

describe('ERP synchronisation', () => {
  it('starts out never synced, which is the only honest thing to say', async () => {
    const warehouse = await created({ code: `${PREFIX}ERP1` });

    expect(warehouse.erp.status).toBe('NEVER_SYNCED');
    expect(warehouse.erp.lastSyncAt).toBeNull();
    expect(warehouse.erp.externalId).toBeNull();
  });

  it('keeps the ERP id a person entered', async () => {
    const warehouse = await created({ code: `${PREFIX}ERP2`, erpExternalId: 'WH-ANR-01' });

    expect(warehouse.erp.externalId).toBe('WH-ANR-01');
  });

  it('records a successful sync and stamps the time', async () => {
    const warehouse = await created({ code: `${PREFIX}ERP3` });

    const response = await erpStatus(warehouse.id, {
      status: 'SYNCED',
      message: '412 SKUs reconciled.',
    });

    expect(response.statusCode, response.body).toBe(200);

    const after = await findOwn(warehouse.code);
    expect(after?.erp.status).toBe('SYNCED');
    expect(after?.erp.message).toBe('412 SKUs reconciled.');
    expect(after?.erp.lastSyncAt).not.toBeNull();
  });

  it('takes the time the work actually happened, for a connector that batches', async () => {
    const warehouse = await created({ code: `${PREFIX}ERP4` });
    const when = '2026-09-01T08:30:00.000Z';

    expect((await erpStatus(warehouse.id, { status: 'SYNCED', syncedAt: when })).statusCode).toBe(
      200,
    );

    expect((await findOwn(warehouse.code))?.erp.lastSyncAt).toBe(when);
  });

  it('does not move the last-sync time on a PENDING', async () => {
    const warehouse = await created({ code: `${PREFIX}ERP5` });
    const when = '2026-09-01T08:30:00.000Z';

    await erpStatus(warehouse.id, { status: 'SYNCED', syncedAt: when });
    expect((await erpStatus(warehouse.id, { status: 'PENDING' })).statusCode).toBe(200);

    const after = await findOwn(warehouse.code);
    // An attempt in flight is not a completed sync. Stamping the time when a
    // job starts would make a warehouse failing for a week look fresh.
    expect(after?.erp.status).toBe('PENDING');
    expect(after?.erp.lastSyncAt).toBe(when);
  });

  it('carries the reason on a failure', async () => {
    const warehouse = await created({ code: `${PREFIX}ERP6` });

    await erpStatus(warehouse.id, {
      status: 'FAILED',
      message: 'ERP rejected 4 SKUs: unit of measure mismatch.',
    });

    const after = await findOwn(warehouse.code);
    expect(after?.erp.status).toBe('FAILED');
    expect(after?.erp.message).toContain('unit of measure');
  });

  it('clears a stale message when a status carries none', async () => {
    const warehouse = await created({ code: `${PREFIX}ERP7` });

    await erpStatus(warehouse.id, { status: 'FAILED', message: 'Everything is broken.' });
    await erpStatus(warehouse.id, { status: 'SYNCED' });

    // Last week's failure must not sit next to a green badge.
    expect((await findOwn(warehouse.code))?.erp.message).toBeNull();
  });

  it('cannot be set through the warehouse form', async () => {
    const warehouse = await created({ code: `${PREFIX}ERP8` });

    // Accepted and ignored: the field is not in the schema, so a client that
    // tries changes nothing rather than being told off. What matters is that
    // the sync state did not move.
    await patch(warehouse.id, { erpSyncStatus: 'SYNCED', erpLastSyncAt: new Date().toISOString() });

    expect((await findOwn(warehouse.code))?.erp.status).toBe('NEVER_SYNCED');
    expect((await findOwn(warehouse.code))?.erp.lastSyncAt).toBeNull();
  });

  it('refuses a status that is not one of the four', async () => {
    const warehouse = await created({ code: `${PREFIX}ERP9` });

    expect((await erpStatus(warehouse.id, { status: 'MAYBE' })).statusCode).toBe(400);
  });

  it('answers 404 for a warehouse that does not exist', async () => {
    expect((await erpStatus(newId(), { status: 'SYNCED' })).statusCode).toBe(404);
  });

  it('is refused to a reader', async () => {
    const warehouse = await created({ code: `${PREFIX}ERPRO` });

    const response = await erpStatus(
      warehouse.id,
      { status: 'SYNCED' },
      { cookies: readerCookies, csrfToken: readerCsrf },
    );

    expect(response.statusCode).toBe(403);
  });
});

describe('a warehouse with no position', () => {
  it('is an ordinary state, not a problem to report', async () => {
    const warehouse = await created({ code: `${PREFIX}NOPOS` });
    const after = await findOwn(warehouse.code);

    expect(after?.latitude).toBeNull();
    expect(after?.longitude).toBeNull();
    // Nothing was ever recorded. Coordinates that exist and *cannot* be
    // drawn are a different state with a different message, and that
    // classification is unit-tested in tests/unit/warehouse-coordinates.test.ts -
    // reaching it here would mean dropping a CHECK constraint out from under
    // every other file in the suite.
    expect(after?.coordinatesInvalid).toBe(false);
  });
});

describe('the map configuration', () => {
  it('reports no background when the operator has configured none', async () => {
    const { map } = await listWarehouses();

    // The default, and a working state: the panel plots markers on a plain
    // grid rather than sending anybody's warehouse coordinates to a tile host
    // or to Google.
    expect(map.provider).toBe('NONE');

    // And it arrives with nothing else on it. A `NONE` carrying a leftover
    // tile URL or an API key would be a setting the operator switched off and
    // this response published anyway.
    expect(Object.keys(map)).toEqual(['provider']);
  });
});

describe('geocoding an address', () => {
  it('answers 200 with no result when no geocoder is configured', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inventory/warehouses/geocode',
      headers: { cookie: cookies, 'x-csrf-token': csrfToken },
      payload: { query: 'Plot 14, MIDC, Pune' },
    });

    // Not an error. The caller is a convenience button beside two fields
    // somebody can always type, and a 502 here would put a red banner on a
    // screen that is working exactly as intended.
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ result: unknown }>().result).toBeNull();
  });

  it('rejects an empty query outright', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inventory/warehouses/geocode',
      headers: { cookie: cookies, 'x-csrf-token': csrfToken },
      payload: { query: '   ' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('permissions', () => {
  it('lets a reader see the warehouses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/inventory/warehouses',
      headers: { cookie: readerCookies },
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  it('refuses a reader the right to create one', async () => {
    const response = await create(
      { code: `${PREFIX}NOPE` },
      { cookies: readerCookies, csrfToken: readerCsrf },
    );

    expect(response.statusCode).toBe(403);
  });

  it('refuses a reader the right to edit one', async () => {
    const warehouse = await created({ code: `${PREFIX}LOCKED` });

    const response = await patch(
      warehouse.id,
      { name: 'Not allowed' },
      { cookies: readerCookies, csrfToken: readerCsrf },
    );

    expect(response.statusCode).toBe(403);
  });

  it('refuses a reader the right to delete one, and leaves it standing', async () => {
    const warehouse = await created({ code: `${PREFIX}KEEP` });

    const response = await remove(warehouse.id, {
      cookies: readerCookies,
      csrfToken: readerCsrf,
    });

    expect(response.statusCode).toBe(403);
    // The row, not just the status code. A delete refused at the door that
    // had already run would be the worst possible way to pass this test.
    expect(await findOwn(warehouse.code)).toBeDefined();
  });

  it('refuses a reader the geocoder', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inventory/warehouses/geocode',
      headers: { cookie: readerCookies, 'x-csrf-token': readerCsrf },
      payload: { query: 'Pune' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('the database holds the line', () => {
  /**
   * The CHECK constraints, tested through Prisma rather than the API.
   *
   * The service already refuses all three, so these can only be reached by a
   * manual SQL fix or a future import script - which is exactly what the
   * constraints are for, and the only way to prove they were actually created
   * is to try.
   */
  it('rejects an unpaired coordinate written directly', async () => {
    await expect(
      prisma.inventoryLocation.create({
        data: { id: newId(), code: `${PREFIX}RAW1`, name: 'Raw', latitude: '18.520400' },
      }),
    ).rejects.toThrow();
  });

  it('rejects an out-of-range latitude written directly', async () => {
    await expect(
      prisma.inventoryLocation.create({
        data: {
          id: newId(),
          code: `${PREFIX}RAW2`,
          name: 'Raw',
          latitude: '91.000000',
          longitude: '0.000000',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a lead-time window with only one end written directly', async () => {
    await expect(
      prisma.inventoryLocation.create({
        data: {
          id: newId(),
          code: `${PREFIX}RAW3`,
          name: 'Raw',
          deliveryLeadTimeMinDays: 2,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a delivery fee with no currency written directly', async () => {
    await expect(
      prisma.inventoryLocation.create({
        data: {
          id: newId(),
          code: `${PREFIX}RAW4`,
          name: 'Raw',
          deliveryFeeMinor: 1200n,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a zero delivery radius written directly', async () => {
    // Zero would silently mean "this warehouse delivers nowhere", which is
    // what retiring a warehouse is for. Nobody types it on purpose.
    await expect(
      prisma.inventoryLocation.create({
        data: {
          id: newId(),
          code: `${PREFIX}RAW5`,
          name: 'Raw',
          deliveryRadiusKm: 0,
        },
      }),
    ).rejects.toThrow();
  });

  /**
   * `chk_warehouse_exclusion_country_shape` rejects anything that is not two
   * letters.
   *
   * A digit or a symbol in a country code is a code that names nothing and
   * would sit in the table forever matching no country. A single letter is the
   * other real case - a truncated paste.
   */
  it('rejects an exclusion whose country code is not two letters', async () => {
    const id = await createdWarehouseId({ code: `${PREFIX}RAWEX` });

    for (const countryCode of ['D1', '99', 'D']) {
      await expect(
        prisma.warehouseCountryExclusion.create({
          data: { id: newId(), locationId: id, countryCode },
        }),
      ).rejects.toThrow();
    }
  });

  /**
   * Two things the constraint does **not** catch, and neither is a problem.
   * Asserted rather than left unsaid, because "the CHECK does not stop this"
   * is exactly the sort of thing somebody discovers by writing the opposite
   * test and finding it fail.
   *
   * **An alpha-3 code is truncated, not rejected.** The column is CHAR(2), and
   * MariaDB shortens an over-long value before any CHECK runs - so "DEU"
   * arrives as "DE", which is Germany, which is what the writer meant. A
   * constraint cannot improve on that.
   *
   * **Lower case passes.** The CHECK reads `REGEXP '^[A-Z]{2}$'` and this
   * column's collation is case-insensitive, so `[A-Z]` matches `de` as readily
   * as `DE`. Making it case-sensitive would need a BINARY comparison and would
   * earn nothing: `de` and `DE` are the *same value* to this column, so the
   * unique index still blocks a duplicate and every query that matches on the
   * code - the storefront's own `exclusions: { none: { countryCode } }` above
   * all - finds it either way. The API upper-cases on the way in, so nothing
   * this product writes reaches the column in lower case at all.
   */
  it('truncates an alpha-3 code and treats lower case as equivalent', async () => {
    const id = await createdWarehouseId({ code: `${PREFIX}RAWLC` });

    await prisma.warehouseCountryExclusion.create({
      data: { id: newId(), locationId: id, countryCode: 'de' },
    });

    // Found by an upper-case lookup, which is the only thing that matters.
    expect(
      await prisma.warehouseCountryExclusion.count({
        where: { locationId: id, countryCode: 'DE' },
      }),
    ).toBe(1);
  });
});

/**
 * The geofence: how far a warehouse delivers, and where it refuses to go.
 *
 * The rules under test are all about the same distinction - what geometry can
 * *reach* against what the business will *serve* - plus the one shape money
 * takes in this system and never any other.
 */
describe('delivery settings', () => {
  it('starts on the deployment default, with nothing of its own', async () => {
    await create({ code: `${PREFIX}GF1` });
    const warehouse = await findOwn(`${PREFIX}GF1`);

    expect(warehouse?.delivery.radiusIsDefault).toBe(true);
    expect(warehouse?.delivery.radiusKm).toBe(env.DELIVERY_COVERAGE_RADIUS_KM);
    expect(warehouse?.delivery.leadTimeDays).toBeNull();
    expect(warehouse?.delivery.fee).toBeNull();
    expect(warehouse?.delivery.excludedCountries).toEqual([]);
  });

  it('takes a radius, a lead time, a fee and closed countries on create', async () => {
    const response = await create({
      code: `${PREFIX}GF2`,
      deliveryRadiusKm: 750,
      deliveryLeadTimeMinDays: 2,
      deliveryLeadTimeMaxDays: 5,
      deliveryFeeMinor: '1250',
      deliveryFeeCurrency: 'EUR',
      excludedCountries: [{ code: 'gb', reason: 'No customs broker.' }],
    });

    expect(response.statusCode, response.body).toBe(201);

    const warehouse = await findOwn(`${PREFIX}GF2`);

    expect(warehouse?.delivery.radiusKm).toBe(750);
    expect(warehouse?.delivery.radiusIsDefault).toBe(false);
    expect(warehouse?.delivery.leadTimeDays).toEqual({ min: 2, max: 5 });
    // Money crosses this API as minor units in a string, always.
    expect(warehouse?.delivery.fee?.minor).toBe('1250');
    expect(warehouse?.delivery.fee?.currency).toBe('EUR');
    // Upper-cased on the way in, and named from the reference table or ISO.
    expect(warehouse?.delivery.excludedCountries).toHaveLength(1);
    expect(warehouse?.delivery.excludedCountries[0]?.code).toBe('GB');
    expect(warehouse?.delivery.excludedCountries[0]?.reason).toBe('No customs broker.');
    expect(warehouse?.delivery.excludedCountries[0]?.name).not.toBe('');
  });

  /**
   * Absent leaves it alone; explicit null clears it.
   *
   * Without the distinction, a PATCH that renamed a building would silently
   * change what it promises - the same rule the coordinates have carried since
   * they were added.
   */
  it('leaves the radius alone when a PATCH does not mention it', async () => {
    const id = await createdWarehouseId({ code: `${PREFIX}GF3`, deliveryRadiusKm: 600 });

    expect((await patch(id, { name: 'Renamed' })).statusCode).toBe(200);
    expect((await findOwn(`${PREFIX}GF3`))?.delivery.radiusKm).toBe(600);
  });

  it('puts a warehouse back on the deployment default when the radius is cleared', async () => {
    const id = await createdWarehouseId({ code: `${PREFIX}GF4`, deliveryRadiusKm: 600 });

    expect((await patch(id, { deliveryRadiusKm: null })).statusCode).toBe(200);

    const warehouse = await findOwn(`${PREFIX}GF4`);
    expect(warehouse?.delivery.radiusIsDefault).toBe(true);
    expect(warehouse?.delivery.radiusKm).toBe(env.DELIVERY_COVERAGE_RADIUS_KM);
  });

  /**
   * A PATCH that moves one end of the window is checked against the other end
   * *as stored*, not against nothing.
   *
   * Otherwise raising the maximum on a warehouse that already has a minimum
   * would fire "give both or neither" on a request that is perfectly complete.
   */
  it('checks one end of the lead-time window against the stored other end', async () => {
    const id = await createdWarehouseId({
      code: `${PREFIX}GF5`,
      deliveryLeadTimeMinDays: 2,
      deliveryLeadTimeMaxDays: 5,
    });

    expect((await patch(id, { deliveryLeadTimeMaxDays: 9 })).statusCode).toBe(200);
    expect((await findOwn(`${PREFIX}GF5`))?.delivery.leadTimeDays).toEqual({ min: 2, max: 9 });
  });

  it('refuses half a lead-time window', async () => {
    const response = await create({ code: `${PREFIX}GF6`, deliveryLeadTimeMinDays: 2 });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a lead time whose fastest end is slower than its slowest', async () => {
    const response = await create({
      code: `${PREFIX}GF7`,
      deliveryLeadTimeMinDays: 9,
      deliveryLeadTimeMaxDays: 2,
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a fee with no currency, and a currency with no fee', async () => {
    expect((await create({ code: `${PREFIX}GF8`, deliveryFeeMinor: '1200' })).statusCode).toBe(400);
    expect((await create({ code: `${PREFIX}GF9`, deliveryFeeCurrency: 'EUR' })).statusCode).toBe(
      400,
    );
  });

  it('accepts a fee of zero, which means free', async () => {
    const response = await create({
      code: `${PREFIX}GFA`,
      deliveryFeeMinor: '0',
      deliveryFeeCurrency: 'EUR',
    });

    expect(response.statusCode, response.body).toBe(201);
    expect((await findOwn(`${PREFIX}GFA`))?.delivery.fee?.minor).toBe('0');
  });

  it('refuses a currency the money module does not know', async () => {
    const response = await create({
      code: `${PREFIX}GFB`,
      deliveryFeeMinor: '1200',
      deliveryFeeCurrency: 'ZZZ',
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a radius past the commercial ceiling', async () => {
    expect((await create({ code: `${PREFIX}GFC`, deliveryRadiusKm: 50_000 })).statusCode).toBe(400);
  });

  /**
   * The exclusion list is the whole set, not a delta.
   *
   * A form that shows the operator every closed country and sends back what is
   * left after they untick one is the only shape that cannot drift out of step
   * with what they are looking at.
   */
  it('replaces the whole closed-country set on a PATCH', async () => {
    const id = await createdWarehouseId({
      code: `${PREFIX}GFD`,
      excludedCountries: [{ code: 'GB' }, { code: 'MA' }],
    });

    expect((await patch(id, { excludedCountries: [{ code: 'MA', reason: 'Still shut.' }] })).statusCode).toBe(
      200,
    );

    const warehouse = await findOwn(`${PREFIX}GFD`);
    expect(warehouse?.delivery.excludedCountries.map((entry) => entry.code)).toEqual(['MA']);
    expect(warehouse?.delivery.excludedCountries[0]?.reason).toBe('Still shut.');
  });

  it('clears every closed country when an empty list is sent', async () => {
    const id = await createdWarehouseId({ code: `${PREFIX}GFE`, excludedCountries: [{ code: 'GB' }] });

    expect((await patch(id, { excludedCountries: [] })).statusCode).toBe(200);
    expect((await findOwn(`${PREFIX}GFE`))?.delivery.excludedCountries).toEqual([]);
  });

  it('leaves the closed countries alone when a PATCH does not mention them', async () => {
    const id = await createdWarehouseId({ code: `${PREFIX}GFF`, excludedCountries: [{ code: 'GB' }] });

    expect((await patch(id, { name: 'Renamed again' })).statusCode).toBe(200);
    expect(
      (await findOwn(`${PREFIX}GFF`))?.delivery.excludedCountries.map((entry) => entry.code),
    ).toEqual(['GB']);
  });

  /**
   * The codes are checked against ISO 3166-1, not against the `countries`
   * reference table.
   *
   * That table is the list of markets this deployment *prices in* - a few
   * dozen rows - and a 500 km circle reaches countries nobody has ever sold
   * into, which are exactly the ones an operator most wants to close. So a
   * real country that is not in the reference table has to be closable.
   */
  it('accepts a real country the reference table does not carry', async () => {
    const outsideTheTable = await prisma.country.findUnique({ where: { code: 'MC' } });
    if (outsideTheTable !== null) {
      // This deployment does carry Monaco, so it proves nothing here. Any
      // ISO code is accepted either way, which the next test covers.
      expect(outsideTheTable.code).toBe('MC');
      return;
    }

    const response = await create({
      code: `${PREFIX}GFG`,
      excludedCountries: [{ code: 'MC' }],
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(
      (await findOwn(`${PREFIX}GFG`))?.delivery.excludedCountries.map((entry) => entry.code),
    ).toEqual(['MC']);
  });

  it('refuses a country code that names nothing', async () => {
    const response = await create({
      code: `${PREFIX}GFH`,
      excludedCountries: [{ code: 'XX' }],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe('VALIDATION_FAILED');
  });

  it('folds a duplicated country rather than failing on the unique index', async () => {
    const response = await create({
      code: `${PREFIX}GFI`,
      excludedCountries: [{ code: 'GB' }, { code: 'GB', reason: 'The later one wins.' }],
    });

    expect(response.statusCode, response.body).toBe(201);

    const excluded = (await findOwn(`${PREFIX}GFI`))?.delivery.excludedCountries;
    expect(excluded).toHaveLength(1);
    expect(excluded?.[0]?.reason).toBe('The later one wins.');
  });

  it("removes a warehouse's closed countries with it", async () => {
    const id = await createdWarehouseId({ code: `${PREFIX}GFJ`, excludedCountries: [{ code: 'GB' }] });

    expect((await remove(id)).statusCode).toBe(200);
    expect(
      await prisma.warehouseCountryExclusion.count({ where: { locationId: id } }),
    ).toBe(0);
  });
});
