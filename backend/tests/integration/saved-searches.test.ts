/**
 * Saved searches and their alerts (checklist Master row 87), over HTTP and
 * through the alert job. Another buyer can neither see, change nor delete a
 * search; the job queues one e-mail for a new match and moves the window.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  SAVED_SEARCH_LIMIT,
  runSavedSearchAlerts,
} from '../../src/modules/catalog/saved-search.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'SavedSearch!2026x';
const EMAIL = { ana: 'saved-search-ana@test.local', ben: 'saved-search-ben@test.local' };
const ALL_EMAILS = Object.values(EMAIL);
const PREFIX = 'svs-';
const users: Record<string, { userId: string; profileId: string }> = {};

interface Session {
  cookie: string;
  csrf: string;
}

async function signIn(email: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode, response.body).toBe(200);
  const jar = new Map<string, string>();
  for (const c of response.cookies as { name: string; value: string }[]) jar.set(c.name, c.value);
  return {
    cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: jar.get('uboss_shop_csrf') ?? '',
  };
}

function call(
  session: Session,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url: `/api/v1/account/saved-searches${url}`,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const code = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { code: string } }>().error?.code;

async function cleanUp(): Promise<void> {
  const userIds = (
    await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })
  ).map((row) => row.id);
  const profileIds = (
    await prisma.customerProfile.findMany({ where: { userId: { in: userIds } }, select: { id: true } })
  ).map((row) => row.id);
  const searchIds = (
    await prisma.savedSearch.findMany({ where: { customerProfileId: { in: profileIds } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.notificationOutbox.deleteMany({ where: { relatedId: { in: searchIds } } });
  await prisma.savedSearch.deleteMany({ where: { customerProfileId: { in: profileIds } } });
  await prisma.cart.deleteMany({ where: { customerProfileId: { in: profileIds } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createCustomer(email: string): Promise<{ userId: string; profileId: string }> {
  const userId = newId();
  const profileId = newId();
  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.customerProfile.create({ data: { id: profileId, userId, fullName: 'Saved Search Buyer' } });
  return { userId, profileId };
}

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();
  users.ana = await createCustomer(EMAIL.ana);
  users.ben = await createCustomer(EMAIL.ben);
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('saved searches', () => {
  let ana: Session;
  let ben: Session;
  let searchId = '';

  it('refuses a signed-out caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/account/saved-searches' });
    expect(response.statusCode).toBe(401);
  });

  it('saves, lists, renames and toggles alerts for the owner', async () => {
    ana = await signIn(EMAIL.ana);
    ben = await signIn(EMAIL.ben);

    const created = await call(ana, 'POST', '/', {
      name: 'Gloves',
      query: 'gloves',
      filters: { category: 'gloves', country: 'de', currency: 'eur', minPrice: '100', maxPrice: '5000' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<{ id: string; alertsEnabled: boolean; filters: Record<string, string> }>();
    searchId = body.id;
    expect(body.alertsEnabled).toBe(true);
    expect(body.filters).toMatchObject({ country: 'DE', currency: 'EUR', minPrice: '100' });

    const list = await call(ana, 'GET', '/');
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { id: string }[]; limit: number }>()).toMatchObject({
      items: [{ id: searchId }],
      limit: SAVED_SEARCH_LIMIT,
    });

    const renamed = await call(ana, 'PATCH', `/${searchId}`, { name: 'Nitrile gloves', alertsEnabled: false });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'Nitrile gloves', alertsEnabled: false });
  });

  it('refuses a price range with no currency', async () => {
    const response = await call(ana, 'POST', '/', { name: 'x', query: 'x', filters: { minPrice: '1' } });
    expect(response.statusCode).toBe(400);
  });

  it('keeps another buyer out', async () => {
    const list = await call(ben, 'GET', '/');
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(0);

    const patch = await call(ben, 'PATCH', `/${searchId}`, { name: 'Mine now' });
    expect(patch.statusCode).toBe(404);
    const removed = await call(ben, 'DELETE', `/${searchId}`);
    expect(removed.statusCode).toBe(404);

    const still = await prisma.savedSearch.findUniqueOrThrow({ where: { id: searchId } });
    expect(still.name).toBe('Nitrile gloves');
  });

  it('caps how many searches one buyer keeps', async () => {
    await prisma.savedSearch.createMany({
      data: Array.from({ length: SAVED_SEARCH_LIMIT - 1 }, (_, index) => ({
        id: newId(),
        customerProfileId: users.ben?.profileId ?? '',
        name: `Filler ${String(index)}`,
        query: 'filler',
      })),
    });
    const last = await call(ben, 'POST', '/', { name: 'Last', query: 'last' });
    expect(last.statusCode, last.body).toBe(201);
    const over = await call(ben, 'POST', '/', { name: 'Over', query: 'over' });
    expect(over.statusCode).toBe(409);
    expect(code(over)).toBe('SAVED_SEARCH_LIMIT_REACHED');
    await prisma.savedSearch.deleteMany({ where: { customerProfileId: users.ben?.profileId ?? '' } });
  });

  it('the owner can delete it', async () => {
    const removed = await call(ana, 'DELETE', `/${searchId}`);
    expect(removed.statusCode).toBe(204);
    expect(await prisma.savedSearch.count({ where: { id: searchId } })).toBe(0);
  });
});

describe('saved search alert job', () => {
  it('queues one alert for a repriced match, moves the window, and stays quiet after', async () => {
    const taxClass = await prisma.taxClass.findFirstOrThrow({ select: { id: true } });
    const currency = await prisma.currency.findFirstOrThrow({ select: { code: true } });
    const categoryId = newId();
    await prisma.category.create({
      data: { id: categoryId, name: 'Saved search test', slug: `${PREFIX}cat`, isActive: true, path: '/', depth: 0 },
    });
    const product = { id: newId(), name: 'Zorblax alert widget' };
    await prisma.product.create({
      data: {
        id: product.id,
        categoryId,
        taxClassId: taxClass.id,
        name: product.name,
        slug: `${PREFIX}widget`,
        sku: 'SVS-WIDGET',
        basePriceMinor: 1000n,
        currency: currency.code,
        status: 'ACTIVE',
        isPublished: true,
        publishedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        isMarketplaceProduct: true,
        isStockTracked: false,
        minOrderQty: 1,
        qtyIncrement: 1,
      },
    });
    await prisma.productPrice.create({
      data: { id: newId(), productId: product.id, currencyCode: currency.code, basePriceMinor: 1000n },
    });

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const id = newId();
    await prisma.savedSearch.create({
      data: {
        id,
        customerProfileId: users.ana?.profileId ?? '',
        name: 'Alert me',
        query: product.name.slice(0, 40),
        createdAt: twoDaysAgo,
      },
    });
    // Another search with alerts off must be left alone.
    const offId = newId();
    await prisma.savedSearch.create({
      data: {
        id: offId,
        customerProfileId: users.ben?.profileId ?? '',
        name: 'Quiet',
        query: product.name.slice(0, 40),
        alertsEnabled: false,
        createdAt: twoDaysAgo,
      },
    });

    // The product was repriced a moment ago.
    await prisma.$executeRaw`UPDATE product_prices SET updatedAt = NOW(3) WHERE productId = ${product.id} AND variantKey = ''`;

    await runSavedSearchAlerts();

    const outbox = await prisma.notificationOutbox.findMany({ where: { relatedId: id } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventKey).toBe('saved_search.matches');
    expect(outbox[0]?.recipientEmail).toBe(EMAIL.ana);

    const after = await prisma.savedSearch.findUniqueOrThrow({ where: { id } });
    expect(after.lastNotifiedAt).not.toBeNull();
    expect(await prisma.notificationOutbox.count({ where: { relatedId: offId } })).toBe(0);
    expect((await prisma.savedSearch.findUniqueOrThrow({ where: { id: offId } })).lastNotifiedAt).toBeNull();

    // Within the day nothing is due, so a second pass queues nothing more.
    await runSavedSearchAlerts();
    expect(await prisma.notificationOutbox.count({ where: { relatedId: id } })).toBe(1);
  });
});
