/**
 * The special instruction a buyer can attach to one basket line.
 *
 * One file for one number, because that number has to be the same in four
 * places and being wrong in any of them is a different kind of bad:
 *
 *   - `cart_items.note` / `order_items.noteSnapshot` are `VARCHAR(500)`. Past
 *     that, MariaDB would truncate.
 *   - The API's Zod schema refuses anything longer, with a message naming the
 *     field.
 *   - The product page's box and the basket's box stop there, so the limit is
 *     something a buyer meets while typing rather than discovers as a rejected
 *     save after writing four hundred words.
 *
 * There is no build step shared between `backend` and the three front ends, so
 * this is a copy of `MAX_LINE_NOTE_CHARS` in `backend/src/modules/cart/
 * cart.service.ts` rather than an import of it. A copy that drifts is a real
 * risk and the honest mitigation is that the server is authoritative: a box
 * that let 600 characters through is refused with a message, not silently cut
 * down. The failure mode of drift is an unnecessary rejection, never a
 * truncated instruction reaching a picking list.
 */
export const MAX_LINE_NOTE_CHARS = 500;

/**
 * An instruction as it should be SENT, or null.
 *
 * Null and not `''` for an empty box, and the distinction is load bearing
 * rather than tidiness: the server reads a value as "set this" and an absent
 * one as "leave it alone", so an empty string sent from a page with no
 * instruction on it would wipe one the buyer typed a minute earlier from
 * somewhere else.
 */
export function noteForWire(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
