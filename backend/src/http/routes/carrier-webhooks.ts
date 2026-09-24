/**
 * Where carriers push tracking events to us.
 *
 * Unauthenticated by necessity - the caller is a machine with no session - and
 * authenticated in substance by an HMAC over the RAW body plus an unguessable
 * per-integration path. Mounted outside every guarded tree for that reason:
 * nothing here may sit behind the session guard, and mixing it in with routes
 * that do is how one eventually loses it.
 *
 * Exactly the same shape as `erp-webhooks.ts` and the payment webhooks, and
 * deliberately so. Three inbound machine-to-machine endpoints that each
 * invented their own verification would be three chances to get it wrong.
 *
 * THE RAW BODY
 *
 * `request.rawBody` is captured by the content-type parser in `app.ts` for
 * paths under this prefix. A signature verified against a re-serialised object
 * fails for every honest sender - key order and whitespace change on a JSON
 * round trip - and the usual "fix" for that is to stop verifying.
 *
 * THE RESPONSE
 *
 * 202 for anything accepted, INCLUDING a duplicate and including an event we
 * could not map. A carrier that gets a 5xx retries, and retrying is correct
 * for a transient fault and wrong for a code we will never understand - so
 * this endpoint is careful to tell the two apart and to answer 2xx whenever
 * the event has been safely recorded, whatever we then decided about it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode } from '../../domain/errors.js';
import { ingestCarrierWebhook } from '../../modules/logistics/carrier/webhook.service.js';

export function registerCarrierWebhookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Receive a tracking event pushed by a carrier and record it against the
   * matching shipment. Only accepted when the signature over the raw body
   * checks out; a duplicate or an event code nobody has mapped yet is still
   * answered as accepted, so the carrier does not keep retrying it.
   *
   * No session: the unguessable path token picks the integration, and the
   * HMAC authenticates the sender. Answers 404 while the logistics portal
   * feature is off.
   */
  app.post(
    '/carriers/:pathToken/webhook',
    {
      config: {
        /*
         * Generous, and still a limit.
         *
         * A busy carrier legitimately sends a burst when a hub scans a
         * trailer - several hundred parcels in a minute is ordinary. What this
         * stops is an unbounded flood against an endpoint that writes a row
         * per request.
         */
        rateLimit: { max: 2000, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      if (!env.FEATURE_LOGISTICS_PORTAL) {
        /*
         * A 404 rather than a 403.
         *
         * With the feature off there is no such endpoint, and saying
         * "forbidden" would confirm to anybody probing that this deployment
         * has carrier integrations it has not enabled.
         */
        return reply.status(404).send({
          error: {
            code: ErrorCode.NOT_FOUND,
            message: `Route ${request.method} ${request.url} does not exist.`,
            details: [],
            correlationId: request.correlationId,
          },
        });
      }

      const params = z
        .object({ pathToken: z.string().trim().min(16).max(64) })
        .parse(request.params);

      const rawBody = request.rawBody;

      if (rawBody === undefined) {
        /*
         * The raw body was not captured, which means this path is not in
         * `RAW_BODY_ROUTES` in `app.ts`. That is a deployment fault rather
         * than a caller fault, and it must NEVER fall through to verifying a
         * re-serialised object - so it refuses.
         */
        request.log.error(
          { url: request.url },
          'carrier webhook received without a raw body; check RAW_BODY_ROUTES',
        );

        return reply.status(500).send({
          error: {
            code: ErrorCode.INTERNAL_ERROR,
            message: 'This endpoint is misconfigured on the server.',
            details: [],
            correlationId: request.correlationId,
          },
        });
      }

      const outcome = await ingestCarrierWebhook({
        pathToken: params.pathToken,
        rawBody,
        headers: request.headers,
      });

      /*
       * What the carrier is told.
       *
       * Deliberately thin: whether we accepted it, and nothing about our
       * consignment. A carrier that could learn a UBOSS shipment id from a
       * webhook response could enumerate them by sending events for tracking
       * numbers it does not carry.
       */
      return reply.status(202).send({
        accepted: outcome.accepted,
        duplicate: outcome.duplicate,
        // True means "kept, flagged, and waiting for a person". Told to the
        // carrier because a carrier's integration team genuinely wants to know
        // that a code they added is not understood downstream.
        unmapped: outcome.unmapped,
      });
    },
  );

  return Promise.resolve();
}
