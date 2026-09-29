/**
 * Payment and carrier adapters against a provider that is having a bad day.
 *
 * DOD-032 / LIVE-017. Each adapter is pointed at `tests/support/fake-provider`
 * - a real HTTP server on a loopback socket - and the fake is scripted to fail
 * in the ways real providers fail during an outage:
 *
 *   - a 5xx, and a 429 with Retry-After
 *   - the connection torn down before a byte is written
 *   - a 2xx whose body is an HTML page from a proxy, or half a JSON document
 *   - no answer at all, until the adapter's own deadline
 *
 * For every one the adapter must fail with its module's TYPED error - never a
 * bare TypeError that becomes a generic 500 - and must say correctly whether a
 * retry is worth making. A retry must carry the same idempotency key as the
 * first attempt, because a provider that timed out may well have acted.
 *
 * The ERP adapters have the same treatment on a real socket in
 * `tests/integration/customer-erp-live.test.ts` (transient failure recovered
 * under one idempotency key; a refusal stops rather than retrying) and the
 * job queue's retry / backoff / dead-letter path in `job-queue.test.ts` and
 * `dead-letter.test.ts`; the missed-webhook reconciliation sweep is in
 * `stripe-checkout.test.ts`. This file covers the two families that had only
 * been exercised with a stubbed `fetch`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError, ErrorCode } from '../../src/domain/errors.js';
import type * as OutboundHttp from '../../src/infra/outbound-http.js';
import { PaymentProviderError } from '../../src/modules/payments/provider.js';
import { RazorpayAdapter } from '../../src/modules/payments/razorpay.adapter.js';
import { StripeAdapter } from '../../src/modules/payments/stripe.adapter.js';
import { DhlApiAdapter } from '../../src/modules/logistics/carrier/dhl.adapter.js';
import { FedExApiAdapter } from '../../src/modules/logistics/carrier/fedex.adapter.js';
import { redirectingFetch, startFakeProvider, type FakeProvider } from '../support/fake-provider.js';

// ---------------------------------------------------------------------------
// Carrier transport: the real safeFetch, re-aimed at the fake
// ---------------------------------------------------------------------------

/**
 * Where the carrier calls are sent. The carrier adapters build their URL from
 * a fixed per-environment base, and `safeFetch` (rightly) refuses loopback, so
 * the mock keeps the REAL safeFetch - its timeout, size cap and socket
 * handling - and changes only the origin and the private-address allowance.
 */
const carrierTarget = vi.hoisted(() => ({ origin: '' }));

vi.mock('../../src/infra/outbound-http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof OutboundHttp>();
  return {
    ...actual,
    safeFetch: (url: string, options: OutboundHttp.SafeFetchOptions) => {
      const original = new URL(url);
      const target = new URL(carrierTarget.origin);
      original.protocol = target.protocol;
      original.host = target.host;
      return actual.safeFetch(original.href, { ...options, allowPrivate: true });
    },
  };
});

let fake: FakeProvider;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  fake = await startFakeProvider();
  carrierTarget.origin = fake.origin;
  vi.stubGlobal(
    'fetch',
    redirectingFetch(
      { 'https://api.stripe.com': fake.origin, 'https://api.razorpay.com': fake.origin },
      realFetch,
    ),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await fake.close();
});

afterEach(() => {
  vi.useRealTimers();
  fake.reset();
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

// ---------------------------------------------------------------------------
// Payment adapters
// ---------------------------------------------------------------------------

const paymentInput = {
  orderId: '01JBOSSORDER00000000000001',
  orderNumber: 'UB-2026-000123',
  amountMinor: 250_00n,
  currency: 'EUR',
  customerEmail: 'buyer@example.com',
  customerName: 'A Buyer',
  customerPhone: null,
  idempotencyKey: 'idem-fault-1',
};

const PAYMENT_PROVIDERS = [
  {
    name: 'Stripe',
    idempotencyHeader: 'idempotency-key',
    build: () =>
      new StripeAdapter({
        keyId: 'pk_test_publishable',
        keySecret: 'sk_test_secret',
        webhookSecret: 'whsec_test',
      }),
    declined: {
      status: 402,
      json: { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } },
    },
    outage: { status: 503, json: { error: { type: 'api_error', message: 'Service unavailable' } } },
  },
  {
    name: 'Razorpay',
    idempotencyHeader: 'x-razorpay-idempotency-key',
    build: () =>
      new RazorpayAdapter({
        keyId: 'rzp_test_key',
        keySecret: 'rzp_test_secret',
        webhookSecret: 'rzp_webhook',
      }),
    declined: {
      status: 400,
      json: { error: { code: 'BAD_REQUEST_ERROR', description: 'The amount is invalid.' } },
    },
    outage: { status: 502, json: { error: { code: 'SERVER_ERROR', description: 'Bad gateway' } } },
  },
] as const;

describe.each(PAYMENT_PROVIDERS)('$name under fault injection', (provider) => {
  it('treats a 5xx as a retryable provider error, carrying the status', async () => {
    fake.script(provider.outage);

    const error = await failure(provider.build().createPayment(paymentInput));

    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ retryable: true, httpStatus: provider.outage.status });
  });

  it('treats a 429 with Retry-After as retryable', async () => {
    fake.script({ status: 429, headers: { 'retry-after': '2' }, json: { error: { message: 'slow down' } } });

    const error = await failure(provider.build().createPayment(paymentInput));

    expect(error).toMatchObject({ retryable: true, httpStatus: 429 });
  });

  it('does not retry a refusal, which only delays telling the customer', async () => {
    fake.script(provider.declined);

    const error = await failure(provider.build().createPayment(paymentInput));

    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ retryable: false });
  });

  it('turns a connection torn down mid-request into a retryable error, not a crash', async () => {
    fake.script({ reset: true });

    const error = await failure(provider.build().createPayment(paymentInput));

    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ retryable: true });
    expect((error as Error).message).toMatch(/could not reach/i);
  });

  it.each([
    ['an HTML error page from a proxy', '<html><body>502 Bad Gateway</body></html>'],
    ['half a JSON document', '{"id":"pi_123","status":"requires_pay'],
    ['an empty body', ''],
  ])('reads a 200 carrying %s as an unreadable, retryable reply', async (_label, text) => {
    fake.script({ status: 200, text });

    const error = await failure(provider.build().createPayment(paymentInput));

    // Before this was guarded, `null` came back and the caller failed with a
    // TypeError reading a field of it - a generic 500 with nothing to say.
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ retryable: true, providerCode: 'UNREADABLE_RESPONSE' });
  });

  it('sends the same idempotency key on the retry after an outage', async () => {
    fake.script(provider.outage, provider.outage);
    const adapter = provider.build();

    await failure(adapter.createPayment(paymentInput));
    await failure(adapter.createPayment(paymentInput));

    expect(fake.requests).toHaveLength(2);
    const keys = fake.requests.map((request) => request.headers[provider.idempotencyHeader]);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
  });

  it('gives up on a provider that never answers, at its own deadline, as retryable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fake.script({ hang: true });

    const pending = failure(provider.build().createPayment(paymentInput));
    // Let the request reach the fake before time moves.
    await vi.waitFor(() => {
      expect(fake.requests).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(15_000);

    const error = await pending;
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ retryable: true });
    expect((error as Error).message).toMatch(/did not respond in time/i);
  });
});

// ---------------------------------------------------------------------------
// Carrier adapters
// ---------------------------------------------------------------------------

const RATE_REQUEST = {
  from: { companyName: 'Sender', line1: '1 Test Street', city: 'London', postalCode: 'EC1A 1BB', countryCode: 'GB' },
  to: { companyName: 'Receiver', line1: '1 Test Street', city: 'Dublin', postalCode: 'D02 AF30', countryCode: 'IE' },
  parcels: [{ reference: 'P1', weightGrams: 1000 }],
};

const FEDEX_TOKEN = { status: 200, json: { access_token: 'fake-token', token_type: 'bearer', expires_in: 3600 } };

const CARRIERS = [
  {
    name: 'DHL',
    /** DHL needs no token call before the rate request. */
    prelude: [] as const,
    build: () =>
      new DhlApiAdapter({
        environment: 'SANDBOX',
        credentials: { apiKey: 'key', apiSecret: 'secret' },
        accountNumber: '123456789',
      }),
  },
  {
    name: 'FEDEX',
    prelude: [FEDEX_TOKEN] as const,
    build: () =>
      new FedExApiAdapter({
        environment: 'SANDBOX',
        credentials: { clientId: 'client', clientSecret: 'secret' },
        accountNumber: '123456789',
      }),
  },
] as const;

function carrierError(error: unknown): { status: number; detail: string | undefined; message: string } {
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  expect(appError.code).toBe(ErrorCode.CARRIER_REQUEST_FAILED);
  return {
    status: appError.statusCode,
    detail: appError.details[0]?.code,
    message: appError.message,
  };
}

describe.each(CARRIERS)('$name under fault injection', (carrier) => {
  it('reports a 5xx outage page as a failed booking, in words safe to show a seller', async () => {
    fake.script(...carrier.prelude, {
      status: 503,
      text: '<html><body>Service Unavailable - Authorization: Bearer sk_live_leaked</body></html>',
    });

    const outcome = carrierError(await failure(carrier.build().getRates(RATE_REQUEST)));

    expect(outcome.status).toBe(502);
    expect(outcome.detail).toBe('CARRIER_REFUSED');
    // Whatever the carrier echoed, a credential never reaches the message.
    expect(outcome.message).not.toContain('sk_live_leaked');
  });

  it('reports a 429 as a failed request rather than an empty rate list', async () => {
    fake.script(...carrier.prelude, { status: 429, headers: { 'retry-after': '5' }, json: { detail: 'Too many requests' } });

    const outcome = carrierError(await failure(carrier.build().getRates(RATE_REQUEST)));

    expect(outcome.status).toBe(502);
  });

  it('reports a 200 that is not JSON as unreadable, never as "no rates"', async () => {
    fake.script(...carrier.prelude, { status: 200, text: '<html>maintenance</html>' });

    const outcome = carrierError(await failure(carrier.build().getRates(RATE_REQUEST)));

    expect(outcome.detail).toBe('CARRIER_REFUSED');
    expect(outcome.message).toMatch(/could not be read/i);
  });

  it('reports a connection torn down mid-request as CARRIER_UNREACHABLE', async () => {
    fake.script(...carrier.prelude, { reset: true });

    const outcome = carrierError(await failure(carrier.build().getRates(RATE_REQUEST)));

    expect(outcome.status).toBe(502);
    expect(outcome.detail).toBe('CARRIER_UNREACHABLE');
    expect(outcome.message).toMatch(/Nothing was booked/);
  });

  it('answers normally again once the carrier recovers', async () => {
    // One outage, then a healthy empty reply: the adapter holds no broken
    // state from the failure (no poisoned token, no stuck connection).
    fake.script(...carrier.prelude, { status: 503, text: 'down' });
    const adapter = carrier.build();
    await failure(adapter.getRates(RATE_REQUEST));

    fake.script(
      { status: 200, json: carrier.name === 'DHL' ? { products: [] } : { output: { rateReplyDetails: [] } } },
    );
    await expect(adapter.getRates(RATE_REQUEST)).resolves.toEqual([]);
  });
});
