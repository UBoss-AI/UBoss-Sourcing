/**
 * Seller Hub -> Factories and certificates (checklist Master row 13). Under
 * `/seller`.
 *
 * The seller comes from the session and every service narrows reads and
 * writes to it, so another seller's factory, evidence or certificate answers
 * 404. There is no route here that sets a verification status: submitting is
 * the only move a seller makes, and the operator decides under `/admin`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  addEvidence,
  archiveFactory,
  createFactory,
  evidenceInput,
  factoryInput,
  factoryPatch,
  listFactories,
  machinesInput,
  removeEvidence,
  replaceMachines,
  submitFactory,
  updateFactory,
} from '../../modules/trust/factory.service.js';
import {
  archiveCertification,
  certificationInput,
  certificationPatch,
  createCertification,
  listCertifications,
  submitCertification,
  updateCertification,
} from '../../modules/trust/certification.service.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';

const WRITE = { max: 60, timeWindow: '1 minute' } as const;
const idParam = z.object({ id: z.string().length(26) });
const evidenceParam = z.object({ id: z.string().length(26), evidenceId: z.string().length(26) });

export function registerSellerFactoryRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: requireSeller(SellerPermission.ACCOUNT_READ) };
  const write = { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE), config: { rateLimit: WRITE } };
  const submit = { preHandler: requireSeller(SellerPermission.ACCOUNT_SUBMIT), config: { rateLimit: WRITE } };

  // --- Factories -------------------------------------------------------------

  /** The seller's factories, with machines, evidence and where each one's verification stands. */
  app.get('/factories', read, async (request, reply) => {
    const factories = await listFactories(currentSeller(request));
    return reply.header('cache-control', 'no-store').send({ factories });
  });

  /** Record a factory: address, capacity, workforce, quality control. Writes an entry in the seller's activity log. */
  app.post('/factories', write, async (request, reply) => {
    const factory = await createFactory(currentSeller(request), factoryInput.parse(request.body), request.correlationId);
    return reply.status(201).send({ factory });
  });

  /**
   * Change a factory's details. Refused while it is with a reviewer; a change
   * to a verified factory's facts sends it back for review. Writes an entry in
   * the seller's activity log.
   */
  app.patch('/factories/:id', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const factory = await updateFactory(currentSeller(request), id, factoryPatch.parse(request.body), request.correlationId);
    return reply.send({ factory });
  });

  /** Archive a factory so it is no longer shown. Its history of checks is kept. */
  app.delete('/factories/:id', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await archiveFactory(currentSeller(request), id, request.correlationId);
    return reply.status(204).send();
  });

  /** Replace the list of machines in a factory. On a verified factory this sends it back for review. */
  app.put('/factories/:id/machines', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const factory = await replaceMachines(currentSeller(request), id, machinesInput.parse(request.body), request.correlationId);
    return reply.send({ factory });
  });

  /** Attach one of the seller's own documents to a factory as evidence, optionally with where it was taken. */
  app.post('/factories/:id/evidence', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const factory = await addEvidence(currentSeller(request), id, evidenceInput.parse(request.body), request.correlationId);
    return reply.status(201).send({ factory });
  });

  /** Detach a piece of evidence from a factory. On a verified factory this sends it back for review. */
  app.delete('/factories/:id/evidence/:evidenceId', write, async (request, reply) => {
    const { id, evidenceId } = evidenceParam.parse(request.params);
    const factory = await removeEvidence(currentSeller(request), id, evidenceId, request.correlationId);
    return reply.send({ factory });
  });

  /** Send a factory for verification: the first time, after a refusal, or after it expired. Needs evidence. */
  app.post('/factories/:id/submit', submit, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const factory = await submitFactory(currentSeller(request), id, request.correlationId);
    return reply.send({ factory });
  });

  // --- Certificates ------------------------------------------------------------

  /** The seller's certificates, with where each one's check stands and whether it expires soon. */
  app.get('/certifications', read, async (request, reply) => {
    const certifications = await listCertifications(currentSeller(request));
    return reply.header('cache-control', 'no-store').send({ certifications });
  });

  /** Add a certificate with the document that proves it. It goes straight to review. */
  app.post('/certifications', write, async (request, reply) => {
    const certification = await createCertification(
      currentSeller(request),
      certificationInput.parse(request.body),
      request.correlationId,
    );
    return reply.status(201).send({ certification });
  });

  /** Change a certificate. Refused while it is with a reviewer; a verified one goes back for review. */
  app.patch('/certifications/:id', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const certification = await updateCertification(
      currentSeller(request),
      id,
      certificationPatch.parse(request.body),
      request.correlationId,
    );
    return reply.send({ certification });
  });

  /** Archive a certificate so it is no longer shown. */
  app.delete('/certifications/:id', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await archiveCertification(currentSeller(request), id, request.correlationId);
    return reply.status(204).send();
  });

  /** Send a refused or expired certificate for review again. */
  app.post('/certifications/:id/submit', submit, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const certification = await submitCertification(currentSeller(request), id, request.correlationId);
    return reply.send({ certification });
  });

  return Promise.resolve();
}
