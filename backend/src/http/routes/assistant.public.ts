/**
 * Storefront assistant chat.
 *
 * **Anybody may ask; only a customer gets a history.** `/start` and `/chat`
 * answer a visitor with no account, on the same reasoning that puts the
 * sign-in wall at the cart rather than the front door: a buyer deciding
 * whether this catalogue has what they need should be able to ask before
 * opening an account. The four `/conversations` routes below stay behind
 * `requireCustomer`, because a history is a thing an account has.
 *
 * An operator who would rather pay only for their own customers sets
 * `ASSISTANT_ALLOW_GUESTS=false`, and the two open routes answer a guest with
 * a 401 again. Read the note on that setting before leaving it on: a rate
 * limit bounds what an anonymous caller can spend, it does not make it free.
 *
 * What a guest is *not* given, which is the part worth being precise about:
 *
 *   - **No access to anybody else's conversation.** A guest conversation is
 *     owned by an opaque token this server minted and only that browser holds.
 *     It cannot open a conversation that has an account behind it, and a
 *     customer cannot pick up a guest's by its id.
 *   - **No history, and no account to hang one on.** The token lives in
 *     `sessionStorage`, so it is forgotten when the tab closes. That is the
 *     honest lifetime for something nobody has claimed, and it means a shared
 *     machine does not offer the next person the last person's conversation.
 *   - **No larger allowance.** `ASSISTANT_GUEST_RATE_LIMIT_PER_5MIN` is lower
 *     than the signed-in one.
 *   - **Nothing the old capture form collected.** It asked for a name, a
 *     mobile number and an email before it would answer anything, verified
 *     none of them, and is gone. A visitor is anonymous, which is both cheaper
 *     and more truthful than an unchecked claim.
 *
 * When a customer *is* signed in, `optionalCustomer` puts them through the
 * whole check — expiry, revocation, surface, account status, CSRF — and a
 * failure is a failure rather than a quiet demotion to guest.
 *
 * What none of this changes:
 *
 *   - The endpoint is a **proxy, not a passthrough.** The request body cannot
 *     name a model, a system prompt, a token budget or any other API
 *     parameter. Everything except the message is decided here. This is the
 *     control that matters most now that the caller need not be identified: it
 *     is what stops the endpoint being driven as a general-purpose relay to
 *     somebody else's AI bill.
 *   - Rate limits, tighter than the global one, on every route.
 *   - Hard caps on turns and per-message length, enforced before a single
 *     token is bought.
 *   - **Ownership on every conversation**, whichever authority proves it.
 *
 * Nothing sensitive is logged. The conversation id, the model and the token
 * counts go to the log; the question, the reply and the customer's details do
 * not. A transcript belongs in the database, where the retention sweep can
 * reach it and an erasure request can delete it — a log file is neither.
 *
 * The reply streams back as Server-Sent Events. The alternative is a page that
 * sits blank for several seconds; the model's first token arrives long before
 * its last.
 */
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { allowedOrigins, env } from '../../config/env.js';
import { ErrorCode, badRequest, notFound, unauthorized } from '../../domain/errors.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import {
  AssistantBusyError,
  isAssistantConfigured,
  streamAssistantReply,
} from '../../modules/assistant/assistant.service.js';
import {
  appendMessage,
  authoriseConversation,
  conversationHistory,
  customerContext,
  customerConversation,
  hideCustomerConversation,
  listCustomerConversations,
  renameCustomerConversation,
  startConversation,
} from '../../modules/assistant/conversation.service.js';
import type { ConversationOwner } from '../../modules/assistant/conversation.service.js';
import { cookieNamesFor, currentUser, optionalCustomer, requireCustomer } from '../plugins/auth.js';

/**
 * The chat allowance for this caller, per IP per five minutes.
 *
 * The rate-limit hook runs before the route's guard, so `request.auth` is not
 * set yet and this has to decide from the request itself: does the browser
 * carry a customer access cookie at all?
 *
 * That is a heuristic and it is used for **sizing a bucket, nothing else** —
 * authorisation happens later and properly. Its worst case is somebody sending
 * a junk cookie of the right name to get the signed-in allowance instead of
 * the guest one, which buys them the difference between the two numbers and no
 * access to anything. Reading the raw header rather than `request.cookies`
 * keeps this independent of where the cookie plugin sits in the hook order.
 */
function chatAllowance(request: FastifyRequest): number {
  const cookie = request.headers.cookie ?? '';
  const looksSignedIn = cookie.includes(`${cookieNamesFor('CUSTOMER').access}=`);

  return looksSignedIn
    ? env.ASSISTANT_RATE_LIMIT_PER_5MIN
    : env.ASSISTANT_GUEST_RATE_LIMIT_PER_5MIN;
}

/**
 * Who this request is, as the conversation service understands ownership.
 *
 * One place, so the two routes that need it cannot disagree — and so the guest
 * branch is refused in exactly one place when the operator has switched guests
 * off.
 */
function ownerFor(request: FastifyRequest, conversationToken: string | undefined): ConversationOwner {
  const profileId = request.auth?.customerProfileId ?? null;
  if (profileId !== null) return { kind: 'customer', customerProfileId: profileId };

  if (!env.ASSISTANT_ALLOW_GUESTS) {
    throw unauthorized(ErrorCode.UNAUTHENTICATED, 'Sign in to use the assistant.');
  }

  if (conversationToken === undefined) {
    // A guest holding no token is not the owner of anything. Answered as a
    // 404 by the caller, not a 401: whether that conversation exists is not
    // something an anonymous caller gets to learn.
    throw notFound('Conversation');
  }

  return { kind: 'guest', sessionTokenHash: sha256Hex(conversationToken) };
}

/** Roughly 1,500 words. Long enough for a real question, short enough to bound cost. */
const MAX_MESSAGE_CHARS = 8_000;

/*
 * `.strict()` on every object, deliberately.
 *
 * Zod would otherwise strip an unexpected `model` or `system` field silently —
 * which is safe, since the handler never reads them, but it also means
 * somebody probing for a passthrough gets a 200 and no trace in the logs.
 * Rejecting the request says no out loud and leaves a 400 to notice.
 *
 * `/start` takes no fields at all any more, and the empty strict object is the
 * point rather than an oversight: a body carrying a name, a phone number or an
 * email is now a 400. The old client posted exactly those three, so a stale
 * bundle fails loudly instead of quietly recording details this system has
 * stopped collecting.
 */
const startBody = z.object({}).strict();

const chatBody = z
  .object({
    conversationId: z.string().length(26),
    message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
    /**
     * A guest's proof that this conversation is theirs.
     *
     * Absent for a signed-in customer, whose account is the proof and whose
     * token would be ignored if they sent one.
     *
     * The pattern is base64url — what `generateToken` produces — with a band
     * rather than an exact length, so changing its byte count does not have to
     * be changed here as well. This is a guard against obviously malformed
     * input, not a security control: it saves a SHA-256 and a database read on
     * a value that could not possibly match. What actually decides ownership is
     * the constant-time hash comparison in `authoriseConversation`.
     */
    conversationToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{32,86}$/)
      .optional(),
  })
  .strict();

const conversationParams = z.object({ id: z.string().length(26) }).strict();

/**
 * A rename.
 *
 * The empty string is accepted and means "clear it", which is not the same as
 * omitting the field — a customer who renames a thread and then wipes the box
 * is asking to go back to the opening-question fallback, and there has to be a
 * way to say that. 120 characters matches the column.
 */
const renameBody = z.object({ title: z.string().trim().max(120) }).strict();

/**
 * The CORS headers for a hijacked response.
 *
 * `reply.hijack()` hands us the raw socket and, with it, responsibility for
 * every header — Fastify's `onSend` hooks never run, and `@fastify/cors`
 * writes its headers in exactly those hooks. So the preflight succeeds (that
 * is a normal OPTIONS reply, hooks and all) and then the browser drops the
 * streamed response for having no `access-control-allow-origin`, which the
 * widget can only report as a dropped connection. Nothing shows up in a curl
 * test, because curl does not enforce CORS.
 *
 * The origin is matched against the same allowlist the plugin uses and echoed
 * only on an exact hit — never reflected back unchecked.
 *
 * `allow-credentials` is set here, and now has to be: the panel authenticates
 * by cookie, and a credentialed request whose response omits that header is
 * dropped by the browser even when the origin matches. It is safe for the same
 * reason the cookie flow is safe everywhere else in this API — the origin was
 * matched against a fixed allowlist, never reflected.
 */
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined || !allowedOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
}

export function registerAssistantRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Open a conversation.
   *
   * Takes nothing and asks nothing — of anybody. A customer is already known
   * from their session; a guest is nobody, and this endpoint is at peace with
   * that. Either way it is one row and an id, and the page goes straight to a
   * composer.
   *
   * A guest also gets back a **conversation token**: the only proof they will
   * ever have that the thread is theirs. It is returned exactly once, here,
   * and only its SHA-256 is stored — so a database read cannot resume somebody
   * else's conversation, and neither can a leaked backup.
   *
   * Rate limited so that a script cannot fill the table with empty
   * conversations. The allowance is generous enough for a procurement office
   * behind a single NAT address, where a dozen people share an IP.
   */
  app.post(
    '/start',
    {
      preHandler: optionalCustomer,
      config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      if (!isAssistantConfigured()) throw notFound('Assistant');

      startBody.parse(request.body ?? {});

      const customerProfileId = request.auth?.customerProfileId ?? null;

      if (customerProfileId === null && !env.ASSISTANT_ALLOW_GUESTS) {
        throw unauthorized(ErrorCode.UNAUTHENTICATED, 'Sign in to use the assistant.');
      }

      /*
       * The token is minted here and never again. `generateToken` returns the
       * secret and its hash together; the secret goes to the browser in this
       * one response and the hash goes in the row.
       */
      const guestToken = customerProfileId === null ? generateToken(32) : null;

      const started = await startConversation(
        customerProfileId === null
          ? { kind: 'guest', sessionTokenHash: (guestToken as { tokenHash: string }).tokenHash }
          : { kind: 'customer', customerProfileId },
        {
          ipAddress: request.ip,
          // Truncated to the column width. A browser that sends a 2KB UA
          // string must not fail the insert.
          userAgent: (request.headers['user-agent'] ?? '').slice(0, 512) || null,
        },
      );

      // The id and whether it was a guest, and nothing else. No name, no
      // address, no message text, and above all not the token — this line
      // exists to tie a support question to a transcript, and a log is the
      // wrong home for personal data and a catastrophic home for a secret.
      request.log.info(
        { conversationId: started.conversationId, guest: customerProfileId === null },
        'assistant conversation started',
      );

      return reply.status(201).send({
        ...started,
        ...(guestToken === null ? {} : { conversationToken: guestToken.token }),
      });
    },
  );

  /*
   * The customer's own history: list, read, rename, delete.
   *
   * Four routes, one guarantee, and it is worth stating once rather than in
   * each of them: every service call below takes `customerProfileId` from the
   * session guard and puts it in the `where`. There is no parameter a browser
   * can send that widens the query, so one customer's AI Mode sidebar cannot
   * reach another's — and a conversation id belonging to somebody else answers
   * 404 rather than 403, so an id says nothing about whose it is.
   *
   * `isAssistantConfigured()` is checked on all four. On a deployment with no
   * key the assistant does not meaningfully exist, and a history endpoint that
   * answered 200 with an empty list would tell the storefront to render a
   * sidebar for a page it must not offer.
   */
  app.get('/conversations', { preHandler: requireCustomer }, async (request, reply) => {
    if (!isAssistantConfigured()) throw notFound('Assistant');

    const { customerProfileId } = currentUser(request);
    if (customerProfileId === null) throw notFound('Assistant');

    const conversations = await listCustomerConversations(customerProfileId);
    return reply.status(200).send({ conversations });
  });

  app.get('/conversations/:id', { preHandler: requireCustomer }, async (request, reply) => {
    if (!isAssistantConfigured()) throw notFound('Assistant');

    const { id } = conversationParams.parse(request.params);
    const { customerProfileId } = currentUser(request);
    if (customerProfileId === null) throw notFound('Assistant');

    const conversation = await customerConversation(id, customerProfileId);
    if (conversation === null) throw notFound('Conversation');

    return reply.status(200).send({ conversation });
  });

  app.patch('/conversations/:id', { preHandler: requireCustomer }, async (request, reply) => {
    if (!isAssistantConfigured()) throw notFound('Assistant');

    const { id } = conversationParams.parse(request.params);
    const body = renameBody.parse(request.body);
    const { customerProfileId } = currentUser(request);
    if (customerProfileId === null) throw notFound('Assistant');

    // Empty means "use the opening question again", which is a null column
    // rather than a row whose title is the empty string.
    const renamed = await renameCustomerConversation(
      id,
      customerProfileId,
      body.title.length === 0 ? null : body.title,
    );
    if (!renamed) throw notFound('Conversation');

    return reply.status(204).send();
  });

  /**
   * Delete a thread from the customer's own history.
   *
   * Soft — see the `hiddenAt` comment on the model. From here it is total: the
   * thread leaves the list, leaves every customer read, and cannot be
   * continued. What it does not do is destroy the record of what this
   * deployment's AI said about a medical device, which staff can still read and
   * the retention sweep still clears on its own schedule. A customer asking for
   * that record to be destroyed is exercising Art. 17, and erasure has its own
   * route.
   */
  app.delete('/conversations/:id', { preHandler: requireCustomer }, async (request, reply) => {
    if (!isAssistantConfigured()) throw notFound('Assistant');

    const { id } = conversationParams.parse(request.params);
    const { customerProfileId } = currentUser(request);
    if (customerProfileId === null) throw notFound('Assistant');

    const hidden = await hideCustomerConversation(id, customerProfileId);
    if (!hidden) throw notFound('Conversation');

    request.log.info({ conversationId: id }, 'assistant conversation hidden by its owner');

    return reply.status(204).send();
  });

  app.post(
    '/chat',
    {
      preHandler: optionalCustomer,
      config: {
        rateLimit: {
          // Guests get the smaller allowance. See `chatAllowance` for why this
          // is decided from the raw cookie header and what that does and does
          // not guarantee.
          max: chatAllowance,
          timeWindow: '5 minutes',
        },
      },
    },
    async (request, reply) => {
      // 404, not 403: on a deployment with no key this endpoint does not
      // meaningfully exist, and saying so is how the storefront learns not to
      // offer AI Mode at all.
      if (!isAssistantConfigured()) throw notFound('Assistant');

      const body = chatBody.parse(request.body);

      const customerProfileId = request.auth?.customerProfileId ?? null;
      const owner = ownerFor(request, body.conversationToken);

      // 404 for a conversation that does not exist, one belonging to somebody
      // else, and one whose token does not match — so an id tells a caller
      // nothing about whose it is. The page reads it as "start again", which is
      // the right recovery for a browser holding an id the retention sweep has
      // since taken, or a guest token from a tab that has been closed.
      const conversation = await authoriseConversation(body.conversationId, owner);
      if (conversation === null) throw notFound('Conversation');

      // One turn is a question and an answer, so the message ceiling is twice
      // the turn cap. Checked before anything is bought.
      if (conversation.messageCount >= env.ASSISTANT_MAX_TURNS * 2) {
        throw badRequest(
          ErrorCode.VALIDATION_FAILED,
          'This conversation has reached its length limit. Start a new one.',
          [{ field: 'message', code: 'CONVERSATION_TOO_LONG' }],
        );
      }

      const [history, customer] = await Promise.all([
        conversationHistory(conversation.id),
        /*
         * What the account already says about them. Read here, under the
         * session that just authenticated, and never taken from the body: this
         * is the whole of the personalisation, and it is why nobody is asked
         * for anything.
         *
         * Null for a guest, and the prompt simply carries no customer block —
         * which is the correct degradation rather than a missing feature. A
         * visitor with no account has no name, organisation or account number
         * for this to be right about, and inventing a place to type one is the
         * capture form all over again.
         */
        customerProfileId === null ? null : customerContext(customerProfileId),
      ]);

      // Recorded before the provider is called, so a question survives a
      // failed or abandoned answer. The question is the part that tells staff
      // what was being asked for.
      await appendMessage(conversation.id, 'VISITOR', body.message);

      const log = request.log;

      // From here the handler owns the socket. Without `hijack()` Fastify
      // would also try to serialise and send a reply, on top of the SSE frames
      // written below. Everything above this line still goes through the
      // normal error handler, which is why the guard, the ownership check and
      // the caps all come first: a 401 has to arrive as a 401 the client can
      // act on, not as an error frame buried in a 200 stream.
      reply.hijack();

      // Headers before the first token. `x-accel-buffering: no` is for nginx,
      // which otherwise buffers the whole response and delivers the "stream"
      // in one lump at the end — the exact thing streaming exists to avoid.
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...corsHeaders(request.headers.origin),
      });

      const send = (event: string, data: unknown): void => {
        if (reply.raw.writableEnded) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Closing the panel must stop the generation we are paying for, not
      // leave it running to completion into a dead socket.
      const abort = new AbortController();
      reply.raw.on('close', () => {
        abort.abort();
      });

      // Accumulated as it streams, so the answer can be recorded even when
      // they walk away part-way through: half an answer is what they saw, and
      // the transcript should say the same thing.
      let answer = '';

      try {
        const result = await streamAssistantReply(
          [...history, { role: 'user', content: body.message }],
          {
            onText: (delta) => {
              answer += delta;
              send('delta', { text: delta });
            },
          },
          { customer, signal: abort.signal },
        );

        // A refusal is a legitimate outcome, not an error: the model declined
        // and the panel should say so rather than showing a broken state.
        if (result.refused) {
          send('error', {
            message: 'I cannot help with that one. Please contact our support team instead.',
          });
        }

        send('done', { finishReason: result.finishReason });

        // Counts and identifiers only. Not the question, not the answer, and
        // nothing about who asked beyond a conversation id.
        log.info(
          {
            conversationId: conversation.id,
            model: result.model,
            turns: history.length + 1,
            inputTokens: result.inputTokens,
            cachedInputTokens: result.cachedInputTokens,
            outputTokens: result.outputTokens,
            // Non-zero on a grounded answer means the model is reasoning when
            // it has nothing to reason about — pure cost. Worth watching.
            thinkingTokens: result.thinkingTokens,
            finishReason: result.finishReason,
          },
          'assistant reply',
        );
      } catch (error) {
        if (abort.signal.aborted) {
          // They left. Nothing to report and nobody to report it to.
          log.debug('assistant stream abandoned by the client');
        } else {
          // The provider's own message is not shown to a customer — it names
          // quota metrics and internal detail — but it is logged in full,
          // because "out of quota" and "briefly overloaded" need different
          // actions from whoever runs this deployment.
          log.error({ err: error }, 'assistant request failed');

          const busy = error instanceof AssistantBusyError;

          send('error', {
            message: busy
              ? 'The assistant is busy right now. Please try again in a moment.'
              : 'The assistant is unavailable right now. Please try again, or contact support.',
          });
        }
      } finally {
        if (!reply.raw.writableEnded) reply.raw.end();

        // Outside the try: the transcript is written whether the answer
        // finished, failed or was cut off. A write failure here must not take
        // the socket down with it — they already have their answer.
        if (answer.trim().length > 0) {
          try {
            await appendMessage(conversation.id, 'ASSISTANT', answer);
          } catch (error) {
            log.error({ err: error }, 'could not record the assistant reply');
          }
        }
      }
    },
  );

  return Promise.resolve();
}
