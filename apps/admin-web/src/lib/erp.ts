/**
 * The Settings -> ERP API, as the admin panel calls it.
 *
 * A thin typed layer over `api`. One thing it is careful about, and it is the
 * same care the server takes: **nothing here can carry a credential back.** The
 * response types have no field for one because the server has none either. What
 * the edit form shows is `credentialHint` - `X-API-Key: sk_live...9f2a` - which
 * identifies a key without being one.
 *
 * The other half of that contract lives in `buildConnectionBody`: a secret the
 * administrator did not retype is OMITTED, so saving a timeout does not wipe a
 * working API key the form never held. An explicit empty string clears one, and
 * that is a deliberate act rather than the default.
 */
import { api } from './api';

const BASE = '/admin/erp';

export const erpKeys = {
  capabilities: ['erp', 'capabilities'] as const,
  connections: ['erp', 'connections'] as const,
  connection: (id: string) => ['erp', 'connections', id] as const,
  syncRuns: (id: string) => ['erp', 'connections', id, 'sync-runs'] as const,
  inventory: (connectionId?: string) => ['erp', 'inventory', connectionId ?? 'all'] as const,
  events: (connectionId?: string) => ['erp', 'events', connectionId ?? 'all'] as const,
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ErpEndpointKey =
  | 'product'
  | 'inventory'
  | 'warehouse'
  | 'orderCreate'
  | 'orderStatus';

export type ErpHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

export type ErpConnectionStatus =
  | 'DRAFT'
  | 'TESTING'
  | 'CONNECTED'
  | 'ACTIVE'
  | 'PAUSED'
  | 'ERROR'
  | 'DISABLED';

export type ErpAuthMethod = 'API_KEY' | 'BEARER_TOKEN' | 'BASIC' | 'OAUTH2';

export interface ErpFieldMapping {
  itemsPath?: string;
  /** Platform field name -> dotted path in the ERP's own JSON. */
  fields: Record<string, string>;
  warehouseMap?: Record<string, string>;
  orderStatusMap?: Record<string, string>;
}

export interface ErpConnection {
  id: string;
  name: string;
  baseUrl: string;
  status: ErpConnectionStatus;
  statusReason: string | null;
  statusChangedAt: string;
  endpoints: Record<ErpEndpointKey, string | null>;
  methods: Record<ErpEndpointKey, ErpHttpMethod>;
  customHeaders: Record<string, string>;
  timeoutMs: number;
  authMethod: ErpAuthMethod;
  /** Enough to recognise which key is configured, never enough to use it. */
  credentialHint: string | null;
  hasCredentials: boolean;
  oauthTokenUrl: string | null;
  oauthScope: string | null;
  webhookEnabled: boolean;
  hasWebhookSecret: boolean;
  webhookSignatureHeader: string;
  /** The address to paste into the ERP. Null when webhooks are off. */
  webhookUrl: string | null;
  pollingEnabled: boolean;
  pollingIntervalMinutes: number;
  lastPolledAt: string | null;
  nextPollAt: string | null;
  fieldMapping: ErpFieldMapping | null;
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
  /** Which buttons to offer. Derived on the server from the state machine. */
  availableActions: string[];
  /** Why the switch-on button is disabled, in sentences ready to render. */
  activationBlockers: string[];
}

export interface ErpMappingIssue {
  field: string;
  code: string;
  message: string;
}

export interface ErpEndpointTest {
  endpoint: ErpEndpointKey;
  configured: boolean;
  ok: boolean;
  httpStatus: number | null;
  durationMs: number | null;
  message: string | null;
}

export interface ErpTestResult {
  ok: boolean;
  authenticated: boolean;
  httpStatus: number | null;
  durationMs: number | null;
  message: string;
  endpoints: ErpEndpointTest[];
  mapping: {
    checked: boolean;
    ok: boolean;
    issues: ErpMappingIssue[];
    resolved: { field: string; path: string; sample: string | null }[];
  };
  testedAt: string;
  status: ErpConnectionStatus;
}

export interface ErpDryRunResult {
  ok: boolean;
  recordsFound: number;
  itemsPath: string;
  preview: Record<string, string | number | null>[];
  issues: ErpMappingIssue[];
  resolved: { field: string; path: string; sample: string | null }[];
  message: string;
  mappingVerified: boolean;
}

export interface ErpSyncOutcome {
  runId: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'RATE_LIMITED';
  processed: number;
  applied: number;
  skipped: number;
  failed: number;
  conflicts: number;
  message: string;
  rateLimitedUntil: string | null;
}

export interface ErpSyncRun {
  id: string;
  connectionId: string;
  trigger: string;
  status: string;
  isDryRun: boolean;
  correlationId: string;
  startedAt: string;
  finishedAt: string | null;
  processedCount: number;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  conflictCount: number;
  rateLimitedUntil: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ErpInventoryLine {
  sku: string;
  warehouseKey: string;
  productId: string | null;
  availableQuantity: number;
  reservedQuantity: number;
  effectiveQuantity: number;
  unitOfMeasure: string | null;
  erpProductName: string | null;
  platformQuantityAtSync: number | null;
  hasConflict: boolean;
  manualQuantity: number | null;
  lastSyncedAt: string;
}

export interface IntegrationEvent {
  id: string;
  eventType: string;
  status: string;
  connectionId: string | null;
  orderId: string | null;
  erpOrderReference: string | null;
  correlationId: string;
  idempotencyKey: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  retryable: boolean;
}

export interface ErpCapabilities {
  erpIntegration: boolean;
  maxConnections: number;
  /** The mapping fields to render, sent by the server so a new one needs no redeploy. */
  mappingFields: { key: string; label: string; group: string; kind: string }[];
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export interface ErpCredentialsInput {
  headerName?: string;
  apiKey?: string;
  token?: string;
  username?: string;
  password?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface ConnectionFormValues {
  name: string;
  baseUrl: string;
  endpoints: Record<ErpEndpointKey, string>;
  methods: Partial<Record<ErpEndpointKey, ErpHttpMethod>>;
  timeoutSeconds: number;
  authMethod: ErpAuthMethod;
  credentials: ErpCredentialsInput;
  oauthTokenUrl: string;
  oauthScope: string;
  webhookEnabled: boolean;
  webhookSecret: string;
  webhookSignatureHeader: string;
  pollingEnabled: boolean;
  pollingIntervalMinutes: number;
  fieldMapping: ErpFieldMapping;
  inventoryAuthority: 'ERP' | 'PLATFORM' | 'MANUAL';
  allowManualOverride: boolean;
  orderPushEnabled: boolean;
  idempotencyHeader: string;
}

/**
 * Drop a secret that was not retyped.
 *
 * The whole masked-form contract in one function. An empty string is kept - it
 * is how a credential is cleared - and an absent one is omitted so the stored
 * value survives an unrelated edit.
 */
function credentialsForSubmit(
  values: ConnectionFormValues,
  isEditing: boolean,
): ErpCredentialsInput | undefined {
  const entries = Object.entries(values.credentials).filter(([key, value]) => {
    if (value === undefined) return false;
    // `headerName` is not a secret; it is which header the key travels in, and
    // the form always knows it.
    if (key === 'headerName') return value !== '';
    return isEditing ? value !== '' : true;
  });

  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function buildConnectionBody(
  values: ConnectionFormValues,
  isEditing: boolean,
): Record<string, unknown> {
  const credentials = credentialsForSubmit(values, isEditing);
  const webhookSecret = values.webhookSecret.trim();

  return {
    name: values.name.trim(),
    baseUrl: values.baseUrl.trim(),
    endpoints: {
      product: values.endpoints.product.trim() || null,
      inventory: values.endpoints.inventory.trim() || null,
      warehouse: values.endpoints.warehouse.trim() || null,
      orderCreate: values.endpoints.orderCreate.trim() || null,
      orderStatus: values.endpoints.orderStatus.trim() || null,
    },
    methods: values.methods,
    // Seconds in the form, milliseconds on the wire. Nobody types 15000.
    timeoutMs: Math.round(values.timeoutSeconds * 1000),
    authMethod: values.authMethod,
    ...(credentials === undefined ? {} : { credentials }),
    oauthTokenUrl: values.oauthTokenUrl.trim() || null,
    oauthScope: values.oauthScope.trim() || null,
    webhookEnabled: values.webhookEnabled,
    // Same rule as a credential: absent means keep.
    ...(isEditing && webhookSecret === '' ? {} : { webhookSecret: webhookSecret || null }),
    webhookSignatureHeader: values.webhookSignatureHeader.trim() || 'X-UBOSS-Signature',
    pollingEnabled: values.pollingEnabled,
    pollingIntervalMinutes: values.pollingIntervalMinutes,
    fieldMapping: values.fieldMapping,
    inventoryAuthority: values.inventoryAuthority,
    allowManualOverride: values.allowManualOverride,
    orderPushEnabled: values.orderPushEnabled,
    idempotencyHeader: values.idempotencyHeader.trim() || 'Idempotency-Key',
  };
}

function isAuthority(value: string): value is 'ERP' | 'PLATFORM' | 'MANUAL' {
  return value === 'ERP' || value === 'PLATFORM' || value === 'MANUAL';
}

export function connectionToForm(connection: ErpConnection): ConnectionFormValues {
  return {
    name: connection.name,
    baseUrl: connection.baseUrl,
    endpoints: {
      product: connection.endpoints.product ?? '',
      inventory: connection.endpoints.inventory ?? '',
      warehouse: connection.endpoints.warehouse ?? '',
      orderCreate: connection.endpoints.orderCreate ?? '',
      orderStatus: connection.endpoints.orderStatus ?? '',
    },
    methods: connection.methods,
    timeoutSeconds: Math.round(connection.timeoutMs / 1000),
    authMethod: connection.authMethod,
    // Empty, always. The server never sends a secret, so the form never holds
    // one, so an untouched field cannot overwrite what is stored.
    credentials: {
      headerName:
        connection.credentialHint === null
          ? 'X-API-Key'
          : (connection.credentialHint.split(':')[0] ?? 'X-API-Key'),
    },
    oauthTokenUrl: connection.oauthTokenUrl ?? '',
    oauthScope: connection.oauthScope ?? '',
    webhookEnabled: connection.webhookEnabled,
    webhookSecret: '',
    webhookSignatureHeader: connection.webhookSignatureHeader,
    pollingEnabled: connection.pollingEnabled,
    pollingIntervalMinutes: connection.pollingIntervalMinutes,
    fieldMapping: connection.fieldMapping ?? { fields: {} },
    inventoryAuthority: isAuthority(connection.inventoryAuthority)
      ? connection.inventoryAuthority
      : 'ERP',
    allowManualOverride: connection.allowManualOverride,
    orderPushEnabled: connection.orderPushEnabled,
    idempotencyHeader: connection.idempotencyHeader,
  };
}

export function emptyConnectionForm(): ConnectionFormValues {
  return {
    name: '',
    baseUrl: '',
    endpoints: { product: '', inventory: '', warehouse: '', orderCreate: '', orderStatus: '' },
    methods: {},
    timeoutSeconds: 15,
    authMethod: 'API_KEY',
    credentials: { headerName: 'X-API-Key' },
    oauthTokenUrl: '',
    oauthScope: '',
    webhookEnabled: false,
    webhookSecret: '',
    webhookSignatureHeader: 'X-UBOSS-Signature',
    pollingEnabled: true,
    pollingIntervalMinutes: 60,
    fieldMapping: { itemsPath: '', fields: {} },
    inventoryAuthority: 'ERP',
    allowManualOverride: false,
    orderPushEnabled: true,
    idempotencyHeader: 'Idempotency-Key',
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const erpApi = {
  capabilities: () => api.get<ErpCapabilities>(`${BASE}/capabilities`),

  listConnections: () =>
    api
      .get<{ connections: ErpConnection[] }>(`${BASE}/connections`)
      .then((response) => response.connections),

  getConnection: (id: string) =>
    api
      .get<{ connection: ErpConnection }>(`${BASE}/connections/${id}`)
      .then((response) => response.connection),

  createConnection: (body: Record<string, unknown>) =>
    api
      .post<{ connection: ErpConnection }>(`${BASE}/connections`, body)
      .then((response) => response.connection),

  updateConnection: (id: string, body: Record<string, unknown>) =>
    api
      .put<{ connection: ErpConnection }>(`${BASE}/connections/${id}`, body)
      .then((response) => response.connection),

  deleteConnection: (id: string) => api.delete<{ deleted: true }>(`${BASE}/connections/${id}`),

  test: (id: string) =>
    api
      .post<{ test: ErpTestResult }>(`${BASE}/connections/${id}/test`)
      .then((response) => response.test),

  dryRun: (id: string) =>
    api
      .post<{ dryRun: ErpDryRunResult }>(`${BASE}/connections/${id}/dry-run`, {})
      .then((response) => response.dryRun),

  action: (id: string, action: 'ACTIVATE' | 'PAUSE' | 'RESUME' | 'DISABLE' | 'REOPEN') =>
    api
      .post<{ connection: ErpConnection }>(`${BASE}/connections/${id}/actions`, { action })
      .then((response) => response.connection),

  sync: (id: string) =>
    api
      .post<{ sync: ErpSyncOutcome }>(`${BASE}/connections/${id}/sync`, {})
      .then((response) => response.sync),

  syncRuns: (id: string) =>
    api
      .get<{ runs: ErpSyncRun[] }>(`${BASE}/connections/${id}/sync-runs`)
      .then((response) => response.runs),

  inventory: (params: { connectionId?: string; sku?: string; conflictsOnly?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (params.connectionId !== undefined) query.set('connectionId', params.connectionId);
    if (params.sku !== undefined && params.sku !== '') query.set('sku', params.sku);
    if (params.conflictsOnly === true) query.set('conflictsOnly', 'true');

    const suffix = query.toString();

    return api
      .get<{ inventory: ErpInventoryLine[] }>(
        `${BASE}/inventory${suffix === '' ? '' : `?${suffix}`}`,
      )
      .then((response) => response.inventory);
  },

  events: (params: { connectionId?: string; status?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.connectionId !== undefined) query.set('connectionId', params.connectionId);
    if (params.status !== undefined) query.set('status', params.status);
    if (params.limit !== undefined) query.set('limit', String(params.limit));

    const suffix = query.toString();

    return api.get<{ events: IntegrationEvent[]; nextCursor: string | null }>(
      `${BASE}/events${suffix === '' ? '' : `?${suffix}`}`,
    );
  },

  retryEvent: (id: string) => api.post<{ retried: boolean }>(`${BASE}/events/${id}/retry`),
};
