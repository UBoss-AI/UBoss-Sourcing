/**
 * Preorder chat: what the storefront sends and reads.
 *
 * The customer talks to the UBOSS team - the operator's own staff - about a
 * product. Never to the seller. Everything the drawer shows about the product
 * comes back from the server, which reads it from the catalogue; the browser
 * only says which product, option, unit, quantity and date it is asking about.
 */
import { api, BASE_URL, newIdempotencyKey, postFile } from './api';
import type { FaqAnswer, SignedAnswer } from './preorder-assistant';

export type ChatOrderingUnit = 'PIECE' | 'CONTAINER_20_FT' | 'CONTAINER_40_FT';
export const CHAT_ORDERING_UNITS: readonly ChatOrderingUnit[] = ['PIECE', 'CONTAINER_20_FT', 'CONTAINER_40_FT'];

export interface ChatContextInput {
  productId: string;
  variantId: string | null;
  orderingUnit: ChatOrderingUnit;
  unitQuantity: number | null;
  desiredDeliveryDate: string | null;
}

export interface ChatContextCard {
  product: { id: string; name: string; slug: string; sku: string; imageUrl: string | null };
  variant: { id: string; name: string; sku: string } | null;
  sellerName: string;
  preorder: {
    available: boolean;
    minimumBaseUnits: number | null;
    moqUnit: string | null;
    moqQuantity: number | null;
  };
  request: {
    orderingUnit: ChatOrderingUnit;
    unitQuantity: number | null;
    baseUnits: number | null;
    desiredDeliveryDate: string | null;
  };
  capturedAt: string;
}

export type CustomerChatStatus = 'OPEN' | 'AWAITING_YOU' | 'RESOLVED' | 'CLOSED' | 'BLOCKED';

export interface CustomerConversation {
  id: string;
  status: CustomerChatStatus;
  canSend: boolean;
  context: ChatContextCard | null;
  preorder: { id: string; requestNumber: string | null } | null;
  lastSequence: number;
  unreadCount: number;
  receipts: { deliveredSeq: number; readSeq: number };
  lastMessagePreview: string | null;
  lastMessageFromMe: boolean;
  lastMessageAt: string;
  /**
   * The customer asked the assistant for a person and nobody has replied
   * since. Says the request is queued - never that anybody is connected.
   */
  humanRequested: boolean;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export type ProposalState = 'PROPOSED' | 'SUPERSEDED' | 'WITHDRAWN' | 'DECLINED' | 'SUBMITTED' | 'EXPIRED';

export interface ChatProposal {
  id: string;
  revision: number;
  state: ProposalState;
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
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  seq: number;
  /** AUTOMATION is the preorder assistant: never a person, and never shown as one. */
  senderType: 'CUSTOMER' | 'ADMIN' | 'SYSTEM' | 'AUTOMATION';
  messageType:
    | 'TEXT'
    | 'ATTACHMENT'
    | 'SYSTEM_EVENT'
    | 'STRUCTURED_OFFER'
    | 'FAQ_QUESTION'
    | 'AUTOMATED_REPLY'
    | 'HANDOFF_REQUEST';
  body: string;
  systemEvent: string | null;
  systemMeta: Record<string, string | number | boolean | null>;
  replyToMessageId: string | null;
  proposal: ChatProposal | null;
  /** For AUTOMATED_REPLY: the answer exactly as the customer was shown it. */
  automation?: (FaqAnswer & { askedAt: string }) | null;
  attachment: { id: string; fileName: string; contentType: string; byteSize: number; downloadable: boolean } | null;
  createdAt: string;
  deliveredAt: string | null;
  redacted: boolean;
  clientMessageId?: string;
}

export interface ChatAvailability {
  enabled: boolean;
  teamAvailable: boolean;
  typicalResponse: string | null;
  maxMessageChars: number;
  attachments: {
    available: boolean;
    reason: 'DISABLED' | 'NO_SCANNER' | null;
    maxBytes: number;
    types: string[];
  };
}

export interface SendResult {
  conversation: CustomerConversation;
  message: ChatMessage;
  created: boolean;
  duplicate: boolean;
}

/** Account -> Messages. `StoreLayout` and `AccountLayout` frame it as an application pane. */
export const MESSAGES_PATH = '/account/messages';

export function isMessagesPath(pathname: string): boolean {
  return pathname === MESSAGES_PATH || pathname.startsWith(`${MESSAGES_PATH}/`);
}

export const chatKeys = {
  availability: ['preorder-chat', 'availability'] as const,
  unread: ['preorder-chat', 'unread'] as const,
  list: ['preorder-chat', 'list'] as const,
  conversation: (id: string) => ['preorder-chat', 'conversation', id] as const,
};

export function fetchChatAvailability(): Promise<ChatAvailability> {
  return api.get<ChatAvailability>('/preorder-chats/availability');
}

export function previewChat(
  input: ChatContextInput,
): Promise<{ context: ChatContextCard | null; conversation: CustomerConversation | null }> {
  return api.post('/preorder-chats/context', input);
}

export function startChat(input: {
  context: ChatContextInput;
  clientMessageId: string;
  body: string;
  locale: string | null;
  /** The assistant's answers the customer read first, as the server signed them. */
  transcript?: SignedAnswer[];
}): Promise<SendResult> {
  return api.post<SendResult>('/preorder-chats/messages', { ...input, replyToMessageId: null });
}

export function sendChatMessage(
  conversationId: string,
  input: { clientMessageId: string; body: string },
): Promise<SendResult> {
  return api.post<SendResult>(`/preorder-chats/${conversationId}/messages`, {
    ...input,
    replyToMessageId: null,
  });
}

export function fetchConversation(id: string): Promise<{ conversation: CustomerConversation }> {
  return api.get(`/preorder-chats/${id}`);
}

export function fetchChatMessages(
  id: string,
  query: { after?: number; before?: number; limit?: number },
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  return api.get(`/preorder-chats/${id}/messages`, { query });
}

export function markChatRead(id: string, seq: number): Promise<{ readSeq: number; unreadCount: number }> {
  return api.post(`/preorder-chats/${id}/read`, { seq });
}

/** Unread replies from the team: all of them, or those about one product. */
export function fetchUnreadChats(productId?: string): Promise<{ unreadCount: number }> {
  return api.get('/preorder-chats/unread', productId === undefined ? undefined : { query: { productId } });
}

export function fetchMyConversations(cursor?: string): Promise<{
  conversations: CustomerConversation[];
  nextCursor: string | null;
}> {
  return api.get('/preorder-chats', { query: { cursor } });
}

export function uploadChatAttachment(
  id: string,
  file: File,
  clientMessageId: string,
): Promise<{ message: ChatMessage; duplicate: boolean }> {
  const form = new FormData();
  // Fields before the file: the server reads the file part, and fields that
  // arrive after it would not be attached to it.
  form.append('clientMessageId', clientMessageId);
  form.append('file', file);
  return postFile(`/preorder-chats/${id}/attachments`, form);
}

/**
 * Open an attachment. A five-minute, single-use link, redeemed by navigating
 * to it so the browser downloads it with this session's cookie.
 */
export async function openChatAttachment(conversationId: string, attachmentId: string): Promise<void> {
  const link = await api.post<{ url: string }>(
    `/preorder-chats/${conversationId}/attachments/${attachmentId}/link`,
  );
  const apiOrigin = new URL(BASE_URL, window.location.origin).origin;
  window.location.assign(new URL(link.url, apiOrigin).toString());
}

export function fetchProposal(
  conversationId: string,
  proposalId: string,
): Promise<{
  proposal: ChatProposal;
  prefill: {
    productId: string;
    variantId: string | null;
    orderingUnit: ChatOrderingUnit;
    unitQuantity: number;
    requestedDeliveryDate: string;
  };
}> {
  return api.get(`/preorder-chats/${conversationId}/proposals/${proposalId}`);
}

export function declineProposal(conversationId: string, proposalId: string, reason: string | null) {
  return api.post<{ proposal: ChatProposal }>(
    `/preorder-chats/${conversationId}/proposals/${proposalId}/decline`,
    { reason },
  );
}

export function markProposalSubmitted(conversationId: string, proposalId: string, preorderRequestId: string) {
  return api.post<{ proposal: ChatProposal }>(
    `/preorder-chats/${conversationId}/proposals/${proposalId}/submitted`,
    { preorderRequestId },
  );
}

export function newClientMessageId(): string {
  return newIdempotencyKey();
}

// ---------------------------------------------------------------------------
// Carrying the intent across sign-in
// ---------------------------------------------------------------------------

/** The query parameter that says "open the chat" on the way back from sign-in. */
export const CHAT_INTENT_PARAM = 'chat';
/** Opens the preorder form on a proposal: `?proposal=<id>&conversation=<id>`. */
export const PROPOSAL_PARAM = 'proposal';
export const CONVERSATION_PARAM = 'conversation';

const INTENT_KEY = 'uboss.preorderChat.intent';

export interface ChatIntent {
  productId: string;
  variantId: string | null;
  orderingUnit: ChatOrderingUnit;
  unitQuantity: number | null;
  desiredDeliveryDate: string | null;
}

/**
 * Kept in this tab only - sessionStorage, not localStorage - and holds no
 * message and nothing personal: which product, option and quantity the guest
 * was looking at, so the drawer opens on it after they sign in.
 */
export function rememberChatIntent(intent: ChatIntent): void {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* private mode: the product page still has the product */
  }
}

export function takeChatIntent(productId: string): ChatIntent | null {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    sessionStorage.removeItem(INTENT_KEY);
    if (raw === null) return null;
    const intent = JSON.parse(raw) as ChatIntent;
    return intent.productId === productId ? intent : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

export type DeliveryState = 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

/** The mark under one of my own messages, from the server's receipts. */
export function deliveryStateOf(seq: number, receipts: { deliveredSeq: number; readSeq: number }): DeliveryState {
  if (seq <= receipts.readSeq) return 'READ';
  if (seq <= receipts.deliveredSeq) return 'DELIVERED';
  return 'SENT';
}

/** Same rule in both apps: see `chat-kit/timeline.ts`. */
export { linkify, type TextPart } from './chat-kit/timeline';

/** Merge messages by sequence, newest version of each winning. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const bySeq = new Map(current.map((message) => [message.seq, message]));
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
