/**
 * The marketplace blocking a live listing (checklist SCREEN-067), over HTTP.
 *
 *   - Only staff who may publish can block; a read-only member of staff is refused.
 *   - A reason is required.
 *   - Blocking takes the listing off the shelf, records the reason, writes an
 *     audit entry on BOTH trails and tells the seller.
 *   - The seller cannot resume, pause, archive or edit their way round it.
 *   - Lifting the block returns a listing that was on sale as PAUSED, so the
 *     seller's own resume checks run before it sells again.
 *   - Everything is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { ErrorCode } from '../../src/domain/errors.js';
import { Role } from '../../src/domain/permissions.js';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import { pauseForEdit } from '../../src/modules/seller/offer-edit.service.js';
import { setOfferStatus } from '../../src/modules/seller/offer.service.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PREFIX = 'sob-';
const STAFF_PASSWORD = 'OfferBlock!2026zz';
const IP = '203.0.113.141';
const EMAIL = { publisher: 'sob-publisher@test.local', reader: 'sob-reader@test.local' };
const ALL_EMAILS = Object.values(EMAIL);

let sellerId = '';
let productId = '';
let offerId = '';
let seller: SellerMembership;
let publisher: AdminSession;
let reader: AdminSession;

function call(
  session: AdminSession,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken, 'x-forwarded-for': IP },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const code = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { code: string } }>().error?.code;

async function createStaff(email: string, role: string): Promise<void> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: roleRow.id } },
    },
  });
}

async function cleanUp(): Promise<void> {
  const userIds = (
    await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccount: { slug: { startsWith: PREFIX } } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: { startsWith: PREFIX } } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: { startsWith: PREFIX } } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.productPrice.deleteMany({ where: { product: { slug: { startsWith: PREFIX } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}category` } });
  await prisma.taxClass.deleteMany({ where: { code: 'SOBTAX' } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const onShelf = async (): Promise<number> => prisma.productPrice.count({ where: { productId } });
const statusOf = async (): Promise<string> =>
  (await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerId } })).status;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  const currency = await getBaseCurrency();
  const taxClassId = newId();
  await prisma.taxClass.create({ data: { id: taxClassId, code: 'SOBTAX', name: 'Block', ratePercent: '18' } });
  const categoryId = newId();
  await prisma.category.create({ data: { id: categoryId, name: 'Block', slug: `${PREFIX}category`, isActive: true } });

  productId = newId();
  await prisma.product.create({
    data: {
      id: productId,
      categoryId,
      taxClassId,
      name: 'Blockable widget',
      slug: `${PREFIX}widget`,
      sku: 'SOB-1',
      basePriceMinor: 0n,
      currency,
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isMarketplaceProduct: true,
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });

  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      legalName: 'SOB Seller Ltd',
      displayName: 'SOB Seller',
      displayNameNormalized: 'sob seller',
      slug: `${PREFIX}seller`,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  seller = {
    sellerAccountId: sellerId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: 'SOB Seller',
    legalName: 'SOB Seller Ltd',
    slug: `${PREFIX}seller`,
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
    logoStorageKey: null,
  };

  offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId: sellerId,
      productId,
      variantKey: '',
      sellerSku: 'SOB-1',
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: 1_000n,
      currency,
      minimumOrderQuantity: 1,
      orderIncrement: 1,
      availableQuantity: 10,
    },
  });
  // Put it on the shelf the way a going-live does.
  await setOfferStatus(seller, offerId, 'PAUSED');
  await setOfferStatus(seller, offerId, 'ACTIVE');

  await createStaff(EMAIL.publisher, Role.BUSINESS_OWNER);
  await createStaff(EMAIL.reader, Role.ORDER_MANAGER);
  publisher = await signInAdmin(app, { email: EMAIL.publisher, password: STAFF_PASSWORD, ip: IP });
  reader = await signInAdmin(app, { email: EMAIL.reader, password: STAFF_PASSWORD, ip: IP });
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('blocking a live listing', () => {
  it('starts on the shelf', async () => {
    expect(await onShelf()).toBeGreaterThan(0);
  });

  it('refuses staff who may not publish, and a block with no reason', async () => {
    const denied = await call(reader, 'POST', `/admin/seller-offers/${offerId}/block`, { reason: 'Recall' });
    expect(denied.statusCode).toBe(403);

    const blank = await call(publisher, 'POST', `/admin/seller-offers/${offerId}/block`, { reason: '   ' });
    expect(blank.statusCode).toBe(400);
    const missing = await call(publisher, 'POST', `/admin/seller-offers/${offerId}/block`, {});
    expect(missing.statusCode).toBe(400);

    expect(await statusOf()).toBe('ACTIVE');
  });

  it('takes it off the shelf, keeps the reason, audits both trails and tells the seller', async () => {
    const response = await call(publisher, 'POST', `/admin/seller-offers/${offerId}/block`, {
      reason: 'Safety alert: batch recalled by the manufacturer.',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('BLOCKED');

    const offer = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.status).toBe('BLOCKED');
    expect(offer.blockedReason).toBe('Safety alert: batch recalled by the manufacturer.');
    expect(offer.statusReason).toBe('Safety alert: batch recalled by the manufacturer.');
    expect(offer.statusBeforeBlock).toBe('ACTIVE');
    expect(offer.blockedByUserId).not.toBeNull();
    expect(await onShelf()).toBe(0);

    expect(await prisma.auditLog.count({ where: { action: 'seller_offer.blocked', resourceId: offerId } })).toBe(1);
    expect(
      await prisma.sellerAuditLog.count({ where: { action: 'seller.offer.blocked', resourceId: offerId } }),
    ).toBe(1);
    const notice = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: sellerId, kind: 'LISTING_DECISION' },
    });
    expect(notice?.body).toContain('Safety alert');
  });

  it('shows it, with the reason, in the seller listing for staff', async () => {
    const list = await call(publisher, 'GET', `/admin/sellers/${sellerId}/offers?status=BLOCKED`);
    expect(list.statusCode, list.body).toBe(200);
    const body = list.json<{ total: number; rows: { id: string; status: string; blockedReason: string | null; priceMinor: string }[] }>();
    expect(body.total).toBe(1);
    expect(body.rows[0]).toMatchObject({ id: offerId, status: 'BLOCKED', priceMinor: '1000' });
    expect(body.rows[0]?.blockedReason).toContain('recalled');
  });

  it('cannot be blocked twice', async () => {
    const again = await call(publisher, 'POST', `/admin/seller-offers/${offerId}/block`, { reason: 'Again' });
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe(ErrorCode.LISTING_TRANSITION_NOT_ALLOWED);
  });

  it('cannot be resumed, paused, archived or opened for edit by the seller', async () => {
    for (const next of ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const) {
      await expect(setOfferStatus(seller, offerId, next)).rejects.toMatchObject({
        code: ErrorCode.LISTING_BLOCKED,
      });
    }
    await expect(pauseForEdit(seller, offerId)).rejects.toMatchObject({ code: ErrorCode.LISTING_BLOCKED });
    expect(await statusOf()).toBe('BLOCKED');
  });
});

describe('lifting a block', () => {
  it('refuses staff who may not publish', async () => {
    const denied = await call(reader, 'POST', `/admin/seller-offers/${offerId}/unblock`, {});
    expect(denied.statusCode).toBe(403);
    expect(await statusOf()).toBe('BLOCKED');
  });

  it('returns a listing that was on sale as PAUSED, off the shelf, and audits it', async () => {
    const response = await call(publisher, 'POST', `/admin/seller-offers/${offerId}/unblock`, {
      note: 'Manufacturer confirmed the batch is safe.',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('PAUSED');

    const offer = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.blockedReason).toBeNull();
    expect(offer.statusBeforeBlock).toBeNull();
    // Still not buyable: the seller resumes it, and the resume checks run.
    expect(await onShelf()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'seller_offer.unblocked', resourceId: offerId } })).toBe(1);

    await setOfferStatus(seller, offerId, 'ACTIVE');
    expect(await statusOf()).toBe('ACTIVE');
    expect(await onShelf()).toBeGreaterThan(0);
  });

  it('refuses to lift a listing that is not blocked', async () => {
    const response = await call(publisher, 'POST', `/admin/seller-offers/${offerId}/unblock`, {});
    expect(response.statusCode).toBe(409);
  });
});
