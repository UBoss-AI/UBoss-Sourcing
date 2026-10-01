/**
 * A seller's bulk update of their own listings: price, minimum order, on/off
 * sale and stock, many rows at once.
 *
 * WHAT IT DOES NOT DO
 *
 * It never creates a listing. A new listing goes through a draft and quality
 * review; a spreadsheet that could create live offers would be a way round
 * moderation. Every row names a `seller_sku` the seller already has, and a SKU
 * that is not theirs is reported as unknown - never as "belongs to someone
 * else", which would leak another seller's catalogue.
 *
 * THE SAME RULES AS THE ADMIN IMPORT
 *
 *   1. One validator. The preview and the apply both call `analyse`.
 *   2. Re-validate at apply. The file is re-read from storage and re-checked,
 *      because a listing can be archived between preview and apply.
 *   3. A file with errors applies nothing.
 *   4. A blank cell changes nothing. Import never deletes or clears.
 *
 * Each change is made through the service a seller's own screen uses
 * (`updateOfferPrice`, `recordStockMovement`, `setOfferStatus`), so ownership,
 * permission, audit and the storefront price projection are exactly what a
 * hand edit gets. The parser is the admin import's `parseCsv` and the
 * product-sheet `xlsx-reader`.
 */
import { createHash } from 'node:crypto';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { currencyExponent } from '../../domain/money.js';
import { SellerPermission, type SellerPermissionKey } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { parseCsv } from '../catalog/import.service.js';
import { readWorkbookBuffer } from '../catalog/sheet-import/xlsx-reader.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';
import { recordSellerAudit } from './audit.service.js';
import { recordStockMovement } from './inventory.service.js';
import { setOfferStatus, updateOfferPrice } from './offer.service.js';

const MAX_ROWS = 5000;
const MAX_RECORDED_ERRORS = 500;
const MAX_PREVIEW_ROWS = 200;
export const MAX_SELLER_IMPORT_BYTES = 8 * 1024 * 1024;

/** The columns, in template order. Only `seller_sku` is required. */
export const SELLER_IMPORT_COLUMNS = [
  'seller_sku',
  'price',
  'compare_at_price',
  'minimum_order_quantity',
  'status',
  'location_code',
  'available_quantity',
] as const;

type Column = (typeof SELLER_IMPORT_COLUMNS)[number];

/** What each column needs, beyond the import permission itself. */
const COLUMN_PERMISSION: Partial<Record<Column, SellerPermissionKey>> = {
  price: SellerPermission.OFFER_PRICE_WRITE,
  compare_at_price: SellerPermission.OFFER_PRICE_WRITE,
  minimum_order_quantity: SellerPermission.OFFER_PRICE_WRITE,
  status: SellerPermission.OFFER_PUBLISH,
  available_quantity: SellerPermission.INVENTORY_ADJUST,
};

const ALIASES: Record<string, Column> = {
  sku: 'seller_sku',
  moq: 'minimum_order_quantity',
  stock: 'available_quantity',
  quantity: 'available_quantity',
  location: 'location_code',
  was_price: 'compare_at_price',
};

export interface RowError {
  rowNumber: number;
  columnName: string | null;
  code: string;
  message: string;
  rawValue: string | null;
}

export interface PlannedRow {
  rowNumber: number;
  offerId: string;
  sellerSku: string;
  currency: string;
  price?: { from: string; to: string };
  compareAtPrice?: { from: string | null; to: string };
  minimumOrderQuantity?: { from: number; to: number };
  status?: { from: string; to: 'ACTIVE' | 'PAUSED' };
  stock?: { locationId: string; locationCode: string; from: number; to: number };
}

interface Analysis {
  totalRows: number;
  columns: Column[];
  planned: PlannedRow[];
  unchangedRows: number;
  errors: RowError[];
}

export function sellerImportTemplate(): string {
  return `${SELLER_IMPORT_COLUMNS.join(',')}\r\n`;
}

function normaliseHeader(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ALIASES[key] ?? key;
}

function isXlsx(content: Buffer): boolean {
  return content.length > 4 && content[0] === 0x50 && content[1] === 0x4b && content[2] === 0x03 && content[3] === 0x04;
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** Rows as arrays of text, whichever format arrived. First row is the header. */
export function readSellerSheet(content: Buffer): { format: 'CSV' | 'XLSX'; rows: string[][] } {
  if (isXlsx(content)) {
    let sheets;
    try {
      sheets = readWorkbookBuffer(content, 'The upload');
    } catch {
      throw badRequest(ErrorCode.BULK_IMPORT_FILE_INVALID, 'That workbook could not be read.', [
        { field: 'file', code: 'UNREADABLE' },
      ]);
    }
    const first = sheets[0];
    const rows: string[][] = [];
    for (const row of first?.rows ?? []) {
      const cells: string[] = [];
      for (const [letters, cell] of row.cells) cells[columnIndex(letters)] = cell.value;
      rows.push(Array.from(cells, (value) => value ?? ''));
    }
    return { format: 'XLSX', rows };
  }

  const text = content.toString('utf8');
  if (text.includes('\u0000')) {
    throw badRequest(
      ErrorCode.BULK_IMPORT_FILE_INVALID,
      'That is not a CSV or XLSX file. Export the sheet as CSV or XLSX and upload that.',
      [{ field: 'file', code: 'NOT_CSV' }],
    );
  }
  return { format: 'CSV', rows: parseCsv(text) };
}

function minorOf(raw: string, currency: string): { minor: bigint } | { error: string } {
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { error: 'Use digits and at most one decimal point, with no currency symbol.' };
  }
  const exponent = currencyExponent(currency);
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > exponent) {
    return { error: `${currency} has ${String(exponent)} decimal place(s).` };
  }
  const digits = `${whole}${fraction.padEnd(exponent, '0')}`;
  if (digits.replace(/^0+/, '').length > 18) return { error: 'That price is too large.' };
  return { minor: BigInt(digits) };
}

function wholeNumber(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,9}$/.test(text)) return null;
  return Number(text);
}

function formatMinor(minor: bigint, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === 0) return minor.toString();
  const text = minor.toString().padStart(exponent + 1, '0');
  return `${text.slice(0, -exponent)}.${text.slice(-exponent)}`;
}

/**
 * Read and check a file against the seller's own listings. Writes nothing.
 * Throws only for a file that cannot be read at all; everything else is a row
 * error, so the seller sees every problem at once.
 */
export async function analyseSellerImport(
  membership: SellerMembership,
  content: Buffer,
): Promise<Analysis & { format: 'CSV' | 'XLSX' }> {
  const { format, rows } = readSellerSheet(content);
  const header = rows[0];
  if (header === undefined || header.every((cell) => cell.trim() === '')) {
    throw badRequest(ErrorCode.BULK_IMPORT_FILE_INVALID, 'The file has no header row.', [
      { field: 'file', code: 'EMPTY' },
    ]);
  }

  const known = new Set<string>(SELLER_IMPORT_COLUMNS);
  const positions = new Map<Column, number>();
  header.forEach((cell, index) => {
    const name = normaliseHeader(cell);
    if (known.has(name) && !positions.has(name as Column)) positions.set(name as Column, index);
  });

  if (!positions.has('seller_sku')) {
    throw badRequest(ErrorCode.BULK_IMPORT_FILE_INVALID, 'The file needs a seller_sku column.', [
      { field: 'seller_sku', code: 'MISSING_COLUMN' },
    ]);
  }
  if (positions.has('available_quantity') !== positions.has('location_code')) {
    throw badRequest(
      ErrorCode.BULK_IMPORT_FILE_INVALID,
      'Stock needs both location_code and available_quantity columns.',
      [{ field: 'location_code', code: 'MISSING_COLUMN' }],
    );
  }

  const columns = [...positions.keys()];
  // A column the member may not change is refused up front, not row by row.
  for (const column of columns) {
    const permission = COLUMN_PERMISSION[column];
    if (permission !== undefined) assertSellerPermission(membership, permission);
  }

  const body = rows.slice(1).map((cells, index) => ({ rowNumber: index + 2, cells }));
  const dataRows = body.filter((row) => row.cells.some((cell) => cell.trim() !== ''));
  if (dataRows.length > MAX_ROWS) {
    throw badRequest(
      ErrorCode.BULK_IMPORT_FILE_INVALID,
      `A file can hold at most ${String(MAX_ROWS)} rows. Split it and upload each part.`,
      [{ field: 'file', code: 'TOO_MANY_ROWS' }],
    );
  }

  const [offers, locations] = await Promise.all([
    prisma.sellerOffer.findMany({
      where: { sellerAccountId: membership.sellerAccountId },
      select: {
        id: true,
        sellerSku: true,
        status: true,
        currency: true,
        priceMinor: true,
        compareAtPriceMinor: true,
        minimumOrderQuantity: true,
      },
    }),
    prisma.sellerLocation.findMany({
      where: { sellerAccountId: membership.sellerAccountId, archivedAt: null },
      select: { id: true, code: true },
    }),
  ]);
  const offersBySku = new Map(offers.map((offer) => [offer.sellerSku.toUpperCase(), offer]));
  const locationsByCode = new Map(locations.map((location) => [location.code.toUpperCase(), location.id]));

  const errors: RowError[] = [];
  const planned: PlannedRow[] = [];
  const seen = new Map<string, number>();
  const stockTargets: { row: PlannedRow; offerId: string; locationId: string }[] = [];
  let unchangedRows = 0;

  for (const { rowNumber, cells } of dataRows) {
    const cell = (column: Column): string => {
      const position = positions.get(column);
      return position === undefined ? '' : (cells[position] ?? '').trim();
    };
    const fail = (columnName: Column | null, code: string, message: string, rawValue?: string): void => {
      errors.push({ rowNumber, columnName, code, message, rawValue: rawValue?.slice(0, 512) ?? null });
    };
    const before = errors.length;

    const sku = cell('seller_sku');
    if (sku === '') {
      fail('seller_sku', 'REQUIRED', 'Every row needs a seller_sku.');
      continue;
    }
    const firstRow = seen.get(sku.toUpperCase());
    if (firstRow !== undefined) {
      fail('seller_sku', 'DUPLICATE', `This SKU is already on row ${String(firstRow)}.`, sku);
      continue;
    }
    seen.set(sku.toUpperCase(), rowNumber);

    const offer = offersBySku.get(sku.toUpperCase());
    if (offer === undefined) {
      fail('seller_sku', 'UNKNOWN_SKU', 'None of your listings has this SKU. Import only updates existing listings.', sku);
      continue;
    }
    if (offer.status === 'ARCHIVED' || offer.status === 'BLOCKED') {
      fail('seller_sku', 'NOT_EDITABLE', `This listing is ${offer.status.toLowerCase()} and cannot be updated.`, sku);
      continue;
    }

    const row: PlannedRow = { rowNumber, offerId: offer.id, sellerSku: offer.sellerSku, currency: offer.currency };

    let price = offer.priceMinor;
    const priceRaw = cell('price');
    if (priceRaw !== '') {
      const parsed = minorOf(priceRaw, offer.currency);
      if ('error' in parsed) fail('price', 'INVALID_PRICE', parsed.error, priceRaw);
      else if (parsed.minor <= 0n) fail('price', 'NOT_POSITIVE', 'A price has to be above zero.', priceRaw);
      else {
        price = parsed.minor;
        if (parsed.minor !== offer.priceMinor) {
          row.price = { from: formatMinor(offer.priceMinor, offer.currency), to: formatMinor(parsed.minor, offer.currency) };
        }
      }
    }

    const compareRaw = cell('compare_at_price');
    if (compareRaw !== '') {
      const parsed = minorOf(compareRaw, offer.currency);
      if ('error' in parsed) fail('compare_at_price', 'INVALID_PRICE', parsed.error, compareRaw);
      else if (parsed.minor < price) {
        fail('compare_at_price', 'BELOW_PRICE', 'The was-price cannot be lower than the price buyers pay.', compareRaw);
      } else if (parsed.minor !== offer.compareAtPriceMinor) {
        row.compareAtPrice = {
          from: offer.compareAtPriceMinor === null ? null : formatMinor(offer.compareAtPriceMinor, offer.currency),
          to: formatMinor(parsed.minor, offer.currency),
        };
      }
    }

    const moqRaw = cell('minimum_order_quantity');
    if (moqRaw !== '') {
      const moq = wholeNumber(moqRaw);
      if (moq === null || moq < 1) fail('minimum_order_quantity', 'INVALID_QUANTITY', 'Use a whole number of at least 1.', moqRaw);
      else if (moq !== offer.minimumOrderQuantity) {
        row.minimumOrderQuantity = { from: offer.minimumOrderQuantity, to: moq };
      }
    }

    const statusRaw = cell('status').toUpperCase();
    if (statusRaw !== '') {
      if (statusRaw !== 'ACTIVE' && statusRaw !== 'PAUSED') {
        fail('status', 'INVALID_STATUS', 'Use ACTIVE or PAUSED.', statusRaw);
      } else if (statusRaw === 'ACTIVE' && offer.status === 'NEEDS_CHANGES') {
        fail('status', 'NEEDS_CHANGES', 'This listing needs changes before it can go back on sale.', statusRaw);
      } else if (statusRaw === 'ACTIVE' && offer.status === 'INACTIVE') {
        fail('status', 'NOT_PUBLISHED', 'This listing has not been approved yet, so it cannot be put on sale here.', statusRaw);
      } else if (statusRaw !== offer.status) {
        row.status = { from: offer.status, to: statusRaw };
      }
    }

    const locationRaw = cell('location_code');
    const quantityRaw = cell('available_quantity');
    if (locationRaw !== '' || quantityRaw !== '') {
      const locationId = locationsByCode.get(locationRaw.toUpperCase());
      const quantity = wholeNumber(quantityRaw);
      if (locationRaw === '' || quantityRaw === '') {
        fail(locationRaw === '' ? 'location_code' : 'available_quantity', 'STOCK_INCOMPLETE', 'Give both the location code and the quantity.');
      } else if (locationId === undefined) {
        fail('location_code', 'UNKNOWN_LOCATION', 'None of your active locations has this code.', locationRaw);
      } else if (quantity === null) {
        fail('available_quantity', 'INVALID_QUANTITY', 'Use a whole number of 0 or more.', quantityRaw);
      } else {
        row.stock = { locationId, locationCode: locationRaw.toUpperCase(), from: 0, to: quantity };
        stockTargets.push({ row, offerId: offer.id, locationId });
      }
    }

    if (errors.length === before) planned.push(row);
  }

  // Current stock, in one query, for the rows that set it.
  if (stockTargets.length > 0) {
    const balances = await prisma.sellerInventory.findMany({
      where: {
        sellerAccountId: membership.sellerAccountId,
        offerId: { in: [...new Set(stockTargets.map((target) => target.offerId))] },
      },
      select: { offerId: true, locationId: true, availableQuantity: true },
    });
    const byKey = new Map(balances.map((b) => [`${b.offerId}:${b.locationId}`, b.availableQuantity]));
    for (const target of stockTargets) {
      const current = byKey.get(`${target.offerId}:${target.locationId}`);
      if (target.row.stock === undefined) continue;
      if (current === undefined) {
        // Stock rows are made when a listing is approved for a place; import
        // does not invent one, or it would stock a place nobody reviewed.
        errors.push({
          rowNumber: target.row.rowNumber,
          columnName: 'location_code',
          code: 'NOT_STOCKED_HERE',
          message: 'This listing is not stocked at that location. Add the location to the listing first.',
          rawValue: target.row.stock.locationCode,
        });
        const index = planned.indexOf(target.row);
        if (index >= 0) planned.splice(index, 1);
      } else {
        target.row.stock.from = current;
      }
    }
    errors.sort((a, b) => a.rowNumber - b.rowNumber);
  }

  const changed = planned.filter((row) => {
    if (row.stock !== undefined && row.stock.from === row.stock.to) delete row.stock;
    const hasChange =
      row.price !== undefined ||
      row.compareAtPrice !== undefined ||
      row.minimumOrderQuantity !== undefined ||
      row.status !== undefined ||
      row.stock !== undefined;
    if (!hasChange) unchangedRows += 1;
    return hasChange;
  });

  return { format, totalRows: dataRows.length, columns, planned: changed, unchangedRows, errors };
}

async function writeRowErrors(jobId: string, errors: readonly RowError[]): Promise<void> {
  if (errors.length === 0) return;
  await prisma.sellerBulkImportRowError.createMany({
    data: errors.slice(0, MAX_RECORDED_ERRORS).map((error) => ({
      id: newId(),
      jobId,
      rowNumber: error.rowNumber,
      columnName: error.columnName,
      code: error.code.slice(0, 64),
      message: error.message.slice(0, 512),
      rawValue: error.rawValue,
    })),
  });
}

function errorRowCount(errors: readonly RowError[]): number {
  return new Set(errors.map((error) => error.rowNumber)).size;
}

/** Upload and preview. Stores the file and the problems; changes no listing. */
export async function createSellerImportDryRun(
  membership: SellerMembership,
  input: { fileName: string; content: Buffer },
  correlationId?: string | null,
): Promise<string> {
  assertSellerPermission(membership, SellerPermission.BULK_IMPORT);

  if (input.content.byteLength === 0) {
    throw badRequest(ErrorCode.BULK_IMPORT_FILE_INVALID, 'The uploaded file is empty.', [
      { field: 'file', code: 'EMPTY' },
    ]);
  }
  if (input.content.byteLength > MAX_SELLER_IMPORT_BYTES) {
    throw badRequest(ErrorCode.BULK_IMPORT_FILE_INVALID, 'The file is larger than 8 MB.', [
      { field: 'file', code: 'TOO_LARGE' },
    ]);
  }

  const analysis = await analyseSellerImport(membership, input.content);
  const stored = await storage.put(
    input.content,
    analysis.format === 'XLSX'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv',
    analysis.format === 'XLSX' ? 'xlsx' : 'csv',
    'private',
  );

  const jobId = newId();
  const invalid = errorRowCount(analysis.errors);
  await prisma.sellerBulkImportJob.create({
    data: {
      id: jobId,
      sellerAccountId: membership.sellerAccountId,
      status: 'SUCCEEDED',
      isDryRun: true,
      originalFileName: input.fileName.slice(0, 255),
      storageKey: stored.storageKey,
      fileFormat: analysis.format,
      fileSha256: createHash('sha256').update(input.content).digest('hex'),
      totalRows: analysis.totalRows,
      validRows: analysis.totalRows - invalid,
      invalidRows: invalid,
      requestedByProfileId: membership.customerProfileId,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  await writeRowErrors(jobId, analysis.errors);

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.bulk_import.previewed',
    actor: { type: 'CUSTOMER', userId: null, label: membership.displayName },
    resourceType: 'SellerBulkImportJob',
    resourceId: jobId,
    after: { totalRows: analysis.totalRows, invalidRows: invalid, changes: analysis.planned.length },
    summary: `${input.fileName} was checked: ${String(analysis.planned.length)} change(s), ${String(invalid)} row(s) with problems.`,
    correlationId: correlationId ?? null,
  });

  return jobId;
}

async function loadOwnJob(membership: SellerMembership, jobId: string) {
  const job = await prisma.sellerBulkImportJob.findUnique({ where: { id: jobId } });
  if (job === null) throw notFound('Import');
  assertSellerOwnership(membership, job.sellerAccountId, 'Import');
  return job;
}

/**
 * Apply a previewed file. The file is re-checked first; any problem, and
 * nothing is changed. A dry run can be applied once.
 */
export async function applySellerImport(
  membership: SellerMembership,
  dryRunId: string,
  correlationId?: string | null,
): Promise<string> {
  assertSellerPermission(membership, SellerPermission.BULK_IMPORT);
  const dryRun = await loadOwnJob(membership, dryRunId);

  if (!dryRun.isDryRun || dryRun.status !== 'SUCCEEDED') {
    throw conflict(ErrorCode.BULK_IMPORT_NOT_APPLICABLE, 'Only a checked preview can be applied.', [
      { field: 'id', code: 'NOT_A_PREVIEW' },
    ]);
  }

  const content = await storage.get(dryRun.storageKey);
  const analysis = await analyseSellerImport(membership, content);
  if (analysis.errors.length > 0) {
    throw conflict(
      ErrorCode.BULK_IMPORT_NOT_APPLICABLE,
      'The file has problems. Fix them and upload it again; nothing was changed.',
      [{ field: 'file', code: 'HAS_ERRORS', meta: { invalidRows: errorRowCount(analysis.errors) } }],
    );
  }

  const jobId = newId();
  try {
    await prisma.sellerBulkImportJob.create({
      data: {
        id: jobId,
        sellerAccountId: membership.sellerAccountId,
        status: 'RUNNING',
        isDryRun: false,
        sourceJobId: dryRun.id,
        originalFileName: dryRun.originalFileName,
        storageKey: dryRun.storageKey,
        fileFormat: dryRun.fileFormat,
        fileSha256: dryRun.fileSha256,
        totalRows: analysis.totalRows,
        validRows: 0,
        requestedByProfileId: membership.customerProfileId,
        startedAt: new Date(),
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw conflict(ErrorCode.BULK_IMPORT_NOT_APPLICABLE, 'This preview has already been applied.', [
        { field: 'id', code: 'ALREADY_APPLIED' },
      ]);
    }
    throw error;
  }

  const failures: RowError[] = [];
  let updated = 0;
  const reason = `Bulk import ${dryRun.originalFileName}`.slice(0, 255);

  for (const row of analysis.planned) {
    try {
      if (row.price !== undefined || row.compareAtPrice !== undefined || row.minimumOrderQuantity !== undefined) {
        const current = await prisma.sellerOffer.findUniqueOrThrow({
          where: { id: row.offerId },
          select: { priceMinor: true, compareAtPriceMinor: true },
        });
        const to = (text: string): string => text.replace('.', '');
        await updateOfferPrice(
          membership,
          row.offerId,
          {
            priceMinor: row.price === undefined ? current.priceMinor.toString() : BigInt(to(row.price.to)).toString(),
            // A blank cell keeps the was-price rather than clearing it.
            compareAtPriceMinor:
              row.compareAtPrice === undefined
                ? (current.compareAtPriceMinor?.toString() ?? null)
                : BigInt(to(row.compareAtPrice.to)).toString(),
            minimumOrderQuantity: row.minimumOrderQuantity?.to ?? null,
          },
          correlationId,
        );
      }
      if (row.stock !== undefined) {
        await recordStockMovement({
          membership,
          offerId: row.offerId,
          locationId: row.stock.locationId,
          type: 'ADJUSTMENT',
          quantityDelta: row.stock.to - row.stock.from,
          reason,
          referenceType: 'SELLER_BULK_IMPORT',
          referenceId: jobId,
          idempotencyKey: `bulk-import:${jobId}:${String(row.rowNumber)}`,
          correlationId: correlationId ?? null,
        });
      }
      if (row.status !== undefined) {
        await setOfferStatus(membership, row.offerId, row.status.to, correlationId);
      }
      updated += 1;
    } catch (error) {
      const err = error as { code?: string; message?: string };
      failures.push({
        rowNumber: row.rowNumber,
        columnName: null,
        code: err.code ?? 'FAILED',
        message: err.message ?? 'This row could not be applied.',
        rawValue: row.sellerSku,
      });
    }
  }

  await writeRowErrors(jobId, failures);
  await prisma.sellerBulkImportJob.update({
    where: { id: jobId },
    data: {
      status: failures.length === 0 ? 'SUCCEEDED' : updated === 0 ? 'FAILED' : 'PARTIAL',
      updatedRows: updated,
      validRows: analysis.totalRows - failures.length,
      invalidRows: failures.length,
      finishedAt: new Date(),
    },
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.bulk_import.applied',
    actor: { type: 'CUSTOMER', userId: null, label: membership.displayName },
    resourceType: 'SellerBulkImportJob',
    resourceId: jobId,
    after: { updatedRows: updated, failedRows: failures.length, sourceJobId: dryRun.id },
    summary: `${dryRun.originalFileName} was applied: ${String(updated)} listing(s) updated.`,
    correlationId: correlationId ?? null,
  });

  return jobId;
}

function serialiseJob(job: Awaited<ReturnType<typeof loadOwnJob>>) {
  return {
    id: job.id,
    status: job.status,
    isDryRun: job.isDryRun,
    fileName: job.originalFileName,
    fileFormat: job.fileFormat,
    totalRows: job.totalRows,
    validRows: job.validRows,
    invalidRows: job.invalidRows,
    updatedRows: job.updatedRows,
    sourceJobId: job.sourceJobId,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/**
 * One import with its row problems and, for a preview, the changes it would
 * make - recomputed from the stored file, so it is never stale.
 */
export async function readSellerImport(membership: SellerMembership, jobId: string) {
  assertSellerPermission(membership, SellerPermission.BULK_IMPORT);
  const job = await loadOwnJob(membership, jobId);
  const [errors, applied] = await Promise.all([
    prisma.sellerBulkImportRowError.findMany({
      where: { jobId },
      orderBy: [{ rowNumber: 'asc' }, { createdAt: 'asc' }],
      take: MAX_RECORDED_ERRORS,
      select: { rowNumber: true, columnName: true, code: true, message: true, rawValue: true },
    }),
    job.isDryRun
      ? prisma.sellerBulkImportJob.findUnique({ where: { sourceJobId: job.id }, select: { id: true } })
      : Promise.resolve(null),
  ]);

  let preview: { changes: PlannedRow[]; unchangedRows: number } | null = null;
  if (job.isDryRun && applied === null && job.invalidRows === 0) {
    try {
      const analysis = await analyseSellerImport(membership, await storage.get(job.storageKey));
      preview = { changes: analysis.planned.slice(0, MAX_PREVIEW_ROWS), unchangedRows: analysis.unchangedRows };
    } catch {
      preview = null;
    }
  }

  return {
    job: serialiseJob(job),
    appliedJobId: applied?.id ?? null,
    errors,
    preview,
  };
}

/** The seller's recent imports, newest first. */
export async function listSellerImports(membership: SellerMembership, limit = 25) {
  assertSellerPermission(membership, SellerPermission.BULK_IMPORT);
  const jobs = await prisma.sellerBulkImportJob.findMany({
    where: { sellerAccountId: membership.sellerAccountId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return jobs.map(serialiseJob);
}
