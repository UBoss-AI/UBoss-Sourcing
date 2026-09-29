/**
 * A provider that misbehaves on purpose.
 *
 * Fault injection for the payment, carrier and ERP adapters (DOD-032,
 * LIVE-017). This is a real HTTP listener on a real loopback socket, so what
 * is exercised is the adapter's own transport: its timeout, its JSON parsing,
 * its reading of the status line, and what it does when the connection is torn
 * down underneath it. A stubbed `fetch` would skip exactly the part that fails
 * in an outage.
 *
 * A test scripts the next N answers with `script(...)`. Each answer is one of:
 *
 *   { status, json }         an ordinary reply
 *   { status, text }         a reply whose body is whatever text is given -
 *                            an HTML error page from a proxy, half a JSON
 *                            document, nothing at all
 *   { status, headers }      e.g. 429 with Retry-After
 *   { hang: true }           accept the request and never answer
 *   { reset: true }          destroy the socket before any byte is written
 *   { delayMs }              answer, but late
 *
 * When the script runs out, `fallback` answers - by default a 503, because a
 * test that forgot to script an answer should see an outage, not a success.
 *
 * Every request is recorded (method, path, headers, body), so a test asserts
 * what was actually sent - for instance that a retry carried the SAME
 * idempotency key as the first attempt.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeAnswer =
  | {
      status: number;
      json?: unknown;
      text?: string;
      headers?: Record<string, string>;
      delayMs?: number;
    }
  | { hang: true }
  | { reset: true };

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface FakeProvider {
  /** e.g. http://127.0.0.1:53211 - no trailing slash. */
  readonly origin: string;
  readonly requests: FakeRequest[];
  /** Queue the next answers, in order. */
  script(...answers: FakeAnswer[]): void;
  /** What answers once the script is empty. */
  fallback: FakeAnswer;
  /** Forget the script and the recorded requests. */
  reset(): void;
  close(): Promise<void>;
}

function write(res: ServerResponse, answer: Exclude<FakeAnswer, { hang: true } | { reset: true }>): void {
  const headers: Record<string, string> = { ...(answer.headers ?? {}) };
  let body = '';
  if (answer.json !== undefined) {
    headers['content-type'] ??= 'application/json';
    body = JSON.stringify(answer.json);
  } else if (answer.text !== undefined) {
    headers['content-type'] ??= 'text/html; charset=utf-8';
    body = answer.text;
  }
  res.writeHead(answer.status, headers);
  res.end(body);
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const queue: FakeAnswer[] = [];
  const requests: FakeRequest[] = [];

  const provider: {
    fallback: FakeAnswer;
  } = { fallback: { status: 503, json: { error: { message: 'fake provider: nothing scripted' } } } };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      const answer = queue.shift() ?? provider.fallback;

      if ('reset' in answer) {
        req.socket.destroy();
        return;
      }
      if ('hang' in answer) return;

      if (answer.delayMs !== undefined && answer.delayMs > 0) {
        setTimeout(() => {
          write(res, answer);
        }, answer.delayMs);
        return;
      }
      write(res, answer);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    script(...answers: FakeAnswer[]) {
      queue.push(...answers);
    },
    get fallback() {
      return provider.fallback;
    },
    set fallback(answer: FakeAnswer) {
      provider.fallback = answer;
    },
    reset() {
      queue.length = 0;
      requests.length = 0;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/**
 * The real `fetch`, with one or more provider origins rewritten to fakes.
 *
 * The payment adapters call a fixed provider origin (`https://api.stripe.com`)
 * - deliberately not configurable, because a payment host an administrator can
 * retype is a way to send card tokens somewhere else. So instead of a setting,
 * the test swaps the origin on the way out and lets the real `fetch` (undici)
 * do the rest against the fake's socket. Everything after the origin - path,
 * query, headers, body, the adapter's AbortSignal - is passed through
 * untouched.
 */
export function redirectingFetch(
  routes: Record<string, string>,
  realFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [from, to] of Object.entries(routes)) {
      if (raw.startsWith(from)) {
        const url = new URL(raw);
        const target = new URL(to);
        url.protocol = target.protocol;
        url.host = target.host;
        return realFetch(url.href, init);
      }
    }
    return Promise.reject(new Error(`fake provider: unexpected outbound call to ${raw}`));
  });
}
