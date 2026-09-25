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
  generateDraftMatrix,
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
  containerLoadingInputSchema,
  previewContainerLoading,
  readContainerLoading,
  saveContainerLoading,
} from '../../modules/seller/container-loading.service.js';
import { CONTAINER_PRESETS, INCOTERMS, PALLET_FOOTPRINTS } from '../../domain/packaging.js';
import {
  previewBulkOrder,
  readPackagingProfile,
  savePackagingOption,
  savePackagingProfileDetails,
  setPackagingOptionEnabled,
} from '../../modules/seller/packaging.service.js';
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
import {
  addListingPhoto,
  pauseForEdit,
  readListingForEdit,
  removeListingPhoto,
  saveListingEdit,
  setPrimaryListingPhoto,
} from '../../modules/seller/offer-edit.service.js';
import {
  addOfferVariants,
  previewOfferVariants,
  readOfferVariants,
} from '../../modules/seller/offer-variants.service.js';
import {
  listInstructionsForOffer,
  listInstructionsForSellerAccount,
} from '../../modules/catalog/product-instruction.service.js';
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

/**
 * The axes a listing sells along.
 *
 * Deliberately permissive about the VALUES - a label is any short string,
 * because the seller is describing their own stock and this marketplace sells
 * everything from bolts to books. What is bounded is the SHAPE: five axes and
 * sixty values each, which is the point past which a matrix stops being
 * something a person can fill in and starts being a denial of service.
 *
 * `normaliseAxes` does the real work afterwards - dropping blanks, folding
 * duplicates, and refusing an axis the category's template does not offer.
 */
const variantAxesSchema = z
  .array(
    z.object({
      axisKey: z.string().trim().min(1).max(64),
      values: z
        .array(
          z.object({
            label: z.string().trim().max(120),
            amount: z.string().trim().max(32).nullable().optional(),
            unit: z.string().trim().max(16).nullable().optional(),
          }),
        )
        .max(60),
    }),
  )
  .max(5);

/**
 * The matrix rows, as the seller last left them.
 *
 * `optionSignature` is accepted and then thrown away - `normaliseRows`
 * recomputes it from `options`. It is in the shape only because the wizard
 * round-trips whole rows, and rejecting a field the server itself sent would
 * be a strange thing to do.
 */
const variantRowsSchema = z
  .array(
    z.object({
      optionSignature: z.string().max(512).default(''),
      options: z.record(z.string().max(64), z.string().max(120)),
      name: z.string().trim().max(255).default(''),
      sku: z.string().trim().max(64).default(''),
      barcode: z.string().trim().max(64).nullable().optional(),
      isActive: z.boolean().default(true),

      priceMinor: minorUnits.nullable().optional(),
      compareAtPriceMinor: minorUnits.nullable().optional(),

      minOrderQty: z.number().int().min(0).max(1_000_000).nullable().optional(),
      qtyIncrement: z.number().int().min(0).max(1_000_000).nullable().optional(),
      maxOrderQty: z.number().int().min(0).max(1_000_000).nullable().optional(),
      leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),

      multipackCount: z.number().int().min(1).max(1_000_000).nullable().optional(),
      netContentValue: z.string().trim().max(32).nullable().optional(),
      netContentUnit: z.string().trim().max(16).nullable().optional(),

      shippingWeightGrams: z.number().int().min(0).max(100_000_000).nullable().optional(),
      shippingLengthMm: z.number().int().min(0).max(1_000_000).nullable().optional(),
      shippingWidthMm: z.number().int().min(0).max(1_000_000).nullable().optional(),
      shippingHeightMm: z.number().int().min(0).max(1_000_000).nullable().optional(),

      stock: z
        .array(
          z.object({
            locationId: z.string().length(26),
            availableQuantity: z.number().int().min(0).max(100_000_000),
          }),
        )
        .max(50)
        .default([]),
      mediaId: z.string().length(26).nullable().optional(),
    }),
  )
  .max(500);

/**
 * The same rows, coming back from the EDIT form rather than the wizard.
 *
 * The one addition is `offerId`, and it is a hint rather than an instruction:
 * the server matches combinations by their option signature, and the id only
 * settles the case where a seller corrected a spelling and the signature
 * therefore moved. An id belonging to another seller resolves to nothing and
 * the row is treated as new, which is the safe reading.
 */
const editRowsSchema = z
  .array(
    variantRowsSchema.element.extend({
      offerId: z.string().length(26).nullable().optional(),
    }),
  )
  .max(500);

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
        expiresOn: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
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
  variantAxes: variantAxesSchema.nullable().optional(),
  variants: variantRowsSchema.nullable().optional(),
  /** The version the client last read. Stale writes are refused, not merged. */
  expectedVersion: z.number().int().min(0).nullable().optional(),
});

export function registerSellerListingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSeller(SellerPermission.LISTING_READ));

  // --- The listings table -------------------------------------------------

  /**
   * One page of the seller's listings, with a count for each status tab.
   * Can be filtered by status, text, category, brand, warehouse or stock level,
   * and sorted by date, price, stock or quality score.
   */
  app.get('/listings', async (request, reply) => {
    const query = z
      .object({
        status: z.enum(['INACTIVE', 'ACTIVE', 'PAUSED', 'NEEDS_CHANGES', 'ARCHIVED']).nullish(),
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

  /** One of the seller's listings in full, for its detail screen. */
  app.get('/listings/:id', async (request, reply) => {
    const params = idParam.parse(request.params);
    const offer = await readOffer(currentSeller(request), params.id);
    return reply.header('cache-control', 'no-store').status(200).send(offer);
  });

  /**
   * Put a listing on sale, pause it (with an optional private note) or archive
   * it. Putting it back on sale is refused while the marketplace has flagged it
   * as needing changes. Writes an audit entry.
   */
  app.patch(
    '/listings/:id/status',
    { preHandler: requireSeller(SellerPermission.OFFER_PUBLISH) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']),
          /** Seller-visible note on a pause. Never shown to a buyer. */
          reason: z.string().trim().max(2000).nullable().optional(),
        })
        .parse(request.body);

      await setOfferStatus(
        currentSeller(request),
        params.id,
        body.status,
        request.correlationId,
        body.reason ?? null,
      );
      return reply.status(204).send();
    },
  );

  /**
   * Change a listing's price, "was" price, order quantity limits and simple
   * quantity discounts. Needs the pricing permission and writes an audit entry,
   * so a disputed price change can be traced to who made it and when.
   */
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

  /*
   * Versions on a listing that already exists.
   *
   * Separate from the wizard's routes because the thing being edited is
   * different: the wizard writes JSON onto a draft nobody can buy, and these
   * create real variants and real offers against a product that is already in
   * the catalogue. Sharing a route would mean one handler whose behaviour
   * depended on which of two unrelated states it found.
   */
  app.get('/listings/:id/variants', async (request, reply) => {
    const params = idParam.parse(request.params);
    const view = await readOfferVariants(currentSeller(request), params.id);
    return reply.header('cache-control', 'no-store').status(200).send(view);
  });

  // --- What buyers have asked about this product ---------------------------

  /**
   * Instructions shoppers have left on the product behind this listing.
   *
   * Read-only, and there is deliberately no write here. These are the
   * shopper's own words and only they can change them — a seller who could
   * edit a buyer's requirement is a seller who can rewrite the evidence of
   * what was asked for.
   *
   * Scoped to this seller's own listing inside the service: a listing
   * belonging to somebody else is "not found" before any instruction is
   * loaded, so this cannot be used to read the catalogue's buyer
   * requirements by posting offer ids.
   *
   * `no-store`. A seller opens this to find out what came in this morning.
   */
  app.get('/listings/:id/instructions', async (request, reply) => {
    const params = idParam.parse(request.params);

    const instructions = await listInstructionsForOffer(
      currentSeller(request).sellerAccountId,
      params.id,
    );

    return reply.header('cache-control', 'no-store').status(200).send({ instructions });
  });

  /**
   * The same thing across everything this seller sells.
   *
   * The hub's own page: "what are people asking me about?". Bounded rather
   * than paged — the question is answered by the recent ones, and a seller
   * looking for the hundredth is looking for a product and should open that
   * listing.
   */
  app.get('/instructions', async (request, reply) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
      .parse(request.query);

    const instructions = await listInstructionsForSellerAccount(
      currentSeller(request).sellerAccountId,
      query.limit,
    );

    return reply.header('cache-control', 'no-store').status(200).send({ instructions });
  });

  /**
   * Show which versions (for example sizes or colours) a set of options would
   * produce on an existing listing, marking the ones already on sale. Creates
   * nothing.
   */
  app.post(
    '/listings/:id/variants/preview',
    { preHandler: requireSeller(SellerPermission.LISTING_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ axes: variantAxesSchema }).parse(request.body);

      const preview = await previewOfferVariants({
        membership: currentSeller(request),
        offerId: params.id,
        axes: body.axes,
      });

      return reply.header('cache-control', 'no-store').status(200).send(preview);
    },
  );

  /**
   * Add new versions to an existing listing as real, sellable items, each with
   * its own price and opening stock. Versions already on sale are skipped, so
   * sending the same request twice adds nothing. Writes an audit entry.
   */
  app.post(
    '/listings/:id/variants',
    {
      preHandler: requireTradingSeller(SellerPermission.LISTING_WRITE),
      config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          axes: variantAxesSchema,
          rows: variantRowsSchema,
          expectedVersion: z.number().int().min(0).nullable().optional(),
        })
        .parse(request.body);

      const result = await addOfferVariants({
        membership: currentSeller(request),
        offerId: params.id,
        axes: body.axes,
        rows: body.rows,
        expectedVersion: body.expectedVersion ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(201).send(result);
    },
  );

  /*
   * Editing a listing that already exists.
   *
   * Three routes rather than one, because they are three different decisions
   * and two of them change what a buyer can see:
   *
   *   - GET  .../edit            fills the form in. Read-only.
   *   - POST .../pause-for-edit  takes it off sale so the structure can move.
   *   - PATCH .../edit           applies the change, and says how it ends.
   *
   * The seller can reach the form without pausing - prices, stock and terms
   * are routine changes a live listing absorbs - and the PATCH refuses the
   * structural half of the payload if the listing is still on sale. That
   * refusal lives in the service, beside the rule, rather than being
   * approximated here by a guard on the route.
   */
  app.get('/listings/:id/edit', async (request, reply) => {
    const params = idParam.parse(request.params);
    const view = await readListingForEdit(currentSeller(request), params.id);
    return reply.header('cache-control', 'no-store').status(200).send(view);
  });

  /**
   * Take a live listing off sale so its structure can be edited, recording that
   * it was paused for editing. Does nothing if it is already paused. Writes an
   * audit entry.
   */
  app.post(
    '/listings/:id/pause-for-edit',
    { preHandler: requireSeller(SellerPermission.OFFER_PUBLISH) },
    async (request, reply) => {
      const params = idParam.parse(request.params);

      const result = await pauseForEdit(currentSeller(request), params.id, request.correlationId);

      return reply.status(200).send(result);
    },
  );

  /**
   * Save an edit to an existing listing - terms, versions and their stock - all
   * at once, then leave it paused or put it back on sale. Structural changes are
   * refused while the listing is on sale, and so is an edit made from an out-of-
   * date copy. Writes an audit entry.
   */
  app.patch(
    '/listings/:id/edit',
    {
      preHandler: requireTradingSeller(SellerPermission.LISTING_WRITE),
      config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          /** The version the form was built from. Required - see the service. */
          expectedVersion: z.number().int().min(0),
          terms: draftOfferSchema
            .omit({ currency: true, orderingUnit: true })
            .nullable()
            .optional(),
          axes: variantAxesSchema.nullable().optional(),
          rows: editRowsSchema.nullable().optional(),
          /** Save and leave it off sale, or save and put it back on. */
          finish: z.enum(['PAUSED', 'ACTIVE']),
        })
        .parse(request.body);

      const result = await saveListingEdit({
        membership: currentSeller(request),
        offerId: params.id,
        expectedVersion: body.expectedVersion,
        terms: body.terms ?? null,
        axes: body.axes ?? null,
        rows: body.rows ?? null,
        finish: body.finish,
        correlationId: request.correlationId,
      });

      return reply.status(200).send(result);
    },
  );

  /*
   * The photographs on a listing the seller is editing.
   *
   * Against the PRODUCT rather than the offer, because that is where a
   * photograph lives - a picture of a pump is a picture of a pump whoever is
   * selling it. Which is exactly why the service refuses a seller who merely
   * matched their stock to somebody else's catalogue entry: they would be
   * changing what two other sellers are showing.
   *
   * Rate-limited by attempt rather than by byte. A seller uploading eight
   * angles of one instrument is doing the right thing; a stuck retry loop is
   * what the ceiling is for.
   */
  app.post(
    '/listings/:id/photos',
    {
      preHandler: requireTradingSeller(SellerPermission.MEDIA_UPLOAD),
      config: { rateLimit: { max: 120, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const upload = await request.file({ limits: { fileSize: env.UPLOAD_MAX_BYTES } });

      if (upload === undefined) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_FAILED', message: 'No file was attached.' },
        });
      }

      // Read once, into memory. A product photograph is bounded by the limit
      // above, and streaming to disk first would buy nothing but a temporary
      // file to clean up.
      const buffer = await upload.toBuffer();

      const fields = upload.fields as Record<string, { value?: unknown } | undefined>;
      const altText = typeof fields['altText']?.value === 'string' ? fields['altText'].value : null;

      const photo = await addListingPhoto({
        membership: currentSeller(request),
        offerId: params.id,
        buffer,
        originalFileName: upload.filename,
        altText,
        correlationId: request.correlationId,
      });

      return reply.status(201).send(photo);
    },
  );

  /** Make one of a listing's photos the one buyers see first. Writes an audit entry. */
  app.patch(
    '/listings/:id/photos/:mediaId',
    { preHandler: requireSeller(SellerPermission.MEDIA_UPLOAD) },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().length(26), mediaId: z.string().length(26) })
        .parse(request.params);

      // One thing this can say, for now: "show this one first". A PATCH rather
      // than a POST to a `/primary` sub-path so that alt text and sort order
      // can join it without another route.
      z.object({ isPrimary: z.literal(true) }).parse(request.body);

      await setPrimaryListingPhoto(
        currentSeller(request),
        params.id,
        params.mediaId,
        request.correlationId,
      );

      return reply.status(204).send();
    },
  );

  /**
   * Take a photo off a listing. The picture file itself is kept, since other
   * listings may use it. Writes an audit entry.
   */
  app.delete(
    '/listings/:id/photos/:mediaId',
    { preHandler: requireSeller(SellerPermission.MEDIA_UPLOAD) },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().length(26), mediaId: z.string().length(26) })
        .parse(request.params);

      await removeListingPhoto(
        currentSeller(request),
        params.id,
        params.mediaId,
        request.correlationId,
      );

      return reply.status(204).send();
    },
  );

  /**
   * Copy a listing's terms into a new, not-yet-live listing under a new SKU.
   * Stock is not copied. Writes an audit entry.
   */
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

  /**
   * One page of the seller's listings still in the wizard or in review,
   * filterable by status, text, category and brand.
   */
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

  /**
   * Start a new listing in the wizard, optionally with its category, brand or
   * matching catalogue product already chosen. Writes an audit entry.
   */
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

  /** One listing in the wizard, with everything entered so far. */
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

  /**
   * Build the combination rows for the axes the seller switched on.
   *
   * A POST because it writes, and separate from the ordinary patch because it
   * is not a save of what the seller typed - it is the server working out what
   * combinations those choices imply, which the seller then prunes down to the
   * ones they actually stock.
   *
   * Rate limited harder than the autosave: each call can write up to five
   * hundred rows into a JSON column, and nothing about the wizard needs it
   * more than a few times a minute.
   */
  app.post(
    '/listing-drafts/:id/variants/generate',
    {
      preHandler: requireSeller(SellerPermission.LISTING_WRITE),
      config: { rateLimit: { max: 60, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          axes: variantAxesSchema,
          replaceExisting: z.boolean().default(false),
        })
        .parse(request.body);

      const draft = await generateDraftMatrix({
        membership: currentSeller(request),
        draftId: params.id,
        axes: body.axes,
        replaceExisting: body.replaceExisting,
        correlationId: request.correlationId,
      });

      return reply.header('cache-control', 'no-store').status(200).send(draft);
    },
  );

  /**
   * Re-run every check on a wizard listing and return what is still missing or
   * wrong. Its status moves to match: ready to submit once everything passes.
   */
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

  /**
   * Send a finished listing to the marketplace's quality review. Refused, with
   * each blocking problem listed, if anything is still missing. It goes on sale
   * only once a moderator approves it. Writes an audit entry.
   */
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

  /**
   * Take a listing back out of the review queue and return it to the wizard,
   * before a moderator has decided on it. Writes an audit entry.
   */
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

  /** The photos and videos uploaded to a listing in the wizard. */
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

  /**
   * Change a wizard photo or video's slot, description, order, or whether it is
   * the main picture. Making one the main picture clears it from the others; a
   * video cannot be the main picture.
   */
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

  /**
   * Delete a photo or video from a wizard listing, including the stored file.
   * If it was the main picture, another photo takes its place.
   */
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

  /**
   * Search the brands this seller is allowed to list under, plus the brands on
   * their recent listings. Also returns advisory warnings about the name typed,
   * which never block anything.
   */
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

  /**
   * Ask the marketplace to add a brand that is not in the catalogue yet. Only a
   * duplicate is refused; an unusual name is accepted and flagged for the
   * operator. Writes an audit entry.
   */
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

  /** The seller's own brand requests and what happened to each. */
  app.get('/brand-requests', async (request, reply) => {
    const requests = await listBrandRequests(currentSeller(request));
    return reply.status(200).send({ requests });
  });

  /** Withdraw a brand request the marketplace has not decided on yet. */
  app.delete(
    '/brand-requests/:id',
    { preHandler: requireSeller(SellerPermission.BRAND_REQUEST) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      await withdrawBrandRequest(currentSeller(request), params.id);
      return reply.status(204).send();
    },
  );

  // --- Bulk packaging ------------------------------------------------------
  //
  // Per OFFER, and therefore per variant: two sellers pack the same catalogue
  // item differently, and one seller packs the 1-litre differently from the
  // 5-litre. A profile on the product would have to pick one of them and be
  // wrong for everybody else.

  /**
   * The presets a form needs before anything has been saved.
   *
   * Footprints and NOMINAL container figures, both described as what they are.
   * A pallet preset supplies two floor dimensions and nothing else - height,
   * load, cartons and layers are the seller's, because a pallet of gauze and a
   * pallet of saline have the footprint in common and nothing else. A
   * container preset is guidance printed beside the seller's own figure and
   * never a capacity: internal dimensions and payload vary by build and by
   * carrier, and a seller who promises a number off a table will one day be
   * unable to load it.
   */
  app.get('/packaging/presets', async (_request, reply) =>
    reply.status(200).send({
      palletFootprints: Object.values(PALLET_FOOTPRINTS),
      containers: Object.values(CONTAINER_PRESETS).map((preset) => ({
        type: preset.type,
        label: preset.label,
        nominalInternalLengthMm: preset.nominalInternalLengthMm,
        nominalInternalWidthMm: preset.nominalInternalWidthMm,
        nominalInternalHeightMm: preset.nominalInternalHeightMm,
        // Minor-unit discipline applies to every large integer that crosses
        // this API, not only to money: a gram figure in the tens of millions
        // is well inside JS's safe range today and the habit is what keeps it
        // safe when somebody adds a heavier unit.
        nominalMaxPayloadGrams: preset.nominalMaxPayloadGrams?.toString() ?? null,
        nominalVolumeCm3: preset.nominalVolumeCm3?.toString() ?? null,
      })),
      incoterms: INCOTERMS,
    }),
  );

  /**
   * How a listing can be bought in bulk - by carton, pallet or container - with
   * the details and prices of each. Returns an empty set-up if none has been
   * saved yet.
   */
  app.get(
    '/offers/:id/packaging',
    { preHandler: requireSeller(SellerPermission.LISTING_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const profile = await readPackagingProfile(currentSeller(request), params.id);
      return reply.status(200).send(profile);
    },
  );

  /** Save the name of a listing's base unit and the seller's packaging notes. */
  app.put(
    '/offers/:id/packaging/profile',
    { preHandler: requireSeller(SellerPermission.LISTING_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          baseUnitLabel: z.string().trim().max(48).nullable().optional(),
          notes: z.string().trim().max(1000).nullable().optional(),
        })
        .parse(request.body);

      const profile = await savePackagingProfileDetails(currentSeller(request), params.id, body);
      return reply.status(200).send(profile);
    },
  );

  /**
   * Save one bulk packaging option for a listing - a carton, a UK or US pallet,
   * or a container - with its contents, size, weight, price and order limits.
   * Writes an audit entry.
   *
   * Measurements are converted to millimetres and grams on the server.
   */
  app.put(
    '/offers/:id/packaging/options',
    { preHandler: requireSeller(SellerPermission.LISTING_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);

      const body = z
        .object({
          packageType: z.enum(['CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER']),
          isEnabled: z.boolean(),
          packageSku: z.string().trim().max(64).nullable().optional(),

          unitsPerCarton: z.number().int().min(1).max(1_000_000).nullable().optional(),
          unitsPerPackage: z.number().int().min(1).max(10_000_000).nullable().optional(),
          unitsPerPackageIsOverride: z.boolean().optional(),

          cartonsPerLayer: z.number().int().min(1).max(10_000).nullable().optional(),
          layerCount: z.number().int().min(1).max(1000).nullable().optional(),
          cartonsPerPallet: z.number().int().min(1).max(100_000).nullable().optional(),
          loadedHeight: z.number().min(0).max(1_000_000).nullable().optional(),
          isStackable: z.boolean().optional(),
          maxStackCount: z.number().int().min(1).max(50).nullable().optional(),

          containerType: z
            .enum(['DRY_20GP', 'DRY_40GP', 'HIGH_CUBE_40HC', 'CUSTOM'])
            .nullable()
            .optional(),
          containerLoadMode: z.enum(['FCL', 'LCL']).nullable().optional(),
          containerLoadingMethod: z
            .enum(['PALLET_LOADED', 'CARTON_LOADED', 'CUSTOM'])
            .nullable()
            .optional(),
          palletsPerContainer: z.number().int().min(1).max(10_000).nullable().optional(),
          cartonsPerContainer: z.number().int().min(1).max(1_000_000).nullable().optional(),
          originPortLabel: z.string().trim().max(160).nullable().optional(),
          incoterm: z.string().trim().max(8).nullable().optional(),

          // Measurements arrive in the unit the seller typed in and are stored
          // canonically - millimetres and grams, both integers. The conversion
          // happens on the server so the figure on the screen and the figure
          // in the database cannot drift.
          dimensionUnit: z.enum(['MM', 'CM', 'M', 'IN']).optional(),
          length: z.number().min(0).max(1_000_000).nullable().optional(),
          width: z.number().min(0).max(1_000_000).nullable().optional(),
          height: z.number().min(0).max(1_000_000).nullable().optional(),

          weightUnit: z.enum(['G', 'KG', 'LB']).optional(),
          netWeight: z.number().min(0).max(100_000_000).nullable().optional(),
          grossWeight: z.number().min(0).max(100_000_000).nullable().optional(),
          maxGrossWeight: z.number().min(0).max(100_000_000).nullable().optional(),

          cargoVolumeCm3: z
            .string()
            .regex(/^\d{1,19}$/)
            .nullable()
            .optional(),

          minimumPackages: z.number().int().min(1).max(100_000).optional(),
          packageIncrement: z.number().int().min(1).max(100_000).optional(),
          maximumPackages: z.number().int().min(1).max(1_000_000).nullable().optional(),

          priceMode: z.enum(['PER_PACKAGE', 'DERIVED_FROM_UNIT', 'FREIGHT_QUOTE']).optional(),
          // Money as a STRING, always. See the schema header: a 19-digit minor
          // figure crossing as a JS number loses its last digit, and a pallet
          // price is exactly the size that reaches there.
          pricePerPackageMinor: z
            .string()
            .regex(/^\d{1,19}$/)
            .nullable()
            .optional(),

          handlingLeadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
          productionLeadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
          originLocationId: z.string().length(26).nullable().optional(),

          isHazardous: z.boolean().optional(),
          temperatureNotes: z.string().trim().max(500).nullable().optional(),
          specialHandlingNotes: z.string().trim().max(1000).nullable().optional(),

          tiers: z
            .array(
              z.object({
                minPackages: z.number().int().min(1).max(1_000_000),
                pricePerPackageMinor: z.string().regex(/^\d{1,19}$/),
              }),
            )
            .max(20)
            .optional(),
        })
        .parse(request.body);

      const profile = await savePackagingOption(
        currentSeller(request),
        params.id,
        body,
        request.auth?.id ?? null,
      );

      return reply.status(200).send(profile);
    },
  );

  // --- Container loading, for 20-ft and 40-ft preorders ----------------------

  /**
   * How many pieces of a listing fit in a 20-ft and a 40-ft container: the
   * carton, the cartons per container, the resulting pieces, whether each size
   * is seller-verified or only an estimate, and the configured payload limits.
   */
  app.get(
    '/offers/:id/container-loading',
    { preHandler: requireSeller(SellerPermission.LISTING_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      return reply.status(200).send(await readContainerLoading(currentSeller(request), params.id));
    },
  );

  /**
   * Work out a container loading without saving it - pieces per container,
   * payload, the share of the container used, the system's estimate, and any
   * problem - for the form while the seller types.
   */
  app.post(
    '/offers/:id/container-loading/preview',
    { preHandler: requireSeller(SellerPermission.LISTING_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = containerLoadingInputSchema.parse(request.body);
      return reply
        .status(200)
        .send(await previewContainerLoading(currentSeller(request), params.id, body));
    },
  );

  /**
   * Save how many pieces of a listing fit in a 20-ft and a 40-ft container.
   * Refused when heavier than the configured payload or larger than the
   * container. A changed figure must be verified again before buyers can order
   * in that container. Existing preorders keep their own snapshot. Writes an
   * audit entry.
   */
  app.put(
    '/offers/:id/container-loading',
    { preHandler: requireSeller(SellerPermission.LISTING_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = containerLoadingInputSchema.parse(request.body);
      return reply
        .status(200)
        .send(
          await saveContainerLoading(
            currentSeller(request),
            params.id,
            body,
            request.auth?.id ?? null,
          ),
        );
    },
  );

  /**
   * Switch buying by one package type on or off for a listing, keeping what was
   * entered for it. Writes an audit entry.
   */
  app.post(
    '/offers/:id/packaging/options/:packageType/enabled',
    { preHandler: requireSeller(SellerPermission.LISTING_WRITE) },
    async (request, reply) => {
      const params = z
        .object({
          id: z.string().length(26),
          packageType: z.enum(['CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER']),
        })
        .parse(request.params);

      const body = z.object({ enabled: z.boolean() }).parse(request.body);

      const profile = await setPackagingOptionEnabled(
        currentSeller(request),
        params.id,
        params.packageType,
        body.enabled,
        request.auth?.id ?? null,
      );

      return reply.status(200).send(profile);
    },
  );

  /**
   * "What would N of these come to?"
   *
   * The same functions the basket uses, so the figure previewed and the figure
   * charged come from one place. A preview computed its own way would
   * eventually disagree with the cart, and the seller would be assuring buyers
   * of a total the checkout does not produce.
   *
   * Reserves nothing and creates nothing.
   */
  app.get(
    '/offers/:id/packaging/preview',
    { preHandler: requireSeller(SellerPermission.LISTING_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const query = z
        .object({
          packageType: z.enum(['CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER']),
          packageQuantity: z.coerce.number().int().min(1).max(1_000_000),
        })
        .parse(request.query);

      // Read through the guarded service first, so a preview cannot be taken
      // against somebody else's offer by posting its id.
      await readPackagingProfile(currentSeller(request), params.id);

      const preview = await previewBulkOrder({
        offerId: params.id,
        packageType: query.packageType,
        packageQuantity: query.packageQuantity,
      });

      return reply.status(200).send(preview);
    },
  );

  return Promise.resolve();
}
