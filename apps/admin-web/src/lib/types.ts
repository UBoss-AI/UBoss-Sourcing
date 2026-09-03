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
    needsAttention: { scheduleId: string; name: string; reason: string }[];
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
  price: Money;
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
  pagination: Pagination;
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
