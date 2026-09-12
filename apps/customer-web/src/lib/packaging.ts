/**
 * Packing, as words and as arithmetic.
 *
 * Two jobs, kept together because they must not disagree: the sentence a
 * screen shows ("100 per box · 2,000 per carton") and the conversion the
 * quantity calculator runs. A card that says one thing and a calculator that
 * multiplies by another is the specific failure this file exists to prevent.
 *
 * Nothing here invents a figure. Every function returns null where the
 * catalogue is silent, and the caller renders nothing rather than a zero — a
 * "0 per carton" is a claim the catalogue never made.
 */
import type { Translate } from '@/i18n/i18n-context';
import type { ProductPackaging } from './types';
import { formatNumber } from './format';

export type OrderingUnit = 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON';

/**
 * How many pieces one of `unit` holds, or null.
 *
 * Mirrors `backend/src/domain/ordering-unit.ts` deliberately: the browser shows
 * the total as it is typed and the server recomputes it before anything is
 * bought, so the two have to agree on the arithmetic. They agree by doing the
 * same thing, not by trusting each other — the server never reads a conversion
 * the browser sends.
 */
export function piecesPerUnit(
  unit: OrderingUnit,
  packaging: ProductPackaging | null | undefined,
): number | null {
  if (unit === 'PIECE') return 1;
  if (packaging === null || packaging === undefined || !packaging.isReliable) return null;

  if (unit === 'INNER_PACK') return packaging.piecesPerInnerPack;

  if (packaging.piecesPerOuterCarton !== null) return packaging.piecesPerOuterCarton;
  if (packaging.piecesPerInnerPack !== null && packaging.innerPacksPerOuterCarton !== null) {
    return packaging.piecesPerInnerPack * packaging.innerPacksPerOuterCarton;
  }
  return null;
}

/** The units this product can be ordered in. Pieces is always one of them. */
export function availableUnits(packaging: ProductPackaging | null | undefined): OrderingUnit[] {
  return (['PIECE', 'INNER_PACK', 'OUTER_CARTON'] as const).filter(
    (unit) => piecesPerUnit(unit, packaging) !== null,
  );
}

/**
 * The one-line summary a card shows.
 *
 * Short on purpose. A card is scanned, not read, and the full breakdown is two
 * headings down the product page. Returns null when there is nothing to say,
 * so the card does not grow an empty row.
 */
export function packSummary(
  packaging: ProductPackaging | null | undefined,
  labels: { perPack: (count: string, pack: string) => string; perCarton: (count: string) => string },
): string | null {
  if (packaging === null || packaging === undefined) return null;

  const parts: string[] = [];
  const packLabel = (packaging.innerPackType ?? 'pack').toLowerCase();

  if (packaging.piecesPerInnerPack !== null) {
    parts.push(labels.perPack(formatNumber(packaging.piecesPerInnerPack), packLabel));
  }

  const perCarton = piecesPerUnit('OUTER_CARTON', packaging);
  if (perCarton !== null) parts.push(labels.perCarton(formatNumber(perCarton)));

  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * English plural for the handful of pack nouns a supplier sheet uses.
 *
 * Not a general pluraliser and not trying to be: the words are "box", "pouch",
 * "packet", "bag", "tray", "carton", all of which obey the sibilant rule. It is
 * done here rather than with an i18next plural key because the noun itself is
 * interpolated — it comes off the supplier's own text — and a plural form
 * chosen by the catalogue cannot inflect a word the catalogue has never seen.
 *
 * The mirror of `pluralise` in the backend's packing parser, for the same
 * reason the conversion is mirrored: both sides have to say the same sentence.
 */
export function pluralisePack(word: string, count: number): string {
  if (count === 1) return word;
  return /(?:s|x|z|ch|sh)$/i.test(word) ? `${word}es` : `${word}s`;
}

/**
 * What to call one of an ordering unit.
 *
 * The supplier's own word wherever the sheet gave one - "Box", "Pouch", "Pkt" -
 * so the screen matches the paperwork a warehouse is reading from. The
 * translated fallback is for a product whose packing was recorded without
 * naming the pack.
 */
export function unitLabel(
  unit: OrderingUnit,
  packaging: ProductPackaging | null | undefined,
  t: Translate,
): string {
  if (unit === 'PIECE') return t('packaging.pieces');
  if (unit === 'INNER_PACK') return packaging?.innerPackType ?? t('packaging.innerPack');
  return packaging?.outerPackType ?? t('packaging.outerCarton');
}

/** Whether there is enough here to be worth a Packaging section at all. */
export function hasPackagingDetail(packaging: ProductPackaging | null | undefined): boolean {
  if (packaging === null || packaging === undefined) return false;
  return (
    packaging.piecesPerInnerPack !== null ||
    packaging.piecesPerOuterCarton !== null ||
    packaging.packingType !== null ||
    packaging.dimensions.length > 0
  );
}
