/**
 * Storefront assistant chat. Signed-in customers only.
 *
 * This endpoint used to be unauthenticated, with a lead-capture form standing
 * in for a sign-in: a visitor typed a name, a mobile number and an email, and
 * that was the whole of "who is asking". Nothing about it was verified, and it
 * bought the deployment friction rather than safety. It is gone. Every route
 * here now runs behind `requireCustomer`, which is where the guarantees come
 * from:
 *
 *   - **A valid access token, for THIS surface.** An expired or tampered token
 *     is a 401; an admin token presented here is a 403, checked against both
 *     the claim and the database row.
 *   - **A live session.** Logout, a password change and a deactivation revoke
 *     it server-side and take effect on the very next request rather than at
 *     the next token expiry — so a signed-out browser cannot keep chatting on
 *     a token it still holds.
 *   - **An active, activated account.** A deactivated user is a 401; a
 *     customer with no profile is a 403. Neither can buy a provider call.
 *   - **CSRF.** These are cookie-authenticated POSTs, so the double-submit
 *     check applies here like it does everywhere else.
 *
 * What the sign-in does not replace, and which therefore stays:
 *
 *   - The endpoint is a **proxy, not a passthrough.** The request body cannot
 *     name a model, a system prompt, a token budget or any other API
 *     parameter. Everything except the message is decided here. Authentication
 *     bounds who may spend the deployment's provider budget; it does not stop
 *     one signed-in account from driving the endpoint as a general-purpose
 *     relay, and only the fixed parameters do that.
 *   - Rate limits, tighter than the global one, on both routes.
 *   - Hard caps on turns and per-message length, enforced before a single
 *     token is bought.
 *   - **Ownership on every conversation.** The id in the body is checked
 *     against the caller's own profile, so one customer cannot read or extend
 *     another's conversation.
 *
 * Nothing sensitive is logged. The conversation id, the model and the token
 * counts go to the log; the question, the reply and the customer's details do
 * not. A transcript belongs in the database, where the retention sweep can
 * reach it and an erasure request can delete it — a log file is neither.
 *
 * The reply streams back as Server-Sent Events. The alternative is a panel
 * that sits blank for several seconds; the model's first token arrives long
 * before its last.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { allowedOrigins, env } from '../../config/env.js';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
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
  startConversation,
} from '../../modules/assistant/conversation.service.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';

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
  })
  .strict();

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
   * Takes nothing and asks nothing. The customer is already known, so this is
   * one row and an id — the panel calls it the moment it opens and goes
   * straight to the composer.
   *
   * Still rate limited. Not against lead spam, which is no longer a thing that
   * can happen here, but because a script holding one valid session should not
   * be able to fill the table with empty conversations. The allowance is
   * generous enough for a procurement office behind a single NAT address,
   * where a dozen people share an IP and each of them opens the panel.
   */
  app.post(
    '/start',
    {
      preHandler: requireCustomer,
      config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      if (!isAssistantConfigured()) throw notFound('Assistant');

      startBody.parse(request.body ?? {});

      // Non-null by the guard: `requireCustomer` refuses a customer with no
      // profile before this handler runs. Narrowed rather than asserted, so a
      // future change to that guard fails the typecheck instead of the request.
      const { customerProfileId } = currentUser(request);
      if (customerProfileId === null) throw notFound('Assistant');

      const started = await startConversation(
        { customerProfileId },
        {
          ipAddress: request.ip,
          // Truncated to the column width. A browser that sends a 2KB UA
          // string must not fail the insert.
          userAgent: (request.headers['user-agent'] ?? '').slice(0, 512) || null,
        },
      );

      // The id and nothing else. No name, no address, no message text: this
      // line exists to tie a support question to a transcript, and a log is
      // the wrong home for personal data.
      request.log.info(
        { conversationId: started.conversationId },
        'assistant conversation started',
      );

      return reply.status(201).send(started);
    },
  );

  app.post(
    '/chat',
    {
      preHandler: requireCustomer,
      config: {
        rateLimit: {
          max: env.ASSISTANT_RATE_LIMIT_PER_5MIN,
          timeWindow: '5 minutes',
        },
      },
    },
    async (request, reply) => {
      // 404, not 403: on a deployment with no key this endpoint does not
      // meaningfully exist, and saying so is how the storefront learns not to
      // show the widget.
      if (!isAssistantConfigured()) throw notFound('Assistant');

      const body = chatBody.parse(request.body);

      const { customerProfileId } = currentUser(request);
      if (customerProfileId === null) throw notFound('Assistant');

      // 404 for both a conversation that does not exist and one belonging to
      // somebody else, so an id tells a caller nothing about whose it is. The
      // widget reads it as "start again", which is the right recovery for a
      // browser holding an id the retention sweep has since taken.
      const conversation = await authoriseConversation(body.conversationId, customerProfileId);
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
        // What the account already says about them. Read here, under the
        // session that just authenticated, and never taken from the body: this
        // is the whole of the personalisation, and it is why the panel no
        // longer has to ask anybody for anything.
        customerContext(customerProfileId),
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
