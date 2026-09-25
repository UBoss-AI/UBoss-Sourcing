/**
 * The live connections of ONE API process, and what each is allowed to hear.
 *
 * WHAT A SOCKET IS
 *
 * A browser that has proved, at the handshake, who it is: a customer (their
 * profile) or a member of staff (their permissions). The route that upgraded
 * it ran the same guard as every REST call - session, account status, CSRF-free
 * because it is a GET, origin checked against the allowlist - and hands the
 * resulting principal here. Nothing a socket says afterwards can change who it
 * is.
 *
 * WHAT IT HEARS
 *
 * Bus events are references. For each one this gateway loads the thing it
 * refers to ONCE per audience and serialises it with the same view functions
 * the REST routes use:
 *
 *   - a customer socket hears only events whose `customerProfileId` is its own,
 *     never a `staffOnly` one, and always through the customer serialisers -
 *     so a note, a tag, an assignee or a colleague's name cannot reach it;
 *   - a staff socket hears every conversation, because `preorder_chat.view` is
 *     the grant to see every conversation.
 *
 * Typing is heard only by sockets that have that conversation OPEN (subscribed
 * after an ownership check), and it is never written anywhere.
 *
 * STAYING HONEST AFTER THE HANDSHAKE
 *
 * Every ten seconds each socket's session and account are checked again, and
 * a staff member's permissions re-read. A signed-out session, a deactivated
 * account or a withdrawn permission closes the socket within that window -
 * and every REST call it could make was already refused the moment it
 * happened.
 */
import type { WebSocket } from 'ws';
import { Permission } from '../../../domain/permissions.js';
import { logger } from '../../../infra/logger.js';
import { prisma } from '../../../infra/prisma.js';
import { loadAuthenticatedUser } from '../../identity/auth.service.js';
import { getSessionAuthState } from '../../identity/session.service.js';
import {
  loadCustomerConversationView,
  loadMessageView,
  loadStaffConversationSummary,
  markDelivered,
} from '../conversation.service.js';
import { chatDeliveryFailuresTotal, chatSocketConnections, chatSocketFailuresTotal } from '../metrics.js';
import type { ChatBus } from './bus.js';
import type { ChatBusEvent, ChatSide } from './events.js';

export type ChatPrincipal =
  | { kind: 'CUSTOMER'; userId: string; email: string; sessionId: string; customerProfileId: string }
  | { kind: 'ADMIN'; userId: string; email: string; sessionId: string; permissions: Set<string> };

/** Close codes a browser can act on. 4401: sign in again. 4403: no longer allowed. */
export const CloseCode = {
  UNAUTHENTICATED: 4401,
  FORBIDDEN: 4403,
  RATE_LIMITED: 4429,
  SHUTTING_DOWN: 1001,
} as const;

const REVALIDATE_MS = 10_000;
const HEARTBEAT_MS = 25_000;
const PRESENCE_MS = 10_000;
const PRESENCE_TTL_MS = 30_000;
const TYPING_THROTTLE_MS = 2_500;
const MAX_OPEN_CONVERSATIONS = 25;
/** Frames a socket may send in a window before it is dropped. */
const INBOUND_LIMIT = 60;
const INBOUND_WINDOW_MS = 10_000;
/** A browser this far behind is not reading; drop it rather than buffer for ever. */
const MAX_BUFFERED_BYTES = 1_048_576;

interface Connection {
  socket: WebSocket;
  principal: ChatPrincipal;
  /** Conversations this socket has open, after an ownership check. */
  open: Set<string>;
  lastTypingAt: Map<string, number>;
  inbound: { windowStart: number; count: number };
  alive: boolean;
}

function sideOf(principal: ChatPrincipal): ChatSide {
  return principal.kind === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF';
}

function canReply(principal: ChatPrincipal): boolean {
  return principal.kind === 'ADMIN' && principal.permissions.has(Permission.PREORDER_CHAT_REPLY);
}

export class ChatGateway {
  private readonly connections = new Set<Connection>();
  private readonly presence = new Map<string, { count: number; at: number }>();
  private unsubscribe: (() => void) | null = null;
  private timers: NodeJS.Timeout[] = [];
  private lastAnnouncedAvailable: boolean | null = null;

  constructor(private readonly bus: ChatBus) {}

  start(): void {
    this.unsubscribe = this.bus.subscribe((event) => {
      void this.onBusEvent(event);
    });
    this.bus.start();
    this.timers.push(
      setInterval(() => {
        void this.revalidateAll();
      }, REVALIDATE_MS),
      setInterval(() => {
        this.heartbeat();
      }, HEARTBEAT_MS),
      setInterval(() => {
        void this.publishPresence();
      }, PRESENCE_MS),
    );
    for (const timer of this.timers) timer.unref();
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const connection of this.connections) {
      connection.socket.close(CloseCode.SHUTTING_DOWN, 'server shutting down');
    }
    this.connections.clear();
    await this.bus.stop();
  }

  /** Publish events produced by a service, after its transaction committed. */
  async publish(events: readonly ChatBusEvent[]): Promise<void> {
    for (const event of events) await this.bus.publish(event);
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  attach(socket: WebSocket, principal: ChatPrincipal): void {
    const connection: Connection = {
      socket,
      principal,
      open: new Set(),
      lastTypingAt: new Map(),
      inbound: { windowStart: Date.now(), count: 0 },
      alive: true,
    };
    this.connections.add(connection);
    this.updateGauge();

    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('message', (raw) => {
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.from(raw).toString('utf8');
      void this.onClientFrame(connection, text);
    });
    socket.on('close', () => {
      this.connections.delete(connection);
      this.updateGauge();
      if (canReply(principal)) void this.publishPresence();
    });
    socket.on('error', (error) => {
      logger.debug({ err: error }, 'chat socket error');
    });

    this.send(connection, {
      type: 'hello',
      side: sideOf(principal),
      teamAvailable: this.teamAvailable(),
    });
    if (canReply(principal)) void this.publishPresence();
  }

  /** Staff who may reply, connected anywhere, counted by distinct person here. */
  private localStaffOnline(): number {
    const people = new Set<string>();
    for (const connection of this.connections) {
      if (canReply(connection.principal)) people.add(connection.principal.userId);
    }
    return people.size;
  }

  /**
   * Is anybody from the team actually here?
   *
   * Only staff who can REPLY count, and only while connected - a console that
   * was closed an hour ago is not "available". Under the database bus each
   * process reports its own count every ten seconds and a report older than
   * thirty is ignored, so a process that died stops counting on its own.
   */
  teamAvailable(): boolean {
    if (this.localStaffOnline() > 0) return true;
    const now = Date.now();
    for (const [instanceId, entry] of this.presence) {
      if (instanceId === this.bus.instanceId) continue;
      if (now - entry.at < PRESENCE_TTL_MS && entry.count > 0) return true;
    }
    return false;
  }

  private async publishPresence(): Promise<void> {
    await this.bus.publish({
      kind: 'presence',
      instanceId: this.bus.instanceId,
      staffOnline: this.localStaffOnline(),
    });
  }

  private announcePresenceIfChanged(): void {
    const available = this.teamAvailable();
    if (available === this.lastAnnouncedAvailable) return;
    this.lastAnnouncedAvailable = available;
    for (const connection of this.connections) {
      this.send(connection, { type: 'presence', teamAvailable: available });
    }
  }

  private updateGauge(): void {
    let customers = 0;
    let staff = 0;
    for (const connection of this.connections) {
      if (connection.principal.kind === 'CUSTOMER') customers += 1;
      else staff += 1;
    }
    chatSocketConnections.set({ audience: 'customer' }, customers);
    chatSocketConnections.set({ audience: 'staff' }, staff);
  }

  private send(connection: Connection, payload: Record<string, unknown>): void {
    const { socket } = connection;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      chatDeliveryFailuresTotal.inc({ stage: 'slow_consumer' });
      socket.terminate();
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      chatDeliveryFailuresTotal.inc({ stage: 'send' });
      logger.debug({ err: error }, 'chat socket send failed');
    }
  }

  private close(connection: Connection, code: number, errorCode: string): void {
    chatSocketFailuresTotal.inc({ reason: errorCode.toLowerCase() });
    this.send(connection, { type: 'error', code: errorCode });
    connection.socket.close(code, errorCode);
    this.connections.delete(connection);
    this.updateGauge();
  }

  private heartbeat(): void {
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        this.connections.delete(connection);
        continue;
      }
      connection.alive = false;
      try {
        connection.socket.ping();
      } catch {
        connection.socket.terminate();
      }
    }
    this.updateGauge();
  }

  /** Re-check every socket's session, account and permissions. */
  async revalidateAll(): Promise<void> {
    for (const connection of [...this.connections]) {
      try {
        const { principal } = connection;
        const session = await getSessionAuthState(principal.sessionId);
        const user = session.isActive
          ? await loadAuthenticatedUser(principal.userId, principal.kind)
          : null;
        if (user === null) {
          this.close(connection, CloseCode.UNAUTHENTICATED, 'SESSION_EXPIRED');
          continue;
        }
        if (principal.kind === 'ADMIN') {
          const permissions = new Set<string>(user.permissions);
          if (!permissions.has(Permission.PREORDER_CHAT_VIEW)) {
            this.close(connection, CloseCode.FORBIDDEN, 'PERMISSION_DENIED');
            continue;
          }
          principal.permissions = permissions;
        } else if (user.customerProfileId !== principal.customerProfileId) {
          this.close(connection, CloseCode.FORBIDDEN, 'PERMISSION_DENIED');
        }
      } catch (error) {
        // A database blip is not a reason to throw everybody out.
        logger.warn({ err: error }, 'chat socket revalidation failed');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Frames from the browser
  // -------------------------------------------------------------------------

  private async mayOpen(principal: ChatPrincipal, conversationId: string): Promise<boolean> {
    if (!/^[0-9A-Z]{26}$/.test(conversationId)) return false;
    if (principal.kind === 'ADMIN') {
      if (!principal.permissions.has(Permission.PREORDER_CHAT_VIEW)) return false;
      const exists = await prisma.preorderChatConversation.findUnique({
        where: { id: conversationId },
        select: { id: true },
      });
      return exists !== null;
    }
    // The ownership check, in the query: another customer's id finds nothing.
    const owned = await prisma.preorderChatConversation.findFirst({
      where: { id: conversationId, customerProfileId: principal.customerProfileId },
      select: { id: true },
    });
    return owned !== null;
  }

  private async onClientFrame(connection: Connection, raw: string): Promise<void> {
    const now = Date.now();
    if (now - connection.inbound.windowStart > INBOUND_WINDOW_MS) {
      connection.inbound = { windowStart: now, count: 0 };
    }
    connection.inbound.count += 1;
    if (connection.inbound.count > INBOUND_LIMIT) {
      this.close(connection, CloseCode.RATE_LIMITED, 'RATE_LIMITED');
      return;
    }

    let frame: { type?: unknown; conversationId?: unknown; state?: unknown; seq?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    const conversationId = typeof frame.conversationId === 'string' ? frame.conversationId : '';

    try {
      switch (frame.type) {
        case 'ping':
          this.send(connection, { type: 'pong' });
          return;

        case 'subscribe': {
          if (connection.open.size >= MAX_OPEN_CONVERSATIONS) return;
          if (!(await this.mayOpen(connection.principal, conversationId))) {
            this.send(connection, { type: 'error', code: 'NOT_FOUND', conversationId });
            return;
          }
          connection.open.add(conversationId);
          this.send(connection, { type: 'subscribed', conversationId });
          return;
        }

        case 'unsubscribe':
          connection.open.delete(conversationId);
          return;

        case 'typing': {
          if (!connection.open.has(conversationId)) return;
          if (connection.principal.kind === 'ADMIN' && !canReply(connection.principal)) return;
          const state = frame.state === 'stop' ? 'stop' : 'start';
          if (state === 'start') {
            const last = connection.lastTypingAt.get(conversationId) ?? 0;
            if (now - last < TYPING_THROTTLE_MS) return;
            connection.lastTypingAt.set(conversationId, now);
          } else {
            connection.lastTypingAt.delete(conversationId);
          }
          const owner = await prisma.preorderChatConversation.findUnique({
            where: { id: conversationId },
            select: { customerProfileId: true },
          });
          if (owner === null) return;
          await this.bus.publish({
            kind: 'typing',
            conversationId,
            customerProfileId: owner.customerProfileId,
            side: sideOf(connection.principal),
            userId: connection.principal.userId,
            state,
          });
          return;
        }

        case 'delivered': {
          if (!connection.open.has(conversationId)) return;
          const seq = typeof frame.seq === 'number' && Number.isInteger(frame.seq) ? frame.seq : -1;
          if (seq < 1) return;
          const event = await markDelivered(conversationId, sideOf(connection.principal), seq);
          if (event !== null) await this.bus.publish(event);
          return;
        }

        default:
          return;
      }
    } catch (error) {
      logger.warn({ err: error, frame: frame.type }, 'chat socket frame failed');
    }
  }

  // -------------------------------------------------------------------------
  // Bus events to sockets
  // -------------------------------------------------------------------------

  private customersOf(profileId: string): Connection[] {
    return [...this.connections].filter(
      (connection) =>
        connection.principal.kind === 'CUSTOMER' &&
        connection.principal.customerProfileId === profileId,
    );
  }

  private staff(): Connection[] {
    return [...this.connections].filter(
      (connection) =>
        connection.principal.kind === 'ADMIN' &&
        connection.principal.permissions.has(Permission.PREORDER_CHAT_VIEW),
    );
  }

  /** Staff views differ only in whether the customer's email is shown. */
  private async staffSummaries(
    conversationId: string,
    staff: Connection[],
  ): Promise<Map<boolean, Record<string, unknown> | null>> {
    const wanted = new Set(
      staff.map(
        (connection) =>
          connection.principal.kind === 'ADMIN' &&
          connection.principal.permissions.has(Permission.CUSTOMER_READ),
      ),
    );
    const views = new Map<boolean, Record<string, unknown> | null>();
    for (const withEmail of wanted) {
      views.set(
        withEmail,
        await loadStaffConversationSummary(conversationId, { canSeeCustomerEmail: withEmail }),
      );
    }
    return views;
  }

  private async onBusEvent(event: ChatBusEvent): Promise<void> {
    try {
      switch (event.kind) {
        case 'presence':
          this.presence.set(event.instanceId, { count: event.staffOnline, at: Date.now() });
          this.announcePresenceIfChanged();
          return;

        case 'message.created':
        case 'message.updated': {
          const type = event.kind;
          const customers = this.customersOf(event.customerProfileId);
          const staff = this.staff();
          if (customers.length > 0) {
            const message = await loadMessageView(event.messageId, 'CUSTOMER');
            if (message !== null) {
              for (const connection of customers) {
                this.send(connection, { type, conversationId: event.conversationId, message });
              }
            }
          }
          if (staff.length > 0) {
            const message = await loadMessageView(event.messageId, 'STAFF');
            if (message !== null) {
              for (const connection of staff) {
                this.send(connection, { type, conversationId: event.conversationId, message });
              }
            }
          }
          return;
        }

        case 'conversation.updated': {
          const staff = this.staff();
          if (staff.length > 0) {
            const views = await this.staffSummaries(event.conversationId, staff);
            for (const connection of staff) {
              const withEmail =
                connection.principal.kind === 'ADMIN' &&
                connection.principal.permissions.has(Permission.CUSTOMER_READ);
              const conversation = views.get(withEmail);
              if (conversation === null || conversation === undefined) continue;
              this.send(connection, {
                type: 'conversation.updated',
                reason: event.reason,
                conversation,
              });
            }
          }
          if (!event.staffOnly) {
            const customers = this.customersOf(event.customerProfileId);
            if (customers.length > 0) {
              const conversation = await loadCustomerConversationView(event.conversationId);
              if (conversation !== null) {
                for (const connection of customers) {
                  this.send(connection, { type: 'conversation.updated', conversation });
                }
              }
            }
          }
          return;
        }

        case 'receipt': {
          const payload = {
            type: 'receipt',
            conversationId: event.conversationId,
            side: event.side,
            deliveredSeq: event.deliveredSeq,
            readSeq: event.readSeq,
          };
          for (const connection of [...this.customersOf(event.customerProfileId), ...this.staff()]) {
            this.send(connection, payload);
          }
          return;
        }

        case 'typing': {
          const recipients = [...this.connections].filter((connection) => {
            if (!connection.open.has(event.conversationId)) return false;
            if (connection.principal.userId === event.userId) return false;
            if (connection.principal.kind === 'CUSTOMER') {
              // A customer hears the TEAM typing, never who, and never another
              // customer - there is no other customer in their conversation.
              return (
                event.side === 'STAFF' &&
                connection.principal.customerProfileId === event.customerProfileId
              );
            }
            return connection.principal.permissions.has(Permission.PREORDER_CHAT_VIEW);
          });
          for (const connection of recipients) {
            this.send(connection, {
              type: 'typing',
              conversationId: event.conversationId,
              side: event.side,
              state: event.state,
              // Staff may see which colleague is typing, to avoid two answers.
              ...(connection.principal.kind === 'ADMIN' && event.side === 'STAFF'
                ? { userId: event.userId }
                : {}),
            });
          }
          return;
        }
      }
    } catch (error) {
      chatDeliveryFailuresTotal.inc({ stage: 'fanout' });
      logger.error({ err: error, kind: event.kind }, 'chat fan-out failed');
    }
  }

  /** For health checks and tests. */
  stats(): { connections: number; teamAvailable: boolean } {
    return { connections: this.connections.size, teamAvailable: this.teamAvailable() };
  }
}
