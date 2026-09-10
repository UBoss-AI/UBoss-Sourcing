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
import { AssistantBusyError } from './provider.js';
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

function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
  return client;
}

export const anthropicProvider: AssistantProvider = {
  name: 'anthropic',
  model: env.ANTHROPIC_MODEL,

  async stream(request: AssistantRequest): Promise<AssistantResult> {
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
      request.signal === undefined ? undefined : { signal: request.signal },
    );

    stream.on('text', request.onText);

    let message;
    try {
      message = await stream.finalMessage();
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new AssistantBusyError(error.message, false);
      }
      throw error;
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
        request.signal === undefined ? undefined : { signal: request.signal },
      );
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new AssistantBusyError(error.message, false);
      }
      throw error;
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
