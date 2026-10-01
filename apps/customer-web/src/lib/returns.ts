/**
 * Returns and refunds from the buyer's side (checklist Master row 30).
 *
 * The server owns every rule: which lines can go back, the window, which
 * reasons need photographs, and every status change. This file only carries
 * its answers.
 */
import { api, newIdempotencyKey, postFile } from '@/lib/api';
import { track } from '@/lib/analytics';
import type { Money } from '@/lib/format';

export const RETURN_REASONS = [
  'DAMAGED_IN_TRANSIT',
  'DEFECTIVE',
  'WRONG_ITEM',
  'NOT_AS_DESCRIBED',
  'MISSING_PARTS',
  'EXPIRED_OR_SHORT_DATED',
  'ORDERED_BY_MISTAKE',
  'NO_LONGER_NEEDED',
  'OTHER',
] as const;

export type ReturnStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'RECEIVED' | 'INSPECTED' | 'COMPLETED';

export interface ReturnEligibility {
  orderId: string;
  orderNumber: string;
  eligible: boolean;
  reason: string | null;
  windowDays: number;
  reasonCodes: string[];
  evidenceRequired: string[];
  replacementEnabled: boolean;
  files: { available: boolean; maxBytes: number; maxFiles: number; types: string[] };
  groups: {
    sellerOrderGroupId: string | null;
    sellerName: string | null;
    windowClosesAt: string | null;
    open: boolean;
    lines: { orderItemId: string; name: string; sku: string; variantName: string | null; returnable: number; unitValue: Money }[];
  }[];
}

export interface ReturnSummary {
  id: string;
  reference: string;
  orderId: string;
  orderNumber: string;
  status: ReturnStatus;
  reasonCode: string | null;
  description: string;
  preferredResolution: string;
  decisionNote: string | null;
  returnInstructions: string | null;
  resolutionNote: string | null;
  createdAt: string;
  lines: { orderItemId: string; name: string; quantity: number; value: Money }[];
  value: Money;
  refund: { status: string; amount: Money; createdAt: string; completedAt: string | null } | null;
  files: { id: string; fileName: string }[];
  timeline: { kind: string; toStatus: string | null; note: string | null; actorType: string; createdAt: string }[];
}

export interface ReturnRequestInput {
  reasonCode: string;
  description: string | null;
  preferredResolution: 'REFUND' | 'REPLACEMENT';
  items: { orderItemId: string; quantity: number }[];
}

export const returnKeys = {
  list: ['returns'] as const,
  one: (id: string) => ['returns', id] as const,
  eligibility: (orderId: string) => ['returns', 'eligibility', orderId] as const,
};

export function fetchReturnEligibility(orderId: string): Promise<ReturnEligibility> {
  return api.get<ReturnEligibility>(`/orders/${orderId}/returns/eligibility`);
}

export async function fetchReturns(): Promise<ReturnSummary[]> {
  const result = await api.get<{ returns: ReturnSummary[] }>('/returns', { query: { limit: 100 } });
  return result.returns;
}

export async function fetchReturn(id: string): Promise<ReturnSummary> {
  const result = await api.get<{ return: ReturnSummary }>(`/returns/${id}`);
  return result.return;
}

/** Sends the request, with its photographs when there are any, under one idempotency key. */
export async function createReturn(
  orderId: string,
  input: ReturnRequestInput,
  files: File[],
  key: string = newIdempotencyKey(),
): Promise<{ return: ReturnSummary }> {
  let created: { return: ReturnSummary };
  if (files.length === 0) {
    created = await api.post(`/orders/${orderId}/returns`, input, { idempotencyKey: key });
  } else {
    const form = new FormData();
    form.append('payload', JSON.stringify(input));
    for (const file of files) form.append('files', file);
    created = await postFile(`/orders/${orderId}/returns`, form, { idempotencyKey: key });
  }
  track('return_requested', '/account/orders/:id/return');
  return created;
}
