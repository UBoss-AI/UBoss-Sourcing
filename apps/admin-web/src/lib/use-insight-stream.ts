/**
 * Driving the insights panel.
 *
 * One hook per dashboard. It owns the four things a streaming panel needs and
 * that every page would otherwise re-implement slightly differently: the open
 * request, the text as it arrives, the finished validated object, and the
 * abort that stops a generation nobody is watching.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web and
 * apps/logistics-web — see the note at the top of
 * components/dashboard/console.tsx.
 *
 * ---
 *
 * TWO THINGS IT IS CAREFUL ABOUT
 *
 *   - **One stream at a time.** Pressing the button again, or asking a second
 *     question while the first is still writing, aborts the first. Two open
 *     streams would interleave their deltas into one paragraph, and the
 *     deployment would be paying for both.
 *   - **It stops when the component goes.** Navigating away aborts, which
 *     cancels the generation server-side rather than leaving it running into a
 *     socket nobody is reading.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestStream } from './api';
import { readInsightStream } from './insight-stream';
import type { Insight } from '@/components/dashboard/AiInsightsCard';

export interface InsightStreamState {
  /** The finished, validated answer. Null until a stream completes. */
  insight: Insight | null;
  /** The summary as it arrives. Empty once `insight` has landed. */
  streamedSummary: string;
  /** True while a stream is open. */
  busy: boolean;
  /** True where the last attempt failed outright. */
  failed: boolean;
  /** Opens a stream. `question` absent means "explain this chart". */
  ask: (question?: string) => void;
}

export function useInsightStream(
  path: string,
  body: () => Record<string, unknown>,
): InsightStreamState {
  const [insight, setInsight] = useState<Insight | null>(null);
  const [streamedSummary, setStreamedSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const inFlight = useRef<AbortController | null>(null);

  /*
   * `body` is a closure over the page's current filters and is rebuilt on
   * every render. Kept in a ref rather than in `ask`'s dependency list, so the
   * callback identity is stable — otherwise every filter change would hand the
   * CTA a new `onClick` and re-render it mid-stream.
   */
  const latestBody = useRef(body);
  latestBody.current = body;

  useEffect(
    () => () => {
      inFlight.current?.abort();
    },
    [],
  );

  const ask = useCallback(
    (question?: string) => {
      inFlight.current?.abort();

      const controller = new AbortController();
      inFlight.current = controller;

      setBusy(true);
      setFailed(false);
      setInsight(null);
      setStreamedSummary('');

      void (async () => {
        try {
          const response = await requestStream(path, {
            body: {
              ...latestBody.current(),
              ...(question === undefined ? {} : { question }),
            },
            signal: controller.signal,
          });

          if (!response.ok || response.body === null) {
            // Including 401 and 429. The panel says it did not work; the
            // session banner and the rate-limit message are the api client's
            // and the page's business respectively.
            setFailed(true);
            return;
          }

          await readInsightStream(response.body, {
            onDelta: (text) => {
              setStreamedSummary((current) => current + text);
            },
            onInsight: (finished) => {
              setInsight(finished);
              // The finished object carries the same summary, so the streamed
              // copy is dropped rather than shown twice.
              setStreamedSummary('');
            },
            onError: () => {
              setFailed(true);
            },
          });
        } catch {
          // An abort is a deliberate stop, not a failure, and must not be
          // reported as one — the reader either pressed again or left.
          if (!controller.signal.aborted) setFailed(true);
        } finally {
          if (inFlight.current === controller) {
            inFlight.current = null;
            setBusy(false);
          }
        }
      })();
    },
    [path],
  );

  return { insight, streamedSummary, busy, failed, ask };
}
