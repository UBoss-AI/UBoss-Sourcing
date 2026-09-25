/**
 * Preorder chat: the customer's side.
 *
 * A signed-in customer asking the OPERATOR's team about a preorder, from the
 * product page. Every route here but `/availability` and the two `/assistant`
 * routes needs a customer session, and every conversation route narrows to
 * that customer's own profile INSIDE the query - another customer's
 * conversation id answers exactly as a missing one does. There is no seller route anywhere that reaches these tables.
 *
 * Writes go over REST, which is where authorisation, validation, the
 * transaction and the acknowledgement live. The socket at `/socket` only
 * tells an open page that something changed.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { allowedOrigins, env } from '../../config/env.js';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { isAppError } from '../../domain/errors.js';
import {
  attachmentAvailability,
  ATTACHMENT_TYPES,
} from '../../modules/preorder-chat/attachment-policy.js';
import {
  createAttachmentLink,
  redeemAttachmentLink,
  uploadAttachment,
} from '../../modules/preorder-chat/attachment.service.js';
import { answerFaq } from '../../modules/preorder-chat/assistant/answers.js';
import { FAQ_IDS, activeFaqEntries } from '../../modules/preorder-chat/assistant/catalogue.js';
import {
  customerFirstName,
  gatherFaqFacts,
  signAnswer,
} from '../../modules/preorder-chat/assistant/facts.service.js';
import {
  buildChatContext,
  chatContextInputSchema,
} from '../../modules/preorder-chat/context.service.js';
import {
  continueCustomerChat,
  customerSendSchema,
  customerStartSchema,
  customerUnreadTotal,
  getCustomerConversation,
  handoffSchema,
  historyQuerySchema,
  listCustomerConversations,
  listCustomerMessages,
  markCustomerRead,
  previewCustomerChat,
  readSchema,
  requestHumanHandoff,
  startOrContinueCustomerChat,
  type CustomerActor,
} from '../../modules/preorder-chat/conversation.service.js';
import { chatSocketFailuresTotal } from '../../modules/preorder-chat/metrics.js';
import {
  declineProposal,
  declineSchema,
  getProposalForCustomer,
  markProposalSubmitted,
  submittedSchema,
} from '../../modules/preorder-chat/proposal.service.js';
import { CloseCode } from '../../modules/preorder-chat/realtime/gateway.js';
import { currentUser, optionalCustomer, requireCustomer } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });
const proposalParams = z.object({ id: z.string().length(26), proposalId: z.string().length(26) });
const attachmentParams = z.object({
  id: z.string().length(26),
  attachmentId: z.string().length(26),
});

function actorOf(request: FastifyRequest, locale: string | null = null): CustomerActor {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    customerProfileId: auth.customerProfileId ?? '',
    locale,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

const SEND_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

/**
 * Is this handshake from a page we serve?
 *
 * A WebSocket is not covered by CORS: a page on any site can open one to this
 * origin and the browser will attach the cookies. The Origin header is the
 * defence, so an origin that is present and not on the allowlist is refused
 * before the upgrade. A missing Origin is a non-browser client - which holds
 * its own cookies and is the user themselves.
 */
export function socketOriginAllowed(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  return origin === undefined || allowedOrigins.includes(origin);
}

/** Download headers for a file that must never render in this origin. */
export function sendAttachment(
  reply: FastifyReply,
  file: { body: Buffer; contentType: string; fileName: string },
): FastifyReply {
  const ascii = file.fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return reply
    .header('content-type', file.contentType)
    .header(
      'content-disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    )
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cache-control', 'no-store')
    .status(200)
    .send(file.body);
}

export function registerPreorderChatRoutes(app: FastifyInstance): Promise<void> {
  const publish = (events: Parameters<typeof app.preorderChat.publish>[0]): Promise<void> =>
    app.preorderChat.publish(events);

  // A feature switched off answers every chat route with 404, the
  // availability probe excepted (it says `enabled: false`).
  app.addHook('onRequest', (request, _reply, done) => {
    const open = env.FEATURE_PREORDER_CHAT || request.url.endsWith('/availability');
    done(open ? undefined : notFound('Preorder chat'));
  });

  /**
   * Whether the team is here, and what this installation allows. Public: the
   * chat button shows it to a guest before they sign in, and it is only ever
   * true when somebody who can reply is actually connected.
   */
  app.get(
    '/availability',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    (_request, reply) => {
      const attachments = attachmentAvailability();
      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send({
          enabled: env.FEATURE_PREORDER_CHAT,
          teamAvailable: env.FEATURE_PREORDER_CHAT && app.preorderChat.gateway.teamAvailable(),
          typicalResponse:
            env.PREORDER_CHAT_TYPICAL_RESPONSE.length > 0
              ? env.PREORDER_CHAT_TYPICAL_RESPONSE
              : null,
          maxMessageChars: env.PREORDER_CHAT_MAX_MESSAGE_CHARS,
          attachments: {
            available: attachments.available,
            reason: attachments.available ? null : attachments.reason,
            maxBytes: env.PREORDER_CHAT_ATTACHMENT_MAX_BYTES,
            types: ATTACHMENT_TYPES,
          },
        });
    },
  );

  const socketAuth = new WeakMap<FastifyRequest, string>();
  /**
   * The live connection. A GET that upgrades to a WebSocket.
   *
   * Authenticated by the customer's session cookie exactly as a REST call is.
   * A failed check still upgrades, then says why and closes with 4401 or 4403 -
   * a browser cannot read the status of a refused upgrade, and "sign in again"
   * and "not allowed" need different answers.
   */
  app.get(
    '/socket',
    {
      websocket: true,
      preHandler: async (request, reply) => {
        if (!socketOriginAllowed(request)) {
          chatSocketFailuresTotal.inc({ reason: 'origin' });
          await reply.status(403).send({
            error: { code: ErrorCode.FORBIDDEN, message: 'Origin not allowed.', details: [] },
          });
          return;
        }
        try {
          await requireCustomer(request, reply);
        } catch (error) {
          socketAuth.set(request, isAppError(error) ? error.code : 'UNAUTHENTICATED');
        }
      },
    },
    (socket, request) => {
      const failure = socketAuth.get(request);
      if (failure !== undefined || request.auth === undefined || !env.FEATURE_PREORDER_CHAT) {
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
        kind: 'CUSTOMER',
        userId: auth.id,
        email: auth.email,
        sessionId: auth.sessionId,
        customerProfileId: auth.customerProfileId ?? '',
      });
    },
  );

  /**
   * What the chat drawer shows before anything is sent: the product card, as
   * the server reads it, and the conversation this customer already has about
   * it. Creates nothing - opening the drawer does not start a conversation.
   */
  app.post(
    '/context',
    { preHandler: requireCustomer, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = chatContextInputSchema.parse(request.body);
      return reply.status(200).send(await previewCustomerChat(actorOf(request), input));
    },
  );

  /**
   * The preorder assistant, before anybody writes anything. Public: a guest
   * can read the common answers without signing in. The questions offered, in
   * order, and what the greeting may say - the product's name as the server
   * reads it, and a signed-in customer's first name. Creates nothing.
   */
  app.post(
    '/assistant',
    { preHandler: optionalCustomer, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { context } = z.object({ context: chatContextInputSchema }).strict().parse(request.body);
      const built = await buildChatContext(context);
      const profileId = request.auth?.customerProfileId ?? null;
      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send({
          greeting: {
            firstName: await customerFirstName(profileId),
            productName: built.snapshot.product.name,
            variantName: built.snapshot.variant?.name ?? null,
          },
          questions: activeFaqEntries().map((entry) => ({
            id: entry.id,
            category: entry.category,
            questionKey: entry.questionTranslationKey,
            version: entry.version,
            requiresHumanConfirmation: entry.requiresHumanConfirmation,
          })),
          signedIn: profileId !== null,
        });
    },
  );

  /**
   * One automated answer, from the product's own preorder terms, verified
   * loading, stock and delivery window - never a guessed figure. Signed, so
   * the customer can carry it into a conversation if they ask for a person.
   */
  app.post(
    '/assistant/answer',
    { preHandler: optionalCustomer, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = z
        .object({ context: chatContextInputSchema, faqId: z.enum(FAQ_IDS) })
        .strict()
        .parse(request.body);
      const { built, facts } = await gatherFaqFacts(input.context, {
        customerProfileId: request.auth?.customerProfileId ?? null,
      });
      const answer = answerFaq(input.faqId, facts);
      if (answer === null) throw notFound('Question');
      const askedAt = new Date().toISOString();
      const token = signAnswer(
        { productId: built.keys.productId, variantId: built.keys.variantId },
        answer,
        askedAt,
      );
      return reply.header('cache-control', 'no-store').status(200).send({ answer, askedAt, token });
    },
  );

  /**
   * "Connect with a human agent." Creates the conversation about this product,
   * or reuses the live one, carries the answers the customer read into it and
   * puts it in the team's queue as a request for a person. Retrying with the
   * same `clientRequestId` returns what the first attempt stored.
   */
  app.post(
    '/handoff',
    { preHandler: requireCustomer, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const input = handoffSchema.parse(request.body);
      const outcome = await requestHumanHandoff(actorOf(request, input.locale), input);
      await publish(outcome.events);
      return reply.status(outcome.value.duplicate ? 200 : 201).send(outcome.value);
    },
  );

  /**
   * Send the first message about a product - which starts the conversation -
   * or the next one, if a live conversation about it already exists. A resolved
   * conversation reopens. Retrying with the same `clientMessageId` returns the
   * stored message instead of sending it twice.
   */
  app.post(
    '/messages',
    { preHandler: requireCustomer, config: { rateLimit: SEND_LIMIT } },
    async (request, reply) => {
      const input = customerStartSchema.parse(request.body);
      const outcome = await startOrContinueCustomerChat(actorOf(request, input.locale), input);
      await publish(outcome.events);
      return reply.status(outcome.value.duplicate ? 200 : 201).send(outcome.value);
    },
  );

  /** The customer's conversations, newest activity first. */
  app.get('/', { preHandler: requireCustomer }, async (request, reply) => {
    const query = z
      .object({
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(request.query);
    return reply.status(200).send(await listCustomerConversations(actorOf(request), query));
  });

  /**
   * How many replies are waiting to be read, across every conversation - or,
   * with a product id, across the conversations about that product only.
   */
  app.get('/unread', { preHandler: requireCustomer }, async (request, reply) => {
    const query = z.object({ productId: z.string().length(26).optional() }).parse(request.query ?? {});
    return reply
      .header('cache-control', 'no-store')
      .status(200)
      .send({ unreadCount: await customerUnreadTotal(actorOf(request), query.productId ?? null) });
  });

  /** One of the customer's own conversations. Another customer's answers 404. */
  app.get('/:id', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply
      .status(200)
      .send({ conversation: await getCustomerConversation(actorOf(request), id) });
  });

  /**
   * A page of history. `after` returns everything since a sequence number,
   * oldest first - how a page catches up after a dropped connection. `before`
   * loads earlier messages.
   */
  app.get('/:id/messages', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const query = historyQuerySchema.parse(request.query);
    return reply.status(200).send(await listCustomerMessages(actorOf(request), id, query));
  });

  /** Send a message in an existing conversation. */
  app.post(
    '/:id/messages',
    { preHandler: requireCustomer, config: { rateLimit: SEND_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const input = customerSendSchema.parse(request.body);
      const outcome = await continueCustomerChat(actorOf(request), id, input);
      await publish(outcome.events);
      return reply.status(outcome.value.duplicate ? 200 : 201).send(outcome.value);
    },
  );

  /** Mark the conversation read up to a sequence number. Never moves backwards. */
  app.post(
    '/:id/read',
    { preHandler: requireCustomer, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { seq } = readSchema.parse(request.body);
      const outcome = await markCustomerRead(actorOf(request), id, seq);
      await publish(outcome.events);
      return reply.status(200).send(outcome.value);
    },
  );

  /**
   * Attach a PDF or an image. The file is checked by its contents, scanned
   * for malware and stored privately; it is refused when attachments are
   * unavailable on this installation.
   */
  app.post(
    '/:id/attachments',
    { preHandler: requireCustomer, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
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
      const outcome = await uploadAttachment('CUSTOMER', actorOf(request), id, {
        bytes,
        fileName: upload.filename,
        clientMessageId: typeof clientMessageId === 'string' ? clientMessageId : '',
      });
      await publish(outcome.events);
      return reply.status(outcome.value.duplicate ? 200 : 201).send(outcome.value);
    },
  );

  /** A download link for one attachment: five minutes, single use, this session only. */
  app.post(
    '/:id/attachments/:attachmentId/link',
    { preHandler: requireCustomer, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id, attachmentId } = attachmentParams.parse(request.params);
      const link = await createAttachmentLink('CUSTOMER', actorOf(request), id, attachmentId);
      return reply.header('cache-control', 'no-store').status(200).send(link);
    },
  );

  /** Redeem a download link. Served as an attachment, never inline. */
  app.get(
    '/:id/attachments/:attachmentId/download',
    { preHandler: requireCustomer },
    async (request, reply) => {
      const { id, attachmentId } = attachmentParams.parse(request.params);
      const { token } = z.object({ token: z.string().min(1).max(256) }).parse(request.query);
      const file = await redeemAttachmentLink(
        'CUSTOMER',
        actorOf(request),
        id,
        attachmentId,
        token,
      );
      return sendAttachment(reply, file);
    },
  );

  /**
   * One proposal, with what the preorder form needs to open on it. The form
   * still checks eligibility and asks the customer to accept the preorder
   * terms; this only saves retyping the figures.
   */
  app.get('/:id/proposals/:proposalId', { preHandler: requireCustomer }, async (request, reply) => {
    const { id, proposalId } = proposalParams.parse(request.params);
    return reply.status(200).send(await getProposalForCustomer(actorOf(request), id, proposalId));
  });

  /** Decline a proposal, optionally saying why. Staff are told. */
  app.post(
    '/:id/proposals/:proposalId/decline',
    { preHandler: requireCustomer, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id, proposalId } = proposalParams.parse(request.params);
      const input = declineSchema.parse(request.body ?? {});
      const outcome = await declineProposal(actorOf(request), id, proposalId, input);
      await publish(outcome.events);
      return reply.status(200).send({ proposal: outcome.value });
    },
  );

  /**
   * Record that a preorder request was sent from this proposal. The request
   * must be the customer's own, for the same product and option, and made
   * after the proposal; the conversation is then linked to it. The request
   * itself goes through the ordinary preorder workflow unchanged.
   */
  app.post(
    '/:id/proposals/:proposalId/submitted',
    { preHandler: requireCustomer, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id, proposalId } = proposalParams.parse(request.params);
      const input = submittedSchema.parse(request.body);
      const outcome = await markProposalSubmitted(actorOf(request), id, proposalId, input);
      await publish(outcome.events);
      return reply.status(200).send({ proposal: outcome.value });
    },
  );

  return Promise.resolve();
}
