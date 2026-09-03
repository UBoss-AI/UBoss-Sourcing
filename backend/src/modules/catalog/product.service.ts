/**
 * Products.
 *
 * Publication is the operation that matters here. `publishProduct` is the only
 * way `isPublished` becomes true, and it runs the full completeness check
 * first - so an incomplete draft cannot reach the storefront by any route.
 *
 * Price changes are audited with before/after values, because SOP 5.3 requires
 * it and because "who dropped the price to 1 rupee at 3am" is a question that
 * eventually gets asked.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, badRequest, conflict, notFound, unprocessable } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { sanitiseProductHtml, stripHtml } from '../../infra/sanitize.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { slugify, validateForPublish } from './catalog.visibility.js';

export interface ProductActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface CreateProductInput {
  name: string;
  sku: string;
  categoryId: string;
  slug?: string;
  shortDescription?: string | null;
  description?: string | null;
  taxClassCode?: string;
  /** Minor units, as a string on the wire so no JS number touches money. */
  basePriceMinor: string;
  compareAtPriceMinor?: string | null;
  currency?: string;
  isStockTracked?: boolean;
  reorderThreshold?: number;
  minOrderQty?: number;
  maxOrderQty?: number | null;
  qtyIncrement?: number;
  isRecurringEligible?: boolean;
  weightGrams?: number | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  attributes?: { name: string; value: string; isFilterable?: boolean }[];
  /**
   * Rich description. Sanitised against an allowlist before storage - see
   * infra/sanitize.ts. It is stored clean so no reader has to remember to
   * clean it, which is how a stored XSS survives.
   */
  descriptionHtml?: string | null;
}

export type UpdateProductInput = Partial<Omit<CreateProductInput, 'sku'>> & { sku?: string };

async function assertSkuAvailable(
  sku: string,
  excludeId: string | null,
  tx: PrismaTransaction | typeof prisma,
): Promise<void> {
  const existing = await tx.product.findUnique({ where: { sku }, select: { id: true } });

  if (existing !== null && existing.id !== excludeId) {
    throw conflict(ErrorCode.SKU_ALREADY_EXISTS, `SKU "${sku}" is already used by another product.`, [
      { field: 'sku', code: 'DUPLICATE', meta: { sku } },
    ]);
  }

  // Variant SKUs share the same namespace: a picker or a scanner has no way to
  // tell a product SKU from a variant SKU, so they must not collide.
  const variant = await tx.productVariant.findUnique({ where: { sku }, select: { id: true } });
  if (variant !== null) {
    throw conflict(ErrorCode.SKU_ALREADY_EXISTS, `SKU "${sku}" is already used by a variant.`, [
      { field: 'sku', code: 'DUPLICATE_VARIANT', meta: { sku } },
    ]);
  }
}

async function assertProductSlugAvailable(
  slug: string,
  excludeId: string | null,
  tx: PrismaTransaction | typeof prisma,
): Promise<void> {
  const existing = await tx.product.findUnique({ where: { slug }, select: { id: true } });

  if (existing !== null && existing.id !== excludeId) {
    throw conflict(ErrorCode.SLUG_ALREADY_EXISTS, `The URL slug "${slug}" is already in use.`, [
      { field: 'slug', code: 'DUPLICATE', meta: { slug } },
    ]);
  }
}

/** Money arrives as a decimal string and is parsed to BigInt minor units here. */
function parseMinor(value: string, field: string): bigint {
  if (!/^\d+$/.test(value.trim())) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Amounts must be whole minor units.', [
      { field, code: 'INVALID_MONEY', message: 'Expected an integer number of minor units.' },
    ]);
  }
  return BigInt(value.trim());
}

export async function createProduct(
  input: CreateProductInput,
  actor: ProductActor,
): Promise<{ id: string; slug: string; sku: string }> {
  const slug = slugify(input.slug ?? input.name);
  const sku = input.sku.trim().toUpperCase();

  if (slug.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Could not derive a URL slug from that name.', [
      { field: 'slug', code: 'EMPTY_SLUG' },
    ]);
  }

  return prisma.$transaction(async (tx) => {
    await assertSkuAvailable(sku, null, tx);
    await assertProductSlugAvailable(slug, null, tx);

    const category = await tx.category.findUnique({
      where: { id: input.categoryId },
      select: { id: true, archivedAt: true },
    });
    if (category === null || category.archivedAt !== null) throw notFound('Category');

    const taxClass = await tx.taxClass.findFirst({
      where:
        input.taxClassCode === undefined
          ? { isDefault: true, isActive: true }
          : { code: input.taxClassCode, isActive: true },
      select: { id: true, code: true },
    });

    if (taxClass === null) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        input.taxClassCode === undefined
          ? 'No default tax class is configured. Set one in Settings before creating products.'
          : `Tax class "${input.taxClassCode}" was not found or is inactive.`,
        [{ field: 'taxClassCode', code: 'NOT_FOUND' }],
      );
    }

    const business = await tx.businessProfile.findFirst({ select: { currency: true } });
    const id = newId();

    await tx.product.create({
      data: {
        id,
        categoryId: input.categoryId,
        taxClassId: taxClass.id,
        name: input.name.trim(),
        slug,
        sku,
        // Plain-text fields are stripped of markup entirely; the rich field is
        // allowlist-sanitised. Both happen on WRITE.
        shortDescription: stripHtml(input.shortDescription),
        description: input.description ?? null,
        descriptionHtml: sanitiseProductHtml(input.descriptionHtml),
        basePriceMinor: parseMinor(input.basePriceMinor, 'basePriceMinor'),
        compareAtPriceMinor:
          input.compareAtPriceMinor === null || input.compareAtPriceMinor === undefined
            ? null
            : parseMinor(input.compareAtPriceMinor, 'compareAtPriceMinor'),
        currency: input.currency ?? business?.currency ?? 'INR',
        isStockTracked: input.isStockTracked ?? true,
        reorderThreshold: input.reorderThreshold ?? 0,
        minOrderQty: input.minOrderQty ?? 1,
        maxOrderQty: input.maxOrderQty ?? null,
        qtyIncrement: input.qtyIncrement ?? 1,
        isRecurringEligible: input.isRecurringEligible ?? false,
        weightGrams: input.weightGrams ?? null,
        metaTitle: stripHtml(input.metaTitle),
        metaDescription: stripHtml(input.metaDescription),
        // Always DRAFT and unpublished. Publication is a separate, audited,
        // separately permissioned action.
        status: 'DRAFT',
        isPublished: false,
        createdById: actor.userId,
        updatedById: actor.userId,
        ...(input.attributes !== undefined && input.attributes.length > 0
          ? {
              attributes: {
                create: input.attributes.map((attribute, index) => ({
                  id: newId(),
                  name: attribute.name,
                  value: attribute.value,
                  sortOrder: index,
                  isFilterable: attribute.isFilterable ?? false,
                })),
              },
            }
          : {}),
      },
    });

    await recordAudit(
      {
        action: AuditAction.PRODUCT_CREATED,
        resourceType: 'product',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { name: input.name, sku, slug, basePriceMinor: input.basePriceMinor },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    return { id, slug, sku };
  });
}

export async function updateProduct(
  productId: string,
  input: UpdateProductInput,
  actor: ProductActor,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.product.findUnique({
      where: { id: productId },
      include: { taxClass: { select: { code: true } } },
    });

    if (existing === null || existing.archivedAt !== null) throw notFound('Product');

    const data: Prisma.ProductUncheckedUpdateInput = { updatedById: actor.userId };

    if (input.name !== undefined) data.name = input.name.trim();
    if (input.shortDescription !== undefined) {
      data.shortDescription = stripHtml(input.shortDescription);
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.descriptionHtml !== undefined) {
      data.descriptionHtml = sanitiseProductHtml(input.descriptionHtml);
    }
    if (input.isStockTracked !== undefined) data.isStockTracked = input.isStockTracked;
    if (input.reorderThreshold !== undefined) data.reorderThreshold = input.reorderThreshold;
    if (input.minOrderQty !== undefined) data.minOrderQty = input.minOrderQty;
    if (input.maxOrderQty !== undefined) data.maxOrderQty = input.maxOrderQty;
    if (input.qtyIncrement !== undefined) data.qtyIncrement = input.qtyIncrement;
    if (input.isRecurringEligible !== undefined) data.isRecurringEligible = input.isRecurringEligible;
    if (input.weightGrams !== undefined) data.weightGrams = input.weightGrams;
    if (input.metaTitle !== undefined) data.metaTitle = stripHtml(input.metaTitle);
    if (input.metaDescription !== undefined) {
      data.metaDescription = stripHtml(input.metaDescription);
    }

    if (input.sku !== undefined) {
      const sku = input.sku.trim().toUpperCase();
      await assertSkuAvailable(sku, productId, tx);
      data.sku = sku;
    }

    if (input.slug !== undefined) {
      const slug = slugify(input.slug);
      await assertProductSlugAvailable(slug, productId, tx);
      data.slug = slug;
    }

    if (input.categoryId !== undefined) {
      const category = await tx.category.findUnique({
        where: { id: input.categoryId },
        select: { id: true, archivedAt: true },
      });
      if (category === null || category.archivedAt !== null) throw notFound('Category');
      data.categoryId = input.categoryId;
    }

    if (input.taxClassCode !== undefined) {
      const taxClass = await tx.taxClass.findFirst({
        where: { code: input.taxClassCode, isActive: true },
        select: { id: true },
      });
      if (taxClass === null) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'That tax class was not found or is inactive.', [
          { field: 'taxClassCode', code: 'NOT_FOUND' },
        ]);
      }
      data.taxClassId = taxClass.id;
    }

    let priceChanged = false;
    let newPrice: bigint | null = null;

    if (input.basePriceMinor !== undefined) {
      newPrice = parseMinor(input.basePriceMinor, 'basePriceMinor');
      priceChanged = newPrice !== existing.basePriceMinor;
      data.basePriceMinor = newPrice;
    }

    if (input.compareAtPriceMinor !== undefined) {
      data.compareAtPriceMinor =
        input.compareAtPriceMinor === null
          ? null
          : parseMinor(input.compareAtPriceMinor, 'compareAtPriceMinor');
    }

    await tx.product.update({ where: { id: productId }, data });

    // Specifications are replace-the-set: the list that arrives is the list the
    // product has afterwards. Omitting the field leaves them untouched, which is
    // what lets a price-only edit stay a price-only edit; sending an empty array
    // clears them. Rows are rewritten rather than diffed because nothing
    // references an attribute id, and rewriting makes sortOrder trivially match
    // the order the editor showed.
    if (input.attributes !== undefined) {
      await tx.productAttribute.deleteMany({ where: { productId } });

      if (input.attributes.length > 0) {
        await tx.productAttribute.createMany({
          data: input.attributes.map((attribute, index) => ({
            id: newId(),
            productId,
            name: attribute.name,
            value: attribute.value,
            sortOrder: index,
            isFilterable: attribute.isFilterable ?? false,
          })),
        });
      }
    }

    // A price change gets its own audit entry with explicit before/after.
    // Burying it inside a general "updated" event makes it far harder to answer
    // "what was this priced at when that order was placed?".
    if (priceChanged && newPrice !== null) {
      await recordAudit(
        {
          action: AuditAction.PRODUCT_PRICE_CHANGED,
          resourceType: 'product',
          resourceId: productId,
          actorType: 'ADMIN',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          before: { basePriceMinor: existing.basePriceMinor, currency: existing.currency },
          after: { basePriceMinor: newPrice, currency: existing.currency },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
    }

    await recordAudit(
      {
        action: AuditAction.PRODUCT_UPDATED,
        resourceType: 'product',
        resourceId: productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          name: existing.name,
          sku: existing.sku,
          slug: existing.slug,
          categoryId: existing.categoryId,
          taxClassCode: existing.taxClass.code,
        },
        after: input,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/**
 * Publish a product.
 *
 * Runs the completeness check and returns every blocker at once, so the Admin
 * Panel can render a checklist rather than one error per attempt.
 */
export async function publishProduct(
  productId: string,
  actor: ProductActor,
): Promise<{ publishedAt: Date }> {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      include: {
        category: { select: { isActive: true, archivedAt: true } },
        _count: {
          select: {
            media: true,
            variants: { where: { isActive: true, archivedAt: null } },
          },
        },
      },
    });

    if (product === null || product.archivedAt !== null) throw notFound('Product');

    if (product.isPublished && product.status === 'ACTIVE') {
      throw conflict(ErrorCode.CONFLICT, 'This product is already published.');
    }

    const blockers = validateForPublish({
      name: product.name,
      slug: product.slug,
      sku: product.sku,
      shortDescription: product.shortDescription,
      description: product.description,
      basePriceMinor: product.basePriceMinor,
      minOrderQty: product.minOrderQty,
      maxOrderQty: product.maxOrderQty,
      qtyIncrement: product.qtyIncrement,
      hasVariants: product.hasVariants,
      mediaCount: product._count.media,
      activeVariantCount: product._count.variants,
      categoryIsActive: product.category.isActive && product.category.archivedAt === null,
    });

    if (blockers.length > 0) {
      throw unprocessable(
        ErrorCode.PRODUCT_INCOMPLETE_FOR_PUBLISH,
        'This product is not ready to publish.',
        blockers.map((blocker) => ({
          field: blocker.field,
          code: blocker.code,
          message: blocker.message,
        })),
      );
    }

    const publishedAt = new Date();

    await tx.product.update({
      where: { id: productId },
      data: {
        status: 'ACTIVE',
        isPublished: true,
        publishedAt: product.publishedAt ?? publishedAt,
        updatedById: actor.userId,
      },
    });

    await recordAudit(
      {
        action: AuditAction.PRODUCT_PUBLISHED,
        resourceType: 'product',
        resourceId: productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: product.status, isPublished: product.isPublished },
        after: { status: 'ACTIVE', isPublished: true, publishedAt: publishedAt.toISOString() },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    return { publishedAt };
  });
}

/**
 * Unpublish a product.
 *
 * Stops new purchases. Deliberately leaves order history untouched (SOP 5.3):
 * historical orders keep their own item snapshots, so an unpublished product
 * never rewrites what a customer already bought.
 */
export async function unpublishProduct(
  productId: string,
  actor: ProductActor,
  reason?: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (product === null || product.archivedAt !== null) throw notFound('Product');

    await tx.product.update({
      where: { id: productId },
      data: { isPublished: false, updatedById: actor.userId },
    });

    await recordAudit(
      {
        action: AuditAction.PRODUCT_UNPUBLISHED,
        resourceType: 'product',
        resourceId: productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { isPublished: product.isPublished },
        after: { isPublished: false, reason: reason ?? null },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

export async function setProductStatus(
  productId: string,
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE',
  actor: ProductActor,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (product === null || product.archivedAt !== null) throw notFound('Product');

    await tx.product.update({
      where: { id: productId },
      data: {
        status,
        // Deactivating must also unpublish. Leaving isPublished true on an
        // INACTIVE row would rely on every future reader remembering to check
        // both, which is precisely the mistake publicProductWhere guards.
        ...(status === 'ACTIVE' ? {} : { isPublished: false }),
        updatedById: actor.userId,
      },
    });

    await recordAudit(
      {
        action: AuditAction.PRODUCT_UPDATED,
        resourceType: 'product',
        resourceId: productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: product.status, isPublished: product.isPublished },
        after: { status, isPublished: status === 'ACTIVE' ? product.isPublished : false },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/**
 * Archive a product.
 *
 * Soft delete: `order_items` references survive, so historical orders keep
 * working. A hard delete would break every order that ever contained it.
 */
export async function archiveProduct(productId: string, actor: ProductActor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (product === null || product.archivedAt !== null) throw notFound('Product');

    await tx.product.update({
      where: { id: productId },
      data: {
        archivedAt: new Date(),
        isPublished: false,
        status: 'INACTIVE',
        updatedById: actor.userId,
      },
    });

    // Remove it from live carts. Leaving it there would surface a confusing
    // "no longer available" line at checkout for every affected customer.
    await tx.cartItem.deleteMany({ where: { productId } });

    await recordAudit(
      {
        action: AuditAction.PRODUCT_ARCHIVED,
        resourceType: 'product',
        resourceId: productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { name: product.name, sku: product.sku, isPublished: product.isPublished },
        after: { archivedAt: new Date().toISOString() },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}
