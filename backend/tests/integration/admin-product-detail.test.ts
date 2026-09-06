/**
 * The admin product detail response - integration, over HTTP.
 *
 * The regression this file exists for: `GET /admin/products/:id` returned its
 * images in the shape Prisma joins them, `{ isPrimary, media: { id, url } }`,
 * while the editor reads `{ mediaId, url }`. Both are valid objects and both
 * typecheck on their own side, so nothing failed loudly. What actually happened
 * was an `<img src="">` on every product and a Remove button that would have
 * called `DELETE .../media/undefined`.
 *
 * A shape mismatch between a route and the screen that reads it cannot be
 * caught by either side's type checker, which is why it is asserted here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signInAdmin } from '../support/admin-session.js';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let cookies: string;
let productId: string;
let mediaId: string;

const EMAIL = 'detail-shape@test.local';
const PASSWORD = 'DetailShape!2026';

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  // --- a catalogue manager who can read products -----------------------------
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

  // --- a product with one image ---------------------------------------------
  //
  // Its own tax class and category, rather than whichever rows happen to be in
  // the database. Files in this suite share one MariaDB and several of them
  // truncate the catalogue in their own setup, so "find the first active tax
  // class" quietly depends on which file ran last - and fails the day somebody
  // adds a file that cleans up after itself.
  const taxClass = await prisma.taxClass.upsert({
    where: { code: 'DETAIL-TEST' },
    update: { isActive: true },
    create: {
      id: newId(),
      code: 'DETAIL-TEST',
      name: 'Detail shape test',
      ratePercent: '18.000000',
      isActive: true,
    },
  });

  const category = await prisma.category.upsert({
    where: { slug: 'detail-shape-test' },
    update: { isActive: true, archivedAt: null },
    create: {
      id: newId(),
      name: 'Detail shape test',
      slug: 'detail-shape-test',
      isActive: true,
    },
  });

  productId = newId();
  mediaId = newId();

  await prisma.mediaAsset.create({
    data: {
      id: mediaId,
      storageKey: `test/detail-shape/${mediaId}.png`,
      url: `http://localhost:4000/media/test/${mediaId}.png`,
      mimeType: 'image/png',
      sizeBytes: 128,
      width: 64,
      height: 64,
      altText: 'A test image',
    },
  });

  await prisma.product.create({
    data: {
      id: productId,
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Detail shape probe',
      slug: `detail-shape-probe-${productId.toLowerCase()}`,
      sku: `DETAIL-SHAPE-${productId}`,
      basePriceMinor: 12_500n,
      currency: 'INR',
      attributes: {
        create: [
          { id: newId(), name: 'Material', value: 'Stainless 304', sortOrder: 0, isFilterable: true },
          { id: newId(), name: 'Finish', value: 'Brushed', sortOrder: 1 },
        ],
      },
      media: { create: { id: newId(), mediaId, sortOrder: 0, isPrimary: true } },
    },
  });

  // A distinct IP so a neighbouring test cannot spend this file's login budget.
  ({ cookies } = await signInAdmin(app, {
    email: EMAIL,
    password: PASSWORD,
    ip: '203.0.113.91',
  }));
});

afterAll(async () => {
  await prisma.productMedia.deleteMany({ where: { productId } });
  await prisma.productAttribute.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.mediaAsset.deleteMany({ where: { id: mediaId } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
  await app.close();
});

interface DetailResponse {
  product: {
    media: { mediaId: string; url: string; altText: string | null; isPrimary: boolean }[];
    attributes: { name: string; value: string; isFilterable: boolean; sortOrder: number }[];
  };
}

async function fetchDetail(): Promise<DetailResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/products/${productId}`,
    headers: { cookie: cookies },
  });

  expect(response.statusCode, response.body).toBe(200);
  return response.json<DetailResponse>();
}

describe('GET /admin/products/:id', () => {
  it('returns images flattened, with a usable url', async () => {
    const { product } = await fetchDetail();

    expect(product.media).toHaveLength(1);
    // An empty or missing url renders as <img src=""> - visibly broken, and
    // silent in every type checker on both sides.
    expect(product.media[0]?.url).toMatch(/^https?:\/\/.+\.png$/);
    expect(product.media[0]?.isPrimary).toBe(true);
    expect(product.media[0]?.altText).toBe('A test image');
  });

  it('names the image by the id the delete route accepts', async () => {
    const { product } = await fetchDetail();

    // DELETE /products/:id/media/:mediaId looks the row up by MediaAsset id.
    // Returning the join row's id here would 404 every removal.
    expect(product.media[0]?.mediaId).toBe(mediaId);
  });

  it('returns specifications in their stored order', async () => {
    const { product } = await fetchDetail();

    expect(product.attributes.map((attribute) => attribute.name)).toEqual(['Material', 'Finish']);
    expect(product.attributes[0]?.value).toBe('Stainless 304');
    expect(product.attributes[0]?.isFilterable).toBe(true);
    expect(product.attributes[1]?.isFilterable).toBe(false);
  });
});
