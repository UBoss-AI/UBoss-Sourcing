/**
 * What staff do TO a conversation, as opposed to writing in it.
 *
 * Assignment, status, priority, tags, internal notes, linking a preorder,
 * blocking a customer, redacting a message, taking a transcript. Every one of
 * them is audited, every one names the permission it needs, and the ones a
 * customer should know about leave a system card in the conversation - in
 * words each reader's own screen chooses, never prose stored here.
 *
 * Status is moved ONLY through `domain/preorder-chat-state.ts`.
 */
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { Permission, permissionsForRoles } from '../../domain/permissions.js';
import {
  PreorderChatPriorityValues,
  PreorderChatStatusValues,
  activeKeyFor,
  assertStaffTransition,
  holdsActiveKey,
  type PreorderChatStatusName,
} from '../../domain/preorder-chat-state.js';
import { cleanChatText, normaliseChatBody, previewOf } from '../../domain/chat-text.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { enqueueNotification, NotificationEvent } from '../notifications/notification.service.js';
import {
  appendSystemMessage,
  bodyFingerprint,
  loadStaffConversationSummary,
  serialiseMessages,
  staffConversationRow,
  staffViewer,
  type ChatOutcome,
  type StaffActor,
} from './conversation.service.js';
import { chatResolutionSeconds } from './metrics.js';
import type { ChatBusEvent } from './realtime/events.js';
import { MESSAGE_SELECT, tagsOf, type MessageRow } from './views.js';

function requirePermission(actor: StaffActor, permission: string): void {
  if (!actor.permissions.has(permission)) {
    throw forbidden(ErrorCode.PERMISSION_DENIED, 'You do not have permission to perform this action.');
  }
}

function updatedEvent(
  conversationId: string,
  customerProfileId: string,
  reason: Extract<ChatBusEvent, { kind: 'conversation.updated' }>['reason'],
  staffOnly: boolean,
): ChatBusEvent {
  return { kind: 'conversation.updated', conversationId, customerProfileId, reason, staffOnly };
}

function messageEvents(
  conversationId: string,
  customerProfileId: string,
  messageId: string | null,
  seq: number,
): ChatBusEvent[] {
  return messageId === null
    ? []
    : [{ kind: 'message.created', conversationId, customerProfileId, messageId, seq }];
}

async function seqOf(messageId: string | null): Promise<number> {
  if (messageId === null) return 0;
  const row = await prisma.preorderChatMessage.findUnique({
    where: { id: messageId },
    select: { serverSequence: true },
  });
  return row?.serverSequence ?? 0;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export const assignSchema = z
  .object({
    /** Null takes it off whoever holds it. */
    assigneeUserId: z.string().length(26).nullable(),
  })
  .strict();

/** Staff who may be given a conversation: active, and able to reply. */
export async function listEligibleAssignees(): Promise<{ id: string; email: string }[]> {
  const users = await prisma.user.findMany({
    where: { type: 'ADMIN', status: 'ACTIVE', archivedAt: null },
    select: { id: true, email: true, roles: { select: { role: { select: { key: true } } } } },
    orderBy: { email: 'asc' },
    take: 500,
  });
  return users
    .filter((user) =>
      permissionsForRoles(user.roles.map((assignment) => assignment.role.key)).has(
        Permission.PREORDER_CHAT_REPLY,
      ),
    )
    .map((user) => ({ id: user.id, email: user.email }));
}

/**
 * Give a conversation to somebody, take it, or put it back in the queue.
 *
 * Taking it yourself needs only the reply permission - picking up the next
 * customer is the job. Giving it to somebody else, or taking it off them,
 * needs `preorder_chat.assign`, because it decides a colleague's workload.
 */
export async function assignConversation(
  actor: StaffActor,
  conversationId: string,
  input: z.infer<typeof assignSchema>,
): Promise<ChatOutcome<Record<string, unknown>>> {
  const row = await staffConversationRow(conversationId);
  const target = input.assigneeUserId;

  const selfTake = target === actor.userId;
  const selfRelease = target === null && row.assignedAdminId === actor.userId;
  requirePermission(
    actor,
    selfTake || selfRelease ? Permission.PREORDER_CHAT_REPLY : Permission.PREORDER_CHAT_ASSIGN,
  );

  if (target !== null) {
    const eligible = await listEligibleAssignees();
    if (!eligible.some((candidate) => candidate.id === target)) {
      throw badRequest(
        ErrorCode.PREORDER_CHAT_ASSIGNEE_NOT_ELIGIBLE,
        'That member of staff cannot answer preorder chats.',
        [{ field: 'assigneeUserId', code: 'NOT_ELIGIBLE' }],
      );
    }
  }

  if (row.assignedAdminId === target) {
    return { value: (await loadStaffConversationSummary(conversationId, staffViewer(actor))) ?? {}, events: [] };
  }

  await prisma.$transaction(async (tx) => {
    await tx.preorderChatConversation.update({
      where: { id: conversationId },
      data: {
        assignedAdminId: target,
        assignedAt: target === null ? null : new Date(),
        version: { increment: 1 },
      },
    });
    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_ASSIGNED,
        resourceType: 'preorder_chat',
        resourceId: conversationId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { assignedAdminId: row.assignedAdminId },
        after: { assignedAdminId: target },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    // A colleague handed it over: tell them, outside the building too.
    if (target !== null && target !== actor.userId) {
      const assignee = await tx.user.findUnique({ where: { id: target }, select: { email: true } });
      if (assignee !== null) {
        await enqueueNotification(
          {
            eventKey: NotificationEvent.PREORDER_CHAT_ASSIGNED,
            recipientEmail: assignee.email,
            variables: {
              productName: row.productName,
              assignedBy: actor.email,
              consoleUrl: `${env.ADMIN_WEB_PUBLIC_URL.replace(/\/$/, '')}/preorder-chats/${conversationId}`,
            },
            dedupeKey: `preorder-chat-assigned:${conversationId}:${target}:${String(row.version)}`,
            relatedType: 'preorder_chat',
            relatedId: conversationId,
          },
          tx,
        );
      }
    }
  });

  return {
    value: (await loadStaffConversationSummary(conversationId, staffViewer(actor))) ?? {},
    events: [updatedEvent(conversationId, row.customerProfileId, 'assigned', true)],
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const statusSchema = z
  .object({
    status: z.enum(PreorderChatStatusValues),
    reason: z.string().trim().max(500).nullable().default(null),
  })
  .strict();

/**
 * The card each customer-relevant move leaves in the conversation.
 *
 * Deliberately none for WAITING_FOR_INTERNAL (the business's bookkeeping),
 * SPAM (a customer is never told their enquiry was filed as spam) or BLOCKED
 * (they learn it the moment they try to write, in words that tell them where
 * else to go).
 */
function systemEventFor(from: PreorderChatStatusName, to: PreorderChatStatusName): string | null {
  if (to === 'RESOLVED') return 'status.resolved';
  if (to === 'CLOSED') return 'status.closed';
  if (to === 'WAITING_FOR_CUSTOMER') return 'status.awaiting_customer';
  if (to === 'OPEN' && (from === 'RESOLVED' || from === 'CLOSED' || from === 'BLOCKED')) {
    return 'status.reopened';
  }
  return null;
}

/**
 * Apply a status inside a transaction. Also used by blocking and unblocking,
 * so that every status change - whoever asks for it - goes through the same
 * assertion and leaves the same trail.
 */
async function applyStatus(
  tx: PrismaTransaction,
  actor: StaffActor,
  row: { id: string; status: PreorderChatStatusName; customerProfileId: string; productId: string; variantId: string | null; preorderRequestId: string | null; createdAt: Date },
  to: PreorderChatStatusName,
  reason: string | null,
): Promise<string | null> {
  assertStaffTransition(row.status, to, {
    canReply: actor.permissions.has(Permission.PREORDER_CHAT_REPLY),
    canModerate: actor.permissions.has(Permission.PREORDER_CHAT_MODERATE),
  });

  const now = new Date();
  const data: Prisma.PreorderChatConversationUpdateInput = {
    status: to,
    version: { increment: 1 },
  };

  if (to === 'RESOLVED') {
    data.resolvedAt = now;
    chatResolutionSeconds.observe((now.getTime() - row.createdAt.getTime()) / 1000);
  }
  if (to === 'CLOSED') {
    data.closedAt = now;
    // Released: the customer's next question about this product is a new
    // conversation, which is what "closed" means.
    data.activeKey = null;
    data.awaitingReplySince = null;
  }
  if (row.status === 'CLOSED' && holdsActiveKey(to)) {
    const key = activeKeyFor({
      customerProfileId: row.customerProfileId,
      productId: row.productId,
      variantKey: row.variantId ?? '',
      preorderKey: row.preorderRequestId ?? '',
    });
    const taken = await tx.preorderChatConversation.findUnique({
      where: { activeKey: key },
      select: { id: true },
    });
    if (taken !== null) {
      throw conflict(
        ErrorCode.PREORDER_CHAT_DUPLICATE_CONVERSATION,
        'The customer has started a newer conversation about this product. Continue there.',
        [{ code: 'DUPLICATE', meta: { conversationId: taken.id } }],
      );
    }
    data.activeKey = key;
    data.closedAt = null;
  }
  if (to === 'OPEN' && row.status === 'RESOLVED') {
    data.resolvedAt = null;
    data.reopenCount = { increment: 1 };
  }

  await tx.preorderChatConversation.update({ where: { id: row.id }, data });
  await recordAudit(
    {
      action: AuditAction.PREORDER_CHAT_STATUS_CHANGED,
      resourceType: 'preorder_chat',
      resourceId: row.id,
      actorType: 'ADMIN',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      before: { status: row.status },
      after: { status: to, reason },
      ipAddress: actor.ipAddress ?? null,
      correlationId: actor.correlationId ?? null,
    },
    tx,
  );

  const event = systemEventFor(row.status, to);
  return event === null
    ? null
    : appendSystemMessage(tx, row.id, event, { from: row.status, to }, `status:${newId()}`);
}

export async function changeStatus(
  actor: StaffActor,
  conversationId: string,
  input: z.infer<typeof statusSchema>,
): Promise<ChatOutcome<Record<string, unknown>>> {
  const row = await staffConversationRow(conversationId);
  if (input.status === 'BLOCKED') {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Block the customer with the block action.', [
      { field: 'status', code: 'USE_BLOCK' },
    ]);
  }
  if (row.status === 'BLOCKED') {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Unblock the customer with the unblock action.', [
      { field: 'status', code: 'USE_UNBLOCK' },
    ]);
  }

  const messageId = await prisma.$transaction((tx) =>
    applyStatus(tx, actor, row, input.status, input.reason),
  );

  return {
    value: (await loadStaffConversationSummary(conversationId, staffViewer(actor))) ?? {},
    events: [
      ...messageEvents(conversationId, row.customerProfileId, messageId, await seqOf(messageId)),
      updatedEvent(conversationId, row.customerProfileId, 'status', false),
    ],
  };
}

// ---------------------------------------------------------------------------
// Priority and tags
// ---------------------------------------------------------------------------

export const prioritySchema = z.object({ priority: z.enum(PreorderChatPriorityValues) }).strict();

export async function setPriority(
  actor: StaffActor,
  conversationId: string,
  input: z.infer<typeof prioritySchema>,
): Promise<ChatOutcome<Record<string, unknown>>> {
  requirePermission(actor, Permission.PREORDER_CHAT_REPLY);
  const row = await staffConversationRow(conversationId);
  if (row.priority === input.priority) {
    return { value: (await loadStaffConversationSummary(conversationId, staffViewer(actor))) ?? {}, events: [] };
  }
  await prisma.$transaction(async (tx) => {
    await tx.preorderChatConversation.update({
      where: { id: conversationId },
      data: { priority: input.priority, version: { increment: 1 } },
    });
    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_PRIORITY_CHANGED,
        resourceType: 'preorder_chat',
        resourceId: conversationId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { priority: row.priority },
        after: { priority: input.priority },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
  return {
    value: (await loadStaffConversationSummary(conversationId, staffViewer(actor))) ?? {},
    events: [updatedEvent(conversationId, row.customerProfileId, 'priority', true)],
  };
}

/** Short operational labels. Letters in any script, digits, space, - and _. */
const tag = z
  .string()
  .transform((value) => cleanChatText(value).trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1)
      .max(32)
      .regex(/^[\p{L}\p{N} _-]+$/u, 'Letters, digits, spaces, hyphens and underscores only.'),
  );

export const tagsSchema = z.object({ tags: z.array(tag).max(10) }).strict();

export async function setTags(
  actor: StaffActor,
  conversationId: string,
  input: z.infer<typeof tagsSchema>,
): Promise<ChatOutcome<Record<string, unknown>>> {
  requirePermission(actor, Permission.PREORDER_CHAT_REPLY);
  const row = await staffConversationRow(conversationId);
  const tags = [...new Map(input.tags.map((value) => [value.toLowerCase(), value])).values()];
  await prisma.$transaction(async (tx) => {
    await tx.preorderChatConversation.update({
      where: { id: conversationId },
      data: { tagsJson: tags, version: { increment: 1 } },
    });
    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_TAGS_CHANGED,
        resourceType: 'preorder_chat',
        resourceId: conversationId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { tags: tagsOf(row.tagsJson) },
        after: { tags },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
  return {
    value: (await loadStaffConversationSummary(conversationId, staffViewer(actor))) ?? {},
    events: [updatedEvent(conversationId, row.customerProfileId, 'tags', true)],
  };
}

// ---------------------------------------------------------------------------
// Internal notes
// ---------------------------------------------------------------------------

export const noteSchema = z.object({ body: z.string().max(40_000) }).strict();

function noteView(note: {
  id: string;
  body: string;
  authorUserId: string;
  createdAt: Date;
}, names: ReadonlyMap<string, string>): Record<string, unknown> {
  return {
    id: note.id,
    body: note.body,
    authorUserId: note.authorUserId,
    authorEmail: names.get(note.authorUserId) ?? null,
    createdAt: note.createdAt.toISOString(),
  };
}

/** Staff only. There is no customer route that reaches this function. */
export async function listNotes(conversationId: string): Promise<Record<string, unknown>[]> {
  await staffConversationRow(conversationId);
  const notes = await prisma.preorderChatNote.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: { id: true, body: true, authorUserId: true, createdAt: true },
  });
  const authors = await prisma.user.findMany({
    where: { id: { in: [...new Set(notes.map((note) => note.authorUserId))] } },
    select: { id: true, email: true },
  });
  const names = new Map(authors.map((author) => [author.id, author.email]));
  return notes.map((note) => noteView(note, names));
}

export async function addNote(
  actor: StaffActor,
  conversationId: string,
  input: z.infer<typeof noteSchema>,
): Promise<ChatOutcome<Record<string, unknown>>> {
  requirePermission(actor, Permission.PREORDER_CHAT_REPLY);
  const row = await staffConversationRow(conversationId);
  const body = normaliseChatBody(input.body, env.PREORDER_CHAT_MAX_MESSAGE_CHARS);
  const id = newId();
  const note = await prisma.$transaction(async (tx) => {
    const created = await tx.preorderChatNote.create({
      data: { id, conversationId, authorUserId: actor.userId, body },
      select: { id: true, body: true, authorUserId: true, createdAt: true },
    });
    // That a note was written, never what it says.
    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_NOTE_ADDED,
        resourceType: 'preorder_chat',
        resourceId: conversationId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { noteId: id, length: body.length },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return created;
  });
  return {
    value: noteView(note, new Map([[actor.userId, actor.email]])),
    // staffOnly: a customer's socket never hears that a note exists.
    events: [updatedEvent(conversationId, row.customerProfileId, 'note', true)],
  };
}

// ---------------------------------------------------------------------------
// Linking a preorder
// ---------------------------------------------------------------------------

export const linkSchema = z.object({ preorderRequestId: z.string().length(26).nullable() }).strict();

/**
 * Point the conversation at one of THIS customer's preorders for THIS product,
 * or at none.
 *
 * The uniqueness key moves with it: a conversation linked to preorder P is
 * "the conversation about P", and a second live one about P cannot exist.
 */
export async function linkPreorder(
  actor: StaffActor,
  conversationId: string,
  input: z.infer<typeof linkSchema>,
): Promise<ChatOutcome<Record<string, unknown>>> {
  requirePermission(actor, Permission.PREORDER_CHAT_REPLY);
  const row = await staffConversationRow(conversationId);
  const requestId = input.preorderRequestId;

  let requestNumber: string | null = null;
  if (requestId !== null) {
    const preorder = await prisma.preorderRequest.findUnique({
      where: { id: requestId },
      select: { customerProfileId: true, productId: true, requestNumber: true },
    });
    if (
      preorder === null ||
      preorder.customerProfileId !== row.customerProfileId ||
      preorder.productId !== row.productId
    ) {
      throw badRequest(
        ErrorCode.PREORDER_CHAT_PREORDER_MISMATCH,
        'That preorder belongs to a different customer or product.',
        [{ field: 'preorderRequestId', code: 'MISMATCH' }],
      );
    }
    requestNumber = preorder.requestNumber;
  }

  if (row.preorderRequestId === requestId) {
    return { value: (await loadStaffConversationSummary(conversationId, staffViewer(actor))) ?? {}, events: [] };
  }

  const messageId = await prisma.$transaction(async (tx) => {
    let activeKey: string | null | undefined;
    if (holdsActiveKey(row.status)) {
      activeKey = activeKeyFor({
        customerProfileId: row.customerProfileId,
        productId: row.productId,
        variantKey: row.variantId ?? '',
        preorderKey: requestId ?? '',
      });
      const taken = await tx.preorderChatConversation.findUnique({
        where: { activeKey },
        select: { id: true },
      });
      if (taken !== null && taken.id !== conversationId) {
        throw conflict(
          ErrorCode.PREORDER_CHAT_DUPLICATE_CONVERSATION,
          'Another open conversation is already about that preorder.',
          [{ code: 'DUPLICATE', meta: { conversationId: taken.id } }],
        );
      }
    }
    await tx.preorderChatConversation.update({
      where: { id: conversationId },
      data: {
        preorderRequestId: requestId,
        preorderKey: requestId ?? '',
        ...(activeKey === undefined ? {} : { activeKey }),
        version: { increment: 1 },
      },
    });
    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_PREORDER_LINKED,
        resourceType: 'preorder_chat',
        resourceId: conversationId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { preorderRequestId: row.preorderRequestId },
        after: { preorderRequestId: requestId },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return requestId === null
      ? null
      : appendSystemMessage(
          tx,
          conversationId,
          'preorder.linked',
          { requestNumber, preorderRequestId: requestId },
          `link:${requestId}`,
        );
  });

  return {
    value: (await loadStaffConversationSummary(conversationId, staffViewer(actor))) ?? {},
    events: [
      ...messageEvents(conversationId, row.customerProfileId, messageId, await seqOf(messageId)),
      updatedEvent(conversationId, row.customerProfileId, 'linked', false),
    ],
  };
}

// ---------------------------------------------------------------------------
// Moderation: block, unblock, redact
// ---------------------------------------------------------------------------

export const blockSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/**
 * Stop this customer sending preorder chat messages, anywhere.
 *
 * Per customer, not per conversation: a block that a new thread about the next
 * product walked round would not be a block. The conversation it was done from
 * becomes BLOCKED; the customer is told, the next time they try to write, that
 * messaging is unavailable and where else to go.
 */
export async function blockCustomer(
  actor: StaffActor,
  conversationId: string,
  input: z.infer<typeof blockSchema>,
): Promise<ChatOutcome<Record<string, unknown>>> {
  requirePermission(actor, Permission.PREORDER_CHAT_MODERATE);
  const row = await staffConversationRow(conversationId);

  await prisma.$transaction(async (tx) => {
    await tx.preorderChatCustomerBlock.upsert({
      where: { customerProfileId: row.customerProfileId },
      update: { reason: input.reason, blockedByUserId: actor.userId },
      create: {
        id: newId(),
        customerProfileId: row.customerProfileId,
        reason: input.reason,
        blockedByUserId: actor.userId,
      },
    });
    if (row.status !== 'BLOCKED') await applyStatus(tx, actor, row, 'BLOCKED', input.reason);
    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_CUSTOMER_BLOCKED,
        resourceType: 'customer_profile',
        resourceId: row.customerProfileId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { conversationId, reason: input.reason },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return {
    value: (await loadStaffConversationSummary(conversationId, staffViewer(actor))) ?? {},
    events: [updatedEvent(conversationId, row.customerProfileId, 'status', false)],
  };
}

export async function unblockCustomer(
  actor: StaffActor,
  conversationId: string,
): Promise<ChatOutcome<Record<string, unknown>>> {
  requirePermission(actor, Permission.PREORDER_CHAT_MODERATE);
  const row = await staffConversationRow(conversationId);

  const messageId = await prisma.$transaction(async (tx) => {
    await tx.preorderChatCustomerBlock.deleteMany({ where: { customerProfileId: row.customerProfileId } });
    const id = row.status === 'BLOCKED' ? await applyStatus(tx, actor, row, 'OPEN', null) : null;
    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_CUSTOMER_UNBLOCKED,
        resourceType: 'customer_profile',
        resourceId: row.customerProfileId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { conversationId },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return id;
  });

  return {
    value: (await loadStaffConversationSummary(conversationId, staffViewer(actor))) ?? {},
    events: [
      ...messageEvents(conversationId, row.customerProfileId, messageId, await seqOf(messageId)),
      updatedEvent(conversationId, row.customerProfileId, 'status', false),
    ],
  };
}

export const redactSchema = z.object({ reason: z.string().trim().min(3).max(255) }).strict();

/**
 * Remove the words of one message - a password, a card number, abuse.
 *
 * The row stays: its sequence, who sent it and when, so the conversation's
 * shape is unchanged and "something was removed here" is visible to both
 * sides. What was removed is NOT kept - the audit entry records its length
 * and SHA-256, which proves later exactly what was redacted without holding
 * on to the secret that made the redaction necessary. An attached file is
 * deleted from storage for the same reason.
 */
export async function redactMessage(
  actor: StaffActor,
  conversationId: string,
  messageId: string,
  input: z.infer<typeof redactSchema>,
): Promise<ChatOutcome<Record<string, unknown>>> {
  requirePermission(actor, Permission.PREORDER_CHAT_MODERATE);
  const row = await staffConversationRow(conversationId);

  const message = await prisma.preorderChatMessage.findFirst({
    where: { id: messageId, conversationId },
    select: {
      id: true,
      body: true,
      senderType: true,
      redactedAt: true,
      serverSequence: true,
      attachment: { select: { id: true, storageKey: true } },
    },
  });
  if (message === null) throw notFound('Message');
  if (message.senderType === 'SYSTEM') {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'System messages cannot be redacted.');
  }
  if (message.redactedAt !== null) {
    const [view] = await serialiseMessages(
      [(await prisma.preorderChatMessage.findUniqueOrThrow({ where: { id: messageId }, select: MESSAGE_SELECT }))],
      'STAFF',
    );
    return { value: view ?? {}, events: [] };
  }

  await prisma.$transaction(async (tx) => {
    await tx.preorderChatMessage.update({
      where: { id: messageId },
      data: {
        body: '',
        redactedAt: new Date(),
        redactedByUserId: actor.userId,
        redactionReason: input.reason,
      },
    });

    // If it was the inbox preview, the preview goes too.
    const latest = await tx.preorderChatMessage.findFirst({
      where: { conversationId, messageType: { in: ['TEXT', 'ATTACHMENT'] }, redactedAt: null },
      orderBy: { serverSequence: 'desc' },
      select: { body: true, senderType: true },
    });
    await tx.preorderChatConversation.update({
      where: { id: conversationId },
      data: {
        lastMessagePreview: latest === null || latest.body.length === 0 ? null : previewOf(latest.body),
        lastMessageSender: latest?.senderType ?? null,
      },
    });

    await recordAudit(
      {
        action: AuditAction.PREORDER_CHAT_MESSAGE_REDACTED,
        resourceType: 'preorder_chat',
        resourceId: conversationId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          messageId,
          seq: message.serverSequence,
          reason: input.reason,
          removedLength: message.body.length,
          removedSha256: bodyFingerprint(message.body),
          attachmentRemoved: message.attachment !== null,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  if (message.attachment !== null) {
    try {
      await storage.delete(message.attachment.storageKey);
    } catch (error) {
      logger.error({ err: error, attachmentId: message.attachment.id }, 'redacted attachment not deleted');
    }
  }

  const [view] = await serialiseMessages(
    [(await prisma.preorderChatMessage.findUniqueOrThrow({ where: { id: messageId }, select: MESSAGE_SELECT }))],
    'STAFF',
  );
  return {
    value: view ?? {},
    events: [
      { kind: 'message.updated', conversationId, customerProfileId: row.customerProfileId, messageId },
      updatedEvent(conversationId, row.customerProfileId, 'message', false),
    ],
  };
}

// ---------------------------------------------------------------------------
// Transcript and activity
// ---------------------------------------------------------------------------

/**
 * The whole conversation as JSON, for somebody holding the export permission.
 *
 * Includes the internal notes, marked as such, because the people trusted
 * with an export are trusted with the whole record. Audited.
 */
export async function exportTranscript(
  actor: StaffActor,
  conversationId: string,
): Promise<Record<string, unknown>> {
  requirePermission(actor, Permission.PREORDER_CHAT_EXPORT);
  const row = await staffConversationRow(conversationId);
  const messages = (await prisma.preorderChatMessage.findMany({
    where: { conversationId },
    orderBy: { serverSequence: 'asc' },
    select: MESSAGE_SELECT,
    take: 20_000,
  })) as MessageRow[];

  await recordAudit({
    action: AuditAction.PREORDER_CHAT_EXPORTED,
    resourceType: 'preorder_chat',
    resourceId: conversationId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { messages: messages.length },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return {
    exportedAt: new Date().toISOString(),
    exportedBy: actor.email,
    conversation: (await loadStaffConversationSummary(conversationId, staffViewer(actor))) ?? {},
    context: row.contextSnapshotJson,
    messages: await serialiseMessages(messages, 'STAFF'),
    internalNotes: await listNotes(conversationId),
  };
}

/** What has been decided about this conversation, newest first. */
export async function listActivity(conversationId: string): Promise<Record<string, unknown>[]> {
  await staffConversationRow(conversationId);
  const rows = await prisma.auditLog.findMany({
    where: { resourceType: 'preorder_chat', resourceId: conversationId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, action: true, actorType: true, actorEmail: true, afterJson: true, beforeJson: true, createdAt: true },
  });
  return rows.map((entry) => ({
    id: entry.id,
    action: entry.action,
    actorType: entry.actorType,
    actorEmail: entry.actorEmail,
    before: entry.beforeJson,
    after: entry.afterJson,
    createdAt: entry.createdAt.toISOString(),
  }));
}
