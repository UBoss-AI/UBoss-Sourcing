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
export const REDACTED_PATHS = [
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

  // The logistics portal.
  //
  // Coordinates are not a secret; they are personal data about a named
  // employee, minute by minute, and a log retains them for as long as the log
  // lives - which is far longer than the thirty days the ping table is swept
  // on. A delivery OTP and a trip's device token are straightforwardly
  // credentials.
  'deviceToken',
  'deviceTokenHash',
  'deliveryOtp',
  'latitude',
  'longitude',
  '*.latitude',
  '*.longitude',
  'lastLatitude',
  'lastLongitude',
  'deliveryLatitude',
  'deliveryLongitude',
  'webhookSecretEnc',
  'credentialsEnc',

  // Headers that carry them
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["x-razorpay-signature"]',
  'req.headers["stripe-signature"]',

  // AI provider keys. The SDKs send them as request headers and none of them
  // puts one in an error today; these are here for the day an SDK attaches
  // its request config to an error, which is the leak nobody sees coming.
  'apiKey',
  '*.apiKey',
  'err.config.headers["x-goog-api-key"]',
  'err.config.headers["x-api-key"]',
  'err.headers["x-goog-api-key"]',
  'err.headers["x-api-key"]',

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
  '*.cardNumber',
  'pan',
  'cvc',
  'iban',
  '*.iban',
  'accountNumber',
  '*.accountNumber',
  'clientSecret',
  '*.clientSecret',
  '*.keySecret',
  '*.apiSecret',
  '*.webhookSecret',
  'privateKey',
  '*.privateKey',

  // Every other envelope column. Ciphertext is not a secret on its own, but
  // it has no business in a log and "which rows hold a credential" is a map.
  'payloadEnc',
  'codeVerifier',
  'codeVerifierEnc',
  'oauthTokenEnc',
  'apiKeyEncrypted',

  // Personal data with no operational value in a log line
  'req.body.email',
  'req.body.phone',
  'billingAddressJson',
  'shippingAddressJson',

  // A seller's business and tax identifiers, and the people who own it. Not
  // secrets, but a log line is copied to places an application's review
  // screen is not, and none of these helps anybody debug anything.
  'taxRegistrationNumber',
  '*.taxRegistrationNumber',
  'companyRegistrationNumber',
  '*.companyRegistrationNumber',
  'udyamNumber',
  '*.udyamNumber',
  'iecNumber',
  '*.iecNumber',
  'extraIdentifiersJson',
  '*.extraIdentifiersJson',
  'beneficialOwners',
  '*.beneficialOwners',
] as const;

/**
 * A card number that slipped into free text - an error message quoting a
 * provider's response, a note somebody pasted - is masked to its last four
 * digits. 13 to 19 digits, optionally grouped by spaces or dashes, and only
 * when the Luhn check passes, so order numbers and timestamps are left alone.
 */
const PAN_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function maskCardNumbers(text: string): string {
  return text.replace(PAN_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    return luhnValid(digits) ? `[CARD ****${digits.slice(-4)}]` : match;
  });
}

function maskStrings(record: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    masked[key] = typeof value === 'string' ? maskCardNumbers(value) : value;
  }
  return masked;
}

export const loggerOptions: LoggerOptions = {
  level: isTest ? (process.env.TEST_LOG_LEVEL ?? 'silent') : env.LOG_LEVEL,
  redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
  base: { service: 'uboss-api', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
    // Top-level string fields: `reason`, `providerMessage`, and so on.
    log: (record) => maskStrings(record),
  },
  hooks: {
    // The message itself, and any interpolation arguments.
    logMethod(args, method) {
      method.apply(
        this,
        args.map((arg) => (typeof arg === 'string' ? maskCardNumbers(arg) : arg)) as Parameters<
          typeof method
        >,
      );
    },
  },
  serializers: {
    // Deliberately narrow: log the shape of a request, never its contents.
    req(request: { method?: string; url?: string; id?: string }) {
      return { method: request.method, url: request.url, id: request.id };
    },
    res(reply: { statusCode?: number }) {
      return { statusCode: reply.statusCode };
    },
    err(error: Error) {
      const serialised = pino.stdSerializers.err(error);
      return {
        ...serialised,
        message: maskCardNumbers(serialised.message),
        ...(typeof serialised.stack === 'string'
          ? { stack: maskCardNumbers(serialised.stack) }
          : {}),
      };
    },
  },
};

export const logger: Logger = pino(
  isDevelopment
    ? {
        ...loggerOptions,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
        },
      }
    : loggerOptions,
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
