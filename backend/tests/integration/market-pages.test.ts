/**
 * Market landing pages - checklist Master row 8.
 *
 *   - Only a country the deployment sells in has a page.
 *   - The operator's text is public only once published; a draft never is.
 *   - Restrictions in force for that destination are always listed.
 *   - Featured categories keep the operator's order and drop any that are not
 *     public.
 *   - Writing a market's text needs settings.write, validates its input and is
 *     audited.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { newId } from '../../src/infra/ids.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { prisma } from '../../src/infra/prisma.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

const PREFIX = 'mkt-page-';
const COUNTRY = 'KI';
const PASSWORD = 'MarketPages!2026Test';
const OWNER = 'mkt-page-owner@test.local';
const CATALOG = 'mkt-page-catalog@test.local';
const IP = '203.0.113.88';

let app: Awaited<ReturnType<typeof buildApp>>;
let owner: AdminSession;
let catalog: AdminSession;
let currencyCode = '';
let createdCountry = false;

async function makeStaff(email: string, role: string): Promise<void> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
  const id = newId();
  await prisma.user.create({
    data: { id, type: 'ADMIN', email, emailNormalized: email, passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  await prisma.userRole.create({ data: { userId: id, roleId: roleRow.id } });
}

async function cleanUp(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { resourceType: 'market_profile', resourceId: COUNTRY } });
  await prisma.marketProfile.deleteMany({ where: { countryCode: COUNTRY } });
  await prisma.marketRule.deleteMany({ where: { reason: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { in: [OWNER, CATALOG] } } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: [OWNER, CATALOG] } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: [OWNER, CATALOG] } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  const existing = await prisma.country.findUnique({ where: { code: COUNTRY } });
  const currency = await prisma.currency.findFirstOrThrow({ where: { isActive: true }, select: { code: true } });
  currencyCode = existing?.currencyCode ?? currency.code;
  if (existing === null) {
    await prisma.country.create({ data: { code: COUNTRY, name: 'Kiribati', currencyCode, isActive: true } });
    createdCountry = true;
  } else {
    await prisma.country.update({ where: { code: COUNTRY }, data: { isActive: true } });
  }

  await prisma.category.create({ data: { id: newId(), name: 'Market solvents', slug: `${PREFIX}solvents`, isActive: true } });
  await prisma.category.create({ data: { id: newId(), name: 'Market tools', slug: `${PREFIX}tools`, isActive: true } });
  await prisma.category.create({ data: { id: newId(), name: 'Market hidden', slug: `${PREFIX}hidden`, isActive: false } });
  const solvents = await prisma.category.findFirstOrThrow({ where: { slug: `${PREFIX}solvents` } });
  await prisma.marketRule.create({
    data: {
      id: newId(),
      scope: 'CATEGORY',
      categoryId: solvents.id,
      countryCode: COUNTRY,
      effect: 'BLOCK',
      reason: `${PREFIX}Solvents cannot be imported.`,
      source: 'test',
      version: '1',
      ownerName: 'Compliance',
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });

  await makeStaff(OWNER, Role.BUSINESS_OWNER);
  await makeStaff(CATALOG, Role.CATALOG_MANAGER);
  owner = await signInAdmin(app, { email: OWNER, password: PASSWORD, ip: IP });
  catalog = await signInAdmin(app, { email: CATALOG, password: PASSWORD, ip: IP });
});

afterAll(async () => {
  await cleanUp();
  if (createdCountry) await prisma.country.deleteMany({ where: { code: COUNTRY } });
  await app.close();
});

const page = (code: string) => app.inject({ method: 'GET', url: `/api/v1/catalog/markets/${code}` });
const save = (session: AdminSession, body: Record<string, unknown>) =>
  app.inject({
    method: 'PUT',
    url: `/api/v1/admin/settings/market-profiles/${COUNTRY}`,
    headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken, 'x-forwarded-for': IP },
    payload: body,
  });

const PROFILE = {
  headline: 'Buying for Kiribati',
  intro: 'We ship by sea freight via Tarawa.',
  dutiesGuidance: 'Import duty is paid by the buyer on arrival.',
  deliveryPromise: '  ',
  complianceNotes: null,
  featuredCategories: [`${PREFIX}tools`, `${PREFIX}hidden`, `${PREFIX}solvents`],
  isPublished: false,
};

describe('GET /api/v1/catalog/markets/:country', () => {
  it('is a 404 for a country the deployment does not sell in, and 400 for a malformed code', async () => {
    expect((await page('ZZ')).statusCode).toBe(404);
    expect((await page('KIR')).statusCode).toBe(400);
  });

  it('always lists the destination facts, even with no text written', async () => {
    const response = await page(COUNTRY.toLowerCase());
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ country: { code: string; currencyCode: string }; profile: unknown; restrictions: { effect: string; category: { slug: string } | null; reason: string }[] }>();
    expect(body.country).toMatchObject({ code: COUNTRY, currencyCode });
    expect(body.profile).toBeNull();
    expect(body.restrictions).toEqual([
      expect.objectContaining({ effect: 'BLOCK', category: { slug: `${PREFIX}solvents`, name: 'Market solvents' }, reason: `${PREFIX}Solvents cannot be imported.` }),
    ]);
  });
});

describe('PUT /api/v1/admin/settings/market-profiles/:country', () => {
  it('refuses staff without settings.write, and anonymous callers', async () => {
    expect((await save(catalog, PROFILE)).statusCode).toBe(403);
    const anonymous = await app.inject({ method: 'PUT', url: `/api/v1/admin/settings/market-profiles/${COUNTRY}`, payload: PROFILE });
    expect([401, 403]).toContain(anonymous.statusCode);
  });

  it('validates the input', async () => {
    expect((await save(owner, { ...PROFILE, headline: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await save(owner, { ...PROFILE, featuredCategories: ['Not A Slug'] })).statusCode).toBe(400);
    expect((await save(owner, { ...PROFILE, isPublished: 'yes' })).statusCode).toBe(400);
  });

  it('keeps a draft private, publishes on request, and audits both writes', async () => {
    expect((await save(owner, PROFILE)).statusCode).toBe(200);
    expect((await page(COUNTRY)).json<{ profile: unknown }>().profile).toBeNull();

    expect((await save(owner, { ...PROFILE, isPublished: true })).statusCode).toBe(200);
    const published = (await page(COUNTRY)).json<{ profile: Record<string, unknown> }>().profile;
    expect(published).toEqual({
      headline: 'Buying for Kiribati',
      intro: 'We ship by sea freight via Tarawa.',
      dutiesGuidance: 'Import duty is paid by the buyer on arrival.',
      // Blank text is stored as nothing, not as spaces.
      deliveryPromise: null,
      complianceNotes: null,
      // The operator's order, minus the category that is not public.
      featuredCategories: [
        { slug: `${PREFIX}tools`, name: 'Market tools' },
        { slug: `${PREFIX}solvents`, name: 'Market solvents' },
      ],
    });

    const audits = await prisma.auditLog.findMany({
      where: { resourceType: 'market_profile', resourceId: COUNTRY },
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorEmail: true, afterJson: true },
    });
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ action: 'settings.updated', actorEmail: OWNER, afterJson: expect.objectContaining({ isPublished: true }) });
  });

  it('is a 404 for a country the deployment does not sell in', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/market-profiles/ZZ',
      headers: { cookie: owner.cookies, 'x-csrf-token': owner.csrfToken, 'x-forwarded-for': IP },
      payload: PROFILE,
    });
    expect(response.statusCode).toBe(404);
  });
});
