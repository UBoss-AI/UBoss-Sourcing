/**
 * The Admin Panel's authority over the Audit Console
 * (`/api/v1/admin/audit-console/*`).
 *
 * Who may sign in to the console and as what: invite audit supervisors,
 * compliance reviewers and agency people, change a staff role, remove access,
 * resend an activation link. Guarded by the ADMIN catalogue's
 * `audit_console.manage` - an Admin Panel permission, never a console one, so
 * nobody inside the console can widen their own access.
 *
 * Also oversight of the requirement matrix: the rules and their coverage, and
 * approving or rejecting a submitted rule from here (the same maker-checker
 * rule applies: never the person who drafted it).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import {
  inviteToConsole,
  listConsolePeople,
  resendInvitation,
  updateStaffMember,
} from '../../modules/audit-console/membership.service.js';
import { decideRequirement, listRequirements, ruleCoverage } from '../../modules/compliance/requirement.service.js';
import { readComplianceFile } from '../../modules/compliance/document.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';
import { sendAttachment } from './preorder-chats.js';

const id = z.string().length(26);
const idParam = z.object({ id });

function admin(request: FastifyRequest) {
  const auth = currentUser(request);
  return { party: 'ADMIN' as const, userId: auth.id, label: auth.email, correlationId: request.correlationId };
}

export function registerAdminAuditConsoleRoutes(app: FastifyInstance): Promise<void> {
  /** Everybody with Audit Console access: the audit team and every agency's people, with how they sign in. */
  app.get('/audit-console/people', { preHandler: requireAdmin(Permission.AUDIT_CONSOLE_MANAGE) }, async (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send({ people: await listConsolePeople({ agencyId: null, includeStaff: true }) }));

  /** Invite somebody to the Audit Console: an audit supervisor or compliance reviewer, or a member of an agency. */
  app.post('/audit-console/invitations', { preHandler: requireAdmin(Permission.AUDIT_CONSOLE_MANAGE) }, async (request, reply) => {
    const input = z
      .object({
        email: z.string().email().max(320),
        fullName: z.string().trim().min(1).max(120),
        target: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('STAFF'), role: z.enum(['SUPERVISOR', 'COMPLIANCE_REVIEWER']) }),
          z.object({
            kind: z.literal('AGENCY'),
            agencyId: id,
            role: z.enum(['AGENCY_ADMIN', 'COORDINATOR', 'INSPECTOR', 'QA_REVIEWER']),
            jobTitle: z.string().trim().max(120).nullable().optional(),
            competenceCategoryIds: z.array(id).max(200).nullable().optional(),
          }),
        ]),
      })
      .parse(request.body);
    const invited = await inviteToConsole(admin(request), input);
    return reply.status(201).send({ userId: invited.userId, memberId: invited.memberId, expiresAt: invited.expiresAt.toISOString() });
  });

  /** Change an audit team member's role or competence, or remove their access (ends their sessions at once). */
  app.patch('/audit-console/staff/:id', { preHandler: requireAdmin(Permission.AUDIT_CONSOLE_MANAGE) }, async (request, reply) => {
    const { id: memberId } = idParam.parse(request.params);
    const input = z
      .object({
        role: z.enum(['SUPERVISOR', 'COMPLIANCE_REVIEWER']).optional(),
        status: z.enum(['ACTIVE', 'DISABLED']).optional(),
        disabledReason: z.string().trim().max(512).nullable().optional(),
        competenceCategoryIds: z.array(id).max(200).nullable().optional(),
      })
      .parse(request.body);
    await updateStaffMember({ userId: currentUser(request).id, correlationId: request.correlationId }, memberId, input);
    return reply.send({ ok: true });
  });

  /** Send a fresh activation link to somebody who has not activated their console account. */
  app.post('/audit-console/people/:id/resend-invitation', { preHandler: requireAdmin(Permission.AUDIT_CONSOLE_MANAGE) }, async (request, reply) => {
    const { id: userId } = idParam.parse(request.params);
    const sent = await resendInvitation(admin(request), userId);
    return reply.send({ expiresAt: sent.expiresAt.toISOString() });
  });

  /** The requirement matrix, for oversight. */
  app.get('/audit-console/rules', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => {
    const q = z.object({ status: z.enum(['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETIRED']).optional() }).parse(request.query);
    return reply.header('Cache-Control', 'no-store').send({ rules: await listRequirements({ status: q.status ?? null }), coverage: await ruleCoverage() });
  });

  /** Approve or reject a submitted compliance rule from the Admin Panel. Never one you drafted. */
  app.post('/audit-console/rules/:id/decision', { preHandler: requireAdmin(Permission.AUDIT_CONSOLE_MANAGE) }, async (request, reply) => {
    const { id: ruleId } = idParam.parse(request.params);
    const input = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().min(10).max(4000) }).parse(request.body);
    const a = admin(request);
    await decideRequirement({ type: 'ADMIN', userId: a.userId, label: a.label, correlationId: a.correlationId }, ruleId, input);
    return reply.send({ ok: true });
  });

  /** A seller's compliance document file, for the Admin Panel's own review screens. Audited. */
  app.get('/audit-console/documents/:id/file', { preHandler: requireAdmin(Permission.CUSTOMER_READ) }, async (request, reply) => {
    const { id: documentId } = idParam.parse(request.params);
    const auth = currentUser(request);
    const file = await readComplianceFile(documentId, { userId: auth.id, actorType: 'ADMIN', ipAddress: request.ip, correlationId: request.correlationId });
    return sendAttachment(reply.header('Cache-Control', 'no-store'), { body: file.body, contentType: file.contentType, fileName: file.fileName });
  });

  return Promise.resolve();
}
