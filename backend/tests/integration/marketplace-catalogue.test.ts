/**
 * A seller's product reaching the shop.
 *
 * The bug this file exists to keep fixed was total and silent: a seller
 * described a product, a moderator approved it, the seller put it on sale — and
 * it appeared in no category, no search result and no facet count. The
 * storefront's grid is rooted at `product_prices` ("rooted at the price row for
 * this currency, so the filter and the sort both operate on the amount the
 * shopper is actually shown"), and a seller never writes one. They write an
 * offer.
 *
 * So the price row for a marketplace product is a projection of its live
 * offers, and these are the claims that have to hold:
 *
 *   - **A live offer puts the product on the shelf**, at the seller's own
 *     figure rather than at anything the operator typed.
 *   - **Pausing the last offer takes it off again.** "A marketplace product
 *     becomes visible because a live offer points at it" is what the
 *     moderation service has always said; this is what makes it true.
 *   - **A price change moves the shelf with it**, in the same transaction, so
 *     no shopper is ever quoted one figure in the grid and charged another.
 *   - **The cheapest live offer wins** when two sellers offer the same thing,
 *     and a currency is never crossed to find it.
 *   - **The operator's own prices are never touched.** A bug here that reached
 *     them would rewrite the catalogue.
 *   - **Adding one to a basket binds the seller's offer**, without the browser
 *     naming it — otherwise the line is priced off a row nobody sells at,
 *     settles against nobody, and never reaches the seller who has to pack it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/domain/errors.js';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { addItem } from '../../src/modules/cart/cart.service.js';
import { publicProductWhere } from '../../src/modules/catalog/catalog.visibility.js';
import { syncMarketplacePrice } from '../../src/modules/catalog/marketplace-price.service.js';
import { setOfferStatus, updateOfferPrice } from '../../src/modules/seller/offer.service.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';

const EMAIL = 'mp-catalogue-buyer@test.local';
const CATEGORY_SLUG = 'mp-catalogue-test';

let categoryId = '';
let taxClassId = '';
let sellerProductId = '';
let operatorProductId = '';
let acmeId = '';
let rivalId = '';
let acmeOfferId = '';
let rivalOfferId = '';
let customerProfileId = '';
let acme: SellerMembership;
let rival: SellerMembership;

/**
 * The grid's own question, asked the way the grid asks it.
 *
 * Rooted at `productPrice` and filtered by `publicProductWhere()`, which is
 * what `GET /catalog/products` does. Asserting against the offers instead would
 * test that the offers exist — which was never in doubt, and was not the bug.
 */
async function shelf(currency: string): Promise<{ productId: string; minor: string }[]> {
  const rows = await prisma.productPrice.findMany({
    where: {
      currencyCode: currency,
      variantKey: '',
      product: { ...publicProductWhere(), category: { slug: CATEGORY_SLUG, isActive: true, archivedAt: null } },
    },
    select: { productId: true, basePriceMinor: true },
    orderBy: { basePriceMinor: 'asc' },
  });

  return rows.map((row) => ({ productId: row.productId, minor: row.basePriceMinor.toString() }));
}

async function makeSeller(slug: string, displayName: string): Promise<string> {
  const id = newId();

  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${displayName} Ltd`,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
      slug,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  return id;
}

function membershipFor(accountId: string, displayName: string, slug: string): SellerMembership {
  return {
    sellerAccountId: accountId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName,
    legalName: `${displayName} Ltd`,
    slug,
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
    logoStorageKey: null,
  };
}

/** An offer, written directly: what is under test is what happens to it after. */
async function makeOffer(input: {
  sellerAccountId: string;
  productId: string;
  sellerSku: string;
  priceMinor: bigint;
  currency?: string;
  status?: 'ACTIVE' | 'INACTIVE';
}): Promise<string> {
  const id = newId();

  await prisma.sellerOffer.create({
    data: {
      id,
      sellerAccountId: input.sellerAccountId,
      productId: input.productId,
      variantKey: '',
      sellerSku: input.sellerSku,
      status: input.status ?? 'ACTIVE',
      priceMinor: input.priceMinor,
      currency: input.currency ?? 'INR',
    },
  });

  return id;
}

async function cleanUp(): Promise<void> {
  await prisma.cartItem.deleteMany({ where: { cart: { customerProfile: { user: { emailNormalized: EMAIL } } } } });
  await prisma.cart.deleteMany({ where: { customerProfile: { user: { emailNormalized: EMAIL } } } });
  await prisma.sellerAuditLog.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'mpc-' } } },
  });
  await prisma.sellerOffer.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'mpc-' } } },
  });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: 'mpc-' } } });
  await prisma.productPrice.deleteMany({ where: { product: { category: { slug: CATEGORY_SLUG } } } });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

beforeAll(async () => {
  await cleanUp();

  const taxClass = await prisma.taxClass.findFirst({ select: { id: true } });

  taxClassId =
    taxClass?.id ??
    (
      await prisma.taxClass.create({
        data: {
          id: newId(),
          code: 'MPC12',
          name: 'GST 12%',
          ratePercent: '12.000000',
          isActive: true,
        },
      })
    ).id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Marketplace catalogue', slug: CATEGORY_SLUG, isActive: true },
  });
  categoryId = category.id;

  /*
   * The product a SELLER described.
   *
   * Exactly what `publishApprovedListing` writes: active, published, marked as
   * the marketplace's, and with no price row of its own - which is the whole
   * shape of the bug.
   */
  const sellerProduct = await prisma.product.create({
    data: {
      id: newId(),
      categoryId,
      taxClassId,
      name: 'Seller described widget',
      slug: 'mpc-seller-widget',
      sku: 'MPC-SELLER-1',
      basePriceMinor: 0n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isMarketplaceProduct: true,
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  sellerProductId = sellerProduct.id;

  /** The OPERATOR's own product, with a price a person typed. It must not move. */
  const operatorProduct = await prisma.product.create({
    data: {
      id: newId(),
      categoryId,
      taxClassId,
      name: 'Operator widget',
      slug: 'mpc-operator-widget',
      sku: 'MPC-OPERATOR-1',
      basePriceMinor: 5_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  operatorProductId = operatorProduct.id;

  await prisma.productPrice.create({
    data: {
      id: newId(),
      productId: operatorProductId,
      variantKey: '',
      currencyCode: 'INR',
      basePriceMinor: 5_000n,
    },
  });

  acmeId = await makeSeller('mpc-acme', 'MPC Acme');
  rivalId = await makeSeller('mpc-rival', 'MPC Rival');

  acme = membershipFor(acmeId, 'MPC Acme', 'mpc-acme');
  rival = membershipFor(rivalId, 'MPC Rival', 'mpc-rival');

  const user = await prisma.user.create({
    data: {
      id: newId(),
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: 'x',
      type: 'CUSTOMER',
      status: 'ACTIVE',
    },
  });

  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'MPC Buyer', preferredCurrency: 'INR' },
  });
  customerProfileId = profile.id;
});

beforeEach(async () => {
  // Basket lines first: `cart_items.sellerOfferId` is a foreign key, so a line
  // left behind by the previous case makes the offer undeletable and every
  // case after it fails on the fixture rather than on what it was testing.
  await prisma.cartItem.deleteMany({
    where: { cart: { customerProfile: { user: { emailNormalized: EMAIL } } } },
  });
  await prisma.sellerOffer.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'mpc-' } } },
  });
  await prisma.productPrice.deleteMany({ where: { productId: sellerProductId } });

  acmeOfferId = await makeOffer({
    sellerAccountId: acmeId,
    productId: sellerProductId,
    sellerSku: 'ACME-1',
    priceMinor: 12_000n,
  });

  rivalOfferId = '';

  await prisma.$transaction((tx) => syncMarketplacePrice(tx, sellerProductId));
});

afterAll(async () => {
  await cleanUp();
});

describe('a live offer puts a marketplace product on the shelf', () => {
  it('lists it at the seller’s price, not at anything the operator typed', async () => {
    const rows = await shelf('INR');

    expect(rows).toEqual([
      { productId: operatorProductId, minor: '5000' },
      { productId: sellerProductId, minor: '12000' },
    ]);
  });

  it('leaves it off the shelf while no offer is live', async () => {
    await prisma.sellerOffer.update({
      where: { id: acmeOfferId },
      data: { status: 'INACTIVE' },
    });
    await prisma.$transaction((tx) => syncMarketplacePrice(tx, sellerProductId));

    const rows = await shelf('INR');
    expect(rows.map((row) => row.productId)).toEqual([operatorProductId]);
  });

  it('never writes a shelf in a currency nobody offers it in', async () => {
    expect(await shelf('EUR')).toEqual([]);
  });
});

describe('the shelf follows the offer', () => {
  it('takes the product off when the seller pauses their only offer', async () => {
    await setOfferStatus(acme, acmeOfferId, 'PAUSED');

    const rows = await shelf('INR');
    expect(rows.map((row) => row.productId)).toEqual([operatorProductId]);
  });

  it('puts it back when they resume', async () => {
    await setOfferStatus(acme, acmeOfferId, 'PAUSED');
    await setOfferStatus(acme, acmeOfferId, 'ACTIVE');

    const rows = await shelf('INR');
    expect(rows).toContainEqual({ productId: sellerProductId, minor: '12000' });
  });

  it('moves the price with a price change', async () => {
    await updateOfferPrice(acme, acmeOfferId, { priceMinor: '9500' });

    const rows = await shelf('INR');
    expect(rows).toContainEqual({ productId: sellerProductId, minor: '9500' });
  });

  it('follows the seller to another currency rather than leaving a row behind', async () => {
    await updateOfferPrice(acme, acmeOfferId, { priceMinor: '9500', currency: 'EUR' });

    // The old shelf is gone, not stale. A row nothing points at is a product
    // on a shelf nobody stocks.
    expect((await shelf('INR')).map((row) => row.productId)).toEqual([operatorProductId]);
    expect(await shelf('EUR')).toEqual([{ productId: sellerProductId, minor: '9500' }]);
  });
});

describe('two sellers, one product', () => {
  it('shows the cheapest live offer', async () => {
    rivalOfferId = await makeOffer({
      sellerAccountId: rivalId,
      productId: sellerProductId,
      sellerSku: 'RIVAL-1',
      priceMinor: 8_000n,
    });
    await prisma.$transaction((tx) => syncMarketplacePrice(tx, sellerProductId));

    expect(await shelf('INR')).toContainEqual({ productId: sellerProductId, minor: '8000' });
  });

  it('falls back to the one that is left when the cheaper seller pauses', async () => {
    rivalOfferId = await makeOffer({
      sellerAccountId: rivalId,
      productId: sellerProductId,
      sellerSku: 'RIVAL-1',
      priceMinor: 8_000n,
    });
    await prisma.$transaction((tx) => syncMarketplacePrice(tx, sellerProductId));

    await setOfferStatus(rival, rivalOfferId, 'PAUSED');

    expect(await shelf('INR')).toContainEqual({ productId: sellerProductId, minor: '12000' });
  });

  it('never crosses a currency to find a cheaper number', async () => {
    // 90 euros is a smaller NUMBER than 12,000 rupees and a larger amount of
    // money. Comparing them at all is the conversion this system does not do.
    rivalOfferId = await makeOffer({
      sellerAccountId: rivalId,
      productId: sellerProductId,
      sellerSku: 'RIVAL-EUR',
      priceMinor: 9_000n,
      currency: 'EUR',
    });
    await prisma.$transaction((tx) => syncMarketplacePrice(tx, sellerProductId));

    expect(await shelf('INR')).toContainEqual({ productId: sellerProductId, minor: '12000' });
    expect(await shelf('EUR')).toEqual([{ productId: sellerProductId, minor: '9000' }]);
  });
});

describe('the operator’s own catalogue', () => {
  it('is never rewritten by the projection', async () => {
    await syncMarketplacePrice(prisma, operatorProductId);

    const row = await prisma.productPrice.findFirst({
      where: { productId: operatorProductId, currencyCode: 'INR', variantKey: '' },
      select: { basePriceMinor: true },
    });

    // Still the figure a person typed, and still there at all - an earlier
    // draft of the projection would have deleted it for having no offers.
    expect(row?.basePriceMinor.toString()).toBe('5000');
  });
});

describe('adding one to a basket', () => {
  it('binds the seller’s offer without the browser naming it', async () => {
    await addItem(customerProfileId, { productId: sellerProductId, quantity: 1 });

    const item = await prisma.cartItem.findFirst({
      where: { productId: sellerProductId },
      select: { sellerOfferId: true, sellerOfferKey: true },
    });

    expect(item?.sellerOfferId).toBe(acmeOfferId);
    // Never null on the column the unique index is built over - see the schema.
    expect(item?.sellerOfferKey).toBe(acmeOfferId);
  });

  it('binds the cheapest one, which is the figure they were shown', async () => {
    rivalOfferId = await makeOffer({
      sellerAccountId: rivalId,
      productId: sellerProductId,
      sellerSku: 'RIVAL-1',
      priceMinor: 8_000n,
    });
    await prisma.$transaction((tx) => syncMarketplacePrice(tx, sellerProductId));

    await addItem(customerProfileId, { productId: sellerProductId, quantity: 1 });

    const item = await prisma.cartItem.findFirst({
      where: { productId: sellerProductId },
      select: { sellerOfferId: true },
    });

    expect(item?.sellerOfferId).toBe(rivalOfferId);
  });

  it('refuses when nobody is selling it', async () => {
    await setOfferStatus(acme, acmeOfferId, 'PAUSED');

    await expect(
      addItem(customerProfileId, { productId: sellerProductId, quantity: 1 }),
    ).rejects.toMatchObject({ code: ErrorCode.CART_ITEM_UNAVAILABLE });
  });

  it('leaves an operator line alone', async () => {
    await addItem(customerProfileId, { productId: operatorProductId, quantity: 1 });

    const item = await prisma.cartItem.findFirst({
      where: { productId: operatorProductId },
      select: { sellerOfferId: true, sellerOfferKey: true },
    });

    expect(item?.sellerOfferId).toBeNull();
    expect(item?.sellerOfferKey).toBe('');
  });
});
