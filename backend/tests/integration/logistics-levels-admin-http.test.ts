/**
 * Who in the marketplace's own staff may do what with the four levels and the
 * platform fee - over HTTP, with real signed-in sessions, because these are
 * properties of the ROUTES.
 *
 *   - an order manager (logistics read and assign, no finance) cannot read or
 *     change a platform fee, and cannot price a UBOSS level - pricing is a
 *     contract decision (`logistics.write`), not daily dispatch;
 *   - a finance approver drafts, publishes and verifies a fee policy, and is
 *     the only one of the three who can;
 *   - a catalogue manager reaches none of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { signInAdmin } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const DOMAIN = '@levels-http.test.local';
const FINANCE = { email: `finance${DOMAIN}`, password: 'LevelsFinance!2026' };
const ORDERS = { email: `orders${DOMAIN}`, password: 'LevelsOrders!2026' };
const CATALOG = { email: `catalog${DOMAIN}`, password: 'LevelsCatalog!2026' };
const SELLER_SLUG = 'lvl-http-seller';

let finance = { cookies: '', csrfToken: '' };
let orders = { cookies: '', csrfToken: '' };
let catalog = { cookies: '', csrfToken: '' };
let sellerId = '';

async function cleanUp(): Promise<void> {
  const sellers = (await prisma.sellerAccount.findMany({ where: { slug: SELLER_SLUG }, select: { id: true } })).map((row) => row.id);
  const policies = (await prisma.platformFeePolicy.findMany({ where: { sellerAccountId: { in: sellers } }, select: { id: true } })).map(
    (row) => row.id,
  );
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: policies } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ resourceId: { in: policies } }, { actorEmail: { endsWith: DOMAIN } }] } });
  await prisma.platformFeePolicy.deleteMany({ where: { id: { in: policies } } });
  await prisma.sellerLogisticsPolicy.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { endsWith: DOMAIN } } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { endsWith: DOMAIN } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { endsWith: DOMAIN } } });
}

async function makeStaff(email: string, password: string, roleKey: string): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey }, select: { id: true } });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(password),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });
}

function call(
  session: { cookies: string; csrfToken: string },
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url: `/api/v1/admin${url}`,
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  await makeStaff(FINANCE.email, FINANCE.password, Role.FINANCE_APPROVER);
  await makeStaff(ORDERS.email, ORDERS.password, Role.ORDER_MANAGER);
  await makeStaff(CATALOG.email, CATALOG.password, Role.CATALOG_MANAGER);

  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      slug: SELLER_SLUG,
      legalName: 'Levels HTTP Ltd',
      displayName: 'Levels HTTP',
      displayNameNormalized: 'levelshttp',
      registrationCountry: 'IN',
      kind: 'MANUFACTURER',
      status: 'APPROVED',
    },
  });

  finance = await signInAdmin(app, { ...FINANCE, ip: '10.91.0.1' });
  orders = await signInAdmin(app, { ...ORDERS, ip: '10.91.0.2' });
  catalog = await signInAdmin(app, { ...CATALOG, ip: '10.91.0.3' });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

const DRAFT = {
  scope: 'SELLER',
  name: 'HTTP fixture',
  feeType: 'PERCENT',
  feeBasis: 'PRODUCT_SUBTOTAL',
  percentRate: '10',
  currency: 'INR',
  taxRatePercent: '15',
};

describe('platform fees are finance’s alone', () => {
  it('refuses an order manager and a catalogue manager, reading or writing', async () => {
    for (const session of [orders, catalog]) {
      expect((await call(session, 'GET', '/platform-fees')).statusCode).toBe(403);
      expect((await call(session, 'POST', '/platform-fees', { ...DRAFT, sellerAccountId: sellerId })).statusCode).toBe(403);
    }
  });

  it('lets finance draft, publish and verify, and says "configured" until it is verified', async () => {
    const created = await call(finance, 'POST', '/platform-fees', { ...DRAFT, sellerAccountId: sellerId });
    expect(created.statusCode).toBe(201);
    const policyId = created.json<{ policy: { id: string } }>().policy.id;

    const published = await call(finance, 'POST', `/platform-fees/${policyId}/publish`);
    expect(published.statusCode).toBe(200);
    const view = published.json<{ policy: { isTaxRuleVerified: boolean; taxDisplayLabel: string } }>().policy;
    expect(view.isTaxRuleVerified).toBe(false);
    expect(view.taxDisplayLabel).toBe('Tax on platform fee - configured 15%');

    // A published policy is never edited.
    const edit = await call(finance, 'PUT', `/platform-fees/${policyId}`, { ...DRAFT, sellerAccountId: sellerId, percentRate: '12' });
    expect(edit.statusCode).toBe(409);

    // An order manager cannot verify a tax rule either.
    expect((await call(orders, 'POST', `/platform-fees/${policyId}/verify-tax`, { note: 'Checked with the tax advisor.' })).statusCode).toBe(403);

    const verified = await call(finance, 'POST', `/platform-fees/${policyId}/verify-tax`, {
      note: 'Checked with the tax advisor on 2026-09-24.',
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json<{ policy: { isTaxRuleVerified: boolean } }>().policy.isTaxRuleVerified).toBe(true);
  });
});

describe('UBOSS-managed levels', () => {
  it('lets an order manager read them, and not price them', async () => {
    expect((await call(orders, 'GET', '/logistics/managed-levels')).statusCode).toBe(200);
    const priced = await call(orders, 'POST', `/logistics/managed-levels/sellers/${sellerId}/rates`, {
      level: 'L2',
      transportMode: 'AIR',
      provider: 'DHL',
      amountMinor: '1000',
    });
    expect(priced.statusCode).toBe(403);
  });

  it('keeps a catalogue manager out entirely', async () => {
    expect((await call(catalog, 'GET', '/logistics/managed-levels')).statusCode).toBe(403);
    expect((await call(catalog, 'GET', '/logistics/legs')).statusCode).toBe(403);
  });
});
