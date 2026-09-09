/**
 * Settings -> ERP. Administrator only.
 *
 * The whole ERP surface lives behind `integration.read` / `integration.write`,
 * which only the Business Owner role holds. There is no customer-facing
 * counterpart to any of it, and that is the security property rather than a
 * layout choice: a connection is a URL plus a credential that this server then
 * calls, so the set of people who can create one is the set of people already
 * trusted with the installation.
 *
 * `outbound-http.ts` still resolves, checks and pins every address before a
 * request leaves. Being administrator-typed makes an address more likely to be
 * right; it does not make it right, and the guard costs nothing.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, forbidden, notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import {
  type ConnectionInput,
  type ErpActor,
  createConnection,
  deleteConnection,
  dryRun,
  getConnection,
  listConnections,
  performLifecycleAction,
  testConnection,
  updateConnection,
} from '../../modules/integrations/erp-connection.service.js';
import {
  getSyncRunErrors,
  listErpInventory,
  listSyncRuns,
  setManualQuantity,
  syncNow,
} from '../../modules/integrations/erp-inventory-sync.service.js';
import {
  listIntegrationEvents,
  loadEvent,
  requeueEvent,
} from '../../modules/integrations/integration-event.service.js';
import {
  erpSyncStateFor,
  retryErpConnectionPush,
} from '../../modules/integrations/erp-push.service.js';
import { MAPPING_FIELDS } from '../../modules/integrations/erp-field-mapping.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

/** The actor every service call takes, built from the session. */
function actorFor(request: FastifyRequest): ErpActor {
  const auth = currentUser(request);

  return {
    userId: auth.id,
    email: auth.email,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    correlationId: request.correlationId,
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const endpointSchema = z.string().trim().max(512).nullable().optional();
const methodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH']);

/**
 * Credentials.
 *
 * Every field optional, and that is what makes the masked edit form work: the
 * screen never receives a secret, so it never sends one back, and an absent
 * field means "keep what is stored". An explicit empty string clears it.
 */
const credentialsSchema = z
  .object({
    headerName: z.string().trim().max(64).optional(),
    apiKey: z.string().max(4096).optional(),
    token: z.string().max(4096).optional(),
    username: z.string().max(255).optional(),
    password: z.string().max(1024).optional(),
    clientId: z.string().max(255).optional(),
    clientSecret: z.string().max(4096).optional(),
    extraSecretHeaders: z.record(z.string().max(64), z.string().max(1024)).optional(),
  })
  .optional();

const fieldMappingSchema = z
  .object({
    itemsPath: z.string().trim().max(256).optional(),
    // Keys checked against the known field list by `validateFieldMapping`,
    // which produces a message naming the field rather than a schema error
    // naming a path.
    fields: z.record(z.string().max(64), z.string().trim().max(256)),
    warehouseMap: z.record(z.string().max(64), z.string().max(64)).optional(),
    orderStatusMap: z.record(z.string().max(64), z.string().max(64)).optional(),
  })
  .optional();

const connectionBodySchema = z.object({
  name: z.string().trim().min(1).max(128),
  baseUrl: z.string().trim().min(1).max(1024),
  endpoints: z
    .object({
      product: endpointSchema,
      inventory: endpointSchema,
      warehouse: endpointSchema,
      orderCreate: endpointSchema,
      orderStatus: endpointSchema,
    })
    .optional(),
  methods: z
    .object({
      product: methodSchema.optional(),
      inventory: methodSchema.optional(),
      warehouse: methodSchema.optional(),
      orderCreate: methodSchema.optional(),
      orderStatus: methodSchema.optional(),
    })
    .optional(),
  customHeaders: z.record(z.string().max(64), z.string().max(1024)).optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
  authMethod: z.enum(['API_KEY', 'BEARER_TOKEN', 'BASIC', 'OAUTH2']),
  credentials: credentialsSchema,
  oauthTokenUrl: z.string().trim().max(1024).nullable().optional(),
  oauthScope: z.string().trim().max(512).nullable().optional(),
  webhookEnabled: z.boolean().optional(),
  webhookSecret: z.string().max(1024).nullable().optional(),
  webhookSignatureHeader: z.string().trim().max(64).optional(),
  pollingEnabled: z.boolean().optional(),
  pollingIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  fieldMapping: fieldMappingSchema,
  inventoryAuthority: z.enum(['ERP', 'PLATFORM', 'MANUAL']).optional(),
  allowManualOverride: z.boolean().optional(),
  orderPushEnabled: z.boolean().optional(),
  idempotencyHeader: z.string().trim().max(64).optional(),
});

function toConnectionInput(body: z.output<typeof connectionBodySchema>): ConnectionInput {
  return body;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerAdminErpRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Refuse the whole surface where the deployment has not enabled it.
   *
   * Applied here as well as in the service, because a route that refuses before
   * touching the database is cheaper and the message is the same either way.
   */
  const requireFeature = async (): Promise<void> => {
    if (!env.FEATURE_ERP_INTEGRATION) {
      throw forbidden(
        ErrorCode.FEATURE_DISABLED,
        'ERP integration is not enabled for this installation.',
      );
    }
    await Promise.resolve();
  };

  /**
   * What this installation offers, and the fields a mapping may name.
   *
   * Read-only, and deliberately NOT behind `requireFeature`: the Settings
   * screen has to be able to ask "is this available" without getting a 403 it
   * would then have to interpret.
   */
  app.get(
    '/erp/capabilities',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (_request, reply) =>
      reply.status(200).send({
        erpIntegration: env.FEATURE_ERP_INTEGRATION,
        maxConnections: env.ERP_MAX_CONNECTIONS,
        /// Sent by the server so a field added to `MAPPING_FIELDS` appears on
        /// the mapping screen without the admin panel being rebuilt.
        mappingFields: Object.entries(MAPPING_FIELDS).map(([key, spec]) => ({
          key,
          label: spec.label,
          group: spec.group,
          kind: spec.kind,
        })),
      }),
  );

  // --- Connections --------------------------------------------------------

  app.get(
    '/erp/connections',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (_request, reply) => reply.status(200).send({ connections: await listConnections() }),
  );

  app.post(
    '/erp/connections',
    {
      preHandler: [requireAdmin(Permission.INTEGRATION_WRITE), requireFeature],
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const body = connectionBodySchema.parse(request.body);
      const connection = await createConnection(actorFor(request), toConnectionInput(body));

      return reply.status(201).send({ connection });
    },
  );

  app.get(
    '/erp/connections/:id',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send({ connection: await getConnection(id) });
    },
  );

  app.put(
    '/erp/connections/:id',
    {
      preHandler: [requireAdmin(Permission.INTEGRATION_WRITE), requireFeature],
      config: { rateLimit: { max: 40, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = connectionBodySchema.parse(request.body);

      const connection = await updateConnection(actorFor(request), id, toConnectionInput(body));

      return reply.status(200).send({ connection });
    },
  );

  app.delete(
    '/erp/connections/:id',
    { preHandler: [requireAdmin(Permission.INTEGRATION_WRITE), requireFeature] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await deleteConnection(actorFor(request), id);

      return reply.status(200).send({ deleted: true });
    },
  );

  /**
   * Test the connection.
   *
   * Rate-limited: each press makes several outbound requests to a server named
   * in configuration, and an unlimited button is a way to generate traffic at
   * somebody else's expense.
   */
  app.post(
    '/erp/connections/:id/test',
    {
      preHandler: [requireAdmin(Permission.INTEGRATION_WRITE), requireFeature],
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const result = await testConnection(actorFor(request), id);

      // 200 even when the test failed. The test RAN; what it found is in the
      // body. A 4xx here would make the panel treat an honest "your credentials
      // are wrong" as a broken request.
      return reply.status(200).send({ test: result });
    },
  );

  /** Dry run: read, map, report, change nothing. */
  app.post(
    '/erp/connections/:id/dry-run',
    {
      preHandler: [requireAdmin(Permission.INTEGRATION_WRITE), requireFeature],
      config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ fieldMapping: fieldMappingSchema }).parse(request.body ?? {});

      const result = await dryRun(
        actorFor(request),
        id,
        body.fieldMapping === undefined
          ? undefined
          : (body.fieldMapping),
      );

      return reply.status(200).send({ dryRun: result });
    },
  );

  /** Activate, pause, resume, disable, reopen. The state machine decides. */
  app.post(
    '/erp/connections/:id/actions',
    { preHandler: [requireAdmin(Permission.INTEGRATION_WRITE), requireFeature] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { action } = z
        .object({ action: z.enum(['ACTIVATE', 'PAUSE', 'RESUME', 'DISABLE', 'REOPEN']) })
        .parse(request.body);

      const connection = await performLifecycleAction(actorFor(request), id, action);

      return reply.status(200).send({ connection });
    },
  );

  // --- Inventory ----------------------------------------------------------

  app.post(
    '/erp/connections/:id/sync',
    {
      preHandler: [requireAdmin(Permission.INTEGRATION_WRITE), requireFeature],
      config: { rateLimit: { max: 12, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ dryRun: z.boolean().optional() }).parse(request.body ?? {});

      const outcome = await syncNow(actorFor(request), id, {
        ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
      });

      return reply.status(200).send({ sync: outcome });
    },
  );

  app.get(
    '/erp/connections/:id/sync-runs',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { limit } = z
        .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
        .parse(request.query);

      return reply.status(200).send({ runs: await listSyncRuns(id, limit ?? 20) });
    },
  );

  app.get(
    '/erp/sync-runs/:id/errors',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send({ errors: await getSyncRunErrors(id) });
    },
  );

  app.get(
    '/erp/inventory',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const query = z
        .object({
          connectionId: z.string().length(26).optional(),
          sku: z.string().trim().max(191).optional(),
          conflictsOnly: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(request.query);

      return reply.status(200).send({ inventory: await listErpInventory(query) });
    },
  );

  /**
   * Set or clear a figure by hand.
   *
   * This writes the SNAPSHOT, not `inventory_balances`. Moving real stock is
   * done through the Inventory screens, which record a reason and an actor -
   * see the comment on `erp_inventory_snapshots`.
   */
  app.post(
    '/erp/inventory/manual',
    { preHandler: [requireAdmin(Permission.INTEGRATION_WRITE), requireFeature] },
    async (request, reply) => {
      const body = z
        .object({
          connectionId: z.string().length(26),
          sku: z.string().trim().min(1).max(191),
          warehouseKey: z.string().max(64).optional(),
          quantity: z.number().int().min(0).nullable(),
        })
        .parse(request.body);

      return reply.status(200).send({ line: await setManualQuantity(actorFor(request), body) });
    },
  );

  // --- Activity -----------------------------------------------------------

  app.get(
    '/erp/events',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const query = z
        .object({
          connectionId: z.string().length(26).optional(),
          eventType: z
            .enum([
              'CONNECTION_TEST',
              'DRY_RUN',
              'ORDER_PUSH',
              'INVENTORY_SYNC',
              'INVENTORY_WEBHOOK',
              'ORDER_STATUS_POLL',
              'AUTOPAY_CHARGE',
            ])
            .optional(),
          status: z
            .enum(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'RETRY_SCHEDULED', 'FAILED', 'ABANDONED'])
            .optional(),
          orderId: z.string().length(26).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          cursor: z.string().length(26).optional(),
        })
        .parse(request.query);

      return reply.status(200).send(await listIntegrationEvents(query));
    },
  );

  /**
   * Try a failed operation again.
   *
   * The idempotency key is NOT regenerated - see `requeueEvent`. If the earlier
   * attempt did reach the ERP despite reporting failure, this has to collide
   * with it rather than create a second order.
   */
  app.post(
    '/erp/events/:id/retry',
    { preHandler: [requireAdmin(Permission.INTEGRATION_WRITE), requireFeature] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const event = await loadEvent(id);

      if (event === null) throw notFound('That activity entry');

      // An order push has its own retry path, because the push ledger row has
      // to move with the event. Routing it here would leave the two
      // disagreeing.
      if (event.eventType === 'ORDER_PUSH' && event.orderId !== null) {
        const result = await retryErpConnectionPush({
          orderId: event.orderId,
          correlationId: request.correlationId,
        });

        return reply.status(200).send({ retried: true, push: result });
      }

      await requeueEvent(id);

      return reply.status(202).send({ retried: true, push: null });
    },
  );

  /** Where one order stands with the ERP. The "Paid - ERP pending" view. */
  app.get(
    '/erp/orders/:id/status',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send({ erpStatus: await erpSyncStateFor(id) });
    },
  );

  return Promise.resolve();
}
