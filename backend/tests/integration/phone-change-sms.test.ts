/**
 * Phone-number confirmation through the operator's SMS gateway (JOURNEY-008).
 *
 * With SMS_HTTP_URL set the link goes by text message to the NEW number and
 * confirming it marks the number verified; a gateway that refuses is a 502
 * SMS_DELIVERY_FAILED with nothing left pending; with no gateway the account
 * email is used and the API says which channel it was.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import { asCustomer, cleanUpOrderDesk, customer, emailFor, type Session } from '../support/order-desk-fixture.js';

const TAG = 'sms8';
let app: Awaited<ReturnType<typeof buildApp>>;
let server: Server;
let gatewayStatus = 200;
const received: { auth: string | undefined; body: { to: string; from: string; body: string } }[] = [];
let session: Session;
const saved = { url: env.SMS_HTTP_URL, token: env.SMS_HTTP_TOKEN };

beforeAll(async () => {
  server = createServer((request, response) => {
    let data = '';
    request.on('data', (chunk: Buffer) => (data += chunk.toString()));
    request.on('end', () => {
      received.push({ auth: request.headers.authorization, body: JSON.parse(data) as { to: string; from: string; body: string } });
      response.statusCode = gatewayStatus;
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  app = await buildApp();
  await app.ready();
  await cleanUpOrderDesk(TAG);
  session = await customer(app, TAG, 'buyer', '10.84.0.10');
}, 120_000);

afterAll(async () => {
  env.SMS_HTTP_URL = saved.url;
  env.SMS_HTTP_TOKEN = saved.token;
  await cleanUpOrderDesk(TAG);
  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function useGateway(on: boolean): void {
  env.SMS_HTTP_URL = on ? `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/sms` : undefined;
  env.SMS_HTTP_TOKEN = on ? 'gateway-test-token' : undefined;
}

describe('phone change', () => {
  it('sends the link to the new number by SMS, and confirming it verifies the number', async () => {
    useGateway(true);
    const response = await asCustomer(app, session, 'POST', '/account/phone-change', { payload: { phone: '+4915112345678' } });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json<{ channel: string }>().channel).toBe('SMS');
    const message = received.at(-1);
    expect(message?.auth).toBe('Bearer gateway-test-token');
    expect(message?.body.to).toBe('+4915112345678');
    const token = /token=([^&\s]+)/.exec(message?.body.body ?? '')?.[1] ?? /\/([A-Za-z0-9_-]{20,})(?:\s|$)/.exec(message?.body.body ?? '')?.[1];
    expect(token).toBeDefined();
    const confirmed = await asCustomer(app, session, 'POST', '/account/phone-change/confirm', { payload: { token: decodeURIComponent(token ?? '') } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const user = await prisma.user.findFirstOrThrow({ where: { emailNormalized: emailFor(TAG, 'buyer') }, select: { phone: true, phoneVerifiedAt: true, pendingPhone: true } });
    expect(user).toMatchObject({ phone: '+4915112345678', pendingPhone: null });
    expect(user.phoneVerifiedAt).not.toBeNull();
  });

  it('reports a refusing gateway and leaves nothing pending', async () => {
    useGateway(true);
    gatewayStatus = 500;
    const response = await asCustomer(app, session, 'POST', '/account/phone-change', { payload: { phone: '+4915199999999' } });
    gatewayStatus = 200;
    expect(response.statusCode).toBe(502);
    expect(response.body).toContain('SMS_DELIVERY_FAILED');
    const user = await prisma.user.findFirstOrThrow({ where: { emailNormalized: emailFor(TAG, 'buyer') }, select: { pendingPhone: true } });
    expect(user.pendingPhone).toBeNull();
  });

  it('falls back to the account email when no gateway is configured, and says so', async () => {
    useGateway(false);
    const before = received.length;
    const response = await asCustomer(app, session, 'POST', '/account/phone-change', { payload: { phone: '+4915100000000' } });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json<{ channel: string }>().channel).toBe('EMAIL');
    expect(received.length).toBe(before);
  });
});
