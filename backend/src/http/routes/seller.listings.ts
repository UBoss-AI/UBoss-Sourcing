/**
 * The listings page and the listing wizard.
 *
 * Two shapes of thing live under one prefix because a seller thinks of them as
 * one screen: `/listings` is the table of live offers, `/listing-drafts` is the
 * wizard. They are separate rows in the database for a reason worth restating -
 * a draft may be invalid and an offer may not - but the interface presents them
 * as tabs over one list, so the tab counts come back from both.
 *
 * Every route resolves the seller from the session. A draft id in a URL is
 * checked against that seller and answers 404 when it belongs to somebody else.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  checkBrandName,
  listBrandRequests,
  recentBrands,
  requestBrand,
  searchBrands,
  withdrawBrandRequest,
} from '../../modules/seller/brand.service.js';
import {
  createDraft,
  listDrafts,
  previewTitle,
  readDraft,
  saveDraft,
  submitDraft,
  validateDraft,
  withdrawDraft,
} from '../../modules/seller/listing-draft.service.js';
import { loadListingSchema } from '../../modules/seller/listing-schema.service.js';
import {
  deleteListingMedia,
  listListingMedia,
  updateListingMedia,
  uploadListingMedia,
} from '../../modules/seller/media.service.js';
import {
  duplicateOffer,
  listOffers,
  readOffer,
  setOfferStatus,
  updateOfferPrice,
} from '../../modules/seller/offer.service.js';
import { currentSeller, requireSeller, requireTradingSeller } from '../plugins/seller.js';

const idParam = z.object({ id: z.string().length(26) });

/**
 * A money field on the wire.
 *
 * A STRING of minor units, never a number. The rule the whole codebase
 * follows: a wholesale price in paise exceeds JavaScript's safe integer range
 * for figures sellers genuinely quote, and `JSON.parse` loses the low digits
 * before any validation could catch it.
 */
const minorUnits = z.string().regex(/^\d+$/, 'Expected whole minor units as a string.');

const draftOfferSchema = z.object({
  priceMinor: minorUnits.nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
  compareAtPriceMinor: minorUnits.nullable().optional(),
  taxClassId: z.string().length(26).nullable().optional(),
  orderingUnit: z.string().trim().max(24).nullable().optional(),
  minimumOrderQuantity: z.number().int().min(1).max(1_000_000).nullable().optional(),
  orderIncrement: z.number().int().min(1).max(1_000_000).nullable().optional(),
  maximumOrderQuantity: z.number().int().min(1).max(10_000_000).nullable().optional(),
  handlingTimeDays: z.number().int().min(0).max(365).nullable().optional(),
  guaranteedShelfLifeMonths: z.number().int().min(0).max(600).nullable().optional(),
  warrantyMonths: z.number().int().min(0).max(600).nullable().optional(),
  sellingRegions: z.array(z.string().trim().length(2).toUpperCase()).max(250).nullable().optional(),
  priceTiers: z
    .array(z.object({ minQuantity: z.number().int().min(2), priceMinor: minorUnits }))
    .max(20)
    .nullable()
    .optional(),
});

const draftPatchSchema = z.object({
  categoryId: z.string().length(26).nullable().optional(),
  brandId: z.string().length(26).nullable().optional(),
  matchedProductId: z.string().length(26).nullable().optional(),
  sellerSku: z.string().trim().min(1).max(64).nullable().optional(),
  /**
   * Whatever the category's schema asks for.
   *
   * Not typed further here on purpose: the field list is a database row, so a
   * Zod shape would be a second copy of it that drifts. Every value is checked
   * against its own definition in `evaluateListing` - which is where the
   * checking belongs, because that is also where the seller's counters come
   * from.
   */
  attributes: z.record(z.string().max(64), z.unknown()).nullable().optional(),
  offer: draftOfferSchema.nullable().optional(),
  stock: z
    .array(
      z.object({
        locationId: z.string().length(26),
        availableQuantity: z.number().int().min(0).max(100_000_000),
        reorderThreshold: z.number().int().min(0).nullable().optional(),
        batchNumber: z.string().trim().max(64).nullable().optional(),
        expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      }),
    )
    .max(100)
    .nullable()
    .optional(),
  packaging: z
    .object({
      baseUnit: z.string().trim().max(32).nullable().optional(),
      unitsPerPack: z.number().int().min(1).max(1_000_000).nullable().optional(),
      packsPerBox: z.number().int().min(1).max(1_000_000).nullable().optional(),
      boxesPerCarton: z.number().int().min(1).max(1_000_000).nullable().optional(),
      cartonsPerPallet: z.number().int().min(1).max(1_000_000).nullable().optional(),
      statedTotalUnits: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
      netWeightGrams: z.number().int().min(0).nullable().optional(),
      grossWeightGrams: z.number().int().min(0).nullable().optional(),
    })
    .nullable()
    .optional(),
  sellerEditedTitle: z.string().trim().max(512).nullable().optional(),
  /** The version the client last read. Stale writes are refused, not merged. */
  expectedVersion: z.number().int().min(0).nullable().optional(),
});

export function registerSellerListingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSeller(SellerPermission.LISTING_READ));

  // --- The listings table -------------------------------------------------

  app.get('/listings', async (request, reply) => {
    const query = z
      .object({
        status: z
          .enum(['INACTIVE', 'ACTIVE', 'PAUSED', 'NEEDS_CHANGES', 'ARCHIVED'])
          .nullish(),
        search: z.string().trim().max(200).nullish(),
        categoryId: z.string().length(26).nullish(),
        brandId: z.string().length(26).nullish(),
        locationId: z.string().length(26).nullish(),
        stockState: z.enum(['in', 'low', 'out']).nullish(),
        sort: z.enum(['updated', 'price_asc', 'price_desc', 'stock_asc', 'quality_asc']).nullish(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);

    const result = await listOffers(currentSeller(request), query);
    return reply.header('cache-control', 'no-store').status(200).send(result);
  });

  app.get('/listings/:id', async (request, reply) => {
    const params = idParam.parse(request.params);
    const offer = await readOffer(currentSeller(request), params.id);
    return reply.header('cache-control', 'no-store').status(200).send(offer);
  });

  app.patch(
    '/listings/:id/status',
    { preHandler: requireSeller(SellerPermission.OFFER_PUBLISH) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']) }).parse(request.body);

      await setOfferStatus(currentSeller(request), params.id, body.status, request.correlationId);
      return reply.status(204).send();
    },
  );

  app.patch(
    '/listings/:id/price',
    { preHandler: requireSeller(SellerPermission.OFFER_PRICE_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          priceMinor: minorUnits,
          currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
          compareAtPriceMinor: minorUnits.nullable().optional(),
          minimumOrderQuantity: z.number().int().min(1).nullable().optional(),
          orderIncrement: z.number().int().min(1).nullable().optional(),
          maximumOrderQuantity: z.number().int().min(1).nullable().optional(),
          priceTiers: z
            .array(z.object({ minQuantity: z.number().int().min(2), priceMinor: minorUnits }))
            .max(20)
            .nullable()
            .optional(),
        })
        .parse(request.body);

      await updateOfferPrice(currentSeller(request), params.id, body, request.correlationId);
      return reply.status(204).send();
    },
  );

  app.post(
    '/listings/:id/duplicate',
    { preHandler: requireTradingSeller(SellerPermission.LISTING_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ sellerSku: z.string().trim().min(1).max(64) }).parse(request.body);

      const result = await duplicateOffer(
        currentSeller(request),
        params.id,
        body.sellerSku,
        request.correlationId,
      );

      return reply.status(201).send(result);
    },
  );

  // --- The wizard ---------------------------------------------------------

  /**
   * The fields this category asks for.
   *
   * Cached for a minute at the edge: the schema changes when an operator edits
   * a category, which is rare, and the wizard fetches it on every step change.
   * It carries no seller data, so a shared cache entry is safe - which is why
   * the cache header here is `public` and every other seller route is
   * `no-store`.
   */
  app.get('/listing-schema', async (request, reply) => {
    const query = z.object({ categoryId: z.string().length(26) }).parse(request.query);
    const schema = await loadListingSchema(query.categoryId);

    return reply.header('cache-control', 'public, max-age=60').status(200).send(schema);
  });

  app.get('/listing-drafts', async (request, reply) => {
    const query = z
      .object({
        status: z
          .enum([
            'DRAFT',
            'VALIDATION_FAILED',
            'READY_FOR_SUBMISSION',
            'PENDING_REVIEW',
            'ACTION_REQUIRED',
            'APPROVED',
            'REJECTED',
            'ARCHIVED',
          ])
          .nullish(),
        search: z.string().trim().max(200).nullish(),
        categoryId: z.string().length(26).nullish(),
        brandId: z.string().length(26).nullish(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);

    const result = await listDrafts(currentSeller(request), query);
    return reply.header('cache-control', 'no-store').status(200).send(result);
  });

  app.post(
    '/listing-drafts',
    { preHandler: requireTradingSeller(SellerPermission.LISTING_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          categoryId: z.string().length(26).nullable().optional(),
          brandId: z.string().length(26).nullable().optional(),
          matchedProductId: z.string().length(26).nullable().optional(),
        })
        .parse(request.body ?? {});

      const draft = await createDraft(currentSeller(request), body, request.correlationId);
      return reply.status(201).send(draft);
    },
  );

  app.get('/listing-drafts/:id', async (request, reply) => {
    const params = idParam.parse(request.params);
    const draft = await readDraft(currentSeller(request), params.id);
    return reply.header('cache-control', 'no-store').status(200).send(draft);
  });

  /**
   * Autosave.
   *
   * Rate-limited generously rather than not at all: the wizard debounces and
   * saves per section, so a seller working quickly through five sections is a
   * handful of calls a minute, while a stuck retry loop is hundreds.
   */
  app.patch(
    '/listing-drafts/:id',
    {
      preHandler: requireSeller(SellerPermission.LISTING_WRITE),
      config: { rateLimit: { max: 240, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const { expectedVersion, ...patch } = draftPatchSchema.parse(request.body);

      const draft = await saveDraft({
        membership: currentSeller(request),
        draftId: params.id,
        patch,
        expectedVersion: expectedVersion ?? null,
        correlationId: request.correlationId,
      });

      return reply.header('cache-control', 'no-store').status(200).send(draft);
    },
  );

  app.post('/listing-drafts/:id/validate', async (request, reply) => {
    const params = idParam.parse(request.params);
    const draft = await validateDraft(currentSeller(request), params.id);
    return reply.header('cache-control', 'no-store').status(200).send(draft);
  });

  /**
   * What the title will be, and which fields made it.
   *
   * A POST rather than a GET because it re-evaluates and can write the
   * generated title back - and because the wizard calls it when the seller
   * presses a button, not when it renders.
   */
  app.post('/listing-drafts/:id/preview-title', async (request, reply) => {
    const params = idParam.parse(request.params);
    const preview = await previewTitle(currentSeller(request), params.id);
    return reply.header('cache-control', 'no-store').status(200).send(preview);
  });

  app.post(
    '/listing-drafts/:id/submit',
    {
      preHandler: requireTradingSeller(SellerPermission.LISTING_SUBMIT),
      config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const draft = await submitDraft(currentSeller(request), params.id, request.correlationId);
      return reply.status(200).send(draft);
    },
  );

  app.post(
    '/listing-drafts/:id/withdraw',
    { preHandler: requireSeller(SellerPermission.LISTING_SUBMIT) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const draft = await withdrawDraft(currentSeller(request), params.id, request.correlationId);
      return reply.status(200).send(draft);
    },
  );

  // --- Photographs and videos ---------------------------------------------

  app.get('/listing-drafts/:id/media', async (request, reply) => {
    const params = idParam.parse(request.params);
    const media = await listListingMedia(currentSeller(request), params.id);

    return reply.header('cache-control', 'no-store').status(200).send({ media });
  });

  /**
   * Upload one photograph or video.
   *
   * A multipart/form-data body, and the BYTES are what decide the type - the
   * declared Content-Type is not trusted anywhere in this path. Which kind it
   * turned out to be also decides which size ceiling applies, because a
   * photograph and a clip are not the same thing.
   *
   * Rate-limited by attempt rather than by byte: a seller uploading twelve
   * angles of one instrument is doing the right thing, and a stuck retry loop
   * is what the ceiling is for.
   */
  app.post(
    '/listing-drafts/:id/media',
    {
      preHandler: requireTradingSeller(SellerPermission.MEDIA_UPLOAD),
      config: { rateLimit: { max: 120, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      // The app-wide multipart ceiling is UPLOAD_MAX_BYTES, which is sized for
      // a photograph and would reject every video. Raised here to the video
      // ceiling, and the service then applies the RIGHT one of the two once the
      // bytes have said which kind this actually is - so a 40 MB file claiming
      // to be a JPEG still gets refused.
      const upload = await request.file({ limits: { fileSize: env.UPLOAD_VIDEO_MAX_BYTES } });

      if (upload === undefined) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_FAILED', message: 'No file was attached.' },
        });
      }

      // Read once, into memory. A product photograph or a short clip is
      // bounded by the limits above, and streaming to disk first would buy
      // nothing but a temporary file to clean up.
      const buffer = await upload.toBuffer();

      // Fields arrive alongside the file in the same multipart body.
      const fields = upload.fields as Record<string, { value?: unknown } | undefined>;
      const slot = typeof fields['slot']?.value === 'string' ? fields['slot'].value : null;
      const altText = typeof fields['altText']?.value === 'string' ? fields['altText'].value : null;

      const media = await uploadListingMedia({
        membership: currentSeller(request),
        draftId: params.id,
        buffer,
        originalFileName: upload.filename,
        slot,
        altText,
        correlationId: request.correlationId,
      });

      return reply.status(201).send(media);
    },
  );

  app.patch(
    '/listing-drafts/:id/media/:mediaId',
    { preHandler: requireSeller(SellerPermission.MEDIA_UPLOAD) },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().length(26), mediaId: z.string().length(26) })
        .parse(request.params);

      const body = z
        .object({
          slot: z.string().trim().max(32).nullable().optional(),
          altText: z.string().trim().max(255).nullable().optional(),
          isPrimary: z.boolean().optional(),
          sortOrder: z.number().int().min(0).max(999).nullable().optional(),
        })
        .parse(request.body);

      const media = await updateListingMedia(
        currentSeller(request),
        params.id,
        params.mediaId,
        body,
      );

      return reply.status(200).send(media);
    },
  );

  app.delete(
    '/listing-drafts/:id/media/:mediaId',
    { preHandler: requireSeller(SellerPermission.MEDIA_UPLOAD) },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().length(26), mediaId: z.string().length(26) })
        .parse(request.params);

      await deleteListingMedia(
        currentSeller(request),
        params.id,
        params.mediaId,
        request.correlationId,
      );

      return reply.status(204).send();
    },
  );

  // --- Brands -------------------------------------------------------------

  app.get('/brands', async (request, reply) => {
    const query = z
      .object({
        q: z.string().trim().max(160).default(''),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(request.query);

    const seller = currentSeller(request);

    const [brands, recent] = await Promise.all([
      searchBrands(seller, query.q, query.limit),
      recentBrands(seller),
    ]);

    return reply.status(200).send({
      brands,
      recent,
      // Advice, not a refusal. The brief is explicit that a warning must not
      // silently reject a legitimate business name, so these are returned
      // beside the results and the request is still accepted.
      warnings: query.q.length > 0 ? checkBrandName(query.q) : [],
    });
  });

  app.post(
    '/brand-requests',
    {
      preHandler: requireSeller(SellerPermission.BRAND_REQUEST),
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const body = z
        .object({
          requestedName: z.string().trim().min(2).max(160),
          manufacturerLegalName: z.string().trim().max(255).nullable().optional(),
          websiteUrl: z.string().trim().url().max(512).nullable().optional(),
          justification: z.string().trim().max(2000).nullable().optional(),
        })
        .parse(request.body);

      const result = await requestBrand({
        membership: currentSeller(request),
        ...body,
        correlationId: request.correlationId,
      });

      return reply.status(201).send(result);
    },
  );

  app.get('/brand-requests', async (request, reply) => {
    const requests = await listBrandRequests(currentSeller(request));
    return reply.status(200).send({ requests });
  });

  app.delete(
    '/brand-requests/:id',
    { preHandler: requireSeller(SellerPermission.BRAND_REQUEST) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      await withdrawBrandRequest(currentSeller(request), params.id);
      return reply.status(204).send();
    },
  );

  return Promise.resolve();
}
