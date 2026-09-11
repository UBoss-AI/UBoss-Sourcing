/**
 * The properties that make this feature safe to retry.
 *
 * Every test here is about one of three things: an idempotency key that cannot
 * vary, a redaction that cannot be skipped, and an address check that cannot be
 * talked round. All three are pure functions, which is exactly why they were
 * written as pure functions - the alternative is testing them through a worker
 * and a live ERP, which means they would not be tested.
 */
import { describe, expect, it } from 'vitest';
import { hostMatchesPolicy } from '../../src/infra/outbound-http.js';
import {
  idempotencyKeyFor,
  type EventTypeName,
} from '../../src/modules/customer-erp/event.service.js';
import {
  parseRetryAfter,
  redactForLedger,
  resolveEndpointUrl,
  isConfigurableHeader,
  ErpCallError,
} from '../../src/modules/customer-erp/http.js';
import { hintFor } from '../../src/modules/customer-erp/credential.service.js';
import {
  capabilitiesFor,
  hasCapability,
  normaliseOrgName,
} from '../../src/modules/customer-erp/organization.service.js';
import { importOpenApi } from '../../src/modules/customer-erp/openapi-import.js';

describe('the idempotency key', () => {
  const base = {
    organizationId: '01JABCDEFGHJKMNPQRSTVWXYZ0',
    subject: '01JORDER00000000000000000',
    eventType: 'PURCHASE_ORDER_CREATE' as EventTypeName,
  };

  it('is the same every time for the same thing', () => {
    // The whole feature turns on this. A key derived from the clock or from a
    // random source is not an idempotency key, it is a unique constraint that
    // never fires - and the second attempt raises a second purchase order.
    expect(idempotencyKeyFor(base)).toBe(idempotencyKeyFor(base));
  });

  it('differs by organisation, so two tenants cannot collide', () => {
    expect(idempotencyKeyFor(base)).not.toBe(
      idempotencyKeyFor({ ...base, organizationId: '01JZZZZZZZZZZZZZZZZZZZZZZZ' }),
    );
  });

  it('differs by event type, so a shipment is not confused with a purchase order', () => {
    expect(idempotencyKeyFor(base)).not.toBe(
      idempotencyKeyFor({ ...base, eventType: 'SHIPMENT_STATUS' }),
    );
  });

  it('differs by version, which is how a second thing to say gets said', () => {
    // A genuinely new thing to tell the ERP about the same order is a new
    // version and therefore a new row. Never the old row again: SUCCEEDED is
    // terminal.
    expect(idempotencyKeyFor(base)).not.toBe(idempotencyKeyFor({ ...base, eventVersion: 2 }));
  });

  it('fits the column it is stored in', () => {
    const long = idempotencyKeyFor({
      ...base,
      subject: 'x'.repeat(400),
      eventVersion: 999,
    });

    // VarChar(191) - the utf8mb4 limit for an indexed column on MariaDB 10.4.
    expect(long.length).toBeLessThanOrEqual(191);
  });
});

describe('redaction before anything is stored', () => {
  it('keeps the key and drops the value', () => {
    // "The client secret was rotated" stays visible; the secret does not. The
    // ledger exists so a disagreement about a purchase order can be settled by
    // what was exchanged, and that is worth keeping without keeping a
    // credential.
    const redacted = redactForLedger({
      clientSecret: 'super-secret',
      apiKey: 'sk_live_1234',
      authorization: 'Bearer abc',
      password: 'hunter2',
      orderNumber: 'UB-2026-000123',
    }) as Record<string, unknown>;

    expect(redacted['clientSecret']).toBe('[redacted]');
    expect(redacted['apiKey']).toBe('[redacted]');
    expect(redacted['authorization']).toBe('[redacted]');
    expect(redacted['password']).toBe('[redacted]');
    expect(redacted['orderNumber']).toBe('UB-2026-000123');
  });

  it('reaches secrets nested inside a request body', () => {
    const redacted = redactForLedger({
      header: { auth: { clientSecret: 'nested' } },
    }) as { header: { auth: { clientSecret: string } } };

    expect(redacted.header.auth.clientSecret).toBe('[redacted]');
  });

  it('caps an array so a ledger row is evidence rather than a copy of the feed', () => {
    const redacted = redactForLedger(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(redacted.length).toBeLessThanOrEqual(100);
  });

  it('renders a BigInt rather than throwing on it', () => {
    // Every money column is one, and `JSON.stringify` of a BigInt throws.
    expect(redactForLedger({ total: 1420000n })).toEqual({ total: '1420000' });
  });
});

describe('credential hints', () => {
  it('shows enough to recognise a key and never enough to use one', () => {
    const hint = hintFor('PRIMARY', { apiKey: 'sk_live_abcdefghijklmnop9f2a' }) ?? '';

    expect(hint).toContain('...');
    expect(hint).not.toContain('abcdefghijklmnop');
    expect(hint.endsWith('9f2a')).toBe(true);
  });

  it('hides a short secret entirely, because a prefix of one is most of it', () => {
    expect(hintFor('PRIMARY', { apiKey: 'short' })).toBe('****');
  });

  it('shows a client ID in full, because it is not a secret', () => {
    // The one part of an OAuth pair a buyer can check against their own ERP's
    // configuration screen without going to find a password manager.
    expect(hintFor('PRIMARY', { clientId: 'uboss-client' })).toBe('client uboss-client');
  });

  it('never renders a certificate, not even a prefix', () => {
    // A PEM header is identical on every certificate ever issued, so a prefix
    // would say nothing at all.
    const hint = hintFor('CLIENT_CERTIFICATE', {
      certificatePem: '-----BEGIN CERTIFICATE-----MIIC...',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----MIIE...',
    });

    expect(hint).toBe('client certificate installed');
  });
});

describe('endpoint addresses', () => {
  const base = 'https://erp.example.com/api';

  it('resolves a relative path against the base', () => {
    expect(resolveEndpointUrl(base, '/purchase-orders').toString()).toBe(
      'https://erp.example.com/api/purchase-orders',
    );
  });

  it('accepts an absolute path on the same origin', () => {
    expect(
      resolveEndpointUrl(base, 'https://erp.example.com/other/path').toString(),
    ).toBe('https://erp.example.com/other/path');
  });

  it('refuses one that leaves the authorised host', () => {
    // An "endpoint" free to name a different host is a server-side request
    // forgery primitive with a form field in front of it, and the base URL is
    // the only address the buyer has been asked to justify.
    expect(() => resolveEndpointUrl(base, 'https://attacker.example/steal')).toThrow(
      /same address/i,
    );

    expect(() => resolveEndpointUrl(base, 'http://169.254.169.254/latest/meta-data/')).toThrow();
  });
});

describe('the operator host allowlist', () => {
  it('admits anything when there is no policy', () => {
    // The right posture for a product sold to businesses whose ERPs live at
    // addresses nobody here can predict. The address checks still apply.
    expect(hostMatchesPolicy('erp.anything.example', [])).toBe(true);
  });

  it('matches an exact host', () => {
    expect(hostMatchesPolicy('erp.example.com', ['erp.example.com'])).toBe(true);
    expect(hostMatchesPolicy('other.example.com', ['erp.example.com'])).toBe(false);
  });

  it('matches a domain and its subdomains when the entry starts with a dot', () => {
    expect(hostMatchesPolicy('erp.example.com', ['.example.com'])).toBe(true);
    expect(hostMatchesPolicy('example.com', ['.example.com'])).toBe(true);
    expect(hostMatchesPolicy('example.com.attacker.example', ['.example.com'])).toBe(false);
  });

  it('is not fooled by a suffix that is not a domain boundary', () => {
    // `notexample.com` ends with `example.com` as a string and is a different
    // company.
    expect(hostMatchesPolicy('notexample.com', ['.example.com'])).toBe(false);
  });
});

describe('headers a buyer may set', () => {
  it('refuses the ones that would carry a credential or break the request', () => {
    expect(isConfigurableHeader('Authorization')).toBe(false);
    expect(isConfigurableHeader('Host')).toBe(false);
    expect(isConfigurableHeader('Content-Length')).toBe(false);
    expect(isConfigurableHeader('Cookie')).toBe(false);
  });

  it('refuses a name carrying a newline, which would smuggle a second header', () => {
    expect(isConfigurableHeader('X-Tenant\r\nX-Admin: true')).toBe(false);
  });

  it('allows an ordinary one', () => {
    expect(isConfigurableHeader('X-Company-Code')).toBe(true);
  });
});

describe('Retry-After', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('120')).toBe(120);
  });

  it('reads an HTTP date', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    expect(parseRetryAfter(future)).toBeGreaterThan(0);
  });

  it('caps an absurd value rather than deferring somebody until next month', () => {
    expect(parseRetryAfter('999999999')).toBe(86_400);
  });

  it('ignores a date already in the past and anything unreadable', () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});

describe('which failures are worth retrying', () => {
  it('retries what may pass and gives up on what will not', () => {
    expect(new ErpCallError('x', 'RATE_LIMIT').isRetryable).toBe(true);
    expect(new ErpCallError('x', 'TRANSPORT').isRetryable).toBe(true);
    expect(new ErpCallError('x', 'SERVER').isRetryable).toBe(true);

    // An expired credential does not un-expire, and a rejection is the ERP
    // understanding us perfectly and saying no.
    expect(new ErpCallError('x', 'AUTH').isRetryable).toBe(false);
    expect(new ErpCallError('x', 'REJECTED').isRetryable).toBe(false);
    expect(new ErpCallError('x', 'BLOCKED').isRetryable).toBe(false);
  });
});

describe('roles inside a buyer organisation', () => {
  it('lets everybody look and only some people change things', () => {
    expect(hasCapability('MEMBER', 'VIEW')).toBe(true);
    expect(hasCapability('MEMBER', 'CONFIGURE')).toBe(false);
    expect(hasCapability('MEMBER', 'OPERATE')).toBe(false);

    expect(hasCapability('INTEGRATION_MANAGER', 'CONFIGURE')).toBe(true);
    expect(hasCapability('INTEGRATION_MANAGER', 'OPERATE')).toBe(true);
    // Who is in the organisation is the owner's business.
    expect(hasCapability('INTEGRATION_MANAGER', 'ADMINISTER')).toBe(false);

    expect(hasCapability('OWNER', 'ADMINISTER')).toBe(true);
  });

  it('gives an owner everything an integration manager has', () => {
    for (const capability of capabilitiesFor('INTEGRATION_MANAGER')) {
      expect(capabilitiesFor('OWNER')).toContain(capability);
    }
  });

  it('normalises a name for finding without making it a way in', () => {
    expect(normaliseOrgName('  City Medical Supplies, Ltd. ')).toBe('city medical supplies ltd');
  });
});

describe('importing an OpenAPI document', () => {
  const json = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Acme ERP', version: '2.1' },
    servers: [{ url: 'https://erp.acme.example/api' }],
    paths: {
      '/purchase-orders': {
        post: { operationId: 'createPurchaseOrder', summary: 'Raise a purchase order' },
        patch: { operationId: 'updatePurchaseOrder', summary: 'Amend a purchase order' },
      },
      '/goods-receipts': { post: { operationId: 'postGoodsReceipt' } },
      '/stock': { get: { operationId: 'listInventory' } },
      '/unrelated': { get: { operationId: 'somethingElse' } },
    },
  });

  it('reads JSON and places the operations it recognises', () => {
    const result = importOpenApi(json);

    expect(result.title).toBe('Acme ERP');
    expect(result.serverUrl).toBe('https://erp.acme.example/api');

    const purposes = result.endpoints.map((entry) => entry.purpose);
    expect(purposes).toContain('PURCHASE_ORDER_CREATE');
    expect(purposes).toContain('PURCHASE_ORDER_UPDATE');
    expect(purposes).toContain('GOODS_RECEIPT');
    expect(purposes).toContain('INVENTORY');
  });

  it('shows what it could not place rather than dropping it silently', () => {
    const result = importOpenApi(json);
    expect(result.unmatched.map((entry) => entry.path)).toContain('/unrelated');
  });

  it('splits create from update by method, not by wording', () => {
    // Every API in the world spells "update" differently and they all agree
    // about PATCH.
    const result = importOpenApi(json);

    const create = result.endpoints.find((e) => e.purpose === 'PURCHASE_ORDER_CREATE');
    const update = result.endpoints.find((e) => e.purpose === 'PURCHASE_ORDER_UPDATE');

    expect(create?.method).toBe('POST');
    expect(update?.method).toBe('PATCH');
  });

  it('reads the YAML subset OpenAPI documents actually use', () => {
    const yaml = [
      'openapi: 3.0.0',
      'info:',
      '  title: Acme ERP   # a comment',
      '  version: "2.1"',
      'servers:',
      '  - url: https://erp.acme.example/api',
      'paths:',
      '  /purchase-orders:',
      '    post:',
      '      operationId: createPurchaseOrder',
      '      summary: Raise a purchase order',
      '  /stock:',
      '    get:',
      '      operationId: listInventory',
      '',
    ].join('\n');

    const result = importOpenApi(yaml);

    expect(result.title).toBe('Acme ERP');
    // A URL has a colon in it, which is why the key separator is "a colon
    // followed by a space" rather than the first colon on the line.
    expect(result.serverUrl).toBe('https://erp.acme.example/api');
    expect(result.endpoints.map((e) => e.purpose)).toContain('PURCHASE_ORDER_CREATE');
    expect(result.endpoints.map((e) => e.purpose)).toContain('INVENTORY');
  });

  it('refuses a document with nothing in it, rather than returning an empty guess', () => {
    expect(() => importOpenApi('not a document')).toThrow(/OpenAPI/i);
    expect(() => importOpenApi('{"info":{}}')).toThrow(/paths/i);
    expect(() => importOpenApi('{ broken json')).toThrow(/JSON/i);
  });

  it('refuses a document too large to be worth parsing', () => {
    expect(() => importOpenApi('x'.repeat(3 * 1024 * 1024))).toThrow(/larger/i);
  });

  it('flags a second candidate for the same purpose rather than picking silently', () => {
    const twoWays = JSON.stringify({
      paths: {
        '/purchase-orders': { post: { operationId: 'createPurchaseOrder' } },
        '/po/create': { post: { operationId: 'createPurchaseOrderLegacy' } },
      },
    });

    const result = importOpenApi(twoWays);
    const creates = result.endpoints.filter((e) => e.purpose === 'PURCHASE_ORDER_CREATE');

    expect(creates).toHaveLength(2);
    expect(creates.map((e) => e.confidence)).toEqual(['high', 'low']);
  });
});
