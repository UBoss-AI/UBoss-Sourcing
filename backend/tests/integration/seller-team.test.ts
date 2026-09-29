/**
 * A seller's team over HTTP, with real cookies and a real Seller Hub lock
 * (checklist Master row 14): who may see and change the team, invitations
 * end to end, the protections on owners and on yourself, one seller kept out
 * of another's team, the access-review facts and record, the staff view, and
 * the audit trail.
 *
 * Each `it` builds on the one before. The file cleans up in `afterAll`.
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

const PASSWORD = 'SellerTeam!2026x';
const HUB_PASSWORD = 'SellerTeamHub!2026';
const SLUG_A = 'steam-alpha';
const SLUG_B = 'steam-beta';
const INVITE_EVENT = 'seller.team_invitation';
const STAFF_EMAIL = 'steam-staff@test.local';

/** Seller A: Olive (owner), Adam (admin), Sam (support), Fin (finance). Seller B: Rita (owner), Otto (order manager). */
const EMAIL = {
  olive: 'steam-olive@test.local',
  adam: 'steam-adam@test.local',
  sam: 'steam-sam@test.local',
  fin: 'steam-fin@test.local',
  rita: 'steam-rita@test.local',
  otto: 'steam-otto@test.local',
  ivy: 'steam-ivy@test.local',
  jack: 'steam-jack@test.local',
  kim: 'steam-kim@test.local',
  uma: 'steam-uma@test.local',
  walt: 'steam-walt@test.local',
};
type Who = keyof typeof EMAIL;
const ALL_EMAILS = [...Object.values(EMAIL), STAFF_EMAIL];

interface Session {
  cookie: string;
  csrf: string;
  ip: string;
}
const users: Partial<Record<Who, string>> = {};
const profiles: Partial<Record<Who, string>> = {};
const members: Partial<Record<Who, string>> = {};
const sessions: Partial<Record<Who, Session>> = {};
let sellerA = '';
let sellerB = '';
let staffCookies = '';

function cookiesOf(response: LightMyRequestResponse): Map<string, string> {
  const jar = new Map<string, string>();
  for (const cookie of response.cookies as { name: string; value: string }[]) jar.set(cookie.name, cookie.value);
  return jar;
}

async function signIn(who: Who, index: number): Promise<Session> {
  const ip = `203.0.113.${String(200 + index)}`;
  // Ten sign-ins per address per 15 minutes, and this file signs in eleven
  // people from one test address. `tests/setup.ts` clears the counters before
  // each test, not before `beforeAll`, so do the same here halfway.
  if (index === 8) await prisma.rateLimitBucket.deleteMany({});
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': ip },
    payload: { email: EMAIL[who], password: PASSWORD },
  });
  expect(response.statusCode, response.body).toBe(200);
  const jar = cookiesOf(response);
  return {
    cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: jar.get('uboss_shop_csrf') ?? '',
    ip,
  };
}

function call(who: Who, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const session = sessions[who];
  if (session === undefined) throw new Error(`no session for ${who}`);
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'x-forwarded-for': session.ip },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function openHub(who: Who): Promise<void> {
  const opened = await call(who, 'POST', '/sellers/lock/open', { password: HUB_PASSWORD });
  expect(opened.statusCode, opened.body).toBe(200);
}

const code = (response: LightMyRequestResponse): string | undefined => response.json<{ error?: { code: string } }>().error?.code;
const detail = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { details?: { code: string }[] } }>().error?.details?.[0]?.code;

interface TeamView {
  yourRole: string;
  canManage: boolean;
  assignableRoles: string[];
  invitableRoles: string[];
  members: {
    id: string;
    email: string;
    role: string;
    isYou: boolean;
    canChange: boolean;
    invitedByName: string | null;
    lastSignInAt: string | null;
    lastActiveAt: string | null;
    lastHubActivityAt: string | null;
  }[];
  invitations: { id: string; email: string; role: string; expired: boolean; sendCount: number; invitedByName: string | null }[];
  accessReview: { reviews: { reviewedByName: string; memberCount: number }[]; due: boolean; intervalDays: number };
}

async function latestToken(recipient: string): Promise<string> {
  const row = await prisma.notificationOutbox.findFirst({
    where: { eventKey: INVITE_EVENT, recipientEmail: recipient },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  });
  const token = row?.body.match(/join-seller\?token=([A-Za-z0-9_-]+)/)?.[1];
  if (token === undefined) throw new Error(`no invitation email for ${recipient}`);
  return token;
}

async function cleanUp(): Promise<void> {
  const userIds = (await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })).map((row) => row.id);
  const sellerIds = (await prisma.sellerAccount.findMany({ where: { slug: { in: [SLUG_A, SLUG_B] } }, select: { id: true } })).map((row) => row.id);
  await prisma.notificationOutbox.deleteMany({ where: { recipientEmail: { in: ALL_EMAILS } } });
  await prisma.teamAccessReview.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerInvitation.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.cart.deleteMany({ where: { customerProfile: { userId: { in: userIds } } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createCustomer(who: Who, verified = true): Promise<void> {
  const userId = newId();
  const email = EMAIL[who];
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
  const profileId = newId();
  const name = who.charAt(0).toUpperCase() + who.slice(1);
  await prisma.customerProfile.create({ data: { id: profileId, userId, fullName: `${name} Steam` } });
  users[who] = userId;
  profiles[who] = profileId;
}

async function createSeller(slug: string, name: string): Promise<string> {
  const id = newId();
  await prisma.sellerAccount.create({
    data: {
      id,
      slug,
      displayName: name,
      displayNameNormalized: name.toLowerCase(),
      legalName: `${name} Ltd`,
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  return id;
}

async function addMember(who: Who, sellerAccountId: string, role: 'OWNER' | 'ADMIN' | 'SUPPORT_MEMBER' | 'FINANCE_VIEWER' | 'ORDER_MANAGER'): Promise<void> {
  const id = newId();
  await prisma.sellerMember.create({
    data: {
      id,
      sellerAccountId,
      customerProfileId: profiles[who] ?? '',
      role,
      passwordHash: await hashPassword(HUB_PASSWORD),
      passwordSetAt: new Date(),
    },
  });
  members[who] = id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  for (const who of Object.keys(EMAIL) as Who[]) await createCustomer(who, who !== 'uma');
  sellerA = await createSeller(SLUG_A, 'Steam Alpha');
  sellerB = await createSeller(SLUG_B, 'Steam Beta');
  await addMember('olive', sellerA, 'OWNER');
  await addMember('adam', sellerA, 'ADMIN');
  await addMember('sam', sellerA, 'SUPPORT_MEMBER');
  await addMember('fin', sellerA, 'FINANCE_VIEWER');
  await addMember('rita', sellerB, 'OWNER');
  await addMember('otto', sellerB, 'ORDER_MANAGER');

  const all = Object.keys(EMAIL) as Who[];
  for (const [index, who] of all.entries()) sessions[who] = await signIn(who, index);
  for (const who of ['olive', 'adam', 'sam', 'fin', 'rita', 'otto'] as const) await openHub(who);

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
  ({ cookies: staffCookies } = await signInAdmin(app, { email: STAFF_EMAIL, password: PASSWORD, ip: '203.0.113.199' }));
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('who may see and change the team', () => {
  it('refuses anybody signed out', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/seller/team'],
      ['GET', '/api/v1/seller/members'],
      ['POST', '/api/v1/seller/invitations'],
      ['POST', '/api/v1/seller/access-reviews'],
      ['POST', '/api/v1/sellers/invitations/accept'],
    ] as const) {
      const response = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('shows the owner the whole team with the access-review facts', async () => {
    const response = await call('olive', 'GET', '/seller/team');
    expect(response.statusCode, response.body).toBe(200);
    const team = response.json<TeamView>();
    expect(team.yourRole).toBe('OWNER');
    expect(team.canManage).toBe(true);
    expect(team.assignableRoles).toContain('OWNER');
    expect(team.invitableRoles).not.toContain('OWNER');
    expect(team.members.map((member) => member.email).sort()).toEqual([EMAIL.adam, EMAIL.fin, EMAIL.olive, EMAIL.sam].sort());
    const olive = team.members.find((member) => member.email === EMAIL.olive);
    expect(olive).toMatchObject({ isYou: true, canChange: false, invitedByName: null });
    // Signed in and opened the Hub in beforeAll.
    expect(olive?.lastSignInAt).not.toBeNull();
    expect(olive?.lastActiveAt).not.toBeNull();
    expect(olive?.lastHubActivityAt).not.toBeNull();
    expect(team.accessReview).toMatchObject({ reviews: [], due: true, intervalDays: 90 });

    // The older member list still answers, for the owner.
    const list = await call('olive', 'GET', '/seller/members');
    expect(list.statusCode).toBe(200);
    expect(list.json<{ members: unknown[] }>().members).toHaveLength(4);
  });

  it('lets an admin manage everybody but the owner, and never grant owner', async () => {
    const team = (await call('adam', 'GET', '/seller/team')).json<TeamView>();
    expect(team.assignableRoles).not.toContain('OWNER');
    expect(team.members.find((member) => member.email === EMAIL.olive)?.canChange).toBe(false);
    expect(team.members.find((member) => member.email === EMAIL.sam)?.canChange).toBe(true);

    const promote = await call('adam', 'PATCH', `/seller/members/${members.sam ?? ''}`, { role: 'OWNER' });
    expect(promote.statusCode).toBe(403);
    expect(code(promote)).toBe('SELLER_ROLE_DENIED');

    const demoteOwner = await call('adam', 'PATCH', `/seller/members/${members.olive ?? ''}`, { role: 'ADMIN' });
    expect(demoteOwner.statusCode).toBe(403);
    expect(code(demoteOwner)).toBe('SELLER_MEMBER_PROTECTED');
    expect(detail(demoteOwner)).toBe('ROLE_ABOVE_YOURS');

    const removeOwner = await call('adam', 'DELETE', `/seller/members/${members.olive ?? ''}`);
    expect(code(removeOwner)).toBe('SELLER_MEMBER_PROTECTED');
    expect(await prisma.sellerMember.count({ where: { id: members.olive ?? '', role: 'OWNER', removedAt: null } })).toBe(1);
  });

  it('never lets anybody change or remove themselves', async () => {
    const own = await call('olive', 'PATCH', `/seller/members/${members.olive ?? ''}`, { role: 'ADMIN' });
    expect(own.statusCode).toBe(403);
    expect(detail(own)).toBe('SELF');
    const leave = await call('adam', 'DELETE', `/seller/members/${members.adam ?? ''}`);
    expect(detail(leave)).toBe('SELF');
  });

  it('refuses every team route to a support member and a finance viewer, and finance routes to support', async () => {
    for (const who of ['sam', 'fin'] as const) {
      for (const [method, url, payload] of [
        ['GET', '/seller/team', undefined],
        ['GET', '/seller/members', undefined],
        ['POST', '/seller/invitations', { email: 'someone@test.local', role: 'SUPPORT_MEMBER' }],
        ['PATCH', `/seller/members/${members.adam ?? ''}`, { role: 'SUPPORT_MEMBER' }],
        ['DELETE', `/seller/members/${members.adam ?? ''}`, undefined],
        ['POST', '/seller/access-reviews', undefined],
      ] as const) {
        const response = await call(who, method, url, payload);
        expect(response.statusCode, `${who} ${method} ${url}`).toBe(403);
        expect(code(response)).toBe('SELLER_ROLE_DENIED');
      }
    }
    // Money: the finance viewer reads it, support does not.
    expect((await call('fin', 'GET', '/seller/settlements')).statusCode).toBe(200);
    const support = await call('sam', 'GET', '/seller/settlements');
    expect(support.statusCode).toBe(403);
    expect(code(support)).toBe('SELLER_ROLE_DENIED');
    expect(await prisma.sellerInvitation.count({ where: { sellerAccountId: sellerA } })).toBe(0);
  });
});

describe('invitations', () => {
  it('invites by email, keeps only a hash of the link, emails it and audits it', async () => {
    const response = await call('olive', 'POST', '/seller/invitations', { email: EMAIL.ivy, role: 'ORDER_MANAGER' });
    expect(response.statusCode, response.body).toBe(201);
    const team = response.json<TeamView>();
    expect(team.invitations).toEqual([
      expect.objectContaining({ email: EMAIL.ivy, role: 'ORDER_MANAGER', sendCount: 1, expired: false, invitedByName: 'Olive Steam' }),
    ]);

    const token = await latestToken(EMAIL.ivy);
    const stored = await prisma.sellerInvitation.findFirstOrThrow({ where: { sellerAccountId: sellerA, emailNormalized: EMAIL.ivy } });
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.liveKey).toBe(`${sellerA}:${EMAIL.ivy}`);
    // A week by default.
    expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(167 * 3_600_000);
    const email = await prisma.notificationOutbox.findFirstOrThrow({ where: { eventKey: INVITE_EVENT, recipientEmail: EMAIL.ivy } });
    expect(email.subject).toContain('Steam Alpha');
    expect(email.body).toContain('Order manager');
    expect(await prisma.auditLog.count({ where: { action: 'seller.member.invited', resourceId: stored.id, actorUserId: users.olive ?? '' } })).toBe(1);
    const own = await prisma.sellerAuditLog.findFirstOrThrow({ where: { sellerAccountId: sellerA, action: 'seller.member.invited' } });
    expect(own.actorLabel).toBe('Olive Steam');
  });

  it('refuses a second invitation to one address, an existing member, a bad address and the owner role', async () => {
    const again = await call('olive', 'POST', '/seller/invitations', { email: EMAIL.ivy.toUpperCase(), role: 'SUPPORT_MEMBER' });
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('SELLER_INVITATION_EXISTS');
    const member = await call('olive', 'POST', '/seller/invitations', { email: EMAIL.adam, role: 'SUPPORT_MEMBER' });
    expect(member.statusCode).toBe(409);
    expect(code(member)).toBe('SELLER_ALREADY_MEMBER');
    expect((await call('olive', 'POST', '/seller/invitations', { email: 'not-an-email', role: 'SUPPORT_MEMBER' })).statusCode).toBe(400);
    expect((await call('olive', 'POST', '/seller/invitations', { email: EMAIL.jack, role: 'OWNER' })).statusCode).toBe(400);
    expect(await prisma.sellerInvitation.count({ where: { sellerAccountId: sellerA } })).toBe(1);
  });

  it('keeps one seller out of another’s team entirely', async () => {
    const invitation = await prisma.sellerInvitation.findFirstOrThrow({ where: { sellerAccountId: sellerA } });
    const theirs = (await call('rita', 'GET', '/seller/team')).json<TeamView>();
    expect(theirs.members.map((member) => member.email).sort()).toEqual([EMAIL.otto, EMAIL.rita].sort());
    expect(theirs.invitations).toEqual([]);
    expect((await call('rita', 'POST', `/seller/invitations/${invitation.id}/resend`)).statusCode).toBe(404);
    expect((await call('rita', 'DELETE', `/seller/invitations/${invitation.id}`)).statusCode).toBe(404);
    expect((await call('rita', 'PATCH', `/seller/members/${members.sam ?? ''}`, { role: 'ORDER_MANAGER' })).statusCode).toBe(404);
    expect((await call('rita', 'DELETE', `/seller/members/${members.sam ?? ''}`)).statusCode).toBe(404);
    expect(await prisma.sellerInvitation.count({ where: { id: invitation.id, liveKey: { not: null }, sendCount: 1 } })).toBe(1);
    expect(await prisma.sellerMember.count({ where: { id: members.sam ?? '', role: 'SUPPORT_MEMBER', removedAt: null } })).toBe(1);
  });

  it('resends with a new link that replaces the old one, up to a cap', async () => {
    const invitation = await prisma.sellerInvitation.findFirstOrThrow({ where: { sellerAccountId: sellerA, emailNormalized: EMAIL.ivy } });
    const first = await latestToken(EMAIL.ivy);
    const resent = await call('adam', 'POST', `/seller/invitations/${invitation.id}/resend`);
    expect(resent.statusCode, resent.body).toBe(200);
    expect(resent.json<TeamView>().invitations[0]?.sendCount).toBe(2);
    const second = await latestToken(EMAIL.ivy);
    expect(second).not.toBe(first);
    const stale = await call('ivy', 'POST', '/sellers/invitations/preview', { token: first });
    expect(code(stale)).toBe('SELLER_INVITATION_INVALID');
    expect(await prisma.auditLog.count({ where: { action: 'seller.invitation.resent', resourceId: invitation.id } })).toBe(1);

    for (let sends = 3; sends <= 5; sends += 1) {
      expect((await call('olive', 'POST', `/seller/invitations/${invitation.id}/resend`)).statusCode).toBe(200);
    }
    const capped = await call('olive', 'POST', `/seller/invitations/${invitation.id}/resend`);
    expect(capped.statusCode).toBe(409);
    expect(code(capped)).toBe('SELLER_INVITATION_SEND_LIMIT');
  });

  it('works only for the verified account it was sent to, and says the same for every bad link', async () => {
    const token = await latestToken(EMAIL.ivy);
    const wrong = await call('walt', 'POST', '/sellers/invitations/accept', { token });
    expect(wrong.statusCode).toBe(400);
    expect(code(wrong)).toBe('SELLER_INVITATION_INVALID');
    expect(code(await call('walt', 'POST', '/sellers/invitations/preview', { token }))).toBe('SELLER_INVITATION_INVALID');
    const madeUp = await call('ivy', 'POST', '/sellers/invitations/accept', { token: 'x'.repeat(43) });
    expect(code(madeUp)).toBe('SELLER_INVITATION_INVALID');
    expect(wrong.json<{ error: { message: string } }>().error.message).toBe(madeUp.json<{ error: { message: string } }>().error.message);

    // An address nobody has confirmed cannot accept, even with the right link.
    expect((await call('olive', 'POST', '/seller/invitations', { email: EMAIL.uma, role: 'SUPPORT_MEMBER' })).statusCode).toBe(201);
    const unverified = await call('uma', 'POST', '/sellers/invitations/accept', { token: await latestToken(EMAIL.uma) });
    expect(code(unverified)).toBe('SELLER_INVITATION_INVALID');
    expect(await prisma.sellerMember.count({ where: { customerProfileId: profiles.uma ?? '' } })).toBe(0);
  });

  it('shows what it is for, then joins the team once however often Accept is pressed', async () => {
    const token = await latestToken(EMAIL.ivy);
    const preview = await call('ivy', 'POST', '/sellers/invitations/preview', { token });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ sellerName: 'Steam Alpha', role: 'ORDER_MANAGER', inviterName: 'Olive Steam' });

    const accepted = await call('ivy', 'POST', '/sellers/invitations/accept', { token });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toEqual({ sellerAccountId: sellerA });
    const again = await call('ivy', 'POST', '/sellers/invitations/accept', { token });
    expect(again.statusCode, again.body).toBe(200);
    expect(await prisma.sellerMember.count({ where: { customerProfileId: profiles.ivy ?? '' } })).toBe(1);
    const joined = await prisma.sellerMember.findUniqueOrThrow({ where: { customerProfileId: profiles.ivy ?? '' } });
    expect(joined).toMatchObject({ sellerAccountId: sellerA, role: 'ORDER_MANAGER', invitedByProfileId: profiles.olive, passwordHash: null });
    members.ivy = joined.id;
    expect(await prisma.auditLog.count({ where: { action: 'seller.invitation.accepted', actorUserId: users.ivy ?? '' } })).toBe(1);

    const team = (await call('olive', 'GET', '/seller/team')).json<TeamView>();
    expect(team.members.find((member) => member.email === EMAIL.ivy)).toMatchObject({ role: 'ORDER_MANAGER', invitedByName: 'Olive Steam' });
    expect(team.invitations.map((row) => row.email)).toEqual([EMAIL.uma]);

    // The new member chooses a Hub password and is in, with their role's permissions only.
    const lock = await call('ivy', 'POST', '/sellers/lock', { newPassword: HUB_PASSWORD });
    expect(lock.statusCode, lock.body).toBe(200);
    await openHub('ivy');
    expect(code(await call('ivy', 'GET', '/seller/team'))).toBe('SELLER_ROLE_DENIED');
  });

  it('makes one membership when two presses of Accept arrive together', async () => {
    expect((await call('adam', 'POST', '/seller/invitations', { email: EMAIL.jack, role: 'SUPPORT_MEMBER' })).statusCode).toBe(201);
    const token = await latestToken(EMAIL.jack);
    const results = await Promise.allSettled([
      call('jack', 'POST', '/sellers/invitations/accept', { token }),
      call('jack', 'POST', '/sellers/invitations/accept', { token }),
    ]);
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') expect(result.value.statusCode, result.value.body).toBe(200);
    }
    expect(await prisma.sellerMember.count({ where: { customerProfileId: profiles.jack ?? '' } })).toBe(1);
    const jack = await prisma.sellerMember.findUniqueOrThrow({ where: { customerProfileId: profiles.jack ?? '' } });
    members.jack = jack.id;
    expect(jack.invitedByProfileId).toBe(profiles.adam);
  });

  it('lets an expired invitation lapse, shows it as expired, and replaces it with a fresh one', async () => {
    expect((await call('olive', 'POST', '/seller/invitations', { email: EMAIL.kim, role: 'SUPPORT_MEMBER' })).statusCode).toBe(201);
    const token = await latestToken(EMAIL.kim);
    const old = await prisma.sellerInvitation.findFirstOrThrow({ where: { sellerAccountId: sellerA, emailNormalized: EMAIL.kim } });
    await prisma.sellerInvitation.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    expect(code(await call('kim', 'POST', '/sellers/invitations/accept', { token }))).toBe('SELLER_INVITATION_INVALID');
    const team = (await call('olive', 'GET', '/seller/team')).json<TeamView>();
    expect(team.invitations.find((row) => row.email === EMAIL.kim)?.expired).toBe(true);

    const fresh = await call('olive', 'POST', '/seller/invitations', { email: EMAIL.kim, role: 'SUPPORT_MEMBER' });
    expect(fresh.statusCode, fresh.body).toBe(201);
    expect((await prisma.sellerInvitation.findUniqueOrThrow({ where: { id: old.id } })).liveKey).toBeNull();
    expect(await prisma.sellerInvitation.count({ where: { sellerAccountId: sellerA, emailNormalized: EMAIL.kim } })).toBe(2);
  });

  it('withdraws an invitation, after which its link stops working', async () => {
    const live = await prisma.sellerInvitation.findFirstOrThrow({ where: { sellerAccountId: sellerA, emailNormalized: EMAIL.kim, liveKey: { not: null } } });
    const token = await latestToken(EMAIL.kim);
    const withdrawn = await call('olive', 'DELETE', `/seller/invitations/${live.id}`);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json<TeamView>().invitations.map((row) => row.email)).not.toContain(EMAIL.kim);
    expect(code(await call('kim', 'POST', '/sellers/invitations/accept', { token }))).toBe('SELLER_INVITATION_INVALID');
    expect(await prisma.sellerInvitation.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ liveKey: null, revokedByProfileId: profiles.olive });
    expect(await prisma.auditLog.count({ where: { action: 'seller.invitation.revoked', resourceId: live.id } })).toBe(1);
  });

  it('will not move somebody who already belongs to another seller', async () => {
    expect((await call('olive', 'POST', '/seller/invitations', { email: EMAIL.otto, role: 'SUPPORT_MEMBER' })).statusCode).toBe(201);
    const refused = await call('otto', 'POST', '/sellers/invitations/accept', { token: await latestToken(EMAIL.otto) });
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('SELLER_MEMBERSHIP_EXISTS');
    expect(await prisma.sellerMember.findUniqueOrThrow({ where: { customerProfileId: profiles.otto ?? '' } })).toMatchObject({ sellerAccountId: sellerB });
  });
});

describe('changing and removing members', () => {
  it('changes a role, writes both logs, and takes effect on the next request', async () => {
    const changed = await call('olive', 'PATCH', `/seller/members/${members.sam ?? ''}`, { role: 'CATALOGUE_MANAGER' });
    expect(changed.statusCode, changed.body).toBe(204);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'seller.member.role_changed', resourceId: members.sam ?? '' } });
    expect(row.actorUserId).toBe(users.olive);
    expect(row.beforeJson).toMatchObject({ sellerAccountId: sellerA, role: 'SUPPORT_MEMBER' });
    expect(row.afterJson).toMatchObject({ role: 'CATALOGUE_MANAGER' });
    const own = await prisma.sellerAuditLog.findFirstOrThrow({ where: { sellerAccountId: sellerA, action: 'seller.member.role_changed' } });
    expect(own.actorLabel).toBe('Olive Steam');
    // Sam's very next request carries the new role.
    const me = await call('sam', 'GET', '/sellers/me');
    expect(me.json<{ seller: { role: string } }>().seller.role).toBe('CATALOGUE_MANAGER');
  });

  it('removes a member, whose access ends at once, and brings them back on the same record', async () => {
    const removed = await call('adam', 'DELETE', `/seller/members/${members.ivy ?? ''}`);
    expect(removed.statusCode, removed.body).toBe(204);
    const after = await call('ivy', 'GET', '/seller/orders');
    expect(after.statusCode).toBe(403);
    expect(code(after)).toBe('SELLER_ACCOUNT_REQUIRED');
    expect(await prisma.auditLog.count({ where: { action: 'seller.member.removed', resourceId: members.ivy ?? '' } })).toBe(1);

    expect((await call('olive', 'POST', '/seller/invitations', { email: EMAIL.ivy, role: 'FINANCE_VIEWER' })).statusCode).toBe(201);
    expect((await call('ivy', 'POST', '/sellers/invitations/accept', { token: await latestToken(EMAIL.ivy) })).statusCode).toBe(200);
    const back = await prisma.sellerMember.findUniqueOrThrow({ where: { customerProfileId: profiles.ivy ?? '' } });
    expect(back).toMatchObject({ id: members.ivy, removedAt: null, role: 'FINANCE_VIEWER', passwordHash: null });
  });

  it('never leaves the account without an owner, even when two owners demote each other at once', async () => {
    expect((await call('olive', 'PATCH', `/seller/members/${members.adam ?? ''}`, { role: 'OWNER' })).statusCode).toBe(204);
    const results = await Promise.allSettled([
      call('olive', 'PATCH', `/seller/members/${members.adam ?? ''}`, { role: 'ADMIN' }),
      call('adam', 'PATCH', `/seller/members/${members.olive ?? ''}`, { role: 'ADMIN' }),
    ]);
    const statuses = results.map((result) => (result.status === 'fulfilled' ? result.value.statusCode : 0)).sort();
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toBe(204);
    expect([403, 409]).toContain(statuses[1]);
    expect(await prisma.sellerMember.count({ where: { sellerAccountId: sellerA, role: 'OWNER', removedAt: null } })).toBe(1);
  });
});

describe('the access review', () => {
  it('records who reviewed and when, with the audit entry', async () => {
    const owner = (await prisma.sellerMember.findFirstOrThrow({ where: { sellerAccountId: sellerA, role: 'OWNER', removedAt: null } }))
      .customerProfileId === profiles.olive
      ? 'olive'
      : 'adam';
    const response = await call(owner, 'POST', '/seller/access-reviews');
    expect(response.statusCode, response.body).toBe(201);
    const team = response.json<TeamView>();
    expect(team.accessReview.due).toBe(false);
    expect(team.accessReview.reviews[0]).toMatchObject({ reviewedByName: owner === 'olive' ? 'Olive Steam' : 'Adam Steam', memberCount: 6 });
    const review = await prisma.teamAccessReview.findFirstOrThrow({ where: { sellerAccountId: sellerA } });
    expect(review).toMatchObject({ reviewedByUserId: users[owner], buyerCompanyId: null });
    expect(await prisma.auditLog.count({ where: { action: 'seller.access.reviewed', resourceId: review.id } })).toBe(1);
  });

  it('gives staff the same facts, read-only', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/sellers/${sellerA}/access-review`,
      headers: { cookie: staffCookies, 'x-forwarded-for': '203.0.113.199' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const view = response.json<{ members: { email: string; invitedByName: string | null; lastSignInAt: string | null }[]; accessReview: { reviews: unknown[] } }>();
    expect(view.members).toHaveLength(6);
    expect(view.members.find((member) => member.email === EMAIL.jack)?.invitedByName).toBe('Adam Steam');
    expect(view.members.find((member) => member.email === EMAIL.fin)?.lastSignInAt).not.toBeNull();
    expect(view.accessReview.reviews).toHaveLength(1);

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/sellers/${newId()}/access-review`,
      headers: { cookie: staffCookies, 'x-forwarded-for': '203.0.113.199' },
    });
    expect(missing.statusCode).toBe(404);
    // A seller's own session is not a staff session.
    expect((await call('olive', 'GET', `/admin/sellers/${sellerA}/access-review`)).statusCode).toBe(401);
  });
});
