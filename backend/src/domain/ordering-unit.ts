/**
 * Ordering by the carton.
 *
 * **This shop sells cartons and nothing else.** Not pieces, not inner boxes -
 * a buyer chooses a number of cartons, and one carton holds the configured
 * number of pieces (500 unless a deployment sets `PIECES_PER_CARTON`). There
 * is no second way to count, on any screen or in any request.
 *
 * One rule survives from when there were three, and everything else follows
 * from it: **the stored quantity is always pieces**. Every price, tax line,
 * stock reservation, warehouse pick and ERP push reads a piece count and has
 * never had to know that cartons exist. What the buyer actually chose - the
 * carton count - is recorded beside that number, not instead of it.
 *
 * The conversion is done here, on the server, from the deployment's own
 * setting - never from a figure the client sent. A client that could post its
 * own "pieces per carton" could post 1 and buy a carton for the price of a
 * syringe.
 *
 * And the conversion is snapshotted at the moment of the choice. The setting
 * gets changed; "2 cartons" has to keep meaning the 1,000 pieces it meant on
 * the day it was agreed. That matters most on a schedule, where the charge
 * happens months later inside a worker with nobody watching.
 */
import { ErrorCode, badRequest } from './errors.js';

/**
 * The unit column as the database still spells it.
 *
 * Three members, because rows written before the shop settled on cartons say
 * `PIECE` or `INNER_PACK` and an old invoice has to keep describing itself
 * honestly. Nothing new is ever written with either of them - see
 * `SELLING_UNIT`.
 */
export type OrderingUnit = 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON';

/** The one unit anything is sold in. */
export const SELLING_UNIT = 'OUTER_CARTON' as const;

/**
 * Pieces in a carton where nothing has been configured.
 *
 * The domain stays free of the environment, so the figure arrives as an
 * argument from whoever read `env.PIECES_PER_CARTON`. This is what they fall
 * back to, and it is the same 500 the setting defaults to - two places, one
 * number, and the test suite holds them together.
 */
export const DEFAULT_PIECES_PER_CARTON = 500;

/** The quantity as it is stored, plus what the buyer actually chose. */
export interface ResolvedOrderingQuantity {
  /** Pieces. The only number anything downstream reads. */
  quantity: number;
  orderingUnit: OrderingUnit;
  /** Cartons. What the buyer typed. */
  unitQuantity: number;
  piecesPerUnitSnapshot: number;
}

/** A guard against a quantity that would overflow anything downstream. */
const MAX_PIECES = 10_000_000;

/**
 * Pieces to whole cartons, always rounding up.
 *
 * For the callers that still speak in pieces - a reorder of a line placed
 * before cartons, an ERP or API client sending a piece count. Rounding up
 * rather than down because part of a carton is not something this shop can
 * ship: asking for 600 pieces is asking for two cartons, and the alternative
 * is quietly delivering less than was asked for.
 */
export function cartonsForPieces(pieces: number, piecesPerCarton: number): number {
  return Math.max(1, Math.ceil(pieces / Math.max(1, piecesPerCarton)));
}

/**
 * Turn "2 cartons" into "1,000 pieces".
 *
 * A caller that names no unit is taken to be speaking in pieces and is rounded
 * up to whole cartons, so there is no route - storefront, API or worker -
 * through which a part-carton line can reach a basket.
 */
export function resolveOrderingQuantity(input: {
  /** Only `OUTER_CARTON` is sellable; anything else is read as pieces. */
  unit: OrderingUnit | null | undefined;
  /** How many cartons. Falls back to `pieces` when no unit was named. */
  unitQuantity: number | null | undefined;
  /** A piece count from a caller that does not count in cartons. */
  pieces: number;
  /** This deployment's carton size, from `env.PIECES_PER_CARTON`. */
  piecesPerCarton: number;
  /** Names the field an error points at, so a batch add can say which line. */
  field: string;
}): ResolvedOrderingQuantity {
  const perCarton = Math.max(1, input.piecesPerCarton);

  const cartons =
    input.unit === SELLING_UNIT
      ? (input.unitQuantity ?? 0)
      : cartonsForPieces(input.pieces, perCarton);

  if (!Number.isInteger(cartons) || cartons <= 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose how many cartons you need.', [
      { field: input.field, code: 'INVALID' },
    ]);
  }

  const quantity = cartons * perCarton;
  if (quantity > MAX_PIECES) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That is more than we can take in one order.', [
      { field: input.field, code: 'TOO_MANY' },
    ]);
  }

  return {
    quantity,
    orderingUnit: SELLING_UNIT,
    unitQuantity: cartons,
    piecesPerUnitSnapshot: perCarton,
  };
}

/**
 * The stored line, described the way the buyer chose it.
 *
 * Reads off the snapshot rather than the setting, on purpose: a line agreed at
 * 500 to a carton stays "2 cartons (1,000 pieces)" even after the deployment
 * re-specifies a carton at 250, because that is what was agreed.
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
