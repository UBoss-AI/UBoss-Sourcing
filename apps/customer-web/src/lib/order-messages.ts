/**
 * Messages about an order between the buyer and one seller (JOURNEY-055).
 *
 * One thread per seller part of an order. The buyer reads every thread on
 * their order; a seller reads only the one about its own part. Polling asks
 * only for messages after the last id held, and a resend with the same
 * `clientMessageId` finds the first message rather than writing a second.
 */
import { api, newIdempotencyKey } from './api';

export type OrderMessageParty = 'BUYER' | 'SELLER';

export interface OrderMessage {
  id: string;
  from: OrderMessageParty;
  body: string;
  mine: boolean;
  at: string;
}

export interface OrderThread {
  sellerOrderGroupId: string;
  sellerName: string;
  sellerOrderNumber: string;
  messages: OrderMessage[];
}

export interface OrderThreadSummary {
  orderId: string;
  orderNumber: string;
  sellerOrderGroupId: string;
  sellerName: string;
  lastMessage: { from: OrderMessageParty; body: string; at: string };
}

/** A sender's own id for one message, in the shape the server accepts. */
export function newClientMessageId(): string {
  return newIdempotencyKey().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

export async function fetchBuyerOrderThreads(orderId: string, after?: string): Promise<OrderThread[]> {
  const result = await api.get<{ threads: OrderThread[] }>(
    `/orders/${orderId}/messages`,
    after === undefined ? undefined : { query: { after } },
  );
  return result.threads;
}

export async function postBuyerOrderMessage(
  orderId: string,
  groupId: string,
  body: string,
  clientMessageId: string,
): Promise<OrderMessage> {
  const result = await api.post<{ message: OrderMessage }>(`/orders/${orderId}/messages/${groupId}`, {
    body,
    clientMessageId,
  });
  return result.message;
}

export async function fetchRecentOrderThreads(): Promise<OrderThreadSummary[]> {
  return (await api.get<{ threads: OrderThreadSummary[] }>('/account/order-messages')).threads;
}

export async function fetchSellerOrderThread(groupId: string, after?: string): Promise<OrderThread> {
  const result = await api.get<{ thread: OrderThread }>(
    `/seller/orders/${groupId}/messages`,
    after === undefined ? undefined : { query: { after } },
  );
  return result.thread;
}

export async function postSellerOrderMessage(groupId: string, body: string, clientMessageId: string): Promise<OrderMessage> {
  const result = await api.post<{ message: OrderMessage }>(`/seller/orders/${groupId}/messages`, { body, clientMessageId });
  return result.message;
}
