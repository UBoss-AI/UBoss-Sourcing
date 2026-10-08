/**
 * Settings → Legal documents: the operator writes and publishes the Terms and
 * Conditions every new account agrees to.
 *
 * Drafts can be changed and deleted; a published document never can - the
 * service refuses, and the database keeps anything somebody accepted from
 * being deleted. Each step has its own permission, Business Owner only by
 * default. The list says how many people accepted each version, never who.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { LEGAL_DOCUMENT_KINDS } from '../../domain/legal-document.js';
import { Permission } from '../../domain/permissions.js';
import {
  createDraft,
  deleteDraft,
  getLegalDocumentForAdmin,
  listLegalDocuments,
  publishDraft,
  updateDraft,
  type LegalActor,
} from '../../modules/legal/legal-document.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

const draftSchema = z.object({
  kind: z.enum(LEGAL_DOCUMENT_KINDS),
  version: z.string().max(64),
  locale: z.string().max(10),
  title: z.string().max(400),
  body: z.string().max(500_000),
  changeSummary: z.string().max(4000).nullable().optional(),
  effectiveAt: z.coerce.date(),
  requiresReacceptance: z.boolean().optional(),
});

function actorOf(request: FastifyRequest): LegalActor {
  const user = currentUser(request);
  return { userId: user.id, email: user.email, ipAddress: request.ip, correlationId: request.correlationId };
}

export function registerAdminLegalRoutes(app: FastifyInstance): Promise<void> {
  // Every legal document, drafts included, with how many people accepted each.
  app.get('/legal-documents', { preHandler: requireAdmin(Permission.LEGAL_DOCUMENT_READ) }, async (request, reply) => {
    const { kind } = z.object({ kind: z.enum(LEGAL_DOCUMENT_KINDS).optional() }).parse(request.query);
    return reply.send({ documents: await listLegalDocuments({ kind }) });
  });

  // One legal document, draft or published.
  app.get('/legal-documents/:id', { preHandler: requireAdmin(Permission.LEGAL_DOCUMENT_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send(await getLegalDocumentForAdmin(id));
  });

  // Start a new version as a draft. Nobody outside the console sees it.
  app.post('/legal-documents', { preHandler: requireAdmin(Permission.LEGAL_DOCUMENT_WRITE) }, async (request, reply) => {
    const body = draftSchema.parse(request.body);
    return reply.status(201).send(await createDraft(body, actorOf(request)));
  });

  // Change a draft. 409 LEGAL_DOCUMENT_IMMUTABLE for a published document.
  app.put('/legal-documents/:id', { preHandler: requireAdmin(Permission.LEGAL_DOCUMENT_WRITE) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = draftSchema.parse(request.body);
    return reply.send(await updateDraft(id, body, actorOf(request)));
  });

  // Delete a draft. 409 LEGAL_DOCUMENT_IMMUTABLE for a published document.
  app.delete('/legal-documents/:id', { preHandler: requireAdmin(Permission.LEGAL_DOCUMENT_WRITE) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await deleteDraft(id, actorOf(request));
    return reply.status(204).send();
  });

  // Publish a draft: its words are frozen and new accounts must accept it once it takes effect.
  app.post('/legal-documents/:id/publish', { preHandler: requireAdmin(Permission.LEGAL_DOCUMENT_PUBLISH) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send(await publishDraft(id, actorOf(request)));
  });

  return Promise.resolve();
}
