/**
 * Seller Hub: bulk listing updates and production milestones.
 */
import type { TranslationKey } from '@/i18n/i18n-context';
import { api, newIdempotencyKey, postFile } from '@/lib/api';

// --- Bulk import -----------------------------------------------------------

export interface SellerImportJob {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'DEAD' | 'CANCELLED';
  isDryRun: boolean;
  fileName: string;
  fileFormat: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  updatedRows: number;
  sourceJobId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface SellerImportChange {
  rowNumber: number;
  offerId: string;
  sellerSku: string;
  currency: string;
  price?: { from: string; to: string };
  compareAtPrice?: { from: string | null; to: string };
  minimumOrderQuantity?: { from: number; to: number };
  status?: { from: string; to: 'ACTIVE' | 'PAUSED' };
  stock?: { locationId: string; locationCode: string; from: number; to: number };
}

export interface SellerImportRowError {
  rowNumber: number;
  columnName: string | null;
  code: string;
  message: string;
  rawValue: string | null;
}

export interface SellerImportView {
  job: SellerImportJob;
  appliedJobId: string | null;
  errors: SellerImportRowError[];
  preview: { changes: SellerImportChange[]; unchangedRows: number } | null;
}

export const SELLER_IMPORT_TEMPLATE_PATH = '/seller/bulk-imports/template';

export async function fetchSellerImports(): Promise<SellerImportJob[]> {
  return (await api.get<{ jobs: SellerImportJob[] }>('/seller/bulk-imports')).jobs;
}

export function fetchSellerImport(id: string): Promise<SellerImportView> {
  return api.get<SellerImportView>(`/seller/bulk-imports/${id}`);
}

export function uploadSellerImport(file: File): Promise<SellerImportView> {
  const form = new FormData();
  form.append('file', file);
  return postFile<SellerImportView>('/seller/bulk-imports', form);
}

export function applySellerImport(id: string): Promise<SellerImportView> {
  return api.post<SellerImportView>(`/seller/bulk-imports/${id}/apply`, {});
}

// --- Production ------------------------------------------------------------

export const PRODUCTION_STAGES = ['RAW_MATERIAL', 'IN_PRODUCTION', 'QUALITY_CHECKED', 'READY'] as const;
export type ProductionStage = (typeof PRODUCTION_STAGES)[number];

export const PRODUCTION_DELAY_REASONS = [
  'RAW_MATERIAL_SHORTAGE',
  'MACHINE_BREAKDOWN',
  'LABOUR_SHORTAGE',
  'QUALITY_REWORK',
  'SUPPLIER_DELAY',
  'TESTING_OR_CERTIFICATION',
  'BUYER_CHANGE_REQUEST',
  'LOGISTICS',
  'OTHER',
] as const;
export type ProductionDelayReason = (typeof PRODUCTION_DELAY_REASONS)[number];

export function stageKey(stage: ProductionStage): TranslationKey {
  return `production.stage.${stage}` as TranslationKey;
}

export function delayReasonKey(reason: ProductionDelayReason): TranslationKey {
  return `production.reason.${reason}` as TranslationKey;
}

export interface ProductionView {
  open: boolean;
  nextStage: ProductionStage | null;
  stages: {
    stage: ProductionStage;
    plannedFor: string | null;
    completedAt: string | null;
    completedByLabel: string | null;
    internalNote: string | null;
    buyerNote: string | null;
  }[];
  delays: {
    id: string;
    stage: ProductionStage;
    reason: ProductionDelayReason;
    detail: string | null;
    buyerMessage: string | null;
    revisedDate: string | null;
    raisedAt: string;
    raisedByLabel: string;
    resolvedAt: string | null;
    resolutionNote: string | null;
  }[];
}

export function fetchProduction(groupId: string): Promise<ProductionView> {
  return api.get<ProductionView>(`/seller/orders/${groupId}/production`);
}

export function completeProductionStage(
  groupId: string,
  body: { stage: ProductionStage; buyerNote?: string | null; internalNote?: string | null },
): Promise<void> {
  return api.post(`/seller/orders/${groupId}/production/milestones`, body);
}

export function planProductionStage(groupId: string, body: { stage: ProductionStage; plannedFor: string }): Promise<void> {
  return api.post(`/seller/orders/${groupId}/production/plan`, body);
}

export function raiseProductionDelay(
  groupId: string,
  body: {
    stage: ProductionStage;
    reason: ProductionDelayReason;
    revisedDate: string;
    detail?: string | null;
    buyerMessage?: string | null;
  },
): Promise<{ delayId: string }> {
  return api.post(`/seller/orders/${groupId}/production/delays`, body, { idempotencyKey: newIdempotencyKey() });
}

export function resolveProductionDelay(groupId: string, delayId: string, resolutionNote: string | null): Promise<void> {
  return api.post(`/seller/orders/${groupId}/production/delays/${delayId}/resolve`, { resolutionNote });
}
