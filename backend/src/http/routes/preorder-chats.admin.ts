/**
 * Preorder chat: the operator's inbox.
 *
 * Five permissions, and each route names the one it needs:
 *
 *   preorder_chat.view     read the inbox, conversations, notes and activity
 *   preorder_chat.reply    reply, notes, take a conversation, status, priority,
 *                          tags, link a preorder, send a proposal
 *   preorder_chat.assign   give a conversation to somebody else
 *   preorder_chat.moderate spam, block, unblock, redact
 *   preorder_chat.export   download a transcript
 *
 * Status moves also check their own permission inside the service - a
 * moderation status needs `moderate` whichever route asked for it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, isAppError, notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import {
  createAttachmentLink,
  redeemAttachmentLink,
  uploadAttachment,
} from '../../modules/preorder-chat/attachment.service.js';
import {
  getStaffConversation,
  historyQuerySchema,
  listStaffConversations,
  listStaffMessages,
  markStaffRead,
  readSchema,
  sendStaffMessage,
  staffInboxCounts,
  staffListQuerySchema,
  staffSendSchema,
  type StaffActor,
} from '../../modules/preorder-chat/conversation.service.js';
import { chatSocketFailuresTotal } from '../../modules/preorder-chat/metrics.js';
import { readChatOperations } from '../../modules/preorder-chat/operations.service.js';
import {
  createProposal,
  listProposals,
  proposalInputSchema,
  withdrawProposal,
} from '../../modules/preorder-chat/proposal.service.js';
import { CloseCode } from '../../modules/preorder-chat/realtime/gateway.js';
import {
  addNote,
  assignConversation,
  assignSchema,
  blockCustomer,
  blockSchema,
  changeStatus,
  exportTranscript,
  linkPreorder,
  linkSchema,
  listActivity,
  listEligibleAssignees,
  listNotes,
  noteSchema,
  prioritySchema,
  redactMessage,
  redactSchema,
  setPriority,
  setTags,
  statusSchema,
  tagsSchema,
  unblockCustomer,
} from '../../modules/preorder-chat/staff-actions.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';
import { sendAttachment, socketOriginAllowed } from './preorder-chats.js';

const idParam = z.object({ id: z.string().length(26) });
const messageParams = z.object({ id: z.string().length(26), messageId: z.string().length(26) });
const proposalParams = z.object({ id: z.string().length(26), proposalId: z.string().length(26) });
const attachmentParams = z.object({
  id: z.string().length(26),
  attachmentId: z.string().length(26),
});

const WRITE_LIMIT = { max: 120, timeWindow: '1 minute' } as const;

function actorOf(request: FastifyRequest): StaffActor {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    permissions: new Set(auth.permissions),
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

export function registerAdminPreorderChatRoutes(app: FastifyInstance): Promise<void> {
  // Each route names its guard inline, so the reference docs - and a reader -
  // can see exactly what it needs. Status moves also check reply-or-moderate
  // per move, inside the service.

  app.addHook('onRequest', (_request, _reply, done) => {
    done(env.FEATURE_PREORDER_CHAT ? undefined : notFound('Preorder chat'));
  });

  const send = async (
    response: FastifyReply,
    outcome: { value: unknown; events: Parameters<typeof app.preorderChat.publish>[0] },
    status = 200,
  ): Promise<FastifyReply> => {
    await app.preorderChat.publish(outcome.events);
    return response.status(status).send(outcome.value);
  };

  const socketAuth = new WeakMap<FastifyRequest, string>();
  /**
   * The live connection for the console. Same session cookie, same guards as
   * every admin route; needs `preorder_chat.view`. A refused check upgrades,
   * says why, and closes with 4401 (sign in again) or 4403 (not allowed).
   */
  app.get(
    '/preorder-chats/socket',
    {
      websocket: true,
      preHandler: async (request, response) => {
        if (!socketOriginAllowed(request)) {
          chatSocketFailuresTotal.inc({ reason: 'origin' });
          await response.status(403).send({
            error: { code: ErrorCode.FORBIDDEN, message: 'Origin not allowed.', details: [] },
          });
          return;
        }
        try {
          await requireAdmin(Permission.PREORDER_CHAT_VIEW)(request, response);
        } catch (error) {
          socketAuth.set(request, isAppError(error) ? error.code : 'UNAUTHENTICATED');
        }
      },
    },
    (socket, request) => {
      const failure = socketAuth.get(request);
      if (failure !== undefined || request.auth === undefined) {
        chatSocketFailuresTotal.inc({ reason: 'auth' });
        const code = failure ?? 'UNAUTHENTICATED';
        socket.send(JSON.stringify({ type: 'error', code }));
        socket.close(
          code === 'UNAUTHENTICATED' || code === 'SESSION_EXPIRED'
            ? CloseCode.UNAUTHENTICATED
            : CloseCode.FORBIDDEN,
          code,
        );
        return;
      }
      const auth = request.auth;
      app.preorderChat.gateway.attach(socket, {
        kind: 'ADMIN',
        userId: auth.id,
        email: auth.email,
        sessionId: auth.sessionId,
        permissions: new Set(auth.permissions),
      });
    },
  );

  /**
   * The inbox: filtered, searched and sorted on the server, one page at a
   * time by cursor. Reads conversation rows only - no message history.
   */
  app.get(
    '/preorder-chats',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW) },
    async (request, response) => {
      const query = staffListQuerySchema.parse(request.query);
      return response.status(200).send(await listStaffConversations(actorOf(request), query));
    },
  );

  /** How many conversations are behind each inbox tab. */
  app.get(
    '/preorder-chats/counts',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW) },
    async (request, response) => {
      return response.status(200).send({ counts: await staffInboxCounts(actorOf(request)) });
    },
  );

  /**
   * Operational numbers for the inbox header: queue sizes, response and
   * resolution times, reopened conversations. Counts and durations only.
   */
  app.get(
    '/preorder-chats/operations',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW) },
    async (_request, response) => {
      return response.status(200).send(await readChatOperations());
    },
  );

  /** Staff who may be given a conversation: active, and able to reply. */
  app.get(
    '/preorder-chats/assignees',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_ASSIGN) },
    async (_request, response) => {
      return response.status(200).send({ assignees: await listEligibleAssignees() });
    },
  );

  /**
   * One conversation with its context panel: the product as the customer saw
   * it and as it is now, the customer, the seller, the linked preorder.
   * Opening it is recorded on the audit trail.
   */
  app.get(
    '/preorder-chats/:id',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW) },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      return response
        .status(200)
        .send({ conversation: await getStaffConversation(actorOf(request), id) });
    },
  );

  /** A page of history - `after` to catch up, `before` to load earlier. */
  app.get(
    '/preorder-chats/:id/messages',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW) },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const query = historyQuerySchema.parse(request.query);
      return response.status(200).send(await listStaffMessages(id, query));
    },
  );

  /**
   * Reply to the customer. The first reply to an unassigned conversation
   * assigns it to whoever wrote it, and closes any SLA alert. Retrying with
   * the same `clientMessageId` returns the stored message.
   */
  app.post(
    '/preorder-chats/:id/messages',
    {
      preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_REPLY),
      config: { rateLimit: WRITE_LIMIT },
    },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const input = staffSendSchema.parse(request.body);
      const outcome = await sendStaffMessage(actorOf(request), id, input);
      return send(response, outcome, outcome.value.duplicate ? 200 : 201);
    },
  );

  /** Mark read up to a sequence number, for the whole team. */
  app.post(
    '/preorder-chats/:id/read',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW) },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const { seq } = readSchema.parse(request.body);
      return send(response, await markStaffRead(actorOf(request), id, seq));
    },
  );

  /**
   * Take a conversation, give it to a colleague, or put it back in the queue.
   * Taking it yourself needs `reply`; anything else needs `assign`. The new
   * holder is emailed.
   */
  app.post(
    '/preorder-chats/:id/assign',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW), config: { rateLimit: WRITE_LIMIT } },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const input = assignSchema.parse(request.body);
      return send(response, await assignConversation(actorOf(request), id, input));
    },
  );

  /**
   * Move the conversation: open, waiting for the customer, waiting internally,
   * resolved, closed, reopened, spam. Spam and leaving spam need `moderate`.
   * Blocking has its own route.
   */
  app.post(
    '/preorder-chats/:id/status',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW), config: { rateLimit: WRITE_LIMIT } },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const input = statusSchema.parse(request.body);
      return send(response, await changeStatus(actorOf(request), id, input));
    },
  );

  /** Set how urgent the conversation is. */
  app.post(
    '/preorder-chats/:id/priority',
    {
      preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_REPLY),
      config: { rateLimit: WRITE_LIMIT },
    },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const input = prioritySchema.parse(request.body);
      return send(response, await setPriority(actorOf(request), id, input));
    },
  );

  /** Replace the conversation's staff-only tags. */
  app.put(
    '/preorder-chats/:id/tags',
    {
      preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_REPLY),
      config: { rateLimit: WRITE_LIMIT },
    },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const input = tagsSchema.parse(request.body);
      return send(response, await setTags(actorOf(request), id, input));
    },
  );

  /** Internal notes. Never shown or sent to the customer. */
  app.get(
    '/preorder-chats/:id/notes',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW) },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      return response.status(200).send({ notes: await listNotes(id) });
    },
  );

  /** Add an internal note. Only other staff ever see it. */
  app.post(
    '/preorder-chats/:id/notes',
    {
      preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_REPLY),
      config: { rateLimit: WRITE_LIMIT },
    },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const input = noteSchema.parse(request.body);
      return send(response, await addNote(actorOf(request), id, input), 201);
    },
  );

  /** What has been decided about the conversation - its audit entries. */
  app.get(
    '/preorder-chats/:id/activity',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW) },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      return response.status(200).send({ activity: await listActivity(id) });
    },
  );

  /**
   * Link the conversation to one of this customer's preorders for this
   * product, or unlink it. The customer sees a card naming the preorder.
   */
  app.post(
    '/preorder-chats/:id/preorder',
    {
      preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_REPLY),
      config: { rateLimit: WRITE_LIMIT },
    },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const input = linkSchema.parse(request.body);
      return send(response, await linkPreorder(actorOf(request), id, input));
    },
  );

  /** Every proposal sent in this conversation, newest first. */
  app.get(
    '/preorder-chats/:id/proposals',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW) },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      return response.status(200).send({ proposals: await listProposals(id) });
    },
  );

  /**
   * Send a preorder proposal - or a new revision of the open one. The pieces
   * come from the seller's verified unit sizes; the price is indicative. The
   * customer turns it into a preorder request through the ordinary preorder
   * form, and nothing is ordered or reserved by the proposal itself.
   */
  app.post(
    '/preorder-chats/:id/proposals',
    {
      preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_REPLY),
      config: { rateLimit: WRITE_LIMIT },
    },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const input = proposalInputSchema.parse(request.body);
      return send(response, await createProposal(actorOf(request), id, input), 201);
    },
  );

  /** Withdraw an open proposal. */
  app.post(
    '/preorder-chats/:id/proposals/:proposalId/withdraw',
    {
      preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_REPLY),
      config: { rateLimit: WRITE_LIMIT },
    },
    async (request, response) => {
      const { id, proposalId } = proposalParams.parse(request.params);
      return send(response, await withdrawProposal(actorOf(request), id, proposalId));
    },
  );

  /**
   * Remove the words of one message, giving a reason. The message row stays;
   * the words do not. Audited with a fingerprint of what was removed.
   */
  app.post(
    '/preorder-chats/:id/messages/:messageId/redact',
    {
      preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_MODERATE),
      config: { rateLimit: WRITE_LIMIT },
    },
    async (request, response) => {
      const { id, messageId } = messageParams.parse(request.params);
      const input = redactSchema.parse(request.body);
      return send(response, await redactMessage(actorOf(request), id, messageId, input));
    },
  );

  /** Stop this customer sending preorder chat messages anywhere. */
  app.post(
    '/preorder-chats/:id/block',
    {
      preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_MODERATE),
      config: { rateLimit: WRITE_LIMIT },
    },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const input = blockSchema.parse(request.body);
      return send(response, await blockCustomer(actorOf(request), id, input));
    },
  );

  /** Let a blocked customer message again. */
  app.post(
    '/preorder-chats/:id/unblock',
    {
      preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_MODERATE),
      config: { rateLimit: WRITE_LIMIT },
    },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      return send(response, await unblockCustomer(actorOf(request), id));
    },
  );

  /** Download the whole conversation, notes included, as JSON. Audited. */
  app.get(
    '/preorder-chats/:id/export',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_EXPORT) },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const transcript = await exportTranscript(actorOf(request), id);
      return response
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="preorder-chat-${id}.json"`)
        .header('cache-control', 'no-store')
        .status(200)
        .send(JSON.stringify(transcript, null, 2));
    },
  );

  /** Send a PDF or an image to the customer. Checked, scanned and stored privately. */
  app.post(
    '/preorder-chats/:id/attachments',
    {
      preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW, Permission.PREORDER_CHAT_REPLY),
      config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
    },
    async (request, response) => {
      const { id } = idParam.parse(request.params);
      const upload = await request.file({
        limits: { fileSize: env.PREORDER_CHAT_ATTACHMENT_MAX_BYTES, files: 1 },
      });
      if (upload === undefined) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'No file was attached.', [
          { field: 'file', code: 'REQUIRED' },
        ]);
      }
      const bytes = await upload.toBuffer();
      const fields = upload.fields as Record<string, { value?: unknown } | undefined>;
      const clientMessageId = fields['clientMessageId']?.value;
      const outcome = await uploadAttachment('STAFF', actorOf(request), id, {
        bytes,
        fileName: upload.filename,
        clientMessageId: typeof clientMessageId === 'string' ? clientMessageId : '',
      });
      return send(response, outcome, outcome.value.duplicate ? 200 : 201);
    },
  );

  /** A download link for one attachment: five minutes, single use. */
  app.post(
    '/preorder-chats/:id/attachments/:attachmentId/link',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW) },
    async (request, response) => {
      const { id, attachmentId } = attachmentParams.parse(request.params);
      const link = await createAttachmentLink('STAFF', actorOf(request), id, attachmentId);
      return response.header('cache-control', 'no-store').status(200).send(link);
    },
  );

  /** Redeem a download link. Served as an attachment, never inline. */
  app.get(
    '/preorder-chats/:id/attachments/:attachmentId/download',
    { preHandler: requireAdmin(Permission.PREORDER_CHAT_VIEW) },
    async (request, response) => {
      const { id, attachmentId } = attachmentParams.parse(request.params);
      const { token } = z.object({ token: z.string().min(1).max(256) }).parse(request.query);
      const file = await redeemAttachmentLink('STAFF', actorOf(request), id, attachmentId, token);
      return sendAttachment(response, file);
    },
  );

  return Promise.resolve();
}
