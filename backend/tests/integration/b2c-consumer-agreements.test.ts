/**
 * The storefront's consumer agreement screen, end to end: somebody shopping
 * for themselves accepts the B2C Consumer Terms and Conditions, acknowledges
 * the Privacy Policy and accepts the B2C Platform Services Agreement - three
 * boxes, three records.
 *
 * Pinned here:
 *
 *   - The consumer screen is used only once all three documents are in
 *     force. With one missing an individual is asked on the BUYER screen as
 *     before, so an unfinished set never becomes a sign-in nobody can pass.
 *   - It follows the session, never the request: a company session keeps the
 *     company screen, and a user id in the body is ignored.
 *   - Each box takes only its own document; a draft, an older version or
 *     another screen's document (the Terms of Use, the B2B agreement) is refused.
 *   - A doubled submit writes one row. Each record names the exact document,
 *     its version, language and hash, under the CONSUMER scope.
 *   - Until all three are in place shopping is refused - but existing orders,
 *     returns, claims and support are not. A company session is unchanged.
 *   - Accepting consents to nothing else: no marketing, no recurring order.
 *   - It survives a new sign-in; a new version asks for that document only.
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { legalContentHash, type LegalDocumentKindName } from '../../src/domain/legal-document.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { resetAgreementRequirementCache } from '../../src/modules/legal/agreement.service.js';
import { bumpLegalPublicationGeneration } from '../../src/modules/legal/publication-generation.js';

const RUN = newId().slice(-8).toLowerCase();
const PASSWORD = 'B2cAgreements!2026x';
const IP = '10.88.0.12';

let app: Awaited<ReturnType<typeof buildApp>>;
const userIds: string[] = [];
const companyIds: string[] = [];
const documentIds: string[] = [];
const savedGate = env.FEATURE_AGREEMENT_GATE;
const BASE = Date.now() - 60_000;

type Jar = Map<string, string>;

function absorb(jar: Jar, response: LightMyRequestResponse): Jar {
  for (const cookie of response.cookies as { name: string; value: string }[]) {
    if (cookie.value === '') jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return jar;
}

function call(jar: Jar, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const csrf = [...jar].find(([name]) => name.endsWith('_csrf'))?.[1] ?? '';
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      'x-csrf-token': csrf,
      'x-forwarded-for': IP,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function publish(
  kind: LegalDocumentKindName,
  step: number,
  options: { status?: 'PUBLISHED' | 'DRAFT' } = {},
): Promise<string> {
  const id = newId();
  const content = {
    kind,
    version: `b2c-${RUN}-${String(step)}`,
    locale: 'en',
    title: `TEST FIXTURE - ${kind}, step ${String(step)} - not legal text`,
    body: '## Test fixture\nInstalled by the B2C agreements test. Not an agreement and not approved.',
  };
  const at = new Date(BASE + step * 10_000);
  const published = (options.status ?? 'PUBLISHED') === 'PUBLISHED';
  await prisma.legalDocument.create({
    data: {
      id,
      ...content,
      status: published ? 'PUBLISHED' : 'DRAFT',
      effectiveAt: at,
      publishedAt: published ? at : null,
      contentSha256: published ? legalContentHash(content) : null,
    },
  });
  documentIds.push(id);
  bumpLegalPublicationGeneration();
  resetAgreementRequirementCache();
  return id;
}

async function person(label: string): Promise<{ userId: string; email: string; profileId: string }> {
  const userId = newId();
  const profileId = newId();
  const email = `b2c-${RUN}-${label}@test.local`;
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
  await prisma.customerProfile.create({ data: { id: profileId, userId, fullName: `B2C agreements ${label}` } });
  return { userId, email, profileId };
}

async function signIn(email: string, buyerType: 'individual' | 'company'): Promise<Jar> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': IP },
    payload: { email, password: PASSWORD, buyerType },
  });
  expect(login.statusCode, login.body).toBe(200);
  return absorb(new Map(), login);
}

interface Entry {
  kind: string;
  current: { document: { id: string; version: string } } | null;
  record: { version: string; recordId: string } | null;
  unavailable: boolean;
}
interface StatusBody {
  scope: string;
  terms: Entry[];
  services: Entry[];
  privacy: Entry;
  termsComplete: boolean;
  servicesComplete: boolean;
  privacyComplete: boolean;
  complete: boolean;
}

const status = async (jar: Jar): Promise<StatusBody> =>
  (await call(jar, 'GET', '/auth/agreements?locale=en')).json<StatusBody>();

const accept = (jar: Jar, box: 'terms' | 'privacy' | 'services', documentId: string, extra: object = {}) =>
  call(jar, 'POST', `/auth/agreements/${box}`, { documentIds: [documentId], locale: 'en', ...extra });

const shop = async (jar: Jar): Promise<number> => (await call(jar, 'GET', '/account/addresses')).statusCode;

let platform: string;
let privacy: string;
let consumerTerms: string;
let consumerServices: string;
let b2bServices: string;
let shopper: { userId: string; email: string; profileId: string };
let other: { userId: string; email: string; profileId: string };
let jar: Jar;
let otherJar: Jar;
let companyJar: Jar;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  platform = await publish('PLATFORM_TERMS', 1);
  privacy = await publish('PRIVACY_POLICY', 1);
  // Two of the three: the consumer screen is not yet complete enough to use.
  consumerTerms = await publish('B2C_CONSUMER_TERMS', 1);
  b2bServices = await publish('B2B_BUYER_SERVICES_AGREEMENT', 1);
  Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: true });

  shopper = await person('shopper');
  other = await person('other');
  const owner = await person('company-owner');
  const companyId = newId();
  companyIds.push(companyId);
  await prisma.buyerCompany.create({
    data: {
      id: companyId,
      applicationReference: `B2C${companyId.slice(-10)}`,
      createdByUserId: owner.userId,
      legalName: `B2C ${RUN} Company Ltd`,
      status: 'SUBMITTED',
    },
  });
  await prisma.buyerCompanyMember.create({
    data: { id: newId(), companyId, userId: owner.userId, role: 'OWNER' },
  });
  jar = await signIn(shopper.email, 'individual');
  otherJar = await signIn(other.email, 'individual');
  companyJar = await signIn(owner.email, 'company');
});

afterAll(async () => {
  Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: savedGate });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.consentRecord.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.consentRecord.deleteMany({ where: { legalDocumentId: { in: documentIds } } });
  await prisma.buyerCompanyMember.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerCompany.deleteMany({ where: { id: { in: companyIds } } });
  await prisma.customerPreference.deleteMany({ where: { customerProfile: { userId: { in: userIds } } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  for (const id of [...documentIds].reverse()) await prisma.legalDocument.deleteMany({ where: { id } });
  bumpLegalPublicationGeneration();
  resetAgreementRequirementCache();
  await app?.close();
});

describe('before every consumer document is in force', () => {
  it('asks an individual on the BUYER screen as before, never for a document that is not there', async () => {
    const body = await status(otherJar);
    expect(body.scope).toBe('BUYER');
    expect(body.terms.map((entry) => entry.kind)).toEqual(['PLATFORM_TERMS']);
    expect(body.services).toEqual([]);
  });

  it('refuses the consumer Terms on that screen, and can be completed - no sign-in deadlock', async () => {
    expect((await accept(otherJar, 'terms', consumerTerms)).statusCode).toBe(400);
    expect((await accept(otherJar, 'terms', platform)).statusCode).toBe(200);
    expect((await accept(otherJar, 'privacy', privacy)).statusCode).toBe(200);
    expect(await shop(otherJar)).toBe(200);
  });
});

describe('once all three are in force', () => {
  beforeAll(async () => {
    consumerServices = await publish('B2C_PLATFORM_SERVICES_AGREEMENT', 1);
  });

  it('shows an individual the three consumer documents, under the CONSUMER scope', async () => {
    const body = await status(jar);
    expect(body.scope).toBe('CONSUMER');
    expect(body.terms.map((entry) => entry.kind)).toEqual(['B2C_CONSUMER_TERMS']);
    expect(body.services.map((entry) => entry.kind)).toEqual(['B2C_PLATFORM_SERVICES_AGREEMENT']);
    expect(body.privacy.kind).toBe('PRIVACY_POLICY');
    expect(body.complete).toBe(false);
  });

  it('asks again prospectively: an earlier Terms of Use acceptance is kept and not carried across', async () => {
    const body = await status(otherJar);
    expect(body.scope).toBe('CONSUMER');
    expect(body.termsComplete).toBe(false);
    expect(body.servicesComplete).toBe(false);
    // The privacy notice is the same document on both screens.
    expect(body.privacyComplete).toBe(true);
    expect(await prisma.consentRecord.count({ where: { userId: other.userId, legalDocumentId: platform, activeDocumentId: platform } })).toBe(1);
    expect(await shop(otherJar)).toBe(403);
  });

  it('keeps a company session on the company screen, unchanged', async () => {
    const body = await status(companyJar);
    expect(body.scope).toBe('COMPANY_BUYER');
    expect(body.terms.every((entry) => entry.kind !== 'B2C_CONSUMER_TERMS')).toBe(true);
    // The company's orders still wait for the company screen.
    expect((await call(companyJar, 'GET', '/orders')).statusCode).toBe(403);
  });

  it('refuses shopping until every box is done, with AGREEMENTS_REQUIRED', async () => {
    const response = await call(jar, 'GET', '/account/addresses');
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('AGREEMENTS_REQUIRED');
    expect((await call(jar, 'GET', '/cart')).statusCode).toBe(403);
  });

  it('never stands between a consumer and their orders, returns, claims or support', async () => {
    for (const url of ['/orders', '/returns', '/disputes', '/support/tickets', '/legal/in-force', `/legal/documents/${consumerTerms}`]) {
      const response = await call(jar, 'GET', url);
      expect(response.statusCode, `${url}: ${response.body}`).toBeLessThan(400);
    }
  });

  it('takes only its own document in each box', async () => {
    const wrong: ['terms' | 'privacy' | 'services', string][] = [
      ['terms', platform],
      ['terms', consumerServices],
      ['services', consumerTerms],
      ['services', b2bServices],
      ['privacy', consumerTerms],
    ];
    for (const [box, id] of wrong) {
      const response = await accept(jar, box, id);
      expect(response.statusCode, `${box} <- ${id}`).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('AGREEMENT_DOCUMENT_NOT_APPLICABLE');
    }
    const draft = await publish('B2C_CONSUMER_TERMS', 2, { status: 'DRAFT' });
    expect((await accept(jar, 'terms', draft)).statusCode).toBe(400);
    expect(await prisma.consentRecord.count({ where: { userId: shopper.userId } })).toBe(0);
  });

  it('records one box at a time; the others stay empty', async () => {
    expect((await accept(jar, 'terms', consumerTerms)).statusCode).toBe(200);
    const body = await status(jar);
    expect(body.termsComplete).toBe(true);
    expect(body.privacyComplete).toBe(false);
    expect(body.servicesComplete).toBe(false);
    expect(await shop(jar)).toBe(403);
  });

  it('writes one row for a doubled submit, and only for the signed-in person', async () => {
    const results = await Promise.allSettled([
      accept(jar, 'services', consumerServices, { userId: other.userId }),
      accept(jar, 'services', consumerServices, { userId: other.userId }),
    ]);
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') expect(result.value.statusCode).toBe(200);
    }
    expect(await prisma.consentRecord.count({ where: { userId: shopper.userId, legalDocumentId: consumerServices } })).toBe(1);
    expect(await prisma.consentRecord.count({ where: { userId: other.userId, legalDocumentId: consumerServices } })).toBe(0);
  });

  it('lets the consumer shop once the Privacy Policy is acknowledged too', async () => {
    expect((await accept(jar, 'privacy', privacy)).statusCode).toBe(200);
    expect((await status(jar)).complete).toBe(true);
    expect(await shop(jar)).toBe(200);
  });

  it('records each document exactly: version, language, hash, server time, CONSUMER scope', async () => {
    const rows = await prisma.consentRecord.findMany({
      where: { userId: shopper.userId, activeDocumentId: { not: null } },
      include: { legalDocument: true },
    });
    expect(rows.map((row) => row.legalDocument?.kind).sort()).toEqual([
      'B2C_CONSUMER_TERMS',
      'B2C_PLATFORM_SERVICES_AGREEMENT',
      'PRIVACY_POLICY',
    ]);
    for (const row of rows) {
      expect(row.scope).toBe('CONSUMER');
      expect(row.textVersion).toBe(row.legalDocument?.version);
      expect(row.textHash).toBe(row.legalDocument?.contentSha256);
      expect(row.locale).toBe('en');
      expect(row.acceptanceSource).toBe('AGREEMENT_SCREEN');
      expect(Math.abs(row.acceptedAt.getTime() - Date.now())).toBeLessThan(5 * 60_000);
    }
    expect(rows.find((row) => row.purpose === 'PRIVACY_NOTICE')?.action).toBe('PRIVACY_NOTICE_ACKNOWLEDGED');
  });

  it('consents to nothing optional: no marketing, no recurring order, no other record', async () => {
    expect(await prisma.consentRecord.count({ where: { userId: shopper.userId } })).toBe(3);
    const preference = await prisma.customerPreference.findUnique({ where: { customerProfileId: shopper.profileId } });
    expect(preference?.marketingEmailOptIn ?? false).toBe(false);
    expect(preference?.marketingSmsOptIn ?? false).toBe(false);
    expect(await prisma.recurringSchedule.count({ where: { customerProfileId: shopper.profileId } })).toBe(0);
  });

  it('keeps the accepted version readable and downloadable afterwards', async () => {
    const pdf = await call(jar, 'GET', `/legal/documents/${consumerTerms}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('is remembered at the next sign-in', async () => {
    const again = await signIn(shopper.email, 'individual');
    expect((await status(again)).complete).toBe(true);
    expect(await shop(again)).toBe(200);
  });
});

describe('unticking and a new version', () => {
  it('unticks the services box without deleting the record, and asks again', async () => {
    expect((await call(jar, 'DELETE', '/auth/agreements/services?locale=en')).statusCode).toBe(200);
    const row = await prisma.consentRecord.findFirstOrThrow({ where: { userId: shopper.userId, legalDocumentId: consumerServices } });
    expect(row.activeDocumentId).toBeNull();
    expect(row.clearedAt).not.toBeNull();
    const body = await status(jar);
    expect(body.servicesComplete).toBe(false);
    expect(body.termsComplete).toBe(true);
    expect(await shop(jar)).toBe(403);
    expect((await accept(jar, 'services', consumerServices)).statusCode).toBe(200);
  });

  it('asks for a new version of the consumer Terms only, and refuses the old one', async () => {
    const next = await publish('B2C_CONSUMER_TERMS', 3);
    const body = await status(jar);
    expect(body.termsComplete).toBe(false);
    expect(body.servicesComplete).toBe(true);
    expect(body.privacyComplete).toBe(true);
    expect(await shop(jar)).toBe(403);

    const stale = await accept(jar, 'terms', consumerTerms);
    expect(stale.statusCode).toBeGreaterThanOrEqual(400);
    expect((await accept(jar, 'terms', next)).statusCode).toBe(200);
    expect(await shop(jar)).toBe(200);
    // The older acceptance stays in the history.
    expect(await prisma.consentRecord.count({ where: { userId: shopper.userId, legalDocumentId: consumerTerms } })).toBe(1);
  });
});
