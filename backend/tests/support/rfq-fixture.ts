/**
 * A small marketplace for the request-for-quotation tests (Master rows 16-19).
 *
 * THE WORLD
 *
 *   Categories  <prefix>root  >  <prefix>gloves  (where the request is filed)
 *               <prefix>other                      (nobody asked sells here)
 *   Products    gloves-a (in gloves)       live offers from ALPHA and BETA
 *               gloves-de-blocked          live offer from DELTA only, and a
 *                                          market rule BLOCKS it for DE
 *               other-thing (in other)     live offer from GAMMA
 *   Sellers     ALPHA, BETA, GAMMA, DELTA  approved
 *               PENDING                    not approved, live offer on gloves-a
 *   Market rule the gloves category is BLOCKED for BR (the whole shelf)
 *
 *   Buyers      BUYER        an individual
 *               RIVAL        another individual (IDOR checks)
 *               OWNER        owner of COMPANY (approved), acting for it
 *               VIEWER       a VIEWER in COMPANY, acting for it
 *
 * Every buyer and every seller owner has a real storefront session. Seller
 * sessions have the Hub already unlocked, so the seller routes are exercised
 * over HTTP through the real guard.
 */
import { expect } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { buildApp as BuildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

export const PASSWORD = 'RfqFixture!2026x';

export interface Person {
  key: string;
  email: string;
  userId: string;
  profileId: string;
  cookie: string;
  csrf: string;
}

export interface Seller {
  id: string;
  displayName: string;
  owner: Person;
}

export interface RfqWorld {
  app: Awaited<ReturnType<typeof BuildApp>>;
  prefix: string;
  rootCategoryId: string;
  categoryId: string;
  otherCategoryId: string;
  /** A category nobody sells in. */
  emptyCategoryId: string;
  buyer: Person;
  rival: Person;
  owner: Person;
  viewer: Person;
  companyId: string;
  sellers: { alpha: Seller; beta: Seller; gamma: Seller; delta: Seller; pending: Seller };
}

function emailFor(prefix: string, key: string): string {
  return `${prefix}${key}@rfq.test.local`;
}

const PEOPLE = ['buyer', 'rival', 'owner', 'viewer', 'alpha', 'beta', 'gamma', 'delta', 'pending'];

export async function cleanRfqWorld(prefix: string): Promise<void> {
  const emails = PEOPLE.map((key) => emailFor(prefix, key));
  const users = await prisma.user.findMany({ where: { emailNormalized: { in: emails } }, select: { id: true } });
  const userIds = users.map((row) => row.id);
  const profiles = (
    await prisma.customerProfile.findMany({ where: { userId: { in: userIds } }, select: { id: true } })
  ).map((row) => row.id);
  const sellers = (
    await prisma.sellerAccount.findMany({ where: { slug: { startsWith: prefix } }, select: { id: true } })
  ).map((row) => row.id);
  const companies = (
    await prisma.buyerCompany.findMany({ where: { createdByUserId: { in: userIds } }, select: { id: true } })
  ).map((row) => row.id);

  await prisma.rfqRequest.deleteMany({ where: { customerProfileId: { in: profiles } } });
  await prisma.notificationOutbox.deleteMany({ where: { recipientEmail: { in: emails } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.marketRule.deleteMany({ where: { source: prefix } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: prefix } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: prefix }, parentId: { not: null } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: prefix } } });
  await prisma.buyerCompanyMember.deleteMany({ where: { companyId: { in: companies } } });
  await prisma.buyerCompany.deleteMany({ where: { id: { in: companies } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profiles } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: emails } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function makePerson(prefix: string, key: string, hash: string): Promise<Omit<Person, 'cookie' | 'csrf'>> {
  const email = emailFor(prefix, key);
  const userId = newId();
  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: hash,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId, fullName: `Rfq ${key}`, activatedAt: new Date() },
  });
  return { key, email, userId, profileId: profile.id };
}

async function signIn(
  app: RfqWorld['app'],
  person: Omit<Person, 'cookie' | 'csrf'>,
): Promise<Person> {
  // Nine people sign in from one address before the first test. The shared
  // setup clears the limiter before each TEST, not before `beforeAll`, so it
  // is cleared here too - the same reset, one step earlier.
  await prisma.rateLimitBucket.deleteMany({});
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: person.email, password: PASSWORD },
  });
  expect(response.statusCode, response.body).toBe(200);
  const jar = new Map<string, string>();
  for (const cookie of response.cookies as { name: string; value: string }[]) jar.set(cookie.name, cookie.value);
  return {
    ...person,
    cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: jar.get('uboss_shop_csrf') ?? '',
  };
}

async function makeProduct(prefix: string, slug: string, categoryId: string, taxClassId: string): Promise<string> {
  const id = newId();
  await prisma.product.create({
    data: {
      id,
      categoryId,
      taxClassId,
      name: `RFQ ${slug}`,
      slug: `${prefix}${slug}`,
      sku: `${prefix}${slug}`.toUpperCase().slice(0, 60),
      basePriceMinor: 0n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isMarketplaceProduct: true,
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  return id;
}

async function makeSeller(
  prefix: string,
  key: string,
  owner: Omit<Person, 'cookie' | 'csrf'>,
  status: 'APPROVED' | 'SUBMITTED',
  hubHash: string,
): Promise<string> {
  const id = newId();
  const displayName = `${key[0]?.toUpperCase() ?? ''}${key.slice(1)} Supplies ${prefix}`;
  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${displayName} Ltd`,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
      slug: `${prefix}${key}`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status,
      approvedAt: status === 'APPROVED' ? new Date('2026-01-15T00:00:00.000Z') : null,
    },
  });
  await prisma.sellerMember.create({
    data: {
      id: newId(),
      sellerAccountId: id,
      customerProfileId: owner.profileId,
      role: 'OWNER',
      passwordHash: hubHash,
      passwordSetAt: new Date(),
    },
  });
  return id;
}

async function offer(sellerAccountId: string, productId: string, sku: string): Promise<void> {
  await prisma.sellerOffer.create({
    data: {
      id: newId(),
      sellerAccountId,
      productId,
      variantKey: '',
      sellerSku: sku,
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: 10_000n,
      currency: 'INR',
      availableQuantity: 500,
    },
  });
}

/** Open the Seller Hub on this person's session, as entering its password would. */
async function unlockHub(person: Person, sellerAccountId: string): Promise<void> {
  const now = new Date();
  await prisma.session.updateMany({
    where: { userId: person.userId },
    data: { sellerUnlockedAt: now, sellerUnlockedForId: sellerAccountId, sellerLastActivityAt: now },
  });
}

export async function buildRfqWorld(
  app: RfqWorld['app'],
  prefix: string,
): Promise<RfqWorld> {
  await cleanRfqWorld(prefix);
  const hash = await hashPassword(PASSWORD);
  const hubHash = await hashPassword('RfqHub!2026x');

  const taxClass =
    (await prisma.taxClass.findFirst({ select: { id: true } })) ??
    (await prisma.taxClass.create({
      data: { id: newId(), code: `${prefix}T`.slice(0, 16), name: 'GST 18%', ratePercent: '18.000000', isActive: true },
      select: { id: true },
    }));

  const root = await prisma.category.create({
    data: { id: newId(), name: `RFQ root ${prefix}`, slug: `${prefix}root`, isActive: true, path: '/', depth: 0 },
  });
  const gloves = await prisma.category.create({
    data: {
      id: newId(),
      parentId: root.id,
      name: `RFQ gloves ${prefix}`,
      slug: `${prefix}gloves`,
      isActive: true,
      path: `/${root.id}/`,
      depth: 1,
    },
  });
  const other = await prisma.category.create({
    data: { id: newId(), name: `RFQ other ${prefix}`, slug: `${prefix}other`, isActive: true, path: '/', depth: 0 },
  });

  const empty = await prisma.category.create({
    data: { id: newId(), name: `RFQ empty ${prefix}`, slug: `${prefix}empty`, isActive: true, path: '/', depth: 0 },
  });

  const glovesA = await makeProduct(prefix, 'gloves-a', gloves.id, taxClass.id);
  const glovesBlocked = await makeProduct(prefix, 'gloves-de-blocked', gloves.id, taxClass.id);
  const otherThing = await makeProduct(prefix, 'other-thing', other.id, taxClass.id);

  const bare: Record<string, Omit<Person, 'cookie' | 'csrf'>> = {};
  for (const key of PEOPLE) bare[key] = await makePerson(prefix, key, hash);
  const person = (key: string): Omit<Person, 'cookie' | 'csrf'> => {
    const found = bare[key];
    if (found === undefined) throw new Error(`no person ${key}`);
    return found;
  };

  const alpha = await makeSeller(prefix, 'alpha', person('alpha'), 'APPROVED', hubHash);
  const beta = await makeSeller(prefix, 'beta', person('beta'), 'APPROVED', hubHash);
  const gamma = await makeSeller(prefix, 'gamma', person('gamma'), 'APPROVED', hubHash);
  const delta = await makeSeller(prefix, 'delta', person('delta'), 'APPROVED', hubHash);
  const pending = await makeSeller(prefix, 'pending', person('pending'), 'SUBMITTED', hubHash);
  await offer(alpha, glovesA, `${prefix}A`);
  await offer(beta, glovesA, `${prefix}B`);
  await offer(delta, glovesBlocked, `${prefix}D`);
  await offer(gamma, otherThing, `${prefix}G`);
  await offer(pending, glovesA, `${prefix}P`);

  const ruleBase = {
    reason: 'Not sold into this country by this marketplace.',
    source: prefix,
    version: '1',
    ownerName: 'Compliance',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    isActive: true,
  };
  await prisma.marketRule.create({
    data: { id: newId(), scope: 'PRODUCT', productId: glovesBlocked, countryCode: 'DE', effect: 'BLOCK', ...ruleBase },
  });
  await prisma.marketRule.create({
    data: { id: newId(), scope: 'CATEGORY', categoryId: gloves.id, countryCode: 'BR', effect: 'BLOCK', ...ruleBase },
  });

  const companyId = newId();
  await prisma.buyerCompany.create({
    data: {
      id: companyId,
      applicationReference: `RQ${companyId.slice(-10)}`,
      createdByUserId: person('owner').userId,
      legalName: `Rfq Buying Co ${prefix}`,
      status: 'APPROVED',
    },
  });
  await prisma.buyerCompanyMember.create({
    data: { id: newId(), companyId, userId: person('owner').userId, role: 'OWNER' },
  });
  await prisma.buyerCompanyMember.create({
    data: { id: newId(), companyId, userId: person('viewer').userId, role: 'VIEWER' },
  });

  const signed: Record<string, Person> = {};
  for (const key of PEOPLE) signed[key] = await signIn(app, person(key));
  const session = (key: string): Person => {
    const found = signed[key];
    if (found === undefined) throw new Error(`no session ${key}`);
    return found;
  };

  // The two company members act for the company.
  for (const key of ['owner', 'viewer']) {
    await prisma.session.updateMany({
      where: { userId: session(key).userId },
      data: { buyerContextKind: 'COMPANY', buyerCompanyId: companyId },
    });
  }

  const sellerOf = async (key: string, id: string): Promise<Seller> => {
    await unlockHub(session(key), id);
    const row = await prisma.sellerAccount.findUniqueOrThrow({ where: { id }, select: { displayName: true } });
    return { id, displayName: row.displayName, owner: session(key) };
  };

  return {
    app,
    prefix,
    rootCategoryId: root.id,
    categoryId: gloves.id,
    otherCategoryId: other.id,
    emptyCategoryId: empty.id,
    buyer: session('buyer'),
    rival: session('rival'),
    owner: session('owner'),
    viewer: session('viewer'),
    companyId,
    sellers: {
      alpha: await sellerOf('alpha', alpha),
      beta: await sellerOf('beta', beta),
      gamma: await sellerOf('gamma', gamma),
      delta: await sellerOf('delta', delta),
      pending: await sellerOf('pending', pending),
    },
  };
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A request as this person's browser would send it. */
export function as(
  world: RfqWorld,
  person: Person,
  method: Method,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return world.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: person.cookie, 'x-csrf-token': person.csrf, ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

export function errorCode(response: LightMyRequestResponse): string | undefined {
  return response.json<{ error?: { code: string } }>().error?.code;
}

export function errorDetails(response: LightMyRequestResponse): { field?: string; code: string }[] {
  return response.json<{ error?: { details?: { field?: string; code: string }[] } }>().error?.details ?? [];
}

/** A complete, valid requirement for the gloves category. */
export function completeDraft(world: RfqWorld, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    categoryId: world.categoryId,
    title: 'Nitrile examination gloves, powder free',
    specification: 'Nitrile, 4 mil, powder free, sizes S-XL, boxes of 100, EN 455 compliant.',
    specs: [
      { key: 'Material', value: 'Nitrile' },
      { key: 'Thickness', value: '4 mil' },
    ],
    quantity: '12000',
    unitOfMeasure: 'BOX',
    annualVolume: '150000',
    targetUnitPriceMinor: '85000',
    targetCurrency: 'INR',
    destinationCountry: 'IN',
    destinationAddress: 'Receiving dock 4, MIDC, Pune 411019',
    destinationPort: 'Nhava Sheva',
    incoterm: 'CIF',
    certifications: ['EN 455', 'ISO 13485'],
    sampleRequirement: 'WITH_QUOTE',
    inspectionRequirement: 'THIRD_PARTY_PRE_SHIPMENT',
    responseDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    deliveryTargetDate: new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10),
    notes: 'Split deliveries acceptable.',
    ...overrides,
  };
}

let keyCounter = 0;
export function key(): string {
  keyCounter += 1;
  return `rfq-test-${String(Date.now())}-${String(keyCounter)}`;
}

/** Create a draft and submit it. Returns the submitted request body. */
export async function submitted(
  world: RfqWorld,
  person: Person = world.buyer,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; reference: string; version: number; invitations: { id: string; status: string; supplier: { sellerAccountId: string } }[] }> {
  const created = await as(world, person, 'POST', '/rfqs', completeDraft(world, overrides), { 'idempotency-key': key() });
  expect(created.statusCode, created.body).toBe(201);
  const draft = created.json<{ rfq: { id: string; version: number } }>().rfq;
  const sent = await as(world, person, 'POST', `/rfqs/${draft.id}/submit`, { expectedVersion: draft.version }, {
    'idempotency-key': key(),
  });
  expect(sent.statusCode, sent.body).toBe(200);
  return sent.json<{ rfq: Awaited<ReturnType<typeof submitted>> }>().rfq;
}
