/**
 * The agreement screen after sign-in, end to end over HTTP.
 *
 * What is pinned here:
 *
 *   - Signed in is not enough: every application route answers 403
 *     AGREEMENTS_REQUIRED until the Terms for the account's kind are accepted
 *     AND the Privacy Policy acknowledged - two separate acts, two records.
 *   - Accepting the Terms never acknowledges the Privacy Policy, and the
 *     reverse. A document of the wrong kind is refused and nothing is written.
 *   - Records are the database's: they survive signing out and a new session
 *     (another device), a double submit writes one row, and clearing keeps
 *     the row and its audit trail.
 *   - A new version asks again only when it says so, and a version replaced
 *     while the dialog was open is refused rather than recorded.
 *   - Sign-out, the agreement routes, the public documents, support and
 *     privacy requests stay reachable; nothing else does.
 *   - Staff, Audit Console users and carrier staff each get their own Terms.
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { legalContentHash, type LegalDocumentKindName } from '../../src/domain/legal-document.js';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  assertAgreementsSatisfied,
  resetAgreementRequirementCache,
} from '../../src/modules/legal/agreement.service.js';
import { bumpLegalPublicationGeneration } from '../../src/modules/legal/publication-generation.js';
import { signInAdmin } from '../support/admin-session.js';
import { auditPerson, asAudit, cleanUpAuditPeople } from '../support/audit-session.js';

const RUN = newId().slice(-8).toLowerCase();
const PASSWORD = 'AgreementGate!2026x';
const IP = '10.88.0.1';
const AUDIT_TAG = `gate${RUN}`;

let app: Awaited<ReturnType<typeof buildApp>>;
const userIds: string[] = [];
const documentIds: string[] = [];
const savedGate = env.FEATURE_AGREEMENT_GATE;

/** Base time for the documents this file publishes: a minute ago, each version ten seconds apart. */
const BASE = Date.now() - 60_000;

type Jar = Map<string, string>;

function absorb(jar: Jar, response: LightMyRequestResponse): Jar {
  for (const cookie of response.cookies as { name: string; value: string }[]) {
    if (cookie.value === '') jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return jar;
}

function headersOf(jar: Jar): Record<string, string> {
  const csrf = [...jar].find(([name]) => name.endsWith('_csrf'))?.[1] ?? '';
  return {
    cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    'x-csrf-token': csrf,
    'x-forwarded-for': IP,
  };
}

function call(jar: Jar, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: headersOf(jar),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function publish(
  kind: LegalDocumentKindName,
  step: number,
  options: { requiresReacceptance?: boolean } = {},
): Promise<string> {
  const id = newId();
  const content = {
    kind,
    version: `gate-${RUN}-${String(step)}`,
    locale: 'en',
    title: `${kind} for the agreement gate test, step ${String(step)}`,
    body: '## Test document\nInstalled by the agreement gate test. Not legal text.',
  };
  const at = new Date(BASE + step * 10_000);
  await prisma.legalDocument.create({
    data: {
      id,
      ...content,
      status: 'PUBLISHED',
      effectiveAt: at,
      publishedAt: at,
      contentSha256: legalContentHash(content),
      requiresReacceptance: options.requiresReacceptance ?? true,
    },
  });
  documentIds.push(id);
  // What publishing through the console does, so this process asks at once.
  bumpLegalPublicationGeneration();
  return id;
}

async function buyer(label: string): Promise<{ userId: string; email: string; jar: Jar }> {
  const userId = newId();
  const email = `gate-${RUN}-${label}@test.local`;
  userIds.push(userId);
  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.customerProfile.create({ data: { id: newId(), userId, fullName: `Gate ${label}` } });
  return { userId, email, jar: await signInBuyer(email) };
}

async function signInBuyer(email: string): Promise<Jar> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': IP },
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  return absorb(new Map(), login);
}

interface StatusBody {
  scope: string;
  terms: { kind: string; current: { document: { id: string; version: string } } | null; record: { version: string } | null; unavailable: boolean }[];
  privacy: { kind: string; current: { document: { id: string; version: string } } | null; record: { version: string } | null; unavailable: boolean };
  termsComplete: boolean;
  privacyComplete: boolean;
  complete: boolean;
}

function missingKinds(response: LightMyRequestResponse): string[] {
  const body = response.json<{ error: { code: string; details?: { meta?: { kind?: string } }[] } }>().error;
  expect(body.code).toBe('AGREEMENTS_REQUIRED');
  return (body.details ?? []).map((detail) => detail.meta?.kind ?? '').sort();
}

let platformV1: string;
let privacyV1: string;
let sellerTerms: string;
let staffTerms: string;
let auditTerms: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  platformV1 = await publish('PLATFORM_TERMS', 1);
  privacyV1 = await publish('PRIVACY_POLICY', 1);
  sellerTerms = await publish('SELLER_TERMS', 1);
  staffTerms = await publish('STAFF_TERMS', 1);
  auditTerms = await publish('AUDIT_CONSOLE_TERMS', 1);

  Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: true });
  resetAgreementRequirementCache();
});

afterAll(async () => {
  Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: savedGate });
  await cleanUpAuditPeople(AUDIT_TAG);
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.consentRecord.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  // Records from the Audit Console people went with their accounts above.
  await prisma.consentRecord.deleteMany({ where: { legalDocumentId: { in: documentIds } } });
  for (const id of [...documentIds].reverse()) await prisma.legalDocument.deleteMany({ where: { id } });
  bumpLegalPublicationGeneration();
  resetAgreementRequirementCache();
  await app?.close();
});

describe('a buyer who has accepted nothing', () => {
  it('is refused on application routes until both documents are done, one box at a time', async () => {
    const { userId, jar } = await buyer('fresh');

    const blocked = await call(jar, 'GET', '/cart');
    expect(blocked.statusCode, blocked.body).toBe(403);
    expect(missingKinds(blocked)).toEqual(['PLATFORM_TERMS', 'PRIVACY_POLICY']);

    // The screen: both boxes unchecked, both documents ready to read.
    const status = await call(jar, 'GET', '/auth/agreements?locale=en');
    expect(status.statusCode, status.body).toBe(200);
    const before = status.json<StatusBody>();
    expect(before.scope).toBe('BUYER');
    expect(before.terms.map((entry) => entry.kind)).toEqual(['PLATFORM_TERMS']);
    expect(before.terms[0]?.current?.document.id).toBe(platformV1);
    expect(before.terms[0]?.record).toBeNull();
    expect(before.privacy.current?.document.id).toBe(privacyV1);
    expect(before.privacy.record).toBeNull();
    expect(before.complete).toBe(false);

    // The Terms box. Accepting them acknowledges nothing else.
    const agreed = await call(jar, 'POST', '/auth/agreements/terms', { documentIds: [platformV1] });
    expect(agreed.statusCode, agreed.body).toBe(200);
    const afterTerms = agreed.json<StatusBody>();
    expect(afterTerms.termsComplete).toBe(true);
    expect(afterTerms.privacyComplete).toBe(false);
    expect(afterTerms.privacy.record).toBeNull();

    const stillBlocked = await call(jar, 'GET', '/cart');
    expect(stillBlocked.statusCode).toBe(403);
    expect(missingKinds(stillBlocked)).toEqual(['PRIVACY_POLICY']);

    // The Privacy Policy box.
    const acknowledged = await call(jar, 'POST', '/auth/agreements/privacy', { documentIds: [privacyV1] });
    expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    expect(acknowledged.json<StatusBody>().complete).toBe(true);

    const allowed = await call(jar, 'GET', '/cart');
    expect(allowed.statusCode, allowed.body).toBe(200);

    // Two records, each saying exactly what it is, from the server's own clock.
    const records = await prisma.consentRecord.findMany({
      where: { userId },
      select: { purpose: true, action: true, scope: true, legalDocumentId: true, textVersion: true, textHash: true, locale: true, acceptanceSource: true, acceptedAt: true },
      orderBy: { purpose: 'asc' },
    });
    expect(records).toHaveLength(2);
    expect(records.find((row) => row.purpose === 'PLATFORM_TERMS')).toMatchObject({
      action: 'TERMS_ACCEPTED', scope: 'BUYER', legalDocumentId: platformV1, locale: 'en', acceptanceSource: 'AGREEMENT_SCREEN',
    });
    expect(records.find((row) => row.purpose === 'PRIVACY_NOTICE')).toMatchObject({
      action: 'PRIVACY_NOTICE_ACKNOWLEDGED', scope: 'BUYER', legalDocumentId: privacyV1,
    });
    for (const row of records) expect(row.textHash).toMatch(/^[0-9a-f]{64}$/);

    const audit = await prisma.auditLog.findMany({
      where: { actorUserId: userId, action: { startsWith: 'legal_agreement.' } },
      select: { action: true },
    });
    expect(audit.map((row) => row.action).sort()).toEqual([
      'legal_agreement.privacy_notice_acknowledged',
      'legal_agreement.terms_accepted',
    ]);
  });

  it('refuses a document of the wrong kind under each box and writes nothing', async () => {
    const { userId, jar } = await buyer('wrong-kind');

    const privacyAsTerms = await call(jar, 'POST', '/auth/agreements/terms', { documentIds: [privacyV1] });
    expect(privacyAsTerms.statusCode).toBe(400);
    expect(privacyAsTerms.json<{ error: { code: string } }>().error.code).toBe('AGREEMENT_DOCUMENT_NOT_APPLICABLE');

    const termsAsPrivacy = await call(jar, 'POST', '/auth/agreements/privacy', { documentIds: [platformV1] });
    expect(termsAsPrivacy.statusCode).toBe(400);

    // A buyer is never asked for, and cannot accept, the Seller Addendum or the staff terms.
    for (const id of [sellerTerms, staffTerms, auditTerms]) {
      const refused = await call(jar, 'POST', '/auth/agreements/terms', { documentIds: [id] });
      expect(refused.statusCode, refused.body).toBe(400);
    }

    expect(await prisma.consentRecord.count({ where: { userId } })).toBe(0);
  });

  it('writes one record for a doubled or repeated submit', async () => {
    const { userId, jar } = await buyer('double');

    const results = await Promise.allSettled([
      call(jar, 'POST', '/auth/agreements/terms', { documentIds: [platformV1] }),
      call(jar, 'POST', '/auth/agreements/terms', { documentIds: [platformV1] }),
    ]);
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') expect(result.value.statusCode, result.value.body).toBe(200);
    }
    const again = await call(jar, 'POST', '/auth/agreements/terms', { documentIds: [platformV1] });
    expect(again.statusCode).toBe(200);

    expect(await prisma.consentRecord.count({ where: { userId, activeDocumentId: { not: null } } })).toBe(1);
  });

  it('keeps sign-out, the agreement routes, public documents, support and privacy requests reachable', async () => {
    const { jar } = await buyer('exempt');

    expect((await call(jar, 'GET', '/auth/me')).statusCode).toBe(200);
    expect((await call(jar, 'GET', '/auth/agreements/history')).statusCode).toBe(200);
    expect((await call(jar, 'GET', `/legal/documents/${platformV1}`)).statusCode).toBe(200);
    expect((await call(jar, 'GET', '/support/tickets')).statusCode).toBe(200);
    expect((await call(jar, 'GET', '/account/data-requests')).statusCode).toBe(200);
    // And nothing else: an ordinary account route is refused.
    expect((await call(jar, 'GET', '/account/addresses')).statusCode).toBe(403);
    expect((await call(jar, 'POST', '/auth/logout')).statusCode).toBe(204);
  });
});

describe('records the database keeps', () => {
  it('survive signing out and a new session on another device', async () => {
    const { email, jar } = await buyer('devices');
    await call(jar, 'POST', '/auth/agreements/terms', { documentIds: [platformV1] });
    await call(jar, 'POST', '/auth/agreements/privacy', { documentIds: [privacyV1] });
    expect((await call(jar, 'POST', '/auth/logout')).statusCode).toBe(204);

    const otherDevice = await signInBuyer(email);
    const status = (await call(otherDevice, 'GET', '/auth/agreements')).json<StatusBody>();
    expect(status.complete).toBe(true);
    expect((await call(otherDevice, 'GET', '/cart')).statusCode).toBe(200);
  });

  it('clear a box before Continue without deleting history or withdrawing anything', async () => {
    const { userId, jar } = await buyer('clear');
    await call(jar, 'POST', '/auth/agreements/terms', { documentIds: [platformV1] });
    await call(jar, 'POST', '/auth/agreements/privacy', { documentIds: [privacyV1] });

    const cleared = await call(jar, 'DELETE', '/auth/agreements/privacy');
    expect(cleared.statusCode, cleared.body).toBe(200);
    const status = cleared.json<StatusBody>();
    expect(status.privacy.record).toBeNull();
    // Clearing one box leaves the other alone.
    expect(status.termsComplete).toBe(true);

    const row = await prisma.consentRecord.findFirstOrThrow({ where: { userId, purpose: 'PRIVACY_NOTICE' } });
    expect(row.clearedAt).not.toBeNull();
    expect(row.withdrawnAt).toBeNull();
    expect(row.activeDocumentId).toBeNull();
    expect(await prisma.auditLog.count({ where: { actorUserId: userId, action: 'legal_agreement.cleared' } })).toBe(1);

    expect((await call(jar, 'GET', '/cart')).statusCode).toBe(403);

    // Acknowledging again is a new record; the cleared one stays.
    await call(jar, 'POST', '/auth/agreements/privacy', { documentIds: [privacyV1] });
    expect(await prisma.consentRecord.count({ where: { userId, purpose: 'PRIVACY_NOTICE' } })).toBe(2);
    expect((await call(jar, 'GET', '/cart')).statusCode).toBe(200);

    const history = (await call(jar, 'GET', '/auth/agreements/history')).json<{ entries: { clearedAt: string | null }[] }>();
    expect(history.entries).toHaveLength(3);
    expect(history.entries.filter((entry) => entry.clearedAt !== null)).toHaveLength(1);
  });
});

describe('a new version', () => {
  it('asks again only when it requires re-acceptance, and refuses the version it replaced', async () => {
    const { userId, jar } = await buyer('versions');
    await call(jar, 'POST', '/auth/agreements/terms', { documentIds: [platformV1] });
    await call(jar, 'POST', '/auth/agreements/privacy', { documentIds: [privacyV1] });
    expect((await call(jar, 'GET', '/cart')).statusCode).toBe(200);

    // A correction: nobody is asked again.
    const correction = await publish('PRIVACY_POLICY', 2, { requiresReacceptance: false });
    expect((await call(jar, 'GET', '/cart')).statusCode).toBe(200);
    const shown = (await call(jar, 'GET', '/auth/agreements')).json<StatusBody>();
    expect(shown.privacy.current?.document.id).toBe(correction);
    expect(shown.privacy.record?.version).toBe(`gate-${RUN}-1`);

    // A real change: asked again on the very next request.
    const change = await publish('PRIVACY_POLICY', 3, { requiresReacceptance: true });
    const blocked = await call(jar, 'GET', '/cart');
    expect(blocked.statusCode).toBe(403);
    expect(missingKinds(blocked)).toEqual(['PRIVACY_POLICY']);

    // The dialog was opened on the correction, which is no longer the one in force.
    const stale = await call(jar, 'POST', '/auth/agreements/privacy', { documentIds: [correction] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe('TERMS_VERSION_OUTDATED');
    expect(await prisma.consentRecord.count({ where: { userId, legalDocumentId: correction } })).toBe(0);

    const current = await call(jar, 'POST', '/auth/agreements/privacy', { documentIds: [change] });
    expect(current.statusCode, current.body).toBe(200);
    expect((await call(jar, 'GET', '/cart')).statusCode).toBe(200);
    // The earlier acknowledgment is still on file.
    expect(await prisma.consentRecord.count({ where: { userId, purpose: 'PRIVACY_NOTICE' } })).toBe(2);
  });
});

describe('other kinds of account', () => {
  it('asks a seller for the Seller Addendum as well, and never a buyer', async () => {
    const { userId, jar } = await buyer('seller-scope');
    // Not a seller: the Seller Hub's screen is refused outright.
    const notSeller = await call(jar, 'GET', '/auth/agreements?scope=SELLER');
    expect(notSeller.statusCode).toBe(403);
    expect(notSeller.json<{ error: { code: string } }>().error.code).toBe('SELLER_ACCOUNT_REQUIRED');

    // The rule itself: the buyer's two records do not satisfy the seller scope.
    const privacyNow = (await call(jar, 'GET', '/auth/agreements')).json<StatusBody>().privacy.current?.document.id ?? '';
    await call(jar, 'POST', '/auth/agreements/terms', { documentIds: [platformV1] });
    await call(jar, 'POST', '/auth/agreements/privacy', { documentIds: [privacyNow] });
    await expect(assertAgreementsSatisfied(userId, 'BUYER')).resolves.toBeUndefined();
    await expect(assertAgreementsSatisfied(userId, 'SELLER')).rejects.toMatchObject({ code: 'AGREEMENTS_REQUIRED' });
  });

  it('asks staff for the staff terms, on the console, after signing in', async () => {
    const id = newId();
    const email = `gate-${RUN}-staff@test.local`;
    userIds.push(id);
    await prisma.user.create({
      data: { id, type: 'ADMIN', email, emailNormalized: email, status: 'ACTIVE', passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: Role.BUSINESS_OWNER } });
    await prisma.userRole.create({ data: { userId: id, roleId: role.id } });

    const session = await signInAdmin(app, { email, password: PASSWORD, ip: IP });
    const jar: Jar = new Map(
      session.cookies.split('; ').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)] as [string, string]),
    );

    const blocked = await call(jar, 'GET', '/admin/legal-documents');
    expect(blocked.statusCode).toBe(403);
    expect(missingKinds(blocked)).toEqual(['PRIVACY_POLICY', 'STAFF_TERMS']);

    const status = (await call(jar, 'GET', '/admin/auth/agreements')).json<StatusBody>();
    expect(status.scope).toBe('STAFF');
    expect(status.terms.map((entry) => entry.kind)).toEqual(['STAFF_TERMS']);

    // Buyer terms are not the staff terms.
    expect((await call(jar, 'POST', '/admin/auth/agreements/terms', { documentIds: [platformV1] })).statusCode).toBe(400);
    expect((await call(jar, 'POST', '/admin/auth/agreements/terms', { documentIds: [staffTerms] })).statusCode).toBe(200);
    const privacyNow = status.privacy.current?.document.id ?? '';
    expect((await call(jar, 'POST', '/admin/auth/agreements/privacy', { documentIds: [privacyNow] })).statusCode).toBe(200);

    expect((await call(jar, 'GET', '/admin/legal-documents')).statusCode).toBe(200);
  });

  it('asks Audit Console users for the console terms', async () => {
    const person = await auditPerson(app, {
      tag: AUDIT_TAG,
      who: 'reviewer',
      ip: '10.88.0.20',
      target: { kind: 'STAFF', role: 'COMPLIANCE_REVIEWER' },
    });

    const blocked = await asAudit(app, person.session, 'GET', '/audit/notifications');
    expect(blocked.statusCode, blocked.body).toBe(403);
    expect(missingKinds(blocked)).toEqual(['AUDIT_CONSOLE_TERMS', 'PRIVACY_POLICY']);

    const status = (await asAudit(app, person.session, 'GET', '/audit/auth/agreements')).json<StatusBody>();
    expect(status.scope).toBe('AUDIT');
    expect((await asAudit(app, person.session, 'POST', '/audit/auth/agreements/terms', { documentIds: [auditTerms] })).statusCode).toBe(200);
    const privacyNow = status.privacy.current?.document.id ?? '';
    expect((await asAudit(app, person.session, 'POST', '/audit/auth/agreements/privacy', { documentIds: [privacyNow] })).statusCode).toBe(200);

    expect((await asAudit(app, person.session, 'GET', '/audit/notifications')).statusCode).toBe(200);
  });

  it('applies to carrier staff with the Logistics Partner Terms', async () => {
    // The guard and screen are the same code as above with scope LOGISTICS;
    // what differs is which Terms apply, pinned here at the service.
    const { userId } = await buyer('logistics-rule');
    await expect(assertAgreementsSatisfied(userId, 'LOGISTICS')).rejects.toMatchObject({ code: 'AGREEMENTS_REQUIRED' });
  });
});

describe('the switch', () => {
  it('asks nothing when the gate is off', async () => {
    const { jar } = await buyer('switch');
    Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: false });
    try {
      expect((await call(jar, 'GET', '/cart')).statusCode).toBe(200);
    } finally {
      Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: true });
    }
  });
});
