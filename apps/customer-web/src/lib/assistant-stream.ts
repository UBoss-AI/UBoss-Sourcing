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
  /**
   * The stream finished, with whatever the server wants the page to know now
   * that this turn is over.
   *
   * Today that is one thing: how many free questions a visitor with no account
   * has left. It arrives here rather than being counted in the browser because
   * a client counting down on its own disagrees with the server the first time
   * a request is retried, and the disagreement always shows as the wall
   * arriving a question early or a question late.
   *
   * `null` means "say nothing about an allowance" — a signed-in customer, or a
   * deployment that has set no cap. Not "none left": a counter drawn on a
   * screen where the number is unlimited is a limit invented by the interface.
   *
   * Optional, so a caller that does not care about the allowance is unchanged.
   */
  onDone?: (info: { guestMessagesRemaining: number | null }) => void;
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
      } else if (event === 'done') {
        const remaining = (parsed as { guestMessagesRemaining?: unknown }).guestMessagesRemaining;

        // Anything that is not a number is `null`, which the caller reads as
        // "say nothing". That covers a server too old to send the field as
        // well as one that sent it as null deliberately, and both should
        // produce the same silence rather than a counter reading NaN.
        handlers.onDone?.({
          guestMessagesRemaining: typeof remaining === 'number' ? remaining : null,
        });
      }
    }
  }
}
