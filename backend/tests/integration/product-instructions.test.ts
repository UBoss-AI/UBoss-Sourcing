/**
 * Instructions a shopper leaves on a product, without buying it.
 *
 * The feature exists because the basket's per-line note arrives too late: it
 * only exists once the product is in a basket, and it only reaches a seller if
 * that basket becomes an order. The questions that decide whether there will
 * be an order at all — "do you do this in 8mm?", "can you supply a calibration
 * certificate?" — are asked before either.
 *
 * Each case here is a way this could go wrong in a way nothing else would
 * catch:
 *
 *   - **One row per shopper per product.** Saving twice must replace, not
 *     append. Anything else is a comment thread with no moderation.
 *   - **Clearing the box takes it back.** An empty body must delete the row,
 *     not store `''` — a blank line in a seller's list means "somebody changed
 *     their mind" and reads as a bug.
 *   - **A seller reads only products they sell.** Without that, the endpoint
 *     is a way to read every buyer requirement in the catalogue by posting
 *     product ids.
 *   - **A paused listing still reads them.** The seller whose listing is off
 *     sale is exactly the seller who needs to know why nobody was buying it.
 *   - **A product nobody may browse cannot be written against.** Otherwise
 *     this endpoint confirms which ids exist in a catalogue you cannot see.
 *   - **Another shopper's instruction is not deletable.**
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  deleteOwnInstruction,
  listInstructionsForOffer,
  listInstructionsForSeller,
  listInstructionsForSellerAccount,
  readOwnInstruction,
  saveOwnInstruction,
} from '../../src/modules/catalog/product-instruction.service.js';

const CATEGORY_SLUG = 'product-instruction-test-category';
const SELLER_SLUG = 'instruction-acme';
const OTHER_SELLER_SLUG = 'instruction-rival';
const TAX_CLASS_CODE = 'PI-GST-18';

let categoryId = '';
let taxClassId = '';
let productId = '';
let hiddenProductId = '';
let sellerAccountId = '';
let otherSellerAccountId = '';
let offerId = '';
let buyerProfileId = '';
let otherBuyerProfileId = '';

/**
 * Everything this file made, in dependency order.
 *
 * Run before AND after. Orders are ON DELETE RESTRICT across this schema, so a
 * file that leaves rows behind breaks the first file of the next run rather
 * than itself — which is the hardest kind of failure to attribute.
 */
async function cleanUp(): Promise<void> {
  const sellerSlugs = { in: [SELLER_SLUG, OTHER_SELLER_SLUG] };

  await prisma.productInstruction.deleteMany({
    where: { product: { category: { slug: CATEGORY_SLUG } } },
  });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: sellerSlugs } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: sellerSlugs } });
  await prisma.productPrice.deleteMany({
    where: { product: { category: { slug: CATEGORY_SLUG } } },
  });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
  await prisma.customerProfile.deleteMany({
    where: { user: { emailNormalized: { startsWith: 'instruction-buyer-' } } },
  });
  await prisma.user.deleteMany({
    where: { emailNormalized: { startsWith: 'instruction-buyer-' } },
  });
  await prisma.taxClass.deleteMany({ where: { code: TAX_CLASS_CODE } });
}

async function makeBuyer(suffix: string): Promise<string> {
  const userId = newId();
  const profileId = newId();
  const email = `instruction-buyer-${suffix}@example.test`;

  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: 'not-a-real-hash',
      status: 'ACTIVE',
    },
  });

  await prisma.customerProfile.create({
    data: {
      id: profileId,
      userId,
      fullName: suffix === 'one' ? 'Priya Nair' : 'Samuel Okoro',
      organization: suffix === 'one' ? 'Northgate Clinical' : null,
    },
  });

  return profileId;
}

async function makeProduct(options: { published: boolean; sku: string }): Promise<string> {
  const id = newId();

  await prisma.product.create({
    data: {
      id,
      sku: options.sku,
      slug: `${options.sku.toLowerCase()}-${id.slice(-8).toLowerCase()}`,
      name: 'Instruction Test Widget',
      categoryId,
      taxClassId,
      currency: 'INR',
      basePriceMinor: 45_000n,
      status: options.published ? 'ACTIVE' : 'DRAFT',
      isPublished: options.published,
      ...(options.published ? { publishedAt: new Date() } : {}),
    },
  });

  return id;
}

beforeAll(async () => {
  await cleanUp();

  /*
   * The tax class and the category are created here rather than read from the
   * seed, for the reason the wishlist fixture next door states: files share
   * one database and several clear the reference tables, so "find the first
   * active tax class" passes alone and fails in the full suite depending on
   * which file ran before it.
   */
  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: TAX_CLASS_CODE,
      name: 'GST 18%',
      ratePercent: '18.000000',
      isActive: true,
    },
  });

  taxClassId = taxClass.id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Instruction Test', slug: CATEGORY_SLUG, isActive: true },
  });

  categoryId = category.id;

  productId = await makeProduct({ published: true, sku: `PI-LIVE-${newId().slice(-8)}` });
  hiddenProductId = await makeProduct({ published: false, sku: `PI-DRAFT-${newId().slice(-8)}` });

  for (const [slug, name] of [
    [SELLER_SLUG, 'Instruction Acme'],
    [OTHER_SELLER_SLUG, 'Instruction Rival'],
  ] as const) {
    const account = await prisma.sellerAccount.create({
      data: {
        id: newId(),
        slug,
        displayName: name,
        displayNameNormalized: name.toLowerCase(),
        legalName: name,
        kind: 'WHOLESALER',
        registrationCountry: 'IN',
        status: 'APPROVED',
      },
    });

    if (slug === SELLER_SLUG) sellerAccountId = account.id;
    else otherSellerAccountId = account.id;
  }

  const offer = await prisma.sellerOffer.create({
    data: {
      id: newId(),
      sellerAccountId,
      productId,
      variantKey: '',
      sellerSku: 'PI-OFFER-1',
      // PAUSED, not ACTIVE, deliberately. The seller whose listing is off sale
      // is exactly the one who needs to read why nobody was buying it, so the
      // gate must not be "an ACTIVE offer".
      status: 'PAUSED',
      priceMinor: 45_000n,
      currency: 'INR',
    },
  });

  offerId = offer.id;

  buyerProfileId = await makeBuyer('one');
  otherBuyerProfileId = await makeBuyer('two');
});

afterAll(cleanUp);

describe('leaving an instruction', () => {
  it('holds one per shopper per product, and saving again replaces it', async () => {
    const first = await saveOwnInstruction(buyerProfileId, {
      productId,
      body: 'Do you supply this in 8 mm?',
    });

    const second = await saveOwnInstruction(buyerProfileId, {
      productId,
      body: 'Do you supply this in 8 mm? We would need about 400 a month.',
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // The same row, edited. Not a second one: this is a standing instruction,
    // not a thread.
    expect(second?.id).toBe(first?.id);
    expect(second?.body).toContain('400 a month');

    await expect(
      prisma.productInstruction.count({ where: { customerProfileId: buyerProfileId, productId } }),
    ).resolves.toBe(1);
  });

  it('reads back what the shopper wrote, so the box opens filled in', async () => {
    const stored = await readOwnInstruction(buyerProfileId, productId);

    expect(stored?.body).toContain('8 mm');
    // The sentinel becomes an absence on the way out: a client reads "about
    // the product" rather than an empty string.
    expect(stored?.variantId).toBeNull();
  });

  it('trims, and treats an emptied box as taking it back', async () => {
    const padded = await saveOwnInstruction(buyerProfileId, {
      productId,
      body: '   Sterile packs only.   ',
    });

    expect(padded?.body).toBe('Sterile packs only.');

    const cleared = await saveOwnInstruction(buyerProfileId, { productId, body: '   ' });

    // Null, and the row is gone. Never `''` — a blank line in the seller's
    // list means "somebody changed their mind" and reads as a bug.
    expect(cleared).toBeNull();
    await expect(readOwnInstruction(buyerProfileId, productId)).resolves.toBeNull();
  });

  it('refuses a product nobody is allowed to browse', async () => {
    // Otherwise this endpoint is a way to confirm which ids exist in a
    // catalogue you cannot see.
    await expect(
      saveOwnInstruction(buyerProfileId, { productId: hiddenProductId, body: 'Anything.' }),
    ).rejects.toThrow(/not found/i);
  });

  it('will not let one shopper delete another shopper instruction', async () => {
    const mine = await saveOwnInstruction(buyerProfileId, {
      productId,
      body: 'Please quote for 400 a month.',
    });

    await expect(deleteOwnInstruction(otherBuyerProfileId, mine?.id ?? '')).rejects.toThrow(
      /not found/i,
    );

    // Still there. "Not found" was a refusal, not a silent success.
    await expect(readOwnInstruction(buyerProfileId, productId)).resolves.not.toBeNull();
  });
});

describe('what the seller can read', () => {
  it('shows every shopper who asked, with who they are', async () => {
    await saveOwnInstruction(buyerProfileId, { productId, body: 'Do you do 8 mm?' });
    await saveOwnInstruction(otherBuyerProfileId, {
      productId,
      body: 'Can you supply a calibration certificate?',
    });

    const rows = await listInstructionsForSeller(sellerAccountId, productId);

    expect(rows).toHaveLength(2);
    // Newest first: what came in this morning is what a seller came to find.
    expect(rows[0]?.body).toContain('calibration');

    const priya = rows.find((row) => row.customerName === 'Priya Nair');
    expect(priya?.customerOrganization).toBe('Northgate Clinical');
    expect(priya?.productSku).not.toBe('');
  });

  it('reads them through the listing the seller is looking at', async () => {
    const rows = await listInstructionsForOffer(sellerAccountId, offerId);
    expect(rows).toHaveLength(2);
  });

  it('shows a seller nothing on a product they do not sell', async () => {
    // The gate. Without it, posting product ids at this endpoint reads every
    // buyer requirement in the catalogue.
    await expect(listInstructionsForSeller(otherSellerAccountId, productId)).resolves.toEqual([]);
    await expect(listInstructionsForSellerAccount(otherSellerAccountId)).resolves.toEqual([]);
  });

  it('refuses a listing that belongs to somebody else', async () => {
    await expect(listInstructionsForOffer(otherSellerAccountId, offerId)).rejects.toThrow(
      /not found/i,
    );
  });

  it('collects them across everything the seller sells', async () => {
    const rows = await listInstructionsForSellerAccount(sellerAccountId);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.productId === productId)).toBe(true);
  });
});
