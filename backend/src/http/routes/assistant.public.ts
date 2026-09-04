/**
 * Storefront assistant chat.
 *
 * Unauthenticated by design: the widget is for visitors who have not signed
 * in — that is most of the traffic on a catalogue. What stands in for auth:
 *
 *   - The endpoint is a **proxy, not a passthrough.** The request body cannot
 *     name a model, a system prompt, a token budget or any other API
 *     parameter. Everything except the visitor's message is decided here.
 *     Without that, a public endpoint holding an API key is an open relay:
 *     somebody points a script at it and bills your account for their own
 *     workload.
 *   - A per-IP rate limit, tighter than the global one.
 *   - Hard caps on turns and per-message length, enforced before a single
 *     token is bought.
 *   - **The visitor identifies themselves first.** `POST /start` takes a name,
 *     a mobile number and an email address and returns a conversation id and
 *     an opaque token; `/chat` will not answer without them. That is a lead
 *     capture rather than an authentication — nothing is verified — but it
 *     also means one visitor cannot read or extend another's conversation.
 *
 * The transcript lives in the database, not in the request body. The client
 * used to post the whole history back on every turn; now it posts one message
 * and the server replays what it recorded. Two reasons: what an administrator
 * reads is then what the model was actually sent, and a browser cannot inflate
 * a request by claiming a conversation it did not have.
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
  authenticateConversation,
  conversationHistory,
  startConversation,
} from '../../modules/assistant/conversation.service.js';

/** Roughly 1,500 words. Long enough for a real question, short enough to bound cost. */
const MAX_MESSAGE_CHARS = 8_000;

/*
 * Mobile numbers arrive as people write them: +91 98765 43210,
 * (022) 4567-8900, 09876543210.
 *
 * The check is deliberately loose about punctuation and strict about content —
 * between 7 and 15 digits, which is the E.164 range — because this store sells
 * across borders and a pattern built around one country's numbering plan
 * rejects a real customer. It is a sanity check on a self-declared number, not
 * a verification: nothing here proves the line exists.
 */
const phoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(32)
  // A leading "(" is allowed as well as "+" and a digit: an area code in
  // brackets is how a landline is written in half the world.
  .regex(/^[+(0-9][0-9\s()./-]*$/, 'Enter a phone number using digits.')
  .refine(
    (value) => {
      const digits = value.replace(/\D/g, '').length;
      return digits >= 7 && digits <= 15;
    },
    { message: 'Enter a mobile number with 7 to 15 digits.' },
  );

/*
 * `.strict()` on every object, deliberately.
 *
 * Zod would otherwise strip an unexpected `model` or `system` field silently —
 * which is safe, since the handler never reads them, but it also means
 * somebody probing for a passthrough gets a 200 and no trace in the logs.
 * Rejecting the request says no out loud and leaves a 400 to notice.
 */
const startBody = z
  .object({
    name: z.string().trim().min(2, 'Enter your name.').max(120),
    phone: phoneSchema,
    email: z.string().trim().min(3).max(320).email('Enter a valid email address.'),
  })
  .strict();

const chatBody = z
  .object({
    conversationId: z.string().length(26),
    /** Returned by `/start`. base64url of 24 random bytes. */
    token: z.string().min(16).max(128),
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
 * only on an exact hit — never reflected back unchecked. No
 * `allow-credentials`: the widget sends no cookies, and this endpoint must not
 * start accepting them by accident.
 */
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined || !allowedOrigins.includes(origin)) return {};
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

export function registerAssistantRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Open a conversation.
   *
   * Rate limited harder than the chat itself: a visitor starts one
   * conversation and then asks several questions, so anything beyond a handful
   * of these from one address is a script filling the enquiry table rather
   * than a buyer with questions.
   */
  app.post(
    '/start',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      if (!isAssistantConfigured()) throw notFound('Assistant');

      const visitor = startBody.parse(request.body);

      const started = await startConversation(visitor, {
        ipAddress: request.ip,
        // Truncated to the column width. A browser that sends a 2KB UA string
        // must not fail the insert on a lead we would otherwise have kept.
        userAgent: (request.headers['user-agent'] ?? '').slice(0, 512) || null,
      });

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

      // 404 for both a wrong id and a wrong token, so probing tells an
      // attacker nothing about which conversations exist. The widget treats it
      // as "start again", which is the right recovery for a visitor whose
      // stored conversation was cleared server-side.
      const conversation = await authenticateConversation(body.conversationId, body.token);
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

      // Recorded before the provider is called, so a question survives a
      // failed or abandoned answer. The question is the part that tells staff
      // what the enquiry was about.
      const history = await conversationHistory(conversation.id);
      await appendMessage(conversation.id, 'VISITOR', body.message);

      const log = request.log;

      // From here the handler owns the socket. Without `hijack()` Fastify
      // would also try to serialise and send a reply, on top of the SSE frames
      // written below. Every validation failure above this line still goes
      // through the normal error handler, which is why the caps come first.
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

      // The visitor closing the panel must stop the generation we are paying
      // for, not leave it running to completion into a dead socket.
      const abort = new AbortController();
      reply.raw.on('close', () => {
        abort.abort();
      });

      // Accumulated as it streams so the answer can be recorded even when the
      // visitor walks away part-way through: half an answer is what they saw,
      // and the transcript should say the same thing.
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
          abort.signal,
        );

        // A refusal is a legitimate outcome, not an error: the model declined
        // and the panel should say so rather than showing a broken state.
        if (result.refused) {
          send('error', {
            message: 'I cannot help with that one. Please contact our support team instead.',
          });
        }

        send('done', { finishReason: result.finishReason });

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
          // The visitor left. Nothing to report and nobody to report it to.
          log.debug('assistant stream abandoned by the client');
        } else {
          // The provider's own message is not shown to a visitor — it names
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
        // the socket down with it — the visitor already has their answer.
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
