/**
 * The Seller Hub's side of a seller's own accounting system.
 *
 * ONE THING TO KEEP IN MIND READING THIS FILE: nothing here ever reaches the
 * seller's TallyPrime. Their Tally runs on a PC in their office, and this API
 * has no address for it and never will - the Glovia Tally Bridge runs beside
 * Tally and connects OUTWARD. Everything below talks to Glovia, which queues
 * work for that agent to collect.
 *
 * So a "test connection" here returns 202 and a job id, not a verdict. The
 * verdict arrives when the bridge next polls, and the screen watches the
 * connection's `lastTestAt` move. A function that returned a verdict would be
 * returning one it had not obtained.
 */
import { api } from './api';

export type SellerErpState =
  | 'NOT_CONFIGURED'
  | 'BRIDGE_REQUIRED'
  | 'AWAITING_PAIRING'
  | 'BRIDGE_OFFLINE'
  | 'TALLY_UNAVAILABLE'
  | 'COMPANY_NOT_LOADED'
  | 'MAPPING_INCOMPLETE'
  | 'VALIDATION_FAILED'
  | 'CONNECTED'
  | 'SYNCING'
  | 'CONNECTED_WITH_WARNINGS'
  | 'PAIRING_EXPIRED'
  | 'DISABLED';

/**
 * One connection, with every claim carrying its own timestamp.
 *
 * The timestamps are not decoration. "Connected" is a conclusion the server
 * reaches from a fresh heartbeat, a recent passing test, the right company
 * being open and the mappings being complete - and the screen shows WHEN each
 * of those was last true, because a status with no time beside it is a status
 * nobody can check.
 */
export interface ErpConnection {
  id: string;
  name: string;
  provider: string;
  state: SellerErpState;
  stateReason: string | null;
  stateChangedAt: string;
  networkMode: string;
  directBaseUrl: string | null;

  companyName: string | null;
  companyGuid: string | null;
  companyBooksFrom: string | null;
  tallyVersion: string | null;
  tallyBaseCurrency: string | null;

  lastTestAt: string | null;
  lastTestOk: boolean;
  lastTestMessage: string | null;
  lastSuccessfulSyncAt: string | null;
  lastHeartbeatAt: string | null;
  mappingCompleteAt: string | null;
  initialSyncCompletedAt: string | null;

  inventoryAuthority: string;
  autoCreateMasters: boolean;

  pendingJobs: number;
  failedJobs: number;
  inFlightJobs: number;
  missingMappingCount: number;

  hasBridge: boolean;
  bridgeOnline: boolean;
  bridgeLabel: string | null;

  /** True when there is something for the SELLER to go and do. */
  needsAction: boolean;
  /** True when work would actually be sent right now. */
  canSync: boolean;

  createdAt: string;
  updatedAt: string;
}

export interface ErpConnectionList {
  /** False when the marketplace has not switched the feature on at all. */
  available: boolean;
  directModeAllowed: boolean;
  connections: ErpConnection[];
}

export function fetchErpConnections(): Promise<ErpConnectionList> {
  return api.get<ErpConnectionList>('/seller/erp/connections');
}

export function createErpConnection(body: { name: string }): Promise<ErpConnection> {
  return api.post<ErpConnection>('/seller/erp/connections', body);
}

export function fetchErpConnection(id: string): Promise<ErpConnection> {
  return api.get<ErpConnection>(`/seller/erp/connections/${encodeURIComponent(id)}`);
}

export function setErpConnectionEnabled(id: string, enabled: boolean): Promise<ErpConnection> {
  return api.post<ErpConnection>(
    `/seller/erp/connections/${encodeURIComponent(id)}/enabled`,
    { enabled },
  );
}

/**
 * The pairing code, returned ONCE.
 *
 * Not stored in plaintext, not returned by any read, and not recoverable. A
 * seller who loses it generates another, which costs nothing and is safer than
 * any mechanism for showing it twice.
 */
export interface IssuedPairingCode {
  code: string;
  codePrefix: string;
  expiresAt: string;
  deviceLabel: string;
}

export function issuePairingCode(
  connectionId: string,
  deviceLabel: string,
): Promise<IssuedPairingCode> {
  return api.post<IssuedPairingCode>(
    `/seller/erp/connections/${encodeURIComponent(connectionId)}/pairing-codes`,
    { deviceLabel },
  );
}

export interface BridgeDevice {
  id: string;
  label: string;
  state: string;
  tokenPrefix: string;
  tokenExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  isOnline: boolean;
  agentVersion: string | null;
  osLabel: string | null;
  /** What the agent says its LOCAL Tally address is. Recorded, never dialled. */
  reportedTallyAddress: string | null;
  tasksCompleted: number;
  tasksFailed: number;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

export function fetchBridgeDevices(connectionId: string): Promise<{ devices: BridgeDevice[] }> {
  return api.get<{ devices: BridgeDevice[] }>(
    `/seller/erp/connections/${encodeURIComponent(connectionId)}/devices`,
  );
}

export function revokeBridgeDevice(deviceId: string, reason: string | null): Promise<never> {
  return api.post<never>(`/seller/erp/devices/${encodeURIComponent(deviceId)}/revoke`, { reason });
}

/**
 * Ask the bridge to test the connection.
 *
 * 202 and a job id. The answer arrives when the agent next polls - normally
 * within a second or two - and the screen watches `lastTestAt` move.
 */
export function testErpConnection(
  connectionId: string,
): Promise<{ jobId: string | null; state: SellerErpState }> {
  return api.post(`/seller/erp/connections/${encodeURIComponent(connectionId)}/test`, {});
}

export interface TallyCompany {
  name: string;
  guid: string | null;
  booksFrom: string | null;
  isSelected: boolean;
  lastSeenAt: string;
}

export function fetchTallyCompanies(
  connectionId: string,
): Promise<{ companies: TallyCompany[] }> {
  return api.get(`/seller/erp/connections/${encodeURIComponent(connectionId)}/companies`);
}

export function selectTallyCompany(
  connectionId: string,
  companyName: string,
): Promise<ErpConnection> {
  return api.post(`/seller/erp/connections/${encodeURIComponent(connectionId)}/company`, {
    companyName,
  });
}

export interface ErpMapping {
  id: string;
  entity: string;
  localKey: string;
  localLabel: string | null;
  tallyName: string;
  tallyGuid: string | null;
  alternateUnitName: string | null;
  conversionFactor: string | null;
  isConfirmed: boolean;
  warning: string | null;
  updatedAt: string;
}

export interface MissingMapping {
  entity: string;
  localKey: string;
  localLabel: string | null;
  /** Why the seller's own choices make this one necessary. */
  because: string;
}

export function fetchErpMappings(
  connectionId: string,
): Promise<{ mappings: ErpMapping[]; missing: MissingMapping[] }> {
  return api.get(`/seller/erp/connections/${encodeURIComponent(connectionId)}/mappings`);
}

export function saveErpMappings(
  connectionId: string,
  mappings: {
    entity: string;
    localKey?: string;
    localLabel?: string | null;
    tallyName: string;
    tallyGuid?: string | null;
    alternateUnitName?: string | null;
    conversionFactor?: string | null;
    isConfirmed?: boolean;
  }[],
): Promise<{ mappings: ErpMapping[] }> {
  return api.put(`/seller/erp/connections/${encodeURIComponent(connectionId)}/mappings`, {
    mappings,
  });
}

export interface TallyMaster {
  tallyName: string;
  tallyGuid: string | null;
  parentName: string | null;
  extra: Record<string, string>;
  lastSeenAt: string;
  /** True when the last few pulls have not reported it. */
  isStale: boolean;
}

export function fetchTallyMasters(
  connectionId: string,
  entity: string,
  search?: string,
): Promise<{ masters: TallyMaster[] }> {
  const params = new URLSearchParams({ entity });
  if (search !== undefined && search !== '') params.set('search', search);

  return api.get(
    `/seller/erp/connections/${encodeURIComponent(connectionId)}/masters?${params.toString()}`,
  );
}

export function refreshTallyMasters(connectionId: string): Promise<{ jobId: string | null }> {
  return api.post(
    `/seller/erp/connections/${encodeURIComponent(connectionId)}/masters/refresh`,
    {},
  );
}

export interface ErpSyncPolicy {
  postSalesOrder: boolean;
  postSalesInvoice: boolean;
  invoiceOnDispatch: boolean;
  postReceipt: boolean;
  postCreditNote: boolean;
  cancellationMode: 'CREDIT_NOTE' | 'MARK_CANCELLED' | 'MANUAL';
  syncStockItems: boolean;
  syncPartyLedgers: boolean;
  syncGodowns: boolean;
  inventoryAuthority: 'GLOVIA' | 'TALLY' | 'MANUAL' | 'DISABLED';
  inventoryPollMinutes: number | null;
  includePackagingNarration: boolean;
  narrationTemplate: string | null;
  maxAttempts: number;
  retryBaseSeconds: number;
  updatedAt: string;
}

export function fetchErpPolicy(connectionId: string): Promise<ErpSyncPolicy> {
  return api.get(`/seller/erp/connections/${encodeURIComponent(connectionId)}/policy`);
}

export function updateErpPolicy(
  connectionId: string,
  patch: Partial<Omit<ErpSyncPolicy, 'updatedAt'>>,
): Promise<ErpSyncPolicy> {
  return api.patch(`/seller/erp/connections/${encodeURIComponent(connectionId)}/policy`, patch);
}

/**
 * Whether Glovia may create ledgers and stock items in Tally unprompted.
 *
 * Its own call rather than a field on the policy patch, because it is the one
 * setting that lets this software write to somebody's chart of accounts
 * without being asked each time - and a decision like that deserves its own
 * request and its own audit line.
 */
export function setAutoCreateMasters(connectionId: string, enabled: boolean): Promise<never> {
  return api.post<never>(
    `/seller/erp/connections/${encodeURIComponent(connectionId)}/auto-create-masters`,
    { enabled },
  );
}

export interface ErpValidation {
  ok: boolean;
  state: SellerErpState;
  stateReason: string | null;
  missing: MissingMapping[];
}

export function validateErpConnection(connectionId: string): Promise<ErpValidation> {
  return api.post(`/seller/erp/connections/${encodeURIComponent(connectionId)}/validate`, {});
}

export function runInitialSync(
  connectionId: string,
): Promise<{ queued: number; considered: number }> {
  return api.post(
    `/seller/erp/connections/${encodeURIComponent(connectionId)}/initial-sync`,
    {},
  );
}

export interface ErpJob {
  id: string;
  eventType: string;
  status: string;
  trigger: string;
  sourceEntityType: string;
  sourceEntityId: string | null;
  orderId: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  externalVoucherNumber: string | null;
  errorCode: string | null;
  /** Safe to show. Never a Tally body, never a path from the seller's machine. */
  sanitizedError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export function fetchErpJobs(
  connectionId: string,
  params: { status?: string | null; page?: number } = {},
): Promise<{ rows: ErpJob[]; total: number; counts: Record<string, number> }> {
  const query = new URLSearchParams();
  if (params.status != null && params.status !== '') query.set('status', params.status);
  if (params.page !== undefined) query.set('page', String(params.page));

  return api.get(
    `/seller/erp/connections/${encodeURIComponent(connectionId)}/jobs?${query.toString()}`,
  );
}

export function retryErpJob(jobId: string): Promise<never> {
  return api.post<never>(`/seller/erp/jobs/${encodeURIComponent(jobId)}/retry`, {});
}

export function cancelErpJob(jobId: string): Promise<never> {
  return api.post<never>(`/seller/erp/jobs/${encodeURIComponent(jobId)}/cancel`, {});
}

export interface ErpAuditEvent {
  id: string;
  action: string;
  actorType: string;
  actorLabel: string | null;
  summary: string | null;
  meta: unknown;
  createdAt: string;
}

export function fetchErpAudit(connectionId: string): Promise<{ events: ErpAuditEvent[] }> {
  return api.get(`/seller/erp/connections/${encodeURIComponent(connectionId)}/audit`);
}
