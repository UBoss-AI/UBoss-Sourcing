/**
 * Every outbound call gives up, and says so in its own module's words.
 *
 * DOD-034. A provider that accepts the connection and then says nothing is the
 * failure a timeout exists for, and it is the one no ordinary test produces:
 * a refused connection fails fast on its own. So each case here builds exactly
 * that upstream - headers and then silence, or nothing at all - and checks two
 * things:
 *
 *   1. the call is cut off at its deadline, not whenever the socket gives up;
 *   2. what comes out is the module's typed error, not the runtime's bare
 *      `AbortError` ("This operation was aborted"), which is what a screen or a
 *      retry decision would otherwise have to read.
 *
 * The `safeFetch` cases use a real local socket and real time, because the
 * timer is inside `node:http` handling and a fake one would prove nothing about
 * it. The adapters above it use fake timers and a hung fake of whatever they
 * call, because their deadlines are ten seconds and more.
 */
import { createServer, type RequestListener, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { AppError, ErrorCode } from '../../src/domain/errors.js';
import { imageSearchErrorFor } from '../../src/http/routes/catalog.public.js';
import { OutboundRequestError } from '../../src/infra/outbound-http.js';
import type * as OutboundHttp from '../../src/infra/outbound-http.js';
import {
  ANTHROPIC_EXCHANGE_DEADLINE_MS,
  anthropicProvider,
} from '../../src/modules/assistant/provider.anthropic.js';
import { AssistantProviderError } from '../../src/modules/assistant/provider.js';
import { UNSPLASH_TIMEOUT_MS, resolveImage } from '../../src/modules/catalog/demo-catalog/images.js';
import { fetchFeed } from '../../src/modules/integrations/connector.service.js';
import { DhlApiAdapter } from '../../src/modules/logistics/carrier/dhl.adapter.js';
import { FedExApiAdapter } from '../../src/modules/logistics/carrier/fedex.adapter.js';

// Replaced for the carrier cases only; every other case gets the real one.
const safeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/infra/outbound-http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof OutboundHttp>();
  return { ...actual, safeFetch: safeFetchMock };
});

// The real one, for the socket cases. `vi.mock` is hoisted above the imports,
// so every module imported above sees the mock instead.
const { safeFetch: realSafeFetch } = await vi.importActual<typeof OutboundHttp>(
  '../../src/infra/outbound-http.js',
);

// ---------------------------------------------------------------------------
// A fetch that hangs
// ---------------------------------------------------------------------------

/**
 * What a hung upstream looks like to `fetch`.
 *
 * `silent` never answers. `stalled` sends a 200 and its headers, then no body
 * - the case an SDK timeout armed only around `fetch()` does not cover. Both
 * honour the request's signal exactly as undici does: an abort rejects the
 * pending promise, or errors the body stream, with the signal's reason.
 */
function hungFetch(mode: 'silent' | 'stalled', contentType = 'application/json') {
  return vi.fn((_input: unknown, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;

    if (mode === 'silent') {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => {
          controller.error(signal.reason);
        });
      },
    });

    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': contentType } }),
    );
  });
}

/**
 * Global `fetch`, redirected to whichever fake the current case installed.
 *
 * Installed once, before anything is called, because the Anthropic SDK reads
 * the global when its client is constructed and keeps that reference.
 */
let currentFetch: (input: unknown, init?: RequestInit) => Promise<Response> = () =>
  Promise.reject(new Error('no fetch installed for this case'));

const mutableEnv = env as { ANTHROPIC_API_KEY: string; UNSPLASH_ACCESS_KEY: string };
const originalAnthropicKey = env.ANTHROPIC_API_KEY;
const originalUnsplashKey = env.UNSPLASH_ACCESS_KEY;

beforeAll(() => {
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => currentFetch(input, init));
  // Never a real key: the fake fetch above answers every call.
  mutableEnv.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-key';
  mutableEnv.UNSPLASH_ACCESS_KEY = 'unsplash-test-not-a-key';
});

afterAll(() => {
  vi.unstubAllGlobals();
  mutableEnv.ANTHROPIC_API_KEY = originalAnthropicKey;
  mutableEnv.UNSPLASH_ACCESS_KEY = originalUnsplashKey;
});

afterEach(() => {
  vi.useRealTimers();
  safeFetchMock.mockReset();
});

/** Settle a promise into a value either way, so fake time can run past it. */
function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

// ---------------------------------------------------------------------------
// safeFetch, on a real socket
// ---------------------------------------------------------------------------

async function listen(handler: RequestListener): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, port: typeof address === 'object' && address !== null ? address.port : 0 };
}

async function shut(server: Server): Promise<void> {
  // The hung requests would otherwise keep `close` waiting for ever.
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

describe('safeFetch - the helper the carrier and ERP adapters share', () => {
  const silent: RequestListener = () => undefined;
  const stalled: RequestListener = (_request, response) => {
    response.writeHead(200);
    response.write('{"partial":');
  };

  it.each([
    ['answers nothing at all', silent],
    ['sends its headers and then stalls the body', stalled],
  ])('cuts off an upstream that %s, as a TIMEOUT', async (_label, handler) => {
    const { server, port } = await listen(handler);

    try {
      const startedAt = Date.now();
      const outcome = await settle(
        realSafeFetch(`http://127.0.0.1:${String(port)}/hang`, {
          method: 'GET',
          headers: {},
          // The floor `safeFetch` applies per hop, so the shortest it honours.
          timeoutMs: 1000,
          allowPrivate: true,
        }),
      );
      const elapsed = Date.now() - startedAt;

      expect(outcome.ok).toBe(false);
      const error = (outcome as { error: unknown }).error as { name: string; code: string };
      expect(error.name).toBe('OutboundRequestError');
      expect(error.code).toBe('TIMEOUT');
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await shut(server);
    }
  });
});

// ---------------------------------------------------------------------------
// Carrier adapters
// ---------------------------------------------------------------------------

/**
 * `safeFetch` as a hung carrier makes it behave: nothing, until its own
 * `timeoutMs` passes, then the TIMEOUT the case above shows it raising.
 */
function hungSafeFetch(_url: string, options: { timeoutMs: number }): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => {
      reject(new OutboundRequestError('The system did not respond in time.', 'TIMEOUT'));
    }, options.timeoutMs);
  });
}

const RATE_REQUEST = {
  from: {
    companyName: 'Sender',
    line1: '1 Test Street',
    city: 'London',
    postalCode: 'EC1A 1BB',
    countryCode: 'GB',
  },
  to: {
    companyName: 'Receiver',
    line1: '1 Test Street',
    city: 'Dublin',
    postalCode: 'D02 AF30',
    countryCode: 'IE',
  },
  parcels: [{ reference: 'P1', weightGrams: 1000 }],
};

const CARRIERS = [
  [
    'DHL',
    () =>
      new DhlApiAdapter({
        environment: 'SANDBOX',
        credentials: { apiKey: 'key', apiSecret: 'secret' },
        accountNumber: '123456789',
      }),
  ],
  [
    'FEDEX',
    () =>
      new FedExApiAdapter({
        environment: 'SANDBOX',
        credentials: { clientId: 'client', clientSecret: 'secret' },
        accountNumber: '123456789',
      }),
  ],
] as const;

describe('carrier adapters', () => {
  it.each(CARRIERS)(
    '%s: a hung carrier is cut off at ten seconds as CARRIER_REQUEST_FAILED / CARRIER_TIMEOUT',
    async (provider, build) => {
      vi.useFakeTimers();
      safeFetchMock.mockImplementation(hungSafeFetch);

      const pending = settle(build().getRates(RATE_REQUEST));

      await vi.advanceTimersByTimeAsync(9_999);
      expect(await Promise.race([pending, Promise.resolve('still waiting')])).toBe('still waiting');

      await vi.advanceTimersByTimeAsync(1);
      const outcome = await pending;

      expect(safeFetchMock).toHaveBeenCalledTimes(1);
      expect((safeFetchMock.mock.calls[0]?.[1] as { timeoutMs: number }).timeoutMs).toBe(10_000);

      expect(outcome.ok).toBe(false);
      const error = (outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(AppError);
      const appError = error as InstanceType<typeof AppError>;
      expect(appError.code).toBe(ErrorCode.CARRIER_REQUEST_FAILED);
      expect(appError.statusCode).toBe(504);
      expect(appError.details[0]).toEqual({ code: 'CARRIER_TIMEOUT', meta: { provider } });
      expect(appError.message).toBe(
        `${provider} did not respond in time. Nothing was booked; please try again.`,
      );
    },
  );

  it.each(CARRIERS)('%s: an unreachable carrier is CARRIER_UNREACHABLE, 502', async (provider, build) => {
    safeFetchMock.mockRejectedValue(
      new OutboundRequestError('The system could not be reached.', 'UNREACHABLE'),
    );

    const outcome = await settle(build().getRates(RATE_REQUEST));

    expect(outcome.ok).toBe(false);
    const appError = (outcome as { error: unknown }).error as InstanceType<typeof AppError>;
    expect(appError.code).toBe(ErrorCode.CARRIER_REQUEST_FAILED);
    expect(appError.statusCode).toBe(502);
    expect(appError.details[0]).toEqual({ code: 'CARRIER_UNREACHABLE', meta: { provider } });
  });
});

// ---------------------------------------------------------------------------
// The Anthropic provider
// ---------------------------------------------------------------------------

describe('Anthropic provider', () => {
  it('cuts off a stream whose headers arrived and whose body stalled, as a timeout', async () => {
    vi.useFakeTimers();
    const fake = hungFetch('stalled', 'text/event-stream');
    currentFetch = fake;

    const pending = settle(
      anthropicProvider.stream({
        systemPrompt: 'Reply with OK.',
        catalogue: '',
        turns: [{ role: 'user', content: 'Status check.' }],
        maxTokens: 8,
        onText: () => undefined,
      }),
    );

    // Past the SDK's own thirty seconds: it is cleared once the headers are in,
    // so without the exchange deadline this would still be waiting here.
    await vi.advanceTimersByTimeAsync(ANTHROPIC_EXCHANGE_DEADLINE_MS - 1);
    expect(await Promise.race([pending, Promise.resolve('still waiting')])).toBe('still waiting');

    await vi.advanceTimersByTimeAsync(1);
    const outcome = await pending;

    expect(fake).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(AssistantProviderError);
    expect((error as InstanceType<typeof AssistantProviderError>).reason).toBe('timeout');
  });

  it('cuts off an image answer whose body stalled, as a timeout the route answers with 503', async () => {
    vi.useFakeTimers();
    currentFetch = hungFetch('stalled');

    const pending = settle(
      anthropicProvider.describeImage({
        systemPrompt: 'Describe it.',
        catalogue: '',
        image: { data: Buffer.from([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' },
        prompt: 'What is this?',
        maxTokens: 8,
      }),
    );

    await vi.advanceTimersByTimeAsync(ANTHROPIC_EXCHANGE_DEADLINE_MS);
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(AssistantProviderError);
    expect((error as InstanceType<typeof AssistantProviderError>).reason).toBe('timeout');

    // What the image-search route sends for it: the published code the
    // storefront translates, not a bare 500.
    const mapped = imageSearchErrorFor(error);
    expect(mapped?.statusCode).toBe(503);
    expect(mapped?.code).toBe(ErrorCode.IMAGE_SEARCH_BUSY);
    expect(mapped?.details[0]?.code).toBe('TIMEOUT');
  });

  it('leaves a visitor closing the panel to the caller, not reported as our deadline', async () => {
    currentFetch = hungFetch('stalled', 'text/event-stream');
    const visitor = new AbortController();

    const pending = settle(
      anthropicProvider.stream({
        systemPrompt: 'Reply with OK.',
        catalogue: '',
        turns: [{ role: 'user', content: 'Status check.' }],
        maxTokens: 8,
        signal: visitor.signal,
        onText: () => undefined,
      }),
    );

    visitor.abort();
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: unknown }).error as { message?: string };
    expect(error.message ?? '').not.toContain('did not finish within');
  });
});

// ---------------------------------------------------------------------------
// The pull connector
// ---------------------------------------------------------------------------

describe('pull connector feed', () => {
  it('cuts off a hung feed at the connection timeout, in words a screen can show', async () => {
    vi.useFakeTimers();
    currentFetch = hungFetch('silent');

    const pending = settle(
      fetchFeed({
        baseUrl: 'https://feed.example.com/products',
        timeoutMs: 5_000,
        authType: 'NONE',
        credentials: null,
      }),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: unknown }).error as Error;
    expect(error.message).toBe('Remote did not respond within 5000 ms');
    expect(error.name).not.toBe('AbortError');
  });

  it('cuts off a feed whose body stalled after the headers', async () => {
    vi.useFakeTimers();
    currentFetch = hungFetch('stalled');

    const pending = settle(
      fetchFeed({
        baseUrl: 'https://feed.example.com/products',
        timeoutMs: 5_000,
        authType: 'NONE',
        credentials: null,
      }),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(((outcome as { error: unknown }).error as Error).message).toBe(
      'Remote did not respond within 5000 ms',
    );
  });
});

// ---------------------------------------------------------------------------
// Demo catalogue images
// ---------------------------------------------------------------------------

describe('demo catalogue image search', () => {
  it('gives up on a hung Unsplash after its attempts and falls back to the library', async () => {
    vi.useFakeTimers();
    const fake = hungFetch('silent');
    currentFetch = fake;

    const pending = settle(
      resolveImage(
        {
          query: 'stethoscope',
          alt: 'A stethoscope',
          departmentSlug: 'demo-department',
          subcategorySlug: 'demo-shelf',
          index: 0,
          seedKey: 'timeout-test',
        },
        {},
        { useApi: true },
      ),
    );

    // Three attempts of ten seconds, with the 500 ms and 1 s backoff between.
    await vi.advanceTimersByTimeAsync(UNSPLASH_TIMEOUT_MS);
    expect(fake).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500 + UNSPLASH_TIMEOUT_MS + 1_000 + UNSPLASH_TIMEOUT_MS);
    const outcome = await pending;

    expect(fake).toHaveBeenCalledTimes(3);
    expect(outcome.ok).toBe(true);
    expect((outcome as { value: { source: string } }).value.source).not.toBe('unsplash-api');
  });
});
