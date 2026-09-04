/**
 * Chat enquiries, for staff.
 *
 * Read-only. There is no route here to edit a message or rewrite a name: the
 * transcript is what the visitor asked and what the assistant answered, and a
 * record that can be tidied up is not a record. Deleting one is a data-erasure
 * question rather than a screen action, so it is not offered either.
 *
 * The contact details on these rows are self-declared and unverified — the
 * widget asks, it does not confirm. The list says so, because a phone number
 * nobody checked and a phone number on a customer account are different things
 * to act on.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import {
  getConversation,
  listConversations,
} from '../../modules/assistant/conversation.service.js';
import { requireAdmin } from '../plugins/auth.js';

export function registerAdminAssistantRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/assistant/conversations',
    { preHandler: requireAdmin(Permission.ASSISTANT_CHAT_READ) },
    async (request, reply) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          /** Substring of the name, email or phone. */
          q: z.string().trim().max(120).optional(),
          customersOnly: z.coerce.boolean().optional(),
        })
        .parse(request.query);

      return reply.status(200).send(
        await listConversations({
          page: query.page,
          limit: query.limit,
          search: query.q,
          customersOnly: query.customersOnly,
        }),
      );
    },
  );

  app.get(
    '/assistant/conversations/:id',
    { preHandler: requireAdmin(Permission.ASSISTANT_CHAT_READ) },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);

      const conversation = await getConversation(id);
      if (conversation === null) throw notFound('Conversation');

      return reply.status(200).send(conversation);
    },
  );

  return Promise.resolve();
}
