/**
 * Commission and fee rules: seller tiers and "no retroactive surprise"
 * (checklist JOURNEY-054).
 *
 *   - placing a seller in a fee tier is finance-only, needs a reason of ten
 *     characters or more, and is on the audit trail;
 *   - finance can find a seller by name to place them in a tier;
 *   - approving a draft whose start date is already past publishes it from
 *     the approval instant, never from the past date;
 *   - an order settled before the rule existed keeps its fee, with no record
 *     that the rule touched it;
 *   - Seller Hub's read-only list shows the seller the live and the upcoming
 *     rules that can change their fee, and never another seller's own rule.
 *
 * Everything is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';
import { sellerFeeRules } from '../../src/modules/settings/platform-fee-rule.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PREFIX = 'FTNR-HTTP';
const SLUG = 'ftnr-http-';
const PASSWORD = 'FeeTiers!2026zzz';
const IP = '10.90.54.1';
const BUYER_EMAIL = 'ftnr-buyer@test.local';
const EMAIL = {
  maker: 'ftnr-maker@test.local',
  checker: 'ftnr-checker@test.local',
  desk: 'ftnr-desk@test.local',
};
const ALL_EMAILS = Object.values(EMAIL);

let maker: AdminSession;
let checker: AdminSession;
let desk: AdminSession;
let currency = 'INR';
let sellerId = '';
let otherSellerId = '';
let settlementId = '';

function call(
  session: AdminSession,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url: `/api/v1/admin${url}`,
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken, 'x-forwarded-for': IP },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function createStaff(email: string, role: string): Promise<void> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: roleRow.id } },
    },
  });
}

async function createSeller(name: string): Promise<string> {
  const id = newId();
  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${PREFIX} ${name} Ltd`,
      displayName: `${PREFIX} ${name}`,
      displayNameNormalized: `${PREFIX} ${name}`.toLowerCase(),
      slug: `${SLUG}${name.toLowerCase()}-${id.slice(-6).toLowerCase()}`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  return id;
}

/** A seller order whose fee was worked out yesterday, before any rule below. */
async function settledYesterday(seller: string): Promise<string> {
  const user = await prisma.user.create({
    data: { id: newId(), type: 'CUSTOMER', email: BUYER_EMAIL, emailNormalized: BUYER_EMAIL, status: 'ACTIVE' },
  });
  const profileId = newId();
  await prisma.customerProfile.create({ data: { id: profileId, userId: user.id, fullName: 'Fee Tier Buyer' } });
  const orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `${PREFIX}-${orderId.slice(-6)}`,
      customerProfileId: profileId,
      status: 'CONFIRMED',
      currency,
      subtotalMinor: 100_000n,
      grandTotalMinor: 100_000n,
      billingAddressJson: { line1: '1 Road', city: 'Pune', postalCode: '411001', country: 'IN' },
      shippingAddressJson: { line1: '1 Road', city: 'Pune', postalCode: '411001', country: 'IN' },
      placedAt: new Date(Date.now() - 86_400_000),
    },
  });
  const groupId = newId();
  await prisma.sellerOrderGroup.create({
    data: {
      id: groupId,
      sellerAccountId: seller,
      orderId,
      sellerOrderNumber: `SO-${orderId.slice(-6)}`,
      status: 'NEW',
      goodsTotalMinor: 100_000n,
      commissionMinor: 10_000n,
      currency,
    },
  });
  const id = newId();
  await prisma.sellerOrderSettlement.create({
    data: {
      id,
      sellerOrderGroupId: groupId,
      sellerAccountId: seller,
      currency,
      grossProceedsMinor: 100_000n,
      feeBasisMinor: 100_000n,
      platformFeeMinor: 10_000n,
      platformFeeTaxMinor: 1_800n,
      estimatedSettlementMinor: 88_200n,
      feeTaxRatePercent: '18.000000',
      feeTaxLabel: 'GST',
      breakdownJson: [],
      computedAt: new Date(Date.now() - 86_400_000),
    },
  });
  return id;
}

async function cleanUp(): Promise<void> {
  const userIds = (
    await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })
  ).map((row) => row.id);
  const sellers = (
    await prisma.sellerAccount.findMany({ where: { slug: { startsWith: SLUG } }, select: { id: true } })
  ).map((row) => row.id);
  const ruleIds = (
    await prisma.platformFeeRule.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.platformFeeRuleApplication.deleteMany({ where: { ruleId: { in: ruleIds } } });
  await prisma.platformFeeRule.updateMany({ where: { id: { in: ruleIds } }, data: { supersedesRuleId: null } });
  await prisma.platformFeeRule.deleteMany({ where: { id: { in: ruleIds } } });
  await prisma.sellerOrderSettlement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: PREFIX } } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: BUYER_EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: BUYER_EMAIL } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ actorUserId: { in: userIds } }, { resourceId: { in: [...ruleIds, ...sellers] } }] },
  });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  currency = (await getBaseCurrency()).toString();
  await createStaff(EMAIL.maker, Role.FINANCE_APPROVER);
  await createStaff(EMAIL.checker, Role.BUSINESS_OWNER);
  await createStaff(EMAIL.desk, Role.ORDER_MANAGER);
  maker = await signInAdmin(app, { email: EMAIL.maker, password: PASSWORD, ip: IP });
  checker = await signInAdmin(app, { email: EMAIL.checker, password: PASSWORD, ip: IP });
  desk = await signInAdmin(app, { email: EMAIL.desk, password: PASSWORD, ip: IP });
  sellerId = await createSeller('Gold');
  otherSellerId = await createSeller('Other');
  settlementId = await settledYesterday(sellerId);
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('seller fee tiers', () => {
  it('are closed to staff outside finance', async () => {
    expect((await call(desk, 'GET', '/seller-fee-tiers')).statusCode).toBe(403);
    expect(
      (await call(desk, 'PUT', `/seller-fee-tiers/${sellerId}`, { tier: 'GOLD', reason: 'Moved up after review.' })).statusCode,
    ).toBe(403);
  });

  it('need a reason of at least ten characters', async () => {
    const short = await call(maker, 'PUT', `/seller-fee-tiers/${sellerId}`, { tier: 'GOLD', reason: 'because' });
    expect(short.statusCode).toBe(400);
    const row = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: sellerId }, select: { feeTier: true } });
    expect(row.feeTier).toBeNull();
  });

  it('find a seller by name, place them in a tier, and audit it with the reason', async () => {
    const found = await call(maker, 'GET', `/seller-fee-tiers?q=${encodeURIComponent(`${PREFIX} Gold`)}`);
    expect(found.statusCode).toBe(200);
    expect(found.json<{ sellers: { sellerAccountId: string }[] }>().sellers.map((row) => row.sellerAccountId)).toContain(sellerId);

    const set = await call(maker, 'PUT', `/seller-fee-tiers/${sellerId}`, {
      tier: 'gold',
      reason: 'Twelve months of on-time dispatch.',
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json<{ feeTier: string }>().feeTier).toBe('GOLD');

    const list = await call(checker, 'GET', '/seller-fee-tiers');
    expect(list.json<{ sellers: { sellerAccountId: string; feeTier: string }[] }>().sellers).toContainEqual(
      expect.objectContaining({ sellerAccountId: sellerId, feeTier: 'GOLD' }),
    );

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'seller.fee_tier_changed', resourceId: sellerId },
    });
    expect(audit.afterJson).toMatchObject({ feeTier: 'GOLD', reason: 'Twelve months of on-time dispatch.' });
  });
});

describe('no retroactive surprise', () => {
  let ruleId = '';

  it('publishes a rule whose start date has passed from the approval instant', async () => {
    const created = await call(maker, 'POST', '/platform-fee-rules', {
      kind: 'SELLER_TIER',
      scope: 'GLOBAL',
      name: `${PREFIX} gold tier`,
      sellerTier: 'GOLD',
      percentRate: '5',
      effectiveFrom: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    });
    expect(created.statusCode, created.body).toBe(201);
    ruleId = created.json<{ rule: { id: string } }>().rule.id;
    await call(maker, 'POST', `/platform-fee-rules/${ruleId}/submit`);

    const before = Date.now();
    const approved = await call(checker, 'POST', `/platform-fee-rules/${ruleId}/approve`);
    expect(approved.statusCode, approved.body).toBe(200);

    const row = await prisma.platformFeeRule.findUniqueOrThrow({ where: { id: ruleId } });
    expect(row.status).toBe('PUBLISHED');
    // Never the week-old date it was drafted with.
    expect(row.effectiveFrom.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row.effectiveFrom.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('leaves an order settled before the rule with its fee, and no record the rule touched it', async () => {
    const settlement = await prisma.sellerOrderSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(settlement.platformFeeMinor).toBe(10_000n);
    expect(settlement.estimatedSettlementMinor).toBe(88_200n);
    expect(await prisma.platformFeeRuleApplication.count({ where: { ruleId } })).toBe(0);
    expect(await prisma.platformFeeRuleApplication.count({ where: { settlementId } })).toBe(0);
  });

  it("shows the seller live and upcoming rules that affect them, never another seller's own", async () => {
    // An upcoming rule, published with a start next month.
    const upcoming = await call(maker, 'POST', '/platform-fee-rules', {
      kind: 'VALUE_BAND',
      scope: 'GLOBAL',
      name: `${PREFIX} upcoming band`,
      currency,
      minValueMinor: '10000000',
      percentRate: '3',
      effectiveFrom: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const upcomingId = upcoming.json<{ rule: { id: string } }>().rule.id;
    await call(maker, 'POST', `/platform-fee-rules/${upcomingId}/submit`);
    expect((await call(checker, 'POST', `/platform-fee-rules/${upcomingId}/approve`)).statusCode).toBe(200);

    // Another seller's own promotion.
    const theirs = await call(maker, 'POST', '/platform-fee-rules', {
      kind: 'PROMOTION',
      scope: 'SELLER',
      sellerAccountId: otherSellerId,
      name: `${PREFIX} their promotion`,
      discountPercent: '20',
      effectiveTo: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    });
    const theirsId = theirs.json<{ rule: { id: string } }>().rule.id;
    await call(maker, 'POST', `/platform-fee-rules/${theirsId}/submit`);
    expect((await call(checker, 'POST', `/platform-fee-rules/${theirsId}/approve`)).statusCode).toBe(200);

    const view = await sellerFeeRules(sellerId);
    expect(view.feeTier).toBe('GOLD');
    const byId = new Map(view.rules.map((rule) => [rule.id, rule]));
    expect(byId.get(ruleId)?.upcoming).toBe(false);
    expect(byId.get(upcomingId)?.upcoming).toBe(true);
    expect(byId.has(theirsId)).toBe(false);

    // The other seller is in no tier, so the gold-tier rule is not theirs.
    const other = await sellerFeeRules(otherSellerId);
    expect(other.rules.map((rule) => rule.id)).toContain(theirsId);
    expect(other.rules.map((rule) => rule.id)).not.toContain(ruleId);
  });
});
