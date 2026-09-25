/**
 * The preorder chat's heartbeat, run by the worker once a minute.
 *
 * Four cheap indexed passes, none of which is worth its own job:
 *
 *   1. **Tell customers about replies they have not read.** Only once a reply
 *      has sat unread for PREORDER_CHAT_EMAIL_DELAY_MINUTES - a customer with
 *      the conversation open is reading it, and an email about a message on
 *      the screen in front of them is noise. One email per burst of replies,
 *      and never the reply itself.
 *   2. **Raise the SLA alert** on the console bell for a customer who has
 *      waited longer than PREORDER_CHAT_SLA_MINUTES. Once per wait; a staff
 *      reply closes it.
 *   3. **Expire proposals** past their date.
 *   4. **Retention**, where the operator set PREORDER_CHAT_RETENTION_DAYS:
 *      closed conversations older than that are deleted with their files.
 *
 * Returns the bus events it caused, for the worker to publish.
 */
import { env } from '../../config/env.js';
import { Permission } from '../../domain/permissions.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import {
  AdminNotificationKind,
  ResolutionKey,
  createAdminNotification,
} from '../notifications/admin-notification.service.js';
import { enqueueNotification, NotificationEvent } from '../notifications/notification.service.js';
import type { ChatBusEvent } from './realtime/events.js';

const BATCH = 200;

function chatUrl(conversationId: string): string {
  return `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/account/messages/${conversationId}`;
}

/** Which email a batch of unread staff-side messages calls for. */
function emailKindFor(messages: { messageType: string; systemEvent: string | null }[]): string {
  if (messages.some((message) => message.messageType === 'STRUCTURED_OFFER')) {
    return NotificationEvent.PREORDER_CHAT_PROPOSAL;
  }
  const last = messages.at(-1);
  if (last?.systemEvent === 'status.awaiting_customer') {
    return NotificationEvent.PREORDER_CHAT_RESPONSE_REQUESTED;
  }
  if (last?.systemEvent === 'status.resolved') return NotificationEvent.PREORDER_CHAT_RESOLVED;
  return NotificationEvent.PREORDER_CHAT_REPLY;
}

export async function emailUnreadReplies(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.PREORDER_CHAT_EMAIL_DELAY_MINUTES * 60_000);
  const candidates = await prisma.preorderChatConversation.findMany({
    where: {
      status: { notIn: ['SPAM', 'BLOCKED'] },
      staffMessageCount: { gt: prisma.preorderChatConversation.fields.customerReadStaffCount },
      lastSequence: { gt: prisma.preorderChatConversation.fields.customerEmailedSeq },
    },
    select: {
      id: true,
      productName: true,
      customerReadSeq: true,
      customerEmailedSeq: true,
      lastSequence: true,
      customerProfile: { select: { fullName: true, user: { select: { email: true, status: true } } } },
    },
    take: BATCH,
  });

  let sent = 0;
  for (const conversation of candidates) {
    const from = Math.max(conversation.customerReadSeq, conversation.customerEmailedSeq);
    const unread = await prisma.preorderChatMessage.findMany({
      where: {
        conversationId: conversation.id,
        serverSequence: { gt: from },
        senderType: { in: ['ADMIN', 'SYSTEM'] },
      },
      orderBy: { serverSequence: 'asc' },
      select: { serverSequence: true, messageType: true, systemEvent: true, createdAt: true },
    });
    const oldest = unread[0];
    if (oldest === undefined || oldest.createdAt > cutoff) continue;

    const user = conversation.customerProfile.user;
    if (user.status === 'ACTIVE') {
      await enqueueNotification({
        eventKey: emailKindFor(unread),
        recipientEmail: user.email,
        recipientName: conversation.customerProfile.fullName,
        variables: { productName: conversation.productName, chatUrl: chatUrl(conversation.id) },
        dedupeKey: `preorder-chat:${conversation.id}:${String(conversation.lastSequence)}`,
        relatedType: 'preorder_chat',
        relatedId: conversation.id,
      });
      sent += 1;
    }
    await prisma.preorderChatConversation.updateMany({
      where: { id: conversation.id, customerEmailedSeq: { lt: conversation.lastSequence } },
      data: { customerEmailedSeq: conversation.lastSequence },
    });
  }
  return sent;
}

export async function raiseSlaAlerts(now: Date = new Date()): Promise<number> {
  const threshold = new Date(now.getTime() - env.PREORDER_CHAT_SLA_MINUTES * 60_000);
  const late = await prisma.preorderChatConversation.findMany({
    where: {
      awaitingReplySince: { lt: threshold },
      slaAlertedAt: null,
      status: { in: ['NEW', 'OPEN', 'WAITING_FOR_INTERNAL'] },
    },
    select: { id: true, productName: true, awaitingReplySince: true },
    take: BATCH,
  });

  for (const conversation of late) {
    const since = conversation.awaitingReplySince ?? now;
    await prisma.$transaction(async (tx) => {
      await createAdminNotification(
        {
          kind: AdminNotificationKind.PREORDER_CHAT_SLA_BREACHED,
          variables: {
            productName: conversation.productName,
            waitingMinutes: Math.floor((now.getTime() - since.getTime()) / 60_000),
          },
          linkPath: `/preorder-chats/${conversation.id}`,
          requiredPermission: Permission.PREORDER_CHAT_VIEW,
          relatedType: 'preorder_chat',
          relatedId: conversation.id,
          // One per wait: the same wait never rings twice, a new wait does.
          dedupeKey: `preorder-chat-sla:${conversation.id}:${String(since.getTime())}`,
          resolutionKey: ResolutionKey.preorderChatReply(conversation.id),
        },
        tx,
      );
      await tx.preorderChatConversation.update({
        where: { id: conversation.id },
        data: { slaAlertedAt: now },
      });
    });
  }
  return late.length;
}

export async function expireProposals(now: Date = new Date()): Promise<ChatBusEvent[]> {
  const expired = await prisma.preorderChatProposal.findMany({
    where: { state: 'PROPOSED', expiresAt: { lte: now } },
    select: { id: true, conversationId: true, conversation: { select: { customerProfileId: true } } },
    take: BATCH,
  });
  if (expired.length === 0) return [];

  await prisma.preorderChatProposal.updateMany({
    where: { id: { in: expired.map((row) => row.id) }, state: 'PROPOSED' },
    data: { state: 'EXPIRED' },
  });

  const cards = await prisma.preorderChatMessage.findMany({
    where: { proposalId: { in: expired.map((row) => row.id) } },
    select: { id: true, conversationId: true, conversation: { select: { customerProfileId: true } } },
  });
  return cards.map((card) => ({
    kind: 'message.updated',
    conversationId: card.conversationId,
    customerProfileId: card.conversation.customerProfileId,
    messageId: card.id,
  }));
}

export async function applyRetention(now: Date = new Date()): Promise<number> {
  if (env.PREORDER_CHAT_RETENTION_DAYS === 0) return 0;
  const cutoff = new Date(now.getTime() - env.PREORDER_CHAT_RETENTION_DAYS * 86_400_000);
  const old = await prisma.preorderChatConversation.findMany({
    where: { status: 'CLOSED', closedAt: { lt: cutoff } },
    select: { id: true, attachments: { select: { storageKey: true } } },
    take: BATCH,
  });
  for (const conversation of old) {
    for (const attachment of conversation.attachments) {
      await storage.delete(attachment.storageKey).catch((error: unknown) => {
        logger.warn({ err: error }, 'retained chat attachment not deleted');
      });
    }
    await prisma.preorderChatConversation.delete({ where: { id: conversation.id } });
  }
  return old.length;
}

/** The whole beat. Each pass is independent; one failing does not stop the others. */
export async function runPreorderChatMaintenance(
  now: Date = new Date(),
): Promise<{ emailed: number; alerted: number; retained: number; events: ChatBusEvent[] }> {
  const result = { emailed: 0, alerted: 0, retained: 0, events: [] as ChatBusEvent[] };
  if (!env.FEATURE_PREORDER_CHAT) return result;

  for (const [name, pass] of [
    ['emails', async () => { result.emailed = await emailUnreadReplies(now); }],
    ['sla', async () => { result.alerted = await raiseSlaAlerts(now); }],
    ['proposals', async () => { result.events.push(...(await expireProposals(now))); }],
    ['retention', async () => { result.retained = await applyRetention(now); }],
  ] as const) {
    try {
      await pass();
    } catch (error) {
      logger.error({ err: error, pass: name }, 'preorder chat maintenance pass failed');
    }
  }
  return result;
}
