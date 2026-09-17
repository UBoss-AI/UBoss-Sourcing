/**
 * Seller warehouses on the operator's console - integration, over HTTP,
 * against a real MariaDB.
 *
 * The claims under test are all about **who may be seen and who may look**:
 *
 *   - Only a seller whose onboarding is APPROVED is offered. A draft, a
 *     submitted application, a refusal and a suspension are all absent from
 *     the picker — and, more importantly, absent from the warehouse endpoint
 *     too, so typing a suspended seller's id into the URL is not a way round
 *     the picker.
 *   - One seller's locations never appear under another seller's id. The
 *     ownership is a foreign key rather than a filter this file supplies, and
 *     the test is that the endpoint honours it.
 *   - A warehouse with no coordinates, or with coordinates that cannot be
 *     plotted, is still in the table. The map has to be able to skip it; the
 *     operator still has to be able to see that the building exists.
 *   - The two grants are both required. A stock-counting role without
 *     `customer.read` gets a 403 rather than a searchable index of every
 *     business on the marketplace.
 *
 * Over HTTP rather than through the service, because every one of those is a
 * claim about the endpoint: the permission guard, the query parsing and the
 * shape the panel actually receives are the things that can be wrong.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signInAdmin } from '../support/admin-session.js';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;

/** An Order Manager: holds inventory.read AND customer.read. */
let cookies: string;
/** An Inventory Manager: holds inventory.read and NOT customer.read. */
let stockOnlyCookies: string;

/** Everything this file creates is named from here, so cleanup can find it. */
const PREFIX = 'ASWT';

const EMAIL = 'seller-warehouses@test.local';
const PASSWORD = 'SellerWarehouses!2026';
const STOCK_EMAIL = 'seller-warehouses-stock@test.local';
const STOCK_PASSWORD = 'SellerWarehousesStock!2026';

interface SellerFixture {
  id: string;
  displayName: string;
  slug: string;
}

/** displayName suffix -> the seller, for the four states under test. */
const sellers = new Map<string, SellerFixture>();

/**
 * Products for the offers the stock roll-up needs.
 *
 * Three, not one. `seller_offers.productId` is a real foreign key - an offer
 * is a seller's price on a marketplace product, not a product of its own - and
 * `uq_seller_offer_product` allows one offer per seller per product, so three
 * offers need three products behind them.
 */
const productIds: string[] = [];
let categoryId = '';
let taxClassId = '';

interface Suggestion {
  sellerAccountId: string;
  displayName: string;
  legalName: string;
  sellerCode: string;
  registrationCountry: string;
  status: string;
  activeWarehouseCount: number;
}

interface SearchResponse {
  sellers: Suggestion[];
  isTruncated: boolean;
  minimumLength: number;
}

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  owner: {
    type: string;
    sellerAccountId: string | null;
    name: string;
    sellerCode: string | null;
  };
  addressLine1: string | null;
  city: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinatesInvalid: boolean;
  operationalStatus: string;
  closedReason: string | null;
  hasColdChain: boolean;
  stock: {
    skuCount: number;
    onHandQty: number;
    reservedQty: number;
    quarantinedQty: number;
    lowStockCount: number;
  };
  erpLastSyncAt: string | null;
}

interface WarehouseResponse {
  warehouses: WarehouseRow[];
  isTruncated: boolean;
  map: { provider: string };
  seller: Suggestion | null;
}

async function search(q: string, who = cookies): Promise<SearchResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/inventory/seller-search?q=${encodeURIComponent(q)}`,
    headers: { cookie: who },
  });

  expect(response.statusCode, response.body).toBe(200);
  return response.json<SearchResponse>();
}

async function warehousesFor(sellerAccountId?: string, extra = ''): Promise<WarehouseResponse> {
  const params = [
    ...(sellerAccountId === undefined ? [] : [`sellerAccountId=${sellerAccountId}`]),
    ...(extra === '' ? [] : [extra]),
  ].join('&');

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/inventory/seller-warehouses${params === '' ? '' : `?${params}`}`,
    headers: { cookie: cookies },
  });

  expect(response.statusCode, response.body).toBe(200);
  return response.json<WarehouseResponse>();
}

/** Only what this file created. The suite shares one database. */
function own(rows: WarehouseRow[]): WarehouseRow[] {
  return rows.filter((row) => row.code.startsWith(PREFIX));
}

async function makeSeller(
  suffix: string,
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED',
  options: { archived?: boolean } = {},
): Promise<SellerFixture> {
  const id = newId();
  const displayName = `${PREFIX} ${suffix}`;
  const normalised = `${PREFIX}${suffix}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  const slug = `${PREFIX.toLowerCase()}-${suffix.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${displayName} Medical BV`,
      displayName,
      displayNameNormalized: normalised,
      slug,
      kind: 'WHOLESALER',
      status,
      registrationCountry: 'NL',
      ...(status === 'APPROVED' ? { approvedAt: new Date() } : {}),
      ...(options.archived === true ? { archivedAt: new Date() } : {}),
    },
  });

  const fixture = { id, displayName, slug };
  sellers.set(suffix, fixture);
  return fixture;
}

async function makeLocation(
  seller: SellerFixture,
  code: string,
  overrides: {
    city?: string;
    countryCode?: string;
    latitude?: string | null;
    longitude?: string | null;
    isOperational?: boolean;
    hasColdChain?: boolean;
    archived?: boolean;
    closedReason?: string | null;
  } = {},
): Promise<string> {
  const id = newId();

  await prisma.sellerLocation.create({
    data: {
      id,
      sellerAccountId: seller.id,
      code,
      name: `${code} depot`,
      addressLine1: '1 Havenstraat',
      city: overrides.city ?? 'Rotterdam',
      postcode: '3011',
      countryCode: overrides.countryCode ?? 'NL',
      timezone: 'Europe/Amsterdam',
      latitude: overrides.latitude === undefined ? '51.9225000' : overrides.latitude,
      longitude: overrides.longitude === undefined ? '4.4791700' : overrides.longitude,
      isOperational: overrides.isOperational ?? true,
      hasColdChain: overrides.hasColdChain ?? false,
      ...(overrides.closedReason === undefined ? {} : { closedReason: overrides.closedReason }),
      ...(overrides.archived === true ? { archivedAt: new Date() } : {}),
    },
  });

  return id;
}

async function cleanUp(): Promise<void> {
  const sellerIds = (
    await prisma.sellerAccount.findMany({
      where: { displayName: { startsWith: PREFIX } },
      select: { id: true },
    })
  ).map((row) => row.id);

  /*
   * Children first, and every delete scoped to this file's own rows. The suite
   * shares one database and leftovers break the NEXT file rather than this
   * one - which is the most confusing failure there is.
   */
  await prisma.sellerInventory.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });

  await prisma.product.deleteMany({ where: { sku: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: PREFIX.toLowerCase() } } });
  await prisma.taxClass.deleteMany({ where: { code: { startsWith: PREFIX } } });

  for (const email of [EMAIL, STOCK_EMAIL]) {
    await prisma.userRole.deleteMany({ where: { user: { emailNormalized: email } } });
    await prisma.session.deleteMany({ where: { user: { emailNormalized: email } } });
    await prisma.user.deleteMany({ where: { emailNormalized: email } });
  }
}

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();

  const orderRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.ORDER_MANAGER },
    select: { id: true },
  });

  const inventoryRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.INVENTORY_MANAGER },
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
      roles: { create: { roleId: orderRole.id } },
    },
  });

  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: STOCK_EMAIL,
      emailNormalized: STOCK_EMAIL,
      passwordHash: await hashPassword(STOCK_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: inventoryRole.id } },
    },
  });

  // Distinct IPs, so neither account spends the other's login budget - or a
  // neighbouring file's.
  ({ cookies } = await signInAdmin(app, {
    email: EMAIL,
    password: PASSWORD,
    ip: '203.0.113.170',
  }));

  ({ cookies: stockOnlyCookies } = await signInAdmin(app, {
    email: STOCK_EMAIL,
    password: STOCK_PASSWORD,
    ip: '203.0.113.171',
  }));

  taxClassId = newId();
  await prisma.taxClass.create({
    data: { id: taxClassId, code: `${PREFIX}TAX`, name: 'Seller warehouse test', ratePercent: '21' },
  });

  categoryId = newId();
  await prisma.category.create({
    data: {
      id: categoryId,
      name: 'Seller warehouse test',
      slug: `${PREFIX.toLowerCase()}-category`,
      path: `${PREFIX.toLowerCase()}-category`,
      depth: 0,
      isActive: true,
    },
  });

  for (const n of [1, 2, 3]) {
    const id = newId();
    await prisma.product.create({
      data: {
        id,
        categoryId,
        taxClassId,
        name: `Seller warehouse test product ${String(n)}`,
        slug: `${PREFIX.toLowerCase()}-product-${String(n)}`,
        sku: `${PREFIX}-PROD-${String(n)}`,
        basePriceMinor: 1_000n,
        currency: 'EUR',
        status: 'ACTIVE',
        isStockTracked: true,
      },
    });
    productIds.push(id);
  }

  // One seller per eligibility state, so "approved only" is proved against
  // every state a real application can be in rather than against one.
  const approved = await makeSeller('Northwind', 'APPROVED');
  const alsoApproved = await makeSeller('Southgate', 'APPROVED');
  await makeSeller('Draftly', 'DRAFT');
  await makeSeller('Submitted', 'SUBMITTED');
  await makeSeller('Refused', 'REJECTED');
  await makeSeller('Stopped', 'SUSPENDED');
  await makeSeller('Archived', 'APPROVED', { archived: true });

  // Northwind: three usable places and three awkward ones.
  await makeLocation(approved, `${PREFIX}-NW-1`);
  await makeLocation(approved, `${PREFIX}-NW-2`, { city: 'Utrecht', hasColdChain: true });
  await makeLocation(approved, `${PREFIX}-NW-3`, { city: 'Leuven', countryCode: 'BE' });
  // Never geocoded. Not an error - it is a warehouse holding stock whose
  // address nobody has looked up.
  await makeLocation(approved, `${PREFIX}-NW-NOGEO`, { latitude: null, longitude: null });
  // Closed by the seller. Out of the default view, in when asked for.
  await makeLocation(approved, `${PREFIX}-NW-SHUT`, {
    isOperational: false,
    closedReason: 'Lease ended',
  });
  // Archived. Never comes back, whatever is asked for.
  await makeLocation(approved, `${PREFIX}-NW-GONE`, { archived: true });

  // Southgate: one place, at the same coordinates as one of Northwind's.
  await makeLocation(alsoApproved, `${PREFIX}-SG-1`);

  // Ineligible sellers with real locations, so "excluded" is proved against
  // sellers who genuinely have something to hide rather than against empties.
  for (const suffix of ['Draftly', 'Submitted', 'Refused', 'Stopped', 'Archived']) {
    const seller = sellers.get(suffix);
    if (seller !== undefined) await makeLocation(seller, `${PREFIX}-${suffix.toUpperCase()}-1`);
  }
});

afterAll(async () => {
  await cleanUp();
  await app.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('searching for a seller company', () => {
  it('offers an approved one, with its code, country and warehouse count', async () => {
    const result = await search('Northwind');
    const row = result.sellers.find((seller) => seller.displayName.includes('Northwind'));

    expect(row).toBeDefined();
    expect(row?.status).toBe('APPROVED');
    expect(row?.sellerCode).toBe(sellers.get('Northwind')?.slug);
    expect(row?.registrationCountry).toBe('NL');
    // Three open, one unplaced but open, one closed, one archived - so four
    // places this seller can dispatch from today.
    expect(row?.activeWarehouseCount).toBe(4);
  });

  it('matches the registered name as well as the public one', async () => {
    // `legalName` is "… Medical BV"; the display name is not.
    const result = await search('Medical BV');
    expect(result.sellers.length).toBeGreaterThan(0);
    expect(result.sellers.every((seller) => seller.status === 'APPROVED')).toBe(true);
  });

  it('matches the seller code', async () => {
    const slug = sellers.get('Southgate')?.slug ?? '';
    const result = await search(slug);
    expect(result.sellers.map((seller) => seller.sellerCode)).toContain(slug);
  });

  it.each([
    ['Draftly', 'a draft application'],
    ['Submitted', 'an application nobody has decided'],
    ['Refused', 'a refused application'],
    ['Stopped', 'a suspended seller'],
    ['Archived', 'an archived account'],
  ])('never offers %s (%s)', async (suffix) => {
    const result = await search(suffix);
    expect(result.sellers).toHaveLength(0);
  });

  it('runs no search below the minimum length', async () => {
    const result = await search('N');
    // Not an error, and not a spinner over a list that was never going to
    // help: one letter matches most of the marketplace.
    expect(result.sellers).toHaveLength(0);
    expect(result.minimumLength).toBe(2);
  });

  it('returns nothing for a name nobody has', async () => {
    const result = await search('Qzzx-no-such-company');
    expect(result.sellers).toHaveLength(0);
    expect(result.isTruncated).toBe(false);
  });

  it('is refused to staff who may count stock but not look a company up', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/inventory/seller-search?q=Northwind',
      headers: { cookie: stockOnlyCookies },
    });

    // An Inventory Manager holds `inventory.read` and not `customer.read`. A
    // searchable index of every business on the marketplace must not be
    // reachable through the back of a warehouse screen.
    expect(response.statusCode).toBe(403);
  });
});

describe("one seller's warehouses", () => {
  it('returns their places and names the owner on every row', async () => {
    const result = await warehousesFor(sellers.get('Northwind')?.id);
    const rows = own(result.warehouses);

    // Three placed, one unplaced. The closed and archived ones are out by
    // default.
    expect(rows).toHaveLength(4);
    expect(result.seller?.displayName).toContain('Northwind');

    for (const row of rows) {
      expect(row.owner.type).toBe('SELLER');
      expect(row.owner.sellerAccountId).toBe(sellers.get('Northwind')?.id);
      expect(row.owner.name).toContain('Northwind');
      expect(row.owner.sellerCode).toBe(sellers.get('Northwind')?.slug);
    }
  });

  it('never returns another seller under this seller id', async () => {
    const result = await warehousesFor(sellers.get('Southgate')?.id);
    const rows = own(result.warehouses);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe(`${PREFIX}-SG-1`);
    // The leak this endpoint most needs not to have. Ownership is a foreign
    // key, and the test is that the endpoint honours it rather than that the
    // fixture happens to be tidy.
    expect(rows.every((row) => row.owner.sellerAccountId === sellers.get('Southgate')?.id)).toBe(
      true,
    );
  });

  it.each([['Draftly'], ['Submitted'], ['Refused'], ['Stopped'], ['Archived']])(
    'returns nothing for %s, even when their id is typed into the URL',
    async (suffix) => {
      const result = await warehousesFor(sellers.get(suffix)?.id);

      // The picker hiding an ineligible seller is a convenience. THIS is the
      // control: the eligibility rule is intersected into the query, so an id
      // from anywhere answers the same way as an id that does not exist.
      expect(own(result.warehouses)).toHaveLength(0);
      expect(result.seller).toBeNull();
    },
  );

  it('answers an unknown id the same way as an ineligible one', async () => {
    const result = await warehousesFor(newId());
    expect(own(result.warehouses)).toHaveLength(0);
    expect(result.seller).toBeNull();
  });

  it('keeps a warehouse with no coordinates in the table', async () => {
    const result = await warehousesFor(sellers.get('Northwind')?.id);
    const unplaced = own(result.warehouses).find((row) => row.code === `${PREFIX}-NW-NOGEO`);

    expect(unplaced).toBeDefined();
    expect(unplaced?.latitude).toBeNull();
    expect(unplaced?.longitude).toBeNull();
    // Nothing was ever recorded, which is different from something unusable
    // having been recorded - and the map has to be able to tell them apart to
    // say the right thing about each.
    expect(unplaced?.coordinatesInvalid).toBe(false);
  });

  it('hands the map a null pair for a position that cannot be plotted', async () => {
    const seller = sellers.get('Northwind');
    const id = await makeLocation(seller as SellerFixture, `${PREFIX}-NW-BADGEO`);

    // Written under the API, as a row predating the constraints would be.
    await prisma.$executeRaw`UPDATE seller_locations SET latitude = 991.0000000, longitude = 4.4791700 WHERE id = ${id}`;

    const result = await warehousesFor(seller?.id);
    const broken = own(result.warehouses).find((row) => row.code === `${PREFIX}-NW-BADGEO`);

    expect(broken).toBeDefined();
    // Still listed, so the operator can see the building and put it right.
    // Null coordinates, so one bad row cannot take the map down with it.
    expect(broken?.coordinatesInvalid).toBe(true);
    expect(broken?.latitude).toBeNull();
    expect(broken?.longitude).toBeNull();

    await prisma.sellerLocation.delete({ where: { id } });
  });

  it('leaves out a place the seller has closed, until it is asked for', async () => {
    const seller = sellers.get('Northwind');

    const byDefault = own((await warehousesFor(seller?.id)).warehouses);
    expect(byDefault.map((row) => row.code)).not.toContain(`${PREFIX}-NW-SHUT`);

    const withClosed = own(
      (await warehousesFor(seller?.id, 'includeClosed=true')).warehouses,
    );
    const shut = withClosed.find((row) => row.code === `${PREFIX}-NW-SHUT`);

    expect(shut?.operationalStatus).toBe('SUSPENDED');
    // The seller's own words about why, which is what turns "closed" into
    // something an operator can act on.
    expect(shut?.closedReason).toBe('Lease ended');
  });

  it('never returns an archived place, whatever is asked for', async () => {
    const seller = sellers.get('Northwind');
    const withClosed = own((await warehousesFor(seller?.id, 'includeClosed=true')).warehouses);

    // A seller archives a location to take it out of the record. Putting it
    // back on an operator's map would undo that.
    expect(withClosed.map((row) => row.code)).not.toContain(`${PREFIX}-NW-GONE`);
  });

  it('narrows by country and by text, on the server', async () => {
    const seller = sellers.get('Northwind');

    const belgian = own((await warehousesFor(seller?.id, 'countryCode=BE')).warehouses);
    expect(belgian.map((row) => row.code)).toEqual([`${PREFIX}-NW-3`]);

    const utrecht = own((await warehousesFor(seller?.id, 'q=Utrecht')).warehouses);
    expect(utrecht.map((row) => row.code)).toEqual([`${PREFIX}-NW-2`]);
  });

  it('carries the map configuration in the same response', async () => {
    const result = await warehousesFor(sellers.get('Northwind')?.id);
    // One response fills the screen. A second request for the tile source is a
    // map that renders bare and then reflows.
    expect(result.map.provider).toBeDefined();
  });

  it('is refused to staff who may count stock but not look a company up', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/inventory/seller-warehouses?sellerAccountId=${sellers.get('Northwind')?.id ?? ''}`,
      headers: { cookie: stockOnlyCookies },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('every approved seller at once', () => {
  it('returns the approved sellers and nobody else', async () => {
    const rows = own((await warehousesFor()).warehouses);

    const owners = new Set(rows.map((row) => row.owner.name));
    expect([...owners].sort()).toEqual([`${PREFIX} Northwind`, `${PREFIX} Southgate`]);

    // Five ineligible sellers each own a real location. None of them is here.
    expect(rows).toHaveLength(5);
  });

  it('distinguishes the owners, so a combined list is readable', async () => {
    const rows = own((await warehousesFor()).warehouses);

    // The column that makes the combined view usable. Without an owner per
    // row, an operator has to guess whose warehouse each one is.
    for (const row of rows) {
      expect(row.owner.name.startsWith(PREFIX)).toBe(true);
      expect(row.owner.sellerCode).not.toBeNull();
    }
  });
});

describe('the stock roll-up', () => {
  it('is zero for a warehouse holding nothing, rather than absent', async () => {
    const rows = own((await warehousesFor(sellers.get('Southgate')?.id)).warehouses);

    // A warehouse with no stock is a fact, not missing data. Absent figures
    // would make the column render as a dash and read as "unknown".
    expect(rows[0]?.stock).toEqual({
      skuCount: 0,
      onHandQty: 0,
      reservedQty: 0,
      quarantinedQty: 0,
      lowStockCount: 0,
    });
  });

  it('counts what is actually held, and what is below its own threshold', async () => {
    const seller = sellers.get('Northwind') as SellerFixture;
    const location = await prisma.sellerLocation.findFirstOrThrow({
      where: { sellerAccountId: seller.id, code: `${PREFIX}-NW-1` },
      select: { id: true },
    });

    const offers = await Promise.all(
      [1, 2, 3].map(async (n) => {
        const id = newId();
        await prisma.sellerOffer.create({
          data: {
            id,
            sellerAccountId: seller.id,
            productId: productIds[n - 1] as string,
            sellerSku: `${PREFIX}-SKU-${String(n)}`,
            status: 'ACTIVE',
            priceMinor: 1000n,
            currency: 'EUR',
          },
        });
        return id;
      }),
    );

    await prisma.sellerInventory.createMany({
      data: [
        // Plenty, and a threshold it is nowhere near.
        {
          id: newId(),
          sellerAccountId: seller.id,
          offerId: offers[0] as string,
          locationId: location.id,
          availableQuantity: 100,
          reservedQuantity: 10,
          quarantinedQuantity: 4,
          reorderThreshold: 20,
        },
        // Below its own threshold. One low line.
        {
          id: newId(),
          sellerAccountId: seller.id,
          offerId: offers[1] as string,
          locationId: location.id,
          availableQuantity: 3,
          reservedQuantity: 0,
          quarantinedQuantity: 0,
          reorderThreshold: 10,
        },
        // Nothing left, and NO threshold set. Not counted as low: zero means
        // "no alert on this line", not "alert at zero".
        {
          id: newId(),
          sellerAccountId: seller.id,
          offerId: offers[2] as string,
          locationId: location.id,
          availableQuantity: 0,
          reservedQuantity: 0,
          quarantinedQuantity: 0,
          reorderThreshold: 0,
        },
      ],
    });

    const rows = own((await warehousesFor(seller.id)).warehouses);
    const first = rows.find((row) => row.code === `${PREFIX}-NW-1`);

    expect(first?.stock).toEqual({
      skuCount: 3,
      onHandQty: 103,
      reservedQty: 10,
      quarantinedQty: 4,
      lowStockCount: 1,
    });

    // And it belongs to THIS location only - a roll-up that leaked across
    // buildings would make every warehouse of a busy seller look identical.
    const second = rows.find((row) => row.code === `${PREFIX}-NW-2`);
    expect(second?.stock.skuCount).toBe(0);

    await prisma.sellerInventory.deleteMany({ where: { locationId: location.id } });
    await prisma.sellerOffer.deleteMany({ where: { id: { in: offers } } });
  });
});
