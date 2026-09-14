/**
 * A seller's own shop front, on their own subdomain.
 *
 * The whole feature is one question asked once per request — whose shop is
 * this? — and then honoured everywhere. These cases are the places where
 * getting it wrong is not a cosmetic bug:
 *
 *   - **The catalogue is theirs.** A product they do not offer is not in their
 *     shop, and the operator's other stock is not either.
 *   - **The price is theirs.** Every figure on their shop comes from their
 *     offer, never from the operator's price list, because that is the figure
 *     the shopper will be charged and the seller settled against.
 *   - **An unknown subdomain is refused**, not quietly served the operator's
 *     shop under somebody else's name.
 *   - **The operator's own domain is untouched.** Everything here has to leave
 *     a single-supplier deployment behaving exactly as it did.
 *
 * The host is set per request rather than globally, which is the point: one
 * running server answers for every shop, and what separates them is a header.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { newId } from '../../src/infra/ids.js';
import type * as AppModule from '../../src/http/app.js';
import type * as CryptoModule from '../../src/infra/crypto.js';
import type * as EnvModule from '../../src/config/env.js';
import type * as PrismaModule from '../../src/infra/prisma.js';
import type * as StorageModule from '../../src/infra/storage/index.js';

/*
 * Everything that touches the database or hashes a password is imported
 * DYNAMICALLY, after the env module is mocked and the registry reset.
 *
 * A static import would belong to the module graph that existed before
 * `vi.resetModules()`, and the app under test belongs to the one after. Two
 * graphs means two Prisma clients and two copies of the argon2 binding — and a
 * password hashed by one and verified by the other does not match, which shows
 * up as an unexplained 401 rather than as anything to do with modules.
 */
let prisma: (typeof PrismaModule)['prisma'];
let hashPassword: (typeof CryptoModule)['hashPassword'];
let storage: (typeof StorageModule)['storage'];

const DOMAIN = 'uboss.test';
const SELLER_HOST = `northwind.${DOMAIN}`;
const OPERATOR_HOST = DOMAIN;

let app: Awaited<ReturnType<(typeof AppModule)['buildApp']>>;

let sellerId = '';
let offeredProductId = '';
let unofferedProductId = '';
let cookieHeader = '';
let csrfToken = '';

const EMAIL = 'storefront-buyer@test.local';
const PASSWORD = 'Storefront!2026';

interface ListBody {
  products?: { id: string; name: string; price: { minor: string } | null }[];
  pagination?: { total: number };
}

/**
 * Only what this file made.
 *
 * Scoped by slug and SKU rather than emptying the tables. The suite shares one
 * database, so a `deleteMany({})` over products here is a file that passes on
 * its own and takes somebody else's fixtures down when the whole suite runs —
 * and the symptom lands in whichever file happens to go next.
 */
const OWN_SLUGS = ['offered-thing', 'operator-only'];

async function cleanUp(): Promise<void> {
  const own = await prisma.product.findMany({
    where: { slug: { in: OWN_SLUGS } },
    select: { id: true },
  });
  const productIds = own.map((product) => product.id);

  await prisma.cartItem.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.cart.deleteMany({ where: { customerProfile: { user: { emailNormalized: EMAIL } } } });
  await prisma.sellerOffer.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: 'northwind' } });
  await prisma.productPrice.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  await prisma.category.deleteMany({ where: { slug: 'storefront-test' } });
  await prisma.taxClass.deleteMany({ where: { code: 'SFT5' } });
  await prisma.inventoryLocation.deleteMany({ where: { code: 'SFT-MAIN' } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

async function makeProduct(name: string, slug: string, sku: string, categoryId: string, taxClassId: string): Promise<string> {
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId,
      taxClassId,
      name,
      slug,
      sku,
      basePriceMinor: 100_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });

  // The operator's own price, which a seller's shop must never show.
  await prisma.productPrice.create({
    data: {
      id: newId(),
      productId: product.id,
      variantKey: '',
      currencyCode: 'INR',
      basePriceMinor: 100_000n,
    },
  });

  return product.id;
}

beforeAll(async () => {
  // The domain has to be in place before the app and the host resolver are
  // imported, because both read it at module scope.
  vi.resetModules();
  vi.doMock('../../src/config/env.js', async (importOriginal) => {
    const actual = await importOriginal<typeof EnvModule>();
    return { ...actual, env: { ...actual.env, SELLER_STOREFRONT_DOMAIN: DOMAIN } };
  });

  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ hashPassword } = await import('../../src/infra/crypto.js'));
  ({ storage } = await import('../../src/infra/storage/index.js'));

  const { buildApp } = await import('../../src/http/app.js');
  app = await buildApp();
  await app.ready();

  await cleanUp();

  /*
   * The cart needs a default location to reserve against, even for untracked
   * stock. Created only where the shared test database has none: adding a
   * second default would leave two files each believing they own the one the
   * cart resolves.
   */
  const existingDefault = await prisma.inventoryLocation.findFirst({
    where: { isDefault: true, isActive: true },
    select: { id: true },
  });

  if (existingDefault === null) {
    await prisma.inventoryLocation.create({
      data: {
        id: newId(),
        code: 'SFT-MAIN',
        name: 'Storefront main',
        isDefault: true,
        isActive: true,
      },
    });
  }

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'SFT5',
      name: 'Storefront 5%',
      ratePercent: '5.000000',
      isDefault: false,
      isActive: true,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Storefront', slug: 'storefront-test', isActive: true },
  });

  offeredProductId = await makeProduct('Offered thing', 'offered-thing', 'OFF-1', category.id, taxClass.id);
  unofferedProductId = await makeProduct('Operator only', 'operator-only', 'OPS-1', category.id, taxClass.id);

  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: 'Northwind Fastenings Ltd',
      displayName: 'Northwind Fastenings',
      displayNameNormalized: 'northwind fastenings',
      slug: 'northwind',
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  sellerId = seller.id;

  // Deliberately cheaper than the operator's 1,000.00, so a response carrying
  // the operator's figure is obvious rather than plausible.
  await prisma.sellerOffer.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      productId: offeredProductId,
      variantKey: '',
      sellerSku: 'NW-OFF-1',
      status: 'ACTIVE',
      priceMinor: 90_000n,
      currency: 'INR',
      availableQuantity: 50,
    },
  });

  // A buyer, so the basket cases have a session to add with.
  const customerRole = await prisma.role.findFirstOrThrow({
    where: { key: Role.CUSTOMER },
    select: { id: true },
  });

  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: customerRole.id } },
    },
  });

  await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'Storefront Buyer', activatedAt: new Date() },
  });

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);

  const jar = signIn.cookies as { name: string; value: string }[];
  cookieHeader = jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  csrfToken = jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '';
  expect(csrfToken).not.toBe('');
});

afterAll(async () => {
  await cleanUp();
  await app.close();
  vi.doUnmock('../../src/config/env.js');
  vi.resetModules();
});

describe("a seller's shop front", () => {
  it('lists only what that seller offers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products?currency=INR&category=storefront-test',
      headers: { host: SELLER_HOST },
    });

    const body = JSON.parse(response.body) as ListBody;

    expect(response.statusCode).toBe(200);
    expect(body.pagination?.total).toBe(1);
    expect(body.products?.map((product) => product.id)).toEqual([offeredProductId]);
  });

  it("quotes the seller's price, not the operator's", async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products?currency=INR',
      headers: { host: SELLER_HOST },
    });

    const body = JSON.parse(response.body) as ListBody;

    // 900.00, the seller's. The operator lists the same product at 1,000.00.
    expect(body.products?.[0]?.price?.minor).toBe('90000');
  });

  it('404s a product the seller does not offer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products/operator-only?currency=INR',
      headers: { host: SELLER_HOST },
    });

    // Not 403 and not an empty shell. A shopper must not be able to tell "this
    // seller does not stock it" from "no such product" by the status code.
    expect(response.statusCode).toBe(404);
  });

  it("prices a product detail from the seller's offer", async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products/offered-thing?currency=INR',
      headers: { host: SELLER_HOST },
    });

    const body = JSON.parse(response.body) as { product?: { price?: { minor: string } } };

    expect(response.statusCode).toBe(200);
    expect(body.product?.price?.minor).toBe('90000');
  });

  it('names the seller in the storefront configuration', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { host: SELLER_HOST },
    });

    const body = JSON.parse(response.body) as {
      business?: { displayName?: string };
      seller?: { slug?: string; displayName?: string };
    };

    expect(body.business?.displayName).toBe('Northwind Fastenings');
    expect(body.seller?.slug).toBe('northwind');

    // Never cached in a shared cache: a proxy ignoring Host would serve one
    // seller's name on another seller's domain.
    expect(response.headers['cache-control']).toContain('private');
    expect(response.headers['vary']).toContain('host');
  });

  it('counts categories against the seller shelf, not the operator one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/categories',
      headers: { host: SELLER_HOST },
    });

    const body = JSON.parse(response.body) as {
      categories?: { slug: string; totalProductCount: number }[];
    };

    const category = body.categories?.find((entry) => entry.slug === 'storefront-test');

    // One, not two. A sidebar promising the operator's count beside a seller's
    // grid is a row of links to products that shop does not sell.
    expect(category?.totalProductCount).toBe(1);
  });

  it("shows the seller their own logo, and never the operator's", async () => {
    // A one-pixel PNG, written as bytes. What is under test is the plumbing
    // from the stored key to the shop header, not image decoding.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    const stored = await storage.put(png, 'image/png', 'png', 'public');
    await prisma.sellerAccount.update({
      where: { id: sellerId },
      data: { logoStorageKey: stored.storageKey },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { host: SELLER_HOST },
    });

    const body = JSON.parse(response.body) as {
      business?: { logo?: { url: string; altText: string } | null };
    };

    expect(body.business?.logo?.url).toContain(stored.storageKey);
    // Named for the seller, so a screen reader says whose shop this is.
    expect(body.business?.logo?.altText).toBe('Northwind Fastenings');

    await prisma.sellerAccount.update({
      where: { id: sellerId },
      data: { logoStorageKey: null },
    });
    await storage.delete(stored.storageKey);
  });

  it('sends no logo at all where the seller has none', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { host: SELLER_HOST },
    });

    const body = JSON.parse(response.body) as { business?: { logo?: unknown } };

    // Null, never the operator's mark. Showing the marketplace's logo above a
    // seller's name tells a buyer they are somewhere they are not.
    expect(body.business?.logo).toBeNull();
  });

  it('refuses a subdomain that is no seller, rather than serving the operator', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products?currency=INR',
      headers: { host: `nosuchseller.${DOMAIN}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses the shop of a seller who is not approved', async () => {
    await prisma.sellerAccount.update({
      where: { id: sellerId },
      data: { status: 'SUSPENDED' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products?currency=INR',
      headers: { host: SELLER_HOST },
    });

    // Suspending a seller has to stop their shop taking orders, not merely stop
    // them logging in.
    expect(response.statusCode).toBe(404);

    await prisma.sellerAccount.update({
      where: { id: sellerId },
      data: { status: 'APPROVED' },
    });
  });
});

describe('buying on a seller shop front', () => {
  it("attaches the seller's offer to the basket line, from the host alone", async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { host: SELLER_HOST, cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { productId: offeredProductId, quantity: 1 },
    });

    expect(response.statusCode, response.body).toBe(201);

    const line = await prisma.cartItem.findFirstOrThrow({
      where: { productId: offeredProductId },
      select: { sellerOfferId: true, sellerOfferKey: true },
    });

    // The request named no seller. The HOST did — which is the whole point:
    // nothing a shopper can set decides whose stock they are buying.
    expect(line.sellerOfferId).not.toBeNull();
    expect(line.sellerOfferKey).toBe(line.sellerOfferId);

    const offer = await prisma.sellerOffer.findUniqueOrThrow({
      where: { id: line.sellerOfferId ?? '' },
    });
    expect(offer.sellerAccountId).toBe(sellerId);
  });

  it('prices the basket from the seller, not from the operator', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: { host: SELLER_HOST, cookie: cookieHeader },
    });

    const body = JSON.parse(response.body) as {
      cart?: { lines?: { unitPrice: { minor: string }; sellerName: string | null }[] };
    };

    // 900.00 a piece, the seller's. The operator lists it at 1,000.00.
    expect(body.cart?.lines?.[0]?.unitPrice.minor).toBe('90000');
    expect(body.cart?.lines?.[0]?.sellerName).toBe('Northwind Fastenings');
  });

  it('refuses a product the seller does not sell', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { host: SELLER_HOST, cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { productId: unofferedProductId, quantity: 1 },
    });

    // Refused on the way in rather than added and then silently priced from
    // the operator's list.
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('does not sell this');
  });
});

describe("the operator's own shop front", () => {
  it('lists everything the operator publishes, at the operator price', async () => {
    // Filtered to this file's own category. The suite shares a database, so an
    // unfiltered total would be an assertion about whatever else happens to be
    // in it — which passes alone and fails in the suite.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products?currency=INR&category=storefront-test',
      headers: { host: OPERATOR_HOST },
    });

    const body = JSON.parse(response.body) as ListBody;

    // Both products, and neither at the seller's figure. A seller's shop must
    // take nothing away from the operator's.
    expect(body.pagination?.total).toBe(2);
    expect(new Set(body.products?.map((product) => product.id))).toEqual(
      new Set([offeredProductId, unofferedProductId]),
    );
    expect(body.products?.every((product) => product.price?.minor === '100000')).toBe(true);
  });

  it('serves a product the seller does not offer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products/operator-only?currency=INR',
      headers: { host: OPERATOR_HOST },
    });

    expect(response.statusCode).toBe(200);
  });

  it('names the operator, and stays cacheable', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { host: OPERATOR_HOST },
    });

    const body = JSON.parse(response.body) as { seller?: unknown };

    expect(body.seller).toBeUndefined();
    expect(response.headers['cache-control']).toContain('public');
  });
});
