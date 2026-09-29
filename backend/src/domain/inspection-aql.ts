/**
 * Acceptance sampling, ISO 2859-1 single sampling, normal inspection.
 *
 * The inspector does not choose how many units to open or how many defects are
 * acceptable: the category's inspection plan names an inspection level and an
 * AQL per severity, and this file turns those and the lot size into a sample
 * size with accept (Ac) and reject (Re) numbers. The result is copied onto the
 * job when it is booked, so a plan edited later does not change a job already
 * under way (INSPECT-002).
 *
 * The master table is not stored cell by cell. Every AQL column of Table 2-A
 * has the same shape: arrows down to the first row where the column starts, a
 * 0/1 cell, an arrow up, and then the accept numbers 1, 1, 2, 3, 5, 7, 10, 14,
 * 21 one row at a time. So a column is fully described by the row its 0/1
 * cell sits on, which is what `ZERO_ONE_ROW` records. An arrow sends the
 * inspector to the sample size of the row it points at, and that is what is
 * returned as the class's own sample size.
 */

/** Code letters in order, with their sample sizes. */
const CODE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R'] as const;
const SAMPLE_SIZES = [2, 3, 5, 8, 13, 20, 32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000] as const;

export type CodeLetter = (typeof CODE_LETTERS)[number];
export type InspectionLevel = 'I' | 'II' | 'III';

/** Upper bound of each lot-size band (Table 1). The last band is open. */
const LOT_BANDS = [8, 15, 25, 50, 90, 150, 280, 500, 1200, 3200, 10_000, 35_000, 150_000, 500_000, Infinity];

/** Code letter index per lot band, for each general inspection level. */
const LEVEL_LETTERS: Record<InspectionLevel, readonly number[]> = {
  I: [0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  II: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  III: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
};

/**
 * The AQL values supported, and the code-letter row of each one's 0/1 cell.
 * `0` is zero tolerance: accept nothing, whatever the sample.
 */
const ZERO_ONE_ROW: Readonly<Record<string, number>> = Object.freeze({
  '0.010': 14,
  '0.015': 13,
  '0.025': 12,
  '0.040': 11,
  '0.065': 10,
  '0.10': 9,
  '0.15': 8,
  '0.25': 7,
  '0.40': 6,
  '0.65': 5,
  '1.0': 4,
  '1.5': 3,
  '2.5': 2,
  '4.0': 1,
  '6.5': 0,
});

/** Accept numbers below a column's 0/1 cell; `null` is the arrow up. */
const LADDER: readonly (number | null)[] = [0, null, 1, 1, 2, 3, 5, 7, 10, 14, 21];

export const SUPPORTED_AQL_VALUES: readonly string[] = Object.freeze(['0', ...Object.keys(ZERO_ONE_ROW)]);

/** "2.50" and "2.5" are the same AQL. Returns the table's own spelling, or null. */
export function normaliseAql(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const number = Number(trimmed);
  if (number === 0) return '0';
  const match = Object.keys(ZERO_ONE_ROW).find((key) => Math.abs(Number(key) - number) < 1e-9);
  return match ?? null;
}

export function codeLetterFor(lotSize: number, level: InspectionLevel): CodeLetter {
  const size = Math.max(2, Math.floor(lotSize));
  const band = LOT_BANDS.findIndex((upper) => size <= upper);
  const index = LEVEL_LETTERS[level][band === -1 ? LOT_BANDS.length - 1 : band] ?? 0;
  return CODE_LETTERS[index] ?? 'A';
}

export interface SamplingClass {
  aql: string;
  /** Units to examine for this class. Never more than the lot. */
  sampleSize: number;
  accept: number;
  reject: number;
}

/**
 * Sample size and Ac/Re for one AQL at one code letter.
 *
 * Arrows are followed to the row they point at. A sample larger than the lot
 * becomes the whole lot (100% inspection), keeping the table's accept number.
 */
export function samplingFor(letter: CodeLetter, aql: string, lotSize: number): SamplingClass {
  const letterIndex = CODE_LETTERS.indexOf(letter);
  const normalised = normaliseAql(aql);

  if (normalised === null) {
    throw new Error(`Unsupported AQL ${aql}.`);
  }

  const cap = (size: number): number => Math.min(size, Math.max(1, Math.floor(lotSize)));

  if (normalised === '0') {
    return { aql: '0', sampleSize: cap(SAMPLE_SIZES[letterIndex] ?? 2), accept: 0, reject: 1 };
  }

  const start = ZERO_ONE_ROW[normalised] ?? 0;
  let row = letterIndex;

  // Above the 0/1 cell: the arrow points down to it.
  if (row < start) row = start;

  let step = row - start;
  // Past the bottom of the ladder: the last cell covers everything below it.
  if (step >= LADDER.length) {
    step = LADDER.length - 1;
    row = start + step;
  }
  // The arrow up: use the row above, which is the 0/1 cell.
  if (LADDER[step] === null) {
    step -= 1;
    row -= 1;
  }

  const accept = LADDER[step] ?? 0;
  const sampleSize = SAMPLE_SIZES[Math.min(row, SAMPLE_SIZES.length - 1)] ?? 2000;

  return { aql: normalised, sampleSize: cap(sampleSize), accept, reject: accept + 1 };
}

export interface SamplingPlan {
  lotSize: number;
  level: InspectionLevel;
  codeLetter: CodeLetter;
  /** The general sample size for the lot - the number of units opened. */
  sampleSize: number;
  critical: SamplingClass;
  major: SamplingClass;
  minor: SamplingClass;
}

export function buildSamplingPlan(input: {
  lotSize: number;
  level: InspectionLevel;
  aqlCritical: string;
  aqlMajor: string;
  aqlMinor: string;
}): SamplingPlan {
  const letter = codeLetterFor(input.lotSize, input.level);
  const letterIndex = CODE_LETTERS.indexOf(letter);
  const critical = samplingFor(letter, input.aqlCritical, input.lotSize);
  const major = samplingFor(letter, input.aqlMajor, input.lotSize);
  const minor = samplingFor(letter, input.aqlMinor, input.lotSize);

  return {
    lotSize: input.lotSize,
    level: input.level,
    codeLetter: letter,
    // Enough units for every class: an arrow can send one class to a larger
    // sample than the lot's own letter.
    sampleSize: Math.min(
      Math.max(
        SAMPLE_SIZES[letterIndex] ?? 2,
        critical.sampleSize,
        major.sampleSize,
        minor.sampleSize,
      ),
      Math.max(1, Math.floor(input.lotSize)),
    ),
    critical,
    major,
    minor,
  };
}

export function isInspectionLevel(value: string): value is InspectionLevel {
  return value === 'I' || value === 'II' || value === 'III';
}
