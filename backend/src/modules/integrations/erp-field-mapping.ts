/**
 * Translating between a customer's ERP JSON and this platform's fields.
 *
 * This module is the reason a second customer with a completely different ERP
 * costs nothing. Their stock endpoint answers
 *
 *     { "d": { "results": [ { "Material": "X-1", "Werks": "1000",
 *                             "LabSt": "42.000", "Meins": "EA" } ] } }
 *
 * and the next customer's answers
 *
 *     [ { "sku": "X-1", "warehouse": "MAIN", "qty_available": 42 } ]
 *
 * Neither is wrong and neither is going to change for us. So the shape is
 * DATA: a mapping from our field names to dotted paths into their JSON, saved
 * on the connection and applied at read time. No branch anywhere in this
 * codebase knows a vendor's name.
 *
 * Three rules that keep that from becoming a footgun:
 *
 *   1. **A mapping is validated twice.** `validateFieldMapping` checks it makes
 *      structural sense - required fields present, no path mapped to two
 *      places, no path that could walk out of the object. `verifyAgainstSample`
 *      then checks it against a response the ERP actually sent, because a
 *      structurally perfect mapping is still a guess about somebody else's
 *      JSON until a real document has been through it. A connection cannot be
 *      switched on without both.
 *
 *   2. **Paths are read, never evaluated.** `readPath` walks own properties
 *      only and refuses `__proto__`, `constructor` and `prototype`. A mapping
 *      is customer input, and customer input that can reach
 *      `Object.prototype` is a prototype-pollution primitive with a form field
 *      in front of it.
 *
 *   3. **Types are coerced deliberately and narrowly.** An ERP that sends
 *      `"42.000"` for a quantity means 42; one that sends `"forty-two"` means
 *      the mapping is wrong, and a silent `NaN` becoming zero would empty a
 *      warehouse. `coerceQuantity` returns null and the record is reported as
 *      a failure rather than applied.
 */
import { ErrorCode, badRequest } from '../../domain/errors.js';

// ---------------------------------------------------------------------------
// The fields a mapping can name
// ---------------------------------------------------------------------------

/**
 * Everything this platform can read out of a customer's ERP.
 *
 * `required` is per feature, not global. A customer syncing stock and not
 * pushing orders needs `sku` and `availableQuantity` and nothing about order
 * references; requiring all fourteen of them everywhere would make the common
 * case impossible to configure.
 */
export const MAPPING_FIELDS = Object.freeze({
  // --- Product identity ---
  productId: { label: 'Product ID', group: 'product', kind: 'string' },
  sku: { label: 'SKU', group: 'product', kind: 'string' },
  productName: { label: 'Product name', group: 'product', kind: 'string' },

  // --- Inventory ---
  warehouseId: { label: 'Warehouse ID', group: 'inventory', kind: 'string' },
  unitOfMeasure: { label: 'Unit of measure', group: 'inventory', kind: 'string' },
  availableQuantity: { label: 'Available quantity', group: 'inventory', kind: 'number' },
  reservedQuantity: { label: 'Reserved quantity', group: 'inventory', kind: 'number' },

  // --- Money ---
  price: { label: 'Price', group: 'pricing', kind: 'money' },
  currency: { label: 'Currency', group: 'pricing', kind: 'currency' },

  // --- Orders ---
  customerReference: { label: 'Customer reference', group: 'order', kind: 'string' },
  platformOrderId: { label: 'Platform order ID', group: 'order', kind: 'string' },
  erpOrderId: { label: 'ERP order ID', group: 'order', kind: 'string' },
  paymentReference: { label: 'Payment reference', group: 'order', kind: 'string' },
  orderStatus: { label: 'Order status', group: 'order', kind: 'string' },
} as const);

export type MappingField = keyof typeof MAPPING_FIELDS;

export const MAPPING_FIELD_NAMES = Object.keys(MAPPING_FIELDS) as MappingField[];

/**
 * A saved mapping.
 *
 * `itemsPath` is the odd one out and the most important: it says where in the
 * response the array of records lives. An ERP answering `{"d":{"results":[…]}}`
 * sets it to `d.results`; one answering a bare array leaves it empty. Getting
 * this wrong is the single most common configuration mistake, which is why the
 * dry run reports what it found there in words.
 */
export interface FieldMapping {
  /** Dotted path to the array of records. Empty means the response IS the array. */
  itemsPath?: string;
  /** Platform field -> dotted path in the customer's JSON. */
  fields: Partial<Record<MappingField, string>>;
  /**
   * ERP warehouse identifier -> this platform's inventory location code.
   *
   * Optional. Without it, a synced record is applied to the customer's default
   * location; with it, a multi-warehouse ERP lands in the right place. A
   * warehouse the ERP names and this map does not is reported as a failed
   * record rather than being guessed at - putting stock in the wrong building
   * is worse than not putting it anywhere.
   */
  warehouseMap?: Record<string, string>;
  /**
   * ERP order status -> a word this platform shows the customer. Free-form on
   * purpose: it is displayed, never acted on, and an ERP's status vocabulary is
   * its own business.
   */
  orderStatusMap?: Record<string, string>;
}

/** The fields each feature cannot work without. */
export const REQUIRED_FIELDS = Object.freeze({
  /// Reading stock. The SKU is what matches a record to a product here, and
  /// the quantity is the thing being synchronised; there is no useful sync
  /// without both.
  inventory: ['sku', 'availableQuantity'] as MappingField[],
  /// Sending an order. The ERP has to be able to say what it created, or the
  /// push cannot be confirmed and every retry is a guess.
  order: ['sku', 'erpOrderId'] as MappingField[],
});

// ---------------------------------------------------------------------------
// Reading a path
// ---------------------------------------------------------------------------

/**
 * Segments that would leave the object graph.
 *
 * A mapping is customer input. Without this, `__proto__.polluted` in a form
 * field reaches `Object.prototype`, and from there every plain object in the
 * process.
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** A path segment: a property name, or `[0]` for an array index. */
const PATH_SEGMENT = /^[A-Za-z0-9_$@.-]+$/;

/**
 * Follow a dotted path through parsed JSON.
 *
 * Supports `a.b.c` and `a.0.c` for arrays, which is how ERPs that wrap a single
 * value in a one-element list are read without a special case. Returns
 * `undefined` for anything absent rather than throwing: a record missing an
 * optional field is ordinary, and the caller decides whether it matters.
 */
export function readPath(source: unknown, path: string): unknown {
  if (path === '') return source;

  let current: unknown = source;

  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;

    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (Number.isNaN(index)) return undefined;
      current = current[index];
      continue;
    }

    if (typeof current !== 'object') return undefined;

    // Own properties only. An inherited one is not data the ERP sent.
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/**
 * A quantity, or null when the value is not one.
 *
 * ERPs send `42`, `"42"`, `"42.000"` and `42.0` for the same figure and all
 * four mean the same thing. They also, occasionally, send `""`, `null` or
 * `"N/A"`, and the difference between "zero in stock" and "the ERP did not say"
 * is the difference between refusing an order and losing a sale - so an
 * unreadable value returns null and the record is reported, never quietly
 * treated as zero.
 *
 * A fractional quantity is refused rather than rounded. This platform counts
 * whole units, and silently turning 0.4 into 0 - or into 1 - is a decision
 * about somebody's stock that nothing here is entitled to make.
 */
export function coerceQuantity(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? value : null;
  }

  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * A money amount in MINOR units, as a BigInt.
 *
 * Never a float, at any point, including inside this function - see CLAUDE.md.
 * `"12.34"` becomes `1234n` by splitting the string on the decimal point and
 * padding, not by multiplying by 100, because `12.34 * 100` is 1233.9999999998
 * and the customer would be billed accordingly.
 *
 * The exponent is the currency's, passed in rather than assumed: JPY has none
 * and KWD has three, and a hard-coded 2 would be wrong for both.
 */
export function coerceMoneyMinor(value: unknown, exponent: number): bigint | null {
  const text =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value.toString()
        : ''
      : typeof value === 'string'
        ? value.trim()
        : '';

  if (text === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '0', fraction = ''] = unsigned.split('.');

  // More decimals than the currency has is not a rounding problem to solve
  // quietly: it means the mapping is pointing at the wrong field, or the ERP
  // is sending a unit price where a line total was expected.
  if (fraction.length > exponent) return null;

  const padded = fraction.padEnd(exponent, '0');
  const minor = BigInt(whole) * BigInt(10) ** BigInt(exponent) + BigInt(padded === '' ? '0' : padded);

  return negative ? -minor : minor;
}

/** A three-letter currency code, upper-cased, or null. */
export function coerceCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

/** A trimmed string, or null when absent or empty. */
export function coerceString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  // A numeric SKU is common and perfectly valid; it just arrived unquoted.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface MappingValidationIssue {
  field: string;
  code: string;
  message: string;
}

export interface MappingValidationResult {
  ok: boolean;
  issues: MappingValidationIssue[];
  /** Fields that resolved to a value during a sample check. */
  resolved: { field: MappingField; path: string; sample: string | null }[];
}

function isSafePath(path: string): boolean {
  if (path === '' || path.length > 256) return false;
  const segments = path.split('.');
  if (segments.length > 12) return false;
  return segments.every(
    (segment) =>
      segment !== '' && PATH_SEGMENT.test(segment) && !FORBIDDEN_SEGMENTS.has(segment),
  );
}

/**
 * Parse whatever is in `fieldMappingJson` into a mapping, or reject it.
 *
 * The column is `Json`, so what comes out of the database is `unknown` and has
 * to be narrowed before anything reads it. Doing that here rather than at each
 * call site means a mapping saved by an older version, or edited in the
 * database by hand, fails in one place with one message.
 */
export function parseFieldMapping(value: unknown): FieldMapping | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const source = value as Record<string, unknown>;
  const rawFields = source['fields'];
  if (rawFields === null || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
    return null;
  }

  const fields: Partial<Record<MappingField, string>> = {};
  for (const name of MAPPING_FIELD_NAMES) {
    const path = (rawFields as Record<string, unknown>)[name];
    if (typeof path === 'string' && path !== '') fields[name] = path;
  }

  const itemsPath = source['itemsPath'];
  const warehouseMap = source['warehouseMap'];
  const orderStatusMap = source['orderStatusMap'];

  return {
    ...(typeof itemsPath === 'string' ? { itemsPath } : {}),
    fields,
    ...(isStringRecord(warehouseMap) ? { warehouseMap } : {}),
    ...(isStringRecord(orderStatusMap) ? { orderStatusMap } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');
}

/**
 * Does this mapping make structural sense for the features that are switched on?
 *
 * Returns issues rather than throwing, because the screen shows them all at
 * once: a customer fixing one field at a time through six round trips is how a
 * setup form gets abandoned.
 */
export function validateFieldMapping(
  mapping: FieldMapping,
  features: { inventory: boolean; order: boolean },
): MappingValidationResult {
  const issues: MappingValidationIssue[] = [];

  if (mapping.itemsPath !== undefined && mapping.itemsPath !== '' && !isSafePath(mapping.itemsPath)) {
    issues.push({
      field: 'fieldMapping.itemsPath',
      code: 'PATH_INVALID',
      message:
        'The path to the list of records may only contain letters, numbers, dots, dashes and ' +
        'underscores.',
    });
  }

  for (const [name, path] of Object.entries(mapping.fields)) {
    if (!MAPPING_FIELD_NAMES.includes(name as MappingField)) {
      issues.push({
        field: `fieldMapping.fields.${name}`,
        code: 'UNKNOWN_FIELD',
        message: `"${name}" is not a field this system can read.`,
      });
      continue;
    }

    if (!isSafePath(path)) {
      issues.push({
        field: `fieldMapping.fields.${name}`,
        code: 'PATH_INVALID',
        message:
          `The path for ${MAPPING_FIELDS[name as MappingField].label} is not usable. Use ` +
          'dotted names like data.items.0.sku.',
      });
    }
  }

  // The same path answering two different fields is nearly always a copy-paste
  // slip, and the consequence - a price read out of the quantity column - is
  // bad enough to be worth refusing rather than warning about.
  const seen = new Map<string, MappingField>();
  for (const [name, path] of Object.entries(mapping.fields) as [MappingField, string][]) {
    const previous = seen.get(path);
    if (previous !== undefined) {
      issues.push({
        field: `fieldMapping.fields.${name}`,
        code: 'PATH_DUPLICATED',
        message:
          `${MAPPING_FIELDS[name].label} and ${MAPPING_FIELDS[previous].label} both read from ` +
          `"${path}". Each field needs its own path.`,
      });
    }
    seen.set(path, name);
  }

  for (const [feature, enabled] of [
    ['inventory', features.inventory],
    ['order', features.order],
  ] as const) {
    if (!enabled) continue;

    for (const required of REQUIRED_FIELDS[feature]) {
      if (mapping.fields[required] === undefined) {
        issues.push({
          field: `fieldMapping.fields.${required}`,
          code: 'FIELD_REQUIRED',
          message: `${MAPPING_FIELDS[required].label} has to be mapped before ${feature} ` +
            'synchronisation can be switched on.',
        });
      }
    }
  }

  // A warehouse map pointing at nothing is worse than none at all: records for
  // that warehouse fail one by one, at sync time, with no obvious cause.
  for (const [external, internal] of Object.entries(mapping.warehouseMap ?? {})) {
    if (external.trim() === '' || internal.trim() === '') {
      issues.push({
        field: 'fieldMapping.warehouseMap',
        code: 'WAREHOUSE_MAP_INCOMPLETE',
        message: 'Every warehouse mapping needs both an ERP identifier and a warehouse here.',
      });
      break;
    }
  }

  return { ok: issues.length === 0, issues, resolved: [] };
}

/**
 * Check a mapping against a document the ERP actually sent.
 *
 * This is what `mappingVerifiedAt` records, and what a dry run runs. The
 * structural check above proves the mapping is well formed; only this proves it
 * describes the JSON in front of it.
 *
 * Reports what each field resolved to, truncated, so the screen can show
 * "SKU -> data.items.0.sku -> "MED-4471"" and the customer can see at a glance
 * that the price column is reading the quantity.
 */
export function verifyAgainstSample(
  mapping: FieldMapping,
  sample: unknown,
  features: { inventory: boolean; order: boolean },
  /**
   * Which field groups this sample could possibly contain.
   *
   * A stock record has no ERP order id in it, and never will - that field
   * describes the response to an order CREATION. Checking it against an
   * inventory sample reports "nothing found at id" every time, which is not a
   * problem with the customer's mapping but a question asked of the wrong
   * document. Omit to check everything.
   */
  groups?: readonly string[],
): MappingValidationResult {
  const structural = validateFieldMapping(mapping, features);
  const issues = [...structural.issues];
  const resolved: MappingValidationResult['resolved'] = [];

  const records = extractRecords(mapping, sample);

  if (records === null) {
    issues.push({
      field: 'fieldMapping.itemsPath',
      code: 'ITEMS_PATH_NOT_A_LIST',
      message:
        mapping.itemsPath === undefined || mapping.itemsPath === ''
          ? 'The response is not a list of records. Set the path to the list - for example ' +
            'data.items.'
          : `There is no list of records at "${mapping.itemsPath}" in the response.`,
    });

    return { ok: false, issues, resolved };
  }

  if (records.length === 0) {
    issues.push({
      field: 'fieldMapping.itemsPath',
      code: 'ITEMS_EMPTY',
      message:
        'The response contained no records, so the mapping could not be checked against real ' +
        'data. Try again when the endpoint has something to return.',
    });

    return { ok: false, issues, resolved };
  }

  const first = records[0];

  for (const [name, path] of Object.entries(mapping.fields) as [MappingField, string][]) {
    if (!MAPPING_FIELD_NAMES.includes(name)) continue;

    const spec = MAPPING_FIELDS[name];
    // Not in this document's groups: not checked, not reported either way.
    if (groups !== undefined && !groups.includes(spec.group)) continue;

    const raw = readPath(first, path);

    if (raw === undefined || raw === null) {
      // A required field that is absent from a real record is a hard failure.
      // An optional one that is absent is only worth mentioning.
      const required =
        (features.inventory && REQUIRED_FIELDS.inventory.includes(name)) ||
        (features.order && REQUIRED_FIELDS.order.includes(name));

      issues.push({
        field: `fieldMapping.fields.${name}`,
        code: required ? 'PATH_NOT_FOUND' : 'PATH_NOT_FOUND_OPTIONAL',
        message: `${spec.label}: nothing was found at "${path}" in the first record returned.`,
      });

      resolved.push({ field: name, path, sample: null });
      continue;
    }

    const typeIssue = checkKind(name, spec.kind, raw);
    if (typeIssue !== null) issues.push(typeIssue);

    resolved.push({ field: name, path, sample: preview(raw) });
  }

  // Only hard issues block. An optional field that did not resolve is
  // information, not a refusal - plenty of ERPs omit a field on a record that
  // has no value for it.
  const blocking = issues.filter((issue) => issue.code !== 'PATH_NOT_FOUND_OPTIONAL');

  return { ok: blocking.length === 0, issues, resolved };
}

function checkKind(
  name: MappingField,
  kind: string,
  raw: unknown,
): MappingValidationIssue | null {
  const label = MAPPING_FIELDS[name].label;

  switch (kind) {
    case 'number':
      return coerceQuantity(raw) === null
        ? {
            field: `fieldMapping.fields.${name}`,
            code: 'TYPE_MISMATCH',
            message: `${label} should be a whole number, but the record contains ${preview(raw) ?? 'nothing usable'}.`,
          }
        : null;

    case 'money':
      // Checked against two decimals here rather than the real currency
      // exponent: this is a shape check on a sample, and the currency of an
      // arbitrary sample record is not known yet.
      return coerceMoneyMinor(raw, 2) === null
        ? {
            field: `fieldMapping.fields.${name}`,
            code: 'TYPE_MISMATCH',
            message: `${label} should be an amount, but the record contains ${preview(raw) ?? 'nothing usable'}.`,
          }
        : null;

    case 'currency':
      return coerceCurrency(raw) === null
        ? {
            field: `fieldMapping.fields.${name}`,
            code: 'TYPE_MISMATCH',
            message: `${label} should be a three-letter code such as EUR, but the record contains ${preview(raw) ?? 'nothing usable'}.`,
          }
        : null;

    default:
      return coerceString(raw) === null
        ? {
            field: `fieldMapping.fields.${name}`,
            code: 'TYPE_MISMATCH',
            message: `${label} should be text, but the record contains ${preview(raw) ?? 'nothing usable'}.`,
          }
        : null;
  }
}

/**
 * The array of records inside a response, or null when there is not one.
 *
 * Null and empty are different answers and the caller treats them differently:
 * null means the mapping is pointing at the wrong place, empty means the ERP
 * had nothing to say today.
 */
export function extractRecords(mapping: FieldMapping, payload: unknown): unknown[] | null {
  const path = mapping.itemsPath ?? '';
  const target = path === '' ? payload : readPath(payload, path);

  // `unknown[]`, not `any[]`. `Array.isArray` on an `unknown` widens to
  // `any[]`, and returning that would quietly switch off type checking for
  // every caller that iterates the result.
  if (Array.isArray(target)) return target as unknown[];

  // A single object where a list was expected is common enough - an ERP
  // answering a one-SKU query - that treating it as a list of one is kinder
  // than refusing, and cannot be ambiguous: an object is not a list of objects
  // by any other reading.
  if (target !== null && typeof target === 'object') return [target];

  return null;
}

/** A short, safe rendering of a value, for a message a customer reads. */
function preview(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  // `String()` on an arbitrary object yields "[object Object]", which tells a
  // customer nothing about why their mapping is wrong. Objects and arrays are
  // serialised; everything else has a useful primitive rendering.
  const text =
    typeof value === 'object'
      ? (JSON.stringify(value) ?? '')
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
          ? String(value)
          : '';

  if (text === '') return null;
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Throw if a mapping cannot be saved at all.
 *
 * Used on the write path, where there is one answer rather than a list to
 * render. The screen calls `validateFieldMapping` and shows everything; this is
 * the backstop for a client that did not.
 */
export function assertMappingValid(
  mapping: FieldMapping,
  features: { inventory: boolean; order: boolean },
): void {
  const result = validateFieldMapping(mapping, features);
  if (result.ok) return;

  throw badRequest(
    ErrorCode.ERP_MAPPING_INVALID,
    'The field mapping is not complete. Check the highlighted fields.',
    result.issues.map((issue) => ({
      field: issue.field,
      code: issue.code,
      message: issue.message,
    })),
  );
}
