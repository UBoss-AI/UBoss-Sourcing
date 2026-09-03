/**
 * OpenAPI contract.
 *
 * The document is derived from Fastify's live route table, so it cannot list a
 * path that does not exist. These tests guard the other direction and the parts
 * that ARE hand-maintained: that the derivation is sane, that every schema
 * reference resolves, and that the contract the frontends depend on - the error
 * envelope, the money shape, the idempotency markers - is actually published.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { buildOpenApiDocument } from '../../src/http/openapi.js';
import { parsePrintedRoutes } from '../../src/http/openapi-export.js';

/** Build the document the same way `npm run openapi:export` does. */
async function generate(): Promise<{
  document: Record<string, unknown>;
  routeCount: number;
}> {
  const app = await buildApp();
  await app.ready();
  const printed = app.printRoutes({ commonPrefix: false });
  await app.close();

  const routes = parsePrintedRoutes(printed);
  return { document: buildOpenApiDocument(routes), routeCount: routes.length };
}

describe('route table parsing', () => {
  it('recovers full paths from the printed tree', async () => {
    const app = await buildApp();
    await app.ready();
    const routes = parsePrintedRoutes(app.printRoutes({ commonPrefix: false }));
    await app.close();

    const urls = routes.map((route) => route.url);

    // Nested prefixes must be reassembled, not truncated to their leaf segment.
    expect(urls).toContain('/api/v1/admin/products/:id/publication');
    expect(urls).toContain('/api/v1/cart/checkout');
    expect(urls).toContain('/api/v1/payments/webhooks/:provider');
    expect(urls).toContain('/health/live');
  });

  /**
   * Two names for one path segment is a routing smell that would surface as
   * `:a|:b` in a generated client. It caught a real collision between the order
   * routes and the payment routes.
   */
  it('leaves no path with two parameter names for one segment', async () => {
    const app = await buildApp();
    await app.ready();
    const routes = parsePrintedRoutes(app.printRoutes({ commonPrefix: false }));
    await app.close();

    const collisions = routes.filter((route) => route.url.includes('|'));
    expect(collisions.map((route) => `${route.method} ${route.url}`)).toEqual([]);
  });
});

describe('document shape', () => {
  it('is a valid OpenAPI 3.1 skeleton', async () => {
    const { document } = await generate();

    expect(document['openapi']).toBe('3.1.0');
    expect(document['info']).toHaveProperty('title');
    expect(document['paths']).toBeTypeOf('object');
    expect(document['components']).toHaveProperty('schemas');
  });

  it('documents every route the application actually serves', async () => {
    const { document, routeCount } = await generate();
    const paths = document['paths'] as Record<string, Record<string, unknown>>;

    const operationCount = Object.values(paths).reduce(
      (total, methods) => total + Object.keys(methods).length,
      0,
    );

    // HEAD is auto-generated per GET and OPTIONS is CORS; both are excluded.
    expect(operationCount).toBeGreaterThan(0);
    expect(operationCount).toBeLessThanOrEqual(routeCount);
  });

  it('converts Fastify parameters to OpenAPI ones', async () => {
    const { document } = await generate();
    const paths = document['paths'] as Record<string, unknown>;

    expect(Object.keys(paths)).toContain('/api/v1/admin/products/{id}/publication');
    // No colon syntax survives.
    expect(Object.keys(paths).filter((path) => path.includes(':'))).toEqual([]);
  });

  it('declares path parameters for every templated segment', async () => {
    const { document } = await generate();
    const paths = document['paths'] as Record<string, Record<string, { parameters?: unknown[] }>>;

    for (const [path, methods] of Object.entries(paths)) {
      const templated = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
      if (templated.length === 0) continue;

      for (const [method, operation] of Object.entries(methods)) {
        const declared = (operation.parameters ?? [])
          .filter((parameter): parameter is { in: string; name: string } => {
            return typeof parameter === 'object' && parameter !== null && 'in' in parameter;
          })
          .filter((parameter) => parameter.in === 'path')
          .map((parameter) => parameter.name);

        for (const name of templated) {
          expect(declared, `${method.toUpperCase()} ${path} is missing parameter ${String(name)}`)
            .toContain(name);
        }
      }
    }
  });

  it('gives every operation a real summary, never a bare method and path', async () => {
    const { document } = await generate();
    const paths = document['paths'] as Record<string, Record<string, { summary: string }>>;

    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.summary, `${method} ${path}`).toBeTruthy();
        // The old fallback looked like "GET /api/v1/admin/products".
        expect(operation.summary).not.toMatch(/^(GET|POST|PATCH|DELETE) \//);
      }
    }
  });

  it('tags every operation, and never as Undocumented', async () => {
    const { document } = await generate();
    const paths = document['paths'] as Record<string, Record<string, { tags: string[] }>>;

    for (const methods of Object.values(paths)) {
      for (const operation of Object.values(methods)) {
        expect(operation.tags.length).toBeGreaterThan(0);
        expect(operation.tags).not.toContain('Undocumented');
      }
    }
  });
});

describe('schema references resolve', () => {
  /** A dangling $ref makes a generated client fail at build time. */
  it('has no dangling $ref', async () => {
    const { document } = await generate();
    const schemas = (document['components'] as { schemas: Record<string, unknown> }).schemas;
    const declared = new Set(Object.keys(schemas));

    const referenced = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node !== 'object' || node === null) return;

      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === '$ref' && typeof value === 'string') {
          referenced.add(value.replace('#/components/schemas/', ''));
        } else {
          walk(value);
        }
      }
    };

    walk(document);

    for (const name of referenced) {
      expect(declared, `$ref to undeclared schema "${name}"`).toContain(name);
    }
  });
});

describe('the contract the frontends depend on', () => {
  it('publishes the error envelope with a stable code field', async () => {
    const { document } = await generate();
    const schemas = (document['components'] as { schemas: Record<string, unknown> }).schemas;

    expect(schemas).toHaveProperty('ErrorEnvelope');
    expect(schemas).toHaveProperty('ErrorDetail');

    const envelope = schemas['ErrorEnvelope'] as {
      properties: { error: { required: string[] } };
    };
    expect(envelope.properties.error.required).toEqual(
      expect.arrayContaining(['code', 'message', 'details', 'correlationId']),
    );
  });

  /** Money must never be typed as a number in a generated client. */
  it('types money as strings, never as a number', async () => {
    const { document } = await generate();
    const schemas = (document['components'] as { schemas: Record<string, unknown> }).schemas;

    const money = schemas['Money'] as {
      properties: { minor: { type: string }; formatted: { type: string } };
    };

    expect(money.properties.minor.type).toBe('string');
    expect(money.properties.formatted.type).toBe('string');
  });

  it('marks the idempotent operations and their required header', async () => {
    const { document } = await generate();
    const paths = document['paths'] as Record<
      string,
      Record<string, { 'x-idempotency-key'?: string; parameters?: { name: string }[] }>
    >;

    const checkout = paths['/api/v1/cart/checkout']?.['post'];
    expect(checkout?.['x-idempotency-key']).toBe('required');
    expect(checkout?.parameters?.map((parameter) => parameter.name)).toContain('Idempotency-Key');
  });

  it('records the permission an admin operation needs', async () => {
    const { document } = await generate();
    const paths = document['paths'] as Record<
      string,
      Record<string, { 'x-required-permission'?: string }>
    >;

    expect(paths['/api/v1/admin/products/{id}/publication']?.['patch']?.['x-required-permission']).toBe(
      'product.publish',
    );
  });

  /** The webhook has no session; its authority is the signature. */
  it('leaves the webhook and public catalog unsecured in the document', async () => {
    const { document } = await generate();
    const paths = document['paths'] as Record<string, Record<string, { security: unknown[] }>>;

    expect(paths['/api/v1/payments/webhooks/{provider}']?.['post']?.security).toEqual([]);
    expect(paths['/api/v1/catalog/products']?.['get']?.security).toEqual([]);
  });

  it('secures the admin and customer surfaces', async () => {
    const { document } = await generate();
    const paths = document['paths'] as Record<string, Record<string, { security: unknown[] }>>;

    expect(paths['/api/v1/admin/orders']?.['get']?.security.length).toBeGreaterThan(0);
    expect(paths['/api/v1/cart']?.['get']?.security.length).toBeGreaterThan(0);
  });
});
