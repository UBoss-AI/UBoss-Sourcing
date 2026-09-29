/**
 * A buyer company's team: invitations, roles and removal, end to end over
 * HTTP (checklist Master rows 11 and 14).
 *
 * Each `it` builds on the one before. The file cleans up in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'CompanyTeam!2026x';
const EMAIL = {
  olga: 'team-olga@test.local',
  adam: 'team-adam@test.local',
  bea: 'team-bea@test.local',
  carl: 'team-carl@test.local',
  wendy: 'team-wendy@test.local',
  otto: 'team-otto@test.local',
  pia: 'team-pia@test.local',
  una: 'team-una@test.local',
};
const ALL_EMAILS = Object.values(EMAIL);
const INVITE_EVENT = 'buyer_company.invitation';

interface Session {
  cookie: string;
  csrf: string;
}
const users: Record<string, string> = {};
const sessions: Record<string, Session> = {};
let companyA = '';
let companyB = '';
let pending = '';

function cookiesOf(response: LightMyRequestResponse): Map<string, string> {
  const jar = new Map<string, string>();
  for (const cookie of response.cookies as { name: string; value: string }[]) jar.set(cookie.name, cookie.value);
  return jar;
}

async function signIn(email: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const jar = cookiesOf(response);
  return { cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '), csrf: jar.get('uboss_shop_csrf') ?? '' };
}

function call(who: keyof typeof EMAIL, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const session = sessions[who];
  if (session === undefined) throw new Error(`no session for ${who}`);
  return app.inject({
    method,
    url: `/api/v1/buyer-companies${url}`,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const code = (response: LightMyRequestResponse): string | undefined => response.json<{ error?: { code: string } }>().error?.code;
const detail = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { details?: { code: string }[] } }>().error?.details?.[0]?.code;

async function latestToken(recipient: string): Promise<string> {
  const row = await prisma.notificationOutbox.findFirst({
    where: { eventKey: INVITE_EVENT, recipientEmail: recipient },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  });
  const token = row?.body.match(/join-company\?token=([A-Za-z0-9_-]+)/)?.[1];
  if (token === undefined) throw new Error(`no invitation email for ${recipient}`);
  return token;
}

async function cleanUp(): Promise<void> {
  const userIds = (await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })).map((row) => row.id);
  const companyIds = (await prisma.buyerCompany.findMany({ where: { createdByUserId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.notificationOutbox.deleteMany({ where: { recipientEmail: { in: ALL_EMAILS } } });
  await prisma.buyerCompanyInvitation.deleteMany({ where: { companyId: { in: companyIds } } });
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

async function createCustomer(email: string, verified = true): Promise<string> {
  const userId = newId();
  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: verified ? new Date() : null,
    },
  });
  await prisma.customerProfile.create({ data: { id: newId(), userId, fullName: email.split('@')[0]?.replace('team-', '') ?? 'Buyer' } });
  return userId;
}

async function createCompany(ownerUserId: string, name: string, status: 'APPROVED' | 'SUBMITTED'): Promise<string> {
  const id = newId();
  await prisma.buyerCompany.create({ data: { id, applicationReference: `TM${id.slice(-10)}`, createdByUserId: ownerUserId, legalName: name, status } });
  await prisma.buyerCompanyMember.create({ data: { id: newId(), companyId: id, userId: ownerUserId, role: 'OWNER' } });
  return id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  for (const [key, email] of Object.entries(EMAIL)) users[key] = await createCustomer(email, key !== 'una');
  companyA = await createCompany(users.olga ?? '', 'Acme Team Buying', 'APPROVED');
  companyB = await createCompany(users.otto ?? '', 'Other Co', 'APPROVED');
  pending = await createCompany(users.pia ?? '', 'Pending Co', 'SUBMITTED');
  for (const key of Object.keys(EMAIL) as (keyof typeof EMAIL)[]) sessions[key] = await signIn(EMAIL[key]);
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('inviting', () => {
  it('refuses anybody signed out, and a company that is not verified yet', async () => {
    const anonymous = await app.inject({ method: 'GET', url: `/api/v1/buyer-companies/${companyA}/team` });
    expect(anonymous.statusCode).toBe(401);

    const early = await call('pia', 'POST', `/${pending}/invitations`, { email: EMAIL.bea, role: 'BUYER' });
    expect(early.statusCode).toBe(403);
    expect(code(early)).toBe('BUYER_COMPANY_NOT_APPROVED');
    const team = await call('pia', 'GET', `/${pending}/team`);
    expect(team.json()).toMatchObject({ manageBlocked: 'NOT_APPROVED', assignableRoles: [], invitations: [] });
  });

  it('invites by email, keeps only a hash of the link, and emails it in the inviter’s language', async () => {
    await prisma.user.update({ where: { id: users.olga ?? '' }, data: { preferredLanguage: 'de' } });
    const response = await call('olga', 'POST', `/${companyA}/invitations`, { email: EMAIL.bea, role: 'BUYER' });
    expect(response.statusCode, response.body).toBe(201);
    const team = response.json<{ invitations: { email: string; role: string; sendCount: number }[] }>();
    expect(team.invitations).toEqual([expect.objectContaining({ email: EMAIL.bea, role: 'BUYER', sendCount: 1 })]);

    const token = await latestToken(EMAIL.bea);
    const stored = await prisma.buyerCompanyInvitation.findFirstOrThrow({ where: { companyId: companyA, emailNormalized: EMAIL.bea } });
    expect(JSON.stringify(stored)).not.toContain(token);
    const email = await prisma.notificationOutbox.findFirstOrThrow({ where: { eventKey: INVITE_EVENT, recipientEmail: EMAIL.bea } });
    expect(email.subject).toContain('Acme Team Buying');
    expect(email.body).toContain('Einkäufer');
    expect(await prisma.auditLog.count({ where: { action: 'buyer_company.member_invited', resourceId: stored.id } })).toBe(1);
  });

  it('refuses a second invitation to the same address, an existing member, a bad address and the owner role', async () => {
    const again = await call('olga', 'POST', `/${companyA}/invitations`, { email: EMAIL.bea.toUpperCase(), role: 'VIEWER' });
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('BUYER_COMPANY_INVITATION_EXISTS');

    const member = await call('olga', 'POST', `/${companyA}/invitations`, { email: EMAIL.olga, role: 'BUYER' });
    expect(code(member)).toBe('BUYER_COMPANY_ALREADY_MEMBER');

    expect((await call('olga', 'POST', `/${companyA}/invitations`, { email: 'not-an-email', role: 'BUYER' })).statusCode).toBe(400);
    expect((await call('olga', 'POST', `/${companyA}/invitations`, { email: EMAIL.carl, role: 'OWNER' })).statusCode).toBe(400);
    expect(await prisma.buyerCompanyInvitation.count({ where: { companyId: companyA } })).toBe(1);
  });

  it('keeps one company out of another’s team entirely', async () => {
    const invitation = await prisma.buyerCompanyInvitation.findFirstOrThrow({ where: { companyId: companyA } });
    expect((await call('otto', 'GET', `/${companyA}/team`)).statusCode).toBe(404);
    expect((await call('otto', 'POST', `/${companyA}/invitations`, { email: EMAIL.carl, role: 'BUYER' })).statusCode).toBe(404);
    // Another company's invitation id under the caller's own company is not found either.
    expect((await call('otto', 'DELETE', `/${companyB}/invitations/${invitation.id}`)).statusCode).toBe(404);
    expect((await call('otto', 'POST', `/${companyB}/invitations/${invitation.id}/resend`)).statusCode).toBe(404);
    const olgaMember = await prisma.buyerCompanyMember.findFirstOrThrow({ where: { companyId: companyA, role: 'OWNER' } });
    expect((await call('otto', 'DELETE', `/${companyB}/members/${olgaMember.id}`)).statusCode).toBe(404);
    expect(await prisma.buyerCompanyInvitation.count({ where: { id: invitation.id, liveKey: { not: null } } })).toBe(1);
  });
});

describe('accepting', () => {
  it('will not let the link work for another account, and says the same for every bad link', async () => {
    const token = await latestToken(EMAIL.bea);
    const wrong = await call('wendy', 'POST', '/invitations/accept', { token });
    expect(wrong.statusCode).toBe(400);
    expect(code(wrong)).toBe('BUYER_COMPANY_INVITATION_INVALID');
    const peek = await call('wendy', 'POST', '/invitations/preview', { token });
    expect(code(peek)).toBe('BUYER_COMPANY_INVITATION_INVALID');
    const made_up = await call('bea', 'POST', '/invitations/accept', { token: 'x'.repeat(43) });
    expect(code(made_up)).toBe('BUYER_COMPANY_INVITATION_INVALID');
    expect(wrong.json<{ error: { message: string } }>().error.message).toBe(made_up.json<{ error: { message: string } }>().error.message);
  });

  it('resending sends a new link and the old one stops working', async () => {
    const old = await latestToken(EMAIL.bea);
    const invitation = await prisma.buyerCompanyInvitation.findFirstOrThrow({ where: { companyId: companyA, emailNormalized: EMAIL.bea } });
    const resent = await call('olga', 'POST', `/${companyA}/invitations/${invitation.id}/resend`);
    expect(resent.statusCode, resent.body).toBe(200);
    expect(resent.json<{ invitations: { sendCount: number }[] }>().invitations[0]?.sendCount).toBe(2);

    const fresh = await latestToken(EMAIL.bea);
    expect(fresh).not.toBe(old);
    expect(code(await call('bea', 'POST', '/invitations/preview', { token: old }))).toBe('BUYER_COMPANY_INVITATION_INVALID');
    const preview = await call('bea', 'POST', '/invitations/preview', { token: fresh });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ companyName: 'Acme Team Buying', role: 'BUYER' });
  });

  it('joins once, in the role invited, however many times the link is used', async () => {
    const token = await latestToken(EMAIL.bea);
    const results = await Promise.allSettled([
      call('bea', 'POST', '/invitations/accept', { token }),
      call('bea', 'POST', '/invitations/accept', { token }),
    ]);
    const statuses = results.map((result) => (result.status === 'fulfilled' ? result.value.statusCode : 0)).sort();
    expect(statuses).toEqual([200, 400]);
    expect(await prisma.buyerCompanyMember.count({ where: { companyId: companyA, userId: users.bea ?? '', status: 'ACTIVE', role: 'BUYER' } })).toBe(1);

    const team = await call('bea', 'GET', `/${companyA}/team`);
    expect(team.statusCode).toBe(200);
    // A buyer sees colleagues, but not invitations, and cannot change anybody.
    expect(team.json()).toMatchObject({ yourRole: 'BUYER', manageBlocked: 'ROLE', invitations: [], assignableRoles: [] });
    expect(team.json<{ members: { canChange: boolean }[] }>().members.every((member) => !member.canChange)).toBe(true);
  });

  it('refuses an account whose email address is not verified', async () => {
    expect((await call('olga', 'POST', `/${companyA}/invitations`, { email: EMAIL.una, role: 'VIEWER' })).statusCode).toBe(201);
    const token = await latestToken(EMAIL.una);
    expect(code(await call('una', 'POST', '/invitations/accept', { token }))).toBe('BUYER_COMPANY_INVITATION_INVALID');
  });
});

describe('roles and removal', () => {
  it('lets only the owner make an administrator', async () => {
    const bea = await call('bea', 'POST', `/${companyA}/invitations`, { email: EMAIL.carl, role: 'VIEWER' });
    expect(bea.statusCode).toBe(403);
    expect(code(bea)).toBe('BUYER_COMPANY_ROLE_FORBIDDEN');

    expect((await call('olga', 'POST', `/${companyA}/invitations`, { email: EMAIL.adam, role: 'COMPANY_ADMIN' })).statusCode).toBe(201);
    expect((await call('adam', 'POST', '/invitations/accept', { token: await latestToken(EMAIL.adam) })).statusCode).toBe(200);

    const adminByAdmin = await call('adam', 'POST', `/${companyA}/invitations`, { email: EMAIL.carl, role: 'COMPANY_ADMIN' });
    expect(adminByAdmin.statusCode).toBe(403);
    expect(detail(adminByAdmin)).toBe('ADMIN_NEEDS_OWNER');
    const team = await call('adam', 'GET', `/${companyA}/team`);
    expect(team.json<{ assignableRoles: string[] }>().assignableRoles).toEqual(['BUYER', 'ORDER_APPROVER', 'FINANCE', 'VIEWER']);
  });

  it('protects the owner and the caller themselves, and changes everybody else', async () => {
    const members = await prisma.buyerCompanyMember.findMany({ where: { companyId: companyA, status: 'ACTIVE' } });
    const id = (userId: string | undefined) => members.find((member) => member.userId === userId)?.id ?? '';

    const owner = await call('adam', 'PATCH', `/${companyA}/members/${id(users.olga)}`, { role: 'VIEWER' });
    expect(detail(owner)).toBe('OWNER');
    const self = await call('adam', 'PATCH', `/${companyA}/members/${id(users.adam)}`, { role: 'BUYER' });
    expect(detail(self)).toBe('SELF');
    const ownerSelf = await call('olga', 'DELETE', `/${companyA}/members/${id(users.olga)}`);
    expect(detail(ownerSelf)).toBe('SELF');
    expect((await call('olga', 'PATCH', `/${companyA}/members/${id(users.bea)}`, { role: 'OWNER' })).statusCode).toBe(400);

    const changed = await call('adam', 'PATCH', `/${companyA}/members/${id(users.bea)}`, { role: 'ORDER_APPROVER' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await prisma.buyerCompanyMember.count({ where: { id: id(users.bea), role: 'ORDER_APPROVER' } })).toBe(1);
    const trail = await prisma.auditLog.findFirstOrThrow({ where: { action: 'buyer_company.member_role_changed', resourceId: id(users.bea) } });
    expect(trail).toMatchObject({ actorUserId: users.adam });

    // Only the owner changes the administrator.
    expect((await call('olga', 'PATCH', `/${companyA}/members/${id(users.adam)}`, { role: 'FINANCE' })).statusCode).toBe(200);
    expect((await call('olga', 'PATCH', `/${companyA}/members/${id(users.adam)}`, { role: 'COMPANY_ADMIN' })).statusCode).toBe(200);
  });

  it('removes a member, whose access ends on their next request, and lets them back only by a new invitation', async () => {
    const bea = await prisma.buyerCompanyMember.findFirstOrThrow({ where: { companyId: companyA, userId: users.bea ?? '' } });
    const removed = await call('adam', 'DELETE', `/${companyA}/members/${bea.id}`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await call('bea', 'GET', `/${companyA}/team`)).statusCode).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: 'buyer_company.member_removed', resourceId: bea.id } })).toBe(1);

    expect((await call('adam', 'POST', `/${companyA}/invitations`, { email: EMAIL.bea, role: 'VIEWER' })).statusCode).toBe(201);
    expect((await call('bea', 'POST', '/invitations/accept', { token: await latestToken(EMAIL.bea) })).statusCode).toBe(200);
    expect(await prisma.buyerCompanyMember.findUniqueOrThrow({ where: { id: bea.id } })).toMatchObject({ status: 'ACTIVE', role: 'VIEWER', removedAt: null });
  });
});

describe('expiry and withdrawal', () => {
  it('stops an expired link working, and lets it be replaced by a new invitation', async () => {
    expect((await call('olga', 'POST', `/${companyA}/invitations`, { email: EMAIL.carl, role: 'FINANCE' })).statusCode).toBe(201);
    const token = await latestToken(EMAIL.carl);
    await prisma.buyerCompanyInvitation.updateMany({ where: { companyId: companyA, emailNormalized: EMAIL.carl }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    const team = await call('olga', 'GET', `/${companyA}/team`);
    expect(team.json<{ invitations: { email: string; expired: boolean }[] }>().invitations.find((row) => row.email === EMAIL.carl)?.expired).toBe(true);
    expect(code(await call('carl', 'POST', '/invitations/accept', { token }))).toBe('BUYER_COMPANY_INVITATION_INVALID');

    expect((await call('olga', 'POST', `/${companyA}/invitations`, { email: EMAIL.carl, role: 'FINANCE' })).statusCode).toBe(201);
    expect(await prisma.buyerCompanyInvitation.count({ where: { companyId: companyA, emailNormalized: EMAIL.carl } })).toBe(2);
  });

  it('withdraws an invitation, after which its link does nothing', async () => {
    const token = await latestToken(EMAIL.carl);
    const invitation = await prisma.buyerCompanyInvitation.findFirstOrThrow({ where: { companyId: companyA, emailNormalized: EMAIL.carl, liveKey: { not: null } } });
    const revoked = await call('olga', 'DELETE', `/${companyA}/invitations/${invitation.id}`);
    expect(revoked.statusCode).toBe(200);
    expect(code(await call('carl', 'POST', '/invitations/accept', { token }))).toBe('BUYER_COMPANY_INVITATION_INVALID');
    expect((await call('olga', 'DELETE', `/${companyA}/invitations/${invitation.id}`)).statusCode).toBe(404);
    expect(await prisma.buyerCompanyMember.count({ where: { companyId: companyA, userId: users.carl ?? '' } })).toBe(0);
  });

  it('caps how many times one invitation is sent', async () => {
    expect((await call('olga', 'POST', `/${companyA}/invitations`, { email: EMAIL.wendy, role: 'VIEWER' })).statusCode).toBe(201);
    const invitation = await prisma.buyerCompanyInvitation.findFirstOrThrow({ where: { companyId: companyA, emailNormalized: EMAIL.wendy } });
    for (let i = 0; i < 4; i += 1) {
      expect((await call('olga', 'POST', `/${companyA}/invitations/${invitation.id}/resend`)).statusCode).toBe(200);
    }
    const sixth = await call('olga', 'POST', `/${companyA}/invitations/${invitation.id}/resend`);
    expect(sixth.statusCode).toBe(409);
    expect(code(sixth)).toBe('BUYER_COMPANY_LIMIT_REACHED');
  });
});
