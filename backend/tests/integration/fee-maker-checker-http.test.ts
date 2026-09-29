/**
 * Fee policies and fee rules are approved by somebody other than their maker.
 *
 * Both change what every seller is charged, so the person who drafted or
 * submitted one can never be the person who approves it. The rule lives in
 * `assertIndependentApprover`; this file proves it holds at the HTTP door, with
 * two real finance sessions, and that the refusal carries its published code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { signInAdmin } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const DOMAIN = '@fee-mc.test.local';
const MAKER = { email: `maker${DOMAIN}`, password: 'FeeMaker!2026xx' };
const CHECKER = { email: `checker${DOMAIN}`, password: 'FeeChecker!2026xx' };
const SELLER_SLUG = 'fee-mc-seller';
const RULE_NAME = 'fee-mc tier rule';

let maker = { cookies: '', csrfToken: '' };
let checker = { cookies: '', csrfToken: '' };
let sellerId = '';

async function cleanUp(): Promise<void> {
  const sellers = (
    await prisma.sellerAccount.findMany({ where: { slug: SELLER_SLUG }, select: { id: true } })
  ).map((r) => r.id);
  const policies = (
    await prisma.platformFeePolicy.findMany({
      where: { sellerAccountId: { in: sellers } },
      select: { id: true },
    })
  ).map((r) => r.id);
  const rules = (
    await prisma.platformFeeRule.findMany({ where: { name: RULE_NAME }, select: { id: true } })
  ).map((r) => r.id);
  await prisma.adminNotification.deleteMany({
    where: { relatedId: { in: [...policies, ...rules] } },
  });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [{ resourceId: { in: [...policies, ...rules] } }, { actorEmail: { endsWith: DOMAIN } }],
    },
  });
  await prisma.platformFeePolicy.deleteMany({ where: { id: { in: policies } } });
  await prisma.platformFeeRule.deleteMany({ where: { id: { in: rules } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { endsWith: DOMAIN } } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { endsWith: DOMAIN } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { endsWith: DOMAIN } } });
}

async function makeFinance(who: { email: string; password: string }): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { key: Role.FINANCE_APPROVER },
    select: { id: true },
  });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: who.email,
      emailNormalized: who.email,
      passwordHash: await hashPassword(who.password),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });
}

function call(
  session: { cookies: string; csrfToken: string },
  method: 'GET' | 'POST',
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

const errorCode = (response: { json: () => unknown }): string | undefined =>
  (response.json() as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  await makeFinance(MAKER);
  await makeFinance(CHECKER);
  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      slug: SELLER_SLUG,
      legalName: 'Fee MC Ltd',
      displayName: 'Fee MC',
      displayNameNormalized: 'feemc',
      registrationCountry: 'IN',
      kind: 'MANUFACTURER',
      status: 'APPROVED',
    },
  });
  maker = await signInAdmin(app, { ...MAKER, ip: '10.98.0.1' });
  checker = await signInAdmin(app, { ...CHECKER, ip: '10.98.0.2' });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('a platform fee policy', () => {
  it('cannot be approved by the person who drafted and submitted it, and can by a colleague', async () => {
    const created = await call(maker, 'POST', '/platform-fees', {
      scope: 'SELLER',
      sellerAccountId: sellerId,
      name: 'fee-mc policy',
      feeType: 'PERCENT',
      percentRate: '10',
      currency: 'INR',
      taxRatePercent: '15',
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ policy: { id: string } }>().policy.id;
    expect((await call(maker, 'POST', `/platform-fees/${id}/submit`)).statusCode).toBe(200);

    const self = await call(maker, 'POST', `/platform-fees/${id}/publish`);
    expect(self.statusCode).toBe(403);
    expect(errorCode(self)).toBe('PLATFORM_FEE_SELF_APPROVAL_FORBIDDEN');
    expect((await prisma.platformFeePolicy.findUniqueOrThrow({ where: { id } })).status).toBe(
      'PENDING_APPROVAL',
    );

    const other = await call(checker, 'POST', `/platform-fees/${id}/publish`);
    expect(other.statusCode, other.body).toBe(200);
    expect((await prisma.platformFeePolicy.findUniqueOrThrow({ where: { id } })).status).toBe(
      'PUBLISHED',
    );
  });
});

describe('a platform fee rule', () => {
  it('cannot be approved by the person who drafted and submitted it, and can by a colleague', async () => {
    const created = await call(maker, 'POST', '/platform-fee-rules', {
      kind: 'SELLER_TIER',
      scope: 'GLOBAL',
      name: RULE_NAME,
      sellerTier: 'GOLD',
      percentRate: '8',
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ rule: { id: string } }>().rule.id;
    expect((await call(maker, 'POST', `/platform-fee-rules/${id}/submit`)).statusCode).toBe(200);

    const self = await call(maker, 'POST', `/platform-fee-rules/${id}/approve`);
    expect(self.statusCode).toBe(403);
    expect(errorCode(self)).toBe('PLATFORM_FEE_SELF_APPROVAL_FORBIDDEN');
    expect((await prisma.platformFeeRule.findUniqueOrThrow({ where: { id } })).status).toBe(
      'PENDING_APPROVAL',
    );

    const other = await call(checker, 'POST', `/platform-fee-rules/${id}/approve`);
    expect(other.statusCode, other.body).toBe(200);
    expect((await prisma.platformFeeRule.findUniqueOrThrow({ where: { id } })).status).toBe(
      'PUBLISHED',
    );
  });

  it('cannot be approved before it has been submitted', async () => {
    const created = await call(maker, 'POST', '/platform-fee-rules', {
      kind: 'SELLER_TIER',
      scope: 'GLOBAL',
      name: RULE_NAME,
      sellerTier: 'SILVER',
      percentRate: '9',
    });
    const id = created.json<{ rule: { id: string } }>().rule.id;
    const response = await call(checker, 'POST', `/platform-fee-rules/${id}/approve`);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('PLATFORM_FEE_NOT_PENDING_APPROVAL');
  });
});
