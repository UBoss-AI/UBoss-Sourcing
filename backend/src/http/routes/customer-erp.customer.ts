/**
 * Account -> Integrations -> ERP.
 *
 * The buyer-facing surface for connecting their own SAP, monday.com or in-house
 * system. Every handler derives the organisation from the SESSION, through
 * `resolveMembership`, and there is no `?organizationId=` anywhere in this file
 * - nor any handler that reads an owner from a request body. That is the tenant
 * boundary, and it is enforced by the shape of the code rather than by a check
 * somebody has to remember.
 *
 * Roles, from `organization.service.ts`:
 *
 *   - Any member may read connection health, sync history and the audit log.
 *   - An integration manager may configure, test, activate and operate.
 *   - An owner may additionally change who is in the organisation.
 *
 * The role check happens inside the SERVICES, not here. A guard that lived only
 * in the routes is a guard the next internal caller walks past; these handlers
 * are thin on purpose.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, forbidden } from '../../domain/errors.js';
import { listOrgAudit, type OrgActor } from '../../modules/customer-erp/audit.service.js';
import {
  activateConnection,
  changeConnectionState,
  createConnection,
  deleteConnection,
  disconnectConnection,
  dryRun,
  getConnection,
  listConnections,
  savePolicy,
  saveEndpoints,
  saveMappings,
  saveWarehouseMaps,
  testConnection,
  updateConnection,
} from '../../modules/customer-erp/connection.service.js';
import { availableSystems, connectorFor } from '../../modules/customer-erp/connectors/index.js';
import { presetsForRegion } from '../../modules/customer-erp/vendor-presets.js';
import { listEvents, requeueEvent } from '../../modules/customer-erp/event.service.js';
import { PLATFORM_FIELDS, TRANSFORMS } from '../../modules/customer-erp/mapping.service.js';
import { importOpenApi } from '../../modules/customer-erp/openapi-import.js';
import {
  acceptInvite,
  changeMemberRole,
  getOrganization,
  inviteMember,
  listInvites,
  listMembers,
  removeMember,
  renameOrganization,
  resolveMembership,
  revokeInvite,
  type Membership,
} from '../../modules/customer-erp/organization.service.js';
import {
  assertOAuthConfigured,
  completeAuthorization,
  connectionIdForState,
  redirectUri,
  startAuthorization,
} from '../../modules/customer-erp/oauth.service.js';
import { listSyncJobs, syncNow } from '../../modules/customer-erp/polling.service.js';
import { reconcile } from '../../modules/customer-erp/reconcile.service.js';
import { decideApproval, listApprovals } from '../../modules/customer-erp/approval.service.js';
import { listWebhookEvents } from '../../modules/customer-erp/webhook.service.js';
import { prisma } from '../../infra/prisma.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const connectionIdParam = z.object({ id: z.string().length(26) });

const systemSchema = z.enum(['SAP', 'MONDAY', 'ODOO', 'CUSTOM']);
const environmentSchema = z.enum(['SANDBOX', 'PRODUCTION']);
const apiStyleSchema = z.enum(['REST_JSON', 'ODATA', 'GRAPHQL']);
const authMethodSchema = z.enum([
  'OAUTH2_CLIENT_CREDENTIALS',
  'OAUTH2_AUTHORIZATION_CODE',
  'API_KEY',
  'BEARER_TOKEN',
  'BASIC',
  'MONDAY_PERSONAL_TOKEN',
]);

/**
 * A secret from a form.
 *
 * `.optional()` and NOT `.nullable()`, and the distinction is the whole of rule
 * 2 in `credential.service.ts`: absent means "the form did not send this, keep
 * what is stored", and an empty string means "the person cleared it". A
 * `.nullable()` here would give a third spelling of the same two intentions and
 * the handler would have to guess which.
 */
const secretSchema = z.string().max(8192).optional();

const secretsSchema = z
  .object({
    apiKey: secretSchema,
    bearerToken: secretSchema,
    username: secretSchema,
    password: secretSchema,
    clientId: secretSchema,
    clientSecret: secretSchema,
    personalToken: secretSchema,
    webhookSigningSecret: secretSchema,
    // PEM blocks, which are legitimately large.
    certificatePem: z.string().max(32768).optional(),
    privateKeyPem: z.string().max(32768).optional(),
    certificatePassphrase: secretSchema,
  })
  .optional();

const connectionBodySchema = z.object({
  name: z.string().trim().min(1).max(128),
  system: systemSchema,
  vendorPreset: z.string().trim().max(48).nullable().optional(),
  apiStyle: apiStyleSchema.optional(),
  environment: environmentSchema,
  erpVersion: z.string().trim().max(64).nullable().optional(),
  baseUrl: z.string().trim().min(1).max(1024),
  apiVersion: z.string().trim().max(32).nullable().optional(),
  networkMode: z
    .enum(['PUBLIC_HTTPS', 'IP_ALLOWLIST', 'VPN_GATEWAY', 'SAP_CLOUD_CONNECTOR'])
    .optional(),
  networkNotes: z.string().trim().max(1024).nullable().optional(),
  tenantIdentifier: z.string().trim().max(191).nullable().optional(),
  customHeaders: z.record(z.string(), z.string().max(1024)).optional(),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
  authMethod: authMethodSchema,
  apiKeyLocation: z.enum(['HEADER', 'QUERY']).nullable().optional(),
  apiKeyName: z.string().trim().max(64).nullable().optional(),
  oauthAuthorizationUrl: z.string().trim().max(1024).nullable().optional(),
  oauthTokenUrl: z.string().trim().max(1024).nullable().optional(),
  oauthScope: z.string().trim().max(512).nullable().optional(),
  mutualTlsEnabled: z.boolean().optional(),
  sapCompanyCode: z.string().trim().max(8).nullable().optional(),
  sapPurchasingOrg: z.string().trim().max(8).nullable().optional(),
  sapPurchasingGroup: z.string().trim().max(8).nullable().optional(),
  sapPlant: z.string().trim().max(8).nullable().optional(),
  sapStorageLocation: z.string().trim().max(8).nullable().optional(),
  sapCommunicationScenario: z.string().trim().max(64).nullable().optional(),
  mondayWorkspaceId: z.string().trim().max(64).nullable().optional(),
  mondayBoardId: z.string().trim().max(64).nullable().optional(),
  mondayGroupId: z.string().trim().max(64).nullable().optional(),
  webhookEnabled: z.boolean().optional(),
  webhookSignatureHeader: z.string().trim().max(64).optional(),
  webhookToleranceSeconds: z.number().int().min(30).max(3600).optional(),
  pollingEnabled: z.boolean().optional(),
  pollingIntervalMinutes: z.number().int().min(5).max(10080).optional(),
  pollingTimezone: z.string().trim().max(64).optional(),
  secrets: secretsSchema,
});

const mappingEntitySchema = z.enum([
  'PRODUCT',
  'WAREHOUSE',
  'ORDER',
  'INVENTORY',
  'INVOICE',
  'PAYMENT',
  'STATUS',
]);

const endpointPurposeSchema = z.enum([
  'PRODUCTS',
  'WAREHOUSES',
  'INVENTORY',
  'PURCHASE_ORDER_CREATE',
  'PURCHASE_ORDER_UPDATE',
  'GOODS_RECEIPT',
  'SHIPMENT_STATUS',
  'INVOICE',
  'PAYMENT_REFERENCE',
  'WEBHOOK',
]);

function actorFor(request: FastifyRequest): OrgActor {
  const auth = currentUser(request);

  return {
    customerProfileId: auth.customerProfileId,
    email: auth.email,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    correlationId: request.correlationId,
  };
}

async function membershipFor(request: FastifyRequest): Promise<Membership> {
  const auth = currentUser(request);
  return resolveMembership(auth.customerProfileId ?? '');
}

// ---------------------------------------------------------------------------

export function registerCustomerErpRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  /**
   * The feature gate.
   *
   * Applied to everything that WRITES, and deliberately not to the reads below
   * - a buyer whose store has switched the feature off should see that it is
   * off, rather than a 403 the screen has to guess the meaning of.
   */
  const requireFeature = async (): Promise<void> => {
    if (!env.FEATURE_CUSTOMER_ERP) {
      throw forbidden(
        ErrorCode.FEATURE_DISABLED,
        'Connecting your own purchasing system is not switched on for this store.',
      );
    }
    await Promise.resolve();
  };

  // --- Discovery ----------------------------------------------------------

  /**
   * What the wizard needs before anything exists: which systems, which
   * authentication methods each accepts, which fields can be mapped, and what
   * this deployment's own defaults are.
   *
   * Ungated, so a store with the feature off renders an honest "not available"
   * rather than a broken form.
   */
  app.get('/options', async (request, reply) => {
    const query = request.query as { environment?: string; region?: string } | undefined;

    const environment = z
      .enum(['SANDBOX', 'PRODUCTION'])
      .catch('SANDBOX')
      .parse(query?.environment);

    /*
     * Which market's ERPs to put first.
     *
     * An Indian buyer should not scroll past four American mid-market systems
     * to reach Tally, and a German one should not lead with Marg. `.catch`
     * rather than a validation failure: a region this deployment has never
     * heard of is a reason to show the global order, not to refuse the screen.
     */
    const region = z.enum(['global', 'india', 'eu']).catch('global').parse(query?.region);

    return reply.status(200).send({
      available: env.FEATURE_CUSTOMER_ERP,
      /*
       * The catalogue: the named ERPs a buyer picks from.
       *
       * `connector` says which protocol speaks to each, and several share one -
       * NetSuite, Zoho, Dynamics, TCS iON and the rest are all CUSTOM. The
       * screen shows brands; only the server cares which code runs.
       */
      presets: presetsForRegion(region).map((preset) => ({
        id: preset.id,
        label: preset.label,
        connector: preset.connector,
        apiStyle: preset.apiStyle,
        /*
         * What this vendor accepts, narrowed to what its connector will accept
         * in THIS environment.
         *
         * A preset is a catalogue entry - it knows monday does OAuth and
         * personal tokens, and nothing about sandbox or production. The
         * connector is the one that knows a personal token is refused on a
         * production connection, and that the OAuth path only exists where the
         * operator has registered an app. The screen prefers the preset's list
         * over the connector's, so leaving this unnarrowed is what let a buyer
         * choose production with a personal token, fill in every step, and be
         * refused at the end by a rule that was knowable at the first one.
         */
        authMethods: preset.authMethods.filter((method) =>
          connectorFor(preset.connector).defaults(environment).authMethods.includes(method),
        ),
        baseUrlExample: preset.baseUrlExample,
        notes: preset.notes,
        // Rendered as a warning. See `vendor-presets.ts` for why this is a
        // field rather than a judgement the screen makes.
        defaultsAreExamples: preset.defaultsAreExamples,
        onPremiseTypical: preset.onPremiseTypical,
        regions: preset.regions,
      })),
      systems: availableSystems().map((system) => {
        const defaults = connectorFor(system).defaults(environment);

        return {
          system,
          apiStyle: defaults.apiStyle,
          authMethods: defaults.authMethods,
          endpoints: defaults.endpoints,
          mappings: defaults.mappings,
          networkNotes: defaults.networkNotes,
          supportsWebhooks: defaults.supportsWebhooks,
          // Null for everything the buyer hosts themselves, in which case the
          // screen keeps asking for them. Set for a SaaS with one published
          // pair, in which case the screen fills them in and stops asking.
          oauthAuthorizationUrl: defaults.oauthAuthorizationUrl,
          oauthTokenUrl: defaults.oauthTokenUrl,
        };
      }),
      platformFields: PLATFORM_FIELDS,
      transforms: TRANSFORMS,
      // The address a buyer registers with their own ERP for OAuth. Shown on
      // the connection step so they can paste it into their side first.
      oauthRedirectUri: redirectUri(),
      maxConnections: env.CUSTOMER_ERP_MAX_CONNECTIONS_PER_ORG,
    });
  });

  /** The warehouses a buyer can map their plants against. */
  app.get('/warehouses', async (_request, reply) => {
    const rows = await prisma.inventoryLocation.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true, countryCode: true },
      orderBy: { name: 'asc' },
    });

    return reply.status(200).send({ warehouses: rows });
  });

  // --- The organisation ---------------------------------------------------

  app.get('/organization', async (request, reply) => {
    const membership = await membershipFor(request);

    return reply.status(200).send({
      organization: await getOrganization(membership),
      members: await listMembers(membership),
      // Only an owner may see who has been invited and not yet joined; for
      // anybody else the list is simply absent rather than empty, so a screen
      // does not render "no pending invitations" to somebody who cannot see
      // them.
      invites: membership.role === 'OWNER' ? await listInvites(membership) : null,
    });
  });

  app.patch('/organization', { preHandler: requireFeature }, async (request, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(255) }).parse(request.body);
    const membership = await membershipFor(request);

    return reply.status(200).send({
      organization: await renameOrganization(membership, actorFor(request), body.name),
    });
  });

  app.post(
    '/organization/invites',
    {
      preHandler: requireFeature,
      // An invitation is an email to an address somebody typed. Bounded so this
      // endpoint cannot be used to send mail on somebody else's behalf.
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const body = z
        .object({
          email: z.string().trim().email().max(320),
          role: z.enum(['OWNER', 'INTEGRATION_MANAGER', 'MEMBER']),
        })
        .parse(request.body);

      const membership = await membershipFor(request);
      const result = await inviteMember(membership, actorFor(request), body);

      return reply.status(201).send(result);
    },
  );

  app.delete(
    '/organization/invites/:inviteId',
    { preHandler: requireFeature },
    async (request, reply) => {
      const { inviteId } = z.object({ inviteId: z.string().length(26) }).parse(request.params);
      const membership = await membershipFor(request);

      return reply.status(200).send({
        invites: await revokeInvite(membership, actorFor(request), inviteId),
      });
    },
  );

  /**
   * Accept an invitation.
   *
   * Deliberately not gated on the feature flag. Somebody holding a valid
   * invitation should be able to join even if the store has since switched the
   * integration off - otherwise the link simply fails with a message about a
   * feature they never asked about.
   */
  app.post(
    '/organization/join',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = z.object({ token: z.string().min(16).max(256) }).parse(request.body);
      const auth = currentUser(request);

      const membership = await acceptInvite({
        token: body.token,
        customerProfileId: auth.customerProfileId ?? '',
        emailNormalized: auth.email.trim().toLowerCase(),
        actor: actorFor(request),
      });

      return reply.status(200).send({ organization: await getOrganization(membership) });
    },
  );

  app.patch(
    '/organization/members/:memberId',
    { preHandler: requireFeature },
    async (request, reply) => {
      const { memberId } = z.object({ memberId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({ role: z.enum(['OWNER', 'INTEGRATION_MANAGER', 'MEMBER']) })
        .parse(request.body);

      const membership = await membershipFor(request);

      return reply.status(200).send({
        members: await changeMemberRole(membership, actorFor(request), memberId, body.role),
      });
    },
  );

  app.delete(
    '/organization/members/:memberId',
    { preHandler: requireFeature },
    async (request, reply) => {
      const { memberId } = z.object({ memberId: z.string().length(26) }).parse(request.params);
      const membership = await membershipFor(request);

      return reply.status(200).send({
        members: await removeMember(membership, actorFor(request), memberId),
      });
    },
  );

  // --- Connections --------------------------------------------------------

  app.get('/connections', async (request, reply) => {
    const membership = await membershipFor(request);

    return reply.status(200).send({
      available: env.FEATURE_CUSTOMER_ERP,
      role: membership.role,
      connections: await listConnections(membership),
    });
  });

  app.post(
    '/connections',
    { preHandler: requireFeature, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = connectionBodySchema.parse(request.body);
      const membership = await membershipFor(request);

      const connection = await createConnection(membership, actorFor(request), body);
      return reply.status(201).send({ connection });
    },
  );

  app.get('/connections/:id', async (request, reply) => {
    const { id } = connectionIdParam.parse(request.params);
    const membership = await membershipFor(request);

    return reply.status(200).send({
      role: membership.role,
      connection: await getConnection(membership, id),
    });
  });

  app.patch('/connections/:id', { preHandler: requireFeature }, async (request, reply) => {
    const { id } = connectionIdParam.parse(request.params);
    const body = connectionBodySchema.partial().parse(request.body);
    const membership = await membershipFor(request);

    return reply.status(200).send({
      connection: await updateConnection(membership, actorFor(request), id, body),
    });
  });

  app.delete('/connections/:id', { preHandler: requireFeature }, async (request, reply) => {
    const { id } = connectionIdParam.parse(request.params);
    const membership = await membershipFor(request);

    await deleteConnection(membership, actorFor(request), id);
    return reply.status(204).send();
  });

  // --- Endpoints, mappings, warehouses, policy ----------------------------

  app.put(
    '/connections/:id/endpoints',
    { preHandler: requireFeature },
    async (request, reply) => {
      const { id } = connectionIdParam.parse(request.params);
      const body = z
        .object({
          endpoints: z
            .array(
              z.object({
                purpose: endpointPurposeSchema,
                path: z.string().trim().min(1).max(512),
                method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
                enabled: z.boolean().optional(),
                pagination: z
                  .enum([
                    'NONE',
                    'PAGE_NUMBER',
                    'OFFSET_LIMIT',
                    'CURSOR',
                    'ODATA_NEXT_LINK',
                  ])
                  .optional(),
                paginationConfig: z.record(z.string(), z.unknown()).optional(),
                recordsPath: z.string().trim().max(191).nullable().optional(),
                requestTemplate: z.record(z.string(), z.unknown()).nullable().optional(),
                queryParams: z.record(z.string(), z.string().max(512)).optional(),
              }),
            )
            .max(20),
        })
        .parse(request.body);

      const membership = await membershipFor(request);

      return reply.status(200).send({
        connection: await saveEndpoints(
          membership,
          actorFor(request),
          id,
          body.endpoints,
        ),
      });
    },
  );

  app.put('/connections/:id/mappings', { preHandler: requireFeature }, async (request, reply) => {
    const { id } = connectionIdParam.parse(request.params);
    const body = z
      .object({
        mappings: z
          .array(
            z.object({
              entity: mappingEntitySchema,
              platformField: z.string().trim().min(1).max(64),
              erpPath: z.string().trim().max(191).default(''),
              constantValue: z.string().trim().max(191).nullable().default(null),
              erpValue: z.string().trim().max(128).nullable().default(null),
              transform: z
                .enum([
                  'TRIM',
                  'UPPERCASE',
                  'LOWERCASE',
                  'MINOR_TO_DECIMAL',
                  'DECIMAL_TO_MINOR',
                  'ISO_DATE',
                  'DATE_ONLY',
                ])
                .nullable()
                .default(null),
              required: z.boolean().default(false),
            }),
          )
          .max(200),
      })
      .parse(request.body);

    const membership = await membershipFor(request);

    return reply.status(200).send({
      connection: await saveMappings(membership, actorFor(request), id, body.mappings),
    });
  });

  app.put(
    '/connections/:id/warehouses',
    { preHandler: requireFeature },
    async (request, reply) => {
      const { id } = connectionIdParam.parse(request.params);
      const body = z
        .object({
          warehouseMaps: z
            .array(
              z.object({
                inventoryLocationId: z.string().length(26).nullable(),
                erpPlant: z.string().trim().max(32).nullable().optional(),
                erpStorageLocation: z.string().trim().max(32).nullable().optional(),
                erpBoardId: z.string().trim().max(64).nullable().optional(),
                erpGroupId: z.string().trim().max(64).nullable().optional(),
                isFallback: z.boolean().optional(),
              }),
            )
            .max(100),
        })
        .parse(request.body);

      const membership = await membershipFor(request);

      return reply.status(200).send({
        connection: await saveWarehouseMaps(
          membership,
          actorFor(request),
          id,
          body.warehouseMaps,
        ),
      });
    },
  );

  app.put('/connections/:id/policy', { preHandler: requireFeature }, async (request, reply) => {
    const { id } = connectionIdParam.parse(request.params);
    const body = z
      .object({
        sourceOfTruth: z.enum(['ERP', 'PLATFORM']).optional(),
        mode: z.enum(['INBOUND', 'OUTBOUND', 'BIDIRECTIONAL']).optional(),
        conflictPolicy: z
          .enum(['ERP_WINS', 'PLATFORM_WINS', 'NEWEST_WINS', 'MANUAL'])
          .optional(),
        inventoryWriteMode: z.enum(['AUTOMATIC', 'APPROVAL_REQUIRED']).optional(),
        receiptOnPlatformDelivery: z.boolean().optional(),
        // Minor units as a STRING. `12.34 * 100` is 1233.9999999999998, and a
        // threshold one unit under what the buyer typed will one day let
        // through an order they meant to be asked about. See CLAUDE.md.
        approvalThresholdMinor: z
          .string()
          .regex(/^\d{1,18}$/)
          .nullable()
          .optional(),
        approvalCurrency: z.string().trim().length(3).nullable().optional(),
        approvalExpiryHours: z.number().int().min(1).max(720).optional(),
        sendPurchaseOrders: z.boolean().optional(),
        sendShipmentStatus: z.boolean().optional(),
        sendGoodsReceipts: z.boolean().optional(),
        sendInvoices: z.boolean().optional(),
        sendPaymentReferences: z.boolean().optional(),
        syncInventory: z.boolean().optional(),
      })
      .parse(request.body);

    const membership = await membershipFor(request);

    return reply.status(200).send({
      connection: await savePolicy(membership, actorFor(request), id, body),
    });
  });

  // --- Operating ----------------------------------------------------------

  app.post(
    '/connections/:id/test',
    {
      preHandler: requireFeature,
      // A test is an outbound call to somebody else's system. Bounded so this
      // endpoint cannot be turned into a way to hammer a third party.
      config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const { id } = connectionIdParam.parse(request.params);
      const membership = await membershipFor(request);

      return reply
        .status(200)
        .send({ test: await testConnection(membership, actorFor(request), id) });
    },
  );

  app.post(
    '/connections/:id/dry-run',
    { preHandler: requireFeature, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = connectionIdParam.parse(request.params);
      const membership = await membershipFor(request);

      return reply.status(200).send({ dryRun: await dryRun(membership, actorFor(request), id) });
    },
  );

  app.post('/connections/:id/activate', { preHandler: requireFeature }, async (request, reply) => {
    const { id } = connectionIdParam.parse(request.params);
    const membership = await membershipFor(request);

    return reply.status(200).send({
      connection: await activateConnection(membership, actorFor(request), id),
    });
  });

  app.post('/connections/:id/pause', { preHandler: requireFeature }, async (request, reply) => {
    const { id } = connectionIdParam.parse(request.params);
    const membership = await membershipFor(request);

    return reply.status(200).send({
      connection: await changeConnectionState(membership, actorFor(request), id, 'PAUSE'),
    });
  });

  app.post('/connections/:id/resume', { preHandler: requireFeature }, async (request, reply) => {
    const { id } = connectionIdParam.parse(request.params);
    const membership = await membershipFor(request);

    return reply.status(200).send({
      connection: await changeConnectionState(membership, actorFor(request), id, 'RESUME'),
    });
  });

  app.post(
    '/connections/:id/reconnect',
    { preHandler: requireFeature },
    async (request, reply) => {
      const { id } = connectionIdParam.parse(request.params);
      const membership = await membershipFor(request);

      return reply.status(200).send({
        connection: await changeConnectionState(membership, actorFor(request), id, 'RECONNECT'),
      });
    },
  );

  app.post(
    '/connections/:id/disconnect',
    { preHandler: requireFeature },
    async (request, reply) => {
      const { id } = connectionIdParam.parse(request.params);
      const membership = await membershipFor(request);

      return reply.status(200).send({
        connection: await disconnectConnection(membership, actorFor(request), id),
      });
    },
  );

  app.post(
    '/connections/:id/sync',
    { preHandler: requireFeature, config: { rateLimit: { max: 12, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = connectionIdParam.parse(request.params);
      const membership = await membershipFor(request);

      return reply.status(202).send({ sync: await syncNow(membership, actorFor(request), id) });
    },
  );

  /**
   * Compare their catalogue against ours, and say where the two disagree.
   *
   * A POST because it calls their system - several times, over a paged feed -
   * and a GET that did that would be re-run by every refresh, back button and
   * link prefetcher. Rate limited accordingly: this is a question somebody asks
   * when they are looking at it, not something a screen polls.
   */
  app.post(
    '/connections/:id/reconcile',
    { preHandler: requireFeature, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = connectionIdParam.parse(request.params);
      const membership = await membershipFor(request);

      // Through the tenant-scoped loader first, so another organisation's
      // connection id is a 404 before a single call leaves this server.
      await getConnection(membership, id);

      return reply.status(200).send({ reconciliation: await reconcile(membership, id) });
    },
  );

  // --- OAuth --------------------------------------------------------------

  /**
   * Start an authorisation-code flow.
   *
   * Returns the URL rather than redirecting. The caller is a fetch from a
   * single-page app, and a 302 to a third party in an XHR response is followed
   * by the fetch rather than by the browser - so the buyer would never see
   * their own ERP's consent screen.
   */
  app.post(
    '/connections/:id/oauth/start',
    { preHandler: requireFeature, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = connectionIdParam.parse(request.params);
      const membership = await membershipFor(request);

      // Loaded through the tenant-scoped loader, so a connection id belonging
      // to another organisation is a 404 before any OAuth state is written.
      await getConnection(membership, id);

      const connection = await prisma.customerErpConnection.findFirstOrThrow({
        where: { id, organizationId: membership.organizationId, deletedAt: null },
      });

      const context = {
        id: connection.id,
        organizationId: connection.organizationId,
        system: connection.system,
        authMethod: connection.authMethod,
        oauthAuthorizationUrl: connection.oauthAuthorizationUrl,
        oauthTokenUrl: connection.oauthTokenUrl,
        oauthScope: connection.oauthScope,
        oauthUsesPlatformApp: connection.oauthUsesPlatformApp,
        timeoutMs: connection.timeoutMs,
      };

      assertOAuthConfigured(context);

      return reply.status(200).send({
        authorization: await startAuthorization(context, membership.customerProfileId),
      });
    },
  );

  /**
   * Finish an authorisation-code flow.
   *
   * A POST from the page the ERP redirected back to, carrying the `code` and
   * `state` from the query string - rather than the redirect landing on the API
   * itself. That keeps the authorisation code out of this server's access logs
   * as a GET query parameter, and lets the storefront render a result the buyer
   * can read instead of a JSON body.
   *
   * `connectionId` is optional because the ERP does not send it back. An
   * authorisation is a full-page redirect to a third party, so the only things
   * that survive it are the query parameters that third party chose to return:
   * `code` and `state`. Requiring the caller to remember the connection meant
   * remembering it in the browser across that redirect, and a provider that
   * opens the callback in a new tab - or a buyer who restores the session -
   * would lose it and strand a perfectly good authorisation. The state row
   * already knows which connection it belongs to, so it is asked. Nothing is
   * relaxed by this: the connection is still loaded through the tenant-scoped
   * loader, and `completeAuthorization` still refuses a state that does not
   * match the connection or was not started by the member finishing it.
   */
  app.post(
    '/oauth/callback',
    { preHandler: requireFeature, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const body = z
        .object({
          connectionId: z.string().length(26).optional(),
          state: z.string().min(16).max(128),
          code: z.string().min(4).max(4096),
        })
        .parse(request.body);

      const membership = await membershipFor(request);

      const connectionId = body.connectionId ?? (await connectionIdForState(body.state));

      await getConnection(membership, connectionId);

      const connection = await prisma.customerErpConnection.findFirstOrThrow({
        where: {
          id: connectionId,
          organizationId: membership.organizationId,
          deletedAt: null,
        },
      });

      const result = await completeAuthorization({
        context: {
          id: connection.id,
          organizationId: connection.organizationId,
          system: connection.system,
          authMethod: connection.authMethod,
          oauthAuthorizationUrl: connection.oauthAuthorizationUrl,
          oauthTokenUrl: connection.oauthTokenUrl,
          oauthScope: connection.oauthScope,
          oauthUsesPlatformApp: connection.oauthUsesPlatformApp,
          timeoutMs: connection.timeoutMs,
        },
        stateToken: body.state,
        code: body.code,
        customerProfileId: membership.customerProfileId,
      });

      const view = await getConnection(membership, connectionId);

      return reply.status(200).send({
        authorized: true,
        // What the ERP actually granted, which is not always what was asked
        // for. Shown so a buyer is told "your system granted read but not
        // write" rather than discovering it at the first purchase order.
        grantedScope: result.scope,
        expiresAt: result.expiresAt?.toISOString() ?? null,
        connection: view,
      });
    },
  );

  // --- OpenAPI import -----------------------------------------------------

  app.post(
    '/openapi/import',
    { preHandler: requireFeature, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = z
        .object({ document: z.string().min(2).max(2 * 1024 * 1024) })
        .parse(request.body);

      // Membership is resolved even though nothing is written, so a caller who
      // is not in an organisation cannot use this as a free YAML parser.
      await membershipFor(request);

      return reply.status(200).send({ imported: importOpenApi(body.document) });
    },
  );

  // --- Logs, events, approvals -------------------------------------------

  app.get('/events', async (request, reply) => {
    const query = z
      .object({
        connectionId: z.string().length(26).optional(),
        state: z
          .enum(['QUEUED', 'PROCESSING', 'SUCCEEDED', 'RETRYING', 'FAILED', 'SKIPPED'])
          .optional(),
        eventType: z.string().max(48).optional(),
        search: z.string().max(128).optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);

    const membership = await membershipFor(request);

    return reply.status(200).send(
      await listEvents(membership.organizationId, {
        connectionId: query.connectionId ?? null,
        state: query.state ?? null,
        eventType: (query.eventType ?? null) as never,
        search: query.search ?? null,
        before: query.before === undefined ? null : new Date(query.before),
        limit: query.limit,
      }),
    );
  });

  app.post(
    '/events/:eventId/retry',
    { preHandler: requireFeature, config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { eventId } = z.object({ eventId: z.string().length(26) }).parse(request.params);
      const membership = await membershipFor(request);

      // OPERATE, checked in the service. A member who can only look must not be
      // able to push a purchase order into somebody's SAP.
      const { assertCapability } = await import(
        '../../modules/customer-erp/organization.service.js'
      );
      assertCapability(membership, 'OPERATE');

      await requeueEvent(eventId, membership.organizationId, actorFor(request));

      return reply.status(202).send({ queued: true });
    },
  );

  app.get('/jobs', async (request, reply) => {
    const query = z
      .object({
        connectionId: z.string().length(26).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(request.query);

    const membership = await membershipFor(request);

    return reply.status(200).send({
      jobs: await listSyncJobs(
        membership.organizationId,
        query.connectionId ?? null,
        query.limit,
      ),
    });
  });

  app.get('/webhook-events', async (request, reply) => {
    const query = z
      .object({
        connectionId: z.string().length(26).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);

    const membership = await membershipFor(request);

    return reply.status(200).send({
      webhookEvents: await listWebhookEvents(
        membership.organizationId,
        query.connectionId ?? null,
        query.limit,
      ),
    });
  });

  app.get('/approvals', async (request, reply) => {
    const query = z
      .object({
        connectionId: z.string().length(26).optional(),
        pendingOnly: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);

    const membership = await membershipFor(request);

    return reply.status(200).send({
      approvals: await listApprovals(membership, {
        connectionId: query.connectionId ?? null,
        pendingOnly: query.pendingOnly ?? false,
        limit: query.limit,
      }),
    });
  });

  app.post(
    '/approvals/:approvalId',
    { preHandler: requireFeature },
    async (request, reply) => {
      const { approvalId } = z
        .object({ approvalId: z.string().length(26) })
        .parse(request.params);

      const body = z
        .object({
          decision: z.enum(['APPROVED', 'REJECTED']),
          note: z.string().trim().max(512).nullable().optional(),
        })
        .parse(request.body);

      const membership = await membershipFor(request);

      return reply.status(200).send({
        approval: await decideApproval(
          membership,
          actorFor(request),
          approvalId,
          body.decision,
          body.note ?? null,
        ),
      });
    },
  );

  app.get('/audit', async (request, reply) => {
    const query = z
      .object({
        connectionId: z.string().length(26).optional(),
        action: z.string().max(64).optional(),
        search: z.string().max(128).optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);

    const membership = await membershipFor(request);

    return reply.status(200).send(
      await listOrgAudit(membership.organizationId, {
        connectionId: query.connectionId ?? null,
        action: query.action ?? null,
        search: query.search ?? null,
        before: query.before === undefined ? null : new Date(query.before),
        limit: query.limit,
      }),
    );
  });

  /**
   * The orders and invoices this connection has linked, for the dashboard's
   * "what has actually gone across" table.
   */
  app.get('/connections/:id/links', async (request, reply) => {
    const { id } = connectionIdParam.parse(request.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
      .parse(request.query);

    const membership = await membershipFor(request);
    await getConnection(membership, id);

    const [orders, invoices] = await Promise.all([
      prisma.customerErpOrderLink.findMany({
        where: { connectionId: id, organizationId: membership.organizationId },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
      }),
      prisma.customerErpInvoiceLink.findMany({
        where: { connectionId: id, organizationId: membership.organizationId },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
      }),
    ]);

    const orderNumbers = await prisma.order.findMany({
      where: { id: { in: orders.map((row) => row.orderId) } },
      select: { id: true, orderNumber: true, status: true },
    });

    const numbers = new Map(orderNumbers.map((row) => [row.id, row]));

    return reply.status(200).send({
      orderLinks: orders.map((row) => ({
        orderId: row.orderId,
        orderNumber: numbers.get(row.orderId)?.orderNumber ?? null,
        orderStatus: numbers.get(row.orderId)?.status ?? null,
        erpPurchaseOrderId: row.erpPurchaseOrderId,
        erpOrderStatus: row.erpOrderStatus,
        erpGoodsReceiptId: row.erpGoodsReceiptId,
        goodsReceiptedAt: row.goodsReceiptedAt?.toISOString() ?? null,
        onOrderQty: row.onOrderQty,
        receivedQty: row.receivedQty,
        shipmentStatus: row.shipmentStatus,
        trackingNumber: row.trackingNumber,
        pushedAt: row.pushedAt?.toISOString() ?? null,
        lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      })),
      invoiceLinks: invoices.map((row) => ({
        invoiceId: row.invoiceId,
        orderId: row.orderId,
        erpInvoiceNumber: row.erpInvoiceNumber,
        currency: row.currency,
        // Minor units as a string. `BigInt` does not survive `JSON.stringify`.
        grandTotalMinor: row.grandTotalMinor.toString(),
        taxMinor: row.taxMinor.toString(),
        dueAt: row.dueAt?.toISOString() ?? null,
        paymentReference: row.paymentReference,
        paymentStatus: row.paymentStatus,
        syncedAt: row.syncedAt?.toISOString() ?? null,
      })),
    });
  });

  return Promise.resolve();
}

/**
 * A stock figure this connection has recorded, for the dashboard.
 *
 * Exported rather than registered inline because the inventory view is read by
 * the admin support screen too, and one query shape means one answer to "what
 * does this connection believe about stock".
 */
export async function listInventoryLinks(
  organizationId: string,
  connectionId: string,
  limit: number,
): Promise<
  {
    productId: string;
    erpMaterialNumber: string | null;
    erpPlant: string | null;
    onHandQty: number;
    onOrderQty: number;
    incomingQty: number;
    erpUnitOfMeasure: string | null;
    divergenceNote: string | null;
    lastSyncedAt: string | null;
  }[]
> {
  const rows = await prisma.customerErpInventoryLink.findMany({
    where: { connectionId, organizationId },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });

  return rows.map((row) => ({
    productId: row.productId,
    erpMaterialNumber: row.erpMaterialNumber,
    erpPlant: row.erpPlant,
    onHandQty: row.onHandQty,
    onOrderQty: row.onOrderQty,
    incomingQty: row.incomingQty,
    erpUnitOfMeasure: row.erpUnitOfMeasure,
    divergenceNote: row.divergenceNote,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  }));
}
