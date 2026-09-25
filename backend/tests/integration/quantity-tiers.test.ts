/**
 * Quantity price bands, end to end: the seller saves them, the popover's
 * endpoint quotes them, the basket charges them, and the order freezes them.
 *
 * THE BUG THIS FILE EXISTS TO KEEP FIXED
 *
 * `seller_price_tiers` was stored and editable and never read: a buyer adding
 * 5,000 pieces paid the one-piece price. So the claim that matters most here
 * is that the figure the popover promises is the figure the order is charged.
 *
 * THE FIXTURE
 *
 * A seller lists tubing at 10.00 a piece, with bands from 100 (9.50), from 500
 * (9.20), a business-only band from 1,000 (8.80) and a preorder-only band from
 * 10,000 (8.00).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';

let app: Awaited<ReturnType<typeof BuildApp>>;
let prisma: typeof PrismaClient;
let newId: typeof NewId;
let seller: SellerMembership;
let rival: SellerMembership;

const PREFIX = 'qtt-';
const BUYER = 'qtt-buyer@test.local';
const GUEST_LIKE = 'qtt-consumer@test.local';
const STAFF = ['qtt-seller@test.local', 'qtt-rival@test.local'];
const EMAILS = [BUYER, GUEST_LIKE, ...STAFF];

let productId = '';
let offerId = '';
let buyerProfileId = '';
let consumerProfileId = '';
let addressId = '';

async function cleanUp(): Promise<void> {
  const profiles = { user: { emailNormalized: { in: EMAILS } } };
  await prisma.sellerOrderLine.deleteMany({
    where: { orderGroup: { sellerAccount: { slug: { startsWith: PREFIX } } } },
  });
  await prisma.sellerOrderGroup.deleteMany({
    where: { sellerAccount: { slug: { startsWith: PREFIX } } },
  });
  await prisma.orderStatusHistory.deleteMany({ where: { order: { customerProfile: profiles } } });
  await prisma.orderItem.deleteMany({ where: { order: { customerProfile: profiles } } });
  await prisma.order.deleteMany({ where: { customerProfile: profiles } });
  await prisma.cartItem.deleteMany({ where: { cart: { customerProfile: profiles } } });
  await prisma.cart.deleteMany({ where: { customerProfile: profiles } });
  await prisma.sellerAuditLog.deleteMany({
    where: { sellerAccount: { slug: { startsWith: PREFIX } } },
  });
  await prisma.sellerInventoryMovement.deleteMany({
    where: { sellerAccount: { slug: { startsWith: PREFIX } } },
  });
  await prisma.sellerInventory.deleteMany({
    where: { sellerAccount: { slug: { startsWith: PREFIX } } },
  });
  await prisma.sellerPriceTier.deleteMany({
    where: { offer: { sellerAccount: { slug: { startsWith: PREFIX } } } },
  });
  await prisma.sellerPackagingOption.deleteMany({
    where: { profile: { offer: { sellerAccount: { slug: { startsWith: PREFIX } } } } },
  });
  await prisma.sellerPackagingProfile.deleteMany({
    where: { offer: { sellerAccount: { slug: { startsWith: PREFIX } } } },
  });
  await prisma.sellerOffer.deleteMany({
    where: { sellerAccount: { slug: { startsWith: PREFIX } } },
  });
  await prisma.sellerMember.deleteMany({
    where: { sellerAccount: { slug: { startsWith: PREFIX } } },
  });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.productPrice.deleteMany({ where: { product: { slug: { startsWith: PREFIX } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}category` } });
  await prisma.address.deleteMany({ where: { customerProfile: profiles } });
  await prisma.customerProfile.deleteMany({ where: profiles });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
}

async function person(email: string, organization: string | null): Promise<string> {
  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const profile = await prisma.customerProfile.create({
    data: {
      id: newId(),
      userId: user.id,
      fullName: `Person ${email}`,
      organization,
      activatedAt: new Date(),
    },
  });
  return profile.id;
}

const BANDS = {
  tiers: [
    {
      minQuantity: 100,
      maxQuantity: null,
      priceMinor: '950',
      isActive: true,
      startsAt: null,
      endsAt: null,
      businessBuyersOnly: false,
      countryCodes: null,
      preorderOnly: false,
    },
    {
      minQuantity: 500,
      maxQuantity: null,
      priceMinor: '920',
      isActive: true,
      startsAt: null,
      endsAt: null,
      businessBuyersOnly: false,
      countryCodes: null,
      preorderOnly: false,
    },
    {
      minQuantity: 1000,
      maxQuantity: null,
      priceMinor: '880',
      isActive: true,
      startsAt: null,
      endsAt: null,
      businessBuyersOnly: true,
      countryCodes: null,
      preorderOnly: false,
    },
    {
      minQuantity: 10000,
      maxQuantity: null,
      priceMinor: '800',
      isActive: true,
      startsAt: null,
      endsAt: null,
      businessBuyersOnly: false,
      countryCodes: null,
      preorderOnly: true,
    },
  ],
};

async function basketFor(profileId: string, quantity: number) {
  const cart = await import('../../src/modules/cart/cart.service.js');
  await cart.clearCart(profileId);
  await cart.addItem(profileId, { productId, quantity, sellerOfferId: offerId });
  const resolved = await cart.resolveCart(profileId);
  const line = resolved.lines[0];
  if (line === undefined) throw new Error('no line');
  return line;
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/http/app.js');
  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));
  const { resolveSellerMembership } = await import('../../src/modules/seller/account.service.js');
  app = await buildApp();
  await app.ready();
  await cleanUp();

  if ((await prisma.inventoryLocation.findFirst({ select: { id: true } })) === null) {
    await prisma.inventoryLocation.create({
      data: { id: newId(), code: 'QTT-MAIN', name: 'Main', isDefault: true, isActive: true },
    });
  }

  buyerProfileId = await person(BUYER, 'Acme Hospitals Pvt Ltd');
  consumerProfileId = await person(GUEST_LIKE, null);
  const sellerPerson = await person(STAFF[0] ?? '', 'Seller staff');
  const rivalPerson = await person(STAFF[1] ?? '', 'Rival staff');

  const makeSeller = async (slug: string, owner: string) => {
    const id = newId();
    await prisma.sellerAccount.create({
      data: {
        id,
        legalName: `${slug} Ltd`,
        displayName: slug,
        displayNameNormalized: slug,
        slug: `${PREFIX}${slug}`,
        kind: 'WHOLESALER',
        registrationCountry: 'IN',
        status: 'APPROVED',
      },
    });
    await prisma.sellerMember.create({
      data: { id: newId(), sellerAccountId: id, customerProfileId: owner, role: 'OWNER' },
    });
    return id;
  };
  const sellerAccountId = await makeSeller('tube', sellerPerson);
  await makeSeller('rival', rivalPerson);
  seller = await resolveSellerMembership(sellerPerson);
  rival = await resolveSellerMembership(rivalPerson);

  const taxClass =
    (await prisma.taxClass.findFirst({ select: { id: true } })) ??
    (await prisma.taxClass.create({
      data: { id: newId(), code: 'QTT0', name: 'Zero', ratePercent: '0.000000', isActive: true },
      select: { id: true },
    }));
  const category = await prisma.category.create({
    data: { id: newId(), name: 'Tiers', slug: `${PREFIX}category`, isActive: true },
  });
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Silicone tubing',
      slug: `${PREFIX}tubing`,
      sku: 'QTT-TUBE',
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
  productId = product.id;

  offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId,
      productId,
      variantKey: '',
      sellerSku: 'QTT-TUBE-1',
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: 1000n,
      currency: 'INR',
      minimumOrderQuantity: 1,
      orderIncrement: 1,
      availableQuantity: 20_000,
    },
  });
  const { syncMarketplacePrice } =
    await import('../../src/modules/catalog/marketplace-price.service.js');
  await syncMarketplacePrice(prisma, productId);

  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId: buyerProfileId,
      kind: 'BOTH',
      contactName: 'Dock',
      contactPhone: '+91 90000 00001',
      line1: '1 Dock Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      postalCode: '400001',
      country: 'IN',
      isDefaultBilling: true,
      isDefaultShipping: true,
    },
  });
  addressId = address.id;
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('the seller saves bands', () => {
  it('refuses a ladder whose price goes up, and one that is not a discount, naming each band', async () => {
    const { saveQuantityTiers } = await import('../../src/modules/seller/quantity-tier.service.js');
    const bad = {
      tiers: [
        { ...BANDS.tiers[0], priceMinor: '900' },
        { ...BANDS.tiers[1], priceMinor: '950' },
        { ...BANDS.tiers[0], minQuantity: 5000, priceMinor: '1000' },
      ],
    } as typeof BANDS;
    await expect(saveQuantityTiers(seller, offerId, bad)).rejects.toMatchObject({
      code: 'QUANTITY_TIERS_INVALID',
      details: expect.arrayContaining([
        expect.objectContaining({ field: 'tiers.1', code: 'PRICE_NOT_DECREASING' }),
        expect.objectContaining({ field: 'tiers.2', code: 'NOT_A_DISCOUNT' }),
      ]) as unknown,
    });
  });

  it('is refused for another seller’s listing', async () => {
    const { saveQuantityTiers, readQuantityTiers } =
      await import('../../src/modules/seller/quantity-tier.service.js');
    await expect(saveQuantityTiers(rival, offerId, BANDS)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(readQuantityTiers(rival, offerId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('saves a valid ladder as one set, and audits it', async () => {
    const { saveQuantityTiers } = await import('../../src/modules/seller/quantity-tier.service.js');
    const saved = await saveQuantityTiers(seller, offerId, BANDS);
    expect(saved.tiers.map((tier) => tier.minQuantity)).toEqual([100, 500, 1000, 10000]);
    expect(saved.tiers[1]?.savingBasisPoints).toBe(800);
    expect(
      await prisma.sellerAuditLog.count({
        where: { action: 'listing.quantity_tiers_saved', resourceId: offerId },
      }),
    ).toBe(1);
  });
});

describe('the basket charges the band', () => {
  it('prices below the first band at list, and at the band once reached', async () => {
    expect((await basketFor(buyerProfileId, 99)).unitPrice.minor).toBe('1000');
    const at480 = await basketFor(buyerProfileId, 480);
    expect(at480.unitPrice.minor).toBe('950');
    expect(at480.lineSubtotal.minor).toBe('456000');
    expect(at480.quantityTier).toMatchObject({ minQuantity: 100, savingBasisPoints: 500 });
    expect(at480.nextQuantityTier).toMatchObject({ minQuantity: 500, addQuantity: 20 });
  });

  it('gives the business-only band only to a business account', async () => {
    expect((await basketFor(buyerProfileId, 1200)).unitPrice.minor).toBe('880');
    expect((await basketFor(consumerProfileId, 1200)).unitPrice.minor).toBe('920');
  });

  it('never applies a preorder-only band in the basket', async () => {
    expect((await basketFor(buyerProfileId, 12_000)).unitPrice.minor).toBe('880');
  });

  it('freezes the band onto the order line the checkout writes', async () => {
    await basketFor(buyerProfileId, 600);
    const { submitCheckout } = await import('../../src/modules/orders/order.service.js');
    const placed = await submitCheckout({
      customerProfileId: buyerProfileId,
      shippingAddressId: addressId,
      paymentMode: 'ONLINE',
      actor: { type: 'CUSTOMER', userId: null, email: BUYER },
    });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: placed.orderId } });
    expect(item.unitPriceMinor).toBe(920n);
    expect(item.lineSubtotalMinor).toBe(552_000n);
    expect(item.quantityTierJson).toMatchObject({
      minQuantity: 500,
      listUnitPriceMinor: '1000',
      unitPriceMinor: '920',
    });

    // A band changed afterwards does not rewrite what the order says.
    await prisma.sellerPriceTier.updateMany({
      where: { offerId, minQuantity: 500 },
      data: { priceMinor: 900n },
    });
    const again = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(again.unitPriceMinor).toBe(920n);
    await prisma.sellerPriceTier.updateMany({
      where: { offerId, minQuantity: 500 },
      data: { priceMinor: 920n },
    });
  });
});

describe('the popover quotes what the basket charges', () => {
  it('quotes the same price per piece, the next band and the stock, for a guest', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/bulk-pricing?productId=${productId}&quantity=480`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const body = response.json<{
      current: { unitPrice: { minor: string } };
      next: { addQuantity: number; unitPrice: { minor: string } } | null;
      ladder: { minQuantity: number }[];
      preorderBands: { minQuantity: number }[];
      units: { unit: string; perPiece: { minor: string } }[];
      exceedsStock: boolean;
    }>();
    expect(body.current.unitPrice.minor).toBe('950');
    expect(body.next).toMatchObject({ addQuantity: 20, unitPrice: { minor: '920' } });
    // A guest is not a business account: that band is not offered to them.
    expect(body.ladder.map((band) => band.minQuantity)).toEqual([100, 500]);
    expect(body.preorderBands.map((band) => band.minQuantity)).toEqual([10000]);
    expect(body.units[0]).toMatchObject({ unit: 'PIECE', perPiece: { minor: '950' } });
    expect(body.exceedsStock).toBe(false);
  });

  it('lists every offer the buyer can reach as cards, priced like the basket', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/bulk-pricing?productId=${productId}&quantity=480`,
    });
    const body = response.json<{
      listUnitPrice: { minor: string };
      offers: {
        minQuantity: number;
        unitPrice: { minor: string };
        savingPerPiece: { minor: string };
        lineTotal: { minor: string };
        totalSaving: { minor: string };
        isCurrent: boolean;
        isNext: boolean;
        isBestValue: boolean;
        withinStock: boolean;
      }[];
      preorderOffers: { minQuantity: number }[];
    }>();
    const list = BigInt(body.listUnitPrice.minor);

    // The same bands as the ladder: nothing added, nothing kept back.
    expect(body.offers.map((offer) => offer.minQuantity)).toEqual([100, 500]);
    for (const offer of body.offers) {
      const unit = BigInt(offer.unitPrice.minor);
      const pieces = BigInt(offer.minQuantity);
      expect(BigInt(offer.savingPerPiece.minor)).toBe(list - unit);
      expect(BigInt(offer.lineTotal.minor)).toBe(unit * pieces);
      expect(BigInt(offer.totalSaving.minor)).toBe((list - unit) * pieces);
    }
    expect(body.offers.map((offer) => [offer.isCurrent, offer.isNext])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(body.offers.find((offer) => offer.minQuantity === 500)?.isBestValue).toBe(true);
    expect(body.offers.every((offer) => offer.withinStock)).toBe(true);
    expect(body.preorderOffers.map((offer) => offer.minQuantity)).toEqual([10000]);
  });

  it('says so when the quantity is more than the seller holds', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/bulk-pricing?productId=${productId}&quantity=25000`,
    });
    expect(response.json<{ exceedsStock: boolean; stockBaseUnits: number }>()).toMatchObject({
      exceedsStock: true,
      stockBaseUnits: 20000,
    });
  });

  it('rejects a nonsense quantity', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/bulk-pricing?productId=${productId}&quantity=0`,
    });
    expect(response.statusCode).toBe(400);
  });
});
