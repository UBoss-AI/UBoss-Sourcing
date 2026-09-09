/**
 * Where a customer's ERP pushes stock updates to us.
 *
 * The only unauthenticated route in this feature, and the one that most needs
 * explaining. Everything else on the Integrations surface sits behind a session
 * cookie; this cannot, because the caller is a machine in somebody else's data
 * centre that has no session and never will.
 *
 * What stands in for authentication:
 *
 *   **An HMAC-SHA256 signature over the exact bytes received.** Verified in
 *   constant time against a secret only the customer and this installation
 *   hold. There is no unsigned mode - a connection with no secret accepts
 *   nothing - because an unauthenticated endpoint that rewrites stock is not a
 *   feature.
 *
 *   **An unguessable path segment.** 32 bytes of CSPRNG per connection. Not a
 *   secret in itself; it keeps one customer's endpoint from being discovered by
 *   iterating ids, so an attacker cannot even begin without knowing where to
 *   aim.
 *
 * Three implementation details that are load-bearing rather than incidental:
 *
 *   1. **The RAW body is signed, so the raw body is what is verified.** This
 *      path is registered in `RAW_BODY_ROUTES`, so `request.rawBody` holds the
 *      exact bytes. Verifying a re-serialised object would fail for every
 *      honest sender - key order and whitespace change on a JSON round trip -
 *      and the usual "fix" for that is to stop verifying.
 *
 *   2. **Rate limiting is generous, not tight.** Throttling a webhook into
 *      failure causes the very inconsistency the webhook exists to prevent: the
 *      ERP gives up, and the two systems disagree about stock until the next
 *      poll. The cap is high enough to be a defence against a flood and no
 *      lower.
 *
 *   3. **A duplicate is a 200.** An ERP redelivering something it already sent
 *      has done nothing wrong. Answering it with a 4xx makes it retry harder,
 *      and eventually makes somebody switch the integration off.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { logger } from '../../infra/logger.js';
import { handleInventoryWebhook } from '../../modules/integrations/erp-inventory-sync.service.js';

/**
 * The slug is base64url from `generateToken(24)`: 32 characters of
 * `[A-Za-z0-9_-]`. Bounded here so a request with a megabyte path never reaches
 * a database query.
 */
const slugParam = z.object({
  slug: z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export function registerErpWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/erp/webhooks/:slug',
    {
      config: {
        // See note 2 in the header. High enough to be a flood defence, not so
        // low that an ERP catching up after an outage is refused.
        rateLimit: { max: 600, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      // 404, not 403. A disabled feature should not confirm that this endpoint
      // would otherwise exist.
      if (!env.FEATURE_ERP_INTEGRATION) throw notFound('That endpoint');

      const { slug } = slugParam.parse(request.params);

      const rawBody = request.rawBody;

      if (rawBody === undefined) {
        // A configuration fault on our side, not the sender's: this path is
        // missing from RAW_BODY_ROUTES. Logged loudly, because the alternative
        // is verifying a signature against bytes we reconstructed - which is
        // the mistake this whole comment block exists to prevent.
        logger.error(
          { path: request.url },
          'ERP webhook arrived without a raw body; the signature cannot be verified',
        );

        throw badRequest(
          ErrorCode.WEBHOOK_PAYLOAD_INVALID,
          'This request could not be verified.',
        );
      }

      const headers: Record<string, string | string[] | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name.toLowerCase()] = value;
      }

      const result = await handleInventoryWebhook({
        slug,
        rawBody,
        headers,
        correlationId: request.correlationId,
      });

      // 200 for an applied update and for a duplicate alike. See note 3.
      return reply.status(200).send({
        received: true,
        duplicate: result.duplicate,
        // Returned so the sender's own logs can be matched to ours when
        // somebody asks what happened to a particular delivery. It names a run,
        // not anything a caller could act on.
        runId: result.runId,
        message: result.message,
      });
    },
  );

  return Promise.resolve();
}
