/**
 * Email delivery.
 *
 * Nothing in the application calls a provider directly. Business code writes to
 * `notification_outbox` inside its own transaction; the worker drains the
 * outbox and calls this. That indirection is what makes "order committed but
 * confirmation email lost" impossible.
 *
 * `EMAIL_DRIVER=log` renders the message into the structured log instead of
 * sending it. It is a development convenience and is rejected at boot in
 * production, so it can never silently swallow a customer's invitation.
 */
import { createTransport, type Transporter } from 'nodemailer';
import { env, isProduction } from '../../config/env.js';
import { logger } from '../logger.js';

export interface EmailMessage {
  to: string;
  toName?: string;
  subject: string;
  /** Plain text body. Always present - it is the accessible fallback. */
  text: string;
  html?: string;
  replyTo?: string;
}

export interface EmailResult {
  /** Provider message id, stored on notification_deliveries for tracing. */
  providerMessageId: string | null;
  provider: string;
  durationMs: number;
}

export interface EmailDriver {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailResult>;
  verify(): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Development driver. Logs the full message so an invitation link can be copied
 * out of the terminal during local work.
 */
class LogEmailDriver implements EmailDriver {
  readonly name = 'log';

  send(message: EmailMessage): Promise<EmailResult> {
    const startedAt = process.hrtime.bigint();

    // `emailPreview` rather than spreading the message: the redaction paths in
    // logger.ts censor `req.body.email`, and a flat `to` field would slip past
    // the intent of that rule in production-shaped logs.
    logger.info(
      {
        emailPreview: {
          to: message.to,
          subject: message.subject,
          body: message.text,
        },
      },
      'email (log driver - not delivered)',
    );

    return Promise.resolve({
      providerMessageId: null,
      provider: this.name,
      durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
    });
  }

  verify(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
}

class SmtpEmailDriver implements EmailDriver {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor() {
    this.transporter = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth:
        env.SMTP_USER.length > 0
          ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
          : undefined,
      // Bounded, so a hanging SMTP server cannot pin a worker slot forever.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const startedAt = process.hrtime.bigint();

    // nodemailer types `sendMail` as returning `any`. Narrowing it here keeps
    // the `any` contained to this one statement instead of leaking outward.
    const info: unknown = await this.transporter.sendMail({
      from: { name: env.EMAIL_FROM_NAME, address: env.EMAIL_FROM_ADDRESS },
      to: message.toName !== undefined ? { name: message.toName, address: message.to } : message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html !== undefined ? { html: message.html } : {}),
      ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
    });

    const messageId =
      typeof info === 'object' && info !== null && 'messageId' in info ? info.messageId : null;

    return {
      providerMessageId: typeof messageId === 'string' ? messageId : null,
      provider: this.name,
      durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
    };
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.transporter.verify();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'SMTP verify failed' };
    }
  }
}

function createEmailDriver(): EmailDriver {
  switch (env.EMAIL_DRIVER) {
    case 'log':
      if (isProduction) {
        // Belt and braces: config/env.ts already rejects this combination.
        throw new Error('EMAIL_DRIVER=log does not deliver mail and is not allowed in production.');
      }
      return new LogEmailDriver();
    case 'smtp':
      return new SmtpEmailDriver();
    default: {
      const exhaustive: never = env.EMAIL_DRIVER;
      throw new Error(`Unknown EMAIL_DRIVER: ${String(exhaustive)}`);
    }
  }
}

export const email: EmailDriver = createEmailDriver();
