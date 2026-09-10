/**
 * Lines somebody has kept without buying them.
 *
 * The narrowest useful feature, deliberately. What it is *not* is the reason
 * the model has no quantity column: a wishlist that carries a quantity is a
 * second basket with none of a basket's rules — no minimum order quantity, no
 * increment, no stock reservation, no priced total — and the moment one exists
 * somebody tries to check it out. Saving a line here says "remind me about
 * this", and buying it means putting it in the cart, where every one of those
 * rules applies.
 *
 * Three things it does have to get right.
 *
 * **Every read is scoped to the session's own profile.** Like everything else
 * under `/account`, there is no id in the path that names a customer. A
 * wishlist row belonging to somebody else resolves to "not found" rather than
 * being readable or removable.
 *
 * **A saved line is not a promise the product is still purchasable.** Weeks
 * pass. A product gets unpublished, archived, or priced out of the currency
 * the shopper is now browsing in. So the read reports what it finds — with
 * `isAvailable` false and no price where there is nothing to quote — instead
 * of hiding the row. A saved item that silently vanishes is indistinguishable
 * from a bug, and the customer is owed the chance to see that the thing they
 * were waiting for has gone.
 *
 * **Prices come from the same quoting path as the catalogue.** The destination
 * and the currency are applied by `location-price.service.ts`, exactly as the
 * grid and the product page do it. A wishlist that quoted the raw
 * `product_prices` row would show a figure with the wrong country's VAT in it,
 * which is the specific discrepancy that whole module exists to prevent.
 */
import { notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { publicProductWhere } from '../catalog/catalog.visibility.js';
import {
  loadShelfContext,
  quoteShelfPrice,
  type ShelfContext,
} from '../catalog/location-price.service.js';

/** The empty string for a base product, exactly as the cart stores it. */
function variantKeyFor(variantId: string | null | undefined): string {
  return variantId === null || variantId === undefined || variantId === '' ? '' : variantId;
}

export interface WishlistLine {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  sku: string;
  /** The saved variant, when it still resolves. Null for a base product. */
  variant: { id: string; name: string; sku: string } | null;
  /** The image the catalogue would show, or null. */
  imageUrl: string | null;
  /**
   * What it costs today, in the currency asked for and quoted for the
   * destination. Null where the product is not priced in that currency, which
   * is an ordinary answer rather than an error.
   */
  priceMinor: string | null;
  currency: string;
  /** Whether it could be added to a basket right now. */
  isAvailable: boolean;
  savedAt: string;
}

/**
 * One customer's saved lines, priced for where they are.
 *
 * Newest first, which is the order a "saved for later" list is read in: the
 * thing you saved a minute ago is the thing you came back for.
 */
export async function listWishlist(
  customerProfileId: string,
  options: { currency: string; country: string | null; language: string | null },
): Promise<{ items: WishlistLine[]; currency: string; country: string | null }> {
  const rows = await prisma.wishlistItem.findMany({
    where: { customerProfileId },
    orderBy: { createdAt: 'desc' },
    include: {
      product: {
        include: {
          taxClass: true,
          prices: { where: { currencyCode: options.currency } },
          // The primary image first, then by position — the same order the
          // catalogue uses, so a saved line shows the picture it was saved
          // from rather than whichever row came back first.
          media: {
            include: { media: { select: { url: true } } },
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
            take: 1,
          },
          translations: options.language === null ? false : { where: { language: options.language } },
        },
      },
    },
  });

  if (rows.length === 0) {
    return { items: [], currency: options.currency, country: options.country };
  }

  // One tax context for the whole list, not one per line: the destination is
  // the same for all of them and loading it is a database read.
  const shelf: ShelfContext = await loadShelfContext(options.country);

  // The variants the saved keys still point at. Resolved in one query rather
  // than per row, and deliberately without a foreign key — see the model.
  const variantIds = rows.map((row) => row.variantKey).filter((key) => key !== '');

  const variants =
    variantIds.length === 0
      ? []
      : await prisma.productVariant.findMany({
          where: { id: { in: variantIds } },
          select: { id: true, name: true, sku: true, isActive: true },
        });

  const variantById = new Map(variants.map((variant) => [variant.id, variant]));

  const items = rows.map((row): WishlistLine => {
    const { product } = row;
    const variant = row.variantKey === '' ? null : (variantById.get(row.variantKey) ?? null);

    // The price row for the variant that was saved, or the base product's.
    // `variantKey` is the same device on both tables, so this is a direct
    // match rather than a nullable comparison.
    const listed =
      product.prices.find((price) => price.variantKey === row.variantKey)?.basePriceMinor ?? null;

    // Under FLAT_RATE — any deployment that has not configured EU VAT — this
    // hands back the listed figure and the tax class's own rate, so a GST
    // catalogue sees no change at all. Same call the grid makes.
    const quoted =
      listed === null
        ? null
        : quoteShelfPrice(
            shelf.setup,
            {
              vatCategory: product.taxClass.vatCategory,
              flatRatePercent: product.taxClass.ratePercent.toString(),
              taxInclusive: product.taxClass.isInclusive,
              productName: product.name,
            },
            listed,
          );

    /*
     * Purchasable right now, which is a narrower question than "does this row
     * still resolve".
     *
     * A product has to be visible in the catalogue AND priced in the currency
     * being asked for; a saved variant has additionally to still be active. A
     * variant that has been deactivated leaves the row readable and the base
     * product named, because the customer chose that option and deserves to
     * see that it is the option that has gone rather than the product.
     */
    const isAvailable =
      product.isPublished &&
      product.archivedAt === null &&
      product.status === 'ACTIVE' &&
      listed !== null &&
      (variant === null || variant.isActive);

    return {
      id: row.id,
      productId: product.id,
      // The translated name where the catalogue has one, so a saved line reads
      // the same as the grid it was saved from.
      productName: product.translations?.[0]?.name ?? product.name,
      productSlug: product.slug,
      sku: product.sku,
      variant:
        variant === null ? null : { id: variant.id, name: variant.name, sku: variant.sku },
      imageUrl: product.media[0]?.media.url ?? null,
      priceMinor: quoted === null ? null : quoted.unitPriceMinor.toString(),
      currency: options.currency,
      isAvailable,
      savedAt: row.createdAt.toISOString(),
    };
  });

  return { items, currency: options.currency, country: options.country };
}

/**
 * Save a line.
 *
 * Idempotent: saving something already saved is the customer getting what they
 * wanted, not a 409. `upsert` on the composite unique rather than a read then
 * a write, so two taps on a slow connection cannot both insert.
 */
export async function addToWishlist(
  customerProfileId: string,
  input: { productId: string; variantId?: string | null },
): Promise<{ id: string }> {
  const variantKey = variantKeyFor(input.variantId);

  /*
   * The product has to be one this customer could actually have seen.
   *
   * `visibleProductWhere` is the same predicate the catalogue reads with, so
   * an unpublished or archived product cannot be saved by posting its id — and
   * a wishlist is otherwise a way to confirm that a given product id exists in
   * a catalogue you are not allowed to browse.
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

  const row = await prisma.wishlistItem.upsert({
    where: {
      customerProfileId_productId_variantKey: {
        customerProfileId,
        productId: product.id,
        variantKey,
      },
    },
    // Nothing to change. The row's only other column is when it was saved, and
    // re-saving something should not push it back to the top of the list — the
    // customer has not changed their mind about it, they have pressed a heart
    // that was already filled in.
    update: {},
    create: { id: newId(), customerProfileId, productId: product.id, variantKey },
    select: { id: true },
  });

  return row;
}

/**
 * Remove a saved line.
 *
 * Scoped by the profile in the `where`, so a row belonging to another customer
 * is not found rather than deleted. `deleteMany` rather than `delete` for
 * exactly that reason: `delete` on a composite of id-and-owner is not
 * expressible, and `delete` on the id alone would need an ownership check
 * before it that somebody will eventually forget to write.
 */
export async function removeFromWishlist(
  customerProfileId: string,
  itemId: string,
): Promise<void> {
  const removed = await prisma.wishlistItem.deleteMany({
    where: { id: itemId, customerProfileId },
  });

  if (removed.count === 0) throw notFound('Saved item');
}

/** How many lines are saved. For a badge, and cheap enough to ask for one. */
export async function countWishlist(customerProfileId: string): Promise<number> {
  return prisma.wishlistItem.count({ where: { customerProfileId } });
}
