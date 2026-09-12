/**
 * Packaging, on its way to a screen.
 *
 * One shape, built once, used by the storefront, the admin panel and anything
 * else that has to say how many are in a box. Two serialisers would be two
 * places to forget that the formula has to agree with the figures, and a page
 * that shows "100 × 20 = 2,000" beside a carton count of 1,800 is worse than
 * one that shows neither.
 *
 * The sticker artwork dimension is filtered out of the public shape here, not
 * at each call site. It is a print specification for the operator's label
 * supplier, and a buyer reading it in a list of box sizes would measure a shelf
 * against a label.
 */
import type { PackDimensionKind } from '../../generated/prisma/enums.js';
import { prisma } from '../../infra/prisma.js';
import { dimensionLabel } from './sheet-import/dimension-parser.js';
import { packingFormula } from './sheet-import/packing-parser.js';

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
  packingRawText: string | null;
  piecesPerInnerPack: number | null;
  innerPacksPerOuterCarton: number | null;
  piecesPerOuterCarton: number | null;
  innerPackType: string | null;
  outerPackType: string | null;
  parseStatus: string;
  validationMessage?: string | null;
  dimensions: {
    kind: string;
    rawText: string;
    displayValue: string | null;
    unit: string | null;
    parseStatus: string;
  }[];
}

/** Columns a public read may select off `product_packaging`. An allowlist. */
export const PUBLIC_PACKAGING_SELECT = {
  variantKey: true,
  packingType: true,
  packingRawText: true,
  piecesPerInnerPack: true,
  innerPacksPerOuterCarton: true,
  piecesPerOuterCarton: true,
  innerPackType: true,
  outerPackType: true,
  parseStatus: true,
  dimensions: {
    where: { kind: { in: PUBLIC_DIMENSION_ORDER } },
    select: { kind: true, rawText: true, displayValue: true, unit: true, parseStatus: true },
  },
} as const;

export interface SerialisedPackaging {
  packingType: string | null;
  /** The source text, so a buyer can see exactly what the supplier said. */
  sourceText: string | null;
  piecesPerInnerPack: number | null;
  innerPacksPerOuterCarton: number | null;
  piecesPerOuterCarton: number | null;
  innerPackType: string | null;
  outerPackType: string | null;
  /** "100 pieces × 20 boxes = 2,000 pieces", or null when unknown. */
  formula: string | null;
  /**
   * Whether the figures can be trusted for arithmetic.
   *
   * The quantity calculator offers a pack unit only where this is true. A
   * NEEDS_REVIEW row - one whose own multiplication disagrees - is shown as
   * text and not used to convert anything, because converting from a figure
   * nobody has confirmed is how a buyer orders twice what they meant to.
   */
  isReliable: boolean;
  parseStatus: string;
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
    sourceText: row.packingRawText,
    piecesPerInnerPack: row.piecesPerInnerPack,
    innerPacksPerOuterCarton: row.innerPacksPerOuterCarton,
    piecesPerOuterCarton: row.piecesPerOuterCarton,
    innerPackType: row.innerPackType,
    outerPackType: row.outerPackType,
    formula: packingFormula(row),
    isReliable: row.parseStatus === 'PARSED' || row.parseStatus === 'PARTIAL',
    parseStatus: row.parseStatus,
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
