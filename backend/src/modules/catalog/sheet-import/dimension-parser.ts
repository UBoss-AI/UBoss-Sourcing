/**
 * Reading a box size out of a sentence somebody typed.
 *
 * The same column carries all of these:
 *
 *     460*350*210 mm      168 X 124 X 155      27 x 124
 *     35.5*155mm          15*12 inch pouch     N/A
 *
 * The hard part is not the separators, it is the unit. Two of those six state
 * one; three do not; one is in inches. Assuming millimetres onto the inch
 * measurement is a twenty-five-fold error in a figure somebody sizes a shelf
 * or a pallet from, and assuming it onto the unitless ones is a guess dressed
 * up as data. So a unit is recorded only when the source names it, and a
 * dimension without one is shown as written with the fact that it has no unit
 * visible rather than hidden.
 */

export type DimensionParseStatus = 'PARSED' | 'UNIT_UNKNOWN' | 'UNPARSED';

export interface ParsedDimension {
  /** The source text, untouched. */
  raw: string;
  /** The numbers, one separator: "460 × 350 × 210". Null when unreadable. */
  displayValue: string | null;
  /** Only ever what the source actually said. */
  unit: string | null;
  status: DimensionParseStatus;
}

/**
 * Units, longest spelling first.
 *
 * Two details in the patterns are load-bearing. There is no word boundary
 * before the abbreviations, because the source writes "35.5*155mm" as often as
 * "155 mm" and `\bmm\b` matches neither digit-abutted form. And "mm" is tried
 * before "m", or every millimetre measurement in the catalogue silently
 * becomes metres - a thousandfold error that looks perfectly reasonable on
 * screen.
 */
const UNITS: [RegExp, string][] = [
  [/millimet(?:re|er)s?\b|mm\b/i, 'mm'],
  [/centimet(?:re|er)s?\b|cm\b/i, 'cm'],
  [/inch(?:es)?\b|\bins?\b|"/i, 'inch'],
  [/\bfeet\b|\bfoot\b|\bft\b/i, 'ft'],
  [/met(?:re|er)s?\b|\bm\b/i, 'm'],
];

/** A dimension is at most three numbers. More than that is not a box. */
const MAX_COMPONENTS = 3;

/** Beyond this it is not a carton, it is a misread decimal separator. */
const MAX_PLAUSIBLE_VALUE = 100_000;

function unitIn(text: string): string | null {
  for (const [pattern, label] of UNITS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/** Trim a parsed number back to how it was written: 35.5 stays, 460.0 does not. */
function formatComponent(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

export function parseDimension(rawInput: string | null | undefined): ParsedDimension {
  const raw = (rawInput ?? '').trim();
  if (raw === '') return { raw, displayValue: null, unit: null, status: 'UNPARSED' };

  const unit = unitIn(raw);

  // Every number in the string, in order. Separators are not matched directly
  // because the source uses "x", "X", "*" and "×" interchangeably, and one
  // value uses a mixture.
  const numbers = [...raw.matchAll(/\d+(?:\.\d+)?/g)]
    .map((match) => Number.parseFloat(match[0]))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= MAX_PLAUSIBLE_VALUE);

  if (numbers.length === 0 || numbers.length > MAX_COMPONENTS) {
    // Four or more numbers is not a box size - it is two measurements in one
    // cell, or a code that happens to contain digits. Showing the first three
    // of it would be a confident wrong answer, so the raw text stands alone.
    return { raw, displayValue: null, unit, status: 'UNPARSED' };
  }

  return {
    raw,
    displayValue: numbers.map(formatComponent).join(' × '),
    unit,
    status: unit === null ? 'UNIT_UNKNOWN' : 'PARSED',
  };
}

/**
 * A dimension as one line of text: "460 × 350 × 210 mm", or the raw value when
 * nothing could be read.
 *
 * Shared by the storefront, the admin panel and the import report for the same
 * reason `packingFormula` is: three screens phrasing one fact three ways gives
 * a reader three things to reconcile.
 */
export function dimensionLabel(dimension: {
  rawText: string;
  displayValue: string | null;
  unit: string | null;
}): string {
  if (dimension.displayValue === null) return dimension.rawText;
  return dimension.unit === null
    ? dimension.displayValue
    : `${dimension.displayValue} ${dimension.unit}`;
}
