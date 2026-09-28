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
import { assistantStatus, probeAssistant } from '../../modules/assistant/assistant.service.js';
import {
  getConversation,
  listConversations,
} from '../../modules/assistant/conversation.service.js';
import { requireAdmin } from '../plugins/auth.js';

export function registerAdminAssistantRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Whether the AI provider is configured: DISABLED, MISSING_CREDENTIALS or
   * CONFIGURED, with the provider and model. `?probe=true` also makes one
   * real call and reports whether it answered. Never returns a key.
   */
  app.get(
    '/assistant/status',
    {
      preHandler: requireAdmin(Permission.SETTINGS_READ),
      // A probe spends provider quota. Ten an hour is plenty for a person
      // checking a key, and nothing for a script left looping on it.
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const { probe } = z
        .object({ probe: z.enum(['true', 'false']).optional() })
        .parse(request.query);

      const status = probe === 'true' ? await probeAssistant() : assistantStatus();
      return reply.header('cache-control', 'no-store').status(200).send(status);
    },
  );

  /**
   * List chat enquiries made through the shopping assistant, a page at a time.
   * Can be searched by name, email or phone, or narrowed to conversations
   * linked to a customer account.
   */
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

  /**
   * One chat conversation with the shopping assistant: the visitor's
   * self-declared contact details and the full transcript. Read-only.
   */
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
