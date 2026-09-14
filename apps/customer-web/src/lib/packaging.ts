/**
 * The carton, as words and as arithmetic.
 *
 * This shop sells one thing: a carton. Not pieces, not inner boxes — a buyer
 * chooses a number of cartons, and one carton holds `piecesPerCarton` pieces,
 * which the server publishes in `/config` because it is the operator's setting
 * and not a figure baked into this bundle.
 *
 * Two jobs, kept together because they must not disagree: the sentence a screen
 * shows ("One carton has 500 pieces") and the multiplication that turns the
 * catalogue's piece price into the carton price beside it. A page that says one
 * thing and prices another is the specific failure this file exists to prevent.
 *
 * Nothing here invents a figure, and nothing here is a second pricing engine.
 * It multiplies ONE catalogue price by ONE carton size, both of which came off
 * the server, and it never sums, discounts or taxes anything — the basket is
 * the only place a total is worked out.
 */
import { useStorefront } from '@/app/storefront-context';
import { multiplyMinor } from './format';

/**
 * The unit column as the API still spells it.
 *
 * Only `OUTER_CARTON` is ever written now. The other two are on basket, plan
 * and order rows placed before the shop settled on the carton, and a screen
 * showing one of those has to keep describing it honestly.
 */
export type OrderingUnit = 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON';

/** The one unit anything is sold in. Mirrors `SELLING_UNIT` on the server. */
export const SELLING_UNIT = 'OUTER_CARTON' as const;

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
