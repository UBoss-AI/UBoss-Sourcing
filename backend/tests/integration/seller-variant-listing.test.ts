/**
 * A seller listing a shirt in twelve combinations, end to end.
 *
 * The unit tests cover the arithmetic. This covers the thing that actually
 * has to work: a draft with a variant matrix, approved by a moderator, coming
 * out the other side as real `ProductVariant` rows, one `SellerOffer` each and
 * stock in the right warehouse against the right combination.
 *
 * Four cases, and each one is a way this has gone wrong in catalogues before:
 *
 *   - **The matrix becomes rows.** Twelve combinations in, twelve variants and
 *     twelve offers out, each with its own code and its own stock.
 *   - **A listing with no variants is untouched.** Every listing approved
 *     before this feature existed has that shape, and it must approve into
 *     exactly the one offer it always did.
 *   - **A matched product is not given somebody else's sizes.** Three
 *     distributors share one product page; one of them must not be able to add
 *     a colour to it.
 *   - **Switched-off combinations are not created.** "We do not make black in
 *     8" is a thing the seller said, and a disabled offer nobody can buy is
 *     not what they meant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import {
  generateDraftMatrix,
  readDraft,
  saveDraft,
} from '../../src/modules/seller/listing-draft.service.js';
import { decideListing } from '../../src/modules/seller/moderation.service.js';
import { setOfferStatus } from '../../src/modules/seller/offer.service.js';
import {
  addOfferVariants,
  readOfferVariants,
} from '../../src/modules/seller/offer-variants.service.js';

const ADMIN_EMAIL = 'variant-listing-admin@test.local';
const SELLER_SLUG = 'varlist-acme';

let adminUserId = '';
let sellerId = '';
let categoryId = '';
let locationId = '';
let membership: SellerMembership;

/**
 * The parent that makes the template resolve, and whether this test made it.
 *
 * `findTemplate` looks up the category's own slug and then its ancestors', so
 * a test shelf hung under `everyday-clothing` gets the real Clothing template
 * - which is the point, because a template with no axes would let the axis
 * validation pass without ever running. The slug is a REAL seeded one, so it
 * is created only when the seed has not already planted it and deleted only
 * when this test was the one that created it. Deleting a seeded category on
 * the way out would break every other suite that reads the catalogue.
 */
let parentCategoryId = '';
let createdParent = false;

/**
 * A tax class to hang the published products off, and whether we made it.
 *
 * `publishApprovedListing` falls back to whichever tax class it can find, and
 * `products.taxClassId` is a foreign key - so on a run where a neighbouring
 * suite has emptied the table, every approval here fails on an FK violation
 * that looks nothing like its cause. Depending on the seed being intact is
 * what makes a suite pass alone and fail in a full run.
 */
let taxClassId = '';
let createdTaxClass = false;

async function cleanUp(): Promise<void> {
  // Order matters: offers and inventory reference variants, variants
  // reference products, and every one of those is ON DELETE RESTRICT.
  await prisma.sellerInventoryMovement.deleteMany({
    where: { sellerAccount: { slug: SELLER_SLUG } },
  });
  await prisma.sellerInventory.deleteMany({ where: { sellerAccount: { slug: SELLER_SLUG } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: SELLER_SLUG } } });
  await prisma.productVariant.deleteMany({
    where: { product: { category: { slug: 'varlist-test-category' } } },
  });
  await prisma.productPrice.deleteMany({
    where: { product: { category: { slug: 'varlist-test-category' } } },
  });
  await prisma.product.deleteMany({ where: { category: { slug: 'varlist-test-category' } } });
  await prisma.sellerListingIssue.deleteMany({
    where: { draft: { sellerAccount: { slug: SELLER_SLUG } } },
  });
  await prisma.sellerListingDraft.deleteMany({
    where: { sellerAccount: { slug: SELLER_SLUG } },
  });
  await prisma.sellerNotification.deleteMany({
    where: { sellerAccount: { slug: SELLER_SLUG } },
  });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: SELLER_SLUG } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccount: { slug: SELLER_SLUG } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SELLER_SLUG } });
  await prisma.category.deleteMany({ where: { slug: 'varlist-test-category' } });
  // Only if this test planted it. A seeded `everyday-clothing` belongs to the
  // catalogue and every other suite that reads it.
  if (createdParent) {
    await prisma.category.deleteMany({ where: { slug: 'everyday-clothing' } });
    createdParent = false;
  }
  // Same rule as the parent category: only what this suite planted.
  if (createdTaxClass) {
    await prisma.taxClass.deleteMany({ where: { code: 'VARLIST-GST18' } });
    createdTaxClass = false;
  }
  await prisma.user.deleteMany({ where: { emailNormalized: ADMIN_EMAIL } });
}

/** A draft ready to be given variants: category, code, price and a warehouse. */
async function makeDraft(over: { matchedProductId?: string } = {}): Promise<string> {
  const id = newId();

  await prisma.sellerListingDraft.create({
    data: {
      id,
      sellerAccountId: sellerId,
      status: 'PENDING_REVIEW',
      categoryId,
      sellerSku: `TSH-${id.slice(-6)}`,
      matchedProductId: over.matchedProductId ?? null,
      attributesJson: {},
      // The tax class is named explicitly so the publish path does not fall
      // back to whatever `findFirst` happens to return on a shared database.
      offerJson: { priceMinor: '49900', currency: 'INR', taxClassId },
      stockJson: [{ locationId, availableQuantity: 3 }],
      packagingJson: {},
      generatedTitle: 'Cotton Round-Neck T-shirt',
      submittedAt: new Date(),
    },
  });

  return id;
}

beforeAll(async () => {
  await cleanUp();

  const admin = await prisma.user.create({
    data: {
      id: newId(),
      email: ADMIN_EMAIL,
      emailNormalized: ADMIN_EMAIL,
      passwordHash: 'x',
      type: 'ADMIN',
      status: 'ACTIVE',
    },
  });
  adminUserId = admin.id;

  const existingTaxClass = await prisma.taxClass.findFirst({ select: { id: true } });

  if (existingTaxClass === null) {
    taxClassId = newId();
    createdTaxClass = true;
    await prisma.taxClass.create({
      data: { id: taxClassId, code: 'VARLIST-GST18', name: 'Varlist GST 18%', ratePercent: 18 },
    });
  } else {
    taxClassId = existingTaxClass.id;
  }

  // Hung under `everyday-clothing` so the real Clothing & Textiles template
  // resolves through the ancestor chain. See the note on `createdParent`.
  const existingParent = await prisma.category.findUnique({
    where: { slug: 'everyday-clothing' },
    select: { id: true },
  });

  if (existingParent === null) {
    parentCategoryId = newId();
    createdParent = true;
    await prisma.category.create({
      data: {
        id: parentCategoryId,
        name: 'Everyday Clothing',
        slug: 'everyday-clothing',
        isActive: true,
        path: '',
      },
    });
  } else {
    parentCategoryId = existingParent.id;
  }

  const category = await prisma.category.create({
    data: {
      id: newId(),
      parentId: parentCategoryId,
      name: 'Varlist Shirts',
      slug: 'varlist-test-category',
      isActive: true,
      // The materialised root-to-leaf trail `categorySlugPath` reads to find
      // the ancestors. Written by hand here because nothing in this test goes
      // through the category service that would normally maintain it.
      path: `/${parentCategoryId}/`,
    },
  });
  categoryId = category.id;

  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      legalName: 'Varlist Acme Ltd',
      displayName: 'Varlist Acme',
      displayNameNormalized: 'varlist acme',
      slug: SELLER_SLUG,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  locationId = newId();
  await prisma.sellerLocation.create({
    data: {
      id: locationId,
      sellerAccountId: sellerId,
      code: 'VL1',
      name: 'Varlist Warehouse',
      addressLine1: '1 Test Road',
      city: 'Chennai',
      postcode: '600001',
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
    },
  });

  membership = {
    sellerAccountId: sellerId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: 'Varlist Acme',
    legalName: 'Varlist Acme Ltd',
    slug: SELLER_SLUG,
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
    logoStorageKey: null,
  };
});

afterAll(async () => {
  await cleanUp();
});

// ---------------------------------------------------------------------------

describe('a seller describing variants in the wizard', () => {
  it('offers the clothing template for a clothing category', async () => {
    const draftId = await makeDraft();
    await prisma.sellerListingDraft.update({
      where: { id: draftId },
      data: { status: 'DRAFT' },
    });

    const draft = await readDraft(membership, draftId);

    // Resolved from the category's slug chain, not from anything the seller
    // typed. A renamed category keeps its template; an invented one has none.
    expect(draft.variantTemplate).not.toBeNull();
    expect(draft.variantTemplate?.axes.some((axis) => axis.key === 'size')).toBe(true);
    expect(draft.variantTemplate?.axes.some((axis) => axis.key === 'colour')).toBe(true);

    // Nothing is switched on until the seller switches it on.
    expect(draft.variantAxes).toBeNull();
  });

  it('builds one row per combination and keeps prices when an axis widens', async () => {
    const draftId = await makeDraft();
    await prisma.sellerListingDraft.update({
      where: { id: draftId },
      data: { status: 'DRAFT' },
    });

    const built = await generateDraftMatrix({
      membership,
      draftId,
      axes: [
        { axisKey: 'size', values: [{ label: 'S' }, { label: 'M' }, { label: 'L' }] },
        { axisKey: 'colour', values: [{ label: 'Black' }, { label: 'White' }] },
      ],
    });

    expect(built.variants).toHaveLength(6);
    expect(new Set(built.variants?.map((row) => row.sku)).size).toBe(6);

    // Price them all, then add a colour.
    const priced = (built.variants ?? []).map((row) => ({ ...row, priceMinor: '49900' }));
    const saved = await saveDraft({
      membership,
      draftId,
      patch: { variants: priced },
    });
    expect(saved.variants?.every((row) => row.priceMinor === '49900')).toBe(true);

    const widened = await generateDraftMatrix({
      membership,
      draftId,
      axes: [
        { axisKey: 'size', values: [{ label: 'S' }, { label: 'M' }, { label: 'L' }] },
        { axisKey: 'colour', values: [{ label: 'Black' }, { label: 'White' }, { label: 'Navy' }] },
      ],
    });

    expect(widened.variants).toHaveLength(9);
    // The six that were priced keep their price; the three new ones have none.
    expect(widened.variants?.filter((row) => row.priceMinor === '49900')).toHaveLength(6);
  });

  it('blocks submission while a combination has no code or price', async () => {
    const draftId = await makeDraft();
    await prisma.sellerListingDraft.update({
      where: { id: draftId },
      data: { status: 'DRAFT' },
    });

    await generateDraftMatrix({
      membership,
      draftId,
      axes: [{ axisKey: 'size', values: [{ label: 'S' }, { label: 'M' }] }],
    });

    const draft = await readDraft(membership, draftId);

    expect(draft.issues.some((issue) => issue.code === 'VARIANT_PRICE_MISSING')).toBe(true);
    expect(draft.isSubmittable).toBe(false);
  });
});

describe('approving a listing that has variants', () => {
  it('creates a variant, an offer and stock for every combination', async () => {
    const draftId = await makeDraft();

    await prisma.sellerListingDraft.update({
      where: { id: draftId },
      data: {
        variantAxesJson: {
          axes: [
            { axisKey: 'size', values: [{ label: 'S' }, { label: 'M' }] },
            { axisKey: 'colour', values: [{ label: 'Black' }, { label: 'White' }] },
          ],
        },
        variantsJson: [
          {
            optionSignature: '',
            options: { size: 'S', colour: 'Black' },
            name: 'Black / S',
            sku: 'TSH-BLK-S',
            isActive: true,
            priceMinor: '49900',
            stock: [{ locationId, availableQuantity: 15 }],
          },
          {
            optionSignature: '',
            options: { size: 'M', colour: 'Black' },
            name: 'Black / M',
            sku: 'TSH-BLK-M',
            isActive: true,
            priceMinor: '49900',
            stock: [{ locationId, availableQuantity: 0 }],
          },
          {
            optionSignature: '',
            options: { size: 'S', colour: 'White' },
            name: 'White / S',
            sku: 'TSH-WHT-S',
            isActive: true,
            // A different price on one combination, because white costs more
            // to make. This is the whole reason price lives on the variant.
            priceMinor: '52900',
            stock: [{ locationId, availableQuantity: 4 }],
          },
        ],
      },
    });

    const { offerId } = await decideListing({ draftId, to: 'APPROVED', adminUserId });
    expect(offerId).not.toBeNull();

    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    const productId = draft.publishedProductId ?? '';
    expect(productId).not.toBe('');

    const variants = await prisma.productVariant.findMany({
      where: { productId },
      orderBy: { sortOrder: 'asc' },
    });
    expect(variants).toHaveLength(3);

    // Every combination has its own code, and its own signature - which is
    // what the unique index is protecting.
    expect(variants.map((row) => row.sku).sort()).toEqual([
      'TSH-BLK-M',
      'TSH-BLK-S',
      'TSH-WHT-S',
    ]);
    expect(new Set(variants.map((row) => row.optionSignature)).size).toBe(3);

    // Price is per combination, not per family.
    const white = variants.find((row) => row.sku === 'TSH-WHT-S');
    expect(white?.priceMinor).toBe(52900n);

    const offers = await prisma.sellerOffer.findMany({ where: { productId } });
    expect(offers).toHaveLength(3);
    // Each offer points at its own variant; none is the bare base offer.
    expect(offers.every((offer) => offer.variantKey !== '')).toBe(true);
    expect(new Set(offers.map((offer) => offer.variantKey)).size).toBe(3);

    // Stock landed against the right combination, and the out-of-stock one is
    // genuinely zero rather than absent.
    const blackSmall = offers.find((offer) => offer.sellerSku === 'TSH-BLK-S');
    const blackMedium = offers.find((offer) => offer.sellerSku === 'TSH-BLK-M');
    expect(blackSmall?.availableQuantity).toBe(15);
    expect(blackMedium?.availableQuantity).toBe(0);

    // The family says it has variants, so the buyer's page knows to draw a
    // selector at all.
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.hasVariants).toBe(true);
  });

  it('does not create an offer for a combination the seller switched off', async () => {
    const draftId = await makeDraft();

    await prisma.sellerListingDraft.update({
      where: { id: draftId },
      data: {
        variantAxesJson: { axes: [{ axisKey: 'size', values: [{ label: 'S' }, { label: 'M' }] }] },
        variantsJson: [
          {
            optionSignature: '',
            options: { size: 'S' },
            name: 'S',
            sku: 'OFF-S',
            isActive: true,
            priceMinor: '10000',
            stock: [],
          },
          {
            optionSignature: '',
            options: { size: 'M' },
            name: 'M',
            // Switched off: the factory does not make it. "Not offered", which
            // is a different answer to a buyer than "out of stock".
            sku: 'OFF-M',
            isActive: false,
            priceMinor: '10000',
            stock: [],
          },
        ],
      },
    });

    await decideListing({ draftId, to: 'APPROVED', adminUserId });

    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    const variants = await prisma.productVariant.findMany({
      where: { productId: draft.publishedProductId ?? '' },
    });

    expect(variants).toHaveLength(1);
    expect(variants[0]?.sku).toBe('OFF-S');
  });

  it('approves a listing with no variants into exactly one base offer', async () => {
    // The shape every listing approved before this feature existed has. It
    // must come out the other side unchanged.
    const draftId = await makeDraft();

    const { offerId } = await decideListing({ draftId, to: 'APPROVED', adminUserId });

    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    const productId = draft.publishedProductId ?? '';

    const variants = await prisma.productVariant.findMany({ where: { productId } });
    expect(variants).toEqual([]);

    const offers = await prisma.sellerOffer.findMany({ where: { productId } });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.variantKey).toBe('');
    expect(offers[0]?.id).toBe(offerId);
    // The opening stock from the wizard still lands.
    expect(offers[0]?.availableQuantity).toBe(3);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.hasVariants).toBe(false);
  });

  it('publishes a price row per size once the seller puts them on sale', async () => {
    /*
     * The link between the two halves of this feature.
     *
     * A seller describing sizes in the wizard is worth nothing unless a
     * shopper can see them, and the storefront reads prices out of
     * `product_prices` rather than out of the offers - the grid, the facets
     * and the selector all root there. So this asserts the thing that
     * actually makes a seller's size run visible: one row per variant, plus
     * the "from" row under the empty key that the category grid reads.
     */
    const currency = await prisma.currency.findFirst({ select: { code: true } });
    if (currency === null) return; // A deployment with no currencies has no shelves.

    const draftId = await makeDraft();

    await prisma.sellerListingDraft.update({
      where: { id: draftId },
      data: {
        offerJson: { priceMinor: '49900', currency: currency.code },
        variantAxesJson: { axes: [{ axisKey: 'size', values: [{ label: 'S' }, { label: 'L' }] }] },
        variantsJson: [
          {
            optionSignature: '',
            options: { size: 'S' },
            name: 'S',
            sku: 'VIS-S',
            isActive: true,
            priceMinor: '49900',
            stock: [{ locationId, availableQuantity: 7 }],
          },
          {
            optionSignature: '',
            options: { size: 'L' },
            name: 'L',
            sku: 'VIS-L',
            isActive: true,
            // Dearer, which is the case a single family price cannot express.
            priceMinor: '59900',
            stock: [{ locationId, availableQuantity: 0 }],
          },
        ],
      },
    });

    await decideListing({ draftId, to: 'APPROVED', adminUserId });

    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    const productId = draft.publishedProductId ?? '';

    // Approved listings start INACTIVE - the seller decides when. Nothing is
    // published until they do, which is itself worth asserting.
    expect(await prisma.productPrice.count({ where: { productId } })).toBe(0);

    const offers = await prisma.sellerOffer.findMany({ where: { productId } });
    for (const offer of offers) {
      await setOfferStatus(membership, offer.id, 'ACTIVE');
    }

    const priceRows = await prisma.productPrice.findMany({
      where: { productId, currencyCode: currency.code },
    });

    // Two variants and the "from" row the category grid reads.
    expect(priceRows).toHaveLength(3);

    const base = priceRows.find((row) => row.variantKey === '');
    expect(base?.basePriceMinor).toBe(49900n);

    const small = offers.find((offer) => offer.sellerSku === 'VIS-S');
    const large = offers.find((offer) => offer.sellerSku === 'VIS-L');

    expect(
      priceRows.find((row) => row.variantKey === small?.variantKey)?.basePriceMinor,
    ).toBe(49900n);
    expect(
      priceRows.find((row) => row.variantKey === large?.variantKey)?.basePriceMinor,
    ).toBe(59900n);

    // Pausing the dearer size removes its row and leaves the other alone.
    if (large !== undefined) await setOfferStatus(membership, large.id, 'PAUSED', null, 'No stock');

    const afterPause = await prisma.productPrice.findMany({ where: { productId } });
    expect(afterPause.some((row) => row.variantKey === large?.variantKey)).toBe(false);
    expect(afterPause.some((row) => row.variantKey === small?.variantKey)).toBe(true);

    // And the reason the seller gave is kept against the offer.
    const paused = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: large?.id ?? '' } });
    expect(paused.statusReason).toBe('No stock');
  });

  it('adds versions to a listing that was published without any', async () => {
    /*
     * The case every existing catalogue is in.
     *
     * A suit listed as one thing, one code, one price. Somewhere there is a
     * rack of them in four sizes and the seller has no way to say so without
     * deleting the listing. This is that way: the original keeps its id, its
     * code and its order history, and the sizes are added beside it.
     */
    const draftId = await makeDraft();
    const { offerId } = await decideListing({ draftId, to: 'APPROVED', adminUserId });
    const baseOfferId = offerId ?? '';

    const before = await readOfferVariants(membership, baseOfferId);
    expect(before.hasVariants).toBe(false);
    expect(before.existing).toHaveLength(1);
    expect(before.existing[0]?.isBaseListing).toBe(true);
    // The clothing template resolved, so the seller is offered real axes.
    expect(before.template?.axes.some((axis) => axis.key === 'size')).toBe(true);
    // Approved listings are INACTIVE, so this one is editable straight away.
    expect(before.isEditable).toBe(true);

    const productId = before.productId;

    await addOfferVariants({
      membership,
      offerId: baseOfferId,
      axes: [{ axisKey: 'size', values: [{ label: '38' }, { label: '40' }] }],
      rows: [
        {
          optionSignature: '',
          options: { size: '38' },
          name: '38',
          sku: 'RAY-001-38',
          isActive: true,
          priceMinor: '799900',
          stock: [{ locationId, availableQuantity: 4 }],
        },
        {
          optionSignature: '',
          options: { size: '40' },
          name: '40',
          sku: 'RAY-001-40',
          isActive: true,
          priceMinor: '799900',
          stock: [{ locationId, availableQuantity: 2 }],
        },
      ],
    });

    // The original listing is untouched - same id, same code.
    const original = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: baseOfferId } });
    expect(original.variantKey).toBe('');
    expect(original.archivedAt).toBeNull();

    const variants = await prisma.productVariant.findMany({ where: { productId } });
    expect(variants.map((row) => row.sku).sort()).toEqual(['RAY-001-38', 'RAY-001-40']);

    const after = await readOfferVariants(membership, baseOfferId);
    expect(after.hasVariants).toBe(true);
    // The base listing plus the two new sizes.
    expect(after.existing).toHaveLength(3);

    // New versions start off sale, so adding six sizes does not put six
    // things in front of buyers the instant Save is pressed.
    const added = await prisma.sellerOffer.findMany({
      where: { productId, variantKey: { not: '' } },
    });
    expect(added.every((row) => row.status === 'INACTIVE')).toBe(true);
    expect(added.find((row) => row.sellerSku === 'RAY-001-38')?.availableQuantity).toBe(4);
  });

  it('adds nothing the second time the same versions are sent', async () => {
    const draftId = await makeDraft();
    const { offerId } = await decideListing({ draftId, to: 'APPROVED', adminUserId });

    const rows: Parameters<typeof addOfferVariants>[0]['rows'] = [
      {
        optionSignature: '',
        options: { size: 'M' },
        name: 'M',
        sku: 'IDEMP-M',
        isActive: true,
        priceMinor: '10000',
        stock: [],
      },
    ];

    const axes = [{ axisKey: 'size', values: [{ label: 'M' }] }];

    const first = await addOfferVariants({ membership, offerId: offerId ?? '', axes, rows });
    const second = await addOfferVariants({ membership, offerId: offerId ?? '', axes, rows });

    expect(first.created).toBe(1);
    // Pressing the button twice is a thing people do. The second press must
    // not duplicate the size or overwrite the price set on the first.
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('refuses to add versions while the listing is on sale', async () => {
    const draftId = await makeDraft();
    const { offerId } = await decideListing({ draftId, to: 'APPROVED', adminUserId });

    await setOfferStatus(membership, offerId ?? '', 'ACTIVE');

    await expect(
      addOfferVariants({
        membership,
        offerId: offerId ?? '',
        axes: [{ axisKey: 'size', values: [{ label: 'S' }] }],
        rows: [
          {
            optionSignature: '',
            options: { size: 'S' },
            name: 'S',
            sku: 'LIVE-S',
            isActive: true,
            priceMinor: '10000',
            stock: [],
          },
        ],
      }),
      // Buyers may have the page open. Structural changes wait for a pause.
    ).rejects.toThrow(/pause/i);
  });

  it('refuses a version with no price rather than storing it to fix later', async () => {
    const draftId = await makeDraft();
    const { offerId } = await decideListing({ draftId, to: 'APPROVED', adminUserId });

    await expect(
      addOfferVariants({
        membership,
        offerId: offerId ?? '',
        axes: [{ axisKey: 'size', values: [{ label: 'S' }] }],
        rows: [
          {
            optionSignature: '',
            options: { size: 'S' },
            name: 'S',
            sku: 'NOPRICE-S',
            isActive: true,
            priceMinor: null,
            stock: [],
          },
        ],
      }),
      // Unlike a draft, every row here is buyable within the minute.
    ).rejects.toThrow();
  });

  it('will not let a seller add versions to another seller\'s listing', async () => {
    const draftId = await makeDraft();
    const { offerId } = await decideListing({ draftId, to: 'APPROVED', adminUserId });

    const intruder: SellerMembership = { ...membership, sellerAccountId: newId() };

    await expect(readOfferVariants(intruder, offerId ?? '')).rejects.toThrow();
  });

  it('refuses to put one seller\'s sizes onto a product they merely matched', async () => {
    // Three distributors compete on one product page. The sizes on that page
    // belong to the product, not to whichever of them listed most recently.
    const hostId = newId();
    await prisma.product.create({
      data: {
        id: hostId,
        categoryId,
        name: 'Shared Shirt',
        slug: `shared-shirt-${hostId.toLowerCase().slice(-6)}`,
        sku: `HOST-${hostId.slice(-10)}`,
        taxClassId,
        basePriceMinor: 49900n,
        currency: 'INR',
        status: 'ACTIVE',
        isMarketplaceProduct: true,
      },
    });

    const draftId = await makeDraft({ matchedProductId: hostId });

    await prisma.sellerListingDraft.update({
      where: { id: draftId },
      data: {
        variantAxesJson: { axes: [{ axisKey: 'colour', values: [{ label: 'Neon Pink' }] }] },
        variantsJson: [
          {
            optionSignature: '',
            options: { colour: 'Neon Pink' },
            name: 'Neon Pink',
            sku: 'RIVAL-PINK',
            isActive: true,
            priceMinor: '49900',
            stock: [],
          },
        ],
      },
    });

    await decideListing({ draftId, to: 'APPROVED', adminUserId });

    // No variant was invented on the shared product.
    const variants = await prisma.productVariant.findMany({ where: { productId: hostId } });
    expect(variants).toEqual([]);

    // The seller still got their offer - matching is a supported thing to do.
    const offers = await prisma.sellerOffer.findMany({ where: { productId: hostId } });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.variantKey).toBe('');
  });
});
