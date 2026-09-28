/**
 * Support tickets - the console's client for Support -> Tickets.
 *
 * Everything a sender can see, plus what only staff may: internal notes,
 * priority, assignment, and who did what. The related order's id arrives only
 * for somebody who may read orders; its number arrives for everyone, because
 * the sender typed it.
 */
import { ApiError, BASE_URL, NetworkError, api } from './api';
import type { ApiErrorBody } from './api';

export const SUPPORT_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_FOR_CUSTOMER',
  'RESOLVED',
  'CLOSED',
] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_CATEGORIES = [
  'ORDERS',
  'PAYMENTS',
  'PREORDERS',
  'PRODUCTS',
  'SELLER_HUB',
  'LOGISTICS',
  'COMPANY_VERIFICATION',
  'ERP_INTEGRATION',
  'ACCOUNT_SECURITY',
  'OTHER',
] as const;

export const SUPPORT_SOURCES = ['STOREFRONT', 'SELLER_HUB', 'LOGISTICS_PORTAL'] as const;

/**
 * Which moves the lifecycle allows from each status. The server is the
 * authority (`domain/support-ticket-state.ts`); this only decides which
 * buttons to offer, so nobody is shown a move that would be refused.
 */
export const STAFF_TRANSITIONS: Readonly<Record<SupportStatus, readonly SupportStatus[]>> = {
  OPEN: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

export interface StaffRef {
  id: string;
  email: string;
}

export interface AdminTicketRow {
  id: string;
  reference: string;
  category: string;
  subject: string;
  status: SupportStatus;
  priority: SupportPriority;
  source: string;
  requesterRole: string;
  requesterName: string;
  requesterEmail: string;
  companyName: string | null;
  relatedOrderNumber: string | null;
  assignee: StaffRef | null;
  lastActivityAt: string;
  createdAt: string;
}

export interface AdminTicketPage {
  tickets: AdminTicketRow[];
  counts: Partial<Record<SupportStatus, number>>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface AdminTicketEvent {
  id: string;
  kind:
    | 'CREATED'
    | 'REQUESTER_MESSAGE'
    | 'STAFF_REPLY'
    | 'INTERNAL_NOTE'
    | 'STATUS_CHANGED'
    | 'PRIORITY_CHANGED'
    | 'ASSIGNED';
  visibleToRequester: boolean;
  actorIsRequester: boolean;
  actor: StaffRef | null;
  body: string | null;
  fromValue: string | null;
  toValue: string | null;
  createdAt: string;
}

export interface AdminTicket {
  id: string;
  reference: string;
  category: string;
  subject: string;
  message: string;
  status: SupportStatus;
  priority: SupportPriority;
  source: string;
  language: string | null;
  requester: {
    userId: string;
    role: string;
    name: string;
    email: string;
    currentEmail: string;
    accountStatus: string;
    companyName: string | null;
    customerProfileId: string | null;
    buyerCompany: { id: string; legalName: string | null; applicationReference: string } | null;
    seller: { id: string; displayName: string } | null;
    logisticsPartner: { id: string; displayName: string } | null;
  };
  relatedOrder: { orderNumber: string; id: string | null } | null;
  assignee: StaffRef | null;
  /** Files the sender attached: images, videos and PDFs. */
  attachments: {
    id: string;
    fileName: string;
    contentType: string;
    kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
    byteSize: number;
    createdAt: string;
  }[];
  lastActivityAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  events: AdminTicketEvent[];
}

export function fetchTickets(params: URLSearchParams): Promise<AdminTicketPage> {
  return api.get(`/admin/support-tickets?${params.toString()}`);
}

export function fetchTicket(id: string): Promise<{ ticket: AdminTicket }> {
  return api.get(`/admin/support-tickets/${encodeURIComponent(id)}`);
}

export function fetchAssignees(): Promise<{ assignees: StaffRef[] }> {
  return api.get('/admin/support-tickets/assignees');
}

export function replyToTicket(
  id: string,
  input: { body: string; nextStatus: SupportStatus | null },
): Promise<{ ticket: AdminTicket; emailQueued: boolean }> {
  return api.post(`/admin/support-tickets/${encodeURIComponent(id)}/replies`, input);
}

export function addInternalNote(id: string, body: string): Promise<{ ticket: AdminTicket }> {
  return api.post(`/admin/support-tickets/${encodeURIComponent(id)}/notes`, { body });
}

export function updateTicket(
  id: string,
  input: { status?: SupportStatus; priority?: SupportPriority },
): Promise<{ ticket: AdminTicket }> {
  return api.patch(`/admin/support-tickets/${encodeURIComponent(id)}`, input);
}

export function assignTicket(
  id: string,
  assigneeUserId: string | null,
): Promise<{ ticket: AdminTicket }> {
  return api.post(`/admin/support-tickets/${encodeURIComponent(id)}/assignment`, {
    assigneeUserId,
  });
}

/**
 * The bytes of one file on a ticket, fetched into the page.
 *
 * A five-minute, single-use link for this session, redeemed at once over the
 * session's own credentials. Every redemption is recorded in the audit log, so
 * this is only ever called because somebody asked to look.
 *
 * The server serves the file as a download under a sandboxing policy and never
 * inline, and that stays true: the page does not navigate to the file. It
 * holds the bytes as a Blob, which the viewer shows as an image (a raster type
 * the server sniffed from the bytes - never SVG, never HTML) or hands to the
 * browser as a download. Nothing a customer uploaded is ever run as a page.
 */
export async function fetchTicketAttachment(ticketId: string, attachmentId: string): Promise<Blob> {
  const link = await api.post<{ url: string }>(
    `/admin/support-tickets/${encodeURIComponent(ticketId)}/attachments/${attachmentId}/link`,
  );
  const apiOrigin = new URL(BASE_URL, window.location.origin).origin;

  let response: Response;
  try {
    response = await fetch(new URL(link.url, apiOrigin).toString(), { credentials: 'include' });
  } catch {
    throw new NetworkError('The file could not be fetched.');
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(response.status, body ?? { code: 'INTERNAL_ERROR', message: 'The file could not be opened.' });
  }

  return response.blob();
}

/** Hand a file the page already holds to the browser as a download. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

/** Download one file on a ticket without leaving the page. */
export async function downloadTicketAttachment(
  ticketId: string,
  attachment: { id: string; fileName: string },
): Promise<void> {
  saveBlob(await fetchTicketAttachment(ticketId, attachment.id), attachment.fileName);
}

/** A size a person reads: 850 KB, 12.4 MB. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / 1_048_576).toFixed(1).replace(/\.0$/, '')} MB`;
}
