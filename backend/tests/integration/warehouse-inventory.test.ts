/**
 * What one warehouse holds - integration, over HTTP, against a real MariaDB.
 *
 * One rule is the whole reason this endpoint exists and it is the thing this
 * file is here to prove: **the list is the catalogue, not the balance rows.**
 * `GET /inventory?locationId=` pages over `inventory_balances`, so a product a
 * warehouse has none of has no row and is simply absent - and absent is
 * indistinguishable from "not in the catalogue". The product a warehouse
 * manager opens this screen to find is usually the one that ran out, so it has
 * to be *in* the answer, at zero.
 *
 * The other assertions here all need a database:
 *
 *   - **`hasBalanceRow` is not `onHandQty === 0`.** No row means stock has
 *     never been booked here; a zero row means it has and has run out. Two
 *     different conversations with a buyer, and the difference is provenance
 *     rather than quantity.
 *   - **The footer is the warehouse, not the filtered list.** A total that
 *     moved when somebody typed in the search box would be read as the
 *     warehouse's and be wrong.
 *   - **`lowStockSkus` is a cross-table comparison in raw SQL** - a balance's
 *     available quantity against its product's threshold - which either
 *     translates to something MariaDB accepts or it does not.
 *   - **Grouping is by product, paging is by product.** A page boundary that
 *     fell inside one product's variants would split a card in half.
 *
 * Cleanup is in `afterAll` and removes every row this file made. Balances are
 * ON DELETE RESTRICT from `inventory_locations`, so a leftover fixture breaks
 * whichever file the suite runs next.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signInAdmin } from '../support/admin-session.js';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let cookies: string;

const EMAIL = 'warehouse-inventory@test.local';
const PASSWORD = 'WhInventory!2026';

/** Every code and SKU this file creates starts here, so cleanup finds them. */
const PREFIX = 'WHI-';

interface Sku {
  variantId: string | null;
  variantName: string | null;
  sku: string;
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
  hasBalanceRow: boolean;
  isLowStock: boolean;
  updatedAt: string | null;
}

interface Product {
  productId: string;
  name: string;
  sku: string;
  categoryId: string;
  categoryName: string;
  isStockTracked: boolean;
  isPublished: boolean;
  reorderThreshold: number;
  unitPrice: { minor: string; formatted: string; currency: string };
  valuation: { minor: string; formatted: string; currency: string };
  imageUrl: string | null;
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
  lowStockSkus: number;
  unstockedSkus: number;
  skus: Sku[];
}

interface InventoryResponse {
  warehouse: { id: string; code: string; name: string; isActive: boolean };
  products: Product[];
  totals: {
    products: number;
    skus: number;
    onHandQty: number;
    reservedQty: number;
    availableQty: number;
    lowStockSkus: number;
    unstockedSkus: number;
  };
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

let categoryId: string;
let taxClassId: string;
let warehouseId: string;
let otherWarehouseId: string;

/** The SKUs this file creates, by their role in the tests. */
const STOCKED = `${PREFIX}STOCKED`;
const EMPTIED = `${PREFIX}EMPTIED`;
const NEVER = `${PREFIX}NEVER`;
const LOW = `${PREFIX}LOW`;
const UNTRACKED = `${PREFIX}UNTRACKED`;
const VARIED = `${PREFIX}VARIED`;

async function product(options: {
  sku: string;
  threshold?: number;
  isStockTracked?: boolean;
  isPublished?: boolean;
}): Promise<string> {
  const id = newId();

  await prisma.product.create({
    data: {
      id,
      categoryId,
      taxClassId,
      name: `Product ${options.sku}`,
      slug: `warehouse-inventory-${options.sku.toLowerCase()}`,
      sku: options.sku,
      status: 'ACTIVE',
      isPublished: options.isPublished ?? true,
      basePriceMinor: 2500n,
      currency: 'INR',
      isStockTracked: options.isStockTracked ?? true,
      reorderThreshold: options.threshold ?? 0,
    },
  });

  return id;
}

async function balance(options: {
  locationId: string;
  productId: string;
  variantId?: string | null;
  onHand: number;
  reserved?: number;
}): Promise<void> {
  await prisma.inventoryBalance.create({
    data: {
      id: newId(),
      productId: options.productId,
      variantId: options.variantId ?? null,
      // '' for the base product, the variant's ULID otherwise - the same
      // convention the unique index uses.
      variantKey: options.variantId ?? '',
      locationId: options.locationId,
      onHandQty: options.onHand,
      reservedQty: options.reserved ?? 0,
    },
  });
}

async function inventory(id = warehouseId, query = ''): Promise<InventoryResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/inventory/warehouses/${id}/inventory${query === '' ? '' : `?${query}`}`,
    headers: { cookie: cookies },
  });

  expect(response.statusCode, response.body).toBe(200);
  return response.json<InventoryResponse>();
}

/** Only the products this file made: the catalogue is shared with the suite. */
function own(body: InventoryResponse): Product[] {
  return body.products.filter((entry) => entry.sku.startsWith(PREFIX));
}

function find(body: InventoryResponse, sku: string): Product | undefined {
  return body.products.find((entry) => entry.sku === sku);
}

async function cleanUp(): Promise<void> {
  await prisma.inventoryBalance.deleteMany({
    where: { product: { sku: { startsWith: PREFIX } } },
  });
  await prisma.productVariant.deleteMany({
    where: { product: { sku: { startsWith: PREFIX } } },
  });
  await prisma.product.deleteMany({ where: { sku: { startsWith: PREFIX } } });
  await prisma.inventoryLocation.deleteMany({ where: { code: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: 'warehouse-inventory-test' } });
  await prisma.taxClass.deleteMany({ where: { code: `${PREFIX}TAX` } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await cleanUp();

  taxClassId = newId();
  await prisma.taxClass.create({
    data: {
      id: taxClassId,
      code: `${PREFIX}TAX`,
      name: 'Warehouse inventory test',
      ratePercent: '18',
    },
  });

  categoryId = newId();
  await prisma.category.create({
    data: {
      id: categoryId,
      name: 'Warehouse inventory test',
      slug: 'warehouse-inventory-test',
      path: 'warehouse-inventory-test',
      depth: 0,
      isActive: true,
    },
  });

  // Written directly rather than created through the API: `createWarehouse`
  // makes the first warehouse in an empty database the default whatever the
  // form said, and this file has no business changing which warehouse a
  // deployment receives unqualified stock into.
  warehouseId = newId();
  await prisma.inventoryLocation.create({
    data: { id: warehouseId, code: `${PREFIX}MAIN`, name: 'Inventory test main', isActive: true },
  });

  otherWarehouseId = newId();
  await prisma.inventoryLocation.create({
    data: {
      id: otherWarehouseId,
      code: `${PREFIX}OTHER`,
      name: 'Inventory test other',
      isActive: true,
    },
  });

  const stocked = await product({ sku: STOCKED });
  const emptied = await product({ sku: EMPTIED });
  await product({ sku: NEVER });
  const low = await product({ sku: LOW, threshold: 10 });
  await product({ sku: UNTRACKED, isStockTracked: false, isPublished: false });
  const varied = await product({ sku: VARIED });

  await balance({ locationId: warehouseId, productId: stocked, onHand: 120, reserved: 20 });
  // Booked here and run out: a row that says zero. Different provenance from
  // NEVER, which has no row at all - see the module header.
  await balance({ locationId: warehouseId, productId: emptied, onHand: 0 });
  await balance({ locationId: warehouseId, productId: low, onHand: 8 });

  // Two variants, one stocked here and one not, so the group can be checked
  // for both a total and a per-SKU absence.
  const first = newId();
  const second = newId();

  await prisma.productVariant.createMany({
    data: [
      {
        id: first,
        productId: varied,
        sku: `${VARIED}-A`,
        name: 'Option A',
        optionsJson: { Size: 'A' },
        sortOrder: 0,
      },
      {
        id: second,
        productId: varied,
        sku: `${VARIED}-B`,
        name: 'Option B',
        optionsJson: { Size: 'B' },
        sortOrder: 1,
      },
    ],
  });

  await balance({ locationId: warehouseId, productId: varied, variantId: first, onHand: 40 });

  // At the *other* warehouse, so a balance somewhere else cannot be mistaken
  // for one here.
  await balance({ locationId: otherWarehouseId, productId: stocked, onHand: 999 });

  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });

  // An Order Manager: holds inventory.read and nothing that writes stock,
  // which is exactly the permission this endpoint asks for.
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
    ip: '203.0.113.171',
  }));
});

afterAll(async () => {
  await cleanUp();
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
  await app.close();
});

describe('every product in the catalogue is listed', () => {
  /**
   * The assertion the endpoint exists for.
   *
   * `GET /inventory?locationId=` cannot answer this: it pages over balance
   * rows, and a product with none here has no row to page over.
   */
  it('includes a product that has never been stocked at this warehouse', async () => {
    const never = find(await inventory(warehouseId, 'limit=100'), NEVER);

    expect(never).toBeDefined();
    expect(never?.onHandQty).toBe(0);
    expect(never?.skus).toHaveLength(1);
    expect(never?.skus[0]?.hasBalanceRow).toBe(false);
  });

  /**
   * No row and a zero row are the same quantity and different provenance:
   * "we have never stocked this here" against "we are out of it".
   */
  it('tells a zero balance apart from no balance at all', async () => {
    const body = await inventory(warehouseId, 'limit=100');

    expect(find(body, EMPTIED)?.skus[0]?.hasBalanceRow).toBe(true);
    expect(find(body, EMPTIED)?.skus[0]?.onHandQty).toBe(0);
    expect(find(body, NEVER)?.skus[0]?.hasBalanceRow).toBe(false);
  });

  it('lists a product that is not stock-tracked, and flags it', async () => {
    const untracked = find(await inventory(warehouseId, 'limit=100'), UNTRACKED);

    expect(untracked).toBeDefined();
    expect(untracked?.isStockTracked).toBe(false);
    // Nothing is ever low against a product that carries no quantity.
    expect(untracked?.lowStockSkus).toBe(0);
  });

  it('lists an unpublished product, and flags it', async () => {
    // A draft product being received into a warehouse ahead of launch is the
    // ordinary case, and it is exactly the row somebody is checking.
    expect(find(await inventory(warehouseId, 'limit=100'), UNTRACKED)?.isPublished).toBe(false);
  });
});

describe('the quantities', () => {
  it('reports on-hand, reserved and available for a stocked SKU', async () => {
    const stocked = find(await inventory(warehouseId, 'limit=100'), STOCKED);

    expect(stocked?.onHandQty).toBe(120);
    expect(stocked?.reservedQty).toBe(20);
    expect(stocked?.availableQty).toBe(100);
    expect(stocked?.skus[0]?.availableQty).toBe(100);
  });

  /**
   * Stock at another warehouse is not stock here.
   *
   * The same product carries 999 at `${PREFIX}OTHER`, so a query that had
   * forgotten to filter on the location would report that instead.
   */
  it('counts only the balances at this warehouse', async () => {
    expect(find(await inventory(otherWarehouseId, 'limit=100'), STOCKED)?.onHandQty).toBe(999);
    expect(find(await inventory(warehouseId, 'limit=100'), STOCKED)?.onHandQty).toBe(120);
  });

  it('values the stock at the product price, in the product currency', async () => {
    const stocked = find(await inventory(warehouseId, 'limit=100'), STOCKED);

    // 120 units at 2500 minor units each.
    expect(stocked?.valuation.minor).toBe('300000');
    expect(stocked?.valuation.currency).toBe('INR');
    expect(stocked?.unitPrice.minor).toBe('2500');
  });

  it('marks a SKU at or below its reorder threshold as low', async () => {
    const low = find(await inventory(warehouseId, 'limit=100'), LOW);

    expect(low?.reorderThreshold).toBe(10);
    expect(low?.skus[0]?.isLowStock).toBe(true);
    expect(low?.lowStockSkus).toBe(1);
  });

  it('does not call a SKU low when nobody set a threshold', async () => {
    // EMPTIED is at zero with a threshold of zero, which means nobody set one.
    expect(find(await inventory(warehouseId, 'limit=100'), EMPTIED)?.skus[0]?.isLowStock).toBe(
      false,
    );
  });
});

describe('products with variants', () => {
  it('carries one SKU row per live variant', async () => {
    const varied = find(await inventory(warehouseId, 'limit=100'), VARIED);

    expect(varied?.skus.map((sku) => sku.sku).sort()).toEqual([
      `${VARIED}-A`,
      `${VARIED}-B`,
    ]);
    expect(varied?.skus.every((sku) => sku.variantId !== null)).toBe(true);
  });

  it('rolls the variants up onto the product', async () => {
    const varied = find(await inventory(warehouseId, 'limit=100'), VARIED);

    expect(varied?.onHandQty).toBe(40);
    expect(varied?.unstockedSkus).toBe(1);
  });

  it('gives an unvaried product exactly one SKU row, with a null variant', async () => {
    const stocked = find(await inventory(warehouseId, 'limit=100'), STOCKED);

    expect(stocked?.skus).toHaveLength(1);
    expect(stocked?.skus[0]?.variantId).toBeNull();
    expect(stocked?.skus[0]?.variantName).toBeNull();
  });
});

describe('the filters', () => {
  it('matches a product name or SKU', async () => {
    const body = await inventory(warehouseId, `q=${LOW}&limit=100`);

    expect(own(body).map((entry) => entry.sku)).toEqual([LOW]);
  });

  /**
   * A variant's SKU has to find the product that carries it.
   *
   * Somebody reading a label off a box types the variant's code, not the
   * product's, and an empty result would send them looking in the wrong
   * warehouse.
   */
  it('finds a product by one of its variant SKUs', async () => {
    const body = await inventory(warehouseId, `q=${VARIED}-B&limit=100`);

    expect(own(body).map((entry) => entry.sku)).toEqual([VARIED]);
  });

  it('keeps only what is in stock here', async () => {
    const body = await inventory(warehouseId, 'presence=IN_STOCK&limit=100');
    const codes = own(body).map((entry) => entry.sku);

    expect(codes).toContain(STOCKED);
    expect(codes).not.toContain(EMPTIED);
    expect(codes).not.toContain(NEVER);
  });

  it('keeps only what has run out or was never stocked', async () => {
    const codes = own(await inventory(warehouseId, 'presence=OUT_OF_STOCK&limit=100')).map(
      (entry) => entry.sku,
    );

    expect(codes).toContain(EMPTIED);
    expect(codes).toContain(NEVER);
    expect(codes).not.toContain(STOCKED);
  });

  it('keeps only what has never been stocked here', async () => {
    const codes = own(await inventory(warehouseId, 'presence=NEVER_STOCKED&limit=100')).map(
      (entry) => entry.sku,
    );

    expect(codes).toContain(NEVER);
    // Booked here once and emptied, so it has a row and is not "never".
    expect(codes).not.toContain(EMPTIED);
  });

  it('keeps only what is low', async () => {
    const codes = own(await inventory(warehouseId, 'presence=LOW_STOCK&limit=100')).map(
      (entry) => entry.sku,
    );

    expect(codes).toEqual([LOW]);
  });

  /**
   * A product whose every SKU the filter rejected is not in the answer.
   *
   * Its group would be a card with no rows in it, which reads as a rendering
   * fault rather than as a filter doing its job.
   */
  it('drops a product entirely when the filter rejects all of its SKUs', async () => {
    const body = await inventory(warehouseId, 'presence=LOW_STOCK&limit=100');

    expect(body.products.every((entry) => entry.skus.length > 0)).toBe(true);
  });
});

describe('the footer figures', () => {
  /**
   * The footer describes the building, not the list.
   *
   * A total that moved because somebody typed three letters into a search box
   * would be read as the warehouse's and be wrong. The count of what the
   * filter matched is `pagination.total`, which is where a number about the
   * list belongs.
   */
  it('does not change when the list is filtered', async () => {
    const all = await inventory(warehouseId, 'limit=100');
    const filtered = await inventory(warehouseId, `q=${LOW}&limit=100`);

    expect(filtered.totals).toEqual(all.totals);
    // The pager, on the other hand, does.
    expect(filtered.pagination.total).toBeLessThan(all.pagination.total);
  });

  it('counts SKUs rather than products', async () => {
    const body = await inventory(warehouseId, 'limit=100');

    // The catalogue is shared with the rest of the suite, so this asserts the
    // relationship rather than an absolute: a product with two variants
    // contributes two SKUs and one product.
    expect(body.totals.skus).toBeGreaterThan(body.totals.products);
  });

  it('sums the units held here', async () => {
    const body = await inventory(warehouseId, 'limit=100');

    // 120 + 0 + 8 + 40 from this file, plus whatever the suite's own
    // fixtures left. Never the 999 sitting at the other warehouse.
    expect(body.totals.onHandQty).toBeGreaterThanOrEqual(168);
    expect(body.totals.onHandQty).toBeLessThan(999);
    expect(body.totals.availableQty).toBe(body.totals.onHandQty - body.totals.reservedQty);
  });

  it('counts the low SKUs across the warehouse', async () => {
    expect((await inventory(warehouseId, 'limit=100')).totals.lowStockSkus).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('never reports a negative count of never-stocked SKUs', async () => {
    expect((await inventory(warehouseId, 'limit=100')).totals.unstockedSkus).toBeGreaterThanOrEqual(
      0,
    );
  });
});

describe('paging', () => {
  it('pages by product, and reports where it is', async () => {
    const body = await inventory(warehouseId, 'limit=2&page=1');

    expect(body.products.length).toBeLessThanOrEqual(2);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(2);
    expect(body.pagination.totalPages).toBe(Math.ceil(body.pagination.total / 2));
  });

  it('never splits one product across two pages', async () => {
    const first = await inventory(warehouseId, 'limit=2&page=1');
    const second = await inventory(warehouseId, 'limit=2&page=2');

    const ids = new Set(first.products.map((entry) => entry.productId));
    expect(second.products.some((entry) => ids.has(entry.productId))).toBe(false);
  });
});

describe('the warehouse itself', () => {
  it('echoes which warehouse was asked about', async () => {
    const body = await inventory(warehouseId);

    expect(body.warehouse.id).toBe(warehouseId);
    expect(body.warehouse.code).toBe(`${PREFIX}MAIN`);
    expect(body.warehouse.isActive).toBe(true);
  });

  /**
   * A retired warehouse is answered for, and says it is retired.
   *
   * Its stock is still standing in a building somebody has to account for.
   * Refusing to open the screen would make that stock unreachable from the one
   * place it is listed.
   */
  it('answers for a retired warehouse and reports it as retired', async () => {
    await prisma.inventoryLocation.update({
      where: { id: otherWarehouseId },
      data: { isActive: false },
    });

    try {
      const body = await inventory(otherWarehouseId, 'limit=100');

      expect(body.warehouse.isActive).toBe(false);
      expect(find(body, STOCKED)?.onHandQty).toBe(999);
    } finally {
      await prisma.inventoryLocation.update({
        where: { id: otherWarehouseId },
        data: { isActive: true },
      });
    }
  });

  it('is a 404 for a warehouse that does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/inventory/warehouses/${newId()}/inventory`,
      headers: { cookie: cookies },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('authorisation', () => {
  it('refuses an anonymous caller', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/inventory/warehouses/${warehouseId}/inventory`,
    });

    expect(response.statusCode).toBe(401);
  });
});
