/**
 * An individual buyer's identity check, importer details and marketing
 * choices (checklist Master row 11).
 *
 *   /account/...           the buyer's own, keyed by their session - never
 *                          by an id in the URL, so nobody reaches another
 *                          buyer's record.
 *   /admin/customers/...   staff: read with customer.read; decide with
 *                          buyer_company.review (the people who check
 *                          company applications check individuals too).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import {
  decideKyc,
  decideKycDocument,
  getKycForStaff,
  getMarketing,
  getOwnKyc,
  KYC_DOCUMENT_KINDS,
  identityInput,
  importerInput,
  marketingInput,
  readKycDocumentForStaff,
  submitOwnKyc,
  updateMarketing,
  updateOwnIdentity,
  updateOwnImporter,
  uploadOwnKycDocument,
  withdrawOwnKycDocument,
  type KycActor,
} from '../../modules/customers/customer-kyc.service.js';
import { currentUser, requireAdmin, requireCustomer } from '../plugins/auth.js';
import { assertStaffDataRegion } from '../plugins/data-region.js';

const idParam = z.object({ id: z.string().length(26) });
const documentParam = z.object({ id: z.string().length(26), documentId: z.string().length(26) });

function actorOf(request: FastifyRequest): KycActor {
  const auth = currentUser(request);
  return { userId: auth.id, email: auth.email, ipAddress: request.ip, correlationId: request.correlationId };
}

function profileOf(request: FastifyRequest): string {
  return currentUser(request).customerProfileId ?? '';
}

export function registerCustomerKycRoutes(app: FastifyInstance): Promise<void> {
  // Your identity check, importer details and uploaded documents.
  app.get('/kyc', { preHandler: requireCustomer }, async (request, reply) =>
    reply.header('cache-control', 'no-store').send(await getOwnKyc(profileOf(request))),
  );

  // Change your identity details. Refused while with a reviewer or verified; the document number is kept masked.
  app.put('/kyc/identity', { preHandler: requireCustomer }, async (request, reply) =>
    reply.send(await updateOwnIdentity(profileOf(request), identityInput.parse(request.body), actorOf(request))),
  );

  // Change your importer-of-record details. Always editable; never "verified".
  app.put('/kyc/importer', { preHandler: requireCustomer }, async (request, reply) =>
    reply.send(await updateOwnImporter(profileOf(request), importerInput.parse(request.body), actorOf(request))),
  );

  // Send your identity check for review. Every detail and an identity document are required.
  app.post('/kyc/submit', { preHandler: requireCustomer }, async (request, reply) =>
    reply.send(await submitOwnKyc(profileOf(request), actorOf(request))),
  );

  // Upload a document (PDF, JPEG, PNG, WebP): multipart, the `kind` field before the file. Scanned and stored privately.
  app.post(
    '/kyc/documents',
    { preHandler: requireCustomer, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const upload = await request.file({ limits: { fileSize: env.BUYER_COMPANY_DOCUMENT_MAX_BYTES + 1, files: 1 } });
      if (upload === undefined) {
        return reply.status(400).send({
          error: { code: ErrorCode.VALIDATION_FAILED, message: 'No file was attached.', details: [], correlationId: request.correlationId },
        });
      }
      const bytes = await upload.toBuffer();
      const fields = upload.fields as Record<string, { value?: unknown } | undefined>;
      const { kind } = z
        .object({ kind: z.enum(KYC_DOCUMENT_KINDS) })
        .parse({ kind: fields.kind?.value });
      return reply.status(201).send(
        await uploadOwnKycDocument({
          customerProfileId: profileOf(request),
          kind,
          fileName: upload.filename,
          bytes,
          actor: actorOf(request),
        }),
      );
    },
  );

  // Withdraw a document nobody has decided on yet.
  app.delete('/kyc/documents/:id', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send(await withdrawOwnKycDocument(profileOf(request), id, actorOf(request)));
  });

  // Your marketing choices: email, SMS and product news. All off until you switch them on.
  app.get('/preferences/marketing', { preHandler: requireCustomer }, async (request, reply) =>
    reply.send(await getMarketing(profileOf(request))),
  );

  // Change your marketing choices. Each change is recorded with its time.
  app.put('/preferences/marketing', { preHandler: requireCustomer }, async (request, reply) =>
    reply.send(await updateMarketing(profileOf(request), marketingInput.parse(request.body), actorOf(request))),
  );

  return Promise.resolve();
}

export function registerAdminCustomerKycRoutes(app: FastifyInstance): Promise<void> {
  // One buyer's identity check, importer details and documents.
  app.get('/customers/:id/kyc', { preHandler: requireAdmin(Permission.CUSTOMER_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.header('cache-control', 'no-store').send(await getKycForStaff(id));
  });

  // Verify or refuse a submitted identity check. Refusing needs a reason the buyer sees; verifying needs an accepted identity document.
  app.post('/customers/:id/kyc/decision', { preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        decision: z.enum(['VERIFIED', 'REJECTED']),
        // The status on the reviewer's screen; a stale one is refused with 409.
        expectedStatus: z.enum(['NOT_STARTED', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'EXPIRED']),
        note: z.string().trim().max(500).nullable().default(null),
      })
      .parse(request.body);
    return reply.send(
      await decideKyc({ customerProfileId: id, decision: body.decision, expectedStatus: body.expectedStatus, note: body.note, actor: actorOf(request) }),
    );
  });

  // Accept or refuse one uploaded document.
  app.post(
    '/customers/:id/kyc/documents/:documentId/decision',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW) },
    async (request, reply) => {
      const { id, documentId } = documentParam.parse(request.params);
      const body = z
        .object({ decision: z.enum(['ACCEPTED', 'REJECTED']), note: z.string().trim().max(500).nullable().default(null) })
        .parse(request.body);
      // The document must belong to this customer: an id from another record is not found.
      const own = await getKycForStaff(id);
      if (!own.documents.some((document) => document.id === documentId)) {
        return reply.status(404).send({
          error: { code: ErrorCode.NOT_FOUND, message: 'Document not found.', details: [], correlationId: request.correlationId },
        });
      }
      await decideKycDocument({ documentId, decision: body.decision, note: body.note, actor: actorOf(request) });
      return reply.send(await getKycForStaff(id));
    },
  );

  // Open one uploaded document. Every opening is audited.
  app.get(
    '/customers/:id/kyc/documents/:documentId/file',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW) },
    async (request, reply) => {
      const { id, documentId } = documentParam.parse(request.params);
      const own = await getKycForStaff(id);
      if (!own.documents.some((document) => document.id === documentId)) {
        return reply.status(404).send({
          error: { code: ErrorCode.NOT_FOUND, message: 'Document not found.', details: [], correlationId: request.correlationId },
        });
      }
      assertStaffDataRegion(request);
      const file = await readKycDocumentForStaff(documentId, actorOf(request));
      return reply
        .header('content-type', file.mimeType)
        // ASCII only: a header cannot carry the buyer's own characters safely.
        .header('content-disposition', `inline; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
        .header('cache-control', 'no-store, private')
        .header('x-content-type-options', 'nosniff')
        // Opened inline, so an uploaded PDF may not run anything or reach anywhere.
        .header('content-security-policy', "sandbox; default-src 'none'")
        .send(file.bytes);
    },
  );

  return Promise.resolve();
}
