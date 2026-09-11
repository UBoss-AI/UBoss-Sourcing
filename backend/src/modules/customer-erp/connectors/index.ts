/**
 * The connector registry, and the context loader that feeds it.
 *
 * Two things live here and they belong together: picking the right connector
 * for a connection, and assembling everything that connector is given. The
 * loader is the ONLY place in this feature that reads a connection's endpoints,
 * mappings and credentials into one object, which is what makes it the one
 * place a tenant scope could be forgotten - and therefore the one place worth
 * reading carefully.
 */
import { ErrorCode, notFound } from '../../../domain/errors.js';
import { prisma } from '../../../infra/prisma.js';
import { conflict } from '../../../domain/errors.js';
import { toAuthMethodName, type ErpCallContext } from '../http.js';
import { getAccessToken, type OAuthConnectionContext } from '../oauth.service.js';
import type { MappingRow, TransformName } from '../mapping.service.js';
import { customConnector } from './custom.connector.js';
import { mondayConnector } from './monday.connector.js';
import { odooConnector } from './odoo.connector.js';
import { sapConnector } from './sap.connector.js';
import {
  toEndpointPurpose,
  type Connector,
  type ConnectorContext,
  type EndpointConfig,
  type EndpointPurpose,
  type PaginationConfig,
  type SystemName,
} from './types.js';

/**
 * The four protocols, not the twenty brands.
 *
 * A brand with a REST or OData API is a preset on top of CUSTOM - see
 * `vendor-presets.ts`. A member only appears here when the wire protocol is
 * genuinely different, which is true of exactly these four.
 */
const REGISTRY: Readonly<Record<SystemName, Connector>> = Object.freeze({
  SAP: sapConnector,
  MONDAY: mondayConnector,
  ODOO: odooConnector,
  CUSTOM: customConnector,
});

export function connectorFor(system: SystemName): Connector {
  return REGISTRY[system];
}

/** For the wizard's first step: what this deployment can connect to. */
export function availableSystems(): SystemName[] {
  return Object.keys(REGISTRY) as SystemName[];
}

/**
 * Assemble everything one operation needs, in one read.
 *
 * `organizationId` is required and is compared against the row rather than
 * merely used to find it. That looks redundant - the `where` already scopes by
 * it - and it is not: this function is called from a dozen places, and a future
 * caller that passes a connection id from somewhere less careful gets a 404
 * rather than somebody else's SAP credentials.
 *
 * The OAuth token is fetched once here rather than per request, because a
 * client-credentials round trip before every page of a sync would double both
 * the traffic and the failure surface.
 */
export async function loadConnectorContext(input: {
  connectionId: string;
  organizationId: string;
  /** Skip the token fetch for operations that make no call - a dry run's mapping check. */
  withToken?: boolean;
  currencyExponent?: number;
}): Promise<{ context: ConnectorContext; connector: Connector }> {
  const connection = await prisma.customerErpConnection.findFirst({
    where: {
      id: input.connectionId,
      organizationId: input.organizationId,
      deletedAt: null,
    },
    include: { endpoints: true, fieldMappings: true },
  });

  if (connection === null) throw notFound('Connection');

  const call: ErpCallContext = {
    id: connection.id,
    organizationId: connection.organizationId,
    baseUrl: connection.baseUrl,
    authMethod: toAuthMethodName(connection.authMethod),
    apiKeyLocation: connection.apiKeyLocation,
    apiKeyName: connection.apiKeyName,
    apiVersion: connection.apiVersion,
    customHeaders: asStringMap(connection.customHeadersJson),
    tenantIdentifier: connection.tenantIdentifier,
    timeoutMs: connection.timeoutMs,
    mutualTlsEnabled: connection.mutualTlsEnabled,
  };

  const endpoints = new Map<EndpointPurpose, EndpointConfig>();

  for (const row of connection.endpoints) {
    endpoints.set(toEndpointPurpose(row.purpose), {
      purpose: toEndpointPurpose(row.purpose),
      path: row.path,
      method: row.method,
      enabled: row.enabled,
      pagination: row.pagination,
      paginationConfig: asPaginationConfig(row.paginationConfigJson),
      recordsPath: row.recordsPath,
      requestTemplate: asObject(row.requestTemplateJson),
      queryParams: asStringMap(row.queryParamsJson),
    });
  }

  const mappings: MappingRow[] = connection.fieldMappings.map((row) => ({
    entity: row.entity,
    platformField: row.platformField,
    erpPath: row.erpPath,
    constantValue: row.constantValue,
    erpValue: row.erpValue,
    transform: row.transform as TransformName | null,
    required: row.required,
  }));

  const usesOAuth =
    connection.authMethod === 'OAUTH2_CLIENT_CREDENTIALS' ||
    connection.authMethod === 'OAUTH2_AUTHORIZATION_CODE';

  const oauthContext: OAuthConnectionContext = {
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

  const accessToken =
    usesOAuth && input.withToken !== false ? await getAccessToken(oauthContext) : null;

  return {
    connector: connectorFor(connection.system),
    context: {
      call,
      system: connection.system,
      apiStyle: connection.apiStyle,
      environment: connection.environment,
      erpVersion: connection.erpVersion,
      authMethod: connection.authMethod,
      apiKeyLocation: connection.apiKeyLocation,
      endpoints,
      mappings,
      sap: {
        companyCode: connection.sapCompanyCode,
        purchasingOrg: connection.sapPurchasingOrg,
        purchasingGroup: connection.sapPurchasingGroup,
        plant: connection.sapPlant,
        storageLocation: connection.sapStorageLocation,
        communicationScenario: connection.sapCommunicationScenario,
      },
      monday: {
        workspaceId: connection.mondayWorkspaceId,
        boardId: connection.mondayBoardId,
        groupId: connection.mondayGroupId,
      },
      accessToken,
      tenantIdentifier: connection.tenantIdentifier,
      currencyExponent: input.currencyExponent ?? 2,
    },
  };
}

/**
 * Refuse an operation against a connection whose system has no rule for it.
 *
 * Called by the pipeline before it builds a payload, so the refusal names the
 * missing endpoint rather than failing halfway through a mapping.
 */
export function assertEndpointAvailable(
  context: ConnectorContext,
  purpose: EndpointPurpose,
): void {
  const endpoint = context.endpoints.get(purpose);

  if (endpoint === undefined || !endpoint.enabled) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_ENDPOINT_MISSING,
      `Nothing is configured for ${purpose.toLowerCase().replace(/_/g, ' ')} on this ` +
        'connection.',
    );
  }
}

// ---------------------------------------------------------------------------
// JSON columns
// ---------------------------------------------------------------------------

/**
 * A JSON column as a flat map of strings.
 *
 * Defensive rather than trusting, because these columns are old data as well as
 * new: a row written by an earlier version, restored from a backup, or edited
 * by hand in a support session is still a row this code has to read without
 * crashing.
 */
function asStringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};

  const result: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry;
    else if (typeof entry === 'number' || typeof entry === 'boolean') result[key] = String(entry);
  }

  return result;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asPaginationConfig(value: unknown): PaginationConfig {
  const source = asObject(value) ?? {};
  const config: PaginationConfig = {};

  for (const key of [
    'pageParam',
    'sizeParam',
    'offsetParam',
    'limitParam',
    'cursorParam',
    'cursorPath',
    'totalPath',
  ] as const) {
    const entry = source[key];
    if (typeof entry === 'string' && entry.length > 0) config[key] = entry;
  }

  const size = source['pageSize'];
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
    config.pageSize = Math.min(Math.floor(size), 1000);
  }

  return config;
}

export type { Connector, ConnectorContext, EndpointConfig, EndpointPurpose, SystemName };
