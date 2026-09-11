/**
 * Which warehouse will send this order - integration, against a real MariaDB.
 *
 * The feature's whole value is that the answer is *true*: a buyer reads "from
 * Pune, Thursday to Monday, ₹1,240" and commits money to it. So every test
 * here is a way of being wrong that looks right on a screen.
 *
 *   - **The lanes decide, not the radius.** A warehouse with coordinates
 *     inside the destination and no delivery zone to it is not offered. That
 *     is the single most important assertion in this file, because the
 *     tempting implementation - reuse the geofence - would quote a delivery
 *     nobody has arranged.
 *   - **Reach is not enough, and neither is stock on its own.** A warehouse
 *     that can only fill three of four lines is reported under `ineligible`
 *     with the lines it is short of, never mixed in with the ones that can.
 *     There is no split-shipment flow in this product.
 *   - **Nothing is substituted, and nobody is moved.** A line that goes short
 *     between the quote and the payment refuses the checkout; it does not
 *     become a different product or a different warehouse.
 *   - **The offer is frozen and re-checked.** An expired quote, a changed
 *     basket, a warehouse that went into maintenance and a price that moved
 *     each refuse with their own code rather than being quietly repriced.
 *   - **It is additive.** A destination no warehouse has a lane to still
 *     checks out, priced by the configured shipping method, exactly as it did
 *     before any of this existed. That test is the one that says this feature
 *     cannot break an installation that has not configured it.
 *
 * Cleanup runs in `beforeEach` and `afterAll`, and it is thorough on purpose:
 * orders are ON DELETE RESTRICT from several tables, so a leftover fixture
 * breaks whichever file the suite runs next rather than this one.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { addItem, clearCart } from '../../src/modules/cart/cart.service.js';
import { receiveStock } from '../../src/modules/inventory/inventory.service.js';
import { submitCheckout } from '../../src/modules/orders/order.service.js';
import {
  assertQuoteUsable,
  currentBasketDigest,
  quoteWarehouseOptions,
  sweepExpiredFulfilmentQuotes,
  zoneCoversPostal,
  type WarehouseOption,
  type WarehouseOptionsResult,
} from '../../src/modules/fulfilment/warehouse-options.service.js';
import { addCalendarDays, todayIn } from '../../src/domain/delivery-dates.js';

let adminActor: { userId: string; email: string };
let customerUserId: string;
let customerProfileId: string;
let otherProfileId: string;
let addressId: string;
let otherAddressId: string;
let categoryId: string;
let taxClassId: string;

let puneId: string;
let mumbaiId: string;
let chennaiId: string;

let boltId: string;
let reagentId: string;
let restrictedId: string;

const CUSTOMER_ACTOR = () => ({
  userId: customerUserId,
  email: 'buyer@fulfilment.test',
  type: 'CUSTOMER' as const,
});

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.idempotencyRecord.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.adminNotificationRead.deleteMany({});
  await prisma.adminNotification.deleteMany({});
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderApproval.deleteMany({});
  await prisma.orderItem.deleteMany({});
  // Before the quotes: an order points at one with RESTRICT.
  await prisma.order.deleteMany({});
  await prisma.fulfilmentQuote.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.numberSequence.deleteMany({});
  await prisma.productCountryRestriction.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.shippingMethod.deleteMany({});
  await prisma.warehouseDeliveryZone.deleteMany({});
  await prisma.warehouseCountryExclusion.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.businessProfile.deleteMany({});
}

async function makeCustomer(email: string): Promise<{ userId: string; profileId: string }> {
  const userId = newId();
  await prisma.user.create({
    data: { id: userId, type: 'CUSTOMER', email, emailNormalized: email, status: 'ACTIVE' },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId, fullName: 'Fulfilment Buyer' },
  });
  return { userId, profileId: profile.id };
}

async function warehouse(options: {
  code: string;
  latitude: number;
  longitude: number;
  city: string;
  isDefault?: boolean;
  operationalStatus?: 'OPERATIONAL' | 'LIMITED' | 'MAINTENANCE' | 'SUSPENDED';
}): Promise<string> {
  const id = newId();

  await prisma.inventoryLocation.create({
    data: {
      id,
      code: options.code,
      name: `Warehouse ${options.code}`,
      isActive: true,
      isDefault: options.isDefault ?? false,
      countryCode: 'IN',
      // Fixed, so the transit windows below are the same every run whatever
      // day the suite happens to execute on.
      timezone: 'Asia/Kolkata',
      addressJson: { city: options.city },
      latitude: options.latitude.toFixed(6),
      longitude: options.longitude.toFixed(6),
      operationalStatus: options.operationalStatus ?? 'OPERATIONAL',
      deliveryRadiusKm: 800,
    },
  });

  return id;
}

interface LaneOptions {
  countryCode?: string;
  postalPrefixes?: string;
  carrierName?: string;
  serviceLevel?: string;
  handlingDays?: number;
  transitMinDays?: number;
  transitMaxDays?: number;
  usesBusinessDays?: boolean;
  feeMinor?: bigint;
  currency?: string;
  freeAboveMinor?: bigint | null;
  supportsColdChain?: boolean;
  maxWeightGrams?: number | null;
  isActive?: boolean;
}

async function lane(locationId: string, options: LaneOptions = {}): Promise<string> {
  const id = newId();

  await prisma.warehouseDeliveryZone.create({
    data: {
      id,
      locationId,
      countryCode: options.countryCode ?? 'IN',
      postalPrefixes: options.postalPrefixes ?? '',
      carrierName: options.carrierName ?? 'Bluedart',
      serviceLevel: options.serviceLevel ?? 'Surface',
      handlingDays: options.handlingDays ?? 1,
      transitMinDays: options.transitMinDays ?? 2,
      transitMaxDays: options.transitMaxDays ?? 4,
      // Calendar days by default in these fixtures, so the expected dates do
      // not depend on which weekday the suite runs on. The working-day
      // behaviour has its own test, with a pinned day.
      usesBusinessDays: options.usesBusinessDays ?? false,
      shippingFeeMinor: options.feeMinor ?? 9900n,
      shippingFeeCurrency: options.currency ?? 'INR',
      freeAboveMinor: options.freeAboveMinor ?? null,
      supportsColdChain: options.supportsColdChain ?? false,
      maxWeightGrams: options.maxWeightGrams ?? null,
      isActive: options.isActive ?? true,
    },
  });

  return id;
}

async function product(options: {
  sku: string;
  priceMinor: bigint;
  requiresColdChain?: boolean;
  weightGrams?: number | null;
}): Promise<string> {
  const id = newId();

  await prisma.product.create({
    data: {
      id,
      categoryId,
      taxClassId,
      name: `Product ${options.sku}`,
      slug: `fulfilment-${options.sku.toLowerCase()}`,
      sku: options.sku,
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      basePriceMinor: options.priceMinor,
      currency: 'INR',
      isStockTracked: true,
      requiresColdChain: options.requiresColdChain ?? false,
      weightGrams: options.weightGrams ?? null,
    },
  });

  return id;
}

async function stock(locationId: string, productId: string, quantity: number): Promise<void> {
  await receiveStock({ productId, quantity, locationId }, adminActor);
}

/** The options for the standard basket, to the standard address. */
async function quote(
  overrides: Record<string, unknown> = {},
): Promise<WarehouseOptionsResult> {
  return quoteWarehouseOptions({
    customerProfileId,
    deliveryAddressId: addressId,
    ...overrides,
  });
}

function codesOf(options: readonly WarehouseOption[]): string[] {
  return options.map((option) => option.warehouse.code).sort();
}

function byCode(result: WarehouseOptionsResult, code: string): WarehouseOption {
  const found = result.options.find((option) => option.warehouse.code === code);
  if (found === undefined) {
    throw new Error(`no option for ${code}; got ${codesOf(result.options).join(', ')}`);
  }
  return found;
}

beforeEach(async () => {
  await resetAll();

  await prisma.businessProfile.create({
    data: {
      id: newId(),
      legalName: 'UBOSS Test',
      displayName: 'UBOSS',
      supportEmail: 'support@test.local',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      orderPrefix: 'UB',
    },
  });

  const adminId = newId();
  await prisma.user.create({
    data: {
      id: adminId,
      type: 'ADMIN',
      email: 'admin@fulfilment.test',
      emailNormalized: 'admin@fulfilment.test',
      status: 'ACTIVE',
    },
  });
  adminActor = { userId: adminId, email: 'admin@fulfilment.test' };

  const buyer = await makeCustomer('buyer@fulfilment.test');
  customerUserId = buyer.userId;
  customerProfileId = buyer.profileId;

  const other = await makeCustomer('other@fulfilment.test');
  otherProfileId = other.profileId;

  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId,
      contactName: 'Fulfilment Buyer',
      contactPhone: '+91 90000 00000',
      line1: 'Gate 3',
      city: 'Pune',
      state: 'MH',
      postalCode: '411019',
      country: 'IN',
      timezone: 'Asia/Kolkata',
      isDefaultBilling: true,
      isDefaultShipping: true,
    },
  });
  addressId = address.id;

  const otherAddress = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId,
      contactName: 'Fulfilment Buyer',
      contactPhone: '+91 90000 00001',
      line1: 'Unit 9',
      city: 'Chennai',
      state: 'TN',
      postalCode: '600001',
      country: 'IN',
      timezone: 'Asia/Kolkata',
    },
  });
  otherAddressId = otherAddress.id;

  await prisma.shippingMethod.create({
    data: {
      id: newId(),
      code: 'STANDARD',
      name: 'Standard delivery',
      priceMinor: 4900n,
      freeAboveMinor: null,
      isActive: true,
    },
  });

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'GST18',
      name: 'GST 18%',
      ratePercent: '18.000000',
      isDefault: true,
      isActive: true,
    },
  });
  taxClassId = taxClass.id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Consumables', slug: 'fulfilment-consumables', isActive: true },
  });
  categoryId = category.id;

  // Pune is in the destination city; Mumbai is 120 km away; Chennai is 900 km
  // away and is the one that will be given no lane.
  puneId = await warehouse({ code: 'PNQ', latitude: 18.52, longitude: 73.85, city: 'Pune', isDefault: true });
  mumbaiId = await warehouse({ code: 'BOM', latitude: 19.076, longitude: 72.877, city: 'Mumbai' });
  chennaiId = await warehouse({ code: 'MAA', latitude: 13.08, longitude: 80.27, city: 'Chennai' });

  boltId = await product({ sku: 'FUL-BOLT', priceMinor: 10_000n, weightGrams: 200 });
  reagentId = await product({ sku: 'FUL-REAGENT', priceMinor: 50_000n, requiresColdChain: true });
  restrictedId = await product({ sku: 'FUL-RESTRICTED', priceMinor: 20_000n });

  for (const location of [puneId, mumbaiId, chennaiId]) {
    await stock(location, boltId, 500);
    await stock(location, reagentId, 500);
    await stock(location, restrictedId, 500);
  }
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('postcode matching', () => {
  it('treats an empty prefix list as the whole country', () => {
    expect(zoneCoversPostal('', '411019')).toBe(true);
    expect(zoneCoversPostal('', null)).toBe(true);
  });

  it('matches on a prefix, and ignores spacing and hyphens on both sides', () => {
    expect(zoneCoversPostal('411', '411019')).toBe(true);
    expect(zoneCoversPostal('SW1', 'sw1a 1aa')).toBe(true);
    expect(zoneCoversPostal('80', '80-601')).toBe(true);
    expect(zoneCoversPostal('412,413', '411019')).toBe(false);
  });

  /**
   * A lane with prefixes and a destination with no postcode does not match.
   *
   * The conservative direction on purpose: an estimate taken before an
   * address is typed must not quote a lane that may turn out not to cover
   * them.
   */
  it('refuses a narrowed lane when the postcode is not known yet', () => {
    expect(zoneCoversPostal('411', null)).toBe(false);
  });
});

describe('what makes a warehouse eligible', () => {
  it('offers the warehouses with a lane, and nothing else', async () => {
    await lane(puneId);
    await lane(mumbaiId);
    // Chennai gets none, and is 900 km from the address - well inside its own
    // 800 km radius of nothing in particular. It is the assertion that the
    // geofence does not decide this.
    await addItem(customerProfileId, { productId: boltId, quantity: 2 });

    const result = await quote();

    expect(codesOf(result.options)).toEqual(['BOM', 'PNQ']);
    expect(result.ineligible.map((entry) => entry.warehouse.code)).toContain('MAA');
    expect(result.ineligible.find((entry) => entry.warehouse.code === 'MAA')?.reason).toBe(
      'NO_DELIVERY_ZONE',
    );
  });

  it('does not offer a warehouse whose lane misses the postcode', async () => {
    await lane(puneId, { postalPrefixes: '411' });
    await lane(mumbaiId, { postalPrefixes: '400,401' });
    await addItem(customerProfileId, { productId: boltId, quantity: 2 });

    const result = await quote();

    expect(codesOf(result.options)).toEqual(['PNQ']);
    expect(result.ineligible.find((entry) => entry.warehouse.code === 'BOM')?.reason).toBe(
      'NO_DELIVERY_ZONE',
    );
  });

  it('does not offer a warehouse that cannot dispatch today', async () => {
    await lane(puneId);
    await lane(mumbaiId);
    await prisma.inventoryLocation.update({
      where: { id: mumbaiId },
      data: { operationalStatus: 'MAINTENANCE' },
    });
    await addItem(customerProfileId, { productId: boltId, quantity: 2 });

    const result = await quote();

    expect(codesOf(result.options)).toEqual(['PNQ']);
    // Not even reported as ineligible: a warehouse under maintenance is
    // filtered in SQL before any of this runs, and a buyer has no business
    // reading the operator's maintenance schedule.
    expect(result.ineligible.map((entry) => entry.warehouse.code)).not.toContain('BOM');
  });

  it('does not offer a warehouse whose country the operator closed', async () => {
    await lane(puneId);
    await lane(mumbaiId);
    await prisma.warehouseCountryExclusion.create({
      data: { id: newId(), locationId: mumbaiId, countryCode: 'IN' },
    });
    await addItem(customerProfileId, { productId: boltId, quantity: 2 });

    const result = await quote();

    expect(codesOf(result.options)).toEqual(['PNQ']);
    expect(result.ineligible.find((entry) => entry.warehouse.code === 'BOM')?.reason).toBe(
      'COUNTRY_CLOSED',
    );
  });

  /**
   * Part of a basket is not an offer.
   *
   * It is reported with the lines and the quantities, because "some items are
   * unavailable" is not something a buyer can act on - and it is reported
   * under `ineligible` rather than mixed in with the options, because there
   * is no split-shipment flow in this product and offering half a basket
   * would break the order at the picking face.
   */
  it('reports a warehouse short of one line rather than offering it', async () => {
    await lane(puneId);
    await lane(mumbaiId);

    await prisma.inventoryBalance.updateMany({
      where: { locationId: mumbaiId, productId: boltId },
      data: { onHandQty: 1 },
    });

    await addItem(customerProfileId, { productId: boltId, quantity: 5 });

    const result = await quote();

    expect(codesOf(result.options)).toEqual(['PNQ']);

    const short = result.ineligible.find((entry) => entry.warehouse.code === 'BOM');
    expect(short?.reason).toBe('INSUFFICIENT_STOCK');
    expect(short?.shortLines).toHaveLength(1);
    expect(short?.shortLines[0]?.availableQty).toBe(1);
    expect(short?.shortLines[0]?.quantity).toBe(5);
  });

  it('refuses a lane that cannot hold temperature for a cold-chain line', async () => {
    await lane(puneId, { serviceLevel: 'Surface' });
    await lane(puneId, { serviceLevel: 'Cold', supportsColdChain: true, feeMinor: 29_900n });

    await addItem(customerProfileId, { productId: reagentId, quantity: 1 });

    const result = await quote();

    expect(result.options).toHaveLength(1);
    expect(result.options[0]?.carrier.serviceLevel).toBe('Cold');
  });

  it('refuses a lane that prices delivery in another currency', async () => {
    await lane(puneId, { currency: 'EUR' });
    await addItem(customerProfileId, { productId: boltId, quantity: 2 });

    const result = await quote();

    expect(result.options).toHaveLength(0);
    expect(result.ineligible.find((entry) => entry.warehouse.code === 'PNQ')?.reason).toBe(
      'CURRENCY_MISMATCH',
    );
  });

  it('refuses a lane lighter than the basket', async () => {
    await lane(puneId, { maxWeightGrams: 100 });
    // 200 g each, five of them.
    await addItem(customerProfileId, { productId: boltId, quantity: 5 });

    const result = await quote();

    expect(result.ineligible.find((entry) => entry.warehouse.code === 'PNQ')?.reason).toBe(
      'OVER_WEIGHT',
    );
  });

  /**
   * A product the destination refuses closes every warehouse.
   *
   * It is a fact about the goods rather than about a building, so recording
   * it on each warehouse in turn would mean forgetting it on the one opened
   * next year.
   */
  it('offers nothing when a line may not be delivered to the country', async () => {
    await lane(puneId);
    await lane(mumbaiId);

    await prisma.productCountryRestriction.create({
      data: {
        id: newId(),
        productId: restrictedId,
        countryCode: 'IN',
        reason: 'No import licence',
      },
    });

    await addItem(customerProfileId, { productId: restrictedId, quantity: 1 });

    const result = await quote();

    expect(result.options).toHaveLength(0);
    expect(result.restrictedLines).toHaveLength(1);
    expect(result.restrictedLines[0]?.reason).toBe('No import licence');
    expect(result.ineligible.every((entry) => entry.reason === 'PRODUCT_RESTRICTED')).toBe(true);
  });
});

describe('what an option promises', () => {
  it('adds the lane fee to the cart total and nothing else', async () => {
    await lane(puneId, { feeMinor: 12_500n });
    await addItem(customerProfileId, { productId: boltId, quantity: 3 });

    const result = await quote();
    const option = byCode(result, 'PNQ');

    // 3 x 100.00 at 18% exclusive = 300.00 + 54.00 = 354.00, plus 125.00.
    expect(option.totals.subtotal.minor).toBe('30000');
    expect(option.totals.tax.minor).toBe('5400');
    expect(option.totals.shipping.minor).toBe('12500');
    expect(option.totals.grandTotal.minor).toBe('47900');
  });

  it('honours the lane free-delivery threshold', async () => {
    await lane(puneId, { feeMinor: 12_500n, freeAboveMinor: 20_000n });
    await addItem(customerProfileId, { productId: boltId, quantity: 3 });

    const result = await quote();

    expect(byCode(result, 'PNQ').totals.shipping.minor).toBe('0');
    expect(byCode(result, 'PNQ').totals.grandTotal.minor).toBe('35400');
  });

  it('dates the promise from handling plus transit, on the warehouse clock', async () => {
    await lane(puneId, { handlingDays: 1, transitMinDays: 2, transitMaxDays: 4 });
    await addItem(customerProfileId, { productId: boltId, quantity: 1 });

    // Pinned, so the expected dates do not depend on when the suite runs.
    const now = new Date('2026-09-14T06:00:00.000Z');
    const result = await quote({ now });
    const option = byCode(result, 'PNQ');

    const today = todayIn('Asia/Kolkata', now);
    expect(option.dispatchDate).toBe(addCalendarDays(today, 1));
    expect(option.deliveryFromDate).toBe(addCalendarDays(today, 3));
    expect(option.deliveryToDate).toBe(addCalendarDays(today, 5));
  });

  /**
   * A working-day lane steps over the weekend.
   *
   * Pinned to a Friday: one handling day lands on the Monday, and two transit
   * days on the Wednesday. A calendar-day lane would have said Saturday and
   * Monday, which is a van nobody was driving.
   */
  it('steps a working-day lane over the weekend', async () => {
    await lane(puneId, {
      usesBusinessDays: true,
      handlingDays: 1,
      transitMinDays: 2,
      transitMaxDays: 2,
    });
    await addItem(customerProfileId, { productId: boltId, quantity: 1 });

    // 2026-09-11 is a Friday. 12:00 UTC is 17:30 in Kolkata, still the 11th.
    const result = await quote({ now: new Date('2026-09-11T12:00:00.000Z') });
    const option = byCode(result, 'PNQ');

    expect(option.dispatchDate).toBe('2026-09-14');
    expect(option.deliveryFromDate).toBe('2026-09-16');
  });

  it('says whether it can make a date the buyer asked for', async () => {
    await lane(puneId, { handlingDays: 1, transitMinDays: 2, transitMaxDays: 4 });
    await addItem(customerProfileId, { productId: boltId, quantity: 1 });

    const now = new Date('2026-09-14T06:00:00.000Z');
    const today = todayIn('Asia/Kolkata', now);

    const soon = await quote({ now, requestedDeliveryDate: addCalendarDays(today, 2) });
    expect(byCode(soon, 'PNQ').meetsRequestedDate).toBe(false);

    const later = await quote({ now, requestedDeliveryDate: addCalendarDays(today, 10) });
    expect(byCode(later, 'PNQ').meetsRequestedDate).toBe(true);
  });
});

describe('the badges', () => {
  it('marks the soonest and the cheapest, and they can be different cards', async () => {
    // Pune: fast and dear. Mumbai: slow and free.
    await lane(puneId, { transitMinDays: 1, transitMaxDays: 1, feeMinor: 30_000n });
    await lane(mumbaiId, { transitMinDays: 5, transitMaxDays: 6, feeMinor: 0n });

    await addItem(customerProfileId, { productId: boltId, quantity: 1 });

    const result = await quote();

    expect(byCode(result, 'PNQ').isFastest).toBe(true);
    expect(byCode(result, 'PNQ').isCheapest).toBe(false);
    expect(byCode(result, 'BOM').isCheapest).toBe(true);
    expect(byCode(result, 'BOM').isFastest).toBe(false);

    // Fastest first: the list is a presentation, and nothing here picks for
    // the buyer except the default below.
    expect(result.options[0]?.warehouse.code).toBe('PNQ');
  });

  it('recommends exactly one option, and it is the cheapest of the soonest', async () => {
    // Same arrival window, different prices: the cheaper one is the default.
    await lane(puneId, { transitMinDays: 2, transitMaxDays: 3, feeMinor: 30_000n });
    await lane(mumbaiId, { transitMinDays: 2, transitMaxDays: 3, feeMinor: 5_000n });

    await addItem(customerProfileId, { productId: boltId, quantity: 1 });

    const result = await quote();

    expect(result.options.filter((option) => option.isRecommended)).toHaveLength(1);
    expect(byCode(result, 'BOM').isRecommended).toBe(true);
  });
});

describe('the estimate, before an address is chosen', () => {
  it('answers from a country alone and says that is what it is', async () => {
    await lane(puneId);
    await addItem(customerProfileId, { productId: boltId, quantity: 1 });

    const result = await quoteWarehouseOptions({
      customerProfileId,
      countryCode: 'IN',
    });

    expect(result.isEstimate).toBe(true);
    expect(result.destination.postalCode).toBeNull();
    expect(result.options).toHaveLength(1);
  });

  /** An estimate is a conversation, never an offer. */
  it('is refused at checkout', async () => {
    await lane(puneId);
    await addItem(customerProfileId, { productId: boltId, quantity: 1 });

    const estimate = await quoteWarehouseOptions({ customerProfileId, countryCode: 'IN' });
    const quoteId = estimate.options[0]?.quoteId ?? '';

    await expect(
      submitCheckout({
        customerProfileId,
        shippingAddressId: addressId,
        paymentMode: 'ONLINE',
        fulfilmentQuoteId: quoteId,
        actor: CUSTOMER_ACTOR(),
      }),
    ).rejects.toMatchObject({ code: 'FULFILMENT_QUOTE_INVALID' });
  });
});

describe('accepting an offer at checkout', () => {
  async function oneOption(laneOptions: LaneOptions = {}): Promise<WarehouseOption> {
    await lane(puneId, laneOptions);
    await addItem(customerProfileId, { productId: boltId, quantity: 2 });

    const result = await quote();
    const option = result.options[0];
    if (option === undefined) throw new Error('expected one option');
    return option;
  }

  it('freezes the warehouse, the carrier and the dates onto the order', async () => {
    const option = await oneOption({ feeMinor: 12_500n, carrierName: 'Delhivery', serviceLevel: 'Express' });

    const created = await submitCheckout({
      customerProfileId,
      shippingAddressId: addressId,
      paymentMode: 'ONLINE',
      fulfilmentQuoteId: option.quoteId,
      actor: CUSTOMER_ACTOR(),
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } });

    expect(order.fulfilmentLocationId).toBe(puneId);
    expect(order.fulfilmentQuoteId).toBe(option.quoteId);
    expect(order.fulfilmentCarrier).toBe('Delhivery');
    expect(order.fulfilmentServiceLevel).toBe('Express');
    expect(order.fulfilmentDispatchDate).not.toBeNull();
    expect(order.fulfilmentDeliveryFrom).not.toBeNull();
    expect(order.fulfilmentDeliveryTo).not.toBeNull();

    // The lane priced the delivery, and the shipping method did not: recording
    // a method that contributed nothing to the figure would leave the order
    // naming an arrangement its own shipping total does not come from.
    expect(order.shippingMinor).toBe(12_500n);
    expect(order.shippingMethodCode).toBeNull();
    expect(order.grandTotalMinor.toString()).toBe(option.totals.grandTotal.minor);
  });

  it('records the choice in the audit trail', async () => {
    const option = await oneOption();

    const created = await submitCheckout({
      customerProfileId,
      shippingAddressId: addressId,
      paymentMode: 'ONLINE',
      fulfilmentQuoteId: option.quoteId,
      actor: CUSTOMER_ACTOR(),
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      // The stored value, not the constant's name. `AuditAction.ORDER_CREATED`
      // is 'order.created', and querying for the enum key matches no row —
      // which is a green-looking test that asserts nothing.
      where: { resourceType: 'order', resourceId: created.orderId, action: 'order.created' },
    });

    const after = entry.afterJson as Record<string, unknown>;
    const fulfilment = after['fulfilment'] as Record<string, unknown> | undefined;

    expect(fulfilment).toBeDefined();
    expect(fulfilment?.['warehouseId']).toBe(puneId);
    expect(fulfilment?.['quoteId']).toBe(option.quoteId);
  });

  it('refuses an offer that has lapsed', async () => {
    const option = await oneOption();

    await prisma.fulfilmentQuote.update({
      where: { id: option.quoteId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      submitCheckout({
        customerProfileId,
        shippingAddressId: addressId,
        paymentMode: 'ONLINE',
        fulfilmentQuoteId: option.quoteId,
        actor: CUSTOMER_ACTOR(),
      }),
    ).rejects.toMatchObject({ code: 'FULFILMENT_QUOTE_EXPIRED' });
  });

  it('refuses an offer for a basket that has since changed', async () => {
    const option = await oneOption();

    // A second tab adds a line.
    await addItem(customerProfileId, { productId: reagentId, quantity: 1 });

    await expect(
      submitCheckout({
        customerProfileId,
        shippingAddressId: addressId,
        paymentMode: 'ONLINE',
        fulfilmentQuoteId: option.quoteId,
        actor: CUSTOMER_ACTOR(),
      }),
    ).rejects.toMatchObject({ code: 'FULFILMENT_QUOTE_STALE' });
  });

  it('refuses an offer taken against a different address', async () => {
    const option = await oneOption();

    await expect(
      submitCheckout({
        customerProfileId,
        shippingAddressId: otherAddressId,
        paymentMode: 'ONLINE',
        fulfilmentQuoteId: option.quoteId,
        actor: CUSTOMER_ACTOR(),
      }),
    ).rejects.toMatchObject({ code: 'FULFILMENT_QUOTE_INVALID' });
  });

  /**
   * Somebody else's quote id is not found rather than forbidden.
   *
   * Deliberately one answer for "not yours" and "not there": distinguishing
   * them would make this endpoint an oracle for other people's quote ids.
   */
  it('refuses another customer an offer that is not theirs', async () => {
    const option = await oneOption();

    const { basketHash, cartId } = await currentBasketDigest(otherProfileId);

    await expect(
      assertQuoteUsable({
        quoteId: option.quoteId,
        customerProfileId: otherProfileId,
        cartId,
        addressId,
        basketHash,
      }),
    ).rejects.toMatchObject({ code: 'FULFILMENT_QUOTE_INVALID' });
  });

  it('refuses when the warehouse stops dispatching between the quote and the payment', async () => {
    const option = await oneOption();

    await prisma.inventoryLocation.update({
      where: { id: puneId },
      data: { operationalStatus: 'SUSPENDED' },
    });

    await expect(
      submitCheckout({
        customerProfileId,
        shippingAddressId: addressId,
        paymentMode: 'ONLINE',
        fulfilmentQuoteId: option.quoteId,
        actor: CUSTOMER_ACTOR(),
      }),
    ).rejects.toMatchObject({ code: 'FULFILMENT_WAREHOUSE_UNAVAILABLE' });
  });

  it('refuses when the lane is withdrawn between the quote and the payment', async () => {
    const option = await oneOption();

    await prisma.warehouseDeliveryZone.updateMany({
      where: { locationId: puneId },
      data: { isActive: false },
    });

    await expect(
      submitCheckout({
        customerProfileId,
        shippingAddressId: addressId,
        paymentMode: 'ONLINE',
        fulfilmentQuoteId: option.quoteId,
        actor: CUSTOMER_ACTOR(),
      }),
    ).rejects.toMatchObject({ code: 'FULFILMENT_WAREHOUSE_UNAVAILABLE' });
  });

  /**
   * Somebody else bought it first.
   *
   * The refusal names the line and the quantities, and no substitution is
   * made and no other warehouse is chosen for them.
   */
  it('refuses when the stock has gone at that warehouse, and says which line', async () => {
    const option = await oneOption();

    await prisma.inventoryBalance.updateMany({
      where: { locationId: puneId, productId: boltId },
      data: { onHandQty: 0 },
    });

    await expect(
      submitCheckout({
        customerProfileId,
        shippingAddressId: addressId,
        paymentMode: 'ONLINE',
        fulfilmentQuoteId: option.quoteId,
        actor: CUSTOMER_ACTOR(),
      }),
    ).rejects.toMatchObject({
      code: 'FULFILMENT_STOCK_CHANGED',
      details: [{ code: 'INSUFFICIENT_STOCK' }],
    });
  });

  /**
   * The check the quote deliberately does not make for itself.
   *
   * A catalogue edit between the review screen and Pay moves the total, and
   * the customer agreed to a figure rather than to a method of arriving at
   * one. Both numbers travel in the refusal so the storefront can say what it
   * was and what it is now.
   */
  it('refuses when the price has moved since the offer', async () => {
    const option = await oneOption();

    await prisma.product.update({
      where: { id: boltId },
      data: { basePriceMinor: 11_000n },
    });

    await expect(
      submitCheckout({
        customerProfileId,
        shippingAddressId: addressId,
        paymentMode: 'ONLINE',
        fulfilmentQuoteId: option.quoteId,
        actor: CUSTOMER_ACTOR(),
      }),
    ).rejects.toMatchObject({
      code: 'FULFILMENT_QUOTE_STALE',
      details: [{ code: 'PRICE_CHANGED' }],
    });
  });
});

describe('what happens where nothing is configured', () => {
  /**
   * The no-regression test.
   *
   * An installation that has never opened the delivery-zone panel offers no
   * warehouse options at all - and still takes orders, priced by the shipping
   * method, exactly as it did before any of this existed. A feature that made
   * a working checkout stop working would not be worth having.
   */
  it('checks out on the configured shipping method when there are no lanes', async () => {
    await addItem(customerProfileId, { productId: boltId, quantity: 2 });

    const result = await quote();
    expect(result.options).toHaveLength(0);

    const created = await submitCheckout({
      customerProfileId,
      shippingAddressId: addressId,
      shippingMethodCode: 'STANDARD',
      paymentMode: 'ONLINE',
      actor: CUSTOMER_ACTOR(),
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } });

    expect(order.fulfilmentLocationId).toBeNull();
    expect(order.fulfilmentQuoteId).toBeNull();
    expect(order.shippingMethodCode).toBe('STANDARD');
    expect(order.shippingMinor).toBe(4900n);
  });

  it('answers an empty basket with a refusal rather than an empty offer', async () => {
    await lane(puneId);
    await clearCart(customerProfileId);

    await expect(quote()).rejects.toMatchObject({ code: 'CART_EMPTY' });
  });
});

describe('clearing offers nobody took', () => {
  it('removes a lapsed quote and keeps the one an order accepted', async () => {
    await lane(puneId);
    await addItem(customerProfileId, { productId: boltId, quantity: 1 });

    const taken = (await quote()).options[0];
    if (taken === undefined) throw new Error('expected an option');

    const created = await submitCheckout({
      customerProfileId,
      shippingAddressId: addressId,
      paymentMode: 'ONLINE',
      fulfilmentQuoteId: taken.quoteId,
      actor: CUSTOMER_ACTOR(),
    });
    expect(created.orderId).not.toBe('');

    // A second round of options, never accepted.
    await addItem(customerProfileId, { productId: boltId, quantity: 1 });
    const abandoned = (await quote()).options[0];
    if (abandoned === undefined) throw new Error('expected an option');

    // Both well past their expiry and past the grace period the sweep allows.
    await prisma.fulfilmentQuote.updateMany({
      data: { expiresAt: new Date(Date.now() - 48 * 3_600_000) },
    });

    const swept = await sweepExpiredFulfilmentQuotes();

    expect(swept.removed).toBe(1);
    expect(await prisma.fulfilmentQuote.findUnique({ where: { id: abandoned.quoteId } })).toBeNull();
    // Kept: it is the evidence of what the customer was shown before they
    // agreed to pay, and the foreign key is RESTRICT so the sweep could not
    // have taken it even if it had tried.
    expect(await prisma.fulfilmentQuote.findUnique({ where: { id: taken.quoteId } })).not.toBeNull();
  });
});
