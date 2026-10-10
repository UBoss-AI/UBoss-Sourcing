/**
 * The storefront's company agreement screen, end to end: somebody acting for
 * a buyer company accepts the B2B Buyer Terms and Conditions, acknowledges the
 * Privacy Policy, and the company accepts the B2B Buyer Platform Services
 * Agreement - once, through an owner or company admin.
 *
 * Pinned here:
 *
 *   - The screen follows the session's CONFIRMED company context, never the
 *     sign-in tab or the request: a company session gets the company screen,
 *     an individual session the buyer one.
 *   - Every protected storefront request from a company session is refused
 *     with AGREEMENTS_REQUIRED until all three are in place.
 *   - A member who cannot bind the company is refused the services
 *     agreement, and waits for one who can. Once the company has accepted it,
 *     nobody else countersigns - and nobody else can clear it.
 *   - Each record names the exact published document, its hash and the
 *     company; a doubled submit writes one row; another company sees none of
 *     it; a draft or another kind of document is refused.
 *   - A new version asks again for that document only.
 *   - Accepting never changes the company's verification status.
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
const PASSWORD = 'B2bAgreements!2026x';
const IP = '10.88.0.9';

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
    version: `b2b-${RUN}-${String(step)}`,
    locale: 'en',
    title: `${kind} for the B2B agreements test, step ${String(step)}`,
    body: '## Test document\nInstalled by the B2B agreements test. Not legal text.',
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

async function company(label: string, ownerUserId: string): Promise<string> {
  const id = newId();
  companyIds.push(id);
  await prisma.buyerCompany.create({
    data: {
      id,
      applicationReference: `B2B${id.slice(-10)}`,
      createdByUserId: ownerUserId,
      legalName: `B2B ${RUN} ${label} Ltd`,
      // Under review: accepting the agreements must not approve it.
      status: 'SUBMITTED',
    },
  });
  return id;
}

interface Person {
  userId: string;
  jar: Jar;
}

async function person(label: string): Promise<{ userId: string; email: string }> {
  const userId = newId();
  const email = `b2b-${RUN}-${label}@test.local`;
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
  await prisma.customerProfile.create({ data: { id: newId(), userId, fullName: `B2B agreements ${label}` } });
  return { userId, email };
}

async function signIn(email: string, userId: string, buyerType: 'individual' | 'company'): Promise<Person> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': IP },
    payload: { email, password: PASSWORD, buyerType },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { userId, jar: absorb(new Map(), login) };
}

interface Entry {
  kind: string;
  current: { document: { id: string; version: string } } | null;
  record: { version: string; recordId: string; byOtherMember: boolean } | null;
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
  company: { companyId: string; companyName: string; canBind: boolean } | null;
  awaitingSignatory: boolean;
}

const status = async (person: Person): Promise<StatusBody> =>
  (await call(person.jar, 'GET', '/auth/agreements?locale=en')).json<StatusBody>();

const accept = (person: Person, box: 'terms' | 'privacy' | 'services', documentId: string) =>
  call(person.jar, 'POST', `/auth/agreements/${box}`, { documentIds: [documentId], locale: 'en' });

let platform: string;
let privacy: string;
let b2bTerms: string;
let b2bServices: string;
let companyA: string;
let companyB: string;
let owner: Person;
let member: Person;
let otherOwner: Person;
let individual: Person;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  platform = await publish('PLATFORM_TERMS', 1);
  privacy = await publish('PRIVACY_POLICY', 1);
  b2bTerms = await publish('B2B_BUYER_TERMS', 1);
  b2bServices = await publish('B2B_BUYER_SERVICES_AGREEMENT', 1);
  Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: true });

  const o = await person('owner');
  const m = await person('member');
  const b = await person('other-owner');
  const i = await person('individual');
  companyA = await company('A', o.userId);
  companyB = await company('B', b.userId);
  await prisma.buyerCompanyMember.createMany({
    data: [
      { id: newId(), companyId: companyA, userId: o.userId, role: 'OWNER' },
      { id: newId(), companyId: companyA, userId: m.userId, role: 'BUYER' },
      { id: newId(), companyId: companyB, userId: b.userId, role: 'OWNER' },
    ],
  });
  owner = await signIn(o.email, o.userId, 'company');
  member = await signIn(m.email, m.userId, 'company');
  otherOwner = await signIn(b.email, b.userId, 'company');
  individual = await signIn(i.email, i.userId, 'individual');
});

afterAll(async () => {
  Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: savedGate });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.consentRecord.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.consentRecord.deleteMany({ where: { legalDocumentId: { in: documentIds } } });
  await prisma.buyerCompanyMember.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerCompany.deleteMany({ where: { id: { in: companyIds } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  for (const id of [...documentIds].reverse()) await prisma.legalDocument.deleteMany({ where: { id } });
  bumpLegalPublicationGeneration();
  resetAgreementRequirementCache();
  await app?.close();
});

describe('which screen applies', () => {
  it('shows a company session the three company documents, for its own company', async () => {
    const body = await status(owner);
    expect(body.scope).toBe('COMPANY_BUYER');
    expect(body.terms.map((entry) => entry.kind)).toEqual(['B2B_BUYER_TERMS']);
    expect(body.services.map((entry) => entry.kind)).toEqual(['B2B_BUYER_SERVICES_AGREEMENT']);
    expect(body.privacy.kind).toBe('PRIVACY_POLICY');
    expect(body.complete).toBe(false);
    expect(body.company).toMatchObject({ companyId: companyA, canBind: true });
  });

  it('leaves an individual session on the buyer screen, with no company documents', async () => {
    const body = await status(individual);
    expect(body.scope).toBe('BUYER');
    expect(body.terms.map((entry) => entry.kind)).toEqual(['PLATFORM_TERMS']);
    expect(body.services).toEqual([]);
    expect(body.company).toBeNull();
  });

  it('refuses a protected request from a company session until all three are in place', async () => {
    const response = await call(owner.jar, 'GET', '/account/addresses');
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('AGREEMENTS_REQUIRED');
  });
});

describe('what each box accepts', () => {
  it('refuses the buyer Terms of Use, a draft, or a made-up id under the company Terms box', async () => {
    const draft = await publish('B2B_BUYER_TERMS', 2, { status: 'DRAFT' });
    for (const id of [platform, draft, newId()]) {
      const response = await accept(owner, 'terms', id);
      expect(response.statusCode, id).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('AGREEMENT_DOCUMENT_NOT_APPLICABLE');
    }
    expect(await prisma.consentRecord.count({ where: { userId: owner.userId } })).toBe(0);
  });

  it('refuses the services agreement from a member who cannot bind the company', async () => {
    const response = await accept(member, 'services', b2bServices);
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('COMPANY_SIGNATORY_REQUIRED');
    const body = await status(member);
    expect(body.company?.canBind).toBe(false);
    expect(body.awaitingSignatory).toBe(true);
    expect(await prisma.consentRecord.count({ where: { userId: member.userId } })).toBe(0);
  });
});

describe('the owner accepts', () => {
  it('records the B2B Terms for the company, once, however often it is sent', async () => {
    const [first, second] = await Promise.allSettled([accept(owner, 'terms', b2bTerms), accept(owner, 'terms', b2bTerms)]);
    expect(first.status === 'fulfilled' && first.value.statusCode).toBe(200);
    expect(second.status === 'fulfilled' && second.value.statusCode).toBe(200);
    const rows = await prisma.consentRecord.findMany({ where: { userId: owner.userId, legalDocumentId: b2bTerms } });
    expect(rows).toHaveLength(1);
    const document = await prisma.legalDocument.findUniqueOrThrow({ where: { id: b2bTerms } });
    expect(rows[0]).toMatchObject({
      purpose: 'B2B_BUYER_TERMS',
      action: 'TERMS_ACCEPTED',
      scope: 'COMPANY_BUYER',
      companyId: companyA,
      activeCompanyKey: companyA,
      textHash: document.contentSha256,
      textVersion: document.version,
    });
  });

  it('is not complete with two of three, and the gate still refuses', async () => {
    expect((await accept(owner, 'privacy', privacy)).statusCode).toBe(200);
    const body = await status(owner);
    expect(body.termsComplete && body.privacyComplete).toBe(true);
    expect(body.complete).toBe(false);
    expect((await call(owner.jar, 'GET', '/account/addresses')).statusCode).toBe(403);
  });

  it('accepts the services agreement for the company, and lets the owner through', async () => {
    expect((await accept(owner, 'services', b2bServices)).statusCode).toBe(200);
    expect((await status(owner)).complete).toBe(true);
    expect((await call(owner.jar, 'GET', '/account/addresses')).statusCode).toBe(200);
    const row = await prisma.consentRecord.findFirstOrThrow({ where: { legalDocumentId: b2bServices } });
    expect(row).toMatchObject({ userId: owner.userId, companyId: companyA, purpose: 'B2B_BUYER_SERVICES_AGREEMENT' });
  });

  it('does not change the company verification status', async () => {
    const row = await prisma.buyerCompany.findUniqueOrThrow({ where: { id: companyA }, select: { status: true } });
    expect(row.status).toBe('SUBMITTED');
  });
});

describe('another member of the same company', () => {
  it('sees the services agreement accepted for the company and is not asked to countersign', async () => {
    const body = await status(member);
    expect(body.servicesComplete).toBe(true);
    expect(body.services[0]?.record?.byOtherMember).toBe(true);
    expect(body.awaitingSignatory).toBe(false);
    // Their own Terms are still theirs to accept.
    expect(body.termsComplete).toBe(false);
  });

  it('cannot clear the company acceptance an owner gave', async () => {
    const response = await call(member.jar, 'DELETE', '/auth/agreements/services?locale=en');
    expect(response.statusCode).toBe(404);
    expect(await prisma.consentRecord.count({ where: { legalDocumentId: b2bServices, activeDocumentId: { not: null } } })).toBe(1);
  });

  it('gets through after their own Terms and Privacy Policy', async () => {
    expect((await accept(member, 'terms', b2bTerms)).statusCode).toBe(200);
    expect((await accept(member, 'privacy', privacy)).statusCode).toBe(200);
    expect((await status(member)).complete).toBe(true);
    expect((await call(member.jar, 'GET', '/account/addresses')).statusCode).toBe(200);
    expect(await prisma.consentRecord.count({ where: { userId: member.userId, legalDocumentId: b2bServices } })).toBe(0);
  });
});

describe('another company', () => {
  it('sees none of company A’s acceptances', async () => {
    const body = await status(otherOwner);
    expect(body.company?.companyId).toBe(companyB);
    expect(body.services[0]?.record).toBeNull();
    expect(body.terms[0]?.record).toBeNull();
    expect((await call(otherOwner.jar, 'GET', '/account/addresses')).statusCode).toBe(403);
  });
});

describe('unticking and a new version', () => {
  it('unticks without deleting the record, and the gate asks again', async () => {
    const response = await call(owner.jar, 'DELETE', '/auth/agreements/terms?locale=en');
    expect(response.statusCode).toBe(200);
    const row = await prisma.consentRecord.findFirstOrThrow({ where: { userId: owner.userId, legalDocumentId: b2bTerms } });
    expect(row.activeDocumentId).toBeNull();
    expect(row.clearedAt).not.toBeNull();
    expect((await call(owner.jar, 'GET', '/account/addresses')).statusCode).toBe(403);
    expect((await accept(owner, 'terms', b2bTerms)).statusCode).toBe(200);
  });

  it('asks for a new version of the B2B Terms only, and refuses the old one', async () => {
    const next = await publish('B2B_BUYER_TERMS', 3);
    const body = await status(owner);
    expect(body.termsComplete).toBe(false);
    expect(body.servicesComplete).toBe(true);
    expect(body.privacyComplete).toBe(true);
    expect((await call(owner.jar, 'GET', '/account/addresses')).statusCode).toBe(403);

    const stale = await accept(owner, 'terms', b2bTerms);
    expect(stale.statusCode).toBeGreaterThanOrEqual(400);
    expect((await accept(owner, 'terms', next)).statusCode).toBe(200);
    expect((await call(owner.jar, 'GET', '/account/addresses')).statusCode).toBe(200);
  });
});
