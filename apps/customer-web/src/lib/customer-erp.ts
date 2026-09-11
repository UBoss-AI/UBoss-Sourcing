/**
 * The Account → Integrations → ERP API, as this app calls it.
 *
 * The buyer-facing half of connecting their own SAP, monday.com or in-house
 * purchasing system. Everything here is scoped to the caller's own buyer
 * organisation by the server, which derives it from the session — there is no
 * organisation id in any path or body on this surface, and there should never
 * be one.
 *
 * TWO RULES THAT SHAPE THE TYPES BELOW
 *
 * **A secret is write-only.** Nothing the server returns carries one. What
 * comes back is `credentials`, a list of hints — `X-API-Key: sk_live...9f2a` —
 * which is enough to recognise which key is configured and never enough to use
 * it. So `ConnectionView` has no `apiKey`, and `secrets` exists only on the
 * request shape.
 *
 * **An absent secret means "keep what is stored".** A form that omits
 * `clientSecret` leaves the stored one alone; an empty string clears it. That
 * is what makes a masked edit form work — the buyer changes the timeout, the
 * form sends no secret because it never had one to send, and the secret
 * survives. `undefined` and `''` therefore mean different things here and must
 * not be collapsed with a `??`.
 *
 * Money crosses this boundary as a STRING of minor units, as everywhere else in
 * this app. `12.34 * 100` is 1233.9999999999998, and an approval threshold one
 * unit under what somebody typed will one day let through an order they meant
 * to be asked about.
 */
import { api } from './api';

const BASE = '/account/integrations/erp';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The PROTOCOL a connection speaks, not the brand it is.
 *
 * Four of them, because there are four genuinely different dialects - not
 * because there are four ERPs. NetSuite, Dynamics, Zoho, QuickBooks, TCS iON
 * and a dozen more are all 'CUSTOM': REST and JSON over OAuth 2.0. Which brand
 * a buyer picked is 'vendorPreset', and the words for it are 'vendorLabel'.
 */
export type ErpSystem = 'SAP' | 'MONDAY' | 'ODOO' | 'CUSTOM';
export type ErpApiStyle = 'REST_JSON' | 'ODATA' | 'GRAPHQL';

/**
 * Which market's ERPs to put first in the catalogue.
 *
 * Ordering only - every preset is returned whatever the region. An Indian
 * buyer should not scroll past four American mid-market systems to reach
 * Tally, and a German one should not lead with Marg.
 */
export type ErpRegion = 'global' | 'india' | 'eu';
export type ErpEnvironment = 'SANDBOX' | 'PRODUCTION';

export type ErpAuthMethod =
  | 'OAUTH2_CLIENT_CREDENTIALS'
  | 'OAUTH2_AUTHORIZATION_CODE'
  | 'API_KEY'
  | 'BEARER_TOKEN'
  | 'BASIC'
  | 'MONDAY_PERSONAL_TOKEN';

export type ErpNetworkMode =
  | 'PUBLIC_HTTPS'
  | 'IP_ALLOWLIST'
  | 'VPN_GATEWAY'
  | 'SAP_CLOUD_CONNECTOR';

export type ErpConnectionState =
  | 'DRAFT'
  | 'TESTING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'ACTION_REQUIRED'
  | 'FAILED'
  | 'DISCONNECTED';

export type ErpEventState =
  | 'QUEUED'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'RETRYING'
  | 'FAILED'
  | 'SKIPPED';

export type ErpEndpointPurpose =
  | 'PRODUCTS'
  | 'WAREHOUSES'
  | 'INVENTORY'
  | 'PURCHASE_ORDER_CREATE'
  | 'PURCHASE_ORDER_UPDATE'
  | 'GOODS_RECEIPT'
  | 'SHIPMENT_STATUS'
  | 'INVOICE'
  | 'PAYMENT_REFERENCE'
  | 'WEBHOOK';

export type ErpPagination =
  | 'NONE'
  | 'PAGE_NUMBER'
  | 'OFFSET_LIMIT'
  | 'CURSOR'
  | 'ODATA_NEXT_LINK';

export type ErpMappingEntity =
  | 'PRODUCT'
  | 'WAREHOUSE'
  | 'ORDER'
  | 'INVENTORY'
  | 'INVOICE'
  | 'PAYMENT'
  | 'STATUS';

export type ErpTransform =
  | 'TRIM'
  | 'UPPERCASE'
  | 'LOWERCASE'
  | 'MINOR_TO_DECIMAL'
  | 'DECIMAL_TO_MINOR'
  | 'ISO_DATE'
  | 'DATE_ONLY';

export type OrgRole = 'OWNER' | 'INTEGRATION_MANAGER' | 'MEMBER';
export type OrgCapability = 'VIEW' | 'OPERATE' | 'CONFIGURE' | 'ADMINISTER';

// ---------------------------------------------------------------------------
// Shapes the server returns
// ---------------------------------------------------------------------------

export interface PlatformFieldSpec {
  key: string;
  label: string;
  required: boolean;
  type: 'string' | 'number' | 'money' | 'date' | 'enum';
}

export interface SystemOption {
  system: ErpSystem;
  apiStyle: ErpApiStyle;
  authMethods: ErpAuthMethod[];
  endpoints: {
    purpose: ErpEndpointPurpose;
    path: string;
    method: string;
    pagination?: ErpPagination;
    recordsPath?: string;
  }[];
  mappings: MappingRow[];
  /** Instructions for the buyer's IT team. Shown on the network step. */
  networkNotes: string;
  supportsWebhooks: boolean;
}

/**
 * One named ERP in the catalogue.
 *
 * A brand rather than a protocol: it carries the label a buyer recognises, the
 * connector that speaks to it, and what to ask their own IT team for. The
 * endpoint paths and field mapping are deliberately NOT here - the server
 * applies the preset it is told about when the connection is created, so a
 * catalogue that grows never has to be mirrored into the browser bundle.
 */
export interface VendorPresetOption {
  id: string;
  label: string;
  connector: ErpSystem;
  apiStyle: ErpApiStyle;
  authMethods: ErpAuthMethod[];
  /** Shown as the address placeholder. Never filled in for them. */
  baseUrlExample: string;
  /** What to ask their IT team for. Rendered on the network step. */
  notes: string;
  /**
   * Whether the endpoint paths are a worked example rather than that vendor's
   * published API. Rendered as a warning where true.
   */
  defaultsAreExamples: boolean;
  /** Typically inside the buyer's own network, so it needs a gateway. */
  onPremiseTypical: boolean;
  regions: string[];
}

export interface ErpOptions {
  available: boolean;
  /** The named ERPs, already ordered for this deployment's market. */
  presets: VendorPresetOption[];
  systems: SystemOption[];
  platformFields: Record<ErpMappingEntity, PlatformFieldSpec[]>;
  transforms: ErpTransform[];
  /** The address a buyer registers with their own ERP before authorising. */
  oauthRedirectUri: string;
  maxConnections: number;
}

export interface CredentialSummary {
  kind: 'PRIMARY' | 'OAUTH_TOKENS' | 'WEBHOOK_SIGNING' | 'CLIENT_CERTIFICATE';
  /** Never a secret. Enough to recognise which key is configured. */
  hint: string | null;
  expiresAt: string | null;
  grantedScope: string | null;
  rotatedAt: string | null;
  expired: boolean;
}

export interface EndpointView {
  purpose: ErpEndpointPurpose;
  path: string;
  method: string;
  enabled: boolean;
  pagination: ErpPagination;
  paginationConfig: Record<string, unknown>;
  recordsPath: string | null;
  requestTemplate: Record<string, unknown> | null;
  queryParams: Record<string, string>;
}

export interface MappingRow {
  entity: ErpMappingEntity;
  platformField: string;
  erpPath: string;
  constantValue: string | null;
  erpValue: string | null;
  transform: ErpTransform | null;
  required?: boolean;
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
  /** Minor units, as a string. Never a number. */
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

/** What every member sees. A different shape from the full one, not a subset. */
export interface ConnectionHealth {
  id: string;
  name: string;
  system: ErpSystem;
  /** The brand in words - "Oracle NetSuite" rather than "CUSTOM". */
  vendorLabel: string;
  environment: ErpEnvironment;
  state: ErpConnectionState;
  stateLabel: string;
  stateReason: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  nextPollAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  eventCounts: Partial<Record<ErpEventState, number>>;
  pendingApprovals: number;
}

/** What an owner or integration manager sees. Adds configuration, never secrets. */
export interface ConnectionView extends ConnectionHealth {
  apiStyle: ErpApiStyle;
  /** Which catalogue entry this is, or null for one created without a preset. */
  vendorPreset: string | null;
  erpVersion: string | null;
  baseUrl: string;
  apiVersion: string | null;
  networkMode: ErpNetworkMode;
  networkNotes: string | null;
  tenantIdentifier: string | null;
  customHeaders: Record<string, string>;
  timeoutMs: number;
  authMethod: ErpAuthMethod;
  apiKeyLocation: 'HEADER' | 'QUERY' | null;
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
  /** The address to register with their ERP. Null while webhooks are off. */
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
  credentials: CredentialSummary[];
  endpoints: EndpointView[];
  mappings: MappingRow[];
  warehouseMaps: WarehouseMapView[];
  policy: PolicyView;
  /** Which buttons to render, straight from the server's state machine. */
  actions: string[];
  createdAt: string;
  updatedAt: string;
}

export function isFullConnection(
  connection: ConnectionHealth | ConnectionView,
): connection is ConnectionView {
  // `baseUrl` is present on the owner's shape and absent from the member's, so
  // it is what distinguishes them. A role check here instead would mean the
  // screen deciding what it is allowed to see, which is the server's job.
  return 'baseUrl' in connection;
}

export interface SampleCheckField {
  entity: ErpMappingEntity;
  platformField: string;
  label: string;
  erpPath: string;
  found: boolean;
  sample: string | null;
}

export interface SampleCheck {
  ok: boolean;
  fields: SampleCheckField[];
  missing: string[];
}

export interface TestResult {
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  message: string;
  /** A record from the buyer's own system. What makes the mapping step real. */
  sample: unknown;
  mapping: SampleCheck | null;
}

export interface DryRunResult {
  records: number;
  mapping: SampleCheck | null;
  message: string;
}

export interface SyncResult {
  jobId: string;
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'RATE_LIMITED';
  processed: number;
  applied: number;
  skipped: number;
  failed: number;
  message: string;
}

export interface EventView {
  id: string;
  connectionId: string;
  eventType: string;
  state: ErpEventState;
  orderId: string | null;
  invoiceId: string | null;
  erpReference: string | null;
  correlationId: string;
  idempotencyKey: string;
  attemptCount: number;
  nextRetryAt: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  skipReason: string | null;
  approvalId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SyncJobView {
  id: string;
  connectionId: string;
  trigger: string;
  status: string;
  isDryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  processedCount: number;
  succeededCount: number;
  skippedCount: number;
  failedCount: number;
  errorMessage: string | null;
  correlationId: string;
}

export interface WebhookEventView {
  id: string;
  externalEventId: string;
  externalEventType: string | null;
  verified: boolean;
  rejectionReason: string | null;
  receivedAt: string;
  processedAt: string | null;
  correlationId: string;
}

export interface ApprovalView {
  id: string;
  connectionId: string;
  kind: 'PURCHASE_ORDER' | 'INVENTORY_WRITE';
  state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  syncEventId: string;
  orderId: string | null;
  amountMinor: string | null;
  currency: string | null;
  summary: string;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface AuditRow {
  id: string;
  action: string;
  actorEmail: string | null;
  resourceType: string;
  resourceId: string | null;
  connectionId: string | null;
  before: unknown;
  after: unknown;
  correlationId: string | null;
  createdAt: string;
}

export interface OrganizationView {
  id: string;
  name: string;
  createdAt: string;
  role: OrgRole;
  capabilities: OrgCapability[];
  memberCount: number;
}

export interface MemberView {
  id: string;
  name: string;
  email: string;
  role: OrgRole;
  joinedAt: string;
  isYou: boolean;
}

export interface InviteView {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
  createdAt: string;
}

export interface OrderLinkView {
  orderId: string;
  orderNumber: string | null;
  orderStatus: string | null;
  erpPurchaseOrderId: string | null;
  erpOrderStatus: string | null;
  erpGoodsReceiptId: string | null;
  goodsReceiptedAt: string | null;
  onOrderQty: number;
  receivedQty: number;
  shipmentStatus: string | null;
  trackingNumber: string | null;
  pushedAt: string | null;
  lastSyncedAt: string | null;
}

export interface InvoiceLinkView {
  invoiceId: string;
  orderId: string | null;
  erpInvoiceNumber: string | null;
  currency: string;
  grandTotalMinor: string;
  taxMinor: string;
  dueAt: string | null;
  paymentReference: string | null;
  paymentStatus: string | null;
  syncedAt: string | null;
}

export interface ImportedSpec {
  title: string | null;
  version: string | null;
  serverUrl: string | null;
  endpoints: {
    purpose: ErpEndpointPurpose;
    path: string;
    method: string;
    summary: string | null;
    confidence: 'high' | 'low';
  }[];
  unmatched: { path: string; method: string; summary: string | null }[];
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

/**
 * The secrets a form may send.
 *
 * Every field optional, and the distinction between "absent" and "empty" is
 * load-bearing — see this file's header.
 */
export interface ErpSecretsInput {
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
}

export interface ConnectionInput {
  name: string;
  system: ErpSystem;
  /** The catalogue id the buyer picked, which decides the defaults applied. */
  vendorPreset?: string | null;
  apiStyle?: ErpApiStyle;
  environment: ErpEnvironment;
  erpVersion?: string | null;
  baseUrl: string;
  apiVersion?: string | null;
  networkMode?: ErpNetworkMode;
  networkNotes?: string | null;
  tenantIdentifier?: string | null;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
  authMethod: ErpAuthMethod;
  apiKeyLocation?: 'HEADER' | 'QUERY' | null;
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
  secrets?: ErpSecretsInput;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const erpKeys = {
  options: (environment: ErpEnvironment, region: ErpRegion) =>
    ['customer-erp', 'options', environment, region] as const,
  warehouses: ['customer-erp', 'warehouses'] as const,
  organization: ['customer-erp', 'organization'] as const,
  connections: ['customer-erp', 'connections'] as const,
  connection: (id: string) => ['customer-erp', 'connection', id] as const,
  links: (id: string) => ['customer-erp', 'links', id] as const,
  events: (filters: Record<string, unknown>) => ['customer-erp', 'events', filters] as const,
  jobs: (connectionId: string | null) => ['customer-erp', 'jobs', connectionId] as const,
  webhookEvents: (connectionId: string | null) =>
    ['customer-erp', 'webhook-events', connectionId] as const,
  approvals: (connectionId: string | null) => ['customer-erp', 'approvals', connectionId] as const,
  audit: (filters: Record<string, unknown>) => ['customer-erp', 'audit', filters] as const,
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export const customerErpApi = {
  /** What the wizard needs before anything exists. Also says whether the store offers it. */
  options: (environment: ErpEnvironment, region: ErpRegion) =>
    api.get<ErpOptions>(`${BASE}/options?environment=${environment}&region=${region}`),

  warehouses: () =>
    api
      .get<{ warehouses: { id: string; code: string; name: string; countryCode: string | null }[] }>(
        `${BASE}/warehouses`,
      )
      .then((response) => response.warehouses),

  organization: () =>
    api.get<{
      organization: OrganizationView;
      members: MemberView[];
      /** Null rather than empty for anybody who may not see invitations. */
      invites: InviteView[] | null;
    }>(`${BASE}/organization`),

  renameOrganization: (name: string) =>
    api
      .patch<{ organization: OrganizationView }>(`${BASE}/organization`, { name })
      .then((response) => response.organization),

  invite: (email: string, role: OrgRole) =>
    api
      .post<{ invites: InviteView[] }>(`${BASE}/organization/invites`, { email, role })
      .then((response) => response.invites),

  revokeInvite: (inviteId: string) =>
    api
      .delete<{ invites: InviteView[] }>(`${BASE}/organization/invites/${inviteId}`)
      .then((response) => response.invites),

  join: (token: string) =>
    api
      .post<{ organization: OrganizationView }>(`${BASE}/organization/join`, { token })
      .then((response) => response.organization),

  changeMemberRole: (memberId: string, role: OrgRole) =>
    api
      .patch<{ members: MemberView[] }>(`${BASE}/organization/members/${memberId}`, { role })
      .then((response) => response.members),

  removeMember: (memberId: string) =>
    api
      .delete<{ members: MemberView[] }>(`${BASE}/organization/members/${memberId}`)
      .then((response) => response.members),

  connections: () =>
    api.get<{ available: boolean; role: OrgRole; connections: ConnectionHealth[] }>(
      `${BASE}/connections`,
    ),

  connection: (id: string) =>
    api.get<{ role: OrgRole; connection: ConnectionHealth | ConnectionView }>(
      `${BASE}/connections/${id}`,
    ),

  create: (body: ConnectionInput) =>
    api
      .post<{ connection: ConnectionView }>(`${BASE}/connections`, body)
      .then((response) => response.connection),

  update: (id: string, body: Partial<ConnectionInput>) =>
    api
      .patch<{ connection: ConnectionView }>(`${BASE}/connections/${id}`, body)
      .then((response) => response.connection),

  //  rather than : the route answers 204 with no body, and 
  // as a type argument is not the same claim.
  remove: (id: string) => api.delete<never>(`${BASE}/connections/${id}`),

  saveEndpoints: (id: string, endpoints: EndpointView[]) =>
    api
      .put<{ connection: ConnectionView }>(`${BASE}/connections/${id}/endpoints`, { endpoints })
      .then((response) => response.connection),

  saveMappings: (id: string, mappings: MappingRow[]) =>
    api
      .put<{ connection: ConnectionView }>(`${BASE}/connections/${id}/mappings`, { mappings })
      .then((response) => response.connection),

  saveWarehouses: (id: string, warehouseMaps: WarehouseMapView[]) =>
    api
      .put<{ connection: ConnectionView }>(`${BASE}/connections/${id}/warehouses`, {
        warehouseMaps,
      })
      .then((response) => response.connection),

  savePolicy: (id: string, policy: Partial<PolicyView>) =>
    api
      .put<{ connection: ConnectionView }>(`${BASE}/connections/${id}/policy`, policy)
      .then((response) => response.connection),

  test: (id: string) =>
    api.post<{ test: TestResult }>(`${BASE}/connections/${id}/test`).then((r) => r.test),

  dryRun: (id: string) =>
    api.post<{ dryRun: DryRunResult }>(`${BASE}/connections/${id}/dry-run`).then((r) => r.dryRun),

  activate: (id: string) =>
    api
      .post<{ connection: ConnectionView }>(`${BASE}/connections/${id}/activate`)
      .then((r) => r.connection),

  /** Pause, resume, reconnect and disconnect share a shape; the path is the verb. */
  lifecycle: (id: string, action: 'pause' | 'resume' | 'reconnect' | 'disconnect') =>
    api
      .post<{ connection: ConnectionView }>(`${BASE}/connections/${id}/${action}`)
      .then((r) => r.connection),

  syncNow: (id: string) =>
    api.post<{ sync: SyncResult }>(`${BASE}/connections/${id}/sync`).then((r) => r.sync),

  startOAuth: (id: string) =>
    api
      .post<{ authorization: { authorizationUrl: string; scope: string; expiresAt: string } }>(
        `${BASE}/connections/${id}/oauth/start`,
      )
      .then((r) => r.authorization),

  completeOAuth: (body: { connectionId: string; state: string; code: string }) =>
    api.post<{
      authorized: boolean;
      grantedScope: string | null;
      expiresAt: string | null;
      connection: ConnectionView;
    }>(`${BASE}/oauth/callback`, body),

  importSpec: (document: string) =>
    api
      .post<{ imported: ImportedSpec }>(`${BASE}/openapi/import`, { document })
      .then((r) => r.imported),

  events: (filters: {
    connectionId?: string;
    state?: ErpEventState;
    eventType?: string;
    search?: string;
    before?: string;
    limit?: number;
  }) => api.get<{ rows: EventView[]; nextBefore: string | null }>(`${BASE}/events${query(filters)}`),

  retryEvent: (eventId: string) =>
    api.post<{ queued: boolean }>(`${BASE}/events/${eventId}/retry`),

  jobs: (connectionId: string | null) =>
    api
      .get<{ jobs: SyncJobView[] }>(
        `${BASE}/jobs${query(connectionId === null ? {} : { connectionId })}`,
      )
      .then((r) => r.jobs),

  webhookEvents: (connectionId: string | null) =>
    api
      .get<{ webhookEvents: WebhookEventView[] }>(
        `${BASE}/webhook-events${query(connectionId === null ? {} : { connectionId })}`,
      )
      .then((r) => r.webhookEvents),

  approvals: (connectionId: string | null, pendingOnly = false) =>
    api
      .get<{ approvals: ApprovalView[] }>(
        `${BASE}/approvals${query({
          ...(connectionId === null ? {} : { connectionId }),
          ...(pendingOnly ? { pendingOnly: 'true' } : {}),
        })}`,
      )
      .then((r) => r.approvals),

  decideApproval: (approvalId: string, decision: 'APPROVED' | 'REJECTED', note?: string) =>
    api
      .post<{ approval: ApprovalView }>(`${BASE}/approvals/${approvalId}`, {
        decision,
        note: note ?? null,
      })
      .then((r) => r.approval),

  audit: (filters: {
    connectionId?: string;
    action?: string;
    search?: string;
    before?: string;
    limit?: number;
  }) => api.get<{ rows: AuditRow[]; nextBefore: string | null }>(`${BASE}/audit${query(filters)}`),

  links: (id: string) =>
    api.get<{ orderLinks: OrderLinkView[]; invoiceLinks: InvoiceLinkView[] }>(
      `${BASE}/connections/${id}/links`,
    ),
};

/** A query string from whatever is actually set. Empty for an empty object. */
function query(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;

    // Narrowed rather than coerced: an object here would become the literal
    // "[object Object]" in a query string, which the server would then try to
    // parse as a filter.
    if (typeof value === 'string') params.set(key, value);
    else if (typeof value === 'number' || typeof value === 'boolean') {
      params.set(key, String(value));
    }
  }

  const serialised = params.toString();
  return serialised.length === 0 ? '' : `?${serialised}`;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * The tone a connection's state should be shown in.
 *
 * Kept here rather than in a component because three surfaces render it — the
 * list, the detail header and the dashboard chip — and a state that is amber in
 * one place and red in another teaches people that the colour means nothing.
 */
export function stateTone(state: ErpConnectionState): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (state) {
    case 'ACTIVE':
      return 'success';
    case 'ACTION_REQUIRED':
    case 'PAUSED':
    case 'TESTING':
      return 'warning';
    case 'FAILED':
      return 'danger';
    case 'DRAFT':
    case 'DISCONNECTED':
      return 'neutral';
  }
}

export function eventStateTone(
  state: ErpEventState,
): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (state) {
    case 'SUCCEEDED':
      return 'success';
    case 'RETRYING':
    case 'PROCESSING':
    case 'QUEUED':
      return 'warning';
    case 'FAILED':
      return 'danger';
    case 'SKIPPED':
      return 'neutral';
  }
}

/** A major-unit string from minor units, for a threshold field. */
export function minorToInput(minor: string | null, exponent = 2): string {
  if (minor === null || minor === '') return '';
  if (exponent === 0) return minor;

  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).replace(/\D/g, '') || '0';
  const padded = digits.padStart(exponent + 1, '0');

  return `${negative ? '-' : ''}${padded.slice(0, padded.length - exponent)}.${padded.slice(
    padded.length - exponent,
  )}`;
}

/**
 * Minor units from what somebody typed, by string arithmetic.
 *
 * Never `value * 100`. `12.34 * 100` is 1233.9999999999998, and a threshold one
 * unit under what they typed will one day let through an order they meant to be
 * asked about.
 */
export function inputToMinor(value: string, exponent = 2): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart = '0', fractionPart = ''] = unsigned.split('.');

  const whole = wholePart.replace(/\D/g, '') || '0';
  const fraction = fractionPart.replace(/\D/g, '').padEnd(exponent, '0').slice(0, exponent);

  const combined = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  return `${negative && combined !== '0' ? '-' : ''}${combined}`;
}
