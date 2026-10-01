/**
 * Claims (disputes) from the buyer's side (checklist Master row 24).
 *
 * The server owns the rules: which reasons are offered, the windows, who may
 * act next and every status change. The `can` block on a claim says what the
 * buyer may do now, and these screens offer exactly that and nothing else.
 */
import { api, newIdempotencyKey, postFile } from '@/lib/api';
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
  order: { id: string | null; orderNumber: string };
  line: { name: string; quantity: number } | null;
  seller: { name: string } | null;
  sellerProposal: { resolution: string; amount: Money | null } | null;
  decision: { resolution: string; amount: Money | null; reason: string | null; decidedAt: string | null; refund: { status: string; amount: Money | null } | null } | null;
  attachments: { id: string; fileName: string }[];
  thread: { id: string; kind: string; author: string; body: string | null; createdAt: string }[];
  can: { message: boolean; addEvidence: boolean; escalate: boolean; withdraw: boolean; appeal: boolean };
  createdAt: string;
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
