/**
 * Shipment Assessment as the seller and the buyer see it.
 *
 *   Seller: GET  /seller/orders/:id/shipment-assessment       the case of one seller order
 *           POST /seller/shipment-assessments/:id/response     readiness note or corrective answer
 *           POST /seller/shipment-assessments/:id/evidence     a photo or PDF for the Audit Team
 *           GET  /seller/shipment-assessments/:id/documents/:documentId
 *   Buyer:  GET  /orders/:id/shipment-assessments              released summaries of an own order
 *
 * The seller cannot change a finding or a decision; the server has no route
 * that would let it.
 */
import { ApiError, api, newIdempotencyKey, postFile, type ApiErrorBody } from '@/lib/api';
import { resolveApiUrl } from '@/lib/seller-documents';

export interface AssessmentDocument {
  id: string;
  number: string;
  kind: string;
  status: string;
  issuedAt: string;
  dispatchBy: string | null;
}

export interface SellerAssessment {
  id: string;
  number: string;
  status: string;
  badge: string | null;
  requirement: string;
  requirementReason: string;
  releaseRefusal: string | null;
  releaseDeadline: string | null;
  holdReason: string | null;
  readinessNote: string | null;
  sellerResponse: string | null;
  documents: AssessmentDocument[];
  rounds: { round: number; kind: string; outcome: string | null; findingsSummary: string | null; correctiveAction: string | null; quantities: { sampledQuantity: number | null; countedQuantity: number | null } }[];
  checks: { round: number; itemCode: string; outcome: string; note: string | null }[];
}

export interface BuyerAssessment {
  id: string;
  number: string;
  status: string;
  releaseDeadline: string | null;
  documents: AssessmentDocument[];
}

export const assessmentKeys = {
  seller: (sellerOrderId: string) => ['shipment-assessment', 'seller', sellerOrderId] as const,
  buyer: (orderId: string) => ['shipment-assessment', 'buyer', orderId] as const,
};

const enc = encodeURIComponent;

export const fetchSellerAssessment = (sellerOrderId: string): Promise<{ assessment: SellerAssessment | null }> =>
  api.get(`/seller/orders/${enc(sellerOrderId)}/shipment-assessment`);

export const sendSellerResponse = (id: string, body: { readinessNote?: string; correctiveResponse?: string }): Promise<unknown> =>
  api.post(`/seller/shipment-assessments/${enc(id)}/response`, body, { idempotencyKey: newIdempotencyKey() });

export function uploadSellerEvidence(id: string, file: File, note: string): Promise<unknown> {
  const form = new FormData();
  if (note.trim() !== '') form.append('note', note.trim());
  form.append('file', file);
  return postFile(`/seller/shipment-assessments/${enc(id)}/evidence`, form, { idempotencyKey: newIdempotencyKey() });
}

export const fetchBuyerAssessments = (orderId: string): Promise<{ items: BuyerAssessment[] }> => api.get(`/orders/${enc(orderId)}/shipment-assessments`);

/** Save a document. Fetched with the session cookie, so a refusal is a sentence, not a broken tab. */
export async function downloadAssessmentDocument(audience: 'SELLER' | 'BUYER', parentId: string, documentId: string): Promise<void> {
  const path =
    audience === 'SELLER'
      ? `/api/v1/seller/shipment-assessments/${enc(parentId)}/documents/${enc(documentId)}`
      : `/api/v1/orders/${enc(parentId)}/shipment-assessments/${enc(documentId)}`;
  const response = await fetch(resolveApiUrl(path), { credentials: 'include' });
  if (!response.ok) {
    let body: { error?: ApiErrorBody } | null = null;
    try {
      body = (await response.json()) as { error?: ApiErrorBody };
    } catch {
      body = null;
    }
    throw new ApiError(response.status, body?.error ?? { code: 'UNEXPECTED_RESPONSE', message: `HTTP ${String(response.status)}` });
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'document.pdf';
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}
