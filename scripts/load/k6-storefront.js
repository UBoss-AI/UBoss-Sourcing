/**
 * k6 load test for the storefront: browse, product page, search and sign-in.
 * These are scenarios 1-3 of docs/DEPLOYMENT.md §5.3.
 *
 * Rules (from §5.3):
 *   - Run it from your own computer, never from the VPS itself.
 *   - Point it at a server that is not yet open to the public.
 *   - Load production-like data first. A small catalogue only measures the cache.
 *
 * Run (PowerShell):
 *   $env:BASE_URL = 'https://shop.example.com'
 *   $env:LOGIN_EMAIL = 'loadtest@example.com'      # a test buyer account
 *   $env:LOGIN_PASSWORD = '...'
 *   k6 run scripts/load/k6-storefront.js
 *
 * Install k6 with: winget install k6
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const API = `${BASE}/api/v1`;
const TERMS = ['glove', 'mask', 'toy', 'box', 'steel', 'paper'];

export const options = {
  scenarios: {
    // Ramp up over 2 minutes (warm-up), then hold for 10 minutes.
    browse: {
      executor: 'ramping-vus',
      exec: 'browse',
      stages: [
        { duration: '2m', target: Number(__ENV.VUS || 50) },
        { duration: '10m', target: Number(__ENV.VUS || 50) },
        { duration: '30s', target: 0 },
      ],
    },
    // Sign-in is CPU-heavy by design, so it runs at a low, steady rate.
    login: {
      executor: 'constant-arrival-rate',
      exec: 'login',
      rate: Number(__ENV.LOGIN_RATE || 2),
      timeUnit: '1s',
      duration: '12m',
      preAllocatedVUs: 10,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:browse}': ['p(95)<800'],
    'http_req_duration{kind:search}': ['p(95)<1200'],
    'http_req_duration{kind:login}': ['p(95)<2000'],
  },
};

export function browse() {
  const list = http.get(`${API}/catalog/products?pageSize=24`, { tags: { kind: 'browse' } });
  check(list, { 'catalogue 200': (r) => r.status === 200 });
  const products = list.status === 200 ? list.json('products') || [] : [];
  sleep(1);

  if (products.length > 0) {
    const pick = products[Math.floor(Math.random() * products.length)];
    const page = http.get(`${API}/catalog/products/${pick.slug}`, { tags: { kind: 'browse' } });
    check(page, { 'product 200': (r) => r.status === 200 });
    sleep(1);
  }

  const q = TERMS[Math.floor(Math.random() * TERMS.length)];
  const search = http.get(`${API}/catalog/search?q=${q}`, { tags: { kind: 'search' } });
  check(search, { 'search 200': (r) => r.status === 200 });
  sleep(2);
}

export function login() {
  if (!__ENV.LOGIN_EMAIL) return;
  const res = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email: __ENV.LOGIN_EMAIL, password: __ENV.LOGIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, tags: { kind: 'login' } },
  );
  // A 429 means the sign-in rate limit has kicked in. That is the limit working, not a crash.
  check(res, { 'login ok or rate-limited': (r) => r.status === 200 || r.status === 429 });
}
