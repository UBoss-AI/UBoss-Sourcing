/**
 * The Preorder Chats inbox: what the console sends and reads.
 *
 * Customer <-> the operator's staff. The seller of the product is not a party
 * and sees none of this. Filtering, searching, sorting and paging all happen
 * on the server; the inbox never loads a conversation's history until it is
 * opened.
 */
import { api, BASE_URL, downloadFile } from './api';
import { newIdempotencyKey } from './forms';

export type ChatStatus =
  | 'NEW'
  | 'OPEN'
  | 'WAITING_FOR_CUSTOMER'
  | 'WAITING_FOR_INTERNAL'
  | 'RESOLVED'
  | 'CLOSED'
  | 'SPAM'
  | 'BLOCKED';

export const CHAT_STATUSES: readonly ChatStatus[] = [
  'NEW',
  'OPEN',
  'WAITING_FOR_CUSTOMER',
  'WAITING_FOR_INTERNAL',
  'RESOLVED',
  'CLOSED',
  'SPAM',
  'BLOCKED',
];

export type ChatPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export const CHAT_PRIORITIES: readonly ChatPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export const INBOX_FILTERS = [
  'all',
  'unassigned',
  'mine',
  'unread',
  'priority',
  'open',
  'waiting_customer',
  'waiting_internal',
  'resolved',
  'closed',
  'spam',
] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export const INBOX_SORTS = ['newest', 'oldest_unanswered', 'priority', 'longest_waiting'] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export type ChatOrderingUnit = 'PIECE' | 'CONTAINER_20_FT' | 'CONTAINER_40_FT';
export const CHAT_ORDERING_UNITS: readonly ChatOrderingUnit[] = ['PIECE', 'CONTAINER_20_FT', 'CONTAINER_40_FT'];

export interface InboxConversation {
  id: string;
  status: ChatStatus;
  priority: ChatPriority;
  customer: {
    profileId: string;
    name: string | null;
    organization: string | null;
    /** Null unless the viewer may read customers. */
    email: string | null;
    blocked: boolean;
  };
  product: { id: string; name: string; sku: string | null; imageUrl: string | null; variantName: string | null };
  seller: { id: string | null; name: string | null };
  preorder: { id: string; requestNumber: string | null; status: string | null } | null;
  assignedTo: { id: string; email: string } | null;
  tags: string[];
  lastMessagePreview: string | null;
  lastMessageSender: 'CUSTOMER' | 'ADMIN' | 'SYSTEM' | null;
  lastMessageAt: string;
  unreadCount: number;
  awaitingReplySince: string | null;
  waitingMinutes: number | null;
  reopenCount: number;
  createdAt: string;
}

export interface ChatSnapshot {
  version: 1;
  capturedAt: string;
  product: { id: string; name: string; slug: string; sku: string; imageUrl: string | null };
  variant: { id: string; name: string; sku: string } | null;
  seller: { name: string; isOperator: boolean };
  preorder: {
    available: boolean;
    minimumBaseUnits: number | null;
    moqUnit: string | null;
    moqQuantity: number | null;
    unitSizes: { unit: ChatOrderingUnit; baseUnits: number | null }[];
  };
  request: {
    orderingUnit: ChatOrderingUnit;
    unitQuantity: number | null;
    baseUnits: number | null;
    desiredDeliveryDate: string | null;
  };
}

export interface ConversationDetail extends InboxConversation {
  customerLocale: string;
  context: ChatSnapshot | null;
  currentProduct: { id: string; name: string; slug: string; isLive: boolean } | null;
  /** What a proposal's indicative price is quoted in. */
  pricingCurrency: string;
  receipts: { deliveredSeq: number; readSeq: number };
  lastSequence: number;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  assignedAt: string | null;
  block: { reason: string; createdAt: string } | null;
  preorderIsOperators: boolean | null;
  version: number;
}

export interface ChatProposal {
  id: string;
  revision: number;
  state: 'PROPOSED' | 'SUPERSEDED' | 'WITHDRAWN' | 'DECLINED' | 'SUBMITTED' | 'EXPIRED';
  orderingUnit: ChatOrderingUnit;
  unitQuantity: number;
  equivalentBaseUnits: number;
  indicativeUnitPriceMinor: string | null;
  currency: string;
  availabilityNote: string | null;
  deliveryDate: string;
  splitDeliveries: { date: string; baseUnits: number }[];
  termsNote: string | null;
  expiresAt: string;
  preorderRequestId: string | null;
  respondedAt: string | null;
  declineReason: string | null;
  createdAt: string;
}

export interface StaffMessage {
  id: string;
  seq: number;
  senderType: 'CUSTOMER' | 'ADMIN' | 'SYSTEM';
  senderName?: string | null;
  senderUserId?: string | null;
  messageType: 'TEXT' | 'ATTACHMENT' | 'SYSTEM_EVENT' | 'STRUCTURED_OFFER';
  body: string;
  systemEvent: string | null;
  systemMeta: Record<string, string | number | boolean | null>;
  proposal: ChatProposal | null;
  attachment: { id: string; fileName: string; contentType: string; byteSize: number; downloadable: boolean } | null;
  createdAt: string;
  deliveredAt: string | null;
  redacted: boolean;
  redactionReason?: string | null;
  clientMessageId?: string;
}

export interface InternalNote {
  id: string;
  body: string;
  authorUserId: string;
  authorEmail: string | null;
  createdAt: string;
}

export interface ChatActivity {
  id: string;
  action: string;
  actorType: string;
  actorEmail: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface ChatOperations {
  queue: { open: number; unassigned: number; awaitingReply: number; approachingSla: number; breachedSla: number };
  last30Days: {
    conversations: number;
    averageFirstResponseSeconds: number | null;
    averageResolutionSeconds: number | null;
    reopened: number;
  };
  slaMinutes: number;
  thisProcess: { deliveryFailures: number; socketFailures: number; busFailures: number };
}

/** The inbox. `AppShell` frames it as an application pane rather than a page. */
export const PREORDER_CHATS_PATH = '/preorder-chats';

export function isPreorderChatsPath(pathname: string): boolean {
  return pathname === PREORDER_CHATS_PATH || pathname.startsWith(`${PREORDER_CHATS_PATH}/`);
}

export const inboxKeys = {
  all: ['preorder-chats'] as const,
  list: (filter: InboxFilter, sort: InboxSort, q: string) => ['preorder-chats', 'list', filter, sort, q] as const,
  counts: ['preorder-chats', 'counts'] as const,
  operations: ['preorder-chats', 'operations'] as const,
  detail: (id: string) => ['preorder-chats', 'detail', id] as const,
  notes: (id: string) => ['preorder-chats', 'notes', id] as const,
  activity: (id: string) => ['preorder-chats', 'activity', id] as const,
  proposals: (id: string) => ['preorder-chats', 'proposals', id] as const,
  assignees: ['preorder-chats', 'assignees'] as const,
};

export function fetchInbox(query: {
  filter: InboxFilter;
  sort: InboxSort;
  q: string;
  cursor?: string | undefined;
}): Promise<{ conversations: InboxConversation[]; nextCursor: string | null }> {
  return api.get('/admin/preorder-chats', {
    query: { filter: query.filter, sort: query.sort, q: query.q, cursor: query.cursor, limit: 25 },
  });
}

export function fetchInboxCounts(): Promise<{ counts: Record<InboxFilter, number> }> {
  return api.get('/admin/preorder-chats/counts');
}

export function fetchOperations(): Promise<ChatOperations> {
  return api.get('/admin/preorder-chats/operations');
}

export function fetchConversation(id: string): Promise<{ conversation: ConversationDetail }> {
  return api.get(`/admin/preorder-chats/${id}`);
}

export function fetchMessages(
  id: string,
  query: { after?: number; before?: number; limit?: number },
): Promise<{ messages: StaffMessage[]; hasMore: boolean }> {
  return api.get(`/admin/preorder-chats/${id}/messages`, { query });
}

export function sendReply(id: string, clientMessageId: string, body: string) {
  return api.post<{ message: StaffMessage; conversation: InboxConversation; duplicate: boolean }>(
    `/admin/preorder-chats/${id}/messages`,
    { clientMessageId, body, replyToMessageId: null },
  );
}

export function markRead(id: string, seq: number) {
  return api.post<{ readSeq: number }>(`/admin/preorder-chats/${id}/read`, { seq });
}

export function assign(id: string, assigneeUserId: string | null) {
  return api.post<InboxConversation>(`/admin/preorder-chats/${id}/assign`, { assigneeUserId });
}

export function fetchAssignees(): Promise<{ assignees: { id: string; email: string }[] }> {
  return api.get('/admin/preorder-chats/assignees');
}

export function changeStatus(id: string, status: ChatStatus, reason: string | null) {
  return api.post<InboxConversation>(`/admin/preorder-chats/${id}/status`, { status, reason });
}

export function setPriority(id: string, priority: ChatPriority) {
  return api.post<InboxConversation>(`/admin/preorder-chats/${id}/priority`, { priority });
}

export function setTags(id: string, tags: string[]) {
  return api.put<InboxConversation>(`/admin/preorder-chats/${id}/tags`, { tags });
}

export function fetchNotes(id: string): Promise<{ notes: InternalNote[] }> {
  return api.get(`/admin/preorder-chats/${id}/notes`);
}

export function addNote(id: string, body: string) {
  return api.post<InternalNote>(`/admin/preorder-chats/${id}/notes`, { body });
}

export function fetchActivity(id: string): Promise<{ activity: ChatActivity[] }> {
  return api.get(`/admin/preorder-chats/${id}/activity`);
}

export function linkPreorder(id: string, preorderRequestId: string | null) {
  return api.post<InboxConversation>(`/admin/preorder-chats/${id}/preorder`, { preorderRequestId });
}

export interface ProposalInput {
  orderingUnit: ChatOrderingUnit;
  unitQuantity: number;
  indicativeUnitPriceMinor: string | null;
  availabilityNote: string | null;
  deliveryDate: string;
  splitDeliveries: { date: string; baseUnits: number }[];
  termsNote: string | null;
  expiresInHours: number;
}

export function fetchProposals(id: string): Promise<{ proposals: ChatProposal[] }> {
  return api.get(`/admin/preorder-chats/${id}/proposals`);
}

export function createProposal(id: string, input: ProposalInput) {
  return api.post<ChatProposal>(`/admin/preorder-chats/${id}/proposals`, input);
}

export function withdrawProposal(id: string, proposalId: string) {
  return api.post<ChatProposal>(`/admin/preorder-chats/${id}/proposals/${proposalId}/withdraw`);
}

export function redact(id: string, messageId: string, reason: string) {
  return api.post<StaffMessage>(`/admin/preorder-chats/${id}/messages/${messageId}/redact`, { reason });
}

export function blockCustomer(id: string, reason: string) {
  return api.post<InboxConversation>(`/admin/preorder-chats/${id}/block`, { reason });
}

export function unblockCustomer(id: string) {
  return api.post<InboxConversation>(`/admin/preorder-chats/${id}/unblock`);
}

export function exportTranscript(id: string): Promise<void> {
  return downloadFile(`/admin/preorder-chats/${id}/export`, `preorder-chat-${id}.json`);
}

export async function openAttachment(conversationId: string, attachmentId: string): Promise<void> {
  const link = await api.post<{ url: string }>(
    `/admin/preorder-chats/${conversationId}/attachments/${attachmentId}/link`,
  );
  const apiOrigin = new URL(BASE_URL, window.location.origin).origin;
  window.location.assign(new URL(link.url, apiOrigin).toString());
}

export function newClientMessageId(): string {
  return newIdempotencyKey();
}

export function mergeMessages(current: StaffMessage[], incoming: StaffMessage[]): StaffMessage[] {
  const bySeq = new Map(current.map((message) => [message.seq, message]));
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Same rule in both apps: see `chat-kit/timeline.ts`. */
export { linkify, type TextPart } from './chat-kit/timeline';

/** A wait as people say it: minutes, then hours, then days. */
export function waitLabel(minutes: number): { unit: 'm' | 'h' | 'd'; value: number } {
  if (minutes < 60) return { unit: 'm', value: minutes };
  if (minutes < 60 * 48) return { unit: 'h', value: Math.floor(minutes / 60) };
  return { unit: 'd', value: Math.floor(minutes / 1440) };
}
