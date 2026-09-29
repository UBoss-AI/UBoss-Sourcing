/**
 * Claude, through the official `@anthropic-ai/sdk`.
 *
 * Kept alongside the Gemini provider rather than deleted: which provider a
 * deployment uses is a deployment decision, and switching is one environment
 * variable. Two differences from the Gemini path worth knowing:
 *
 *   - **The prompt cache is explicit and cheap.** `cache_control` on the
 *     catalogue block means every visitor after the first in a five-minute
 *     window reads it at about a tenth of the price. Gemini has no equivalent
 *     knob on this call.
 *   - **Aborting actually cancels.** The signal reaches Anthropic and stops
 *     the generation, so a visitor closing the panel stops the spend. On
 *     Gemini the abort is client-side only.
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import { AssistantBusyError, AssistantProviderError, classifyTransportFailure } from './provider.js';
import type {
  AssistantProvider,
  AssistantRequest,
  AssistantResult,
  AssistantVisionRequest,
  AssistantVisionResult,
} from './provider.js';

/** The four types `sniffImageType` can produce, which is what Claude accepts. */
type ClaudeImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

let client: Anthropic | null = null;

/**
 * Map an SDK error onto the reasons the route words for a visitor.
 *
 * Keyed on the SDK's own error classes. The timeout and connection classes
 * come before the generic transport check because the SDK raises its own
 * rather than letting fetch's through.
 */
export function classifyAnthropic(error: unknown): AssistantProviderError | null {
  if (error instanceof Anthropic.RateLimitError) return new AssistantBusyError(error.message, false, 429);
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AssistantProviderError(error.message, 'credentials', error.status);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new AssistantProviderError(error.message, 'model', 404);
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AssistantProviderError(error.message, 'timeout');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AssistantProviderError(error.message, 'network');
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new AssistantBusyError(error.message, false, error.status);
  }
  return classifyTransportFailure(error);
}

function anthropic(): Anthropic {
  // Thirty seconds, the same deadline as the Gemini path: a visitor is
  // watching an empty panel, and the SDK default is ten minutes.
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 30_000 });
  return client;
}

/**
 * The whole exchange, body included: two attempts of the SDK's thirty seconds.
 *
 * The SDK's `timeout` is armed around `fetch` itself and cleared the moment
 * the response headers arrive. Everything after that - every streamed token,
 * or the JSON body of a `create` - is outside it, so a connection that sends
 * its headers and then goes quiet would hold the visitor's panel open until
 * the socket's own idle limit, minutes later. Gemini's per-attempt timeout
 * stays armed through the body; this is what gives the Anthropic path the same
 * property.
 */
export const ANTHROPIC_EXCHANGE_DEADLINE_MS = 60_000;

/**
 * One exchange's abort signal: the caller's, plus our deadline.
 *
 * A timer and a controller rather than `AbortSignal.timeout` so that it can be
 * cleared the moment the answer is in, and so `expired()` can tell "we gave up
 * waiting" from "the visitor closed the panel". The route reads its own signal
 * for the second; the first has to become a `timeout` failure here, or it
 * would reach the route as the SDK's generic "Request was aborted."
 */
function exchangeDeadline(callerSignal: AbortSignal | undefined): {
  signal: AbortSignal;
  expired: () => boolean;
  clear: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ANTHROPIC_EXCHANGE_DEADLINE_MS);

  const forward = (): void => {
    controller.abort();
  };

  if (callerSignal?.aborted === true) controller.abort();
  else callerSignal?.addEventListener('abort', forward, { once: true });

  return {
    signal: controller.signal,
    expired: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forward);
    },
  };
}

/** What the deadline firing becomes: the same `timeout` the SDK's own raises. */
function deadlineExceeded(): AssistantProviderError {
  return new AssistantProviderError(
    `Anthropic did not finish within ${String(ANTHROPIC_EXCHANGE_DEADLINE_MS / 1000)} seconds.`,
    'timeout',
  );
}

export const anthropicProvider: AssistantProvider = {
  name: 'anthropic',
  model: env.ANTHROPIC_MODEL,

  async stream(request: AssistantRequest): Promise<AssistantResult> {
    const deadline = exchangeDeadline(request.signal);

    const stream = anthropic().messages.stream(
      {
        model: env.ANTHROPIC_MODEL,
        max_tokens: request.maxTokens,
        system: [
          { type: 'text', text: request.systemPrompt },
          {
            type: 'text',
            text: `CATALOGUE — the complete published product list for this store.\n\n${request.catalogue}`,
            // The whole prefix above this point is byte-identical for every
            // customer, which is what makes the cache hit rate a function of
            // traffic and nothing else.
            cache_control: { type: 'ephemeral' },
          },
          // Below the cache breakpoint on purpose: this block is the one part
          // that differs per caller, and putting it any earlier would cost the
          // deployment its prefix cache on every single request.
          ...(request.customer === undefined
            ? []
            : [{ type: 'text' as const, text: request.customer }]),
        ],
        // Storefront Q&A over a catalogue that is handed to the model does not
        // repay deep reasoning.
        output_config: { effort: 'low' },
        messages: request.turns.map((turn) => ({ role: turn.role, content: turn.content })),
      },
      { signal: deadline.signal },
    );

    stream.on('text', request.onText);

    let message;
    try {
      message = await stream.finalMessage();
    } catch (error) {
      if (deadline.expired()) throw deadlineExceeded();
      throw classifyAnthropic(error) ?? error;
    } finally {
      deadline.clear();
    }

    return {
      inputTokens: message.usage.input_tokens,
      cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
      outputTokens: message.usage.output_tokens,
      // Claude bills thinking inside output tokens rather than reporting it
      // separately, so there is nothing honest to put here.
      thinkingTokens: 0,
      finishReason: message.stop_reason,
      refused: message.stop_reason === 'refusal',
      model: env.ANTHROPIC_MODEL,
    };
  },

  /**
   * One image, one answer, no stream.
   *
   * `messages.create` rather than `messages.stream`: the reply is JSON that a
   * parser reads in one piece, and nobody is watching it arrive token by token
   * — the customer is watching a spinner over their own photograph.
   *
   * The catalogue index goes in the system block with `cache_control`, exactly
   * as it does on the chat path and for the same reason: it is byte-identical
   * for every caller on the deployment, and it is by far the largest part of
   * the prompt. The image is the only per-request bytes and it comes after.
   */
  async describeImage(request: AssistantVisionRequest): Promise<AssistantVisionResult> {
    const deadline = exchangeDeadline(request.signal);
    let message;

    try {
      message = await anthropic().messages.create(
        {
          model: env.ANTHROPIC_MODEL,
          max_tokens: request.maxTokens,
          system: [
            { type: 'text', text: request.systemPrompt },
            {
              type: 'text',
              text: request.catalogue,
              cache_control: { type: 'ephemeral' },
            },
          ],
          output_config: { effort: 'low' },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: request.image.mimeType as ClaudeImageType,
                    data: request.image.data.toString('base64'),
                  },
                },
                { type: 'text', text: request.prompt },
              ],
            },
          ],
        },
        { signal: deadline.signal },
      );
    } catch (error) {
      if (deadline.expired()) throw deadlineExceeded();
      throw classifyAnthropic(error) ?? error;
    } finally {
      deadline.clear();
    }

    // Only the text blocks. A reply carrying anything else is not something
    // this caller can parse, and concatenating the text is the whole of it.
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      model: env.ANTHROPIC_MODEL,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  },
};
