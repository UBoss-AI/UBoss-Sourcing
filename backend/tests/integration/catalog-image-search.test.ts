/**
 * Image search - integration, against a real MariaDB.
 *
 * `POST /catalog/image-search` is the one authenticated route under
 * `/catalog`, and the reason is the thing most worth holding down here: every
 * other read in that file costs a database query, while this one spends the
 * operator's AI provider budget on every call. Left open, any script on the
 * internet could bill a self-hosted deployment for as many vision calls as it
 * cared to make.
 *
 * The provider itself is mocked. A test that reached it would be slow, flaky
 * offline and billed; what is under test is everything around it — the guard,
 * the upload validation, and the part that turns whatever the model said into
 * products a storefront can render:
 *
 *   - a slug the catalogue does not have is dropped rather than becoming a
 *     card that 404s,
 *   - an unpublished product cannot be matched into an answer,
 *   - a product with no price in the requested currency is not sold in it and
 *     is left out, exactly as it would be from the grid,
 *   - and what comes back is in the model's ranking, best first, because the
 *     ranking is the whole value of having asked for one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { Role } from '../../src/domain/permissions.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';
import type * as AssistantService from '../../src/modules/assistant/assistant.service.js';
import type * as ImageSearchService from '../../src/modules/assistant/image-search.service.js';

/*
 * Both halves of the assistant module are mocked, and both are needed.
 *
 * `isAssistantConfigured` because the test environment has no provider key, so
 * the route would otherwise 404 before doing anything worth testing — which is
 * itself asserted in one case below, by turning the mock off.
 */
const analyseProductImage = vi.hoisted(() => vi.fn());
const isAssistantConfigured = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../src/modules/assistant/image-search.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageSearchService>()),
  analyseProductImage,
}));

vi.mock('../../src/modules/assistant/assistant.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof AssistantService>()),
  isAssistantConfigured,
}));

const PASSWORD = 'ImageSearchPass!2026';

let app: Awaited<ReturnType<typeof buildApp>>;
let currency: string;
/** Anything but the base currency, for the "not sold here" case. */
let otherCurrency: string;
let categoryId: string;
let taxClassId: string;
let buyer: { cookies: string; csrfToken: string };

/** A one-pixel PNG. Real magic bytes, because the route sniffs them. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** A text file pretending to be a photograph. Refused on its bytes, not its name. */
const NOT_AN_IMAGE = Buffer.from('This is plainly not a PNG.', 'utf8');

function multipart(file: Buffer, filename: string): { body: Buffer; headers: Record<string, string> } {
  const boundary = '----ubosstestboundary';

  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
      'Content-Type: image/png\r\n\r\n',
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return {
    body: Buffer.concat([head, file, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(
  session: { cookies: string; csrfToken: string } | null,
  file: Buffer = PNG,
  filename = 'shelf.png',
): Promise<LightMyRequestResponse> {
  const { body, headers } = multipart(file, filename);

  return app.inject({
    method: 'POST',
    url: `/api/v1/catalog/image-search?currency=${currency}`,
    headers: {
      ...headers,
      ...(session === null
        ? {}
        : { cookie: session.cookies, 'x-csrf-token': session.csrfToken }),
    },
    payload: body,
  });
}

interface SearchResponse {
  description: string;
  terms: string[];
  products: { slug: string }[];
}

/**
 * A product in this file's own category. Published and sold in the base
 * currency unless told otherwise.
 *
 * `otherCurrencyOnly` gives the product a price list this request is not asking
 * for. That is the real shape of "not sold in this currency" - omitting the
 * `product_prices` row alone would not do it, because `loadPricesForCurrency`
 * deliberately falls back to the pre-multi-currency column when the product's
 * own currency matches the one being asked for.
 */
async function makeProduct(options: {
  slug: string;
  published?: boolean;
  otherCurrencyOnly?: boolean;
}): Promise<void> {
  const id = newId();
  const productCurrency = options.otherCurrencyOnly === true ? otherCurrency : currency;

  await prisma.product.create({
    data: {
      id,
      categoryId,
      name: `Product ${options.slug}`,
      slug: options.slug,
      sku: options.slug.toUpperCase(),
      status: 'ACTIVE',
      isPublished: options.published ?? true,
      publishedAt: new Date(),
      taxClassId,
      basePriceMinor: 12_500n,
      currency: productCurrency,
    },
  });

  await prisma.productPrice.create({
    data: {
      id: newId(),
      productId: id,
      variantKey: '',
      currencyCode: productCurrency,
      basePriceMinor: 12_500n,
    },
  });
}

async function removeOwnProducts(): Promise<void> {
  const own = await prisma.product.findMany({ where: { categoryId }, select: { id: true } });
  const ids = own.map((product) => product.id);
  if (ids.length === 0) return;

  await prisma.cartItem.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productPrice.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  currency = await getBaseCurrency();
  otherCurrency = currency === 'JPY' ? 'INR' : 'JPY';

  taxClassId = newId();
  await prisma.taxClass.create({
    data: { id: taxClassId, code: 'IMGS', name: 'Image search test', ratePercent: '18' },
  });

  categoryId = newId();
  await prisma.category.create({
    data: {
      id: categoryId,
      name: 'Image search test',
      slug: 'image-search-test',
      path: 'image-search-test',
      depth: 0,
      isActive: true,
    },
  });

  const role = await prisma.role.upsert({
    where: { key: Role.CUSTOMER },
    update: {},
    create: {
      id: newId(),
      key: Role.CUSTOMER,
      name: 'Customer',
      description: 'Storefront customer',
      isSystem: true,
    },
  });

  const email = 'image-search-buyer@hospital.test';
  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });

  await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'Image Search Buyer', activatedAt: new Date() },
  });

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);

  const jar = signIn.cookies as { name: string; value: string }[];
  buyer = {
    cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrfToken: jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '',
  };
});

afterAll(async () => {
  await removeOwnProducts();
  await prisma.customerProfile.deleteMany({ where: { fullName: 'Image Search Buyer' } });
  await prisma.user.deleteMany({ where: { emailNormalized: 'image-search-buyer@hospital.test' } });
  await prisma.category.deleteMany({ where: { id: categoryId } });
  await prisma.taxClass.deleteMany({ where: { id: taxClassId } });
  await app.close();
});

beforeEach(async () => {
  await removeOwnProducts();
  analyseProductImage.mockReset();
  isAssistantConfigured.mockReturnValue(true);
});

describe('who may search by photograph', () => {
  it('refuses a guest, and never reaches the provider', async () => {
    const response = await upload(null);

    expect(response.statusCode).toBe(401);
    // The guard runs before the handler, so nothing was uploaded, nothing was
    // sniffed, and nothing was billed.
    expect(analyseProductImage).not.toHaveBeenCalled();
  });

  it('answers 404 on a deployment with no AI provider configured', async () => {
    isAssistantConfigured.mockReturnValue(false);

    const response = await upload(buyer);

    // 404 rather than 403: the endpoint does not meaningfully exist here, and
    // that is how the storefront learns not to render the camera button.
    expect(response.statusCode).toBe(404);
    expect(analyseProductImage).not.toHaveBeenCalled();
  });
});

describe('what the upload has to be', () => {
  it('refuses a file that is not an image, whatever it was called', async () => {
    const response = await upload(buyer, NOT_AN_IMAGE, 'photo.png');

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'MEDIA_TYPE_NOT_ALLOWED',
    );
    // Refused on its magic bytes, before a byte reached the provider - the
    // client's filename and Content-Type both claimed PNG.
    expect(analyseProductImage).not.toHaveBeenCalled();
  });

  it('refuses a request with no file at all', async () => {
    const boundary = '----ubosstestboundary';
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/image-search',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        cookie: buyer.cookies,
        'x-csrf-token': buyer.csrfToken,
      },
      payload: Buffer.from(`--${boundary}--\r\n`, 'utf8'),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('turning what the model said into products', () => {
  it('returns the matches in the ranking it was given', async () => {
    await makeProduct({ slug: 'suction-catheter-10fr' });
    await makeProduct({ slug: 'suction-catheter-12fr' });
    await makeProduct({ slug: 'nebuliser-mask-adult' });

    analyseProductImage.mockResolvedValue({
      description: 'A clear suction catheter in a sealed sleeve.',
      terms: ['suction catheter'],
      slugs: ['suction-catheter-12fr', 'suction-catheter-10fr'],
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 5,
    });

    const response = await upload(buyer);
    expect(response.statusCode, response.body).toBe(200);

    const body = response.json<SearchResponse>();

    // Best first, in the model's order rather than whatever the index gave the
    // query. The ranking is the point of having asked for one.
    expect(body.products.map((product) => product.slug)).toEqual([
      'suction-catheter-12fr',
      'suction-catheter-10fr',
    ]);
    expect(body.description).toBe('A clear suction catheter in a sealed sleeve.');
    expect(body.terms).toEqual(['suction catheter']);
  });

  it('drops a slug the catalogue does not have rather than 404ing a card', async () => {
    await makeProduct({ slug: 'suction-catheter-10fr' });

    analyseProductImage.mockResolvedValue({
      description: 'A suction catheter.',
      terms: ['suction catheter'],
      // The second is a product this store does not publish. It must not
      // become a card whose link is a dead end.
      slugs: ['suction-catheter-10fr', 'blue-syringe-box'],
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 5,
    });

    const body = (await upload(buyer)).json<SearchResponse>();

    expect(body.products.map((product) => product.slug)).toEqual(['suction-catheter-10fr']);
  });

  it('cannot surface an unpublished product, or one not sold in this currency', async () => {
    await makeProduct({ slug: 'draft-catheter', published: false });
    await makeProduct({ slug: 'unpriced-catheter', otherCurrencyOnly: true });
    await makeProduct({ slug: 'listed-catheter' });

    analyseProductImage.mockResolvedValue({
      description: 'A catheter.',
      terms: ['catheter'],
      slugs: ['draft-catheter', 'unpriced-catheter', 'listed-catheter'],
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 5,
    });

    const body = (await upload(buyer)).json<SearchResponse>();

    // The draft is invisible for the same reason it is invisible everywhere
    // else; the unpriced one is simply not sold in this currency, and a card
    // with no price is worse than one card fewer.
    expect(body.products.map((product) => product.slug)).toEqual(['listed-catheter']);
  });

  it('says it found nothing rather than pretending the catalogue is empty', async () => {
    await makeProduct({ slug: 'listed-catheter' });

    analyseProductImage.mockResolvedValue({
      description: 'A photograph of a car park.',
      terms: [],
      slugs: [],
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 5,
    });

    const response = await upload(buyer);
    expect(response.statusCode).toBe(200);

    const body = response.json<SearchResponse>();
    expect(body.products).toEqual([]);
    // The description still comes back, so the shopper can see that the
    // picture was read as something other than a product.
    expect(body.description).toBe('A photograph of a car park.');
  });
});

describe('when the provider cannot answer', () => {
  it('reports a busy provider as its own code, not as a site outage', async () => {
    const { AssistantBusyError } = await import('../../src/modules/assistant/provider.js');
    analyseProductImage.mockRejectedValue(new AssistantBusyError('quota exhausted', true));

    const response = await upload(buyer);

    expect(response.statusCode).toBe(503);

    // Deliberately not SERVICE_UNAVAILABLE, which the storefront reads as "the
    // whole store is down" and puts a site-wide maintenance banner behind. One
    // camera button failing is not an outage.
    const { error } = response.json<{ error: { code: string; message: string } }>();
    expect(error.code).toBe('IMAGE_SEARCH_BUSY');
    // The provider's own wording names quota metrics and is logged, never sent.
    expect(error.message).not.toContain('quota exhausted');
  });

  it('reports an unreadable reply as something the shopper can act on', async () => {
    const { ImageSearchUnreadableError } = await import(
      '../../src/modules/assistant/image-search.service.js'
    );
    analyseProductImage.mockRejectedValue(new ImageSearchUnreadableError());

    const response = await upload(buyer);

    expect(response.statusCode).toBe(502);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'IMAGE_SEARCH_UNREADABLE',
    );
  });
});
