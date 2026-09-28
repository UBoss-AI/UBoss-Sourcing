/**
 * Support requests - the storefront's and Seller Hub's client.
 *
 * Two surfaces, one shape. The storefront sends as the buyer the session is
 * buying as; Seller Hub sends as the seller the Hub is open for. Which one is
 * decided by the base path, and the server works out everything else - who
 * the sender is, whom they act for, which orders they may name - from the
 * session. Nothing here claims an identity.
 */
import { BASE_URL, api, postFile } from './api';

export type SupportSurface = 'storefront' | 'seller';

const BASE: Record<SupportSurface, string> = {
  storefront: '/support',
  seller: '/seller/support',
};

/** Where the sender reads their requests, on each surface. */
export const SUPPORT_TICKETS_PATH: Record<SupportSurface, string> = {
  storefront: '/account/support',
  seller: '/seller/support/requests',
};

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

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export type SupportStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_FOR_CUSTOMER' | 'RESOLVED' | 'CLOSED';

export type SupportRequesterRole = 'BUYER' | 'COMPANY_BUYER' | 'SELLER' | 'LOGISTICS_PARTNER';

export interface SupportContext {
  enabled: boolean;
  contacts: { email: string | null; phone: string | null };
  requester: {
    name: string;
    email: string;
    emailVerified: boolean;
    role: SupportRequesterRole;
    companyName: string | null;
    companyNameEditable: boolean;
    canReferenceOrder: boolean;
  };
  /** Whether files can be attached here, and the rules the picker shows. */
  attachments: {
    available: boolean;
    reason: 'DISABLED' | 'NO_SCANNER' | null;
    maxBytes: number;
    maxFiles: number;
    types: string[];
  };
  limits: {
    nameMax: number;
    companyNameMax: number;
    subjectMin: number;
    subjectMax: number;
    messageMin: number;
    messageMax: number;
    orderNumberMax: number;
    perDay: number;
  };
}

export interface SupportTicketSummary {
  reference: string;
  category: SupportCategory;
  subject: string;
  status: SupportStatus;
  relatedOrderNumber: string | null;
  lastActivityAt: string;
  createdAt: string;
}

export interface SupportThreadEntry {
  id: string;
  kind: 'REQUESTER_MESSAGE' | 'STAFF_REPLY' | 'STATUS_CHANGED';
  author: 'REQUESTER' | 'TEAM';
  body: string | null;
  status: SupportStatus | null;
  createdAt: string;
}

export interface SupportAttachment {
  id: string;
  fileName: string;
  contentType: string;
  kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  byteSize: number;
  createdAt: string;
}

export interface SupportTicket extends SupportTicketSummary {
  message: string;
  attachments: SupportAttachment[];
  companyName: string | null;
  canReply: boolean;
  thread: SupportThreadEntry[];
}

export interface SupportRequestInput {
  /** Optional: the server uses the account's name. */
  name?: string | null;
  companyName?: string | null;
  category: SupportCategory;
  subject: string;
  message: string;
  orderNumber?: string | null;
  language?: string | null;
}

export function fetchSupportContext(surface: SupportSurface): Promise<SupportContext> {
  return api.get<SupportContext>(`${BASE[surface]}/context`);
}

/**
 * Send a request. `idempotencyKey` is made once per attempt by the caller and
 * reused for its retries, so a double-click or a retried network call sends
 * one request - see `newIdempotencyKey`.
 */
export function createSupportTicket(
  surface: SupportSurface,
  input: SupportRequestInput,
  idempotencyKey: string,
): Promise<{ ticket: SupportTicket; acknowledgementQueued: boolean }> {
  return api.post(`${BASE[surface]}/tickets`, input, { idempotencyKey });
}

export function fetchSupportTickets(
  surface: SupportSurface,
  page = 1,
): Promise<{
  tickets: SupportTicketSummary[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  return api.get(`${BASE[surface]}/tickets`, { query: { page } });
}

export function fetchSupportTicket(
  surface: SupportSurface,
  reference: string,
): Promise<{ ticket: SupportTicket }> {
  return api.get(`${BASE[surface]}/tickets/${encodeURIComponent(reference)}`);
}

export function addSupportMessage(
  surface: SupportSurface,
  reference: string,
  body: string,
  idempotencyKey: string,
): Promise<{ ticket: SupportTicket }> {
  return api.post(
    `${BASE[surface]}/tickets/${encodeURIComponent(reference)}/messages`,
    { body },
    { idempotencyKey },
  );
}

/**
 * Attach one file to a ticket. One request per file, so each can fail - too
 * large, the wrong type - on its own without costing the others.
 */
export function uploadSupportAttachment(
  surface: SupportSurface,
  reference: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<{ attachment: SupportAttachment }> {
  const form = new FormData();
  form.append('file', file, file.name);
  return postFile(`${BASE[surface]}/tickets/${encodeURIComponent(reference)}/attachments`, form, {
    ...(onProgress === undefined ? {} : { onProgress }),
  });
}

/**
 * Open a file: ask for a five-minute, single-use link, then follow it. The
 * server answers the link as a download, never inline.
 */
export async function openSupportAttachment(
  surface: SupportSurface,
  reference: string,
  attachmentId: string,
): Promise<void> {
  const link = await api.post<{ url: string }>(
    `${BASE[surface]}/tickets/${encodeURIComponent(reference)}/attachments/${attachmentId}/link`,
  );
  const apiOrigin = new URL(BASE_URL, window.location.origin).origin;
  window.location.assign(new URL(link.url, apiOrigin).toString());
}

/** Whether the picker should accept this file before it is ever sent. */
export function checkSupportFile(
  file: File,
  rules: { maxBytes: number; types: readonly string[] },
): 'TYPE' | 'SIZE' | null {
  if (!rules.types.includes(file.type)) return 'TYPE';
  if (file.size > rules.maxBytes) return 'SIZE';
  return null;
}

/** A size a person reads: 850 KB, 12.4 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / 1_048_576).toFixed(1).replace(/\.0$/, '')} MB`;
}
