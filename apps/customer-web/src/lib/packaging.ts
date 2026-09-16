/**
 * What a price on a screen is a price FOR, as words and as arithmetic.
 *
 * The catalogue prices a PIECE. It always has, and nothing here changes that.
 * What varies is what a shopper is allowed to buy, and therefore what figure
 * should appear on the card:
 *
 *   - **The operator sells cartons.** A buyer chooses a number of cartons, and
 *     one carton holds `piecesPerCarton` pieces, which the server publishes in
 *     `/config` because it is the operator's setting and not a figure baked
 *     into this bundle. The card shows the piece price times that factor.
 *
 *   - **A third-party seller sells pieces.** Their offer's price IS the price
 *     of one piece, and the card shows it unmultiplied. Applying the
 *     operator's carton to it put a seller's ten-rupee item on the screen at
 *     five thousand, which is the bug this file was rewritten for.
 *
 * Which of the two applies is never guessed here. The server sends it, per
 * product, as `sellUnit` — decided from product ownership, on the same code path
 * that will price the basket. A storefront that worked it out for itself would
 * eventually work it out differently from the cart, and the shopper would be
 * quoted one figure and charged another.
 *
 * Two jobs, kept together because they must not disagree: the sentence a screen
 * shows ("One carton has 500 pieces", "Sold by the piece") and the
 * multiplication that produces the figure beside it. A page that says one thing
 * and prices another is the specific failure this file exists to prevent.
 *
 * Nothing here invents a figure, and nothing here is a second pricing engine.
 * It multiplies ONE catalogue price by ONE factor, both of which came off the
 * server, and it never sums, discounts or taxes anything — the basket is the
 * only place a total is worked out.
 */
import { useStorefront } from '@/app/storefront-context';
import { multiplyMinor } from './format';

/**
 * The unit column as the API spells it.
 *
 * `OUTER_CARTON` is the operator's own line and `PIECE` is a seller's.
 * `INNER_PACK` is only ever found on basket, plan and order rows placed before
 * the shop settled on either, and a screen showing one of those has to keep
 * describing it honestly.
 */
export type OrderingUnit = 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON';

/** The unit the OPERATOR sells in. Mirrors `SELLING_UNIT` on the server. */
export const SELLING_UNIT = 'OUTER_CARTON' as const;

/** The unit a third-party SELLER sells in. */
export const SELLER_SELLING_UNIT = 'PIECE' as const;

/**
 * What one product's price is per, as the server decided it.
 *
 * Every field comes off `/catalog`. Nothing in it is computed in the browser,
 * which is the point — see the header.
 */
export interface SellUnit {
  unit: OrderingUnit;
  /** Pieces in one sell unit. The carton size, or 1 for a seller's piece. */
  piecesPerUnit: number;
  minimumOrderQuantity: number;
  orderIncrement: number;
  maximumOrderQuantity: number | null;
  /** True when the catalogue price is already the price of one sell unit. */
  isPricedPerSellUnit: boolean;
}

/** A product as much of it as the display basis needs. */
export interface HasSellUnit {
  sellUnit?: Partial<SellUnit> | null;
}

/**
 * This product's sell unit, or the operator's carton where the server did not
 * say.
 *
 * The fallback is the carton rather than the piece, and that direction is
 * deliberate: a response cached from before the field existed can only be an
 * operator product, because a marketplace product's card did not render a
 * seller's own basis before this work either. Falling back to the piece would
 * take every operator card down by a factor of five hundred the first time an
 * old response was replayed.
 */
export function sellUnitOf(product: HasSellUnit, piecesPerCarton: number): SellUnit {
  const sent = product.sellUnit ?? null;

  if (sent === null || typeof sent.piecesPerUnit !== 'number' || sent.piecesPerUnit < 1) {
    return {
      unit: SELLING_UNIT,
      piecesPerUnit: piecesPerCarton,
      minimumOrderQuantity: 1,
      orderIncrement: 1,
      maximumOrderQuantity: null,
      isPricedPerSellUnit: piecesPerCarton === 1,
    };
  }

  return {
    unit: sent.unit ?? SELLING_UNIT,
    piecesPerUnit: sent.piecesPerUnit,
    minimumOrderQuantity: sent.minimumOrderQuantity ?? 1,
    orderIncrement: sent.orderIncrement ?? 1,
    maximumOrderQuantity: sent.maximumOrderQuantity ?? null,
    isPricedPerSellUnit: sent.isPricedPerSellUnit ?? sent.piecesPerUnit === 1,
  };
}

/** Is this product a third-party seller's, and therefore sold by the piece? */
export function isSoldByThePiece(sellUnit: SellUnit): boolean {
  return sellUnit.unit === SELLER_SELLING_UNIT;
}

/**
 * The figure to print, from the catalogue's per-piece figure.
 *
 * One function rather than a multiplication at each price on each page, which
 * is what stops the product card and the product page quoting two different
 * numbers for one product. On a seller's line the factor is 1 and this returns
 * what it was given — which is exactly the behaviour that was missing.
 */
export function sellUnitPriceMinor(pieceMinor: string, sellUnit: SellUnit): string {
  return sellUnit.piecesPerUnit === 1
    ? pieceMinor
    : multiplyMinor(pieceMinor, sellUnit.piecesPerUnit);
}

/**
 * Pieces in a carton when `/config` has not answered yet, or answered without
 * the field — a response cached from before it existed.
 *
 * The same 500 the server defaults to. Every caller goes through
 * `usePiecesPerCarton`, so this is the one place the fallback is written down.
 */
export const DEFAULT_PIECES_PER_CARTON = 500;

/** This deployment's carton size. */
export function usePiecesPerCarton(): number {
  const { ordering } = useStorefront();
  const configured = ordering?.piecesPerCarton;
  return typeof configured === 'number' && configured > 0
    ? configured
    : DEFAULT_PIECES_PER_CARTON;
}

/**
 * What one carton costs, from what one piece costs.
 *
 * The catalogue prices a piece; every figure a shopper sees is the price of a
 * carton, because that is the only thing they can buy. Doing the arithmetic in
 * one function rather than at each price on each page is what stops the product
 * card and the product page quoting two different numbers for one product.
 */
export function cartonPriceMinor(pieceMinor: string, piecesPerCarton: number): string {
  return multiplyMinor(pieceMinor, piecesPerCarton);
}

/**
 * The pieces a carton count comes to.
 *
 * Against a line's own snapshot wherever there is one - a basket agreed at 500
 * to a carton keeps reading "2 cartons (1,000 pieces)" even after the operator
 * re-specifies the carton, because that is what was agreed.
 */
export function piecesFor(cartons: number, piecesPerCarton: number): number {
  return cartons * piecesPerCarton;
}

/**
 * A basket, plan or order line described in the unit it was agreed in.
 *
 * Null for a line placed before this shop settled on the carton — those keep
 * being shown in pieces, because that is what was agreed and an old receipt
 * that reworded itself is a receipt that no longer matches what was signed.
 *
 * The carton size is the line's OWN snapshot, never today's setting, for the
 * same reason.
 */
export function cartonsOfLine(
  ordering: { unit: OrderingUnit; unitQuantity: number; piecesPerUnit: number } | null | undefined,
): { cartons: number; piecesPerCarton: number } | null {
  if (ordering === null || ordering === undefined) return null;
  if (ordering.unit !== SELLING_UNIT) return null;
  return { cartons: ordering.unitQuantity, piecesPerCarton: Math.max(ordering.piecesPerUnit, 1) };
}

/**
 * Is this basket, plan or order line one a seller sold by the piece?
 *
 * Read off the LINE's own snapshot, not off the product it points at. A line
 * agreed in cartons keeps being shown in cartons even if the product is later
 * sold by somebody else on a different basis — an old receipt that reworded
 * itself is a receipt that no longer matches what was signed.
 */
export function lineIsSoldByThePiece(
  ordering: { unit: OrderingUnit; piecesPerUnit: number } | null | undefined,
): boolean {
  if (ordering === null || ordering === undefined) return false;
  return ordering.unit === SELLER_SELLING_UNIT && ordering.piecesPerUnit === 1;
}

/**
 * Whether there is anything left worth a Packaging section.
 *
 * Only what the supplier said about the product itself now: what it is packed
 * as, and how big the boxes are. The piece counts never reach the browser -
 * see `packaging.service.ts` - because the supplier's "2,000 to a carton" and
 * this shop's carton of 500 cannot both be true on one page.
 */
export function hasPackagingDetail(packaging: { packingType: string | null; dimensions: unknown[] } | null | undefined): boolean {
  if (packaging === null || packaging === undefined) return false;
  return packaging.packingType !== null || packaging.dimensions.length > 0;
}
