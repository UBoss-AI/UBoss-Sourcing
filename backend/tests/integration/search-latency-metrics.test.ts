/**
 * Search latency is measured, per route, where an operator can watch it.
 *
 * The storefront's search bar hands off to the catalogue listing, so the
 * listing route's latency IS the search latency a shopper feels. What is
 * asserted here is that every search lands in the request-duration histogram
 * under the registered path — never the URL with the search term in it, which
 * would put what people typed into the metrics store and grow a new time
 * series per query.
 *
 * Reads only: no rows are written, so there is nothing to clean up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const SERIES =
  'uboss_http_request_duration_seconds_count{service="uboss-api",method="GET",route="/api/v1/catalog/products",status="200"}';

/** The current count of catalogue searches in the histogram, 0 if none yet. */
async function searchCount(): Promise<number> {
  const response = await app.inject({ method: 'GET', url: '/metrics' });
  expect(response.statusCode).toBe(200);

  const line = response.body.split('\n').find((row) => row.startsWith(SERIES));
  return line === undefined ? 0 : Number(line.slice(SERIES.length).trim());
}

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('search latency monitoring', () => {
  it('records each catalogue search under the registered route, not the typed term', async () => {
    const before = await searchCount();

    const term = 'latency-probe-term-7f3a';
    const search = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products?q=${term}`,
    });
    expect(search.statusCode).toBe(200);

    expect(await searchCount()).toBe(before + 1);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).not.toContain(term);
    // The buckets the targets are read against are present for the series.
    expect(metrics.body).toContain(
      'uboss_http_request_duration_seconds_bucket{le="0.5",service="uboss-api",method="GET",route="/api/v1/catalog/products",status="200"}',
    );
  });
});
