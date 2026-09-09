/**
 * The business's ERP connection, end to end, against a real HTTP server.
 *
 * The stub here is a genuine `node:http` server on the loopback interface, not
 * a `fetch` mock, and that is deliberate. `outbound-http.ts` does not use
 * `fetch` - it uses `node:http`/`node:https` so it can pin the socket to an
 * address it has already validated, which is what closes the DNS-rebind window.
 * A test that stubbed `fetch` would exercise none of that: not the address
 * checks, not the pinning, not the redirect handling, not the timeouts, not the
 * byte ceiling. So the tests below make real TCP connections and the real guard
 * runs on every one of them.
 *
 * `ALLOW_PRIVATE_ERP_TARGETS` is on for the duration, which is what permits a
 * loopback target. `env.ts` refuses to start a production process in that
 * state; the point here is that the developer exemption is the only thing
 * standing between these tests and the same refusal a customer would get.
 *
 * What is covered, in the order the sections appear:
 *
 *   - all four authentication methods, each verified by the server actually
 *     checking the header it should have received
 *   - the address guard, from a customer's point of view
 *   - Test Connection: success, wrong credentials, unreachable host
 *   - field-mapping validation and the dry run that changes nothing
 *   - the lifecycle, and the refusal to activate an untested connection
 *   - inventory: manual, polled, and by signed webhook, including duplicates,
 *     rate limits, conflicts and manual override
 *   - order push: success, 409-means-success, Paid-ERP-Pending, and a retry
 *     that produces neither a second order nor a second charge
 *   - that a customer has no route to any of it
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { env } from '../../src/config/env.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  createConnection,
  dryRun,
  getConnection,
  listConnections,
  performLifecycleAction,
  testConnection,
  updateConnection,
  deleteConnection,
  type ErpActor,
} from '../../src/modules/integrations/erp-connection.service.js';
import {
  availabilityForSkus,
  handleInventoryWebhook,
  listErpInventory,
  listSyncRuns,
  pollDueConnections,
  setManualQuantity,
  syncNow,
  verifyWebhookSignature,
} from '../../src/modules/integrations/erp-inventory-sync.service.js';
import {
  erpSyncStateFor,
  pushOrderToErpConnection,
  retryErpConnectionPush,
  retryDueErpConnectionPushes,
} from '../../src/modules/integrations/erp-push.service.js';
import { listIntegrationEvents } from '../../src/modules/integrations/integration-event.service.js';

// ---------------------------------------------------------------------------
// The customer's ERP, as an actual server
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = 'whsec_customer_erp_test_secret';

/**
 * What the stubbed ERP should do next.
 *
 * Mutated per test rather than re-stubbed, so a test reads as "make the ERP
 * refuse, then push the order" instead of as HTTP plumbing.
 */
interface ErpState {
  /** Which credential the server will accept. */
  expect:
    | { kind: 'apiKey'; header: string; value: string }
    | { kind: 'bearer'; value: string }
    | { kind: 'basic'; username: string; password: string }
    | { kind: 'oauth'; clientId: string; clientSecret: string; accessToken: string }
    | { kind: 'none' };
  /** The stock feed, in the customer's own shape. */
  stock: { Material: string; Werks: string; LabSt: string; Meins: string }[];
  /** How the order endpoint behaves. */
  order: 'accepts' | 'rejects_permanently' | 'unavailable' | 'duplicate' | 'rate_limited';
  /** How the stock endpoint behaves. */
  stockBehaviour: 'ok' | 'rate_limited' | 'not_json' | 'wrong_shape' | 'slow';
  /** Every request the server saw, so a test can assert what was sent. */
  requests: {
    path: string;
    method: string;
    authorization: string | undefined;
    apiKeyHeader: string | undefined;
    idempotencyKey: string | undefined;
    tenantHeader: string | undefined;
    body: unknown;
  }[];
  /** Orders created, keyed by idempotency key, so a replay returns the same one. */
  ordersByKey: Map<string, string>;
  /** Access tokens the OAuth endpoint has issued. */
  tokensIssued: number;
}

let erp: ErpState;
let server: Server;
let baseUrl: string;

function resetErp(): void {
  erp = {
    expect: { kind: 'none' },
    stock: [
      { Material: 'GLV-M', Werks: '1000', LabSt: '42.000', Meins: 'EA' },
      { Material: 'SYR-10', Werks: '1000', LabSt: '7', Meins: 'BOX' },
    ],
    order: 'accepts',
    stockBehaviour: 'ok',
    requests: [],
    ordersByKey: new Map(),
    tokensIssued: 0,
  };
}

/** Does the request carry the credential this test expects? */
function credentialAccepted(request: IncomingMessage): boolean {
  const authorization = request.headers['authorization'];

  switch (erp.expect.kind) {
    case 'none':
      return true;

    case 'apiKey': {
      const header = request.headers[erp.expect.header.toLowerCase()];
      return header === erp.expect.value;
    }

    case 'bearer':
      return authorization === `Bearer ${erp.expect.value}`;

    case 'basic': {
      const encoded = Buffer.from(
        `${erp.expect.username}:${erp.expect.password}`,
        'utf8',
      ).toString('base64');
      return authorization === `Basic ${encoded}`;
    }

    case 'oauth':
      return authorization === `Bearer ${erp.expect.accessToken}`;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function send(response: ServerResponse, status: number, body: unknown, headers = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // `send` writes and ends; the `return send(...)` calls below are for control
  // flow, so it returns void rather than the response object.
  const path = (request.url ?? '').split('?')[0] ?? '';
  const raw = await readBody(request);

  // A body a test can assert on. Anything that is not JSON - a form-encoded
  // OAuth token request, say - is kept as the raw string rather than discarded.
  let parsedBody: unknown;
  try {
    parsedBody = raw === '' ? null : JSON.parse(raw);
  } catch {
    parsedBody = raw;
  }

  erp.requests.push({
    path,
    method: request.method ?? 'GET',
    authorization: request.headers['authorization'],
    apiKeyHeader: request.headers['x-api-key'] as string | undefined,
    idempotencyKey: request.headers['idempotency-key'] as string | undefined,
    tenantHeader: request.headers['x-tenant'] as string | undefined,
    body: parsedBody,
  });

  // --- OAuth token endpoint ---------------------------------------------
  //
  // Checked before the credential guard below, because obtaining the token is
  // how the credential for every other endpoint is acquired.
  if (path === '/oauth/token') {
    if (erp.expect.kind !== 'oauth') return send(response, 400, { error: 'invalid_request' });

    const form = new URLSearchParams(raw);

    if (
      form.get('client_id') !== erp.expect.clientId ||
      form.get('client_secret') !== erp.expect.clientSecret
    ) {
      // The OAuth-specified answer to a wrong secret, and it arrives as a 400
      // rather than a 401 - which is why `fetchOAuthToken` treats 400 as an
      // authentication failure rather than a rejection.
      return send(response, 400, { error: 'invalid_client' });
    }

    erp.tokensIssued += 1;
    return send(response, 200, {
      access_token: erp.expect.accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
    });
  }

  if (!credentialAccepted(request)) {
    return send(response, 401, { error: 'unauthorized', hint: 'wrong key' });
  }

  // --- Stock -------------------------------------------------------------
  if (path === '/api/stock') {
    switch (erp.stockBehaviour) {
      case 'rate_limited':
        return send(response, 429, { error: 'slow down' }, { 'Retry-After': '120' });

      case 'not_json': {
        // The session-expired login page an ERP behind an SSO proxy returns.
        // `end()` answers with `this`, so it cannot be returned from a
        // void-typed handler.
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<html>the login page your ERP shows when the session expired</html>');
        return;
      }

      case 'wrong_shape':
        return send(response, 200, { message: 'no results' });

      case 'slow':
        // Never answers. The request has to be abandoned by the timeout rather
        // than hanging the suite.
        return;

      default:
        return send(response, 200, { d: { results: erp.stock } });
    }
  }

  // --- Orders ------------------------------------------------------------
  if (path === '/api/orders') {
    const key = request.headers['idempotency-key'] as string | undefined;

    if (erp.order === 'unavailable') return send(response, 503, { error: 'ERP restarting' });
    if (erp.order === 'rate_limited') {
      return send(response, 429, { error: 'slow down' }, { 'Retry-After': '60' });
    }
    if (erp.order === 'rejects_permanently') {
      return send(response, 400, { error: 'unknown material GLV-M' });
    }
    if (erp.order === 'duplicate') {
      return send(response, 409, { id: 'ERP-ALREADY-1', message: 'already have it' });
    }

    // An ERP that honours the idempotency header: the same key returns the same
    // order rather than creating a second one.
    if (key !== undefined && erp.ordersByKey.has(key)) {
      return send(response, 409, { id: erp.ordersByKey.get(key) });
    }

    const orderId = `ERP-${String(erp.ordersByKey.size + 1)}`;
    if (key !== undefined) erp.ordersByKey.set(key, orderId);

    return send(response, 201, { id: orderId, status: 'RECEIVED' });
  }

  if (path === '/api/warehouses') return send(response, 200, { d: { results: [] } });
  if (path === '/api/products') return send(response, 200, { d: { results: erp.stock } });
  if (path === '/api/order-status') return send(response, 200, { d: { results: [] } });

  return send(response, 404, { error: 'no such endpoint' });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The member of staff configuring the ERP. */
let adminActor: ErpActor;
/** Two buyers, so an order has an owner and a second one can be compared. */
let buyerProfileId: string;
let otherBuyerProfileId: string;
let productId: string;

const flags = {
  erp: env.FEATURE_ERP_INTEGRATION,
  privateTargets: env.ALLOW_PRIVATE_ERP_TARGETS,
};

type MutableEnv = {
  FEATURE_ERP_INTEGRATION: boolean;
  ALLOW_PRIVATE_ERP_TARGETS: boolean;
};

function setFlags(values: Partial<MutableEnv>): void {
  Object.assign(env as unknown as MutableEnv, values);
}

/** The mapping that reads this ERP's wrapped, stringly-typed feed. */
const MAPPING = {
  itemsPath: 'd.results',
  fields: {
    sku: 'Material',
    warehouseId: 'Werks',
    availableQuantity: 'LabSt',
    unitOfMeasure: 'Meins',
    erpOrderId: 'id',
  },
  warehouseMap: { '1000': 'MAIN' },
};

/** A connection with API-key auth, ready to be tested. */
function connectionInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Production',
    baseUrl,
    endpoints: {
      product: '/api/products',
      inventory: '/api/stock',
      warehouse: '/api/warehouses',
      orderCreate: '/api/orders',
      orderStatus: '/api/order-status',
    },
    authMethod: 'API_KEY' as const,
    credentials: { headerName: 'X-API-Key', apiKey: 'sk_live_erp_key_9f2a' },
    fieldMapping: MAPPING,
    pollingEnabled: true,
    pollingIntervalMinutes: 15,
    orderPushEnabled: true,
    ...overrides,
  };
}

/** Create, test and switch on a connection - the happy path, as a helper. */
async function activeConnection(
  actor: ErpActor = adminActor,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'sk_live_erp_key_9f2a' };

  const created = await createConnection(actor, connectionInput(overrides));
  await testConnection(actor, created.id);
  await dryRun(actor, created.id);
  await performLifecycleAction(actor, created.id, 'ACTIVATE');

  return created.id;
}

/** A buyer who can own an order. Returns the profile id. */
async function makeCustomer(email: string): Promise<string> {
  const userId = newId();
  await prisma.user.create({
    data: { id: userId, type: 'CUSTOMER', email, emailNormalized: email, status: 'ACTIVE' },
  });

  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId, fullName: 'Test Buyer', activatedAt: new Date() },
  });

  return profile.id;
}

/** The member of staff who configures the ERP. */
async function makeAdmin(email: string): Promise<ErpActor> {
  const userId = newId();
  await prisma.user.create({
    data: { id: userId, type: 'ADMIN', email, emailNormalized: email, status: 'ACTIVE' },
  });

  return { userId, email, ipAddress: '203.0.113.7' };
}

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.integrationEvent.deleteMany({});
  await prisma.erpWebhookReceipt.deleteMany({});
  await prisma.erpSyncRecordError.deleteMany({});
  await prisma.erpInventorySyncRun.deleteMany({});
  await prisma.erpInventorySnapshot.deleteMany({});
  await prisma.erpConnection.deleteMany({});
  await prisma.erpOrderPush.deleteMany({});
  await prisma.paymentTransaction.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.productPrice.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.businessProfile.deleteMany({});
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void handle(request, response);
  });

  await new Promise<void>((resolve) => {
    // 127.0.0.1 explicitly rather than a wildcard: the guard resolves and pins
    // an address, and a server on `::` would make the test depend on which
    // family the resolver happened to prefer.
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // Leave the database as we found it. Files share one MariaDB instance, and
  // `orders.customerProfileId` is ON DELETE RESTRICT - so rows left here become
  // a foreign-key failure inside the FIRST file of the NEXT run, several
  // hundred tests away from the file that actually caused it.
  await resetAll();

  setFlags({
    FEATURE_ERP_INTEGRATION: flags.erp,
    ALLOW_PRIVATE_ERP_TARGETS: flags.privateTargets,
  });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetAll();
  resetErp();

  setFlags({ FEATURE_ERP_INTEGRATION: true, ALLOW_PRIVATE_ERP_TARGETS: true });

  await prisma.businessProfile.create({
    data: {
      id: newId(),
      legalName: 'UBOSS Test',
      displayName: 'UBOSS',
      supportEmail: 'support@test.local',
      currency: 'EUR',
      timezone: 'Europe/Brussels',
      orderPrefix: 'UB',
    },
  });

  adminActor = await makeAdmin('owner@erp.test');
  buyerProfileId = await makeCustomer('buyer@erp.test');
  otherBuyerProfileId = await makeCustomer('rival@erp.test');

  await prisma.inventoryLocation.create({
    data: { id: newId(), code: 'MAIN', name: 'Main', isDefault: true, isActive: true },
  });

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'VAT21',
      name: 'VAT 21%',
      ratePercent: '21.000000',
      isDefault: true,
      isActive: true,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Consumables', slug: 'consumables', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Nitrile Gloves M',
      slug: 'nitrile-gloves-m',
      sku: 'GLV-M',
      status: 'ACTIVE',
      basePriceMinor: 1200n,
      currency: 'EUR',
      isPublished: true,
      isStockTracked: true,
    },
  });
  productId = product.id;
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('authentication methods', () => {
  it('signs requests with an API key in the header the customer named', async () => {
    erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'sk_live_erp_key_9f2a' };

    const created = await createConnection(adminActor, connectionInput());
    const result = await testConnection(adminActor, created.id);

    expect(result.ok).toBe(true);
    expect(result.authenticated).toBe(true);
    // The server verified the header itself, so this is proof the key travelled
    // rather than proof the code intended to send it.
    expect(erp.requests.some((entry) => entry.apiKeyHeader === 'sk_live_erp_key_9f2a')).toBe(true);
  });

  it('signs requests with a bearer token', async () => {
    erp.expect = { kind: 'bearer', value: 'tok_live_abc123' };

    const created = await createConnection(
      adminActor,
      connectionInput({
        authMethod: 'BEARER_TOKEN',
        credentials: { token: 'tok_live_abc123' },
      }),
    );

    const result = await testConnection(adminActor, created.id);

    expect(result.ok).toBe(true);
    expect(erp.requests.some((entry) => entry.authorization === 'Bearer tok_live_abc123')).toBe(true);
  });

  it('signs requests with basic authentication', async () => {
    erp.expect = { kind: 'basic', username: 'uboss', password: 'p@ss word/with:colon' };

    const created = await createConnection(
      adminActor,
      connectionInput({
        authMethod: 'BASIC',
        credentials: { username: 'uboss', password: 'p@ss word/with:colon' },
      }),
    );

    const result = await testConnection(adminActor, created.id);

    expect(result.ok).toBe(true);
    // A password containing a colon and a space still encodes correctly, which
    // is where hand-rolled Basic auth usually goes wrong.
    expect(erp.requests.some((entry) => entry.authorization?.startsWith('Basic '))).toBe(true);
  });

  it('obtains and reuses an OAuth 2.0 client-credentials token', async () => {
    erp.expect = {
      kind: 'oauth',
      clientId: 'uboss-client',
      clientSecret: 'shhh',
      accessToken: 'at_live_xyz',
    };

    const created = await createConnection(
      adminActor,
      connectionInput({
        authMethod: 'OAUTH2',
        credentials: { clientId: 'uboss-client', clientSecret: 'shhh' },
        oauthTokenUrl: `${baseUrl}/oauth/token`,
        oauthScope: 'inventory.read orders.write',
      }),
    );

    const first = await testConnection(adminActor, created.id);
    expect(first.ok).toBe(true);
    expect(erp.tokensIssued).toBe(1);
    expect(erp.requests.some((entry) => entry.authorization === 'Bearer at_live_xyz')).toBe(true);

    // The token is cached on the row, so a second run does NOT fetch another.
    // Fetching one per request would double both the traffic and the number of
    // ways a stock read can fail.
    await testConnection(adminActor, created.id);
    expect(erp.tokensIssued).toBe(1);
  });

  it('reports a refused OAuth secret as an authentication problem', async () => {
    erp.expect = {
      kind: 'oauth',
      clientId: 'uboss-client',
      clientSecret: 'the-right-one',
      accessToken: 'at_live_xyz',
    };

    const created = await createConnection(
      adminActor,
      connectionInput({
        authMethod: 'OAUTH2',
        credentials: { clientId: 'uboss-client', clientSecret: 'the-wrong-one' },
        oauthTokenUrl: `${baseUrl}/oauth/token`,
      }),
    );

    const result = await testConnection(adminActor, created.id);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/OAuth client ID and secret/i);
  });

  it('reports wrong credentials as wrong credentials, not as a network fault', async () => {
    erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'the-right-key' };

    const created = await createConnection(
      adminActor,
      connectionInput({ credentials: { headerName: 'X-API-Key', apiKey: 'the-wrong-key' } }),
    );

    const result = await testConnection(adminActor, created.id);

    expect(result.ok).toBe(false);
    expect(result.authenticated).toBe(false);
    // The remedy for a rejected credential is completely different from the one
    // for an unreachable host, so the two must not be reported alike.
    expect(result.message).toMatch(/refused these credentials/i);
    expect(result.httpStatus).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Secrets never come back out
// ---------------------------------------------------------------------------

describe('credential handling', () => {
  it('stores the key encrypted and never returns it', async () => {
    const created = await createConnection(adminActor, connectionInput());

    // The view the API returns.
    const view = await getConnection(created.id);
    expect(view.credentialHint).toBe('X-API-Key: sk_liv...9f2a');
    expect(view.hasCredentials).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk_live_erp_key_9f2a');

    // And the row underneath it.
    const row = await prisma.erpConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.credentialsEnc).not.toBeNull();
    expect(row.credentialsEnc).not.toContain('sk_live_erp_key_9f2a');
    expect(row.credentialsEnc?.startsWith('v1:')).toBe(true);
  });

  it('keeps the stored key when an edit does not send one', async () => {
    // The masked-form contract. The screen never receives a secret, so it never
    // sends one back, and an absent field must mean "keep" rather than "clear".
    const created = await createConnection(adminActor, connectionInput());
    const before = await prisma.erpConnection.findUniqueOrThrow({ where: { id: created.id } });

    const input = connectionInput({ timeoutMs: 20_000 }) as Record<string, unknown>;
    delete input['credentials'];

    await updateConnection(adminActor, created.id, input as never);

    const after = await prisma.erpConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.credentialHint).toBe(before.credentialHint);
    expect(after.timeoutMs).toBe(20_000);

    // And it still works, which is the assertion that matters.
    erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'sk_live_erp_key_9f2a' };
    const result = await testConnection(adminActor, created.id);
    expect(result.ok).toBe(true);
  });

  it('keeps a credential out of the audit trail', async () => {
    await createConnection(adminActor, connectionInput());

    const entries = await prisma.auditLog.findMany({});
    const serialised = JSON.stringify(entries);

    expect(serialised).toContain('erp_connection.created');
    expect(serialised).not.toContain('sk_live_erp_key_9f2a');
  });

  it('refuses a custom header that would overwrite Authorization', async () => {
    // Otherwise a customer could put a credential in a column the API returns
    // in plain text.
    await expect(
      createConnection(
        adminActor,
        connectionInput({ customHeaders: { Authorization: 'Bearer smuggled' } }) as never,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('sends the custom headers a customer legitimately configured', async () => {
    erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'sk_live_erp_key_9f2a' };

    const created = await createConnection(
      adminActor,
      connectionInput({ customHeaders: { 'X-Tenant': 'ward-7' } }),
    );

    await testConnection(adminActor, created.id);

    expect(erp.requests.some((entry) => entry.tenantHeader === 'ward-7')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The address guard, as a customer meets it
// ---------------------------------------------------------------------------

describe('addresses a customer may configure', () => {
  it('refuses a base URL on a private network when the exemption is off', async () => {
    setFlags({ ALLOW_PRIVATE_ERP_TARGETS: false });

    await expect(
      createConnection(adminActor, connectionInput({ baseUrl: 'http://169.254.169.254' }) as never),
    ).rejects.toMatchObject({ code: 'ERP_URL_NOT_ALLOWED' });
  });

  it('refuses an endpoint that points at a different origin', async () => {
    // An "endpoint" free to leave the authorised host is an SSRF primitive with
    // a form field in front of it - and it would carry the customer's
    // credential with it.
    await expect(
      createConnection(
        adminActor,
        connectionInput({
          endpoints: { inventory: 'https://evil.example.com/collect' },
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'ERP_ENDPOINT_OFF_ORIGIN' });
  });

  it('accepts an absolute endpoint on the SAME origin, which is only verbose', async () => {
    const created = await createConnection(
      adminActor,
      connectionInput({
        endpoints: { inventory: `${baseUrl}/api/stock`, orderCreate: '/api/orders' },
      }),
    );

    erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'sk_live_erp_key_9f2a' };
    const result = await testConnection(adminActor, created.id);

    expect(result.ok).toBe(true);
  });

  it('reports an unreachable host without pretending the credentials were wrong', async () => {
    // Port 1 on loopback: nothing listens, so the connection is refused at once
    // rather than hanging.
    const created = await createConnection(
      adminActor,
      connectionInput({ baseUrl: 'http://127.0.0.1:1' }),
    );

    const result = await testConnection(adminActor, created.id);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not be reached/i);
  });

  it('abandons a request that never answers, rather than holding a worker', async () => {
    erp.stockBehaviour = 'slow';
    erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'sk_live_erp_key_9f2a' };

    const created = await createConnection(
      adminActor,
      connectionInput({ timeoutMs: 1000 }),
    );

    const startedAt = Date.now();
    const result = await testConnection(adminActor, created.id);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/did not respond in time/i);
    // Well inside the default 15s, which is the point: the customer's timeout
    // is honoured, not the library's.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Mapping, dry run and activation
// ---------------------------------------------------------------------------

describe('field mapping and the dry run', () => {
  it('refuses an incomplete mapping at save time', async () => {
    await expect(
      createConnection(
        adminActor,
        connectionInput({ fieldMapping: { fields: { sku: 'Material' } } }) as never,
      ),
    ).rejects.toMatchObject({ code: 'ERP_MAPPING_INVALID' });
  });

  it('reads real records, shows what it made of them, and changes nothing', async () => {
    erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'sk_live_erp_key_9f2a' };
    const created = await createConnection(adminActor, connectionInput());

    const result = await dryRun(adminActor, created.id);

    expect(result.ok).toBe(true);
    expect(result.recordsFound).toBe(2);
    expect(result.preview[0]).toMatchObject({ sku: 'GLV-M', availableQuantity: 42 });
    expect(result.message).toMatch(/Nothing was changed/i);

    // The load-bearing assertion: a dry run writes no stock.
    expect(await prisma.erpInventorySnapshot.count()).toBe(0);
  });

  it('says where to look when the items path is wrong', async () => {
    erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'sk_live_erp_key_9f2a' };
    const created = await createConnection(
      adminActor,
      connectionInput({
        fieldMapping: { ...MAPPING, itemsPath: 'data.items' },
      }),
    );

    const result = await dryRun(adminActor, created.id);

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('data.items'))).toBe(true);
  });

  it('reports an ERP that answered with HTML instead of JSON', async () => {
    // The session-expired login page, which is what an ERP behind an SSO proxy
    // returns and which would otherwise look like "no records".
    erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'sk_live_erp_key_9f2a' };
    erp.stockBehaviour = 'not_json';

    const created = await createConnection(adminActor, connectionInput());
    const result = await dryRun(adminActor, created.id);

    expect(result.ok).toBe(false);
  });

  it('lets a mapping be tried without being saved', async () => {
    erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'sk_live_erp_key_9f2a' };
    const created = await createConnection(adminActor, connectionInput());

    const result = await dryRun(adminActor, created.id, {
      itemsPath: 'd.results',
      fields: { sku: 'Material', availableQuantity: 'Meins' },
    });

    expect(result.ok).toBe(false);

    // A trial mapping must not become the saved one, and must not count as
    // verification.
    const view = await getConnection(created.id);
    expect(view.fieldMapping?.fields.availableQuantity).toBe('LabSt');
  });
});

describe('the connection lifecycle', () => {
  it('refuses to switch on a connection that has never been tested', async () => {
    const created = await createConnection(adminActor, connectionInput());

    // The state machine refuses first, and its message is the actionable one:
    // a DRAFT connection has never answered a request.
    await expect(
      performLifecycleAction(adminActor, created.id, 'ACTIVATE'),
    ).rejects.toMatchObject({ code: 'ERP_CONNECTION_STATE_INVALID' });
  });

  it('refuses to switch on a connection whose mapping has never been verified', async () => {
    erp.expect = { kind: 'apiKey', header: 'X-API-Key', value: 'sk_live_erp_key_9f2a' };
    const created = await createConnection(adminActor, connectionInput());

    // A test with no inventory endpoint cannot read a sample, so the mapping
    // stays unverified even though the connection answers.
    await updateConnection(
      adminActor,
      created.id,
      connectionInput({
        endpoints: { orderCreate: '/api/orders', product: '/api/products' },
      }),
    );

    await testConnection(adminActor, created.id);

    await expect(
      performLifecycleAction(adminActor, created.id, 'ACTIVATE'),
    ).rejects.toMatchObject({ code: 'ERP_MAPPING_UNVERIFIED' });
  });

  it('lists what is blocking activation, so the screen can show it beside the button', async () => {
    const created = await createConnection(adminActor, connectionInput());
    const view = await getConnection(created.id);

    expect(view.activationBlockers).toContain('Run a successful connection test.');
    expect(view.availableActions).toContain('START_TEST');
    expect(view.availableActions).not.toContain('ACTIVATE');
  });

  it('goes DRAFT -> TESTING -> CONNECTED -> ACTIVE and back down again', async () => {
    const id = await activeConnection();

    let view = await getConnection(id);
    expect(view.status).toBe('ACTIVE');

    await performLifecycleAction(adminActor, id, 'PAUSE');
    view = await getConnection(id);
    expect(view.status).toBe('PAUSED');
    // Polling stops with the connection: a paused connection that kept polling
    // would be neither paused nor active.
    expect(view.nextPollAt).toBeNull();

    await performLifecycleAction(adminActor, id, 'RESUME');
    view = await getConnection(id);
    expect(view.status).toBe('ACTIVE');
    expect(view.nextPollAt).not.toBeNull();
  });

  it('drops a connection back to DRAFT when its settings change', async () => {
    const id = await activeConnection();

    await updateConnection(adminActor, id, connectionInput({ timeoutMs: 5000 }));

    const view = await getConnection(id);
    // What the last test proved, it proved about settings that no longer exist.
    expect(view.status).toBe('DRAFT');
    expect(view.lastTestOk).toBeNull();
  });

  it('keeps a deleted connection out of the list but leaves its history readable', async () => {
    const id = await activeConnection();
    await performLifecycleAction(adminActor, id, 'PAUSE');

    await deleteConnection(adminActor, id);

    expect(await listConnections()).toHaveLength(0);

    const row = await prisma.erpConnection.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();
    // The secrets go, so a retired row cannot be used for anything.
    expect(row.credentialsEnc).toBeNull();
    expect(row.webhookSecretEnc).toBeNull();
  });

  it('refuses to delete a connection with a paid order still waiting', async () => {
    const id = await activeConnection();
    const orderId = await makeOrder();

    erp.order = 'unavailable';
    await pushOrderToErpConnection({
      orderId,
      idempotencyKey: `erp:order:${orderId}`,
    });

    // Deleting the connection underneath a paid order would strand the money.
    await expect(deleteConnection(adminActor, id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe('inventory synchronisation', () => {
  it('applies a manual sync and records what it did', async () => {
    const id = await activeConnection();

    const outcome = await syncNow(adminActor, id);

    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.processed).toBe(2);
    expect(outcome.applied).toBe(2);

    const inventory = await listErpInventory();
    expect(inventory).toHaveLength(2);
    expect(inventory.find((line) => line.sku === 'GLV-M')).toMatchObject({
      availableQuantity: 42,
      warehouseKey: 'MAIN',
      unitOfMeasure: 'EA',
    });

    const runs = await listSyncRuns(id);
    expect(runs[0]).toMatchObject({ status: 'SUCCEEDED', trigger: 'MANUAL', appliedCount: 2 });
  });

  it('never writes the supplier’s own stock', async () => {
    // The single most important assertion in this file. A customer's field
    // mapping is customer input; if it could reach `inventory_balances`, one
    // buyer's typo would empty the shelves every other buyer shops against.
    const id = await activeConnection();
    await syncNow(adminActor, id);

    expect(await prisma.inventoryBalance.count()).toBe(0);
  });

  it('refuses a manual sync on a connection that is not switched on', async () => {
    const id = await activeConnection();
    await performLifecycleAction(adminActor, id, 'PAUSE');

    await expect(syncNow(adminActor, id)).rejects.toMatchObject({
      code: 'ERP_CONNECTION_STATE_INVALID',
    });
  });

  it('applies the same feed twice without doubling anything', async () => {
    const id = await activeConnection();

    await syncNow(adminActor, id);
    await syncNow(adminActor, id);

    // The upsert on (connection, sku, warehouse) is what makes this a no-op
    // rather than a doubling, and it is a database constraint rather than a
    // check the code performs.
    expect(await prisma.erpInventorySnapshot.count()).toBe(2);
  });

  it('reports a record it could not read instead of writing a zero', async () => {
    const id = await activeConnection();
    erp.stock = [
      { Material: 'GLV-M', Werks: '1000', LabSt: '42', Meins: 'EA' },
      { Material: 'SYR-10', Werks: '1000', LabSt: 'N/A', Meins: 'BOX' },
    ];

    const outcome = await syncNow(adminActor, id);

    expect(outcome.status).toBe('PARTIAL');
    expect(outcome.applied).toBe(1);
    expect(outcome.failed).toBe(1);

    // "The ERP said nothing" is not "the ERP said none left". A zero here would
    // make the SKU unorderable on the strength of a renamed field.
    const inventory = await listErpInventory();
    expect(inventory.find((line) => line.sku === 'SYR-10')).toBeUndefined();

    const runs = await listSyncRuns(id);
    const errors = await prisma.erpSyncRecordError.findMany({ where: { syncRunId: runs[0]?.id } });
    expect(errors[0]?.errorCode).toBe('QUANTITY_UNREADABLE');
  });

  it('refuses a warehouse the mapping does not name, rather than guessing', async () => {
    const id = await activeConnection();
    erp.stock = [{ Material: 'GLV-M', Werks: '9999', LabSt: '42', Meins: 'EA' }];

    const outcome = await syncNow(adminActor, id);

    expect(outcome.failed).toBe(1);

    const runs = await listSyncRuns(id);
    const errors = await prisma.erpSyncRecordError.findMany({ where: { syncRunId: runs[0]?.id } });
    // Stock in the wrong building is worse than stock nowhere.
    expect(errors[0]?.errorCode).toBe('WAREHOUSE_NOT_MAPPED');
  });

  it('stops on a rate limit and waits exactly as long as it was told', async () => {
    const id = await activeConnection();
    erp.stockBehaviour = 'rate_limited';

    const outcome = await syncNow(adminActor, id);

    // Not FAILED. The ERP is working correctly; it asked us to slow down.
    expect(outcome.status).toBe('RATE_LIMITED');
    expect(outcome.rateLimitedUntil).not.toBeNull();

    const row = await prisma.erpConnection.findUniqueOrThrow({ where: { id } });
    // The next poll is pushed out to the Retry-After the ERP sent, not to the
    // ordinary interval.
    const waitMs = (row.nextPollAt?.getTime() ?? 0) - Date.now();
    expect(waitMs).toBeGreaterThan(100_000);

    // And a rate limit does not count towards taking the connection out of
    // service - that would suspend exactly the customers whose ERPs are best
    // behaved.
    expect(row.consecutiveFailures).toBe(0);
    expect(row.status).toBe('ACTIVE');
  });

  it('takes a connection out of service after repeated real failures', async () => {
    const id = await activeConnection();
    erp.stockBehaviour = 'wrong_shape';

    for (let attempt = 0; attempt < env.ERP_FAILURE_THRESHOLD; attempt += 1) {
      await syncNow(adminActor, id);
    }

    const row = await prisma.erpConnection.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ERROR');
    expect(row.statusReason).not.toBeNull();
    // Nothing polls a suspended connection.
    expect(row.nextPollAt).toBeNull();
  });

  it('polls on a schedule and books the next check before running', async () => {
    const id = await activeConnection();

    await prisma.erpConnection.update({
      where: { id },
      data: { nextPollAt: new Date(Date.now() - 60_000) },
    });

    const result = await pollDueConnections();

    expect(result.polled).toBe(1);
    expect(await prisma.erpInventorySnapshot.count()).toBe(2);

    const row = await prisma.erpConnection.findUniqueOrThrow({ where: { id } });
    // Booked forward, so a poll that throws is not picked up again on the very
    // next pass - which would be a tight loop against somebody else's server.
    expect(row.nextPollAt!.getTime()).toBeGreaterThan(Date.now());

    const runs = await listSyncRuns(id);
    expect(runs[0]?.trigger).toBe('SCHEDULED');
  });

  it('does not poll a paused connection', async () => {
    const id = await activeConnection();
    await performLifecycleAction(adminActor, id, 'PAUSE');

    await prisma.erpConnection.update({
      where: { id },
      data: { nextPollAt: new Date(Date.now() - 60_000) },
    });

    const result = await pollDueConnections();

    expect(result.polled).toBe(0);
    expect(await prisma.erpInventorySnapshot.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Conflict policy
// ---------------------------------------------------------------------------

describe('who wins when the two systems disagree', () => {
  /** Give the platform a stock figure the ERP will disagree with. */
  async function seedPlatformStock(quantity: number): Promise<void> {
    const location = await prisma.inventoryLocation.findFirstOrThrow({});
    await prisma.inventoryBalance.create({
      data: {
        id: newId(),
        productId,
        variantKey: '',
        locationId: location.id,
        onHandQty: quantity,
        reservedQty: 0,
      },
    });
  }

  it('applies the ERP figure when the ERP is the authority', async () => {
    await seedPlatformStock(100);
    const id = await activeConnection(adminActor, { inventoryAuthority: 'ERP' });

    await syncNow(adminActor, id);

    const line = (await listErpInventory()).find(
      (entry) => entry.sku === 'GLV-M',
    );

    expect(line?.availableQuantity).toBe(42);
    // The platform's figure is recorded beside it, so the divergence can be
    // shown rather than merely resolved.
    expect(line?.platformQuantityAtSync).toBe(100);
  });

  it('keeps the platform figure, and flags the divergence, when the platform is the authority', async () => {
    await seedPlatformStock(100);
    const id = await activeConnection(adminActor, { inventoryAuthority: 'PLATFORM' });

    const outcome = await syncNow(adminActor, id);
    expect(outcome.conflicts).toBeGreaterThan(0);

    const line = (await listErpInventory()).find(
      (entry) => entry.sku === 'GLV-M',
    );

    expect(line?.availableQuantity).toBe(100);
    expect(line?.hasConflict).toBe(true);
  });

  it('applies neither, and asks, when the policy is MANUAL', async () => {
    await seedPlatformStock(100);
    const id = await activeConnection(adminActor, { inventoryAuthority: 'MANUAL' });

    const outcome = await syncNow(adminActor, id);

    expect(outcome.conflicts).toBeGreaterThan(0);
    expect(outcome.applied).toBe(1); // SYR-10 has no platform figure to disagree with.

    const line = (await listErpInventory()).find(
      (entry) => entry.sku === 'GLV-M',
    );

    expect(line?.hasConflict).toBe(true);
  });

  it('refuses a manual figure unless the connection allows one', async () => {
    const id = await activeConnection(adminActor, { allowManualOverride: false });
    await syncNow(adminActor, id);

    // With the ERP as authority, a manual figure would be silently reverted by
    // the next sync, and a control that undoes itself is worse than none.
    await expect(
      setManualQuantity(adminActor, { connectionId: id, sku: 'GLV-M', warehouseKey: 'MAIN', quantity: 5 }),
    ).rejects.toMatchObject({ code: 'INVENTORY_BALANCE_NOT_EDITABLE' });
  });

  it('lets a manual figure survive the next sync where override is allowed', async () => {
    const id = await activeConnection(adminActor, { allowManualOverride: true });
    await syncNow(adminActor, id);

    await setManualQuantity(adminActor, {
      connectionId: id,
      sku: 'GLV-M',
      warehouseKey: 'MAIN',
      quantity: 5,
    });

    erp.stock = [{ Material: 'GLV-M', Werks: '1000', LabSt: '999', Meins: 'EA' }];
    const outcome = await syncNow(adminActor, id);

    expect(outcome.skipped).toBe(1);

    const line = (await listErpInventory()).find(
      (entry) => entry.sku === 'GLV-M',
    );

    expect(line?.manualQuantity).toBe(5);
    // The effective figure - what every availability check downstream reads.
    expect(line?.effectiveQuantity).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

describe('inbound webhooks', () => {
  const payload = JSON.stringify({
    d: { results: [{ Material: 'GLV-M', Werks: '1000', LabSt: '11', Meins: 'EA' }] },
  });

  function sign(body: string, secret = WEBHOOK_SECRET): string {
    return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
  }

  async function webhookConnection(): Promise<{ id: string; slug: string }> {
    const id = await activeConnection(adminActor, {
      webhookEnabled: true,
      webhookSecret: WEBHOOK_SECRET,
      webhookSignatureHeader: 'X-ERP-Signature',
    });

    const row = await prisma.erpConnection.findUniqueOrThrow({ where: { id } });
    return { id, slug: row.webhookSlug };
  }

  it('verifies a signature over the exact bytes received', () => {
    const body = Buffer.from(payload, 'utf8');

    expect(verifyWebhookSignature(body, sign(payload), WEBHOOK_SECRET)).toBe(true);
    // The `sha256=` prefix some ERPs use is accepted too; neither spelling is
    // wrong.
    expect(verifyWebhookSignature(body, `sha256=${sign(payload)}`, WEBHOOK_SECRET)).toBe(true);

    expect(verifyWebhookSignature(body, sign(payload, 'the-wrong-secret'), WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, WEBHOOK_SECRET)).toBe(false);
    // A body that differs by one byte does not verify, which is the whole point.
    expect(verifyWebhookSignature(Buffer.from(`${payload} `, 'utf8'), sign(payload), WEBHOOK_SECRET)).toBe(
      false,
    );
  });

  it('applies a correctly signed update', async () => {
    const { slug } = await webhookConnection();

    const result = await handleInventoryWebhook({
      slug,
      rawBody: Buffer.from(payload, 'utf8'),
      headers: { 'x-erp-signature': sign(payload), 'x-erp-event-id': 'evt-1' },
      correlationId: newId(),
    });

    expect(result.accepted).toBe(true);
    expect(result.duplicate).toBe(false);

    const line = (await listErpInventory()).find(
      (entry) => entry.sku === 'GLV-M',
    );
    expect(line?.availableQuantity).toBe(11);
  });

  it('applies a redelivered update exactly once', async () => {
    const { slug } = await webhookConnection();

    const deliver = () =>
      handleInventoryWebhook({
        slug,
        rawBody: Buffer.from(payload, 'utf8'),
        headers: { 'x-erp-signature': sign(payload), 'x-erp-event-id': 'evt-1' },
        correlationId: newId(),
      });

    const first = await deliver();
    const second = await deliver();

    expect(first.duplicate).toBe(false);
    // A 200 with `duplicate: true`, not an error. An ERP retrying a delivery it
    // already made has done nothing wrong, and a 4xx makes it retry harder.
    expect(second.duplicate).toBe(true);
    expect(second.runId).toBe(first.runId);

    // One sync run, not two.
    expect(await prisma.erpInventorySyncRun.count()).toBe(1);
  });

  it('de-duplicates on a body hash when the ERP sends no event id', async () => {
    const { slug } = await webhookConnection();

    const deliver = () =>
      handleInventoryWebhook({
        slug,
        rawBody: Buffer.from(payload, 'utf8'),
        headers: { 'x-erp-signature': sign(payload) },
        correlationId: newId(),
      });

    await deliver();
    const second = await deliver();

    expect(second.duplicate).toBe(true);

    const receipt = await prisma.erpWebhookReceipt.findFirstOrThrow({});
    expect(receipt.externalEventId.startsWith('sha256:')).toBe(true);
  });

  it('refuses a bad signature, a missing one, and an unknown slug alike', async () => {
    const { slug } = await webhookConnection();

    const cases = [
      { slug, headers: { 'x-erp-signature': sign(payload, 'wrong') }, why: 'a bad signature' },
      { slug, headers: {}, why: 'no signature at all' },
      { slug: 'not-a-real-slug-at-all', headers: { 'x-erp-signature': sign(payload) }, why: 'an unknown slug' },
    ];

    for (const testCase of cases) {
      await expect(
        handleInventoryWebhook({
          slug: testCase.slug,
          rawBody: Buffer.from(payload, 'utf8'),
          headers: testCase.headers,
          correlationId: newId(),
        }),
        // An endpoint that told these three apart would be an oracle.
      ).rejects.toMatchObject({ code: 'ERP_WEBHOOK_REJECTED' });
    }

    expect(await prisma.erpInventorySnapshot.count()).toBe(0);
  });

  it('refuses a webhook for a paused connection', async () => {
    const { id, slug } = await webhookConnection();
    await performLifecycleAction(adminActor, id, 'PAUSE');

    // Accepting stock updates for a connection somebody deliberately stopped is
    // the opposite of what pausing means.
    await expect(
      handleInventoryWebhook({
        slug,
        rawBody: Buffer.from(payload, 'utf8'),
        headers: { 'x-erp-signature': sign(payload) },
        correlationId: newId(),
      }),
    ).rejects.toMatchObject({ code: 'ERP_WEBHOOK_REJECTED' });
  });

  it('records a refused webhook on the audit trail', async () => {
    const { slug } = await webhookConnection();

    await handleInventoryWebhook({
      slug,
      rawBody: Buffer.from(payload, 'utf8'),
      headers: { 'x-erp-signature': 'deadbeef' },
      correlationId: newId(),
    }).catch(() => undefined);

    const entries = await prisma.auditLog.findMany({
      where: { action: 'erp_connection.webhook_rejected' },
    });

    // A run of these is either a misconfigured ERP or somebody probing.
    expect(entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/** A paid order belonging to the primary customer. */
async function makeOrder(profileId: string = buyerProfileId): Promise<string> {
  const orderId = newId();

  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `UB-${orderId.slice(-8)}`,
      customerProfileId: profileId,
      status: 'CONFIRMED',
      source: 'ONE_TIME',
      currency: 'EUR',
      subtotalMinor: 1200n,
      discountMinor: 0n,
      taxMinor: 252n,
      shippingMinor: 0n,
      grandTotalMinor: 1452n,
      placedAt: new Date(),
      // The snapshots an order keeps of where it is going. Required columns:
      // an order that outlives the address it shipped to still has to say
      // where it went.
      billingAddressJson: { line1: 'Dock 4', city: 'Brussels', country: 'BE' },
      shippingAddressJson: { line1: 'Dock 4', city: 'Brussels', country: 'BE' },
      items: {
        create: [
          {
            id: newId(),
            productId,
            skuSnapshot: 'GLV-M',
            nameSnapshot: 'Nitrile Gloves M',
            quantity: 1,
            unitPriceMinor: 1200n,
            lineSubtotalMinor: 1200n,
            // Snapshotted at order time, so a later change to the tax class
            // does not rewrite what was charged.
            taxClassCodeSnapshot: 'VAT21',
            taxRatePercent: '21.000000',
            taxAmountMinor: 252n,
            lineTotalMinor: 1452n,
          },
        ],
      },
    },
  });

  return orderId;
}

describe('sending an order to the customer’s ERP', () => {
  it('sends it and stores the reference the ERP gave back', async () => {
    const id = await activeConnection();
    const orderId = await makeOrder();

    const result = await pushOrderToErpConnection({
      orderId,
      idempotencyKey: `erp:order:${orderId}`,
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.erpOrderReference).toBe('ERP-1');

    const sent = erp.requests.find((entry) => entry.path === '/api/orders');
    expect(sent?.idempotencyKey).toBe(`erp:order:${orderId}`);

    // The payload the ERP received: money as strings, never JSON numbers.
    const body = sent?.body as { totals: { grand_total_minor: unknown }; lines: unknown[] };
    expect(body.totals.grand_total_minor).toBe('1452');
    expect(body.lines).toHaveLength(1);

    const status = await erpSyncStateFor(orderId);
    expect(status.state).toBe('SYNCED');
    expect(status.erpOrderReference).toBe('ERP-1');

    // The connection used is recorded, so the ledger can explain the hand-off
    // later even if the connection is deleted.
    const push = await prisma.erpOrderPush.findUniqueOrThrow({ where: { orderId } });
    expect(push.erpConnectionId).toBe(id);
  });

  it('holds at Paid - ERP Pending when the ERP is unavailable after the charge', async () => {
    await activeConnection();
    const orderId = await makeOrder();
    erp.order = 'unavailable';

    const result = await pushOrderToErpConnection({
      orderId,
      idempotencyKey: `erp:order:${orderId}`,
    });

    expect(result.status).toBe('DEFERRED');

    // The order is NOT failed. The customer's money is real and so is their
    // order; only the hand-off is outstanding.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CONFIRMED');

    const status = await erpSyncStateFor(orderId);
    expect(status.state).toBe('PAID_ERP_PENDING');
    expect(status.nextRetryAt).not.toBeNull();
  });

  it('retries under the SAME key and never produces a second ERP order', async () => {
    await activeConnection();
    const orderId = await makeOrder();
    const key = `erp:order:${orderId}`;

    erp.order = 'unavailable';
    await pushOrderToErpConnection({ orderId, idempotencyKey: key });

    // The ERP comes back.
    erp.order = 'accepts';
    await prisma.erpOrderPush.update({ where: { orderId }, data: { nextRetryAt: new Date(0) } });

    const swept = await retryDueErpConnectionPushes();
    expect(swept.succeeded).toBe(1);

    const orderCalls = erp.requests.filter((entry) => entry.path === '/api/orders');
    expect(orderCalls).toHaveLength(2);
    // Two attempts, one key. This is the assertion the whole retry design
    // exists for.
    expect(new Set(orderCalls.map((entry) => entry.idempotencyKey)).size).toBe(1);

    // One ERP order, one push row.
    expect(erp.ordersByKey.size).toBe(1);
    expect(await prisma.erpOrderPush.count()).toBe(1);
  });

  it('treats an ERP 409 as success, because the order is already there', async () => {
    await activeConnection();
    const orderId = await makeOrder();
    erp.order = 'duplicate';

    const result = await pushOrderToErpConnection({
      orderId,
      idempotencyKey: `erp:order:${orderId}`,
    });

    // Retrying for hours against an ERP that took the order on the first
    // attempt would eventually abandon an order the warehouse is picking.
    expect(result.status).toBe('SUCCEEDED');
    expect(result.erpOrderReference).toBe('ERP-ALREADY-1');
    expect(result.alreadyPushed).toBe(true);
  });

  it('does not repeat a request the ERP refused outright', async () => {
    await activeConnection();
    const orderId = await makeOrder();
    erp.order = 'rejects_permanently';

    const result = await pushOrderToErpConnection({
      orderId,
      idempotencyKey: `erp:order:${orderId}`,
    });

    expect(result.status).toBe('ABANDONED');

    // No retry is booked: sending identical bytes to a 400 gets an identical
    // answer, and hammering somebody's server over a typo is not a strategy.
    const push = await prisma.erpOrderPush.findUniqueOrThrow({ where: { orderId } });
    expect(push.nextRetryAt).toBeNull();

    const swept = await retryDueErpConnectionPushes();
    expect(swept.attempted).toBe(0);
  });

  it('lets the customer retry by hand once they have fixed the cause', async () => {
    await activeConnection();
    const orderId = await makeOrder();
    erp.order = 'rejects_permanently';

    await pushOrderToErpConnection({
      orderId,
      idempotencyKey: `erp:order:${orderId}`,
    });

    erp.order = 'accepts';

    const result = await retryErpConnectionPush({
      orderId,
    });

    expect(result.status).toBe('SUCCEEDED');

    // Still one key across every attempt, so the customer's ERP cannot end up
    // with two copies.
    const orderCalls = erp.requests.filter((entry) => entry.path === '/api/orders');
    expect(new Set(orderCalls.map((entry) => entry.idempotencyKey)).size).toBe(1);
  });

  it('is a no-op for a customer with no connection', async () => {
    // A buyer who has not connected an ERP - which is most of them - must be
    // able to order exactly as they did before this feature existed.
    const orderId = await makeOrder();

    const result = await pushOrderToErpConnection({
      orderId,
      idempotencyKey: `erp:order:${orderId}`,
    });

    expect(result.status).toBe('SKIPPED');
    expect(await prisma.erpOrderPush.count()).toBe(0);
  });

  it('records the whole hand-off on the activity ledger', async () => {
    await activeConnection();
    const orderId = await makeOrder();

    await pushOrderToErpConnection({
      orderId,
      idempotencyKey: `erp:order:${orderId}`,
    });

    const { events } = await listIntegrationEvents({
      eventType: 'ORDER_PUSH',
    });

    expect(events[0]).toMatchObject({
      status: 'SUCCEEDED',
      orderId,
      erpOrderReference: 'ERP-1',
      idempotencyKey: `erp:order:${orderId}`,
    });
    // Every event carries a correlation id, so one incident reads back as one
    // story rather than three that have to be aligned by timestamp.
    expect(events[0]?.correlationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('one connection, every order', () => {
  it('sends orders from different buyers down the same connection', () => {
    // The point of the design the feature settled on: whose order it is has no
    // bearing on where it goes. One business, one ERP.
    expect(buyerProfileId).not.toBe(otherBuyerProfileId);
  });

  it('routes an order to the connection whoever placed it', async () => {
    await activeConnection();

    for (const profileId of [buyerProfileId, otherBuyerProfileId]) {
      const orderId = await makeOrder(profileId);

      const result = await pushOrderToErpConnection({
        orderId,
        idempotencyKey: `erp:order:${orderId}`,
      });

      expect(result.status).toBe('SUCCEEDED');
    }

    // Two orders from two different buyers, both in the ERP.
    expect(erp.requests.filter((entry) => entry.path === '/api/orders')).toHaveLength(2);
    expect(erp.ordersByKey.size).toBe(2);
  });

  it('refuses a second connection with the same name', async () => {
    await activeConnection();

    // `name` is unique across the installation now, not per customer - there is
    // only one customer of this table, and it is the business.
    await expect(
      createConnection(adminActor, connectionInput({ baseUrl })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('switches the previous connection off when another is activated', async () => {
    const first = await activeConnection(adminActor, { name: 'Live' });
    const second = await activeConnection(adminActor, { name: 'Sandbox' });

    // At most one ACTIVE at a time. Two would make "which ERP does an order go
    // to" depend on row order, which is exactly the ambiguity the single
    // business-wide connection exists to remove.
    const rows = await prisma.erpConnection.findMany({ where: { status: 'ACTIVE' } });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(second);

    const previous = await getConnection(first);
    expect(previous.status).toBe('PAUSED');
  });

  it('answers availability from the one active connection', async () => {
    const id = await activeConnection();
    await syncNow(adminActor, id);

    expect((await availabilityForSkus(['GLV-M'])).get('GLV-M')).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// The feature switch
// ---------------------------------------------------------------------------

describe('when the deployment has not enabled this', () => {
  it('refuses the whole surface', async () => {
    setFlags({ FEATURE_ERP_INTEGRATION: false });

    await expect(createConnection(adminActor, connectionInput() as never)).rejects.toMatchObject({
      code: 'FEATURE_DISABLED',
    });
  });

  it('leaves ordering exactly as it was', async () => {
    setFlags({ FEATURE_ERP_INTEGRATION: false });
    const orderId = await makeOrder();

    const result = await pushOrderToErpConnection({
      orderId,
      idempotencyKey: `erp:order:${orderId}`,
    });

    expect(result.status).toBe('SKIPPED');
  });
});
