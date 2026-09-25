/**
 * The chat's live side, attached to one Fastify app.
 *
 * One bus and one gateway per app rather than per module, so that a test can
 * build two apps on one database with REALTIME_BUS_DRIVER=database and prove
 * that a message sent through the first reaches a socket on the second - the
 * same thing two API processes behind a load balancer do.
 *
 * Services never publish. They return the events their transaction implies,
 * and the route publishes them through `app.preorderChat.publish` once the
 * transaction has committed - so a rolled-back write can never have been
 * announced.
 */
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { createChatBus, type ChatBus, type ChatBusHealth } from './bus.js';
import type { ChatBusEvent } from './events.js';
import { ChatGateway } from './gateway.js';

export interface ChatRuntime {
  bus: ChatBus;
  gateway: ChatGateway;
  publish(events: readonly ChatBusEvent[]): Promise<void>;
  health(): ChatBusHealth & { connections: number };
}

declare module 'fastify' {
  interface FastifyInstance {
    preorderChat: ChatRuntime;
  }
}

export function createChatRuntime(bus: ChatBus = createChatBus()): ChatRuntime {
  const gateway = new ChatGateway(bus);
  return {
    bus,
    gateway,
    publish: (events) => gateway.publish(events),
    health: () => ({ ...bus.health(), connections: gateway.stats().connections }),
  };
}

/**
 * Register the WebSocket plugin and the runtime on the ROOT app.
 *
 * Root, because `@fastify/websocket` must see every route to upgrade it, and
 * the decorator must be visible inside every encapsulated route plugin.
 * `maxPayload` bounds what a browser may send in one frame: the protocol has
 * nothing bigger than a subscribe, a typing flag or a delivered position, so
 * anything above a few kilobytes is not a client of ours.
 */
export async function registerChatRuntime(app: FastifyInstance): Promise<void> {
  await app.register(websocket, {
    options: { maxPayload: 4096 },
  });

  const runtime = createChatRuntime();
  app.decorate('preorderChat', runtime);
  runtime.gateway.start();

  app.addHook('onClose', async () => {
    await runtime.gateway.stop();
  });
}
