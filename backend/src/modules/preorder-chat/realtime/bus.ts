/**
 * How a change in one API process reaches browsers connected to another.
 *
 * The chat's source of truth is the database. This bus only says "conversation
 * X has message 14" - a reference - and the process that delivers it reads
 * message 14 itself, through the same visibility rules as a REST read. Two
 * consequences worth stating:
 *
 *   - **Nothing here carries content.** No message body, no note, no customer
 *     name. An event that reached the wrong socket would tell it an id.
 *   - **Losing an event loses nothing.** A browser that missed one reads what
 *     it missed by sequence number when it next connects or looks.
 *
 * TWO DRIVERS
 *
 *   memory   - an in-process emitter. One API process, which is how this ships.
 *   database - every event is also written to `realtime_events`; every process
 *              polls that table and delivers what other processes wrote. No
 *              Redis, which XAMPP does not ship, and at chat volume a polled
 *              indexed table is a legitimate transport rather than a stopgap.
 *
 * WHY THE POLL TRACKS GAPS
 *
 * Auto-increment ids are handed out at insert and become visible at commit.
 * Two writers can commit out of order - id 12 visible while id 11 is not yet -
 * so a poller that simply advanced past 12 would never see 11. Ids skipped
 * over are remembered for a few seconds and asked for again; a gap left by a
 * rolled-back insert is never filled and ages out.
 */
import { EventEmitter } from 'node:events';
import { env } from '../../../config/env.js';
import { newId } from '../../../infra/ids.js';
import { logger } from '../../../infra/logger.js';
import { prisma } from '../../../infra/prisma.js';
import { chatBusFailuresTotal } from '../metrics.js';
import type { ChatBusEvent } from './events.js';

export type ChatBusHandler = (event: ChatBusEvent) => void;

export interface ChatBusHealth {
  driver: 'memory' | 'database';
  healthy: boolean;
  /** When the database bus last read the table successfully. */
  lastPollAt: string | null;
  lastError: string | null;
}

export interface ChatBus {
  readonly instanceId: string;
  publish(event: ChatBusEvent): Promise<void>;
  subscribe(handler: ChatBusHandler): () => void;
  start(): void;
  stop(): Promise<void>;
  health(): ChatBusHealth;
}

class LocalFanout {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Every connected socket's gateway listens once, not once per socket, so
    // a handful of listeners is normal; the default warning at 10 is noise.
    this.emitter.setMaxListeners(100);
  }

  emit(event: ChatBusEvent): void {
    // A microtask, so the publisher's own request finishes before any socket
    // is written to, and a throwing listener cannot fail that request.
    queueMicrotask(() => {
      this.emitter.emit('event', event);
    });
  }

  on(handler: ChatBusHandler): () => void {
    const wrapped = (event: ChatBusEvent): void => {
      try {
        handler(event);
      } catch (error) {
        logger.error({ err: error, kind: event.kind }, 'chat bus listener failed');
      }
    };
    this.emitter.on('event', wrapped);
    return () => {
      this.emitter.off('event', wrapped);
    };
  }
}

export class MemoryChatBus implements ChatBus {
  readonly instanceId = `mem-${newId()}`;
  private readonly local = new LocalFanout();

  publish(event: ChatBusEvent): Promise<void> {
    this.local.emit(event);
    return Promise.resolve();
  }

  subscribe(handler: ChatBusHandler): () => void {
    return this.local.on(handler);
  }

  start(): void {
    /* nothing to start */
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  health(): ChatBusHealth {
    return { driver: 'memory', healthy: true, lastPollAt: null, lastError: null };
  }
}

/** How long a skipped id is asked for again before it is written off. */
const GAP_TTL_MS = 5_000;
/** Rows older than this are deleted. Nothing here is history. */
const RETAIN_MS = 120_000;
/** How often one process prunes. Any process may; the delete is idempotent. */
const PRUNE_EVERY_MS = 30_000;
const BATCH = 500;

export class DatabaseChatBus implements ChatBus {
  readonly instanceId: string;
  private readonly local = new LocalFanout();
  private cursor: bigint | null = null;
  /** id -> when it was first noticed missing. */
  private readonly gaps = new Map<bigint, number>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;
  private lastPollAt: Date | null = null;
  private lastError: string | null = null;
  private lastPruneAt = 0;

  constructor(
    private readonly pollMs: number = env.REALTIME_BUS_POLL_MS,
    instanceId?: string,
  ) {
    this.instanceId = instanceId ?? `db-${newId()}`;
  }

  async publish(event: ChatBusEvent): Promise<void> {
    // This process's own sockets hear it at once; the row is for the others.
    this.local.emit(event);
    try {
      await prisma.realtimeEvent.create({
        data: { instanceId: this.instanceId, payloadJson: event },
      });
    } catch (error) {
      // Not thrown: the message is committed and the publisher's request has
      // succeeded. Browsers on other processes recover it on their next read.
      chatBusFailuresTotal.inc({ stage: 'publish' });
      logger.error({ err: error, kind: event.kind }, 'chat bus publish failed');
    }
  }

  subscribe(handler: ChatBusHandler): () => void {
    return this.local.on(handler);
  }

  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    const tick = (): void => {
      if (this.stopped) return;
      void this.poll().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, this.pollMs);
      });
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    // Let an in-flight poll finish rather than racing the Prisma disconnect.
    for (let waited = 0; this.polling && waited < 2_000; waited += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  health(): ChatBusHealth {
    const fresh =
      this.lastPollAt !== null && Date.now() - this.lastPollAt.getTime() < Math.max(10_000, this.pollMs * 10);
    return {
      driver: 'database',
      healthy: fresh,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }

  /** One pass. Public so a test can drive the bus without waiting on a timer. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      if (this.cursor === null) {
        // Start from now. Events from before this process existed are not for it.
        const latest = await prisma.realtimeEvent.findFirst({
          orderBy: { id: 'desc' },
          select: { id: true },
        });
        this.cursor = latest?.id ?? 0n;
      }

      const now = Date.now();
      for (const [id, since] of this.gaps) {
        if (now - since > GAP_TTL_MS) this.gaps.delete(id);
      }

      const gapIds = [...this.gaps.keys()];
      const rows = await prisma.realtimeEvent.findMany({
        where: {
          OR: [{ id: { gt: this.cursor } }, ...(gapIds.length > 0 ? [{ id: { in: gapIds } }] : [])],
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        select: { id: true, instanceId: true, payloadJson: true },
      });

      for (const row of rows) {
        this.gaps.delete(row.id);
        if (row.id > this.cursor) {
          // Everything between the old cursor and this id that we have not
          // seen may still be committing.
          for (let missing = this.cursor + 1n; missing < row.id; missing += 1n) {
            if (this.gaps.size > 5_000) break;
            this.gaps.set(missing, now);
          }
          this.cursor = row.id;
        }
        if (row.instanceId === this.instanceId) continue;
        this.local.emit(row.payloadJson as unknown as ChatBusEvent);
      }

      if (now - this.lastPruneAt > PRUNE_EVERY_MS) {
        this.lastPruneAt = now;
        await prisma.realtimeEvent.deleteMany({
          where: { createdAt: { lt: new Date(now - RETAIN_MS) } },
        });
      }

      this.lastPollAt = new Date();
      this.lastError = null;
    } catch (error) {
      chatBusFailuresTotal.inc({ stage: 'poll' });
      this.lastError = error instanceof Error ? error.message.slice(0, 200) : 'poll failed';
      logger.warn({ err: error }, 'chat bus poll failed');
    } finally {
      this.polling = false;
    }
  }
}

export function createChatBus(): ChatBus {
  return env.REALTIME_BUS_DRIVER === 'database' ? new DatabaseChatBus() : new MemoryChatBus();
}
