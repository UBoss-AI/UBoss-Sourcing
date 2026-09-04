/**
 * Gemini, through Google's official `@google/genai` SDK.
 *
 * Three things about this provider that are not obvious and were verified
 * against the live API rather than assumed:
 *
 *   1. **Thinking is on by default and it is expensive here.** A three-word
 *      reply from `gemini-2.5-flash` burned 1,133 reasoning tokens in
 *      testing. This assistant answers from a catalogue that is handed to it —
 *      there is nothing to reason about — so `thinkingBudget: 0` turns it off.
 *      That is a token-for-token saving with no effect on answer quality for
 *      this workload, and it is the single biggest cost lever on this provider.
 *
 *   2. **`abortSignal` is client-side only.** The SDK's own documentation is
 *      explicit: aborting stops us reading, it does not stop Google
 *      generating, and the tokens are still billed. That is a real difference
 *      from the Anthropic path, where the cancel reaches the server. A visitor
 *      closing the panel therefore saves latency here, not money.
 *
 *   3. **There is no prompt-cache control to set.** Gemini caches repeated
 *      prefixes implicitly on 2.5-era models and reports what it reused as
 *      `cachedContentTokenCount`. The explicit `cachedContents` API exists but
 *      needs a cache object created, given a TTL and refreshed — worth it only
 *      once traffic makes the implicit hit rate visibly insufficient. The
 *      catalogue is still placed first in the prompt so an implicit hit is
 *      possible at all.
 */
import { ApiError, GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';
import { AssistantBusyError } from './provider.js';
import type { AssistantProvider, AssistantRequest, AssistantResult } from './provider.js';

/** Built once per process: the client is a thin HTTP wrapper and is reusable. */
let client: GoogleGenAI | null = null;

function genai(): GoogleGenAI {
  client ??= new GoogleGenAI({
    apiKey: env.GEMINI_API_KEY,
    httpOptions: {
      // A visitor is watching an empty panel. Thirty seconds is already
      // longer than anyone waits; hanging on a stalled socket past that is
      // worse than failing and offering a retry.
      timeout: 30_000,
      retryOptions: {
        // Three attempts, quickly. A connect timeout to Google — which
        // happened during testing — should not cost the visitor their answer.
        attempts: 3,
        initialDelay: 0.5,
        maxDelay: 2,
        // Deliberately NOT 429, which the SDK would retry by default.
        // Google's 429 here carries "retry in 29.7s": a quota is not going to
        // clear inside a backoff window, and retrying would hold the panel
        // open for up to a minute before failing anyway. Better to surface
        // "busy, try again" immediately — see classify() below.
        httpStatusCodes: [408, 500, 502, 503, 504],
      },
    },
  });
  return client;
}

/**
 * Map a Google error onto something the route can act on.
 *
 * Keyed on the SDK's own `ApiError.status` rather than on message text, with
 * a message check only as a fallback for errors the SDK has wrapped rather
 * than thrown as `ApiError`.
 *
 * 429 here is not only "slow down": on the free tier it is a hard per-minute
 * quota that will not clear inside a retry window, so `isQuota` separates it
 * from transient overload for the operator's log.
 *
 * Note what this does NOT catch: a DNS or connect failure arrives as a plain
 * `TypeError: fetch failed` with no status, so it falls through to the generic
 * error path. That is deliberate — it is an infrastructure problem on the
 * caller's side, and telling a visitor the assistant is "busy" would point
 * whoever reads the log in the wrong direction.
 */
function classify(error: unknown): AssistantBusyError | null {
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 429 || message.includes('RESOURCE_EXHAUSTED')) {
    return new AssistantBusyError(
      message,
      message.includes('free_tier') || message.includes('quota'),
    );
  }

  if (status === 503 || status === 500 || message.includes('UNAVAILABLE')) {
    return new AssistantBusyError(message, false);
  }

  return null;
}

export const geminiProvider: AssistantProvider = {
  name: 'gemini',
  model: env.GEMINI_MODEL,

  async stream(request: AssistantRequest): Promise<AssistantResult> {
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
    let finishReason: string | null = null;

    try {
      const stream = await genai().models.generateContentStream({
        model: env.GEMINI_MODEL,
        // Gemini calls the assistant role "model". Everything else about the
        // turn list is the same shape.
        contents: request.turns.map((turn) => ({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: turn.content }],
        })),
        config: {
          // Catalogue first, then behaviour: the catalogue is the larger and
          // more stable half, and a prefix cache can only help if the stable
          // part comes first.
          systemInstruction: {
            parts: [
              { text: `CATALOGUE — the complete published product list for this store.\n\n${request.catalogue}` },
              { text: request.systemPrompt },
            ],
          },
          maxOutputTokens: request.maxTokens,
          // See the note at the top of this file. 0 is DISABLED per the SDK.
          thinkingConfig: { thinkingBudget: 0 },
          ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
        },
      });

      for await (const chunk of stream) {
        const text = chunk.text;
        if (text !== undefined && text.length > 0) request.onText(text);

        const reason = chunk.candidates?.[0]?.finishReason;
        if (reason !== undefined) finishReason = String(reason);

        // Usage arrives on every frame and is cumulative, so the last one
        // wins rather than being summed.
        const meta = chunk.usageMetadata;
        if (meta !== undefined) {
          usage.inputTokens = meta.promptTokenCount ?? 0;
          usage.cachedInputTokens = meta.cachedContentTokenCount ?? 0;
          usage.outputTokens = meta.candidatesTokenCount ?? 0;
          usage.thinkingTokens = meta.thoughtsTokenCount ?? 0;
        }
      }
    } catch (error) {
      const busy = classify(error);
      if (busy !== null) throw busy;
      throw error;
    }

    return {
      ...usage,
      finishReason,
      // Gemini reports a blocked answer as a finish reason rather than an
      // error. SAFETY and PROHIBITED_CONTENT are the model declining; RECITATION
      // is it stopping to avoid reproducing training data. All three mean the
      // visitor did not get an answer and should be told so.
      refused:
        finishReason === 'SAFETY' ||
        finishReason === 'PROHIBITED_CONTENT' ||
        finishReason === 'RECITATION' ||
        finishReason === 'BLOCKLIST',
      model: env.GEMINI_MODEL,
    };
  },
};
