/**
 * Audit Console people for integration tests.
 *
 * Every person here comes in the way a real one does: invited through
 * `inviteToConsole`, activated through the public invitation endpoint with a
 * password of their own, and signed in at `/api/v1/audit/auth/login`. Nothing
 * writes a password hash or flips a status by hand, so a broken invitation,
 * activation or audience check fails the suite that depends on it.
 *
 * The test environment switches the console's second factor off (tests/
 * setup.ts); `audit-console.test.ts` switches it on for itself.
 */
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { inviteToConsole, type InviteTarget } from '../../src/modules/audit-console/membership.service.js';
import { issueToken } from '../../src/modules/identity/token.service.js';
import type { Session } from './order-desk-fixture.js';

type App = Awaited<ReturnType<typeof buildApp>>;

export const AUDIT_PASSWORD = 'AuditConsolePass!2026x';
export const auditEmailFor = (tag: string, who: string): string => `${tag}-${who}@auditconsole.test.local`;

function cookiesOf(response: LightMyRequestResponse): Map<string, string> {
  const jar = new Map<string, string>();
  for (const cookie of response.cookies) jar.set(cookie.name, cookie.value);
  return jar;
}

/** Redeem an invitation for this account over HTTP, then sign in. */
export async function activateAndSignIn(app: App, userId: string, ip: string): Promise<Session> {
  const { token } = await issueToken(userId, 'INVITATION');
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/v1/audit/auth/invitations/accept',
    remoteAddress: ip,
    headers: { 'x-forwarded-for': ip },
    payload: { token, password: AUDIT_PASSWORD, acceptedTerms: false },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  return signInAudit(app, user.email, ip);
}

export async function signInAudit(app: App, email: string, ip: string): Promise<Session> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/audit/auth/login',
    remoteAddress: ip,
    headers: { 'x-forwarded-for': ip },
    payload: { email, password: AUDIT_PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = cookiesOf(login);
  return {
    cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: jar.get('uboss_audit_csrf') ?? '',
    ip,
  };
}

/** Invite, activate and sign in one console person. */
export async function auditPerson(
  app: App,
  input: { tag: string; who: string; ip: string; target: InviteTarget },
): Promise<{ session: Session; userId: string; memberId: string }> {
  // A real operator account: audit rows name their actor by foreign key.
  const operator = await prisma.user.findFirstOrThrow({ where: { type: 'ADMIN' }, select: { id: true, email: true } });
  const invited = await inviteToConsole(
    { party: 'ADMIN', userId: operator.id, label: operator.email },
    { email: auditEmailFor(input.tag, input.who), fullName: `${input.who} ${input.tag}`, target: input.target },
  );
  const session = await activateAndSignIn(app, invited.userId, input.ip);
  return { session, userId: invited.userId, memberId: invited.memberId };
}

/** Call a console route. `url` starts after `/api/v1`. */
export function asAudit(
  app: App,
  session: Session,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    remoteAddress: session.ip,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'x-forwarded-for': session.ip, 'idempotency-key': newId() },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** Remove every console account a suite made, and what hangs off them. */
export async function cleanUpAuditPeople(tag: string): Promise<void> {
  const users = await prisma.user.findMany({
    where: { emailNormalized: { startsWith: `${tag}-`, endsWith: '@auditconsole.test.local' } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);
  if (ids.length === 0) return;
  await prisma.auditNotification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditStaffMember.deleteMany({ where: { userId: { in: ids } } });
  await prisma.inspectionAgencyMember.deleteMany({ where: { userId: { in: ids } } });
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { startsWith: `${tag}-`, endsWith: '@auditconsole.test.local' } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}
