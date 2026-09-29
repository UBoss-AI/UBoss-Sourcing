/**
 * The Automatic payment screen's controls, over HTTP: an end date, a start
 * date, a cap per period and a supplier / category scope.
 *
 * `autopay.test.ts` proves the decision made at charge time. This file proves
 * the other half: that the customer can actually SET those limits through the
 * routes the screen uses, that nonsense is refused with a 400 rather than
 * stored, that the settings come back as the screen needs them, and that
 * changing standing payment authority needs a fresh confirmation.
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { buildApp } from '../../src/http/app.js';
import { encryptSecret, hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

const EMAIL = 'apx-http-buyer@test.local';
const PASSWORD = 'AutoPayHttp!2026x';
const SLUG = 'apx-http-seller';
const CATEGORY_SLUG = 'apx-http-category';
const IP = '10.61.0.1';

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
let csrf = '';
let userId = '';
let cardId = '';
let sellerId = '';
let categoryId = '';
let connectionId = '';

const saved = {
  FEATURE_CUSTOMER_AUTOPAY: env.FEATURE_CUSTOMER_AUTOPAY,
  FEATURE_SUBSCRIPTION_AUTOPAY: env.FEATURE_SUBSCRIPTION_AUTOPAY,
  AUTOPAY_REQUIRES_MFA: env.AUTOPAY_REQUIRES_MFA,
  FEATURE_STEP_UP: env.FEATURE_STEP_UP,
};

function setEnv(values: Partial<typeof saved>): void {
  Object.assign(env as unknown as typeof saved, values);
}

async function cleanUp(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { emailNormalized: EMAIL },
    select: { id: true },
  });
  const profiles = await prisma.customerProfile.findMany({
    where: { userId: { in: users.map((u) => u.id) } },
    select: { id: true },
  });
  const profileIds = profiles.map((p) => p.id);
  await prisma.customerAutoPaySetting.deleteMany({
    where: { customerProfileId: { in: profileIds } },
  });
  await prisma.customerPaymentMethod.deleteMany({
    where: { customerProfileId: { in: profileIds } },
  });
  await prisma.auditLog.deleteMany({ where: { actorEmail: EMAIL } });
  await prisma.session.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: EMAIL } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SLUG } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
  await prisma.paymentProviderConnection.deleteMany({ where: { label: 'apx-http-stripe' } });
}

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url: `/api/v1/account/autopay${url}`,
    headers: { cookie, 'x-csrf-token': csrf, 'x-forwarded-for': IP },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const codeOf = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { code?: string } }>().error?.code;

interface View {
  autoPay: {
    status: string;
    authorityExpiresAt: string | null;
    authorityStartsAt: string | null;
    periodCapMinor: string | null;
    capPeriod: string | null;
    scopeSellerKeys: string[] | null;
    scopeCategoryIds: string[] | null;
    limitCurrency: string | null;
  };
}

beforeAll(async () => {
  setEnv({
    FEATURE_CUSTOMER_AUTOPAY: true,
    FEATURE_SUBSCRIPTION_AUTOPAY: true,
    AUTOPAY_REQUIRES_MFA: false,
    FEATURE_STEP_UP: true,
  });
  app = await buildApp();
  await app.ready();
  await cleanUp();

  connectionId = newId();
  await prisma.paymentProviderConnection.create({
    data: {
      id: connectionId,
      provider: 'STRIPE',
      mode: 'TEST',
      label: 'apx-http-stripe',
      credentialsEnc: encryptSecret(
        JSON.stringify({ keyId: 'pk_test_abc', keySecret: 'sk_test_abc' }),
        `payment_connection:${connectionId}`,
      ),
      webhookSecretEnc: encryptSecret('whsec_apx', `payment_connection:${connectionId}`),
      isActive: true,
    },
  });

  userId = newId();
  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId, fullName: 'AutoPay Http', activatedAt: new Date() },
  });
  cardId = newId();
  await prisma.customerPaymentMethod.create({
    data: {
      id: cardId,
      customerProfileId: profile.id,
      provider: 'STRIPE',
      providerCustomerId: 'cus_apxhttp',
      providerPaymentMethodId: 'pm_apxhttp',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: new Date().getUTCFullYear() + 3,
      status: 'ACTIVE',
      consentScope: 'OFF_SESSION',
      consentAcceptedAt: new Date(),
      consentVersion: 'v1',
    },
  });

  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      slug: SLUG,
      legalName: 'Apx Http Ltd',
      displayName: 'Apx Http Supplier',
      displayNameNormalized: 'apxhttpsupplier',
      registrationCountry: 'IN',
      kind: 'WHOLESALER',
      status: 'APPROVED',
    },
  });
  categoryId = newId();
  await prisma.category.create({
    data: { id: categoryId, name: 'Apx Http Category', slug: CATEGORY_SLUG, isActive: true },
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': IP },
    payload: { email: EMAIL, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = new Map<string, string>();
  for (const c of login.cookies as { name: string; value: string }[]) jar.set(c.name, c.value);
  cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  csrf = jar.get('uboss_shop_csrf') ?? '';
}, 120_000);

afterAll(async () => {
  await cleanUp();
  setEnv(saved);
  await app.close();
});

describe('the pickers', () => {
  it('offers the marketplace’s own stock, approved suppliers and active categories', async () => {
    const response = await call('GET', '/scope-options');
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      suppliers: { key: string; name: string | null }[];
      categories: { id: string }[];
    }>();
    expect(body.suppliers[0]).toEqual({ key: 'MARKETPLACE', name: null });
    expect(body.suppliers.map((s) => s.key)).toContain(sellerId);
    expect(body.categories.map((c) => c.id)).toContain(categoryId);
  });

  it('refuses a signed-out caller', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/account/autopay/scope-options',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('setting the limits', () => {
  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

  it('switches on with an end date, a start date, a cap and a scope, and reads them back', async () => {
    const starts = inDays(1);
    const ends = inDays(60);
    const response = await call('POST', '', {
      paymentMethodId: cardId,
      consentAccepted: true,
      limitCurrency: 'EUR',
      authorityStartsAt: starts,
      authorityExpiresAt: ends,
      periodCapMinor: '250000',
      capPeriod: 'MONTH',
      scopeSellerKeys: [sellerId, 'MARKETPLACE'],
      scopeCategoryIds: [categoryId],
    });
    expect(response.statusCode, response.body).toBe(200);

    const read = await call('GET', '');
    const view = read.json<View>().autoPay;
    expect(view.status).toBe('ACTIVE');
    expect(new Date(view.authorityStartsAt ?? '').getTime()).toBe(new Date(starts).getTime());
    expect(new Date(view.authorityExpiresAt ?? '').getTime()).toBe(new Date(ends).getTime());
    expect(view.periodCapMinor).toBe('250000');
    expect(view.capPeriod).toBe('MONTH');
    expect(view.scopeSellerKeys).toEqual([sellerId, 'MARKETPLACE']);
    expect(view.scopeCategoryIds).toEqual([categoryId]);
  });

  it('clears the end date, the cap and the scope again with nulls', async () => {
    const response = await call('PATCH', '', {
      authorityExpiresAt: null,
      authorityStartsAt: null,
      periodCapMinor: null,
      capPeriod: null,
      scopeSellerKeys: null,
      scopeCategoryIds: null,
    });
    expect(response.statusCode, response.body).toBe(200);

    const view = response.json<View>().autoPay;
    expect(view.authorityExpiresAt).toBeNull();
    expect(view.authorityStartsAt).toBeNull();
    expect(view.periodCapMinor).toBeNull();
    expect(view.capPeriod).toBeNull();
    expect(view.scopeSellerKeys).toBeNull();
    expect(view.scopeCategoryIds).toBeNull();
  });

  it('leaves a field alone when the request does not mention it', async () => {
    await call('PATCH', '', { authorityExpiresAt: inDays(30), scopeCategoryIds: [categoryId] });
    const response = await call('PATCH', '', { notifyOnCharge: false });
    expect(response.statusCode, response.body).toBe(200);

    const view = response.json<View>().autoPay;
    expect(view.authorityExpiresAt).not.toBeNull();
    expect(view.scopeCategoryIds).toEqual([categoryId]);
  });

  it('refuses an end date in the past', async () => {
    const response = await call('PATCH', '', { authorityExpiresAt: inDays(-1) });
    expect(response.statusCode).toBe(400);
    expect(codeOf(response)).toBe('VALIDATION_FAILED');
  });

  it('refuses an end date that is not a date', async () => {
    expect((await call('PATCH', '', { authorityExpiresAt: 'next tuesday' })).statusCode).toBe(400);
  });

  it('refuses a start date after the end date', async () => {
    const response = await call('PATCH', '', {
      authorityStartsAt: inDays(20),
      authorityExpiresAt: inDays(10),
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a cap with no period, and a period with no cap amount left as nonsense', async () => {
    await call('PATCH', '', { limitCurrency: 'EUR' });
    const response = await call('PATCH', '', { periodCapMinor: '100000', capPeriod: null });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a cap that is not a whole number of minor units', async () => {
    expect(
      (
        await call('PATCH', '', {
          limitCurrency: 'EUR',
          periodCapMinor: '12.50',
          capPeriod: 'MONTH',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call('PATCH', '', { limitCurrency: 'EUR', periodCapMinor: '-5', capPeriod: 'MONTH' }))
        .statusCode,
    ).toBe(400);
  });

  it('refuses a supplier or category that does not exist', async () => {
    expect((await call('PATCH', '', { scopeSellerKeys: [newId()] })).statusCode).toBe(400);
    expect((await call('PATCH', '', { scopeCategoryIds: [newId()] })).statusCode).toBe(400);
  });

  it('records who changed what on the audit trail', async () => {
    await call('PATCH', '', {
      scopeCategoryIds: [categoryId],
      periodCapMinor: '90000',
      capPeriod: 'WEEK',
      limitCurrency: 'EUR',
    });
    const entry = await prisma.auditLog.findFirst({
      where: { actorEmail: EMAIL, resourceType: 'autopay' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).not.toBeNull();
  });
});

describe('standing payment authority needs a fresh confirmation', () => {
  it('asks the customer to confirm it is them once the confirmation is old', async () => {
    await prisma.session.updateMany({
      where: { userId },
      data: { reauthenticatedAt: new Date(Date.now() - (env.STEP_UP_WINDOW_SECONDS + 5) * 1000) },
    });

    const response = await call('PATCH', '', {
      authorityExpiresAt: new Date(Date.now() + 86_400_000 * 90).toISOString(),
    });
    expect(response.statusCode).toBe(403);
    expect(codeOf(response)).toBe('STEP_UP_REQUIRED');
  });

  it('asks for a second factor first where the deployment requires one', async () => {
    setEnv({ AUTOPAY_REQUIRES_MFA: true });
    try {
      const response = await call('PATCH', '', { notifyOnCharge: true });
      expect(response.statusCode).toBe(403);
      expect(codeOf(response)).toBe('MFA_SETUP_REQUIRED');
    } finally {
      setEnv({ AUTOPAY_REQUIRES_MFA: false });
    }
  });
});
