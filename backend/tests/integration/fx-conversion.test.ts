/**
 * Read-time currency conversion, end to end against a real MariaDB.
 *
 * The claims under test, in the order they matter:
 *
 *   - **A manual price always wins.** A currency somebody typed a figure for
 *     is quoted verbatim, even when a rate exists that would produce a
 *     different number. This is the property the whole feature was built
 *     around not breaking.
 *   - **Derivation is off until it is turned on.** A deployment that upgrades
 *     into this feature keeps the behaviour it had: a SKU with no row in a
 *     currency is not sellable in it.
 *   - **A derived figure says it is derived,** and carries the rate, the
 *     provider and the date that produced it.
 *   - **A stale rate stops a sale rather than guessing.** And it says so with
 *     its own error code, because "we cannot price in zloty this minute" and
 *     "this is not sold in zloty" need opposite advice.
 *   - **An order freezes its rate and never moves again.** The one that
 *     matters most: rates move daily, and a total nobody can reconstruct is a
 *     dispute nobody can settle.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { addItem, resolveCart, toCartView } from '../../src/modules/cart/cart.service.js';
import { receiveStock } from '../../src/modules/inventory/inventory.service.js';
import { submitCheckout } from '../../src/modules/orders/order.service.js';
import { setCustomerLocale } from '../../src/modules/settings/currency.service.js';
import { FX_SETTINGS_ID, activeRateSet } from '../../src/modules/settings/fx-snapshot.service.js';
import { ErrorCode } from '../../src/domain/errors.js';

let adminActor: { userId: string; email: string };
let customerUserId: string;
let customerProfileId: string;
let addressId: string;
let boltProductId: string;
let glueProductId: string;

const CUSTOMER_ACTOR = () => ({
  userId: customerUserId,
  email: 'buyer@fxtest.local',
  type: 'CUSTOMER' as const,
});

/** How old the rate set is. Every test that cares sets this explicitly. */
function asOfHoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

/**
 * Put a validated, active rate set in the database.
 *
 * Writes the rows the refresh job would have written, rather than reaching for
 * the network. The fetching and validating of a set has its own unit tests
 * against real documents; what this file is about is what the rest of the
 * system does with one once it is there.
 */
async function activateRateSet(options: {
  asOf: Date;
  rates: Record<string, string>;
  pivot?: string;
  provider?: string;
}): Promise<string> {
  const snapshotId = newId();
  const pivot = options.pivot ?? 'EUR';
  const provider = options.provider ?? 'ecb';

  await prisma.exchangeRateSnapshot.updateMany({
    where: { activeProvider: { not: null } },
    data: { isActive: false, activeProvider: null, retiredAt: new Date() },
  });

  await prisma.exchangeRateSnapshot.create({
    data: {
      id: snapshotId,
      provider,
      pivotCurrency: pivot,
      asOf: options.asOf,
      sourceReference: 'test://fixture',
      retrievalStatus: 'FETCHED',
      validationStatus: 'VALID',
      isActive: true,
      activeProvider: provider,
      activatedAt: new Date(),
      rateCount: Object.keys(options.rates).length,
    },
  });

  await prisma.exchangeRate.createMany({
    data: Object.entries(options.rates).map(([quoteCurrency, rate]) => ({
      id: newId(),
      snapshotId,
      baseCurrency: pivot,
      quoteCurrency,
      rate,
    })),
  });

  return snapshotId;
}

async function setFx(settings: Record<string, unknown>): Promise<void> {
  await prisma.currencyRateSync.upsert({
    where: { id: FX_SETTINGS_ID },
    create: { id: FX_SETTINGS_ID, ...settings },
    update: settings,
  });
}

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.idempotencyRecord.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.exchangeRate.deleteMany({});
  await prisma.exchangeRateSnapshot.deleteMany({});
  await prisma.currencyRateSync.deleteMany({});
  await prisma.productPrice.deleteMany({});
  await prisma.productVariant.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.shippingMethod.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { contains: '@fxtest.local' } } });
  await prisma.businessProfile.deleteMany({});
  // Currencies and countries are reference data shared with every other file
  // in this suite and are upserted below rather than wiped. See the same note
  // in coupons-currency.test.ts - a global delete here pulls rows out from
  // under whichever file happens to be mid-request.
}

beforeEach(async () => {
  await resetAll();

  await prisma.businessProfile.create({
    data: {
      id: newId(),
      legalName: 'UBOSS FX Test',
      displayName: 'UBOSS',
      supportEmail: 'support@fxtest.local',
      currency: 'EUR',
      timezone: 'Europe/Warsaw',
    },
  });

  // EUR is the base here, which makes the euro-pivoted feed the simple case
  // and PLN the derived one. INR is present and deliberately NOT given a
  // price row, so "manual wins" and "derived fills the gap" are both testable
  // against the same product.
  for (const currency of [
    { code: 'EUR', name: 'Euro', symbol: '€', exponent: 2, isBase: true, sortOrder: 1 },
    { code: 'PLN', name: 'Polish Zloty', symbol: 'zl', exponent: 2, sortOrder: 2 },
    { code: 'INR', name: 'Indian Rupee', symbol: '₹', exponent: 2, sortOrder: 3 },
  ]) {
    await prisma.currency.upsert({
      where: { code: currency.code },
      update: { ...currency, isActive: true },
      create: { ...currency, isActive: true },
    });
  }

  for (const country of [
    { code: 'PL', name: 'Poland', currencyCode: 'PLN', sortOrder: 1 },
    { code: 'IN', name: 'India', currencyCode: 'INR', sortOrder: 2 },
  ]) {
    await prisma.country.upsert({
      where: { code: country.code },
      update: { ...country, isActive: true },
      create: { ...country, isActive: true },
    });
  }

  await prisma.inventoryLocation.create({
    data: { id: newId(), code: 'MAIN', name: 'Main', isDefault: true, isActive: true },
  });

  await prisma.shippingMethod.create({
    data: {
      id: newId(),
      code: 'STANDARD',
      name: 'Standard',
      priceMinor: 0n,
      isActive: true,
      sortOrder: 1,
    },
  });

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'ZERO',
      name: 'Zero rated',
      ratePercent: '0.000000',
      isInclusive: false,
      isDefault: true,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Tools', slug: 'tools-fx', isActive: true },
  });
  await prisma.category.update({
    where: { id: category.id },
    data: { path: `/${category.id}/` },
  });

  const makeProduct = async (
    name: string,
    slug: string,
    sku: string,
    eurMinor: bigint,
    plnMinor: bigint | null,
  ): Promise<string> => {
    const product = await prisma.product.create({
      data: {
        id: newId(),
        categoryId: category.id,
        taxClassId: taxClass.id,
        name,
        slug,
        sku,
        basePriceMinor: eurMinor,
        currency: 'EUR',
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
        currencyCode: 'EUR',
        basePriceMinor: eurMinor,
      },
    });

    if (plnMinor !== null) {
      await prisma.productPrice.create({
        data: {
          id: newId(),
          productId: product.id,
          variantKey: '',
          currencyCode: 'PLN',
          basePriceMinor: plnMinor,
        },
      });
    }

    return product.id;
  };

  // The bolt has a deliberate Polish price: 40.00 zloty, which is well below
  // what 10.00 euro would convert to at 4.4. That gap is the whole point - it
  // is how "a manual price wins over a conversion" becomes visible rather than
  // merely asserted.
  boltProductId = await makeProduct('Hex Bolt', 'hex-bolt-fx', 'FX-HEX-1', 1_000n, 4_000n);
  glueProductId = await makeProduct('Epoxy Glue', 'epoxy-fx', 'FX-GLU-1', 5_000n, null);

  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: 'buyer@fxtest.local',
      emailNormalized: 'buyer@fxtest.local',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  customerUserId = user.id;

  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'FX Buyer' },
  });
  customerProfileId = profile.id;

  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId,
      contactName: 'FX Buyer',
      contactPhone: '+48 500 000 000',
      line1: 'ul. Test 1',
      city: 'Warsaw',
      state: 'Mazowieckie',
      postalCode: '00-001',
      country: 'PL',
      isDefaultBilling: true,
      isDefaultShipping: true,
    },
  });
  addressId = address.id;

  const staff = await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: 'staff@fxtest.local',
      emailNormalized: 'staff@fxtest.local',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  adminActor = { userId: staff.id, email: staff.email };

  await receiveStock({ productId: boltProductId, quantity: 500 }, adminActor);
  await receiveStock({ productId: glueProductId, quantity: 500 }, adminActor);
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// The default: nothing changes until somebody turns it on
// ---------------------------------------------------------------------------

describe('with derivation switched off', () => {
  beforeEach(async () => {
    await setFx({ deriveMissingPrices: false, marginPercent: '0.00', rounding: 'exact' });
    await activateRateSet({ asOf: asOfHoursAgo(2), rates: { PLN: '4.400000000000' } });
  });

  it('still refuses a currency with no price row, exactly as before', async () => {
    // The glue has no Polish price. A rate set exists and would happily
    // convert one, and it must not: an upgrade is not a pricing decision.
    await setCustomerLocale(customerProfileId, { country: 'PL', currency: 'PLN' });
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });

    const view = toCartView(await resolveCart(customerProfileId));
    const issues = view.lines.flatMap((line) => line.issues.map((issue) => issue.code));

    expect(issues).toContain(ErrorCode.PRICE_UNAVAILABLE_IN_CURRENCY);
    expect(view.checkoutReady).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Manual beats converted
// ---------------------------------------------------------------------------

describe('with derivation switched on', () => {
  beforeEach(async () => {
    await setFx({ deriveMissingPrices: true, marginPercent: '0.00', rounding: 'exact' });
    await activateRateSet({ asOf: asOfHoursAgo(2), rates: { PLN: '4.400000000000' } });
    await setCustomerLocale(customerProfileId, { country: 'PL', currency: 'PLN' });
  });

  it('quotes the manual price, not the conversion', async () => {
    // 10.00 EUR at 4.4 would be 44.00 zloty. The typed price is 40.00, and
    // that is what the shopper pays - a deliberate local price must survive a
    // rate existing.
    await addItem(customerProfileId, { productId: boltProductId, quantity: 1 });

    const view = toCartView(await resolveCart(customerProfileId));

    expect(view.currency).toBe('PLN');
    expect(view.totals.subtotal.minor).toBe('4000');
  });

  it('fills a gap by converting the base price', async () => {
    // The glue has no Polish row: 50.00 EUR at 4.4 is 220.00 zloty.
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });

    const view = toCartView(await resolveCart(customerProfileId));

    expect(view.totals.subtotal.minor).toBe('22000');
    expect(view.checkoutReady).toBe(true);
  });

  it('applies the configured adjustment to a derived price only', async () => {
    await setFx({ deriveMissingPrices: true, marginPercent: '2.00', rounding: 'exact' });

    // Glue: 50.00 EUR at 4.4 + 2% = 4.488 -> 224.40 zloty.
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });
    expect(toCartView(await resolveCart(customerProfileId)).totals.subtotal.minor).toBe('22440');

    // The bolt's manual 40.00 is untouched by the margin. A spread belongs to
    // a conversion; there is no conversion here to charge it on.
    await prisma.cartItem.deleteMany({});
    await addItem(customerProfileId, { productId: boltProductId, quantity: 1 });
    expect(toCartView(await resolveCart(customerProfileId)).totals.subtotal.minor).toBe('4000');
  });

  it('crosses through the pivot for a currency that is not the base', async () => {
    // INR is neither the base (EUR) nor manually priced. 50.00 EUR at 92.4
    // is 4,620.00 rupees, and the rate reaches it via the euro pivot.
    await activateRateSet({
      asOf: asOfHoursAgo(2),
      rates: { PLN: '4.400000000000', INR: '92.400000000000' },
    });
    await setCustomerLocale(customerProfileId, { country: 'IN', currency: 'INR' });
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });

    expect(toCartView(await resolveCart(customerProfileId)).totals.subtotal.minor).toBe('462000');
  });

  it('refuses a currency the feed does not quote', async () => {
    // The set carries no rupee rate, so there is nothing to convert with.
    await setCustomerLocale(customerProfileId, { country: 'IN', currency: 'INR' });
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });

    const view = toCartView(await resolveCart(customerProfileId));
    const issues = view.lines.flatMap((line) => line.issues.map((issue) => issue.code));

    expect(issues).toContain(ErrorCode.PRICE_UNAVAILABLE_IN_CURRENCY);
    expect(view.checkoutReady).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

describe('a rate set that has gone stale', () => {
  beforeEach(async () => {
    await setFx({
      deriveMissingPrices: true,
      marginPercent: '0.00',
      rounding: 'exact',
      displayMaxAgeHours: 168,
      checkoutMaxAgeHours: 96,
      alertMaxAgeHours: 72,
    });
    await setCustomerLocale(customerProfileId, { country: 'PL', currency: 'PLN' });
  });

  it('still prices a page but refuses a sale, in the window between the two', async () => {
    // 120 hours: past the 96 hour checkout limit, inside the 168 hour display
    // one. The shopper can still browse; they cannot still be charged.
    await activateRateSet({ asOf: asOfHoursAgo(120), rates: { PLN: '4.400000000000' } });
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });

    const browsing = toCartView(await resolveCart(customerProfileId));
    expect(browsing.totals.subtotal.minor).toBe('22000');

    // Repriced for checkout, the line loses its price entirely. It stays in
    // the basket at zero with a blocking issue on it rather than vanishing -
    // the existing behaviour for anything unpriceable, and the right one: a
    // line that disappeared would let the order through for everything else
    // without saying what had been dropped.
    const paying = toCartView(await resolveCart(customerProfileId, { fxPurpose: 'checkout' }));

    expect(paying.totals.subtotal.minor).toBe('0');
    expect(paying.checkoutReady).toBe(false);

    // And the refusal is enforced where it counts, not merely reported.
    await expect(
      submitCheckout({
        customerProfileId,
        shippingAddressId: addressId,
        shippingMethodCode: 'STANDARD',
        paymentMode: 'ONLINE',
        actor: CUSTOMER_ACTOR(),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CART_ITEM_UNAVAILABLE });
  });

  it('says WHY it cannot price, rather than claiming the product is not sold', async () => {
    // The distinction this error code exists for. "Not sold in zloty" would
    // send whoever investigates into the catalogue after a price row that was
    // never missing; the real cause is a feed that has stopped publishing.
    await activateRateSet({ asOf: asOfHoursAgo(400), rates: { PLN: '4.400000000000' } });
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });

    const view = toCartView(await resolveCart(customerProfileId));
    const issues = view.lines.flatMap((line) => line.issues.map((issue) => issue.code));

    expect(issues).toContain(ErrorCode.PRICE_RATE_UNAVAILABLE);
    expect(issues).not.toContain(ErrorCode.PRICE_UNAVAILABLE_IN_CURRENCY);
    expect(view.checkoutReady).toBe(false);
  });

  it('leaves a manually priced product completely unaffected', async () => {
    // No rate is involved in a typed price, so no rate can make it stale.
    await activateRateSet({ asOf: asOfHoursAgo(4000), rates: { PLN: '4.400000000000' } });
    await addItem(customerProfileId, { productId: boltProductId, quantity: 1 });

    const view = toCartView(await resolveCart(customerProfileId, { fxPurpose: 'checkout' }));

    expect(view.totals.subtotal.minor).toBe('4000');
    expect(view.checkoutReady).toBe(true);
  });

  it('refuses everything derived when no rate set exists at all', async () => {
    await prisma.exchangeRate.deleteMany({});
    await prisma.exchangeRateSnapshot.deleteMany({});

    expect(await activeRateSet()).toBeNull();

    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });
    const view = toCartView(await resolveCart(customerProfileId));

    expect(view.checkoutReady).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The order snapshot
// ---------------------------------------------------------------------------

describe('what an order records about its currency', () => {
  beforeEach(async () => {
    await setFx({ deriveMissingPrices: true, marginPercent: '2.00', rounding: 'exact' });
    await activateRateSet({ asOf: asOfHoursAgo(2), rates: { PLN: '4.400000000000' } });
    await setCustomerLocale(customerProfileId, { country: 'PL', currency: 'PLN' });
  });

  async function checkout() {
    return submitCheckout({
      customerProfileId,
      shippingAddressId: addressId,
      shippingMethodCode: 'STANDARD',
      paymentMode: 'ONLINE',
      actor: CUSTOMER_ACTOR(),
    });
  }

  it('records the rate, the provider and the date on a converted order', async () => {
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });
    const placed = await checkout();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });

    expect(order.currency).toBe('PLN');
    expect(order.fxPriceSource).toBe('CONVERTED');
    expect(order.fxProvider).toBe('ecb');
    expect(order.fxBaseCurrency).toBe('EUR');
    expect(order.fxMidRate?.toFixed(8)).toBe('4.40000000');
    expect(order.fxRateUsed?.toFixed(8)).toBe('4.48800000');
    expect(order.fxAdjustmentPercent?.toFixed(2)).toBe('2.00');
    expect(order.fxSnapshotId).not.toBeNull();
    expect(order.fxPolicyVersion).not.toBeNull();

    // 50.00 EUR at 4.488 is 224.40 zloty, and back again is 50.00 EUR.
    expect(order.grandTotalMinor).toBe(22_440n);
    expect(order.fxBaseGrandTotalMinor).toBe(5_000n);
  });

  it('records MANUAL and no rate at all on an order that involved no conversion', async () => {
    // The bolt has a typed Polish price. Writing a rate of 1.0 here would make
    // "was this converted?" unanswerable, which is the one question these
    // columns exist to answer.
    await addItem(customerProfileId, { productId: boltProductId, quantity: 1 });
    const placed = await checkout();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });

    expect(order.fxPriceSource).toBe('MANUAL');
    expect(order.fxRateUsed).toBeNull();
    expect(order.fxSnapshotId).toBeNull();
    expect(order.fxProvider).toBeNull();
  });

  it('does not move when the rate moves afterwards', async () => {
    // THE CLAIM THIS WHOLE FEATURE RESTS ON.
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });
    const placed = await checkout();

    const before = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });

    // The zloty moves 10% overnight and a new set goes live.
    await activateRateSet({ asOf: asOfHoursAgo(1), rates: { PLN: '4.840000000000' } });

    const after = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });

    expect(after.grandTotalMinor).toBe(before.grandTotalMinor);
    expect(after.fxRateUsed?.toFixed(8)).toBe('4.48800000');
    expect(after.fxRateAsOf?.getTime()).toBe(before.fxRateAsOf?.getTime());
    expect(after.fxBaseGrandTotalMinor).toBe(before.fxBaseGrandTotalMinor);

    // And the line snapshots are untouched too - the order's own record of
    // what each thing cost does not follow the catalogue either.
    const items = await prisma.orderItem.findMany({ where: { orderId: placed.orderId } });
    expect(items[0]?.unitPriceMinor).toBe(22_440n);
  });

  it('keeps pointing at a retired snapshot, so the audit trail survives', async () => {
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });
    const placed = await checkout();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    const snapshotId = order.fxSnapshotId;
    expect(snapshotId).not.toBeNull();

    // Tomorrow's set retires it, but it is still there and still joinable.
    await activateRateSet({ asOf: asOfHoursAgo(1), rates: { PLN: '4.840000000000' } });

    const snapshot = await prisma.exchangeRateSnapshot.findUniqueOrThrow({
      where: { id: snapshotId ?? '' },
      include: { rates: true },
    });

    expect(snapshot.isActive).toBe(false);
    expect(snapshot.activeProvider).toBeNull();
    expect(snapshot.rates.find((rate) => rate.quoteCurrency === 'PLN')?.rate.toFixed(6)).toBe(
      '4.400000',
    );
  });

  it('survives its snapshot being pruned, because it kept its own copy', async () => {
    await addItem(customerProfileId, { productId: glueProductId, quantity: 1 });
    const placed = await checkout();

    const before = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });

    await activateRateSet({ asOf: asOfHoursAgo(1), rates: { PLN: '4.840000000000' } });
    await prisma.exchangeRateSnapshot.delete({ where: { id: before.fxSnapshotId ?? '' } });

    const after = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });

    // The join is gone; every fact is still there. That is what makes pruning
    // safe at all.
    expect(after.fxSnapshotId).toBeNull();
    expect(after.fxRateUsed?.toFixed(8)).toBe('4.48800000');
    expect(after.fxProvider).toBe('ecb');
    expect(after.grandTotalMinor).toBe(before.grandTotalMinor);
  });
});

// ---------------------------------------------------------------------------
// One active set, enforced by the database
// ---------------------------------------------------------------------------

describe('activation', () => {
  it('permits exactly one active snapshot per provider', async () => {
    await activateRateSet({ asOf: asOfHoursAgo(2), rates: { PLN: '4.400000000000' } });

    // A second activation without retiring the first is what a lost race looks
    // like, and the unique index is what stops it becoming two live rate sets.
    await expect(
      prisma.exchangeRateSnapshot.create({
        data: {
          id: newId(),
          provider: 'ecb',
          pivotCurrency: 'EUR',
          asOf: new Date(),
          sourceReference: 'test://race',
          isActive: true,
          activeProvider: 'ecb',
          validationStatus: 'VALID',
        },
      }),
    ).rejects.toThrow();
  });

  it('permits any number of retired snapshots', async () => {
    for (let index = 0; index < 3; index += 1) {
      await activateRateSet({
        asOf: asOfHoursAgo(24 * (index + 1)),
        rates: { PLN: '4.400000000000' },
      });
    }

    const retired = await prisma.exchangeRateSnapshot.count({ where: { activeProvider: null } });
    const active = await prisma.exchangeRateSnapshot.count({ where: { isActive: true } });

    expect(retired).toBe(2);
    expect(active).toBe(1);
  });
});
