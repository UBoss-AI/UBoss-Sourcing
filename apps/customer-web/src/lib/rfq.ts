/**
 * Requests for quotation: the storefront's side of the API (Master rows 16-19).
 *
 * Every figure of money crosses as a string of minor units and stays one here.
 * Quantities are decimal strings (up to three places) for the same reason: a
 * buyer who asks for 12.5 tonnes must see 12.5, not 12.499999.
 */
import { z } from 'zod';
import { api, BASE_URL, newIdempotencyKey, postFile } from './api';
import { track } from '@/lib/analytics';
import type { Money } from './format';

export const RFQ_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'AWARDED', 'CANCELLED'] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

export type InvitationStatus = 'INVITED' | 'VIEWED' | 'QUOTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED';

export interface RfqSpecLine {
  key: string;
  value: string;
}

/** Every field of the request form. */
export interface RfqRequirement {
  categoryId: string | null;
  title: string;
  specification: string | null;
  specs: RfqSpecLine[];
  quantity: string | null;
  unitOfMeasure: string | null;
  annualVolume: string | null;
  targetUnitPriceMinor: string | null;
  targetCurrency: string | null;
  destinationCountry: string | null;
  destinationAddress: string | null;
  destinationPort: string | null;
  incoterm: string | null;
  certifications: string[];
  sampleRequirement: string;
  inspectionRequirement: string;
  responseDeadline: string | null;
  deliveryTargetDate: string | null;
  notes: string | null;
}

export interface RfqDraftInput extends RfqRequirement {
  includeSellerIds: string[];
  excludeSellerIds: string[];
}

export interface SupplierCard {
  sellerAccountId: string;
  displayName: string;
  slug: string;
  registrationCountry: string;
  verifiedAt: string | null;
  matchesCategory: boolean;
  /** Why it matched (JOURNEY-014). Absent on a hand-picked card or an older API. */
  reasons?: ('LIVE_IN_CATEGORY' | 'EXPORTS_TO_DESTINATION' | 'VERIFIED_CERTIFICATE')[];
  /** What to know before inviting: capacity and possible conflict. */
  flags?: ('CAPACITY_UNKNOWN' | 'CAPACITY_BELOW_QUANTITY' | 'OPEN_DISPUTE')[];
}

export interface RfqAttachment {
  id: string;
  purpose: 'REQUIREMENT' | 'QUOTE' | 'NEGOTIATION';
  fileName: string;
  contentType: string;
  byteSize: number;
  requirementVersion: number | null;
  quoteVersionId: string | null;
  uploadedBy: 'BUYER' | 'SUPPLIER';
  createdAt: string;
}

export interface AttachmentPolicy {
  available: boolean;
  reason: 'NO_SCANNER' | null;
  maxBytes: number;
  maxFiles: number;
  types: string[];
}

export interface RfqInvitation {
  id: string;
  source: 'MATCHED' | 'BUYER_SELECTED';
  status: InvitationStatus;
  invitedAt: string;
  viewedAt: string | null;
  respondedAt: string | null;
  declineReason: string | null;
  supplier: SupplierCard;
}

export interface RfqTimelineEvent {
  id: string;
  kind: string;
  actor: 'BUYER' | 'SUPPLIER' | 'SYSTEM';
  supplierName: string | null;
  meta: Record<string, unknown> | null;
  at: string;
}

export interface RfqVersionSummary {
  versionNumber: number;
  changedFields: string[];
  changeSummary: string | null;
  createdAt: string;
}

export interface BuyerRfq {
  id: string;
  reference: string;
  status: RfqStatus;
  version: number;
  isPastDeadline: boolean;
  requirement: RfqRequirement;
  targetPrice: Money | null;
  category: { id: string; name: string } | null;
  owner: { kind: 'INDIVIDUAL' } | { kind: 'COMPANY'; companyId: string; companyName: string };
  currentRequirementVersion: number;
  matchOutcome: 'MATCHED' | 'NO_MATCH' | null;
  matchedSupplierCount: number;
  selection: { include: SupplierCard[]; exclude: SupplierCard[] };
  invitations: RfqInvitation[];
  attachments: RfqAttachment[];
  attachmentPolicy: AttachmentPolicy;
  versions: RfqVersionSummary[];
  timeline: RfqTimelineEvent[];
  submittedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  actions: {
    canEdit: boolean;
    canSubmit: boolean;
    canCancel: boolean;
    canClose: boolean;
    canInvite: boolean;
    canAmend: boolean;
  };
}

export interface RfqListItem {
  id: string;
  reference: string;
  status: RfqStatus;
  title: string;
  categoryName: string | null;
  quantity: string | null;
  unitOfMeasure: string | null;
  destinationCountry: string | null;
  responseDeadline: string | null;
  isPastDeadline: boolean;
  invitedCount: number;
  respondedCount: number;
  updatedAt: string;
  submittedAt: string | null;
}

export interface RfqFormOptions {
  unitsOfMeasure: string[];
  incoterms: string[];
  sampleRequirements: string[];
  inspectionRequirements: string[];
  maxResponseDays: number;
  maxInvitedSuppliers: number;
  attachments: AttachmentPolicy;
}

export interface MatchResult {
  outcome: 'MATCHED' | 'NO_MATCH' | 'BLOCKED' | 'INCOMPLETE';
  suppliers: SupplierCard[];
  blockedReason: string | null;
}

/** The C and D group Incoterms: the buyer must name where the goods go. */
export const INCOTERMS_NEEDING_DESTINATION = ['CPT', 'CIP', 'CFR', 'CIF', 'DAP', 'DPU', 'DDP'];

export const EMPTY_REQUIREMENT: RfqDraftInput = {
  categoryId: null,
  title: '',
  specification: null,
  specs: [],
  quantity: null,
  unitOfMeasure: null,
  annualVolume: null,
  targetUnitPriceMinor: null,
  targetCurrency: null,
  destinationCountry: null,
  destinationAddress: null,
  destinationPort: null,
  incoterm: null,
  certifications: [],
  sampleRequirement: 'NONE',
  inspectionRequirement: 'NONE',
  responseDeadline: null,
  deliveryTargetDate: null,
  notes: null,
  includeSellerIds: [],
  excludeSellerIds: [],
};

/** What the draft form holds, from a request the server returned. */
export function draftFrom(rfq: BuyerRfq): RfqDraftInput {
  return {
    ...rfq.requirement,
    includeSellerIds: rfq.selection.include.map((supplier) => supplier.sellerAccountId),
    excludeSellerIds: rfq.selection.exclude.map((supplier) => supplier.sellerAccountId),
  };
}

/** The requirement alone, without the draft's supplier choices. */
export function requirementOnly(input: RfqDraftInput): RfqRequirement {
  return Object.fromEntries(
    Object.entries(input).filter(([field]) => field !== 'includeSellerIds' && field !== 'excludeSellerIds'),
  ) as unknown as RfqRequirement;
}

export async function fetchRfqFormOptions(): Promise<RfqFormOptions> {
  return api.get<RfqFormOptions>('/rfqs/form-options');
}

export async function fetchMyRfqs(
  status: RfqStatus | null,
): Promise<{ items: RfqListItem[]; counts: Record<RfqStatus, number> }> {
  return api.get('/rfqs', { query: { status } });
}

export async function fetchRfq(id: string): Promise<BuyerRfq> {
  return (await api.get<{ rfq: BuyerRfq }>(`/rfqs/${id}`)).rfq;
}

export async function createRfqDraft(input: RfqDraftInput, idempotencyKey: string): Promise<BuyerRfq> {
  return (await api.post<{ rfq: BuyerRfq }>('/rfqs', input, { idempotencyKey })).rfq;
}

export async function saveRfqDraft(id: string, input: RfqDraftInput, expectedVersion: number): Promise<BuyerRfq> {
  return (await api.put<{ rfq: BuyerRfq }>(`/rfqs/${id}`, { ...input, expectedVersion })).rfq;
}

export async function deleteRfqDraft(id: string): Promise<void> {
  await api.delete(`/rfqs/${id}`);
}

export async function submitRfq(id: string, expectedVersion: number, idempotencyKey: string): Promise<BuyerRfq> {
  const { rfq } = await api.post<{ rfq: BuyerRfq }>(`/rfqs/${id}/submit`, { expectedVersion }, { idempotencyKey });
  track('rfq_submitted', '/account/rfqs/:id');
  return rfq;
}

/** Publish a new version of a sent requirement, with what changed and why. */
export async function amendRfqRequirement(
  id: string,
  requirement: RfqRequirement,
  expectedVersion: number,
  changeSummary: string,
): Promise<BuyerRfq> {
  return (await api.post<{ rfq: BuyerRfq }>(`/rfqs/${id}/versions`, { ...requirement, expectedVersion, changeSummary })).rfq;
}

export async function previewRfqMatches(id: string): Promise<MatchResult> {
  return api.get<MatchResult>(`/rfqs/${id}/matches`);
}

export async function searchRfqSuppliers(input: {
  q: string;
  categoryId: string | null;
  country: string | null;
}): Promise<SupplierCard[]> {
  return (
    await api.get<{ suppliers: SupplierCard[] }>('/rfqs/suppliers', {
      query: { q: input.q, categoryId: input.categoryId, country: input.country },
    })
  ).suppliers;
}

export async function inviteRfqSupplier(id: string, sellerAccountId: string): Promise<BuyerRfq> {
  return (await api.post<{ rfq: BuyerRfq }>(`/rfqs/${id}/invitations`, { sellerAccountId })).rfq;
}

export async function endRfq(
  id: string,
  action: 'cancel' | 'close',
  expectedVersion: number,
  reason: string | null,
): Promise<BuyerRfq> {
  return (await api.post<{ rfq: BuyerRfq }>(`/rfqs/${id}/${action}`, { expectedVersion, reason })).rfq;
}

export async function uploadRfqAttachment(path: string, file: File): Promise<RfqAttachment> {
  const form = new FormData();
  form.append('file', file);
  return (await postFile<{ attachment: RfqAttachment }>(path, form)).attachment;
}

export async function removeRfqAttachment(rfqId: string, attachmentId: string): Promise<void> {
  await api.delete(`/rfqs/${rfqId}/attachments/${attachmentId}`);
}

/** Where a file is downloaded from. Opened by the browser with the session cookie. */
export function rfqAttachmentUrl(base: '/rfqs' | '/seller/rfqs', rfqId: string, attachmentId: string): string {
  return `${BASE_URL}${base}/${rfqId}/attachments/${attachmentId}/download`;
}

export { newIdempotencyKey };

/** A file size a person reads: KB below a megabyte, MB with one decimal above. */
export function fileSize(bytes: number): string {
  return bytes < 1_048_576 ? `${String(Math.max(1, Math.round(bytes / 1024)))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** An instant in UTC as the deadline field shows it: `YYYY-MM-DDTHH:mm`. */
export function toDeadlineInput(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 16);
}

/** The field's `YYYY-MM-DDTHH:mm`, read as UTC, back to ISO 8601. */
export function fromDeadlineInput(value: string): string | null {
  if (value.length === 0) return null;
  const date = new Date(`${value}:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// --- Dashboard summary (Master row 15) -------------------------------------

export type RfqNextActionKind = 'FINISH_DRAFT' | 'REVIEW_OFFER' | 'DEADLINE_PASSED' | 'CONFIRM_SAMPLE' | 'DECIDE_SAMPLE';

export interface RfqNextAction {
  kind: RfqNextActionKind;
  rfqId: string;
  rfqReference: string;
  rfqTitle: string;
  quoteId: string | null;
  sampleReference: string | null;
  at: string;
}

/** Each block is null when the server could not measure it; the rest still stand. */
export interface RfqDashboardSummary {
  requests: { draft: number; open: number; awarded: number; closed: number } | null;
  quotes: { open: number; awaitingYou: number; shortlisted: number } | null;
  negotiations: { active: number; awaitingYou: number; accepted: number } | null;
  samples: { inProgress: number; awaitingYou: number; approved: number } | null;
  nextActions: RfqNextAction[] | null;
  unavailable: string[];
  generatedAt: string;
}

export async function fetchRfqSummary(): Promise<RfqDashboardSummary> {
  return api.get('/rfqs/summary');
}

/** Where a next action is done. */
export function nextActionHref(action: RfqNextAction): string {
  switch (action.kind) {
    case 'FINISH_DRAFT':
      return `/account/rfqs/${action.rfqId}/edit`;
    case 'REVIEW_OFFER':
      return action.quoteId === null
        ? `/account/rfqs/${action.rfqId}/compare`
        : `/account/rfqs/${action.rfqId}/quotes/${action.quoteId}`;
    case 'DEADLINE_PASSED':
      return `/account/rfqs/${action.rfqId}/compare`;
    case 'CONFIRM_SAMPLE':
    case 'DECIDE_SAMPLE':
      return `/account/rfqs/${action.rfqId}?tab=samples`;
  }
}

export interface RfqDestinationGuidanceData {
  country: string;
  categoryId: string | null;
  complianceNotes: string | null;
  blockedReason: string | null;
  notes: {
    effect: 'BLOCK' | 'DOCUMENTS_REQUIRED' | 'LABEL_REQUIRED';
    reason: string;
    requiredDocuments: string[];
    categoryName: string;
    minOrderValueMinor: string | null;
    thresholdCurrency: string | null;
    labelText: string | null;
  }[];
}

const destinationGuidanceResponse = z.object({
  country: z.string(), categoryId: z.string().nullable(), complianceNotes: z.string().nullable(), blockedReason: z.string().nullable(),
  notes: z.array(z.object({
    effect: z.enum(['BLOCK', 'DOCUMENTS_REQUIRED', 'LABEL_REQUIRED']), reason: z.string(), requiredDocuments: z.array(z.string()),
    categoryName: z.string(), minOrderValueMinor: z.string().nullable(), thresholdCurrency: z.string().nullable(), labelText: z.string().nullable(),
  })),
});
export async function fetchRfqDestinationGuidance(country: string, categoryId: string | null): Promise<RfqDestinationGuidanceData> {
  const result = destinationGuidanceResponse.parse(await api.get<unknown>('/rfqs/destination-guidance', { query: { country, categoryId } }));
  if (result.country !== country || result.categoryId !== categoryId) throw new Error('Invalid RFQ destination guidance response');
  return result;
}