/**
 * Reading the assistant's reply as it is written.
 *
 * The API answers `/assistant/chat` with Server-Sent Events, and this is the
 * one place in the storefront that parses them. It was inside the old corner
 * chat widget; AI Mode is a page rather than a panel, and the parser had no
 * business living inside either.
 *
 * Written against `response.body` rather than `EventSource`, for two reasons
 * that both still hold: `EventSource` can only issue GET requests and so
 * cannot send the message, and reading the body ourselves means the same
 * `AbortController` that stops the reader also cancels the generation
 * server-side — pressing Stop stops the spend, not just the scrolling.
 */
import type { Translate } from '@/i18n/i18n-context';

export interface AssistantStreamHandlers {
  /** One chunk of the reply. Called many times, in order. */
  onDelta: (text: string) => void;
  /**
   * The server reported a problem mid-stream.
   *
   * This is not the same as the request failing: an error frame can arrive
   * after several paragraphs have already been written, and the caller has to
   * decide what to do with the half-answer it already showed.
   */
  onError: (message: string) => void;
}

/**
 * Read the SSE body to the end, handing each text delta to `onDelta`.
 *
 * Resolves when the stream closes. An aborted read rejects, which the caller
 * distinguishes by checking its own signal — a deliberate stop is not a
 * failure and must not be reported as one.
 */
export async function readAssistantStream(
  t: Translate,
  body: ReadableStream<Uint8Array>,
  handlers: AssistantStreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line. Anything after the last one is
    // a partial frame and stays in the buffer until the rest of it arrives.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      let event = 'message';
      let data = '';

      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }

      if (data.length === 0) continue;

      // A malformed frame is not worth taking the page down for.
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      if (event === 'delta' && typeof (parsed as { text?: unknown }).text === 'string') {
        handlers.onDelta((parsed as { text: string }).text);
      } else if (event === 'error') {
        const message = (parsed as { message?: unknown }).message;
        handlers.onError(typeof message === 'string' ? message : t('chat.assistantCouldNotAnswer'));
      }
    }
  }
}
