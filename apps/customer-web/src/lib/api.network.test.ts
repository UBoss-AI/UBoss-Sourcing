/**
 * A dropped connection, at the one place every request goes through.
 *
 * Every screen reads a transport failure through `errorMessage`, which only
 * knows what to say because the client turns `fetch`'s bare TypeError into a
 * `NetworkError` that says whether the browser is offline. If that conversion
 * broke, every screen in the storefront would show a generic failure — or
 * worse, treat a lost response as a refusal — and no screen test would say why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/config';
import { api, NetworkError } from './api';
import { errorMessage } from './errors';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const t = i18n.t.bind(i18n) as Parameters<typeof errorMessage>[0];

describe('a request whose connection drops', () => {
  it('becomes a NetworkError that says the store could not be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const failure = await api.get('/cart').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NetworkError);
    expect((failure as NetworkError).isOffline).toBe(false);
    expect(errorMessage(t, failure)).toBe(
      'Could not reach the store. Check your connection and try again.',
    );
  });

  it('says the customer is offline when the browser reports it', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    const failure = await api.post('/cart/items', { productId: 'p' }).catch((e: unknown) => e);

    expect((failure as NetworkError).isOffline).toBe(true);
    expect(errorMessage(t, failure)).toBe(
      'You appear to be offline. Check your connection and try again.',
    );
  });

  it('lets a cancelled request stay a cancellation, not a network failure', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

    const failure = await api.get('/cart').catch((error: unknown) => error);

    // A screen that aborts a stale request on navigation must not then show
    // "could not reach the store" for something it chose to cancel.
    expect(failure).not.toBeInstanceOf(NetworkError);
    expect((failure as DOMException).name).toBe('AbortError');
  });

  it('works again once the connection is back, with nothing held over', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await expect(api.get('/cart')).rejects.toBeInstanceOf(NetworkError);
    await expect(api.get('/cart')).resolves.toEqual({ ok: true });
  });
});
