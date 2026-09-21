/**
 * Instructions a shopper leaves on a product, without buying it.
 *
 * The basket already has a box for this per line — see `line-note.ts`, which
 * this file deliberately mirrors. That one only exists once the product is in
 * a basket and only reaches a seller if the basket becomes an order, which is
 * too late for the questions that decide whether there will be an order at
 * all: "do you do this in 8mm?", "can you supply a calibration certificate?",
 * "we need four hundred a month, would you hold stock?".
 *
 * One standing instruction per shopper per product. Saving again replaces what
 * was there rather than adding to it, and clearing the box takes it back — the
 * same behaviour as the basket's note, which is where the shape comes from.
 */
import { api } from './api';

/**
 * The ceiling, copied rather than imported.
 *
 * The same number as the column, the same number as the API's Zod schema, and
 * the same number this box counts down from — for the reasons `line-note.ts`
 * sets out at length for its own copy of 500. There is no build step shared
 * between `backend` and the three front ends. The server stays authoritative,
 * so the failure mode of drift is an unnecessary rejection with a message, not
 * a truncated instruction reaching a seller.
 */
export const MAX_INSTRUCTION_CHARS = 500;

/**
 * The cache key for one shopper's instruction on one product.
 *
 * Here rather than beside the button that uses it, for the reason
 * `auth/session-context.ts` gives: React Fast Refresh cannot preserve state
 * across an edit to a file that exports both components and plain values, so
 * a component file that also exports a helper remounts the tree on every save.
 *
 * It is shared because the product page and a card can both be mounted against
 * the same product — a "related products" rail under the page it is on — and a
 * save from one has to be seen by the other. Two keys for one row is how the
 * card goes on saying "Add" after the dialog on the page has saved.
 */
export function instructionQueryKey(
  productId: string,
  variantId: string | null,
): readonly unknown[] {
  return ['product-instruction', productId, variantId ?? ''];
}

export interface ProductInstruction {
  id: string;
  productId: string;
  /** The version it is about, or null for the product in general. */
  variantId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What this shopper has already said about this product, or null.
 *
 * Null is the ordinary answer and not an error — most shoppers have said
 * nothing about most products. The dialog opens with this in the box, because
 * a form that came up empty over something they wrote last week would have
 * them write it again, and the second one would replace the first.
 */
export async function fetchOwnInstruction(
  productId: string,
  variantId?: string | null,
): Promise<ProductInstruction | null> {
  const query = new URLSearchParams({ productId });
  if (variantId !== null && variantId !== undefined && variantId !== '') {
    query.set('variantId', variantId);
  }

  const response = await api.get<{ instruction: ProductInstruction | null }>(
    `/account/product-instructions?${query.toString()}`,
  );

  return response.instruction;
}

/**
 * Leave one, or replace the one already there.
 *
 * An empty body is sent as an empty string rather than withheld, and that is
 * the opposite of `noteForWire`'s rule next door — on purpose. There, an
 * absent value means "leave the existing one alone", because the basket page
 * and the product page can both write the same line. Here there is exactly one
 * writer and clearing the box is an instruction in itself: take back what I
 * said. The server answers `null`, which is the row being gone.
 */
export async function saveOwnInstruction(input: {
  productId: string;
  variantId?: string | null;
  body: string;
}): Promise<ProductInstruction | null> {
  const response = await api.post<{ instruction: ProductInstruction | null }>(
    '/account/product-instructions',
    {
      productId: input.productId,
      variantId: input.variantId ?? null,
      body: input.body,
    },
  );

  return response.instruction;
}

/** Take it back, by id. */
export async function deleteOwnInstruction(instructionId: string): Promise<void> {
  await api.delete(`/account/product-instructions/${instructionId}`);
}
