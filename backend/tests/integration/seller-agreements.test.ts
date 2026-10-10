/**
 * The Seller Hub's two seller agreements, end to end: the Seller Terms and
 * Conditions (under the Terms box, with the Terms of Use) and the Seller
 * Platform Services Agreement (its own box).
 *
 * Pinned here:
 *
 *   - The services agreement is its own box: accepting the Terms never
 *     accepts it, a document of the wrong kind is refused under each box, and
 *     a buyer is never asked for it.
 *   - Each record names the exact published document, its version and hash,
 *     the server's time, and the seller the person is a member of - taken
 *     from their membership, never from the request.
 *   - A doubled submit writes one row; clearing keeps the row.
 *   - Submitting an application needs both, published and accepted in a
 *     version that still counts: an unpublished kind, a draft, a replaced
 *     version and a record given for another seller are all refused.
 *   - Accepting changes nothing about the seller's verification.
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { legalContentHash, type LegalDocumentKindName } from '../../src/domain/legal-document.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  assertAgreementsSatisfied,
  assertSellerSubmissionAgreements,
  resetAgreementRequirementCache,
} from '../../src/modules/legal/agreement.service.js';
import { bumpLegalPublicationGeneration } from '../../src/modules/legal/publication-generation.js';

const RUN = newId().slice(-8).toLowerCase();
const PASSWORD = 'SellerAgreements!2026x';
const IP = '10.88.0.7';

let app: Awaited<ReturnType<typeof buildApp>>;
const userIds: string[] = [];
const sellerIds: string[] = [];
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
    version: `sa-${RUN}-${String(step)}`,
    locale: 'en',
    title: `${kind} for the seller agreements test, step ${String(step)}`,
    body: '## Test document\nInstalled by the seller agreements test. Not legal text.',
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

interface Person {
  userId: string;
  sellerAccountId: string | null;
  jar: Jar;
}

async function person(label: string, options: { seller: boolean }): Promise<Person> {
  const userId = newId();
  const email = `sa-${RUN}-${label}@test.local`;
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
  const profileId = newId();
  await prisma.customerProfile.create({ data: { id: profileId, userId, fullName: `Seller agreements ${label}` } });

  let sellerAccountId: string | null = null;
  if (options.seller) {
    sellerAccountId = newId();
    sellerIds.push(sellerAccountId);
    const name = `SA ${RUN} ${label}`;
    await prisma.sellerAccount.create({
      data: {
        id: sellerAccountId,
        legalName: `${name} Pvt Ltd`,
        displayName: name,
        displayNameNormalized: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
        slug: `sa-${RUN}-${label}`,
        kind: 'MANUFACTURER',
        status: 'DRAFT',
        registrationCountry: 'IN',
      },
    });
    await prisma.sellerMember.create({
      data: { id: newId(), sellerAccountId, customerProfileId: profileId, role: 'OWNER' },
    });
  }

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': IP },
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { userId, sellerAccountId, jar: absorb(new Map(), login) };
}

interface Entry {
  kind: string;
  current: { document: { id: string; version: string } } | null;
  record: { version: string; recordId: string } | null;
  unavailable: boolean;
}
interface StatusBody {
  terms: Entry[];
  services: Entry[];
  privacy: Entry;
  termsComplete: boolean;
  servicesComplete: boolean;
  complete: boolean;
}

const sellerStatus = async (jar: Jar): Promise<StatusBody> =>
  (await call(jar, 'GET', '/auth/agreements?scope=SELLER&locale=en')).json<StatusBody>();

async function submissionError(userId: string, sellerAccountId: string): Promise<{ code: string; details: { field: string; code: string }[] }> {
  try {
    await assertSellerSubmissionAgreements(userId, sellerAccountId);
  } catch (error) {
    return error as { code: string; details: { field: string; code: string }[] };
  }
  throw new Error('Expected the submission to be refused');
}

let platform: string;
let privacy: string;
let sellerTerms: string;
let services: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  platform = await publish('PLATFORM_TERMS', 1);
  privacy = await publish('PRIVACY_POLICY', 1);
  sellerTerms = await publish('SELLER_TERMS', 1);
  Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: true });
});

afterAll(async () => {
  Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: savedGate });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.consentRecord.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.consentRecord.deleteMany({ where: { legalDocumentId: { in: documentIds } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  for (const id of [...documentIds].reverse()) await prisma.legalDocument.deleteMany({ where: { id } });
  bumpLegalPublicationGeneration();
  resetAgreementRequirementCache();
  await app?.close();
});

describe('before the services agreement is published', () => {
  it('does not lock the Hub, but refuses submission and says which is missing', async () => {
    // Only meaningful while no other file has one published.
    const others = await prisma.legalDocument.count({ where: { kind: 'SELLER_SERVICES_AGREEMENT', status: 'PUBLISHED' } });
    if (others > 0) return;

    const seller = await person('early', { seller: true });
    const status = await sellerStatus(seller.jar);
    expect(status.services).toHaveLength(1);
    expect(status.services[0]?.unavailable).toBe(true);

    await call(seller.jar, 'POST', '/auth/agreements/terms', { scope: 'SELLER', documentIds: [platform, sellerTerms] });
    const error = await submissionError(seller.userId, seller.sellerAccountId ?? '');
    expect(error.code).toBe('SELLER_AGREEMENTS_REQUIRED');
    expect(error.details).toEqual([expect.objectContaining({ field: 'SELLER_SERVICES_AGREEMENT', code: 'AGREEMENT_NOT_PUBLISHED' })]);
  });
});

describe('the services agreement box', () => {
  beforeAll(async () => {
    services = await publish('SELLER_SERVICES_AGREEMENT', 2);
  });

  it('is its own box: the Terms never accept it, and the wrong kind is refused under each', async () => {
    const seller = await person('box', { seller: true });

    let status = await sellerStatus(seller.jar);
    expect(status.terms.map((entry) => entry.kind)).toEqual(['PLATFORM_TERMS', 'SELLER_TERMS']);
    expect(status.services.map((entry) => entry.kind)).toEqual(['SELLER_SERVICES_AGREEMENT']);
    expect(status.services[0]?.record).toBeNull();

    // The services agreement under the Terms box, and the seller terms under the services box.
    const wrongUnderTerms = await call(seller.jar, 'POST', '/auth/agreements/terms', { scope: 'SELLER', documentIds: [services] });
    expect(wrongUnderTerms.statusCode).toBe(400);
    expect(wrongUnderTerms.json<{ error: { code: string } }>().error.code).toBe('AGREEMENT_DOCUMENT_NOT_APPLICABLE');
    const wrongUnderServices = await call(seller.jar, 'POST', '/auth/agreements/services', { scope: 'SELLER', documentIds: [sellerTerms] });
    expect(wrongUnderServices.statusCode).toBe(400);
    expect(wrongUnderServices.json<{ error: { code: string } }>().error.code).toBe('AGREEMENT_DOCUMENT_NOT_APPLICABLE');

    // Terms and privacy done: the services box is still empty and the gate still asks for it.
    expect((await call(seller.jar, 'POST', '/auth/agreements/terms', { scope: 'SELLER', documentIds: [platform, sellerTerms] })).statusCode).toBe(200);
    expect((await call(seller.jar, 'POST', '/auth/agreements/privacy', { scope: 'SELLER', documentIds: [privacy] })).statusCode).toBe(200);
    status = await sellerStatus(seller.jar);
    expect(status.termsComplete).toBe(true);
    expect(status.servicesComplete).toBe(false);
    expect(status.complete).toBe(false);
    await expect(assertAgreementsSatisfied(seller.userId, 'SELLER')).rejects.toMatchObject({
      code: 'AGREEMENTS_REQUIRED',
      details: [expect.objectContaining({ meta: { kind: 'SELLER_SERVICES_AGREEMENT', scope: 'SELLER' } })],
    });

    // Accepting it alone touches nothing else.
    const accepted = await call(seller.jar, 'POST', '/auth/agreements/services', { scope: 'SELLER', documentIds: [services] });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json<StatusBody>().complete).toBe(true);
    await expect(assertAgreementsSatisfied(seller.userId, 'SELLER')).resolves.toBeUndefined();
  });

  it('is never asked of a buyer, and a buyer cannot record it', async () => {
    const buyer = await person('buyer', { seller: false });
    const status = (await call(buyer.jar, 'GET', '/auth/agreements')).json<StatusBody>();
    expect(status.services).toEqual([]);

    const refused = await call(buyer.jar, 'POST', '/auth/agreements/services', { documentIds: [services] });
    expect(refused.statusCode).toBe(400);
    expect(await prisma.consentRecord.count({ where: { userId: buyer.userId } })).toBe(0);

    // Naming SELLER without being a member of one is refused outright.
    const notSeller = await call(buyer.jar, 'POST', '/auth/agreements/services', { scope: 'SELLER', documentIds: [services] });
    expect(notSeller.json<{ error: { code: string } }>().error.code).toBe('SELLER_ACCOUNT_REQUIRED');
  });

  it('records the exact document, hash, server time and the member’s own seller, once', async () => {
    const seller = await person('record', { seller: true });
    const before = Date.now();
    const body = { scope: 'SELLER', documentIds: [services], sellerAccountId: 'not-taken-from-here' };
    const [first, second] = await Promise.allSettled([
      call(seller.jar, 'POST', '/auth/agreements/services', body),
      call(seller.jar, 'POST', '/auth/agreements/services', body),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');

    const rows = await prisma.consentRecord.findMany({ where: { userId: seller.userId } });
    expect(rows).toHaveLength(1);
    const document = await prisma.legalDocument.findUniqueOrThrow({ where: { id: services } });
    expect(rows[0]).toMatchObject({
      purpose: 'SELLER_SERVICES_AGREEMENT',
      action: 'TERMS_ACCEPTED',
      scope: 'SELLER',
      legalDocumentId: services,
      activeDocumentId: services,
      textVersion: document.version,
      textHash: document.contentSha256,
      sellerAccountId: seller.sellerAccountId,
      acceptanceSource: 'AGREEMENT_SCREEN',
    });
    expect(rows[0]?.acceptedAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);

    // Accepting is not approval: the seller's application is where it was.
    const account = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: seller.sellerAccountId ?? '' } });
    expect(account.status).toBe('DRAFT');
    expect(account.approvedAt).toBeNull();
  });

  it('clears only its own box, and keeps the row', async () => {
    const seller = await person('clear', { seller: true });
    await call(seller.jar, 'POST', '/auth/agreements/terms', { scope: 'SELLER', documentIds: [platform, sellerTerms] });
    await call(seller.jar, 'POST', '/auth/agreements/services', { scope: 'SELLER', documentIds: [services] });

    const cleared = await call(seller.jar, 'DELETE', '/auth/agreements/services?scope=SELLER&locale=en');
    expect(cleared.statusCode, cleared.body).toBe(200);
    const status = cleared.json<StatusBody>();
    expect(status.servicesComplete).toBe(false);
    expect(status.termsComplete).toBe(true);

    const row = await prisma.consentRecord.findFirstOrThrow({ where: { userId: seller.userId, legalDocumentId: services } });
    expect(row.clearedAt).not.toBeNull();
    expect(row.activeDocumentId).toBeNull();
  });
});

describe('submitting an application', () => {
  it('needs both agreements accepted, in the version in force, for this seller', async () => {
    const seller = await person('submit', { seller: true });
    const sellerAccountId = seller.sellerAccountId ?? '';

    let error = await submissionError(seller.userId, sellerAccountId);
    expect(error.details.map((detail) => `${detail.field}:${detail.code}`).sort()).toEqual([
      'SELLER_SERVICES_AGREEMENT:AGREEMENT_NOT_ACCEPTED',
      'SELLER_TERMS:AGREEMENT_NOT_ACCEPTED',
    ]);

    await call(seller.jar, 'POST', '/auth/agreements/terms', { scope: 'SELLER', documentIds: [platform, sellerTerms] });
    error = await submissionError(seller.userId, sellerAccountId);
    expect(error.details).toEqual([expect.objectContaining({ field: 'SELLER_SERVICES_AGREEMENT', code: 'AGREEMENT_NOT_ACCEPTED' })]);

    await call(seller.jar, 'POST', '/auth/agreements/services', { scope: 'SELLER', documentIds: [services] });
    const confirmed = await assertSellerSubmissionAgreements(seller.userId, sellerAccountId);
    expect(confirmed.map((row) => `${row.kind}:${row.legalDocumentId}`).sort()).toEqual([
      `SELLER_SERVICES_AGREEMENT:${services}`,
      `SELLER_TERMS:${sellerTerms}`,
    ]);

    // A record given for another seller does not count for this one.
    const other = await person('other-seller', { seller: true });
    error = await submissionError(seller.userId, other.sellerAccountId ?? '');
    expect(error.code).toBe('SELLER_AGREEMENTS_REQUIRED');
  });

  it('ignores a newer draft, and asks again after a version that requires it', async () => {
    const seller = await person('versions', { seller: true });
    const sellerAccountId = seller.sellerAccountId ?? '';
    await call(seller.jar, 'POST', '/auth/agreements/terms', { scope: 'SELLER', documentIds: [platform, sellerTerms] });
    await call(seller.jar, 'POST', '/auth/agreements/services', { scope: 'SELLER', documentIds: [services] });

    // A draft is never in force and never needed.
    const draft = await publish('SELLER_SERVICES_AGREEMENT', 3, { status: 'DRAFT' });
    await expect(assertSellerSubmissionAgreements(seller.userId, sellerAccountId)).resolves.toHaveLength(2);
    const draftUnderBox = await call(seller.jar, 'POST', '/auth/agreements/services', { scope: 'SELLER', documentIds: [draft] });
    expect(draftUnderBox.statusCode).toBe(400);

    // A published replacement: the old acceptance no longer counts, and the old id is refused.
    const v2 = await publish('SELLER_SERVICES_AGREEMENT', 4);
    const error = await submissionError(seller.userId, sellerAccountId);
    expect(error.details).toEqual([expect.objectContaining({ field: 'SELLER_SERVICES_AGREEMENT', code: 'AGREEMENT_NOT_ACCEPTED' })]);
    const stale = await call(seller.jar, 'POST', '/auth/agreements/services', { scope: 'SELLER', documentIds: [services] });
    expect(stale.statusCode).not.toBe(200);

    // History is kept: the first acceptance is still there, beside the new one.
    expect((await call(seller.jar, 'POST', '/auth/agreements/services', { scope: 'SELLER', documentIds: [v2] })).statusCode).toBe(200);
    await expect(assertSellerSubmissionAgreements(seller.userId, sellerAccountId)).resolves.toHaveLength(2);
    expect(await prisma.consentRecord.count({ where: { userId: seller.userId, purpose: 'SELLER_SERVICES_AGREEMENT' } })).toBe(2);
  });

  it('is not checked when the agreement gate is off', async () => {
    Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: false });
    try {
      await expect(assertSellerSubmissionAgreements(newId(), newId())).resolves.toEqual([]);
    } finally {
      Object.assign(env as unknown as { FEATURE_AGREEMENT_GATE: boolean }, { FEATURE_AGREEMENT_GATE: true });
    }
  });
});
