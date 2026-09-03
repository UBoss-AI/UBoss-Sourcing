/**
 * Catalog - integration, against a real MariaDB.
 *
 * The rule under test throughout is the SOP's core operating principle: a
 * product reaches the Customer Website only after an authorised administrator
 * marks it Active AND Published. Most of these tests assert the negative -
 * the ways a draft could otherwise leak.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { productAttributesSchema } from '../../src/http/routes/catalog.admin.js';
import { prisma } from '../../src/infra/prisma.js';
import { newId } from '../../src/infra/ids.js';
import {
  PUBLIC_PRODUCT_SELECT,
  publicProductWhere,
  slugify,
  validateForPublish,
} from '../../src/modules/catalog/catalog.visibility.js';
import {
  archiveCategory,
  createCategory,
  listCategoryTree,
  subtreeCategoryIds,
  updateCategory,
} from '../../src/modules/catalog/category.service.js';
import {
  archiveProduct,
  createProduct,
  publishProduct,
  setProductStatus,
  unpublishProduct,
  updateProduct,
} from '../../src/modules/catalog/product.service.js';

/**
 * Populated in beforeEach from a real user row. `audit_logs.actorUserId` has a
 * foreign key, so a synthetic id would (correctly) be rejected - the audit
 * trail must never name an actor who does not exist.
 */
let actor: { userId: string; email: string };

let taxClassId: string;
let categoryId: string;

async function resetCatalog(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({ where: { emailNormalized: 'catalog@test.local' } });
  await prisma.cartItem.deleteMany({});
  await prisma.productMedia.deleteMany({});
  await prisma.mediaAsset.deleteMany({});
  await prisma.productAttribute.deleteMany({});
  await prisma.productVariant.deleteMany({});
  await prisma.product.deleteMany({});

  // categories.parentId references categories, so a bulk delete would try to
  // remove a parent while its children still point at it. Delete deepest-first.
  const categories = await prisma.category.findMany({
    orderBy: { depth: 'desc' },
    select: { id: true },
  });
  for (const category of categories) {
    await prisma.category.delete({ where: { id: category.id } });
  }

  await prisma.taxClass.deleteMany({});
}

/** Attach an image, since publication requires at least one. */
async function attachImage(productId: string): Promise<string> {
  const mediaId = newId();
  await prisma.mediaAsset.create({
    data: {
      id: mediaId,
      storageKey: `test/${mediaId}.png`,
      url: `http://localhost/media/test/${mediaId}.png`,
      mimeType: 'image/png',
      sizeBytes: 100,
      altText: 'Test image',
    },
  });
  await prisma.productMedia.create({
    data: { id: newId(), productId, mediaId, sortOrder: 0, isPrimary: true },
  });
  return mediaId;
}

async function makeProduct(overrides: { sku?: string; name?: string } = {}): Promise<string> {
  const created = await createProduct(
    {
      name: overrides.name ?? 'Hex Bolt M12',
      sku: overrides.sku ?? `HEX-${newId().slice(-8)}`,
      categoryId,
      basePriceMinor: '4550',
      shortDescription: 'Grade 8.8 zinc-plated hex bolt.',
      minOrderQty: 10,
      qtyIncrement: 5,
    },
    actor,
  );
  return created.id;
}

beforeEach(async () => {
  await resetCatalog();

  const actorId = newId();
  await prisma.user.create({
    data: {
      id: actorId,
      type: 'ADMIN',
      email: 'catalog@test.local',
      emailNormalized: 'catalog@test.local',
      status: 'ACTIVE',
    },
  });
  actor = { userId: actorId, email: 'catalog@test.local' };

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'GST18',
      name: 'GST 18%',
      ratePercent: '18.000000',
      isDefault: true,
      isActive: true,
    },
  });
  taxClassId = taxClass.id;

  const category = await createCategory({ name: 'Fasteners', isActive: true }, actor);
  categoryId = category.id;
});

afterAll(async () => {
  await resetCatalog();
  await prisma.$disconnect();
});

describe('slugify', () => {
  it('produces URL-safe slugs', () => {
    expect(slugify('Hex Bolt M12 x 60mm')).toBe('hex-bolt-m12-x-60mm');
    expect(slugify('  Spaced  Out  ')).toBe('spaced-out');
    expect(slugify('Symbols!@#$%^&*()')).toBe('symbols');
  });

  it('strips accents rather than dropping the characters', () => {
    expect(slugify('Café Münster')).toBe('cafe-munster');
  });
});

describe('categories', () => {
  it('creates a category as a draft by default', async () => {
    const created = await createCategory({ name: 'Draft Category' }, actor);
    const row = await prisma.category.findUniqueOrThrow({ where: { id: created.id } });

    // Not visible until an admin deliberately activates it.
    expect(row.isActive).toBe(false);
    expect(row.depth).toBe(0);
    expect(row.path).toBe('/');
  });

  it('rejects a duplicate slug', async () => {
    await expect(createCategory({ name: 'Fasteners' }, actor)).rejects.toMatchObject({
      code: 'SLUG_ALREADY_EXISTS',
    });
  });

  it('builds the materialised path for nested categories', async () => {
    const child = await createCategory({ name: 'Bolts', parentId: categoryId }, actor);
    const grandchild = await createCategory({ name: 'Hex Bolts', parentId: child.id }, actor);

    const rows = await prisma.category.findMany({ where: { id: { in: [child.id, grandchild.id] } } });
    const childRow = rows.find((r) => r.id === child.id);
    const grandchildRow = rows.find((r) => r.id === grandchild.id);

    expect(childRow?.path).toBe(`/${categoryId}/`);
    expect(childRow?.depth).toBe(1);
    expect(grandchildRow?.path).toBe(`/${categoryId}/${child.id}/`);
    expect(grandchildRow?.depth).toBe(2);
  });

  it('refuses to make a category its own parent', async () => {
    await expect(updateCategory(categoryId, { parentId: categoryId }, actor)).rejects.toMatchObject({
      code: 'CATEGORY_CYCLE_DETECTED',
    });
  });

  /** The cycle that a naive parent check misses: attaching to a descendant. */
  it('refuses to attach a category beneath its own descendant', async () => {
    const child = await createCategory({ name: 'Bolts', parentId: categoryId }, actor);
    const grandchild = await createCategory({ name: 'Hex', parentId: child.id }, actor);

    await expect(
      updateCategory(categoryId, { parentId: grandchild.id }, actor),
    ).rejects.toMatchObject({ code: 'CATEGORY_CYCLE_DETECTED' });
  });

  it('rewrites descendant paths when a category moves', async () => {
    const other = await createCategory({ name: 'Hardware', isActive: true }, actor);
    const child = await createCategory({ name: 'Bolts', parentId: categoryId }, actor);
    const grandchild = await createCategory({ name: 'Hex', parentId: child.id }, actor);

    await updateCategory(child.id, { parentId: other.id }, actor);

    const grandchildRow = await prisma.category.findUniqueOrThrow({ where: { id: grandchild.id } });
    // The whole branch moved, not just the node that was reparented.
    expect(grandchildRow.path).toBe(`/${other.id}/${child.id}/`);
    expect(grandchildRow.depth).toBe(2);
  });

  it('enforces the maximum nesting depth', async () => {
    let parentId = categoryId;
    for (let level = 1; level <= 4; level += 1) {
      const created = await createCategory({ name: `Level ${String(level)}`, parentId }, actor);
      parentId = created.id;
    }

    await expect(createCategory({ name: 'Too deep', parentId }, actor)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses to archive a category that still holds products', async () => {
    await makeProduct();
    await expect(archiveCategory(categoryId, actor)).rejects.toMatchObject({
      code: 'CATEGORY_HAS_PRODUCTS',
    });
  });

  it('requires confirmation before archiving sub-categories', async () => {
    await createCategory({ name: 'Bolts', parentId: categoryId }, actor);

    await expect(archiveCategory(categoryId, actor)).rejects.toMatchObject({ code: 'CONFLICT' });

    const result = await archiveCategory(categoryId, actor, { force: true });
    expect(result.archivedCount).toBe(2);
  });

  it('hides inactive categories from the public tree', async () => {
    await createCategory({ name: 'Hidden', isActive: false }, actor);

    const publicTree = await listCategoryTree();
    const adminTree = await listCategoryTree({ includeInactive: true });

    expect(publicTree.map((n) => n.name)).not.toContain('Hidden');
    expect(adminTree.map((n) => n.name)).toContain('Hidden');
  });

  /**
   * A child of a hidden parent must not be promoted to a root - that would
   * surface a category the admin deliberately hid.
   */
  it('does not promote the child of a hidden parent to a root', async () => {
    const hidden = await createCategory({ name: 'Hidden', isActive: false }, actor);
    await createCategory({ name: 'Visible Child', parentId: hidden.id, isActive: true }, actor);

    const publicTree = await listCategoryTree();
    expect(publicTree.map((n) => n.name)).not.toContain('Visible Child');
  });

  it('returns a whole subtree for filtering', async () => {
    const child = await createCategory({ name: 'Bolts', parentId: categoryId }, actor);
    const grandchild = await createCategory({ name: 'Hex', parentId: child.id }, actor);

    const ids = await subtreeCategoryIds(categoryId);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining([categoryId, child.id, grandchild.id]));
  });
});

describe('products', () => {
  it('always creates as an unpublished draft', async () => {
    const productId = await makeProduct();
    const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });

    expect(row.status).toBe('DRAFT');
    expect(row.isPublished).toBe(false);
    expect(row.publishedAt).toBeNull();
  });

  it('rejects a duplicate SKU', async () => {
    await makeProduct({ sku: 'DUPLICATE-SKU' });
    await expect(makeProduct({ sku: 'DUPLICATE-SKU' })).rejects.toMatchObject({
      code: 'SKU_ALREADY_EXISTS',
    });
  });

  /** Product and variant SKUs share one namespace - a scanner cannot tell them apart. */
  it('rejects a product SKU that collides with a variant SKU', async () => {
    const productId = await makeProduct();
    await prisma.productVariant.create({
      data: {
        id: newId(),
        productId,
        sku: 'VARIANT-SKU-1',
        name: '1L',
        optionsJson: { Size: '1L' },
      },
    });

    await expect(makeProduct({ sku: 'VARIANT-SKU-1' })).rejects.toMatchObject({
      code: 'SKU_ALREADY_EXISTS',
    });
  });

  it('normalises the SKU to upper case', async () => {
    const created = await createProduct(
      { name: 'Lower', sku: 'lower-case-sku', categoryId, basePriceMinor: '1000' },
      actor,
    );
    expect(created.sku).toBe('LOWER-CASE-SKU');
  });

  it('rejects a non-integer money string', async () => {
    await expect(
      createProduct(
        { name: 'Bad price', sku: 'BAD-1', categoryId, basePriceMinor: '45.50' },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('stores money as BigInt minor units', async () => {
    const productId = await makeProduct();
    const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });

    expect(row.basePriceMinor).toBe(4550n);
    expect(typeof row.basePriceMinor).toBe('bigint');
  });
});

/**
 * Specifications are the name/value rows shown under "Specifications" on the
 * product page. The editor sends the whole list every time, so the contract
 * that matters is: what arrives replaces what was there, and omitting the
 * field changes nothing.
 */
describe('specifications', () => {
  async function specsOf(productId: string) {
    return prisma.productAttribute.findMany({
      where: { productId },
      orderBy: { sortOrder: 'asc' },
      select: { name: true, value: true, sortOrder: true, isFilterable: true },
    });
  }

  it('saves the specifications given at creation, in the order given', async () => {
    const created = await createProduct(
      {
        name: 'Spec sheet',
        sku: 'SPEC-1',
        categoryId,
        basePriceMinor: '1000',
        attributes: [
          { name: 'Material', value: 'Mild steel', isFilterable: true },
          { name: 'Finish', value: 'Zinc plated' },
        ],
      },
      actor,
    );

    expect(await specsOf(created.id)).toEqual([
      { name: 'Material', value: 'Mild steel', sortOrder: 0, isFilterable: true },
      { name: 'Finish', value: 'Zinc plated', sortOrder: 1, isFilterable: false },
    ]);
  });

  it('replaces the whole set on update, renumbering the order', async () => {
    const productId = await makeProduct();

    await updateProduct(
      productId,
      { attributes: [{ name: 'Material', value: 'Mild steel' }, { name: 'Finish', value: 'Raw' }] },
      actor,
    );

    // The editor moved Finish above Material, corrected its value, and dropped
    // nothing. What comes back must be exactly that, not a merge of both edits.
    await updateProduct(
      productId,
      {
        attributes: [
          { name: 'Finish', value: 'Zinc plated' },
          { name: 'Material', value: 'Stainless 304', isFilterable: true },
        ],
      },
      actor,
    );

    expect(await specsOf(productId)).toEqual([
      { name: 'Finish', value: 'Zinc plated', sortOrder: 0, isFilterable: false },
      { name: 'Material', value: 'Stainless 304', sortOrder: 1, isFilterable: true },
    ]);
  });

  it('clears them when an empty list is sent', async () => {
    const productId = await makeProduct();
    await updateProduct(productId, { attributes: [{ name: 'Material', value: 'Steel' }] }, actor);

    await updateProduct(productId, { attributes: [] }, actor);

    expect(await specsOf(productId)).toEqual([]);
  });

  it('leaves them alone when the field is omitted', async () => {
    const productId = await makeProduct();
    await updateProduct(productId, { attributes: [{ name: 'Material', value: 'Steel' }] }, actor);

    // A price-only edit must stay a price-only edit. This is the regression
    // that matters: the field used to be accepted and silently discarded.
    await updateProduct(productId, { basePriceMinor: '9900' }, actor);

    expect(await specsOf(productId)).toEqual([
      { name: 'Material', value: 'Steel', sortOrder: 0, isFilterable: false },
    ]);
  });

  it('rejects a repeated name before it reaches the database', () => {
    const result = productAttributesSchema.safeParse([
      { name: 'Material', value: 'Steel' },
      { name: 'material', value: 'Brass' },
    ]);

    expect(result.success).toBe(false);
    // The row index is on the issue, so the editor can mark the offending
    // field rather than showing a form-level failure.
    expect(result.error?.issues[0]?.path).toEqual([1, 'name']);
  });

  it('accepts fifty specifications and refuses the fifty-first', () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      name: `Spec ${String(index)}`,
      value: 'x',
    }));

    expect(productAttributesSchema.safeParse(rows).success).toBe(true);
    expect(
      productAttributesSchema.safeParse([...rows, { name: 'Spec 50', value: 'x' }]).success,
    ).toBe(false);
  });
});

describe('publication gate', () => {
  it('blocks publication without an image, and says why', async () => {
    const productId = await makeProduct();

    await expect(publishProduct(productId, actor)).rejects.toMatchObject({
      code: 'PRODUCT_INCOMPLETE_FOR_PUBLISH',
    });
  });

  it('reports every blocker at once, not just the first', () => {
    const blockers = validateForPublish({
      name: '',
      slug: '',
      sku: '',
      shortDescription: null,
      description: null,
      basePriceMinor: 0n,
      minOrderQty: 1,
      maxOrderQty: null,
      qtyIncrement: 1,
      hasVariants: false,
      mediaCount: 0,
      activeVariantCount: 0,
      categoryIsActive: true,
    });

    // The Admin Panel renders this as a checklist.
    expect(blockers.length).toBeGreaterThanOrEqual(5);
    expect(blockers.map((b) => b.field)).toEqual(
      expect.arrayContaining(['name', 'slug', 'sku', 'description', 'basePriceMinor', 'media']),
    );
  });

  it('blocks a zero price', () => {
    const blockers = validateForPublish({
      name: 'Freebie',
      slug: 'freebie',
      sku: 'FREE-1',
      shortDescription: 'A thing',
      description: null,
      basePriceMinor: 0n,
      minOrderQty: 1,
      maxOrderQty: null,
      qtyIncrement: 1,
      hasVariants: false,
      mediaCount: 1,
      activeVariantCount: 0,
      categoryIsActive: true,
    });

    expect(blockers.map((b) => b.code)).toContain('PRICE_REQUIRED');
  });

  it('blocks a variant product with no active variant', () => {
    const blockers = validateForPublish({
      name: 'Varianted',
      slug: 'varianted',
      sku: 'VAR-1',
      shortDescription: 'A thing',
      description: null,
      basePriceMinor: 1000n,
      minOrderQty: 1,
      maxOrderQty: null,
      qtyIncrement: 1,
      hasVariants: true,
      mediaCount: 1,
      activeVariantCount: 0,
      categoryIsActive: true,
    });

    expect(blockers.map((b) => b.code)).toContain('NO_ACTIVE_VARIANTS');
  });

  it('publishes a complete product', async () => {
    const productId = await makeProduct();
    await attachImage(productId);

    const result = await publishProduct(productId, actor);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });

    expect(row.status).toBe('ACTIVE');
    expect(row.isPublished).toBe(true);
    expect(result.publishedAt).toBeInstanceOf(Date);
  });

  it('refuses to publish twice', async () => {
    const productId = await makeProduct();
    await attachImage(productId);
    await publishProduct(productId, actor);

    await expect(publishProduct(productId, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('public visibility', () => {
  async function publicCount(): Promise<number> {
    return prisma.product.count({ where: publicProductWhere() });
  }

  it('excludes drafts', async () => {
    await makeProduct();
    expect(await publicCount()).toBe(0);
  });

  it('includes a published product', async () => {
    const productId = await makeProduct();
    await attachImage(productId);
    await publishProduct(productId, actor);

    expect(await publicCount()).toBe(1);
  });

  it('excludes it again once unpublished', async () => {
    const productId = await makeProduct();
    await attachImage(productId);
    await publishProduct(productId, actor);
    await unpublishProduct(productId, actor, 'price review');

    expect(await publicCount()).toBe(0);
  });

  /**
   * Deactivating must also unpublish. Otherwise visibility depends on every
   * future reader remembering to check both columns.
   */
  it('unpublishes when a product is deactivated', async () => {
    const productId = await makeProduct();
    await attachImage(productId);
    await publishProduct(productId, actor);
    await setProductStatus(productId, 'INACTIVE', actor);

    const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(row.isPublished).toBe(false);
    expect(await publicCount()).toBe(0);
  });

  it('excludes an archived product', async () => {
    const productId = await makeProduct();
    await attachImage(productId);
    await publishProduct(productId, actor);
    await archiveProduct(productId, actor);

    expect(await publicCount()).toBe(0);
  });

  /**
   * An archived category takes its products with it, so retiring a range
   * cannot leave a product reachable by direct URL.
   */
  it('hides products whose category was deactivated', async () => {
    const productId = await makeProduct();
    await attachImage(productId);
    await publishProduct(productId, actor);
    expect(await publicCount()).toBe(1);

    await updateCategory(categoryId, { isActive: false }, actor);
    expect(await publicCount()).toBe(0);
  });

  it('never exposes an internal column through the public select', async () => {
    const productId = await makeProduct();
    await attachImage(productId);
    await publishProduct(productId, actor);

    const row = await prisma.product.findFirst({
      where: publicProductWhere(),
      select: PUBLIC_PRODUCT_SELECT,
    });

    // The select is an allowlist: adding an internal column to the schema must
    // not silently start exposing it.
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty('createdById');
    expect(row).not.toHaveProperty('updatedById');
    expect(row).not.toHaveProperty('reorderThreshold');
    expect(row).not.toHaveProperty('archivedAt');
  });

  it('hides deactivated variants from the public select', async () => {
    const productId = await makeProduct();
    await attachImage(productId);
    await prisma.productVariant.createMany({
      data: [
        { id: newId(), productId, sku: 'V-ACTIVE', name: 'Active', optionsJson: {}, isActive: true },
        { id: newId(), productId, sku: 'V-OFF', name: 'Off', optionsJson: {}, isActive: false },
      ],
    });
    await publishProduct(productId, actor);

    const row = await prisma.product.findFirstOrThrow({
      where: publicProductWhere(),
      select: PUBLIC_PRODUCT_SELECT,
    });

    expect(row.variants).toHaveLength(1);
    expect(row.variants[0]?.sku).toBe('V-ACTIVE');
  });
});

describe('archiving and history', () => {
  it('removes an archived product from live carts', async () => {
    const productId = await makeProduct();

    const cart = await prisma.cart.create({
      data: { id: newId(), currency: 'INR', status: 'ACTIVE' },
    });
    await prisma.cartItem.create({
      data: { id: newId(), cartId: cart.id, productId, variantKey: '', quantity: 10 },
    });

    await archiveProduct(productId, actor);

    expect(await prisma.cartItem.count({ where: { productId } })).toBe(0);
  });

  it('soft deletes, so order history keeps its reference', async () => {
    const productId = await makeProduct();
    await archiveProduct(productId, actor);

    // Still present - a hard delete would break every order containing it.
    const row = await prisma.product.findUnique({ where: { id: productId } });
    expect(row).not.toBeNull();
    expect(row?.archivedAt).not.toBeNull();
  });
});

describe('audit trail', () => {
  it('records a price change with explicit before and after', async () => {
    const productId = await makeProduct();
    await updateProduct(productId, { basePriceMinor: '9999' }, actor);

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'product.price_changed', resourceId: productId },
    });

    expect(entry).not.toBeNull();
    // BigInt is serialised as a string - JSON.stringify throws on it otherwise.
    expect(entry?.beforeJson).toMatchObject({ basePriceMinor: '4550' });
    expect(entry?.afterJson).toMatchObject({ basePriceMinor: '9999' });
  });

  it('does not log a price change when the price did not change', async () => {
    const productId = await makeProduct();
    await updateProduct(productId, { basePriceMinor: '4550', name: 'Renamed' }, actor);

    const count = await prisma.auditLog.count({ where: { action: 'product.price_changed' } });
    expect(count).toBe(0);
  });

  it('records publication and unpublication separately', async () => {
    const productId = await makeProduct();
    await attachImage(productId);
    await publishProduct(productId, actor);
    await unpublishProduct(productId, actor, 'price review');

    expect(await prisma.auditLog.count({ where: { action: 'product.published' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'product.unpublished' } })).toBe(1);
  });

  it('writes no audit row when the operation rolls back', async () => {
    const before = await prisma.auditLog.count();

    // A duplicate SKU aborts the transaction; the audit row must go with it.
    await makeProduct({ sku: 'ROLLBACK-TEST' });
    const afterFirst = await prisma.auditLog.count();

    await makeProduct({ sku: 'ROLLBACK-TEST' }).catch(() => undefined);
    const afterFailed = await prisma.auditLog.count();

    expect(afterFirst).toBeGreaterThan(before);
    expect(afterFailed).toBe(afterFirst);
  });
});

describe('tax class wiring', () => {
  it('uses the default tax class when none is named', async () => {
    const productId = await makeProduct();
    const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(row.taxClassId).toBe(taxClassId);
  });

  it('rejects an unknown tax class', async () => {
    await expect(
      createProduct(
        { name: 'X', sku: 'TAX-X', categoryId, basePriceMinor: '100', taxClassCode: 'NOPE' },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
