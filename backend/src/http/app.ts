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
import { mkdir } from 'node:fs/promises';
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
import { httpErrorsTotal, httpRequestDuration, httpRequestsTotal } from '../infra/metrics.js';
import { DatabaseRateLimitStore } from '../infra/database-rate-limit-store.js';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { localStorageRoot } from '../infra/storage/index.js';
import { authRoutes } from './routes/auth.js';
import {
  registerCustomerAccountRoutes,
  registerDataBundleDownloadRoute,
} from './routes/account.customer.js';
import { registerAdminPrivacyRoutes } from './routes/privacy.admin.js';
import { registerAdminVatRoutes } from './routes/vat.admin.js';
import { registerAdminGpsrRoutes } from './routes/gpsr.admin.js';
import { registerAdminCatalogRoutes } from './routes/catalog.admin.js';
import { registerAdminTranslationRoutes } from './routes/translations.admin.js';
import { registerCartRoutes } from './routes/cart.customer.js';
import { registerAdminCustomerRoutes } from './routes/customers.admin.js';
import { registerAdminDirectoryRoutes } from './routes/directory.admin.js';
import { registerAdminInventoryRoutes } from './routes/inventory.admin.js';
import { registerAdminSettingsRoutes } from './routes/settings.admin.js';
import { registerAdminOrderRoutes, registerCustomerOrderRoutes } from './routes/orders.js';
import { registerCustomerPaymentMethodRoutes } from './routes/payment-methods.customer.js';
import { registerCustomerAutoPayRoutes } from './routes/autopay.customer.js';
import { registerAdminErpRoutes } from './routes/erp.admin.js';
import { registerErpWebhookRoutes } from './routes/erp-webhooks.js';
import { registerCustomerErpRoutes } from './routes/customer-erp.customer.js';
import { registerCustomerErpWebhookRoutes } from './routes/customer-erp-webhooks.js';
import { registerAdminCustomerErpRoutes } from './routes/customer-erp.admin.js';
import { registerAdminPaymentRoutes, registerPaymentRoutes } from './routes/payments.js';
import { registerAdminNotificationRoutes } from './routes/notifications.admin.js';
import { registerAdminReportRoutes, registerExportDownloadRoute } from './routes/reports.admin.js';
import { registerAdminScheduleRoutes, registerCustomerScheduleRoutes } from './routes/schedules.js';
import { registerPublicConfigRoutes } from './routes/config.public.js';
import { registerAssistantRoutes } from './routes/assistant.public.js';
import { registerAdminAssistantRoutes } from './routes/assistant.admin.js';
import { registerAdminCouponRoutes } from './routes/coupons.admin.js';
import { registerPublicCatalogRoutes } from './routes/catalog.public.js';
import { registerSitemapRoutes } from './routes/sitemap.public.js';
import { registerPublicDeliveryRoutes } from './routes/delivery.public.js';
import { registerPartnerInvitationRoutes } from './routes/partner-invitations.public.js';
import { registerCustomerFulfilmentRoutes } from './routes/fulfilment.customer.js';
import { registerHealthRoutes } from './routes/health.js';
import {
  registerSellerAccountRoutes,
  registerSellerEntryRoutes,
} from './routes/seller.account.js';
import { registerSellerListingRoutes } from './routes/seller.listings.js';
import { registerSellerOperationsRoutes } from './routes/seller.operations.js';
import { registerSellerErpRoutes } from './routes/seller.erp.js';
import { registerErpBridgeRoutes } from './routes/erp-bridge.js';
import { registerAdminSellerRoutes } from './routes/sellers.admin.js';
import { registerLogisticsPortalRoutes } from './routes/logistics.portal.js';
import { registerLogisticsOperationsRoutes } from './routes/logistics.operations.js';
import { registerLogisticsDriverRoutes } from './routes/logistics.driver.js';
import { registerAdminLogisticsRoutes } from './routes/logistics.admin.js';
import {
  registerAdminLogisticsLevelRoutes,
  registerCustomerLogisticsPricingRoutes,
  registerCustomerOrderBreakdownRoutes,
  registerLogisticsPortalLegRoutes,
} from './routes/logistics-levels.admin.js';
import { registerSellerLogisticsRoutes } from './routes/seller.logistics.js';
import { registerSellerPreorderRoutes } from './routes/seller.preorders.js';
import { registerPreorderRoutes } from './routes/preorders.js';
import { registerAdminPreorderRoutes } from './routes/preorders.admin.js';
import { registerSellerDocumentRoutes } from './routes/seller.documents.js';
import { registerSellerQuantityTierRoutes } from './routes/seller.quantity-tiers.js';
import { registerBulkPricingRoutes } from './routes/bulk-pricing.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerAdminDocumentRoutes } from './routes/documents.admin.js';
import { registerCarrierWebhookRoutes } from './routes/carrier-webhooks.js';
import { resolveHost } from '../modules/seller/storefront.service.js';
import type { SellerStorefront } from '../modules/seller/storefront.service.js';

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
const RAW_BODY_ROUTES = [
  `${API_PREFIX}/payments/webhooks/`,
  // A customer's ERP signs the exact bytes it sent, so the exact bytes are what
  // `verifyWebhookSignature` is given. Verifying a re-serialised object fails
  // for every honest sender - key order and whitespace change on a JSON round
  // trip - and the usual "fix" for that is to stop verifying.
  `${API_PREFIX}/integrations/erp/webhooks/`,
  // And a BUYER's own ERP, for exactly the same reason. Its own prefix because
  // it is a separate feature with a separate owner and a separate secret - see
  // `customer-erp-webhooks.ts`.
  `${API_PREFIX}/erp-inbound/`,
  // A CARRIER signs the exact bytes it sent, like everybody else. Without this
  // prefix the handler receives no `rawBody` and refuses outright rather than
  // falling back to verifying a re-serialised object - see that route file.
  `${API_PREFIX}/integrations/carriers/`,
];

function shouldCaptureRawBody(url: string): boolean {
  return RAW_BODY_ROUTES.some((prefix) => url.startsWith(prefix));
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    /** Populated only for webhook routes. */
    rawBody?: Buffer;
    /**
     * The seller whose shop front this request came to, or null for the
     * operator's own.
     *
     * Set once per request from the HOST header, before any route runs — never
     * from a parameter, a query string or a cookie, because a shopper can set
     * all of those and this decides whose prices they are charged.
     */
    storefront: SellerStorefront | null;
  }
}

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    // Trust the proxy only in production, where one actually terminates TLS,
    // and trust exactly ONE address rather than `true`.
    //
    // `true` trusts the whole forwarded chain and takes its left-most entry as
    // `request.ip`. Every request here arrives from nginx on loopback - the
    // unit forces `API_HOST=127.0.0.1` and the upstream block names
    // `127.0.0.1:400x` - so `'loopback'` means that hop is trusted and nothing
    // else is: a header forged further out cannot extend the chain past it.
    // `'loopback'` rather than the literal address because it also covers `::1`,
    // which is what an upstream spelled `localhost` resolves to first. Paired
    // with `proxy_set_header X-Forwarded-For $remote_addr` in
    // deploy/nginx/snippets/uboss-proxy.conf, which discards the client's own
    // header before it ever reaches here.
    //
    // Both halves matter. Either alone closes the hole for the shipped
    // topology; both together survive somebody adding a second proxy and
    // forgetting one of them. Without them a client picks its own `request.ip`
    // and walks through the per-IP rate limit and the per-IP login lockout.
    //
    // Trusting the header in development would let a local client do the same,
    // so there it stays off.
    trustProxy: isProduction ? 'loopback' : false,
    bodyLimit: 1_048_576,
    // Fastify's default is 100 characters per route parameter, and a slug is a
    // route parameter. Product and category slugs are VARCHAR(255) and come
    // from the product name, so an imported medical line - "in-line arterial
    // blood sampling kit ... with 27G x 1.5 safety needle, blister pack" -
    // slugs past 100 easily. Over the default the router never reaches the
    // handler: it answers 414, and the shop shows "the server returned an
    // unexpected 414 response" on a product that is perfectly fine. 255 is the
    // column width, which is also what the slug routes validate against.
    //
    // Under `routerOptions` rather than at the top level: the top-level spelling
    // still works in Fastify 5 but warns, and goes away in 6.
    routerOptions: { maxParamLength: 255 },
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

  /*
   * --- 1a. Which shop this request is for --------------------------------
   *
   * Resolved once, from the HOST and nothing else, before any route runs. Every
   * public read that prices something asks `request.storefront` rather than
   * working it out for itself, because two places deciding whose shop this is
   * would eventually disagree — and the disagreement would be a shopper shown
   * one seller's price and charged another's.
   *
   * A subdomain under the configured domain that matches no approved seller is
   * refused here rather than falling through to the operator's catalogue. That
   * fall-through is the dangerous one: a mistyped or stale link would quietly
   * serve the operator's stock at the operator's prices under somebody else's
   * name.
   *
   * With `SELLER_STOREFRONT_DOMAIN` unset — the default, and every existing
   * deployment — this resolves to OPERATOR for everything and costs one string
   * comparison.
   */
  app.addHook('onRequest', async (request, reply) => {
    const resolution = await resolveHost(request.headers.host);

    if (resolution.kind === 'UNKNOWN') {
      await reply.status(404).send({
        error: {
          code: ErrorCode.NOT_FOUND,
          message: 'There is no shop at this address.',
          details: [],
          correlationId: request.correlationId,
        },
      });
      return;
    }

    request.storefront = resolution.kind === 'SELLER' ? resolution.seller : null;
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
    /*
     * The API serves JSON and locally-stored media, never HTML that runs
     * script.
     *
     * EVERY DIRECTIVE IS NAMED, INCLUDING THE ONES SET TO 'none'.
     *
     * Helmet MERGES what it is given with its own defaults, which are written
     * for a web page rather than for an API. Naming only `default-src`,
     * `img-src` and `frame-ancestors` left the real header carrying
     * `style-src 'self' https: 'unsafe-inline'`, `font-src 'self' https:
     * data:` and `script-src 'self'` — helmet's defaults, none of them
     * intended here, and none of them visible in this file. The header that
     * went out was materially broader than the one the code read as, which
     * is the whole failure mode: `default-src 'none'` looks absolute and is
     * overridden by every more specific default sitting underneath it.
     *
     * So the four a browser could otherwise be told to fetch are pinned to
     * 'none' explicitly. `useDefaults` stays on, because what it contributes
     * beyond these — `base-uri 'self'`, `form-action 'self'`,
     * `object-src 'none'`, `script-src-attr 'none'`,
     * `upgrade-insecure-requests` — is all wanted, and turning it off would
     * mean re-listing them here and losing whatever helmet adds next.
     *
     * `tests/integration/api-security-headers.test.ts` asserts the header on
     * a real response rather than trusting this comment, for exactly the
     * reason above.
     */
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        // Uploaded product media, served from this origin under
        // /media/products/ when STORAGE_DRIVER=local.
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        scriptSrc: ["'none'"],
        styleSrc: ["'none'"],
        fontSrc: ["'none'"],
        connectSrc: ["'none'"],
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
    store: DatabaseRateLimitStore,
    // A database failure must not silently remove brute-force protection.
    skipOnError: false,
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
          code: fastifyStatus === 413 ? ErrorCode.PAYLOAD_TOO_LARGE : ErrorCode.VALIDATION_FAILED,
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
  // The third audience. Same factory, same tokens, same rotation - a different
  // cookie jar and a different `users.type`, which is what stops a credential
  // minted here reaching the console or the storefront.
  await app.register(authRoutes('LOGISTICS'), { prefix: `${API_PREFIX}/logistics/auth` });

  // Public catalog: no auth. Every read is filtered by publicProductWhere().
  // Unauthenticated: the storefront needs branding and capability flags
  // before anybody signs in.
  await app.register(registerPublicConfigRoutes, { prefix: API_PREFIX });
  await app.register(registerPublicCatalogRoutes, { prefix: `${API_PREFIX}/catalog` });
  // The bulk-savings popover's figures. See `bulk-pricing.service.ts`.
  await app.register(registerBulkPricingRoutes, { prefix: `${API_PREFIX}/catalog` });
  // The sitemap. Unauthenticated because a sitemap has to be, and it discloses
  // nothing a visitor could not find by browsing: the same products, at the
  // same addresses, under the same visibility rules the catalogue uses.
  await app.register(registerSitemapRoutes, { prefix: API_PREFIX });
  // Where we deliver. Public for the same reason the catalogue is: a buyer
  // asks "can you get this to Belgium, and when" before they have an account,
  // and an answer that waits for a sign-in is an answer given too late.
  await app.register(registerPublicDeliveryRoutes, { prefix: `${API_PREFIX}/delivery` });
  /*
   * Public because the company being invited has no account here yet. See the
   * file's own header for why the token travels in the body.
   */
  await app.register(registerPartnerInvitationRoutes, {
    prefix: `${API_PREFIX}/partner-invitations`,
  });

  // NOT public, despite sitting outside the customer block below. The chat
  // widget used to be open to anyone, with a contact form standing in for a
  // sign-in; both routes are behind `requireCustomer` now. It keeps its own
  // prefix because the widget is storefront chrome rather than account
  // self-service, and every parameter of the provider call is still fixed
  // server-side so a signed-in caller cannot drive it as an open relay.
  await app.register(registerAssistantRoutes, { prefix: `${API_PREFIX}/assistant` });

  // The transcripts those conversations leave behind, and the contact details
  // the visitor gave before starting one. Staff only, behind assistant_chat.read.
  await app.register(registerAdminAssistantRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminCatalogRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminTranslationRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminCustomerRoutes, { prefix: `${API_PREFIX}/admin` });
  /*
   * Every company that reaches this marketplace, in one tree: who buys, who
   * sells, who carries, and which accounts belong to the same business. Read
   * only - see the route file. Registered beside customers because that is
   * where an operator looks for it.
   */
  await app.register(registerAdminDirectoryRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminInventoryRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminSettingsRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminCouponRoutes, { prefix: `${API_PREFIX}/admin` });

  // Customer self-service. Every handler derives the profile from the session,
  // so there is no id-taking endpoint to forget an ownership check on.
  await app.register(registerCustomerAccountRoutes, { prefix: `${API_PREFIX}/account` });
  await app.register(registerCartRoutes, { prefix: `${API_PREFIX}/cart` });

  // Which warehouse will send this order, when it arrives, and what it costs.
  //
  // Signed in, unlike /delivery/options above, and the difference is the
  // question rather than the caution: that one answers "do you reach Belgium"
  // from a country code before anybody has an account, and this one prices a
  // particular person's basket to a particular address of theirs and writes
  // down the offer. Both belong where they are.
  await app.register(registerCustomerFulfilmentRoutes, {
    prefix: `${API_PREFIX}/fulfilment`,
  });
  await app.register(registerCustomerOrderRoutes, { prefix: `${API_PREFIX}/orders` });
  await app.register(registerAdminOrderRoutes, { prefix: `${API_PREFIX}/admin` });

  // The webhook inside this tree is unauthenticated by design: its authority
  // is the signature over the raw body, captured in the content-type parser.
  await app.register(registerPaymentRoutes, { prefix: `${API_PREFIX}/payments` });
  await app.register(registerAdminPaymentRoutes, { prefix: `${API_PREFIX}/admin` });

  // Saved cards. Under /account rather than /payments because they belong to
  // the customer rather than to a transaction, and that is where the
  // storefront's own screens for them live.
  await app.register(registerCustomerPaymentMethodRoutes, {
    prefix: `${API_PREFIX}/account/payment-methods`,
  });

  // The customer's standing authority to be charged. Under /account for the
  // same reason as saved cards: it belongs to the buyer, and nobody can consent
  // on their behalf. The ERP it pays for is the business's - see below.
  await app.register(registerCustomerAutoPayRoutes, {
    prefix: `${API_PREFIX}/account/autopay`,
  });

  // Settings -> ERP. Administrator only, behind integration.read/write, which
  // only the Business Owner role holds. There is deliberately no customer
  // counterpart: a connection is a URL plus a credential this server then
  // calls, so creating one is limited to people already trusted with the
  // installation.
  await app.register(registerAdminErpRoutes, { prefix: `${API_PREFIX}/admin` });

  // Where the ERP pushes stock TO US. Unauthenticated by necessity - the caller
  // is a machine with no session - and authenticated in substance by an HMAC
  // over the raw body plus an unguessable per-connection path. Mounted outside
  // /admin for that reason: nothing here may sit behind the session guard, and
  // mixing it in with routes that do is how one eventually loses it.
  await app.register(registerErpWebhookRoutes, {
    prefix: `${API_PREFIX}/integrations`,
  });

  // A BUYER's own ERP. The other direction entirely from the block above: this
  // is a customer business connecting its own SAP, monday.com or in-house
  // system so that what it buys here appears there. Owned by a buyer
  // organisation rather than by this installation - see
  // `modules/customer-erp/organization.service.ts` for the tenant boundary.
  await app.register(registerCustomerErpRoutes, {
    prefix: `${API_PREFIX}/account/integrations/erp`,
  });

  // Where a BUYER's ERP pushes to us. Same reasoning as the operator webhook
  // above and a separate route for a separate owner: same shape, different
  // table, different secret. Mounted outside /account so nothing here can end
  // up behind the session guard by accident.
  await app.register(registerCustomerErpWebhookRoutes, { prefix: API_PREFIX });

  // Support monitoring for those connections. Read-only, and deliberately
  // returns no credential, no hint, no endpoint path and no request body - see
  // that file's header.
  await app.register(registerAdminCustomerErpRoutes, { prefix: `${API_PREFIX}/admin` });

  await app.register(registerCustomerScheduleRoutes, {
    prefix: `${API_PREFIX}/recurring-schedules`,
  });
  await app.register(registerAdminScheduleRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminReportRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminNotificationRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminPrivacyRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminVatRoutes, { prefix: `${API_PREFIX}/admin` });
  await app.register(registerAdminGpsrRoutes, { prefix: `${API_PREFIX}/admin` });

  /*
   * The Seller Hub.
   *
   * Two prefixes rather than one, because they need different guards and a
   * Fastify guard attaches per plugin scope. `/sellers` answers BEFORE a seller
   * organisation exists - it is where one is created, and where the storefront
   * header asks "does this account sell here?" - while everything under
   * `/seller` requires one and resolves it from the SESSION.
   *
   * There is no seller id in any path. That is not an oversight to be tidied
   * later: it is what makes cross-tenant access impossible to express rather
   * than merely checked for.
   */
  await app.register(registerSellerEntryRoutes, { prefix: `${API_PREFIX}/sellers` });
  await app.register(registerSellerAccountRoutes, { prefix: `${API_PREFIX}/seller` });
  await app.register(registerSellerListingRoutes, { prefix: `${API_PREFIX}/seller` });
  await app.register(registerSellerOperationsRoutes, { prefix: `${API_PREFIX}/seller` });
  // The seller's own accounting system. Under `/seller` like everything else
  // in the Hub, and resolved from the session - there is no seller id in any
  // of its paths, for the reason stated above.
  await app.register(registerSellerErpRoutes, { prefix: `${API_PREFIX}/seller` });
  // Seller Hub -> Logistics: the four delivery levels, their prices, the legs
  // of confirmed orders and the read-only settlement preview.
  await app.register(registerSellerLogisticsRoutes, { prefix: `${API_PREFIX}/seller` });
  // Seller Hub -> Orders -> Preorders, and the preorder terms on a listing.
  await app.register(registerSellerPreorderRoutes, { prefix: `${API_PREFIX}/seller` });
  // The buyer's side of bulk preorders, and the public eligibility check.
  await app.register(registerPreorderRoutes, { prefix: `${API_PREFIX}/preorders` });
  // The operator's side: read every preorder, and answer the ones on the
  // operator's own products (sellers' preorders stay read-only for staff).
  await app.register(registerAdminPreorderRoutes, { prefix: `${API_PREFIX}/admin` });
  // Seller invoices and packing lists: the seller's side, the buyer's and the
  // public check, and read-only for the operator.
  await app.register(registerSellerDocumentRoutes, { prefix: `${API_PREFIX}/seller` });
  await app.register(registerSellerQuantityTierRoutes, { prefix: `${API_PREFIX}/seller` });
  await app.register(registerDocumentRoutes, { prefix: `${API_PREFIX}/documents` });
  await app.register(registerAdminDocumentRoutes, { prefix: `${API_PREFIX}/admin` });

  /*
   * Where the Glovia Tally Bridge talks to us.
   *
   * Outside every session guard, alongside the carrier and ERP webhooks and
   * for the same reason: the caller is an agent on a seller's own machine with
   * no cookie, no session and no CSRF token. It authenticates with a bearer
   * token verified by hash on every request, and the token names the device,
   * which names the connection, which names the seller.
   *
   * Nothing here may sit behind the customer guard, and mixing it into a tree
   * that has one is how the guard eventually gets relaxed for everybody.
   */
  await app.register(registerErpBridgeRoutes, { prefix: `${API_PREFIX}/integrations` });

  // The operator's side of the marketplace: applications, listing moderation
  // and brand requests. Guarded by the ADMIN permission catalogue, never the
  // seller one - see `domain/seller-permissions.ts`.
  await app.register(registerAdminSellerRoutes, { prefix: `${API_PREFIX}/admin` });

  /*
   * The Logistics Partner Portal.
   *
   * A THIRD audience, not a section of either existing one. A carrier's
   * dispatcher is another company's employee: they must never reach a cart, an
   * order total, a price or a payment method, and the cheapest way to
   * guarantee that is for their credential not to be a customer credential at
   * all. Hence `authRoutes('LOGISTICS')` above and `requireLogistics` here.
   *
   * There is no partner id in any path. That is not an oversight to be tidied
   * later: it is what makes cross-carrier access impossible to express rather
   * than merely checked for - the same rule the Seller Hub follows.
   *
   * Three prefixes under one tree because they need different guards and a
   * Fastify guard attaches per plugin scope: the portal's own routes, the
   * operations desk, and the driver's phone - whose location endpoint is
   * authenticated by a device token rather than by a session.
   */
  await app.register(registerLogisticsPortalRoutes, { prefix: `${API_PREFIX}/logistics` });
  await app.register(registerLogisticsOperationsRoutes, { prefix: `${API_PREFIX}/logistics` });
  await app.register(registerLogisticsDriverRoutes, { prefix: `${API_PREFIX}/logistics` });

  // The marketplace's own authority over carriers. Guarded by the ADMIN
  // catalogue (`logistics.*`), never the logistics one - see
  // `domain/logistics-permissions.ts` for why the two are kept apart.
  await app.register(registerAdminLogisticsRoutes, { prefix: `${API_PREFIX}/admin` });
  // UBOSS-managed levels, legs, and the platform fee (finance permissions).
  await app.register(registerAdminLogisticsLevelRoutes, { prefix: `${API_PREFIX}/admin` });
  // The legs a delivery company holds, in its own portal.
  await app.register(registerLogisticsPortalLegRoutes, { prefix: `${API_PREFIX}/logistics` });
  // The buyer's delivery quote and an order's price breakdown.
  await app.register(registerCustomerLogisticsPricingRoutes, { prefix: `${API_PREFIX}/pricing` });
  await app.register(registerCustomerOrderBreakdownRoutes, { prefix: `${API_PREFIX}/orders` });

  // Where a CARRIER pushes tracking to us. Unauthenticated by necessity and
  // authenticated in substance by an HMAC over the raw body plus an
  // unguessable per-integration path. Mounted outside every guarded tree for
  // the same reason the ERP webhooks are: nothing here may sit behind the
  // session guard, and mixing it in with routes that do is how one eventually
  // loses it.
  await app.register(registerCarrierWebhookRoutes, { prefix: `${API_PREFIX}/integrations` });

  // Outside the admin tree: the hashed expiring token is the authorisation, so
  // a download link works from an email client without a session.
  await app.register(registerExportDownloadRoute, { prefix: `${API_PREFIX}/exports` });
  await app.register(registerDataBundleDownloadRoute, { prefix: `${API_PREFIX}/my-data` });

  // Local media, development only. Under STORAGE_DRIVER=s3 this is not mounted
  // and images are served by the object store instead.
  //
  // The mount is the PUBLIC prefix, not the storage root. Report exports and
  // Art. 15 personal-data bundles are written under `private/` and are read
  // back only through code that redeems a hashed, expiring token first; if the
  // root were mounted here, an unguessable path would be the only thing
  // between the open internet and one person's entire record.
  const mediaRoot = localStorageRoot();
  if (mediaRoot !== null) {
    // fastify-static refuses a root that does not exist, and on a fresh
    // checkout nothing has been uploaded yet.
    await mkdir(mediaRoot, { recursive: true });

    await app.register(fastifyStatic, {
      root: mediaRoot,
      prefix: '/media/products/',
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
