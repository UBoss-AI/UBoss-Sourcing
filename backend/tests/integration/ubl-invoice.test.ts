/**
 * EN 16931 UBL output — integration, against a real MariaDB.
 *
 * The document this produces is read by a machine at a tax authority, which
 * changes what "correct" means: there is no reviewer to notice that an amount
 * looks odd, and a rejection arrives days later as a code. So the assertions
 * here are about the things a validator actually fails on.
 *
 * The one that earns the most attention is the **VAT category code**. A zero
 * on an invoice is ambiguous — zero-rated, exempt, reverse-charged, out of
 * scope — and the receiver posts each one differently. Emitting `AE` (domestic
 * reverse charge) for an intra-Community supply instead of `K` is the classic
 * mapping error and puts the transaction in the wrong box on their return.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { addItem } from '../../src/modules/cart/cart.service.js';
import { receiveStock } from '../../src/modules/inventory/inventory.service.js';
import { submitCheckout } from '../../src/modules/orders/order.service.js';
import { issueInvoice } from '../../src/modules/invoicing/invoice.service.js';
import {
  renderInvoiceUbl,
  validateInvoiceForEn16931,
} from '../../src/modules/invoicing/ubl.service.js';

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

/**
 * The value of one element, by tag name.
 *
 * A regex rather than an XML parser: pulling in a parser to assert on output
 * this file also generates would mostly test the parser. These documents are
 * emitted by a template with no attributes on the elements being read, so the
 * match is unambiguous.
 */
function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return match?.[1]?.trim() ?? null;
}

function allTags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map(
    (match) => (match[1] ?? '').trim(),
  );
}

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.idempotencyRecord.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.invoice.updateMany({ data: { creditsInvoiceId: null } });
  await prisma.invoice.deleteMany({});
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.numberSequence.deleteMany({});
  await prisma.productPrice.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.businessProfile.deleteMany({});
  await prisma.vatRate.deleteMany({});
}

async function ensureReferenceData(): Promise<void> {
  await prisma.currency.upsert({
    where: { code: 'EUR' },
    update: {},
    create: { code: 'EUR', name: 'Euro', symbol: '€', exponent: 2, sortOrder: 30 },
  });

  for (const [code, name] of [
    ['NL', 'Netherlands'],
    ['DE', 'Germany'],
    ['CH', 'Switzerland'],
  ] as [string, string][]) {
    await prisma.country.upsert({
      where: { code },
      update: {},
      create: { code, name, currencyCode: 'EUR', isActive: true },
    });
  }
}

async function makeAddress(country: string): Promise<string> {
  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId,
      contactName: 'Inkoop Zorggroep',
      contactPhone: '+31 20 1234567',
      // An ampersand on purpose: a company name with one in it is ordinary,
      // and it is enough to make the whole document unparseable if the
      // generator does not escape.
      line1: 'Keizersgracht 123 & 125',
      city: 'Amsterdam',
      state: 'Noord-Holland',
      postalCode: '1015CJ',
      country,
    },
  });

  return address.id;
}

beforeEach(async () => {
  await resetAll();
  await ensureReferenceData();

  await prisma.businessProfile.create({
    data: {
      id: newId(),
      legalName: 'UBOSS Medical B.V.',
      displayName: 'UBOSS',
      supportEmail: 'verkoop@uboss.test',
      addressJson: {
        line1: 'Havenstraat 4',
        city: 'Rotterdam',
        postalCode: '3011AA',
        country: 'NL',
      },
      currency: 'EUR',
      timezone: 'Europe/Amsterdam',
      orderPrefix: 'UB',
      invoicePrefix: 'INV',
      vatNumber: 'NL123456789B01',
      vatCountry: 'NL',
    },
  });

  await prisma.country.updateMany({ where: { code: { in: ['NL', 'DE'] } }, data: { isEuVat: true } });
  await prisma.country.updateMany({ where: { code: 'CH' }, data: { isEuVat: false } });

  for (const [countryCode, category, ratePercent] of [
    ['NL', 'STANDARD', '21'],
    ['NL', 'REDUCED', '9'],
    ['DE', 'STANDARD', '19'],
    ['DE', 'REDUCED', '7'],
  ] as [string, 'STANDARD' | 'REDUCED', string][]) {
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
      email: 'admin@ubl.test',
      emailNormalized: 'admin@ubl.test',
      status: 'ACTIVE',
    },
  });
  adminActor = { userId: adminId, email: 'admin@ubl.test' };

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
      organization: 'Zorggroep Noord & Zuid',
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
      name: 'Standard',
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
      name: 'Reduced',
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
      name: 'Nitrile gloves <box of 100>',
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

  for (const [productId, minor] of [
    [standardProductId, 10_000n],
    [reducedProductId, 5_000n],
  ] as [string, bigint][]) {
    await prisma.productPrice.create({
      data: { id: newId(), productId, variantKey: '', currencyCode: 'EUR', basePriceMinor: minor },
    });
  }

  await receiveStock({ productId: standardProductId, quantity: 500 }, adminActor);
  await receiveStock({ productId: reducedProductId, quantity: 500 }, adminActor);
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

/** Place, confirm and invoice one order into `country`. Returns the invoice id. */
async function invoiceFor(country: string, options: { mixed?: boolean } = {}): Promise<string> {
  const address = await makeAddress(country);

  await addItem(customerProfileId, { productId: standardProductId, quantity: 2 });
  if (options.mixed === true) {
    await addItem(customerProfileId, { productId: reducedProductId, quantity: 1 });
  }

  const result = await submitCheckout({
    customerProfileId,
    shippingAddressId: address,
    paymentMode: 'ONLINE',
    actor: CUSTOMER_ACTOR(),
  });

  await prisma.order.update({ where: { id: result.orderId }, data: { status: 'CONFIRMED' } });

  const issued = await issueInvoice({ orderId: result.orderId });
  return issued.id;
}

describe('the document envelope', () => {
  it('declares itself as Peppol BIS Billing 3.0', async () => {
    const rendered = await renderInvoiceUbl(await invoiceFor('NL'));

    // A receiver's validator keys off both, and the wrong pair is rejected
    // before anybody looks at the amounts.
    expect(tag(rendered.xml, 'cbc:CustomizationID')).toBe(
      'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
    );
    expect(tag(rendered.xml, 'cbc:ProfileID')).toBe(
      'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
    );
  });

  it('is a commercial invoice, and a credit note is type 381', async () => {
    const invoiceId = await invoiceFor('NL');
    const invoice = await renderInvoiceUbl(invoiceId);

    expect(tag(invoice.xml, 'cbc:InvoiceTypeCode')).toBe('380');

    const { creditInvoice } = await import('../../src/modules/invoicing/invoice.service.js');
    const credit = await creditInvoice({
      invoiceId,
      actorUserId: adminActor.userId,
      actorEmail: adminActor.email,
    });

    const rendered = await renderInvoiceUbl(credit.id);
    expect(tag(rendered.xml, 'cbc:InvoiceTypeCode')).toBe('381');
  });

  it('escapes XML, so an ampersand in a name does not break the document', async () => {
    const rendered = await renderInvoiceUbl(await invoiceFor('NL'));

    // The buyer is "Zorggroep Noord & Zuid" and the product is
    // "Nitrile gloves <box of 100>". Either would make the whole file
    // unparseable at the receiver.
    expect(rendered.xml).toContain('Zorggroep Noord &amp; Zuid');
    expect(rendered.xml).toContain('Nitrile gloves &lt;box of 100&gt;');
    expect(rendered.xml).not.toContain('Noord & Zuid');
  });

  it('names both parties with a country code', async () => {
    const rendered = await renderInvoiceUbl(await invoiceFor('DE'));

    expect(tag(rendered.xml, 'cbc:RegistrationName')).toBe('UBOSS Medical B.V.');
    const countries = allTags(rendered.xml, 'cbc:IdentificationCode');
    expect(countries).toEqual(['NL', 'DE']);
  });
});

describe('VAT category codes', () => {
  it('uses S for a domestic standard-rated supply', async () => {
    const rendered = await renderInvoiceUbl(await invoiceFor('NL'));

    const categories = allTags(rendered.xml, 'cbc:ID').filter((value) => value.length === 1);
    expect(categories).toContain('S');
  });

  it('uses K, not AE, for an intra-Community supply', async () => {
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { vatNumber: 'DE811569869', vatNumberValid: true },
    });

    const rendered = await renderInvoiceUbl(await invoiceFor('DE'));

    // The classic mapping error. AE is a DOMESTIC reverse charge; K is an
    // intra-Community supply. Getting it wrong puts the transaction in the
    // wrong box on the receiver's VAT return.
    expect(rendered.xml).toContain('<cbc:ID>K</cbc:ID>');
    expect(rendered.xml).not.toContain('<cbc:ID>AE</cbc:ID>');
  });

  it('uses G for an export out of the Union', async () => {
    const rendered = await renderInvoiceUbl(await invoiceFor('CH'));
    expect(rendered.xml).toContain('<cbc:ID>G</cbc:ID>');
  });

  it('states an exemption reason wherever the rate is zero', async () => {
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { vatNumber: 'DE811569869', vatNumberValid: true },
    });

    const rendered = await renderInvoiceUbl(await invoiceFor('DE'));

    // BR-IC-10. An otherwise perfect document is rejected without it.
    const reason = tag(rendered.xml, 'cbc:TaxExemptionReason');
    expect(reason).not.toBeNull();
    expect(reason).toContain('Article 138');
  });

  it('emits one tax subtotal per rate on a mixed invoice', async () => {
    const rendered = await renderInvoiceUbl(await invoiceFor('DE', { mixed: true }));

    const taxable = allTags(rendered.xml, 'cbc:TaxableAmount');
    expect(taxable).toHaveLength(2);

    const percents = allTags(rendered.xml, 'cbc:Percent');
    // Two lines and two subtotals, so each rate appears twice.
    expect(percents.filter((value) => value === '19.00')).toHaveLength(2);
    expect(percents.filter((value) => value === '7.00')).toHaveLength(2);
  });
});

describe('amounts', () => {
  it('formats money by integer arithmetic, never through a float', async () => {
    const rendered = await renderInvoiceUbl(await invoiceFor('DE'));

    // €200 net at German 19% is €38.00 exactly. A float path here is how a
    // total becomes 37.999999999999996 in a document a tax authority reads.
    expect(tag(rendered.xml, 'cbc:TaxAmount')).toBe('38.00');
    expect(tag(rendered.xml, 'cbc:LineExtensionAmount')).toBe('200.00');
    expect(tag(rendered.xml, 'cbc:PayableAmount')).toBe('238.00');
  });

  it('reconciles the line sum with the document total', async () => {
    const rendered = await renderInvoiceUbl(await invoiceFor('DE', { mixed: true }));

    const lineTotal = Number(tag(rendered.xml, 'cbc:LineExtensionAmount'));
    const taxExclusive = Number(tag(rendered.xml, 'cbc:TaxExclusiveAmount'));
    const taxInclusive = Number(tag(rendered.xml, 'cbc:TaxInclusiveAmount'));
    const tax = Number(tag(rendered.xml, 'cbc:TaxAmount'));

    // BR-CO-13 and BR-CO-15: the two identities every validator checks.
    const allowance = Number(tag(rendered.xml, 'cbc:AllowanceTotalAmount'));
    const charge = Number(tag(rendered.xml, 'cbc:ChargeTotalAmount'));

    expect(taxExclusive).toBeCloseTo(lineTotal - allowance + charge, 2);
    expect(taxInclusive).toBeCloseTo(taxExclusive + tax, 2);
  });
});

describe('the pre-send check', () => {
  it('passes a complete invoice', async () => {
    const issues = await validateInvoiceForEn16931(await invoiceFor('NL'));
    expect(issues).toEqual([]);
  });

  it('catches a zero-rated intra-Community supply with no customer VAT number', async () => {
    // The order is zero-rated because the number was valid at checkout, and
    // the number is then removed from the snapshot - which is the shape a
    // mis-keyed record actually takes.
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { vatNumber: 'DE811569869', vatNumberValid: true },
    });

    const invoiceId = await invoiceFor('DE');
    await prisma.invoice.update({ where: { id: invoiceId }, data: { buyerVatNumber: null } });

    const issues = await validateInvoiceForEn16931(invoiceId);

    // BR-IC-11. Rejected by every EN 16931 validator, and the reason is not
    // obvious from the rejection code alone.
    expect(issues.map((issue) => issue.rule)).toContain('BR-IC-11');
  });

  it('catches VAT charged with no seller VAT number', async () => {
    const invoiceId = await invoiceFor('NL');
    await prisma.invoice.update({ where: { id: invoiceId }, data: { sellerVatNumber: null } });

    const issues = await validateInvoiceForEn16931(invoiceId);
    expect(issues.map((issue) => issue.rule)).toContain('BR-CO-9');
  });

  it('catches a zero total with no exemption reason', async () => {
    const invoiceId = await invoiceFor('CH');
    await prisma.invoice.update({ where: { id: invoiceId }, data: { exemptionNote: null } });

    const issues = await validateInvoiceForEn16931(invoiceId);
    expect(issues.map((issue) => issue.rule)).toContain('BR-E-10');
  });
});
