/**
 * How an `error` frame from the assistant becomes a sentence and a Retry
 * decision.
 *
 * The server names the reason as a code and says whether a retry can work;
 * the page words it in the visitor's language. These pin that mapping, and
 * the fallbacks for a server that sends less than this bundle expects.
 */
import { describe, expect, it } from 'vitest';
import { readAssistantStream } from './assistant-stream';
import type { AssistantStreamFailure } from './assistant-stream';
import type { Translate } from '@/i18n/i18n-context';
import en from '@/i18n/locales/en.json';

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as Translate;

function body(...frames: string[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(frames.join(''));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function errorOf(data: unknown): Promise<{ message: string; failure: AssistantStreamFailure }> {
  let caught: { message: string; failure: AssistantStreamFailure } | undefined;
  await readAssistantStream(t, body(frame('error', data)), {
    onDelta: () => undefined,
    onError: (message, failure) => {
      caught = { message, failure };
    },
  });
  if (caught === undefined) throw new Error('no error frame was reported');
  return caught;
}

describe('readAssistantStream error frames', () => {
  it.each([
    ['BUSY', true, 'chat.assistantBusy'],
    ['QUOTA', true, 'chat.assistantQuotaReached'],
    ['TIMEOUT', true, 'chat.assistantTimedOut'],
    ['UNAVAILABLE', false, 'chat.assistantUnavailableContactSupport'],
    ['UNAVAILABLE', true, 'chat.assistantUnavailable'],
    ['REFUSED', false, 'chat.assistantDeclined'],
  ] as const)('words %s (retryable %s) from the catalogue', async (code, retryable, key) => {
    const { message, failure } = await errorOf({ code, retryable, message: 'English from the server' });

    expect(message).toBe((en as Record<string, string>)[key]);
    expect(failure).toEqual({ code, retryable });
  });

  it('prints the server message for a code this bundle does not know', async () => {
    const { message, failure } = await errorOf({ code: 'SOMETHING_NEW', message: 'Server words' });

    expect(message).toBe('Server words');
    expect(failure.retryable).toBe(true);
  });

  it('offers a retry to an older server that sends no code, and none for a refusal', async () => {
    expect((await errorOf({ message: 'Old server' })).failure.retryable).toBe(true);
    expect((await errorOf({ code: 'REFUSED' })).failure.retryable).toBe(false);
  });

  it('streams the deltas in order before a mid-answer failure', async () => {
    const deltas: string[] = [];
    const errors: string[] = [];

    await readAssistantStream(
      t,
      body(
        frame('delta', { text: 'Half ' }),
        frame('delta', { text: 'an answer' }),
        frame('error', { code: 'TIMEOUT', retryable: true }),
      ),
      {
        onDelta: (text) => deltas.push(text),
        onError: (message) => errors.push(message),
      },
    );

    expect(deltas).toEqual(['Half ', 'an answer']);
    expect(errors).toEqual([en['chat.assistantTimedOut']]);
  });
});
