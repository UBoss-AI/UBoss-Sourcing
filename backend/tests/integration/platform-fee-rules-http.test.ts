/**
 * Fee rule routes over HTTP, and the maker-checker around them
 * (checklist SCREEN-068).
 *
 *   - only finance staff may read or write rules;
 *   - a bad rule is refused naming the field;
 *   - whoever created, edited or submitted a rule cannot approve it;
 *   - a different member of finance staff publishes it;
 *   - a rule sent back needs a reason and returns to draft with it;
 *   - a published rule is never edited; a replacement retires it when approved;
 *   - every step is on the audit trail.
 * Everything is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { ErrorCode } from '../../src/domain/errors.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PREFIX = 'PFR-HTTP';
const PASSWORD = 'FeeRules!2026zzz';
const IP = '203.0.113.151';
const EMAIL = {
  maker: 'pfr-maker@test.local',
  checker: 'pfr-checker@test.local',
  desk: 'pfr-desk@test.local',
};
const ALL_EMAILS = Object.values(EMAIL);

let maker: AdminSession;
let checker: AdminSession;
let desk: AdminSession;
let currency = 'INR';

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

interface Rule {
  id: string;
  status: string;
  name: string;
  rejectionReason: string | null;
  supersedesRuleId: string | null;
  createdByUserId: string | null;
  submittedByUserId: string | null;
  publishedByUserId: string | null;
  percentRate: string | null;
}
const ruleOf = (response: LightMyRequestResponse): Rule => response.json<{ rule: Rule }>().rule;
const code = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { code: string } }>().error?.code;

const BAND = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'VALUE_BAND',
  scope: 'GLOBAL',
  name: `${PREFIX} ${name}`,
  currency,
  minValueMinor: '10000000',
  percentRate: '4',
  ...extra,
});

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

async function cleanUp(): Promise<void> {
  const userIds = (
    await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })
  ).map((row) => row.id);
  const rules = await prisma.platformFeeRule.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ruleIds = rules.map((row) => row.id);
  await prisma.platformFeeRule.updateMany({ where: { id: { in: ruleIds } }, data: { supersedesRuleId: null } });
  await prisma.platformFeeRule.deleteMany({ where: { id: { in: ruleIds } } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ actorUserId: { in: userIds } }, { resourceId: { in: ruleIds } }] },
  });
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
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

let first: Rule;
let second: Rule;
let replacement: Rule;

describe('fee rule routes', () => {
  it('are closed to staff outside finance', async () => {
    expect((await call(desk, 'GET', '/platform-fee-rules')).statusCode).toBe(403);
    expect((await call(desk, 'POST', '/platform-fee-rules', BAND('desk'))).statusCode).toBe(403);
  });

  it('refuse a bad rule, naming the field', async () => {
    const noBound = await call(maker, 'POST', '/platform-fee-rules', BAND('bad', { minValueMinor: null }));
    expect(noBound.statusCode).toBe(400);
    expect(code(noBound)).toBe(ErrorCode.PLATFORM_FEE_RULE_INVALID);
    expect(noBound.json<{ error: { details: { field: string }[] } }>().error.details[0]?.field).toBe(
      'minValueMinor',
    );

    const badRate = await call(maker, 'POST', '/platform-fee-rules', BAND('bad', { percentRate: '250' }));
    expect(badRate.statusCode).toBe(400);
    expect(code(badRate)).toBe(ErrorCode.PLATFORM_FEE_RULE_INVALID);

    const noEnd = await call(maker, 'POST', '/platform-fee-rules', {
      kind: 'PROMOTION',
      scope: 'GLOBAL',
      name: `${PREFIX} promo`,
      discountPercent: '20',
    });
    expect(noEnd.statusCode).toBe(400);
    expect(noEnd.json<{ error: { details: { field: string }[] } }>().error.details[0]?.field).toBe('effectiveTo');
  });

  it('create a draft that changes nothing yet', async () => {
    const created = await call(maker, 'POST', '/platform-fee-rules', BAND('first'));
    expect(created.statusCode, created.body).toBe(201);
    first = ruleOf(created);
    expect(first.status).toBe('DRAFT');
    expect(first.percentRate).toBe('4');

    const list = await call(checker, 'GET', '/platform-fee-rules?status=PUBLISHED');
    const published = list.json<{ rules: Rule[] }>().rules.map((row) => row.id);
    expect(published).not.toContain(first.id);
  });

  it('let the maker edit a draft, then submit it', async () => {
    const edited = await call(maker, 'PUT', `/platform-fee-rules/${first.id}`, BAND('first', { percentRate: '3.5' }));
    expect(edited.statusCode, edited.body).toBe(200);
    expect(ruleOf(edited).percentRate).toBe('3.5');

    const submitted = await call(maker, 'POST', `/platform-fee-rules/${first.id}/submit`);
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(ruleOf(submitted).status).toBe('PENDING_APPROVAL');
    expect(ruleOf(submitted).submittedByUserId).toBe(first.createdByUserId);
  });

  it('never let the maker approve their own rule', async () => {
    const self = await call(maker, 'POST', `/platform-fee-rules/${first.id}/approve`);
    expect(self.statusCode).toBe(403);
    expect(code(self)).toBe(ErrorCode.PLATFORM_FEE_SELF_APPROVAL_FORBIDDEN);
    const row = await prisma.platformFeeRule.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.status).toBe('PENDING_APPROVAL');
  });

  it('let a different member of finance staff publish it', async () => {
    const approved = await call(checker, 'POST', `/platform-fee-rules/${first.id}/approve`);
    expect(approved.statusCode, approved.body).toBe(200);
    const rule = ruleOf(approved);
    expect(rule.status).toBe('PUBLISHED');
    expect(rule.publishedByUserId).not.toBeNull();
    expect(rule.publishedByUserId).not.toBe(rule.createdByUserId);

    // Approving twice is harmless: the second call changes nothing.
    const again = await call(checker, 'POST', `/platform-fee-rules/${first.id}/approve`);
    expect(again.statusCode).toBe(200);
    expect(ruleOf(again).status).toBe('PUBLISHED');
  });

  it('never edit a published rule', async () => {
    const edit = await call(maker, 'PUT', `/platform-fee-rules/${first.id}`, BAND('first', { percentRate: '9' }));
    expect(edit.statusCode).toBeGreaterThanOrEqual(400);
    const row = await prisma.platformFeeRule.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.percentRate?.toString()).toBe('3.5');
  });

  it('send a rule back to draft only with a reason, and keep the reason', async () => {
    second = ruleOf(await call(maker, 'POST', '/platform-fee-rules', BAND('second', { minValueMinor: '500000', maxValueMinor: '900000' })));
    await call(maker, 'POST', `/platform-fee-rules/${second.id}/submit`);

    const short = await call(checker, 'POST', `/platform-fee-rules/${second.id}/reject`, { reason: 'no' });
    expect(short.statusCode).toBe(400);

    const sent = await call(checker, 'POST', `/platform-fee-rules/${second.id}/reject`, {
      reason: 'The band overlaps the live one.',
    });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(ruleOf(sent).status).toBe('DRAFT');
    expect(ruleOf(sent).rejectionReason).toBe('The band overlaps the live one.');

    // Back in draft it is not waiting for anyone, so there is nothing to approve.
    const early = await call(checker, 'POST', `/platform-fee-rules/${second.id}/approve`);
    expect(early.statusCode).toBe(409);
    expect(code(early)).toBe(ErrorCode.PLATFORM_FEE_NOT_PENDING_APPROVAL);
  });

  it('replace a published rule: approving the new one retires the old one', async () => {
    const drafted = await call(maker, 'POST', '/platform-fee-rules', BAND('replacement', { percentRate: '3', supersedesRuleId: first.id }));
    expect(drafted.statusCode, drafted.body).toBe(201);
    replacement = ruleOf(drafted);
    expect(replacement.supersedesRuleId).toBe(first.id);

    await call(maker, 'POST', `/platform-fee-rules/${replacement.id}/submit`);
    const approved = await call(checker, 'POST', `/platform-fee-rules/${replacement.id}/approve`);
    expect(approved.statusCode, approved.body).toBe(200);

    const old = await prisma.platformFeeRule.findUniqueOrThrow({ where: { id: first.id } });
    expect(old.status).toBe('RETIRED');
    const now = await prisma.platformFeeRule.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(now.status).toBe('PUBLISHED');
  });

  it('retire a live rule and list the orders a rule touched', async () => {
    const retired = await call(checker, 'POST', `/platform-fee-rules/${replacement.id}/retire`);
    expect(retired.statusCode, retired.body).toBe(200);
    expect(ruleOf(retired).status).toBe('RETIRED');

    const orders = await call(maker, 'GET', `/platform-fee-rules/${replacement.id}/orders`);
    expect(orders.statusCode).toBe(200);
    expect(orders.json<{ orders: unknown[] }>().orders).toEqual([]);
  });

  it('write every step to the audit trail', async () => {
    const entries = await prisma.auditLog.findMany({
      where: { resourceType: 'platform_fee_rule', resourceId: { in: [first.id, second.id, replacement.id] } },
      select: { action: true },
    });
    expect(entries.length).toBeGreaterThanOrEqual(8);
  });
});
