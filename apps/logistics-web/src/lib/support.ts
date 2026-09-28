/**
 * Support requests - the logistics portal's client.
 *
 * The server works out who is sending and for which company from the portal
 * session; nothing here claims either. A portal request cannot name an order:
 * a carrier's consignments are not orders it may look up by number, so the
 * shipment is described in the message instead.
 */
import { BASE_URL, api } from './api';

export const SUPPORT_CATEGORIES = [
  'LOGISTICS',
  'ORDERS',
  'PAYMENTS',
  'ACCOUNT_SECURITY',
  'ERP_INTEGRATION',
  'OTHER',
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export type SupportStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_FOR_CUSTOMER' | 'RESOLVED' | 'CLOSED';

export interface SupportContext {
  enabled: boolean;
  contacts: { email: string | null; phone: string | null };
  requester: {
    name: string;
    email: string;
    emailVerified: boolean;
    role: string;
    companyName: string | null;
    companyNameEditable: boolean;
    canReferenceOrder: boolean;
  };
  attachments: {
    available: boolean;
    reason: 'DISABLED' | 'NO_SCANNER' | null;
    maxBytes: number;
    maxFiles: number;
    types: string[];
  };
  limits: {
    nameMax: number;
    subjectMin: number;
    subjectMax: number;
    messageMin: number;
    messageMax: number;
  };
}

export interface SupportTicketSummary {
  reference: string;
  category: string;
  subject: string;
  status: SupportStatus;
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

export function fetchSupportContext(): Promise<SupportContext> {
  return api.get<SupportContext>('/logistics/support/context');
}

/** One key per attempt, reused on retry - a double-click sends one request. */
export function createSupportTicket(
  input: {
    category: SupportCategory;
    subject: string;
    message: string;
    language: string;
  },
  idempotencyKey: string,
): Promise<{ ticket: SupportTicket; acknowledgementQueued: boolean }> {
  return api.post('/logistics/support/tickets', input, { idempotencyKey });
}

export function fetchSupportTickets(): Promise<{ tickets: SupportTicketSummary[] }> {
  return api.get('/logistics/support/tickets');
}

export function fetchSupportTicket(reference: string): Promise<{ ticket: SupportTicket }> {
  return api.get(`/logistics/support/tickets/${encodeURIComponent(reference)}`);
}

export function addSupportMessage(
  reference: string,
  body: string,
  idempotencyKey: string,
): Promise<{ ticket: SupportTicket }> {
  return api.post(
    `/logistics/support/tickets/${encodeURIComponent(reference)}/messages`,
    { body },
    { idempotencyKey },
  );
}

/** Attach one file. One request per file, so a refused one costs only itself. */
export function uploadSupportAttachment(
  reference: string,
  file: File,
): Promise<{ attachment: SupportAttachment }> {
  const formData = new FormData();
  formData.append('file', file, file.name);
  return api.post(
    `/logistics/support/tickets/${encodeURIComponent(reference)}/attachments`,
    undefined,
    {
      formData,
    },
  );
}

/** Ask for a five-minute, single-use link, then follow it. Served as a download. */
export async function openSupportAttachment(
  reference: string,
  attachmentId: string,
): Promise<void> {
  const link = await api.post<{ url: string }>(
    `/logistics/support/tickets/${encodeURIComponent(reference)}/attachments/${attachmentId}/link`,
  );
  const apiOrigin = new URL(BASE_URL, window.location.origin).origin;
  window.location.assign(new URL(link.url, apiOrigin).toString());
}

/** Whether the picker should take this file before it is ever sent. */
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
