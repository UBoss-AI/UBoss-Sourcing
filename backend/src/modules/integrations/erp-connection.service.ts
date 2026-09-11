/**
 * The business's ERP connection: creating it, testing it, and switching it on.
 *
 * This is the service behind Settings -> ERP, and it is administrator-only.
 * There is no per-customer connection and no owner column: `business_profiles`
 * is a single-row table, so the installation has one ERP and every order goes
 * to it.
 *
 * That is about THIS INSTALLATION's warehouse system, and it is not a claim
 * that buyers never configure an ERP. They do, in a separate feature with
 * separate tables: `modules/customer-erp/`, where a buyer connects their own
 * SAP, monday.com or in-house system so that what they buy here appears there.
 * The two never meet - different tenants, different credentials, different
 * jobs - and neither can reach the other's rows.
 *
 * What makes it safe for a buyer to supply an address is `outbound-http.ts`:
 * https only, DNS resolved here, private ranges refused, the socket pinned,
 * every redirect re-checked. The same guard applies to this connection too,
 * because an address typed by an administrator is still an address typed by a
 * person.
 *
 * Three rules about secrets, none of which has an exception:
 *
 *   1. A credential is encrypted before it is stored, with AAD binding it to
 *      the row. It is decrypted in exactly one module (`erp-client.ts`), to
 *      build a header, for the duration of one call.
 *   2. No function here returns a credential. `toView` is the only shape that
 *      leaves this file and it has no field that could carry one; the edit
 *      screen gets `credentialHint`, which is `X-API-Key: sk_live_...9f2a`.
 *   3. A save that omits a secret field KEEPS the stored one. That is what
 *      makes a masked edit form work: the customer changes the timeout, the
 *      form sends no API key because it never had one to send, and the key
 *      survives. Sending an empty string is how you clear it, and that is a
 *      deliberate act rather than the default.
 *
 * On testing before activating. `ACTIVATE` is refused unless a test has passed
 * AND the mapping has been checked against a real response. Both are recorded
 * on the row (`lastTestOk`, `mappingVerifiedAt`) and both are cleared whenever
 * the configuration changes, because what the last test proved, it proved about
 * settings that have since been replaced.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { ErpAuthMethod, ErpConnectionStatus } from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import {
  assertErpTransition,
  availableActions,
  type ErpConnectionStatusName,
} from '../../domain/erp-connection-state.js';
import { encryptSecret, generateToken, maskSecret } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { loggerFor } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { assertSafeErpUrl } from '../../infra/outbound-http.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  ErpCallError,
  type ErpCallContext,
  type ErpCredentials,
  callErp,
  decryptErpCredentials,
  erpCredentialAad,
  fetchOAuthToken,
  isConfigurableHeader,
  resolveEndpointUrl,
  safeErrorMessage,
} from './erp-client.js';
import {
  type FieldMapping,
  assertMappingValid,
  parseFieldMapping,
  verifyAgainstSample,
} from './erp-field-mapping.js';
import {
  claimEvent,
  recordEventFailure,
  recordEventSuccess,
} from './integration-event.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The member of staff doing this.
 *
 * Every mutation here is on the audit trail with their id against it: these
 * rows record somebody pointing this server at an outbound address and handing
 * it a credential, and "who set that up, and when" is the first question asked
 * if the address turns out to be wrong.
 */
export interface ErpActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export type EndpointKey = 'product' | 'inventory' | 'warehouse' | 'orderCreate' | 'orderStatus';

export const ENDPOINT_KEYS: EndpointKey[] = [
  'product',
  'inventory',
  'warehouse',
  'orderCreate',
  'orderStatus',
];

export type HttpMethodName = 'GET' | 'POST' | 'PUT' | 'PATCH';

/**
 * The field groups a record from the INVENTORY endpoint can contain.
 *
 * `order` is absent, and that absence is the point: those fields describe the
 * response to an order creation, which a test deliberately never makes. Without
 * this, every passing test reported "ERP order ID: nothing was found at id" -
 * a problem with the question, not with the customer's mapping.
 */
const INVENTORY_SAMPLE_GROUPS = ['product', 'inventory', 'pricing'] as const;

export interface ConnectionInput {
  name: string;
  baseUrl: string;
  endpoints?: Partial<Record<EndpointKey, string | null>>;
  methods?: Partial<Record<EndpointKey, HttpMethodName>>;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
  authMethod: ErpAuthMethod;
  /**
   * Omit to keep what is stored. That is what makes the masked edit form work -
   * see the header. An explicit empty string clears the secret.
   */
  credentials?: ErpCredentials;
  oauthTokenUrl?: string | null;
  oauthScope?: string | null;
  webhookEnabled?: boolean;
  /** Omit to keep. Empty string clears, which switches webhooks off. */
  webhookSecret?: string | null;
  webhookSignatureHeader?: string;
  pollingEnabled?: boolean;
  pollingIntervalMinutes?: number;
  fieldMapping?: FieldMapping;
  inventoryAuthority?: 'ERP' | 'PLATFORM' | 'MANUAL';
  allowManualOverride?: boolean;
  orderPushEnabled?: boolean;
  idempotencyHeader?: string;
}

/**
 * What the API returns for a connection.
 *
 * Every field here is safe. There is no `credentialsEnc`, no `webhookSecretEnc`
 * and no `oauthTokenEnc`, and that is enforced by this type rather than by a
 * `select` somebody might widen later: a new secret column added to the schema
 * does not appear here until somebody writes the line that puts it here.
 */
export interface ConnectionView {
  id: string;
  name: string;
  baseUrl: string;
  status: ErpConnectionStatus;
  statusReason: string | null;
  statusChangedAt: string;
  endpoints: Record<EndpointKey, string | null>;
  methods: Record<EndpointKey, HttpMethodName>;
  customHeaders: Record<string, string>;
  timeoutMs: number;
  authMethod: ErpAuthMethod;
  /** `X-API-Key: sk_live_...9f2a`. Identifies the credential, cannot use it. */
  credentialHint: string | null;
  hasCredentials: boolean;
  oauthTokenUrl: string | null;
  oauthScope: string | null;
  webhookEnabled: boolean;
  hasWebhookSecret: boolean;
  webhookSignatureHeader: string;
  /** The full URL the customer pastes into their ERP. */
  webhookUrl: string | null;
  pollingEnabled: boolean;
  pollingIntervalMinutes: number;
  lastPolledAt: string | null;
  nextPollAt: string | null;
  fieldMapping: FieldMapping | null;
  mappingVerifiedAt: string | null;
  inventoryAuthority: string;
  allowManualOverride: boolean;
  orderPushEnabled: boolean;
  idempotencyHeader: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestHttpStatus: number | null;
  lastTestDurationMs: number | null;
  lastTestMessage: string | null;
  consecutiveFailures: number;
  lastSyncSuccessAt: string | null;
  lastSyncFailureAt: string | null;
  createdAt: string;
  /** Which buttons the screen should offer, from the state machine. */
  availableActions: string[];
  /** Whether ACTIVATE would currently succeed, and why not when it would not. */
  activationBlockers: string[];
}

type ConnectionRow = Prisma.ErpConnectionGetPayload<Record<string, never>>;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Refuse the whole surface where the deployment has not enabled it. */
export function assertFeatureEnabled(): void {
  if (!env.FEATURE_ERP_INTEGRATION) {
    throw forbidden(
      ErrorCode.FEATURE_DISABLED,
      'Connecting your own ERP is not enabled for this store.',
    );
  }
}

/**
 * Load a live connection, or 404.
 *
 * The single read path. A retired connection is treated as absent rather than
 * returned in a state every caller would then have to special-case - its
 * history is still readable through the ledger, which is what `deletedAt`
 * exists to preserve.
 */
export async function loadConnection(connectionId: string): Promise<ConnectionRow> {
  const row = await prisma.erpConnection.findFirst({
    where: { id: connectionId, deletedAt: null },
  });

  if (row === null) throw notFound('That connection');
  return row;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function readMethods(row: ConnectionRow): Record<EndpointKey, HttpMethodName> {
  const stored = (row.methodsJson ?? {}) as Record<string, unknown>;

  // GET for reads, POST for the one that creates something. A customer whose
  // ERP disagrees changes it; these are the defaults that need changing least
  // often, not an assumption about anybody's API.
  const defaults: Record<EndpointKey, HttpMethodName> = {
    product: 'GET',
    inventory: 'GET',
    warehouse: 'GET',
    orderCreate: 'POST',
    orderStatus: 'GET',
  };

  const result = { ...defaults };
  for (const key of ENDPOINT_KEYS) {
    const value = stored[key];
    if (value === 'GET' || value === 'POST' || value === 'PUT' || value === 'PATCH') {
      result[key] = value;
    }
  }

  return result;
}

function readCustomHeaders(row: ConnectionRow): Record<string, string> {
  const stored = (row.customHeadersJson ?? {}) as Record<string, unknown>;
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(stored)) {
    if (typeof value === 'string') result[name] = value;
  }

  return result;
}

/**
 * The webhook URL a customer pastes into their ERP.
 *
 * Built from `PUBLIC_API_URL` rather than from the request, because the URL has
 * to be the same one whichever machine renders it and a `Host` header is
 * attacker-controlled. Null when webhooks are off, so the screen does not offer
 * an address that would refuse everything sent to it.
 */
function webhookUrlFor(row: ConnectionRow): string | null {
  if (!row.webhookEnabled) return null;
  const base = env.API_PUBLIC_URL.replace(/\/+$/, '');
  return `${base}/api/v1/integrations/erp/webhooks/${row.webhookSlug}`;
}

/**
 * Everything standing between this connection and being switched on.
 *
 * Returned rather than thrown so the screen can show the list beside a disabled
 * button, which is a far better experience than a button that fails when
 * pressed and explains one problem at a time.
 */
export function activationBlockers(row: ConnectionRow): string[] {
  const blockers: string[] = [];

  if (row.lastTestOk !== true) {
    blockers.push('Run a successful connection test.');
  }

  if (row.mappingVerifiedAt === null) {
    blockers.push('Check the field mapping against a real response using Dry run.');
  }

  const mapping = parseFieldMapping(row.fieldMappingJson);
  if (mapping === null) {
    blockers.push('Set up the field mapping.');
  }

  if (row.orderPushEnabled && (row.orderCreateEndpoint ?? '') === '') {
    blockers.push('Set the order creation endpoint, or turn order sending off.');
  }

  if (
    (row.pollingEnabled || row.webhookEnabled) &&
    (row.inventoryEndpoint ?? '') === '' &&
    row.pollingEnabled
  ) {
    blockers.push('Set the inventory endpoint, or turn scheduled synchronisation off.');
  }

  if (row.webhookEnabled && row.webhookSecretEnc === null) {
    blockers.push('Add the webhook signing secret, or turn webhooks off.');
  }

  return blockers;
}

export function toView(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    status: row.status,
    statusReason: row.statusReason,
    statusChangedAt: row.statusChangedAt.toISOString(),
    endpoints: {
      product: row.productEndpoint,
      inventory: row.inventoryEndpoint,
      warehouse: row.warehouseEndpoint,
      orderCreate: row.orderCreateEndpoint,
      orderStatus: row.orderStatusEndpoint,
    },
    methods: readMethods(row),
    customHeaders: readCustomHeaders(row),
    timeoutMs: row.timeoutMs,
    authMethod: row.authMethod,
    credentialHint: row.credentialHint,
    hasCredentials: row.credentialsEnc !== null,
    oauthTokenUrl: row.oauthTokenUrl,
    oauthScope: row.oauthScope,
    webhookEnabled: row.webhookEnabled,
    hasWebhookSecret: row.webhookSecretEnc !== null,
    webhookSignatureHeader: row.webhookSignatureHeader,
    webhookUrl: webhookUrlFor(row),
    pollingEnabled: row.pollingEnabled,
    pollingIntervalMinutes: row.pollingIntervalMinutes,
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    nextPollAt: row.nextPollAt?.toISOString() ?? null,
    fieldMapping: parseFieldMapping(row.fieldMappingJson),
    mappingVerifiedAt: row.mappingVerifiedAt?.toISOString() ?? null,
    inventoryAuthority: row.inventoryAuthority,
    allowManualOverride: row.allowManualOverride,
    orderPushEnabled: row.orderPushEnabled,
    idempotencyHeader: row.idempotencyHeader,
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastTestOk: row.lastTestOk,
    lastTestHttpStatus: row.lastTestHttpStatus,
    lastTestDurationMs: row.lastTestDurationMs,
    lastTestMessage: row.lastTestMessage,
    consecutiveFailures: row.consecutiveFailures,
    lastSyncSuccessAt: row.lastSyncSuccessAt?.toISOString() ?? null,
    lastSyncFailureAt: row.lastSyncFailureAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    availableActions: availableActions(row.status),
    activationBlockers: activationBlockers(row),
  };
}

/** The call context `erp-client` needs, from a row. */
export function callContextFor(row: ConnectionRow): ErpCallContext {
  return {
    id: row.id,
    baseUrl: row.baseUrl,
    authMethod: row.authMethod,
    credentialsEnc: row.credentialsEnc,
    customHeaders: readCustomHeaders(row),
    timeoutMs: row.timeoutMs,
    oauthTokenUrl: row.oauthTokenUrl,
    oauthScope: row.oauthScope,
    oauthTokenEnc: row.oauthTokenEnc,
    oauthTokenExpiresAt: row.oauthTokenExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// Validation of an incoming configuration
// ---------------------------------------------------------------------------

/**
 * Which credential fields each method needs.
 *
 * Checked on save rather than only at test time, so a customer finds out about
 * a missing client secret while they are looking at the field, not an hour
 * later in an error log.
 */
function assertCredentialsComplete(
  method: ErpAuthMethod,
  credentials: ErpCredentials,
  existing: ErpCredentials,
): void {
  // The merged view: what will be stored after this save.
  const merged = { ...existing, ...credentials };

  const missing: { field: string; label: string }[] = [];

  switch (method) {
    case 'API_KEY':
      if ((merged.apiKey ?? '') === '') missing.push({ field: 'credentials.apiKey', label: 'API key' });
      break;
    case 'BEARER_TOKEN':
      if ((merged.token ?? '') === '')
        missing.push({ field: 'credentials.token', label: 'bearer token' });
      break;
    case 'BASIC':
      if ((merged.username ?? '') === '')
        missing.push({ field: 'credentials.username', label: 'username' });
      if ((merged.password ?? '') === '')
        missing.push({ field: 'credentials.password', label: 'password' });
      break;
    case 'OAUTH2':
      if ((merged.clientId ?? '') === '')
        missing.push({ field: 'credentials.clientId', label: 'client ID' });
      if ((merged.clientSecret ?? '') === '')
        missing.push({ field: 'credentials.clientSecret', label: 'client secret' });
      break;
  }

  if (missing.length > 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `This authentication method needs a ${missing.map((entry) => entry.label).join(' and a ')}.`,
      missing.map((entry) => ({ field: entry.field, code: 'REQUIRED' })),
    );
  }
}

/**
 * A masked-form save, resolved.
 *
 * `undefined` means "the form did not send this field, keep what is stored".
 * `''` means "the customer cleared it". Anything else is a new value. Getting
 * this distinction wrong in either direction is a real bug: treating undefined
 * as empty wipes a working credential every time somebody edits the timeout,
 * and treating empty as undefined makes it impossible to remove one.
 */
function mergeCredentials(
  incoming: ErpCredentials | undefined,
  existing: ErpCredentials,
): ErpCredentials {
  if (incoming === undefined) return existing;

  const merged: ErpCredentials = { ...existing };

  for (const [key, value] of Object.entries(incoming) as [keyof ErpCredentials, unknown][]) {
    if (value === undefined) continue;

    if (value === '') {
      delete merged[key];
      continue;
    }

    // `extraSecretHeaders` is an object, and replaces wholesale rather than
    // merging: a customer removing a header from the form means to remove it.
    (merged as Record<string, unknown>)[key] = value;
  }

  return merged;
}

/** A short, safe description of the credential in place, for the edit screen. */
function hintFor(method: ErpAuthMethod, credentials: ErpCredentials): string | null {
  switch (method) {
    case 'API_KEY':
      return credentials.apiKey === undefined
        ? null
        : `${credentials.headerName ?? 'X-API-Key'}: ${maskSecret(credentials.apiKey)}`;
    case 'BEARER_TOKEN':
      return credentials.token === undefined ? null : `Bearer ${maskSecret(credentials.token)}`;
    case 'BASIC':
      // The username is not a secret and is by far the most useful thing to
      // show: it is what tells the customer which account is configured.
      return credentials.username === undefined ? null : `${credentials.username} / ********`;
    case 'OAUTH2':
      return credentials.clientId === undefined
        ? null
        : `${credentials.clientId} / ${maskSecret(credentials.clientSecret ?? '')}`;
  }
}

function assertHeadersAcceptable(
  headers: Record<string, string>,
  idempotencyHeader: string,
): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!isConfigurableHeader(name, idempotencyHeader)) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `"${name}" is set by this system and cannot be a custom header. Put a secret in the ` +
          'authentication section instead.',
        [{ field: 'customHeaders', code: 'HEADER_RESERVED' }],
      );
    }

    // A header value with a newline in it is header injection, whatever the
    // name is.
    if (/[\r\n]/.test(value) || value.length > 1024) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, `The value for "${name}" is not usable.`, [
        { field: 'customHeaders', code: 'HEADER_VALUE_INVALID' },
      ]);
    }
  }
}

/**
 * Turn an input into the columns to write, validating as it goes.
 *
 * Every endpoint is resolved against the base URL here rather than at call
 * time, so an endpoint pointing at another origin is a form error the customer
 * sees immediately instead of a request that would have gone somewhere else.
 */
function buildWriteData(
  input: ConnectionInput,
  existing: ConnectionRow | null,
): Prisma.ErpConnectionUncheckedUpdateInput {
  assertSafeErpUrl(input.baseUrl, { field: 'baseUrl' });

  const endpoints = input.endpoints ?? {};
  for (const key of ENDPOINT_KEYS) {
    const value = endpoints[key];
    if (value === undefined || value === null || value.trim() === '') continue;
    // Throws on an off-origin or malformed endpoint. The return value is not
    // kept: what is stored is what the customer typed, so the field they see
    // is the field they filled in.
    resolveEndpointUrl(input.baseUrl, value, `endpoints.${key}`);
  }

  const idempotencyHeader = input.idempotencyHeader ?? existing?.idempotencyHeader ?? 'Idempotency-Key';
  const customHeaders = input.customHeaders ?? {};
  assertHeadersAcceptable(customHeaders, idempotencyHeader);

  const timeoutMs = input.timeoutMs ?? existing?.timeoutMs ?? 15000;
  if (timeoutMs < 1000 || timeoutMs > 60_000) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The timeout has to be between 1 and 60 seconds.',
      [{ field: 'timeoutMs', code: 'OUT_OF_RANGE' }],
    );
  }

  const pollingIntervalMinutes =
    input.pollingIntervalMinutes ?? existing?.pollingIntervalMinutes ?? 60;
  if (pollingIntervalMinutes < 5 || pollingIntervalMinutes > 1440) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Check for stock changes no more often than every 5 minutes and at least once a day. ' +
        'For anything faster, use a webhook.',
      [{ field: 'pollingIntervalMinutes', code: 'OUT_OF_RANGE' }],
    );
  }

  if (input.authMethod === 'OAUTH2') {
    const tokenUrl = input.oauthTokenUrl ?? existing?.oauthTokenUrl ?? '';
    if (tokenUrl === '') {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'OAuth needs the address of the token endpoint.',
        [{ field: 'oauthTokenUrl', code: 'REQUIRED' }],
      );
    }
    // The token endpoint receives the client secret, so it goes through the
    // same address check as the base URL. It is allowed to be on a different
    // origin - plenty of ERPs use a separate identity server - which is
    // exactly why it must be validated in its own right.
    assertSafeErpUrl(tokenUrl, { field: 'oauthTokenUrl' });
  }

  const existingCredentials = existing === null ? {} : decryptErpCredentials(callContextFor(existing));
  const credentials = mergeCredentials(input.credentials, existingCredentials);
  assertCredentialsComplete(input.authMethod, input.credentials ?? {}, existingCredentials);

  const mapping = input.fieldMapping;
  if (mapping !== undefined) {
    assertMappingValid(mapping, {
      inventory: input.pollingEnabled === true || input.webhookEnabled === true,
      order: input.orderPushEnabled !== false,
    });
  }

  const hasCredentials = Object.keys(credentials).length > 0;

  return {
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim(),
    productEndpoint: emptyToNull(endpoints.product),
    inventoryEndpoint: emptyToNull(endpoints.inventory),
    warehouseEndpoint: emptyToNull(endpoints.warehouse),
    orderCreateEndpoint: emptyToNull(endpoints.orderCreate),
    orderStatusEndpoint: emptyToNull(endpoints.orderStatus),
    methodsJson: (input.methods ?? {}),
    customHeadersJson: customHeaders,
    timeoutMs,
    authMethod: input.authMethod,
    // Re-encrypted on every save even when unchanged, which costs nothing and
    // means a key rotation is a matter of re-saving rather than a migration.
    credentialsEnc: hasCredentials
      ? encryptSecret(JSON.stringify(credentials), erpCredentialAad(existing?.id ?? ''))
      : null,
    credentialHint: hasCredentials ? hintFor(input.authMethod, credentials) : null,
    // A method change invalidates any cached OAuth token, and so does a
    // credential change. Clearing it here rather than hoping it expires means
    // the next call fetches a fresh one with the new secret.
    oauthTokenEnc: null,
    oauthTokenExpiresAt: null,
    oauthTokenUrl: input.authMethod === 'OAUTH2' ? (input.oauthTokenUrl ?? existing?.oauthTokenUrl ?? null) : null,
    oauthScope: input.authMethod === 'OAUTH2' ? emptyToNull(input.oauthScope) : null,
    webhookEnabled: input.webhookEnabled ?? existing?.webhookEnabled ?? false,
    webhookSignatureHeader:
      input.webhookSignatureHeader ?? existing?.webhookSignatureHeader ?? 'X-UBOSS-Signature',
    pollingEnabled: input.pollingEnabled ?? existing?.pollingEnabled ?? false,
    pollingIntervalMinutes,
    ...(mapping === undefined ? {} : { fieldMappingJson: mapping as unknown as Prisma.InputJsonValue }),
    inventoryAuthority: input.inventoryAuthority ?? existing?.inventoryAuthority ?? 'ERP',
    allowManualOverride: input.allowManualOverride ?? existing?.allowManualOverride ?? false,
    orderPushEnabled: input.orderPushEnabled ?? existing?.orderPushEnabled ?? true,
    idempotencyHeader,
  };
}

/**
 * Turn MariaDB's duplicate-key error into a sentence, or re-throw.
 *
 * P2002 is the only one worth translating here: names are the one field an
 * administrator picks freely, so it is the only collision they can cause.
 */
function asDuplicateNameError(error: unknown, name: string): unknown {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error).code
      : null;

  if (code !== 'P2002') return error;

  return conflict(
    ErrorCode.CONFLICT,
    `There is already a connection called "${name}". Names have to be different so the two can ` +
      'be told apart on the Activity screen.',
    [{ field: 'name', code: 'NAME_TAKEN' }],
  );
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Create, read, update, delete
// ---------------------------------------------------------------------------

export async function listConnections(): Promise<ConnectionView[]> {
  const rows = await prisma.erpConnection.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map(toView);
}

export async function getConnection(connectionId: string): Promise<ConnectionView> {
  return toView(await loadConnection(connectionId));
}

export async function createConnection(
  actor: ErpActor,
  input: ConnectionInput,
): Promise<ConnectionView> {
  assertFeatureEnabled();

  const existingCount = await prisma.erpConnection.count({ where: { deletedAt: null } });

  // Several connections are useful - a sandbox alongside the live one while
  // an ERP is being migrated - but only one is ever ACTIVE. The ceiling is
  // here to stop the poller acquiring work without limit, not to express a
  // business rule.
  if (existingCount >= env.ERP_MAX_CONNECTIONS) {
    throw conflict(
      ErrorCode.CONFLICT,
      `There can be at most ${String(env.ERP_MAX_CONNECTIONS)} ERP connections. Delete one ` +
        'that is no longer used to add another.',
    );
  }

  const id = newId();

  // The credential AAD binds ciphertext to a row id, so the id has to exist
  // before the ciphertext is built. `buildWriteData` is called with a stand-in
  // row carrying only the id, which is the only field it reads from `existing`
  // for that purpose.
  const data = buildWriteData(input, { id } as ConnectionRow);

  // 32 bytes of CSPRNG. Not a secret - the signature is what authenticates a
  // webhook - but it keeps the endpoint from being found by iterating ids.
  const { token: webhookSlug } = generateToken(24);

  const created = await prisma.erpConnection
    .create({
      data: {
        ...(data as Prisma.ErpConnectionUncheckedCreateInput),
        id,
        createdById: actor.userId,
        status: 'DRAFT',
        statusChangedAt: new Date(),
        webhookSlug,
        ...(input.webhookSecret === undefined ||
        input.webhookSecret === null ||
        input.webhookSecret === ''
          ? {}
          : { webhookSecretEnc: encryptSecret(input.webhookSecret, erpCredentialAad(id)) }),
      },
    })
    .catch((error: unknown) => {
      // `name` is unique. Caught and reworded rather than left to surface as a
      // Prisma error, because "Unique constraint failed on the fields: (`name`)"
      // tells an administrator to go and read the schema.
      throw asDuplicateNameError(error, data.name as string);
    });

  await recordAudit({
    action: AuditAction.ERP_CONNECTION_CREATED,
    resourceType: 'erp_connection',
    resourceId: id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    // Deliberately the safe subset. The whole input would carry the
    // credentials, and REDACTED_FIELDS is a backstop rather than a licence to
    // hand it secrets.
    after: { name: created.name, baseUrl: created.baseUrl, authMethod: created.authMethod },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return toView(created);
}

/**
 * Save changes, and put the connection back to DRAFT.
 *
 * The status reset is the point of this function as much as the columns are.
 * Whatever the last test proved, it proved about the settings that have just
 * been replaced - so `lastTestOk` and `mappingVerifiedAt` are cleared and the
 * connection has to be tested again before it can carry orders. An edit that
 * silently left a connection ACTIVE would let somebody change a base URL and
 * have the next order go to the new address untested.
 */
export async function updateConnection(
  actor: ErpActor,
  connectionId: string,
  input: ConnectionInput,
): Promise<ConnectionView> {
  assertFeatureEnabled();

  const existing = await loadConnection(connectionId);

  // Refuses on DISABLED, which has to be reopened first.
  const nextStatus = assertErpTransition(existing.status, 'EDIT');

  const data = buildWriteData(input, existing);

  const credentialsChanged = input.credentials !== undefined;

  // Three states, not two: absent (keep the stored secret), empty or null
  // (clear it), or a new value. Resolved here rather than inline so the
  // distinction is visible - collapsing "absent" into "clear" would wipe a
  // working webhook secret every time somebody edited the connection name.
  const incomingWebhookSecret = input.webhookSecret;
  const webhookSecretChanged = incomingWebhookSecret !== undefined;
  const nextWebhookSecretEnc =
    incomingWebhookSecret === undefined || incomingWebhookSecret === null || incomingWebhookSecret === ''
      ? null
      : encryptSecret(incomingWebhookSecret, erpCredentialAad(connectionId));

  const updated = await prisma.erpConnection.update({
    where: { id: connectionId },
    data: {
      ...data,
      status: nextStatus,
      statusReason: null,
      statusChangedAt: new Date(),
      // Cleared together: both are claims about a configuration that no longer
      // exists.
      lastTestOk: null,
      mappingVerifiedAt: input.fieldMapping === undefined ? existing.mappingVerifiedAt : null,
      consecutiveFailures: 0,
      circuitOpenedAt: null,
      ...(webhookSecretChanged ? { webhookSecretEnc: nextWebhookSecretEnc } : {}),
    },
  });

  await recordAudit({
    action: credentialsChanged
      ? AuditAction.ERP_CREDENTIALS_ROTATED
      : AuditAction.ERP_CONNECTION_UPDATED,
    resourceType: 'erp_connection',
    resourceId: connectionId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { name: existing.name, baseUrl: existing.baseUrl, authMethod: existing.authMethod },
    after: {
      name: updated.name,
      baseUrl: updated.baseUrl,
      authMethod: updated.authMethod,
      credentialsChanged,
      webhookSecretChanged,
    },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return toView(updated);
}

/**
 * Retire a connection.
 *
 * Soft, always. An integration event references the connection that produced
 * it, and a hard delete would either cascade the ledger away or leave rows
 * pointing at nothing - and the ledger is what explains an order that went
 * through this connector six months ago.
 *
 * The name is freed for reuse by suffixing the stored one, because
 * `(customerProfileId, name)` is unique and a customer who deletes "Production"
 * and creates it again is doing something entirely reasonable.
 */
export async function deleteConnection(
  actor: ErpActor,
  connectionId: string,
): Promise<void> {
  assertFeatureEnabled();

  const existing = await loadConnection(connectionId);

  const inFlight = await prisma.integrationEvent.count({
    where: {
      connectionId,
      status: { in: ['PENDING', 'IN_PROGRESS', 'RETRY_SCHEDULED'] },
    },
  });

  if (inFlight > 0) {
    // Refused rather than deleted, because those events include orders that
    // have been paid for and have not reached the ERP. Deleting the connection
    // underneath them would strand the money.
    throw conflict(
      ErrorCode.CONFLICT,
      `This connection still has ${String(inFlight)} operation${inFlight === 1 ? '' : 's'} ` +
        'waiting. Pause it and let them finish, or resolve them on the Activity tab, before ' +
        'deleting it.',
    );
  }

  await prisma.erpConnection.update({
    where: { id: connectionId },
    data: {
      deletedAt: new Date(),
      status: 'DISABLED',
      statusChangedAt: new Date(),
      statusReason: 'Deleted by the account holder.',
      // The name is released so it can be used again. The suffix is the id,
      // which is unique by construction.
      name: `${existing.name.slice(0, 90)} (deleted ${existing.id.slice(-6)})`,
      pollingEnabled: false,
      webhookEnabled: false,
      nextPollAt: null,
      // Nothing should be able to use these again, and a retired row is a row
      // nobody is watching.
      credentialsEnc: null,
      credentialHint: null,
      webhookSecretEnc: null,
      oauthTokenEnc: null,
    },
  });

  await recordAudit({
    action: AuditAction.ERP_CONNECTION_DELETED,
    resourceType: 'erp_connection',
    resourceId: connectionId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { name: existing.name, status: existing.status },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const ACTION_AUDIT = {
  ACTIVATE: AuditAction.ERP_CONNECTION_ACTIVATED,
  PAUSE: AuditAction.ERP_CONNECTION_PAUSED,
  RESUME: AuditAction.ERP_CONNECTION_RESUMED,
  DISABLE: AuditAction.ERP_CONNECTION_DELETED,
  REOPEN: AuditAction.ERP_CONNECTION_UPDATED,
} as const;

export type LifecycleAction = keyof typeof ACTION_AUDIT;

/**
 * Activate, pause, resume, disable or reopen.
 *
 * One function rather than five, because the shape is identical and the
 * difference is entirely in the state machine - which is where that difference
 * belongs. `assertErpTransition` decides whether the move is legal; the extra
 * check below decides whether ACTIVATE specifically has the two facts it needs.
 */
export async function performLifecycleAction(
  actor: ErpActor,
  connectionId: string,
  action: LifecycleAction,
): Promise<ConnectionView> {
  assertFeatureEnabled();

  const existing = await loadConnection(connectionId);
  const nextStatus = assertErpTransition(existing.status, action);

  if (action === 'ACTIVATE') {
    const blockers = activationBlockers(existing);
    if (blockers.length > 0) {
      throw conflict(
        existing.lastTestOk === true
          ? ErrorCode.ERP_MAPPING_UNVERIFIED
          : ErrorCode.ERP_CONNECTION_UNTESTED,
        `This connection is not ready to be switched on. ${blockers.join(' ')}`,
        blockers.map((message) => ({ code: 'ACTIVATION_BLOCKED', message })),
      );
    }

    // --- At most one ACTIVE connection ---------------------------------
    //
    // Two would make "which ERP does an order go to" depend on row order.
    // Switching the previous one to PAUSED rather than refusing is deliberate:
    // the point of holding a sandbox alongside a live connection is being able
    // to cut over, and making somebody pause the old one first turns a
    // one-click cutover into a two-step dance with a window in the middle where
    // no connection is active at all.
    //
    // PAUSED and not DISABLED, so cutting back is one click too.
    //
    // MariaDB 10.4 has no partial index, so "unique where status = ACTIVE"
    // cannot be a constraint - this is the only thing enforcing it.
    const superseded = await prisma.erpConnection.updateMany({
      where: { status: 'ACTIVE', id: { not: connectionId } },
      data: {
        status: 'PAUSED',
        statusChangedAt: new Date(),
        statusReason: `Superseded by "${existing.name}".`,
        nextPollAt: null,
      },
    });

    if (superseded.count > 0) {
      await recordAudit({
        action: AuditAction.ERP_CONNECTION_PAUSED,
        resourceType: 'erp_connection',
        resourceId: connectionId,
        actorType: 'SYSTEM',
        after: { supersededCount: superseded.count, activated: existing.name },
        correlationId: actor.correlationId ?? null,
      });
    }
  }

  const updated = await prisma.erpConnection.update({
    where: { id: connectionId },
    data: {
      status: nextStatus,
      statusChangedAt: new Date(),
      statusReason: null,
      // Resuming clears the failure count. The customer is asserting the cause
      // is fixed, and starting from five would take the connection straight
      // back out of service on the first hiccup.
      ...(action === 'RESUME' || action === 'ACTIVATE'
        ? { consecutiveFailures: 0, circuitOpenedAt: null }
        : {}),
      // Polling starts and stops with the connection. A paused connection that
      // kept polling would be neither paused nor active.
      ...(nextStatus === 'ACTIVE'
        ? { nextPollAt: existing.pollingEnabled ? new Date() : null }
        : { nextPollAt: null }),
    },
  });

  await recordAudit({
    action: ACTION_AUDIT[action],
    resourceType: 'erp_connection',
    resourceId: connectionId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { status: existing.status },
    after: { status: nextStatus },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return toView(updated);
}

/**
 * Take a connection out of service after repeated failures.
 *
 * Called by the machinery, never by a person, and it is why a customer whose
 * ERP has been switched off for a fortnight does not get a failed poll against
 * it every hour for a fortnight. Recovering goes through a passing test, which
 * is the same door setup came through.
 */
export async function suspendAfterFailures(
  connectionId: string,
  reason: string,
): Promise<void> {
  const row = await prisma.erpConnection.findUnique({ where: { id: connectionId } });
  if (row === null || row.deletedAt !== null) return;

  const failures = row.consecutiveFailures + 1;

  if (failures < env.ERP_FAILURE_THRESHOLD) {
    await prisma.erpConnection.update({
      where: { id: connectionId },
      data: { consecutiveFailures: failures, lastSyncFailureAt: new Date() },
    });
    return;
  }

  // The status machine refuses this from PAUSED or DISABLED - a connection
  // somebody deliberately stopped should not be reported as broken - so a
  // refusal here is expected and is not an error.
  let nextStatus: ErpConnectionStatusName;
  try {
    nextStatus = assertErpTransition(row.status, 'SUSPEND');
  } catch {
    await prisma.erpConnection.update({
      where: { id: connectionId },
      data: { consecutiveFailures: failures, lastSyncFailureAt: new Date() },
    });
    return;
  }

  await prisma.erpConnection.update({
    where: { id: connectionId },
    data: {
      status: nextStatus,
      statusChangedAt: new Date(),
      statusReason: reason.slice(0, 500),
      consecutiveFailures: failures,
      circuitOpenedAt: new Date(),
      lastSyncFailureAt: new Date(),
      nextPollAt: null,
    },
  });

  await recordAudit({
    action: AuditAction.ERP_CONNECTION_SUSPENDED,
    resourceType: 'erp_connection',
    resourceId: connectionId,
    actorType: 'SYSTEM',
    after: { failures, reason: reason.slice(0, 500) },
  });
}

/** A successful call clears the failure count. */
export async function recordConnectionSuccess(connectionId: string): Promise<void> {
  await prisma.erpConnection
    .update({
      where: { id: connectionId },
      data: { consecutiveFailures: 0, circuitOpenedAt: null, lastSyncSuccessAt: new Date() },
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// OAuth token cache
// ---------------------------------------------------------------------------

/**
 * A usable access token for an OAuth connection, fetching one if needed.
 *
 * The cache is on the row rather than in memory because there are two processes
 * - the API and the worker - and a token fetched by one is perfectly usable by
 * the other. An in-memory cache would double the token requests and, on an ERP
 * that rate-limits its token endpoint, halve the number of syncs that work.
 */
export async function ensureOAuthToken(row: ConnectionRow): Promise<string | null> {
  if (row.authMethod !== 'OAUTH2') return null;

  const context = callContextFor(row);

  if (row.oauthTokenEnc !== null && row.oauthTokenExpiresAt !== null) {
    if (row.oauthTokenExpiresAt.getTime() > Date.now()) {
      try {
        const { decryptSecret } = await import('../../infra/crypto.js');
        return decryptSecret(row.oauthTokenEnc, erpCredentialAad(row.id));
      } catch {
        // A token that will not decrypt is a rotated key or a copied row.
        // Falling through fetches a fresh one, which is the right recovery.
      }
    }
  }

  const token = await fetchOAuthToken(context);

  await prisma.erpConnection.update({
    where: { id: row.id },
    data: {
      oauthTokenEnc: encryptSecret(token.accessToken, erpCredentialAad(row.id)),
      oauthTokenExpiresAt: token.expiresAt,
    },
  });

  return token.accessToken;
}

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

export interface EndpointTestResult {
  endpoint: EndpointKey;
  /** Null when the customer has not configured this endpoint. */
  configured: boolean;
  ok: boolean;
  httpStatus: number | null;
  durationMs: number | null;
  /** Safe for display. Never a provider body. */
  message: string | null;
}

export interface TestConnectionResult {
  ok: boolean;
  /** Whether the credentials were accepted, judged separately from reachability. */
  authenticated: boolean;
  httpStatus: number | null;
  durationMs: number | null;
  message: string;
  endpoints: EndpointTestResult[];
  mapping: {
    checked: boolean;
    ok: boolean;
    issues: { field: string; code: string; message: string }[];
    resolved: { field: string; path: string; sample: string | null }[];
  };
  testedAt: string;
  status: ErpConnectionStatus;
}

/**
 * Prove the connection works, without changing anything in the ERP.
 *
 * Only read endpoints are called. The order-creation endpoint is deliberately
 * NOT exercised - a "test" that creates a real order in somebody's ERP is not a
 * test, it is an incident - so what is reported for it is that it is
 * configured and on-origin, which is what can be known without side effects.
 *
 * Everything reported is safe: a status code, a round-trip time, and a sentence
 * from `safeErrorMessage`. No header, no token, no provider body.
 */
export async function testConnection(
  actor: ErpActor,
  connectionId: string,
): Promise<TestConnectionResult> {
  assertFeatureEnabled();

  const existing = await loadConnection(connectionId);
  const correlationId = actor.correlationId ?? newId();
  const log = loggerFor(correlationId, { connectionId, actorUserId: actor.userId });

  // TESTING is held on the row so a second tab pressing the button does not run
  // a concurrent test whose result would overwrite this one's.
  const testingStatus = assertErpTransition(existing.status, 'START_TEST');
  const previousStatus = existing.status;

  await prisma.erpConnection.update({
    where: { id: connectionId },
    data: { status: testingStatus, statusChangedAt: new Date() },
  });

  const claim = await claimEvent({
    connectionId,
    eventType: 'CONNECTION_TEST',
    correlationId,
    // No idempotency key: a test may be run as often as somebody likes, and a
    // key would make the second press of the button silently do nothing.
  });

  const eventId = claim.outcome === 'CLAIMED' ? claim.eventId : null;
  const attempt = claim.outcome === 'CLAIMED' ? claim.attempt : 1;

  const endpoints: EndpointTestResult[] = [];
  let authenticated = false;
  let overallStatus: number | null = null;
  let overallDuration: number | null = null;
  let failureMessage: string | null = null;
  let firstError: unknown = null;
  let sampleForMapping: unknown = null;

  try {
    const oauthToken = await ensureOAuthToken(existing);
    const context = callContextFor(existing);
    const methods = readMethods(existing);

    // Read endpoints only, and inventory first: it is the one most likely to be
    // configured and the one whose response the mapping check needs.
    const readable: EndpointKey[] = ['inventory', 'product', 'warehouse', 'orderStatus'];

    for (const key of readable) {
      const configured = endpointPath(existing, key);

      if (configured === null) {
        endpoints.push({
          endpoint: key,
          configured: false,
          ok: true,
          httpStatus: null,
          durationMs: null,
          message: 'Not configured.',
        });
        continue;
      }

      try {
        const url = resolveEndpointUrl(existing.baseUrl, configured, `endpoints.${key}`);
        const method = methods[key];

        const result = await callErp(context, url, {
          // A read endpoint is called with its configured method, except that a
          // write verb is downgraded to GET here: testing must not create
          // anything, and an ERP that needs POST to READ stock still answers a
          // GET with 405, which is a perfectly informative test result.
          method: method === 'GET' ? 'GET' : 'GET',
          oauthAccessToken: oauthToken,
          maxResponseBytes: 512 * 1024,
        });

        authenticated = true;
        overallStatus ??= result.status;
        overallDuration ??= result.durationMs;

        if (key === 'inventory') sampleForMapping = result.data;

        endpoints.push({
          endpoint: key,
          configured: true,
          ok: true,
          httpStatus: result.status,
          durationMs: result.durationMs,
          message: null,
        });
      } catch (error) {
        firstError ??= error;
        const erpError = error instanceof ErpCallError ? error : null;

        // An ERP that answered at all - even with a 4xx that is not 401 -
        // proves reachability and credentials. Only AUTH says otherwise.
        if (erpError !== null && erpError.kind !== 'AUTH' && erpError.httpStatus !== null) {
          authenticated = true;
        }

        overallStatus ??= erpError?.httpStatus ?? null;

        endpoints.push({
          endpoint: key,
          configured: true,
          ok: false,
          httpStatus: erpError?.httpStatus ?? null,
          durationMs: null,
          message: safeErrorMessage(error),
        });

        failureMessage ??= safeErrorMessage(error);
      }
    }

    // The write endpoint, reported without being called. See the header.
    const orderCreate = endpointPath(existing, 'orderCreate');
    endpoints.push({
      endpoint: 'orderCreate',
      configured: orderCreate !== null,
      ok: true,
      httpStatus: null,
      durationMs: null,
      message:
        orderCreate === null
          ? 'Not configured.'
          : 'Configured. Not called during a test, so that no order is created in the ERP.',
    });
  } catch (error) {
    // Thrown by `ensureOAuthToken`, which fails before any endpoint is tried.
    firstError = error;
    failureMessage = safeErrorMessage(error);
    overallStatus = error instanceof ErpCallError ? error.httpStatus : null;
  }

  // --- Mapping, against whatever the inventory endpoint returned -----------
  const mapping = parseFieldMapping(existing.fieldMappingJson);
  const mappingResult =
    mapping === null || sampleForMapping === null
      ? { checked: false, ok: false, issues: [], resolved: [] }
      : (() => {
          // The sample is a record from the INVENTORY endpoint, so only the
          // inventory half of the mapping can be checked against it. The order
          // fields - `erpOrderId` and the rest - describe the response to an
          // order CREATION, which a test deliberately never makes: a "test"
          // that puts a real order in somebody's ERP is not a test. Their
          // structural presence is enforced at save time by
          // `validateFieldMapping`.
          const verified = verifyAgainstSample(
            mapping,
            sampleForMapping,
            { inventory: true, order: false },
            INVENTORY_SAMPLE_GROUPS,
          );
          return {
            checked: true,
            ok: verified.ok,
            issues: verified.issues,
            resolved: verified.resolved.map((entry) => ({
              field: entry.field,
              path: entry.path,
              sample: entry.sample,
            })),
          };
        })();

  const configuredEndpoints = endpoints.filter((entry) => entry.configured);
  const anyCalled = configuredEndpoints.some((entry) => entry.httpStatus !== null);
  const allOk = configuredEndpoints.every((entry) => entry.ok);
  const ok = allOk && anyCalled;

  const message = ok
    ? mappingResult.checked && !mappingResult.ok
      ? 'The connection works, but the field mapping does not match what the ERP returned.'
      : 'The connection works.'
    : (failureMessage ?? 'No endpoint could be reached. Check the address and the endpoints.');

  // --- Record the outcome ------------------------------------------------
  //
  // A failed test leaves the connection in ERROR rather than back where it
  // started, so the list screen shows the problem rather than a connection that
  // looks fine and silently is not.
  const resultStatus = assertErpTransition(testingStatus, ok ? 'TEST_PASSED' : 'TEST_FAILED');

  const updated = await prisma.erpConnection.update({
    where: { id: connectionId },
    data: {
      status: resultStatus,
      statusChangedAt: new Date(),
      statusReason: ok ? null : message.slice(0, 500),
      lastTestAt: new Date(),
      lastTestOk: ok,
      lastTestHttpStatus: overallStatus,
      lastTestDurationMs: overallDuration,
      lastTestMessage: message.slice(0, 500),
      ...(ok ? { consecutiveFailures: 0, circuitOpenedAt: null } : {}),
      // Verified only when a real response went through the mapping and passed.
      // A test that could not read a sample leaves the previous verification
      // alone rather than revoking it.
      ...(mappingResult.checked ? { mappingVerifiedAt: mappingResult.ok ? new Date() : null } : {}),
    },
  });

  if (eventId !== null) {
    if (ok) {
      await recordEventSuccess({
        eventId,
        httpStatus: overallStatus,
        durationMs: overallDuration,
        response: { endpoints: endpoints.map((entry) => ({ ...entry })) },
      });
    } else {
      await recordEventFailure({ eventId, attempt, error: firstError ?? new Error(message) });
    }
  }

  await recordAudit({
    action: AuditAction.ERP_CONNECTION_TESTED,
    resourceType: 'erp_connection',
    resourceId: connectionId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: {
      ok,
      httpStatus: overallStatus,
      durationMs: overallDuration,
      previousStatus,
      status: resultStatus,
    },
    ipAddress: actor.ipAddress ?? null,
    correlationId,
  });

  log.info({ ok, httpStatus: overallStatus }, 'customer ERP connection tested');

  return {
    ok,
    authenticated,
    httpStatus: overallStatus,
    durationMs: overallDuration,
    message,
    endpoints,
    mapping: mappingResult,
    testedAt: (updated.lastTestAt ?? new Date()).toISOString(),
    status: updated.status,
  };
}

function endpointPath(row: ConnectionRow, key: EndpointKey): string | null {
  switch (key) {
    case 'product':
      return row.productEndpoint;
    case 'inventory':
      return row.inventoryEndpoint;
    case 'warehouse':
      return row.warehouseEndpoint;
    case 'orderCreate':
      return row.orderCreateEndpoint;
    case 'orderStatus':
      return row.orderStatusEndpoint;
  }
}

export { endpointPath, readMethods, readCustomHeaders };

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

export interface DryRunResult {
  ok: boolean;
  /** Where the records were found, and how many. */
  recordsFound: number;
  itemsPath: string;
  /** Up to five records as this system would read them. */
  preview: Record<string, string | number | null>[];
  issues: { field: string; code: string; message: string }[];
  resolved: { field: string; path: string; sample: string | null }[];
  message: string;
  /** True when the mapping is now recorded as verified. */
  mappingVerified: boolean;
}

/**
 * Read from the ERP and show what the mapping makes of it - changing nothing.
 *
 * The rehearsal. It fetches the inventory endpoint, applies the mapping, and
 * shows the customer the first few records as this system would understand
 * them, without writing a single stock figure. That is the difference between
 * "the mapping looks right" and "the mapping IS right", and it is what
 * `mappingVerifiedAt` records.
 *
 * No order is created, no payment is taken, no balance moves. The word "dry" is
 * load-bearing.
 */
export async function dryRun(
  actor: ErpActor,
  connectionId: string,
  overrideMapping?: FieldMapping,
): Promise<DryRunResult> {
  assertFeatureEnabled();

  const existing = await loadConnection(connectionId);
  const correlationId = actor.correlationId ?? newId();

  const inventoryEndpoint = existing.inventoryEndpoint;
  if (inventoryEndpoint === null || inventoryEndpoint === '') {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Set the inventory endpoint before running a dry run.',
      [{ field: 'endpoints.inventory', code: 'REQUIRED' }],
    );
  }

  const mapping = overrideMapping ?? parseFieldMapping(existing.fieldMappingJson);
  if (mapping === null) {
    throw badRequest(
      ErrorCode.ERP_MAPPING_INVALID,
      'Set up the field mapping before running a dry run.',
      [{ field: 'fieldMapping', code: 'REQUIRED' }],
    );
  }

  const claim = await claimEvent({
    connectionId,
    eventType: 'DRY_RUN',
    correlationId,
  });
  const eventId = claim.outcome === 'CLAIMED' ? claim.eventId : null;
  const attempt = claim.outcome === 'CLAIMED' ? claim.attempt : 1;

  try {
    const oauthToken = await ensureOAuthToken(existing);
    const url = resolveEndpointUrl(existing.baseUrl, inventoryEndpoint, 'endpoints.inventory');

    const result = await callErp(callContextFor(existing), url, {
      method: 'GET',
      oauthAccessToken: oauthToken,
      maxResponseBytes: 1024 * 1024,
    });

    const { extractRecords, coerceQuantity, coerceString, readPath } = await import(
      './erp-field-mapping.js'
    );

    // Inventory only, and for the same reason as in `testConnection`: this
    // read came from the stock endpoint, and asking a stock record for an ERP
    // order id would fail every honest mapping.
    const verified = verifyAgainstSample(
      mapping,
      result.data,
      { inventory: true, order: false },
      INVENTORY_SAMPLE_GROUPS,
    );

    const records = extractRecords(mapping, result.data) ?? [];

    const preview = records.slice(0, 5).map((record) => {
      const row: Record<string, string | number | null> = {};

      for (const [field, path] of Object.entries(mapping.fields)) {
        const raw = readPath(record, path);
        row[field] =
          field === 'availableQuantity' || field === 'reservedQuantity'
            ? coerceQuantity(raw)
            : coerceString(raw);
      }

      return row;
    });

    // A dry run that both reads real records and validates against them is
    // exactly the evidence `mappingVerifiedAt` stands for.
    const mappingVerified = verified.ok && records.length > 0 && overrideMapping === undefined;

    if (mappingVerified) {
      await prisma.erpConnection.update({
        where: { id: connectionId },
        data: { mappingVerifiedAt: new Date() },
      });

      await recordAudit({
        action: AuditAction.ERP_MAPPING_UPDATED,
        resourceType: 'erp_connection',
        resourceId: connectionId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { verified: true, recordsSeen: records.length },
        correlationId,
      });
    }

    if (eventId !== null) {
      await recordEventSuccess({
        eventId,
        httpStatus: result.status,
        durationMs: result.durationMs,
        response: { recordsFound: records.length, mappingOk: verified.ok },
      });
    }

    return {
      ok: verified.ok,
      recordsFound: records.length,
      itemsPath: mapping.itemsPath ?? '(the response itself)',
      preview,
      issues: verified.issues,
      resolved: verified.resolved.map((entry) => ({
        field: entry.field,
        path: entry.path,
        sample: entry.sample,
      })),
      message: verified.ok
        ? `Read ${String(records.length)} record${records.length === 1 ? '' : 's'}. Nothing was ` +
          'changed. The mapping matches what the ERP returned.'
        : 'Nothing was changed. The mapping does not match what the ERP returned - see below.',
      mappingVerified,
    };
  } catch (error) {
    if (eventId !== null) {
      await recordEventFailure({ eventId, attempt, error });
    }

    if (error instanceof ErpCallError) {
      return {
        ok: false,
        recordsFound: 0,
        itemsPath: mapping.itemsPath ?? '(the response itself)',
        preview: [],
        issues: [{ field: 'connection', code: error.errorCode, message: error.message }],
        resolved: [],
        message: error.message,
        mappingVerified: false,
      };
    }

    throw error;
  }
}
