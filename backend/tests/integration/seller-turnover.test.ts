/**
 * The seller turnover eligibility policy, end to end over HTTP.
 *
 *   - **Applying.** `/sellers/apply` refuses a turnover below the minimum, at
 *     exactly the minimum, a missing declaration or year and a malformed
 *     amount - and accepts one paisa above the minimum, storing the exact
 *     amount, the year, the declaration time and the policy version.
 *   - **No way round it.** An in-progress application with no declaration, or
 *     one corrected down below the minimum, is refused at `/sellers/submit`
 *     with SELLER_TURNOVER_NOT_ELIGIBLE. The form is not the gate.
 *   - **Declared is not verified is not approved.** Approval waits for a
 *     reviewer to verify the figure; verifying it does not approve anybody.
 *   - **Changes go back for review.** A new figure or new evidence reopens a
 *     verified declaration and keeps the old decision as history.
 *   - **Existing approved sellers are untouched.**
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { mostRecentFinancialYear } from '../../src/domain/seller-turnover.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { approvalReadiness } from '../../src/modules/seller/application-review.service.js';
import { refreshDocumentSteps } from '../../src/modules/seller/document.service.js';
import { TURNOVER_EVIDENCE_FIELD_KEY } from '../../src/modules/seller/turnover-facts.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';
import { asAudit, auditEmailFor, auditPerson, cleanUpAuditPeople } from '../support/audit-session.js';
import type { Session as AuditSession } from '../support/order-desk-fixture.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'TurnoverGate!2026x';
const HUB_PASSWORD = 'HubTurnover!2026x';
const PREFIX = 'trnvr-';
const EMAIL = {
  applicant: 'trnvr-applicant@test.local',
  legacy: 'trnvr-legacy@test.local',
  staff: 'trnvr-staff@test.local',
};
const ALL_EMAILS = Object.values(EMAIL);

/** INR 30 crore in paise. */
const MINIMUM = 30_000_000_000n;
const FY = mostRecentFinancialYear(4, new Date());

interface Session {
  cookie: string;
  csrf: string;
}

let applicant: Session;
let legacy: Session;
let staff: AdminSession;
/** Turnover is verified by the Audit Team, in the Audit Console. */
let auditor: AuditSession;
let legacySellerId = '';
let ipSeed = 10;
const someIp = (): string => `203.0.113.${String((ipSeed += 1))}`;

/** Decide the turnover through the Audit Console, as the reviewer would, with the state their screen showed. */
async function decideAsAuditor(sellerAccountId: string, body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  const current = await prisma.sellerTurnoverDeclaration.findFirst({ where: { sellerAccountId, isCurrent: true }, select: { verificationState: true } });
  return asAudit(app, auditor, 'POST', `/audit/seller-verification/${sellerAccountId}/turnover/decision`, {
    ...body,
    expectedVerificationState: current?.verificationState ?? 'AWAITING_INPUT',
  });
}

function call(
  session: Session | AdminSession,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const isAdmin = 'cookies' in session;
  return app.inject({
    method,
    url,
    headers: {
      cookie: isAdmin ? session.cookies : session.cookie,
      'x-csrf-token': isAdmin ? session.csrfToken : session.csrf,
      'x-forwarded-for': someIp(),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const errorOf = (response: LightMyRequestResponse) =>
  response.json<{ error?: { code: string; details?: { field?: string; code?: string }[] } }>().error;

function turnover(amountMinor: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amountMinor,
    currency: 'INR',
    financialYearStart: FY.start,
    financialYearEnd: FY.end,
    declarationAccepted: true,
    ...overrides,
  };
}

function application(turnoverBody: unknown): Record<string, unknown> {
  return {
    legalName: 'Turnover Test Private Limited',
    displayName: `${PREFIX}shop`,
    registrationCountry: 'IN',
    kind: 'WHOLESALER',
    ...(turnoverBody === undefined ? {} : { turnover: turnoverBody }),
  };
}

async function signIn(email: string): Promise<Session> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': someIp() },
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = login.cookies as { name: string; value: string }[];
  return {
    cookie: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrf: jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '',
  };
}

async function openHub(session: Session): Promise<void> {
  const set = await call(session, 'POST', '/api/v1/sellers/lock', { newPassword: HUB_PASSWORD });
  expect(set.statusCode, set.body).toBe(200);
  const open = await call(session, 'POST', '/api/v1/sellers/lock/open', { password: HUB_PASSWORD });
  expect(open.statusCode, open.body).toBe(200);
}

async function createCustomer(email: string): Promise<string> {
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
  await prisma.customerProfile.create({
    data: { id: profileId, userId, fullName: email.split('@')[0] ?? 'Seller', activatedAt: new Date() },
  });
  return profileId;
}

async function sellerIds(): Promise<string[]> {
  const profiles = (
    await prisma.customerProfile.findMany({
      where: { user: { emailNormalized: { in: ALL_EMAILS } } },
      select: { id: true },
    })
  ).map((row) => row.id);
  return (
    await prisma.sellerAccount.findMany({
      where: {
        OR: [{ slug: { startsWith: PREFIX } }, { members: { some: { customerProfileId: { in: profiles } } } }],
      },
      select: { id: true },
    })
  ).map((row) => row.id);
}

async function cleanUp(): Promise<void> {
  const userIds = (
    await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })
  ).map((row) => row.id);
  const ids = await sellerIds();
  await prisma.sellerTurnoverDeclaration.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerDocument.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds }, action: 'seller_turnover.decided' } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.cart.deleteMany({ where: { customerProfile: { userId: { in: userIds } } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  await createCustomer(EMAIL.applicant);
  const legacyProfile = await createCustomer(EMAIL.legacy);

  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: Role.BUSINESS_OWNER }, select: { id: true } });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: EMAIL.staff,
      emailNormalized: EMAIL.staff,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: roleRow.id } },
    },
  });

  // A seller the marketplace approved before the policy existed, with no
  // turnover on file at all.
  legacySellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: legacySellerId,
      legalName: 'Legacy Seller Private Limited',
      displayName: 'Legacy Turnover Seller',
      displayNameNormalized: 'legacyturnoverseller',
      slug: `${PREFIX}legacy`,
      kind: 'WHOLESALER',
      registrationCountry: 'QZ',
      status: 'APPROVED',
      approvedAt: new Date('2025-01-15T00:00:00.000Z'),
    },
  });
  await prisma.sellerBusinessProfile.create({ data: { id: newId(), sellerAccountId: legacySellerId } });
  await prisma.sellerMember.create({
    data: { id: newId(), sellerAccountId: legacySellerId, customerProfileId: legacyProfile, role: 'OWNER' },
  });

  applicant = await signIn(EMAIL.applicant);
  legacy = await signIn(EMAIL.legacy);
  staff = await signInAdmin(app, { email: EMAIL.staff, password: PASSWORD, ip: someIp() });
  auditor = (await auditPerson(app, { tag: 'trnvr', who: 'review', ip: '10.82.0.11', target: { kind: 'STAFF', role: 'COMPLIANCE_REVIEWER' } })).session;
});

afterAll(async () => {
  await cleanUp();
  await cleanUpAuditPeople('trnvr');
  await app.close();
});

// ---------------------------------------------------------------------------

describe('the policy is public', () => {
  it('publishes the minimum, as minor units, in the storefront config', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ sellerEligibility: Record<string, unknown> }>().sellerEligibility).toMatchObject({
      required: true,
      minimumMinor: MINIMUM.toString(),
      currency: 'INR',
      currencyExponent: 2,
      suggestedFinancialYear: FY,
    });
  });
});

describe('applying to sell', () => {
  it.each([
    ['below the minimum', (MINIMUM - 1n).toString()],
    ['exactly the minimum', MINIMUM.toString()],
  ])('refuses a turnover %s', async (_label, amount) => {
    const response = await call(applicant, 'POST', '/api/v1/sellers/apply', application(turnover(amount)));
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response)?.code).toBe('SELLER_TURNOVER_NOT_ELIGIBLE');
    expect(errorOf(response)?.details?.[0]?.code).toBe('BELOW_MINIMUM');
  });

  it.each([
    ['no turnover at all', undefined, 'amountMinor'],
    ['the declaration unticked', turnover('30000000001', { declarationAccepted: false }), 'declarationAccepted'],
    ['no financial year', turnover('30000000001', { financialYearStart: '', financialYearEnd: '' }), 'financialYearStart'],
    ['a negative amount', turnover('-30000000001'), 'amountMinor'],
    ['a decimal amount', turnover('30000000001.5'), 'amountMinor'],
    ['a number instead of a string', turnover(30000000001), 'amountMinor'],
    ['another currency', turnover('30000000001', { currency: 'EUR' }), 'currency'],
  ])('refuses %s, naming the field', async (_label, body, field) => {
    const response = await call(applicant, 'POST', '/api/v1/sellers/apply', application(body));
    expect(response.statusCode, response.body).toBe(400);
    expect(errorOf(response)?.code).toBe('VALIDATION_FAILED');
    expect(errorOf(response)?.details?.map((detail) => detail.field)).toContain(field);
  });

  it('opened nothing for any refused application', async () => {
    expect(await sellerIds()).toEqual([legacySellerId]);
  });

  it('accepts one paisa above the minimum and stores exactly what was declared', async () => {
    const response = await call(applicant, 'POST', '/api/v1/sellers/apply', application(turnover((MINIMUM + 1n).toString())));
    expect(response.statusCode, response.body).toBe(201);
    const { sellerAccountId } = response.json<{ sellerAccountId: string }>();

    const row = await prisma.sellerTurnoverDeclaration.findFirstOrThrow({ where: { sellerAccountId, isCurrent: true } });
    expect(row.amountMinor).toBe(MINIMUM + 1n);
    expect(row.currency).toBe('INR');
    expect(row.financialYearStart.toISOString().slice(0, 10)).toBe(FY.start);
    expect(row.financialYearEnd.toISOString().slice(0, 10)).toBe(FY.end);
    expect(row.policyVersion).toBe('2026-10');
    expect(row.minimumMinor).toBe(MINIMUM);
    expect(row.declaredAt).toBeInstanceOf(Date);
    // Declared is not verified, and nobody is approved by declaring.
    expect(row.verificationState).toBe('AWAITING_INPUT');
    const account = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: sellerAccountId } });
    expect(account.status).toBe('DRAFT');
  });
});

describe('the onboarding form and the submit gate', () => {
  let sellerAccountId = '';

  beforeAll(async () => {
    await openHub(applicant);
    sellerAccountId = (await sellerIds()).find((id) => id !== legacySellerId) ?? '';
    expect(sellerAccountId).not.toBe('');
  });

  it('shows the seller their declaration, never the reviewer note', async () => {
    const response = await call(applicant, 'GET', '/api/v1/seller/turnover');
    expect(response.statusCode, response.body).toBe(200);
    const view = response.json<{ standing: string; declaration: Record<string, unknown> }>();
    expect(view.standing).toBe('ELIGIBLE');
    expect(view.declaration).toMatchObject({ amountMinor: (MINIMUM + 1n).toString(), financialYearStart: FY.start });
    expect(view.declaration).not.toHaveProperty('internalNote');
  });

  it('keeps a figure corrected down to the minimum, and refuses submission', async () => {
    const saved = await call(applicant, 'PUT', '/api/v1/seller/turnover', turnover(MINIMUM.toString()));
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<{ standing: string; declaration: { amountMinor: string } }>()).toMatchObject({
      standing: 'BELOW_MINIMUM',
      declaration: { amountMinor: MINIMUM.toString() },
    });

    const onboarding = await call(applicant, 'GET', '/api/v1/seller/onboarding');
    const business = onboarding
      .json<{ steps: { key: string; state: string; message: string | null }[] }>()
      .steps.find((step) => step.key === 'business_identity');
    expect(business?.state).toBe('IN_PROGRESS');
    expect(business?.message).toContain('Annual turnover above the seller minimum');

    const submit = await call(applicant, 'POST', '/api/v1/seller/submit', {});
    expect(submit.statusCode, submit.body).toBe(409);
    expect(errorOf(submit)?.code).toBe('SELLER_TURNOVER_NOT_ELIGIBLE');
  });

  it('refuses submission with no declaration at all - the API is not a way round the form', async () => {
    await prisma.sellerTurnoverDeclaration.deleteMany({ where: { sellerAccountId } });
    const submit = await call(applicant, 'POST', '/api/v1/seller/submit', {});
    expect(submit.statusCode, submit.body).toBe(409);
    expect(errorOf(submit)?.code).toBe('SELLER_TURNOVER_NOT_ELIGIBLE');
    expect(errorOf(submit)?.details?.[0]?.code).toBe('NOT_DECLARED');
  });

  it('gets past the turnover gate once the figure exceeds the minimum', async () => {
    const saved = await call(applicant, 'PUT', '/api/v1/seller/turnover', turnover((MINIMUM + 1n).toString()));
    expect(saved.statusCode, saved.body).toBe(200);
    const submit = await call(applicant, 'POST', '/api/v1/seller/submit', {});
    // Refused for the unfinished checklist, not for the turnover.
    expect(errorOf(submit)?.code).toBe('SELLER_ONBOARDING_INCOMPLETE');
  });

  it('is never readable by another seller', async () => {
    const response = await call(legacy, 'GET', '/api/v1/seller/turnover');
    // The legacy seller has no Hub lock open, and even with one the route reads
    // only the session's own seller - there is no id to put in the URL.
    expect([200, 401, 403, 423]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      expect(response.json<{ declaration: unknown }>().declaration).toBeNull();
    }
  });

  describe('verification', () => {
    it('refuses a decision from a seller session and without staff rights', async () => {
      const response = await call(applicant, 'POST', `/api/v1/admin/sellers/${sellerAccountId}/turnover/decision`, {
        declarationId: newId(),
        decision: 'VERIFIED',
        reason: 'Self-approval',
      });
      expect([401, 403]).toContain(response.statusCode);

      // Nor from the Admin Panel, whatever the role: the Audit Team verifies turnover.
      const admin = await call(staff, 'POST', `/api/v1/admin/sellers/${sellerAccountId}/turnover/decision`, {
        declarationId: newId(),
        decision: 'VERIFIED',
        reason: 'Admin trying',
      });
      expect(admin.statusCode).toBe(403);
      expect(errorOf(admin)?.code).toBe('SELLER_VERIFICATION_AUDIT_ONLY');
    });

    it('holds approval until a reviewer verifies, and verifying approves nobody', async () => {
      const before = await approvalReadiness(sellerAccountId);
      expect(before.missing.map((item) => item.code)).toContain('TURNOVER_NOT_VERIFIED');

      const review = await call(staff, 'GET', `/api/v1/admin/sellers/${sellerAccountId}/turnover`);
      expect(review.statusCode, review.body).toBe(200);
      const current = review.json<{ current: { id: string; exceedsMinimum: boolean } }>().current;
      expect(current.exceedsMinimum).toBe(true);

      const decided = await decideAsAuditor(sellerAccountId, {
        declarationId: current.id,
        decision: 'VERIFIED',
        reason: 'Audited statements for the year match the declared figure.',
        internalNote: 'Checked against the filed annual return.',
      });
      expect(decided.statusCode, decided.body).toBe(200);
      expect(decided.json<{ current: { verificationState: string; reviewedBy: string } }>().current).toMatchObject({
        verificationState: 'VERIFIED',
        reviewedBy: auditEmailFor('trnvr', 'review'),
      });

      const after = await approvalReadiness(sellerAccountId);
      expect(after.missing.map((item) => item.code)).not.toContain('TURNOVER_NOT_VERIFIED');
      const account = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: sellerAccountId } });
      expect(account.status).toBe('DRAFT');

      // The seller sees the reason, not the internal note.
      const mine = await call(applicant, 'GET', '/api/v1/seller/turnover');
      expect(mine.json<{ declaration: Record<string, unknown> }>().declaration).toMatchObject({
        verificationState: 'VERIFIED',
        decisionReason: 'Audited statements for the year match the declared figure.',
      });
      expect(mine.body).not.toContain('filed annual return');
    });

    it('sends an edited figure back for review, and refuses a decision on the old one', async () => {
      const verified = await prisma.sellerTurnoverDeclaration.findFirstOrThrow({ where: { sellerAccountId, isCurrent: true } });

      const saved = await call(applicant, 'PUT', '/api/v1/seller/turnover', turnover((MINIMUM + 500n).toString()));
      expect(saved.statusCode, saved.body).toBe(200);

      const current = await prisma.sellerTurnoverDeclaration.findFirstOrThrow({ where: { sellerAccountId, isCurrent: true } });
      expect(current.id).not.toBe(verified.id);
      expect(current.verificationState).toBe('AWAITING_INPUT');
      const old = await prisma.sellerTurnoverDeclaration.findUniqueOrThrow({ where: { id: verified.id } });
      expect(old).toMatchObject({ isCurrent: false, supersededReason: 'AMENDED', verificationState: 'VERIFIED' });

      expect((await approvalReadiness(sellerAccountId)).missing.map((item) => item.code)).toContain('TURNOVER_NOT_VERIFIED');

      const stale = await decideAsAuditor(sellerAccountId, {
        declarationId: verified.id,
        decision: 'VERIFIED',
        reason: 'Verifying the figure I opened earlier.',
      });
      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale)?.code).toBe('SELLER_STALE_VERSION');
    });

    it('keeps the same figures re-declared verified', async () => {
      const current = await prisma.sellerTurnoverDeclaration.findFirstOrThrow({ where: { sellerAccountId, isCurrent: true } });
      await decideAsAuditor(sellerAccountId, {
        declarationId: current.id,
        decision: 'VERIFIED',
        reason: 'Matches the audited statements.',
      });
      const again = await call(applicant, 'PUT', '/api/v1/seller/turnover', turnover((MINIMUM + 500n).toString()));
      expect(again.statusCode, again.body).toBe(200);
      const after = await prisma.sellerTurnoverDeclaration.findFirstOrThrow({ where: { sellerAccountId, isCurrent: true } });
      expect(after.id).toBe(current.id);
      expect(after.verificationState).toBe('VERIFIED');
    });

    it('sends it back for review when the supporting evidence changes', async () => {
      const verified = await prisma.sellerTurnoverDeclaration.findFirstOrThrow({ where: { sellerAccountId, isCurrent: true } });
      expect(verified.verificationState).toBe('VERIFIED');

      // What an upload against the turnover requirement leaves behind; the
      // upload route calls the same refresh after storing the file.
      await prisma.sellerDocument.create({
        data: {
          id: newId(),
          sellerAccountId,
          kind: 'OTHER',
          requirementFieldKey: TURNOVER_EVIDENCE_FIELD_KEY,
          storageKey: `test/${newId()}.pdf`,
          originalFileName: 'audited-statements.pdf',
          contentType: 'application/pdf',
          byteSize: 1024,
          contentHash: '0'.repeat(64),
          scanState: 'SCANNER_UNCONFIGURED',
        },
      });
      await refreshDocumentSteps({ sellerAccountId, registrationCountry: 'IN' });

      const current = await prisma.sellerTurnoverDeclaration.findFirstOrThrow({ where: { sellerAccountId, isCurrent: true } });
      expect(current.id).not.toBe(verified.id);
      expect(current.verificationState).toBe('IN_PROGRESS');
      expect(current.amountMinor).toBe(verified.amountMinor);
      const old = await prisma.sellerTurnoverDeclaration.findUniqueOrThrow({ where: { id: verified.id } });
      expect(old).toMatchObject({ isCurrent: false, supersededReason: 'EVIDENCE_CHANGED' });

      const review = await call(staff, 'GET', `/api/v1/admin/sellers/${sellerAccountId}/turnover`);
      const body = review.json<{ evidence: { originalFileName: string }[]; history: unknown[] }>();
      expect(body.evidence.map((document) => document.originalFileName)).toContain('audited-statements.pdf');
      expect(body.history.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('sellers approved before the policy', () => {
  it('are not asked for a turnover, held at approval or marked incomplete', async () => {
    expect(await prisma.sellerTurnoverDeclaration.count({ where: { sellerAccountId: legacySellerId } })).toBe(0);

    const readiness = await approvalReadiness(legacySellerId);
    expect(readiness.missing.filter((item) => item.field === 'turnover')).toEqual([]);

    const account = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: legacySellerId } });
    expect(account.status).toBe('APPROVED');

    await openHub(legacy);
    const view = await call(legacy, 'GET', '/api/v1/seller/turnover');
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json<{ applies: boolean }>().applies).toBe(false);

    const onboarding = await call(legacy, 'GET', '/api/v1/seller/onboarding');
    const business = onboarding
      .json<{ steps: { key: string; message: string | null }[] }>()
      .steps.find((step) => step.key === 'business_identity');
    expect(business?.message ?? '').not.toContain('turnover');
  });
});
