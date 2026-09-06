/**
 * Payment routes.
 *
 * The webhook endpoint is the security-critical one. It is deliberately
 * unauthenticated - the provider has no session - and its authority comes
 * entirely from the signature over the raw body. Three consequences:
 *
 *   - It is excluded from the CSRF check (no cookie is involved).
 *   - It reads `request.rawBody`, captured before JSON parsing in app.ts.
 *   - It answers 200 even when it rejects the event, so the provider stops
 *     retrying something we have deliberately refused. The rejection is
 *     recorded and alerted instead.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import {
  createPaymentLink,
  redeemPaymentLink,
  resolvePaymentLink,
  revokePaymentLink,
} from '../../modules/payments/payment-link.service.js';
import {
  availableGateways,
  createOrderPayment,
  getPaymentStatusForOrder,
  loadActiveProvider,
  processWebhook,
  reconcilePayment,
  testStoredConnection,
} from '../../modules/payments/payment.service.js';
import {
  createRefund,
  getRefundQuote,
  settleRefundedOrder,
} from '../../modules/payments/refund.service.js';
import { encryptSecret, maskSecret } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { AuditAction, recordAudit } from '../../modules/audit/audit.service.js';
import { currentUser, requireAdmin, requireCustomer } from '../plugins/auth.js';

/**
 * Customer-facing payment routes live under /payments/orders/:orderId.
 * The ADMIN ones live under /admin/orders/:id and must use that name - Fastify
 * treats the segment as one parameter, and two names for it would surface as
 * `:id|:orderId` in the route table and in any generated client.
 */
const orderParam = z.object({ orderId: z.string().length(26) });
const adminOrderParam = z.object({ id: z.string().length(26) });

export function registerPaymentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Provider webhook.
   *
   * Registered before the customer routes so no `preHandler` auth hook applies
   * to it.
   */
  app.post(
    '/webhooks/:provider',
    {
      // Generous, because a provider retry burst is legitimate traffic and
      // rate-limiting a webhook into failure causes the very inconsistency the
      // webhook exists to prevent.
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { provider } = z
        .object({ provider: z.enum(['razorpay', 'stripe']) })
        .parse(request.params);

      const rawBody = request.rawBody;

      if (rawBody === undefined || rawBody.length === 0) {
        // Without the raw bytes the signature cannot be checked, and a
        // re-serialised body would fail every time. Refuse rather than skip.
        logger.error(
          { provider, correlationId: request.correlationId },
          'webhook arrived without a raw body; signature cannot be verified',
        );
        return reply.status(400).send({
          error: {
            code: ErrorCode.WEBHOOK_PAYLOAD_INVALID,
            message: 'Request body is required.',
            details: [],
            correlationId: request.correlationId,
          },
        });
      }

      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }

      const result = await processWebhook(rawBody, headers, request.correlationId);

      // 200 in every case. A rejected event has been recorded and alerted;
      // making the provider retry it forever would achieve nothing.
      return reply.status(200).send({
        received: true,
        accepted: result.accepted,
        duplicate: result.duplicate,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      });
    },
  );

  /**
   * Open a payment link.
   *
   * Unauthenticated on purpose: the payer is Finance or an approver reading an
   * email, not a customer with an account. The token IS the authorisation, so
   * it is 32 bytes of CSPRNG output, single use and expiring.
   */
  app.get(
    '/links/:token',
    { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { token } = z.object({ token: z.string().min(16).max(512) }).parse(request.params);
      const resolved = await resolvePaymentLink(token);

      return reply.status(200).send({
        orderNumber: resolved.orderNumber,
        customerName: resolved.customerName,
        amount: resolved.amount,
        itemCount: resolved.itemCount,
        expiresAt: resolved.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/links/:token/pay',
    { config: { rateLimit: { max: 15, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { token } = z.object({ token: z.string().min(16).max(512) }).parse(request.params);
      const result = await redeemPaymentLink(token, request.correlationId);
      return reply.status(201).send(result);
    },
  );

  // --- Customer payment routes -------------------------------------------

  /**
   * Which gateways the storefront may offer, and which one to preselect.
   *
   * The checkout page needs this before an order exists, so it is not scoped
   * to one. It carries no secrets and no customer data - only which gateways
   * an operator has connected - but it stays behind the customer guard,
   * because how a shop is wired is not something a passer-by needs to know.
   */
  app.get('/gateways', { preHandler: requireCustomer }, async (_request, reply) => {
    return reply.status(200).send(await availableGateways());
  });

  app.post(
    '/orders/:orderId/session',
    {
      preHandler: requireCustomer,
      config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const auth = currentUser(request);
      const { orderId } = orderParam.parse(request.params);

      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
        throw badRequest(
          ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
          'Send an Idempotency-Key header with this request.',
          [{ field: 'Idempotency-Key', code: 'REQUIRED' }],
        );
      }

      /**
       * The customer's gateway pick, carried from checkout.
       *
       * Optional, and optional on purpose: a client that sends nothing still
       * gets the configured default, which is what every caller written before
       * this existed does. What it can never do is choose an *amount* - that
       * comes from the order and nowhere else.
       */
      const choice = z
        .object({
          provider: z.enum(['RAZORPAY', 'STRIPE']).optional(),
          method: z.enum(['ANY', 'UPI']).optional(),
        })
        .default({})
        .parse(request.body ?? {});

      const result = await createOrderPayment({
        orderId,
        customerProfileId: auth.customerProfileId ?? '',
        idempotencyKey: idempotencyKey.trim(),
        actorUserId: auth.id,
        correlationId: request.correlationId,
        ...(choice.provider === undefined ? {} : { preferredProvider: choice.provider }),
        ...(choice.method === undefined ? {} : { methodHint: choice.method }),
      });

      return reply.status(201).send(result);
    },
  );

  /**
   * Poll after returning from the provider UI.
   *
   * The client shows "Processing" until this reports the order confirmed. It
   * must never treat its own redirect as proof of payment - the webhook is the
   * authority, and this endpoint reports what the webhook established.
   */
  app.get(
    '/orders/:orderId/status',
    { preHandler: requireCustomer },
    async (request, reply) => {
      const auth = currentUser(request);
      const { orderId } = orderParam.parse(request.params);

      const status = await getPaymentStatusForOrder(orderId, auth.customerProfileId ?? '');
      return reply.status(200).send(status);
    },
  );

  /**
   * Ask the provider directly.
   *
   * For the case where the webhook has not arrived and the customer is still
   * waiting. Rate-limited because it costs a provider API call.
   */
  app.post(
    '/orders/:orderId/reconcile',
    {
      preHandler: requireCustomer,
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const auth = currentUser(request);
      const { orderId } = orderParam.parse(request.params);

      const transaction = await prisma.paymentTransaction.findFirst({
        where: { orderId, order: { customerProfileId: auth.customerProfileId ?? '' } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });

      if (transaction === null) throw notFound('Payment');

      const result = await reconcilePayment(transaction.id);
      return reply.status(200).send(result);
    },
  );

  return Promise.resolve();
}

// --- Admin payment routes -------------------------------------------------

export function registerAdminPaymentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/payments',
    { preHandler: requireAdmin(Permission.PAYMENT_READ) },
    async (request, reply) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          status: z
            .enum(['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED'])
            .optional(),
          orderId: z.string().length(26).optional(),
        })
        .parse(request.query);

      const where = {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.orderId !== undefined ? { orderId: query.orderId } : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.paymentTransaction.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          include: { order: { select: { orderNumber: true, customerProfileId: true } } },
        }),
        prisma.paymentTransaction.count({ where }),
      ]);

      return reply.status(200).send({
        payments: rows.map((row) => ({
          id: row.id,
          orderId: row.orderId,
          orderNumber: row.order.orderNumber,
          provider: row.provider,
          mode: row.mode,
          status: row.status,
          amountMinor: row.amountMinor.toString(),
          capturedMinor: row.capturedMinor.toString(),
          currency: row.currency,
          method: row.method,
          // Provider references are safe to show; signatures and secrets are not.
          providerOrderId: row.providerOrderId,
          providerPaymentId: row.providerPaymentId,
          failureCode: row.failureCode,
          failureMessage: row.failureMessage,
          reconciledAt: row.reconciledAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      });
    },
  );

  /**
   * Webhook health.
   *
   * Shows what arrived and what was refused, without ever exposing a signature
   * or a raw payload - those can contain provider references an operator has no
   * need to see in a list view.
   */
  app.get(
    '/payments/webhook-health',
    { preHandler: requireAdmin(Permission.PAYMENT_READ) },
    async (_request, reply) => {
      const [counts, recent] = await Promise.all([
        prisma.paymentEvent.groupBy({
          by: ['processingStatus'],
          _count: { _all: true },
        }),
        prisma.paymentEvent.findMany({
          orderBy: { receivedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            provider: true,
            eventType: true,
            signatureVerified: true,
            processingStatus: true,
            processingError: true,
            orderId: true,
            receivedAt: true,
            processedAt: true,
          },
        }),
      ]);

      return reply.status(200).send({
        summary: Object.fromEntries(
          counts.map((entry) => [entry.processingStatus, entry._count._all]),
        ),
        recent: recent.map((event) => ({
          ...event,
          receivedAt: event.receivedAt.toISOString(),
          processedAt: event.processedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  /**
   * Save gateway credentials.
   *
   * The secret arrives once, over HTTPS, and is AES-256-GCM encrypted with the
   * connection id as AAD before it touches the database. No endpoint ever
   * returns it - only a mask, which identifies which key is configured without
   * being usable.
   *
   * Saving always DEACTIVATES the connection. A key that has never been proven
   * against the provider must not start taking payments because someone typed
   * it correctly.
   */
  app.put(
    '/payments/connections',
    { preHandler: requireAdmin(Permission.PAYMENT_GATEWAY_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          provider: z.enum(['RAZORPAY', 'STRIPE']),
          mode: z.enum(['TEST', 'LIVE']),
          label: z.string().trim().min(1).max(128),
          keyId: z.string().trim().min(1).max(256),
          keySecret: z.string().trim().min(1).max(512),
          webhookSecret: z.string().trim().max(512).optional(),
        })
        .parse(request.body);

      // A live key filed under TEST would route real money through a sandbox
      // flow, and the reverse would collect nothing while looking like it did.
      const looksLive = body.keyId.includes('_live_');
      if (looksLive !== (body.mode === 'LIVE')) {
        throw badRequest(
          ErrorCode.VALIDATION_FAILED,
          looksLive
            ? 'That is a LIVE key but the mode is set to TEST.'
            : 'That is a TEST key but the mode is set to LIVE.',
          [{ field: 'keyId', code: 'MODE_MISMATCH' }],
        );
      }

      const auth = currentUser(request);

      const existing = await prisma.paymentProviderConnection.findUnique({
        where: { provider_mode: { provider: body.provider, mode: body.mode } },
        select: { id: true, isActive: true },
      });

      const connectionId = existing?.id ?? newId();
      const aad = `payment_connection:${connectionId}`;
      const credentialsEnc = encryptSecret(
        JSON.stringify({ keyId: body.keyId, keySecret: body.keySecret }),
        aad,
      );
      const webhookSecretEnc =
        body.webhookSecret === undefined ? null : encryptSecret(body.webhookSecret, aad);

      await prisma.paymentProviderConnection.upsert({
        where: { provider_mode: { provider: body.provider, mode: body.mode } },
        update: {
          label: body.label,
          credentialsEnc,
          webhookSecretEnc,
          credentialsMask: maskSecret(body.keyId),
          isActive: false,
          lastTestStatus: null,
          lastTestedAt: null,
        },
        create: {
          id: connectionId,
          provider: body.provider,
          mode: body.mode,
          label: body.label,
          credentialsEnc,
          webhookSecretEnc,
          credentialsMask: maskSecret(body.keyId),
          isActive: false,
          createdById: auth.id,
        },
      });

      await recordAudit({
        action: AuditAction.PAYMENT_GATEWAY_CONFIGURED,
        resourceType: 'payment_provider_connection',
        resourceId: connectionId,
        actorType: 'ADMIN',
        actorUserId: auth.id,
        actorEmail: auth.email,
        // The secret itself is redacted by the audit service; only the fact of
        // the change and the mask are recorded.
        after: {
          provider: body.provider,
          mode: body.mode,
          label: body.label,
          credentialsMask: maskSecret(body.keyId),
          deactivatedPendingTest: existing?.isActive ?? false,
        },
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({
        connectionId,
        provider: body.provider,
        mode: body.mode,
        credentialsMask: maskSecret(body.keyId),
        isActive: false,
        message: 'Saved. Run Test Connection before activating.',
      });
    },
  );

  /** Configured connections. Masks only - a secret never leaves the server. */
  app.get(
    '/payments/connections',
    { preHandler: requireAdmin(Permission.PAYMENT_READ) },
    async (_request, reply) => {
      const rows = await prisma.paymentProviderConnection.findMany({
        orderBy: [{ provider: 'asc' }, { mode: 'asc' }],
        select: {
          id: true,
          provider: true,
          mode: true,
          label: true,
          credentialsMask: true,
          webhookSecretEnc: true,
          isActive: true,
          lastTestedAt: true,
          lastTestStatus: true,
          lastTestMessage: true,
          createdAt: true,
        },
      });

      return reply.status(200).send({
        connections: rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          mode: row.mode,
          label: row.label,
          credentialsMask: row.credentialsMask,
          // Presence only. The ciphertext is not the UI's business.
          hasWebhookSecret: row.webhookSecretEnc !== null,
          isActive: row.isActive,
          lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
          lastTestStatus: row.lastTestStatus,
          lastTestMessage: row.lastTestMessage,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    },
  );

  /**
   * Test one saved connection.
   *
   * Activation reads `lastTestStatus`, which only this route writes, so an
   * administrator cannot activate credentials that have never proven
   * themselves against the provider.
   */
  app.post(
    '/payments/connections/:id/test',
    {
      preHandler: requireAdmin(Permission.PAYMENT_GATEWAY_WRITE),
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      const result = await testStoredConnection(id);
      const auth = currentUser(request);

      await recordAudit({
        action: AuditAction.PAYMENT_GATEWAY_CONFIGURED,
        resourceType: 'payment_provider_connection',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: auth.id,
        actorEmail: auth.email,
        after: { testResult: result.ok ? 'OK' : 'FAILED', message: result.message },
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      // 200 either way: the test ran and produced an answer. A failed gateway
      // handshake is a result to display, not a fault in this API.
      return reply.status(200).send(result);
    },
  );

  app.patch(
    '/payments/connections/:id/status',
    { preHandler: requireAdmin(Permission.PAYMENT_GATEWAY_WRITE) },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      const { active } = z.object({ active: z.boolean() }).parse(request.body);

      const connection = await prisma.paymentProviderConnection.findUnique({
        where: { id },
        select: {
          id: true,
          lastTestStatus: true,
          provider: true,
          mode: true,
          webhookSecretEnc: true,
        },
      });

      if (connection === null) throw notFound('Payment connection');

      if (active && connection.lastTestStatus !== 'OK') {
        throw badRequest(
          ErrorCode.CONNECTOR_TEST_FAILED,
          'Run a successful Test Connection before activating this gateway.',
          [{ field: 'active', code: 'TEST_REQUIRED' }],
        );
      }

      // An order is confirmed only by a signature-verified provider event, and
      // a signature cannot be verified without this secret. Activating without
      // one is the quietest possible failure: customers are charged by the
      // gateway, every delivery is rejected as unverified, and no order ever
      // leaves Pending Payment. Refusing here is the only place that catches
      // it before money moves.
      if (active && connection.webhookSecretEnc === null) {
        throw badRequest(
          ErrorCode.PAYMENT_PROVIDER_NOT_CONFIGURED,
          'Add the webhook signing secret before activating this gateway. ' +
            'Without it no payment can be verified, so no order would ever be confirmed.',
          [{ field: 'webhookSecret', code: 'REQUIRED' }],
        );
      }

      // Exactly one active connection. Two would make provider selection at
      // checkout arbitrary.
      if (active) {
        await prisma.paymentProviderConnection.updateMany({
          where: { id: { not: id } },
          data: { isActive: false },
        });
      }

      await prisma.paymentProviderConnection.update({
        where: { id },
        data: { isActive: active },
      });

      const auth = currentUser(request);

      await recordAudit({
        action: AuditAction.PAYMENT_GATEWAY_ACTIVATED,
        resourceType: 'payment_provider_connection',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: auth.id,
        actorEmail: auth.email,
        after: { provider: connection.provider, mode: connection.mode, isActive: active },
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ isActive: active });
    },
  );

  /** Prove the credentials work before an administrator activates them. */
  app.post(
    '/payments/test-connection',
    { preHandler: requireAdmin(Permission.PAYMENT_GATEWAY_WRITE) },
    async (_request, reply) => {
      const { provider } = await loadActiveProvider();
      const result = await provider.testConnection();

      return reply.status(result.ok ? 200 : 502).send({
        ok: result.ok,
        provider: provider.kind,
        mode: result.mode,
        message: result.message,
      });
    },
  );

  app.post(
    '/orders/:id/payment-links',
    {
      preHandler: requireAdmin(Permission.PAYMENT_LINK_CREATE),
      config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id: orderId } = adminOrderParam.parse(request.params);
      const body = z
        .object({
          recipientEmail: z.string().trim().max(320).email(),
          recipientName: z.string().max(255).nullable().optional(),
          expiryHours: z.number().int().min(1).max(8760).optional(),
        })
        .parse(request.body);

      const auth = currentUser(request);

      const result = await createPaymentLink({
        orderId,
        recipientEmail: body.recipientEmail,
        recipientName: body.recipientName ?? null,
        ...(body.expiryHours !== undefined ? { expiryHours: body.expiryHours } : {}),
        actorUserId: auth.id,
        actorEmail: auth.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      return reply.status(201).send({
        paymentLinkId: result.paymentLinkId,
        recipientEmail: result.recipientEmail,
        amount: result.amount,
        expiresAt: result.expiresAt.toISOString(),
        // The URL is deliberately NOT returned: it is a bearer credential and
        // belongs only in the recipient's inbox.
        sent: true,
      });
    },
  );

  app.delete(
    '/payment-links/:linkId',
    { preHandler: requireAdmin(Permission.PAYMENT_LINK_CREATE) },
    async (request, reply) => {
      const { linkId } = z.object({ linkId: z.string().length(26) }).parse(request.params);
      const body = z.object({ reason: z.string().trim().min(1).max(255) }).parse(request.body);
      const auth = currentUser(request);

      await revokePaymentLink(
        linkId,
        {
          userId: auth.id,
          email: auth.email,
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
        body.reason,
      );

      return reply.status(200).send({ revoked: true });
    },
  );

  /** What the refund dialog shows before anything is submitted. */
  app.get(
    '/orders/:id/refund-quote',
    { preHandler: requireAdmin(Permission.PAYMENT_READ) },
    async (request, reply) => {
      const { id: orderId } = adminOrderParam.parse(request.params);
      return reply.status(200).send(await getRefundQuote(orderId));
    },
  );

  app.post(
    '/orders/:id/refunds',
    {
      // Finance-only: an Order Manager can cancel but not refund (SOP 3).
      preHandler: requireAdmin(Permission.REFUND_CREATE),
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id: orderId } = adminOrderParam.parse(request.params);
      const body = z
        .object({
          amountMinor: z
            .string()
            .regex(/^\d+$/, 'Expected whole minor units, e.g. "117280".')
            .optional(),
          reason: z.string().trim().min(1).max(512),
        })
        .parse(request.body);

      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
        throw badRequest(
          ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
          'Send an Idempotency-Key header with this request.',
          [{ field: 'Idempotency-Key', code: 'REQUIRED' }],
        );
      }

      const auth = currentUser(request);

      const result = await createRefund({
        orderId,
        ...(body.amountMinor !== undefined ? { amountMinor: body.amountMinor } : {}),
        reason: body.reason,
        idempotencyKey: idempotencyKey.trim(),
        actorUserId: auth.id,
        actorEmail: auth.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      // A full refund on a cancelled or returned order closes it out.
      const settled = await settleRefundedOrder(orderId, {
        userId: auth.id,
        email: auth.email,
        permissions: auth.permissions,
      });

      return reply.status(201).send({ ...result, orderTransitioned: settled.transitioned });
    },
  );

  app.post(
    '/payments/:paymentId/reconcile',
    { preHandler: requireAdmin(Permission.PAYMENT_READ) },
    async (request, reply) => {
      const { paymentId } = z.object({ paymentId: z.string().length(26) }).parse(request.params);
      const result = await reconcilePayment(paymentId);
      return reply.status(200).send(result);
    },
  );

  return Promise.resolve();
}
