/**
 * What an order item says was bought, frozen when the order was created.
 *
 * WHY
 *
 * A seller edits a listing next month, a specification changes, a product is
 * unpublished or archived. An order placed today must still say exactly what
 * the customer bought - on the seller's order page, on the invoice and on the
 * packing list - so it is written once into `order_items.productInfoSnapshotJson`
 * in the transaction that creates the item, and never rewritten. Anything that
 * reads what was ordered reads this, not the live listing.
 *
 * WHAT IS IN IT
 *
 * The product's own words and facts, and the buyer's choices. Not prices (the
 * order item already holds what was charged, and a seller's view must not see
 * the buyer's pricing), not stock, not internal notes, not moderation.
 *
 * VERSIONS
 *
 * `schemaVersion` says which shape a row holds. A reader that meets a version
 * it does not know returns null and the page says the snapshot is unavailable,
 * rather than rendering half a shape.
 */
import { z } from 'zod';
import { SPEC_GROUPS } from './product-specifications.js';

export const ORDER_ITEM_SNAPSHOT_VERSION = 1;

const specRow = z.object({
  label: z.string(),
  value: z.string(),
  unit: z.string().nullable(),
  highlight: z.boolean(),
});

const container = z
  .object({
    pieces: z.number().int().nonnegative(),
    cartons: z.number().int().nonnegative().nullable(),
    piecesPerCarton: z.number().int().nonnegative().nullable(),
  })
  .nullable();

export const orderItemSnapshotSchema = z.object({
  schemaVersion: z.literal(ORDER_ITEM_SNAPSHOT_VERSION),
  capturedAt: z.string(),
  productId: z.string(),
  productName: z.string(),
  sku: z.string(),
  variantId: z.string().nullable(),
  variantName: z.string().nullable(),
  /** The options the buyer chose - "Size: M", "Colour: Black". */
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
  description: z.object({
    /** Plain text, where the product had one. */
    text: z.string().nullable(),
    /** The HTML description, already sanitised when it was saved. */
    html: z.string().nullable(),
    sections: z.array(z.object({ heading: z.string(), body: z.string() })),
  }),
  specificationGroups: z.array(z.object({ group: z.enum(SPEC_GROUPS), rows: z.array(specRow) })),
  packaging: z.object({
    orderingUnit: z.string(),
    unitQuantity: z.number().int(),
    piecesPerUnit: z.number().int(),
    /** Pieces this line comes to: `unitQuantity × piecesPerUnit`. */
    equivalentPieces: z.number().int(),
    packageType: z.string().nullable(),
    unitsPerCarton: z.number().int().nullable(),
    cartonsPerPallet: z.number().int().nullable(),
    cartonsPerContainer: z.number().int().nullable(),
    dimensionsMm: z
      .object({ length: z.number().int().nullable(), width: z.number().int().nullable(), height: z.number().int().nullable() })
      .nullable(),
    grossWeightGrams: z.string().nullable(),
  }),
  /** The minimum order, in pieces, that applied. */
  moqPieces: z.number().int().nullable(),
  piecesPerCarton: z.number().int().nullable(),
  containerCapacity: z.object({ CONTAINER_20_FT: container, CONTAINER_40_FT: container }),
  specialInstructions: z.string().nullable(),
});

export type OrderItemSnapshot = z.infer<typeof orderItemSnapshotSchema>;

/** A stored snapshot, or null when there is none or it is a shape this code does not know. */
export function readOrderItemSnapshot(value: unknown): OrderItemSnapshot | null {
  if (value === null || value === undefined) return null;
  const parsed = orderItemSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
