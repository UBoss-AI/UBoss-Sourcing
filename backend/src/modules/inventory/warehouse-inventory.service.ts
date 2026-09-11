/**
 * What one warehouse holds, product by product.
 *
 * The answer to "click a warehouse and show me its inventory". The Inventory
 * screen already answered a different question - one flat, paginated list of
 * *balance rows* across every warehouse, filterable by location - and the
 * difference between the two is the reason this module exists rather than
 * another query parameter on that one.
 *
 * **This list is driven from the catalogue, not from the balance rows.** Every
 * product this deployment sells appears for every warehouse, whether or not a
 * row exists for it there. That is not padding: a warehouse manager opening
 * this screen is usually looking for the product that is *missing*, and a list
 * built from balance rows cannot show an absence. It shows nothing where the
 * answer is zero, and nothing is indistinguishable from "not in the
 * catalogue". So the products are the spine and the balances are joined on,
 * which also means a product added to the catalogue this morning is in every
 * warehouse's list this afternoon with nothing to backfill and nothing to
 * remember.
 *
 * **A balance row that does not exist and one that says zero are the same
 * fact, and the response says which it is.** `hasBalanceRow` is carried
 * because the two are different *provenance*: no row means stock has never
 * been booked here, and a zero row means it has been and has run out. That is
 * the difference between "we have never stocked this in Antwerp" and "Antwerp
 * is out of it", which are two different conversations with a buyer.
 *
 * **Grouped by product, with one row per stock-keeping unit inside it.** A
 * product with variants has no balance of its own - stock is held per variant,
 * keyed by `variantKey` - so a flat list of SKUs would show a catalogue of
 * twenty products as two hundred rows with the same name repeated. The group
 * carries the product's own roll-up, which is what somebody scanning the list
 * reads; the SKUs inside it are what they act on.
 *
 * **Products that are not stock-tracked are listed and labelled, not hidden.**
 * A made-to-order item genuinely has no quantity anywhere, and leaving it out
 * of a screen headed "everything in this warehouse" would have somebody
 * hunting for a product that is deliberately absent. It appears with no
 * numbers and a flag saying why.
 *
 * Pagination is by product rather than by SKU, so a page boundary never falls
 * in the middle of one product's variants. `totals` is measured across the
 * whole warehouse and not across the page - a footer that says "1,204 units"
 * must mean the warehouse, or it is worse than no footer.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { serialiseMoney } from '../../domain/money.js';
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';

/** One stock-keeping unit at this warehouse: a variant, or a product with none. */
export interface WarehouseSku {
  /** Null for the base product of an unvaried catalogue item. */
  variantId: string | null;
  /** The variant's name, or null when this row *is* the product. */
  variantName: string | null;
  /** The variant's SKU where there is one, else the product's. */
  sku: string;
  onHandQty: number;
  reservedQty: number;
  /**
   * On hand minus reserved. Derived here and read-only everywhere.
   *
   * Never writable, for the same reason `onHandQty` is not: the balances are
   * the result of the movement ledger, and a number somebody could type over
   * would erase the trail that explains where stock went.
   */
  availableQty: number;
  /** Whether a balance row exists at all. See the module header. */
  hasBalanceRow: boolean;
  /** True when available is at or below the product's reorder threshold. */
  isLowStock: boolean;
  /** ISO-8601 of the last movement's effect here, or null with no row. */
  updatedAt: string | null;
}

/** One catalogue product, as this warehouse holds it. */
export interface WarehouseProduct {
  productId: string;
  name: string;
  sku: string;
  /** The category's name, for grouping and for the filter chips. */
  categoryId: string;
  categoryName: string;
  /** Whether this product carries a quantity at all. */
  isStockTracked: boolean;
  /** Whether this product is on sale in the storefront right now. */
  isPublished: boolean;
  reorderThreshold: number;
  /**
   * The product's own price, for a valuation.
   *
   * The base price, not the per-market `ProductPrice` row: a valuation of what
   * is standing in a building is a figure for whoever runs the business, and
   * the market a buyer in Athens is quoted in has nothing to do with it.
   */
  unitPrice: { minor: string; formatted: string; currency: string };
  /** On-hand times the unit price, in the product's own currency. */
  valuation: { minor: string; formatted: string; currency: string };
  /** The image the panel draws beside the name. Null where the product has none. */
  imageUrl: string | null;
  /** Summed across this product's SKUs at this warehouse. */
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
  /** How many of this product's SKUs are at or below the threshold. */
  lowStockSkus: number;
  /** How many of them have never had stock booked here. */
  unstockedSkus: number;
  /** One row per SKU. Exactly one, with `variantId: null`, for an unvaried product. */
  skus: WarehouseSku[];
}

export interface WarehouseInventoryTotals {
  /** Catalogue products in this list, before paging. */
  products: number;
  /** Stock-keeping units across those products. */
  skus: number;
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
  /** SKUs at or below their product's reorder threshold. */
  lowStockSkus: number;
  /** SKUs with no balance row here - never stocked at this warehouse. */
  unstockedSkus: number;
}

/** Which SKUs to keep. Applied after the balances are joined on. */
export type StockPresence =
  /** Everything in the catalogue. */
  | 'ALL'
  /** Only what this warehouse actually has on hand. */
  | 'IN_STOCK'
  /** Only what it has none of - the shopping list. */
  | 'OUT_OF_STOCK'
  /** Only what is at or below its reorder threshold. */
  | 'LOW_STOCK'
  /** Only what has never been stocked here at all. */
  | 'NEVER_STOCKED';

export interface WarehouseInventoryOptions {
  warehouseId: string;
  /** Matched against the product's name and SKU, and against variant SKUs. */
  search?: string;
  categoryId?: string;
  presence?: StockPresence;
  page?: number;
  /** Products per page, not SKUs. See the module header. */
  limit?: number;
}

export interface WarehouseInventory {
  warehouse: { id: string; code: string; name: string; isActive: boolean };
  products: WarehouseProduct[];
  totals: WarehouseInventoryTotals;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * The catalogue rows this warehouse's list is built from.
 *
 * Archived products are out: they are not in the catalogue any more, and a
 * warehouse that still holds one of them shows it on the Inventory screen,
 * which is where a balance against an archived product belongs. Unpublished
 * ones stay in - a draft product being received into a warehouse ahead of
 * launch is the ordinary case, and it is exactly the row somebody is checking.
 */
function productWhere(options: WarehouseInventoryOptions): Prisma.ProductWhereInput {
  const search = (options.search ?? '').trim();

  return {
    archivedAt: null,
    ...(options.categoryId === undefined ? {} : { categoryId: options.categoryId }),
    ...(search.length === 0
      ? {}
      : {
          OR: [
            { name: { contains: search } },
            { sku: { contains: search } },
            // A warehouse manager searching for a variant's SKU has to find
            // the product that carries it, not an empty result.
            { variants: { some: { sku: { contains: search }, archivedAt: null } } },
          ],
        }),
  };
}

/** Does this SKU survive the presence filter? */
function matchesPresence(sku: WarehouseSku, presence: StockPresence): boolean {
  switch (presence) {
    case 'IN_STOCK':
      return sku.onHandQty > 0;
    case 'OUT_OF_STOCK':
      return sku.onHandQty === 0;
    case 'LOW_STOCK':
      return sku.isLowStock;
    case 'NEVER_STOCKED':
      return !sku.hasBalanceRow;
    case 'ALL':
      return true;
  }
}

/**
 * Everything this warehouse holds, one page of products at a time.
 *
 * Throws `NOT_FOUND` for a warehouse that does not exist. A *retired*
 * warehouse is answered for normally, and deliberately: its stock is still
 * standing in a building somebody has to account for, and the screen says it
 * is retired rather than refusing to open.
 */
export async function warehouseInventory(
  options: WarehouseInventoryOptions,
): Promise<WarehouseInventory> {
  const warehouse = await prisma.inventoryLocation.findUnique({
    where: { id: options.warehouseId },
    select: { id: true, code: true, name: true, isActive: true },
  });

  if (warehouse === null) throw notFound('Warehouse');

  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(200, Math.max(1, options.limit ?? 25));
  const presence = options.presence ?? 'ALL';
  const where = productWhere(options);

  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      // By name, because that is how a person looks for a product. `id` breaks
      // the tie so paging is stable across two products with the same name.
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        name: true,
        sku: true,
        categoryId: true,
        isStockTracked: true,
        isPublished: true,
        reorderThreshold: true,
        basePriceMinor: true,
        currency: true,
        category: { select: { name: true } },
        variants: {
          where: { archivedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, sku: true, isActive: true },
        },
        media: {
          // One image: the primary one where a product has been given one,
          // and otherwise the first in the gallery's own order. A list of
          // thumbnails does not need the gallery, and pulling every image for
          // twenty-five products is a payload nobody looks at.
          orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
          take: 1,
          select: { media: { select: { url: true } } },
        },
      },
    }),
    prisma.product.count({ where }),
  ]);

  /**
   * The balances for these products at this warehouse, in one query.
   *
   * Keyed on `productId:variantKey`, the same composite the unique index uses,
   * so a variant's row and its product's row can never be confused for each
   * other. A product with no row at all simply misses from the map, which is
   * what `hasBalanceRow` reads.
   */
  const balances =
    rows.length === 0
      ? []
      : await prisma.inventoryBalance.findMany({
          where: {
            locationId: warehouse.id,
            productId: { in: rows.map((row) => row.id) },
          },
          select: {
            productId: true,
            variantKey: true,
            onHandQty: true,
            reservedQty: true,
            updatedAt: true,
          },
        });

  const byKey = new Map(
    balances.map((balance) => [`${balance.productId}:${balance.variantKey}`, balance]),
  );

  const products: WarehouseProduct[] = [];

  for (const row of rows) {
    // A variant that has been deactivated but not archived still holds stock
    // and still has to be counted; it is the row somebody is trying to run
    // down. Archived ones are already excluded by the query above.
    const variants = row.variants;

    const keys: { variantId: string | null; variantName: string | null; sku: string }[] =
      variants.length === 0
        ? [{ variantId: null, variantName: null, sku: row.sku }]
        : variants.map((variant) => ({
            variantId: variant.id,
            variantName: variant.name,
            sku: variant.sku,
          }));

    const skus: WarehouseSku[] = keys.map((key) => {
      // '' for the base product, the variant's ULID otherwise - the same
      // `variantKey` convention the column uses, and the reason it is never
      // null: a MariaDB unique index treats every NULL as distinct.
      const balance = byKey.get(`${row.id}:${key.variantId ?? ''}`);
      const onHandQty = balance?.onHandQty ?? 0;
      const reservedQty = balance?.reservedQty ?? 0;
      const availableQty = onHandQty - reservedQty;

      return {
        variantId: key.variantId,
        variantName: key.variantName,
        sku: key.sku,
        onHandQty,
        reservedQty,
        availableQty,
        hasBalanceRow: balance !== undefined,
        // A threshold of zero means nobody set one, so nothing is ever low
        // against it. The same rule the Inventory screen applies.
        isLowStock:
          row.isStockTracked && row.reorderThreshold > 0 && availableQty <= row.reorderThreshold,
        updatedAt: balance?.updatedAt.toISOString() ?? null,
      };
    });

    const kept = presence === 'ALL' ? skus : skus.filter((sku) => matchesPresence(sku, presence));

    // A product all of whose SKUs the filter rejected is not in the answer.
    // Its group would be an empty card, which reads as a rendering fault.
    if (kept.length === 0) continue;

    const onHandQty = kept.reduce((sum, sku) => sum + sku.onHandQty, 0);
    const reservedQty = kept.reduce((sum, sku) => sum + sku.reservedQty, 0);

    products.push({
      productId: row.id,
      name: row.name,
      sku: row.sku,
      categoryId: row.categoryId,
      categoryName: row.category.name,
      isStockTracked: row.isStockTracked,
      isPublished: row.isPublished,
      reorderThreshold: row.reorderThreshold,
      unitPrice: serialiseMoney(row.basePriceMinor, row.currency),
      valuation: serialiseMoney(row.basePriceMinor * BigInt(onHandQty), row.currency),
      imageUrl: row.media[0]?.media.url ?? null,
      onHandQty,
      reservedQty,
      availableQty: onHandQty - reservedQty,
      lowStockSkus: kept.filter((sku) => sku.isLowStock).length,
      unstockedSkus: kept.filter((sku) => !sku.hasBalanceRow).length,
      skus: kept,
    });
  }

  return {
    warehouse,
    products,
    totals: await warehouseInventoryTotals(warehouse.id),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/**
 * The footer figures: the whole warehouse, whatever the filters say.
 *
 * **Deliberately not narrowed by the search, the category or the presence
 * filter.** The footer answers "what is standing in this building", and that
 * does not change because somebody typed three letters into a search box to
 * find one product. A total that moved with the filter would be read as the
 * warehouse's and be wrong; the filtered count is already on screen as
 * `pagination.total`, which is where a number about the *list* belongs.
 *
 * Four aggregates rather than a walk over every SKU: a catalogue of ten
 * thousand products would otherwise be loaded into memory to produce six
 * numbers.
 *
 * `unstockedSkus` is the one figure that has to be derived rather than summed.
 * "SKUs with no balance row" is a count of rows that are not there, which SQL
 * cannot aggregate - so it is the number of stock-keeping units in the
 * catalogue minus the number of balance rows here, both of which it can count.
 */
async function warehouseInventoryTotals(locationId: string): Promise<WarehouseInventoryTotals> {
  const catalogue: Prisma.ProductWhereInput = { archivedAt: null };

  const [productCount, unvariedCount, variantCount, balances, lowStock] = await Promise.all([
    prisma.product.count({ where: catalogue }),
    // Products with no live variant hold their stock on the product itself, so
    // each is one SKU. Counted separately from the variants below because the
    // two are counted in different tables.
    prisma.product.count({ where: { ...catalogue, variants: { none: { archivedAt: null } } } }),
    prisma.productVariant.count({ where: { archivedAt: null, product: catalogue } }),
    prisma.inventoryBalance.aggregate({
      where: { locationId, product: catalogue },
      _sum: { onHandQty: true, reservedQty: true },
      _count: { _all: true },
    }),
    /**
     * The low-stock count, in SQL.
     *
     * A raw query because the comparison is between two columns in two tables
     * - a balance's available quantity against its product's threshold - and
     * Prisma's query API has no way to express that. The alternative is
     * loading every balance row in the warehouse into memory to compare them
     * in JavaScript, which is the thing this whole function exists to avoid.
     *
     * `reorderThreshold > 0` because zero means nobody set one, and
     * `isStockTracked` because a product with no quantity cannot be low on it.
     */
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count
        FROM inventory_balances b
        JOIN products p ON p.id = b.productId
       WHERE b.locationId = ${locationId}
         AND p.archivedAt IS NULL
         AND p.isStockTracked = 1
         AND p.reorderThreshold > 0
         AND (b.onHandQty - b.reservedQty) <= p.reorderThreshold
    `,
  ]);

  const skus = unvariedCount + variantCount;
  const onHandQty = balances._sum.onHandQty ?? 0;
  const reservedQty = balances._sum.reservedQty ?? 0;

  return {
    products: productCount,
    skus,
    onHandQty,
    reservedQty,
    availableQty: onHandQty - reservedQty,
    lowStockSkus: Number(lowStock[0]?.count ?? 0n),
    // Never negative: a balance row against an archived product is excluded
    // from `where` and so from `skus`, and could otherwise make the count of
    // rows exceed the count of units. `Math.max` says that in one place
    // rather than leaving a footer that can read "-3 never stocked".
    unstockedSkus: Math.max(0, skus - balances._count._all),
  };
}
