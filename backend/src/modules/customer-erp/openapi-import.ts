/**
 * Reading a buyer's OpenAPI document to fill in the endpoint step.
 *
 * A convenience, and deliberately only that. Everything this produces is a
 * SUGGESTION the buyer confirms on screen; nothing here saves anything, and no
 * endpoint reaches the database without somebody having looked at it. An
 * importer that silently configured a connection from a file would be trusting
 * a document to decide which addresses this server calls.
 *
 * WHAT IT DOES
 *
 * Parses JSON or YAML, walks `paths`, and guesses which of our purposes each
 * operation answers - from its `operationId`, its `summary`, its tags and the
 * path itself. A guess it is not confident about is offered as "unmatched"
 * rather than assigned, because an endpoint mapped to the wrong purpose is
 * worse than one left blank: blank is visible and wrong is not.
 *
 * WHY THE YAML PARSER IS WRITTEN OUT HERE
 *
 * It handles the subset OpenAPI documents actually use - nested maps,
 * sequences, quoted and bare scalars - and nothing else. Pulling in a full YAML
 * library for this would add a parser with an attack surface (anchors, aliases,
 * custom tags, and the billion-laughs expansion that comes with them) to handle
 * a file a customer uploads. The subset below cannot expand, cannot recurse
 * into itself, and cannot construct a type.
 *
 * SERVERS ARE READ AND NOT TRUSTED
 *
 * A document's `servers[0].url` is offered as the base address, and it goes
 * through `assertSafeErpUrl` like anything a person typed - because a URL in an
 * uploaded file is exactly as untrusted as a URL in a form field, and rather
 * more likely to be overlooked.
 */
import { ErrorCode, badRequest } from '../../domain/errors.js';
import type { EndpointPurpose } from './connectors/types.js';

/** Bytes of document we are willing to parse. */
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export interface SuggestedEndpoint {
  purpose: EndpointPurpose;
  path: string;
  method: string;
  /** The document's own words, so the buyer can recognise it. */
  summary: string | null;
  /** How sure the match is, so the screen can sort and flag. */
  confidence: 'high' | 'low';
}

export interface ImportResult {
  title: string | null;
  version: string | null;
  /** The document's first server, if it named one. Validated by the caller. */
  serverUrl: string | null;
  endpoints: SuggestedEndpoint[];
  /** Operations we could not place. Shown so nothing looks silently dropped. */
  unmatched: { path: string; method: string; summary: string | null }[];
}

/**
 * The words that mean each purpose.
 *
 * Ordered: the first purpose whose patterns match wins, so the more specific
 * ones come first. `goods receipt` before `receipt`, and both before anything
 * matching a bare `order`.
 */
const PURPOSE_PATTERNS: readonly { purpose: EndpointPurpose; patterns: RegExp[] }[] =
  Object.freeze([
    {
      purpose: 'GOODS_RECEIPT',
      patterns: [/goods[\s_-]?receipt/i, /material[\s_-]?document/i, /\bgrn\b/i, /receiving/i],
    },
    {
      purpose: 'PURCHASE_ORDER_CREATE',
      patterns: [/purchase[\s_-]?order/i, /\bpo\b/i, /procurement/i, /requisition/i],
    },
    {
      purpose: 'SHIPMENT_STATUS',
      patterns: [/shipment/i, /delivery/i, /dispatch/i, /tracking/i, /consignment/i],
    },
    {
      purpose: 'INVOICE',
      patterns: [/invoice/i, /\bbilling\b/i, /supplier[\s_-]?invoice/i],
    },
    {
      purpose: 'PAYMENT_REFERENCE',
      patterns: [/payment/i, /remittance/i, /settlement/i],
    },
    {
      purpose: 'INVENTORY',
      patterns: [/inventory/i, /\bstock\b/i, /availability/i, /material[\s_-]?stock/i],
    },
    {
      purpose: 'WAREHOUSES',
      patterns: [/warehouse/i, /\bplant\b/i, /storage[\s_-]?location/i, /\bsite\b/i],
    },
    {
      purpose: 'PRODUCTS',
      patterns: [/product/i, /\bmaterial\b/i, /\bitem\b/i, /\bsku\b/i, /article/i],
    },
  ]);

/**
 * Parse a document and suggest endpoints.
 *
 * Never throws for an operation it cannot place - those go in `unmatched`. It
 * throws only when the document is not readable at all, because that is the one
 * case where there is nothing useful to show.
 */
export function importOpenApi(source: string): ImportResult {
  if (source.length > MAX_DOCUMENT_BYTES) {
    throw badRequest(
      ErrorCode.CUSTOMER_ERP_SPEC_UNUSABLE,
      'That document is larger than we can read. Trim it to the endpoints you want to ' +
        'connect, or enter them by hand.',
      [{ field: 'document', code: 'TOO_LARGE' }],
    );
  }

  const document = parseDocument(source);

  const paths = document['paths'];

  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) {
    throw badRequest(
      ErrorCode.CUSTOMER_ERP_SPEC_UNUSABLE,
      'That document has no paths section, so there is nothing to import from it.',
      [{ field: 'document', code: 'NO_PATHS' }],
    );
  }

  const info = asObject(document['info']);
  const servers = document['servers'];

  const endpoints: SuggestedEndpoint[] = [];
  const unmatched: ImportResult['unmatched'] = [];
  const claimed = new Set<EndpointPurpose>();

  for (const [path, operations] of Object.entries(paths as Record<string, unknown>)) {
    const byMethod = asObject(operations);

    for (const [method, operation] of Object.entries(byMethod)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) continue;

      const details = asObject(operation);
      const summary = asText(details['summary']) ?? asText(details['description']);
      const operationId = asText(details['operationId']);
      const tags = Array.isArray(details['tags'])
        ? (details['tags'] as unknown[]).map((tag) => asText(tag) ?? '').join(' ')
        : '';

      // The haystack, in order of how much each part is worth: an operationId
      // is authored to be meaningful, a path is structural, a summary is prose.
      const haystack = `${operationId ?? ''} ${path} ${summary ?? ''} ${tags}`;

      const match = PURPOSE_PATTERNS.find((entry) =>
        entry.patterns.some((pattern) => pattern.test(haystack)),
      );

      if (match === undefined) {
        unmatched.push({ path, method: method.toUpperCase(), summary });
        continue;
      }

      const purpose = refinePurpose(match.purpose, method, haystack);

      endpoints.push({
        purpose,
        path,
        method: method.toUpperCase(),
        summary,
        // The first candidate for a purpose is offered confidently; later ones
        // are flagged, because a document with four purchase-order operations
        // needs a person to say which one raises them.
        confidence: claimed.has(purpose) ? 'low' : 'high',
      });

      claimed.add(purpose);
    }
  }

  return {
    title: asText(info['title']),
    version: asText(info['version']),
    serverUrl:
      Array.isArray(servers) && servers.length > 0
        ? asText(asObject(servers[0])['url'])
        : null,
    endpoints,
    unmatched,
  };
}

/**
 * Split a purchase-order match into create and update.
 *
 * A POST raises one; a PATCH or PUT changes one. Getting this from the method
 * rather than from the words is right: every API in the world spells "update"
 * differently and they all agree about PATCH.
 */
function refinePurpose(
  purpose: EndpointPurpose,
  method: string,
  haystack: string,
): EndpointPurpose {
  if (purpose !== 'PURCHASE_ORDER_CREATE') return purpose;

  const lower = method.toLowerCase();

  if (lower === 'patch' || lower === 'put' || /update|change|amend|cancel/i.test(haystack)) {
    return 'PURCHASE_ORDER_UPDATE';
  }

  return 'PURCHASE_ORDER_CREATE';
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseDocument(source: string): Record<string, unknown> {
  const trimmed = source.trim();

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw badRequest(
        ErrorCode.CUSTOMER_ERP_SPEC_UNUSABLE,
        'That file starts like JSON but could not be read as JSON.',
        [{ field: 'document', code: 'INVALID_JSON' }],
      );
    }
  }

  const parsed = parseYamlSubset(trimmed);

  if (Object.keys(parsed).length === 0) {
    throw badRequest(
      ErrorCode.CUSTOMER_ERP_SPEC_UNUSABLE,
      'That file could not be read as an OpenAPI document. JSON and YAML are both fine.',
      [{ field: 'document', code: 'UNREADABLE' }],
    );
  }

  return parsed;
}

interface YamlFrame {
  indent: number;
  container: Record<string, unknown> | unknown[];
}

/**
 * A YAML parser for the subset OpenAPI documents use.
 *
 * Nested maps, sequences of maps, sequences of scalars, quoted and bare
 * scalars, `#` comments, and `|`/`>` block scalars skipped rather than
 * interpreted (nothing this importer reads is ever a block scalar). No anchors,
 * no aliases, no tags, no multi-document streams, no flow collections beyond
 * empty `{}`/`[]`.
 *
 * That is not a limitation to apologise for - it is the point. The things left
 * out are the things that turn a parser for a customer-uploaded file into an
 * amplification bug.
 */
function parseYamlSubset(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: YamlFrame[] = [{ indent: -1, container: root }];

  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';

    // A comment or a blank. `#` inside a quoted scalar is handled by
    // `splitComment` below; this only catches whole-line comments.
    if (rawLine.trim().length === 0 || rawLine.trim().startsWith('#')) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = splitComment(rawLine.trim());

    if (line.length === 0) continue;

    // Pop frames we have dedented out of.
    while (stack.length > 1 && indent <= (stack[stack.length - 1]?.indent ?? -1)) {
      stack.pop();
    }

    const frame = stack[stack.length - 1];
    if (frame === undefined) continue;

    // --- A sequence item ---
    if (line.startsWith('- ') || line === '-') {
      if (!Array.isArray(frame.container)) continue;

      const rest = line === '-' ? '' : line.slice(2).trim();

      if (rest.length === 0) {
        const child: Record<string, unknown> = {};
        frame.container.push(child);
        stack.push({ indent, container: child });
        continue;
      }

      const colon = findKeySeparator(rest);

      if (colon === -1) {
        frame.container.push(parseScalar(rest));
        continue;
      }

      // `- name: value` opens a map whose first key is on the dash line.
      const child: Record<string, unknown> = {};
      const key = unquote(rest.slice(0, colon).trim());
      const value = rest.slice(colon + 1).trim();

      if (value.length === 0) {
        const grandchild: Record<string, unknown> = {};
        child[key] = grandchild;
        frame.container.push(child);
        stack.push({ indent, container: child });
        stack.push({ indent: indent + 2, container: grandchild });
      } else {
        child[key] = parseScalar(value);
        frame.container.push(child);
        stack.push({ indent, container: child });
      }

      continue;
    }

    // --- A mapping entry ---
    const colon = findKeySeparator(line);
    if (colon === -1) continue;

    const key = unquote(line.slice(0, colon).trim());
    const value = line.slice(colon + 1).trim();

    if (Array.isArray(frame.container)) continue;

    if (value.length === 0) {
      // Look ahead to decide whether the child is a map or a sequence. The
      // alternative - guessing and correcting - means a sequence briefly
      // existing as a map, which nothing downstream would survive.
      const next = nextMeaningfulLine(lines, index + 1);
      const child: Record<string, unknown> | unknown[] =
        next !== null && next.indent > indent && next.text.startsWith('-') ? [] : {};

      frame.container[key] = child;
      stack.push({ indent, container: child });
      continue;
    }

    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      // A block scalar. Skipped rather than read: nothing this importer looks
      // at is ever one, and reading it correctly means tracking a second kind
      // of indentation.
      frame.container[key] = '';
      const blockIndent = indent;
      while (index + 1 < lines.length) {
        const peek = lines[index + 1] ?? '';
        if (peek.trim().length > 0 && peek.length - peek.trimStart().length <= blockIndent) break;
        index += 1;
      }
      continue;
    }

    frame.container[key] = parseScalar(value);
  }

  return root;
}

function nextMeaningfulLine(
  lines: readonly string[],
  from: number,
): { indent: number; text: string } | null {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;

    return { indent: line.length - line.trimStart().length, text: line.trim() };
  }

  return null;
}

/**
 * The `:` that separates a key from its value.
 *
 * Not simply `indexOf(':')`: a path key like `/orders/{id}:` is fine, but a URL
 * value like `url: https://example.com` has a colon in it, and a quoted key may
 * contain one too. So quotes are tracked and the separator is the first colon
 * outside them that is followed by a space or end of line.
 */
function findKeySeparator(line: string): number {
  let quote: string | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === ':') {
      const next = line[index + 1];
      if (next === undefined || next === ' ') return index;
    }
  }

  return -1;
}

/** Strip a trailing `# comment`, respecting quotes. */
function splitComment(line: string): string {
  let quote: string | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '#' && (index === 0 || line[index - 1] === ' ')) {
      return line.slice(0, index).trim();
    }
  }

  return line;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();

  if (trimmed === '{}' ) return {};
  if (trimmed === '[]') return [];
  if (trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);

  // A flow sequence of scalars: `tags: [orders, purchasing]`. The one flow
  // collection OpenAPI documents use often enough to be worth handling.
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((entry) => unquote(entry.trim()))
      .filter((entry) => entry.length > 0);
  }

  return unquote(trimmed);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];

    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }

  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value.length === 0 ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}
