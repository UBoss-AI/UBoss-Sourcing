/**
 * API response shapes.
 *
 * Hand-written from `backend/openapi.json` rather than generated, because the
 * generated types for this API are mostly `Record<string, unknown>` - the
 * backend derives its OpenAPI from the live route table, which knows the paths
 * and methods exactly but not the response bodies.
 *
 * The rule when editing: money is always `Money`, never a number. If a field
 * here is typed `number` and it is an amount, that is a bug.
 */
import type { Money } from './format';

export type { Money };

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface SalesSummary {
  currency: string;
  window: { from: string; to: string };
  orderCount: number;
  grossSales: Money;
  tax: Money;
  shipping: Money;
  discount: Money;
  collected: Money;
  refunded: Money;
  netRevenue: Money;
  averageOrderValue: Money;
}

export interface OrdersByStatusRow {
  status: string;
  count: number;
  /** Minor units, as a bare string on this endpoint. */
  value: string;
}

export interface LowStockItem {
  productId: string;
  variantId?: string | null;
  sku: string;
  name: string;
  availableQty: number;
  reorderThreshold: number;
}

export interface UpcomingOccurrence {
  scheduleId: string;
  name: string;
  customerName: string | null;
  nextRunAt: string;
  paymentMode: string;
}

export interface DashboardResponse {
  sales: SalesSummary;
  ordersByStatus: OrdersByStatusRow[];
  payments: {
    currency: string;
    byStatus: { status: string; count: number; amount?: string }[];
    captured: string;
    failed: string;
    refunded: string;
    refundCount: number;
    rejectedWebhooks: number;
    unreconciled: number;
  };
  lowStock: { count: number; items: LowStockItem[] };
  recurring: {
    byStatus: { status: string; count: number }[];
    upcoming: UpcomingOccurrence[];
    failedOccurrences: number;
    // Widened to what the endpoint actually sends. `reason` is the schedule's
    // `pausedReason`, which is null for a schedule that failed rather than one
    // somebody paused — so it has to be nullable here or the dashboard renders
    // the string "null" at people.
    needsAttention: {
      scheduleId: string;
      name: string;
      customerName: string | null;
      failureCount: number;
      reason: string | null;
    }[];
  };
  alerts: {
    failedNotifications: number;
    deadJobs: number;
    rejectedWebhooks: number;
    unreconciledPayments: number;
    schedulesNeedingAttention: number;
  };
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  depth: number;
  sortOrder: number;
  isActive: boolean;
  productCount?: number;
  archivedAt?: string | null;
  children: CategoryNode[];
}

export interface ProductListItem {
  id: string;
  name: string;
  slug: string;
  sku: string;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  isPublished: boolean;
  publishedAt: string | null;
  /** The listed figure: what staff typed, and what the editor writes back. */
  price: Money;
  /**
   * What a customer in the requested market is charged for that figure.
   *
   * Equal to `price` when no market was asked for, and in a deployment where
   * no price depends on one. Never editable: it is the pricing engine's answer
   * about the price beside it, not a second place to set one.
   */
  quoted: Money;
  /** The rate that produced `quoted`, and whether it is inside the figure. */
  quotedTax: { ratePercent: string; inclusive: boolean };
  isStockTracked: boolean;
  reorderThreshold: number;
  archivedAt: string | null;
  category: { id: string; name: string } | null;
  mediaCount: number;
  variantCount: number;
  createdAt: string;
}

export interface ProductListResponse {
  products: ProductListItem[];
  /** The market every `quoted` above is for. Null when none was asked for. */
  country: string | null;
  /** Which rate applies there and on what basis, in one sentence. */
  taxNote: string;
  pagination: Pagination;
}

/**
 * What the product list can be filtered by.
 *
 * Which attributes are offered is a decision taken per product, by marking an
 * attribute filterable — so the toolbar asks the catalogue rather than naming
 * attributes that would be wrong for the next business to install this.
 *
 * Counts carry the other filters but not the attribute selection itself, so a
 * value that is currently chosen still shows what choosing a different one
 * would find.
 */
export interface ProductFilterFacets {
  /** The base currency; every price on this list is quoted in it. */
  currency: string;
  /** What the catalogue holds, ignoring the price boxes. Null when empty. */
  priceRange: { min: Money | null; max: Money | null };
  attributes: { name: string; values: { value: string; count: number }[] }[];
}

export interface VariantRow {
  id: string;
  sku: string;
  name: string;
  options: Record<string, string>;
  priceMinor: string | null;
  isActive: boolean;
  sortOrder: number;
  archivedAt: string | null;
  onHandQty: number;
  availableQty: number;
  orderCount: number;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportRowError {
  rowNumber: number;
  field: string | null;
  code: string;
  message: string;
}

export interface ImportJob {
  id: string;
  type: string;
  fileName: string;
  isDryRun: boolean;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'DEAD' | 'CANCELLED';
  totalRows: number;
  validRows: number;
  errorRows: number;
  createdRows: number;
  updatedRows: number;
  result: { creates?: number; updates?: number; skipped?: number } | null;
  errorMessage: string | null;
  confirmedFromJobId: string | null;
  createdAt: string;
  completedAt: string | null;
  rowErrors: ImportRowError[];
  pagination: Pagination & { truncated: boolean };
}

// ---------------------------------------------------------------------------
// Console notifications
// ---------------------------------------------------------------------------

/**
 * One row of the bell.
 *
 * No prose crosses the wire, by design: the backend sends what happened
 * (`kind`) and the values involved, and this panel builds the sentence in
 * whichever of the eight languages the reader has chosen. A row whose `kind`
 * this build does not recognise is rendered as plain fact rather than dropped -
 * a panel that is one deploy behind the API must not silently swallow news.
 */
export interface ConsoleNotification {
  id: string;
  kind: string;
  variables: Record<string, unknown>;
  /** Admin-panel path this row opens, or null when it leads nowhere. */
  linkPath: string | null;
  /** For the signed-in member of staff, not for everyone. */
  isRead: boolean;
  createdAt: string;
}

export interface ConsoleNotificationFeed {
  items: ConsoleNotification[];
  /** Across the whole visible feed, not only the page returned. */
  unreadCount: number;
}
