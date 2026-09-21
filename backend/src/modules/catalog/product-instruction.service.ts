/**
 * What a shopper needs done to a product, said before there is an order.
 *
 * The basket already carries a note per line — `cart_items.note`, and the
 * whole reasoning for it is in `20260919210000_line_special_instructions`.
 * That column is right and it arrives late: it exists only once the product is
 * in a basket, and it reaches a seller only if that basket becomes an order.
 *
 * The things a trade buyer most wants to say are said before either of those.
 * "Do you do this in 8mm?" "Can you supply it with a calibration certificate?"
 * "We need four hundred a month — would you hold stock?" Each of those decides
 * whether there is an order at all. Until this module there was nowhere on the
 * product to put them, so they became an email nobody could tie back to a
 * product, or they became nothing.
 *
 * Four rules the whole file is arranged around.
 *
 * **One standing instruction per shopper per product.** Not a thread. Editing
 * replaces what they said, exactly as the basket's note behaves — which is
 * where this shape comes from, and which is also why there is no moderation
 * queue: a signed-in shopper can hold at most one row per product, so there is
 * nothing to flood.
 *
 * **It is never public.** A storefront printing these under the product would
 * be publishing one buyer's requirements to their competitors, and a buyer who
 * knew that would stop writing anything worth reading. The readers are the
 * shopper who wrote it and the sellers who could actually act on it.
 *
 * **A seller sees it only for a product they sell.** `sellerCanSeeProduct`
 * below is the gate, and it is scoped to unarchived offers belonging to the
 * seller in the session. Without it, a seller could read every buyer
 * requirement in the catalogue by posting product ids.
 *
 * **It is plain text, end to end.** Nothing stores HTML, nothing renders this
 * with `dangerouslySetInnerHTML`, and the column is `VARCHAR(500)` so MariaDB
 * 10.4 — which is not strict and would truncate — never gets the chance. The
 * API enforces the same 500 so going over is a message, not a silent loss.
 */
import { notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { publicProductWhere } from './catalog.visibility.js';

/**
 * The ceiling, stated once.
 *
 * The same number `cart_items.note` carries, and the same reasoning: a few
 * sentences about one product, read by a seller working down a list of them.
 * The route's Zod schema and the column agree with this constant; all three
 * being the same number is what makes going over a 400 rather than a truncated
 * sentence nobody notices.
 */
export const INSTRUCTION_MAX_LENGTH = 500;

/** The empty string for "this product in general", exactly as the cart stores it. */
function variantKeyFor(variantId: string | null | undefined): string {
  return variantId === null || variantId === undefined || variantId === '' ? '' : variantId;
}

/**
 * The instruction as it SHOULD BE STORED, or null.
 *
 * A box the shopper emptied is `null`, never `''`. Two ways of saying "there
 * is no instruction" is how a seller ends up with a list of blank rows, and
 * how `uq_product_instruction` ends up holding a row that means nothing.
 */
function normalise(body: string): string | null {
  const trimmed = body.trim();
  return trimmed === '' ? null : trimmed.slice(0, INSTRUCTION_MAX_LENGTH);
}

/** One shopper's instruction, as the storefront reads it back. */
export interface OwnInstruction {
  id: string;
  productId: string;
  /** The variant it is about, or null for the product in general. */
  variantId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** One instruction, as a seller reads it. */
export interface SellerInstruction extends OwnInstruction {
  productName: string;
  productSku: string;
  /**
   * The version it is about, resolved if it still resolves.
   *
   * Null covers two different things — "about the product in general" and "the
   * version it named has since been deleted" — and the seller cannot tell them
   * apart. That is acceptable: in both cases the instruction is about this
   * product and there is no version to point at.
   */
  variantName: string | null;
  /**
   * Who said it. A name and nothing else.
   *
   * The seller needs to know whether three sentences came from three buyers or
   * from one, and whether the buyer asking for four hundred a month is one
   * they already supply. They do not need an email address to answer that, and
   * this endpoint is not a way to harvest one — a seller who wants to reply
   * does it through the order path, where there is a relationship.
   */
  customerName: string;
  customerOrganization: string | null;
}

/**
 * What this shopper has already said about this product.
 *
 * Returned so the product page can open its box with their own words in it. A
 * form that came up empty over an instruction they wrote last week would have
 * them write it again, and the second one would replace the first.
 *
 * Null is the ordinary answer and not an error: most shoppers have said
 * nothing about most products.
 */
export async function readOwnInstruction(
  customerProfileId: string,
  productId: string,
  variantId?: string | null,
): Promise<OwnInstruction | null> {
  const row = await prisma.productInstruction.findUnique({
    where: {
      customerProfileId_productId_variantKey: {
        customerProfileId,
        productId,
        variantKey: variantKeyFor(variantId),
      },
    },
  });

  return row === null ? null : shape(row);
}

/**
 * Leave an instruction, or replace the one already there.
 *
 * `upsert` on the composite unique rather than a read then a write: two taps
 * on a slow connection would otherwise both insert, and the second would fail
 * on the index instead of doing what the shopper asked.
 *
 * An empty body DELETES. A shopper who clears the box has withdrawn what they
 * said, and leaving a blank row behind would put an empty line in the seller's
 * list that means "somebody changed their mind" and reads as a bug.
 */
export async function saveOwnInstruction(
  customerProfileId: string,
  input: { productId: string; variantId?: string | null; body: string },
): Promise<OwnInstruction | null> {
  const variantKey = variantKeyFor(input.variantId);

  /*
   * The product has to be one this shopper could actually have seen.
   *
   * The same predicate the catalogue reads with, for the same reason the
   * wishlist uses it: without this, posting product ids at this endpoint is a
   * way to confirm which ones exist in a catalogue you are not allowed to
   * browse.
   */
  const product = await prisma.product.findFirst({
    where: { id: input.productId, ...publicProductWhere() },
    select: { id: true },
  });

  if (product === null) throw notFound('Product');

  if (variantKey !== '') {
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantKey, productId: product.id },
      select: { id: true },
    });

    if (variant === null) throw notFound('Variant');
  }

  const body = normalise(input.body);

  if (body === null) {
    await prisma.productInstruction.deleteMany({
      where: { customerProfileId, productId: product.id, variantKey },
    });

    return null;
  }

  const row = await prisma.productInstruction.upsert({
    where: {
      customerProfileId_productId_variantKey: {
        customerProfileId,
        productId: product.id,
        variantKey,
      },
    },
    update: { body },
    create: { id: newId(), customerProfileId, productId: product.id, variantKey, body },
  });

  return shape(row);
}

/**
 * Take it back.
 *
 * Scoped by the profile in the `where` so another shopper's row is "not found"
 * rather than deletable — `deleteMany` rather than `delete` for exactly the
 * reason the wishlist gives: `delete` on a composite of id-and-owner is not
 * expressible, and `delete` on the id alone needs an ownership check in front
 * of it that somebody will eventually forget to write.
 */
export async function deleteOwnInstruction(
  customerProfileId: string,
  instructionId: string,
): Promise<void> {
  const removed = await prisma.productInstruction.deleteMany({
    where: { id: instructionId, customerProfileId },
  });

  if (removed.count === 0) throw notFound('Instruction');
}

/**
 * Whether this seller has any business reading instructions on this product.
 *
 * An unarchived offer, of any status. Deliberately not "an ACTIVE offer": a
 * seller whose listing is paused is exactly the seller who needs to read why
 * nobody is buying it, and a seller fixing a listing the marketplace asked
 * them to change should see what buyers have been asking for while it was
 * down.
 */
async function sellerCanSeeProduct(sellerAccountId: string, productId: string): Promise<boolean> {
  const offer = await prisma.sellerOffer.findFirst({
    where: { sellerAccountId, productId, archivedAt: null },
    select: { id: true },
  });

  return offer !== null;
}

/**
 * Every instruction left on one product, for the seller who sells it.
 *
 * Newest first, which is the order this is read in: what somebody asked this
 * morning is what a seller came to find out.
 *
 * Scoped to the PRODUCT and not to the seller's offer, and that is the correct
 * line even though three distributors can sell the same shirt. A buyer asking
 * "do you do this in 8mm?" is asking the marketplace, not a company they have
 * never heard of — routing it to one seller because their offer happened to be
 * the one on screen would send most of these questions to somebody who cannot
 * answer them, and hide them from the one who can.
 */
export async function listInstructionsForSeller(
  sellerAccountId: string,
  productId: string,
  limit = 50,
): Promise<SellerInstruction[]> {
  if (!(await sellerCanSeeProduct(sellerAccountId, productId))) return [];

  const rows = await prisma.productInstruction.findMany({
    where: { productId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      product: { select: { name: true, sku: true } },
      customerProfile: { select: { fullName: true, organization: true } },
    },
  });

  return decorate(rows);
}

/**
 * The same list, reached by the listing the seller is looking at.
 *
 * The seller hub navigates by offer id — that is what is in the URL of a
 * listing — and the instructions are keyed on the product. Resolving the one
 * to the other here rather than in the route keeps the ownership check and
 * the read in one place: a listing belonging to somebody else is "not found"
 * before any instruction is loaded, rather than after.
 */
export async function listInstructionsForOffer(
  sellerAccountId: string,
  offerId: string,
  limit = 50,
): Promise<SellerInstruction[]> {
  const offer = await prisma.sellerOffer.findFirst({
    where: { id: offerId, sellerAccountId },
    select: { productId: true },
  });

  if (offer === null) throw notFound('Listing');

  return listInstructionsForSeller(sellerAccountId, offer.productId, limit);
}

/**
 * How many instructions are waiting on each of these products.
 *
 * One query for a whole listings table rather than one per row. Returns a map
 * keyed by product id, with absent meaning zero — a caller reading
 * `counts.get(id) ?? 0` gets the right answer without this function having to
 * materialise a zero for every product a seller has never been asked about.
 */
export async function countInstructionsByProduct(
  productIds: readonly string[],
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();

  const rows = await prisma.productInstruction.groupBy({
    by: ['productId'],
    where: { productId: { in: [...productIds] } },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [row.productId, row._count._all]));
}

/**
 * Everything buyers have said about anything this seller sells.
 *
 * The seller hub's own page. Bounded by `take` rather than paged, because the
 * question it answers — "what are people asking me about?" — is answered by
 * the recent ones, and a seller who needs the hundredth is looking for a
 * specific product and should open that listing.
 */
export async function listInstructionsForSellerAccount(
  sellerAccountId: string,
  limit = 100,
): Promise<SellerInstruction[]> {
  /*
   * The products this seller sells, resolved first.
   *
   * `distinct` rather than a join through the offer, because a seller listing
   * a shirt in six sizes has six offers on one product and would otherwise see
   * every instruction on it six times.
   */
  const offers = await prisma.sellerOffer.findMany({
    where: { sellerAccountId, archivedAt: null },
    select: { productId: true },
    distinct: ['productId'],
  });

  if (offers.length === 0) return [];

  const rows = await prisma.productInstruction.findMany({
    where: { productId: { in: offers.map((offer) => offer.productId) } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      product: { select: { name: true, sku: true } },
      customerProfile: { select: { fullName: true, organization: true } },
    },
  });

  return decorate(rows);
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

interface StoredInstruction {
  id: string;
  productId: string;
  variantKey: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

function shape(row: StoredInstruction): OwnInstruction {
  return {
    id: row.id,
    productId: row.productId,
    // The empty string means the base product. Sent as null so a client reads
    // an absence rather than a sentinel — the same conversion the wishlist
    // does on the way out.
    variantId: row.variantKey === '' ? null : row.variantKey,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolve the version names, then shape.
 *
 * One query for all of them rather than one per row, and deliberately without
 * a foreign key — see the model. A key that no longer resolves becomes null,
 * which is the same thing the reader shows for "about the product in general".
 */
async function decorate(
  rows: readonly (StoredInstruction & {
    product: { name: string; sku: string };
    customerProfile: { fullName: string; organization: string | null };
  })[],
): Promise<SellerInstruction[]> {
  const variantIds = rows.map((row) => row.variantKey).filter((key) => key !== '');

  const variants =
    variantIds.length === 0
      ? []
      : await prisma.productVariant.findMany({
          where: { id: { in: variantIds } },
          select: { id: true, name: true },
        });

  const nameById = new Map(variants.map((variant) => [variant.id, variant.name]));

  return rows.map((row) => ({
    ...shape(row),
    productName: row.product.name,
    productSku: row.product.sku,
    variantName: row.variantKey === '' ? null : (nameById.get(row.variantKey) ?? null),
    customerName: row.customerProfile.fullName,
    customerOrganization: row.customerProfile.organization,
  }));
}
