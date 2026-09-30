/**
 * Inspection, as the storefront sees it: the buyer's timeline, the seller's
 * readiness and corrective actions, and the agency portal (checklist Master
 * rows 23, 41, 45-54, 94, 95). The server decides every status, result and
 * permission; this file only carries its answers and the requests.
 */
import { api, newIdempotencyKey, postFile } from '@/lib/api';

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
  report: { status: string; result: string | null; summary: string | null; signedAt: string | null; signedByName: string | null } | null;
  defects?: InspectionDefect[];
  evidence?: { id: string; purpose: string; defectId: string | null; fileName: string }[];
  samplingRecord?: { lotReference?: string; sampledQuantity?: number; acceptedQuantity?: number; rejectedQuantity?: number } | null;
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
  };
  jobs: InspectionJobView[];
  releases: { id: string; kind: string; state: string; reason?: string | null }[];
  timeline: { id: string; kind: string; actorLabel: string | null; summary: string; createdAt: string | null }[];
}

export const inspectionKeys = {
  buyer: (orderId: string) => ['inspection', 'buyer', orderId] as const,
  seller: (groupId: string) => ['inspection', 'seller', groupId] as const,
  agency: ['inspection', 'agency'] as const,
  agencyJob: (jobId: string) => ['inspection', 'agency', jobId] as const,
};

export async function fetchBuyerInspections(orderId: string): Promise<InspectionView[]> {
  return (await api.get<{ inspections: InspectionView[] }>(`/inspection/buyer/orders/${orderId}`)).inspections;
}

export async function fetchSellerInspection(groupId: string): Promise<InspectionView | null> {
  return (await api.get<{ inspection: InspectionView | null }>(`/seller/inspection/orders/${groupId}`)).inspection;
}

export const requestBuyerInspection = (orderId: string, sellerOrderGroupId: string, note: string | null): Promise<unknown> =>
  api.post(`/inspection/buyer/orders/${orderId}/request`, { sellerOrderGroupId, note });

export const submitReadiness = (jobId: string, body: unknown): Promise<unknown> => api.post(`/seller/inspection/jobs/${jobId}/readiness`, body);

export const submitCapa = (defectId: string, body: { sellerResponse: string; correctiveAction: string }): Promise<unknown> =>
  api.post(`/seller/inspection/defects/${defectId}/capa`, body);

export interface AgencyJobRow {
  id: string;
  jobNumber: string;
  status: string;
  scheduledFor: string | null;
  sellerName?: string;
  orderNumber?: string;
  acceptDueAt: string | null;
  reportDueAt: string | null;
  slaState: 'ON_TIME' | 'ACCEPT_OVERDUE' | 'REPORT_OVERDUE';
  inspectorMemberId: string | null;
}

export interface AgencyDashboard {
  counts: Record<'offered' | 'toAssign' | 'assigned' | 'inProgress' | 'awaitingQa' | 'completed' | 'overdue', number>;
  jobs: AgencyJobRow[];
  inspectors: { id: string; fullName: string; role: string; status: string; identityVerifiedAt: string | null; credentialExpiresAt: string | null }[];
  invoices: { id: string; jobNumber: string; invoiceNumber: string; amountMinor: string; currency: string; payer: string; status: string }[];
}

export const fetchAgencyDashboard = (): Promise<AgencyDashboard> => api.get('/inspection/agency/dashboard');

export const fetchAgencyMe = (): Promise<{ membership: { agencyName: string; fullName: string; role: string; permissions: string[] } }> =>
  api.get('/inspection/agency/me');

export async function fetchAgencyJobs(): Promise<AgencyJobRow[]> {
  return (await api.get<{ jobs: AgencyJobRow[] }>('/inspection/agency/jobs')).jobs;
}

export async function fetchAgencyJob(jobId: string): Promise<Record<string, unknown>> {
  return (await api.get<{ job: Record<string, unknown> }>(`/inspection/agency/jobs/${jobId}`)).job;
}

export const agencyAction = (jobId: string, action: string, body: unknown = {}): Promise<unknown> =>
  api.post(`/inspection/agency/jobs/${jobId}/${action}`, body, { idempotencyKey: newIdempotencyKey() });

export function uploadAgencyEvidence(jobId: string, file: File, fields: Record<string, string>): Promise<unknown> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('capturedAt', new Date().toISOString());
  form.append('file', file);
  return postFile(`/inspection/agency/jobs/${jobId}/evidence`, form, { idempotencyKey: newIdempotencyKey() });
}

export function uploadCorrectiveEvidence(jobId: string, defectId: string, file: File): Promise<unknown> {
  const form = new FormData();
  form.append('purpose', 'CAPA');
  form.append('defectId', defectId);
  form.append('file', file);
  return postFile(`/seller/inspection/jobs/${jobId}/evidence`, form, { idempotencyKey: newIdempotencyKey() });
}
