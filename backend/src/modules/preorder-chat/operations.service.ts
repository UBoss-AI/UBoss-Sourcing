/**
 * How the preorder chat desk is doing, for the inbox header.
 *
 * Counts and durations only - never a word anybody wrote, never who. The same
 * figures a Prometheus scrape gets from `metrics.ts`, worked out from the
 * tables so that they are right across every API process and survive a
 * restart, which a process's own counters do not.
 */
import { env } from '../../config/env.js';
import { prisma } from '../../infra/prisma.js';
import {
  chatBusFailuresTotal,
  chatDeliveryFailuresTotal,
  chatSocketFailuresTotal,
} from './metrics.js';

const WORKING = ['NEW', 'OPEN', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_INTERNAL'] as const;

async function counterTotal(counter: { get(): Promise<{ values: { value: number }[] }> }): Promise<number> {
  const snapshot = await counter.get();
  return snapshot.values.reduce((total, entry) => total + entry.value, 0);
}

export interface ChatOperations {
  queue: {
    open: number;
    unassigned: number;
    awaitingReply: number;
    approachingSla: number;
    breachedSla: number;
  };
  last30Days: {
    conversations: number;
    /** Seconds, or null when nothing was answered. */
    averageFirstResponseSeconds: number | null;
    averageResolutionSeconds: number | null;
    reopened: number;
  };
  slaMinutes: number;
  /** This process's own counters since it started. */
  thisProcess: { deliveryFailures: number; socketFailures: number; busFailures: number };
}

export async function readChatOperations(now: Date = new Date()): Promise<ChatOperations> {
  const sla = env.PREORDER_CHAT_SLA_MINUTES * 60_000;
  const since = new Date(now.getTime() - 30 * 86_400_000);

  const [open, unassigned, awaitingReply, approachingSla, breachedSla, conversations, reopened] =
    await Promise.all([
      prisma.preorderChatConversation.count({ where: { status: { in: [...WORKING] } } }),
      prisma.preorderChatConversation.count({
        where: { status: { in: [...WORKING] }, assignedAdminId: null },
      }),
      prisma.preorderChatConversation.count({
        where: { status: { in: ['NEW', 'OPEN', 'WAITING_FOR_INTERNAL'] }, awaitingReplySince: { not: null } },
      }),
      prisma.preorderChatConversation.count({
        where: {
          status: { in: ['NEW', 'OPEN', 'WAITING_FOR_INTERNAL'] },
          awaitingReplySince: {
            lt: new Date(now.getTime() - sla * 0.75),
            gte: new Date(now.getTime() - sla),
          },
        },
      }),
      prisma.preorderChatConversation.count({
        where: {
          status: { in: ['NEW', 'OPEN', 'WAITING_FOR_INTERNAL'] },
          awaitingReplySince: { lt: new Date(now.getTime() - sla) },
        },
      }),
      prisma.preorderChatConversation.count({ where: { createdAt: { gte: since } } }),
      prisma.preorderChatConversation.count({
        where: { reopenCount: { gt: 0 }, updatedAt: { gte: since } },
      }),
    ]);

  const [durations] = await prisma.$queryRaw<
    { firstResponse: number | null; resolution: number | null }[]
  >`
    SELECT
      AVG(CASE WHEN firstResponseAt IS NOT NULL
               THEN TIMESTAMPDIFF(SECOND, createdAt, firstResponseAt) END) AS firstResponse,
      AVG(CASE WHEN resolvedAt IS NOT NULL
               THEN TIMESTAMPDIFF(SECOND, createdAt, resolvedAt) END) AS resolution
      FROM preorder_chat_conversations
     WHERE createdAt >= ${since}
  `;

  const round = (value: unknown): number | null =>
    value === null || value === undefined ? null : Math.round(Number(value));

  return {
    queue: { open, unassigned, awaitingReply, approachingSla, breachedSla },
    last30Days: {
      conversations,
      averageFirstResponseSeconds: round(durations?.firstResponse),
      averageResolutionSeconds: round(durations?.resolution),
      reopened,
    },
    slaMinutes: env.PREORDER_CHAT_SLA_MINUTES,
    thisProcess: {
      deliveryFailures: await counterTotal(chatDeliveryFailuresTotal),
      socketFailures: await counterTotal(chatSocketFailuresTotal),
      busFailures: await counterTotal(chatBusFailuresTotal),
    },
  };
}
