/**
 * Privacy-first analytics (Section 17): only route patterns leave the browser,
 * Do Not Track and Global Privacy Control send nothing, and a batch goes out
 * in one request without cookies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAnalyticsForTest, flushAnalytics, patternOf, pendingAnalyticsForTest, resetAnalyticsForTest, track, trackOnce } from './analytics';

const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  resetAnalyticsForTest();
  enableAnalyticsForTest(true);
});

afterEach(() => {
  enableAnalyticsForTest(false);
  vi.unstubAllGlobals();
});

describe('analytics', () => {
  it('turns a real address into its route pattern', () => {
    expect(patternOf('/product/nitrile-gloves', { slug: 'nitrile-gloves' })).toBe('/product/:slug');
    expect(patternOf('/account/orders/01JABCDEFGHJKMNPQRSTVWXYZ0', {})).toBe('/account/orders/:id');
    expect(patternOf('/account/orders/12345', {})).toBe('/account/orders/:n');
  });

  it('sends one batch with no cookies', () => {
    track('screen_view', '/product/:slug');
    track('search_submitted', '/search');
    expect(pendingAnalyticsForTest()).toHaveLength(2);
    flushAnalytics();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/analytics\/events$/);
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body as string)).toEqual({
      events: [
        { event: 'screen_view', screen: '/product/:slug' },
        { event: 'search_submitted', screen: '/search' },
      ],
    });
  });

  it('sends nothing when the browser asks not to be tracked', () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    try {
      track('screen_view', '/');
      flushAnalytics();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, 'globalPrivacyControl');
    }
  });

  it('counts an order placed once, however often its confirmation page is opened (LIVE-020)', () => {
    window.localStorage.removeItem('uboss.analytics.once');
    trackOnce('checkout_completed', '/order-confirmation', 'order-A');
    // React's development double mount, and a second render of the same page.
    trackOnce('checkout_completed', '/order-confirmation', 'order-A');
    expect(pendingAnalyticsForTest()).toHaveLength(1);

    // A reload: the page's memory is gone, the browser's record is not.
    resetAnalyticsForTest();
    trackOnce('checkout_completed', '/order-confirmation', 'order-A');
    expect(pendingAnalyticsForTest()).toHaveLength(0);

    // A different order is a different count, and the order id is never sent.
    trackOnce('checkout_completed', '/order-confirmation', 'order-B');
    expect(pendingAnalyticsForTest()).toEqual([{ event: 'checkout_completed', screen: '/order-confirmation' }]);
    window.localStorage.removeItem('uboss.analytics.once');
  });
});
