/**
 * The differences between quotes, worked out only from the quotes' own fields
 * (ENH-002). Every conclusion names the field it came from and the quotes it
 * is about, so the page can link it to the exact cell. No model, no guess:
 * where the data cannot support a conclusion, none is drawn and that is said.
 */
import type { Money } from '@/lib/format';
import type { ComparisonRow } from '@/lib/rfq-quote';

export type SummaryField = 'total' | 'landed' | 'leadTime' | 'moq';

export interface Conclusion {
  field: SummaryField;
  quoteIds: string[];
  suppliers: string[];
  /** Display value: formatted money, days or MOQ text. */
  value: string;
  /** Quotes that did not state this field and so were left out. */
  unstated: number;
}

function basisOf(rows: ComparisonRow[]): 'converted' | 'quoted' | null {
  if (rows.every((row) => row.converted !== null)) return 'converted';
  return new Set(rows.map((row) => row.quoted.currency)).size === 1 ? 'quoted' : null;
}

function lowest<T>(rows: ComparisonRow[], field: SummaryField, pick: (row: ComparisonRow) => T | null, less: (a: T, b: T) => number, show: (value: T) => string): Conclusion | null {
  const stated = rows.map((row) => ({ row, value: pick(row) })).filter((entry): entry is { row: ComparisonRow; value: T } => entry.value !== null);
  if (stated.length < 2) return null;
  const best = stated.reduce((a, b) => (less(b.value, a.value) < 0 ? b : a)).value;
  const winners = stated.filter((entry) => less(entry.value, best) === 0);
  if (winners.length === stated.length) return null; // all the same: no difference to report
  return {
    field,
    quoteIds: winners.map((entry) => entry.row.quoteId),
    suppliers: winners.map((entry) => entry.row.supplier.displayName),
    value: show(best),
    unstated: rows.length - stated.length,
  };
}

const money = (a: Money, b: Money): number => { const x = BigInt(a.minor); const y = BigInt(b.minor); return x < y ? -1 : x > y ? 1 : 0; };

export function summarise(rows: ComparisonRow[], formatMoney: (m: Money) => string): { comparablePrices: boolean; conclusions: Conclusion[] } {
  const basis = basisOf(rows);
  const conclusions: (Conclusion | null)[] = [];
  if (basis !== null) {
    const side = (row: ComparisonRow) => (basis === 'converted' ? row.converted : row.quoted);
    conclusions.push(lowest(rows, 'total', (row) => side(row)?.total ?? null, money, formatMoney));
    conclusions.push(lowest(rows, 'landed', (row) => side(row)?.landedEstimate ?? null, money, formatMoney));
  }
  conclusions.push(lowest(rows, 'leadTime', (row) => row.leadTimeDays, (a, b) => a - b, String));
  conclusions.push(lowest(rows, 'moq', (row) => (row.moq !== null && /^\d+(\.\d+)?$/.test(row.moq) ? row.moq : null), (a, b) => Number(a) - Number(b), String));
  return { comparablePrices: basis !== null, conclusions: conclusions.filter((c): c is Conclusion => c !== null) };
}

/** The table cell a conclusion links to; the table uses the same id. */
export function compareCellId(label: string, quoteId: string): string {
  return `cmp-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${quoteId}`;
}
