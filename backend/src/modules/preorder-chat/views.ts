/**
 * What each side is shown.
 *
 * TWO SERIALISERS, NEVER ONE WITH A FLAG
 *
 * The customer's view and the staff view are separate functions over the same
 * rows. A single serialiser with an `isStaff` switch is one inverted condition
 * away from sending a customer the assignee, the tags, the SLA clock or who at
 * the business read their message - so the customer functions below simply do
 * not know those fields exist. Internal notes have no customer serialiser at
 * all, because no customer query ever loads one.
 *
 * Staff are shown to the customer as "the team" (under the operator's own name), never by name or
 * address. A negotiation is with the business, and a named person's inbox is
 * not where a customer should be sending the next one.
 */
import {
  customerFacingStatus,
  type PreorderChatPriorityName,
  type PreorderChatStatusName,
} from '../../domain/preorder-chat-state.js';
import { readSnapshot, type ChatContextSnapshot } from './context.service.js';

// ---------------------------------------------------------------------------
// Row shapes the services select
// ---------------------------------------------------------------------------

export const MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  serverSequence: true,
  senderType: true,
  senderUserId: true,
  clientMessageId: true,
  messageType: true,
  body: true,
  systemEvent: true,
  systemMetaJson: true,
  replyToMessageId: true,
  proposalId: true,
  createdAt: true,
  deliveredAt: true,
  editedAt: true,
  redactedAt: true,
  redactionReason: true,
  attachment: {
    select: { id: true, fileName: true, contentType: true, byteSize: true, scanState: true },
  },
} as const;

export interface MessageRow {
  id: string;
  conversationId: string;
  serverSequence: number;
  senderType: 'CUSTOMER' | 'ADMIN' | 'SYSTEM';
  senderUserId: string | null;
  clientMessageId: string;
  messageType: 'TEXT' | 'ATTACHMENT' | 'SYSTEM_EVENT' | 'STRUCTURED_OFFER';
  body: string;
  systemEvent: string | null;
  systemMetaJson: unknown;
  replyToMessageId: string | null;
  proposalId: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  editedAt: Date | null;
  redactedAt: Date | null;
  redactionReason: string | null;
  attachment: {
    id: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    scanState: 'CLEAN' | 'SCANNER_UNCONFIGURED';
  } | null;
}

export const PROPOSAL_SELECT = {
  id: true,
  revision: true,
  state: true,
  orderingUnit: true,
  unitQuantity: true,
  equivalentBaseUnits: true,
  indicativeUnitPriceMinor: true,
  currency: true,
  availabilityNote: true,
  deliveryDate: true,
  splitDeliveriesJson: true,
  termsNote: true,
  expiresAt: true,
  preorderRequestId: true,
  respondedAt: true,
  declineReason: true,
  createdAt: true,
} as const;

export interface ProposalRow {
  id: string;
  revision: number;
  state: 'PROPOSED' | 'SUPERSEDED' | 'WITHDRAWN' | 'DECLINED' | 'SUBMITTED' | 'EXPIRED';
  orderingUnit: string;
  unitQuantity: number;
  equivalentBaseUnits: number;
  indicativeUnitPriceMinor: bigint | null;
  currency: string;
  availabilityNote: string | null;
  deliveryDate: Date;
  splitDeliveriesJson: unknown;
  termsNote: string | null;
  expiresAt: Date;
  preorderRequestId: string | null;
  respondedAt: Date | null;
  declineReason: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function splits(value: unknown): { date: string; baseUnits: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { date, baseUnits } = entry as { date?: unknown; baseUnits?: unknown };
    return typeof date === 'string' && typeof baseUnits === 'number' ? [{ date, baseUnits }] : [];
  });
}

/**
 * A proposal, identically for both sides. Nothing on it is internal: it is a
 * card the business sent the customer. An expired PROPOSED row reads as
 * EXPIRED at once rather than waiting for the sweep to write it.
 */
export function proposalView(row: ProposalRow, now: Date = new Date()): Record<string, unknown> {
  const state = row.state === 'PROPOSED' && row.expiresAt <= now ? 'EXPIRED' : row.state;
  return {
    id: row.id,
    revision: row.revision,
    state,
    orderingUnit: row.orderingUnit,
    unitQuantity: row.unitQuantity,
    equivalentBaseUnits: row.equivalentBaseUnits,
    // Money crosses the API as a string of minor units, like everywhere else.
    indicativeUnitPriceMinor: row.indicativeUnitPriceMinor?.toString() ?? null,
    currency: row.currency,
    availabilityNote: row.availabilityNote,
    deliveryDate: day(row.deliveryDate),
    splitDeliveries: splits(row.splitDeliveriesJson),
    termsNote: row.termsNote,
    expiresAt: row.expiresAt.toISOString(),
    preorderRequestId: row.preorderRequestId,
    respondedAt: row.respondedAt?.toISOString() ?? null,
    declineReason: row.declineReason,
    createdAt: row.createdAt.toISOString(),
  };
}

function systemMeta(value: unknown): Record<string, string | number | boolean | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean'
    ) {
      result[key] = entry;
    }
  }
  return result;
}

interface MessageViewOptions {
  side: 'CUSTOMER' | 'STAFF';
  /** Only for STAFF: who each staff sender was, by user id. */
  staffNames?: ReadonlyMap<string, string>;
  proposals?: ReadonlyMap<string, ProposalRow>;
  attachmentsServable: (scanState: 'CLEAN' | 'SCANNER_UNCONFIGURED') => boolean;
}

/**
 * One message.
 *
 * `clientMessageId` goes back only to the side that wrote it - it is how the
 * sender's own browser matches its optimistic copy to the stored one, and it
 * is nobody else's business.
 */
export function messageView(row: MessageRow, options: MessageViewOptions): Record<string, unknown> {
  const own =
    (options.side === 'CUSTOMER' && row.senderType === 'CUSTOMER') ||
    (options.side === 'STAFF' && row.senderType === 'ADMIN');
  const redacted = row.redactedAt !== null;

  const senderName =
    row.senderType === 'ADMIN'
      ? options.side === 'STAFF'
        ? (options.staffNames?.get(row.senderUserId ?? '') ?? null)
        : null
      : null;

  const proposal =
    row.proposalId === null ? undefined : options.proposals?.get(row.proposalId);

  return {
    id: row.id,
    seq: row.serverSequence,
    senderType: row.senderType,
    // STAFF only: which colleague wrote it. The customer sees "UBOSS team".
    ...(options.side === 'STAFF' ? { senderName, senderUserId: row.senderUserId } : {}),
    messageType: row.messageType,
    body: redacted ? '' : row.body,
    systemEvent: row.systemEvent,
    systemMeta: systemMeta(row.systemMetaJson),
    replyToMessageId: row.replyToMessageId,
    proposal: proposal === undefined ? null : proposalView(proposal),
    attachment:
      row.attachment === null || redacted
        ? null
        : {
            id: row.attachment.id,
            fileName: row.attachment.fileName,
            contentType: row.attachment.contentType,
            byteSize: row.attachment.byteSize,
            downloadable: options.attachmentsServable(row.attachment.scanState),
          },
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    editedAt: row.editedAt?.toISOString() ?? null,
    redacted,
    ...(options.side === 'STAFF' && redacted ? { redactionReason: row.redactionReason } : {}),
    ...(own ? { clientMessageId: row.clientMessageId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Conversation, as the customer sees it
// ---------------------------------------------------------------------------

export const CUSTOMER_CONVERSATION_SELECT = {
  id: true,
  status: true,
  contextSnapshotJson: true,
  preorderRequestId: true,
  preorderRequest: { select: { requestNumber: true } },
  lastSequence: true,
  staffMessageCount: true,
  customerReadStaffCount: true,
  staffDeliveredSeq: true,
  staffReadSeq: true,
  lastMessagePreview: true,
  lastMessageSender: true,
  lastMessageAt: true,
  resolvedAt: true,
  closedAt: true,
  createdAt: true,
} as const;

export interface CustomerConversationRow {
  id: string;
  status: PreorderChatStatusName;
  contextSnapshotJson: unknown;
  preorderRequestId: string | null;
  preorderRequest: { requestNumber: string } | null;
  lastSequence: number;
  staffMessageCount: number;
  customerReadStaffCount: number;
  staffDeliveredSeq: number;
  staffReadSeq: number;
  lastMessagePreview: string | null;
  lastMessageSender: 'CUSTOMER' | 'ADMIN' | 'SYSTEM' | null;
  lastMessageAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
}

/** The context card, minus anything a customer did not see on the product page. */
export function customerContext(snapshot: ChatContextSnapshot | null): Record<string, unknown> | null {
  if (snapshot === null) return null;
  return {
    product: snapshot.product,
    variant: snapshot.variant,
    sellerName: snapshot.seller.name,
    preorder: {
      available: snapshot.preorder.available,
      minimumBaseUnits: snapshot.preorder.minimumBaseUnits,
      moqUnit: snapshot.preorder.moqUnit,
      moqQuantity: snapshot.preorder.moqQuantity,
    },
    request: snapshot.request,
    capturedAt: snapshot.capturedAt,
  };
}

export function customerConversationView(row: CustomerConversationRow): Record<string, unknown> {
  const status = customerFacingStatus(row.status);
  return {
    id: row.id,
    status,
    // What the composer should allow. A closed or blocked conversation is read
    // only; a resolved one reopens when the customer writes.
    canSend: status !== 'CLOSED' && status !== 'BLOCKED',
    context: customerContext(readSnapshot(row.contextSnapshotJson)),
    preorder:
      row.preorderRequestId === null
        ? null
        : { id: row.preorderRequestId, requestNumber: row.preorderRequest?.requestNumber ?? null },
    lastSequence: row.lastSequence,
    unreadCount: Math.max(0, row.staffMessageCount - row.customerReadStaffCount),
    // How far the business has seen this customer's messages. Drives the
    // Delivered / Read marks under their own messages.
    receipts: { deliveredSeq: row.staffDeliveredSeq, readSeq: row.staffReadSeq },
    lastMessagePreview: row.lastMessagePreview,
    lastMessageFromMe: row.lastMessageSender === 'CUSTOMER',
    lastMessageAt: row.lastMessageAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Conversation, as staff see it
// ---------------------------------------------------------------------------

export const STAFF_CONVERSATION_SELECT = {
  id: true,
  status: true,
  priority: true,
  customerProfileId: true,
  customerLocale: true,
  productId: true,
  variantId: true,
  sellerAccountId: true,
  offerId: true,
  preorderRequestId: true,
  preorderRequest: { select: { requestNumber: true, status: true, sellerAccountId: true } },
  productName: true,
  productSku: true,
  sellerName: true,
  contextSnapshotJson: true,
  tagsJson: true,
  assignedAdminId: true,
  assignedAt: true,
  assignedAdmin: { select: { id: true, email: true } },
  lastSequence: true,
  customerMessageCount: true,
  staffReadCustomerCount: true,
  customerDeliveredSeq: true,
  customerReadSeq: true,
  lastMessagePreview: true,
  lastMessageSender: true,
  lastMessageAt: true,
  lastCustomerMessageAt: true,
  lastStaffMessageAt: true,
  awaitingReplySince: true,
  firstResponseAt: true,
  resolvedAt: true,
  closedAt: true,
  reopenCount: true,
  version: true,
  createdAt: true,
  customerProfile: {
    select: {
      fullName: true,
      organization: true,
      user: { select: { email: true } },
      preorderChatBlock: { select: { id: true, reason: true, createdAt: true } },
    },
  },
} as const;

export interface StaffConversationRow {
  id: string;
  status: PreorderChatStatusName;
  priority: PreorderChatPriorityName;
  customerProfileId: string;
  customerLocale: string;
  productId: string;
  variantId: string | null;
  sellerAccountId: string | null;
  offerId: string | null;
  preorderRequestId: string | null;
  preorderRequest: { requestNumber: string; status: string; sellerAccountId: string | null } | null;
  productName: string;
  productSku: string | null;
  sellerName: string | null;
  contextSnapshotJson: unknown;
  tagsJson: unknown;
  assignedAdminId: string | null;
  assignedAt: Date | null;
  assignedAdmin: { id: string; email: string } | null;
  lastSequence: number;
  customerMessageCount: number;
  staffReadCustomerCount: number;
  customerDeliveredSeq: number;
  customerReadSeq: number;
  lastMessagePreview: string | null;
  lastMessageSender: 'CUSTOMER' | 'ADMIN' | 'SYSTEM' | null;
  lastMessageAt: Date;
  lastCustomerMessageAt: Date | null;
  lastStaffMessageAt: Date | null;
  awaitingReplySince: Date | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  reopenCount: number;
  version: number;
  createdAt: Date;
  customerProfile: {
    fullName: string | null;
    organization: string | null;
    user: { email: string };
    preorderChatBlock: { id: string; reason: string; createdAt: Date } | null;
  };
}

export function tagsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];
}

export interface StaffViewer {
  /** `customer.read`: may see the customer's email address. */
  canSeeCustomerEmail: boolean;
}

/** One inbox row. */
export function staffConversationSummary(
  row: StaffConversationRow,
  viewer: StaffViewer,
  now: Date = new Date(),
): Record<string, unknown> {
  const snapshot = readSnapshot(row.contextSnapshotJson);
  return {
    id: row.id,
    status: row.status,
    priority: row.priority,
    customer: {
      profileId: row.customerProfileId,
      name: row.customerProfile.fullName,
      organization: row.customerProfile.organization,
      // Subject to `customer.read`, the grant the customer screens sit behind.
      email: viewer.canSeeCustomerEmail ? row.customerProfile.user.email : null,
      blocked: row.customerProfile.preorderChatBlock !== null,
    },
    product: {
      id: row.productId,
      name: row.productName,
      sku: row.productSku,
      imageUrl: snapshot?.product.imageUrl ?? null,
      variantName: snapshot?.variant?.name ?? null,
    },
    seller: { id: row.sellerAccountId, name: row.sellerName },
    preorder:
      row.preorderRequestId === null
        ? null
        : {
            id: row.preorderRequestId,
            requestNumber: row.preorderRequest?.requestNumber ?? null,
            status: row.preorderRequest?.status ?? null,
          },
    assignedTo:
      row.assignedAdmin === null ? null : { id: row.assignedAdmin.id, email: row.assignedAdmin.email },
    tags: tagsOf(row.tagsJson),
    lastMessagePreview: row.lastMessagePreview,
    lastMessageSender: row.lastMessageSender,
    lastMessageAt: row.lastMessageAt.toISOString(),
    unreadCount: Math.max(0, row.customerMessageCount - row.staffReadCustomerCount),
    awaitingReplySince: row.awaitingReplySince?.toISOString() ?? null,
    waitingMinutes:
      row.awaitingReplySince === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - row.awaitingReplySince.getTime()) / 60_000)),
    reopenCount: row.reopenCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The whole conversation header, for the open thread and its side panel. */
export function staffConversationDetail(
  row: StaffConversationRow,
  viewer: StaffViewer,
  extra: {
    currentProduct: {
      id: string;
      name: string;
      slug: string;
      isLive: boolean;
    } | null;
    /** What a proposal's indicative price is quoted in: the offer's, or the product's. */
    pricingCurrency: string;
  },
): Record<string, unknown> {
  const snapshot = readSnapshot(row.contextSnapshotJson);
  return {
    ...staffConversationSummary(row, viewer),
    customerLocale: row.customerLocale,
    // The product as the customer saw it, and as it is now - side by side, so
    // a rename or a withdrawal since is visible rather than silently applied.
    context: snapshot,
    currentProduct: extra.currentProduct,
    pricingCurrency: extra.pricingCurrency,
    receipts: { deliveredSeq: row.customerDeliveredSeq, readSeq: row.customerReadSeq },
    lastSequence: row.lastSequence,
    lastCustomerMessageAt: row.lastCustomerMessageAt?.toISOString() ?? null,
    lastStaffMessageAt: row.lastStaffMessageAt?.toISOString() ?? null,
    firstResponseAt: row.firstResponseAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    assignedAt: row.assignedAt?.toISOString() ?? null,
    block:
      row.customerProfile.preorderChatBlock === null
        ? null
        : {
            reason: row.customerProfile.preorderChatBlock.reason,
            createdAt: row.customerProfile.preorderChatBlock.createdAt.toISOString(),
          },
    // Whether the linked preorder is the operator's to answer in Preorders.
    preorderIsOperators:
      row.preorderRequest === null ? null : row.preorderRequest.sellerAccountId === null,
    version: row.version,
  };
}
