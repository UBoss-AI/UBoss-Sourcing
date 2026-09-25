/**
 * Preorder chat metrics, on the shared `/metrics` registry.
 *
 * Counts and durations only. No label ever carries a conversation id, a
 * customer, a product or a word anybody wrote - the same rule as the rest of
 * `infra/metrics.ts`, and here it is also a privacy rule: message text as a
 * label would publish private negotiations to whoever can scrape.
 *
 * The three queue gauges are computed on scrape (`collect`), so an instance
 * nobody scrapes runs no queries for them.
 */
import { Counter, Gauge, Histogram } from 'prom-client';
import { env } from '../../config/env.js';
import { logger } from '../../infra/logger.js';
import { registry } from '../../infra/metrics.js';
import { prisma } from '../../infra/prisma.js';

export const chatConversationsCreatedTotal = new Counter({
  name: 'uboss_preorder_chat_conversations_created_total',
  help: 'Preorder chat conversations opened by customers',
  registers: [registry],
});

export const chatMessagesTotal = new Counter({
  name: 'uboss_preorder_chat_messages_total',
  help: 'Preorder chat messages stored, by who sent them',
  labelNames: ['sender'] as const,
  registers: [registry],
});

export const chatReopenedTotal = new Counter({
  name: 'uboss_preorder_chat_reopened_total',
  help: 'Resolved preorder chats reopened by a new message',
  registers: [registry],
});

export const chatFirstResponseSeconds = new Histogram({
  name: 'uboss_preorder_chat_first_response_seconds',
  help: 'Time from a conversation opening to the first staff reply',
  buckets: [60, 300, 900, 1800, 3600, 7200, 14_400, 28_800, 86_400, 259_200],
  registers: [registry],
});

export const chatResponseSeconds = new Histogram({
  name: 'uboss_preorder_chat_response_seconds',
  help: 'Time a customer message waited for a staff reply',
  buckets: [60, 300, 900, 1800, 3600, 7200, 14_400, 28_800, 86_400, 259_200],
  registers: [registry],
});

export const chatResolutionSeconds = new Histogram({
  name: 'uboss_preorder_chat_resolution_seconds',
  help: 'Time from a conversation opening to it being resolved',
  buckets: [900, 3600, 14_400, 43_200, 86_400, 259_200, 604_800, 1_209_600],
  registers: [registry],
});

/** A message that could not be written to a connected socket. */
export const chatDeliveryFailuresTotal = new Counter({
  name: 'uboss_preorder_chat_delivery_failures_total',
  help: 'Live chat events that could not be delivered to a connected browser',
  labelNames: ['stage'] as const,
  registers: [registry],
});

export const chatBusFailuresTotal = new Counter({
  name: 'uboss_preorder_chat_bus_failures_total',
  help: 'Failures publishing to or reading from the shared chat event bus',
  labelNames: ['stage'] as const,
  registers: [registry],
});

export const chatSocketConnections = new Gauge({
  name: 'uboss_preorder_chat_socket_connections',
  help: 'Chat WebSocket connections open on this process',
  labelNames: ['audience'] as const,
  registers: [registry],
});

export const chatSocketFailuresTotal = new Counter({
  name: 'uboss_preorder_chat_socket_failures_total',
  help: 'Chat WebSocket connections refused or ended by the server',
  labelNames: ['reason'] as const,
  registers: [registry],
});

function safely(name: string, run: () => Promise<number>): (this: Gauge) => Promise<void> {
  return async function collect(this: Gauge): Promise<void> {
    try {
      this.set(await run());
    } catch (error) {
      logger.error({ err: error, gauge: name }, 'chat gauge failed');
    }
  };
}

new Gauge({
  name: 'uboss_preorder_chat_open',
  help: 'Preorder chats still being worked (new, open or waiting)',
  registers: [registry],
  collect: safely('open', () =>
    prisma.preorderChatConversation.count({
      where: { status: { in: ['NEW', 'OPEN', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_INTERNAL'] } },
    }),
  ),
});

new Gauge({
  name: 'uboss_preorder_chat_unassigned',
  help: 'Preorder chats being worked that nobody holds',
  registers: [registry],
  collect: safely('unassigned', () =>
    prisma.preorderChatConversation.count({
      where: {
        assignedAdminId: null,
        status: { in: ['NEW', 'OPEN', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_INTERNAL'] },
      },
    }),
  ),
});

new Gauge({
  name: 'uboss_preorder_chat_approaching_sla',
  help: 'Preorder chats whose unanswered message is past three quarters of the SLA',
  registers: [registry],
  collect: safely('approaching_sla', () =>
    prisma.preorderChatConversation.count({
      where: {
        awaitingReplySince: {
          lt: new Date(Date.now() - env.PREORDER_CHAT_SLA_MINUTES * 60_000 * 0.75),
        },
        status: { in: ['NEW', 'OPEN', 'WAITING_FOR_INTERNAL'] },
      },
    }),
  ),
});
