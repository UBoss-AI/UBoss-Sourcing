/**
 * Claims (disputes) from the buyer's side (checklist Master row 24).
 *
 * The server owns the rules: which reasons are offered, the windows, who may
 * act next and every status change. The `can` block on a claim says what the
 * buyer may do now, and these screens offer exactly that and nothing else.
 */
import { BASE_URL, api, newIdempotencyKey, postFile } from '@/lib/api';
import { track } from '@/lib/analytics';
import type { Money } from '@/lib/format';

export type DisputeRemedy = 'REFUND_FULL' | 'REFUND_PARTIAL' | 'REPLACEMENT';

export interface ClaimContext {
  reasons: string[];
  remedies: DisputeRemedy[];
  claimWindowDays: number;
  sellerResponseHours: number;
  limits: { descriptionMin: number; descriptionMax: number; messageMax: number };
}

export interface DisputeSummary {
  reference: string;
  status: string;
  reasonCode: string;
  orderNumber: string;
  lineName: string | null;
  lastActivityAt: string;
  createdAt: string;
}

export interface DisputeView {
  reference: string;
  status: string;
  reasonCode: string;
  description: string;
  desiredOutcome: DisputeRemedy;
  requestedAmount: Money | null;
  currency?: string;
  order: { id: string | null; orderNumber: string; sellerOrderGroupId?: string | null; sellerOrderNumber?: string | null };
  line: { name: string; quantity: number } | null;
  seller: { name: string } | null;
  sellerProposal: { resolution: string; amount: Money | null } | null;
  decision: { resolution: string; amount: Money | null; reason: string | null; decidedAt: string | null; refund: { status: string; amount: Money | null } | null } | null;
  attachments: { id: string; fileName: string; party?: string; byteSize?: number; createdAt?: string }[];
  thread: {
    id: string;
    kind: string;
    author: string;
    body: string | null;
    toValue?: string | null;
    amount?: Money | null;
    createdAt: string;
  }[];
  /** Deadlines the reader is held to. */
  deadlines?: {
    sellerResponseDueAt: string | null;
    sellerResponseBreached: boolean;
    decisionDueAt: string | null;
    appealDueAt: string | null;
  };
  /**
   * The inspection behind the claim, as far as this reader may see it: a
   * seller sees signed reports, a buyer only what the inspection policy
   * releases to buyers. Status and result only.
   */
  inspection?: DisputeInspection[];
  can: {
    message: boolean;
    addEvidence: boolean;
    escalate: boolean;
    withdraw: boolean;
    appeal: boolean;
    /** Seller only: answer the claim, optionally with an offer. */
    respond?: boolean;
  };
  createdAt: string;
}

export interface DisputeInspection {
  sellerOrderGroupId: string;
  status: string;
  reports: { id: string; revision: number; status: string; result: string; signedAt: string | null }[];
  linkPath: string | null;
}

export interface ClaimInput {
  orderId: string;
  orderItemId: string | null;
  reasonCode: string;
  description: string;
  desiredOutcome: DisputeRemedy;
  requestedAmountMinor: string | null;
}

export const disputeKeys = {
  context: ['disputes', 'context'] as const,
  list: ['disputes'] as const,
  one: (reference: string) => ['disputes', reference] as const,
};

export const fetchClaimContext = (): Promise<ClaimContext> => api.get<ClaimContext>('/disputes/context');

export async function fetchDisputes(): Promise<DisputeSummary[]> {
  const result = await api.get<{ disputes: DisputeSummary[] }>('/disputes', { query: { limit: 50 } });
  return result.disputes;
}

export async function fetchDispute(reference: string): Promise<DisputeView> {
  return (await api.get<{ dispute: DisputeView }>(`/disputes/${reference}`)).dispute;
}

export async function createClaim(input: ClaimInput, key: string): Promise<{ dispute: DisputeView }> {
  const created = await api.post<{ dispute: DisputeView }>('/disputes', input, { idempotencyKey: key });
  track('dispute_opened', '/account/disputes/new');
  return created;
}

export function sendClaimMessage(reference: string, body: string): Promise<{ dispute: DisputeView }> {
  return api.post(`/disputes/${reference}/messages`, { body }, { idempotencyKey: newIdempotencyKey() });
}

export function claimAction(reference: string, action: 'escalate' | 'withdraw'): Promise<{ dispute: DisputeView }> {
  return api.post(`/disputes/${reference}/${action}`);
}

export function appealClaim(reference: string, body: string): Promise<{ dispute: DisputeView }> {
  return api.post(`/disputes/${reference}/appeal`, { body });
}

export function uploadClaimEvidence(reference: string, file: File): Promise<unknown> {
  const form = new FormData();
  form.append('file', file);
  return postFile(`/disputes/${reference}/attachments`, form);
}

// ---------------------------------------------------------------------------
// Opening a file on a claim (both sides)
// ---------------------------------------------------------------------------

export type DisputeSurface = 'BUYER' | 'SELLER';

const DISPUTE_BASE: Record<DisputeSurface, string> = { BUYER: '/disputes', SELLER: '/seller/disputes' };

/**
 * Open a file: ask for a five-minute, single-use link, then follow it. The
 * server answers the link as a download, never inline.
 */
export async function openDisputeAttachment(surface: DisputeSurface, reference: string, attachmentId: string): Promise<void> {
  const link = await api.post<{ url: string }>(
    `${DISPUTE_BASE[surface]}/${encodeURIComponent(reference)}/attachments/${attachmentId}/link`,
  );
  const apiOrigin = new URL(BASE_URL, window.location.origin).origin;
  window.location.assign(new URL(link.url, apiOrigin).toString());
}

// ---------------------------------------------------------------------------
// Seller Hub (JOURNEY-058)
// ---------------------------------------------------------------------------

export const sellerDisputeKeys = {
  // Separate branches, so refreshing the list never refetches an open claim
  // over the answer the server just returned.
  list: ['seller', 'disputes', 'list'] as const,
  one: (reference: string) => ['seller', 'disputes', 'one', reference] as const,
};

export async function fetchSellerDisputes(status: 'OPEN' | 'CLOSED' | null): Promise<DisputeSummary[]> {
  const result = await api.get<{ disputes: DisputeSummary[] }>('/seller/disputes', {
    query: { limit: 50, ...(status === null ? {} : { status }) },
  });
  return result.disputes;
}

export async function fetchSellerDispute(reference: string): Promise<DisputeView> {
  return (await api.get<{ dispute: DisputeView }>(`/seller/disputes/${reference}`)).dispute;
}

export interface SellerResponse {
  body: string;
  proposal: DisputeRemedy | null;
  proposalAmountMinor: string | null;
}

/** The seller's account of what happened, and optionally what they offer. */
export function respondToClaim(reference: string, input: SellerResponse): Promise<{ dispute: DisputeView }> {
  return api.post(`/seller/disputes/${reference}/response`, input);
}

export function sendSellerClaimMessage(reference: string, body: string): Promise<{ dispute: DisputeView }> {
  return api.post(`/seller/disputes/${reference}/messages`, { body }, { idempotencyKey: newIdempotencyKey() });
}

export function appealSellerClaim(reference: string, body: string): Promise<{ dispute: DisputeView }> {
  return api.post(`/seller/disputes/${reference}/appeal`, { body });
}

export function uploadSellerClaimEvidence(reference: string, file: File): Promise<unknown> {
  const form = new FormData();
  form.append('file', file);
  return postFile(`/seller/disputes/${reference}/attachments`, form);
}
