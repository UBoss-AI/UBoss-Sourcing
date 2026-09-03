/**
 * Environment loading and validation.
 *
 * The process refuses to boot on a missing or malformed value rather than
 * failing later inside a payment or migration path. Nothing in the codebase
 * reads `process.env` directly - everything imports `env` from here.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/** "true"/"1"/"yes" -> true. Anything else falsy. Env vars are always strings. */
const booleanFromString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const intFromString = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

/** Comma-separated origin list -> deduplicated array of exact origins. */
const originList = z
  .string()
  .transform((raw) =>
    Array.from(
      new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    ),
  );

const envSchema = z
  .object({
    // --- Runtime ---
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: intFromString(1, 65535).default(4000),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_PUBLIC_URL: z.string().url(),

    // --- Frontend origins ---
    ADMIN_WEB_ORIGIN: originList,
    CUSTOMER_WEB_ORIGIN: originList,
    CUSTOMER_WEB_PUBLIC_URL: z.string().url(),
    ADMIN_WEB_PUBLIC_URL: z.string().url(),

    // --- Database ---
    DATABASE_URL: z.string().min(1),
    TEST_DATABASE_URL: z.string().min(1).optional(),
    DB_POOL_SIZE: intFromString(1, 100).default(10),
    DB_CONNECT_TIMEOUT_MS: intFromString(1000, 60_000).default(10_000),

    // --- Sessions / tokens ---
    // 32 bytes of entropy minimum. Short secrets are a real-world breach path,
    // so this is a hard boot failure rather than a warning.
    SESSION_COOKIE_SECRET: z.string().min(32),
    ACCESS_TOKEN_SECRET: z.string().min(32),
    REFRESH_TOKEN_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL_SECONDS: intFromString(60, 86_400).default(900),
    REFRESH_TOKEN_TTL_SECONDS: intFromString(3600, 31_536_000).default(2_592_000),
    COOKIE_DOMAIN: z.string().default(''),
    COOKIE_SECURE: booleanFromString.default(false),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    // --- Encryption at rest ---
    SECRETS_ENCRYPTION_KEY: z.string().min(1),

    // --- Queue / cache ---
    QUEUE_DRIVER: z.enum(['database', 'redis']).default('database'),
    CACHE_DRIVER: z.enum(['memory', 'redis']).default('memory'),
    REDIS_URL: z.string().default(''),
    WORKER_POLL_INTERVAL_MS: intFromString(250, 60_000).default(2000),
    WORKER_CONCURRENCY: intFromString(1, 64).default(4),
    WORKER_LEASE_SECONDS: intFromString(10, 3600).default(60),

    // --- Object storage ---
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('.storage'),
    STORAGE_PUBLIC_BASE_URL: z.string().url(),
    S3_ENDPOINT: z.string().default(''),
    S3_REGION: z.string().default(''),
    S3_BUCKET: z.string().default(''),
    S3_ACCESS_KEY_ID: z.string().default(''),
    S3_SECRET_ACCESS_KEY: z.string().default(''),
    S3_FORCE_PATH_STYLE: booleanFromString.default(true),
    UPLOAD_MAX_BYTES: intFromString(1024, 104_857_600).default(5_242_880),

    // --- Email ---
    EMAIL_DRIVER: z.enum(['log', 'smtp']).default('log'),
    EMAIL_FROM_NAME: z.string().min(1),
    EMAIL_FROM_ADDRESS: z.string().email(),
    SMTP_HOST: z.string().default(''),
    SMTP_PORT: intFromString(1, 65535).default(587),
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    SMTP_SECURE: booleanFromString.default(false),

    // --- Payments ---
    PAYMENT_DEFAULT_PROVIDER: z.enum(['razorpay', 'stripe']).default('razorpay'),
    RAZORPAY_KEY_ID: z.string().default(''),
    RAZORPAY_KEY_SECRET: z.string().default(''),
    RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
    STRIPE_SECRET_KEY: z.string().default(''),
    STRIPE_WEBHOOK_SECRET: z.string().default(''),
    PAYMENT_LINK_TTL_HOURS: intFromString(1, 8760).default(72),

    // --- Business defaults ---
    DEFAULT_CURRENCY: z.string().length(3).toUpperCase().default('INR'),
    DEFAULT_TIMEZONE: z.string().min(1).default('Asia/Kolkata'),

    // --- Feature flags ---
    FEATURE_CUSTOMER_SELF_REGISTRATION: booleanFromString.default(false),
    FEATURE_STOCK_RESERVATIONS: booleanFromString.default(true),
    FEATURE_ORDER_APPROVALS: booleanFromString.default(false),
    FEATURE_RECURRING_ORDERS: booleanFromString.default(true),

    // --- Rate limits ---
    RATE_LIMIT_GLOBAL_PER_MINUTE: intFromString(10, 100_000).default(300),
    RATE_LIMIT_LOGIN_PER_15MIN: intFromString(1, 1000).default(10),
    LOGIN_LOCKOUT_THRESHOLD: intFromString(3, 100).default(8),
    LOGIN_LOCKOUT_MINUTES: intFromString(1, 1440).default(15),
  })
  .superRefine((value, ctx) => {
    // AES-256-GCM needs exactly 32 bytes of key material.
    const keyBytes = Buffer.from(value.SECRETS_ENCRYPTION_KEY, 'base64');
    if (keyBytes.length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SECRETS_ENCRYPTION_KEY'],
        message: `must be exactly 32 bytes base64-encoded for AES-256-GCM (got ${keyBytes.length}). Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      });
    }

    if (value.QUEUE_DRIVER === 'redis' && value.REDIS_URL.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'required when QUEUE_DRIVER=redis',
      });
    }
    if (value.CACHE_DRIVER === 'redis' && value.REDIS_URL.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'required when CACHE_DRIVER=redis',
      });
    }

    if (value.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (value[key].length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'required when STORAGE_DRIVER=s3',
          });
        }
      }
    }

    if (value.EMAIL_DRIVER === 'smtp' && value.SMTP_HOST.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message: 'required when EMAIL_DRIVER=smtp',
      });
    }

    // --- Live-credential guard --------------------------------------------
    //
    // The single control that stands between a development machine and real
    // money. A live key moves actual funds from actual customers, so it may
    // only exist in a deployment that has declared itself production. Anywhere
    // else, the process refuses to start rather than starting and hoping
    // nobody triggers a payment.
    if (value.NODE_ENV !== 'production') {
      if (value.RAZORPAY_KEY_ID.startsWith('rzp_live_')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RAZORPAY_KEY_ID'],
          message:
            'refusing to start: this is a LIVE Razorpay key and NODE_ENV is not production. ' +
            'Live keys move real money. Use a rzp_test_ key for development.',
        });
      }

      if (value.STRIPE_SECRET_KEY.startsWith('sk_live_')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_SECRET_KEY'],
          message:
            'refusing to start: this is a LIVE Stripe key and NODE_ENV is not production. ' +
            'Live keys move real money. Use a sk_test_ key for development.',
        });
      }
    }

    // The mirror of the rule above: production must not run on test keys, or
    // customers appear to pay and no money is ever collected.
    if (value.NODE_ENV === 'production' && value.RAZORPAY_KEY_ID.startsWith('rzp_test_')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RAZORPAY_KEY_ID'],
        message:
          'this is a TEST Razorpay key and NODE_ENV is production. Test keys never collect money.',
      });
    }

    // Production-only guards. These are the settings that look harmless in dev
    // and are outright dangerous once real customers and money are involved.
    if (value.NODE_ENV === 'production') {
      if (!value.COOKIE_SECURE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['COOKIE_SECURE'],
          message: 'must be true in production',
        });
      }
      if (value.EMAIL_DRIVER === 'log') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_DRIVER'],
          message: 'the log driver does not deliver mail; configure smtp in production',
        });
      }
      if (value.STORAGE_DRIVER === 'local') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STORAGE_DRIVER'],
          message: 'local disk storage is not durable; configure s3 in production',
        });
      }
      for (const key of [
        'SESSION_COOKIE_SECRET',
        'ACCESS_TOKEN_SECRET',
        'REFRESH_TOKEN_SECRET',
      ] as const) {
        if (value[key].startsWith('replace-with')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'still holds the .env.example placeholder',
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    // Deliberately process.stderr rather than the logger: the logger itself
    // depends on this module, so it does not exist yet at this point.
    process.stderr.write(
      `\nInvalid environment configuration:\n${lines.join('\n')}\n\n` +
        `Copy .env.example to .env and fill the required values.\n\n`,
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

/** Exact CORS allowlist. Admin and customer origins, no wildcards. */
export const allowedOrigins: readonly string[] = Object.freeze([
  ...env.ADMIN_WEB_ORIGIN,
  ...env.CUSTOMER_WEB_ORIGIN,
]);

/** Decoded AES-256-GCM key. Validated to 32 bytes above. */
export const secretsEncryptionKey: Buffer = Buffer.from(env.SECRETS_ENCRYPTION_KEY, 'base64');
