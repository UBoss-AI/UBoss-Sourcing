/**
 * What one warehouse holds, as the inventory panel reads it.
 *
 * Mirrors `backend/src/modules/inventory/warehouse-inventory.service.ts`, and
 * the two things in it that look redundant are the whole feature:
 *
 *   - **The list is the catalogue, not the balance rows.** Every product
 *     appears for every warehouse, whether or not stock has ever been booked
 *     there. A list built from balance rows cannot show an absence - it shows
 *     nothing where the answer is zero, and nothing is indistinguishable from
 *     "not in the catalogue". The product a warehouse manager is looking for
 *     is usually the one that is missing.
 *   - **`hasBalanceRow` is separate from `onHandQty === 0`.** They are the
 *     same quantity and different provenance: no row means stock has never
 *     been booked here, a zero row means it has and has run out. "We have
 *     never stocked this in Antwerp" and "Antwerp is out of it" are two
 *     different conversations with a buyer.
 *
 * Grouped by product with one row per SKU inside, because a product with
 * variants holds its stock per variant - a flat list would repeat the same
 * name twenty times down the screen.
 */
import { api } from '@/lib/api';
import type { Money } from '@/lib/warehouses';

/** One stock-keeping unit at this warehouse: a variant, or a product with none. */
export interface WarehouseSku {
  /** Null when this row *is* the product - it has no variants. */
  variantId: string | null;
  variantName: string | null;
  sku: string;
  onHandQty: number;
  reservedQty: number;
  /** On hand minus what live checkouts have already promised away. Read-only. */
  availableQty: number;
  /** Whether a balance row exists at all. See the module header. */
  hasBalanceRow: boolean;
  isLowStock: boolean;
  /** ISO-8601 of the last movement's effect here, or null with no row. */
  updatedAt: string | null;
}

export interface WarehouseProduct {
  productId: string;
  name: string;
  sku: string;
  categoryId: string;
  categoryName: string;
  /**
   * Whether this product carries a quantity at all.
   *
   * False for a made-to-order item, which genuinely has no stock anywhere.
   * Listed and labelled rather than hidden, so nobody hunts a screen headed
   * "everything in this warehouse" for a product that is deliberately absent
   * from the numbers.
   */
  isStockTracked: boolean;
  isPublished: boolean;
  reorderThreshold: number;
  unitPrice: Money;
  /** On-hand times the unit price, in the product's own currency. */
  valuation: Money;
  imageUrl: string | null;
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
  lowStockSkus: number;
  unstockedSkus: number;
  skus: WarehouseSku[];
}

/**
 * The footer figures.
 *
 * **The whole warehouse, not the filtered list.** A total that moved with the
 * search box would be read as the warehouse's and be wrong; the count of what
 * the filter matched is `pagination.total`, which is where a number about the
 * list belongs.
 */
export interface WarehouseInventoryTotals {
  products: number;
  skus: number;
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
  lowStockSkus: number;
  /** SKUs with no balance row here - never stocked at this warehouse. */
  unstockedSkus: number;
}

/** Which SKUs to keep. Applied after the balances are joined on. */
export type StockPresence = 'ALL' | 'IN_STOCK' | 'OUT_OF_STOCK' | 'LOW_STOCK' | 'NEVER_STOCKED';

export const STOCK_PRESENCES: readonly StockPresence[] = [
  'ALL',
  'IN_STOCK',
  'LOW_STOCK',
  'OUT_OF_STOCK',
  'NEVER_STOCKED',
];

export interface WarehouseInventoryResponse {
  warehouse: { id: string; code: string; name: string; isActive: boolean };
  products: WarehouseProduct[];
  totals: WarehouseInventoryTotals;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface WarehouseInventoryQuery {
  page: number;
  search: string;
  categoryId: string;
  presence: StockPresence;
}

/** How many products one page holds. Twenty-five cards is a screenful. */
export const INVENTORY_PAGE_SIZE = 25;

export function warehouseInventoryQueryKey(
  warehouseId: string,
  query: WarehouseInventoryQuery,
): readonly unknown[] {
  return ['warehouse-inventory', warehouseId, query];
}

export function fetchWarehouseInventory(
  warehouseId: string,
  query: WarehouseInventoryQuery,
): Promise<WarehouseInventoryResponse> {
  return api.get<WarehouseInventoryResponse>(
    `/admin/inventory/warehouses/${warehouseId}/inventory`,
    {
      query: {
        page: String(query.page),
        limit: String(INVENTORY_PAGE_SIZE),
        presence: query.presence,
        ...(query.search === '' ? {} : { q: query.search }),
        ...(query.categoryId === '' ? {} : { categoryId: query.categoryId }),
      },
    },
  );
}

/**
 * How full a SKU is, as a fraction, for the fill bars.
 *
 * There is no "capacity" in this data model - a warehouse does not declare how
 * many of a thing it can hold - so a bar has to be relative to something real.
 * The reorder threshold is that something: it is the number the business
 * itself chose as "this is getting low", so the bar reads as *health* rather
 * than as fullness. Ten times the threshold is treated as full, which puts a
 * SKU sitting exactly at its threshold at one tenth of the bar - visibly, and
 * correctly, nearly empty.
 *
 * A product with no threshold set has nothing to be measured against, so the
 * bar is drawn at a flat two thirds and carries no meaning beyond "there is
 * some". Guessing a scale would draw a confident picture of nothing.
 */
export function stockFraction(sku: WarehouseSku, reorderThreshold: number): number {
  if (sku.availableQty <= 0) return 0;
  if (reorderThreshold <= 0) return 0.66;

  return Math.min(1, sku.availableQty / (reorderThreshold * 10));
}
