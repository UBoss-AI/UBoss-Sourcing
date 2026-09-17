/**
 * Seller warehouses, as the Warehouses screen reads them.
 *
 * Types and queries only. Kept out of the component files so those export
 * components alone - a module that mixes the two cannot keep its state across
 * a Fast Refresh edit, which on a screen with an open picker and a half-typed
 * search is the difference between an edit you notice and one you do not.
 *
 * The rows come back in the same shape whoever owns the building, because the
 * map and the table draw both and a screen with two row types is a screen with
 * two of every column. What differs is carried in `owner`.
 */
import { api } from '@/lib/api';
import type { MapConfig, MappablePlace, OperationalStatus } from '@/lib/warehouses';

/** Which set of buildings the screen is showing. */
export type WarehouseViewMode = 'uboss' | 'seller' | 'all';

export interface SellerSuggestion {
  sellerAccountId: string;
  /** The public shopfront name. What buyers see, and what the operator types. */
  displayName: string;
  /** The registered business name. Two sellers can legitimately share one. */
  legalName: string;
  /** The seller's stable public handle - what somebody quotes in a ticket. */
  sellerCode: string;
  registrationCountry: string;
  /** Always `APPROVED`. Carried so the row can say so rather than imply it. */
  status: string;
  /** Places they dispatch from and have not closed or archived. */
  activeWarehouseCount: number;
}

export interface SellerSearchResponse {
  sellers: SellerSuggestion[];
  /** More matched than came back. The picker says "keep typing". */
  isTruncated: boolean;
  /** Below this many characters the server runs no search at all. */
  minimumLength: number;
}

export interface SellerWarehouseStock {
  skuCount: number;
  onHandQty: number;
  reservedQty: number;
  quarantinedQty: number;
  lowStockCount: number;
}

/**
 * One building on the seller view.
 *
 * Satisfies `MappablePlace` structurally, which is what lets the existing map
 * draw these without a second implementation of it.
 */
export interface SellerWarehouse extends MappablePlace {
  owner: {
    type: 'PLATFORM' | 'SELLER';
    sellerAccountId: string | null;
    name: string;
    sellerCode: string | null;
  };
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  countryCode: string | null;
  timezone: string | null;
  /**
   * The place has a position stored that cannot be plotted.
   *
   * Different from never having been geocoded, and the table says something
   * different about each: one is a job somebody has not done, the other is a
   * value somebody has to correct. Both keep the row in the table and out of
   * the map.
   */
  coordinatesInvalid: boolean;
  operationalStatus: OperationalStatus;
  isActive: boolean;
  /** The seller's own words about why it is shut, where they gave any. */
  closedReason: string | null;
  isPickupLocation: boolean;
  isReturnLocation: boolean;
  hasColdChain: boolean;
  hasControlledStorage: boolean;
  hasSterileStorage: boolean;
  stock: SellerWarehouseStock;
  /** When this place's stock last agreed with the seller's own ERP. */
  erpLastSyncAt: string | null;
}

export interface SellerWarehousesResponse {
  warehouses: SellerWarehouse[];
  /** More matched than the cap allowed. The screen says to narrow it. */
  isTruncated: boolean;
  map: MapConfig;
  /** Present when one seller was asked for, so the screen can name them. */
  seller: SellerSuggestion | null;
}

export const sellerSearchKey = (search: string): readonly unknown[] => [
  'seller-search',
  search,
];

export const sellerWarehousesKey = (input: {
  sellerAccountId: string | null;
  search: string;
  countryCode: string;
  includeClosed: boolean;
}): readonly unknown[] => ['seller-warehouses', input];

export function fetchSellerSuggestions(search: string): Promise<SellerSearchResponse> {
  return api.get<SellerSearchResponse>('/admin/inventory/seller-search', {
    query: { q: search },
  });
}

export function fetchSellerWarehouses(input: {
  sellerAccountId: string | null;
  search: string;
  countryCode: string;
  includeClosed: boolean;
}): Promise<SellerWarehousesResponse> {
  return api.get<SellerWarehousesResponse>('/admin/inventory/seller-warehouses', {
    query: {
      ...(input.sellerAccountId === null ? {} : { sellerAccountId: input.sellerAccountId }),
      ...(input.search === '' ? {} : { q: input.search }),
      ...(input.countryCode === '' ? {} : { countryCode: input.countryCode }),
      includeClosed: input.includeClosed ? 'true' : 'false',
    },
  });
}

/**
 * A one-line address for the table.
 *
 * Built from the parts that exist rather than from a template with gaps, so a
 * place with no city does not read as "1 Havenstraat, , 3011".
 */
export function sellerAddressLine(warehouse: SellerWarehouse): string {
  return [warehouse.addressLine1, warehouse.city, warehouse.postcode]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(', ');
}
