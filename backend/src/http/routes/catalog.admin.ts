/**
 * Admin catalog routes.
 *
 * Every route names the permission it needs. `product.publish` is separate from
 * `product.write` on purpose: editing a draft and making it publicly buyable
 * are different levels of authority, and the SOP grants them separately.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { Permission } from '../../domain/permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  assertWithinSizeLimit,
  sniffImageType,
  storage,
} from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../../modules/audit/audit.service.js';
import {
  confirmProductImport,
  createProductImportDryRun,
  getImportJob,
  listImportJobs,
  productImportColumnHelp,
  productImportTemplate,
} from '../../modules/catalog/import.service.js';
import {
  archiveCategory,
  createCategory,
  listCategoryTree,
  updateCategory,
} from '../../modules/catalog/category.service.js';
import { currenciesForProduct, writeProductPrices } from '../../modules/catalog/price.service.js';
import { getBaseCurrency, listActiveCurrencies } from '../../modules/settings/currency.service.js';
import {
  archiveProduct,
  createProduct,
  publishProduct,
  setProductStatus,
  unpublishProduct,
  updateProduct,
} from '../../modules/catalog/product.service.js';
import {
  archiveVariant,
  createVariant,
  listVariants,
  updateVariant,
} from '../../modules/catalog/variant.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';
import type { FastifyRequest } from 'fastify';

/** Money on the wire is a string of minor units - never a JS number. */
const minorUnits = z.string().regex(/^\d+$/, 'Expected whole minor units, e.g. "149950".');

const categoryBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  slug: z.string().trim().max(255).optional(),
  parentId: z.string().length(26).nullable().optional(),
  description: z.string().max(20_000).nullable().optional(),
  imageMediaId: z.string().length(26).nullable().optional(),
  bannerMediaId: z.string().length(26).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  metaTitle: z.string().max(255).nullable().optional(),
  metaDescription: z.string().max(512).nullable().optional(),
});

/**
 * Product specifications - the name/value rows a customer reads under
 * "Specifications", and the same rows that drive faceted filtering when a row
 * is marked filterable.
 *
 * Exported so the duplicate-name rule can be tested directly. It is a rule
 * worth testing: `uq_product_attribute_name` would reject a repeat anyway, but
 * as a driver error carrying no field, which the editor cannot attach to a row.
 */
export const productAttributesSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(128),
      value: z.string().trim().min(1).max(512),
      isFilterable: z.boolean().optional(),
    }),
  )
  .max(50)
  // Case-insensitive, because the column's collation is: to MariaDB,
  // "Material" and "material" are already the same name.
  .superRefine((rows, ctx) => {
    const seen = new Map<string, number>();

    rows.forEach((row, index) => {
      const key = row.name.trim().toLocaleLowerCase();
      const first = seen.get(key);

      if (first === undefined) {
        seen.set(key, index);
        return;
      }

      ctx.addIssue({
        code: 'custom',
        path: [index, 'name'],
        message: `"${row.name}" is already used by specification ${String(first + 1)}. Each name may appear once.`,
      });
    });
  });

const productBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  sku: z.string().trim().min(1).max(64),
  categoryId: z.string().length(26),
  slug: z.string().trim().max(255).optional(),
  shortDescription: z.string().max(1024).nullable().optional(),
  description: z.string().max(50_000).nullable().optional(),
  // Sanitised server-side against an allowlist before storage.
  descriptionHtml: z.string().max(100_000).nullable().optional(),
  taxClassCode: z.string().max(32).optional(),
  basePriceMinor: minorUnits,
  compareAtPriceMinor: minorUnits.nullable().optional(),
  currency: z.string().length(3).optional(),
  isStockTracked: z.boolean().optional(),
  reorderThreshold: z.number().int().min(0).max(1_000_000).optional(),
  minOrderQty: z.number().int().min(1).max(1_000_000).optional(),
  maxOrderQty: z.number().int().min(1).max(1_000_000).nullable().optional(),
  qtyIncrement: z.number().int().min(1).max(1_000_000).optional(),
  isRecurringEligible: z.boolean().optional(),
  weightGrams: z.number().int().min(0).max(10_000_000).nullable().optional(),
  metaTitle: z.string().max(255).nullable().optional(),
  metaDescription: z.string().max(512).nullable().optional(),
  attributes: productAttributesSchema.optional(),
});

const idParam = z.object({ id: z.string().length(26) });

/**
 * A product's price in every currency it is sold in.
 *
 * Amounts are digit strings of minor units. A JSON number has already lost
 * precision by the time it is parsed, and a paisa-exact total can exceed 2^53.
 */
const productPricesSchema = z.object({
  prices: z
    .array(
      z.object({
        currencyCode: z.string().trim().length(3),
        // Transformed here rather than on the shared `minorUnits`, which other
        // routes on this file consume as a string.
        basePriceMinor: minorUnits.transform((value) => BigInt(value)),
        compareAtPriceMinor: minorUnits
          .transform((value) => BigInt(value))
          .nullable()
          .optional(),
      }),
    )
    .max(20),
});

const adminProductQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(120).optional(),
  categoryId: z.string().length(26).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).optional(),
  published: z.enum(['true', 'false']).optional(),
  includeArchived: z.enum(['true', 'false']).default('false'),
});

function actorFrom(request: FastifyRequest): {
  userId: string;
  email: string;
  ipAddress: string;
  correlationId: string;
} {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

export function registerAdminCatalogRoutes(app: FastifyInstance): Promise<void> {
  // --- Categories ----------------------------------------------------------

  app.get(
    '/categories',
    { preHandler: requireAdmin(Permission.CATEGORY_READ) },
    async (_request, reply) => {
      // Admins see drafts too; the storefront tree hides them.
      const tree = await listCategoryTree({ includeInactive: true });
      return reply.status(200).send({ categories: tree });
    },
  );

  app.post(
    '/categories',
    { preHandler: requireAdmin(Permission.CATEGORY_WRITE) },
    async (request, reply) => {
      const body = categoryBodySchema.parse(request.body);
      const created = await createCategory(body, actorFrom(request));
      return reply.status(201).send(created);
    },
  );

  app.patch(
    '/categories/:id',
    { preHandler: requireAdmin(Permission.CATEGORY_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = categoryBodySchema.partial().parse(request.body);
      await updateCategory(id, body, actorFrom(request));
      return reply.status(200).send({ updated: true });
    },
  );

  app.delete(
    '/categories/:id',
    { preHandler: requireAdmin(Permission.CATEGORY_ARCHIVE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { force } = z
        .object({ force: z.enum(['true', 'false']).default('false') })
        .parse(request.query);

      const result = await archiveCategory(id, actorFrom(request), {
        force: force === 'true',
      });
      return reply.status(200).send(result);
    },
  );

  // --- Products ------------------------------------------------------------

  app.get(
    '/products',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (request, reply) => {
      const query = adminProductQuerySchema.parse(request.query);

      const where = {
        ...(query.includeArchived === 'true' ? {} : { archivedAt: null }),
        ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.published !== undefined ? { isPublished: query.published === 'true' } : {}),
        ...(query.q !== undefined && query.q.length > 0
          ? { OR: [{ name: { contains: query.q } }, { sku: { contains: query.q } }] }
          : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.product.findMany({
          where,
          // `id` as a tiebreaker keeps pagination stable across pages.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          select: {
            id: true,
            name: true,
            slug: true,
            sku: true,
            status: true,
            isPublished: true,
            publishedAt: true,
            basePriceMinor: true,
            currency: true,
            isStockTracked: true,
            reorderThreshold: true,
            archivedAt: true,
            createdAt: true,
            category: { select: { id: true, name: true } },
            _count: { select: { media: true, variants: true } },
          },
        }),
        prisma.product.count({ where }),
      ]);

      return reply.status(200).send({
        products: rows.map((row) => ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          sku: row.sku,
          status: row.status,
          isPublished: row.isPublished,
          publishedAt: row.publishedAt?.toISOString() ?? null,
          price: serialiseMoney(row.basePriceMinor, row.currency),
          isStockTracked: row.isStockTracked,
          reorderThreshold: row.reorderThreshold,
          archivedAt: row.archivedAt?.toISOString() ?? null,
          category: row.category,
          mediaCount: row._count.media,
          variantCount: row._count.variants,
          createdAt: row.createdAt.toISOString(),
        })),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      });
    },
  );

  app.get(
    '/products/:id',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      const product = await prisma.product.findUnique({
        where: { id },
        include: {
          category: { select: { id: true, name: true, slug: true, isActive: true } },
          taxClass: { select: { code: true, name: true, ratePercent: true, isInclusive: true } },
          media: {
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
            select: {
              id: true,
              sortOrder: true,
              isPrimary: true,
              media: { select: { id: true, url: true, altText: true, width: true, height: true } },
            },
          },
          attributes: { orderBy: { sortOrder: 'asc' } },
          variants: { orderBy: { sortOrder: 'asc' } },
        },
      });

      if (product === null) throw notFound('Product');

      return reply.status(200).send({
        product: {
          ...product,
          basePriceMinor: product.basePriceMinor.toString(),
          compareAtPriceMinor: product.compareAtPriceMinor?.toString() ?? null,
          price: serialiseMoney(product.basePriceMinor, product.currency),
          taxClass: {
            ...product.taxClass,
            ratePercent: product.taxClass.ratePercent.toString(),
          },
          // Flattened, because the join row and the asset are two tables but one
          // idea to the editor. `mediaId` is deliberately the MediaAsset id, not
          // the join row's: it is what DELETE /products/:id/media/:mediaId takes.
          media: product.media.map((row) => ({
            mediaId: row.media.id,
            url: row.media.url,
            altText: row.media.altText,
            width: row.media.width,
            height: row.media.height,
            isPrimary: row.isPrimary,
            sortOrder: row.sortOrder,
          })),
          variants: product.variants.map((variant) => ({
            ...variant,
            priceMinor: variant.priceMinor?.toString() ?? null,
          })),
        },
      });
    },
  );

  app.post(
    '/products',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const body = productBodySchema.parse(request.body);
      const created = await createProduct(body, actorFrom(request));
      return reply.status(201).send(created);
    },
  );

  app.patch(
    '/products/:id',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = productBodySchema.partial().parse(request.body);
      await updateProduct(id, body, actorFrom(request));
      return reply.status(200).send({ updated: true });
    },
  );

  /**
   * Per-currency prices for one product.
   *
   * Returns every active currency, with the price where one exists and null
   * where it does not, so the editor can show the full grid rather than making
   * staff guess which markets are missing. A null is meaningful: the product is
   * simply not sold there.
   */
  app.get(
    '/products/:id/prices',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      const product = await prisma.product.findUnique({
        where: { id },
        select: { id: true, name: true, sku: true },
      });
      if (product === null) throw notFound('Product');

      const currencies = await listActiveCurrencies();

      const rows = await prisma.productPrice.findMany({
        where: { productId: id, variantKey: '' },
        select: { currencyCode: true, basePriceMinor: true, compareAtPriceMinor: true },
      });
      const byCurrency = new Map(rows.map((row) => [row.currencyCode, row]));

      return reply.status(200).send({
        product,
        baseCurrency: await getBaseCurrency(),
        prices: currencies.map((currency) => {
          const row = byCurrency.get(currency.code);

          return {
            currency,
            basePriceMinor: row?.basePriceMinor.toString() ?? null,
            compareAtPriceMinor: row?.compareAtPriceMinor?.toString() ?? null,
            price: row === undefined ? null : serialiseMoney(row.basePriceMinor, currency.code),
          };
        }),
      });
    },
  );

  /**
   * Replace the price set.
   *
   * Currencies omitted from the body are withdrawn, which is how a product
   * leaves a market. Prices are absolute figures per currency, never converted
   * from one another.
   */
  app.put(
    '/products/:id/prices',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = productPricesSchema.parse(request.body);
      const actor = actorFrom(request);

      const product = await prisma.product.findUnique({ where: { id }, select: { id: true } });
      if (product === null) throw notFound('Product');

      const before = await currenciesForProduct(id);

      await writeProductPrices(id, null, body.prices, await getBaseCurrency(), actor.userId);

      await recordAudit({
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        ipAddress: actor.ipAddress,
        correlationId: actor.correlationId,
        action: AuditAction.PRODUCT_PRICE_CHANGED,
        resourceType: 'product',
        resourceId: id,
        before: { currencies: before },
        after: {
          currencies: body.prices.map((price) => price.currencyCode),
          amounts: Object.fromEntries(
            body.prices.map((price) => [price.currencyCode, price.basePriceMinor.toString()]),
          ),
        },
      });

      return reply.status(200).send({ updated: true });
    },
  );

  /**
   * Publication.
   *
   * Requires `product.publish`, which a Catalog Manager holds but an Inventory
   * or Order Manager does not.
   */
  app.patch(
    '/products/:id/publication',
    { preHandler: requireAdmin(Permission.PRODUCT_PUBLISH) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          publish: z.boolean(),
          reason: z.string().max(512).optional(),
        })
        .parse(request.body);

      if (body.publish) {
        const result = await publishProduct(id, actorFrom(request));
        return reply.status(200).send({
          isPublished: true,
          publishedAt: result.publishedAt.toISOString(),
        });
      }

      await unpublishProduct(id, actorFrom(request), body.reason);
      return reply.status(200).send({ isPublished: false });
    },
  );

  app.patch(
    '/products/:id/status',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { status } = z
        .object({ status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']) })
        .parse(request.body);

      await setProductStatus(id, status, actorFrom(request));
      return reply.status(200).send({ status });
    },
  );

  app.delete(
    '/products/:id',
    { preHandler: requireAdmin(Permission.PRODUCT_ARCHIVE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await archiveProduct(id, actorFrom(request));
      return reply.status(200).send({ archived: true });
    },
  );

  // --- Variants ------------------------------------------------------------

  const variantBody = z.object({
    sku: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(255),
    options: z.record(z.string().max(64), z.string().max(128)),
    // Absolute price. Null means "use the product base price".
    priceMinor: minorUnits.nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  });

  app.get(
    '/products/:id/variants',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send({ variants: await listVariants(id) });
    },
  );

  app.post(
    '/products/:id/variants',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const created = await createVariant(id, variantBody.parse(request.body), actorFrom(request));
      return reply.status(201).send(created);
    },
  );

  app.patch(
    '/products/:id/variants/:variantId',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().length(26), variantId: z.string().length(26) })
        .parse(request.params);

      await updateVariant(
        params.id,
        params.variantId,
        variantBody.partial().parse(request.body),
        actorFrom(request),
      );

      return reply.status(200).send({ updated: true });
    },
  );

  app.delete(
    '/products/:id/variants/:variantId',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().length(26), variantId: z.string().length(26) })
        .parse(request.params);

      // `deleted: false` means it was archived rather than removed, because
      // orders or schedules reference it.
      const result = await archiveVariant(params.id, params.variantId, actorFrom(request));
      return reply.status(200).send(result);
    },
  );

  // --- Media ---------------------------------------------------------------

  /**
   * Upload a product image.
   *
   * The client's Content-Type and filename are both ignored. The real type is
   * sniffed from magic bytes and the stored key is generated, so neither a
   * spoofed MIME type nor a traversal filename has anywhere to go.
   */
  app.post(
    '/products/:id/media',
    { preHandler: requireAdmin(Permission.MEDIA_UPLOAD) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      const product = await prisma.product.findUnique({
        where: { id },
        select: { id: true, archivedAt: true },
      });
      if (product === null || product.archivedAt !== null) throw notFound('Product');

      const file = await request.file({ limits: { fileSize: 10 * 1024 * 1024 } });
      if (file === undefined) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'No file was uploaded.', [
          { field: 'file', code: 'REQUIRED' },
        ]);
      }

      const buffer = await file.toBuffer();
      assertWithinSizeLimit(buffer.byteLength);

      const sniffed = sniffImageType(buffer);
      const stored = await storage.put(buffer, sniffed.mimeType, sniffed.extension);

      const altTextField = file.fields['altText'];
      const altText =
        altTextField !== undefined && 'value' in altTextField && typeof altTextField.value === 'string'
          ? altTextField.value.slice(0, 512)
          : null;

      const actor = actorFrom(request);

      const result = await prisma.$transaction(async (tx) => {
        const mediaId = newId();

        await tx.mediaAsset.create({
          data: {
            id: mediaId,
            storageKey: stored.storageKey,
            url: stored.url,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
            width: stored.width ?? null,
            height: stored.height ?? null,
            altText,
            checksum: stored.checksum,
            uploadedById: actor.userId,
          },
        });

        const existingCount = await tx.productMedia.count({ where: { productId: id } });

        await tx.productMedia.create({
          data: {
            id: newId(),
            productId: id,
            mediaId,
            sortOrder: existingCount,
            // The first image uploaded becomes the primary one, so a product
            // always has a usable thumbnail without an extra admin step.
            isPrimary: existingCount === 0,
          },
        });

        await recordAudit(
          {
            action: AuditAction.PRODUCT_UPDATED,
            resourceType: 'product',
            resourceId: id,
            actorType: 'ADMIN',
            actorUserId: actor.userId,
            actorEmail: actor.email,
            after: { mediaAdded: mediaId, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes },
            ipAddress: actor.ipAddress,
            correlationId: actor.correlationId,
          },
          tx,
        );

        return { mediaId, url: stored.url };
      });

      return reply.status(201).send({
        mediaId: result.mediaId,
        url: result.url,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        width: stored.width ?? null,
        height: stored.height ?? null,
      });
    },
  );

  app.delete(
    '/products/:id/media/:mediaId',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().length(26), mediaId: z.string().length(26) })
        .parse(request.params);

      const link = await prisma.productMedia.findFirst({
        where: { productId: params.id, mediaId: params.mediaId },
        include: { media: { select: { storageKey: true } } },
      });

      if (link === null) throw notFound('Product image');

      await prisma.$transaction(async (tx) => {
        await tx.productMedia.delete({ where: { id: link.id } });

        // If the primary image was removed, promote the next one so the product
        // does not silently lose its thumbnail.
        if (link.isPrimary) {
          const next = await tx.productMedia.findFirst({
            where: { productId: params.id },
            orderBy: { sortOrder: 'asc' },
          });
          if (next !== null) {
            await tx.productMedia.update({ where: { id: next.id }, data: { isPrimary: true } });
          }
        }

        await tx.mediaAsset.delete({ where: { id: params.mediaId } });
      });

      // Delete the bytes only after the rows are committed. The other order
      // risks a committed row pointing at a file that no longer exists.
      await storage.delete(link.media.storageKey);

      return reply.status(200).send({ deleted: true });
    },
  );

  // --- Bulk product import -------------------------------------------------
  //
  // The upload never writes. It produces a preview job; a separate confirm
  // applies it. Two calls rather than one because an administrator must be
  // able to see what a spreadsheet is about to do to a live catalogue.

  /** The template, with a worked example row. */
  app.get(
    '/products/import/template',
    { preHandler: requireAdmin(Permission.PRODUCT_IMPORT) },
    async (_request, reply) => {
      const csv = productImportTemplate();

      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="uboss-product-import-template.csv"')
        .status(200)
        .send(csv);
    },
  );

  /** Column documentation, so the UI does not restate the rules and drift. */
  app.get(
    '/products/import/columns',
    { preHandler: requireAdmin(Permission.PRODUCT_IMPORT) },
    async (_request, reply) =>
      reply.status(200).send({ columns: productImportColumnHelp() }),
  );

  /** Upload and preview. Writes nothing to the catalogue. */
  app.post(
    '/products/import',
    {
      preHandler: requireAdmin(Permission.PRODUCT_IMPORT),
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const file = await request.file({ limits: { fileSize: 8 * 1024 * 1024 } });

      if (file === undefined) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'No file was uploaded.', [
          { field: 'file', code: 'REQUIRED' },
        ]);
      }

      const buffer = await file.toBuffer();

      if (buffer.byteLength === 0) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'The uploaded file is empty.', [
          { field: 'file', code: 'EMPTY' },
        ]);
      }

      const result = await createProductImportDryRun(
        { fileName: file.filename, content: buffer },
        actorFrom(request),
      );

      // 200, not 201: the preview created a job, but nothing in the catalogue.
      return reply.status(200).send(await getImportJob(result.importJobId));
    },
  );

  /** Apply a previewed import. */
  app.post(
    '/products/import/:id/confirm',
    {
      preHandler: requireAdmin(Permission.PRODUCT_IMPORT),
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ skipInvalidRows: z.boolean().default(false) })
        .parse(request.body ?? {});

      const result = await confirmProductImport(id, body, actorFrom(request));

      return reply.status(200).send(await getImportJob(result.importJobId));
    },
  );

  app.get(
    '/products/import',
    { preHandler: requireAdmin(Permission.PRODUCT_IMPORT) },
    async (request, reply) => {
      const { limit } = z
        .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
        .parse(request.query);

      return reply.status(200).send({ jobs: await listImportJobs(limit) });
    },
  );

  app.get(
    '/products/import/:id',
    { preHandler: requireAdmin(Permission.PRODUCT_IMPORT) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { page, limit } = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);

      return reply.status(200).send(await getImportJob(id, page, limit));
    },
  );

  return Promise.resolve();
}
