/**
 * Field mapping: the buyer's vocabulary against ours.
 *
 * A mapping is a small, boring, closed thing on purpose. `platformField` comes
 * from a published list - a buyer cannot invent one, because nothing would read
 * it - and `erpPath` is a dotted path into their JSON. There is no expression
 * language and there will not be one: a mapping that can run arbitrary code is a
 * remote code execution primitive somebody types into a form, and every
 * integration product that has added one has spent the following year removing
 * it.
 *
 * Where a value genuinely has to change shape, a NAMED transform from the list
 * in `TRANSFORMS` does it. Five of them, each one answering a real disagreement
 * between two systems: whitespace, case, minor units against decimals, and date
 * formats.
 *
 * THE UNIT-OF-MEASURE TRAP
 *
 * Worth naming because it is the classic way an integration destroys somebody's
 * stock figures. A box of ten, sent as `quantity: 1` and read as ten units, is
 * a tenfold error that looks completely normal on both screens. So
 * `unitOfMeasure` is a mappable field in its own right, the value is carried
 * across rather than assumed, and `CustomerErpInventoryLink.erpUnitOfMeasure`
 * records what the ERP counts in so a divergence is visible. Nothing here
 * converts between units silently.
 *
 * MONEY
 *
 * Money crosses this boundary as a STRING of minor units, and any conversion to
 * a decimal happens in `MINOR_TO_DECIMAL`, by string arithmetic. `1234 / 100` is
 * fine; `12.34 * 100` is 1233.9999999999998, and a purchase order raised for one
 * unit less than the invoice is a dispute nobody can explain. See CLAUDE.md.
 */
import { ErrorCode, badRequest } from '../../domain/errors.js';

export type MappingEntity =
  | 'PRODUCT'
  | 'WAREHOUSE'
  | 'ORDER'
  | 'INVENTORY'
  | 'INVOICE'
  | 'PAYMENT'
  | 'STATUS';

export type TransformName =
  | 'TRIM'
  | 'UPPERCASE'
  | 'LOWERCASE'
  | 'MINOR_TO_DECIMAL'
  | 'DECIMAL_TO_MINOR'
  | 'ISO_DATE'
  | 'DATE_ONLY';

export const TRANSFORMS: readonly TransformName[] = Object.freeze([
  'TRIM',
  'UPPERCASE',
  'LOWERCASE',
  'MINOR_TO_DECIMAL',
  'DECIMAL_TO_MINOR',
  'ISO_DATE',
  'DATE_ONLY',
]);

export interface PlatformFieldSpec {
  key: string;
  /** What it is, in the words a buyer would use. Shown beside the input. */
  label: string;
  /**
   * Whether an active connection must map it.
   *
   * Required means "a purchase order without this is not a purchase order the
   * ERP can accept", not "we would like it". Being wrong in the strict
   * direction here means a buyer cannot activate a connection that would have
   * worked, so the list is deliberately short.
   */
  required: boolean;
  /** What kind of thing the value is, for the sample and the validator. */
  type: 'string' | 'number' | 'money' | 'date' | 'enum';
}

/**
 * Every field a mapping may name, by entity.
 *
 * This IS the published contract between the wizard and the connectors: the
 * screen renders one row per entry, the connectors read values by these keys,
 * and a key that is in one and not the other is a field that silently never
 * arrives. Adding one means adding it here, reading it in at least one
 * connector, and saying so in the guide.
 */
export const PLATFORM_FIELDS: Readonly<Record<MappingEntity, readonly PlatformFieldSpec[]>> =
  Object.freeze({
    PRODUCT: [
      { key: 'productId', label: 'Our product ID', required: false, type: 'string' },
      { key: 'sku', label: 'SKU / material number', required: true, type: 'string' },
      { key: 'name', label: 'Product name', required: false, type: 'string' },
      { key: 'unitOfMeasure', label: 'Unit of measure', required: false, type: 'string' },
      { key: 'manufacturerCode', label: 'Manufacturer code', required: false, type: 'string' },
    ],
    WAREHOUSE: [
      { key: 'warehouseCode', label: 'Warehouse code', required: false, type: 'string' },
      { key: 'plant', label: 'Plant', required: false, type: 'string' },
      { key: 'storageLocation', label: 'Storage location', required: false, type: 'string' },
    ],
    ORDER: [
      { key: 'purchaseOrderNumber', label: 'Purchase order number', required: false, type: 'string' },
      { key: 'orderNumber', label: 'Our order number', required: true, type: 'string' },
      { key: 'orderDate', label: 'Order date', required: false, type: 'date' },
      { key: 'vendorId', label: 'Vendor / supplier ID', required: false, type: 'string' },
      { key: 'customerId', label: 'Your customer number with us', required: false, type: 'string' },
      { key: 'currency', label: 'Currency', required: true, type: 'string' },
      { key: 'lineSku', label: 'Line: SKU', required: true, type: 'string' },
      { key: 'lineQuantity', label: 'Line: quantity', required: true, type: 'number' },
      { key: 'lineUnitOfMeasure', label: 'Line: unit of measure', required: false, type: 'string' },
      { key: 'lineUnitPrice', label: 'Line: unit price', required: false, type: 'money' },
      { key: 'lineNetAmount', label: 'Line: net amount', required: false, type: 'money' },
      { key: 'lineTaxAmount', label: 'Line: tax amount', required: false, type: 'money' },
      { key: 'lineWarehouse', label: 'Line: plant / storage location', required: false, type: 'string' },
      { key: 'netAmount', label: 'Order net amount', required: false, type: 'money' },
      { key: 'taxAmount', label: 'Order tax amount', required: false, type: 'money' },
      { key: 'grossAmount', label: 'Order total', required: false, type: 'money' },
      { key: 'deliveryDate', label: 'Requested delivery date', required: false, type: 'date' },
      { key: 'shipmentStatus', label: 'Shipment status', required: false, type: 'string' },
      { key: 'trackingNumber', label: 'Tracking number', required: false, type: 'string' },
    ],
    INVENTORY: [
      { key: 'sku', label: 'SKU / material number', required: true, type: 'string' },
      { key: 'plant', label: 'Plant', required: false, type: 'string' },
      { key: 'onHandQty', label: 'On hand', required: false, type: 'number' },
      { key: 'onOrderQty', label: 'On order', required: false, type: 'number' },
      { key: 'incomingQty', label: 'Incoming', required: false, type: 'number' },
      { key: 'unitOfMeasure', label: 'Unit of measure', required: false, type: 'string' },
      { key: 'receiptQuantity', label: 'Goods receipt quantity', required: false, type: 'number' },
      { key: 'goodsReceiptId', label: 'Goods receipt reference', required: false, type: 'string' },
    ],
    INVOICE: [
      { key: 'invoiceNumber', label: 'Invoice number', required: true, type: 'string' },
      { key: 'invoiceDate', label: 'Invoice date', required: false, type: 'date' },
      { key: 'dueDate', label: 'Due date', required: false, type: 'date' },
      { key: 'currency', label: 'Currency', required: true, type: 'string' },
      { key: 'netAmount', label: 'Net amount', required: false, type: 'money' },
      { key: 'taxAmount', label: 'Tax amount', required: false, type: 'money' },
      { key: 'grossAmount', label: 'Total', required: true, type: 'money' },
      { key: 'documentUrl', label: 'Document link', required: false, type: 'string' },
      { key: 'purchaseOrderNumber', label: 'Purchase order number', required: false, type: 'string' },
    ],
    PAYMENT: [
      { key: 'paymentReference', label: 'Payment reference', required: true, type: 'string' },
      { key: 'paymentStatus', label: 'Payment status', required: false, type: 'string' },
      { key: 'paidAmount', label: 'Amount paid', required: false, type: 'money' },
      { key: 'currency', label: 'Currency', required: false, type: 'string' },
      { key: 'paidAt', label: 'Paid at', required: false, type: 'date' },
      { key: 'invoiceNumber', label: 'Invoice number', required: false, type: 'string' },
    ],
    /**
     * Status vocabulary rather than field placement. `platformField` holds OUR
     * word and `erpValue` holds theirs, so one platform status may legitimately
     * have several rows - some ERPs distinguish "goods issued" from "delivered"
     * and both mean the same thing here.
     */
    STATUS: [
      { key: 'CONFIRMED', label: 'Order confirmed', required: false, type: 'enum' },
      { key: 'PROCESSING', label: 'Being prepared', required: false, type: 'enum' },
      { key: 'SHIPPED', label: 'Shipped', required: false, type: 'enum' },
      { key: 'DELIVERED', label: 'Delivered', required: false, type: 'enum' },
      { key: 'CANCELLED', label: 'Cancelled', required: false, type: 'enum' },
      { key: 'RETURNED', label: 'Returned', required: false, type: 'enum' },
    ],
  });

const FIELD_INDEX: ReadonlyMap<string, PlatformFieldSpec> = new Map(
  (Object.entries(PLATFORM_FIELDS) as [MappingEntity, readonly PlatformFieldSpec[]][]).flatMap(
    ([entity, specs]) => specs.map((spec) => [`${entity}:${spec.key}`, spec] as const),
  ),
);

export interface MappingRow {
  entity: MappingEntity;
  platformField: string;
  erpPath: string;
  constantValue: string | null;
  erpValue: string | null;
  transform: TransformName | null;
  required: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A dotted path with optional numeric segments: `Items.0.Material`. */
const PATH_PATTERN = /^[A-Za-z0-9_@$][A-Za-z0-9_@$.\-[\]]{0,190}$/;

/**
 * Structural validation, before anything is saved.
 *
 * Catches what a form can catch: an unknown field, a duplicate, a path that is
 * not a path, a transform that does not exist, a row that names neither a path
 * nor a constant. It does NOT catch a path that is simply not present in the
 * buyer's data - only a real response can say that, which is what
 * `verifyAgainstSample` is for and why activation requires it.
 */
export function assertMappingValid(rows: readonly MappingRow[]): void {
  const seen = new Set<string>();
  const details: { field: string; code: string; message: string }[] = [];

  rows.forEach((row, index) => {
    const spec = FIELD_INDEX.get(`${row.entity}:${row.platformField}`);

    if (spec === undefined) {
      details.push({
        field: `mappings.${index}.platformField`,
        code: 'UNKNOWN_FIELD',
        message: `"${row.platformField}" is not a field we can map for ${row.entity.toLowerCase()}.`,
      });
      return;
    }

    // A STATUS row is keyed by (our status, their word), so the same platform
    // status may appear more than once - that is the point of it. Everything
    // else is one row per field.
    const key =
      row.entity === 'STATUS'
        ? `${row.entity}:${row.platformField}:${row.erpValue ?? ''}`
        : `${row.entity}:${row.platformField}`;

    if (seen.has(key)) {
      details.push({
        field: `mappings.${index}.platformField`,
        code: 'DUPLICATE',
        message: `${spec.label} is mapped more than once.`,
      });
    }
    seen.add(key);

    const hasPath = row.erpPath.trim().length > 0;
    const hasConstant = (row.constantValue ?? '').trim().length > 0;
    const hasErpValue = (row.erpValue ?? '').trim().length > 0;

    if (row.entity === 'STATUS') {
      if (!hasErpValue) {
        details.push({
          field: `mappings.${index}.erpValue`,
          code: 'REQUIRED',
          message: `Enter what your system calls "${spec.label}".`,
        });
      }
      return;
    }

    if (!hasPath && !hasConstant) {
      details.push({
        field: `mappings.${index}.erpPath`,
        code: 'REQUIRED',
        message: `${spec.label} needs either a field in your system or a fixed value.`,
      });
      return;
    }

    if (hasPath && !PATH_PATTERN.test(row.erpPath.trim())) {
      details.push({
        field: `mappings.${index}.erpPath`,
        code: 'INVALID_PATH',
        message:
          'Use the field name as it appears in your system, with a dot between levels - ' +
          'for example Items.0.Material.',
      });
    }

    if (row.transform !== null && !TRANSFORMS.includes(row.transform)) {
      details.push({
        field: `mappings.${index}.transform`,
        code: 'UNKNOWN_TRANSFORM',
        message: `"${row.transform}" is not a conversion we can apply.`,
      });
    }
  });

  if (details.length > 0) {
    throw badRequest(
      ErrorCode.CUSTOMER_ERP_MAPPING_INVALID,
      'Some of the field mapping needs attention before it can be saved.',
      details,
    );
  }
}

/**
 * Which required fields are still unmapped, for the entities in play.
 *
 * Only asked about entities the policy actually sends, so a buyer who has
 * switched invoices off is not held to the invoice mapping. Returns labels
 * rather than keys, because the answer is shown to a person.
 */
/**
 * Which entities a connection is held to a complete mapping for.
 *
 * One entity per thing a connection actually does, each gated on the policy
 * flag that decides whether it is ever sent. ORDER used to be ungated, and
 * being the only one made a read-only connection impossible to switch on: a
 * buyer whose ERP is a product list, with purchase orders switched off, was
 * still required to map an order number, a currency and a line quantity - to
 * an ERP that has none of the three, for a purchase order that was never going
 * to be raised.
 *
 * `sendPurchaseOrders` defaults to TRUE where a connection has expressed no
 * opinion, matching the endpoint check that runs beside this one. Purchase
 * orders are what the feature is for; switching them off is the deliberate act.
 */
export function mappedEntitiesFor(policy: {
  sendPurchaseOrders?: boolean | null;
  sendInvoices?: boolean | null;
  syncInventory?: boolean | null;
  sendPaymentReferences?: boolean | null;
} | null): MappingEntity[] {
  const entities: MappingEntity[] = [];

  if (policy?.sendPurchaseOrders ?? true) entities.push('ORDER');
  if (policy?.sendInvoices === true) entities.push('INVOICE');
  if (policy?.syncInventory === true) entities.push('INVENTORY');
  if (policy?.sendPaymentReferences === true) entities.push('PAYMENT');

  return entities;
}

export function missingRequiredFields(
  rows: readonly MappingRow[],
  entities: readonly MappingEntity[],
): string[] {
  const mapped = new Set(rows.map((row) => `${row.entity}:${row.platformField}`));

  return entities.flatMap((entity) =>
    PLATFORM_FIELDS[entity]
      .filter((spec) => spec.required && !mapped.has(`${entity}:${spec.key}`))
      .map((spec) => spec.label),
  );
}

// ---------------------------------------------------------------------------
// Reading a value out of the ERP's JSON
// ---------------------------------------------------------------------------

/**
 * Follow a dotted path.
 *
 * Numeric segments index arrays, and `[0]` is accepted as well as `.0` because
 * both spellings turn up in the documentation buyers copy from. Returns
 * `undefined` for anything the path does not reach, which is different from
 * `null` - a field the ERP explicitly set to null.
 */
export function readPath(source: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  let cursor: unknown = source;

  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;

    if (Array.isArray(cursor)) {
      const index = Number.parseInt(segment, 10);
      if (Number.isNaN(index)) return undefined;
      cursor = cursor[index];
      continue;
    }

    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return cursor;
}

/**
 * Write a value at a dotted path, creating the objects on the way.
 *
 * Used to build an outbound body from the mapping. Numeric segments create
 * arrays, so `Items.0.Material` produces `{Items:[{Material:...}]}` rather than
 * `{Items:{"0":{...}}}` - a distinction SAP cares about a great deal.
 */
export function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return;

  let cursor: Record<string, unknown> | unknown[] = target;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const nextSegment = segments[index + 1] as string;
    const nextIsIndex = /^\d+$/.test(nextSegment);

    if (Array.isArray(cursor)) {
      const position = Number.parseInt(segment, 10);
      if (Number.isNaN(position)) return;
      cursor[position] ??= nextIsIndex ? [] : {};
      cursor = cursor[position] as Record<string, unknown> | unknown[];
      continue;
    }

    (cursor)[segment] ??= nextIsIndex ? [] : {};
    cursor = (cursor)[segment] as Record<string, unknown> | unknown[];
  }

  const last = segments[segments.length - 1] as string;

  if (Array.isArray(cursor)) {
    const position = Number.parseInt(last, 10);
    if (!Number.isNaN(position)) cursor[position] = value;
    return;
  }

  (cursor)[last] = value;
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/**
 * Minor units to a decimal string, by string arithmetic.
 *
 * Never `Number`. A total above 2^53 minor units is not theoretical for a
 * currency with no minor unit, and half a paisa of drift on a purchase order is
 * a mismatch somebody in accounts payable has to reconcile by hand.
 */
export function minorToDecimal(minor: string, exponent = 2): string {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).replace(/\D/g, '') || '0';

  if (exponent === 0) return `${negative ? '-' : ''}${digits}`;

  const padded = digits.padStart(exponent + 1, '0');
  const whole = padded.slice(0, padded.length - exponent);
  const fraction = padded.slice(padded.length - exponent);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** A decimal string to minor units, by string arithmetic. Same reason. */
export function decimalToMinor(value: string, exponent = 2): string {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;

  const [wholePart = '0', fractionPart = ''] = unsigned.split('.');
  const whole = wholePart.replace(/\D/g, '') || '0';
  const fraction = fractionPart.replace(/\D/g, '').padEnd(exponent, '0').slice(0, exponent);

  const combined = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  return `${negative && combined !== '0' ? '-' : ''}${combined}`;
}

/**
 * A value as text, without ever producing "[object Object]".
 *
 * `String(value)` on an `unknown` is how a mapped field silently becomes the
 * literal text "[object Object]" in somebody's purchase order - it looks like
 * data, it passes every validation the ERP has, and nobody notices until a
 * buyer asks why their material number is that. An object here means the
 * mapping pointed at a nested structure rather than at a leaf, which is a
 * mapping error: JSON is the honest rendering of it, and it is visible as
 * wrong.
 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return '';

  return JSON.stringify(value) ?? '';
}

export function applyTransform(
  value: unknown,
  transform: TransformName | null,
  exponent = 2,
): unknown {
  if (transform === null || value === null || value === undefined) return value;

  // Narrowed rather than coerced. Coercing an object gives "[object Object]",
  // which would then be trimmed, upper-cased and sent to somebody's ERP as a
  // material number - a value that looks like data and is not.
  const asText = stringify(value);

  switch (transform) {
    case 'TRIM':
      return asText.trim();
    case 'UPPERCASE':
      return asText.trim().toUpperCase();
    case 'LOWERCASE':
      return asText.trim().toLowerCase();
    case 'MINOR_TO_DECIMAL':
      return minorToDecimal(asText, exponent);
    case 'DECIMAL_TO_MINOR':
      return decimalToMinor(asText, exponent);
    case 'ISO_DATE': {
      const parsed = value instanceof Date ? value : new Date(asText);
      return Number.isNaN(parsed.getTime()) ? asText : parsed.toISOString();
    }
    case 'DATE_ONLY': {
      const parsed = value instanceof Date ? value : new Date(asText);
      return Number.isNaN(parsed.getTime()) ? asText : parsed.toISOString().slice(0, 10);
    }
  }
}

// ---------------------------------------------------------------------------
// Applying a mapping
// ---------------------------------------------------------------------------

/** The platform-side values one entity contributes, keyed by `platformField`. */
export type PlatformValues = Record<string, unknown>;

/**
 * Build the ERP's shape from ours.
 *
 * A row with a `constantValue` writes that constant; a row with an `erpPath`
 * writes the platform value at that path. A required platform value that is
 * absent is reported rather than silently omitted - an ERP that receives a
 * purchase order line with no quantity will either reject it or, worse, accept
 * it as zero.
 *
 * WHAT "REQUIRED" MEANS, AND WHAT IT DOES NOT
 *
 * Required is a property of a field within a DOCUMENT, not of the entity across
 * every document written through it. One entity serves several documents: the
 * INVENTORY mapping shapes both a stock figure read back from the ERP - which
 * is nothing without a SKU - and the header of a goods receipt, which is a
 * statement about an order and has no single SKU at all, its materials being
 * one per line.
 *
 * So the caller's own keys decide. A field the caller did not put in `values`
 * is not part of the document being written, and is skipped; a field the caller
 * DID put there and left empty is a real gap and is reported. Every caller that
 * checks `missing` passes its whole key set explicitly, with null for what it
 * has not got - which is what makes the distinction meaningful rather than an
 * accident of how a payload was built.
 */
export function applyOutbound(
  rows: readonly MappingRow[],
  entity: MappingEntity,
  values: PlatformValues,
  options: { currencyExponent?: number } = {},
): { body: Record<string, unknown>; missing: string[] } {
  const body: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const row of rows) {
    if (row.entity !== entity) continue;
    if (row.erpPath.trim().length === 0) continue;

    const constant = (row.constantValue ?? '').trim();

    if (constant.length > 0) {
      writePath(body, row.erpPath.trim(), constant);
      continue;
    }

    const raw = values[row.platformField];

    if (raw === undefined || raw === null || raw === '') {
      if (row.required && row.platformField in values) {
        missing.push(
          FIELD_INDEX.get(`${entity}:${row.platformField}`)?.label ?? row.platformField,
        );
      }
      continue;
    }

    writePath(
      body,
      row.erpPath.trim(),
      applyTransform(raw, row.transform, options.currencyExponent ?? 2),
    );
  }

  return { body, missing };
}

/** Read the ERP's shape into ours. The mirror of `applyOutbound`. */
export function applyInbound(
  rows: readonly MappingRow[],
  entity: MappingEntity,
  record: unknown,
  options: { currencyExponent?: number } = {},
): PlatformValues {
  const values: PlatformValues = {};

  for (const row of rows) {
    if (row.entity !== entity) continue;

    const constant = (row.constantValue ?? '').trim();

    if (row.erpPath.trim().length === 0) {
      if (constant.length > 0) values[row.platformField] = constant;
      continue;
    }

    const raw = readPath(record, row.erpPath.trim());
    if (raw === undefined) continue;

    values[row.platformField] = applyTransform(
      raw,
      row.transform,
      options.currencyExponent ?? 2,
    );
  }

  return values;
}

/**
 * Translate a platform status into the buyer's word for it, and back.
 *
 * Both directions from one set of rows, because a mapping that said "shipped"
 * means "Goods Issued" outbound but something else inbound would be two
 * mappings pretending to be one.
 */
export function statusToErp(rows: readonly MappingRow[], platformStatus: string): string | null {
  const row = rows.find(
    (entry) => entry.entity === 'STATUS' && entry.platformField === platformStatus,
  );

  return row?.erpValue ?? null;
}

export function statusFromErp(rows: readonly MappingRow[], erpValue: string): string | null {
  const normalised = erpValue.trim().toLowerCase();

  const row = rows.find(
    (entry) =>
      entry.entity === 'STATUS' && (entry.erpValue ?? '').trim().toLowerCase() === normalised,
  );

  return row?.platformField ?? null;
}

// ---------------------------------------------------------------------------
// Checking a mapping against something real
// ---------------------------------------------------------------------------

export interface SampleCheckResult {
  ok: boolean;
  /** One line per mapped field: what was looked for, and what was found. */
  fields: {
    entity: MappingEntity;
    platformField: string;
    label: string;
    erpPath: string;
    found: boolean;
    /** The value, stringified and capped. Never a whole nested object. */
    sample: string | null;
  }[];
  /** Required fields whose path found nothing. The reason `ok` is false. */
  missing: string[];
}

/**
 * Check a mapping against a real record from the buyer's own system.
 *
 * This is what activation requires, and the reason it does is worth stating: a
 * structurally valid mapping is a guess about somebody else's JSON. `Items.0.
 * Material` is a perfectly well-formed path that finds nothing at all if their
 * field is called `Material_No`, and the first anybody would learn of it is a
 * purchase order raised with no line items.
 *
 * A field that is mapped and NOT found is reported for every field, not only
 * the required ones - a buyer looking at this list is checking their own work,
 * and "found: no" beside an optional field is exactly the sort of thing they
 * spot immediately and we never could.
 */
export function verifyAgainstSample(
  rows: readonly MappingRow[],
  entity: MappingEntity,
  record: unknown,
): SampleCheckResult {
  const fields: SampleCheckResult['fields'] = [];
  const missing: string[] = [];

  for (const row of rows) {
    if (row.entity !== entity) continue;
    if (row.erpPath.trim().length === 0) continue;

    const spec = FIELD_INDEX.get(`${entity}:${row.platformField}`);
    const label = spec?.label ?? row.platformField;
    const value = readPath(record, row.erpPath.trim());
    const found = value !== undefined;

    if (!found && row.required) missing.push(label);

    fields.push({
      entity,
      platformField: row.platformField,
      label,
      erpPath: row.erpPath.trim(),
      found,
      sample: found ? summarise(value) : null,
    });
  }

  return { ok: missing.length === 0, fields, missing };
}

/**
 * A value, small enough to show.
 *
 * Capped hard. This lands in a response the buyer reads, and a nested object
 * from their ERP could be a megabyte of somebody else's purchase history.
 */
function summarise(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') {
    const serialised = JSON.stringify(value) ?? '';
    return serialised.length > 120 ? `${serialised.slice(0, 117)}...` : serialised;
  }

  const text = stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * Find the array of records in a response.
 *
 * `recordsPath` where the endpoint names one; otherwise the body itself if it
 * is an array, and otherwise the first array-valued property - which is how
 * `{"value":[...]}` (OData), `{"data":[...]}` and `{"items":[...]}` all work
 * without the buyer having to be told which of the three their system uses.
 */
export function extractRecords(body: unknown, recordsPath: string | null): unknown[] {
  if (recordsPath !== null && recordsPath.trim().length > 0) {
    const found = readPath(body, recordsPath.trim());
    if (Array.isArray(found)) return found;

    throw badRequest(
      ErrorCode.CUSTOMER_ERP_RESPONSE_UNUSABLE,
      `Your system answered, but there is no list of records at "${recordsPath}".`,
      [{ field: 'recordsPath', code: 'NOT_AN_ARRAY' }],
    );
  }

  if (Array.isArray(body)) return body;

  if (body !== null && typeof body === 'object') {
    for (const value of Object.values(body as Record<string, unknown>)) {
      if (Array.isArray(value)) return value;
    }
  }

  throw badRequest(
    ErrorCode.CUSTOMER_ERP_RESPONSE_UNUSABLE,
    'Your system answered, but not with a list of records we could read. Set the ' +
      '"records path" on the endpoint to tell us where the list is.',
    [{ field: 'recordsPath', code: 'NO_RECORDS' }],
  );
}

