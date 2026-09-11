/**
 * A small ERP that actually answers.
 *
 * Every other test in this feature proves a piece in isolation: the state
 * machine refuses the wrong move, the idempotency key is stable, the mapping
 * finds a field. None of them proves the thing a buyer actually cares about -
 * that a connection, once configured, *works*: that a confirmed order becomes a
 * purchase order in a real HTTP server, under a real credential, through the
 * real address checks.
 *
 * This is that server. It is deliberately a real HTTP listener on a real
 * socket rather than a mocked `fetch`, because half of what is being tested
 * lives below `fetch`: `safeFetch` resolves the hostname itself, refuses
 * anything that is not publicly routable, pins the socket to the address it
 * checked, and re-validates every redirect. A stubbed transport would skip all
 * of that and prove nothing about the path a real request takes.
 *
 * WHY IT LISTENS ON LOOPBACK, AND WHAT THAT COSTS
 *
 * 127.0.0.1 is exactly what the SSRF guard exists to refuse, so a test using
 * this has to set `ALLOW_PRIVATE_ERP_TARGETS` - which is the same escape hatch
 * a developer uses to point a connection at a mock on their own machine, and
 * which `env.ts` refuses to start a production process with. That is the honest
 * trade: the guard is proven separately, by `customer-erp-reliability.test.ts`
 * and by `outbound-http.test.ts`, against addresses it must refuse.
 *
 * WHAT IT REMEMBERS
 *
 * Every request, so a test can assert what was actually sent rather than what
 * the connector believed it sent - and the purchase orders it has been given,
 * keyed by our order number, so it can behave the way a real ERP behaves when
 * the same document arrives twice.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  /**
   * The query string, without the `?`.
   *
   * Recorded separately from the path because it is where every paging style
   * this platform speaks puts its cursor - and because a whole class of bug
   * lives in whether those parameters reach the ERP at all.
   */
  query: string;
  /** Lower-cased names, as the server saw them. */
  headers: Record<string, string>;
  body: unknown;
  /** The bytes, for anything that needs to check a signature. */
  rawBody: string;
}

export interface MockErpOptions {
  /**
   * The key the ERP expects, and the header it expects it in.
   *
   * A request without it is answered 401, which is what makes "the credential
   * reached the ERP" a thing a test can assert rather than assume.
   */
  apiKeyHeader?: string;
  apiKey?: string;
  /**
   * Fail the first N calls to a path, then behave.
   *
   * For proving the retry path end to end: the event fails, backs off, is
   * picked up again, and succeeds under the SAME idempotency key.
   */
  failFirst?: { path: string; times: number; status?: number };
  /** Answer every write with this status, for the rejection paths. */
  forceStatus?: number;
}

export interface MockErp {
  /** `http://127.0.0.1:<port>` - what a connection's base URL is set to. */
  url: string;
  requests: RecordedRequest[];
  /** Purchase orders it holds, keyed by the `reference` we sent. */
  purchaseOrders: Map<string, Record<string, unknown>>;
  goodsReceipts: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  /** Requests to one path, for asserting what was sent. */
  requestsTo: (path: string) => RecordedRequest[];
  reset: () => void;
  close: () => Promise<void>;
}

/**
 * The request body, parsed where it is JSON and kept as text where it is not.
 *
 * A real ERP receiving something it cannot parse answers about the content, not
 * about JSON - so the raw string is passed through rather than thrown away, and
 * a test sending a malformed body can assert on what arrived.
 */
function parseBody(rawBody: string): unknown {
  if (rawBody.length === 0) return null;

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

/**
 * Our document number, as this ERP reads it off an incoming order.
 *
 * Only a string counts. A body whose `reference` is an object or an array is a
 * body this server has no document number for, and coercing one out of it would
 * key the duplicate guard on "[object Object]" - which would then match every
 * other malformed request.
 */
function referenceOf(body: unknown): string {
  if (body === null || typeof body !== 'object') return '';

  const value = (body as Record<string, unknown>)['reference'];

  return typeof value === 'string' ? value : '';
}

/**
 * Start one.
 *
 * Port 0, so the OS picks a free one and two suites running together do not
 * collide. The returned `url` is what a test puts in the connection's base URL.
 */
export async function startMockErp(options: MockErpOptions = {}): Promise<MockErp> {
  const requests: RecordedRequest[] = [];
  const purchaseOrders = new Map<string, Record<string, unknown>>();
  const goodsReceipts: Record<string, unknown>[] = [];
  const invoices: Record<string, unknown>[] = [];
  const payments: Record<string, unknown>[] = [];
  const failures = new Map<string, number>();

  let nextId = 4500000000;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));

    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      const query = (request.url ?? '').split('?')[1] ?? '';

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }

      const body = parseBody(rawBody);

      requests.push({ method: request.method ?? 'GET', path, query, headers, body, rawBody });

      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      // --- The credential ------------------------------------------------
      //
      // Checked first, exactly as a real ERP would, so a test asserting "the
      // key reached it" is asserting something the server enforced.
      if (options.apiKey !== undefined) {
        const header = (options.apiKeyHeader ?? 'x-api-key').toLowerCase();

        if (headers[header] !== options.apiKey) {
          send(401, { error: 'unauthorised', detail: 'missing or wrong API key' });
          return;
        }
      }

      // --- Deliberate failures -------------------------------------------
      if (options.failFirst !== undefined && path.startsWith(options.failFirst.path)) {
        const seen = failures.get(path) ?? 0;

        if (seen < options.failFirst.times) {
          failures.set(path, seen + 1);
          // 503 by default: a transient failure, which is the one the
          // dispatcher is supposed to retry.
          send(options.failFirst.status ?? 503, { error: 'temporarily unavailable' });
          return;
        }
      }

      if (options.forceStatus !== undefined && request.method !== 'GET') {
        send(options.forceStatus, { error: 'refused', detail: 'forced by the test' });
        return;
      }

      // --- Reads ----------------------------------------------------------
      if (request.method === 'GET' && path === '/products') {
        send(200, {
          items: [
            { sku: 'MOCK-SKU-1', name: 'Nitrile gloves, medium', quantityOnHand: 240, uom: 'BOX' },
            { sku: 'MOCK-SKU-2', name: 'Surgical mask, type IIR', quantityOnHand: 1200, uom: 'BOX' },
          ],
        });
        return;
      }

      if (request.method === 'GET' && path === '/inventory') {
        send(200, {
          items: [
            { sku: 'MOCK-SKU-1', quantityOnHand: 240, uom: 'BOX' },
            { sku: 'MOCK-SKU-2', quantityOnHand: 1200, uom: 'BOX' },
          ],
        });
        return;
      }

      // --- Purchase orders -------------------------------------------------
      if (request.method === 'POST' && path === '/purchase-orders') {
        const reference = referenceOf(body);

        /*
         * The duplicate guard a real ERP has.
         *
         * A second POST of the same document number is answered 409 rather
         * than creating a second order - which is what lets a test prove that
         * a retry cannot produce two purchase orders even against a system
         * that ignores the idempotency header entirely.
         */
        if (reference.length > 0 && purchaseOrders.has(reference)) {
          send(409, {
            error: 'duplicate',
            detail: `A purchase order with reference ${reference} already exists.`,
            id: purchaseOrders.get(reference)?.['id'],
          });
          return;
        }

        nextId += 1;
        const created = { ...(body as Record<string, unknown>), id: String(nextId) };
        if (reference.length > 0) purchaseOrders.set(reference, created);

        send(201, created);
        return;
      }

      if (request.method === 'PATCH' && path === '/purchase-orders') {
        send(200, { ...(body as Record<string, unknown>), updated: true });
        return;
      }

      if (request.method === 'POST' && path === '/goods-receipts') {
        nextId += 1;
        const created = { ...(body as Record<string, unknown>), id: String(nextId) };
        goodsReceipts.push(created);
        send(201, created);
        return;
      }

      if (request.method === 'POST' && path === '/shipments') {
        send(200, { ...(body as Record<string, unknown>), acknowledged: true });
        return;
      }

      if (request.method === 'POST' && path === '/invoices') {
        nextId += 1;
        const created = { ...(body as Record<string, unknown>), id: String(nextId) };
        invoices.push(created);
        send(201, created);
        return;
      }

      if (request.method === 'POST' && path === '/payments') {
        payments.push(body as Record<string, unknown>);
        send(200, { acknowledged: true });
        return;
      }

      send(404, { error: 'not found', path });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    purchaseOrders,
    goodsReceipts,
    invoices,
    payments,
    requestsTo: (path) => requests.filter((entry) => entry.path === path),
    reset: () => {
      requests.length = 0;
      purchaseOrders.clear();
      goodsReceipts.length = 0;
      invoices.length = 0;
      payments.length = 0;
      failures.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
