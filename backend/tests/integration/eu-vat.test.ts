/**
 * EU VAT and invoicing, end to end — against a real MariaDB.
 *
 * The unit tests next door assert the decision table in isolation. This file
 * asserts the thing that actually matters: that the decision reaches the
 * money. A perfect treatment resolver is worth nothing if the cart prices at
 * the seller's rate anyway, or if the order records a treatment the lines were
 * not priced under, or if the invoice states a total that disagrees with the
 * order behind it.
 *
 * Four claims:
 *   - A Dutch seller charges Dutch VAT at home, German VAT to a German
 *     consumer, and nothing to a German business with a confirmed VAT number.
 *   - The delivery address decides, not the country the shopper typed into
 *     their profile.
 *   - The order freezes the reasoning, so a VAT number cancelled tomorrow does
 *     not retroactively change what was charged today.
 *   - The invoice satisfies the Art. 226 checklist, including the per-rate
 *     breakdown and the exemption wording.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { addItem, resolveCart } from '../../src/modules/cart/cart.service.js';
import { receiveStock } from '../../src/modules/inventory/inventory.service.js';
import { submitCheckout } from '../../src/modules/orders/order.service.js';
import { creditInvoice, getInvoice, issueInvoice } from '../../src/modules/invoicing/invoice.service.js';

let adminActor: { userId: string; email: string };
let customerUserId: string;
let customerProfileId: string;
let standardProductId: string;
let reducedProductId: string;

const CUSTOMER_ACTOR = () => ({
  userId: customerUserId,
  email: 'inkoop@zorggroep.test',
  type: 'CUSTOMER' as const,
});

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.idempotencyRecord.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  // Two passes: an invoice referenced by the credit note that cancels it is
  // protected by a Restrict foreign key, which is the point - an issued
  // invoice is not deletable while something points at it. Detach first.
  await prisma.invoice.updateMany({ data: { creditsInvoiceId: null } });
  await prisma.invoice.deleteMany({});
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderApproval.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.numberSequence.deleteMany({});
  await prisma.productPrice.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.shippingMethod.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.businessProfile.deleteMany({});
  await prisma.vatRate.deleteMany({});
  await prisma.vatNumberCheck.deleteMany({});
}

/** A delivery address in one country. Returns its id. */
async function makeAddress(country: string): Promise<string> {
  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId,
      contactName: 'Inkoop Zorggroep',
      contactPhone: '+31 20 1234567',
      line1: 'Keizersgracht 123',
      city: 'Amsterdam',
      state: 'Noord-Holland',
      postalCode: '1015CJ',
      country,
    },
  });

  return address.id;
}

async function priceIn(productId: string, currency: string, minor: bigint): Promise<void> {
  await prisma.productPrice.create({
    data: {
      id: newId(),
      productId,
      variantKey: '',
      currencyCode: currency,
      basePriceMinor: minor,
    },
  });
}

/**
 * The reference rows this file needs.
 *
 * Upserted rather than seeded, and never deleted by `resetAll`: currencies and
 * countries are reference data shared with every other test file in the suite,
 * and a `deleteMany` here would break whichever file happens to run next.
 */
async function ensureReferenceData(): Promise<void> {
  await prisma.currency.upsert({
    where: { code: 'EUR' },
    update: {},
    create: { code: 'EUR', name: 'Euro', symbol: '€', exponent: 2, sortOrder: 30 },
  });

  const countries: [string, string][] = [
    ['NL', 'Netherlands'],
    ['DE', 'Germany'],
    // The third country, for the export case.
    ['CH', 'Switzerland'],
  ];

  for (const [code, name] of countries) {
    await prisma.country.upsert({
      where: { code },
      update: {},
      create: { code, name, currencyCode: 'EUR', isActive: true },
    });
  }
}

beforeEach(async () => {
  await resetAll();
  await ensureReferenceData();

  // A Dutch seller. The `vatCountry` is what switches EU VAT resolution on;
  // without it every assertion in this file would come back FLAT_RATE.
  await prisma.businessProfile.create({
    data: {
      id: newId(),
      legalName: 'UBOSS Medical B.V.',
      displayName: 'UBOSS',
      supportEmail: 'verkoop@uboss.test',
      addressJson: { line1: 'Havenstraat 4', city: 'Rotterdam', postalCode: '3011AA', country: 'NL' },
      currency: 'EUR',
      timezone: 'Europe/Amsterdam',
      orderPrefix: 'UB',
      invoicePrefix: 'INV',
      vatNumber: 'NL123456789B01',
      vatCountry: 'NL',
    },
  });

  // The VAT area, and two states' rates. Seeded here rather than relying on
  // the reference seed, so the numbers this file asserts are the numbers this
  // file wrote - a rate correction in `vat-reference.ts` must not turn these
  // assertions red.
  await prisma.country.updateMany({ where: { code: { in: ['NL', 'DE'] } }, data: { isEuVat: true } });
  await prisma.country.updateMany({ where: { code: 'CH' }, data: { isEuVat: false } });

  const rates: [string, 'STANDARD' | 'REDUCED', string][] = [
    ['NL', 'STANDARD', '21'],
    ['NL', 'REDUCED', '9'],
    ['DE', 'STANDARD', '19'],
    ['DE', 'REDUCED', '7'],
  ];

  for (const [countryCode, category, ratePercent] of rates) {
    await prisma.vatRate.create({
      data: {
        id: newId(),
        countryCode,
        category,
        ratePercent,
        validFrom: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
  }

  const adminId = newId();
  await prisma.user.create({
    data: {
      id: adminId,
      type: 'ADMIN',
      email: 'admin@vat.test',
      emailNormalized: 'admin@vat.test',
      status: 'ACTIVE',
    },
  });
  adminActor = { userId: adminId, email: 'admin@vat.test' };

  customerUserId = newId();
  await prisma.user.create({
    data: {
      id: customerUserId,
      type: 'CUSTOMER',
      email: 'inkoop@zorggroep.test',
      emailNormalized: 'inkoop@zorggroep.test',
      status: 'ACTIVE',
    },
  });

  const profile = await prisma.customerProfile.create({
    data: {
      id: newId(),
      userId: customerUserId,
      fullName: 'Inkoop Zorggroep',
      organization: 'Zorggroep Noord',
      // Deliberately Dutch, so the tests that ship to Germany prove the
      // DELIVERY address is what decides rather than this field.
      preferredCountry: 'NL',
      preferredCurrency: 'EUR',
    },
  });
  customerProfileId = profile.id;

  await prisma.inventoryLocation.create({
    data: { id: newId(), code: 'MAIN', name: 'Main', isDefault: true, isActive: true },
  });

  const standardClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'VAT-STD',
      name: 'Standard rate',
      // The flat rate is deliberately a wrong-looking number: if any assertion
      // below sees 18%, EU resolution did not run.
      ratePercent: '18.000000',
      vatCategory: 'STANDARD',
      isDefault: true,
      isActive: true,
    },
  });

  const reducedClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'VAT-RED',
      name: 'Reduced rate',
      ratePercent: '18.000000',
      vatCategory: 'REDUCED',
      isActive: true,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Consumables', slug: 'consumables', isActive: true },
  });

  const standard = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: standardClass.id,
      name: 'Nitrile gloves, box of 100',
      slug: 'nitrile-gloves',
      sku: 'GLV-100',
      basePriceMinor: 10_000n,
      currency: 'EUR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: true,
    },
  });
  standardProductId = standard.id;

  const reduced = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: reducedClass.id,
      name: 'Sterile dressing',
      slug: 'sterile-dressing',
      sku: 'DRS-10',
      basePriceMinor: 5_000n,
      currency: 'EUR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: true,
    },
  });
  reducedProductId = reduced.id;

  await priceIn(standardProductId, 'EUR', 10_000n);
  await priceIn(reducedProductId, 'EUR', 5_000n);

  await receiveStock({ productId: standardProductId, quantity: 500 }, adminActor);
  await receiveStock({ productId: reducedProductId, quantity: 500 }, adminActor);
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

describe('cart pricing under EU VAT', () => {
  it('charges the seller’s own rate on a domestic sale', async () => {
    await addItem(customerProfileId, { productId: standardProductId, quantity: 1 });

    const resolved = await resolveCart(customerProfileId, { destinationCountry: 'NL' });

    expect(resolved.taxSetup.context.treatment).toBe('DOMESTIC');
    expect(resolved.pricing.lines[0]?.taxRatePercent).toBe('21');
    // €100 net, 21% on top.
    expect(resolved.pricing.totals.taxMinor).toBe(2_100n);
    expect(resolved.pricing.totals.grandTotalMinor).toBe(12_100n);
  });

  it('charges the DESTINATION state’s rate to a customer with no VAT number', async () => {
    await addItem(customerProfileId, { productId: standardProductId, quantity: 1 });

    const resolved = await resolveCart(customerProfileId, { destinationCountry: 'DE' });

    expect(resolved.taxSetup.context.treatment).toBe('INTRA_EU_B2C');
    // German 19%, not Dutch 21% and certainly not the tax class's own 18%.
    expect(resolved.pricing.lines[0]?.taxRatePercent).toBe('19');
    expect(resolved.pricing.totals.taxMinor).toBe(1_900n);
  });

  it('zero-rates a supply to a business whose VAT number VIES confirmed', async () => {
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { vatNumber: 'DE811569869', vatNumberValid: true, vatNumberCheckedAt: new Date() },
    });

    await addItem(customerProfileId, { productId: standardProductId, quantity: 1 });

    const resolved = await resolveCart(customerProfileId, { destinationCountry: 'DE' });

    expect(resolved.taxSetup.context.treatment).toBe('INTRA_EU_REVERSE_CHARGE');
    expect(resolved.pricing.lines[0]?.taxRatePercent).toBe('0');
    expect(resolved.pricing.totals.taxMinor).toBe(0n);
    expect(resolved.pricing.totals.grandTotalMinor).toBe(10_000n);
  });

  it('taxes the same supply when the VAT number is unverified', async () => {
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      // A number on file that nobody has checked. Not the same as a bad one,
      // and treated the same way: the seller carries the liability.
      data: { vatNumber: 'DE811569869', vatNumberValid: null },
    });

    await addItem(customerProfileId, { productId: standardProductId, quantity: 1 });

    const resolved = await resolveCart(customerProfileId, { destinationCountry: 'DE' });

    expect(resolved.taxSetup.context.treatment).toBe('INTRA_EU_B2C');
    expect(resolved.pricing.totals.taxMinor).toBe(1_900n);
  });

  it('zero-rates an export out of the Union', async () => {
    await addItem(customerProfileId, { productId: standardProductId, quantity: 1 });

    const resolved = await resolveCart(customerProfileId, { destinationCountry: 'CH' });

    expect(resolved.taxSetup.context.treatment).toBe('EXPORT');
    expect(resolved.pricing.totals.taxMinor).toBe(0n);
  });

  it('applies each product’s own band, not one rate for the basket', async () => {
    await addItem(customerProfileId, { productId: standardProductId, quantity: 1 });
    await addItem(customerProfileId, { productId: reducedProductId, quantity: 1 });

    const resolved = await resolveCart(customerProfileId, { destinationCountry: 'DE' });

    const rates = resolved.pricing.lines.map((line) => line.taxRatePercent).sort();

    expect(rates).toEqual(['19', '7']);
    // €100 at 19% plus €50 at 7% = €19.00 + €3.50.
    expect(resolved.pricing.totals.taxMinor).toBe(2_250n);
  });

  it('blocks a line whose band has no rate in the destination state', async () => {
    await prisma.vatRate.deleteMany({ where: { countryCode: 'DE', category: 'REDUCED' } });
    await addItem(customerProfileId, { productId: reducedProductId, quantity: 1 });

    const resolved = await resolveCart(customerProfileId, { destinationCountry: 'DE' });

    // Never a silent 0%: an undercharge that surfaces at a VAT audit is worse
    // than a checkout that stops and says why.
    expect(resolved.lines[0]?.issues.length).toBeGreaterThan(0);
    expect(resolved.lines[0]?.issues[0]?.message).toContain('REDUCED');
  });

  it('falls back to the flat rate when the business has no VAT country', async () => {
    await prisma.businessProfile.updateMany({ data: { vatCountry: null } });
    await addItem(customerProfileId, { productId: standardProductId, quantity: 1 });

    const resolved = await resolveCart(customerProfileId, { destinationCountry: 'DE' });

    // The GST path, untouched. This is the assertion that lets one codebase
    // serve an Indian shop and a Dutch one.
    expect(resolved.taxSetup.context.treatment).toBe('FLAT_RATE');
    // The tax class's own figure, as Decimal.toString() renders it.
    expect(resolved.pricing.lines[0]?.taxRatePercent).toBe('18');
  });
});

describe('checkout freezes the treatment', () => {
  it('taxes by the delivery address, not the profile’s country', async () => {
    const german = await makeAddress('DE');
    await addItem(customerProfileId, { productId: standardProductId, quantity: 1 });

    const result = await submitCheckout({
      customerProfileId,
      shippingAddressId: german,
      paymentMode: 'ONLINE',
      actor: CUSTOMER_ACTOR(),
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.orderId } });

    // The profile says NL. The goods go to DE. Art. 33 follows the goods.
    expect(order.taxTreatment).toBe('INTRA_EU_B2C');
    expect(order.taxCountry).toBe('DE');
    expect(order.taxMinor).toBe(1_900n);
  });

  it('records the reasoning and both VAT numbers on the order', async () => {
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { vatNumber: 'DE811569869', vatNumberValid: true },
    });

    const german = await makeAddress('DE');
    await addItem(customerProfileId, { productId: standardProductId, quantity: 1 });

    const result = await submitCheckout({
      customerProfileId,
      shippingAddressId: german,
      paymentMode: 'ONLINE',
      actor: CUSTOMER_ACTOR(),
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.orderId } });

    expect(order.taxTreatment).toBe('INTRA_EU_REVERSE_CHARGE');
    expect(order.sellerVatNumberSnapshot).toBe('NL123456789B01');
    expect(order.buyerVatNumberSnapshot).toBe('DE811569869');
    expect(order.taxMinor).toBe(0n);

    // The number is cancelled the next day. What was charged must not move.
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { vatNumberValid: false },
    });

    const unchanged = await prisma.order.findUniqueOrThrow({ where: { id: result.orderId } });
    expect(unchanged.taxTreatment).toBe('INTRA_EU_REVERSE_CHARGE');
    expect(unchanged.taxMinor).toBe(0n);
  });
});

describe('invoicing', () => {
  async function placeAndConfirm(country: string): Promise<string> {
    const address = await makeAddress(country);
    await addItem(customerProfileId, { productId: standardProductId, quantity: 2 });
    await addItem(customerProfileId, { productId: reducedProductId, quantity: 1 });

    const result = await submitCheckout({
      customerProfileId,
      shippingAddressId: address,
      paymentMode: 'ONLINE',
      actor: CUSTOMER_ACTOR(),
    });

    await prisma.order.update({
      where: { id: result.orderId },
      data: { status: 'CONFIRMED' },
    });

    return result.orderId;
  }

  it('issues a sequential number and the Art. 226 identities', async () => {
    const orderId = await placeAndConfirm('NL');

    const issued = await issueInvoice({ orderId, actorUserId: adminActor.userId, actorEmail: adminActor.email });
    const invoice = await getInvoice(issued.id);

    expect(issued.number).toMatch(/^INV-\d{4}-000001$/);

    const seller = invoice.seller as Record<string, unknown>;
    const buyer = invoice.buyer as Record<string, unknown>;

    // Art. 226(3)-(5).
    expect(seller.legalName).toBe('UBOSS Medical B.V.');
    expect(invoice.sellerVatNumber).toBe('NL123456789B01');
    expect(buyer.organization).toBe('Zorggroep Noord');
    expect(buyer.billingAddress).toMatchObject({ country: 'NL' });
  });

  it('breaks the total down per rate, not into one figure', async () => {
    const orderId = await placeAndConfirm('DE');

    const issued = await issueInvoice({ orderId });
    const invoice = await getInvoice(issued.id);

    const breakdown = invoice.vatBreakdown as { ratePercent: string; taxableMinor: string; vatMinor: string }[];

    // Art. 226(8)-(10). Two bands on one invoice means two rows: €200 at 19%
    // and €50 at 7%. One combined "VAT: €41.50" is not a valid invoice.
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0]).toMatchObject({ ratePercent: '19', taxableMinor: '20000', vatMinor: '3800' });
    expect(breakdown[1]).toMatchObject({ ratePercent: '7', taxableMinor: '5000', vatMinor: '350' });
  });

  it('states the provision relied on when no VAT is charged', async () => {
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { vatNumber: 'DE811569869', vatNumberValid: true },
    });

    const orderId = await placeAndConfirm('DE');
    const issued = await issueInvoice({ orderId });
    const invoice = await getInvoice(issued.id);

    // Art. 226(11): a zero tax line is not an explanation.
    expect(invoice.exemptionNote).toContain('Article 138');
    expect(invoice.exemptionNote).toContain('Article 196');
    expect(invoice.taxTreatment).toBe('INTRA_EU_REVERSE_CHARGE');
  });

  it('agrees with the order it was raised from', async () => {
    const orderId = await placeAndConfirm('DE');
    const issued = await issueInvoice({ orderId });

    const invoice = await getInvoice(issued.id);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const totals = invoice.totals as Record<string, string>;

    // An invoice that disagrees with the order behind it is the one bug in
    // this area that nobody notices until a customer queries the amount.
    expect(totals.grandTotalMinor).toBe(order.grandTotalMinor.toString());
    expect(totals.taxMinor).toBe(order.taxMinor.toString());
    expect(totals.subtotalMinor).toBe(order.subtotalMinor.toString());
  });

  it('issues once per order, however many times it is asked', async () => {
    const orderId = await placeAndConfirm('NL');

    const first = await issueInvoice({ orderId });
    const second = await issueInvoice({ orderId });

    // Two numbers against one supply is a real problem to unpick once both are
    // in a VAT return.
    expect(second.number).toBe(first.number);
    expect(await prisma.invoice.count({ where: { orderId } })).toBe(1);
  });

  it('refuses to invoice an order that was never supplied', async () => {
    const address = await makeAddress('NL');
    await addItem(customerProfileId, { productId: standardProductId, quantity: 1 });

    const result = await submitCheckout({
      customerProfileId,
      shippingAddressId: address,
      paymentMode: 'ONLINE',
      actor: CUSTOMER_ACTOR(),
    });

    await prisma.order.update({ where: { id: result.orderId }, data: { status: 'CANCELLED' } });

    await expect(issueInvoice({ orderId: result.orderId })).rejects.toThrow();
  });

  it('corrects an invoice with a credit note rather than an edit', async () => {
    const orderId = await placeAndConfirm('NL');
    const original = await issueInvoice({ orderId });

    const credit = await creditInvoice({
      invoiceId: original.id,
      actorUserId: adminActor.userId,
      actorEmail: adminActor.email,
    });

    const note = await getInvoice(credit.id);
    const totals = note.totals as Record<string, string>;

    // The original stands - a gap in the sequence reads as a destroyed
    // document - and the correction is a second document of opposite value.
    expect(note.isCreditNote).toBe(true);
    expect(note.creditsInvoiceId).toBe(original.id);
    expect(totals.grandTotalMinor).toMatch(/^-/);

    const stillThere = await getInvoice(original.id);
    expect((stillThere.totals as Record<string, string>).grandTotalMinor).not.toMatch(/^-/);

    // And crediting twice does not issue a third document.
    const again = await creditInvoice({
      invoiceId: original.id,
      actorUserId: adminActor.userId,
      actorEmail: adminActor.email,
    });
    expect(again.number).toBe(credit.number);
  });

  it('numbers a credit note in the same series as the invoice it cancels', async () => {
    const orderId = await placeAndConfirm('NL');
    const original = await issueInvoice({ orderId });

    const credit = await creditInvoice({
      invoiceId: original.id,
      actorUserId: adminActor.userId,
      actorEmail: adminActor.email,
    });

    expect(original.number).toMatch(/^INV-\d{4}-000001$/);
    expect(credit.number).toMatch(/^INV-\d{4}-000002$/);
  });
});
