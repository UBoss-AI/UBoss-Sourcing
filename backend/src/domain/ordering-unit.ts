/**
 * What a buyer counts in.
 *
 * There are two answers, and which one applies is decided by **who is selling**
 * - never by a category, a route, or a word in a product name.
 *
 *   - **The operator sells cartons.** A buyer chooses a number of cartons, and
 *     one carton holds the configured number of pieces (500 unless a
 *     deployment sets `PIECES_PER_CARTON`). This is the original shop and
 *     nothing about it changes.
 *
 *   - **A third-party seller sells pieces.** A marketplace offer is an
 *     ordinary listing: a price per piece, stock in pieces, a minimum and a
 *     step the seller chose. The operator's carton is the operator's, and
 *     applying it to somebody else's offer is how a seller's small item is
 *     charged at five hundred times what the card said.
 *
 * One rule survives from when there was only the carton, and everything else
 * follows from it: **the stored quantity is always pieces**. Every price, tax
 * line, stock reservation, warehouse pick and ERP push reads a piece count and
 * has never had to know that cartons exist. What the buyer actually chose -
 * the carton count, or the piece count - is recorded beside that number, not
 * instead of it. For a seller's offer the two are the same number, which is
 * exactly why a piece offer needed no new column to be counted correctly.
 *
 * The conversion is done here, on the server, from the deployment's own
 * setting or the offer's own terms - never from a figure the client sent. A
 * client that could post its own "pieces per unit" could post 1 and buy a
 * carton for the price of a syringe; a client that could name the unit could
 * ask for a seller's piece offer "by the carton" and get five hundred of them
 * for the price on the card.
 *
 * And the conversion is snapshotted at the moment of the choice. The setting
 * gets changed; "2 cartons" has to keep meaning the 1,000 pieces it meant on
 * the day it was agreed. That matters most on a schedule, where the charge
 * happens months later inside a worker with nobody watching.
 */
import { ErrorCode, badRequest, conflict } from './errors.js';

/**
 * The unit column as the database still spells it.
 *
 * Three members, because rows written before the shop settled on cartons say
 * `PIECE` or `INNER_PACK` and an old invoice has to keep describing itself
 * honestly. Nothing new is ever written with either of them - see
 * `SELLING_UNIT`.
 */
export type OrderingUnit = 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON';

/**
 * The unit the OPERATOR sells in.
 *
 * Still named `SELLING_UNIT` because every existing caller means the
 * operator's carton by it, and renaming it would have touched a dozen files to
 * say the same thing. A seller's unit is `SELLER_SELLING_UNIT`.
 */
export const SELLING_UNIT = 'OUTER_CARTON' as const;

/**
 * The unit a THIRD-PARTY SELLER sells in.
 *
 * One selected unit is one physical piece, so the snapshot factor is 1 and
 * there is no multiplication anywhere on the path. That is the entire fix:
 * not a new kind of arithmetic, but the absence of the operator's.
 *
 * Deliberately the only value a seller offer may carry. Packs, boxes and
 * seller-defined cartons are not modelled - an offer found holding one is held
 * for review rather than guessed at, because the guess is the difference
 * between a price meaning one piece and it meaning five hundred.
 */
export const SELLER_SELLING_UNIT = 'PIECE' as const;

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

// ---------------------------------------------------------------------------
// What one line may be counted in
// ---------------------------------------------------------------------------

/**
 * The terms a single line is counted and stepped by.
 *
 * Built on the server from the offer that is actually selling the thing, and
 * passed to `resolveSellUnitQuantity` as the only authority on the question.
 * Nothing in it is ever read from a request body.
 */
export interface SellUnitSpec {
  /** What the buyer picks a number of. */
  unit: OrderingUnit;
  /** Pieces in one of those. 500 for the operator's carton, 1 for a piece. */
  piecesPerUnit: number;
  /** The fewest the buyer may take, in sell units. */
  minimumOrderQuantity: number;
  /** Quantities must be a multiple of this, in sell units. 1 means no step. */
  orderIncrement: number;
  /** The most the buyer may take, in sell units. Null means no ceiling. */
  maximumOrderQuantity: number | null;
}

/**
 * The operator's own line: cartons, at this deployment's carton size.
 *
 * The minimum and the step stay at one carton. The operator's per-product
 * minimum is written in PIECES and is applied further down by the cart, which
 * is where it has always been applied - moving it here would change a rule
 * this work has no business changing.
 */
export function operatorSellUnit(piecesPerCarton: number): SellUnitSpec {
  return {
    unit: SELLING_UNIT,
    piecesPerUnit: Math.max(1, Math.trunc(piecesPerCarton)),
    minimumOrderQuantity: 1,
    orderIncrement: 1,
    maximumOrderQuantity: null,
  };
}

/** An offer, as much of it as the unit question needs. */
export interface SellerOfferUnitTerms {
  orderingUnit: OrderingUnit;
  minimumOrderQuantity: number;
  orderIncrement: number;
  maximumOrderQuantity: number | null;
}

/**
 * A seller's line: pieces, at the seller's own minimum and step.
 *
 * Throws rather than falling back when the stored unit is anything but
 * `PIECE`. There is no safe default available here: reading a carton offer as
 * pieces divides the seller's price by five hundred, and reading it as cartons
 * multiplies the buyer's basket by the same. The offer is held instead, and
 * `SELLER_OFFER_UNIT_UNSUPPORTED` is the code that says so - the migration in
 * the same commit flags any such offer for a human rather than rewriting it.
 */
export function sellerSellUnit(offer: SellerOfferUnitTerms): SellUnitSpec {
  if (offer.orderingUnit !== SELLER_SELLING_UNIT) {
    throw conflict(
      ErrorCode.SELLER_OFFER_UNIT_UNSUPPORTED,
      'This seller listing is set up in a unit the marketplace no longer sells in. The seller has been asked to restate its price and stock in pieces.',
      [{ code: 'UNIT_NOT_SUPPORTED', meta: { orderingUnit: offer.orderingUnit } }],
    );
  }

  return {
    unit: SELLER_SELLING_UNIT,
    // Always one. Never `env.PIECES_PER_CARTON`, and never a figure off the
    // offer - a seller who could state their own factor could state 500 and
    // take five hundred pieces out of stock for one piece of revenue.
    piecesPerUnit: 1,
    minimumOrderQuantity: Math.max(1, Math.trunc(offer.minimumOrderQuantity)),
    orderIncrement: Math.max(1, Math.trunc(offer.orderIncrement)),
    maximumOrderQuantity:
      offer.maximumOrderQuantity === null
        ? null
        : Math.max(1, Math.trunc(offer.maximumOrderQuantity)),
  };
}

/**
 * How many sell units the buyer asked for, whatever shape they asked in.
 *
 * The client may name the unit, and where it does it must be the one the line
 * is actually sold in. A mismatch is refused rather than reinterpreted: a
 * request for a seller's piece offer "by the carton" is either a stale client
 * or somebody trying it on, and the generous reading of it hands them five
 * hundred pieces at the price of one.
 *
 * A caller that names no unit is speaking in pieces, and is rounded UP to whole
 * sell units - which for a seller's piece offer is not a rounding at all.
 *
 * The refusal is asymmetric on purpose, and the asymmetry is the point:
 *
 *   - **On a seller's line a mismatch is refused.** The factor between the two
 *     units is five hundred, so the generous reading is not a rounding - it is
 *     a basket five hundred times the one the shopper agreed to.
 *
 *   - **On the operator's line it is read as pieces**, exactly as it always
 *     has been. That is not leniency left over from anything; it is the
 *     documented route for a reorder of a pre-carton line and for an ERP or
 *     API client that counts in pieces, and it rounds UP, so the worst it can
 *     do is deliver a whole carton to somebody who asked for most of one.
 */
function requestedUnits(input: {
  spec: SellUnitSpec;
  unit: OrderingUnit | null | undefined;
  unitQuantity: number | null | undefined;
  pieces: number;
  field: string;
}): number {
  const named = input.unit ?? null;

  if (named !== null && named !== input.spec.unit && input.spec.unit === SELLER_SELLING_UNIT) {
    throw badRequest(
      ErrorCode.SELLER_OFFER_UNIT_MISMATCH,
      'This seller sells this by the piece. Choose a number of pieces.',
      [
        {
          field: input.field,
          code: 'UNIT_MISMATCH',
          meta: { expected: input.spec.unit, received: named },
        },
      ],
    );
  }

  return named === input.spec.unit
    ? (input.unitQuantity ?? 0)
    : unitsForPieces(input.pieces, input.spec.piecesPerUnit);
}

/**
 * Turn what the buyer asked for into what gets stored.
 *
 * The one function every purchase path calls, and the reason the carton case
 * and the piece case cannot drift: they are the same few lines with a
 * different `piecesPerUnit`.
 *
 * The minimum and the step are applied HERE, in sell units, before the piece
 * count is derived. Applying them afterwards - in pieces - is what would let a
 * seller's "minimum 5, in steps of 5" be satisfied by 7.
 */
export function resolveSellUnitQuantity(input: {
  spec: SellUnitSpec;
  /** The unit the client named, where it named one. Checked, never trusted. */
  unit: OrderingUnit | null | undefined;
  /** How many of the spec's unit. */
  unitQuantity: number | null | undefined;
  /** A piece count, from a caller that does not count in sell units. */
  pieces: number;
  /** Names the field an error points at, so a batch add can say which line. */
  field: string;
}): ResolvedOrderingQuantity {
  const { spec } = input;
  const perUnit = Math.max(1, spec.piecesPerUnit);

  const asked = requestedUnits(input);

  if (!Number.isInteger(asked) || asked <= 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      spec.unit === SELLER_SELLING_UNIT
        ? 'Choose how many pieces you need.'
        : 'Choose how many cartons you need.',
      [{ field: input.field, code: 'INVALID' }],
    );
  }

  // Raised to the minimum, then raised again onto the step. In that order: a
  // minimum of 5 with a step of 4 means 8, not 5 - the step is a rule about
  // what the seller can actually pick and pack, and the minimum does not
  // exempt a buyer from it.
  const step = Math.max(1, spec.orderIncrement);
  const atLeast = Math.max(asked, Math.max(1, spec.minimumOrderQuantity));
  const units = Math.ceil(atLeast / step) * step;

  if (spec.maximumOrderQuantity !== null && units > spec.maximumOrderQuantity) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      spec.unit === SELLER_SELLING_UNIT
        ? `This seller takes at most ${String(spec.maximumOrderQuantity)} pieces on one order.`
        : `At most ${String(spec.maximumOrderQuantity)} cartons on one order.`,
      [{ field: input.field, code: 'TOO_MANY', meta: { maximum: spec.maximumOrderQuantity } }],
    );
  }

  const quantity = units * perUnit;

  if (quantity > MAX_PIECES) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That is more than we can take in one order.', [
      { field: input.field, code: 'TOO_MANY' },
    ]);
  }

  return {
    quantity,
    orderingUnit: spec.unit,
    unitQuantity: units,
    piecesPerUnitSnapshot: perUnit,
  };
}

/** Does this many sell units satisfy the offer's minimum and step? */
export function isValidUnitQuantity(spec: SellUnitSpec, units: number): boolean {
  if (!Number.isInteger(units) || units <= 0) return false;
  if (units < Math.max(1, spec.minimumOrderQuantity)) return false;
  if (units % Math.max(1, spec.orderIncrement) !== 0) return false;
  if (spec.maximumOrderQuantity !== null && units > spec.maximumOrderQuantity) return false;
  return true;
}

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
  return unitsForPieces(pieces, piecesPerCarton);
}

/**
 * The same rounding, without the word "carton" in it.
 *
 * `cartonsForPieces` is what the operator's paths call it and reads correctly
 * there; on a seller's line the factor is 1 and the name would be a lie. One
 * implementation, because two would eventually round differently.
 */
export function unitsForPieces(pieces: number, piecesPerUnit: number): number {
  return Math.max(1, Math.ceil(pieces / Math.max(1, piecesPerUnit)));
}

/**
 * Turn "2 cartons" into "1,000 pieces".
 *
 * A caller that names no unit is taken to be speaking in pieces and is rounded
 * up to whole cartons, so there is no route - storefront, API or worker -
 * through which a part-carton line can reach a basket.
 */
export function resolveOrderingQuantity(input: {
  /** Only `OUTER_CARTON` is sellable here; anything else is read as pieces. */
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
  return resolveSellUnitQuantity({
    spec: operatorSellUnit(input.piecesPerCarton),
    unit: input.unit,
    unitQuantity: input.unitQuantity,
    pieces: input.pieces,
    field: input.field,
  });
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
