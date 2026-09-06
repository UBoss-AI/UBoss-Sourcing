/**
 * Location-based catalogue pricing - integration, against a real MariaDB.
 *
 * The claim under test is that the shelf answers the same question the cart
 * answers. A storefront that quotes one figure and a basket that charges
 * another is worse than one that is simply expensive: the shopper finds out at
 * the moment they were about to pay, which is where trust is lost and carts
 * are abandoned.
 *
 * A Dutch seller with a euro price list is the case that makes it visible.
 * `product_prices` holds one figure - EUR 121 - and three shoppers pay three
 * different amounts for it, because Germany, the Netherlands and a buyer in
 * Switzerland are one currency and three tax positions. The currency chooses
 * the price list; the country decides what that figure becomes.
 *
 * The last test is the one that guards everybody else's deployment: an Indian
 * GST store has no `vatCountry`, so none of this may fire, and `?country=`
 * must be inert rather than merely harmless.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import { newId } from '../../src/infra/ids.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let categoryId: string;
let standardClassId: string;

interface Quote {
  price: { minor: string } | null;
  compareAtPrice: { minor: string } | null;
  tax: { ratePercent: string; inclusive: boolean; country: string | null; treatment: string };
}

interface ListResponse {
  products: (Quote & { sku: string })[];
  country: string | null;
}

interface DetailResponse {
  product: Quote & { variants: { sku: string; price: { minor: string } | null }[] };
  country: string | null;
  taxNote: string;
}

interface FacetResponse {
  priceRange: { min: { minor: string } | null; max: { minor: string } | null };
}

async function detail(slug: string, country?: string): Promise<DetailResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/catalog/products/${slug}?currency=EUR${country === undefined ? '' : `&country=${country}`}`,
  });

  expect(response.statusCode).toBe(200);
  return response.json<DetailResponse>();
}

async function listOne(sku: string, country?: string): Promise<Quote & { sku: string }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/catalog/products?limit=60&currency=EUR${country === undefined ? '' : `&country=${country}`}`,
  });

  expect(response.statusCode).toBe(200);
  const match = response.json<ListResponse>().products.find((row) => row.sku === sku);

  if (match === undefined) throw new Error(`${sku} was not in the listing`);
  return match;
}

async function resetAll(): Promise<void> {
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.productPrice.deleteMany({});
  await prisma.productVariant.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.businessProfile.deleteMany({});
  await prisma.vatRate.deleteMany({});
}

/**
 * Currencies and countries are shared reference data, so they are upserted and
 * never deleted - a `deleteMany` here would break whichever file runs next.
 */
async function ensureReferenceData(): Promise<void> {
  await prisma.currency.upsert({
    where: { code: 'EUR' },
    update: {},
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

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(async () => {
  await resetAll();
  await ensureReferenceData();

  // A Dutch seller. `vatCountry` is the switch: without it every assertion
  // below would come back FLAT_RATE, which is what the last test proves.
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

  // Inclusive, which is how a consumer-facing EU catalogue is authored: the
  // figure on the shelf is what gets paid. The flat rate is deliberately a
  // number no member state charges - if any assertion sees 18%, EU resolution
  // did not run.
  const standardClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'VAT-STD',
      name: 'Standard rate',
      ratePercent: '18.000000',
      vatCategory: 'STANDARD',
      isInclusive: true,
      isDefault: true,
      isActive: true,
    },
  });
  standardClassId = standardClass.id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Consumables', slug: 'consumables', isActive: true },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await resetAll();
  await app.close();
  await prisma.$disconnect();
});

/**
 * One product at one listed price.
 *
 * EUR 121 is chosen because it is EUR 100 plus the seller's own 21%, so every
 * expected figure below is a round number and a wrong one is obvious.
 */
async function makeProduct(options: {
  sku: string;
  slug: string;
  listedMinor: bigint;
  compareAtMinor?: bigint;
  taxClassId?: string;
}): Promise<string> {
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId,
      taxClassId: options.taxClassId ?? standardClassId,
      name: `Product ${options.sku}`,
      slug: options.slug,
      sku: options.sku,
      basePriceMinor: options.listedMinor,
      compareAtPriceMinor: options.compareAtMinor ?? null,
      currency: 'EUR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
    },
  });

  await prisma.productPrice.create({
    data: {
      id: newId(),
      productId: product.id,
      variantKey: '',
      currencyCode: 'EUR',
      basePriceMinor: options.listedMinor,
      compareAtPriceMinor: options.compareAtMinor ?? null,
    },
  });

  return product.id;
}

describe('a listed price against three destinations', () => {
  beforeEach(async () => {
    await makeProduct({ sku: 'GLV-100', slug: 'nitrile-gloves', listedMinor: 12_100n });
  });

  it('quotes the seller’s own rate at home', async () => {
    const { product, country } = await detail('nitrile-gloves', 'NL');

    expect(country).toBe('NL');
    // Unchanged: EUR 121 already is EUR 100 plus 21% Dutch VAT.
    expect(product.price?.minor).toBe('12100');
    expect(product.tax).toMatchObject({ ratePercent: '21', inclusive: true, country: 'NL' });
  });

  it('quotes the destination state’s rate to a German consumer', async () => {
    const { product } = await detail('nitrile-gloves', 'DE');

    // The Dutch 21% comes out and German 19% goes on: EUR 100 net, EUR 119.
    // Charging EUR 121 and calling 19% of it tax would hand the seller money
    // that is not theirs, which is the mistake this whole path exists to stop.
    expect(product.price?.minor).toBe('11900');
    expect(product.tax).toMatchObject({
      ratePercent: '19',
      inclusive: true,
      country: 'DE',
      treatment: 'INTRA_EU_B2C',
    });
  });

  it('drops the VAT entirely on an export', async () => {
    const { product, taxNote } = await detail('nitrile-gloves', 'CH');

    // Zero-rated under Art. 146, so the shopper sees the net figure.
    expect(product.price?.minor).toBe('10000');
    expect(product.tax).toMatchObject({ ratePercent: '0', country: null, treatment: 'EXPORT' });
    expect(taxNote).toContain('zero-rated');
  });

  it('falls back to the seller’s own country when none is stated', async () => {
    const { product, country } = await detail('nitrile-gloves');

    expect(country).toBeNull();
    // The same answer a shopper gets before entering a delivery address.
    expect(product.price?.minor).toBe('12100');
    expect(product.tax.ratePercent).toBe('21');
  });

  it('ignores a country code it cannot read rather than failing the page', async () => {
    const { product, country } = await detail('nitrile-gloves', 'ZZZ');

    // A bad country quotes the default market. A bad *currency* still 400s:
    // that one silently serves another market's numbers.
    expect(country).toBeNull();
    expect(product.price?.minor).toBe('12100');
  });

  it('quotes the listing the same way it quotes the detail page', async () => {
    const listed = await listOne('GLV-100', 'DE');
    const { product } = await detail('nitrile-gloves', 'DE');

    // The grid and the product page are two code paths onto one engine. A
    // shopper who clicks a card must not watch the price change.
    expect(listed.price?.minor).toBe(product.price?.minor);
    expect(listed.tax.ratePercent).toBe(product.tax.ratePercent);
  });
});

describe('everything else priced on the page', () => {
  it('moves the compare-at price with the selling price', async () => {
    await makeProduct({
      sku: 'GLV-200',
      slug: 'gloves-on-offer',
      listedMinor: 12_100n,
      compareAtMinor: 18_150n,
    });

    const { product } = await detail('gloves-on-offer', 'DE');

    // EUR 150 net at 19%. Left at EUR 181.50 beside a EUR 119 price it would
    // advertise a bigger saving in Germany than the business ever offered.
    expect(product.price?.minor).toBe('11900');
    expect(product.compareAtPrice?.minor).toBe('17850');
  });

  it('moves variant prices with it', async () => {
    const productId = await makeProduct({
      sku: 'GLV-300',
      slug: 'gloves-by-size',
      listedMinor: 12_100n,
    });

    const variantId = newId();
    await prisma.productVariant.create({
      data: {
        id: variantId,
        productId,
        sku: 'GLV-300-L',
        name: 'Large',
        optionsJson: { Size: 'Large' },
        priceMinor: 24_200n,
        isActive: true,
      },
    });
    await prisma.productPrice.create({
      data: {
        id: newId(),
        productId,
        variantId,
        variantKey: variantId,
        currencyCode: 'EUR',
        basePriceMinor: 24_200n,
      },
    });

    const { product } = await detail('gloves-by-size', 'DE');

    // EUR 200 net at 19%. A variant left at its listed figure would jump the
    // moment the shopper picked it, after the page had already quoted them a
    // German price for the product.
    expect(product.variants.find((row) => row.sku === 'GLV-300-L')?.price?.minor).toBe('23800');
  });

  it('translates the price filter into the shopper’s own terms', async () => {
    // EUR 121 lists at EUR 119 in Germany; EUR 126.61 lists at EUR 124.45.
    await makeProduct({ sku: 'CHEAP', slug: 'cheap', listedMinor: 12_100n });
    await makeProduct({ sku: 'DEARER', slug: 'dearer', listedMinor: 12_661n });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products?limit=60&currency=EUR&country=DE&maxPrice=12000',
    });

    expect(response.statusCode).toBe(200);
    const skus = response.json<ListResponse>().products.map((row) => row.sku);

    // A ceiling typed against German prices has to be met by German prices.
    // Compared against the listed column instead, EUR 121 would fail a EUR 120
    // ceiling and the grid would hide an item it displays at EUR 119.
    expect(skus).toContain('CHEAP');
    expect(skus).not.toContain('DEARER');
  });

  it('reports the facet price range in those same terms', async () => {
    await makeProduct({ sku: 'ONLY', slug: 'only', listedMinor: 12_100n });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/filters?currency=EUR&country=DE',
    });

    expect(response.statusCode).toBe(200);
    const range = response.json<FacetResponse>().priceRange;

    // The range labels the boxes the filter above is typed into, so the two
    // have to be quoted the same way or the slider bounds the wrong numbers.
    expect(range.min?.minor).toBe('11900');
    expect(range.max?.minor).toBe('11900');
  });
});

describe('a deployment with no EU VAT configured', () => {
  beforeEach(async () => {
    // An Indian GST store: no vatCountry, an exclusive 18% class.
    await prisma.businessProfile.deleteMany({});
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

    await prisma.taxClass.update({
      where: { id: standardClassId },
      data: { code: 'GST18', name: 'GST 18%', isInclusive: false, vatCategory: null },
    });

    await makeProduct({ sku: 'GST-1', slug: 'gst-item', listedMinor: 10_000n });
  });

  it('leaves every price exactly as it is listed, country or no country', async () => {
    const stated = await detail('gst-item', 'DE');
    const unstated = await detail('gst-item');

    // The whole point of the FLAT_RATE path: one codebase serves a Dutch shop
    // and an Indian one, and the Indian one must not acquire German VAT
    // because somebody appended a query parameter.
    for (const { product } of [stated, unstated]) {
      expect(product.price?.minor).toBe('10000');
      expect(product.tax).toMatchObject({
        ratePercent: '18',
        inclusive: false,
        country: null,
        treatment: 'FLAT_RATE',
      });
    }
  });
});
