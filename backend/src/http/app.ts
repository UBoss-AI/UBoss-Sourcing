/**
 * Fastify application assembly.
 *
 * Plugin order matters and is not arbitrary:
 *   1. Correlation id  - so every later hook and log line can reference it.
 *   2. Security headers - before anything can write a response.
 *   3. CORS            - exact allowlist, credentials enabled for cookies.
 *   4. Cookies         - required by the session layer.
 *   5. Rate limiting   - before route handlers do real work.
 *   6. Raw-body capture - webhooks must verify a signature over untouched bytes.
 *   7. Error handler   - single place that renders the error envelope. Must
 *                        precede routes; see the note at the registration site.
 *   8. Routes.
 */
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { CSRF_HEADER } from './plugins/auth.js';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { allowedOrigins, env, isProduction } from '../config/env.js';
import {
  AppError,
  ErrorCode,
  isAppError,
  tooManyRequests,
  type ErrorDetail,
} from '../domain/errors.js';
import { newId } from '../infra/ids.js';
import { logger } from '../infra/logger.js';
import {
  httpErrorsTotal,
  httpRequestDuration,
  httpRequestsTotal,
} from '../infra/metrics.js';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { localStorageRoot } from '../infra/storage/index.js';
import { authRoutes } from './routes/auth.js';
import { registerCustomerAccountRoutes } from './routes/account.customer.js';
import { registerAdminCatalogRoutes } from './routes/catalog.admin.js';
import { registerCartRoutes } from './routes/cart.customer.js';
import { registerAdminCustomerRoutes } from './routes/customers.admin.js';
import { registerAdminInventoryRoutes } from './routes/inventory.admin.js';
import { registerAdminSettingsRoutes } from './routes/settings.admin.js';
import {
  registerAdminOrderRoutes,
  registerCustomerOrderRoutes,
} from './routes/orders.js';
import {
  registerAdminPaymentRoutes,
  registerPaymentRoutes,
} from './routes/payments.js';
import {
  registerAdminReportRoutes,
  registerExportDownloadRoute,
} from './routes/reports.admin.js';
import {
  registerAdminScheduleRoutes,
  registerCustomerScheduleRoutes,
} from './routes/schedules.js';
import { registerPublicConfigRoutes } from './routes/config.public.js';
import { registerAdminCouponRoutes } from './routes/coupons.admin.js';
import { registerPublicCatalogRoutes } from './routes/catalog.public.js';
import { registerHealthRoutes } from './routes/health.js';

export const CORRELATION_HEADER = 'x-correlation-id';

/** Prefix every business route shares. Versioned from day one. */
export const API_PREFIX = '/api/v1';

/**
 * Webhook paths whose raw body must survive JSON parsing.
 *
 * Razorpay and Stripe both sign the exact bytes they sent. Verifying against a
 * re-serialised object is the classic mistake - key order and whitespace change
 * and every signature fails, or worse, someone "fixes" it by skipping
 * verification.
 */
const RAW_BODY_ROUTES = [`${API_PREFIX}/payments/webhooks/`];

function shouldCaptureRawBody(url: string): boolean {
  return RAW_BODY_ROUTES.some((prefix) => url.startsWith(prefix));
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    /** Populated only for webhook routes. */
    rawBody?: Buffer;
  }
}

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    // Trust the proxy only in production, where one actually terminates TLS.
    // Trusting it in development would let a local client spoof its own IP and
    // walk straight through the per-IP rate limits.
    trustProxy: isProduction,
    bodyLimit: 1_048_576,
    genReqId: (request) => {
      const supplied = request.headers[CORRELATION_HEADER];
      return typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 64
        ? supplied
        : newId();
    },
  });

  // --- 1. Correlation id ---------------------------------------------------
  app.addHook('onRequest', (request, reply, done) => {
    request.correlationId = String(request.id);
    reply.header(CORRELATION_HEADER, request.correlationId);
    done();
  });

  // --- 1b. Request metrics -------------------------------------------------
  //
  // The route label is the REGISTERED path (`/orders/:id`), never the URL. A
  // label carrying an order id would create a new time series per order and
  // take the metrics store down.
  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const status = String(reply.statusCode);
    const labels = { method: request.method, route, status };

    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);

    if (reply.statusCode >= 400) {
      httpErrorsTotal.inc({ ...labels, code: reply.statusCode >= 500 ? 'server' : 'client' });
    }

    done();
  });

  // --- 2. Security headers -------------------------------------------------
  await app.register(helmet, {
    // The API serves JSON and locally-stored media, never HTML that runs script.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  // --- 3. CORS -------------------------------------------------------------
  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and server-to-server calls arrive with no Origin header.
      if (origin === undefined) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    // CSRF_HEADER matters: without it the browser's preflight rejects every
    // state-changing request from the admin panel, and the double-submit check
    // never even runs.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      CSRF_HEADER,
      CORRELATION_HEADER,
    ],
    exposedHeaders: [CORRELATION_HEADER, 'RateLimit-Limit', 'RateLimit-Remaining'],
    maxAge: 86_400,
  });

  // --- 4. Cookies ----------------------------------------------------------
  await app.register(cookie, {
    secret: env.SESSION_COOKIE_SECRET,
    parseOptions: {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: env.COOKIE_SAME_SITE,
      path: '/',
      ...(env.COOKIE_DOMAIN.length > 0 ? { domain: env.COOKIE_DOMAIN } : {}),
    },
  });

  // --- 5. Rate limiting ----------------------------------------------------
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_GLOBAL_PER_MINUTE,
    timeWindow: '1 minute',
    // Health checks come from orchestrators on a fixed interval; counting them
    // would let a liveness probe exhaust a real client's budget.
    allowList: (request) => request.url.startsWith('/health'),
    keyGenerator: (request) => request.ip,
    // Must return an AppError, not a plain envelope object. The plugin hands
    // whatever this returns to Fastify's error handler; a plain object carries
    // no statusCode, so it falls through to the 500 branch and a rate-limited
    // caller is told the server broke instead of being told to slow down.
    errorResponseBuilder: (_request, context) =>
      tooManyRequests(`Too many requests. Retry in ${String(context.after)}.`),
  });

  // --- 6. Raw body for webhook signature verification ---------------------
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      if (shouldCaptureRawBody(request.url)) {
        request.rawBody = body;
      }

      if (body.length === 0) {
        done(null, undefined);
        return;
      }

      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch {
        done(
          new AppError({
            statusCode: 400,
            code: ErrorCode.VALIDATION_FAILED,
            message: 'Request body is not valid JSON.',
          }),
        );
      }
    },
  );

  // --- 6b. Multipart uploads ----------------------------------------------
  await app.register(multipart, {
    limits: {
      fileSize: env.UPLOAD_MAX_BYTES,
      // One file, few fields: a product image upload needs nothing more, and a
      // low ceiling keeps a malicious multipart body from exhausting memory.
      files: 1,
      fields: 10,
      parts: 20,
    },
  });

  // --- 7. Error handling ---------------------------------------------------
  //
  // MUST be registered BEFORE routes. `register` creates an encapsulated child
  // context that captures the parent's error handler at creation time, so a
  // handler set afterwards never reaches routes inside those children - their
  // errors fall through to Fastify's default serializer and lose the envelope,
  // the correlation id and the field-level details.
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: ErrorCode.NOT_FOUND,
        message: `Route ${request.method} ${request.url} does not exist.`,
        details: [],
        correlationId: request.correlationId,
      },
    });
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const correlationId = request.correlationId;

    // Zod failures become field-level details the frontends can attach to inputs.
    if (error instanceof ZodError) {
      const details: ErrorDetail[] = error.issues.map((issue) => ({
        field: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      }));

      request.log.info({ correlationId, details }, 'request validation failed');
      void reply.status(400).send({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'The request contains invalid data.',
          details,
          correlationId,
        },
      });
      return;
    }

    if (isAppError(error)) {
      const logPayload = {
        correlationId,
        code: error.code,
        statusCode: error.statusCode,
        ...(error.internalContext ?? {}),
      };

      // 4xx is a client mistake and belongs at info; 5xx is ours.
      if (error.statusCode >= 500) {
        request.log.error({ ...logPayload, err: error }, 'request failed');
      } else {
        request.log.info(logPayload, 'request rejected');
      }

      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          correlationId,
        },
      });
      return;
    }

    // Fastify's own errors (payload too large, bad content type, ...). These
    // carry a 4xx statusCode and a message that is safe to surface verbatim.
    const framework = error as Partial<FastifyError>;
    const fastifyStatus = typeof framework.statusCode === 'number' ? framework.statusCode : 500;

    if (fastifyStatus < 500) {
      request.log.info({ correlationId, err: error }, 'request rejected by framework');
      void reply.status(fastifyStatus).send({
        error: {
          code:
            fastifyStatus === 413 ? ErrorCode.PAYLOAD_TOO_LARGE : ErrorCode.VALIDATION_FAILED,
          message: framework.message ?? 'The request could not be processed.',
          details: [],
          correlationId,
        },
      });
      return;
    }

    // Anything unrecognised: log everything, disclose nothing. No stack trace,
    // no driver message, no SQL fragment reaches the client.
    request.log.error({ correlationId, err: error }, 'unhandled error');
    void reply.status(500).send({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred. Quote the correlation id when reporting this.',
        details: [],
        correlationId,
      },
    });
  });

  // --- 8. Routes -----------------------------------------------------------
  await app.register(registerHealthRoutes);

  // The two surfaces are registered from one factory under separate prefixes.
  // `kind` is fixed at registration, so an admin credential presented to the
  // customer endpoint (or the reverse) fails before the password is compared.
  await app.register(authRoutes('ADMIN'), { prefix: `${API_PREFIX}/admin/auth` });
  await app.register(authRoutes('CUSTOMER'), { prefix: `${API_PREFIX}/auth` });

  // Public catalog: no auth. Every read is filtered by publicProductWhere().
  // Unauthenticated: the storefront needs branding and capability flags
  // before anybody signs in.
  await app.register(registerPublicConfigRoutes, { prefix: API_PREFIX });
  await app.register(registerPublicCatalogRoutes, { prefix: `${API_PREFIX}/catalog` });
  await app.register(registerAdminCatalogRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminCustomerRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminInventoryRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminSettingsRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminCouponRoutes, { prefix: `${API_PREFIX}/admin` });

  // Customer self-service. Every handler derives the profile from the session,
  // so there is no id-taking endpoint to forget an ownership check on.
  await app.register(registerCustomerAccountRoutes, { prefix: `${API_PREFIX}/account` });
  await app.register(registerCartRoutes, { prefix: `${API_PREFIX}/cart` });
  await app.register(registerCustomerOrderRoutes, { prefix: `${API_PREFIX}/orders` });
  await app.register(registerAdminOrderRoutes, { prefix: `${API_PREFIX}/admin` });

  // The webhook inside this tree is unauthenticated by design: its authority
  // is the signature over the raw body, captured in the content-type parser.
  await app.register(registerPaymentRoutes, { prefix: `${API_PREFIX}/payments` });
  await app.register(registerAdminPaymentRoutes, { prefix: `${API_PREFIX}/admin` });

  await app.register(registerCustomerScheduleRoutes, {
    prefix: `${API_PREFIX}/recurring-schedules`,
  });
  await app.register(registerAdminScheduleRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminReportRoutes, { prefix: `${API_PREFIX}/admin` });

  // Outside the admin tree: the hashed expiring token is the authorisation, so
  // a download link works from an email client without a session.
  await app.register(registerExportDownloadRoute, { prefix: `${API_PREFIX}/exports` });

  // Local media, development only. Under STORAGE_DRIVER=s3 this is not mounted
  // and images are served by the object store instead.
  const mediaRoot = localStorageRoot();
  if (mediaRoot !== null) {
    await app.register(fastifyStatic, {
      root: mediaRoot,
      prefix: '/media/',
      // Uploaded bytes must never execute or render as a document in the
      // API's origin, whatever a browser decides to sniff them as.
      setHeaders: (response) => {
        response.header('Content-Disposition', 'inline');
        response.header('X-Content-Type-Options', 'nosniff');
        response.header('Content-Security-Policy', "default-src 'none'; sandbox");
      },
    });
  }

  return app;
}

/** The assembled application type, for callers that need to name it. */
export type App = Awaited<ReturnType<typeof buildApp>>;
