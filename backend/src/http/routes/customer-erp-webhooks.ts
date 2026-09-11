/**
 * Where a BUYER's own ERP pushes to us.
 *
 * Unauthenticated in the session sense, because the caller is a machine in
 * somebody else's data centre that has no session and never will. What stands
 * in for authentication is in `webhook.service.ts`: an HMAC-SHA256 signature
 * over the exact bytes received, a signed timestamp inside a replay window, and
 * an unguessable path segment so the endpoint cannot be found by iterating ids.
 * There is no unsigned mode.
 *
 * Three things about this route are load-bearing rather than incidental.
 *
 *   1. **The raw body is what is verified.** This path is registered in
 *      `RAW_BODY_ROUTES` so `request.rawBody` holds the exact bytes. Verifying
 *      a re-serialised object fails for every honest sender - key order and
 *      whitespace change on a JSON round trip - and the usual "fix" for that is
 *      to stop verifying.
 *
 *   2. **Rate limiting is generous, not tight.** Throttling a webhook into
 *      failure causes the very inconsistency the webhook exists to prevent: the
 *      ERP gives up, and the two systems disagree about stock until the next
 *      poll. The cap is high enough to be a flood defence and no lower.
 *
 *   3. **A duplicate is a 200.** An ERP redelivering something it already sent
 *      has done nothing wrong. Answering with a 4xx makes it retry harder and
 *      eventually makes somebody switch the integration off.
 *
 * This is a separate route from `erp-webhooks.ts`, which is where the
 * OPERATOR's ERP pushes stock. Same shape, different owner, different table,
 * different secret - and combining them would mean one endpoint whose meaning
 * depended on which of two slug tables happened to match.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { notFound } from '../../domain/errors.js';
import { logger } from '../../infra/logger.js';
import { receiveWebhook } from '../../modules/customer-erp/webhook.service.js';

/**
 * The slug is base64url from 24 random bytes: 32 characters of `[A-Za-z0-9_-]`.
 * Bounded here so a request with a megabyte path never reaches a query.
 */
const slugParam = z.object({
  slug: z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export function registerCustomerErpWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/erp-inbound/:slug',
    {
      config: {
        // See note 2 in the header.
        rateLimit: { max: 600, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      // 404, not 403. A disabled feature should not confirm that this endpoint
      // would otherwise exist.
      if (!env.FEATURE_CUSTOMER_ERP) throw notFound('That endpoint');

      const { slug } = slugParam.parse(request.params);

      const rawBody = request.rawBody;

      if (rawBody === undefined) {
        // A configuration fault on our side, not the sender's: this path is
        // missing from RAW_BODY_ROUTES. Logged loudly, because the alternative
        // is every delivery failing its signature check for a reason that
        // looks like the customer's.
        logger.error(
          { url: request.url },
          'a buyer ERP webhook arrived without its raw body; check RAW_BODY_ROUTES',
        );

        throw notFound('That endpoint');
      }

      const result = await receiveWebhook({
        slug,
        rawBody: rawBody.toString('utf8'),
        headers: request.headers,
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      // 200 for a fresh delivery and for a redelivery alike. The body says
      // which, for an ERP whose delivery log a person reads; nothing in it
      // discloses anything about the connection.
      return reply.status(200).send({
        received: true,
        duplicate: result.duplicate,
      });
    },
  );

  return Promise.resolve();
}
