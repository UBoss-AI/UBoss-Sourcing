/**
 * Master data — admin routes (Master row 75).
 *
 * Units of measure, Incoterms and inspection defect codes. Reading needs
 * `settings.read`; adding, renaming or switching an entry off needs
 * `settings.write`, like the rest of the store's configuration.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import {
  createMasterData,
  listMasterData,
  MASTER_DATA_KINDS,
  updateMasterData,
  type MasterDataActor,
} from '../../modules/settings/master-data.service.js';
import { masterDataReadiness } from '../../modules/settings/master-data-readiness.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const kindParam = z.object({ kind: z.enum(MASTER_DATA_KINDS) });
const kindIdParam = z.object({ kind: z.enum(MASTER_DATA_KINDS), id: z.string().length(26) });

const entryFields = {
  code: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash or underscore only.'),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  defaultSeverity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().optional(),
};

const createBody = z.object(entryFields).strict();
const updateBody = z
  .object({ ...entryFields, code: entryFields.code.optional(), name: entryFields.name.optional() })
  .strict();

function actorFrom(request: FastifyRequest): MasterDataActor {
  const auth = currentUser(request);
  return { userId: auth.id, email: auth.email, ipAddress: request.ip, correlationId: request.correlationId };
}

export function registerAdminMasterDataRoutes(app: FastifyInstance): Promise<void> {
  /** Go-live check: is each required master list present, and is any demonstration seed data left? */
  app.get(
    '/master-data-readiness',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (_request, reply) => reply.status(200).send(await masterDataReadiness()),
  );

  /** List one master-data list (UOM, INCOTERM or DEFECT_CODE), switched-off entries included. */
  app.get(
    '/master-data/:kind',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (request, reply) => {
      const { kind } = kindParam.parse(request.params);
      return reply.status(200).send({ entries: await listMasterData(kind) });
    },
  );

  /** Add an entry to a master-data list. Codes are unique per list. Writes an audit entry. */
  app.post(
    '/master-data/:kind',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const { kind } = kindParam.parse(request.params);
      const body = createBody.parse(request.body);
      return reply.status(201).send({ entry: await createMasterData(kind, body, actorFrom(request)) });
    },
  );

  /** Edit or switch off a master-data entry. Writes an audit entry. */
  app.patch(
    '/master-data/:kind/:id',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const { kind, id } = kindIdParam.parse(request.params);
      const body = updateBody.parse(request.body);
      return reply
        .status(200)
        .send({ entry: await updateMasterData(kind, id, body, actorFrom(request)) });
    },
  );

  return Promise.resolve();
}
