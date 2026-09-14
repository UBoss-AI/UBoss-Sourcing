/**
 * Packaging, on its way to a storefront screen.
 *
 * **No piece counts leave here.** The shop sells one thing - a carton, holding
 * the number of pieces `PIECES_PER_CARTON` names - and the supplier's own
 * "100 per box, 20 boxes to a carton" would contradict it on the same page.
 * Two carton sizes on one screen is a buyer working out which of them their
 * order was priced at, and one of the two answers is always wrong.
 *
 * What is left is what the supplier's sheet says about the product rather than
 * about the quantity: what it is packed as, and how big the boxes are. Those
 * do not compete with the selling unit, and a buyer sizing a shelf or a pallet
 * needs them.
 *
 * The admin console still sees the sheet's own figures in full - see
 * `catalog.admin.ts`. Somebody reviewing an import has to be able to read what
 * the supplier actually wrote.
 *
 * The sticker artwork dimension is filtered out of the public shape here, not
 * at each call site. It is a print specification for the operator's label
 * supplier, and a buyer reading it in a list of box sizes would measure a shelf
 * against a label.
 */
import type { PackDimensionKind } from '../../generated/prisma/enums.js';
import { prisma } from '../../infra/prisma.js';
import { dimensionLabel } from './sheet-import/dimension-parser.js';

/**
 * The dimensions a buyer is shown, in the order a buyer reads them.
 *
 * Not `as const`: Prisma's `in` filter wants a mutable array, and a readonly
 * one fails to typecheck at every call site rather than here.
 */
const PUBLIC_DIMENSION_ORDER: PackDimensionKind[] = ['PRIMARY_PACK', 'INNER_BOX', 'OUTER_CARTON'];

const DIMENSION_LABELS: Record<string, string> = {
  PRIMARY_PACK: 'Primary pack',
  INNER_BOX: 'Inner box',
  OUTER_CARTON: 'Outer carton',
  STICKER_ARTWORK: 'Sticker artwork',
};

export interface PackagingRow {
  variantKey: string;
  packingType: string | null;
  dimensions: {
    kind: string;
    rawText: string;
    displayValue: string | null;
    unit: string | null;
    parseStatus: string;
  }[];
}

/**
 * Columns a public read may select off `product_packaging`. An allowlist.
 *
 * The piece counts are deliberately absent. They are the supplier's own
 * packing arithmetic, they no longer decide what anything costs or how much
 * arrives, and a storefront that received them would eventually print one of
 * them beside a carton of 500.
 */
export const PUBLIC_PACKAGING_SELECT = {
  variantKey: true,
  packingType: true,
  dimensions: {
    where: { kind: { in: PUBLIC_DIMENSION_ORDER } },
    select: { kind: true, rawText: true, displayValue: true, unit: true, parseStatus: true },
  },
} as const;

export interface SerialisedPackaging {
  /** What the supplier packs it as - "Blister", "Pouch". Never a quantity. */
  packingType: string | null;
  dimensions: {
    kind: string;
    label: string;
    /** "460 × 350 × 210 mm", or the raw text when nothing could be read. */
    value: string;
    hasUnit: boolean;
  }[];
}

export function serialisePackaging(row: PackagingRow | null | undefined): SerialisedPackaging | null {
  if (row === undefined || row === null) return null;

  const byKind = new Map(row.dimensions.map((dimension) => [dimension.kind, dimension]));

  return {
    packingType: row.packingType,
    dimensions: PUBLIC_DIMENSION_ORDER.flatMap((kind) => {
      const dimension = byKind.get(kind);
      if (dimension === undefined) return [];
      return [
        {
          kind,
          label: DIMENSION_LABELS[kind] ?? kind,
          value: dimensionLabel(dimension),
          hasUnit: dimension.unit !== null,
        },
      ];
    }),
  };
}

/**
 * Every variant's packing for one product, keyed by variant id.
 *
 * A separate read rather than part of the shared product select, because a
 * grid of two dozen products does not need thirty packing rows each. The
 * detail page asks for them; the listing shows the product-level row that the
 * import writes alongside them.
 */
export async function variantPackagingFor(productId: string): Promise<Map<string, SerialisedPackaging>> {
  const rows = await prisma.productPackaging.findMany({
    where: { productId, NOT: { variantId: null } },
    select: { variantId: true, ...PUBLIC_PACKAGING_SELECT },
  });

  const byVariant = new Map<string, SerialisedPackaging>();
  for (const row of rows) {
    if (row.variantId === null) continue;
    const serialised = serialisePackaging(row);
    if (serialised !== null) byVariant.set(row.variantId, serialised);
  }
  return byVariant;
}
