/**
 * The company directory, for the admin console.
 *
 * One read-only route. Everything an operator can DO to a company is done on
 * that company's own screen — a seller decision, a carrier's contract, a
 * customer's status — each with its own permission and its own audit trail.
 * This one answers "who is this and what do they do here", and nothing else.
 *
 * THE GUARD IS `CUSTOMER_READ` OR `LOGISTICS_READ`, NOT BOTH
 *
 * `requireAdmin` requires every permission it is given, which would mean an
 * operations manager who may read carriers but not customers could not open a
 * screen that lists carriers. So the guard asks for authentication and the
 * handler decides what the caller may see: sellers and buyers behind
 * `customer.read`, carriers behind `logistics.read`, and an empty directory
 * where somebody holds neither. Absent rather than greyed out — see the
 * service's header for why.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCode, forbidden } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { readDirectory } from '../../modules/directory/directory.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

export function registerAdminDirectoryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Search the directory of companies on the platform - sellers, buyers and
   * carriers - a page at a time. Staff see only the kinds their permissions
   * allow, and are refused if they may read neither customers nor carriers.
   */
  app.get(
    '/directory',
    // No permission argument: the handler below checks the two it accepts,
    // because holding EITHER is enough and `requireAdmin` means "all of".
    { preHandler: requireAdmin() },
    async (request, reply) => {
      const auth = currentUser(request);
      const held = new Set(auth.permissions);

      const canReadCustomers = held.has(Permission.CUSTOMER_READ);
      const canReadLogistics = held.has(Permission.LOGISTICS_READ);

      if (!canReadCustomers && !canReadLogistics) {
        throw forbidden(
          ErrorCode.PERMISSION_DENIED,
          'You do not have permission to perform this action.',
        );
      }

      const query = z
        .object({
          search: z.string().trim().max(200).nullish(),
          kind: z.enum(['SELLER', 'BUYER', 'LOGISTICS']).nullish(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(request.query);

      const result = await readDirectory({
        search: query.search ?? null,
        kind: query.kind ?? null,
        page: query.page,
        pageSize: query.pageSize,
        canReadCustomers,
        canReadLogistics,
      });

      return reply.header('cache-control', 'no-store').status(200).send(result);
    },
  );

  return Promise.resolve();
}
