/**
 * Container loading: Seller Hub's client for how many pieces of one listing fit
 * in a 20-ft and a 40-ft container.
 *
 * Nothing here works a capacity out. The pieces per container, the payload,
 * the share of the container used and the estimate all come back from the
 * server's preview, which is the same function the save is held to - so the
 * form can never show a figure the save refuses.
 */
import { api } from './api';
import type { ContainerSize } from './preorders';

export type CapacitySource = 'SELLER_VERIFIED' | 'CALCULATED_ESTIMATE';

export interface ContainerSizeView {
  cartonsPerContainer: number | null;
  palletsPerContainer: number | null;
  piecesPerContainer: number | null;
  source: CapacitySource | null;
  verifiedAt: string | null;
  /** Grams, as a string. */
  payloadGrams: string | null;
  volumeUsePercent: number | null;
  estimate: { cartons: number; pieces: number; limitedBy: 'SPACE' | 'STACKING' | 'WEIGHT' } | null;
}

export interface ContainerLimitsView {
  /** Grams, as a string. */
  maxPayloadGrams: string;
  internalLengthMm: number;
  internalWidthMm: number;
  internalHeightMm: number;
}

export interface ContainerLoadingView {
  offerId: string;
  configured: boolean;
  version: number | null;
  carton?: {
    piecesPerCarton: number;
    lengthMm: number;
    widthMm: number;
    heightMm: number;
    grossWeightGrams: string;
    maxStackLayers: number | null;
  };
  loadingMethod?: 'CARTON_LOADED' | 'PALLET_LOADED' | 'CUSTOM';
  cartonsPerPallet?: number | null;
  sizes?: Record<ContainerSize, ContainerSizeView | null>;
  notes?: string | null;
  updatedAt?: string;
  updatedByLabel?: string | null;
  /** Always present from the server; optional so a partial response cannot break the page. */
  limits?: Record<ContainerSize, ContainerLimitsView>;
}

export interface ContainerSizeInput {
  cartonsPerContainer: number | null;
  palletsPerContainer: number | null;
  verified: boolean;
}

export interface ContainerLoadingInput {
  piecesPerCarton: number;
  cartonLength: number;
  cartonWidth: number;
  cartonHeight: number;
  dimensionUnit: 'MM' | 'CM' | 'M' | 'IN';
  grossWeightPerCarton: number;
  weightUnit: 'G' | 'KG' | 'LB';
  maxStackLayers: number | null;
  loadingMethod: 'CARTON_LOADED' | 'PALLET_LOADED';
  cartonsPerPallet: number | null;
  twentyFt: ContainerSizeInput | null;
  fortyFt: ContainerSizeInput | null;
  notes: string | null;
  expectedVersion: number | null;
}

export interface LoadingIssue {
  field: string;
  code: string;
  message: string;
  meta?: Record<string, number | string>;
}

export interface ContainerLoadingPreview {
  issues?: LoadingIssue[];
  sizes?: Record<ContainerSize, ContainerSizeView | null>;
  limits?: Record<ContainerSize, ContainerLimitsView>;
}

export function fetchContainerLoading(offerId: string) {
  return api.get<ContainerLoadingView>(`/seller/offers/${offerId}/container-loading`);
}

export function previewContainerLoading(offerId: string, input: ContainerLoadingInput) {
  return api.post<ContainerLoadingPreview>(
    `/seller/offers/${offerId}/container-loading/preview`,
    input,
  );
}

export function saveContainerLoading(offerId: string, input: ContainerLoadingInput) {
  return api.put<ContainerLoadingView>(`/seller/offers/${offerId}/container-loading`, input);
}

/** Grams as a string, to whole kilograms for display. Never a float sum. */
export function gramsToKg(grams: string | null | undefined): number | null {
  if (grams === null || grams === undefined || !/^\d+$/.test(grams)) return null;
  return Number(BigInt(grams) / 1000n);
}
