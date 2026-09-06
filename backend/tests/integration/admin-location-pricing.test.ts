/**
 * Location-aware pricing in the admin console - integration, over HTTP.
 *
 * The console has to answer the question the storefront already answers, and
 * answer it identically: given a customer standing in Germany, what does this
 * product cost them? Staff who cannot see that number are pricing a market
 * blind. `catalogue-location-pricing.test.ts` proves the shop and the cart
 * agree; this file proves the panel reads the same engine rather than holding a
 * second opinion of its own.
 *
 * The other claim under test is what the panel must NOT do. The `price` on a
 * row is the listed figure - what somebody typed, and what the editor writes
 * back. A screen that quietly showed EUR 119 where EUR 121 was entered would
 * invite staff to "correct" their own price list back to a number the engine
 * had already adjusted, and every such correction is a real price change in
 * every other market.
 *
 * The last block is everybody else's deployment: an Indian GST store has no
 * `vatCountry`, so `?country=` must be inert rather than merely harmless.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signInAdmin } from '../support/admin-session.js';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let cookies: string;
let taxClassId: string;
let productId: string;

const EMAIL = 'market-preview@test.local';
const PASSWORD = 'MarketPreview!2026';

/** Its own source address: the login route is rate limited per IP. */
const IP = '203.0.113.51';

const SKU = 'GLV-ADMIN-100';

interface Money {
  minor: string;
  currency: string;
}

interface ListRow {
  sku: string;
  price: Money;
  quoted: Money;
  quotedTax: { ratePercent: string; inclusive: boolean };
}

interface ListResponse {
  products: ListRow[];
  country: string | null;
  taxNote: string;
}

interface PricesResponse {
  country: string | null;
  taxNote: string;
  prices: {
    currency: { code: string };
    basePriceMinor: string | null;
    quoted: Money | null;
    quotedTax: { ratePercent: string; inclusive: boolean } | null;
  }[];
}

async function list(country?: string): Promise<ListResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/products?limit=60${country === undefined ? '' : `&country=${country}`}`,
    headers: { cookie: cookies },
  });

  expect(response.statusCode, response.body).toBe(200);
  return response.json<ListResponse>();
}

async function row(country?: string): Promise<ListRow> {
  const match = (await list(country)).products.find((entry) => entry.sku === SKU);

  if (match === undefined) throw new Error(`${SKU} was not in the admin listing`);
  return match;
}

async function prices(country: string): Promise<PricesResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/products/${productId}/prices?country=${country}`,
    headers: { cookie: cookies },
  });

  expect(response.statusCode, response.body).toBe(200);
  return response.json<PricesResponse>();
}

/**
 * Currencies and countries are reference data shared with every other file in
 * this suite, so they are upserted and never deleted.
 */
async function ensureReferenceData(): Promise<void> {
  await prisma.currency.upsert({
    where: { code: 'EUR' },
    update: { isActive: true },
    create: { code: 'EUR', name: 'Euro', symbol: '€', exponent: 2, sortOrder: 30 },
  });

  const countries: [string, string, boolean][] = [
    ['NL', 'Netherlands', true],
    ['DE', 'Germany', true],
    ['CH', 'Switzerland', false],
  ];

  for (const [code, name, isEuVat] of countries) {
    await prisma.country.upsert({
      where: { code },
      update: { isEuVat, isActive: true },
      create: { code, name, currencyCode: 'EUR', isActive: true, isEuVat },
    });
  }
}

async function resetCatalogue(): Promise<void> {
  await prisma.productPrice.deleteMany({});
  await prisma.productVariant.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.businessProfile.deleteMany({});
  await prisma.vatRate.deleteMany({});
}

/** A Dutch seller. `vatCountry` is the switch every assertion below rests on. */
async function makeDutchSeller(): Promise<void> {
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
}

/**
 * One product at one listed price, priced in EUR.
 *
 * EUR 121 is EUR 100 plus the seller's own 21%, so every expected figure below
 * is a round number and a wrong one is obvious. The tax class's own flat rate
 * is 18% - a number no member state charges - so an 18 appearing anywhere in a
 * EU-configured assertion means the EU path never ran.
 */
async function makeCatalogue(options: {
  inclusive: boolean;
  vatCategory: 'STANDARD' | null;
}): Promise<void> {
  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'ADMIN-STD',
      name: 'Standard rate',
      ratePercent: '18.000000',
      vatCategory: options.vatCategory,
      isInclusive: options.inclusive,
      isDefault: true,
      isActive: true,
    },
  });
  taxClassId = taxClass.id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Consumables', slug: 'consumables-admin', isActive: true },
  });

  productId = newId();

  await prisma.product.create({
    data: {
      id: productId,
      categoryId: category.id,
      taxClassId,
      name: 'Nitrile gloves',
      slug: `nitrile-gloves-admin-${productId.toLowerCase()}`,
      sku: SKU,
      basePriceMinor: 12_100n,
      currency: 'EUR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
    },
  });

  await prisma.productPrice.create({
    data: {
      id: newId(),
      productId,
      variantKey: '',
      currencyCode: 'EUR',
      basePriceMinor: 12_100n,
    },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  // A catalogue manager: `product.read` is all these routes ask for, and a
  // test that signed in as an owner would not notice if that changed.
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });

  const catalogRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.CATALOG_MANAGER },
    select: { id: true },
  });

  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: catalogRole.id } },
    },
  });

  ({ cookies } = await signInAdmin(app, { email: EMAIL, password: PASSWORD, ip: IP }));
});

afterAll(async () => {
  await resetCatalogue();
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
  await app.close();
  await prisma.$disconnect();
});

describe('the product list, quoted for a market', () => {
  beforeEach(async () => {
    await resetCatalogue();
    await ensureReferenceData();
    await makeDutchSeller();
    await makeCatalogue({ inclusive: true, vatCategory: 'STANDARD' });
  });

  it('shows what a German customer pays beside what the price list says', async () => {
    const listed = await row('DE');

    // The listed figure is untouched. This is the assertion that keeps the
    // editor honest: staff type into this number, and a screen showing them
    // EUR 119 here would invite them to "fix" it.
    expect(listed.price.minor).toBe('12100');

    // The Dutch 21% comes out and German 19% goes on: EUR 100 net, EUR 119.
    expect(listed.quoted.minor).toBe('11900');
    expect(listed.quotedTax).toMatchObject({ ratePercent: '19', inclusive: true });
  });

  it('names the market the figure was produced for', async () => {
    const { country, taxNote } = await list('DE');

    expect(country).toBe('DE');
    // The panel prints this beside the column, so it has to be the sentence
    // the engine wrote rather than one a frontend guessed at.
    expect(taxNote).toContain('DE');
  });

  it('quotes the seller’s own rate when no market is asked for', async () => {
    const { country } = await list();
    const listed = await row();

    expect(country).toBeNull();
    // The same answer a shopper gets before entering a delivery address:
    // EUR 121 already is EUR 100 plus 21% Dutch VAT.
    expect(listed.quoted.minor).toBe('12100');
    expect(listed.quotedTax.ratePercent).toBe('21');
  });

  it('ignores a country code it cannot read rather than failing the screen', async () => {
    const { country } = await list('ZZZ');
    const listed = await row('ZZZ');

    expect(country).toBeNull();
    expect(listed.quoted.minor).toBe('12100');
  });

  it('drops the VAT for a customer outside the EU', async () => {
    const listed = await row('CH');

    // Zero-rated as an export, so the figure staff read is the net one.
    expect(listed.quoted.minor).toBe('10000');
    expect(listed.quotedTax.ratePercent).toBe('0');
  });

  it('agrees with the per-currency panel on the same product', async () => {
    const listed = await row('DE');
    const panel = await prices('DE');
    const euro = panel.prices.find((entry) => entry.currency.code === 'EUR');

    // Two routes onto one engine. The list and the product screen sit a click
    // apart, and a figure that changed on the way between them would leave
    // staff no way to tell which of the two the shop is using.
    expect(euro?.basePriceMinor).toBe(listed.price.minor);
    expect(euro?.quoted?.minor).toBe(listed.quoted.minor);
    expect(euro?.quotedTax?.ratePercent).toBe(listed.quotedTax.ratePercent);
    expect(panel.country).toBe('DE');
  });

  it('leaves a catalogue authored net of tax at its listed figure', async () => {
    // An exclusive class: the listed figure is already net, so there is no
    // tax to put back in. What changes is the rate quoted beside it, which is
    // the destination's - printing the class's own 18% next to a German sale
    // would be telling staff a fiction.
    await prisma.taxClass.update({ where: { id: taxClassId }, data: { isInclusive: false } });

    const listed = await row('DE');

    expect(listed.quoted.minor).toBe('12100');
    expect(listed.quotedTax).toMatchObject({ ratePercent: '19', inclusive: false });
  });
});

describe('a deployment with no EU VAT configured', () => {
  beforeEach(async () => {
    await resetCatalogue();
    await ensureReferenceData();

    // An Indian GST store: no vatCountry, an exclusive 18% class.
    await prisma.businessProfile.create({
      data: {
        id: newId(),
        legalName: 'SPM Medicare',
        displayName: 'SPM',
        supportEmail: 'care@spm.test',
        addressJson: { line1: '12 MG Road', city: 'Pune', postalCode: '411001', country: 'IN' },
        currency: 'EUR',
        timezone: 'Asia/Kolkata',
        orderPrefix: 'SP',
        invoicePrefix: 'INV',
      },
    });

    await makeCatalogue({ inclusive: false, vatCategory: null });
  });

  it('quotes every row at its listed figure, country or no country', async () => {
    for (const country of ['DE', undefined]) {
      const listed = await row(country);

      // One codebase serves a Dutch shop and an Indian one, and the Indian one
      // must not acquire German VAT because a console appended a query
      // parameter.
      expect(listed.price.minor).toBe('12100');
      expect(listed.quoted.minor).toBe('12100');
      expect(listed.quotedTax).toMatchObject({ ratePercent: '18', inclusive: false });
    }
  });

  it('tells the console there is no location worth asking about', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });

    expect(response.statusCode).toBe(200);
    // What keeps the market picker out of the panel's header here. A control
    // that can change no number on any screen is worse than no control.
    expect(
      response.json<{ localisation: { locationPricing: boolean } }>().localisation,
    ).toMatchObject({ locationPricing: false });
  });
});
