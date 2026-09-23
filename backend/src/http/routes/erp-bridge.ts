/**
 * Where the Glovia Tally Bridge talks to this API.
 *
 * Mounted OUTSIDE every session guard, for the same reason the carrier and
 * payment webhooks are: an agent has no session, no cookie and no CSRF token,
 * and hanging these routes off a tree that assumes one is how the assumption
 * eventually gets quietly relaxed for everybody.
 *
 * WHAT AUTHENTICATES A CALLER HERE
 *
 * A bearer token issued by `redeemPairingCode`, verified by hash against
 * `seller_erp_bridge_devices` on EVERY request. No session, no cache, no
 * grace period - a revoked device stops working on its next call. The device
 * names its connection, the connection names its seller, and every query below
 * is scoped by that. There is no parameter anywhere in this file in which a
 * bridge could name a seller, a connection or another bridge's task, which is
 * what makes cross-tenant access impossible to express rather than merely
 * checked for.
 *
 * WHAT THE BRIDGE IS NOT TRUSTED TO SAY
 *
 * It runs on somebody else's computer. So it reports FACTS and never verdicts:
 * Tally's counters, not "this succeeded"; the companies it found open, not
 * "the connection is healthy". `completeTask` decides the first from the
 * counters and `decideConnectionState` decides the second from the facts. A
 * modified agent can mislead its own seller about their own Tally; it cannot
 * make an accounting event appear to have posted when it did not, and it
 * cannot reach another seller at all.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, forbidden } from '../../domain/errors.js';
import { sha256Hex } from '../../infra/crypto.js';
import {
  pollTasks,
  recordHeartbeat,
  submitTaskResult,
} from '../../modules/seller-erp/bridge.service.js';
import {
  authenticateBridge,
  recordPairingAttempt,
  redeemPairingCode,
  rotateBridgeToken,
  type AuthenticatedBridge,
} from '../../modules/seller-erp/pairing.service.js';

/**
 * The bearer token off the request, or a refusal.
 *
 * Refuses on a MISSING header the same way it refuses on a bad one - same
 * code, same wording. An agent that gets a distinguishable answer for "no
 * token" and "wrong token" learns nothing useful, and neither does anybody
 * probing the endpoint.
 */
function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;

  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw badRequest(
      ErrorCode.SELLER_ERP_BRIDGE_UNAUTHORISED,
      'This bridge is not authorised. Pair the machine again in the Seller Hub.',
      [{ code: 'UNAUTHORISED' }],
    );
  }

  return header.slice('Bearer '.length).trim();
}

export function registerErpBridgeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The feature gate, applied to every route including the reads.
   *
   * Unlike the seller-facing routes, which report `available: false` so the
   * screen can explain itself, an agent gets a flat refusal: there is no
   * person to explain anything to, and an endpoint that answers helpfully
   * while the feature is off is an endpoint worth probing.
   */
  const requireFeature = async (): Promise<void> => {
    if (!env.FEATURE_SELLER_ERP) {
      throw forbidden(ErrorCode.FEATURE_DISABLED, 'Not available.');
    }
    await Promise.resolve();
  };

  app.addHook('preHandler', requireFeature);

  const ipHashOf = (ip: string | undefined): string | null =>
    ip === undefined ? null : sha256Hex(`${env.SECRETS_ENCRYPTION_KEY}:${ip}`);

  const authenticate = async (request: FastifyRequest): Promise<AuthenticatedBridge> =>
    authenticateBridge(bearerToken(request));

  // --- Pairing ------------------------------------------------------------

  /**
   * Trade a pairing code for a token.
   *
   * The one route here with no bearer token, because the agent has no
   * credential yet - the CODE is the credential for this single call. What
   * makes that safe is in `redeemPairingCode`: minutes to live, single use,
   * attempt-capped, rate-limited at issue, and consumed by a conditional
   * update that two agents cannot both win.
   *
   * A failed redemption counts an attempt against the code AFTER the refusal
   * is decided, never before, so the timing of the response does not reveal
   * whether the code existed.
   */
  app.post('/tally-bridge/pair', async (request, reply) => {
    const body = z
      .object({
        code: z.string().trim().min(6).max(64),
        agentVersion: z.string().trim().max(32).nullable().optional(),
        osLabel: z.string().trim().max(64).nullable().optional(),
        /**
         * What the agent says its local Tally address is.
         *
         * RECORDED AND SHOWN BACK, never dialled. This API does not connect to
         * a seller's machine; the value exists so the seller can confirm on
         * screen that the agent found the right Tally, which is the commonest
         * thing to get wrong on a PC with two installations.
         */
        reportedTallyAddress: z.string().trim().max(255).nullable().optional(),
      })
      .parse(request.body);

    try {
      const result = await redeemPairingCode({
        code: body.code,
        agentVersion: body.agentVersion ?? null,
        osLabel: body.osLabel ?? null,
        reportedTallyAddress: body.reportedTallyAddress ?? null,
        ipHash: ipHashOf(request.ip),
        correlationId: request.correlationId,
      });

      return reply
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .status(201)
        .send(result);
    } catch (error) {
      // Counted only for a code of the right shape, and only against a row
      // that exists - see `recordPairingAttempt`. Deliberately after the
      // refusal, and deliberately not awaited in a way that changes the shape
      // of the failure.
      await recordPairingAttempt(body.code);
      throw error;
    }
  });

  /** Swap a live token for a fresh one. The agent does this on its own. */
  app.post('/tally-bridge/rotate-token', async (request, reply) => {
    const bridge = await authenticate(request);
    const rotated = await rotateBridgeToken(bridge);

    return reply
      .header('cache-control', 'no-store')
      .header('pragma', 'no-cache')
      .status(200)
      .send(rotated);
  });

  // --- The loop -----------------------------------------------------------

  /**
   * "I am still here."
   *
   * The only thing that makes CONNECTED possible, and the only thing whose
   * ABSENCE makes a connection go offline - nothing writes a row when a
   * heartbeat fails to arrive, so the freshness window is what notices.
   */
  app.post('/tally-bridge/heartbeat', async (request, reply) => {
    const bridge = await authenticate(request);

    const body = z
      .object({
        agentVersion: z.string().trim().max(32).nullable().optional(),
        osLabel: z.string().trim().max(64).nullable().optional(),
        reportedTallyAddress: z.string().trim().max(255).nullable().optional(),
        tallyReachable: z.boolean().nullable().optional(),
      })
      .parse(request.body ?? {});

    const result = await recordHeartbeat({
      bridge,
      agentVersion: body.agentVersion ?? null,
      osLabel: body.osLabel ?? null,
      reportedTallyAddress: body.reportedTallyAddress ?? null,
      tallyReachable: body.tallyReachable ?? null,
      ipHash: ipHashOf(request.ip),
    });

    return reply.header('cache-control', 'no-store').status(200).send(result);
  });

  /**
   * "What is there for me to do?"
   *
   * The connection comes from the TOKEN. There is no parameter here naming a
   * seller or a connection, which is the whole of the tenant isolation on this
   * endpoint - structural rather than checked.
   */
  app.post('/tally-bridge/tasks/claim', async (request, reply) => {
    const bridge = await authenticate(request);

    const body = z
      .object({ limit: z.number().int().min(1).max(50).default(5) })
      .parse(request.body ?? {});

    const result = await pollTasks({ bridge, limit: body.limit });

    return reply.header('cache-control', 'no-store').status(200).send(result);
  });

  /**
   * "Here is what Tally said."
   *
   * FACTS, not a verdict. `ok` is the agent's opinion and is necessary but not
   * sufficient: the counters below are what `completeTask` actually decides
   * on, because Tally answers HTTP 200 to a request it rejected completely and
   * an agent that trusted the status code would mark a month of vouchers
   * posted when none were.
   */
  app.post('/tally-bridge/tasks/result', async (request, reply) => {
    const bridge = await authenticate(request);

    const body = z
      .object({
        jobId: z.string().length(26),
        ok: z.boolean(),
        httpStatus: z.number().int().min(100).max(599).nullable().optional(),
        durationMs: z.number().int().min(0).max(3_600_000).nullable().optional(),
        errorCode: z.string().trim().max(64).nullable().optional(),
        /**
         * Already redacted by the agent and capped here again.
         *
         * Tally quotes the seller's own file paths in its errors, and this
         * string is read by a marketplace support desk. The agent strips them;
         * this is the second cap, because the first one runs on a machine we
         * do not control.
         */
        sanitizedError: z.string().trim().max(1000).nullable().optional(),
        requestHash: z.string().trim().length(64).nullable().optional(),
        responseHash: z.string().trim().length(64).nullable().optional(),

        tally: z
          .object({
            created: z.number().int().min(0).max(1_000_000).nullable().optional(),
            altered: z.number().int().min(0).max(1_000_000).nullable().optional(),
            deleted: z.number().int().min(0).max(1_000_000).nullable().optional(),
            ignored: z.number().int().min(0).max(1_000_000).nullable().optional(),
            errors: z.number().int().min(0).max(1_000_000).nullable().optional(),
            exceptions: z.number().int().min(0).max(1_000_000).nullable().optional(),
            lastVoucherId: z.string().trim().max(96).nullable().optional(),
          })
          .nullable()
          .optional(),

        voucherNumber: z.string().trim().max(64).nullable().optional(),
        masterName: z.string().trim().max(255).nullable().optional(),

        lineErrors: z
          .array(
            z.object({
              message: z.string().trim().max(300),
              lineNumber: z.number().int().min(0).max(100_000).nullable(),
              missingMaster: z.string().trim().max(255).nullable(),
            }),
          )
          .max(20)
          .optional(),

        companies: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(255),
              guid: z.string().trim().max(96).nullable().optional(),
              booksFrom: z.string().trim().max(32).nullable().optional(),
            }),
          )
          .max(50)
          .optional(),

        tallyVersion: z.string().trim().max(64).nullable().optional(),
        baseCurrency: z.string().trim().max(16).nullable().optional(),

        masters: z
          .array(
            z.object({
              entity: z.string().trim().max(48),
              rows: z
                .array(
                  z.object({
                    name: z.string().trim().min(1).max(255),
                    guid: z.string().trim().max(96).nullable().optional(),
                    parent: z.string().trim().max(255).nullable().optional(),
                    extra: z.record(z.string(), z.string().max(64)).optional(),
                  }),
                )
                .max(5000),
            }),
          )
          .max(20)
          .optional(),

        stock: z
          .array(
            z.object({
              stockItemName: z.string().trim().min(1).max(255),
              closingQuantity: z.number().int().min(0).max(100_000_000),
              unitName: z.string().trim().max(64).nullable().optional(),
            }),
          )
          .max(20_000)
          .optional(),
      })
      .parse(request.body);

    await submitTaskResult({ bridge, result: body });

    return reply.status(204).send();
  });

  return Promise.resolve();
}
