/**
 * Seller Hub -> Settings -> ERP Integrations -> TallyPrime.
 *
 * Every route here is guarded twice, and both guards are load-bearing:
 *
 *   - `requireSeller(INTEGRATION_READ | INTEGRATION_WRITE)` answers "may this
 *     PERSON do this kind of thing".
 *   - The service resolves the connection and checks it belongs to the
 *     membership on the session, which answers "to WHOSE books".
 *
 * Only the second one keeps sellers apart, which is why no route takes a
 * seller id: there is no parameter in which cross-tenant access could be
 * expressed, so there is nothing to validate and nothing to forget.
 *
 * The bridge's own endpoints are NOT here. They are in `erp-bridge.ts`,
 * mounted outside every session guard, because an agent has no session and
 * mixing the two trees is how one eventually loses the guard.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, forbidden } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { sha256Hex } from '../../infra/crypto.js';
import {
  createConnection,
  listCompanies,
  listConnections,
  readConnection,
  selectCompany,
  setConnectionEnabled,
  startConnectionTest,
} from '../../modules/seller-erp/connection.service.js';
import {
  cancelJob,
  enqueueErpEvent,
  listJobs,
  retryJob,
} from '../../modules/seller-erp/job.service.js';
import {
  assertMappingsComplete,
  listMappings,
  listMasters,
  missingMappings,
  saveMappings,
} from '../../modules/seller-erp/mapping.service.js';
import {
  issuePairingCode,
  listBridgeDevices,
  revokeBridgeDevice,
} from '../../modules/seller-erp/pairing.service.js';
import {
  readPolicy,
  setAutoCreateMasters,
  updatePolicy,
} from '../../modules/seller-erp/policy.service.js';
import { prisma } from '../../infra/prisma.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';

const idParam = z.object({ id: z.string().length(26) });

const mappingEntity = z.enum([
  'PARTY_LEDGER',
  'STOCK_ITEM',
  'GODOWN',
  'UNIT',
  'ALTERNATE_UNIT',
  'SALES_ORDER_VOUCHER_TYPE',
  'SALES_INVOICE_VOUCHER_TYPE',
  'RECEIPT_VOUCHER_TYPE',
  'CREDIT_NOTE_VOUCHER_TYPE',
  'SALES_LEDGER',
  'FREIGHT_LEDGER',
  'DISCOUNT_LEDGER',
  'COMMISSION_LEDGER',
  'GATEWAY_FEE_LEDGER',
  'ROUNDING_LEDGER',
  'TAX_LEDGER_CGST',
  'TAX_LEDGER_SGST',
  'TAX_LEDGER_IGST',
  'TAX_LEDGER_CESS',
  'TAX_LEDGER_OTHER',
  'COST_CENTRE',
  'CURRENCY',
]);

export function registerSellerErpRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSeller());

  /**
   * The feature gate.
   *
   * On every WRITE and not on the reads, exactly as the buyer's ERP routes do
   * it. A seller whose marketplace has switched the feature off should see
   * that it is off - an empty list and a flag - rather than a 403 the screen
   * has to guess the meaning of.
   */
  const requireFeature = async (): Promise<void> => {
    if (!env.FEATURE_SELLER_ERP) {
      throw forbidden(
        ErrorCode.FEATURE_DISABLED,
        'Connecting your own accounting system is not switched on for this marketplace.',
      );
    }
    await Promise.resolve();
  };

  /**
   * A salted hash of the caller's address, for the audit trail.
   *
   * The hash and never the address. A pairing or a revocation is worth being
   * able to place, and an office IP sitting in a table the support desk reads
   * is personal data held for no proportionate reason. Salted with the
   * deployment's own secret so the same address does not hash alike across
   * installations.
   */
  const ipHashOf = (ip: string | undefined): string | null =>
    ip === undefined ? null : sha256Hex(`${env.SECRETS_ENCRYPTION_KEY}:${ip}`);

  // --- Connections --------------------------------------------------------

  /**
   * The seller's TallyPrime connections, with whether the feature is switched
   * on for this marketplace. When it is off the list is empty and the flag says so.
   */
  app.get(
    '/erp/connections',
    { preHandler: requireSeller(SellerPermission.INTEGRATION_READ) },
    async (request, reply) => {
      const connections = env.FEATURE_SELLER_ERP
        ? await listConnections(currentSeller(request))
        : [];

      return reply.header('cache-control', 'no-store').status(200).send({
        available: env.FEATURE_SELLER_ERP,
        // The bridge's download page and the direct-mode availability, so the
        // wizard can say what this deployment actually offers rather than
        // showing a step nobody here can complete.
        directModeAllowed: env.SELLER_ERP_ALLOW_DIRECT_MODE,
        connections,
      });
    },
  );

  /**
   * Create a new TallyPrime connection for the seller. It starts with nothing
   * switched on: no company chosen and nothing posted to the seller's accounts
   * until each step is set up.
   */
  app.post(
    '/erp/connections',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(128),
          networkMode: z.enum(['BRIDGE', 'DIRECT_PRIVATE']).default('BRIDGE'),
          directBaseUrl: z.string().trim().max(1024).nullable().optional(),
        })
        .parse(request.body);

      const connection = await createConnection({
        membership: currentSeller(request),
        body,
        actorUserId: request.auth?.id ?? null,
        ipHash: ipHashOf(request.ip),
        correlationId: request.correlationId,
      });

      return reply.status(201).send(connection);
    },
  );

  /** One of the seller's TallyPrime connections, with its current state worked out fresh. */
  app.get(
    '/erp/connections/:id',
    { preHandler: requireSeller(SellerPermission.INTEGRATION_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const connection = await readConnection(currentSeller(request), params.id);
      return reply.header('cache-control', 'no-store').status(200).send(connection);
    },
  );

  /**
   * Switch a connection off or back on. Off stops all sending and the paired
   * computer's access; settings, history and queued work are kept for when it
   * is switched back on.
   */
  app.post(
    '/erp/connections/:id/enabled',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ enabled: z.boolean() }).parse(request.body);

      const connection = await setConnectionEnabled({
        membership: currentSeller(request),
        connectionId: params.id,
        enabled: body.enabled,
        actorUserId: request.auth?.id ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(200).send(connection);
    },
  );

  // --- Pairing ------------------------------------------------------------

  /**
   * Generate a pairing code.
   *
   * The ONLY response that ever carries the code. It is not stored in
   * plaintext, not returned by any read, and not recoverable - a seller who
   * loses it generates another, which costs nothing and is safer than any
   * mechanism for showing it twice.
   *
   * `no-store` matters more here than anywhere else in this file: a proxy
   * caching this response caches a live credential.
   */
  app.post(
    '/erp/connections/:id/pairing-codes',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ deviceLabel: z.string().trim().min(1).max(120) }).parse(request.body);

      const issued = await issuePairingCode({
        membership: currentSeller(request),
        connectionId: params.id,
        deviceLabel: body.deviceLabel,
        actorUserId: request.auth?.id ?? null,
        ipHash: ipHashOf(request.ip),
        correlationId: request.correlationId,
      });

      return reply
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .status(201)
        .send(issued);
    },
  );

  /** Every computer ever paired to this connection, newest first, and whether each is currently online. */
  app.get(
    '/erp/connections/:id/devices',
    { preHandler: requireSeller(SellerPermission.INTEGRATION_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const devices = await listBridgeDevices(currentSeller(request), params.id);
      return reply.header('cache-control', 'no-store').status(200).send({ devices });
    },
  );

  /**
   * Remove a paired computer's access immediately, for example after a laptop
   * is lost. Work it had picked up is handed back for another paired computer.
   * Recorded in the connection's security trail.
   */
  app.post(
    '/erp/devices/:id/revoke',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({ reason: z.string().trim().max(255).nullable().optional() })
        .parse(request.body ?? {});

      await revokeBridgeDevice({
        membership: currentSeller(request),
        deviceId: params.id,
        reason: body.reason ?? null,
        actorUserId: request.auth?.id ?? null,
        ipHash: ipHashOf(request.ip),
        correlationId: request.correlationId,
      });

      return reply.status(204).send();
    },
  );

  // --- Testing and the company --------------------------------------------

  /**
   * Ask the bridge to test the connection.
   *
   * 202, not 200, and the distinction is honest rather than pedantic: the
   * bridge PULLS work, so nothing has been tested when this returns. The
   * screen polls the connection until `lastTestAt` moves.
   */
  app.post(
    '/erp/connections/:id/test',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);

      const result = await startConnectionTest({
        membership: currentSeller(request),
        connectionId: params.id,
        actorUserId: request.auth?.id ?? null,
      });

      return reply.status(202).send(result);
    },
  );

  /** The Tally companies the last connection test found open, to choose from. */
  app.get(
    '/erp/connections/:id/companies',
    { preHandler: requireSeller(SellerPermission.INTEGRATION_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const companies = await listCompanies(currentSeller(request), params.id);
      return reply.status(200).send({ companies });
    },
  );

  /**
   * Choose which Tally company this connection posts into. Only a company the
   * last test actually found is accepted; a typed-in name is refused.
   */
  app.post(
    '/erp/connections/:id/company',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ companyName: z.string().trim().min(1).max(255) }).parse(request.body);

      const connection = await selectCompany({
        membership: currentSeller(request),
        connectionId: params.id,
        companyName: body.companyName,
        actorUserId: request.auth?.id ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(200).send(connection);
    },
  );

  // --- Mapping ------------------------------------------------------------

  /**
   * How the seller's products, buyers, taxes and so on are matched to names in
   * Tally, plus the matches the seller's settings still need before syncing.
   */
  app.get(
    '/erp/connections/:id/mappings',
    { preHandler: requireSeller(SellerPermission.INTEGRATION_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const membership = currentSeller(request);

      const [mappings, missing] = await Promise.all([
        listMappings(membership, params.id),
        missingMappings(params.id),
      ]);

      return reply.status(200).send({ mappings, missing });
    },
  );

  /**
   * Save up to 500 matches between the seller's records and names in Tally.
   * They are saved all together or not at all.
   */
  app.put(
    '/erp/connections/:id/mappings',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);

      const body = z
        .object({
          mappings: z
            .array(
              z.object({
                entity: mappingEntity,
                localKey: z.string().trim().max(64).optional(),
                localLabel: z.string().trim().max(255).nullable().optional(),
                tallyName: z.string().trim().min(1).max(255),
                tallyGuid: z.string().trim().max(96).nullable().optional(),
                alternateUnitName: z.string().trim().max(64).nullable().optional(),
                // A STRING, so the decimal is parsed exactly. A conversion
                // factor crossing as a JS number multiplies a quantity on an
                // accounting document by an approximation.
                conversionFactor: z.string().trim().max(24).nullable().optional(),
                isConfirmed: z.boolean().optional(),
              }),
            )
            .min(1)
            .max(500),
        })
        .parse(request.body);

      const mappings = await saveMappings({
        membership: currentSeller(request),
        connectionId: params.id,
        mappings: body.mappings,
        actorUserId: request.auth?.id ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ mappings });
    },
  );

  /** The picker's options - what the last master pull found in Tally. */
  app.get(
    '/erp/connections/:id/masters',
    { preHandler: requireSeller(SellerPermission.INTEGRATION_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const query = z
        .object({
          entity: mappingEntity,
          search: z.string().trim().max(120).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(request.query);

      const masters = await listMasters({
        membership: currentSeller(request),
        connectionId: params.id,
        entity: query.entity,
        search: query.search ?? null,
        limit: query.limit,
      });

      return reply.status(200).send({ masters });
    },
  );

  /** Ask the bridge to re-read the master lists out of Tally. */
  app.post(
    '/erp/connections/:id/masters/refresh',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const membership = currentSeller(request);

      // Ownership is established by reading it through the guarded service
      // before anything is queued against the id.
      const connection = await readConnection(membership, params.id);

      const jobId = await enqueueErpEvent({
        connectionId: connection.id,
        sellerAccountId: membership.sellerAccountId,
        eventType: 'MASTER_PULL',
        sourceEntityType: 'seller_erp_connection',
        sourceEntityId: connection.id,
        payload: { kind: 'MASTER_PULL', companyName: connection.companyName },
        trigger: 'MANUAL',
        // A read, asked for again, is a NEW question - see the same reasoning
        // on the connection test.
        discriminator: String(Date.now()),
        maxAttempts: 1,
        correlationId: request.correlationId,
      });

      return reply.status(202).send({ jobId });
    },
  );

  // --- Policy -------------------------------------------------------------

  /** What this connection sends to Tally (orders, invoices, receipts, credit notes), how cancellations and stock are handled, and its retry settings. */
  app.get(
    '/erp/connections/:id/policy',
    { preHandler: requireSeller(SellerPermission.INTEGRATION_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const policy = await readPolicy(currentSeller(request), params.id);
      return reply.status(200).send(policy);
    },
  );

  /**
   * Change some of this connection's sync settings. Only the fields sent are
   * changed, and each change is recorded with its previous value.
   */
  app.patch(
    '/erp/connections/:id/policy',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);

      const body = z
        .object({
          postSalesOrder: z.boolean().optional(),
          postSalesInvoice: z.boolean().optional(),
          invoiceOnDispatch: z.boolean().optional(),
          postReceipt: z.boolean().optional(),
          postCreditNote: z.boolean().optional(),
          cancellationMode: z.enum(['CREDIT_NOTE', 'MARK_CANCELLED', 'MANUAL']).optional(),
          syncStockItems: z.boolean().optional(),
          syncPartyLedgers: z.boolean().optional(),
          syncGodowns: z.boolean().optional(),
          inventoryAuthority: z.enum(['GLOVIA', 'TALLY', 'MANUAL', 'DISABLED']).optional(),
          inventoryPollMinutes: z.number().int().min(5).max(10_080).nullable().optional(),
          includePackagingNarration: z.boolean().optional(),
          narrationTemplate: z.string().max(512).nullable().optional(),
          maxAttempts: z.number().int().min(1).max(50).optional(),
          retryBaseSeconds: z.number().int().min(1).max(3600).optional(),
        })
        .parse(request.body);

      const policy = await updatePolicy({
        membership: currentSeller(request),
        connectionId: params.id,
        patch: body,
        actorUserId: request.auth?.id ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(200).send(policy);
    },
  );

  /**
   * Whether we may create masters in their chart of accounts unprompted.
   *
   * Its own endpoint rather than a field on the policy patch, because it is
   * the one setting that lets this software WRITE TO SOMEBODY'S CHART OF
   * ACCOUNTS without being asked each time - and a decision like that deserves
   * its own request and its own audit line rather than riding along with
   * fourteen checkboxes.
   */
  app.post(
    '/erp/connections/:id/auto-create-masters',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ enabled: z.boolean() }).parse(request.body);

      await setAutoCreateMasters({
        membership: currentSeller(request),
        connectionId: params.id,
        enabled: body.enabled,
        actorUserId: request.auth?.id ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(204).send();
    },
  );

  // --- Validation and the first run ---------------------------------------

  /**
   * "Would a sync work right now?"
   *
   * Checks the mappings and reports, without posting anything. The step before
   * the initial sync, and the thing a seller presses when a job has failed and
   * they want to know whether they have fixed it.
   */
  app.post(
    '/erp/connections/:id/validate',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const membership = currentSeller(request);

      const connection = await readConnection(membership, params.id);
      const missing = await missingMappings(params.id);

      return reply.status(200).send({
        ok: missing.length === 0 && connection.state === 'CONNECTED',
        state: connection.state,
        stateReason: connection.stateReason,
        missing,
      });
    },
  );

  /**
   * The first sync.
   *
   * Refuses unless the mappings are complete - `assertMappingsComplete` names
   * each missing one, so the screen can list them and link to the row. That
   * refusal is the point: an initial sync is the one run that posts a great
   * deal at once, and running it half-mapped produces a pile of dead-lettered
   * jobs rather than a set of books.
   */
  app.post(
    '/erp/connections/:id/initial-sync',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const membership = currentSeller(request);

      const connection = await readConnection(membership, params.id);
      await assertMappingsComplete(params.id);

      await prisma.sellerErpConnection.update({
        where: { id: connection.id },
        data: { initialSyncStartedAt: new Date(), initialSyncCompletedAt: null },
      });

      /*
       * Every order group not yet posted, queued as its own job.
       *
       * Bounded, because a seller connecting after two years of trading has
       * thousands and queueing all of them would hand their PC a week of work
       * on the day they set it up. The bound is stated to them in the
       * response, and running it again picks up the next batch - which is a
       * more honest interaction than a progress bar over an unbounded job.
       */
      const groups = await prisma.sellerOrderGroup.findMany({
        where: {
          sellerAccountId: membership.sellerAccountId,
          status: { notIn: ['CANCELLED'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: { id: true, orderId: true },
      });

      let queued = 0;

      for (const group of groups) {
        const jobId = await enqueueErpEvent({
          connectionId: connection.id,
          sellerAccountId: membership.sellerAccountId,
          eventType: 'SALES_ORDER',
          sourceEntityType: 'seller_order_group',
          sourceEntityId: group.id,
          orderId: group.orderId,
          sellerOrderGroupId: group.id,
          // The payload is built by the dispatcher for a backfill, because
          // building five hundred of them inside one request would hold a
          // connection open for a minute. The event is what matters here.
          payload: { kind: 'ORDER_BACKFILL', sellerOrderGroupId: group.id },
          trigger: 'INITIAL',
          // Everything about one order stays in order behind one key.
          sequenceKey: group.orderId,
          correlationId: request.correlationId,
        });

        if (jobId !== null) queued += 1;
      }

      return reply.status(202).send({ queued, considered: groups.length });
    },
  );

  // --- History ------------------------------------------------------------

  /** The connection's sync jobs, page by page, optionally filtered by status. */
  app.get(
    '/erp/connections/:id/jobs',
    { preHandler: requireSeller(SellerPermission.INTEGRATION_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const query = z
        .object({
          status: z
            .enum([
              'PENDING',
              'IN_FLIGHT',
              'SUCCEEDED',
              'RETRY_SCHEDULED',
              'FAILED',
              'DEAD_LETTER',
              'CANCELLED',
              'BLOCKED',
            ])
            .nullable()
            .optional(),
          page: z.coerce.number().int().min(1).optional(),
          pageSize: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(request.query);

      const jobs = await listJobs({
        membership: currentSeller(request),
        connectionId: params.id,
        status: query.status ?? null,
        page: query.page,
        pageSize: query.pageSize,
      });

      return reply.header('cache-control', 'no-store').status(200).send(jobs);
    },
  );

  /**
   * Try a failed sync job again. Only a job that has failed can be retried; one
   * that already succeeded is refused, so nothing is posted twice.
   */
  app.post(
    '/erp/jobs/:id/retry',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);

      await retryJob({
        membership: currentSeller(request),
        jobId: params.id,
        actorUserId: request.auth?.id ?? null,
      });

      return reply.status(204).send();
    },
  );

  /**
   * Cancel a sync job that should not be sent. Refused while it is running and
   * for anything already posted to Tally, which is undone with a credit note instead.
   */
  app.post(
    '/erp/jobs/:id/cancel',
    { preHandler: [requireFeature, requireSeller(SellerPermission.INTEGRATION_WRITE)] },
    async (request, reply) => {
      const params = idParam.parse(request.params);

      await cancelJob({
        membership: currentSeller(request),
        jobId: params.id,
        actorUserId: request.auth?.id ?? null,
      });

      return reply.status(204).send();
    },
  );

  /** The security trail: pairings, revocations, mapping and policy changes. */
  app.get(
    '/erp/connections/:id/audit',
    { preHandler: requireSeller(SellerPermission.AUDIT_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const membership = currentSeller(request);

      await readConnection(membership, params.id);

      const events = await prisma.sellerErpAuditEvent.findMany({
        where: {
          connectionId: params.id,
          // Belt and braces on top of the ownership read above.
          sellerAccountId: membership.sellerAccountId,
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          action: true,
          actorType: true,
          actorLabel: true,
          summary: true,
          metaJson: true,
          createdAt: true,
        },
      });

      return reply.status(200).send({
        events: events.map((event) => ({
          id: event.id,
          action: event.action,
          actorType: event.actorType,
          actorLabel: event.actorLabel,
          summary: event.summary,
          meta: event.metaJson,
          createdAt: event.createdAt.toISOString(),
        })),
      });
    },
  );

  return Promise.resolve();
}
