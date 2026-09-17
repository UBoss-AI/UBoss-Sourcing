/**
 * Reading an insight as it is written.
 *
 * The API answers `…/dashboard/insights/stream` with Server-Sent Events, and
 * this is the one place any dashboard parses them.
 *
 * Written against `response.body` rather than `EventSource`, for the same two
 * reasons `assistant-stream.ts` records in the storefront: `EventSource` can
 * only issue GET requests and so cannot carry the question, and reading the
 * body ourselves means the same `AbortController` that stops the reader also
 * cancels the generation server-side — closing the panel stops the spend, not
 * just the scrolling.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web and
 * apps/logistics-web — see the note at the top of
 * components/dashboard/console.tsx.
 *
 * ---
 *
 * THE EVENT ORDER IS THE CONTRACT
 *
 *   - `meta`    once, first: the window and the metric keys in scope.
 *   - `delta`   the summary, as it arrives.
 *   - `insight` once, at the end: the whole validated object.
 *   - `done`    the stream is finished.
 *   - `error`   something went wrong, possibly after several deltas.
 *
 * The findings arrive only in `insight`, never in a `delta`, and that is
 * deliberate on the server's side: a citation cannot be checked against the
 * metric bundle until the structured half of the reply is complete. So the
 * panel shows prose while it streams and claims nothing until it can prove it.
 */
import type { Insight } from '@/components/dashboard/AiInsightsCard';

export interface InsightStreamHandlers {
  /** The window and metric keys, before a word of the answer exists. */
  onMeta?: ((meta: { window: { from: string; to: string }; metricKeys: string[] }) => void) | undefined;
  /** One chunk of the summary. Called many times, in order. */
  onDelta: (text: string) => void;
  /** The finished, validated insight. Called once, at the end. */
  onInsight: (insight: Insight) => void;
  /**
   * The server reported a problem mid-stream.
   *
   * Not the same as the request failing: an error frame can arrive after
   * several sentences are already on screen, and the caller decides what to do
   * with the half-answer it has shown.
   */
  onError: (message: string) => void;
}

/**
 * Read the SSE body to the end.
 *
 * Resolves when the stream closes. An aborted read rejects, which the caller
 * tells apart by checking its own signal — a deliberate stop is not a failure
 * and must not be reported as one.
 */
export async function readInsightStream(
  body: ReadableStream<Uint8Array>,
  handlers: InsightStreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line. Anything after the last one is
    // a partial frame and stays in the buffer until the rest arrives.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      let event = 'message';
      const data: string[] = [];

      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        // A `data:` line may legitimately be empty, so this slices rather than
        // trimming — leading whitespace after the colon is the only thing the
        // specification lets us drop.
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }

      if (data.length === 0) continue;

      let payload: unknown;
      try {
        payload = JSON.parse(data.join('\n'));
      } catch {
        // A frame this build cannot read is skipped rather than fatal. A panel
        // one deploy behind the API must degrade, not break.
        continue;
      }

      if (event === 'meta' && handlers.onMeta !== undefined) {
        handlers.onMeta(payload as { window: { from: string; to: string }; metricKeys: string[] });
      } else if (event === 'delta') {
        const text = (payload as { text?: unknown }).text;
        if (typeof text === 'string') handlers.onDelta(text);
      } else if (event === 'insight') {
        handlers.onInsight(payload as Insight);
      } else if (event === 'error') {
        const message = (payload as { message?: unknown }).message;
        handlers.onError(typeof message === 'string' ? message : 'The insights panel failed.');
      }
    }
  }
}
