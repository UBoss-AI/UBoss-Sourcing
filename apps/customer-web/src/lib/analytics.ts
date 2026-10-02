/**
 * Product analytics, privacy-first (checklist Section 17, LIVE-020).
 *
 * What is sent is a COUNT, never a trail. Each event is a name from a fixed
 * list and, for a page view, the route PATTERN ("/product/:slug"), never the
 * address itself - so no product, order or person can be read back out of it.
 * No cookie, no identifier, no IP address is kept: the server adds one to a
 * per-day counter and throws the request away.
 *
 * A browser that says Do Not Track or Global Privacy Control sends nothing.
 * Analytics is never allowed to break a page: every failure is swallowed.
 */
import { useContext, useEffect } from 'react';
import { UNSAFE_DataRouterStateContext } from 'react-router-dom';
import { BASE_URL } from '@/lib/api';

/** The events a page may send. The server refuses any other name. */
export type AnalyticsEvent =
  | 'screen_view'
  | 'search_submitted'
  | 'filter_applied'
  | 'checkout_started'
  | 'checkout_completed'
  | 'rfq_started'
  | 'rfq_submitted'
  | 'return_requested'
  | 'dispute_opened'
  | 'quick_start_used';

interface Pending {
  event: AnalyticsEvent;
  screen: string;
}

const FLUSH_MS = 4000;
const MAX_BATCH = 20;
let queue: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let testSending = false;

function optedOut(): boolean {
  // Component tests stub fetch and count its calls; a counter must not show up there.
  if (import.meta.env.MODE === 'test' && !testSending) return true;
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    return nav.globalPrivacyControl === true || nav.doNotTrack === '1';
  } catch {
    return true;
  }
}

/** The route pattern for a concrete path, with every parameter put back as `:name`. */
export function patternOf(pathname: string, params: Record<string, string | undefined>): string {
  let pattern = pathname;
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === '' || name === '*') continue;
    pattern = pattern
      .split('/')
      .map((segment) => (decodeURIComponent(segment) === value ? `:${name}` : segment))
      .join('/');
  }
  // Belt and braces: anything still looking like an id is masked.
  pattern = pattern.replace(/\/[0-9A-HJKMNP-TV-Z]{26}(?=\/|$)/g, '/:id').replace(/\/\d+(?=\/|$)/g, '/:n');
  return pattern.slice(0, 96) || '/';
}

export function flushAnalytics(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const events = queue.splice(0, MAX_BATCH);
  try {
    void fetch(`${BASE_URL}/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      credentials: 'omit',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Never let a counter break a page.
  }
  if (queue.length > 0) flushAnalytics();
}

export function track(event: AnalyticsEvent, screen = ''): void {
  if (optedOut()) return;
  queue.push({ event, screen: screen.slice(0, 96) });
  if (queue.length >= MAX_BATCH) {
    flushAnalytics();
    return;
  }
  timer ??= setTimeout(flushAnalytics, FLUSH_MS);
}

/**
 * Count an event at most once for `onceKey` in this browser.
 *
 * For the events that stand for a transaction - an order placed - and are
 * reconciled against the source table. The confirmation page is reloaded,
 * reopened from history and mounted twice by React's development checks, and
 * each of those used to add one. The key (an order id) stays in this browser
 * and is never sent: the server still receives a bare count.
 */
const ONCE_STORAGE_KEY = 'uboss.analytics.once';
const ONCE_LIMIT = 50;
const countedThisTab = new Set<string>();

export function trackOnce(event: AnalyticsEvent, screen: string, onceKey: string): void {
  const key = `${event}:${onceKey}`;
  if (countedThisTab.has(key)) return;
  countedThisTab.add(key);
  let seen: string[] = [];
  try {
    const raw = window.localStorage.getItem(ONCE_STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    seen = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    seen = [];
  }
  if (seen.includes(key)) return;
  try {
    window.localStorage.setItem(ONCE_STORAGE_KEY, JSON.stringify([...seen, key].slice(-ONCE_LIMIT)));
  } catch {
    // Storage blocked: the in-memory set still stops a second count in this tab.
  }
  track(event, screen);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAnalytics();
  });
}

/** One `screen_view` per route a shopper lands on. Mounted once, in the layouts. */
export function usePageViewTracking(): void {
  // The data router's state rather than useMatches(): outside a data router
  // (a component test rendering a layout in MemoryRouter) this is null and
  // nothing is tracked, instead of the hook throwing.
  const state = useContext(UNSAFE_DataRouterStateContext);
  const deepest = state?.matches[state.matches.length - 1];
  const pattern = deepest === undefined ? '' : patternOf(deepest.pathname, deepest.params);
  useEffect(() => {
    if (pattern !== '') track('screen_view', pattern);
  }, [pattern]);
}

/** For tests only. */
export function pendingAnalyticsForTest(): Pending[] {
  return [...queue];
}

export function enableAnalyticsForTest(on: boolean): void {
  testSending = on;
}

export function resetAnalyticsForTest(): void {
  queue = [];
  countedThisTab.clear();
  if (timer !== null) clearTimeout(timer);
  timer = null;
}
