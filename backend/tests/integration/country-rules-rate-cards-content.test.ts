/**
 * Country rules (Master row 69), the operator's rate cards (row 71) and
 * storefront content blocks (row 72).
 *
 *   - Country rules: staff CRUD with settings permissions, validated and
 *     audited; checkout refuses a basket holding a category blocked for the
 *     delivery country; a value threshold only bites at or above its amount
 *     and never hides a product from the listing.
 *   - Rate cards: overlapping bands are refused; the quote applies band,
 *     per-kilogram, minimum charge and fuel surcharge in integer minor units;
 *     a lane switched off is not offered; every save bumps the version.
 *   - Content: only published, in-schedule blocks targeted at the shopper's
 *     country and language reach the storefront; a coupon code is shown only
 *     while that coupon is ACTIVE and publicly listed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError } from '../../src/domain/errors.js';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { addItem } from '../../src/modules/cart/cart.service.js';
import { blockedScopeFor } from '../../src/modules/catalog/market-eligibility.service.js';
import { destinationRestrictions } from '../../src/modules/catalog/market-rule-admin.service.js';
import { priceOnLane } from '../../src/modules/logistics/lane-rate.service.js';
import { submitCheckout } from '../../src/modules/orders/order.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

const PREFIX = 'crc-test';
const PASSWORD = 'CountryRules!2026Test';
const OWNER = 'crc-owner@test.local';
const CATALOG = 'crc-catalog@test.local';
const BUYER = 'crc-buyer@test.local';
/** A second business owner: a content block is published only by someone other than its author (JOURNEY-067). */
const APPROVER = 'crc-approver@test.local';
const IP = '203.0.113.91';
const COUPON = 'CRCTESTBANNER';

let app: Awaited<ReturnType<typeof buildApp>>;
let owner: AdminSession;
let catalog: AdminSession;
let approver: AdminSession;
let categoryId = '';
let productId = '';
let buyer = { userId: '', profileId: '', addressId: '' };

async function makeStaff(email: string, role: string): Promise<void> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
  const id = newId();
  await prisma.user.create({
    data: { id, type: 'ADMIN', email, emailNormalized: email, passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  await prisma.userRole.create({ data: { userId: id, roleId: roleRow.id } });
}

async function cleanUp(): Promise<void> {
  const emails = [OWNER, CATALOG, BUYER, APPROVER];
  const userIds = (await prisma.user.findMany({ where: { emailNormalized: { in: emails } }, select: { id: true } })).map((row) => row.id);
  await prisma.auditLog.deleteMany({
    where: { resourceType: { in: ['market_rule', 'logistics_lane', 'content_block'] }, actorUserId: { in: userIds } },
  });
  await prisma.contentBlock.deleteMany({ where: { title: { startsWith: PREFIX } } });
  await prisma.coupon.deleteMany({ where: { code: COUPON } });
  const ruleIds = (await prisma.marketRule.findMany({ where: { reason: { startsWith: PREFIX } }, select: { id: true } })).map((row) => row.id);
  await prisma.marketRuleVersion.deleteMany({ where: { OR: [{ ruleId: { in: ruleIds } }, { changedById: { in: userIds } }] } });
  await prisma.marketRule.deleteMany({ where: { reason: { startsWith: PREFIX } } });
  await prisma.logisticsLane.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.cartItem.deleteMany({ where: { cart: { customerProfile: { userId: { in: userIds } } } } });
  await prisma.cart.deleteMany({ where: { customerProfile: { userId: { in: userIds } } } });
  await prisma.address.deleteMany({ where: { customerProfile: { userId: { in: userIds } } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.productPrice.deleteMany({ where: { product: { sku: { startsWith: PREFIX } } } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}-category` } });
  await prisma.shippingMethod.deleteMany({ where: { code: 'CRC-STD' } });
  await prisma.taxClass.deleteMany({ where: { code: 'CRC-GST18' } });
  await prisma.inventoryLocation.deleteMany({ where: { code: 'CRC-MAIN' } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: emails } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const headers = (session: AdminSession) => ({ cookie: session.cookies, 'x-csrf-token': session.csrfToken, 'x-forwarded-for': IP });
const send = (session: AdminSession, method: 'POST' | 'PUT' | 'DELETE' | 'GET', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/v1/admin${url}`, headers: headers(session), ...(payload === undefined ? {} : { payload }) });

const RULE = {
  scope: 'CATEGORY',
  countryCode: 'in',
  effect: 'BLOCK',
  reason: `${PREFIX} Lithium cells cannot be shipped there.`,
  source: 'Test regulation 1',
  version: '2026.1',
  ownerName: 'Compliance',
  effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  if ((await prisma.inventoryLocation.count({ where: { isDefault: true } })) === 0) {
    await prisma.inventoryLocation.create({ data: { id: newId(), code: 'CRC-MAIN', name: 'CRC Main', isDefault: true, isActive: true } });
  }
  const taxClassId = newId();
  await prisma.taxClass.create({ data: { id: taxClassId, code: 'CRC-GST18', name: 'CRC GST 18%', ratePercent: '18.000000', isActive: true } });
  await prisma.shippingMethod.create({ data: { id: newId(), code: 'CRC-STD', name: 'CRC standard', priceMinor: 0n, isActive: true } });
  categoryId = newId();
  await prisma.category.create({ data: { id: categoryId, name: 'CRC cells', slug: `${PREFIX}-category`, isActive: true } });
  productId = newId();
  await prisma.product.create({
    data: {
      id: productId,
      categoryId,
      taxClassId,
      name: 'CRC Lithium Cell',
      slug: `${PREFIX}-cell`,
      sku: `${PREFIX}-CELL`,
      basePriceMinor: 1000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
    },
  });
  await prisma.productPrice.create({ data: { id: newId(), productId, variantKey: '', currencyCode: 'INR', basePriceMinor: 1000n } });

  const userId = newId();
  const profileId = newId();
  await prisma.user.create({
    data: { id: userId, type: 'CUSTOMER', email: BUYER, emailNormalized: BUYER, passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  await prisma.customerProfile.create({ data: { id: profileId, userId, fullName: 'CRC Buyer' } });
  const addressId = newId();
  await prisma.address.create({
    data: {
      id: addressId,
      customerProfileId: profileId,
      contactName: 'CRC Buyer',
      contactPhone: '+91 90000 00000',
      line1: 'Gate 3',
      city: 'Pune',
      state: 'MH',
      postalCode: '411019',
      country: 'IN',
    },
  });
  buyer = { userId, profileId, addressId };

  await makeStaff(OWNER, Role.BUSINESS_OWNER);
  await makeStaff(CATALOG, Role.CATALOG_MANAGER);
  await makeStaff(APPROVER, Role.BUSINESS_OWNER);
  owner = await signInAdmin(app, { email: OWNER, password: PASSWORD, ip: IP });
  catalog = await signInAdmin(app, { email: CATALOG, password: PASSWORD, ip: IP });
  approver = await signInAdmin(app, { email: APPROVER, password: PASSWORD, ip: IP });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('country rules (Master row 69)', () => {
  let ruleId = '';

  it('creates, lists and audits a rule; refuses a half threshold; needs settings.write', async () => {
    const created = await send(owner, 'POST', '/market-rules', { ...RULE, categoryId });
    expect(created.statusCode, created.body).toBe(201);
    const rule = created.json<{ rule: { id: string; countryCode: string; category: { id: string } } }>().rule;
    expect(rule).toMatchObject({ countryCode: 'IN', category: { id: categoryId } });
    ruleId = rule.id;

    const listed = await send(owner, 'GET', '/market-rules?country=IN');
    expect(listed.json<{ rules: { id: string }[] }>().rules.map((row) => row.id)).toContain(ruleId);
    expect(await prisma.auditLog.count({ where: { resourceType: 'market_rule', resourceId: ruleId } })).toBe(1);

    const half = await send(owner, 'POST', '/market-rules', { ...RULE, categoryId, minOrderValueMinor: '5000' });
    expect(half.statusCode).toBe(400);
    expect(half.json<{ error: { code: string } }>().error.code).toBe('MARKET_RULE_INVALID');

    const noScope = await send(owner, 'POST', '/market-rules', { ...RULE });
    expect(noScope.json<{ error: { code: string } }>().error.code).toBe('MARKET_RULE_INVALID');

    const forbidden = await send(catalog, 'POST', '/market-rules', { ...RULE, categoryId });
    expect(forbidden.statusCode).toBe(403);
  });

  it('refuses checkout to that country with MARKET_DESTINATION_RESTRICTED', async () => {
    await addItem(buyer.profileId, { productId, quantity: 2 });
    let code: string | null = null;
    let meta: Record<string, unknown> = {};
    try {
      await submitCheckout({
        customerProfileId: buyer.profileId,
        shippingAddressId: buyer.addressId,
        shippingMethodCode: 'CRC-STD',
        paymentMode: 'ONLINE',
        actor: { userId: buyer.userId, email: BUYER, type: 'CUSTOMER' },
      });
    } catch (error) {
      if (!isAppError(error)) throw error;
      code = error.code;
      meta = error.details[0]?.meta ?? {};
    }
    expect(code).toBe('MARKET_DESTINATION_RESTRICTED');
    expect(meta).toMatchObject({ productId, country: 'IN', reason: RULE.reason });
    expect(await prisma.order.count({ where: { customerProfileId: buyer.profileId } })).toBe(0);
  });

  it('applies a value threshold only at or above it, and never hides the product from a listing', async () => {
    const updated = await send(owner, 'PUT', `/market-rules/${ruleId}`, {
      ...RULE,
      categoryId,
      minOrderValueMinor: '5000',
      thresholdCurrency: 'inr',
    });
    expect(updated.statusCode, updated.body).toBe(200);

    expect(await destinationRestrictions('IN', [productId], { amountMinor: 4999n, currency: 'INR' })).toEqual([]);
    expect(await destinationRestrictions('IN', [productId], { amountMinor: 5000n, currency: 'INR' })).toEqual([
      { productId, reason: RULE.reason },
    ]);
    // Another currency is treated as meeting it: no exchange rate is guessed.
    expect(await destinationRestrictions('IN', [productId], { amountMinor: 1n, currency: 'EUR' })).toHaveLength(1);
    // Another country is untouched.
    expect(await destinationRestrictions('DE', [productId], { amountMinor: 9_999_999n, currency: 'INR' })).toEqual([]);

    expect((await blockedScopeFor('IN')).categoryIds).not.toContain(categoryId);

    const removed = await send(owner, 'DELETE', `/market-rules/${ruleId}`);
    expect(removed.statusCode).toBe(204);
    expect(await prisma.marketRule.count({ where: { id: ruleId } })).toBe(0);

    // The history outlives the rule: created, updated, deleted (JOURNEY-064).
    const history = await send(owner, 'GET', `/market-rules/${ruleId}/versions`);
    const versions = history.json<{ versions: { revision: number; changeKind: string; changedByEmail: string }[] }>().versions;
    expect(versions.map((row) => row.changeKind)).toEqual(['DELETED', 'UPDATED', 'CREATED']);
    expect(versions[0]).toMatchObject({ revision: 3, changedByEmail: OWNER });
  });

  it('keeps a label rule that never blocks, and lists it for checkout (JOURNEY-064)', async () => {
    const noText = await send(owner, 'POST', '/market-rules', { ...RULE, categoryId, effect: 'LABEL_REQUIRED' });
    expect(noText.json<{ error: { code: string } }>().error.code).toBe('MARKET_RULE_INVALID');

    const label = await send(owner, 'POST', '/market-rules', {
      ...RULE,
      categoryId,
      countryCode: 'de',
      effect: 'LABEL_REQUIRED',
      labelText: 'German-language battery warning and the WEEE bin symbol.',
    });
    expect(label.statusCode, label.body).toBe(201);
    expect(await destinationRestrictions('DE', [productId], { amountMinor: 1n, currency: 'EUR' })).toEqual([]);

    const listed = await app.inject({ method: 'GET', url: `/api/v1/catalog/label-requirements?country=DE&products=${productId}` });
    expect(listed.json<{ requirements: { productId: string; labelText: string }[] }>().requirements).toEqual([
      { productId, reason: RULE.reason, labelText: 'German-language battery warning and the WEEE bin symbol.' },
    ]);
    const id = label.json<{ rule: { id: string } }>().rule.id;
    expect((await send(owner, 'DELETE', `/market-rules/${id}`)).statusCode).toBe(204);
  });
});

describe('rate cards (Master row 71)', () => {
  const LANE = {
    name: `${PREFIX} Pune to Kiribati air`,
    originCountry: 'IN',
    destinationCountry: 'KI',
    mode: 'AIR',
    carrierName: 'Test Air',
    transitDaysMin: 3,
    transitDaysMax: 6,
    currency: 'INR',
    minimumChargeMinor: '50000',
    fuelSurchargeBasisPoints: 1250,
    validFrom: new Date(Date.now() - 86_400_000).toISOString(),
    bands: [
      { minWeightGrams: 0, maxWeightGrams: 4999, amountMinor: '20000', perKgMinor: '1000' },
      { minWeightGrams: 5000, maxWeightGrams: null, amountMinor: '40000', perKgMinor: '5000' },
    ],
  };

  it('prices with band, started kilograms, minimum charge and fuel in integer minor units', () => {
    const lane = { minimumChargeMinor: 50_000n, fuelSurchargeBasisPoints: 1250 };
    const bands = LANE.bands.map((band) => ({
      ...band,
      amountMinor: BigInt(band.amountMinor),
      perKgMinor: BigInt(band.perKgMinor),
    }));
    // 2.1 kg: 20000 + 3 x 1000 = 23000, below the minimum, so 50000; fuel 6250.
    expect(priceOnLane(lane, bands, 2100)).toEqual({ baseMinor: 50_000n, fuelMinor: 6250n, totalMinor: 56_250n });
    // 12 kg: 40000 + 12 x 5000 = 100000; fuel 12500.
    expect(priceOnLane(lane, bands, 12_000)).toEqual({ baseMinor: 100_000n, fuelMinor: 12_500n, totalMinor: 112_500n });
  });

  it('saves a lane, refuses overlapping bands, quotes it, and drops it when not serviceable', async () => {
    const overlap = await send(owner, 'POST', '/logistics/lanes', {
      ...LANE,
      bands: [
        { minWeightGrams: 0, maxWeightGrams: 5000, amountMinor: '1' },
        { minWeightGrams: 5000, maxWeightGrams: null, amountMinor: '2' },
      ],
    });
    expect(overlap.statusCode).toBe(400);
    expect(overlap.json<{ error: { code: string } }>().error.code).toBe('LOGISTICS_LANE_INVALID');

    const created = await send(owner, 'POST', '/logistics/lanes', LANE);
    expect(created.statusCode, created.body).toBe(201);
    const lane = created.json<{ lane: { id: string; version: number } }>().lane;
    expect(lane.version).toBe(1);

    const quote = await send(owner, 'POST', '/logistics/lanes/quote', { originCountry: 'IN', destinationCountry: 'KI', weightGrams: 12_000 });
    expect(quote.statusCode, quote.body).toBe(200);
    const mine = quote.json<{ quotes: { laneId: string; totalMinor: string; currency: string }[] }>().quotes.find((row) => row.laneId === lane.id);
    expect(mine).toMatchObject({ totalMinor: '112500', currency: 'INR' });

    const off = await send(owner, 'PUT', `/logistics/lanes/${lane.id}`, { ...LANE, isServiceable: false });
    expect(off.json<{ lane: { version: number } }>().lane.version).toBe(2);
    const after = await send(owner, 'POST', '/logistics/lanes/quote', { originCountry: 'IN', destinationCountry: 'KI', weightGrams: 12_000 });
    expect(after.json<{ quotes: { laneId: string }[] }>().quotes.map((row) => row.laneId)).not.toContain(lane.id);

    expect((await send(catalog, 'POST', '/logistics/lanes', LANE)).statusCode).toBe(403);
  });
});

describe('storefront content blocks (Master row 72)', () => {
  const live = (query: string) => app.inject({ method: 'GET', url: `/api/v1/catalog/content-blocks?${query}` });
  const titles = async (query: string): Promise<string[]> =>
    (await live(query)).json<{ blocks: { title: string }[] }>().blocks.map((row) => row.title);

  it('shows only published, in-schedule blocks for the shopper country and language, with a usable coupon', async () => {
    await prisma.coupon.create({
      data: { id: newId(), code: COUPON, name: 'CRC banner coupon', discountPercent: '10.00', status: 'DRAFT', isPubliclyListed: true },
    });
    const base = { placement: 'HOME_BANNER', isPublished: true };
    for (const body of [
      { ...base, title: `${PREFIX} everyone`, couponCode: COUPON.toLowerCase() },
      { ...base, title: `${PREFIX} kiribati german`, countryCode: 'ki', languageCode: 'de' },
      { ...base, title: `${PREFIX} draft`, isPublished: false },
      { ...base, title: `${PREFIX} later`, startsAt: new Date(Date.now() + 86_400_000).toISOString() },
      { ...base, title: `${PREFIX} ended`, startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), endsAt: new Date(Date.now() - 86_400_000).toISOString() },
    ]) {
      const response = await send(owner, 'POST', '/content-blocks', body);
      expect(response.statusCode, response.body).toBe(201);
      const created = response.json<{ block: { id: string; status: string } }>().block;
      if (body.isPublished) {
        // Sent for approval, not live: a second member of staff publishes it.
        expect(created.status).toBe('PENDING_APPROVAL');
        const approved = await send(approver, 'POST', `/content-blocks/${created.id}/approve`);
        expect(approved.statusCode, approved.body).toBe(200);
      }
    }

    const forKiGerman = (await titles('country=KI&language=de')).filter((title) => title.startsWith(PREFIX));
    expect(forKiGerman.sort()).toEqual([`${PREFIX} everyone`, `${PREFIX} kiribati german`]);
    const forKiEnglish = (await titles('country=KI&language=en')).filter((title) => title.startsWith(PREFIX));
    expect(forKiEnglish).toEqual([`${PREFIX} everyone`]);

    const coupon = async () =>
      (await live('country=KI')).json<{ blocks: { title: string; couponCode: string | null }[] }>().blocks.find(
        (row) => row.title === `${PREFIX} everyone`,
      )?.couponCode;
    expect(await coupon()).toBeNull();
    await prisma.coupon.update({ where: { code: COUPON }, data: { status: 'ACTIVE' } });
    expect(await coupon()).toBe(COUPON);
  });

  it('validates input and needs settings.write', async () => {
    const noCategory = await send(owner, 'POST', '/content-blocks', { placement: 'CATEGORY_BLOCK', title: `${PREFIX} x` });
    expect(noCategory.json<{ error: { code: string } }>().error.code).toBe('CONTENT_BLOCK_INVALID');
    const badCoupon = await send(owner, 'POST', '/content-blocks', { placement: 'HOME_BANNER', title: `${PREFIX} y`, couponCode: 'NOPE-NOT-REAL' });
    expect(badCoupon.json<{ error: { code: string } }>().error.code).toBe('CONTENT_BLOCK_INVALID');
    const script = await send(owner, 'POST', '/content-blocks', { placement: 'HOME_BANNER', title: `${PREFIX} z`, linkUrl: 'javascript:alert(1)' });
    expect(script.statusCode).toBe(400);
    expect((await send(catalog, 'POST', '/content-blocks', { placement: 'HOME_BANNER', title: `${PREFIX} w` })).statusCode).toBe(403);

    const category = await send(owner, 'POST', '/content-blocks', { placement: 'CATEGORY_BLOCK', categoryId, title: `${PREFIX} shelf`, isPublished: true });
    expect(category.statusCode, category.body).toBe(201);
    // Not on the storefront until somebody else approves it.
    expect(await titles(`placement=CATEGORY_BLOCK&category=${PREFIX}-category`)).toEqual([]);
    const shelfId = category.json<{ block: { id: string } }>().block.id;
    const self = await send(owner, 'POST', `/content-blocks/${shelfId}/approve`);
    expect(self.json<{ error: { code: string } }>().error.code).toBe('CONTENT_BLOCK_SAME_APPROVER');
    expect((await send(approver, 'POST', `/content-blocks/${shelfId}/approve`)).statusCode).toBe(200);
    expect(await titles(`placement=CATEGORY_BLOCK&category=${PREFIX}-category`)).toEqual([`${PREFIX} shelf`]);
  });
});

describe('content approval, preview, rollback and conflict checks (JOURNEY-067)', () => {
  const titles = async (query: string): Promise<string[]> =>
    (await app.inject({ method: 'GET', url: `/api/v1/catalog/content-blocks?${query}` }))
      .json<{ blocks: { title: string }[] }>()
      .blocks.map((row) => row.title);

  it('previews drafts for a country, language and moment before anybody approves them', async () => {
    const created = await send(owner, 'POST', '/content-blocks', {
      placement: 'HOME_BANNER',
      title: `${PREFIX} preview me`,
      countryCode: 'ki',
      languageCode: 'de',
      startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });
    expect(created.statusCode, created.body).toBe(201);

    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const preview = await send(owner, 'GET', `/content-blocks/preview?country=KI&language=de&at=${encodeURIComponent(at)}`);
    const rows = preview.json<{ blocks: { title: string; status: string }[] }>().blocks;
    expect(rows.find((row) => row.title === `${PREFIX} preview me`)?.status).toBe('DRAFT');

    // Not for today, not for another language, and never on the live storefront.
    const today = await send(owner, 'GET', '/content-blocks/preview?country=KI&language=de');
    expect(today.json<{ blocks: { title: string }[] }>().blocks.some((row) => row.title === `${PREFIX} preview me`)).toBe(false);
    expect((await titles('country=KI&language=de')).includes(`${PREFIX} preview me`)).toBe(false);
  });

  it('keeps every saved version and restores an earlier one as a new draft', async () => {
    const created = await send(owner, 'POST', '/content-blocks', { placement: 'HOME_BANNER', title: `${PREFIX} v1` });
    const id = created.json<{ block: { id: string } }>().block.id;
    const edited = await send(owner, 'PUT', `/content-blocks/${id}`, { placement: 'HOME_BANNER', title: `${PREFIX} v2`, isPublished: true });
    expect(edited.json<{ block: { revision: number; status: string } }>().block).toMatchObject({ revision: 2, status: 'PENDING_APPROVAL' });

    const versions = (await send(owner, 'GET', `/content-blocks/${id}/versions`)).json<{ versions: { revision: number; snapshot: { title: string } }[] }>().versions;
    expect(versions.map((row) => row.revision)).toEqual([2, 1]);
    expect(versions[1]?.snapshot.title).toBe(`${PREFIX} v1`);

    const restored = await send(owner, 'POST', `/content-blocks/${id}/versions/1/restore`);
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json<{ block: { title: string; revision: number; status: string } }>().block).toMatchObject({
      title: `${PREFIX} v1`,
      revision: 3,
      status: 'DRAFT',
    });
  });

  it('warns about an inactive coupon and overlapping banners, and refuses a coupon that ends before the block starts', async () => {
    const coupon = await prisma.coupon.findUniqueOrThrow({ where: { code: COUPON } });
    await prisma.coupon.update({ where: { id: coupon.id }, data: { status: 'DRAFT', validUntil: new Date(Date.now() + 86_400_000) } });
    try {
      const saved = await send(owner, 'POST', '/content-blocks', {
        placement: 'HOME_BANNER',
        title: `${PREFIX} late coupon`,
        couponCode: COUPON,
        startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        isPublished: true,
      });
      expect(saved.statusCode, saved.body).toBe(201);
      const body = saved.json<{ block: { id: string }; warnings: { code: string; blocking: boolean }[] }>();
      expect(body.warnings.map((row) => row.code)).toEqual(expect.arrayContaining(['COUPON_NOT_ACTIVE', 'COUPON_ENDS_BEFORE_START']));
      // The everyone banner from the first test overlaps this one.
      expect(body.warnings.some((row) => row.code === 'OVERLAPPING_BLOCK')).toBe(true);

      const refused = await send(approver, 'POST', `/content-blocks/${body.block.id}/approve`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('CONTENT_BLOCK_CONFLICT');
    } finally {
      await prisma.coupon.update({ where: { id: coupon.id }, data: { status: coupon.status, validUntil: coupon.validUntil } });
    }
  });
});
