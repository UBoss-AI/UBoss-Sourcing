/**
 * Preorder chat: conversations and messages.
 *
 * THE SEND PATH, IN ORDER
 *
 *   1. Authorise: the customer owns the conversation (or is starting one), or
 *      the member of staff holds the permission. Done before anything is read
 *      that could leak.
 *   2. Validate and clean the text (`domain/chat-text.ts`).
 *   3. Persist inside one transaction: the conversation's sequence counter is
 *      incremented, the message is written with that sequence, and the
 *      counters, preview and waiting clock move with it.
 *   4. Commit.
 *   5. Return the bus events to the caller, who publishes them - so nothing is
 *      ever announced that a rollback could take back.
 *   6. The HTTP response carrying the stored message is the sender's
 *      acknowledgement.
 *
 * RETRIES
 *
 * The browser generates `clientMessageId` once per message and reuses it for
 * every retry. (`senderKey`, `clientMessageId`) is UNIQUE, so a resend after a
 * dropped connection finds the message already stored and is answered with it
 * - `duplicate: true` - rather than creating a second one. A retry that reuses
 * the id for DIFFERENT text is refused, because that is not a retry.
 *
 * WHO SEES WHAT
 *
 * Every read here goes through `views.ts`, whose customer serialisers do not
 * know the staff-only fields exist. Internal notes live in another table and
 * another module; nothing in this file reads them for a customer.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { normaliseChatBody, previewOf } from '../../domain/chat-text.js';
import { ErrorCode, AppError, conflict, forbidden, notFound, tooManyRequests } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import {
  activeKeyFor,
  onCustomerMessage,
  onStaffMessage,
  WORKING_STATUSES,
  type PreorderChatStatusName,
} from '../../domain/preorder-chat-state.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  ResolutionKey,
  createAdminNotification,
  resolveAdminNotifications,
} from '../notifications/admin-notification.service.js';
import { attachmentsServable } from './attachment-policy.js';
import { FAQ_IDS } from './assistant/catalogue.js';
import { transcriptSchema, verifyTranscript, type TranscriptItem } from './assistant/transcript.js';
import {
  buildChatContext,
  chatContextInputSchema,
  type BuiltChatContext,
  type ChatContextInput,
} from './context.service.js';
import {
  chatConversationsCreatedTotal,
  chatFirstResponseSeconds,
  chatMessagesTotal,
  chatReopenedTotal,
  chatResponseSeconds,
} from './metrics.js';
import type { ChatBusEvent, ChatSide } from './realtime/events.js';
import {
  CUSTOMER_CONVERSATION_SELECT,
  MESSAGE_SELECT,
  PROPOSAL_SELECT,
  STAFF_CONVERSATION_SELECT,
  customerContext,
  customerConversationView,
  messageView,
  staffConversationDetail,
  staffConversationSummary,
  type CustomerConversationRow,
  type MessageRow,
  type ProposalRow,
  type StaffConversationRow,
  type StaffViewer,
} from './views.js';

// ---------------------------------------------------------------------------
// Actors and outcomes
// ---------------------------------------------------------------------------

export interface CustomerActor {
  userId: string;
  email: string;
  customerProfileId: string;
  locale?: string | null;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface StaffActor {
  userId: string;
  email: string;
  permissions: ReadonlySet<string>;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/** A result, and the events to publish once the caller has it. */
export interface ChatOutcome<T> {
  value: T;
  events: ChatBusEvent[];
}

export function staffViewer(actor: StaffActor): StaffViewer {
  return { canSeeCustomerEmail: actor.permissions.has(Permission.CUSTOMER_READ) };
}

function assertFeature(): void {
  if (!env.FEATURE_PREORDER_CHAT) throw notFound('Preorder chat');
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/** A browser-made id for one message attempt. A UUID in practice. */
const clientMessageId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Use 8 to 64 letters, digits, hyphens or underscores.');

export const customerSendSchema = z
  .object({
    clientMessageId,
    body: z.string().max(40_000),
    replyToMessageId: z.string().length(26).nullable().default(null),
  })
  .strict();

/** The first message, which names the product instead of a conversation. */
export const customerStartSchema = customerSendSchema
  .extend({
    context: chatContextInputSchema,
    /** The storefront's language, kept on the conversation for staff. */
    locale: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .nullable()
      .default(null),
    /**
     * The preorder assistant's answers the customer read before writing, as
     * this server signed them. They go into the conversation ahead of the
     * message, so staff see what the customer already knows.
     */
    transcript: transcriptSchema.default([]),
  })
  .strict();

export const staffSendSchema = customerSendSchema;

export const readSchema = z.object({ seq: z.number().int().min(0).max(2_147_483_647) }).strict();

export const historyQuerySchema = z.object({
  /** Messages after this sequence - the reconnect path. */
  after: z.coerce.number().int().min(0).optional(),
  /** Messages before this sequence - "load earlier". */
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type HistoryQuery = z.infer<typeof historyQuerySchema>;

// ---------------------------------------------------------------------------
// Appending a message: the one place a sequence is handed out
// ---------------------------------------------------------------------------

type SenderType = 'CUSTOMER' | 'ADMIN' | 'SYSTEM' | 'AUTOMATION';
type MessageType =
  | 'TEXT'
  | 'ATTACHMENT'
  | 'SYSTEM_EVENT'
  | 'STRUCTURED_OFFER'
  | 'FAQ_QUESTION'
  | 'AUTOMATED_REPLY'
  | 'HANDOFF_REQUEST';

export interface AppendInput {
  conversationId: string;
  senderType: SenderType;
  senderUserId: string | null;
  clientMessageId: string;
  messageType: MessageType;
  body: string;
  systemEvent?: string | null;
  systemMeta?: Record<string, string | number | boolean | null> | null;
  /** Structured values instead of `systemMeta` - an assistant answer. */
  metaJson?: Prisma.InputJsonValue;
  replyToMessageId?: string | null;
  proposalId?: string | null;
  /** Status to move to as part of the same write. */
  nextStatus?: PreorderChatStatusName;
  /** RESOLVED -> OPEN by a new message. */
  reopened?: boolean;
  now?: Date;
}

const SENDER_KEY_PREFIX: Readonly<Record<SenderType, string>> = {
  CUSTOMER: 'C',
  ADMIN: 'A',
  SYSTEM: 'S',
  // "Bot": the assistant's own retry space, apart from the system's.
  AUTOMATION: 'B',
};

export function senderKeyFor(senderType: SenderType, id: string): string {
  return `${SENDER_KEY_PREFIX[senderType]}:${id}`;
}

/**
 * Write one message inside the caller's transaction.
 *
 * The conversation row is updated FIRST - `lastSequence + 1` - which takes its
 * row lock, so two sends into the same conversation queue behind each other
 * and each gets its own sequence. The message insert then uses the number the
 * update handed back. Neither the browser's clock nor the insert's timing
 * decides the order.
 */
export async function appendMessage(tx: PrismaTransaction, input: AppendInput): Promise<string> {
  const now = input.now ?? new Date();
  const fromCustomer = input.senderType === 'CUSTOMER';
  // Every row in the messages table is customer-visible - notes are another
  // table - so every message moves one side's count.
  const spoken = input.messageType === 'TEXT' || input.messageType === 'ATTACHMENT';

  const before = await tx.preorderChatConversation.findUniqueOrThrow({
    where: { id: input.conversationId },
    select: { awaitingReplySince: true, firstResponseAt: true, createdAt: true, status: true },
  });

  const data: Prisma.PreorderChatConversationUpdateInput = {
    lastSequence: { increment: 1 },
    lastMessageAt: now,
    version: { increment: 1 },
    // A system card ("resolved", "proposal created") keeps the preview of the
    // last thing a PERSON said, which is what the inbox row is for.
    ...(spoken
      ? {
          lastMessageSender: input.senderType,
          lastMessagePreview: input.body.length > 0 ? previewOf(input.body, 160) : null,
        }
      : {}),
  };

  if (fromCustomer) {
    data.customerMessageCount = { increment: 1 };
    data.lastCustomerMessageAt = now;
    // The clock starts at the OLDEST unanswered message, not the newest: a
    // customer who writes three times while waiting has waited since the first.
    if (before.awaitingReplySince === null) data.awaitingReplySince = now;
  } else {
    data.staffMessageCount = { increment: 1 };
  }

  if (input.senderType === 'ADMIN') {
    data.lastStaffMessageAt = now;
    data.awaitingReplySince = null;
    data.slaAlertedAt = null;
    if (before.firstResponseAt === null) {
      data.firstResponseAt = now;
      chatFirstResponseSeconds.observe((now.getTime() - before.createdAt.getTime()) / 1000);
    }
    if (before.awaitingReplySince !== null) {
      chatResponseSeconds.observe((now.getTime() - before.awaitingReplySince.getTime()) / 1000);
    }
  }

  if (input.nextStatus !== undefined && input.nextStatus !== before.status) {
    data.status = input.nextStatus;
    if (input.nextStatus === 'OPEN' && before.status === 'RESOLVED') data.resolvedAt = null;
  }
  if (input.reopened === true) {
    data.reopenCount = { increment: 1 };
    chatReopenedTotal.inc();
  }

  const updated = await tx.preorderChatConversation.update({
    where: { id: input.conversationId },
    data,
    select: { lastSequence: true },
  });

  const id = newId();
  await tx.preorderChatMessage.create({
    data: {
      id,
      conversationId: input.conversationId,
      serverSequence: updated.lastSequence,
      senderType: input.senderType,
      senderUserId: input.senderUserId,
      senderKey: senderKeyFor(input.senderType, input.senderUserId ?? input.conversationId),
      clientMessageId: input.clientMessageId,
      messageType: input.messageType,
      body: input.body,
      systemEvent: input.systemEvent ?? null,
      ...(input.metaJson !== undefined
        ? { systemMetaJson: input.metaJson }
        : input.systemMeta === undefined || input.systemMeta === null
          ? {}
          : { systemMetaJson: input.systemMeta }),
      replyToMessageId: input.replyToMessageId ?? null,
      proposalId: input.proposalId ?? null,
      createdAt: now,
    },
  });

  chatMessagesTotal.inc({ sender: input.senderType });
  return id;
}

/**
 * A system card, for both sides to read in their own language.
 *
 * `key` makes it idempotent: "proposal X was created" is posted once however
 * many times the operation behind it is retried.
 */
export async function appendSystemMessage(
  tx: PrismaTransaction,
  conversationId: string,
  event: string,
  meta: Record<string, string | number | boolean | null>,
  key: string,
  options: { proposalId?: string; messageType?: MessageType } = {},
): Promise<string | null> {
  const senderKey = senderKeyFor('SYSTEM', conversationId);
  const existing = await tx.preorderChatMessage.findUnique({
    where: { senderKey_clientMessageId: { senderKey, clientMessageId: key } },
    select: { id: true },
  });
  if (existing !== null) return null;

  return appendMessage(tx, {
    conversationId,
    senderType: 'SYSTEM',
    senderUserId: null,
    clientMessageId: key,
    messageType: options.messageType ?? 'SYSTEM_EVENT',
    body: '',
    systemEvent: event,
    systemMeta: meta,
    ...(options.proposalId === undefined ? {} : { proposalId: options.proposalId }),
  });
}

function isUniqueViolation(error: unknown, index: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; meta?: unknown };
  if (candidate.code !== 'P2002') return false;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return `${message} ${JSON.stringify(candidate.meta ?? {})}`.includes(index);
}

// ---------------------------------------------------------------------------
// Loading rows for views
// ---------------------------------------------------------------------------

async function loadMessages(where: Prisma.PreorderChatMessageWhereInput, options: {
  orderBy: 'asc' | 'desc';
  take: number;
}): Promise<MessageRow[]> {
  return prisma.preorderChatMessage.findMany({
    where,
    orderBy: { serverSequence: options.orderBy },
    take: options.take,
    select: MESSAGE_SELECT,
  });
}

async function proposalsFor(rows: MessageRow[]): Promise<Map<string, ProposalRow>> {
  const ids = [...new Set(rows.flatMap((row) => (row.proposalId === null ? [] : [row.proposalId])))];
  if (ids.length === 0) return new Map();
  const proposals = (await prisma.preorderChatProposal.findMany({
    where: { id: { in: ids } },
    select: PROPOSAL_SELECT,
  })) as ProposalRow[];
  return new Map(proposals.map((proposal) => [proposal.id, proposal]));
}

async function staffNamesFor(rows: MessageRow[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows.flatMap((row) =>
        row.senderType === 'ADMIN' && row.senderUserId !== null ? [row.senderUserId] : [],
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true },
  });
  return new Map(users.map((user) => [user.id, user.email]));
}

/** Serialise a page of messages for one side. */
export async function serialiseMessages(
  rows: MessageRow[],
  side: ChatSide,
): Promise<Record<string, unknown>[]> {
  const [proposals, staffNames] = await Promise.all([
    proposalsFor(rows),
    side === 'STAFF' ? staffNamesFor(rows) : Promise.resolve(new Map<string, string>()),
  ]);
  return rows.map((row) =>
    messageView(row, { side, proposals, staffNames, attachmentsServable }),
  );
}

export async function loadMessageView(
  messageId: string,
  side: ChatSide,
): Promise<Record<string, unknown> | null> {
  const row = (await prisma.preorderChatMessage.findUnique({
    where: { id: messageId },
    select: MESSAGE_SELECT,
  })) as MessageRow | null;
  if (row === null) return null;
  const [view] = await serialiseMessages([row], side);
  return view ?? null;
}

export async function loadCustomerConversationView(
  conversationId: string,
): Promise<Record<string, unknown> | null> {
  const row = (await prisma.preorderChatConversation.findUnique({
    where: { id: conversationId },
    select: CUSTOMER_CONVERSATION_SELECT,
  })) as CustomerConversationRow | null;
  return row === null ? null : customerConversationView(row);
}

export async function loadStaffConversationSummary(
  conversationId: string,
  viewer: StaffViewer,
): Promise<Record<string, unknown> | null> {
  const row = (await prisma.preorderChatConversation.findUnique({
    where: { id: conversationId },
    select: STAFF_CONVERSATION_SELECT,
  })) as StaffConversationRow | null;
  return row === null ? null : staffConversationSummary(row, viewer);
}

/**
 * Load a conversation the customer OWNS, or 404.
 *
 * The ownership test is part of the query - another customer's conversation
 * is never loaded, so there is nothing to leak through a timing difference or
 * a forgotten check - and a conversation that exists but is somebody else's
 * answers exactly as one that does not exist.
 */
async function ownedConversation(
  actor: CustomerActor,
  conversationId: string,
): Promise<{ id: string; status: PreorderChatStatusName; lastSequence: number }> {
  const row = await prisma.preorderChatConversation.findFirst({
    where: { id: conversationId, customerProfileId: actor.customerProfileId },
    select: { id: true, status: true, lastSequence: true },
  });
  if (row === null) throw notFound('Conversation');
  return row;
}

async function assertNotBlocked(customerProfileId: string): Promise<void> {
  const block = await prisma.preorderChatCustomerBlock.findUnique({
    where: { customerProfileId },
    select: { id: true },
  });
  if (block !== null) {
    throw forbidden(
      ErrorCode.PREORDER_CHAT_BLOCKED,
      'Messaging is not available on this account. Contact the business by its published details.',
    );
  }
}

/** Messages per minute, across every conversation, for one sender. */
async function assertSendRate(senderKey: string): Promise<void> {
  const recent = await prisma.preorderChatMessage.count({
    where: { senderKey, createdAt: { gt: new Date(Date.now() - 60_000) } },
  });
  if (recent >= env.PREORDER_CHAT_MESSAGES_PER_MINUTE) {
    throw tooManyRequests('You are sending messages too quickly. Wait a moment and try again.');
  }
}

/**
 * A retry of a message already stored, or null.
 *
 * Same sender, same `clientMessageId`: the same attempt. It must also be the
 * same text in the same conversation - otherwise the id is being reused for
 * something else, which a retry never does.
 */
async function findRetry(
  senderKey: string,
  id: string,
  expected: { conversationId: string | null; body: string },
): Promise<MessageRow | null> {
  const existing = (await prisma.preorderChatMessage.findUnique({
    where: { senderKey_clientMessageId: { senderKey, clientMessageId: id } },
    select: MESSAGE_SELECT,
  })) as MessageRow | null;
  if (existing === null) return null;

  const sameConversation =
    expected.conversationId === null || existing.conversationId === expected.conversationId;
  if (!sameConversation || existing.body !== expected.body) {
    throw conflict(
      ErrorCode.PREORDER_CHAT_MESSAGE_ID_REUSED,
      'That message id was already used for a different message.',
    );
  }
  return existing;
}

function refuseCustomerMessage(code: 'PREORDER_CHAT_CLOSED' | 'PREORDER_CHAT_BLOCKED'): never {
  if (code === 'PREORDER_CHAT_BLOCKED') {
    throw forbidden(
      ErrorCode.PREORDER_CHAT_BLOCKED,
      'Messaging is not available on this account. Contact the business by its published details.',
    );
  }
  throw conflict(
    ErrorCode.PREORDER_CHAT_CLOSED,
    'This conversation is closed. Start a new one from the product page.',
  );
}

/** Conversations started per hour, per customer. */
async function assertConversationRate(actor: CustomerActor): Promise<void> {
  const recentlyOpened = await prisma.preorderChatConversation.count({
    where: {
      customerProfileId: actor.customerProfileId,
      createdAt: { gt: new Date(Date.now() - 3_600_000) },
    },
  });
  if (recentlyOpened >= env.PREORDER_CHAT_CONVERSATIONS_PER_HOUR) {
    throw tooManyRequests('You have started a lot of conversations recently. Try again later.');
  }
}

/** The conversation row and its customer participant. Nothing else. */
async function createConversationRow(
  tx: PrismaTransaction,
  actor: CustomerActor,
  conversationId: string,
  built: BuiltChatContext,
  activeKey: string,
): Promise<void> {
  await tx.preorderChatConversation.create({
    data: {
      id: conversationId,
      customerProfileId: actor.customerProfileId,
      startedByUserId: actor.userId,
      productId: built.keys.productId,
      variantId: built.keys.variantId,
      variantKey: built.keys.variantKey,
      sellerAccountId: built.keys.sellerAccountId,
      offerId: built.keys.offerId,
      preorderKey: '',
      activeKey,
      status: 'NEW',
      customerLocale: (actor.locale ?? 'en').slice(0, 10),
      contextSnapshotJson: built.snapshot as unknown as Prisma.InputJsonValue,
      productName: built.keys.productName,
      productSku: built.keys.productSku,
      sellerName: built.keys.sellerName,
    },
  });
  await tx.preorderChatParticipant.create({
    data: {
      id: newId(),
      conversationId,
      participantType: 'CUSTOMER',
      userId: actor.userId,
    },
  });
}

/**
 * The assistant answers the customer read, as messages: each question they
 * picked (theirs) and the answer they were shown (the assistant's, never
 * staff's). Keyed on the request that carries them, so a retry of that
 * request cannot store them twice.
 */
async function appendTranscript(
  tx: PrismaTransaction,
  conversationId: string,
  actor: CustomerActor,
  transcript: readonly TranscriptItem[],
  requestKey: string,
): Promise<void> {
  for (const [index, item] of transcript.entries()) {
    await appendMessage(tx, {
      conversationId,
      senderType: 'CUSTOMER',
      senderUserId: actor.userId,
      clientMessageId: `${requestKey}:q${index}`,
      messageType: 'FAQ_QUESTION',
      body: '',
      systemEvent: item.answer.faqId,
      systemMeta: { faqId: item.answer.faqId, version: item.answer.version, askedAt: item.askedAt },
    });
    await appendMessage(tx, {
      conversationId,
      senderType: 'AUTOMATION',
      senderUserId: null,
      clientMessageId: `${requestKey}:a${index}`,
      messageType: 'AUTOMATED_REPLY',
      body: '',
      systemEvent: item.answer.faqId,
      metaJson: { answer: item.answer, askedAt: item.askedAt },
    });
  }
}

// ---------------------------------------------------------------------------
// The customer's side
// ---------------------------------------------------------------------------

export interface CustomerSendResult {
  conversation: Record<string, unknown>;
  message: Record<string, unknown>;
  /** A conversation was created by this message. */
  created: boolean;
  /** This was a retry; the stored message is returned unchanged. */
  duplicate: boolean;
}

/**
 * What the drawer shows before anything is sent: the context card, built by
 * the server, and the conversation this customer already has about it, if any.
 *
 * Creates nothing. Opening the drawer must not leave an empty conversation in
 * somebody's queue.
 */
export async function previewCustomerChat(
  actor: CustomerActor,
  input: ChatContextInput,
): Promise<{ context: Record<string, unknown> | null; conversation: Record<string, unknown> | null }> {
  assertFeature();
  const built = await buildChatContext(input);
  const key = activeKeyFor({
    customerProfileId: actor.customerProfileId,
    productId: built.keys.productId,
    variantKey: built.keys.variantKey,
    preorderKey: '',
  });
  const existing = await prisma.preorderChatConversation.findUnique({
    where: { activeKey: key },
    select: CUSTOMER_CONVERSATION_SELECT,
  });
  return {
    context: customerContext(built.snapshot),
    conversation:
      existing === null ? null : customerConversationView(existing),
  };
}

/**
 * The customer's first message about a product - or their next one, if they
 * already have a live conversation about it.
 *
 * The conversation is created HERE and nowhere earlier, in the same
 * transaction as the message, so a conversation never exists without the
 * message that started it. An existing live conversation about the same
 * product, option and (no) preorder is reused rather than duplicated; a
 * resolved one is reopened. Two first messages racing each other both land in
 * one conversation, because the second insert meets `uq_preorder_chat_active`
 * and falls back to appending.
 */
export async function startOrContinueCustomerChat(
  actor: CustomerActor,
  input: z.infer<typeof customerStartSchema>,
): Promise<ChatOutcome<CustomerSendResult>> {
  assertFeature();
  const body = normaliseChatBody(input.body, env.PREORDER_CHAT_MAX_MESSAGE_CHARS);
  const senderKey = senderKeyFor('CUSTOMER', actor.userId);

  const retry = await findRetry(senderKey, input.clientMessageId, { conversationId: null, body });
  if (retry !== null) return replayCustomerMessage(retry);

  await assertNotBlocked(actor.customerProfileId);
  await assertSendRate(senderKey);

  const built = await buildChatContext(input.context);
  const activeKey = activeKeyFor({
    customerProfileId: actor.customerProfileId,
    productId: built.keys.productId,
    variantKey: built.keys.variantKey,
    preorderKey: '',
  });
  const transcript = verifyTranscript(input.transcript, {
    productId: built.keys.productId,
    variantId: built.keys.variantId,
  });

  const existing = await prisma.preorderChatConversation.findUnique({
    where: { activeKey },
    select: { id: true },
  });
  if (existing !== null) {
    return continueCustomerChat(actor, existing.id, input, transcript);
  }

  await assertConversationRate(actor);

  const conversationId = newId();
  let messageId: string;
  try {
    messageId = await prisma.$transaction(async (tx) => {
      await createConversationRow(tx, actor, conversationId, built, activeKey);
      await appendTranscript(tx, conversationId, actor, transcript, input.clientMessageId);
      const id = await appendMessage(tx, {
        conversationId,
        senderType: 'CUSTOMER',
        senderUserId: actor.userId,
        clientMessageId: input.clientMessageId,
        messageType: 'TEXT',
        body,
        replyToMessageId: null,
      });
      // The customer has read their own message, and the answers before it.
      await markReadInTx(tx, conversationId, 'CUSTOMER', actor.userId, await sequenceOf(tx, id));

      const profile = await tx.customerProfile.findUnique({
        where: { id: actor.customerProfileId },
        select: { fullName: true, organization: true },
      });
      await createAdminNotification(
        {
          kind: AdminNotificationKind.PREORDER_CHAT_STARTED,
          variables: {
            productName: built.keys.productName,
            customerName: profile?.organization ?? profile?.fullName ?? null,
          },
          linkPath: `/preorder-chats/${conversationId}`,
          requiredPermission: Permission.PREORDER_CHAT_VIEW,
          relatedType: 'preorder_chat',
          relatedId: conversationId,
          dedupeKey: `preorder-chat-started:${conversationId}`,
        },
        tx,
      );
      await recordAudit(
        {
          action: AuditAction.PREORDER_CHAT_STARTED,
          resourceType: 'preorder_chat',
          resourceId: conversationId,
          actorType: 'CUSTOMER',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          after: {
            productId: built.keys.productId,
            variantId: built.keys.variantId,
            sellerAccountId: built.keys.sellerAccountId,
          },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'uq_preorder_chat_active')) {
      // Another request created it a moment ago. Join that one.
      const winner = await prisma.preorderChatConversation.findUnique({
        where: { activeKey },
        select: { id: true },
      });
      if (winner !== null) return continueCustomerChat(actor, winner.id, input, transcript);
    }
    if (isUniqueViolation(error, 'uq_preorder_chat_message_client')) {
      const replay = await findRetry(senderKey, input.clientMessageId, { conversationId: null, body });
      if (replay !== null) return replayCustomerMessage(replay);
    }
    throw error;
  }

  chatConversationsCreatedTotal.inc();
  const [conversation, message] = await Promise.all([
    loadCustomerConversationView(conversationId),
    loadMessageView(messageId, 'CUSTOMER'),
  ]);

  const seq = (message?.['seq'] as number | undefined) ?? 1;
  return {
    value: {
      conversation: conversation ?? {},
      message: message ?? {},
      created: true,
      duplicate: false,
    },
    events: [
      // Staff open a new conversation from the queue and read it whole; one
      // event for the message that started it is what their list needs.
      { kind: 'message.created', conversationId, customerProfileId: actor.customerProfileId, messageId, seq },
      {
        kind: 'conversation.updated',
        conversationId,
        customerProfileId: actor.customerProfileId,
        reason: 'created',
        staffOnly: false,
      },
    ],
  };
}

async function replayCustomerMessage(row: MessageRow): Promise<ChatOutcome<CustomerSendResult>> {
  const [conversation] = await Promise.all([loadCustomerConversationView(row.conversationId)]);
  const [message] = await serialiseMessages([row], 'CUSTOMER');
  return {
    value: { conversation: conversation ?? {}, message: message ?? {}, created: false, duplicate: true },
    events: [],
  };
}

/** A message into a conversation the customer already has. */
export async function continueCustomerChat(
  actor: CustomerActor,
  conversationId: string,
  input: z.infer<typeof customerSendSchema>,
  /** Already verified by the caller: answers read before this first message. */
  transcript: readonly TranscriptItem[] = [],
): Promise<ChatOutcome<CustomerSendResult>> {
  assertFeature();
  const body = normaliseChatBody(input.body, env.PREORDER_CHAT_MAX_MESSAGE_CHARS);
  const senderKey = senderKeyFor('CUSTOMER', actor.userId);

  const conversation = await ownedConversation(actor, conversationId);

  const retry = await findRetry(senderKey, input.clientMessageId, { conversationId, body });
  if (retry !== null) return replayCustomerMessage(retry);

  await assertNotBlocked(actor.customerProfileId);
  const outcome = onCustomerMessage(conversation.status);
  if (!outcome.accepted) refuseCustomerMessage(outcome.code);
  await assertSendRate(senderKey);

  const replyTo = await validReplyTarget(conversationId, input.replyToMessageId);

  let messageId: string;
  try {
    messageId = await prisma.$transaction(async (tx) => {
      // The status is read again under the transaction: staff may have closed
      // it between the check above and here.
      const current = await tx.preorderChatConversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { status: true },
      });
      const decided = onCustomerMessage(current.status);
      if (!decided.accepted) refuseCustomerMessage(decided.code);

      await ensureParticipant(tx, conversationId, 'CUSTOMER', actor.userId);
      await appendTranscript(tx, conversationId, actor, transcript, input.clientMessageId);
      const id = await appendMessage(tx, {
        conversationId,
        senderType: 'CUSTOMER',
        senderUserId: actor.userId,
        clientMessageId: input.clientMessageId,
        messageType: 'TEXT',
        body,
        replyToMessageId: replyTo,
        nextStatus: decided.next,
        reopened: decided.reopened,
      });
      const seq = await sequenceOf(tx, id);
      await markReadInTx(tx, conversationId, 'CUSTOMER', actor.userId, seq);

      if (decided.reopened) {
        await recordAudit(
          {
            action: AuditAction.PREORDER_CHAT_STATUS_CHANGED,
            resourceType: 'preorder_chat',
            resourceId: conversationId,
            actorType: 'CUSTOMER',
            actorUserId: actor.userId,
            actorEmail: actor.email,
            before: { status: current.status },
            after: { status: decided.next, reason: 'customer_message' },
            correlationId: actor.correlationId ?? null,
          },
          tx,
        );
      }
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'uq_preorder_chat_message_client')) {
      const replay = await findRetry(senderKey, input.clientMessageId, { conversationId, body });
      if (replay !== null) return replayCustomerMessage(replay);
    }
    throw error;
  }

  const [conversationView, message] = await Promise.all([
    loadCustomerConversationView(conversationId),
    loadMessageView(messageId, 'CUSTOMER'),
  ]);
  const seq = (message?.['seq'] as number | undefined) ?? 0;

  return {
    value: {
      conversation: conversationView ?? {},
      message: message ?? {},
      created: false,
      duplicate: false,
    },
    events: [
      { kind: 'message.created', conversationId, customerProfileId: actor.customerProfileId, messageId, seq },
      {
        kind: 'conversation.updated',
        conversationId,
        customerProfileId: actor.customerProfileId,
        reason: outcome.reopened ? 'status' : 'message',
        staffOnly: false,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Asking for a person
// ---------------------------------------------------------------------------

export const handoffSchema = z
  .object({
    /** The browser's id for this request; a retry sends the same one. */
    clientRequestId: clientMessageId,
    context: chatContextInputSchema,
    locale: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .nullable()
      .default(null),
    /** The common question the customer was on, if any. */
    topic: z.enum(FAQ_IDS).nullable().default(null),
    transcript: transcriptSchema.default([]),
  })
  .strict();

export interface HandoffResult {
  conversation: Record<string, unknown>;
  /** Every message this request stored, oldest first. */
  messages: Record<string, unknown>[];
  created: boolean;
  duplicate: boolean;
}

/** A transcript plus its request, at most. */
const HANDOFF_MESSAGES_MAX = 60;

async function replayHandoff(row: MessageRow): Promise<ChatOutcome<HandoffResult>> {
  const conversation = await loadCustomerConversationView(row.conversationId);
  const rows = await loadMessages(
    { conversationId: row.conversationId, serverSequence: { lte: row.serverSequence } },
    { orderBy: 'desc', take: HANDOFF_MESSAGES_MAX },
  );
  return {
    value: {
      conversation: conversation ?? {},
      messages: await serialiseMessages(rows.reverse(), 'CUSTOMER'),
      created: false,
      duplicate: true,
    },
    events: [],
  };
}

/**
 * "Connect with a human agent."
 *
 * Creates the conversation about this product, or reuses the live one the
 * customer already has - never a second. Into it, in one transaction: the
 * assistant answers they read (verified as this server's own), then a
 * HANDOFF_REQUEST from the customer, which starts the waiting clock and counts
 * as unread for staff like any message. The conversation is marked
 * `handoffRequestedAt`, which the queue shows as "Human assistance requested"
 * and which is unassigned until somebody takes it. Staff with
 * `preorder_chat.view` are notified. A RESOLVED conversation reopens, exactly
 * as a message would reopen it; a CLOSED one refuses, and the customer starts
 * a new one from the product page.
 *
 * Nothing here says a person is available. Whether anybody is connected is
 * `/availability`'s business, and it answers only from real connections.
 */
export async function requestHumanHandoff(
  actor: CustomerActor,
  input: z.infer<typeof handoffSchema>,
): Promise<ChatOutcome<HandoffResult>> {
  assertFeature();
  const senderKey = senderKeyFor('CUSTOMER', actor.userId);
  const findPrevious = async (): Promise<MessageRow | null> =>
    (await prisma.preorderChatMessage.findUnique({
      where: { senderKey_clientMessageId: { senderKey, clientMessageId: input.clientRequestId } },
      select: MESSAGE_SELECT,
    }));
  const replayOrRefuse = (row: MessageRow): Promise<ChatOutcome<HandoffResult>> => {
    if (row.messageType !== 'HANDOFF_REQUEST') {
      throw conflict(ErrorCode.PREORDER_CHAT_MESSAGE_ID_REUSED, 'That request id was already used for a message.');
    }
    return replayHandoff(row);
  };

  const previous = await findPrevious();
  if (previous !== null) return replayOrRefuse(previous);

  await assertNotBlocked(actor.customerProfileId);
  await assertSendRate(senderKey);

  const built = await buildChatContext(input.context);
  const transcript = verifyTranscript(input.transcript, {
    productId: built.keys.productId,
    variantId: built.keys.variantId,
  });
  const activeKey = activeKeyFor({
    customerProfileId: actor.customerProfileId,
    productId: built.keys.productId,
    variantKey: built.keys.variantKey,
    preorderKey: '',
  });

  const run = async (): Promise<{ conversationId: string; created: boolean; firstSeq: number; lastSeq: number }> => {
    const existing = await prisma.preorderChatConversation.findUnique({
      where: { activeKey },
      select: { id: true, status: true },
    });
    if (existing !== null) {
      const outcome = onCustomerMessage(existing.status);
      if (!outcome.accepted) refuseCustomerMessage(outcome.code);
    } else {
      await assertConversationRate(actor);
    }

    return prisma.$transaction(async (tx) => {
      let conversationId: string;
      let created = false;
      let before: PreorderChatStatusName = 'NEW';
      let decided: { next: PreorderChatStatusName; reopened: boolean } = { next: 'NEW', reopened: false };

      if (existing === null) {
        conversationId = newId();
        await createConversationRow(tx, actor, conversationId, built, activeKey);
        created = true;
      } else {
        conversationId = existing.id;
        // Read again under the transaction: staff may have closed it since.
        const current = await tx.preorderChatConversation.findUniqueOrThrow({
          where: { id: conversationId },
          select: { status: true },
        });
        const outcome = onCustomerMessage(current.status);
        if (!outcome.accepted) refuseCustomerMessage(outcome.code);
        before = current.status;
        decided = { next: outcome.next, reopened: outcome.reopened };
        await ensureParticipant(tx, conversationId, 'CUSTOMER', actor.userId);
      }

      const start = await tx.preorderChatConversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { lastSequence: true },
      });
      await appendTranscript(tx, conversationId, actor, transcript, input.clientRequestId);
      const now = new Date();
      const handoffId = await appendMessage(tx, {
        conversationId,
        senderType: 'CUSTOMER',
        senderUserId: actor.userId,
        clientMessageId: input.clientRequestId,
        messageType: 'HANDOFF_REQUEST',
        body: '',
        systemEvent: 'handoff.requested',
        systemMeta: { topic: input.topic },
        nextStatus: decided.next,
        reopened: decided.reopened,
        now,
      });
      const lastSeq = await sequenceOf(tx, handoffId);
      await tx.preorderChatConversation.update({
        where: { id: conversationId },
        data: { handoffRequestedAt: now, handoffTopic: input.topic },
      });
      // The customer has read the answers they were shown and their own request.
      await markReadInTx(tx, conversationId, 'CUSTOMER', actor.userId, lastSeq);

      const profile = await tx.customerProfile.findUnique({
        where: { id: actor.customerProfileId },
        select: { fullName: true, organization: true },
      });
      await createAdminNotification(
        {
          kind: AdminNotificationKind.PREORDER_CHAT_HANDOFF,
          variables: {
            productName: built.keys.productName,
            customerName: profile?.organization ?? profile?.fullName ?? null,
            topic: input.topic,
          },
          linkPath: `/preorder-chats/${conversationId}`,
          requiredPermission: Permission.PREORDER_CHAT_VIEW,
          relatedType: 'preorder_chat',
          relatedId: conversationId,
          dedupeKey: `preorder-chat-handoff:${handoffId}`,
        },
        tx,
      );
      await recordAudit(
        {
          action: created ? AuditAction.PREORDER_CHAT_STARTED : AuditAction.PREORDER_CHAT_HANDOFF_REQUESTED,
          resourceType: 'preorder_chat',
          resourceId: conversationId,
          actorType: 'CUSTOMER',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          ...(created ? {} : { before: { status: before } }),
          after: {
            reason: 'handoff_requested',
            topic: input.topic,
            answersRead: transcript.length,
            status: decided.next,
            productId: built.keys.productId,
            variantId: built.keys.variantId,
            sellerAccountId: built.keys.sellerAccountId,
          },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
      return { conversationId, created, firstSeq: start.lastSequence + 1, lastSeq };
    });
  };

  let stored: Awaited<ReturnType<typeof run>>;
  try {
    stored = await run();
  } catch (error) {
    if (isUniqueViolation(error, 'uq_preorder_chat_active')) {
      // Two first requests racing: the loser joins the conversation the
      // winner created.
      stored = await run();
    } else if (isUniqueViolation(error, 'uq_preorder_chat_message_client')) {
      const replay = await findPrevious();
      if (replay === null) throw error;
      return replayOrRefuse(replay);
    } else {
      throw error;
    }
  }

  if (stored.created) chatConversationsCreatedTotal.inc();
  const [conversation, rows] = await Promise.all([
    loadCustomerConversationView(stored.conversationId),
    loadMessages(
      {
        conversationId: stored.conversationId,
        serverSequence: { gte: stored.firstSeq, lte: stored.lastSeq },
      },
      { orderBy: 'asc', take: HANDOFF_MESSAGES_MAX },
    ),
  ]);

  return {
    value: {
      conversation: conversation ?? {},
      messages: await serialiseMessages(rows, 'CUSTOMER'),
      created: stored.created,
      duplicate: false,
    },
    events: [
      ...rows.map((row) => ({
        kind: 'message.created' as const,
        conversationId: stored.conversationId,
        customerProfileId: actor.customerProfileId,
        messageId: row.id,
        seq: row.serverSequence,
      })),
      {
        kind: 'conversation.updated' as const,
        conversationId: stored.conversationId,
        customerProfileId: actor.customerProfileId,
        reason: stored.created ? ('created' as const) : ('status' as const),
        staffOnly: false,
      },
    ],
  };
}

async function sequenceOf(tx: PrismaTransaction, messageId: string): Promise<number> {
  const row = await tx.preorderChatMessage.findUniqueOrThrow({
    where: { id: messageId },
    select: { serverSequence: true },
  });
  return row.serverSequence;
}

/** A reply-to must be a message in the same conversation. */
async function validReplyTarget(
  conversationId: string,
  replyToMessageId: string | null,
): Promise<string | null> {
  if (replyToMessageId === null) return null;
  const target = await prisma.preorderChatMessage.findFirst({
    where: { id: replyToMessageId, conversationId },
    select: { id: true },
  });
  return target?.id ?? null;
}

async function ensureParticipant(
  tx: PrismaTransaction,
  conversationId: string,
  type: 'CUSTOMER' | 'ADMIN',
  userId: string,
): Promise<void> {
  await tx.preorderChatParticipant.upsert({
    where: { conversationId_userId: { conversationId, userId } },
    update: {},
    create: { id: newId(), conversationId, participantType: type, userId },
  });
}

/** The customer's conversations, newest activity first, by cursor. */
export async function listCustomerConversations(
  actor: CustomerActor,
  query: { cursor?: string | undefined; limit: number },
): Promise<{ conversations: Record<string, unknown>[]; nextCursor: string | null }> {
  assertFeature();
  const cursor = decodeCursor(query.cursor);
  const rows = (await prisma.preorderChatConversation.findMany({
    where: {
      customerProfileId: actor.customerProfileId,
      ...(cursor === null
        ? {}
        : {
            OR: [
              { lastMessageAt: { lt: cursor.at } },
              { lastMessageAt: cursor.at, id: { lt: cursor.id } },
            ],
          }),
    },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    select: CUSTOMER_CONVERSATION_SELECT,
  })) as CustomerConversationRow[];

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    conversations: page.map(customerConversationView),
    nextCursor:
      rows.length > query.limit && last !== undefined ? encodeCursor(last.lastMessageAt, last.id) : null,
  };
}

export async function getCustomerConversation(
  actor: CustomerActor,
  conversationId: string,
): Promise<Record<string, unknown>> {
  assertFeature();
  await ownedConversation(actor, conversationId);
  return (await loadCustomerConversationView(conversationId)) ?? {};
}

/** Every conversation's unread replies, added up, for the account badge. */
/**
 * Staff replies this customer has not read, across their conversations - or,
 * given a product, across their conversations about that product only, for
 * the badge on that product page's chat icon. The customer is always the one
 * signed in; a product id can only narrow their own count.
 */
export async function customerUnreadTotal(
  actor: CustomerActor,
  productId: string | null = null,
): Promise<number> {
  if (!env.FEATURE_PREORDER_CHAT) return 0;
  const rows = await prisma.preorderChatConversation.findMany({
    where: {
      customerProfileId: actor.customerProfileId,
      ...(productId === null ? {} : { productId }),
      staffMessageCount: { gt: prisma.preorderChatConversation.fields.customerReadStaffCount },
    },
    select: { staffMessageCount: true, customerReadStaffCount: true },
    take: 500,
  });
  return rows.reduce(
    (total, row) => total + Math.max(0, row.staffMessageCount - row.customerReadStaffCount),
    0,
  );
}

/**
 * A page of history.
 *
 * `after` is the reconnect path: "everything since the last sequence I have",
 * oldest first, so a browser that was offline appends in order and dedupes on
 * the sequence. `before` is "load earlier": newest first from the server,
 * handed back oldest first.
 */
async function history(
  conversationId: string,
  query: HistoryQuery,
  side: ChatSide,
): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
  if (query.after !== undefined) {
    const rows = await loadMessages(
      { conversationId, serverSequence: { gt: query.after } },
      { orderBy: 'asc', take: query.limit + 1 },
    );
    return {
      messages: await serialiseMessages(rows.slice(0, query.limit), side),
      hasMore: rows.length > query.limit,
    };
  }

  const rows = await loadMessages(
    {
      conversationId,
      ...(query.before === undefined ? {} : { serverSequence: { lt: query.before } }),
    },
    { orderBy: 'desc', take: query.limit + 1 },
  );
  const page = rows.slice(0, query.limit).reverse();
  return { messages: await serialiseMessages(page, side), hasMore: rows.length > query.limit };
}

export async function listCustomerMessages(
  actor: CustomerActor,
  conversationId: string,
  query: HistoryQuery,
): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
  assertFeature();
  await ownedConversation(actor, conversationId);
  return history(conversationId, query, 'CUSTOMER');
}

// ---------------------------------------------------------------------------
// Read and delivered positions
// ---------------------------------------------------------------------------

/**
 * Move one side's read position forward, never back.
 *
 * `seq` is clamped to what exists, so a browser cannot mark tomorrow's message
 * read, and the unread count comes from the server's own count of the other
 * side's messages up to that point - a client never says how many it read.
 */
async function markReadInTx(
  tx: PrismaTransaction,
  conversationId: string,
  side: ChatSide,
  userId: string,
  requestedSeq: number,
): Promise<{ readSeq: number; deliveredSeq: number; moved: boolean }> {
  const conversation = await tx.preorderChatConversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: {
      lastSequence: true,
      customerReadSeq: true,
      staffReadSeq: true,
      customerDeliveredSeq: true,
      staffDeliveredSeq: true,
    },
  });
  const seq = Math.min(requestedSeq, conversation.lastSequence);
  const participantType = side === 'CUSTOMER' ? 'CUSTOMER' : 'ADMIN';

  await tx.preorderChatParticipant.upsert({
    where: { conversationId_userId: { conversationId, userId } },
    update: {},
    create: { id: newId(), conversationId, participantType, userId },
  });
  await tx.preorderChatParticipant.updateMany({
    where: { conversationId, userId, lastReadSeq: { lt: seq } },
    data: { lastReadSeq: seq, lastReadAt: new Date() },
  });

  const currentRead = side === 'CUSTOMER' ? conversation.customerReadSeq : conversation.staffReadSeq;
  const currentDelivered =
    side === 'CUSTOMER' ? conversation.customerDeliveredSeq : conversation.staffDeliveredSeq;
  if (seq <= currentRead) {
    return { readSeq: currentRead, deliveredSeq: currentDelivered, moved: false };
  }

  // How many of the OTHER side's messages exist up to `seq`.
  const otherSeen = await tx.preorderChatMessage.count({
    where: {
      conversationId,
      serverSequence: { lte: seq },
      // The assistant's answers are on the team's side of the count: they
      // are what the customer reads, like a system card.
      senderType: side === 'CUSTOMER' ? { in: ['ADMIN', 'SYSTEM', 'AUTOMATION'] } : 'CUSTOMER',
    },
  });
  const deliveredSeq = Math.max(currentDelivered, seq);

  await tx.preorderChatConversation.update({
    where: { id: conversationId },
    data:
      side === 'CUSTOMER'
        ? { customerReadSeq: seq, customerDeliveredSeq: deliveredSeq, customerReadStaffCount: otherSeen }
        : { staffReadSeq: seq, staffDeliveredSeq: deliveredSeq, staffReadCustomerCount: otherSeen },
  });
  await stampDelivered(tx, conversationId, side, deliveredSeq);
  return { readSeq: seq, deliveredSeq, moved: true };
}

/** `deliveredAt` on the other side's messages, the first time they are shown. */
async function stampDelivered(
  tx: PrismaTransaction | typeof prisma,
  conversationId: string,
  readerSide: ChatSide,
  upToSeq: number,
): Promise<void> {
  await tx.preorderChatMessage.updateMany({
    where: {
      conversationId,
      serverSequence: { lte: upToSeq },
      deliveredAt: null,
      senderType: readerSide === 'CUSTOMER' ? { in: ['ADMIN', 'SYSTEM', 'AUTOMATION'] } : 'CUSTOMER',
    },
    data: { deliveredAt: new Date() },
  });
}

function receiptEvent(
  conversationId: string,
  customerProfileId: string,
  side: ChatSide,
  position: { readSeq: number; deliveredSeq: number },
): ChatBusEvent {
  return {
    kind: 'receipt',
    conversationId,
    customerProfileId,
    side,
    deliveredSeq: position.deliveredSeq,
    readSeq: position.readSeq,
  };
}

export async function markCustomerRead(
  actor: CustomerActor,
  conversationId: string,
  seq: number,
): Promise<ChatOutcome<{ readSeq: number; unreadCount: number }>> {
  assertFeature();
  await ownedConversation(actor, conversationId);
  const position = await prisma.$transaction((tx) =>
    markReadInTx(tx, conversationId, 'CUSTOMER', actor.userId, seq),
  );
  const view = await loadCustomerConversationView(conversationId);
  return {
    value: { readSeq: position.readSeq, unreadCount: (view?.['unreadCount'] as number | undefined) ?? 0 },
    events: position.moved
      ? [receiptEvent(conversationId, actor.customerProfileId, 'CUSTOMER', position)]
      : [],
  };
}

/**
 * "This browser has been shown up to `seq`", from a connected socket.
 *
 * Only ever moves the position of the socket's OWN side, and only forward. The
 * caller has already established that the socket may see the conversation.
 */
export async function markDelivered(
  conversationId: string,
  side: ChatSide,
  requestedSeq: number,
): Promise<ChatBusEvent | null> {
  const conversation = await prisma.preorderChatConversation.findUnique({
    where: { id: conversationId },
    select: {
      customerProfileId: true,
      lastSequence: true,
      customerDeliveredSeq: true,
      staffDeliveredSeq: true,
      customerReadSeq: true,
      staffReadSeq: true,
    },
  });
  if (conversation === null) return null;
  const seq = Math.min(requestedSeq, conversation.lastSequence);

  // Conditional, so two sockets reporting at once cannot move it backwards.
  const moved =
    side === 'CUSTOMER'
      ? await prisma.preorderChatConversation.updateMany({
          where: { id: conversationId, customerDeliveredSeq: { lt: seq } },
          data: { customerDeliveredSeq: seq },
        })
      : await prisma.preorderChatConversation.updateMany({
          where: { id: conversationId, staffDeliveredSeq: { lt: seq } },
          data: { staffDeliveredSeq: seq },
        });
  if (moved.count === 0) return null;
  await stampDelivered(prisma, conversationId, side, seq);

  return receiptEvent(conversationId, conversation.customerProfileId, side, {
    deliveredSeq: seq,
    readSeq: side === 'CUSTOMER' ? conversation.customerReadSeq : conversation.staffReadSeq,
  });
}

// ---------------------------------------------------------------------------
// The staff side: reading
// ---------------------------------------------------------------------------

export const STAFF_FILTERS = [
  'all',
  'unassigned',
  'human_requested',
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
export type StaffFilter = (typeof STAFF_FILTERS)[number];

export const STAFF_SORTS = ['newest', 'oldest_unanswered', 'priority', 'longest_waiting'] as const;
export type StaffSort = (typeof STAFF_SORTS)[number];

export const staffListQuerySchema = z.object({
  filter: z.enum(STAFF_FILTERS).default('all'),
  sort: z.enum(STAFF_SORTS).default('newest'),
  q: z.string().trim().max(120).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type StaffListQuery = z.infer<typeof staffListQuerySchema>;

function filterWhere(filter: StaffFilter, actor: StaffActor): Prisma.PreorderChatConversationWhereInput {
  switch (filter) {
    case 'all':
      // Everything except what moderation has set aside. Spam and blocked have
      // their own tab; mixing them in is how a queue fills with noise.
      return { status: { notIn: ['SPAM', 'BLOCKED'] } };
    case 'unassigned':
      return { assignedAdminId: null, status: { in: [...WORKING_STATUSES] } };
    case 'human_requested':
      // Asked the assistant for a person, and no member of staff has replied
      // since - the conversations where "a person will answer here" is a
      // promise still to keep.
      return {
        handoffRequestedAt: { not: null },
        status: { in: [...WORKING_STATUSES] },
        OR: [
          { lastStaffMessageAt: null },
          { lastStaffMessageAt: { lt: prisma.preorderChatConversation.fields.handoffRequestedAt } },
        ],
      };
    case 'mine':
      return { assignedAdminId: actor.userId, status: { notIn: ['SPAM', 'BLOCKED'] } };
    case 'unread':
      return {
        status: { notIn: ['SPAM', 'BLOCKED'] },
        customerMessageCount: { gt: prisma.preorderChatConversation.fields.staffReadCustomerCount },
      };
    case 'priority':
      // High and urgent conversations somebody still has to work on. A
      // resolved urgent one has been dealt with and is not in the way.
      return { priority: { in: ['HIGH', 'URGENT'] }, status: { in: [...WORKING_STATUSES] } };
    case 'open':
      return { status: { in: ['NEW', 'OPEN'] } };
    case 'waiting_customer':
      return { status: 'WAITING_FOR_CUSTOMER' };
    case 'waiting_internal':
      return { status: 'WAITING_FOR_INTERNAL' };
    case 'resolved':
      return { status: 'RESOLVED' };
    case 'closed':
      return { status: 'CLOSED' };
    case 'spam':
      return { status: { in: ['SPAM', 'BLOCKED'] } };
  }
}

/**
 * Search, across what staff may search on.
 *
 * The customer's email is searched only for somebody who may SEE it - a search
 * that answers "is anyone@example.com a customer here?" is a way to read the
 * field without the grant.
 */
function searchWhere(q: string, actor: StaffActor): Prisma.PreorderChatConversationWhereInput {
  const term = q.trim();
  const byId = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(term)
    ? [{ id: term.toUpperCase() }, { preorderRequestId: term.toUpperCase() }]
    : [];
  return {
    OR: [
      ...byId,
      { productName: { contains: term } },
      { productSku: { contains: term } },
      { sellerName: { contains: term } },
      { customerProfile: { fullName: { contains: term } } },
      { customerProfile: { organization: { contains: term } } },
      ...(actor.permissions.has(Permission.CUSTOMER_READ)
        ? [{ customerProfile: { user: { email: { contains: term } } } }]
        : []),
      { preorderRequest: { requestNumber: { contains: term } } },
      { messages: { some: { body: { contains: term }, redactedAt: null } } },
    ],
  };
}

/** Cursors are opaque to the client and carry the sort key and the id. */
function encodeCursor(at: Date | null, id: string, rank?: number): string {
  return Buffer.from(JSON.stringify({ t: at?.getTime() ?? null, i: id, r: rank ?? null })).toString(
    'base64url',
  );
}

function decodeCursor(
  raw: string | undefined,
): { at: Date; id: string; rawAt: number | null; rank: number | null } | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      t?: unknown;
      i?: unknown;
      r?: unknown;
    };
    if (typeof parsed.i !== 'string') return null;
    const rawAt = typeof parsed.t === 'number' ? parsed.t : null;
    return {
      at: new Date(rawAt ?? 0),
      id: parsed.i,
      rawAt,
      rank: typeof parsed.r === 'number' ? parsed.r : null,
    };
  } catch {
    return null;
  }
}

const PRIORITY_RANK: Readonly<Record<string, number>> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

/**
 * The inbox, one page at a time.
 *
 * Keyset pagination on (sort key, id) rather than an offset, so a page does
 * not shift under somebody reading it while new conversations arrive. The
 * list reads conversation rows only - never message history.
 */
export async function listStaffConversations(
  actor: StaffActor,
  query: StaffListQuery,
): Promise<{ conversations: Record<string, unknown>[]; nextCursor: string | null }> {
  assertFeature();
  const cursor = decodeCursor(query.cursor);
  const and: Prisma.PreorderChatConversationWhereInput[] = [filterWhere(query.filter, actor)];
  if (query.q !== undefined && query.q.length > 0) and.push(searchWhere(query.q, actor));

  let orderBy: Prisma.PreorderChatConversationOrderByWithRelationInput[];

  switch (query.sort) {
    case 'oldest_unanswered':
    case 'longest_waiting':
      // Only conversations somebody is waiting on, oldest wait first.
      and.push({ awaitingReplySince: { not: null } });
      orderBy = [{ awaitingReplySince: 'asc' }, { id: 'asc' }];
      if (cursor !== null) {
        and.push({
          OR: [
            { awaitingReplySince: { gt: cursor.at } },
            { awaitingReplySince: cursor.at, id: { gt: cursor.id } },
          ],
        });
      }
      break;
    case 'priority': {
      // Prisma orders an enum by its declaration order (LOW..URGENT), so
      // priority is paged one level at a time from URGENT down.
      const levels = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;
      const startRank = cursor?.rank ?? 0;
      const collected: StaffConversationRow[] = [];
      let nextCursor: string | null = null;
      for (let rank = startRank; rank < levels.length && collected.length <= query.limit; rank += 1) {
        const level = levels[rank] as (typeof levels)[number];
        const rows = (await prisma.preorderChatConversation.findMany({
          where: {
            AND: [
              ...and,
              { priority: level },
              ...(cursor !== null && rank === startRank
                ? [
                    {
                      OR: [
                        { lastMessageAt: { lt: cursor.at } },
                        { lastMessageAt: cursor.at, id: { lt: cursor.id } },
                      ],
                    },
                  ]
                : []),
            ],
          },
          orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1 - collected.length,
          select: STAFF_CONVERSATION_SELECT,
        })) as StaffConversationRow[];
        collected.push(...rows);
      }
      const page = collected.slice(0, query.limit);
      const last = page.at(-1);
      if (collected.length > query.limit && last !== undefined) {
        nextCursor = encodeCursor(last.lastMessageAt, last.id, PRIORITY_RANK[last.priority] ?? 0);
      }
      const viewer = staffViewer(actor);
      return { conversations: page.map((row) => staffConversationSummary(row, viewer)), nextCursor };
    }
    default:
      orderBy = [{ lastMessageAt: 'desc' }, { id: 'desc' }];
      if (cursor !== null) {
        and.push({
          OR: [
            { lastMessageAt: { lt: cursor.at } },
            { lastMessageAt: cursor.at, id: { lt: cursor.id } },
          ],
        });
      }
  }

  const rows = (await prisma.preorderChatConversation.findMany({
    where: { AND: and },
    orderBy,
    take: query.limit + 1,
    select: STAFF_CONVERSATION_SELECT,
  })) as StaffConversationRow[];

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const viewer = staffViewer(actor);
  const waitingSort = query.sort === 'oldest_unanswered' || query.sort === 'longest_waiting';

  return {
    conversations: page.map((row) => staffConversationSummary(row, viewer)),
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? encodeCursor(waitingSort ? last.awaitingReplySince : last.lastMessageAt, last.id)
        : null,
  };
}

/** How many conversations sit behind each tab, for the tab labels. */
export async function staffInboxCounts(actor: StaffActor): Promise<Record<StaffFilter, number>> {
  assertFeature();
  const entries = await Promise.all(
    STAFF_FILTERS.map(
      async (filter) =>
        [
          filter,
          await prisma.preorderChatConversation.count({ where: filterWhere(filter, actor) }),
        ] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<StaffFilter, number>;
}

/** Load a conversation for staff, or 404. */
export async function staffConversationRow(conversationId: string): Promise<StaffConversationRow> {
  const row = (await prisma.preorderChatConversation.findUnique({
    where: { id: conversationId },
    select: STAFF_CONVERSATION_SELECT,
  })) as StaffConversationRow | null;
  if (row === null) throw notFound('Conversation');
  return row;
}

/** How long one person's opening of a conversation counts as one view. */
const VIEW_AUDIT_WINDOW_MS = 30 * 60_000;

/**
 * One conversation, with its context panel.
 *
 * Opening it is recorded on the audit trail - it is a private negotiation and
 * "who at the business read it" is a question an operator must be able to
 * answer - but once per person per half hour, so a trail is not a log of every
 * click.
 */
export async function getStaffConversation(
  actor: StaffActor,
  conversationId: string,
): Promise<Record<string, unknown>> {
  assertFeature();
  const row = await staffConversationRow(conversationId);

  const product = await prisma.product.findUnique({
    where: { id: row.productId },
    select: { id: true, name: true, slug: true, status: true, isPublished: true, archivedAt: true, currency: true },
  });
  const offer =
    row.offerId === null
      ? null
      : await prisma.sellerOffer.findUnique({ where: { id: row.offerId }, select: { currency: true } });

  const recentlyViewed = await prisma.auditLog.findFirst({
    where: {
      action: AuditAction.PREORDER_CHAT_VIEWED,
      resourceType: 'preorder_chat',
      resourceId: conversationId,
      actorUserId: actor.userId,
      createdAt: { gt: new Date(Date.now() - VIEW_AUDIT_WINDOW_MS) },
    },
    select: { id: true },
  });
  if (recentlyViewed === null) {
    await recordAudit({
      action: AuditAction.PREORDER_CHAT_VIEWED,
      resourceType: 'preorder_chat',
      resourceId: conversationId,
      actorType: 'ADMIN',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      after: { withCustomerEmail: actor.permissions.has(Permission.CUSTOMER_READ) },
      ipAddress: actor.ipAddress ?? null,
      correlationId: actor.correlationId ?? null,
    });
  }

  return staffConversationDetail(row, staffViewer(actor), {
    currentProduct:
      product === null
        ? null
        : {
            id: product.id,
            name: product.name,
            slug: product.slug,
            isLive: product.status === 'ACTIVE' && product.isPublished && product.archivedAt === null,
          },
    pricingCurrency: offer?.currency ?? product?.currency ?? env.DEFAULT_CURRENCY,
  });
}

export async function listStaffMessages(
  conversationId: string,
  query: HistoryQuery,
): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
  assertFeature();
  await staffConversationRow(conversationId);
  return history(conversationId, query, 'STAFF');
}

export async function markStaffRead(
  actor: StaffActor,
  conversationId: string,
  seq: number,
): Promise<ChatOutcome<{ readSeq: number }>> {
  assertFeature();
  const row = await staffConversationRow(conversationId);
  const position = await prisma.$transaction((tx) =>
    markReadInTx(tx, conversationId, 'STAFF', actor.userId, seq),
  );
  return {
    value: { readSeq: position.readSeq },
    events: position.moved
      ? [
          receiptEvent(conversationId, row.customerProfileId, 'STAFF', position),
          {
            kind: 'conversation.updated',
            conversationId,
            customerProfileId: row.customerProfileId,
            reason: 'receipt',
            staffOnly: true,
          },
        ]
      : [],
  };
}

// ---------------------------------------------------------------------------
// The staff side: replying
// ---------------------------------------------------------------------------

export interface StaffSendResult {
  message: Record<string, unknown>;
  conversation: Record<string, unknown>;
  duplicate: boolean;
}

/**
 * A reply to the customer.
 *
 * The first reply to an unassigned conversation assigns it to whoever wrote
 * it - the person who answered is the person the customer now expects to hear
 * from - and the SLA alert, if one was raised, closes.
 */
export async function sendStaffMessage(
  actor: StaffActor,
  conversationId: string,
  input: z.infer<typeof staffSendSchema>,
): Promise<ChatOutcome<StaffSendResult>> {
  assertFeature();
  const body = normaliseChatBody(input.body, env.PREORDER_CHAT_MAX_MESSAGE_CHARS);
  const senderKey = senderKeyFor('ADMIN', actor.userId);
  const row = await staffConversationRow(conversationId);

  const retry = await findRetry(senderKey, input.clientMessageId, { conversationId, body });
  if (retry !== null) {
    const [message] = await serialiseMessages([retry], 'STAFF');
    return {
      value: {
        message: message ?? {},
        conversation: staffConversationSummary(row, staffViewer(actor)),
        duplicate: true,
      },
      events: [],
    };
  }

  const decided = onStaffMessage(row.status);
  if (!decided.accepted) {
    throw conflict(
      ErrorCode.PREORDER_CHAT_CLOSED,
      'This conversation is closed. Reopen it before replying.',
    );
  }
  await assertSendRate(senderKey);
  const replyTo = await validReplyTarget(conversationId, input.replyToMessageId);

  let assignedNow = false;
  let joinedId: string | null = null;
  let messageId: string;
  try {
    messageId = await prisma.$transaction(async (tx) => {
      joinedId = null;
      const current = await tx.preorderChatConversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { status: true, assignedAdminId: true, handoffRequestedAt: true, lastStaffMessageAt: true },
      });
      const again = onStaffMessage(current.status);
      if (!again.accepted) {
        throw conflict(
          ErrorCode.PREORDER_CHAT_CLOSED,
          'This conversation is closed. Reopen it before replying.',
        );
      }

      // The customer asked the assistant for a person, and this is the first
      // person to answer since: say so, once, above the reply. Keyed on the
      // request's time, so a second request later gets its own line.
      if (
        current.handoffRequestedAt !== null &&
        (current.lastStaffMessageAt === null || current.lastStaffMessageAt < current.handoffRequestedAt)
      ) {
        joinedId = await appendSystemMessage(
          tx,
          conversationId,
          'handoff.joined',
          {},
          `handoff-joined:${current.handoffRequestedAt.getTime()}`,
        );
      }

      if (current.assignedAdminId === null) {
        await tx.preorderChatConversation.update({
          where: { id: conversationId },
          data: { assignedAdminId: actor.userId, assignedAt: new Date() },
        });
        assignedNow = true;
        await recordAudit(
          {
            action: AuditAction.PREORDER_CHAT_ASSIGNED,
            resourceType: 'preorder_chat',
            resourceId: conversationId,
            actorType: 'ADMIN',
            actorUserId: actor.userId,
            actorEmail: actor.email,
            before: { assignedAdminId: null },
            after: { assignedAdminId: actor.userId, reason: 'first_reply' },
            correlationId: actor.correlationId ?? null,
          },
          tx,
        );
      }

      await ensureParticipant(tx, conversationId, 'ADMIN', actor.userId);
      const id = await appendMessage(tx, {
        conversationId,
        senderType: 'ADMIN',
        senderUserId: actor.userId,
        clientMessageId: input.clientMessageId,
        messageType: 'TEXT',
        body,
        replyToMessageId: replyTo,
        nextStatus: again.next,
        reopened: current.status === 'RESOLVED',
      });
      const seq = await sequenceOf(tx, id);
      await markReadInTx(tx, conversationId, 'STAFF', actor.userId, seq);

      await resolveAdminNotifications(
        {
          resolutionKey: ResolutionKey.preorderChatReply(conversationId),
          reason: 'A member of staff replied.',
          source: 'DOMAIN_EVENT',
        },
        tx,
      );
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'uq_preorder_chat_message_client')) {
      const replay = await findRetry(senderKey, input.clientMessageId, { conversationId, body });
      if (replay !== null) {
        const [message] = await serialiseMessages([replay], 'STAFF');
        return {
          value: {
            message: message ?? {},
            conversation: staffConversationSummary(await staffConversationRow(conversationId), staffViewer(actor)),
            duplicate: true,
          },
          events: [],
        };
      }
    }
    throw error;
  }

  const [message, conversation] = await Promise.all([
    loadMessageView(messageId, 'STAFF'),
    loadStaffConversationSummary(conversationId, staffViewer(actor)),
  ]);
  const seq = (message?.['seq'] as number | undefined) ?? 0;
  const joined: string | null = joinedId;

  return {
    value: { message: message ?? {}, conversation: conversation ?? {}, duplicate: false },
    events: [
      ...(joined === null
        ? []
        : [
            {
              kind: 'message.created' as const,
              conversationId,
              customerProfileId: row.customerProfileId,
              messageId: joined,
              seq: seq - 1,
            },
          ]),
      { kind: 'message.created', conversationId, customerProfileId: row.customerProfileId, messageId, seq },
      {
        kind: 'conversation.updated',
        conversationId,
        customerProfileId: row.customerProfileId,
        reason: assignedNow ? 'assigned' : 'message',
        staffOnly: false,
      },
    ],
  };
}

/** SHA-256 of a message body, for the redaction record. */
export function bodyFingerprint(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Re-throw anything that is not ours as-is; shape ours consistently. */
export function isChatError(error: unknown): error is AppError {
  return error instanceof AppError;
}
