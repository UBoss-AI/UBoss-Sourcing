/**
 * Bulk product import.
 *
 * A catalogue import is the fastest way to wreck a catalogue, so this module
 * is built around four rules:
 *
 *   1. **One validator.** The dry run and the real run call the same
 *      `validateRow`. A preview that disagrees with the outcome is worse than
 *      no preview at all, and the only way to guarantee agreement is to have
 *      one code path.
 *   2. **Re-validate at confirm.** Counts from a dry run are a forecast, not a
 *      promise - a SKU can be taken, a category archived, a tax class
 *      deactivated between preview and confirm. The file is re-read from
 *      storage and re-checked.
 *   3. **A bad file imports nothing.** Confirm refuses a file with row errors
 *      unless the caller explicitly opts into skipping them. A half-applied
 *      price list is harder to recover from than a rejected one.
 *   4. **Import never deletes.** A SKU missing from the file is left alone. A
 *      catalogue cull is a deliberate act, not a side effect of a short file.
 *
 * Format is CSV (UTF-8, RFC 4180). XLSX is deliberately not accepted: parsing
 * it needs a dependency that would also have to be trusted with untrusted
 * uploads, and every spreadsheet exports CSV. A non-CSV upload is rejected
 * with that explanation rather than mis-parsed.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { createProduct, setProductStatus, updateProduct } from './product.service.js';

export interface ImportActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/** Rows above this are rejected at upload - a bigger job belongs in a queue. */
const MAX_ROWS = 5000;

/** Errors recorded per job. Beyond this the file is wrong, not the rows. */
const MAX_RECORDED_ERRORS = 500;

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * RFC 4180 parser.
 *
 * Hand-written rather than a `split(',')` because product descriptions contain
 * commas, quotes and newlines, and a naive split silently shifts every column
 * after the first one - which surfaces as a price in the SKU field.
 */
export function parseCsv(text: string): string[][] {
  // Excel writes a UTF-8 BOM; left in place it becomes part of the first
  // header name and that column stops matching.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }

    if (char === '\r' || char === '\n') {
      // CRLF is one terminator, not two.
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // A file that does not end in a newline still has a final row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Trailing blank lines are an artefact of every editor, not data.
  return rows.filter((cells) => !(cells.length === 1 && (cells[0] ?? '').trim() === ''));
}

// ---------------------------------------------------------------------------
// Column contract
// ---------------------------------------------------------------------------

interface ColumnSpec {
  key: string;
  required: boolean;
  help: string;
  example: string;
}

/**
 * The import contract.
 *
 * `sku` is the identity: a row whose SKU exists updates that product, a row
 * whose SKU is new creates one.
 */
export const PRODUCT_IMPORT_COLUMNS: readonly ColumnSpec[] = [
  {
    key: 'sku',
    required: true,
    help: 'Unique. Identifies the product; an existing SKU is updated in place.',
    example: 'HEX-M12-60',
  },
  { key: 'name', required: true, help: 'Product name shown to customers.', example: 'Hex Bolt M12 x 60mm' },
  {
    key: 'categorySlug',
    required: true,
    help: 'Category URL slug. The category must already exist.',
    example: 'industrial-fasteners',
  },
  {
    key: 'price',
    required: true,
    help: 'Price in major units, e.g. 45.50. No currency symbol, no thousands separator.',
    example: '45.50',
  },
  {
    key: 'taxClassCode',
    required: false,
    help: 'Tax class code. Blank uses the default tax class.',
    example: 'GST18',
  },
  { key: 'status', required: false, help: 'DRAFT, ACTIVE or INACTIVE. Blank means DRAFT.', example: 'ACTIVE' },
  {
    key: 'shortDescription',
    required: false,
    help: 'One-line summary, 1024 characters or fewer.',
    example: 'Grade 8.8 zinc-plated hex bolt.',
  },
  {
    key: 'description',
    required: false,
    help: 'Plain-text description.',
    example: 'Suitable for structural steel work.',
  },
  {
    key: 'compareAtPrice',
    required: false,
    help: 'Strike-through price. Must be at least the price.',
    example: '52.00',
  },
  { key: 'isStockTracked', required: false, help: 'true or false. Blank means true.', example: 'true' },
  { key: 'reorderThreshold', required: false, help: 'Low-stock alert level. Whole number.', example: '25' },
  { key: 'minOrderQty', required: false, help: 'Minimum quantity per order. Blank means 1.', example: '10' },
  {
    key: 'maxOrderQty',
    required: false,
    help: 'Maximum quantity per order. Blank means no limit.',
    example: '500',
  },
  { key: 'qtyIncrement', required: false, help: 'Order quantity step. Blank means 1.', example: '10' },
  {
    key: 'isRecurringEligible',
    required: false,
    help: 'true or false. Blank means false.',
    example: 'false',
  },
  { key: 'weightGrams', required: false, help: 'Shipping weight in grams. Whole number.', example: '95' },
];

function csvCell(value: string): string {
  // A leading =, +, - or @ is executed as a formula by spreadsheet software.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** The downloadable template: header, one worked example, one blank row. */
export function productImportTemplate(): string {
  const header = PRODUCT_IMPORT_COLUMNS.map((column) => csvCell(column.key)).join(',');
  const example = PRODUCT_IMPORT_COLUMNS.map((column) => csvCell(column.example)).join(',');
  const blank = PRODUCT_IMPORT_COLUMNS.map(() => '').join(',');
  return `${header}\r\n${example}\r\n${blank}\r\n`;
}

/** Column documentation, so the UI does not restate the rules and drift. */
export function productImportColumnHelp(): ColumnSpec[] {
  return PRODUCT_IMPORT_COLUMNS.map((column) => ({ ...column }));
}

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------

interface RowError {
  rowNumber: number;
  field: string | null;
  code: string;
  message: string;
}

interface ValidRow {
  rowNumber: number;
  sku: string;
  existingProductId: string | null;
  values: {
    name: string;
    categoryId: string;
    basePriceMinor: string;
    taxClassCode: string;
    status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
    shortDescription: string | null;
    description: string | null;
    compareAtPriceMinor: string | null;
    isStockTracked: boolean;
    reorderThreshold: number;
    minOrderQty: number;
    maxOrderQty: number | null;
    qtyIncrement: number;
    isRecurringEligible: boolean;
    weightGrams: number | null;
  };
}

/** Lookup tables loaded once per job rather than per row. */
interface ImportContext {
  categoriesBySlug: Map<string, string>;
  taxClassCodes: Set<string>;
  defaultTaxClassCode: string | null;
  productIdsBySku: Map<string, string>;
  currencyExponent: number;
}

async function loadContext(): Promise<ImportContext> {
  const [categories, taxClasses, products, settings] = await Promise.all([
    prisma.category.findMany({ where: { archivedAt: null }, select: { id: true, slug: true } }),
    prisma.taxClass.findMany({ where: { isActive: true }, select: { code: true, isDefault: true } }),
    prisma.product.findMany({ where: { archivedAt: null }, select: { id: true, sku: true } }),
    prisma.businessProfile.findFirst({ select: { currency: true } }),
  ]);

  return {
    categoriesBySlug: new Map(categories.map((category) => [category.slug.toLowerCase(), category.id])),
    taxClassCodes: new Set(taxClasses.map((taxClass) => taxClass.code.toUpperCase())),
    defaultTaxClassCode: taxClasses.find((taxClass) => taxClass.isDefault)?.code ?? null,
    productIdsBySku: new Map(products.map((product) => [product.sku.toUpperCase(), product.id])),
    // Most currencies are 2. A zero-decimal currency rejects "45.50" rather
    // than quietly discarding the fraction.
    currencyExponent: settings?.currency === 'JPY' ? 0 : 2,
  };
}

/**
 * Decimal major units to integer minor units, exactly.
 *
 * String arithmetic throughout. `Math.round(45.55 * 100)` is 4555 for some
 * inputs and 4554 for others, and a catalogue import is precisely where that
 * one-paisa error gets multiplied by the whole product list.
 */
function toMinorUnits(raw: string, exponent: number): { minor: string } | { error: string } {
  const text = raw.trim();

  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return {
      error: 'Use digits and at most one decimal point, with no currency symbol or separators.',
    };
  }

  if (text.startsWith('-')) return { error: 'A price cannot be negative.' };

  const [whole, fraction = ''] = text.split('.');

  if (fraction.length > exponent) {
    return {
      error: `This currency has ${String(exponent)} decimal place(s); "${text}" has ${String(fraction.length)}.`,
    };
  }

  const padded = fraction.padEnd(exponent, '0');
  const minor = `${whole}${padded}`.replace(/^0+(?=\d)/, '');

  if (minor.length > 18) return { error: 'That price is too large.' };

  return { minor };
}

function toBoolean(raw: string): boolean | null {
  const text = raw.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(text)) return true;
  if (['false', 'no', 'n', '0'].includes(text)) return false;
  return null;
}

function toInteger(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Validate one row.
 *
 * Collects every problem in the row rather than stopping at the first, so an
 * administrator fixes a spreadsheet once instead of re-uploading per mistake.
 */
function validateRow(
  rowNumber: number,
  cell: (key: string) => string,
  context: ImportContext,
  skusSeen: Map<string, number>,
): { ok: true; row: ValidRow } | { ok: false; errors: RowError[] } {
  const errors: RowError[] = [];
  const fail = (field: string | null, code: string, message: string): void => {
    errors.push({ rowNumber, field, code, message });
  };

  const sku = cell('sku').trim().toUpperCase();

  if (sku.length === 0) {
    fail('sku', 'REQUIRED', 'SKU is required.');
  } else if (sku.length > 64) {
    fail('sku', 'TOO_LONG', 'SKU must be 64 characters or fewer.');
  } else {
    const firstSeen = skusSeen.get(sku);
    if (firstSeen !== undefined) {
      // Letting the last row win would apply a price nobody chose.
      fail('sku', 'DUPLICATE_IN_FILE', `SKU "${sku}" already appears on row ${String(firstSeen)}.`);
    } else {
      skusSeen.set(sku, rowNumber);
    }
  }

  const name = cell('name').trim();
  if (name.length === 0) fail('name', 'REQUIRED', 'Name is required.');
  else if (name.length > 255) fail('name', 'TOO_LONG', 'Name must be 255 characters or fewer.');

  const categorySlug = cell('categorySlug').trim().toLowerCase();
  let categoryId = '';

  if (categorySlug.length === 0) {
    fail('categorySlug', 'REQUIRED', 'Category slug is required.');
  } else {
    const found = context.categoriesBySlug.get(categorySlug);
    if (found === undefined) {
      fail('categorySlug', 'UNKNOWN_CATEGORY', `No active category has the slug "${categorySlug}".`);
    } else {
      categoryId = found;
    }
  }

  const priceRaw = cell('price').trim();
  let basePriceMinor = '';

  if (priceRaw.length === 0) {
    fail('price', 'REQUIRED', 'Price is required.');
  } else {
    const parsed = toMinorUnits(priceRaw, context.currencyExponent);
    if ('error' in parsed) fail('price', 'INVALID_MONEY', parsed.error);
    else basePriceMinor = parsed.minor;
  }

  const compareRaw = cell('compareAtPrice').trim();
  let compareAtPriceMinor: string | null = null;

  if (compareRaw.length > 0) {
    const parsed = toMinorUnits(compareRaw, context.currencyExponent);
    if ('error' in parsed) {
      fail('compareAtPrice', 'INVALID_MONEY', parsed.error);
    } else if (basePriceMinor.length > 0 && BigInt(parsed.minor) < BigInt(basePriceMinor)) {
      fail(
        'compareAtPrice',
        'BELOW_PRICE',
        'The compare-at price must be at least the price, or the discount reads as negative.',
      );
    } else {
      compareAtPriceMinor = parsed.minor;
    }
  }

  const taxRaw = cell('taxClassCode').trim().toUpperCase();
  let taxClassCode = '';

  if (taxRaw.length === 0) {
    if (context.defaultTaxClassCode === null) {
      fail('taxClassCode', 'REQUIRED', 'No default tax class is configured, so every row must name one.');
    } else {
      taxClassCode = context.defaultTaxClassCode;
    }
  } else if (!context.taxClassCodes.has(taxRaw)) {
    fail('taxClassCode', 'UNKNOWN_TAX_CLASS', `No active tax class has the code "${taxRaw}".`);
  } else {
    taxClassCode = taxRaw;
  }

  const statusRaw = cell('status').trim().toUpperCase();
  let status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' = 'DRAFT';

  if (statusRaw.length > 0) {
    if (statusRaw !== 'DRAFT' && statusRaw !== 'ACTIVE' && statusRaw !== 'INACTIVE') {
      fail('status', 'INVALID_STATUS', 'Status must be DRAFT, ACTIVE or INACTIVE.');
    } else {
      status = statusRaw;
    }
  }

  const booleans = new Map<string, boolean>();
  for (const [key, fallback] of [
    ['isStockTracked', true],
    ['isRecurringEligible', false],
  ] as const) {
    const raw = cell(key).trim();
    if (raw.length === 0) {
      booleans.set(key, fallback);
      continue;
    }
    const parsed = toBoolean(raw);
    if (parsed === null) fail(key, 'INVALID_BOOLEAN', `"${raw}" is not true or false.`);
    else booleans.set(key, parsed);
  }

  const integers = new Map<string, number | null>();
  for (const [key, fallback] of [
    ['reorderThreshold', 0],
    ['minOrderQty', 1],
    ['maxOrderQty', null],
    ['qtyIncrement', 1],
    ['weightGrams', null],
  ] as const) {
    const raw = cell(key).trim();
    if (raw.length === 0) {
      integers.set(key, fallback);
      continue;
    }
    const parsed = toInteger(raw);
    if (parsed === null) fail(key, 'INVALID_NUMBER', `"${raw}" is not a whole number.`);
    else integers.set(key, parsed);
  }

  const minOrderQty = integers.get('minOrderQty') ?? 1;
  const qtyIncrement = integers.get('qtyIncrement') ?? 1;
  const maxOrderQty = integers.get('maxOrderQty') ?? null;

  if (minOrderQty < 1) fail('minOrderQty', 'OUT_OF_RANGE', 'Minimum order quantity must be at least 1.');
  if (qtyIncrement < 1) fail('qtyIncrement', 'OUT_OF_RANGE', 'Quantity increment must be at least 1.');

  if (maxOrderQty !== null && maxOrderQty < minOrderQty) {
    // Otherwise no quantity satisfies both rules and the product cannot be
    // bought at all - a failure that surfaces only at a customer's checkout.
    fail('maxOrderQty', 'OUT_OF_RANGE', 'Maximum order quantity cannot be below the minimum.');
  }

  const shortDescription = cell('shortDescription').trim();
  if (shortDescription.length > 1024) {
    fail('shortDescription', 'TOO_LONG', 'Short description must be 1024 characters or fewer.');
  }

  const description = cell('description').trim();

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    row: {
      rowNumber,
      sku,
      existingProductId: context.productIdsBySku.get(sku) ?? null,
      values: {
        name,
        categoryId,
        basePriceMinor,
        taxClassCode,
        status,
        shortDescription: shortDescription.length > 0 ? shortDescription : null,
        description: description.length > 0 ? description : null,
        compareAtPriceMinor,
        isStockTracked: booleans.get('isStockTracked') ?? true,
        reorderThreshold: integers.get('reorderThreshold') ?? 0,
        minOrderQty,
        maxOrderQty,
        qtyIncrement,
        isRecurringEligible: booleans.get('isRecurringEligible') ?? false,
        weightGrams: integers.get('weightGrams') ?? null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface AnalysedFile {
  totalRows: number;
  valid: ValidRow[];
  errors: RowError[];
  /** Set when the file itself is unusable - a missing header column, say. */
  fatal: string | null;
}

/** Parse and validate a whole file. Writes nothing. */
async function analyse(content: string): Promise<AnalysedFile> {
  const rows = parseCsv(content);

  if (rows.length === 0) {
    return { totalRows: 0, valid: [], errors: [], fatal: 'The file is empty.' };
  }

  const header = (rows[0] ?? []).map((name) => name.trim());
  const known = new Set(PRODUCT_IMPORT_COLUMNS.map((column) => column.key.toLowerCase()));
  const index = new Map<string, number>();

  header.forEach((name, position) => {
    const key = name.toLowerCase();
    // First occurrence wins - a duplicated column would otherwise make which
    // one applies depend on column order.
    if (known.has(key) && !index.has(key)) index.set(key, position);
  });

  const missing = PRODUCT_IMPORT_COLUMNS.filter(
    (column) => column.required && !index.has(column.key.toLowerCase()),
  ).map((column) => column.key);

  if (missing.length > 0) {
    return {
      totalRows: 0,
      valid: [],
      errors: [],
      fatal: `The file is missing required column(s): ${missing.join(', ')}. Download the template to see the expected header.`,
    };
  }

  const dataRows = rows.slice(1);

  if (dataRows.length > MAX_ROWS) {
    return {
      totalRows: dataRows.length,
      valid: [],
      errors: [],
      fatal: `The file has ${String(dataRows.length)} rows; the limit is ${String(MAX_ROWS)}. Split it into smaller files.`,
    };
  }

  const context = await loadContext();
  const skusSeen = new Map<string, number>();
  const valid: ValidRow[] = [];
  const errors: RowError[] = [];

  dataRows.forEach((cells, offset) => {
    // +2: one for the header, one because spreadsheets count from 1. The
    // number in an error must match what the administrator sees in Excel.
    const rowNumber = offset + 2;

    // A row of only empty cells is spreadsheet padding, not a product.
    if (cells.every((value) => value.trim() === '')) return;

    const cell = (key: string): string => {
      const position = index.get(key.toLowerCase());
      return position === undefined ? '' : (cells[position] ?? '');
    };

    const result = validateRow(rowNumber, cell, context, skusSeen);
    if (result.ok) valid.push(result.row);
    else errors.push(...result.errors);
  });

  const errorRowNumbers = new Set(errors.map((error) => error.rowNumber));

  return { totalRows: valid.length + errorRowNumbers.size, valid, errors, fatal: null };
}

function rowErrorRows(errors: readonly RowError[]): number {
  return new Set(errors.map((error) => error.rowNumber)).size;
}

async function recordRowErrors(jobId: string, errors: readonly RowError[]): Promise<void> {
  if (errors.length === 0) return;

  await prisma.importRowError.createMany({
    data: errors.slice(0, MAX_RECORDED_ERRORS).map((error) => ({
      id: newId(),
      importJobId: jobId,
      rowNumber: error.rowNumber,
      field: error.field,
      code: error.code,
      message: error.message.slice(0, 1024),
    })),
  });
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

/**
 * Accept an uploaded file and validate it without writing anything.
 *
 * Always a dry run. There is no import-immediately path: an administrator sees
 * what will happen before it happens, every time.
 */
export async function createProductImportDryRun(
  input: { fileName: string; content: Buffer },
  actor: ImportActor,
): Promise<{ importJobId: string }> {
  const text = input.content.toString('utf8');

  // A NUL byte almost always means an XLSX or a ZIP renamed to .csv. Saying so
  // beats reporting "SKU is required" against every row of binary noise.
  if (text.includes('\u0000')) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'That is not a UTF-8 CSV file. Export the sheet as CSV and upload that.',
      [{ field: 'file', code: 'NOT_CSV' }],
    );
  }

  const stored = await storage.put(input.content, 'text/csv', 'csv');
  const jobId = newId();
  const analysis = await analyse(text);
  const errorRows = rowErrorRows(analysis.errors);

  await prisma.importJob.create({
    data: {
      id: jobId,
      type: 'PRODUCTS',
      fileKey: stored.storageKey,
      fileName: input.fileName.slice(0, 255),
      isDryRun: true,
      // A preview that found problems still ran to completion; FAILED is
      // reserved for a file that could not be read at all.
      status: analysis.fatal !== null ? 'FAILED' : errorRows > 0 ? 'PARTIAL' : 'SUCCEEDED',
      totalRows: analysis.totalRows,
      validRows: analysis.valid.length,
      errorRows,
      errorMessage: analysis.fatal?.slice(0, 1024) ?? null,
      resultJson: {
        creates: analysis.valid.filter((row) => row.existingProductId === null).length,
        updates: analysis.valid.filter((row) => row.existingProductId !== null).length,
      },
      createdById: actor.userId,
      startedAt: new Date(),
      completedAt: new Date(),
    },
  });

  await recordRowErrors(jobId, analysis.errors);

  await recordAudit({
    action: AuditAction.PRODUCT_UPDATED,
    resourceType: 'import_job',
    resourceId: jobId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: {
      dryRun: true,
      fileName: input.fileName,
      totalRows: analysis.totalRows,
      validRows: analysis.valid.length,
      errorRows,
    },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { importJobId: jobId };
}

/**
 * Apply a previewed import.
 *
 * The file is re-read and re-validated - see rule 2 at the top of this file.
 * `skipInvalidRows` is the caller's explicit acceptance that some rows will be
 * left out; without it a file with any error imports nothing.
 */
export async function confirmProductImport(
  dryRunJobId: string,
  options: { skipInvalidRows: boolean },
  actor: ImportActor,
): Promise<{ importJobId: string }> {
  const dryRun = await prisma.importJob.findUnique({ where: { id: dryRunJobId } });

  if (dryRun === null || dryRun.type !== 'PRODUCTS') throw notFound('Import job');

  if (!dryRun.isDryRun) {
    throw conflict(ErrorCode.VALIDATION_FAILED, 'That job is an import, not a preview.');
  }

  if (dryRun.errorMessage !== null) {
    throw conflict(ErrorCode.VALIDATION_FAILED, dryRun.errorMessage);
  }

  const alreadyConfirmed = await prisma.importJob.findFirst({
    where: { confirmedFromJobId: dryRunJobId },
    select: { id: true },
  });

  if (alreadyConfirmed !== null) {
    // Without this, a double-clicked Confirm applies the file twice. Updates
    // are idempotent; creates are not, and the second pass would collide on
    // the SKU unique index and report a file-wide failure.
    throw conflict(ErrorCode.VALIDATION_FAILED, 'This preview has already been imported.', [
      { field: 'importJobId', code: 'ALREADY_CONFIRMED', meta: { importJobId: alreadyConfirmed.id } },
    ]);
  }

  const content = (await storage.get(dryRun.fileKey)).toString('utf8');
  const analysis = await analyse(content);

  if (analysis.fatal !== null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, analysis.fatal, [{ field: 'file', code: 'UNUSABLE' }]);
  }

  const errorRows = rowErrorRows(analysis.errors);

  if (errorRows > 0 && !options.skipInvalidRows) {
    throw conflict(
      ErrorCode.VALIDATION_FAILED,
      `${String(errorRows)} row(s) have errors. Fix the file and preview again, or confirm with "skip invalid rows".`,
      [{ field: 'skipInvalidRows', code: 'ERRORS_PRESENT', meta: { errorRows } }],
    );
  }

  const jobId = newId();

  await prisma.importJob.create({
    data: {
      id: jobId,
      type: 'PRODUCTS',
      fileKey: dryRun.fileKey,
      fileName: dryRun.fileName,
      isDryRun: false,
      status: 'RUNNING',
      totalRows: analysis.totalRows,
      validRows: analysis.valid.length,
      errorRows,
      confirmedFromJobId: dryRunJobId,
      createdById: actor.userId,
      startedAt: new Date(),
    },
  });

  // Errors found at confirm time and not at preview time are the interesting
  // ones: they are what changed underneath the administrator.
  await recordRowErrors(jobId, analysis.errors);

  let created = 0;
  let updated = 0;
  const writeErrors: RowError[] = [];

  for (const row of analysis.valid) {
    const shared = {
      name: row.values.name,
      categoryId: row.values.categoryId,
      shortDescription: row.values.shortDescription,
      description: row.values.description,
      taxClassCode: row.values.taxClassCode,
      basePriceMinor: row.values.basePriceMinor,
      compareAtPriceMinor: row.values.compareAtPriceMinor,
      isStockTracked: row.values.isStockTracked,
      reorderThreshold: row.values.reorderThreshold,
      minOrderQty: row.values.minOrderQty,
      maxOrderQty: row.values.maxOrderQty,
      qtyIncrement: row.values.qtyIncrement,
      isRecurringEligible: row.values.isRecurringEligible,
      weightGrams: row.values.weightGrams,
    };

    try {
      if (row.existingProductId === null) {
        const product = await createProduct({ ...shared, sku: row.sku }, actor);
        // Status goes through the product service so the import is not a
        // second, unaudited way to change what customers can see. Publication
        // stays separate: an import can activate a product, never publish it.
        if (row.values.status !== 'DRAFT') {
          await setProductStatus(product.id, row.values.status, actor);
        }
        created += 1;
      } else {
        await updateProduct(row.existingProductId, shared, actor);
        await setProductStatus(row.existingProductId, row.values.status, actor);
        updated += 1;
      }
    } catch (error) {
      // One row's failure must not abandon the rest, but it must be visible -
      // a silently skipped row is a product an administrator believes exists.
      writeErrors.push({
        rowNumber: row.rowNumber,
        field: null,
        code: 'WRITE_FAILED',
        message: error instanceof Error ? error.message : 'The row could not be saved.',
      });
    }
  }

  await recordRowErrors(jobId, writeErrors);

  const failedRows = errorRows + writeErrors.length;

  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      status: failedRows === 0 ? 'SUCCEEDED' : created + updated > 0 ? 'PARTIAL' : 'FAILED',
      createdRows: created,
      updatedRows: updated,
      errorRows: failedRows,
      resultJson: { creates: created, updates: updated, skipped: failedRows },
      completedAt: new Date(),
    },
  });

  await recordAudit({
    action: AuditAction.PRODUCT_UPDATED,
    resourceType: 'import_job',
    resourceId: jobId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: {
      dryRun: false,
      confirmedFrom: dryRunJobId,
      fileName: dryRun.fileName,
      created,
      updated,
      skipped: failedRows,
    },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { importJobId: jobId };
}

export async function getImportJob(
  jobId: string,
  page = 1,
  limit = 50,
): Promise<Record<string, unknown>> {
  const job = await prisma.importJob.findUnique({
    where: { id: jobId },
    include: {
      rowErrors: {
        orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      },
    },
  });

  if (job === null) throw notFound('Import job');

  const totalErrors = await prisma.importRowError.count({ where: { importJobId: jobId } });

  return {
    id: job.id,
    type: job.type,
    fileName: job.fileName,
    isDryRun: job.isDryRun,
    status: job.status,
    totalRows: job.totalRows,
    validRows: job.validRows,
    errorRows: job.errorRows,
    createdRows: job.createdRows,
    updatedRows: job.updatedRows,
    result: job.resultJson,
    errorMessage: job.errorMessage,
    confirmedFromJobId: job.confirmedFromJobId,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    rowErrors: job.rowErrors.map((error) => ({
      rowNumber: error.rowNumber,
      field: error.field,
      code: error.code,
      message: error.message,
    })),
    pagination: {
      page,
      limit,
      total: totalErrors,
      totalPages: Math.max(1, Math.ceil(totalErrors / limit)),
      // Past this the file is wrong rather than the rows, and the UI should
      // say so instead of paging through hundreds of identical complaints.
      truncated: totalErrors >= MAX_RECORDED_ERRORS,
    },
  };
}

export async function listImportJobs(limit = 25): Promise<Record<string, unknown>[]> {
  const jobs = await prisma.importJob.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: {
      id: true,
      type: true,
      fileName: true,
      isDryRun: true,
      status: true,
      totalRows: true,
      validRows: true,
      errorRows: true,
      createdRows: true,
      updatedRows: true,
      confirmedFromJobId: true,
      createdAt: true,
      completedAt: true,
    },
  });

  return jobs.map((job) => ({
    ...job,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  }));
}
