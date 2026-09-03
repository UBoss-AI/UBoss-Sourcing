/**
 * Structured logging with redaction.
 *
 * Redaction is configured here rather than at each call site, because the
 * dangerous case is the one nobody remembered to redact: an error object that
 * happens to carry a provider response, or a request body logged wholesale
 * during debugging. The paths below are censored no matter who logs them.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';
import { env, isDevelopment, isTest } from '../config/env.js';

/**
 * Anything matching these paths is replaced with [REDACTED] before it is
 * serialised. Covers credentials, session material, payment secrets and the
 * personal data we have no operational reason to keep in logs.
 */
const REDACTED_PATHS = [
  // Credentials and session material
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  '*.token',
  'accessToken',
  'refreshToken',
  'refreshTokenHash',
  'tokenHash',
  '*.tokenHash',
  'mfaSecret',
  'mfaSecretEnc',
  'otp',
  'sessionId',

  // Headers that carry them
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["x-razorpay-signature"]',
  'req.headers["stripe-signature"]',

  // Payment provider material
  'keySecret',
  'apiSecret',
  'webhookSecret',
  'credentialsEnc',
  'webhookSecretEnc',
  'signature',
  '*.signature',
  'card',
  '*.card',
  'cvv',
  'cardNumber',

  // Personal data with no operational value in a log line
  'req.body.email',
  'req.body.phone',
  'billingAddressJson',
  'shippingAddressJson',
] as const;

const baseOptions: LoggerOptions = {
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
  base: { service: 'uboss-api', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  serializers: {
    // Deliberately narrow: log the shape of a request, never its contents.
    req(request: { method?: string; url?: string; id?: string }) {
      return { method: request.method, url: request.url, id: request.id };
    },
    res(reply: { statusCode?: number }) {
      return { statusCode: reply.statusCode };
    },
    err: pino.stdSerializers.err,
  },
};

export const logger: Logger = pino(
  isDevelopment
    ? {
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
        },
      }
    : baseOptions,
);

/**
 * Child logger bound to a correlation id. Every request gets one, and it is
 * carried into queued jobs so a webhook, the order it confirmed and the email
 * it triggered can be traced as one causal chain.
 */
export function loggerFor(correlationId: string, context?: Record<string, unknown>): Logger {
  return logger.child({ correlationId, ...context });
}

export type { Logger };
