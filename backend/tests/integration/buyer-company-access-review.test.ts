/**
 * A buyer company's periodic access review over HTTP (checklist Master row
 * 14): the facts the owner reviews, who may see them, the "review done"
 * record with its audit entry, and the read-only staff view.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { signInAdmin } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'CompanyReview!2026x';
const STAFF_EMAIL = 'bcar-staff@test.local';
const EMAIL = {
  olga: 'bcar-olga@test.local',
  adam: 'bcar-adam@test.local',
  vera: 'bcar-vera@test.local',
  otto: 'bcar-otto@test.local',
};
type Who = keyof typeof EMAIL;
const ALL_EMAILS = [...Object.values(EMAIL), STAFF_EMAIL];

const users: Partial<Record<Who, string>> = {};
const sessions: Partial<Record<Who, { cookie: string; csrf: string }>> = {};
let companyA = '';
let companyB = '';
let staffCookies = '';

interface Team {
  members: { email: string; access: { invitedByName: string | null; lastSignInAt: string | null; lastActiveAt: string | null } | null }[];
  accessReview: { reviews: { reviewedByName: string; memberCount: number }[]; due: boolean } | null;
}

function call(who: Who, method: 'GET' | 'POST', url: string): Promise<LightMyRequestResponse> {
  const session = sessions[who];
  if (session === undefined) throw new Error(`no session for ${who}`);
  return app.inject({ method, url: `/api/v1/buyer-companies${url}`, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf } });
}

const code = (response: LightMyRequestResponse): string | undefined => response.json<{ error?: { code: string } }>().error?.code;

async function cleanUp(): Promise<void> {
  const userIds = (await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })).map((row) => row.id);
  const companyIds = (await prisma.buyerCompany.findMany({ where: { createdByUserId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.teamAccessReview.deleteMany({ where: { buyerCompanyId: { in: companyIds } } });
  await prisma.buyerCompanyMember.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.buyerCompany.deleteMany({ where: { id: { in: companyIds } } });
  await prisma.cart.deleteMany({ where: { customerProfile: { userId: { in: userIds } } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  for (const who of Object.keys(EMAIL) as Who[]) {
    const id = newId();
    await prisma.user.create({
      data: { id, type: 'CUSTOMER', email: EMAIL[who], emailNormalized: EMAIL[who], passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await prisma.customerProfile.create({ data: { id: newId(), userId: id, fullName: `${who.charAt(0).toUpperCase()}${who.slice(1)} Review` } });
    users[who] = id;
  }
  companyA = newId();
  companyB = newId();
  await prisma.buyerCompany.create({ data: { id: companyA, applicationReference: `AR${companyA.slice(-10)}`, createdByUserId: users.olga ?? '', legalName: 'Review Co', status: 'APPROVED' } });
  await prisma.buyerCompany.create({ data: { id: companyB, applicationReference: `AR${companyB.slice(-10)}`, createdByUserId: users.otto ?? '', legalName: 'Other Review Co', status: 'APPROVED' } });
  await prisma.buyerCompanyMember.create({ data: { id: newId(), companyId: companyA, userId: users.olga ?? '', role: 'OWNER' } });
  await prisma.buyerCompanyMember.create({ data: { id: newId(), companyId: companyA, userId: users.adam ?? '', role: 'COMPANY_ADMIN', invitedByUserId: users.olga ?? '' } });
  await prisma.buyerCompanyMember.create({ data: { id: newId(), companyId: companyA, userId: users.vera ?? '', role: 'VIEWER', invitedByUserId: users.adam ?? '' } });
  await prisma.buyerCompanyMember.create({ data: { id: newId(), companyId: companyB, userId: users.otto ?? '', role: 'OWNER' } });

  for (const who of Object.keys(EMAIL) as Who[]) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAIL[who], password: PASSWORD } });
    expect(response.statusCode, response.body).toBe(200);
    const jar = new Map((response.cookies as { name: string; value: string }[]).map((cookie) => [cookie.name, cookie.value]));
    sessions[who] = { cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '), csrf: jar.get('uboss_shop_csrf') ?? '' };
  }

  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { key: Role.BUSINESS_OWNER }, select: { id: true } });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: STAFF_EMAIL,
      emailNormalized: STAFF_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: ownerRole.id } },
    },
  });
  ({ cookies: staffCookies } = await signInAdmin(app, { email: STAFF_EMAIL, password: PASSWORD, ip: '203.0.113.189' }));
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('the access review of a buyer company', () => {
  it('shows the owner who invited whom and when each last signed in, and that a review is due', async () => {
    const team = (await call('olga', 'GET', `/${companyA}/team`)).json<Team>();
    const vera = team.members.find((member) => member.email === EMAIL.vera);
    expect(vera?.access).toMatchObject({ invitedByName: 'Adam Review' });
    expect(vera?.access?.lastSignInAt).not.toBeNull();
    expect(vera?.access?.lastActiveAt).not.toBeNull();
    expect(team.members.find((member) => member.email === EMAIL.olga)?.access?.invitedByName).toBeNull();
    expect(team.accessReview).toMatchObject({ reviews: [], due: true });
  });

  it('keeps those facts from a viewer, and refuses a viewer and another company', async () => {
    const team = (await call('vera', 'GET', `/${companyA}/team`)).json<Team>();
    expect(team.members.every((member) => member.access === null)).toBe(true);
    expect(team.accessReview).toBeNull();

    const viewer = await call('vera', 'POST', `/${companyA}/access-reviews`);
    expect(viewer.statusCode).toBe(403);
    expect(code(viewer)).toBe('BUYER_COMPANY_ROLE_FORBIDDEN');
    expect((await call('otto', 'POST', `/${companyA}/access-reviews`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/v1/buyer-companies/${companyA}/access-reviews` })).statusCode).toBe(401);
    expect(await prisma.teamAccessReview.count({ where: { buyerCompanyId: companyA } })).toBe(0);
  });

  it('records a review by an administrator, with the audit entry', async () => {
    const response = await call('adam', 'POST', `/${companyA}/access-reviews`);
    expect(response.statusCode, response.body).toBe(201);
    const team = response.json<Team>();
    expect(team.accessReview?.due).toBe(false);
    expect(team.accessReview?.reviews[0]).toMatchObject({ reviewedByName: 'Adam Review', memberCount: 3 });
    const review = await prisma.teamAccessReview.findFirstOrThrow({ where: { buyerCompanyId: companyA } });
    expect(review).toMatchObject({ reviewedByUserId: users.adam, sellerAccountId: null, invitationCount: 0 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'buyer_company.access_reviewed', resourceId: review.id } });
    expect(audit.actorUserId).toBe(users.adam);
  });

  it('gives staff the same facts, read-only', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/buyer-companies/${companyA}/access-review`,
      headers: { cookie: staffCookies, 'x-forwarded-for': '203.0.113.189' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const view = response.json<{ members: { email: string; role: string; invitedByName: string | null }[]; accessReview: { reviews: unknown[] } }>();
    expect(view.members.map((member) => member.role)).toEqual(['OWNER', 'COMPANY_ADMIN', 'VIEWER']);
    expect(view.members[2]?.invitedByName).toBe('Adam Review');
    expect(view.accessReview.reviews).toHaveLength(1);
  });
});
