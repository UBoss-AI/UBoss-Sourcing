/**
 * The figures on a seller's invoice, from the figures on the order.
 *
 * Pure. An invoice never re-prices anything: every amount comes off the order
 * line the buyer was charged against, which is frozen at checkout. What this
 * file adds is the one thing an order does not know - that its lines may leave
 * in several consignments, each with its own invoice.
 *
 * THE APPORTIONMENT RULE
 *
 * A consignment carrying q of a line's Q pieces takes floor(amount x q / Q) of
 * each of the line's amounts, EXCEPT the consignment that completes the line,
 * which takes whatever has not yet been invoiced. So however a line is split,
 * the invoices for it add up to the order line exactly, to the paisa - a
 * seller's invoices and the buyer's order can never disagree about a total.
 */
import { splitGst, type GstSupplyType } from './gst.js';

export interface OrderLineFigures {
  orderItemId: string;
  quantity: number;
  unitPriceMinor: bigint;
  lineSubtotalMinor: bigint;
  discountMinor: bigint;
  taxAmountMinor: bigint;
  lineTotalMinor: bigint;
  taxRatePercent: string;
  taxInclusive: boolean;
}

/** What earlier, still-standing invoices already took from this line. */
export interface AlreadyInvoiced {
  quantity: number;
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
}

export const NOTHING_INVOICED: AlreadyInvoiced = Object.freeze({
  quantity: 0,
  subtotalMinor: 0n,
  discountMinor: 0n,
  taxMinor: 0n,
  totalMinor: 0n,
});

export interface LineShare {
  quantity: number;
  subtotalMinor: bigint;
  discountMinor: bigint;
  /** The value tax is charged on: total less tax, inclusive or not. */
  taxableMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
}

export class InvoiceArithmeticError extends Error {}

/** This consignment's share of one order line. */
export function shareOfLine(
  line: OrderLineFigures,
  quantity: number,
  prior: AlreadyInvoiced,
): LineShare {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new InvoiceArithmeticError('A shipped quantity must be a positive whole number.');
  }
  if (prior.quantity + quantity > line.quantity) {
    throw new InvoiceArithmeticError(
      `Invoicing ${String(quantity)} would take this line past its ${String(line.quantity)} pieces.`,
    );
  }

  const completes = prior.quantity + quantity === line.quantity;
  const part = (amount: bigint, already: bigint): bigint =>
    completes ? amount - already : (amount * BigInt(quantity)) / BigInt(line.quantity);

  const subtotalMinor = part(line.lineSubtotalMinor, prior.subtotalMinor);
  const discountMinor = part(line.discountMinor, prior.discountMinor);
  const taxMinor = part(line.taxAmountMinor, prior.taxMinor);
  const totalMinor = part(line.lineTotalMinor, prior.totalMinor);

  return {
    quantity,
    subtotalMinor,
    discountMinor,
    taxableMinor: totalMinor - taxMinor,
    taxMinor,
    totalMinor,
  };
}

export interface TaxRow {
  ratePercent: string;
  taxableMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  /** VAT or other tax, on a non-GST invoice. */
  otherMinor: bigint;
  taxMinor: bigint;
}

/**
 * The tax per rate, split into its components.
 *
 * Split per LINE and summed, not split from the per-rate total: a line's
 * CGST and SGST are what its own invoice line shows, and a total that halved
 * the sum could differ from the sum of the halves by a paisa.
 */
export function taxBreakdown(
  lines: readonly { ratePercent: string; taxableMinor: bigint; taxMinor: bigint }[],
  supplyType: GstSupplyType | null,
): TaxRow[] {
  const rows = new Map<string, TaxRow>();

  for (const line of lines) {
    const key = normaliseRate(line.ratePercent);
    const row = rows.get(key) ?? {
      ratePercent: key,
      taxableMinor: 0n,
      cgstMinor: 0n,
      sgstMinor: 0n,
      igstMinor: 0n,
      otherMinor: 0n,
      taxMinor: 0n,
    };
    row.taxableMinor += line.taxableMinor;
    row.taxMinor += line.taxMinor;
    if (supplyType === null) {
      row.otherMinor += line.taxMinor;
    } else {
      const split = splitGst(line.taxMinor, supplyType);
      row.cgstMinor += split.cgst;
      row.sgstMinor += split.sgst;
      row.igstMinor += split.igst;
    }
    rows.set(key, row);
  }

  return [...rows.values()].sort((a, b) => Number(b.ratePercent) - Number(a.ratePercent));
}

/** "18.000000" -> "18", "5.500000" -> "5.5". A label, never arithmetic. */
export function normaliseRate(ratePercent: string): string {
  const [whole = '0', fraction = ''] = ratePercent.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? String(Number(whole)) : `${String(Number(whole))}.${trimmed}`;
}

/** Half of a rate, for the CGST and SGST columns: "18" -> "9", "5" -> "2.5". */
export function halfRate(ratePercent: string): string {
  const [whole = '0', fraction = ''] = ratePercent.split('.');
  const scaled = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6) || '0');
  const half = scaled / 2n;
  const wholePart = half / 1_000_000n;
  const frac = (half % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac === '' ? wholePart.toString() : `${wholePart.toString()}.${frac}`;
}

export interface InvoiceTotals {
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxableMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  otherTaxMinor: bigint;
  totalTaxMinor: bigint;
  freightMinor: bigint;
  grandTotalMinor: bigint;
}

/**
 * The document's totals, from its lines and its freight.
 *
 * `grandTotal = sum(line totals) + freight`: the same assembly the order's own
 * grand total uses, so an order shipped in one consignment has an invoice
 * whose total IS the order total.
 */
export function invoiceTotals(
  lines: readonly LineShare[],
  breakdown: readonly TaxRow[],
  freightMinor: bigint,
): InvoiceTotals {
  const sum = (pick: (line: LineShare) => bigint) =>
    lines.reduce((total, line) => total + pick(line), 0n);
  const sumRows = (pick: (row: TaxRow) => bigint) =>
    breakdown.reduce((total, row) => total + pick(row), 0n);

  const lineTotals = sum((line) => line.totalMinor);

  return {
    subtotalMinor: sum((line) => line.subtotalMinor),
    discountMinor: sum((line) => line.discountMinor),
    taxableMinor: sum((line) => line.taxableMinor),
    cgstMinor: sumRows((row) => row.cgstMinor),
    sgstMinor: sumRows((row) => row.sgstMinor),
    igstMinor: sumRows((row) => row.igstMinor),
    cessMinor: 0n,
    otherTaxMinor: sumRows((row) => row.otherMinor),
    totalTaxMinor: sum((line) => line.taxMinor),
    freightMinor,
    grandTotalMinor: lineTotals + freightMinor,
  };
}
