/**
 * Requests for quotation: the Seller Hub's side of the API (Master rows 17-19).
 */
import { api } from './api';
import type { AttachmentPolicy, InvitationStatus, RfqAttachment, RfqRequirement, RfqStatus, RfqVersionSummary } from './rfq';

export const SELLER_RFQ_FILTERS = ['action', 'quoted', 'closed', 'all'] as const;
export type SellerRfqFilter = (typeof SELLER_RFQ_FILTERS)[number];

export interface SellerRfqListItem {
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
  invitationStatus: InvitationStatus;
  currentRequirementVersion: number;
  invitedAt: string;
}

export interface SellerRfq {
  id: string;
  reference: string;
  status: RfqStatus;
  isPastDeadline: boolean;
  requirement: RfqRequirement;
  category: { id: string; name: string } | null;
  currentRequirementVersion: number;
  buyer: { kind: 'INDIVIDUAL' } | { kind: 'COMPANY'; companyName: string };
  invitation: {
    id: string;
    status: InvitationStatus;
    source: string;
    invitedAt: string;
    viewedAt: string | null;
    respondedAt: string | null;
    declineReason: string | null;
    notifiedVersion: number;
  };
  versions: RfqVersionSummary[];
  attachments: RfqAttachment[];
  attachmentPolicy: AttachmentPolicy;
  timeline: { id: string; kind: string; actor: 'BUYER' | 'SUPPLIER' | 'SYSTEM'; meta: Record<string, unknown> | null; at: string }[];
  actions: { canAsk: boolean; canDecline: boolean; canQuote: boolean };
}

export async function fetchSellerRfqs(
  filter: SellerRfqFilter,
): Promise<{ items: SellerRfqListItem[]; counts: Record<SellerRfqFilter, number> }> {
  return api.get('/seller/rfqs', { query: { filter } });
}

export async function fetchSellerRfq(id: string): Promise<SellerRfq> {
  return (await api.get<{ rfq: SellerRfq }>(`/seller/rfqs/${id}`)).rfq;
}

export async function declineSellerRfq(id: string, reason: string): Promise<SellerRfq> {
  return (await api.post<{ rfq: SellerRfq }>(`/seller/rfqs/${id}/decline`, { reason })).rfq;
}
