/**
 * Log redaction - what must never reach a log line.
 *
 * Redaction is configured once in `infra/logger.ts` so that the dangerous case
 * (an error or a request body somebody logged wholesale while debugging) is
 * covered without the caller remembering anything. The card-number mask once
 * silently matched nothing, so these tests build a real pino logger from the
 * production options and read what it actually wrote.
 */
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions, maskCardNumbers } from '../../src/infra/logger.js';

function capture(): { lines: () => Array<Record<string, unknown>>; log: pino.Logger } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const log = pino({ ...loggerOptions, level: 'info' }, stream);
  return {
    log,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const VISA = '4242424242424242';

describe('log redaction', () => {
  it('redacts passwords and tokens wherever they sit', () => {
    const { log, lines } = capture();
    log.info({
      password: 'hunter2-Hunter2!',
      currentPassword: 'old-secret-1',
      newPassword: 'new-secret-2',
      token: 'tok_live_abcdef',
      accessToken: 'access-abc',
      refreshToken: 'refresh-abc',
      tokenHash: 'deadbeef',
      user: { password: 'nested-secret', token: 'nested-token' },
    });

    const written = JSON.stringify(lines());
    for (const secret of [
      'hunter2',
      'old-secret-1',
      'new-secret-2',
      'tok_live_abcdef',
      'access-abc',
      'refresh-abc',
      'deadbeef',
      'nested-secret',
      'nested-token',
    ]) {
      expect(written).not.toContain(secret);
    }
    expect(lines()[0]?.password).toBe('[REDACTED]');
    expect((lines()[0]?.user as Record<string, unknown>).token).toBe('[REDACTED]');
  });

  it('redacts the authorization header, cookies and provider signatures', () => {
    const { log, lines } = capture();
    log.info({
      req: {
        headers: {
          authorization: 'Bearer eyJhbGciOi.secret',
          cookie: 'uboss_session=abc123',
          'x-api-key': 'key-123',
          'stripe-signature': 't=1,v1=sig',
          'x-razorpay-signature': 'rzp-sig',
        },
      },
      res: { headers: { 'set-cookie': ['uboss_session=zzz; HttpOnly'] } },
    });

    const written = JSON.stringify(lines());
    for (const secret of ['eyJhbGciOi', 'abc123', 'key-123', 'v1=sig', 'rzp-sig', 'zzz']) {
      expect(written).not.toContain(secret);
    }
  });

  it('redacts card fields, and the provider material that pays for them', () => {
    const { log, lines } = capture();
    log.info({
      card: { number: VISA, cvc: '123' },
      cardNumber: VISA,
      cvv: '999',
      cvc: '123',
      pan: VISA,
      iban: 'DE89370400440532013000',
      clientSecret: 'placeholder-client-value',
      webhookSecret: 'whsec_abc',
      signature: 'sig-abc',
    });

    const written = JSON.stringify(lines());
    for (const secret of [
      VISA,
      '999',
      'DE89370400440532013000',
      'placeholder-client-value',
      'whsec_abc',
      'sig-abc',
    ]) {
      expect(written).not.toContain(secret);
    }
  });

  it('masks a card number that slipped into free text, keeping the last four', () => {
    const { log, lines } = capture();
    log.info(`provider said: card ${VISA} was declined`);
    log.info({ reason: `declined for 4242 4242 4242 4242 today` });
    log.error(new Error(`Stripe: card ${VISA} refused`));

    const written = JSON.stringify(lines());
    expect(written).not.toContain(VISA);
    expect(written).not.toContain('4242 4242 4242 4242');
    expect(written).toContain('[CARD ****4242]');
  });

  it('leaves a number that is not a card alone', () => {
    expect(maskCardNumbers('order 1234567890123 shipped')).toBe('order 1234567890123 shipped');
    expect(maskCardNumbers(`pay ${VISA}`)).toBe('pay [CARD ****4242]');
  });

  it('never logs a request body, only its method, url and id', () => {
    const { log, lines } = capture();
    log.info({
      req: {
        method: 'POST',
        url: '/api/v1/auth/login',
        id: 'req-1',
        body: { password: 'x-body-secret' },
      },
    });

    const line = lines()[0] as { req: Record<string, unknown> };
    expect(line.req).toEqual({ method: 'POST', url: '/api/v1/auth/login', id: 'req-1' });
    expect(JSON.stringify(line)).not.toContain('x-body-secret');
  });
});
