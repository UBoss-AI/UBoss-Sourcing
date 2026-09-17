/**
 * The one shape every dashboard insights endpoint takes.
 *
 * Three surfaces ask for an insight — a buyer's account, the admin console, a
 * carrier's portal — and all three have to validate the same body, apply the
 * same limits and refuse in the same way. Writing that three times is how two
 * of them end up with a 4,000-character question field and one of them forgets
 * the rate limit.
 *
 * What is emphatically NOT shared is the metric bundle. Each route builds its
 * own from its own role-scoped aggregate, and this file never queries
 * anything. The guard on the route decides who is asking; the aggregate
 * decides what they may see; this decides only how the question is parsed.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { allowedOrigins } from '../../config/env.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import {
  streamInsight,
  type InsightRequest,
} from '../../modules/assistant/insights.service.js';

/**
 * The body.
 *
 * `question` is capped short on purpose. This is a panel on a dashboard, not a
 * chat: a question that does not fit in 500 characters is not a question about
 * a ring with eight segments in it, and an uncapped free-text field on an
 * endpoint that reaches a paid provider is somebody else's bill.
 */
export const insightBody = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  question: z.string().trim().max(500).optional(),
  /**
   * The reader's language, so the answer comes back in it.
   *
   * Constrained to the eight this product ships, rather than passed through:
   * an unvalidated language tag is a string from a client that goes into a
   * prompt, and "reply in the following language: <anything>" is an
   * instruction-injection seam for no benefit.
   */
  language: z.enum(['en', 'de', 'es', 'fr', 'it', 'nl', 'pl', 'el']).optional(),
  /**
   * The chart segment the reader has selected, if any.
   *
   * A status key, matched against the metric keys the route built. Anything
   * unrecognised is dropped rather than rejected — a panel must not 400
   * because the URL carried a filter from an older build.
   */
  segment: z.string().trim().max(64).optional(),
});

export type InsightBody = z.infer<typeof insightBody>;

/**
 * The rate limit every insights route carries.
 *
 * Tighter than the assistant's chat limit, because the shape of the traffic is
 * different: a dashboard opens, asks once, and is read. Ten in five minutes is
 * an opening summary, a couple of "explain this" presses and a few typed
 * questions — comfortably more than anybody does, and far short of a script.
 *
 * Applied per route rather than globally so that a busy admin console cannot
 * spend a carrier's allowance.
 */
export const INSIGHT_RATE_LIMIT = { max: 10, timeWindow: '5 minutes' } as const;

/**
 * The filters, as labels for the prompt.
 *
 * Built here so all three surfaces describe a window the same way, and so that
 * nothing but a label can reach the prompt: the values are formatted from
 * already-validated data, never copied from the query string.
 */
export function describeFilters(
  window: { from: Date; to: Date },
  extra: Record<string, string | null | undefined> = {},
): Record<string, string> {
  const filters: Record<string, string> = {
    period: `${window.from.toISOString()} to ${window.to.toISOString()}`,
  };

  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === undefined || value === '') continue;
    filters[key] = value;
  }

  return filters;
}

/**
 * The window, validated as a window rather than as two dates.
 *
 * `resolveWindow` will happily return a range that runs backwards or covers a
 * decade, because its job is to fill in defaults. This is where a window that
 * makes no sense is refused — before it reaches a `groupBy` over every order
 * the deployment has ever taken.
 */
export function assertUsableWindow(window: { from: Date; to: Date }): void {
  if (Number.isNaN(window.from.getTime()) || Number.isNaN(window.to.getTime())) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The reporting period is not a valid range.');
  }

  if (window.from.getTime() > window.to.getTime()) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The reporting period ends before it starts.');
  }

  // Two years. Long enough for any comparison a dashboard offers, short enough
  // that a hand-typed `from=1970-01-01` cannot turn a card into a table scan.
  const MAX_SPAN_MS = 2 * 366 * 86_400_000;
  if (window.to.getTime() - window.from.getTime() > MAX_SPAN_MS) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The reporting period is longer than this dashboard covers. Use a report for a longer span.',
    );
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Which origins may read a stream.
 *
 * Mirrors `corsHeaders` in assistant.public.ts. An SSE response is written
 * with `reply.raw`, which bypasses the CORS plugin entirely — so the headers
 * have to be put on by hand or every cross-origin dashboard gets a stream the
 * browser refuses to read.
 */
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined || !allowedOrigins.includes(origin)) return {};

  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
}

/**
 * Send one insight as Server-Sent Events.
 *
 * Four event types, and the order of them is the contract:
 *
 *   - `meta`     once, before anything else: the window and the metric keys in
 *                scope, so the panel can show what the answer is measured over
 *                before a word of it exists.
 *   - `delta`    the summary, as it is written.
 *   - `insight`  once, at the end: the whole validated object — findings,
 *                suggested actions, evidence, source and model. Nothing here
 *                has skipped `sanitise`.
 *   - `done`     the stream is finished and the socket is closing.
 *
 * `build` is the caller's own role-scoped bundle, awaited BEFORE the socket is
 * hijacked. That ordering matters: a 401, a 403 or a 400 has to arrive as
 * itself, through the normal error handler, rather than as an error frame
 * buried inside a 200 stream that the panel would have to unpick.
 */
export async function streamInsightResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  build: () => Promise<InsightRequest>,
): Promise<void> {
  const insightRequest = await build();

  // From here the handler owns the socket. See the note above.
  reply.hijack();

  // `x-accel-buffering: no` is for nginx, which otherwise holds the whole
  // response and delivers the "stream" in one lump at the end.
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...corsHeaders(request.headers.origin),
  });

  const send = (event: string, data: unknown): void => {
    if (reply.raw.writableEnded) return;
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Closing the panel must stop the generation this deployment is paying for,
  // not leave it running to completion into a dead socket.
  const abort = new AbortController();
  reply.raw.on('close', () => {
    abort.abort();
  });

  send('meta', {
    window: insightRequest.window,
    metricKeys: insightRequest.metrics.map((metric) => metric.key),
  });

  try {
    const insight = await streamInsight(
      insightRequest,
      (text) => {
        send('delta', { text });
      },
      abort.signal,
    );

    send('insight', insight);
    send('done', {});
  } catch (error) {
    // `streamInsight` does not throw for a provider problem — it falls back.
    // Reaching here means something else did, so the panel is told plainly
    // rather than left waiting on a socket that never closes.
    if (!abort.signal.aborted) {
      request.log.error({ err: error }, 'insight stream failed');
      send('error', { message: 'The insights panel is unavailable right now.' });
    }
  } finally {
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}
