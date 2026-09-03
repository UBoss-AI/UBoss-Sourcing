/**
 * Generate `openapi.json` from the live route table.
 *
 * Run with `npm run openapi:export`. The routes are collected via Fastify's
 * `onRoute` hook while the real application is being built, so the document
 * cannot list a path that does not exist or miss one that does.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { buildOpenApiDocument } from './openapi.js';

interface CollectedRoute {
  method: string;
  url: string;
}

async function main(): Promise<void> {
  // The real application, so every nested prefix resolves exactly as it does
  // at runtime. An `onRoute` hook cannot see them - the route files know
  // nothing about the prefixes they are registered under.
  const app = await buildApp();
  await app.ready();

  // Fastify exposes no public route list, so the printed tree is the source.
  // It is stable, documented output.
  const printed = app.printRoutes({ commonPrefix: false });
  await app.close();

  const document = buildOpenApiDocument(parsePrintedRoutes(printed));
  const outputPath = resolve(process.cwd(), 'openapi.json');

  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const operationCount = Object.values(document['paths'] as Record<string, object>).reduce(
    (total, methods) => total + Object.keys(methods).length,
    0,
  );

  const undocumented = document['x-undocumented-operations'] as string[];

  console.log(`Wrote ${outputPath}`);
  console.log(`  paths      : ${String(Object.keys(document['paths'] as object).length)}`);
  console.log(`  operations : ${String(operationCount)}`);
  console.log(`  documented : ${String(operationCount - undocumented.length)}`);

  if (undocumented.length > 0) {
    console.log(`\n  ${String(undocumented.length)} operation(s) have no authored summary:`);
    for (const entry of undocumented.slice(0, 40)) console.log(`    - ${entry}`);
    if (undocumented.length > 40) {
      console.log(`    ... and ${String(undocumented.length - 40)} more`);
    }
  }
}

/**
 * Turn Fastify's printed route tree into flat `{ method, url }` records.
 *
 * The tree is indented and path-compressed:
 *   ├── /api/v1/admin/products (GET, POST)
 *   │   └── /:id (PATCH)
 * so a node's full URL is its own segment appended to its ancestors'.
 */
export function parsePrintedRoutes(printed: string): CollectedRoute[] {
  const routes: CollectedRoute[] = [];
  // Stack of path segments by indentation depth.
  const stack: string[] = [];

  for (const rawLine of printed.split('\n')) {
    if (rawLine.trim().length === 0) continue;

    // Strip the drawing characters, keeping the indentation width so depth can
    // be measured.
    const drawing = /^[│\s]*(?:├──|└──)?\s?/.exec(rawLine)?.[0] ?? '';
    const depth = Math.floor(drawing.length / 4);
    const content = rawLine.slice(drawing.length);

    const match = /^(\S*)(?:\s+\(([^)]+)\))?$/.exec(content.trim());
    if (match === null) continue;

    const segment = match[1] ?? '';
    const methods = match[2];

    stack.length = depth;
    stack[depth] = segment;

    if (methods === undefined) continue;

    const url = stack.slice(0, depth + 1).join('');
    if (!url.startsWith('/')) continue;

    for (const method of methods.split(',').map((entry) => entry.trim())) {
      // A path registered with two parameter names shows as `:a|:b`; that is a
      // routing smell, so surface it rather than silently picking one.
      if (url.includes('|')) {
        console.warn(`  warning: ${method} ${url} has two parameter names for one segment`);
      }
      routes.push({ method, url });
    }
  }

  return routes;
}

/**
 * Only run as a CLI.
 *
 * `parsePrintedRoutes` is imported by the contract test; without this guard the
 * import alone would build the app and write openapi.json as a side effect.
 */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes('openapi-export');

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('Failed to generate openapi.json:', error);
    process.exit(1);
  });
}
