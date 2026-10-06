/**
 * Inspection, as the storefront sees it: the buyer's timeline, the seller's
 * readiness and corrective actions (checklist Master rows 23, 41, 94, 95).
 * The server decides every status, result and permission; this file only
 * carries its answers and the requests.
 *
 * The agency portal is not here any more: agencies, inspectors and QA work in
 * the Audit Console, a separate application with its own sign-in.
 */
import { ApiError, api, newIdempotencyKey, postFile, type ApiErrorBody } from '@/lib/api';
import { resolveApiUrl } from '@/lib/seller-documents';

/**
 * One report as the buyer or seller sees it. `result` is PASS, FAIL or
 * INCONCLUSIVE - the last holds the goods like a FAIL without saying they are bad.
 */
export interface InspectionReportView {
  /** Absent from an older server; without it the PDF cannot be asked for. */
  id?: string;
  revision?: number;
  status: string;
  result: string | null;
  summary: string | null;
  /** What the inspector could not check, when the server sends it. */
  limitations?: string | null;
  /** The signed content; null for the buyer. May carry `limitations`. */
  content?: unknown;
  signedAt: string | null;
  signedByName: string | null;
}

/** The inspector's stated limitations, wherever the payload carries them. */
export function reportLimitations(report: InspectionReportView): string | null {
  const direct = report.limitations;
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  const content = report.content;
  if (typeof content === 'object' && content !== null && 'limitations' in content) {
    const value = (content as { limitations?: unknown }).limitations;
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

export interface InspectionDefect {
  id: string;
  ncrNumber: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  status: string;
  description: string;
  requirementRef?: string;
  defectQuantity?: number;
  sellerResponse?: string | null;
  correctiveAction?: string | null;
}

export interface InspectionJobView {
  id: string;
  jobNumber: string;
  kind: string;
  reinspectionOfJobId?: string | null;
  status: string;
  agency: { name?: string } | null;
  payer: string;
  scheduledFor: string | null;
  inspectionPointType: string;
  inspectionPoint: { label?: string; city?: string; country?: string } | null;
  readinessSubmittedAt: string | null;
  inspector: { fullName?: string } | null;
  /** Every signed report on the job, oldest first, where the server sends them. */
  reports?: InspectionReportView[];
  report: InspectionReportView | null;
  defects?: InspectionDefect[];
  evidence?: { id: string; purpose: string; defectId: string | null; fileName: string }[];
  samplingRecord?: { lotReference?: string; sampledQuantity?: number; acceptedQuantity?: number; rejectedQuantity?: number } | null;
}

/** The RFQ purchase order an inspected order was bought on (LIVE-004). */
export interface InspectionPurchaseOrder {
  reference: string;
  inspectionRequirement: string | null;
  inspectionTerms: string | null;
}

/** The approved RFQ reference sample the goods are measured against (JOURNEY-019). */
export interface InspectionReferenceSample {
  reference: string;
  referenceCode: string | null;
  quantity: string;
  unitOfMeasure: string | null;
  approvalCriteria: string;
  decisionReason: string | null;
  approvedAt: string | null;
  files: string[];
}

export interface InspectionView {
  requirement: {
    id: string;
    orderNumber: string;
    sellerOrderGroupId: string;
    sellerName: string;
    level: string;
    status: string;
    reason: string | null;
    gate: { allowed?: boolean; sentence: string };
    /** Optional: absent from an older server. */
    purchaseOrder?: InspectionPurchaseOrder | null;
    referenceSample?: InspectionReferenceSample | null;
  };
  jobs: InspectionJobView[];
  releases: { id: string; kind: string; state: string; reason?: string | null }[];
  timeline: { id: string; kind: string; actorLabel: string | null; summary: string; createdAt: string | null }[];
}

export const inspectionKeys = {
  buyer: (orderId: string) => ['inspection', 'buyer', orderId] as const,
  seller: (groupId: string) => ['inspection', 'seller', groupId] as const,
};

export async function fetchBuyerInspections(orderId: string): Promise<InspectionView[]> {
  return (await api.get<{ inspections: InspectionView[] }>(`/inspection/buyer/orders/${orderId}`)).inspections;
}

export async function fetchSellerInspection(groupId: string): Promise<InspectionView | null> {
  return (await api.get<{ inspection: InspectionView | null }>(`/seller/inspection/orders/${groupId}`)).inspection;
}

export const requestBuyerInspection = (orderId: string, sellerOrderGroupId: string, note: string | null): Promise<unknown> =>
  api.post(`/inspection/buyer/orders/${orderId}/request`, { sellerOrderGroupId, note });

/** One agency a buyer may choose; `problems` says why one cannot take the job on that day or in that country. */
export interface BuyerAgencyChoice {
  id: string;
  name: string;
  eligible: boolean;
  problems: string[];
}

export async function fetchBuyerAgencyChoices(
  orderId: string,
  query: { sellerOrderGroupId: string; country: string; scheduledFor: string },
): Promise<BuyerAgencyChoice[]> {
  const params = new URLSearchParams({ sellerOrderGroupId: query.sellerOrderGroupId, scheduledFor: query.scheduledFor });
  if (query.country.length === 2) params.set('country', query.country);
  return (await api.get<{ agencies: BuyerAgencyChoice[] }>(`/inspection/buyer/orders/${orderId}/agencies?${params.toString()}`)).agencies;
}

export interface BuyerBookingInput {
  sellerOrderGroupId: string;
  agencyId: string;
  scheduledFor: string;
  inspectionPointType: 'SELLER_PREMISES' | 'WAREHOUSE' | 'PORT' | 'OTHER';
  inspectionPoint: { label: string; addressLine: string; city: string; country: string };
  payer: 'BUYER' | 'SELLER';
  specialRequirements?: string | null;
}

export const bookBuyerInspection = (orderId: string, body: BuyerBookingInput): Promise<{ jobId: string; jobNumber: string }> =>
  api.post(`/inspection/buyer/orders/${orderId}/book`, body);

/** A job still in flight: a second one cannot be booked while one of these exists. */
export const OPEN_JOB_STATUSES = ['REQUESTED', 'ACCEPTED', 'INSPECTOR_ASSIGNED', 'IN_PROGRESS', 'REPORT_SUBMITTED'];

export const submitReadiness = (jobId: string, body: unknown): Promise<unknown> => api.post(`/seller/inspection/jobs/${jobId}/readiness`, body);

export const submitCapa = (defectId: string, body: { sellerResponse: string; correctiveAction: string }): Promise<unknown> =>
  api.post(`/seller/inspection/defects/${defectId}/capa`, body);

export function uploadCorrectiveEvidence(jobId: string, defectId: string, file: File): Promise<unknown> {
  const form = new FormData();
  form.append('purpose', 'CAPA');
  form.append('defectId', defectId);
  form.append('file', file);
  return postFile(`/seller/inspection/jobs/${jobId}/evidence`, form, { idempotencyKey: newIdempotencyKey() });
}

/**
 * Save a signed report as a PDF.
 *
 * The seller reads reports on their own orders; the buyer reads one only when
 * the operator's policy lets buyers see it (the server answers 404 otherwise).
 * Fetched with the session cookie rather than navigated to, so a refusal comes
 * back as a sentence on this page - the same way receipts are downloaded.
 */
export async function downloadInspectionReport(audience: 'BUYER' | 'SELLER', reportId: string): Promise<void> {
  const path = audience === 'SELLER'
    ? `/api/v1/seller/inspection/reports/${encodeURIComponent(reportId)}/pdf`
    : `/api/v1/inspection/buyer/reports/${encodeURIComponent(reportId)}/pdf`;
  const response = await fetch(resolveApiUrl(path), { credentials: 'include' });
  if (!response.ok) {
    let body: { error?: ApiErrorBody } | null = null;
    try {
      body = (await response.json()) as { error?: ApiErrorBody };
    } catch {
      body = null;
    }
    throw new ApiError(
      response.status,
      body?.error ?? { code: 'UNEXPECTED_RESPONSE', message: `HTTP ${String(response.status)}` },
    );
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'inspection-report.pdf';
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}
