/**
 * Requests for quotation: the Seller Hub's side of the API (Master rows 17-19).
 */
import { api } from './api';
import type { AttachmentPolicy, InvitationStatus, RfqAttachment, RfqRequirement, RfqStatus, RfqVersionSummary } from './rfq';

export const SELLER_RFQ_FILTERS = ['action', 'quoted', 'closed', 'all', 'hidden'] as const;
export type SellerRfqFilter = (typeof SELLER_RFQ_FILTERS)[number];

/** `me`, `unassigned` or a team member's id; left out, every request. */
export type SellerRfqAssignee = string;

/** How well this seller fits the request (JOURNEY-030). Score 0-100. */
export interface SellerRfqQualification {
  score: number;
  reasons: ('LIVE_IN_CATEGORY' | 'EXPORTS_TO_DESTINATION' | 'VERIFIED_CERTIFICATE')[];
  flags: ('CAPACITY_UNKNOWN' | 'CAPACITY_BELOW_QUANTITY' | 'OPEN_DISPUTE' | 'NOT_LIVE_IN_CATEGORY' | 'NO_CATEGORY')[];
}

export type BuyerVerification = 'VERIFIED_BUSINESS' | 'BUSINESS_PENDING' | 'BUSINESS_NOT_VERIFIED' | 'INDIVIDUAL';

interface InboxFields {
  qualification: SellerRfqQualification;
  buyerVerification: BuyerVerification;
  hidden: boolean;
  assignedMember: { id: string; name: string } | null;
}

export interface SellerRfqListItem extends InboxFields {
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

export interface SellerRfq extends InboxFields {
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
  assignee?: SellerRfqAssignee,
): Promise<{ items: SellerRfqListItem[]; counts: Record<SellerRfqFilter, number> }> {
  return api.get('/seller/rfqs', { query: assignee === undefined ? { filter } : { filter, assignee } });
}

export async function fetchRfqAssignees(): Promise<{ id: string; name: string }[]> {
  return (await api.get<{ members: { id: string; name: string }[] }>('/seller/rfqs/assignees')).members;
}

export async function setSellerRfqHidden(id: string, hidden: boolean): Promise<SellerRfq> {
  return (await api.post<{ rfq: SellerRfq }>(`/seller/rfqs/${id}/${hidden ? 'hide' : 'unhide'}`, {})).rfq;
}

export async function assignSellerRfq(id: string, memberId: string | null): Promise<SellerRfq> {
  return (await api.post<{ rfq: SellerRfq }>(`/seller/rfqs/${id}/assign`, { memberId })).rfq;
}

export async function fetchSellerRfq(id: string): Promise<SellerRfq> {
  return (await api.get<{ rfq: SellerRfq }>(`/seller/rfqs/${id}`)).rfq;
}

export async function declineSellerRfq(id: string, reason: string): Promise<SellerRfq> {
  return (await api.post<{ rfq: SellerRfq }>(`/seller/rfqs/${id}/decline`, { reason })).rfq;
}
