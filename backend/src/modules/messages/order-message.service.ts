/**
 * Messages about an order, between the buyer and one seller (JOURNEY-055).
 *
 * One thread per seller order group - the part of an order one seller ships.
 * A buyer of a two-seller order has two threads and each seller sees only its
 * own, because the seller side is keyed on the group the SESSION's seller owns:
 * there is no seller id in the request a seller could change. The marketplace's
 * own stock has no seller and so no thread here; the buyer uses support.
 *
 * Same shape as the RFQ thread (`rfq/message.service.ts`): ids are monotonic so
 * a reader polls with `after`, and a resend with the same `clientMessageId`
 * finds the first message rather than writing a second (the UNIQUE index).
 *
 * Plain text only, at most 4000 characters, rendered as text everywhere. The
 * screen warns against sending bank details or passwords; nothing here scans
 * or rewrites what was written - a message is the sender's own words.
 */
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { notFound } from '../../domain/errors.js';
import { env } from '../../config/env.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  dispatchPendingNotifications,
  enqueueNotification,
  NotificationEvent,
} from '../notifications/notification.service.js';
import { notifySeller } from '../seller/notification.service.js';

export const orderMessageBodySchema = z
  .object({
    body: z.string().trim().min(1).max(4000),
    clientMessageId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .nullable()
      .default(null),
  })
  .strict();

export const orderThreadQuerySchema = z.object({ after: z.string().length(26).optional() });

export type OrderMessageParty = 'BUYER' | 'SELLER';

export interface OrderMessageView {
  id: string;
  from: OrderMessageParty;
  body: string;
  mine: boolean;
  at: string;
}

export interface OrderThreadView {
  sellerOrderGroupId: string;
  sellerName: string;
  sellerOrderNumber: string;
  messages: OrderMessageView[];
}

function view(
  row: { id: string; authorParty: OrderMessageParty; body: string; createdAt: Date },
  reader: OrderMessageParty,
): OrderMessageView {
  return { id: row.id, from: row.authorParty, body: row.body, mine: row.authorParty === reader, at: row.createdAt.toISOString() };
}

async function messagesOf(groupId: string, reader: OrderMessageParty, after?: string): Promise<OrderMessageView[]> {
  const rows = await prisma.orderMessage.findMany({
    where: { sellerOrderGroupId: groupId, ...(after === undefined ? {} : { id: { gt: after } }) },
    orderBy: { id: 'asc' },
    take: 500,
  });
  return rows.map((row) => view(row, reader));
}

/**
 * Every seller thread on one of the buyer's orders. `orderScope` is the
 * caller's ownership `where` (`orderScopeWhere`), so another buyer's order is
 * simply not found.
 */
export async function listBuyerOrderThreads(
  orderId: string,
  orderScope: Prisma.OrderWhereInput,
  after?: string,
): Promise<OrderThreadView[]> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...orderScope },
    select: {
      id: true,
      sellerOrderGroups: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, sellerOrderNumber: true, sellerAccount: { select: { displayName: true } } },
      },
    },
  });
  if (order === null) throw notFound('Order');
  return Promise.all(
    order.sellerOrderGroups.map(async (group) => ({
      sellerOrderGroupId: group.id,
      sellerName: group.sellerAccount.displayName,
      sellerOrderNumber: group.sellerOrderNumber,
      messages: await messagesOf(group.id, 'BUYER', after),
    })),
  );
}

export interface OrderThreadSummary {
  orderId: string;
  orderNumber: string;
  sellerOrderGroupId: string;
  sellerName: string;
  lastMessage: { from: OrderMessageParty; body: string; at: string };
}

/**
 * The buyer's order threads that have any message, most recently active
 * first - the "Order messages" tab of the message centre. At most 50.
 */
export async function listBuyerRecentOrderThreads(orderScope: Prisma.OrderWhereInput): Promise<OrderThreadSummary[]> {
  const groups = await prisma.sellerOrderGroup.findMany({
    where: { order: orderScope, messages: { some: {} } },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    select: {
      id: true,
      orderId: true,
      order: { select: { orderNumber: true } },
      sellerAccount: { select: { displayName: true } },
      messages: { orderBy: { id: 'desc' }, take: 1, select: { id: true, authorParty: true, body: true, createdAt: true } },
    },
  });
  return groups
    .filter((group) => group.messages[0] !== undefined)
    .sort((a, b) => ((b.messages[0]?.id ?? '') > (a.messages[0]?.id ?? '') ? 1 : -1))
    .slice(0, 50)
    .map((group) => {
      const last = group.messages[0] as { authorParty: OrderMessageParty; body: string; createdAt: Date };
      return {
        orderId: group.orderId,
        orderNumber: group.order.orderNumber,
        sellerOrderGroupId: group.id,
        sellerName: group.sellerAccount.displayName,
        lastMessage: { from: last.authorParty, body: last.body.slice(0, 160), at: last.createdAt.toISOString() },
      };
    });
}

/** The thread on one of this seller's order groups; anything else is "not found". */
export async function listSellerOrderThread(
  groupId: string,
  sellerAccountId: string,
  after?: string,
): Promise<OrderThreadView> {
  const group = await prisma.sellerOrderGroup.findFirst({
    where: { id: groupId, sellerAccountId },
    select: { id: true, sellerOrderNumber: true, sellerAccount: { select: { displayName: true } } },
  });
  if (group === null) throw notFound('Order');
  return {
    sellerOrderGroupId: group.id,
    sellerName: group.sellerAccount.displayName,
    sellerOrderNumber: group.sellerOrderNumber,
    messages: await messagesOf(group.id, 'SELLER', after),
  };
}

function customerOrderUrl(orderId: string): string {
  return `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/account/orders/${orderId}`;
}

/**
 * Write one message. The caller has resolved who may write in which group:
 * the buyer through their order scope, the seller through its session.
 */
export async function postOrderMessage(input: {
  groupId: string;
  party: OrderMessageParty;
  userId: string;
  /** For the buyer: the order must match this scope. For a seller: its own id. */
  access: { orderScope: Prisma.OrderWhereInput } | { sellerAccountId: string };
  body: z.infer<typeof orderMessageBodySchema>;
}): Promise<OrderMessageView> {
  const group = await prisma.sellerOrderGroup.findFirst({
    where: {
      id: input.groupId,
      ...('sellerAccountId' in input.access
        ? { sellerAccountId: input.access.sellerAccountId }
        : { order: input.access.orderScope }),
    },
    select: {
      id: true,
      orderId: true,
      sellerAccountId: true,
      sellerOrderNumber: true,
      sellerAccount: { select: { displayName: true } },
      order: {
        select: {
          orderNumber: true,
          customerProfile: { select: { fullName: true, user: { select: { email: true } } } },
        },
      },
    },
  });
  if (group === null) throw notFound('Order');

  if (input.body.clientMessageId !== null) {
    const existing = await prisma.orderMessage.findUnique({
      where: {
        sellerOrderGroupId_clientMessageId: {
          sellerOrderGroupId: group.id,
          clientMessageId: input.body.clientMessageId,
        },
      },
    });
    if (existing !== null) return view(existing, input.party);
  }

  const id = newId();
  await prisma.$transaction(async (tx) => {
    const created = await tx.orderMessage.createMany({
      data: [
        {
          id,
          sellerOrderGroupId: group.id,
          authorParty: input.party,
          authorUserId: input.userId,
          body: input.body.body,
          clientMessageId: input.body.clientMessageId,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) return;

    // One notice an hour per thread: a conversation is not a mail flood.
    const hour = new Date().toISOString().slice(0, 13);
    if (input.party === 'BUYER') {
      await notifySeller({
        sellerAccountId: group.sellerAccountId,
        kind: 'ORDER_MESSAGE',
        title: `New message on order ${group.sellerOrderNumber}`,
        body: 'The buyer wrote to you about this order.',
        linkPath: `/seller/orders/${group.id}`,
        subjectType: 'seller_order_group',
        subjectId: group.id,
        dedupeKey: `order-message:${group.id}:${hour}`,
        tx,
      });
    } else {
      await enqueueNotification(
        {
          eventKey: NotificationEvent.ORDER_MESSAGE_FOR_BUYER,
          recipientEmail: group.order.customerProfile.user.email,
          recipientName: group.order.customerProfile.fullName,
          variables: {
            orderNumber: group.order.orderNumber,
            sellerName: group.sellerAccount.displayName,
            orderUrl: customerOrderUrl(group.orderId),
          },
          dedupeKey: `order:${group.orderId}:message:${group.id}:${hour}`,
          relatedType: 'order',
          relatedId: group.orderId,
        },
        tx,
      );
    }
  });
  await dispatchPendingNotifications();

  const row =
    (await prisma.orderMessage.findUnique({ where: { id } })) ??
    (input.body.clientMessageId === null
      ? null
      : await prisma.orderMessage.findUnique({
          where: {
            sellerOrderGroupId_clientMessageId: {
              sellerOrderGroupId: group.id,
              clientMessageId: input.body.clientMessageId,
            },
          },
        }));
  if (row === null) throw notFound('Message');
  return view(row, input.party);
}
