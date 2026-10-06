/**
 * What an inspection counted, measured and tested - exactly, and honestly.
 *
 * Pure. Every quantity is an exact decimal with up to three places, held as a
 * bigint count of thousandths; nothing here goes near a binary float, because
 * "4,999.999 kg" is a different shortage from "5,000 kg" and a float cannot
 * tell them apart reliably.
 *
 * The other half of the job is wording. A sample says something about the
 * units that were tested and NOTHING about the units that were not. So this
 * module reports "95 of 100 tested units passed; 4,900 units were not tested",
 * never "4,750 working units", and it keeps three things apart that are easy
 * to blur:
 *
 *   - quantity reconciliation: ordered vs declared vs physically verified;
 *   - functional results: tested, conforming, non-conforming, untested;
 *   - the lot disposition: PASS / FAIL / INCONCLUSIVE under the approved
 *     decision rule (`computeInspectionResult` in inspection-state.ts).
 *
 * An observed failure rate is a fact about a sample. It is not an acceptance
 * rule, and nothing here compares it to an AQL.
 */
import { ErrorCode, badRequest } from './errors.js';

/** Units counted in whole numbers. Everything else may carry decimals. */
export const COUNTABLE_UNITS = ['PIECE', 'PAIR', 'SET', 'BOX', 'CARTON', 'PALLET', 'ROLL'] as const;
export const MEASURED_UNITS = ['KILOGRAM', 'GRAM', 'LITRE', 'MILLILITRE', 'METRE', 'SQUARE_METRE'] as const;
export const QUANTITY_UNITS = [...COUNTABLE_UNITS, ...MEASURED_UNITS] as const;
export type QuantityUnitName = (typeof QUANTITY_UNITS)[number];

export const COUNTING_METHODS = ['FULL_COUNT', 'CARTON_COUNT', 'WEIGHED', 'MEASURED', 'DECLARED_ONLY'] as const;
export type CountingMethod = (typeof COUNTING_METHODS)[number];

export function isCountable(unit: QuantityUnitName): boolean {
  return (COUNTABLE_UNITS as readonly string[]).includes(unit);
}

/** Up to 15 digits, then up to three decimals. Zero allowed. */
const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,3})?$/;

/** An exact quantity in thousandths. `'2.5'` is 2500n. Throws on anything else. */
export function toMilli(value: string, field = 'quantity'): bigint {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw badRequest(ErrorCode.INSPECTION_QUANTITY_INVALID, `${field} must be a number with at most three decimal places.`, [
      { field, code: 'NOT_A_QUANTITY' },
    ]);
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3));
}

/** Thousandths back to the canonical string: `2500n` is `'2.5'`, `-1000n` is `'-1'`. */
export function fromMilli(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1000n;
  const fraction = (abs % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction.length > 0 ? `.${fraction}` : ''}`;
}

/** Whole thousandths only, for a countable unit. */
function assertWhole(milli: bigint, unit: QuantityUnitName, field: string): void {
  if (isCountable(unit) && milli % 1000n !== 0n) {
    throw badRequest(
      ErrorCode.INSPECTION_QUANTITY_INVALID,
      `${field} must be a whole number of ${unit.toLowerCase()}s.`,
      [{ field, code: 'NOT_WHOLE', meta: { unit } }],
    );
  }
}

export interface PackagingConversion {
  /** The outer unit, e.g. CARTON. */
  unit: QuantityUnitName;
  /** How many of `of` one outer unit contains, exact. */
  contains: string;
  of: QuantityUnitName;
}

export interface QuantityInput {
  unit: QuantityUnitName;
  scopeMethod: 'FULL' | 'SAMPLE';
  orderedQuantity: string;
  declaredQuantity?: string | null;
  verifiedQuantity?: string | null;
  countingMethod?: CountingMethod | null;
  packaging?: readonly PackagingConversion[] | null;
  sampledQuantity?: string | null;
  functionallyTestedQuantity?: string | null;
  testedConformingQuantity?: string | null;
  testedNonconformingQuantity?: string | null;
  damagedQuantity?: string | null;
}

/** The input parsed to thousandths, with nulls kept as nulls. */
export interface ParsedQuantities {
  unit: QuantityUnitName;
  scopeMethod: 'FULL' | 'SAMPLE';
  ordered: bigint;
  declared: bigint | null;
  verified: bigint | null;
  sampled: bigint | null;
  tested: bigint | null;
  conforming: bigint | null;
  nonconforming: bigint | null;
  damaged: bigint | null;
}

/**
 * Parse and cross-check a quantity record. Refuses, naming the field, when:
 *  - a value is not an exact decimal, or is fractional for a countable unit;
 *  - more was sampled than was verified, or tested than sampled;
 *  - conforming plus non-conforming is not exactly what was tested;
 *  - more is damaged than was verified;
 *  - a FULL inspection claims to have sampled less than every verified unit;
 *  - a packaging conversion is zero or converts a unit into itself.
 */
export function validateQuantities(input: QuantityInput): ParsedQuantities {
  const opt = (value: string | null | undefined, field: string): bigint | null => {
    if (value === null || value === undefined || value.trim().length === 0) return null;
    const milli = toMilli(value, field);
    assertWhole(milli, input.unit, field);
    return milli;
  };

  const parsed: ParsedQuantities = {
    unit: input.unit,
    scopeMethod: input.scopeMethod,
    ordered: toMilli(input.orderedQuantity, 'orderedQuantity'),
    declared: opt(input.declaredQuantity, 'declaredQuantity'),
    verified: opt(input.verifiedQuantity, 'verifiedQuantity'),
    sampled: opt(input.sampledQuantity, 'sampledQuantity'),
    tested: opt(input.functionallyTestedQuantity, 'functionallyTestedQuantity'),
    conforming: opt(input.testedConformingQuantity, 'testedConformingQuantity'),
    nonconforming: opt(input.testedNonconformingQuantity, 'testedNonconformingQuantity'),
    damaged: opt(input.damagedQuantity, 'damagedQuantity'),
  };
  assertWhole(parsed.ordered, input.unit, 'orderedQuantity');

  const refuse = (field: string, code: string, message: string): never => {
    throw badRequest(ErrorCode.INSPECTION_QUANTITY_INVALID, message, [{ field, code }]);
  };

  if (parsed.sampled !== null && parsed.verified !== null && parsed.sampled > parsed.verified) {
    refuse('sampledQuantity', 'SAMPLED_MORE_THAN_VERIFIED', 'More units were sampled than were physically verified.');
  }
  if (parsed.tested !== null && parsed.sampled !== null && parsed.tested > parsed.sampled) {
    refuse('functionallyTestedQuantity', 'TESTED_MORE_THAN_SAMPLED', 'More units were tested than were sampled.');
  }
  if (parsed.tested !== null && parsed.sampled === null && parsed.verified !== null && parsed.tested > parsed.verified) {
    refuse('functionallyTestedQuantity', 'TESTED_MORE_THAN_VERIFIED', 'More units were tested than were physically verified.');
  }
  if (parsed.conforming !== null || parsed.nonconforming !== null) {
    if (parsed.tested === null) {
      refuse('functionallyTestedQuantity', 'TESTED_REQUIRED', 'Record how many units were tested before their results.');
    }
    const total = (parsed.conforming ?? 0n) + (parsed.nonconforming ?? 0n);
    if (total !== parsed.tested) {
      refuse(
        'testedConformingQuantity',
        'RESULTS_DO_NOT_ADD_UP',
        'Conforming plus non-conforming units must equal the number tested.',
      );
    }
  }
  if (parsed.damaged !== null && parsed.verified !== null && parsed.damaged > parsed.verified) {
    refuse('damagedQuantity', 'DAMAGED_MORE_THAN_VERIFIED', 'More units are recorded as damaged than were verified.');
  }
  if (input.scopeMethod === 'FULL' && parsed.verified !== null && parsed.sampled !== null && parsed.sampled !== parsed.verified) {
    refuse(
      'sampledQuantity',
      'FULL_INSPECTION_NOT_FULL',
      'A full inspection examines every verified unit. Record it as a sample inspection instead.',
    );
  }
  for (const [index, conversion] of (input.packaging ?? []).entries()) {
    if (conversion.unit === conversion.of) {
      refuse(`packaging[${String(index)}]`, 'CONVERSION_TO_ITSELF', 'A packaging conversion must convert between two units.');
    }
    if (toMilli(conversion.contains, `packaging[${String(index)}].contains`) === 0n) {
      refuse(`packaging[${String(index)}]`, 'CONVERSION_ZERO', 'A packaging unit must contain more than nothing.');
    }
  }

  return parsed;
}

export interface QuantitySummary {
  unit: QuantityUnitName;
  scopeMethod: 'FULL' | 'SAMPLE';
  reconciliation: {
    ordered: string;
    declared: string | null;
    verified: string | null;
    /** verified - ordered. Negative is a shortage, positive an excess. Null if not verified. */
    difference: string | null;
    status: 'NOT_VERIFIED' | 'MATCHES' | 'SHORT' | 'EXCESS';
  };
  functional: {
    tested: string | null;
    conforming: string | null;
    nonconforming: string | null;
    /** Verified units that were not functionally tested. Null when it cannot be known. */
    untested: string | null;
    /**
     * Non-conforming over tested, in basis points, as an OBSERVATION about the
     * tested units. Not an acceptance rule, never compared to an AQL here.
     */
    observedNonconformingBasisPoints: number | null;
  };
  damaged: string | null;
  /**
   * The sentence a report prints, in English. Screens build their own from
   * the numbers in the reader's language.
   */
  statement: string;
}

function grouped(value: string): string {
  const [whole = '0', fraction] = value.replace('-', '').split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value.startsWith('-') ? '-' : ''}${withCommas}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** Reconciliation, functional results and the honest sentence. */
export function summariseQuantities(parsed: ParsedQuantities): QuantitySummary {
  const difference = parsed.verified === null ? null : parsed.verified - parsed.ordered;
  const status =
    difference === null ? 'NOT_VERIFIED' : difference === 0n ? 'MATCHES' : difference < 0n ? 'SHORT' : 'EXCESS';

  const untested =
    parsed.verified === null || parsed.tested === null ? null : parsed.verified - parsed.tested;

  const observed =
    parsed.tested === null || parsed.tested === 0n || parsed.nonconforming === null
      ? null
      : Number((parsed.nonconforming * 10_000n) / parsed.tested);

  const unitWord = parsed.unit === 'PIECE' ? 'units' : parsed.unit.toLowerCase().replace('_', ' ');
  let statement: string;
  if (parsed.tested === null || parsed.tested === 0n) {
    statement = 'No units were functionally tested.';
  } else if (parsed.conforming === null) {
    statement = `${grouped(fromMilli(parsed.tested))} ${unitWord} were tested; results were not recorded.`;
  } else {
    statement = `${grouped(fromMilli(parsed.conforming))} of ${grouped(fromMilli(parsed.tested))} tested ${unitWord} passed`;
    if (untested !== null && untested > 0n) {
      statement += `; ${grouped(fromMilli(untested))} ${unitWord} were not tested.`;
    } else if (untested === 0n) {
      statement += '; every verified unit was tested.';
    } else {
      statement += '; the number of untested units is not known because the lot was not counted.';
    }
  }

  return {
    unit: parsed.unit,
    scopeMethod: parsed.scopeMethod,
    reconciliation: {
      ordered: fromMilli(parsed.ordered),
      declared: parsed.declared === null ? null : fromMilli(parsed.declared),
      verified: parsed.verified === null ? null : fromMilli(parsed.verified),
      difference: difference === null ? null : fromMilli(difference),
      status,
    },
    functional: {
      tested: parsed.tested === null ? null : fromMilli(parsed.tested),
      conforming: parsed.conforming === null ? null : fromMilli(parsed.conforming),
      nonconforming: parsed.nonconforming === null ? null : fromMilli(parsed.nonconforming),
      untested: untested === null ? null : fromMilli(untested),
      observedNonconformingBasisPoints: observed,
    },
    damaged: parsed.damaged === null ? null : fromMilli(parsed.damaged),
    statement,
  };
}

// ---------------------------------------------------------------------------
// Defective units versus defect occurrences
// ---------------------------------------------------------------------------

export interface DefectUnitInput {
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  defectQuantity: number;
  unitRefs: readonly string[] | null;
}

export interface DefectUnitSummary {
  /** Every occurrence, summed. One unit with three defects is three. */
  occurrences: { critical: number; major: number; minor: number; total: number };
  /** Distinct sample units identified as carrying at least one defect. */
  defectiveUnitsIdentified: number;
  /** Distinct units by their WORST defect, so a unit is counted once. */
  defectiveUnitsByWorstSeverity: { critical: number; major: number; minor: number };
  /** Occurrences recorded without naming the unit, so they cannot be de-duplicated. */
  occurrencesWithoutUnit: number;
}

const RANK = { CRITICAL: 3, MAJOR: 2, MINOR: 1 } as const;

/** A unit reference: "U-017", "C3/12". Trimmed, case-folded for comparison. */
export function normaliseUnitRef(ref: string): string {
  return ref.trim().toUpperCase();
}

export function summariseDefectUnits(defects: readonly DefectUnitInput[]): DefectUnitSummary {
  const occurrences = { critical: 0, major: 0, minor: 0, total: 0 };
  const worst = new Map<string, DefectUnitInput['severity']>();
  let occurrencesWithoutUnit = 0;

  for (const defect of defects) {
    const count = Math.max(1, defect.defectQuantity);
    const key = defect.severity.toLowerCase() as 'critical' | 'major' | 'minor';
    occurrences[key] += count;
    occurrences.total += count;

    const refs = (defect.unitRefs ?? []).map(normaliseUnitRef).filter((ref) => ref.length > 0);
    if (refs.length === 0) {
      occurrencesWithoutUnit += count;
      continue;
    }
    for (const ref of new Set(refs)) {
      const previous = worst.get(ref);
      if (previous === undefined || RANK[defect.severity] > RANK[previous]) worst.set(ref, defect.severity);
    }
  }

  const byWorst = { critical: 0, major: 0, minor: 0 };
  for (const severity of worst.values()) byWorst[severity.toLowerCase() as 'critical' | 'major' | 'minor'] += 1;

  return {
    occurrences,
    defectiveUnitsIdentified: worst.size,
    defectiveUnitsByWorstSeverity: byWorst,
    occurrencesWithoutUnit,
  };
}
