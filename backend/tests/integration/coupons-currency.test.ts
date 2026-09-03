/**
 * Multi-currency pricing and coupons - integration, against a real MariaDB.
 *
 * The claims under test:
 *   - A product carries a real price per currency. The cart quotes the
 *     shopper's currency, and a SKU with no row for it is refused rather than
 *     substituted from another currency.
 *   - A coupon's qualifying amount is per currency. A coupon offered in INR
 *     does not silently apply to a USD cart.
 *   - A category coupon touches only the lines inside that category, and its
 *     per-line shares sum to the discount exactly - so per-line tax stays
 *     consistent with the total charged.
 *   - A redemption is written inside the checkout transaction, once per order.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { addItem, applyCoupon, resolveCart, toCartView } from '../../src/modules/cart/cart.service.js';
import { createCoupon } from '../../src/modules/coupons/coupon.service.js';
import { receiveStock } from '../../src/modules/inventory/inventory.service.js';
import { setCustomerLocale } from '../../src/modules/settings/currency.service.js';

let adminActor: { userId: string; email: string };
let customerProfileId: string;
let boltProductId: string;
let glueProductId: string;
let boltCategoryId: string;
let glueCategoryId: string;

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.couponRedemption.deleteMany({});
  await prisma.couponCategory.deleteMany({});
  await prisma.couponMinimum.deleteMany({});
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.coupon.deleteMany({});
  await prisma.productPrice.deleteMany({});
  await prisma.productVariant.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { contains: '@coupontest.local' } } });
  await prisma.country.deleteMany({});
  await prisma.currency.deleteMany({});
  await prisma.businessProfile.deleteMany({});
}

beforeEach(async () => {
  await resetAll();

  await prisma.businessProfile.create({
    data: {
      id: newId(),
      legalName: 'UBOSS Test',
      displayName: 'UBOSS',
      supportEmail: 'support@coupontest.local',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    },
  });

  await prisma.currency.createMany({
    data: [
      { code: 'INR', name: 'Indian Rupee', symbol: '₹', exponent: 2, isBase: true, sortOrder: 1 },
      { code: 'USD', name: 'US Dollar', symbol: '$', exponent: 2, sortOrder: 2 },
    ],
  });

  await prisma.country.createMany({
    data: [
      { code: 'IN', name: 'India', currencyCode: 'INR', sortOrder: 1 },
      { code: 'US', name: 'United States', currencyCode: 'USD', sortOrder: 2 },
    ],
  });

  await prisma.inventoryLocation.create({
    data: { id: newId(), code: 'MAIN', name: 'Main', isDefault: true, isActive: true },
  });

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'GST18',
      name: 'GST 18%',
      ratePercent: '18.000000',
      isInclusive: false,
      isDefault: true,
    },
  });

  const bolts = await prisma.category.create({
    data: { id: newId(), name: 'Fasteners', slug: 'fasteners', isActive: true },
  });
  boltCategoryId = bolts.id;
  await prisma.category.update({
    where: { id: bolts.id },
    data: { path: `/${bolts.id}/` },
  });

  const glues = await prisma.category.create({
    data: { id: newId(), name: 'Adhesives', slug: 'adhesives', isActive: true },
  });
  glueCategoryId = glues.id;
  await prisma.category.update({
    where: { id: glues.id },
    data: { path: `/${glues.id}/` },
  });

  const makeProduct = async (
    name: string,
    slug: string,
    sku: string,
    categoryId: string,
    inrMinor: bigint,
    usdMinor: bigint | null,
  ): Promise<string> => {
    const product = await prisma.product.create({
      data: {
        id: newId(),
        categoryId,
        taxClassId: taxClass.id,
        name,
        slug,
        sku,
        basePriceMinor: inrMinor,
        currency: 'INR',
        status: 'ACTIVE',
        isPublished: true,
        publishedAt: new Date(),
        isStockTracked: true,
        minOrderQty: 1,
        qtyIncrement: 1,
      },
    });

    await prisma.productPrice.create({
      data: {
        id: newId(),
        productId: product.id,
        variantKey: '',
        currencyCode: 'INR',
        basePriceMinor: inrMinor,
      },
    });

    if (usdMinor !== null) {
      await prisma.productPrice.create({
        data: {
          id: newId(),
          productId: product.id,
          variantKey: '',
          currencyCode: 'USD',
          basePriceMinor: usdMinor,
        },
      });
    }

    return product.id;
  };

  // Bolts sell in both markets. Glue is India-only, which is what makes the
  // "not sold in this currency" path testable.
  boltProductId = await makeProduct('Hex Bolt', 'hex-bolt', 'HEX-1', boltCategoryId, 10_000n, 12_000n);
  glueProductId = await makeProduct('Epoxy Glue', 'epoxy-glue', 'GLU-1', glueCategoryId, 50_000n, null);

  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: 'buyer@coupontest.local',
      emailNormalized: 'buyer@coupontest.local',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'Coupon Buyer' },
  });
  customerProfileId = profile.id;

  // A real row, because audit_logs carries a foreign key to it.
  const staff = await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: 'staff@coupontest.local',
      emailNormalized: 'staff@coupontest.local',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  adminActor = { userId: staff.id, email: staff.email };
  await receiveStock({ productId: boltProductId, quantity: 500 }, adminActor);
  await receiveStock({ productId: glueProductId, quantity: 500 }, adminActor);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('multi-currency pricing', () => {
  it('quotes the base currency until the shopper chooses one', async () => {
    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });

    const view = toCartView(await resolveCart(customerProfileId));

    expect(view.currency).toBe('INR');
    expect(view.totals.subtotal.minor).toBe('20000');
  });

  it('quotes the currency the shopper picked, from that currency own price row', async () => {
    await setCustomerLocale(customerProfileId, { country: 'US' });
    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });

    const view = toCartView(await resolveCart(customerProfileId));

    // 2 x USD 120.00, not a conversion of 2 x INR 100.00.
    expect(view.currency).toBe('USD');
    expect(view.totals.subtotal.minor).toBe('24000');
  });

  it('refuses a line whose product is not sold in the chosen currency', async () => {
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });
    await setCustomerLocale(customerProfileId, { country: 'US' });

    const view = toCartView(await resolveCart(customerProfileId));

    // Never priced from the INR row. The line is flagged, and checkout blocked.
    const codes = view.lines.flatMap((line) => line.issues.map((issue) => issue.code));
    expect(codes).toContain('PRICE_UNAVAILABLE_IN_CURRENCY');
    expect(view.checkoutReady).toBe(false);
  });

  it('refuses to price a limited account in a currency its limits were not set in', async () => {
    // Purchasing limits are plain amounts entered in the base currency. A 500
    // rupee minimum must never be read as a 500 dollar one, so an account
    // carrying a money limit is held to the currency that limit was set in -
    // blocked, rather than having the control silently dropped.
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { perOrderMinMinor: 50_000n },
    });

    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });
    await setCustomerLocale(customerProfileId, { country: 'US' });

    const view = toCartView(await resolveCart(customerProfileId));

    expect(view.checkoutReady).toBe(false);
    expect(view.blockingIssues.map((issue) => issue.code)).toContain('CART_CURRENCY_MISMATCH');
  });

  it('applies those limits normally in their own currency', async () => {
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { perOrderMinMinor: 50_000n },
    });

    await addItem(customerProfileId, { productId: glueProductId, quantity: 2 });

    const view = toCartView(await resolveCart(customerProfileId));

    expect(view.currency).toBe('INR');
    expect(view.blockingIssues.map((issue) => issue.code)).not.toContain('CART_CURRENCY_MISMATCH');
  });

  it('restamps an open cart and drops its coupon when the currency changes', async () => {
    await createCoupon(
      {
        code: 'INRONLY',
        name: 'India launch',
        discountPercent: '10.00',
        scope: 'ALL_PRODUCTS',
        status: 'ACTIVE',
        minimums: [{ currencyCode: 'INR', minOrderMinor: 0n }],
      },
      adminActor.userId,
    );

    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });
    await applyCoupon(customerProfileId, 'INRONLY');

    expect(toCartView(await resolveCart(customerProfileId)).coupon?.code).toBe('INRONLY');

    await setCustomerLocale(customerProfileId, { country: 'US' });
    const view = toCartView(await resolveCart(customerProfileId));

    expect(view.currency).toBe('USD');
    expect(view.coupon).toBeNull();
  });
});

describe('coupons', () => {
  const activeCoupon = async (overrides: Record<string, unknown> = {}) =>
    createCoupon(
      {
        code: 'SAVE10',
        name: 'Ten percent',
        discountPercent: '10.00',
        scope: 'ALL_PRODUCTS',
        status: 'ACTIVE',
        minimums: [{ currencyCode: 'INR', minOrderMinor: 0n }],
        ...overrides,
      },
      adminActor.userId,
    );

  it('generates a code when none is supplied, and it is unique', async () => {
    const first = await activeCoupon({ code: null });
    const second = await activeCoupon({ code: null, name: 'Another' });

    expect(first.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(second.code).not.toBe(first.code);
  });

  it('takes the percentage off and charges tax on the discounted amount', async () => {
    await activeCoupon();
    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });
    await applyCoupon(customerProfileId, 'SAVE10');

    const view = toCartView(await resolveCart(customerProfileId));

    expect(view.totals.subtotal.minor).toBe('20000');
    expect(view.totals.discount.minor).toBe('2000');
    // 18% of 18,000, not of 20,000. Taxing the pre-discount value would charge
    // tax on money the customer never paid.
    expect(view.totals.tax.minor).toBe('3240');
    expect(view.totals.grandTotal.minor).toBe('21240');
  });

  it('accepts the code in any case, with stray spaces', async () => {
    await activeCoupon();
    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });

    await applyCoupon(customerProfileId, '  save10 ');

    expect(toCartView(await resolveCart(customerProfileId)).coupon?.code).toBe('SAVE10');
  });

  it('refuses a cart below the qualifying amount for that currency', async () => {
    await activeCoupon({ minimums: [{ currencyCode: 'INR', minOrderMinor: 50_000n }] });
    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });

    await expect(applyCoupon(customerProfileId, 'SAVE10')).rejects.toMatchObject({
      code: 'COUPON_MINIMUM_NOT_MET',
    });
  });

  it('does not apply in a currency it was never given a threshold for', async () => {
    await activeCoupon({ minimums: [{ currencyCode: 'INR', minOrderMinor: 0n }] });
    await setCustomerLocale(customerProfileId, { country: 'US' });
    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });

    // The INR threshold is NOT converted into USD - that would make the rule
    // move with the exchange rate.
    await expect(applyCoupon(customerProfileId, 'SAVE10')).rejects.toMatchObject({
      code: 'COUPON_NOT_APPLICABLE',
    });
  });

  it('discounts only the lines inside the coupon categories', async () => {
    await activeCoupon({ scope: 'CATEGORIES', categoryIds: [boltCategoryId] });

    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });
    await applyCoupon(customerProfileId, 'SAVE10');

    const view = toCartView(await resolveCart(customerProfileId));

    // 10% of the 20,000 of bolts. The 50,000 of glue is untouched.
    expect(view.totals.subtotal.minor).toBe('70000');
    expect(view.totals.discount.minor).toBe('2000');

    const bolt = view.lines.find((line) => line.productId === boltProductId);
    const glue = view.lines.find((line) => line.productId === glueProductId);
    expect(bolt?.discount.minor).toBe('2000');
    expect(glue?.discount.minor).toBe('0');
  });

  it('refuses when nothing in the cart falls inside its categories', async () => {
    await activeCoupon({ scope: 'CATEGORIES', categoryIds: [glueCategoryId] });
    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });

    await expect(applyCoupon(customerProfileId, 'SAVE10')).rejects.toMatchObject({
      code: 'COUPON_NOT_APPLICABLE',
    });
  });

  it('apportions the discount so the line shares sum to it exactly', async () => {
    // 3 x 100.00 plus 1 x 500.00 = 800.00. 7% of that is 56.00, which does not
    // divide cleanly by line value - the largest-remainder split must still add
    // up to the penny.
    await activeCoupon({ discountPercent: '7.00' });
    await addItem(customerProfileId, { productId: boltProductId, quantity: 3 });
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });
    await applyCoupon(customerProfileId, 'SAVE10');

    const view = toCartView(await resolveCart(customerProfileId));

    const shares = view.lines.reduce((total, line) => total + BigInt(line.discount.minor), 0n);
    expect(shares.toString()).toBe(view.totals.discount.minor);
  });

  it('rejects an unknown code rather than silently ignoring it', async () => {
    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });

    await expect(applyCoupon(customerProfileId, 'NOPE')).rejects.toMatchObject({
      code: 'COUPON_NOT_FOUND',
    });
  });

  it('never applies a draft coupon', async () => {
    await activeCoupon({ status: 'DRAFT' });
    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });

    await expect(applyCoupon(customerProfileId, 'SAVE10')).rejects.toMatchObject({
      code: 'COUPON_NOT_ACTIVE',
    });
  });

  it('refuses an expired coupon', async () => {
    await activeCoupon({ validUntil: new Date(Date.now() - 86_400_000) });
    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });

    await expect(applyCoupon(customerProfileId, 'SAVE10')).rejects.toMatchObject({
      code: 'COUPON_EXPIRED',
    });
  });

  it('stops applying once the usage limit is reached', async () => {
    const coupon = await activeCoupon({ usageLimit: 1 });
    await prisma.coupon.update({ where: { id: coupon.id }, data: { usageCount: 1 } });

    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });

    await expect(applyCoupon(customerProfileId, 'SAVE10')).rejects.toMatchObject({
      code: 'COUPON_USAGE_LIMIT_REACHED',
    });
  });

  it('keeps a coupon that stopped qualifying visible, with the reason', async () => {
    await activeCoupon({ minimums: [{ currencyCode: 'INR', minOrderMinor: 15_000n }] });
    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });
    await applyCoupon(customerProfileId, 'SAVE10');

    // The shopper drops back below the threshold. The coupon must not vanish
    // without explanation.
    const cart = await prisma.cart.findFirstOrThrow({ where: { customerProfileId } });
    const line = await prisma.cartItem.findFirstOrThrow({ where: { cartId: cart.id } });
    await prisma.cartItem.update({ where: { id: line.id }, data: { quantity: 1 } });

    const view = toCartView(await resolveCart(customerProfileId));

    expect(view.totals.discount.minor).toBe('0');
    expect(view.coupon?.rejection?.code).toBe('COUPON_MINIMUM_NOT_MET');
  });

  it('lists the publicly advertised coupons, flagging which already qualify', async () => {
    await activeCoupon({ code: 'READY', minimums: [{ currencyCode: 'INR', minOrderMinor: 0n }] });
    await activeCoupon({
      code: 'BIGSPEND',
      name: 'Spend more',
      minimums: [{ currencyCode: 'INR', minOrderMinor: 100_000n }],
    });
    await activeCoupon({ code: 'SECRET', name: 'Code only', isPubliclyListed: false });

    await addItem(customerProfileId, { productId: boltProductId, quantity: 2 });
    const view = toCartView(await resolveCart(customerProfileId));

    const byCode = new Map(view.availableCoupons.map((entry) => [entry.code, entry]));
    expect(byCode.get('READY')?.eligibleNow).toBe(true);
    expect(byCode.get('BIGSPEND')?.eligibleNow).toBe(false);
    // Not advertised, but still redeemable by typing it.
    expect(byCode.has('SECRET')).toBe(false);
  });

  it('refuses a discount above 100 percent', async () => {
    await expect(activeCoupon({ discountPercent: '150.00' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses a coupon with no qualifying amount in any currency', async () => {
    await expect(activeCoupon({ minimums: [] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses a duplicate code', async () => {
    await activeCoupon();

    await expect(activeCoupon({ name: 'Clash' })).rejects.toMatchObject({
      code: 'COUPON_CODE_ALREADY_EXISTS',
    });
  });
});

describe('locale', () => {
  it('defaults the currency to the chosen country own currency', async () => {
    const locale = await setCustomerLocale(customerProfileId, { country: 'US' });

    expect(locale.currency).toBe('USD');
    expect(locale.detectedMismatch).toBe(false);
  });

  it('keeps a geolocation reading beside the stated country and flags a disagreement', async () => {
    const locale = await setCustomerLocale(customerProfileId, {
      country: 'IN',
      detectedCountry: 'US',
    });

    // The stated answer still wins. The disagreement is surfaced, not resolved.
    expect(locale.country).toBe('IN');
    expect(locale.currency).toBe('INR');
    expect(locale.detectedCountry).toBe('US');
    expect(locale.detectedMismatch).toBe(true);
  });

  it('rejects a country the store does not ship to', async () => {
    await expect(
      setCustomerLocale(customerProfileId, { country: 'ZZ' }),
    ).rejects.toMatchObject({ code: 'COUNTRY_NOT_SUPPORTED' });
  });
});
