/**
 * Two API processes, one database: the shared chat bus.
 *
 * Under REALTIME_BUS_DRIVER=database a message sent through one process must
 * reach a browser connected to another. This builds two apps in one test
 * process - each with its own bus instance and gateway, exactly as two
 * processes behind a load balancer would have - connects a member of staff to
 * the SECOND and sends a customer's message through the FIRST.
 *
 * Also: what crosses the table is a reference, never the message body.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';

import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';

type App = Awaited<ReturnType<typeof BuildApp>>;

let first: App;
let second: App;
let prisma: typeof PrismaClient;

const PASSWORD = 'PreorderChat!2026';
const BUYER = 'pchm-buyer@test.local';
const STAFF = 'pchm-staff@test.local';
const SLUG = 'pchm-product';
let productId = '';

async function cleanUp(): Promise<void> {
  const profiles = { user: { emailNormalized: BUYER } };
  const chats = await prisma.preorderChatConversation.findMany({ where: { customerProfile: profiles }, select: { id: true } });
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: chats.map((c) => c.id) } } });
  await prisma.preorderChatConversation.deleteMany({ where: { customerProfile: profiles } });
  await prisma.customerProfile.deleteMany({ where: profiles });
  await prisma.product.deleteMany({ where: { slug: SLUG } });
  await prisma.category.deleteMany({ where: { slug: 'pchm-category' } });
  for (const email of [BUYER, STAFF]) {
    await prisma.session.deleteMany({ where: { user: { emailNormalized: email } } });
    await prisma.userRole.deleteMany({ where: { user: { emailNormalized: email } } });
    await prisma.user.deleteMany({ where: { emailNormalized: email } });
  }
}

beforeAll(async () => {
  process.env.REALTIME_BUS_DRIVER = 'database';
  process.env.REALTIME_BUS_POLL_MS = '100';

  ({ prisma } = await import('../../src/infra/prisma.js'));
  const { newId } = await import('../../src/infra/ids.js');
  const { hashPassword } = await import('../../src/infra/crypto.js');
  const { Role } = await import('../../src/domain/permissions.js');
  const { buildApp } = await import('../../src/http/app.js');

  await cleanUp();

  const passwordHash = await hashPassword(PASSWORD);
  const buyer = await prisma.user.create({
    data: { id: newId(), type: 'CUSTOMER', email: BUYER, emailNormalized: BUYER, passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  await prisma.customerProfile.create({
    data: { id: newId(), userId: buyer.id, fullName: 'Multi buyer', organization: 'Multi Ltd', activatedAt: new Date() },
  });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: Role.ORDER_MANAGER } });
  await prisma.user.create({
    data: {
      id: newId(), type: 'ADMIN', email: STAFF, emailNormalized: STAFF, passwordHash, status: 'ACTIVE',
      emailVerifiedAt: new Date(), roles: { create: { roleId: role.id } },
    },
  });
  const taxClass = await prisma.taxClass.upsert({
    where: { code: 'PCH-ZERO' },
    update: {},
    create: { id: newId(), code: 'PCH-ZERO', name: 'Zero', ratePercent: '0.000000', isActive: true },
  });
  const category = await prisma.category.create({
    data: { id: newId(), name: 'Multi', slug: 'pchm-category', isActive: true },
  });
  productId = (
    await prisma.product.create({
      data: {
        id: newId(), categoryId: category.id, taxClassId: taxClass.id, name: 'Multi-instance mask', slug: SLUG,
        sku: 'PCHM-MASK', basePriceMinor: 1_000n, currency: 'INR', status: 'ACTIVE', isPublished: true,
        publishedAt: new Date(), isMarketplaceProduct: false, isStockTracked: false, minOrderQty: 1, qtyIncrement: 1,
      },
    })
  ).id;

  first = await buildApp();
  second = await buildApp();
  await first.ready();
  await second.ready();
});

afterAll(async () => {
  await first.close();
  await second.close();
  await cleanUp();
});

describe('the database bus', () => {
  it('gives each process its own bus', () => {
    expect(first.preorderChat.bus.instanceId).not.toBe(second.preorderChat.bus.instanceId);
    expect(first.preorderChat.health().driver).toBe('database');
  });

  it('delivers a message sent through one process to a socket on the other', async () => {
    const login = await first.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: BUYER, password: PASSWORD } });
    expect(login.statusCode, login.body).toBe(200);
    const jar = login.cookies as { name: string; value: string }[];
    const customerCookies = jar.map((c) => `${c.name}=${c.value}`).join('; ');
    const csrf = jar.find((c) => c.name === 'uboss_shop_csrf')?.value ?? '';

    const { signInAdmin } = await import('../support/admin-session.js');
    const staff = await signInAdmin(second, { email: STAFF, password: PASSWORD });

    const frames: Record<string, unknown>[] = [];
    const socket: WebSocket = await second.injectWS('/api/v1/admin/preorder-chats/socket', {
      headers: { cookie: staff.cookies },
    }, {
      onInit: (ws) => {
        ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>));
      },
    });

    // The staff member is on the SECOND process; the customer's page asks the
    // FIRST whether anybody is there. Presence crosses the bus too.
    let available = false;
    for (let attempt = 0; attempt < 40 && !available; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      available = first.preorderChat.gateway.teamAvailable();
    }
    expect(available).toBe(true);

    const sent = await first.inject({
      method: 'POST',
      url: '/api/v1/preorder-chats/messages',
      headers: { cookie: customerCookies, 'x-csrf-token': csrf },
      payload: {
        clientMessageId: crypto.randomUUID(),
        body: 'Sent through process one',
        context: { productId, variantId: null, orderingUnit: 'PIECE', unitQuantity: 1_000 },
      },
    });
    expect(sent.statusCode, sent.body).toBe(201);

    let delivered: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 50 && delivered === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      delivered = frames.find(
        (frame) =>
          frame['type'] === 'message.created' &&
          (frame['message'] as { body: string }).body === 'Sent through process one',
      );
    }
    expect(delivered).toBeDefined();

    // What crossed the table was a reference.
    const rows = await prisma.realtimeEvent.findMany({ orderBy: { id: 'desc' }, take: 50 });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.map((row) => row.payloadJson))).not.toContain('Sent through process one');

    socket.terminate();
  });

  it('reports itself healthy on the readiness probe', async () => {
    const response = await second.inject({ method: 'GET', url: '/health/ready' });
    const body = response.json<{ dependencies: { realtime: { ok: boolean } } }>();
    expect(body.dependencies.realtime.ok).toBe(true);
  });
});
