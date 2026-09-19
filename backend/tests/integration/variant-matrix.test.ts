/**
 * The variant matrix, end to end: axes, preview, generation and the rules that
 * stop a catalogue being quietly corrupted.
 *
 * What this file is really guarding:
 *
 *   - **Preview writes nothing.** It is the whole point of the two-step flow.
 *   - **Generating twice creates nothing the second time.** A seller who adds
 *     one size and re-runs must get one row, not forty duplicates and not
 *     forty overwritten prices.
 *   - **No two variants of one product describe themselves the same way.**
 *     "Black" and "black" are one shoe, and two rows for one shoe is a
 *     resolver picking between them at random.
 *   - **A category with no template still works.** Medical Devices has none
 *     and never will; its products must keep the free-form option editor.
 *   - **A variant an order has touched is never hard-deleted.**
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { signInAdmin } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let cookies = '';
let csrfToken = '';

const EMAIL = 'variant-matrix@test.local';
const PASSWORD = 'VariantMatrix!2026';

const FOOTWEAR_SLUG = `footwear`;
const MEDICAL_SLUG = `diagnostics-monitoring`;

let shoeId = '';
let medicalId = '';
let footwearCategoryId = '';
let medicalCategoryId = '';
let taxClassId = '';
let locationId = '';

interface PreviewBody {
  rows?: {
    optionSignature: string;
    options: Record<string, string>;
    displayName: string;
    sku: string;
    exists: boolean;
  }[];
  total?: number;
  toCreate?: number;
  warnings?: string[];
  error?: { code?: string; message?: string };
}

async function post(url: string, payload: Record<string, unknown>): Promise<{ status: number; body: PreviewBody }> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { cookie: cookies, 'x-csrf-token': csrfToken },
    payload,
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as PreviewBody };
}

async function put(url: string, payload: Record<string, unknown>): Promise<{ status: number; body: PreviewBody }> {
  const response = await app.inject({
    method: 'PUT',
    url,
    headers: { cookie: cookies, 'x-csrf-token': csrfToken },
    payload,
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as PreviewBody };
}

/** Three colours and three sizes, as the seller would type them. */
const SHOE_AXES = [
  { axisKey: 'colour', values: [{ label: 'Black' }, { label: 'Brown' }] },
  { axisKey: 'size', values: [{ label: '6' }, { label: '7' }, { label: '8' }] },
];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });

  const role = await prisma.role.findUniqueOrThrow({
    where: { key: Role.CATALOG_MANAGER },
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

  const taxClass = await prisma.taxClass.upsert({
    where: { code: 'VARIANT-MATRIX-TEST' },
    update: { isActive: true },
    create: {
      id: newId(),
      code: 'VARIANT-MATRIX-TEST',
      name: 'Variant matrix test',
      ratePercent: '18.000000',
      isActive: true,
    },
  });
  taxClassId = taxClass.id;

  // The slugs are the contract with the template registry, so the categories
  // here carry the ones the starter seed plants rather than invented names.
  const footwear = await prisma.category.upsert({
    where: { slug: FOOTWEAR_SLUG },
    update: { isActive: true, archivedAt: null },
    create: { id: newId(), name: 'Footwear', slug: FOOTWEAR_SLUG, isActive: true },
  });
  footwearCategoryId = footwear.id;

  const medical = await prisma.category.upsert({
    where: { slug: MEDICAL_SLUG },
    update: { isActive: true, archivedAt: null },
    create: {
      id: newId(),
      name: 'Diagnostics & Monitoring',
      slug: MEDICAL_SLUG,
      isActive: true,
    },
  });
  medicalCategoryId = medical.id;

  const shoe = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: footwearCategoryId,
      taxClassId,
      name: "Men's Industrial Safety Shoe",
      slug: `safety-shoe-${newId().toLowerCase()}`,
      sku: `SHOE-${newId().slice(-8)}`,
      basePriceMinor: 499_900n,
      currency: 'INR',
      isStockTracked: false,
    },
  });
  shoeId = shoe.id;

  const medicalProduct = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: medicalCategoryId,
      taxClassId,
      name: 'Disposable Syringe',
      slug: `syringe-${newId().toLowerCase()}`,
      sku: `SYR-${newId().slice(-8)}`,
      basePriceMinor: 1_000n,
      currency: 'INR',
      isStockTracked: false,
    },
  });
  medicalId = medicalProduct.id;

  // A default warehouse of this file’s own. Several files in this suite
  // truncate `inventory_locations` in their setup, so whether one exists at
  // all depends on which file ran last - and stock is only readable through
  // the default. Created only when there is none, so a file that legitimately
  // set one up first keeps it, and two rows can never both claim to be it.
  const existingDefault = await prisma.inventoryLocation.findFirst({
    where: { isDefault: true, isActive: true },
    select: { id: true },
  });

  if (existingDefault === null) {
    const created = await prisma.inventoryLocation.create({
      data: {
        id: newId(),
        code: 'VARIANT-MATRIX-WH',
        name: 'Variant matrix warehouse',
        isDefault: true,
        isActive: true,
      },
    });
    locationId = created.id;
  } else {
    locationId = existingDefault.id;
  }

  ({ cookies, csrfToken } = await signInAdmin(app, {
    email: EMAIL,
    password: PASSWORD,
    ip: '203.0.113.77',
  }));
});

afterAll(async () => {
  // Orders are ON DELETE RESTRICT, so variants go before products and both go
  // before the categories that hold them. A leftover here breaks the first
  // file of the next run rather than this one.
  await prisma.inventoryBalance.deleteMany({ where: { productId: { in: [shoeId, medicalId] } } });
  await prisma.productPrice.deleteMany({ where: { productId: { in: [shoeId, medicalId] } } });
  await prisma.productVariant.deleteMany({ where: { productId: { in: [shoeId, medicalId] } } });
  await prisma.product.deleteMany({ where: { id: { in: [shoeId, medicalId] } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
  await prisma.inventoryLocation.deleteMany({ where: { code: 'VARIANT-MATRIX-WH' } });
});

describe('the variant template', () => {
  it('offers footwear its own axes, size behind the size system', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/products/${shoeId}/variant-template`,
      headers: { cookie: cookies },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as {
      template: { subcategorySlug: string; axes: { key: string; dependsOn?: string[] }[] } | null;
      activeAxisKeys: string[];
    };

    expect(body.template?.subcategorySlug).toBe(FOOTWEAR_SLUG);
    expect(body.template?.axes.map((axis) => axis.key)).toContain('size');
    expect(
      body.template?.axes.find((axis) => axis.key === 'size')?.dependsOn,
    ).toContain('size_system');
    expect(body.activeAxisKeys).toEqual([]);
  });

  it('answers null for a category that has none, so Medical Devices is untouched', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/products/${medicalId}/variant-template`,
      headers: { cookie: cookies },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as { template: unknown; activeAxisKeys: string[] };

    // Not an error and not an empty template - null, which is what turns the
    // free-form option editor on and the matrix builder off.
    expect(body.template).toBeNull();
    expect(body.activeAxisKeys).toEqual([]);
  });

  it('refuses an axis the category does not offer', async () => {
    const result = await put(`/api/v1/admin/products/${shoeId}/variant-axes`, {
      axisKeys: ['size', 'melt_flow'],
    });

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('VARIANT_AXIS_NOT_IN_TEMPLATE');
  });

  it('refuses any axis at all on a category with no template', async () => {
    const result = await put(`/api/v1/admin/products/${medicalId}/variant-axes`, {
      axisKeys: ['size'],
    });

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('VARIANT_AXIS_NOT_IN_TEMPLATE');
  });

  it('stores the axes in the template order, not the order they were sent', async () => {
    const result = await put(`/api/v1/admin/products/${shoeId}/variant-axes`, {
      axisKeys: ['colour', 'size', 'size_system'],
    });

    expect(result.status).toBe(200);
    // Two products on one shelf presenting the same axes in a different order
    // is the sort of inconsistency a shopper notices without being able to say
    // why, so the template decides and the caller does not.
    expect((result.body as unknown as { activeAxisKeys: string[] }).activeAxisKeys).toEqual([
      'size_system',
      'size',
      'colour',
    ]);
  });
});

describe('preview', () => {
  it('works out the whole table and writes nothing', async () => {
    const before = await prisma.productVariant.count({ where: { productId: shoeId } });

    const result = await post(`/api/v1/admin/products/${shoeId}/variants/preview`, {
      axes: SHOE_AXES,
      skuPrefix: 'UB',
    });

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.total).toBe(6);
    expect(result.body.toCreate).toBe(6);
    expect(result.body.rows).toHaveLength(6);

    // The last axis varies fastest, which is what makes the table read as a
    // table: every size of black, then every size of brown.
    expect(result.body.rows?.map((row) => row.displayName)).toEqual([
      '6 / Black',
      '7 / Black',
      '8 / Black',
      '6 / Brown',
      '7 / Brown',
      '8 / Brown',
    ]);

    expect(await prisma.productVariant.count({ where: { productId: shoeId } })).toBe(before);
  });

  it('refuses two values that are the same once case is ignored', async () => {
    const result = await post(`/api/v1/admin/products/${shoeId}/variants/preview`, {
      axes: [{ axisKey: 'colour', values: [{ label: 'Black' }, { label: ' black ' }] }],
    });

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a matrix nobody could check before saving', async () => {
    const wide = ['colour', 'size', 'width', 'material'].map((axisKey) => ({
      axisKey,
      values: Array.from({ length: 6 }, (_unused, index) => ({ label: `v${String(index)}` })),
    }));

    const result = await post(`/api/v1/admin/products/${shoeId}/variants/preview`, {
      axes: wide,
    });

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('VARIANT_MATRIX_TOO_LARGE');
  });
});

describe('generating', () => {
  it('creates the rows the operator approved, and flips the product into variant mode', async () => {
    const preview = await post(`/api/v1/admin/products/${shoeId}/variants/preview`, {
      axes: SHOE_AXES,
      skuPrefix: 'UB',
    });

    const result = await post(`/api/v1/admin/products/${shoeId}/variants/generate`, {
      rows: (preview.body.rows ?? []).map((row) => ({
        optionSignature: row.optionSignature,
        options: row.options,
        name: row.displayName,
        sku: row.sku,
        priceMinor: '499900',
        minOrderQty: 2,
      })),
    });

    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect((result.body as unknown as { created: number }).created).toBe(6);

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: shoeId },
      select: { hasVariants: true },
    });
    expect(product.hasVariants).toBe(true);

    const variants = await prisma.productVariant.findMany({
      where: { productId: shoeId },
      select: { sku: true, optionSignature: true, minOrderQty: true, priceMinor: true },
    });

    expect(variants).toHaveLength(6);
    // Every signature distinct, which is what the unique index is for.
    expect(new Set(variants.map((row) => row.optionSignature)).size).toBe(6);
    expect(variants.every((row) => row.minOrderQty === 2)).toBe(true);
    expect(variants.every((row) => row.priceMinor === 499_900n)).toBe(true);
  });

  it('is idempotent: a second run of the same table creates nothing', async () => {
    const preview = await post(`/api/v1/admin/products/${shoeId}/variants/preview`, {
      axes: SHOE_AXES,
      skuPrefix: 'UB',
    });

    // Every row now reports itself as already listed, which is what the
    // operator sees before deciding whether to press Save at all.
    expect(preview.body.toCreate).toBe(0);
    expect(preview.body.rows?.every((row) => row.exists)).toBe(true);

    const result = await post(`/api/v1/admin/products/${shoeId}/variants/generate`, {
      rows: (preview.body.rows ?? []).map((row) => ({
        optionSignature: row.optionSignature,
        options: row.options,
        name: row.displayName,
        sku: row.sku,
        // A different price, which must NOT be applied: those rows are the
        // operator's work and generating is not the place to overwrite them.
        priceMinor: '100',
      })),
    });

    expect(result.status).toBe(201);
    expect((result.body as unknown as { created: number; skipped: number }).created).toBe(0);
    expect(await prisma.productVariant.count({ where: { productId: shoeId } })).toBe(6);

    const untouched = await prisma.productVariant.findMany({
      where: { productId: shoeId },
      select: { priceMinor: true },
    });
    expect(untouched.every((row) => row.priceMinor === 499_900n)).toBe(true);
  });

  it('adds only the new row when a size is added to an existing matrix', async () => {
    const preview = await post(`/api/v1/admin/products/${shoeId}/variants/preview`, {
      axes: [
        { axisKey: 'colour', values: [{ label: 'Black' }] },
        { axisKey: 'size', values: [{ label: '8' }, { label: '9' }] },
      ],
      skuPrefix: 'UB',
    });

    expect(preview.body.total).toBe(2);
    expect(preview.body.toCreate).toBe(1);

    const result = await post(`/api/v1/admin/products/${shoeId}/variants/generate`, {
      rows: (preview.body.rows ?? [])
        .filter((row) => !row.exists)
        .map((row) => ({
          optionSignature: row.optionSignature,
          options: row.options,
          name: row.displayName,
          sku: row.sku,
        })),
    });

    expect(result.status).toBe(201);
    expect((result.body as unknown as { created: number }).created).toBe(1);
    expect(await prisma.productVariant.count({ where: { productId: shoeId } })).toBe(7);
  });
});

describe('duplicate protection', () => {
  it('refuses a second variant describing itself the same way, whatever the spelling', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${shoeId}/variants`,
      headers: { cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        sku: `DUPE-${newId().slice(-8)}`,
        name: 'Black 6, again',
        // Same combination as a generated row, differently cased and spaced.
        options: { colour: ' BLACK ', size: '6' },
      },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as PreviewBody).error?.code).toBe(
      'VARIANT_COMBINATION_EXISTS',
    );
  });

  it('lets a variant be re-saved without reporting it as a clash with itself', async () => {
    const existing = await prisma.productVariant.findFirstOrThrow({
      where: { productId: shoeId },
      select: { id: true, optionsJson: true },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/products/${shoeId}/variants/${existing.id}`,
      headers: { cookie: cookies, 'x-csrf-token': csrfToken },
      payload: { options: existing.optionsJson, leadTimeDays: 5 },
    });

    expect(response.statusCode, response.body).toBe(200);
  });
});

describe('bulk editing', () => {
  it('sets one figure across many variants, and only within this product', async () => {
    const mine = await prisma.productVariant.findMany({
      where: { productId: shoeId },
      select: { id: true },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${shoeId}/variants/bulk`,
      headers: { cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        // A variant id from nowhere, which must be ignored rather than swept in.
        variantIds: [...mine.map((row) => row.id), newId()],
        leadTimeDays: 7,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect((JSON.parse(response.body) as { updated: number }).updated).toBe(mine.length);

    const updated = await prisma.productVariant.findMany({
      where: { productId: shoeId },
      select: { leadTimeDays: true },
    });
    expect(updated.every((row) => row.leadTimeDays === 7)).toBe(true);
  });
});

describe('compare-at prices', () => {
  it('refuses a "was" price below the price it is compared against', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${shoeId}/variants`,
      headers: { cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        sku: `CMP-${newId().slice(-8)}`,
        name: 'Black 11',
        options: { colour: 'Black', size: '11' },
        priceMinor: '500000',
        compareAtPriceMinor: '400000',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as PreviewBody;
    expect(body.error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('the public read', () => {
  it('publishes the axis keys and the template slug, so the storefront can draw a selector', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: shoeId },
      select: { slug: true },
    });

    await prisma.product.update({
      where: { id: shoeId },
      data: { status: 'ACTIVE', isPublished: true, publishedAt: new Date() },
    });

    await prisma.productPrice.deleteMany({ where: { productId: shoeId } });
    await prisma.productPrice.create({
      data: {
        id: newId(),
        productId: shoeId,
        variantKey: '',
        currencyCode: 'INR',
        basePriceMinor: 499_900n,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/${product.slug}?currency=INR`,
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as {
      product: { variantAxisKeys: string[]; variantTemplateSlug: string | null };
    };

    expect(body.product.variantAxisKeys).toEqual(['size_system', 'size', 'colour']);
    expect(body.product.variantTemplateSlug).toBe(FOOTWEAR_SLUG);

    await prisma.productPrice.deleteMany({ where: { productId: shoeId } });
  });

  it('says whether each size can be had, as a boolean and never as a figure', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: shoeId },
      select: { slug: true },
    });

    // Stock tracking on, and a balance for exactly one size at the default
    // warehouse. Everything else has never been received, which is zero.

    const variants = await prisma.productVariant.findMany({
      where: { productId: shoeId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
      take: 2,
    });

    const stocked = variants[0];
    const empty = variants[1];
    expect(stocked).toBeDefined();
    expect(empty).toBeDefined();

    await prisma.product.update({
      where: { id: shoeId },
      data: { status: 'ACTIVE', isPublished: true, publishedAt: new Date(), isStockTracked: true },
    });

    await prisma.productPrice.create({
      data: {
        id: newId(),
        productId: shoeId,
        variantKey: '',
        currencyCode: 'INR',
        basePriceMinor: 499_900n,
      },
    });

    await prisma.inventoryBalance.create({
      data: {
        id: newId(),
        productId: shoeId,
        variantId: stocked?.id ?? '',
        variantKey: stocked?.id ?? '',
        locationId,
        onHandQty: 5,
        reservedQty: 0,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/${product.slug}?currency=INR`,
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as {
      product: { variants: { id: string; isInStock: boolean | null }[] };
    };

    const byId = new Map(body.product.variants.map((row) => [row.id, row]));
    expect(byId.get(stocked?.id ?? '')?.isInStock).toBe(true);
    expect(byId.get(empty?.id ?? '')?.isInStock).toBe(false);

    // A boolean, and nothing that leaks a warehouse figure alongside it.
    expect(JSON.stringify(body.product.variants)).not.toContain('availableQty');
    expect(JSON.stringify(body.product.variants)).not.toContain('onHandQty');

    await prisma.inventoryBalance.deleteMany({ where: { productId: shoeId } });
    await prisma.productPrice.deleteMany({ where: { productId: shoeId } });
    await prisma.product.update({
      where: { id: shoeId },
      data: { isStockTracked: false },
    });
  });

  it('renders the page even where no default warehouse is configured', async () => {
    // Stock is a courtesy on this page, never a precondition for it. The
    // availability lookup REFUSES when a deployment has no default warehouse -
    // correct for a stock movement, and catastrophic here: it turned every
    // product page of a warehouse-less deployment into a 400.
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: shoeId },
      select: { slug: true },
    });

    await prisma.product.update({
      where: { id: shoeId },
      data: { status: 'ACTIVE', isPublished: true, publishedAt: new Date(), isStockTracked: true },
    });
    await prisma.productPrice.create({
      data: {
        id: newId(),
        productId: shoeId,
        variantKey: '',
        currencyCode: 'INR',
        basePriceMinor: 499_900n,
      },
    });

    // Every warehouse stops being the default, as a fresh deployment is.
    await prisma.inventoryLocation.updateMany({ data: { isDefault: false } });

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/catalog/products/${product.slug}?currency=INR`,
      });

      expect(response.statusCode, response.body).toBe(200);

      const body = JSON.parse(response.body) as {
        product: { isInStock: boolean | null; variants: { isInStock: boolean | null }[] };
      };

      // No answer, rather than a wrong one. Null is purchasable.
      expect(body.product.isInStock).toBeNull();
      expect(body.product.variants.every((row) => row.isInStock === null)).toBe(true);
    } finally {
      await prisma.inventoryLocation.updateMany({
        where: { id: locationId },
        data: { isDefault: true },
      });
      await prisma.productPrice.deleteMany({ where: { productId: shoeId } });
      await prisma.product.update({ where: { id: shoeId }, data: { isStockTracked: false } });
    }
  });

  it('serves the axis definitions per shelf, because size means two things', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/catalog/variant-axes' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      templates: Record<string, { axes: { key: string; sort: string }[] }>;
    };

    // A shoe's size is a numeric run; a shirt's is a semantic one. One global
    // definition of "size" hangs a shirt rail in the order L, M, S, XL.
    const shoeSize = body.templates[FOOTWEAR_SLUG]?.axes.find((axis) => axis.key === 'size');
    const shirtSize = body.templates['everyday-clothing']?.axes.find(
      (axis) => axis.key === 'size',
    );

    expect(shoeSize?.sort).toBe('NUMERIC');
    expect(shirtSize?.sort).toBe('APPAREL');
    expect(Object.keys(body.templates)).toHaveLength(112);
  });
});
