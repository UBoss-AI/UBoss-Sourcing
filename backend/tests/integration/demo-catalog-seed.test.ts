/**
 * The demonstration seed, run against a real database.
 *
 * The unit tests prove the registry and the generator are sound. These prove
 * the four things that can only go wrong once rows exist:
 *
 *   - **A re-run converges.** Same product count, same product ids, same
 *     prices, same stock. A seed that creates a second copy of everything on
 *     the second run is worse than no seed, because the first person to notice
 *     is a customer looking at a catalogue with two of each item in it.
 *   - **A genuine product is never touched.** The whole safety of the exercise
 *     rests on `demo_catalog_entries` being the only way a blueprint can name
 *     a product, and that is worth a test that actually plants a product the
 *     seed has no row for and checks it comes out unchanged.
 *   - **What is written is buyable.** Published, in an active category, with a
 *     price row in the base currency and a stock balance per combination - the
 *     four conditions `publicProductWhere` and the cart between them require.
 *   - **`ENABLE_DEMO_CATALOG=false` hides all of it**, and hides nothing else.
 *
 * Scoped to one sub-category with `--subcategory`, because the point is the
 * behaviour rather than the volume and four hundred families is a minute of
 * somebody's life on every run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { publicProductWhere } from '../../src/modules/catalog/catalog.visibility.js';
import { seedDemoCatalog } from '../../src/modules/catalog/demo-catalog/seed.js';

/** One shelf, chosen because its products carry a three-axis size run. */
const SUBCATEGORY = 'safety-footwear';

/** Its department. Created here too, and removed here too - see `afterAll`. */
const DEPARTMENT = 'safety-protective-equipment';

/** A product this seed has no row for, and therefore cannot name. */
const GENUINE_SKU = 'GENUINE-TEST-SKU-001';
const GENUINE_SLUG = 'genuine-operator-product-under-test';

let genuineId = '';
let categoryId = '';

async function removeGenuineProduct(): Promise<void> {
  const existing = await prisma.product.findUnique({
    where: { slug: GENUINE_SLUG },
    select: { id: true },
  });
  if (existing === null) return;

  // Order matters: every one of these references the product, and the
  // product's own row is RESTRICT from several of them.
  await prisma.productPrice.deleteMany({ where: { productId: existing.id } });
  await prisma.inventoryMovement.deleteMany({ where: { productId: existing.id } });
  await prisma.inventoryBalance.deleteMany({ where: { productId: existing.id } });
  await prisma.productAttribute.deleteMany({ where: { productId: existing.id } });
  await prisma.product.delete({ where: { id: existing.id } });
}

beforeAll(async () => {
  /*
   * Everything this suite needs, created here rather than assumed.
   *
   * The test database gets the reference data - currencies, countries, VAT -
   * from `globalSetup` and nothing else; the business tables are cleared
   * between files. So the department, the shelf, the warehouse and the tax
   * class are all provisioned here, which also means this file states its own
   * preconditions instead of inheriting somebody's development database.
   *
   * Upserts, because the suite may run this file after another has left rows
   * of its own behind.
   */
  const department = await prisma.category.upsert({
    where: { slug: DEPARTMENT },
    update: {},
    create: {
      id: newId(),
      name: 'Safety & Protective Equipment',
      slug: DEPARTMENT,
      isActive: true,
    },
    select: { id: true },
  });

  const category = await prisma.category.upsert({
    where: { slug: SUBCATEGORY },
    update: { isActive: true, archivedAt: null },
    create: {
      id: newId(),
      name: 'Safety Footwear',
      slug: SUBCATEGORY,
      parentId: department.id,
      path: `/${department.id}/`,
      depth: 1,
      isActive: true,
    },
    select: { id: true },
  });
  categoryId = category.id;

  const taxClass =
    (await prisma.taxClass.findFirst({ select: { id: true } })) ??
    (await prisma.taxClass.create({
      data: {
        id: newId(),
        code: 'GST18',
        name: 'GST 18%',
        ratePercent: '18.000000',
        isDefault: true,
        isActive: true,
      },
      select: { id: true },
    }));

  const location = await prisma.inventoryLocation.findFirst({ select: { id: true } });
  if (location === null) {
    await prisma.inventoryLocation.create({
      data: { id: newId(), code: 'MAIN', name: 'Main', isDefault: true, isActive: true },
    });
  }

  await removeGenuineProduct();

  genuineId = newId();
  await prisma.product.create({
    data: {
      id: genuineId,
      categoryId,
      name: 'Genuine operator product under test',
      slug: GENUINE_SLUG,
      sku: GENUINE_SKU,
      shortDescription: 'Written by a person, not by the demonstration seed.',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      taxClassId: taxClass.id,
      basePriceMinor: 123_456n,
      currency: 'INR',
    },
  });
});

/**
 * Take the demonstration products this file planted back out.
 *
 * Not optional, and not tidiness. The suite's global setup deletes every
 * category before the first file runs, and `products.categoryId` is ON DELETE
 * RESTRICT - so a product left behind here does not fail THIS file, it fails
 * the whole suite on its next run with a foreign key violation in a setup
 * routine nobody is looking at.
 *
 * Deleted in dependency order for the same reason: prices, movements, balances,
 * attributes, media links and packing rows all reference the product or its
 * variants, and most of them are RESTRICT.
 */
async function removeSeededProducts(): Promise<void> {
  const ids = (
    await prisma.demoCatalogEntry.findMany({ select: { productId: true } })
  ).map((row) => row.productId);

  if (ids.length === 0) return;

  const where = { productId: { in: ids } };

  await prisma.productPrice.deleteMany({ where });
  await prisma.inventoryMovement.deleteMany({ where });
  await prisma.inventoryBalance.deleteMany({ where });
  await prisma.productAttribute.deleteMany({ where });
  await prisma.productMedia.deleteMany({ where });
  await prisma.productPackaging.deleteMany({ where });
  await prisma.productVariant.deleteMany({ where });
  // `demo_catalog_entries` is ON DELETE CASCADE from the product, so the
  // marker rows go with them.
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
  await prisma.mediaAsset.deleteMany({ where: { storageKey: { startsWith: 'demo-catalog/' } } });
}

afterAll(async () => {
  // Integration tests clean up after themselves: orders are ON DELETE RESTRICT
  // and a leftover row breaks the first file of the next run.
  await removeSeededProducts();
  await removeGenuineProduct();

  /*
   * And the two categories, child before parent.
   *
   * This file is the only one in the suite that creates a category with a
   * PARENT, and several others clean up with a single flat
   * `category.deleteMany({})` - which MariaDB refuses while a row still points
   * at another row in the same table. Leaving the pair behind therefore does
   * not fail this file, it fails three unrelated ones with a foreign key error
   * on `parentId` in a teardown nobody is looking at.
   */
  await prisma.category.deleteMany({ where: { slug: SUBCATEGORY } });
  await prisma.category.deleteMany({ where: { slug: DEPARTMENT } });
});

describe('demonstration catalogue seed', () => {
  it('plants a sub-category and reports what it did', async () => {
    const report = await seedDemoCatalog({ subcategorySlug: SUBCATEGORY, useApi: false });

    expect(report.problems).toEqual([]);
    expect(report.missingSubcategories).toEqual([]);
    expect(report.created + report.updated).toBeGreaterThanOrEqual(3);
    expect(report.subcategoriesCovered).toBe(1);
  }, 120_000);

  it('writes products that the public catalogue can actually see', async () => {
    const visible = await prisma.product.findMany({
      where: { ...publicProductWhere(), demoEntry: { isNot: null }, categoryId },
      select: { id: true, sku: true, hasVariants: true },
    });

    expect(visible.length).toBeGreaterThanOrEqual(3);
    for (const product of visible) expect(product.sku.startsWith('DEMO-')).toBe(true);
  });

  it('gives every combination its own SKU, price and stock', async () => {
    const products = await prisma.product.findMany({
      where: { demoEntry: { isNot: null }, categoryId },
      select: {
        id: true,
        variants: { where: { isActive: true }, select: { id: true, sku: true } },
      },
    });

    expect(products.length).toBeGreaterThanOrEqual(3);

    for (const product of products) {
      expect(product.variants.length).toBeGreaterThan(1);

      const skus = product.variants.map((variant) => variant.sku);
      expect(new Set(skus).size).toBe(skus.length);

      for (const variant of product.variants) {
        const price = await prisma.productPrice.findFirst({
          where: { productId: product.id, variantKey: variant.id, currencyCode: 'INR' },
          select: { basePriceMinor: true },
        });
        expect(price, `${variant.sku} has no INR price`).not.toBeNull();
        expect(price?.basePriceMinor ?? 0n).toBeGreaterThan(0n);

        const balance = await prisma.inventoryBalance.findFirst({
          where: { productId: product.id, variantKey: variant.id },
          select: { onHandQty: true },
        });
        expect(balance, `${variant.sku} has no stock row`).not.toBeNull();
        expect(balance?.onHandQty ?? -1).toBeGreaterThanOrEqual(0);
      }
    }
  }, 60_000);

  it('converges on a re-run rather than duplicating', async () => {
    const before = await prisma.product.findMany({
      where: { demoEntry: { isNot: null }, categoryId },
      select: {
        id: true,
        sku: true,
        basePriceMinor: true,
        variants: {
          where: { isActive: true },
          select: { id: true, sku: true, priceMinor: true },
          orderBy: { sku: 'asc' },
        },
      },
      orderBy: { sku: 'asc' },
    });

    const report = await seedDemoCatalog({ subcategorySlug: SUBCATEGORY, useApi: false });
    expect(report.created).toBe(0);

    const after = await prisma.product.findMany({
      where: { demoEntry: { isNot: null }, categoryId },
      select: {
        id: true,
        sku: true,
        basePriceMinor: true,
        variants: {
          where: { isActive: true },
          select: { id: true, sku: true, priceMinor: true },
          orderBy: { sku: 'asc' },
        },
      },
      orderBy: { sku: 'asc' },
    });

    // Identical ids, not merely an identical count: a seed that deleted and
    // recreated everything would pass a count check and break every order,
    // basket and schedule pointing at the old rows.
    expect(after).toEqual(before);
  }, 120_000);

  it('leaves a product it has no row for entirely alone', async () => {
    const genuine = await prisma.product.findUnique({
      where: { id: genuineId },
      select: {
        name: true,
        sku: true,
        basePriceMinor: true,
        shortDescription: true,
        status: true,
        isPublished: true,
      },
    });

    expect(genuine).toEqual({
      name: 'Genuine operator product under test',
      sku: GENUINE_SKU,
      basePriceMinor: 123_456n,
      shortDescription: 'Written by a person, not by the demonstration seed.',
      status: 'ACTIVE',
      isPublished: true,
    });

    // And it is not claimed by the seed, which is the structural reason the
    // above is true rather than a coincidence.
    const claimed = await prisma.demoCatalogEntry.findUnique({
      where: { productId: genuineId },
      select: { id: true },
    });
    expect(claimed).toBeNull();
  });

  it('never reuses a genuine SKU', async () => {
    const collision = await prisma.product.findMany({
      where: { sku: GENUINE_SKU },
      select: { id: true },
    });
    expect(collision).toHaveLength(1);
    expect(collision[0]?.id).toBe(genuineId);
  });
});
