/**
 * The Audit Console guard.
 *
 * Every route under `/audit` passes through here. It authenticates against
 * the AUDIT audience only - the console's own cookie jar, token audience and
 * `users.type` - resolves the person's console membership from their user id,
 * checks the second factor, and hangs the membership on the request. A
 * customer, seller, carrier or admin credential is refused by the first of
 * those three checks before anything else is read.
 *
 * No route takes an agency id, a member id or a role from the request to
 * decide whose data it may see: there is nowhere for one to come from except
 * the session. Permissions here say what KIND of thing a person may do; the
 * services narrow every read to the agency, and for an inspector to the jobs
 * they are named on.
 *
 * The four routes that must work before the second factor is passed - the
 * boot response, the two MFA endpoints and logout - use
 * `requireAuditSession`. Nothing else should.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import type { AuditConsoleKey } from '../../domain/audit-console-permissions.js';
import { ErrorCode, forbidden } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import {
  assertAuditPermission,
  resolveAuditMember,
  type AuditMember,
} from '../../modules/audit-console/membership.service.js';
import { auditMfaGate } from '../../modules/audit-console/mfa.service.js';
import { currentUser, requireAuthenticated } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after an audit guard has run. Never speculative. */
    audit?: AuditMember;
  }
}

export function assertAuditConsoleEnabled(): void {
  if (!env.FEATURE_AUDIT_CONSOLE) {
    throw forbidden(ErrorCode.FEATURE_DISABLED, 'The Audit Console is not switched on for this marketplace.');
  }
}

/** Session and membership, WITHOUT the second-factor gate. Four routes only. */
export async function requireAuditSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  assertAuditConsoleEnabled();
  await requireAuthenticated('AUDIT')(request, reply);
  request.audit = await resolveAuditMember(currentUser(request).id);
}

async function authenticateWithSecondFactor(request: FastifyRequest, reply: FastifyReply): Promise<AuditMember> {
  await requireAuditSession(request, reply);
  const auth = currentUser(request);
  const user = await prisma.user.findUnique({ where: { id: auth.id }, select: { mfaEnabledAt: true } });
  const gate = auditMfaGate({
    enrolled: (user?.mfaEnabledAt ?? null) !== null,
    sessionVerified: auth.sessionMfaVerifiedAt !== null,
  });
  if (gate === 'SETUP_REQUIRED') {
    throw forbidden(ErrorCode.AUDIT_MFA_SETUP_REQUIRED, 'Set up two-step sign-in before using the Audit Console.');
  }
  if (gate === 'CHALLENGE_REQUIRED') {
    throw forbidden(ErrorCode.AUDIT_MFA_CHALLENGE_REQUIRED, 'Enter the code from your authenticator to continue.');
  }
  return currentAudit(request);
}

/** Every listed key is required. An empty list means "any console member". */
export function requireAudit(...keys: AuditConsoleKey[]) {
  return async function auditGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const member = await authenticateWithSecondFactor(request, reply);
    assertAuditPermission(member, ...keys);
  };
}

/**
 * At least ONE of the keys. For screens that serve both an agency (its own
 * jobs) and the audit staff (every job, read-only) - the service behind such a
 * route narrows the agency member again, so this only opens a door the
 * service closes back down.
 */
export function requireAuditAny(...keys: AuditConsoleKey[]) {
  if (keys.length === 0) throw new Error('requireAuditAny needs at least one key.');
  return async function auditAnyGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const member = await authenticateWithSecondFactor(request, reply);
    if (!keys.some((key) => member.permissions.has(key))) assertAuditPermission(member, keys[0] as AuditConsoleKey);
  };
}

export function currentAudit(request: FastifyRequest): AuditMember {
  if (request.audit === undefined) {
    throw forbidden(ErrorCode.AUDIT_MEMBER_REQUIRED, 'This account does not have access to the Audit Console.');
  }
  return request.audit;
}
