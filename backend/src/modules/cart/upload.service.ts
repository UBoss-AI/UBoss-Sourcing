/**
 * A buyer's SKU list, from CSV or Excel, read into cart lines (ENH-016).
 *
 * This only READS: it resolves each row to a published product and reports
 * what it could not use. The buyer reviews the result and then adds it with
 * the existing all-or-nothing bulk add, so nothing reaches the cart unseen.
 * Columns are found by header (`sku`, `quantity` / `qty`), or are the first
 * two when there is no header. At most 50 lines, the bulk add's own limit.
 */
import { badRequest, ErrorCode } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { readSellerSheet } from '../seller/bulk-import.service.js';

export const UPLOAD_MAX_BYTES = 1_000_000;
export const UPLOAD_MAX_LINES = 50;

export type UploadProblem = 'SKU_MISSING' | 'QUANTITY_INVALID' | 'SKU_UNKNOWN' | 'DUPLICATE_SKU' | 'TOO_MANY_LINES';

export interface UploadPreview {
  lines: { row: number; sku: string; productId: string; variantId: string | null; name: string; quantity: number }[];
  problems: { row: number; sku: string | null; code: UploadProblem }[];
}

/** Rows as plain strings, whichever format arrived; the seller bulk import's reader. */
export function readRows(fileName: string, content: Buffer): string[][] {
  if (content.length > UPLOAD_MAX_BYTES) throw badRequest(ErrorCode.VALIDATION_FAILED, 'The file is larger than 1 MB.', [{ field: 'content', code: 'TOO_LARGE' }]);
  if (!/\.(csv|xlsx)$/i.test(fileName)) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Upload a .csv or .xlsx file.', [{ field: 'fileName', code: 'UNSUPPORTED' }]);
  return readSellerSheet(content).rows;
}

export async function previewUpload(fileName: string, content: Buffer): Promise<UploadPreview> {
  const rows = readRows(fileName, content).filter((row) => row.some((cell) => cell.trim() !== ''));
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const skuAt = header.indexOf('sku');
  const qtyAt = header.findIndex((cell) => cell === 'quantity' || cell === 'qty');
  const hasHeader = skuAt >= 0 && qtyAt >= 0;
  const body = (hasHeader ? rows.slice(1) : rows).map((cells, index) => ({
    row: index + (hasHeader ? 2 : 1),
    sku: (cells[hasHeader ? skuAt : 0] ?? '').trim(),
    quantityText: (cells[hasHeader ? qtyAt : 1] ?? '').trim(),
  }));
  const problems: UploadPreview['problems'] = [];
  const wanted: { row: number; sku: string; quantity: number }[] = [];
  const seen = new Set<string>();
  for (const entry of body) {
    if (entry.sku === '') { problems.push({ row: entry.row, sku: null, code: 'SKU_MISSING' }); continue; }
    if (!/^[1-9]\d{0,6}$/.test(entry.quantityText) || Number(entry.quantityText) > 1_000_000) { problems.push({ row: entry.row, sku: entry.sku, code: 'QUANTITY_INVALID' }); continue; }
    const key = entry.sku.toUpperCase();
    if (seen.has(key)) { problems.push({ row: entry.row, sku: entry.sku, code: 'DUPLICATE_SKU' }); continue; }
    seen.add(key);
    if (wanted.length >= UPLOAD_MAX_LINES) { problems.push({ row: entry.row, sku: entry.sku, code: 'TOO_MANY_LINES' }); continue; }
    wanted.push({ row: entry.row, sku: entry.sku, quantity: Number(entry.quantityText) });
  }
  const skus = wanted.map((entry) => entry.sku);
  const live = { status: 'ACTIVE' as const, isPublished: true };
  const [products, variants] = await Promise.all([
    prisma.product.findMany({ where: { sku: { in: skus }, ...live }, select: { id: true, sku: true, name: true } }),
    prisma.productVariant.findMany({ where: { sku: { in: skus }, product: live }, select: { id: true, sku: true, name: true, productId: true, product: { select: { name: true } } } }),
  ]);
  const bySku = new Map<string, { productId: string; variantId: string | null; name: string }>();
  for (const p of products) bySku.set(p.sku.toUpperCase(), { productId: p.id, variantId: null, name: p.name });
  for (const v of variants) bySku.set(v.sku.toUpperCase(), { productId: v.productId, variantId: v.id, name: `${v.product.name} — ${v.name}` });
  const lines: UploadPreview['lines'] = [];
  for (const entry of wanted) {
    const found = bySku.get(entry.sku.toUpperCase());
    if (found === undefined) problems.push({ row: entry.row, sku: entry.sku, code: 'SKU_UNKNOWN' });
    else lines.push({ row: entry.row, sku: entry.sku, quantity: entry.quantity, ...found });
  }
  problems.sort((a, b) => a.row - b.row);
  return { lines, problems };
}
