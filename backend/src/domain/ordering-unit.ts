/**
 * Ordering by the pack, converted to pieces.
 *
 * One rule, and everything else follows from it: **quantity is always pieces**.
 * Every price, tax line, stock reservation, warehouse pick and ERP push reads
 * a piece count and has never had to know that packs exist. What a buyer chose
 * to count in is recorded beside that number, not instead of it.
 *
 * The conversion is done here, on the server, from the catalogue's own
 * packaging row - never from a figure the client sent. A client that could
 * post its own "pieces per carton" could post 1 and buy a carton for the price
 * of a syringe.
 *
 * And the conversion is snapshotted at the moment of the choice. Packing gets
 * corrected; "2 cartons" has to keep meaning the 4,000 pieces it meant on the
 * day it was agreed. That matters most on a schedule, where the charge happens
 * months later inside a worker with nobody watching.
 */
import { ErrorCode, badRequest } from './errors.js';

export type OrderingUnit = 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON';

export const ORDERING_UNITS: OrderingUnit[] = ['PIECE', 'INNER_PACK', 'OUTER_CARTON'];

/** What the catalogue knows about how a product is boxed. */
export interface PackConversion {
  piecesPerInnerPack: number | null;
  innerPacksPerOuterCarton: number | null;
  piecesPerOuterCarton: number | null;
  /**
   * False where the source's own arithmetic disagreed with itself.
   *
   * Such a row is displayed but never converted from. Ordering by the carton
   * off a figure nobody has confirmed is how a buyer receives twice what they
   * asked for.
   */
  isReliable: boolean;
}

/** The quantity as it is stored, plus what the buyer actually chose. */
export interface ResolvedOrderingQuantity {
  /** Pieces. The only number anything downstream reads. */
  quantity: number;
  orderingUnit: OrderingUnit;
  unitQuantity: number;
  piecesPerUnitSnapshot: number;
}

/**
 * How many pieces one of `unit` holds, or null when the catalogue cannot say.
 *
 * A carton falls back to inner × packs when the total was never stated, because
 * that is arithmetic with one answer rather than a guess. It does not fall the
 * other way: a stated carton total says nothing about how the pieces inside are
 * boxed, and dividing one by an invented inner count would be inventing twice.
 */
export function piecesPerUnit(unit: OrderingUnit, conversion: PackConversion): number | null {
  if (unit === 'PIECE') return 1;
  if (!conversion.isReliable) return null;

  if (unit === 'INNER_PACK') {
    return conversion.piecesPerInnerPack;
  }

  if (conversion.piecesPerOuterCarton !== null) return conversion.piecesPerOuterCarton;
  if (conversion.piecesPerInnerPack !== null && conversion.innerPacksPerOuterCarton !== null) {
    return conversion.piecesPerInnerPack * conversion.innerPacksPerOuterCarton;
  }
  return null;
}

/** Which units this product can actually be ordered in. Always includes pieces. */
export function availableUnits(conversion: PackConversion): OrderingUnit[] {
  return ORDERING_UNITS.filter((unit) => piecesPerUnit(unit, conversion) !== null);
}

/** A guard against a quantity that would overflow anything downstream. */
const MAX_PIECES = 10_000_000;

/**
 * Turn "2 cartons" into "4,000 pieces", or refuse.
 *
 * Refusing is the important half. A pack unit the catalogue has no figure for
 * is rejected with `PACK_SIZE_UNKNOWN` rather than quietly treated as one
 * piece - a buyer who asked for two cartons and received two syringes has been
 * failed far worse than one who was told the carton quantity is not on file.
 */
export function resolveOrderingQuantity(input: {
  unit: OrderingUnit | null | undefined;
  /** How many of `unit`. Falls back to `pieces` when no unit was named. */
  unitQuantity: number | null | undefined;
  /** The piece count a caller sent directly, for the unchanged piece path. */
  pieces: number;
  conversion: PackConversion;
  /** Names the field an error points at, so a batch add can say which line. */
  field: string;
}): ResolvedOrderingQuantity {
  const unit = input.unit ?? 'PIECE';

  if (unit === 'PIECE') {
    return {
      quantity: input.pieces,
      orderingUnit: 'PIECE',
      unitQuantity: input.pieces,
      piecesPerUnitSnapshot: 1,
    };
  }

  const unitQuantity = input.unitQuantity ?? 0;
  if (!Number.isInteger(unitQuantity) || unitQuantity <= 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose how many packs you need.', [
      { field: input.field, code: 'INVALID' },
    ]);
  }

  const perUnit = piecesPerUnit(unit, input.conversion);
  if (perUnit === null) {
    throw badRequest(
      ErrorCode.PACK_SIZE_UNKNOWN,
      unit === 'INNER_PACK'
        ? 'We have not recorded how many pieces are in a box of this product, so it cannot be ordered by the box yet. Order by the piece, or ask us.'
        : 'We have not recorded how many pieces are in a carton of this product, so it cannot be ordered by the carton yet. Order by the piece, or ask us.',
      [{ field: input.field, code: 'PACK_SIZE_UNKNOWN' }],
    );
  }

  const quantity = unitQuantity * perUnit;
  if (quantity > MAX_PIECES) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That is more than we can take in one order.', [
      { field: input.field, code: 'TOO_MANY' },
    ]);
  }

  return { quantity, orderingUnit: unit, unitQuantity, piecesPerUnitSnapshot: perUnit };
}

/**
 * The stored line, described the way the buyer chose it.
 *
 * Reads off the snapshot rather than the catalogue, on purpose: a line agreed
 * at 100 to a box stays "2 boxes (200 pieces)" even after the box is
 * re-specified at 50, because that is what was agreed.
 */
export function describeOrderingQuantity(line: {
  quantity: number;
  orderingUnit: OrderingUnit;
  unitQuantity: number;
  piecesPerUnitSnapshot: number;
}): { unit: OrderingUnit; unitQuantity: number; pieces: number; piecesPerUnit: number } {
  return {
    unit: line.orderingUnit,
    unitQuantity: line.unitQuantity,
    pieces: line.quantity,
    piecesPerUnit: line.piecesPerUnitSnapshot,
  };
}
