/**
 * A buyer's ERP connection: creating it, configuring it, proving it works, and
 * switching it on.
 *
 * This is the service behind Account -> Integrations -> ERP. Every function
 * takes a `Membership` rather than an organisation id, and that is the tenant
 * boundary: a membership can only be obtained from `resolveMembership`, which
 * derives it from the session. No function here accepts an organisation id from
 * a caller, and every query names `organizationId` in its WHERE clause rather
 * than filtering afterwards - so a mistake produces a 404 instead of somebody
 * else's SAP credentials.
 *
 * THREE RULES ABOUT SECRETS, NONE OF WHICH HAS AN EXCEPTION
 *
 *   1. Nothing here returns a credential. `toOwnerView` is the widest shape
 *      that leaves this file and it has no field that could carry one; what it
 *      carries instead is `credentials`, a list of hints.
 *   2. A save that omits a secret field KEEPS the stored one. That is what
 *      makes a masked edit form work: the buyer changes the timeout, the form
 *      sends no client secret because it never had one to send, and the secret
 *      survives. An explicit empty string clears it, which is a deliberate act.
 *   3. Disconnecting destroys them. See `credential.service.ts`, rule 4.
 *
 * ON TESTING BEFORE ACTIVATING
 *
 * `ACTIVATE` is refused unless a test has passed AND the mapping has been
 * checked against a real response AND an endpoint exists for everything the
 * policy says will be sent. All three are recorded on the row, and the first
 * two are CLEARED whenever the configuration changes - because what the last
 * test proved, it proved about settings that have since been replaced.
 *
 * That is stricter than it needs to be for a demo and exactly as strict as it
 * needs to be for somebody's purchasing system. A connection that has never
 * answered cannot start raising purchase orders in a live SAP.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  CustomerErpApiKeyLocation,
  CustomerErpApiStyle,
  CustomerErpAuthMethod,
  CustomerErpEnvironment,
  CustomerErpNetworkMode,
  CustomerErpPagination,
  CustomerErpSystem,
} from '../../generated/prisma/enums.js';
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  assertConnectionTransition,
  assertReadyToActivate,
  availableConnectionActions,
  connectionStateLabel,
  type CustomerErpConnectionStateName,
} from '../../domain/customer-erp-state.js';
import { newId } from '../../infra/ids.js';
import { loggerFor } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { assertSafeErpUrl } from '../../infra/outbound-http.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { recordOrgAudit, type OrgActor } from './audit.service.js';
import { connectorFor, loadConnectorContext } from './connectors/index.js';
import { presetById } from './vendor-presets.js';
import type { ConnectorDefaults, EndpointPurpose, SystemName } from './connectors/types.js';
import {
  deleteCredential,
  hasCredential,
  mergePrimaryCredential,
  purgeCredentials,
  saveCredential,
  summariseCredentials,
  type CredentialSummary,
} from './credential.service.js';
import { countEventsByState } from './event.service.js';
import { ErpCallError, hostPolicy, resolveEndpointUrl, safeErrorMessage } from './http.js';
import {
  PLATFORM_FIELDS,
  assertMappingValid,
  missingRequiredFields,
  verifyAgainstSample,
  type MappingEntity,
  type MappingRow,
  type SampleCheckResult,
  type TransformName,
} from './mapping.service.js';
import { assertCapability, type Membership } from './organization.service.js';
import { revokeTokens } from './oauth.service.js';

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * What a MEMBER sees.
 *
 * A different shape from the owner's rather than the same shape with fields
 * blanked, and the difference is the point: a read-only member has no reason to
 * know which addresses the connection calls, and a view that carried them with
 * a `null` where a hint should be would put the decision about what to hide in
 * whichever screen happened to render it.
 */
export interface ConnectionHealthView {
  id: string;
  name: string;
  system: SystemName;
  /**
   * The brand in words - 'Oracle NetSuite' rather than 'CUSTOM'.
   *
   * Here rather than only on the owner's view because the hub lists every
   * connection to every member, and nine different systems all reading
   * 'Custom' is a list nobody can use. It is a label, not configuration.
   */
  vendorLabel: string;
  environment: CustomerErpEnvironment;
  state: CustomerErpConnectionStateName;
  stateLabel: string;
  stateReason: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  nextPollAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  /** Queued, failed, succeeded - the chips on the dashboard. */
  eventCounts: Record<string, number>;
  pendingApprovals: number;
}

/** What an owner or integration manager sees. Adds configuration, never secrets. */
export interface ConnectionView extends ConnectionHealthView {
  apiStyle: CustomerErpApiStyle;
  /** Which named ERP this is, from the catalogue in `vendor-presets.ts`. */
  vendorPreset: string | null;
  /**
   * The brand in words, for a screen.
   *
   * Falls back to the protocol for a connection created before the catalogue
   * existed, or one whose preset has since been retired - "Custom" is a worse
   * label than "NetSuite" and a far better one than a blank.
   */
  vendorLabel: string;
  erpVersion: string | null;
  baseUrl: string;
  apiVersion: string | null;
  networkMode: CustomerErpNetworkMode;
  networkNotes: string | null;
  tenantIdentifier: string | null;
  customHeaders: Record<string, string>;
  timeoutMs: number;
  authMethod: CustomerErpAuthMethod;
  apiKeyLocation: CustomerErpApiKeyLocation | null;
  apiKeyName: string | null;
  oauthAuthorizationUrl: string | null;
  oauthTokenUrl: string | null;
  oauthScope: string | null;
  oauthUsesPlatformApp: boolean;
  mutualTlsEnabled: boolean;
  sap: {
    companyCode: string | null;
    purchasingOrg: string | null;
    purchasingGroup: string | null;
    plant: string | null;
    storageLocation: string | null;
    communicationScenario: string | null;
  };
  monday: { workspaceId: string | null; boardId: string | null; groupId: string | null };
  webhookEnabled: boolean;
  /** The address the buyer registers with their ERP. Public, unguessable. */
  webhookUrl: string | null;
  webhookSignatureHeader: string;
  webhookToleranceSeconds: number;
  pollingEnabled: boolean;
  pollingIntervalMinutes: number;
  pollingTimezone: string;
  lastPolledAt: string | null;
  mappingVerifiedAt: string | null;
  lastTestMessage: string | null;
  consecutiveFailures: number;
  /** Hints only. Never a secret - see this file's header. */
  credentials: CredentialSummary[];
  endpoints: EndpointView[];
  mappings: MappingView[];
  warehouseMaps: WarehouseMapView[];
  policy: PolicyView;
  /** Which buttons the screen should render, from the state machine. */
  actions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EndpointView {
  purpose: EndpointPurpose;
  path: string;
  method: string;
  enabled: boolean;
  pagination: CustomerErpPagination;
  paginationConfig: Record<string, unknown>;
  recordsPath: string | null;
  requestTemplate: Record<string, unknown> | null;
  queryParams: Record<string, string>;
}

export interface MappingView {
  entity: MappingEntity;
  platformField: string;
  erpPath: string;
  constantValue: string | null;
  erpValue: string | null;
  transform: TransformName | null;
  required: boolean;
}

export interface WarehouseMapView {
  inventoryLocationId: string | null;
  warehouseName: string | null;
  erpPlant: string | null;
  erpStorageLocation: string | null;
  erpBoardId: string | null;
  erpGroupId: string | null;
  isFallback: boolean;
}

export interface PolicyView {
  sourceOfTruth: string;
  mode: string;
  conflictPolicy: string;
  inventoryWriteMode: string;
  receiptOnPlatformDelivery: boolean;
  approvalThresholdMinor: string | null;
  approvalCurrency: string | null;
  approvalExpiryHours: number;
  sendPurchaseOrders: boolean;
  sendShipmentStatus: boolean;
  sendGoodsReceipts: boolean;
  sendInvoices: boolean;
  sendPaymentReferences: boolean;
  syncInventory: boolean;
}

const DEFAULT_POLICY: PolicyView = Object.freeze({
  sourceOfTruth: 'PLATFORM',
  mode: 'OUTBOUND',
  conflictPolicy: 'MANUAL',
  inventoryWriteMode: 'APPROVAL_REQUIRED',
  receiptOnPlatformDelivery: false,
  approvalThresholdMinor: null,
  approvalCurrency: null,
  approvalExpiryHours: 72,
  sendPurchaseOrders: true,
  sendShipmentStatus: true,
  sendGoodsReceipts: true,
  sendInvoices: true,
  sendPaymentReferences: true,
  syncInventory: false,
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listConnections(
  membership: Membership,
): Promise<ConnectionHealthView[]> {
  assertCapability(membership, 'VIEW');

  const rows = await prisma.customerErpConnection.findMany({
    where: { organizationId: membership.organizationId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  return Promise.all(rows.map((row) => toHealthView(row, membership.organizationId)));
}

/**
 * One connection, in the shape this member is entitled to.
 *
 * The role decides which view is BUILT, not which fields are stripped from a
 * fuller one. A `MEMBER` never has the endpoints and hints in memory, so no
 * later serialisation mistake can leak them.
 */
export async function getConnection(
  membership: Membership,
  connectionId: string,
): Promise<ConnectionHealthView | ConnectionView> {
  assertCapability(membership, 'VIEW');

  const row = await loadOwned(membership, connectionId);

  if (membership.role === 'MEMBER') {
    return toHealthView(row, membership.organizationId);
  }

  return toOwnerView(row, membership.organizationId);
}

async function loadOwned(
  membership: Membership,
  connectionId: string,
): Promise<Prisma.CustomerErpConnectionGetPayload<{
  include: {
    endpoints: true;
    fieldMappings: true;
    warehouseMaps: true;
    policy: true;
  };
}>> {
  const row = await prisma.customerErpConnection.findFirst({
    where: {
      id: connectionId,
      organizationId: membership.organizationId,
      deletedAt: null,
    },
    include: { endpoints: true, fieldMappings: true, warehouseMaps: true, policy: true },
  });

  // 404 rather than 403. Confirming that a connection exists but belongs to
  // somebody else still leaks its existence, and a connection id is guessable
  // enough to matter.
  if (row === null) throw notFound('Connection');

  return row;
}

async function toHealthView(
  row: {
    id: string;
    name: string;
    system: CustomerErpSystem;
    vendorPreset: string | null;
    environment: CustomerErpEnvironment;
    state: string;
    stateReason: string | null;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    nextPollAt: Date | null;
    lastTestAt: Date | null;
    lastTestOk: boolean | null;
  },
  organizationId: string,
): Promise<ConnectionHealthView> {
  const [eventCounts, pendingApprovals] = await Promise.all([
    countEventsByState(organizationId, row.id),
    prisma.customerErpApproval.count({
      where: { connectionId: row.id, organizationId, state: 'PENDING' },
    }),
  ]);

  const state = row.state as CustomerErpConnectionStateName;

  return {
    id: row.id,
    name: row.name,
    system: row.system,
    vendorLabel: presetById(row.vendorPreset)?.label ?? row.system,
    environment: row.environment,
    state,
    stateLabel: connectionStateLabel(state),
    stateReason: row.stateReason,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    nextPollAt: row.nextPollAt?.toISOString() ?? null,
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastTestOk: row.lastTestOk,
    eventCounts,
    pendingApprovals,
  };
}

async function toOwnerView(
  row: Prisma.CustomerErpConnectionGetPayload<{
    include: {
      endpoints: true;
      fieldMappings: true;
      warehouseMaps: true;
      policy: true;
    };
  }>,
  organizationId: string,
): Promise<ConnectionView> {
  const health = await toHealthView(row, organizationId);

  const locationIds = row.warehouseMaps
    .map((entry) => entry.inventoryLocationId)
    .filter((id): id is string => id !== null);

  const locations =
    locationIds.length === 0
      ? []
      : await prisma.inventoryLocation.findMany({
          where: { id: { in: locationIds } },
          select: { id: true, name: true },
        });

  const locationNames = new Map(locations.map((entry) => [entry.id, entry.name]));

  const preset = presetById(row.vendorPreset);

  return {
    ...health,
    apiStyle: row.apiStyle,
    vendorPreset: row.vendorPreset,
    vendorLabel: preset?.label ?? row.system,
    erpVersion: row.erpVersion,
    baseUrl: row.baseUrl,
    apiVersion: row.apiVersion,
    networkMode: row.networkMode,
    networkNotes: row.networkNotes,
    tenantIdentifier: row.tenantIdentifier,
    customHeaders: asStringMap(row.customHeadersJson),
    timeoutMs: row.timeoutMs,
    authMethod: row.authMethod,
    apiKeyLocation: row.apiKeyLocation,
    apiKeyName: row.apiKeyName,
    oauthAuthorizationUrl: row.oauthAuthorizationUrl,
    oauthTokenUrl: row.oauthTokenUrl,
    oauthScope: row.oauthScope,
    oauthUsesPlatformApp: row.oauthUsesPlatformApp,
    mutualTlsEnabled: row.mutualTlsEnabled,
    sap: {
      companyCode: row.sapCompanyCode,
      purchasingOrg: row.sapPurchasingOrg,
      purchasingGroup: row.sapPurchasingGroup,
      plant: row.sapPlant,
      storageLocation: row.sapStorageLocation,
      communicationScenario: row.sapCommunicationScenario,
    },
    monday: {
      workspaceId: row.mondayWorkspaceId,
      boardId: row.mondayBoardId,
      groupId: row.mondayGroupId,
    },
    webhookEnabled: row.webhookEnabled,
    webhookUrl: row.webhookEnabled ? webhookUrlFor(row.webhookSlug) : null,
    webhookSignatureHeader: row.webhookSignatureHeader,
    webhookToleranceSeconds: row.webhookToleranceSeconds,
    pollingEnabled: row.pollingEnabled,
    pollingIntervalMinutes: row.pollingIntervalMinutes,
    pollingTimezone: row.pollingTimezone,
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    mappingVerifiedAt: row.mappingVerifiedAt?.toISOString() ?? null,
    lastTestMessage: row.lastTestMessage,
    consecutiveFailures: row.consecutiveFailures,
    credentials: await summariseCredentials(row.id),
    endpoints: row.endpoints.map((entry) => ({
      purpose: entry.purpose,
      path: entry.path,
      method: entry.method,
      enabled: entry.enabled,
      pagination: entry.pagination,
      paginationConfig: (entry.paginationConfigJson ?? {}) as Record<string, unknown>,
      recordsPath: entry.recordsPath,
      requestTemplate: (entry.requestTemplateJson ?? null) as Record<string, unknown> | null,
      queryParams: asStringMap(entry.queryParamsJson),
    })),
    mappings: row.fieldMappings.map((entry) => ({
      entity: entry.entity,
      platformField: entry.platformField,
      erpPath: entry.erpPath,
      constantValue: entry.constantValue,
      erpValue: entry.erpValue,
      transform: entry.transform as TransformName | null,
      required: entry.required,
    })),
    warehouseMaps: row.warehouseMaps.map((entry) => ({
      inventoryLocationId: entry.inventoryLocationId,
      warehouseName:
        entry.inventoryLocationId === null
          ? null
          : (locationNames.get(entry.inventoryLocationId) ?? null),
      erpPlant: entry.erpPlant,
      erpStorageLocation: entry.erpStorageLocation,
      erpBoardId: entry.erpBoardId,
      erpGroupId: entry.erpGroupId,
      isFallback: entry.isFallback,
    })),
    policy:
      row.policy === null
        ? DEFAULT_POLICY
        : {
            sourceOfTruth: row.policy.sourceOfTruth,
            mode: row.policy.mode,
            conflictPolicy: row.policy.conflictPolicy,
            inventoryWriteMode: row.policy.inventoryWriteMode,
            receiptOnPlatformDelivery: row.policy.receiptOnPlatformDelivery,
            approvalThresholdMinor: row.policy.approvalThresholdMinor?.toString() ?? null,
            approvalCurrency: row.policy.approvalCurrency,
            approvalExpiryHours: row.policy.approvalExpiryHours,
            sendPurchaseOrders: row.policy.sendPurchaseOrders,
            sendShipmentStatus: row.policy.sendShipmentStatus,
            sendGoodsReceipts: row.policy.sendGoodsReceipts,
            sendInvoices: row.policy.sendInvoices,
            sendPaymentReferences: row.policy.sendPaymentReferences,
            syncInventory: row.policy.syncInventory,
          },
    actions: availableConnectionActions(row.state),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The address a buyer registers with their own ERP. */
function webhookUrlFor(slug: string): string {
  return `${env.API_PUBLIC_URL.replace(/\/+$/, '')}/api/v1/erp-inbound/${slug}`;
}

// ---------------------------------------------------------------------------
// Creating and updating
// ---------------------------------------------------------------------------

export interface ConnectionInput {
  name: string;
  system: SystemName;
  /** Which named ERP this is, from the catalogue. See `vendor-presets.ts`. */
  vendorPreset?: string | null;
  apiStyle?: CustomerErpApiStyle;
  environment: CustomerErpEnvironment;
  erpVersion?: string | null;
  baseUrl: string;
  apiVersion?: string | null;
  networkMode?: CustomerErpNetworkMode;
  networkNotes?: string | null;
  tenantIdentifier?: string | null;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
  authMethod: CustomerErpAuthMethod;
  apiKeyLocation?: CustomerErpApiKeyLocation | null;
  apiKeyName?: string | null;
  oauthAuthorizationUrl?: string | null;
  oauthTokenUrl?: string | null;
  oauthScope?: string | null;
  mutualTlsEnabled?: boolean;
  sapCompanyCode?: string | null;
  sapPurchasingOrg?: string | null;
  sapPurchasingGroup?: string | null;
  sapPlant?: string | null;
  sapStorageLocation?: string | null;
  sapCommunicationScenario?: string | null;
  mondayWorkspaceId?: string | null;
  mondayBoardId?: string | null;
  mondayGroupId?: string | null;
  webhookEnabled?: boolean;
  webhookSignatureHeader?: string;
  webhookToleranceSeconds?: number;
  pollingEnabled?: boolean;
  pollingIntervalMinutes?: number;
  pollingTimezone?: string;
  /**
   * Secrets. `undefined` means the form did not send this and the stored value
   * stands; an empty string clears it. See rule 2 in this file's header.
   */
  secrets?: {
    apiKey?: string;
    bearerToken?: string;
    username?: string;
    password?: string;
    clientId?: string;
    clientSecret?: string;
    personalToken?: string;
    webhookSigningSecret?: string;
    certificatePem?: string;
    privateKeyPem?: string;
    certificatePassphrase?: string;
  };
}

export async function createConnection(
  membership: Membership,
  actor: OrgActor,
  input: ConnectionInput,
): Promise<ConnectionView> {
  assertCapability(membership, 'CONFIGURE');

  const existing = await prisma.customerErpConnection.count({
    where: { organizationId: membership.organizationId, deletedAt: null },
  });

  if (existing >= env.CUSTOMER_ERP_MAX_CONNECTIONS_PER_ORG) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_LIMIT_REACHED,
      `Your organisation already has ${existing} connections, which is as many as this ` +
        'store allows. Remove one you no longer use.',
    );
  }

  const validated = validateInput(input);
  const connectionId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.customerErpConnection.create({
      data: {
        id: connectionId,
        organizationId: membership.organizationId,
        ...validated,
        state: 'DRAFT',
        // 32 bytes of CSPRNG, base64url. Not the authentication - the
        // signature is - but it keeps the endpoint from being discoverable by
        // iterating ids.
        webhookSlug: randomBytes(24).toString('base64url'),
        createdByProfileId: membership.customerProfileId,
      },
    });

    /*
     * Defaults, so the wizard's later steps are pre-filled with something that
     * stands a chance rather than with eleven empty boxes.
     *
     * The preset wins where it has an opinion, and falls back to the connector
     * where it does not. That split is what lets NetSuite and Zoho both ride
     * the CUSTOM connector and still arrive with their own paths, while SAP and
     * monday leave their presets empty and inherit the connector's - which are
     * the same list, maintained in one place.
     */
    const defaults = presetDefaults(input.vendorPreset ?? null, input.system, input.environment);

    await tx.customerErpEndpoint.createMany({
      data: defaults.endpoints.map((endpoint) => ({
        id: newId(),
        connectionId,
        purpose: endpoint.purpose,
        path: endpoint.path,
        method: endpoint.method,
        pagination: (endpoint.pagination ?? 'NONE'),
        recordsPath: endpoint.recordsPath ?? null,
      })),
      skipDuplicates: true,
    });

    await tx.customerErpFieldMapping.createMany({
      data: defaults.mappings.map((mapping) => ({
        id: newId(),
        connectionId,
        entity: mapping.entity,
        platformField: mapping.platformField,
        erpPath: mapping.erpPath,
        constantValue: mapping.constantValue,
        erpValue: mapping.erpValue,
        transform: mapping.transform,
        required:
          PLATFORM_FIELDS[mapping.entity].find(
            (spec) => spec.key === mapping.platformField,
          )?.required ?? false,
      })),
      skipDuplicates: true,
    });

    await tx.customerErpSyncPolicy.create({
      data: { id: newId(), connectionId },
    });
  });

  await writeSecrets(connectionId, input.secrets);

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'connection.created',
    resourceType: 'connection',
    resourceId: connectionId,
    actor,
    after: { name: input.name, system: input.system, environment: input.environment },
  });

  // The operator's trail as well, at a coarser grain. A tenant pointing this
  // server at a new outbound address is something whoever runs the installation
  // is entitled to know about, without being able to see the credential.
  await recordAudit({
    action: AuditAction.CUSTOMER_ERP_CONNECTION_CREATED,
    resourceType: 'customer_erp_connection',
    resourceId: connectionId,
    actorType: 'CUSTOMER',
    actorUserId: null,
    actorEmail: actor.email,
    after: {
      organizationId: membership.organizationId,
      system: input.system,
      environment: input.environment,
      host: safeHost(input.baseUrl),
    },
    correlationId: actor.correlationId ?? null,
  });

  return (await getConnection(membership, connectionId)) as ConnectionView;
}

/**
 * Change a connection's configuration.
 *
 * Lands the connection back in DRAFT through `EDIT`, and clears `lastTestOk`
 * and `mappingVerifiedAt`. That is not bureaucracy: a live connection edited
 * underneath the traffic it is carrying is how a buyer's purchase orders start
 * going to a sandbox, and what the last test proved, it proved about settings
 * that have just been replaced.
 */
export async function updateConnection(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
  input: Partial<ConnectionInput>,
): Promise<ConnectionView> {
  assertCapability(membership, 'CONFIGURE');

  const current = await loadOwned(membership, connectionId);

  const merged: ConnectionInput = {
    name: input.name ?? current.name,
    system: (input.system ?? current.system),
    // Carried explicitly. Every field in this object is, because `validateInput`
    // reads the merge rather than the row - so a field missing here is a field
    // silently cleared on every edit.
    vendorPreset:
      input.vendorPreset === undefined ? current.vendorPreset : input.vendorPreset,
    environment: input.environment ?? current.environment,
    baseUrl: input.baseUrl ?? current.baseUrl,
    authMethod: input.authMethod ?? current.authMethod,
    apiStyle: input.apiStyle ?? current.apiStyle,
    erpVersion: input.erpVersion === undefined ? current.erpVersion : input.erpVersion,
    apiVersion: input.apiVersion === undefined ? current.apiVersion : input.apiVersion,
    networkMode: input.networkMode ?? current.networkMode,
    networkNotes: input.networkNotes === undefined ? current.networkNotes : input.networkNotes,
    tenantIdentifier:
      input.tenantIdentifier === undefined ? current.tenantIdentifier : input.tenantIdentifier,
    customHeaders: input.customHeaders ?? asStringMap(current.customHeadersJson),
    timeoutMs: input.timeoutMs ?? current.timeoutMs,
    apiKeyLocation:
      input.apiKeyLocation === undefined ? current.apiKeyLocation : input.apiKeyLocation,
    apiKeyName: input.apiKeyName === undefined ? current.apiKeyName : input.apiKeyName,
    oauthAuthorizationUrl:
      input.oauthAuthorizationUrl === undefined
        ? current.oauthAuthorizationUrl
        : input.oauthAuthorizationUrl,
    oauthTokenUrl:
      input.oauthTokenUrl === undefined ? current.oauthTokenUrl : input.oauthTokenUrl,
    oauthScope: input.oauthScope === undefined ? current.oauthScope : input.oauthScope,
    mutualTlsEnabled: input.mutualTlsEnabled ?? current.mutualTlsEnabled,
    sapCompanyCode:
      input.sapCompanyCode === undefined ? current.sapCompanyCode : input.sapCompanyCode,
    sapPurchasingOrg:
      input.sapPurchasingOrg === undefined ? current.sapPurchasingOrg : input.sapPurchasingOrg,
    sapPurchasingGroup:
      input.sapPurchasingGroup === undefined
        ? current.sapPurchasingGroup
        : input.sapPurchasingGroup,
    sapPlant: input.sapPlant === undefined ? current.sapPlant : input.sapPlant,
    sapStorageLocation:
      input.sapStorageLocation === undefined
        ? current.sapStorageLocation
        : input.sapStorageLocation,
    sapCommunicationScenario:
      input.sapCommunicationScenario === undefined
        ? current.sapCommunicationScenario
        : input.sapCommunicationScenario,
    mondayWorkspaceId:
      input.mondayWorkspaceId === undefined
        ? current.mondayWorkspaceId
        : input.mondayWorkspaceId,
    mondayBoardId:
      input.mondayBoardId === undefined ? current.mondayBoardId : input.mondayBoardId,
    mondayGroupId:
      input.mondayGroupId === undefined ? current.mondayGroupId : input.mondayGroupId,
    webhookEnabled: input.webhookEnabled ?? current.webhookEnabled,
    webhookSignatureHeader: input.webhookSignatureHeader ?? current.webhookSignatureHeader,
    webhookToleranceSeconds:
      input.webhookToleranceSeconds ?? current.webhookToleranceSeconds,
    pollingEnabled: input.pollingEnabled ?? current.pollingEnabled,
    pollingIntervalMinutes: input.pollingIntervalMinutes ?? current.pollingIntervalMinutes,
    pollingTimezone: input.pollingTimezone ?? current.pollingTimezone,
  };

  const validated = validateInput(merged);

  const state = assertConnectionTransition(
    current.state,
    'EDIT',
  );

  await prisma.customerErpConnection.update({
    where: { id: connectionId },
    data: {
      ...validated,
      state,
      stateChangedAt: new Date(),
      stateReason: null,
      // Cleared, deliberately. See this function's comment.
      lastTestOk: null,
      mappingVerifiedAt: null,
      consecutiveFailures: 0,
      circuitOpenedAt: null,
    },
  });

  await writeSecrets(connectionId, input.secrets);

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'connection.updated',
    resourceType: 'connection',
    resourceId: connectionId,
    actor,
    // The values, minus anything secret - `recordOrgAudit` redacts, and
    // `validated` never contained a credential in the first place.
    before: { baseUrl: current.baseUrl, authMethod: current.authMethod, state: current.state },
    after: { baseUrl: merged.baseUrl, authMethod: merged.authMethod, state },
  });

  return (await getConnection(membership, connectionId)) as ConnectionView;
}

/**
 * The columns `validateInput` is responsible for.
 *
 * Derived from the Prisma input type rather than written out, so a column added
 * to the model is a compile error here rather than a field that silently stops
 * being validated. The five it excludes are the ones this service sets itself:
 * the identity, the tenant, the webhook slug, the state and who created it.
 */
type ValidatedConnectionFields = Omit<
  Prisma.CustomerErpConnectionUncheckedCreateInput,
  'id' | 'organizationId' | 'webhookSlug' | 'state' | 'createdByProfileId'
>;

/**
 * Everything that has to be true of a connection's own fields.
 *
 * Runs on create and on every update, and calls into the connector so each
 * system can refuse what it cannot honour - a monday personal token on a
 * production connection, an SAP connection with no company code. Every refusal
 * names a legitimate alternative, because "invalid" is not an instruction.
 */
function validateInput(input: ConnectionInput): ValidatedConnectionFields {
  const name = input.name.trim();

  if (name.length === 0 || name.length > 128) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give this connection a name.', [
      { field: 'name', code: 'INVALID_LENGTH' },
    ]);
  }

  // The address checks: https only, no credentials in the URL, a host that is
  // not private or link-local, and the operator's allowlist where there is one.
  // Resolution happens again immediately before every request - see
  // `outbound-http.ts`.
  const baseUrl = assertSafeErpUrl(input.baseUrl.trim(), {
    field: 'baseUrl',
    errorCode: ErrorCode.CUSTOMER_ERP_URL_NOT_ALLOWED,
    ...(hostPolicy() === undefined ? {} : { allowedHostSuffixes: hostPolicy() as string[] }),
  });

  for (const [field, value] of [
    ['oauthTokenUrl', input.oauthTokenUrl],
    ['oauthAuthorizationUrl', input.oauthAuthorizationUrl],
  ] as const) {
    if (value === null || value === undefined || value.trim().length === 0) continue;

    assertSafeErpUrl(value.trim(), {
      field,
      errorCode: ErrorCode.CUSTOMER_ERP_URL_NOT_ALLOWED,
      ...(hostPolicy() === undefined ? {} : { allowedHostSuffixes: hostPolicy() as string[] }),
    });
  }

  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 20000, 1000), 60000);
  const pollingIntervalMinutes = Math.min(
    Math.max(input.pollingIntervalMinutes ?? 60, 5),
    10080,
  );
  const webhookToleranceSeconds = Math.min(
    Math.max(input.webhookToleranceSeconds ?? 300, 30),
    3600,
  );

  // A header carrying a secret belongs in the vault, not in a column the API
  // returns. Filtered rather than trusted.
  const customHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.customHeaders ?? {})) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(key)) continue;
    if (['authorization', 'cookie', 'host'].includes(key.toLowerCase())) continue;
    customHeaders[key] = String(value).slice(0, 1024);
  }

  // monday's production path uses the OPERATOR's registered app, so the buyer
  // never types a client secret. That is a property of the combination rather
  // than of either field, which is why it is derived here.
  const oauthUsesPlatformApp =
    input.system === 'MONDAY' &&
    input.authMethod === 'OAUTH2_AUTHORIZATION_CODE' &&
    env.MONDAY_OAUTH_CLIENT_ID.length > 0;

  connectorFor(input.system).validateConfiguration({
    environment: input.environment,
    authMethod: input.authMethod,
    apiStyle: input.apiStyle ?? 'REST_JSON',
    baseUrl: baseUrl.toString(),
    sap: {
      companyCode: nullish(input.sapCompanyCode),
      purchasingOrg: nullish(input.sapPurchasingOrg),
      purchasingGroup: nullish(input.sapPurchasingGroup),
      plant: nullish(input.sapPlant),
      storageLocation: nullish(input.sapStorageLocation),
      communicationScenario: nullish(input.sapCommunicationScenario),
    },
    monday: {
      workspaceId: nullish(input.mondayWorkspaceId),
      boardId: nullish(input.mondayBoardId),
      groupId: nullish(input.mondayGroupId),
    },
    oauthTokenUrl: nullish(input.oauthTokenUrl),
    oauthAuthorizationUrl: nullish(input.oauthAuthorizationUrl),
    mutualTlsEnabled: input.mutualTlsEnabled ?? false,
  });

  if (input.authMethod === 'API_KEY') {
    const keyName = nullish(input.apiKeyName);
    if (keyName === null) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Enter the header or parameter name your system expects the key in.',
        [{ field: 'apiKeyName', code: 'REQUIRED' }],
      );
    }
  }

  return {
    name,
    system: input.system,
    vendorPreset: nullish(input.vendorPreset),
    apiStyle: (input.apiStyle ?? 'REST_JSON'),
    environment: input.environment,
    erpVersion: nullish(input.erpVersion),
    baseUrl: baseUrl.toString().replace(/\/+$/, ''),
    apiVersion: nullish(input.apiVersion),
    networkMode: input.networkMode ?? 'PUBLIC_HTTPS',
    networkNotes: nullish(input.networkNotes),
    tenantIdentifier: nullish(input.tenantIdentifier),
    customHeadersJson: customHeaders,
    timeoutMs,
    authMethod: input.authMethod,
    apiKeyLocation: input.authMethod === 'API_KEY' ? (input.apiKeyLocation ?? 'HEADER') : null,
    apiKeyName: input.authMethod === 'API_KEY' ? nullish(input.apiKeyName) : null,
    oauthAuthorizationUrl: nullish(input.oauthAuthorizationUrl),
    oauthTokenUrl: nullish(input.oauthTokenUrl),
    oauthScope: nullish(input.oauthScope),
    oauthUsesPlatformApp,
    mutualTlsEnabled: input.mutualTlsEnabled ?? false,
    sapCompanyCode: nullish(input.sapCompanyCode),
    sapPurchasingOrg: nullish(input.sapPurchasingOrg),
    sapPurchasingGroup: nullish(input.sapPurchasingGroup),
    sapPlant: nullish(input.sapPlant),
    sapStorageLocation: nullish(input.sapStorageLocation),
    sapCommunicationScenario: nullish(input.sapCommunicationScenario),
    mondayWorkspaceId: nullish(input.mondayWorkspaceId),
    mondayBoardId: nullish(input.mondayBoardId),
    mondayGroupId: nullish(input.mondayGroupId),
    webhookEnabled: input.webhookEnabled ?? false,
    webhookSignatureHeader: input.webhookSignatureHeader ?? 'X-UBOSS-Signature',
    webhookToleranceSeconds,
    pollingEnabled: input.pollingEnabled ?? false,
    pollingIntervalMinutes,
    pollingTimezone: input.pollingTimezone ?? 'UTC',
  };
}

/**
 * Write whichever secrets the form actually sent.
 *
 * Rule 2 in action: `undefined` keeps what is stored, an empty string clears
 * it. A `??` here instead of the explicit `undefined` checks would collapse
 * those two, and a buyer changing the timeout would silently wipe their SAP
 * client secret.
 */
async function writeSecrets(
  connectionId: string,
  secrets: ConnectionInput['secrets'],
): Promise<void> {
  if (secrets === undefined) return;

  await mergePrimaryCredential(connectionId, {
    apiKey: secrets.apiKey,
    bearerToken: secrets.bearerToken,
    username: secrets.username,
    password: secrets.password,
    clientId: secrets.clientId,
    clientSecret: secrets.clientSecret,
    personalToken: secrets.personalToken,
  });

  if (secrets.webhookSigningSecret !== undefined) {
    if (secrets.webhookSigningSecret.length === 0) {
      await deleteCredential(connectionId, 'WEBHOOK_SIGNING');
    } else {
      await saveCredential({
        connectionId,
        kind: 'WEBHOOK_SIGNING',
        payload: { signingSecret: secrets.webhookSigningSecret },
      });
    }
  }

  if (secrets.certificatePem !== undefined || secrets.privateKeyPem !== undefined) {
    const certificate = (secrets.certificatePem ?? '').trim();
    const key = (secrets.privateKeyPem ?? '').trim();

    if (certificate.length === 0 && key.length === 0) {
      await deleteCredential(connectionId, 'CLIENT_CERTIFICATE');
    } else {
      // Both or neither. A certificate without its key cannot complete a
      // handshake, and storing half of one would produce a TLS failure whose
      // message blames the buyer's server.
      if (certificate.length === 0 || key.length === 0) {
        throw badRequest(
          ErrorCode.VALIDATION_FAILED,
          'A client certificate needs both the certificate and its private key.',
          [{ field: 'secrets.privateKeyPem', code: 'REQUIRED' }],
        );
      }

      await saveCredential({
        connectionId,
        kind: 'CLIENT_CERTIFICATE',
        payload: {
          certificatePem: certificate,
          privateKeyPem: key,
          ...(secrets.certificatePassphrase === undefined ||
          secrets.certificatePassphrase.length === 0
            ? {}
            : { passphrase: secrets.certificatePassphrase }),
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Endpoints, mappings, warehouses, policy
// ---------------------------------------------------------------------------

export interface EndpointInput {
  purpose: EndpointPurpose;
  path: string;
  method: string;
  enabled?: boolean;
  pagination?: CustomerErpPagination;
  paginationConfig?: Record<string, unknown>;
  recordsPath?: string | null;
  requestTemplate?: Record<string, unknown> | null;
  queryParams?: Record<string, string>;
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export async function saveEndpoints(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
  endpoints: readonly EndpointInput[],
): Promise<ConnectionView> {
  assertCapability(membership, 'CONFIGURE');

  const connection = await loadOwned(membership, connectionId);

  for (const [index, endpoint] of endpoints.entries()) {
    const method = endpoint.method.toUpperCase();

    if (!ALLOWED_METHODS.has(method)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, `${method} is not a method we can use.`, [
        { field: `endpoints.${index}.method`, code: 'INVALID_METHOD' },
      ]);
    }

    // Same-origin, checked here so a typo is a form error rather than a job
    // that fails an hour later. Checked again before every call, because
    // nothing guarantees the row was written by this path.
    resolveEndpointUrl(connection.baseUrl, endpoint.path, `endpoints.${index}.path`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.customerErpEndpoint.deleteMany({ where: { connectionId } });

    await tx.customerErpEndpoint.createMany({
      data: endpoints.map((endpoint) => ({
        id: newId(),
        connectionId,
        purpose: endpoint.purpose,
        path: endpoint.path.trim(),
        method: endpoint.method.toUpperCase(),
        enabled: endpoint.enabled ?? true,
        pagination: endpoint.pagination ?? 'NONE',
        paginationConfigJson: (endpoint.paginationConfig ?? {}) as Prisma.InputJsonValue,
        recordsPath: endpoint.recordsPath ?? null,
        requestTemplateJson: (endpoint.requestTemplate ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        queryParamsJson: (endpoint.queryParams ?? {}),
      })),
      skipDuplicates: true,
    });

    // Endpoints are part of what a test proved. Changing them invalidates it.
    await tx.customerErpConnection.update({
      where: { id: connectionId },
      data: { mappingVerifiedAt: null },
    });
  });

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'endpoint.saved',
    resourceType: 'endpoint',
    resourceId: connectionId,
    actor,
    after: { count: endpoints.length, purposes: endpoints.map((entry) => entry.purpose) },
  });

  return (await getConnection(membership, connectionId)) as ConnectionView;
}

export async function saveMappings(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
  mappings: readonly MappingRow[],
): Promise<ConnectionView> {
  assertCapability(membership, 'CONFIGURE');
  await loadOwned(membership, connectionId);

  assertMappingValid(mappings);

  await prisma.$transaction(async (tx) => {
    await tx.customerErpFieldMapping.deleteMany({ where: { connectionId } });

    await tx.customerErpFieldMapping.createMany({
      data: mappings.map((mapping) => ({
        id: newId(),
        connectionId,
        entity: mapping.entity,
        platformField: mapping.platformField,
        erpPath: mapping.erpPath.trim(),
        constantValue: mapping.constantValue,
        erpValue: mapping.erpValue,
        transform: mapping.transform,
        required:
          PLATFORM_FIELDS[mapping.entity].find((spec) => spec.key === mapping.platformField)
            ?.required ?? false,
      })),
      skipDuplicates: true,
    });

    // A mapping that changed has not been checked against a real response.
    await tx.customerErpConnection.update({
      where: { id: connectionId },
      data: { mappingVerifiedAt: null },
    });
  });

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'mapping.saved',
    resourceType: 'mapping',
    resourceId: connectionId,
    actor,
    after: { count: mappings.length },
  });

  return (await getConnection(membership, connectionId)) as ConnectionView;
}

export interface WarehouseMapInput {
  inventoryLocationId: string | null;
  erpPlant?: string | null;
  erpStorageLocation?: string | null;
  erpBoardId?: string | null;
  erpGroupId?: string | null;
  isFallback?: boolean;
}

export async function saveWarehouseMaps(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
  maps: readonly WarehouseMapInput[],
): Promise<ConnectionView> {
  assertCapability(membership, 'CONFIGURE');
  await loadOwned(membership, connectionId);

  // At most one fallback. Enforced here because a MariaDB UNIQUE treats every
  // NULL as distinct, so the index on (connectionId, inventoryLocationId)
  // cannot express it - see the model comment.
  const fallbacks = maps.filter((entry) => entry.isFallback === true);

  if (fallbacks.length > 1) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Only one warehouse mapping can be the fallback.',
      [{ field: 'warehouseMaps', code: 'MULTIPLE_FALLBACKS' }],
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.customerErpWarehouseMap.deleteMany({ where: { connectionId } });

    await tx.customerErpWarehouseMap.createMany({
      data: maps.map((entry) => ({
        id: newId(),
        connectionId,
        inventoryLocationId: entry.isFallback === true ? null : entry.inventoryLocationId,
        erpPlant: entry.erpPlant ?? null,
        erpStorageLocation: entry.erpStorageLocation ?? null,
        erpBoardId: entry.erpBoardId ?? null,
        erpGroupId: entry.erpGroupId ?? null,
        isFallback: entry.isFallback ?? false,
      })),
      skipDuplicates: true,
    });
  });

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'warehouse_map.saved',
    resourceType: 'warehouse_map',
    resourceId: connectionId,
    actor,
    after: { count: maps.length },
  });

  return (await getConnection(membership, connectionId)) as ConnectionView;
}

export interface PolicyInput {
  sourceOfTruth?: string;
  mode?: string;
  conflictPolicy?: string;
  inventoryWriteMode?: string;
  receiptOnPlatformDelivery?: boolean;
  approvalThresholdMinor?: string | null;
  approvalCurrency?: string | null;
  approvalExpiryHours?: number;
  sendPurchaseOrders?: boolean;
  sendShipmentStatus?: boolean;
  sendGoodsReceipts?: boolean;
  sendInvoices?: boolean;
  sendPaymentReferences?: boolean;
  syncInventory?: boolean;
}

export async function savePolicy(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
  input: PolicyInput,
): Promise<ConnectionView> {
  assertCapability(membership, 'CONFIGURE');

  const connection = await loadOwned(membership, connectionId);

  // A threshold is an amount in a currency. One without the other cannot be
  // compared to anything, and the comparison is the only thing it is for.
  if (
    input.approvalThresholdMinor !== undefined &&
    input.approvalThresholdMinor !== null &&
    (input.approvalCurrency ?? connection.policy?.approvalCurrency ?? null) === null
  ) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Choose the currency your approval threshold is in.',
      [{ field: 'approvalCurrency', code: 'REQUIRED' }],
    );
  }

  // A sandbox connection may raise purchase orders in a test system all day and
  // must never be what decides how much stock the buyer believes they have.
  const inventoryWriteMode =
    connection.environment === 'SANDBOX'
      ? 'APPROVAL_REQUIRED'
      : (input.inventoryWriteMode ?? connection.policy?.inventoryWriteMode ?? 'APPROVAL_REQUIRED');

  if (
    connection.environment === 'SANDBOX' &&
    input.inventoryWriteMode === 'AUTOMATIC'
  ) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
      'A sandbox connection cannot write stock automatically. It can raise purchase ' +
        'orders in your test system, but what it believes about stock must not become ' +
        'what you believe about stock.',
    );
  }

  /*
   * Reading stock back from a connection that only sends.
   *
   * `mode` and `syncInventory` are two answers to one question, and this pair
   * contradicts itself: OUTBOUND means we never read their ERP, so a stock sync
   * would call their system, be handed their figures, and throw every one of
   * them away. Accepting it silently is the worst outcome available - the
   * dashboard reports a successful sync that recorded nothing, every fifteen
   * minutes, and the buyer has no way to tell that from an ERP with no stock in
   * it.
   *
   * Refused rather than quietly widened to BIDIRECTIONAL. Direction is a
   * decision about whose numbers are allowed to change whose, and moving it on
   * somebody's behalf because a checkbox implied it is not a decision this code
   * gets to make.
   */
  const mode = input.mode ?? connection.policy?.mode ?? 'OUTBOUND';
  const syncInventory = input.syncInventory ?? connection.policy?.syncInventory ?? false;

  if (syncInventory && mode === 'OUTBOUND') {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
      'This connection is set to send only, so stock cannot be read back from it. ' +
        'Either switch stock syncing off, or change the direction to two-way and choose ' +
        'whose figure wins when they disagree.',
    );
  }

  const data = {
    ...(input.sourceOfTruth === undefined ? {} : { sourceOfTruth: input.sourceOfTruth as never }),
    ...(input.mode === undefined ? {} : { mode: input.mode as never }),
    ...(input.conflictPolicy === undefined
      ? {}
      : { conflictPolicy: input.conflictPolicy as never }),
    inventoryWriteMode: inventoryWriteMode as never,
    ...(input.receiptOnPlatformDelivery === undefined
      ? {}
      : { receiptOnPlatformDelivery: input.receiptOnPlatformDelivery }),
    ...(input.approvalThresholdMinor === undefined
      ? {}
      : {
          approvalThresholdMinor:
            input.approvalThresholdMinor === null
              ? null
              : BigInt(input.approvalThresholdMinor),
        }),
    ...(input.approvalCurrency === undefined ? {} : { approvalCurrency: input.approvalCurrency }),
    ...(input.approvalExpiryHours === undefined
      ? {}
      : { approvalExpiryHours: Math.min(Math.max(input.approvalExpiryHours, 1), 720) }),
    ...(input.sendPurchaseOrders === undefined
      ? {}
      : { sendPurchaseOrders: input.sendPurchaseOrders }),
    ...(input.sendShipmentStatus === undefined
      ? {}
      : { sendShipmentStatus: input.sendShipmentStatus }),
    ...(input.sendGoodsReceipts === undefined
      ? {}
      : { sendGoodsReceipts: input.sendGoodsReceipts }),
    ...(input.sendInvoices === undefined ? {} : { sendInvoices: input.sendInvoices }),
    ...(input.sendPaymentReferences === undefined
      ? {}
      : { sendPaymentReferences: input.sendPaymentReferences }),
    ...(input.syncInventory === undefined ? {} : { syncInventory: input.syncInventory }),
  };

  await prisma.customerErpSyncPolicy.upsert({
    where: { connectionId },
    create: { id: newId(), connectionId, ...data },
    update: data,
  });

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'policy.updated',
    resourceType: 'policy',
    resourceId: connectionId,
    actor,
    after: { ...input, inventoryWriteMode },
  });

  return (await getConnection(membership, connectionId)) as ConnectionView;
}

// ---------------------------------------------------------------------------
// Testing
// ---------------------------------------------------------------------------

export interface TestResult {
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  message: string;
  /** A record from the buyer's own system, for the mapping check. */
  sample: unknown;
  /** How the mapping fared against that record, when there was one. */
  mapping: SampleCheckResult | null;
}

/**
 * Call the buyer's ERP and see what happens.
 *
 * Moves through TESTING and back to DRAFT whatever the outcome - the OUTCOME is
 * recorded in `lastTestOk` rather than in the state, because a failed test
 * leaves a draft a draft. Marking it FAILED would say repeated failures took a
 * working connection out of service, and nothing of the sort happened.
 *
 * A test is always a READ. A test that created a purchase order to prove it
 * could is a test nobody dares press twice.
 */
export async function testConnection(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
): Promise<TestResult> {
  assertCapability(membership, 'OPERATE');

  const current = await loadOwned(membership, connectionId);
  const log = loggerFor(actor.correlationId ?? newId(), { connectionId });

  // One test at a time. Held in the row so a second tab pressing the button
  // does not race the first and overwrite its result.
  const testingState = assertConnectionTransition(
    current.state,
    'START_TEST',
  );

  await prisma.customerErpConnection.update({
    where: { id: connectionId },
    data: { state: testingState, stateChangedAt: new Date() },
  });

  let result: TestResult;

  try {
    const { connector, context } = await loadConnectorContext({
      connectionId,
      organizationId: membership.organizationId,
    });

    const outcome = await connector.test(context);

    const mapping =
      outcome.sample === null
        ? null
        : verifyAgainstSample(context.mappings, inferEntity(current), outcome.sample);

    result = {
      ok: outcome.ok,
      httpStatus: outcome.httpStatus,
      durationMs: outcome.durationMs,
      message: outcome.message,
      sample: outcome.sample,
      mapping,
    };
  } catch (error) {
    log.warn({ err: error }, 'a buyer ERP connection test failed');

    result = {
      ok: false,
      httpStatus: error instanceof ErpCallError ? error.httpStatus : null,
      durationMs: 0,
      message: safeErrorMessage(error),
      sample: null,
      mapping: null,
    };
  }

  // Back to DRAFT either way. The outcome lives in the columns.
  await prisma.customerErpConnection.update({
    where: { id: connectionId },
    data: {
      state: assertConnectionTransition(testingState, 'TEST_FINISHED'),
      stateChangedAt: new Date(),
      lastTestAt: new Date(),
      lastTestOk: result.ok,
      lastTestHttpStatus: result.httpStatus,
      lastTestDurationMs: result.durationMs,
      lastTestMessage: result.message.slice(0, 512),
      stateReason: result.ok ? null : result.message.slice(0, 512),
      ...(result.ok ? { consecutiveFailures: 0, circuitOpenedAt: null } : {}),
      // A passing test whose mapping also checked out is what activation needs.
      // Both, not either: credentials that work against a mapping that finds
      // nothing is a connection that will raise empty purchase orders.
      ...(result.ok && result.mapping?.ok === true ? { mappingVerifiedAt: new Date() } : {}),
    },
  });

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'connection.tested',
    resourceType: 'connection',
    resourceId: connectionId,
    actor,
    after: { ok: result.ok, httpStatus: result.httpStatus, message: result.message },
  });

  return result;
}

/**
 * Which entity a test's sample record is about.
 *
 * The test reads products where there is a products endpoint and inventory
 * otherwise, so the mapping is checked against the entity the sample actually
 * came from. Checking an inventory record against the ORDER mapping would
 * report every order field as missing, which is a problem with the question.
 */
function inferEntity(connection: { endpoints: { purpose: string }[] }): MappingEntity {
  return connection.endpoints.some((entry) => entry.purpose === 'PRODUCTS')
    ? 'PRODUCT'
    : 'INVENTORY';
}

/**
 * A dry run: read, map, report, write nothing anywhere.
 *
 * The rehearsal that lets a buyer check a mapping without moving a number in
 * either system. Distinct from a test in that it exercises the ACTUAL sync
 * path and reports per-field results across a page of records rather than one.
 */
export async function dryRun(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
): Promise<{
  records: number;
  mapping: SampleCheckResult | null;
  message: string;
}> {
  assertCapability(membership, 'OPERATE');
  const current = await loadOwned(membership, connectionId);

  const { connector, context } = await loadConnectorContext({
    connectionId,
    organizationId: membership.organizationId,
  });

  const jobId = newId();
  const correlationId = actor.correlationId ?? newId();

  await prisma.customerErpSyncJob.create({
    data: {
      id: jobId,
      connectionId,
      organizationId: membership.organizationId,
      trigger: 'MANUAL',
      status: 'RUNNING',
      isDryRun: true,
      correlationId,
      startedByProfileId: membership.customerProfileId,
    },
  });

  try {
    const page = await connector.readInventory(context, null);

    const mapping =
      page.records.length === 0
        ? null
        : verifyAgainstSample(context.mappings, 'INVENTORY', page.records[0]?.raw ?? null);

    await prisma.customerErpSyncJob.update({
      where: { id: jobId },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        processedCount: page.records.length,
        // A dry run applies nothing, so everything it read is skipped. Counted
        // this way rather than as "succeeded" so the number in the log means
        // the same thing it means on a real run.
        skippedCount: page.records.length,
      },
    });

    await prisma.customerErpConnection.update({
      where: { id: connectionId },
      data: mapping?.ok === true ? { mappingVerifiedAt: new Date() } : {},
    });

    await recordOrgAudit({
      organizationId: membership.organizationId,
      connectionId,
      action: 'mapping.verified',
      resourceType: 'connection',
      resourceId: connectionId,
      actor,
      after: { records: page.records.length, ok: mapping?.ok ?? false },
    });

    return {
      records: page.records.length,
      mapping,
      message:
        page.records.length === 0
          ? 'Your system answered, and returned no records to check the mapping against.'
          : mapping?.ok === true
            ? `Read ${page.records.length} records and every required field was found. ` +
              'Nothing was written to either system.'
            : `Read ${page.records.length} records. Some mapped fields were not found - ` +
              'see the list. Nothing was written to either system.',
    };
  } catch (error) {
    await prisma.customerErpSyncJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorCode: error instanceof ErpCallError ? error.kind : 'UNKNOWN',
        errorMessage: safeErrorMessage(error).slice(0, 1024),
      },
    });

    throw error;
  } finally {
    // `current` is read to keep the connection's own name available for the
    // audit trail even when the read above threw.
    void current;
  }
}

// ---------------------------------------------------------------------------
// State changes
// ---------------------------------------------------------------------------

export async function activateConnection(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
): Promise<ConnectionView> {
  assertCapability(membership, 'CONFIGURE');

  const current = await loadOwned(membership, connectionId);

  const state = assertConnectionTransition(
    current.state,
    'ACTIVATE',
  );

  // What the policy says will be sent has to have somewhere to go.
  const policy = current.policy;
  const required: { purpose: EndpointPurpose; label: string; wanted: boolean }[] = [
    {
      purpose: 'PURCHASE_ORDER_CREATE',
      label: 'purchase orders',
      wanted: policy?.sendPurchaseOrders ?? true,
    },
    {
      purpose: 'GOODS_RECEIPT',
      label: 'goods receipts',
      wanted: policy?.sendGoodsReceipts ?? false,
    },
    { purpose: 'INVOICE', label: 'invoices', wanted: policy?.sendInvoices ?? false },
    { purpose: 'INVENTORY', label: 'stock', wanted: policy?.syncInventory ?? false },
  ];

  const configured = new Set(
    current.endpoints.filter((entry) => entry.enabled).map((entry) => entry.purpose),
  );

  const missingEndpoints = required
    .filter((entry) => entry.wanted && !configured.has(entry.purpose))
    .map((entry) => entry.label);

  assertReadyToActivate({
    lastTestOk: current.lastTestOk,
    mappingVerifiedAt: current.mappingVerifiedAt,
    missingEndpoints,
  });

  // And the mapping has to name everything that cannot be omitted.
  const entities: MappingEntity[] = ['ORDER'];
  if (policy?.sendInvoices === true) entities.push('INVOICE');
  if (policy?.syncInventory === true) entities.push('INVENTORY');
  if (policy?.sendPaymentReferences === true) entities.push('PAYMENT');

  const mappings: MappingRow[] = current.fieldMappings.map((row) => ({
    entity: row.entity,
    platformField: row.platformField,
    erpPath: row.erpPath,
    constantValue: row.constantValue,
    erpValue: row.erpValue,
    transform: row.transform as TransformName | null,
    required: row.required,
  }));

  const missingFields = missingRequiredFields(mappings, entities);

  if (missingFields.length > 0) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_MAPPING_INVALID,
      `These have to be mapped before this connection can be switched on: ${missingFields.join(
        ', ',
      )}.`,
    );
  }

  // A webhook-enabled connection with no signing secret accepts nothing, and a
  // buyer who switched webhooks on expects them to work. Refused now rather
  // than discovered as silence later.
  if (current.webhookEnabled && !(await hasCredential(connectionId, 'WEBHOOK_SIGNING'))) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_CONFIGURATION_REFUSED,
      'Webhooks are switched on but no signing secret is set. We do not accept unsigned ' +
        'deliveries, so nothing would arrive. Add the secret, or switch webhooks off.',
    );
  }

  await prisma.customerErpConnection.update({
    where: { id: connectionId },
    data: {
      state,
      stateChangedAt: new Date(),
      stateReason: null,
      consecutiveFailures: 0,
      circuitOpenedAt: null,
      // The first poll is due immediately, so a buyer who switches polling on
      // sees something happen rather than waiting an hour to find out it works.
      ...(current.pollingEnabled ? { nextPollAt: new Date() } : {}),
    },
  });

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'connection.activated',
    resourceType: 'connection',
    resourceId: connectionId,
    actor,
    before: { state: current.state },
    after: { state },
  });

  return (await getConnection(membership, connectionId)) as ConnectionView;
}

/**
 * Pause, resume, reconnect.
 *
 * One function for the three because they differ only in which transition they
 * ask for, and three near-identical functions is three places for the audit
 * action to drift from the thing that happened.
 */
export async function changeConnectionState(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
  action: 'PAUSE' | 'RESUME' | 'RECONNECT',
): Promise<ConnectionView> {
  assertCapability(membership, 'CONFIGURE');

  const current = await loadOwned(membership, connectionId);
  const state = assertConnectionTransition(
    current.state,
    action,
  );

  await prisma.customerErpConnection.update({
    where: { id: connectionId },
    data: {
      state,
      stateChangedAt: new Date(),
      stateReason: null,
      ...(action === 'RESUME' || action === 'RECONNECT'
        ? { consecutiveFailures: 0, circuitOpenedAt: null }
        : {}),
      // Pausing stops the poller as well as the dispatcher. The dispatcher
      // checks the state on every attempt - see `dispatchEvent` - and this is
      // the poller's half of the same promise.
      ...(action === 'PAUSE' ? { nextPollAt: null } : {}),
      ...(action === 'RESUME' && current.pollingEnabled ? { nextPollAt: new Date() } : {}),
    },
  });

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action:
      action === 'PAUSE'
        ? 'connection.paused'
        : action === 'RESUME'
          ? 'connection.resumed'
          : 'connection.reconnected',
    resourceType: 'connection',
    resourceId: connectionId,
    actor,
    before: { state: current.state },
    after: { state },
  });

  return (await getConnection(membership, connectionId)) as ConnectionView;
}

/**
 * Disconnect: stop everything and destroy the credentials.
 *
 * The row survives, because the events that reference it still have to read
 * back - a buyer asking "what happened to the purchase order for order 1234"
 * six months later deserves an answer. What does not survive is any standing
 * authority against their system: the tokens are revoked where the ERP offers
 * an endpoint for it, and every credential row is deleted either way.
 */
export async function disconnectConnection(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
): Promise<ConnectionView> {
  assertCapability(membership, 'CONFIGURE');

  const current = await loadOwned(membership, connectionId);
  const state = assertConnectionTransition(
    current.state,
    'DISCONNECT',
  );

  await revokeTokens({
    id: current.id,
    organizationId: current.organizationId,
    system: current.system,
    authMethod: current.authMethod,
    oauthAuthorizationUrl: current.oauthAuthorizationUrl,
    oauthTokenUrl: current.oauthTokenUrl,
    oauthScope: current.oauthScope,
    oauthUsesPlatformApp: current.oauthUsesPlatformApp,
    timeoutMs: current.timeoutMs,
  }).catch(() => undefined);

  const destroyed = await purgeCredentials(connectionId);

  await prisma.customerErpConnection.update({
    where: { id: connectionId },
    data: {
      state,
      stateChangedAt: new Date(),
      stateReason: 'Disconnected. Credentials were deleted.',
      nextPollAt: null,
      pollCursor: null,
      lastTestOk: null,
      mappingVerifiedAt: null,
    },
  });

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'connection.disconnected',
    resourceType: 'connection',
    resourceId: connectionId,
    actor,
    before: { state: current.state },
    // The COUNT, never the credentials. "Three credentials were destroyed" is
    // the fact with evidential value.
    after: { state, credentialsDestroyed: destroyed },
  });

  return (await getConnection(membership, connectionId)) as ConnectionView;
}

/**
 * Remove a connection.
 *
 * Soft delete, and the credentials go for good. A connection with events behind
 * it is retired rather than erased, so the ledger still explains what became of
 * an order - which is the same reasoning the seller-side connection uses, and
 * matters more here because the events belong to somebody who may need to prove
 * what was sent.
 */
export async function deleteConnection(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
): Promise<void> {
  assertCapability(membership, 'CONFIGURE');

  const current = await loadOwned(membership, connectionId);

  await purgeCredentials(connectionId);

  await prisma.customerErpConnection.update({
    where: { id: connectionId },
    data: {
      state: 'DISCONNECTED',
      stateChangedAt: new Date(),
      stateReason: 'Removed.',
      deletedAt: new Date(),
      nextPollAt: null,
      // Freed so the buyer can reuse the name. The unique is on
      // (organizationId, name), and a retired connection holding a name for
      // ever would mean "Production SAP" could never be created again.
      name: `${current.name} (removed ${new Date().toISOString().slice(0, 10)})`.slice(0, 128),
    },
  });

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'connection.deleted',
    resourceType: 'connection',
    resourceId: connectionId,
    actor,
    before: { name: current.name, state: current.state },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The defaults a new connection starts with: the preset's where it has them,
 * the connector's where it does not.
 *
 * A preset with no endpoints and no mappings of its own is not an unfinished
 * preset - it is one whose connector already owns that list. SAP and monday are
 * like that, and duplicating their paths into the catalogue would be two lists
 * to keep in step for no gain. NetSuite, Zoho, Business One and the rest carry
 * their own, because the CUSTOM connector has no idea what a purchase order
 * looks like in any of them.
 */
function presetDefaults(
  vendorPreset: string | null,
  system: SystemName,
  environment: CustomerErpEnvironment,
): ConnectorDefaults {
  const connectorDefaults = connectorFor(system).defaults(environment);
  const preset = presetById(vendorPreset);

  if (preset === null) return connectorDefaults;

  return {
    ...connectorDefaults,
    apiStyle: preset.apiStyle,
    authMethods: preset.authMethods,
    endpoints: preset.endpoints.length > 0 ? preset.endpoints : connectorDefaults.endpoints,
    mappings: preset.mappings.length > 0 ? preset.mappings : connectorDefaults.mappings,
    networkNotes: preset.notes,
  };
}

function nullish(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asStringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

/** The host, for the operator's audit trail. Never the path, never a query. */
function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return 'unparseable';
  }
}
