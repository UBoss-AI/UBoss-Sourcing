/**
 * A seller editing something they already sell.
 *
 * The unit tests cover the arithmetic of a matrix. This covers the thing a
 * seller does on a Tuesday afternoon: open a listing that is live, change what
 * it costs, add the size they have started stocking, stop offering the one
 * they have not, and put it back on sale — without any of it touching the
 * orders already placed against it.
 *
 * Each case here is a way this has gone wrong in catalogues before:
 *
 *   - **The form arrives filled in.** An edit screen that opens empty is an
 *     edit screen that silently creates a second product.
 *   - **A live listing refuses a structural change.** Adding a size under
 *     somebody mid-purchase means they choose one that stops existing between
 *     the click and the basket.
 *   - **Ids and stock survive a widening.** Adding size 10 to a run of 7-9
 *     must keep three variant ids, three offer ids and three piles of stock.
 *     Regenerating the matrix looks identical from the outside and loses all
 *     of them.
 *   - **A withdrawn size that has been ordered is archived, not deleted.** The
 *     buyer's order page still has to be able to say what was in the box.
 *   - **Resume refuses a listing that is not fit to be seen.** Pausing is what
 *     a seller does in order to change things, so the state they paused in is
 *     not the state they are resuming from.
 *   - **Another seller's listing is not editable.** Ownership is checked on
 *     the row, not inferred from the URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import {
  pauseForEdit,
  readListingForEdit,
  saveListingEdit,
} from '../../src/modules/seller/offer-edit.service.js';

const SELLER_SLUG = 'edit-acme';
const OTHER_SLUG = 'edit-rival';
const CATEGORY_SLUG = 'listing-edit-test-category';

let sellerId = '';
let otherSellerId = '';
let categoryId = '';
let parentCategoryId = '';
let createdParent = false;
let taxClassId = '';
let createdTaxClass = false;
let locationId = '';
let mediaId = '';
let membership: SellerMembership;
let otherMembership: SellerMembership;

async function cleanUp(): Promise<void> {
  // Order matters: offers and inventory reference variants, variants reference
  // products, and every one of those is ON DELETE RESTRICT.
  const slugs = { in: [SELLER_SLUG, OTHER_SLUG] };

  await prisma.sellerInventoryMovement.deleteMany({
    where: { sellerAccount: { slug: slugs } },
  });
  await prisma.sellerInventory.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerPriceTier.deleteMany({
    where: { offer: { sellerAccount: { slug: slugs } } },
  });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: slugs } });

  await prisma.productVariantMedia.deleteMany({
    where: { variant: { product: { category: { slug: CATEGORY_SLUG } } } },
  });
  await prisma.productMedia.deleteMany({
    where: { product: { category: { slug: CATEGORY_SLUG } } },
  });
  await prisma.productVariant.deleteMany({
    where: { product: { category: { slug: CATEGORY_SLUG } } },
  });
  await prisma.productPrice.deleteMany({
    where: { product: { category: { slug: CATEGORY_SLUG } } },
  });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
  await prisma.mediaAsset.deleteMany({ where: { storageKey: 'listing-edit/test.jpg' } });

  if (createdParent) {
    await prisma.category.deleteMany({ where: { slug: 'footwear' } });
    createdParent = false;
  }

  if (createdTaxClass) {
    await prisma.taxClass.deleteMany({ where: { code: 'EDIT-GST18' } });
    createdTaxClass = false;
  }
}

/**
 * A shoe this seller already sells in three sizes, exactly as a published
 * listing looks: one product, three variants, three offers, stock on each.
 *
 * Built by hand rather than through the wizard because what is under test is
 * what happens to rows that ALREADY EXIST, and going through approval first
 * would make every failure here ambiguous between the two.
 */
async function makeLiveListing(options: {
  sellerAccountId: string;
  code: string;
  sizes: string[];
  status?: 'ACTIVE' | 'PAUSED';
}): Promise<{ productId: string; offerIds: Record<string, string>; variantIds: Record<string, string> }> {
  const productId = newId();

  await prisma.product.create({
    data: {
      id: productId,
      categoryId,
      taxClassId,
      name: `${options.code} Walking Shoe`,
      slug: `${options.code.toLowerCase()}-walking-shoe`,
      sku: `${options.code}-PROD`,
      basePriceMinor: 249900n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      isMarketplaceProduct: true,
      hasVariants: true,
      variantAxesJson: ['size'] as never,
    },
  });

  // A photograph, because resuming a listing with none is refused - which is
  // itself one of the cases below and must not accidentally fire in the others.
  await prisma.productMedia.create({
    data: { id: newId(), productId, mediaId, isPrimary: true, sortOrder: 0 },
  });

  const offerIds: Record<string, string> = {};
  const variantIds: Record<string, string> = {};

  for (const [position, size] of options.sizes.entries()) {
    const variantId = newId();
    const offerId = newId();

    await prisma.productVariant.create({
      data: {
        id: variantId,
        productId,
        name: size,
        sku: `${options.code}-${size}`,
        optionsJson: { size } as never,
        optionSignature: `size:${size.toLowerCase()}`,
        priceMinor: 249900n,
        isActive: true,
        sortOrder: position,
      },
    });

    await prisma.sellerOffer.create({
      data: {
        id: offerId,
        sellerAccountId: options.sellerAccountId,
        productId,
        variantId,
        variantKey: variantId,
        sellerSku: `${options.code}-${size}`,
        status: options.status ?? 'ACTIVE',
        priceMinor: 249900n,
        currency: 'INR',
        taxClassId,
        orderingUnit: 'PIECE',
        availableQuantity: 10,
      },
    });

    await prisma.sellerInventory.create({
      data: {
        id: newId(),
        sellerAccountId: options.sellerAccountId,
        offerId,
        locationId,
        availableQuantity: 10,
      },
    });

    offerIds[size] = offerId;
    variantIds[size] = variantId;
  }

  return { productId, offerIds, variantIds };
}

beforeAll(async () => {
  await cleanUp();

  const existingTaxClass = await prisma.taxClass.findFirst({ select: { id: true } });

  if (existingTaxClass === null) {
    taxClassId = newId();
    createdTaxClass = true;
    await prisma.taxClass.create({
      data: { id: taxClassId, code: 'EDIT-GST18', name: 'Edit GST 18%', ratePercent: 18 },
    });
  } else {
    taxClassId = existingTaxClass.id;
  }

  // Hung under a footwear parent so the real Footwear template resolves
  // through the ancestor chain, the same trick the variant listing suite uses.
  const existingParent = await prisma.category.findUnique({
    where: { slug: 'footwear' },
    select: { id: true },
  });

  if (existingParent === null) {
    parentCategoryId = newId();
    createdParent = true;
    await prisma.category.create({
      data: {
        id: parentCategoryId,
        name: 'Footwear',
        slug: 'footwear',
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
      name: 'Listing Edit Shoes',
      slug: CATEGORY_SLUG,
      isActive: true,
      path: `/${parentCategoryId}/`,
    },
  });
  categoryId = category.id;

  mediaId = newId();
  await prisma.mediaAsset.create({
    data: {
      id: mediaId,
      storageKey: 'listing-edit/test.jpg',
      url: 'https://example.invalid/listing-edit/test.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
    },
  });

  for (const [slug, legal] of [
    [SELLER_SLUG, 'Edit Acme Ltd'],
    [OTHER_SLUG, 'Edit Rival Ltd'],
  ] as const) {
    const id = newId();

    await prisma.sellerAccount.create({
      data: {
        id,
        legalName: legal,
        displayName: legal.replace(' Ltd', ''),
        displayNameNormalized: legal.replace(' Ltd', '').toLowerCase(),
        slug,
        kind: 'WHOLESALER',
        registrationCountry: 'IN',
        status: 'APPROVED',
      },
    });

    if (slug === SELLER_SLUG) sellerId = id;
    else otherSellerId = id;
  }

  locationId = newId();
  await prisma.sellerLocation.create({
    data: {
      id: locationId,
      sellerAccountId: sellerId,
      code: 'EA1',
      name: 'Edit Acme Warehouse',
      addressLine1: '1 Test Road',
      city: 'Chennai',
      postcode: '600001',
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
    },
  });

  const base = {
    memberId: newId(),
    customerProfileId: newId(),
    status: 'APPROVED' as const,
    role: 'OWNER' as const,
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
    logoStorageKey: null,
  };

  membership = {
    ...base,
    sellerAccountId: sellerId,
    displayName: 'Edit Acme',
    legalName: 'Edit Acme Ltd',
    slug: SELLER_SLUG,
  };

  otherMembership = {
    ...base,
    memberId: newId(),
    customerProfileId: newId(),
    sellerAccountId: otherSellerId,
    displayName: 'Edit Rival',
    legalName: 'Edit Rival Ltd',
    slug: OTHER_SLUG,
  };
});

afterAll(async () => {
  await cleanUp();
});

// ---------------------------------------------------------------------------

describe('opening a listing to edit it', () => {
  it('arrives filled in, with every version and its stock', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'FILLED',
      sizes: ['7', '8', '9'],
    });

    const view = await readListingForEdit(membership, live.offerIds['8'] ?? '');

    // The terms the form has to render, not an empty shell.
    expect(view.sellerSku).toBe('FILLED-8');
    expect(view.terms.priceMinor).toBe('249900');
    expect(view.product.name).toBe('FILLED Walking Shoe');
    expect(view.product.categoryName).toBe('Listing Edit Shoes');
    expect(view.product.images).toHaveLength(1);

    // Every version THIS seller offers, each with its own stock.
    expect(view.variants).toHaveLength(3);
    expect(view.variants.map((row) => row.sku).sort()).toEqual([
      'FILLED-7',
      'FILLED-8',
      'FILLED-9',
    ]);
    expect(view.variants.every((row) => row.stock[0]?.availableQuantity === 10)).toBe(true);

    // The category's own template, so the seller is offered the axes a shoe
    // actually sells along rather than a blank box.
    expect(view.template).not.toBeNull();
    expect(view.template?.axes.some((axis) => axis.key === 'size')).toBe(true);
  });

  it('refuses a listing belonging to another seller', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'MINE',
      sizes: ['7'],
    });

    await expect(readListingForEdit(otherMembership, live.offerIds['7'] ?? '')).rejects.toThrow();
  });
});

describe('changing a listing that is on sale', () => {
  it('lets the price and the stock through without a pause', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'ROUTINE',
      sizes: ['7', '8'],
    });

    const view = await readListingForEdit(membership, live.offerIds['7'] ?? '');
    expect(view.isStructuralEditAllowed).toBe(false);

    await saveListingEdit({
      membership,
      offerId: live.offerIds['7'] ?? '',
      expectedVersion: view.version,
      // Every row that already exists, re-priced. No row added, none removed:
      // a routine change, which an ACTIVE listing must accept.
      rows: view.variants.map((row) => ({
        ...row,
        priceMinor: '199900',
        stock: [{ locationId, availableQuantity: 4 }],
      })),
      finish: 'ACTIVE',
    });

    const after = await prisma.sellerOffer.findMany({
      where: { id: { in: Object.values(live.offerIds) } },
      select: { priceMinor: true, availableQuantity: true },
    });

    expect(after.every((row) => row.priceMinor === 199900n)).toBe(true);
    expect(after.every((row) => row.availableQuantity === 4)).toBe(true);
  });

  it('refuses to add a version while it is still on sale', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'STRUCT',
      sizes: ['7'],
    });

    const view = await readListingForEdit(membership, live.offerIds['7'] ?? '');

    await expect(
      saveListingEdit({
        membership,
        offerId: live.offerIds['7'] ?? '',
        expectedVersion: view.version,
        rows: [
          ...view.variants,
          {
            optionSignature: 'size:8',
            options: { size: '8' },
            name: '8',
            sku: 'STRUCT-8',
            isActive: true,
            priceMinor: '249900',
            stock: [],
          },
        ],
        finish: 'PAUSED',
      }),
    ).rejects.toThrow(/pause/i);
  });

  it('pauses for editing and records who did it', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'PAUSEME',
      sizes: ['7'],
    });

    const result = await pauseForEdit(membership, live.offerIds['7'] ?? '');
    expect(result.status).toBe('PAUSED');

    const row = await prisma.sellerOffer.findUniqueOrThrow({
      where: { id: live.offerIds['7'] },
      select: { status: true, pausedAt: true, pausedByProfileId: true },
    });

    expect(row.status).toBe('PAUSED');
    expect(row.pausedAt).not.toBeNull();
    expect(row.pausedByProfileId).toBe(membership.customerProfileId);

    // Idempotent: the seller's intent is already true, so pressing it again
    // must not error and must not move the listing anywhere else.
    const again = await pauseForEdit(membership, live.offerIds['7'] ?? '');
    expect(again.status).toBe('PAUSED');
  });
});

describe('widening a size run', () => {
  it('keeps every existing id and every pile of stock, and adds only the new size', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'WIDEN',
      sizes: ['7', '8', '9'],
      status: 'PAUSED',
    });

    const before = await readListingForEdit(membership, live.offerIds['7'] ?? '');

    const result = await saveListingEdit({
      membership,
      offerId: live.offerIds['7'] ?? '',
      expectedVersion: before.version,
      axes: [
        {
          axisKey: 'size',
          values: [{ label: '7' }, { label: '8' }, { label: '9' }, { label: '10' }],
        },
      ],
      rows: [
        ...before.variants,
        {
          optionSignature: 'size:10',
          options: { size: '10' },
          name: '10',
          sku: 'WIDEN-10',
          isActive: true,
          priceMinor: '259900',
          stock: [{ locationId, availableQuantity: 2 }],
        },
      ],
      finish: 'PAUSED',
    });

    expect(result.created).toBe(1);
    expect(result.withdrawn).toBe(0);

    const after = await readListingForEdit(membership, live.offerIds['7'] ?? '');

    // The three that existed are the SAME three rows, not replacements.
    for (const size of ['7', '8', '9'] as const) {
      const row = after.variants.find((entry) => entry.sku === `WIDEN-${size}`);
      expect(row?.offerId).toBe(live.offerIds[size]);
      expect(row?.variantId).toBe(live.variantIds[size]);
      // And nothing reset their stock on the way past.
      expect(row?.stock[0]?.availableQuantity).toBe(10);
    }

    const added = after.variants.find((entry) => entry.sku === 'WIDEN-10');
    expect(added).toBeDefined();
    // New versions arrive off sale. Adding a size must not put something in
    // front of a buyer the instant Save is pressed.
    expect(added?.status).toBe('INACTIVE');
    expect(added?.stock[0]?.availableQuantity).toBe(2);
  });

  it('refuses two versions sharing one product code', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'DUPSKU',
      sizes: ['7', '8'],
      status: 'PAUSED',
    });

    const view = await readListingForEdit(membership, live.offerIds['7'] ?? '');

    await expect(
      saveListingEdit({
        membership,
        offerId: live.offerIds['7'] ?? '',
        expectedVersion: view.version,
        rows: view.variants.map((row) => ({ ...row, sku: 'DUPSKU-SAME' })),
        finish: 'PAUSED',
      }),
    ).rejects.toThrow(/code/i);
  });

  it('refuses a save built from a version somebody else has already moved past', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'STALE',
      sizes: ['7'],
      status: 'PAUSED',
    });

    const view = await readListingForEdit(membership, live.offerIds['7'] ?? '');

    await expect(
      saveListingEdit({
        membership,
        offerId: live.offerIds['7'] ?? '',
        expectedVersion: view.version + 5,
        rows: view.variants,
        finish: 'PAUSED',
      }),
    ).rejects.toThrow(/reload/i);
  });
});

describe('withdrawing a version', () => {
  it('archives one that has been ordered rather than deleting it', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'SOLD',
      sizes: ['7', '8'],
      status: 'PAUSED',
    });

    const view = await readListingForEdit(membership, live.offerIds['7'] ?? '');

    const result = await saveListingEdit({
      membership,
      offerId: live.offerIds['7'] ?? '',
      expectedVersion: view.version,
      // Size 8 simply is not in the payload any more. That is how a seller
      // says they have stopped stocking it.
      rows: view.variants.filter((row) => row.sku !== 'SOLD-8'),
      finish: 'PAUSED',
    });

    expect(result.withdrawn).toBe(1);

    // The rows are still there. Nothing an order could point at was destroyed.
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: live.variantIds['8'] },
      select: { isActive: true, archivedAt: true },
    });

    expect(variant.isActive).toBe(false);
    expect(variant.archivedAt).not.toBeNull();

    const offer = await prisma.sellerOffer.findUniqueOrThrow({
      where: { id: live.offerIds['8'] },
      select: { status: true },
    });

    expect(offer.status).toBe('INACTIVE');
  });
});

describe('putting it back on sale', () => {
  it('refuses while nothing is switched on', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'NONEON',
      sizes: ['7', '8'],
      status: 'PAUSED',
    });

    const view = await readListingForEdit(membership, live.offerIds['7'] ?? '');

    await expect(
      saveListingEdit({
        membership,
        offerId: live.offerIds['7'] ?? '',
        expectedVersion: view.version,
        rows: view.variants.map((row) => ({ ...row, isActive: false })),
        finish: 'ACTIVE',
      }),
    ).rejects.toThrow(/switched on/i);
  });

  it('goes back on sale once it is fit to be seen', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'RESUME',
      sizes: ['7', '8'],
      status: 'PAUSED',
    });

    const view = await readListingForEdit(membership, live.offerIds['7'] ?? '');

    const result = await saveListingEdit({
      membership,
      offerId: live.offerIds['7'] ?? '',
      expectedVersion: view.version,
      terms: { priceMinor: '279900' },
      rows: view.variants,
      finish: 'ACTIVE',
    });

    expect(result.status).toBe('ACTIVE');

    const offer = await prisma.sellerOffer.findUniqueOrThrow({
      where: { id: live.offerIds['7'] },
      select: { status: true, priceMinor: true, pausedAt: true },
    });

    expect(offer.status).toBe('ACTIVE');
    expect(offer.priceMinor).toBe(279900n);
    // The pause trail is cleared when it goes back on sale: it describes the
    // current state, not the history, and the audit log keeps the history.
    expect(offer.pausedAt).toBeNull();
  });

  /**
   * The bug this catches, and why the suite did not catch it before.
   *
   * `seller_offers.taxClassId` is nullable, and it is an OVERRIDE: the rate a
   * buyer is actually charged comes from `products.taxClassId`, which is NOT
   * NULL. Nothing in the seller hub sets the override, the listing wizard
   * never populates the draft slot that would carry it, and the approval path
   * writes whatever the draft held — which is nothing. So every offer in a
   * real catalogue has it null.
   *
   * `assertReadyToResume` used to read that column. The result was that every
   * paused listing in the product refused to go back on sale with "it has no
   * tax class, so the GST on it cannot be worked out", over a field the seller
   * could not set and no pricing path reads.
   *
   * Every existing case above passed straight through it, because
   * `makeLiveListing` sets `taxClassId` on the offer — a fixture more generous
   * than production, which is the specific way a test suite can be green over
   * a screen nobody can use. So this one builds the listing the way the
   * product actually does, with the override null, and requires the resume to
   * work.
   */
  it('goes back on sale when only the product carries the tax class', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'NOTAXOVERRIDE',
      sizes: ['7'],
      status: 'PAUSED',
    });

    // Exactly what the approval path leaves behind. The product keeps its own
    // tax class, which is where the rate has always come from.
    await prisma.sellerOffer.updateMany({
      where: { id: { in: Object.values(live.offerIds) } },
      data: { taxClassId: null },
    });

    const view = await readListingForEdit(membership, live.offerIds['7'] ?? '');

    expect(view.terms.taxClassId).toBeNull();
    expect(view.product.taxClassId).not.toBe('');

    const result = await saveListingEdit({
      membership,
      offerId: live.offerIds['7'] ?? '',
      expectedVersion: view.version,
      rows: view.variants,
      finish: 'ACTIVE',
    });

    expect(result.status).toBe('ACTIVE');
  });

  it('writes what happened to the seller own audit trail', async () => {
    const live = await makeLiveListing({
      sellerAccountId: sellerId,
      code: 'AUDITED',
      sizes: ['7'],
      status: 'PAUSED',
    });

    const view = await readListingForEdit(membership, live.offerIds['7'] ?? '');

    await saveListingEdit({
      membership,
      offerId: live.offerIds['7'] ?? '',
      expectedVersion: view.version,
      terms: { priceMinor: '111100' },
      rows: view.variants,
      finish: 'PAUSED',
    });

    const entry = await prisma.sellerAuditLog.findFirst({
      where: { sellerAccountId: sellerId, resourceId: live.offerIds['7'] },
      orderBy: { createdAt: 'desc' },
      select: { action: true, summary: true },
    });

    expect(entry?.action).toBe('seller.offer.edited');
    expect(entry?.summary).toContain('AUDITED-7');
  });
});
