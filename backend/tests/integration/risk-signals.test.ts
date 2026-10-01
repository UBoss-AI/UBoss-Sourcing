/**
 * Fraud and risk controls (checklist SEC-008).
 *
 * Rules fire on the records the system already keeps, stay quiet below their
 * threshold, never raise the same pattern twice, and only a reviewer with
 * `risk.review` decides a signal - with a reason, never about themselves, and
 * with every decision and override in the audit log. Thresholds are changed
 * only by `risk.rule.write`, versioned and audited.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { AuditAction, recordAudit } from '../../src/modules/audit/audit.service.js';
import { RiskRuleCode, runRiskScan } from '../../src/modules/risk/risk.service.js';
import { asStaff, cleanUpOrderDesk, emailFor, staff, type StaffSession } from '../support/order-desk-fixture.js';

const TAG = 'risk8';
const START = new Date();
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: StaffSession;
let compliance: StaffSession;
let support: StaffSession;
let complianceUserId = '';
let savedRules: Awaited<ReturnType<typeof prisma.riskRule.findMany>> = [];
const sellerIds: string[] = [];

const noisy = `${TAG}-noisy@risk.test.local`;
const quiet = `${TAG}-quiet@risk.test.local`;

function patch(session: StaffSession, url: string, payload: unknown) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/admin${url}`,
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken, 'x-forwarded-for': session.ip },
    payload: payload as Record<string, unknown>,
  });
}

async function failures(email: string, count: number): Promise<void> {
  await prisma.loginAttempt.createMany({
    data: Array.from({ length: count }, () => ({ id: newId(), emailNormalized: email, userType: 'CUSTOMER' as const, success: false, failureReason: 'BAD_PASSWORD' })),
  });
}

async function cleanUp(): Promise<void> {
  await prisma.adminNotification.deleteMany({ where: { relatedType: 'risk_signal', createdAt: { gte: START } } });
  await prisma.riskSignal.deleteMany({ where: { detectedAt: { gte: new Date(START.getTime() - 60_000) } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: [noisy, quiet, emailFor(TAG, 'compliance')] } } });
  await prisma.sellerBusinessProfile.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUpOrderDesk(TAG);
  savedRules = await prisma.riskRule.findMany();
  // Only the rules under test run, with small thresholds; restored afterwards.
  await prisma.riskRule.updateMany({ data: { enabled: false } });
  for (const [code, threshold, windowMinutes] of [
    [RiskRuleCode.LOGIN_FAILURES, 3, 15],
    [RiskRuleCode.SENSITIVE_CHANGE_AFTER_FAILURES, 3, 60],
    [RiskRuleCode.DUPLICATE_SELLER_IDENTIFIER, 2, 525600],
    [RiskRuleCode.MULTIPLE_HIGH_RISK, 2, 1440],
  ] as const) {
    await prisma.riskRule.update({ where: { code }, data: { enabled: true, threshold, windowMinutes } });
  }
  owner = await staff(app, TAG, 'inspadmin', Role.BUSINESS_OWNER, '10.82.0.20');
  compliance = await staff(app, TAG, 'compliance', Role.COMPLIANCE_OFFICER, '10.82.0.21');
  support = await staff(app, TAG, 'support', Role.SUPPORT_AGENT, '10.82.0.22');
  complianceUserId = (await prisma.user.findFirstOrThrow({ where: { emailNormalized: emailFor(TAG, 'compliance') } })).id;
  for (const letter of ['a', 'b']) {
    const id = newId();
    sellerIds.push(id);
    await prisma.sellerAccount.create({
      data: { id, slug: `${TAG}-dup${letter}`, legalName: `${TAG} ${letter} Ltd`, displayName: `${TAG} ${letter}`, displayNameNormalized: `${TAG}dup${letter}`, kind: 'MANUFACTURER', registrationCountry: 'IN', status: 'SUBMITTED' },
    });
    await prisma.sellerBusinessProfile.create({ data: { id: newId(), sellerAccountId: id, taxRegistrationNumber: letter === 'a' ? '27ABCDE1234F1Z5' : '27abcde1234f1z5 ' } });
  }
}, 120_000);

afterAll(async () => {
  await cleanUp();
  for (const rule of savedRules) {
    const { code, createdAt: _c, updatedAt: _u, ...rest } = rule;
    await prisma.riskRule.update({ where: { code }, data: rest });
  }
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('rules', () => {
  it('raises a signal at the threshold, not below it, and never twice', async () => {
    await failures(noisy, 3);
    await failures(quiet, 2);
    expect(await runRiskScan()).toBeGreaterThanOrEqual(1);
    // Scoped to this file's addresses: other files' failed sign-ins may share the window.
    const login = await prisma.riskSignal.findMany({ where: { ruleCode: RiskRuleCode.LOGIN_FAILURES, facts: { path: '$.email', equals: noisy } } });
    expect(login).toHaveLength(1);
    expect(await prisma.riskSignal.count({ where: { ruleCode: RiskRuleCode.LOGIN_FAILURES, facts: { path: '$.email', equals: quiet } } })).toBe(0);
    expect(login[0]?.facts).toMatchObject({ email: noisy, approvedForProduction: false });
    expect(login[0]?.observed).toBe(3);
    const before = await prisma.riskSignal.count();
    await runRiskScan();
    // A rescan of the same window raises nothing new for this pattern.
    expect(await prisma.riskSignal.count({ where: { ruleCode: RiskRuleCode.LOGIN_FAILURES, facts: { path: '$.email', equals: noisy } } })).toBe(1);
    expect(await prisma.riskSignal.count()).toBe(before);
  });

  it('flags two sellers sharing a tax number without storing the number', async () => {
    const dup = await prisma.riskSignal.findFirstOrThrow({ where: { ruleCode: RiskRuleCode.DUPLICATE_SELLER_IDENTIFIER, facts: { path: '$.sellerAccountIds', array_contains: sellerIds[0] } } });
    expect(JSON.stringify(dup.facts)).not.toContain('ABCDE1234');
    expect(dup.facts).toMatchObject({ identifier: 'TAX_REGISTRATION', value: '****F1Z5' });
    expect(dup.severity).toBe('HIGH');
    // A HIGH signal reaches the console bell.
    expect(await prisma.adminNotification.count({ where: { relatedType: 'risk_signal', relatedId: dup.id } })).toBe(1);
  });

  it('flags a password change after repeated failures, and escalates several high signals on one subject', async () => {
    await failures(emailFor(TAG, 'compliance'), 3);
    await recordAudit({ action: AuditAction.USER_PASSWORD_CHANGED, resourceType: 'user', resourceId: complianceUserId, actorType: 'SYSTEM' });
    await runRiskScan();
    const takeover = await prisma.riskSignal.findFirstOrThrow({ where: { ruleCode: RiskRuleCode.SENSITIVE_CHANGE_AFTER_FAILURES, subjectId: complianceUserId } });
    expect(takeover.severity).toBe('HIGH');
    // A second HIGH signal on the same user makes the composite rule fire.
    await prisma.riskSignal.create({
      data: { id: newId(), ruleCode: 'TEST_HIGH', severity: 'HIGH', subjectType: 'USER', subjectId: complianceUserId, observed: 1, threshold: 1, facts: {}, dedupeKey: `${TAG}:extra` },
    });
    await runRiskScan();
    const composite = await prisma.riskSignal.findFirstOrThrow({ where: { ruleCode: RiskRuleCode.MULTIPLE_HIGH_RISK, subjectId: complianceUserId } });
    expect(composite.severity).toBe('CRITICAL');
  });
});

describe('review', () => {
  it('lets compliance read the queue and refuses support', async () => {
    expect((await asStaff(app, compliance, 'GET', '/risk/signals?status=OPEN')).statusCode).toBe(200);
    expect((await asStaff(app, support, 'GET', '/risk/signals')).statusCode).toBe(403);
  });

  it('needs a reason, refuses a self-review, records a false positive and an audited override', async () => {
    const dup = await prisma.riskSignal.findFirstOrThrow({ where: { ruleCode: RiskRuleCode.DUPLICATE_SELLER_IDENTIFIER, facts: { path: '$.sellerAccountIds', array_contains: sellerIds[0] } } });
    const about = await prisma.riskSignal.findFirstOrThrow({ where: { ruleCode: RiskRuleCode.SENSITIVE_CHANGE_AFTER_FAILURES, subjectId: complianceUserId } });
    const decide = (session: StaffSession, id: string, decision: string, reason: string) =>
      asStaff(app, session, 'POST', `/risk/signals/${id}/decision`, { payload: { decision, reason } });

    expect((await decide(support, dup.id, 'FALSE_POSITIVE', 'same group company')).statusCode).toBe(403);
    expect((await decide(compliance, dup.id, 'FALSE_POSITIVE', 'x')).statusCode).toBe(400);
    const self = await decide(compliance, about.id, 'FALSE_POSITIVE', 'that was me changing my password');
    expect(self.statusCode).toBe(403);
    expect(self.body).toContain('SELF_REVIEW');

    expect((await decide(compliance, dup.id, 'FALSE_POSITIVE', 'Both accounts belong to one group company; documents seen.')).statusCode).toBe(204);
    expect((await prisma.riskSignal.findUniqueOrThrow({ where: { id: dup.id } })).status).toBe('FALSE_POSITIVE');
    expect(await prisma.adminNotification.count({ where: { relatedId: dup.id, resolvedAt: null } })).toBe(0);
    expect((await decide(compliance, dup.id, 'FALSE_POSITIVE', 'repeat of the same decision')).statusCode).toBe(409);

    expect((await decide(owner, dup.id, 'CONFIRMED', 'Group company claim not supported by the registry.')).statusCode).toBe(204);
    const audits = await prisma.auditLog.findMany({ where: { resourceId: dup.id, action: 'risk_signal.reviewed' }, orderBy: { createdAt: 'asc' } });
    expect(audits).toHaveLength(2);
    expect(audits[1]?.beforeJson).toMatchObject({ status: 'FALSE_POSITIVE' });
    expect(audits[1]?.afterJson).toMatchObject({ status: 'CONFIRMED', override: true });
  });
});

describe('rules administration', () => {
  it('lets only the owner change a rule, with the version read, and audits it', async () => {
    const rules = (await asStaff(app, compliance, 'GET', '/risk/rules')).json<{ rules: { code: string; version: number }[] }>().rules;
    const rule = rules.find((row) => row.code === RiskRuleCode.REFUND_VALUE);
    expect(rule).toBeDefined();
    expect((await patch(compliance, `/risk/rules/${RiskRuleCode.REFUND_VALUE}`, { expectedVersion: rule?.version, threshold: 2 })).statusCode).toBe(403);
    const changed = await patch(owner, `/risk/rules/${RiskRuleCode.REFUND_VALUE}`, { expectedVersion: rule?.version, thresholdMinor: '7500000', approvedForProduction: true });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<{ rule: { thresholdMinor: string; version: number } }>().rule).toMatchObject({ thresholdMinor: '7500000', version: (rule?.version ?? 0) + 1 });
    expect((await patch(owner, `/risk/rules/${RiskRuleCode.REFUND_VALUE}`, { expectedVersion: rule?.version, threshold: 3 })).statusCode).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: 'risk_rule.changed', createdAt: { gte: START } } })).toBe(1);
  });
});
