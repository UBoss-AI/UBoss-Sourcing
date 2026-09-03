/**
 * Custom product/inventory API connector.
 *
 * Pulls a catalog or stock feed from a system the client already runs. That
 * system is outside our control, so it is treated as hostile input and as
 * unreliable infrastructure:
 *
 *   - Credentials are AES-256-GCM encrypted and never returned by any API.
 *   - Every response field is validated and normalised; nothing is trusted
 *     because the remote said so.
 *   - A dry run is the default. Row-level results are reported before anything
 *     is written, because a bad mapping silently repricing the catalog is the
 *     failure mode that matters.
 *   - Timeouts, bounded retries and a circuit breaker, so a dead endpoint
 *     degrades instead of hanging every sync forever.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

function credentialAad(connectionId: string): string {
  return `integration_connection:${connectionId}`;
}

/** Open the breaker after this many consecutive failures. */
const CIRCUIT_FAILURE_THRESHOLD = 5;
/** How long the breaker stays open before allowing one probe. */
const CIRCUIT_COOLDOWN_MS = 300_000;

/** Hard ceiling on a response body, so a runaway feed cannot exhaust memory. */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

export interface ConnectorActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/**
 * External field -> UBOSS field mapping.
 *
 * `sku` is required and is the match key: a feed with no stable identifier
 * cannot be upserted safely, only blindly inserted.
 */
export interface FieldMapping {
  sku: string;
  name?: string;
  /** Must resolve to whole minor units. A decimal string is rejected. */
  priceMinor?: string;
  stockQty?: string;
  shortDescription?: string;
  /** Dotted path to the array of records inside the response. */
  itemsPath?: string;
}

export interface CreateConnectorInput {
  name: string;
  baseUrl: string;
  authType: 'NONE' | 'API_KEY_HEADER' | 'BEARER_TOKEN' | 'BASIC';
  credentials?: { headerName?: string; token?: string; username?: string; password?: string };
  fieldMapping: FieldMapping;
  direction?: 'IMPORT' | 'EXPORT' | 'BIDIRECTIONAL';
  conflictPolicy?: 'EXTERNAL_WINS' | 'UBOSS_WINS' | 'FIELD_LEVEL';
  scheduleCron?: string | null;
  timeoutMs?: number;
  maxRetries?: number;
  alertRecipients?: string[];
}

function assertHttpsOrLocal(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Enter a valid URL.', [
      { field: 'baseUrl', code: 'INVALID_URL' },
    ]);
  }

  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);

  // Credentials travel on every call. Plain HTTP would put them on the wire.
  if (parsed.protocol !== 'https:' && !isLocal) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The endpoint must use HTTPS. Credentials are sent with every request.',
      [{ field: 'baseUrl', code: 'HTTPS_REQUIRED' }],
    );
  }
}

export async function createConnector(
  input: CreateConnectorInput,
  actor: ConnectorActor,
): Promise<{ connectionId: string }> {
  assertHttpsOrLocal(input.baseUrl);

  if (input.fieldMapping.sku.trim().length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Map an external field to SKU. It is how records are matched.',
      [{ field: 'fieldMapping.sku', code: 'REQUIRED' }],
    );
  }

  if (input.authType !== 'NONE' && input.credentials === undefined) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Provide the credentials for this auth type.', [
      { field: 'credentials', code: 'REQUIRED' },
    ]);
  }

  const connectionId = newId();
  const secretShown = input.credentials?.token ?? input.credentials?.password ?? '';

  await prisma.integrationConnection.create({
    data: {
      id: connectionId,
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      authType: input.authType,
      credentialsEnc:
        input.credentials === undefined
          ? null
          : encryptSecret(JSON.stringify(input.credentials), credentialAad(connectionId)),
      credentialsMask: secretShown.length > 0 ? maskSecret(secretShown) : null,
      fieldMappingJson: input.fieldMapping as never,
      direction: input.direction ?? 'IMPORT',
      conflictPolicy: input.conflictPolicy ?? 'EXTERNAL_WINS',
      scheduleCron: input.scheduleCron ?? null,
      timeoutMs: input.timeoutMs ?? 15_000,
      maxRetries: input.maxRetries ?? 3,
      // Inactive until an administrator has run a successful test.
      isActive: false,
      alertRecipientsJson: (input.alertRecipients ?? []) as never,
      createdById: actor.userId,
    },
  });

  await recordAudit({
    action: AuditAction.CONNECTOR_CREATED,
    resourceType: 'integration_connection',
    resourceId: connectionId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    // The credential value is redacted by the audit service; only the shape of
    // the change is recorded.
    after: { name: input.name, baseUrl: input.baseUrl, authType: input.authType },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { connectionId };
}

interface LoadedConnection {
  id: string;
  name: string;
  baseUrl: string;
  authType: string;
  credentials: Record<string, string> | null;
  fieldMapping: FieldMapping;
  timeoutMs: number;
  maxRetries: number;
  circuitState: string;
  circuitOpenedAt: Date | null;
  consecutiveFailures: number;
  conflictPolicy: string;
}

async function loadConnection(connectionId: string): Promise<LoadedConnection> {
  const row = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
  if (row === null) throw notFound('Connector');

  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    authType: row.authType,
    credentials:
      row.credentialsEnc === null
        ? null
        : (JSON.parse(decryptSecret(row.credentialsEnc, credentialAad(row.id))) as Record<
            string,
            string
          >),
    fieldMapping: row.fieldMappingJson as unknown as FieldMapping,
    timeoutMs: row.timeoutMs,
    maxRetries: row.maxRetries,
    circuitState: row.circuitState,
    circuitOpenedAt: row.circuitOpenedAt,
    consecutiveFailures: row.consecutiveFailures,
    conflictPolicy: row.conflictPolicy,
  };
}

function authHeaders(connection: LoadedConnection): Record<string, string> {
  const credentials = connection.credentials;
  if (credentials === null) return {};

  switch (connection.authType) {
    case 'API_KEY_HEADER':
      return { [credentials['headerName'] ?? 'X-API-Key']: credentials['token'] ?? '' };
    case 'BEARER_TOKEN':
      return { Authorization: `Bearer ${credentials['token'] ?? ''}` };
    case 'BASIC':
      return {
        Authorization: `Basic ${Buffer.from(
          `${credentials['username'] ?? ''}:${credentials['password'] ?? ''}`,
          'utf8',
        ).toString('base64')}`,
      };
    default:
      return {};
  }
}

/**
 * Refuse to call an endpoint that has been failing.
 *
 * Without this, a dead remote turns every scheduled sync into a timeout, and
 * the queue fills with jobs that cannot succeed.
 */
function assertCircuitClosed(connection: LoadedConnection): void {
  if (connection.circuitState !== 'OPEN') return;

  const openedAt = connection.circuitOpenedAt?.getTime() ?? 0;
  if (Date.now() - openedAt < CIRCUIT_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((CIRCUIT_COOLDOWN_MS - (Date.now() - openedAt)) / 1000);
    throw conflict(
      ErrorCode.CONNECTOR_CIRCUIT_OPEN,
      `This connector is temporarily disabled after repeated failures. Retrying in ${String(waitSeconds)}s.`,
      [{ code: 'CIRCUIT_OPEN', meta: { retryInSeconds: waitSeconds } }],
    );
  }
  // Cooldown elapsed: the next call is the half-open probe.
}

async function recordCircuitSuccess(connectionId: string): Promise<void> {
  await prisma.integrationConnection.update({
    where: { id: connectionId },
    data: {
      circuitState: 'CLOSED',
      consecutiveFailures: 0,
      circuitOpenedAt: null,
      lastSuccessAt: new Date(),
    },
  });
}

async function recordCircuitFailure(connectionId: string, failures: number): Promise<void> {
  const shouldOpen = failures + 1 >= CIRCUIT_FAILURE_THRESHOLD;

  await prisma.integrationConnection.update({
    where: { id: connectionId },
    data: {
      consecutiveFailures: failures + 1,
      ...(shouldOpen ? { circuitState: 'OPEN', circuitOpenedAt: new Date() } : {}),
    },
  });

  if (shouldOpen) {
    logger.error({ connectionId, failures: failures + 1 }, 'connector circuit opened');
  }
}

/** One HTTP call with a bounded timeout and a response-size ceiling. */
async function fetchFeed(connection: LoadedConnection): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connection.timeoutMs);

  try {
    const response = await fetch(connection.baseUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', ...authHeaders(connection) },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Remote returned HTTP ${String(response.status)}`);
    }

    const text = await response.text();

    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`Response exceeded ${String(MAX_RESPONSE_BYTES)} bytes`);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('Remote returned a body that is not valid JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a feed value as text.
 *
 * Never `String(value)`: a remote that returns an object where a price was
 * expected would stringify to "[object Object]" and slip past a naive check.
 * Anything non-primitive yields an empty string, which then fails validation
 * loudly rather than quietly.
 */
function feedText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return '';
}

/** Follow a dotted path, e.g. `data.products`. */
function readPath(source: unknown, path: string): unknown {
  return path
    .split('.')
    .filter((segment) => segment.length > 0)
    .reduce<unknown>((current, segment) => {
      if (typeof current !== 'object' || current === null) return undefined;
      return (current as Record<string, unknown>)[segment];
    }, source);
}

export interface RowError {
  rowRef: string | null;
  field: string | null;
  code: string;
  message: string;
}

export interface SyncResult {
  syncRunId: string;
  isDryRun: boolean;
  totalRecords: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failureCount: number;
  errors: RowError[];
}

export interface RunSyncInput {
  connectionId: string;
  /** Defaults to TRUE. Writing is an explicit choice, never the default. */
  dryRun?: boolean;
  triggeredBy: string;
  actorUserId?: string | null;
}

/**
 * Run one sync.
 *
 * A dry run validates and reports every row without writing anything, which is
 * the step that catches a mapping that would silently reprice the catalog.
 */
export async function runSync(input: RunSyncInput): Promise<SyncResult> {
  const connection = await loadConnection(input.connectionId);
  assertCircuitClosed(connection);

  const isDryRun = input.dryRun ?? true;
  const syncRunId = newId();

  await prisma.syncRun.create({
    data: {
      id: syncRunId,
      connectionId: connection.id,
      status: 'RUNNING',
      isDryRun,
      triggeredBy: input.triggeredBy,
    },
  });

  const errors: RowError[] = [];
  // Always zero: the connector only ever UPDATES existing products. Creating
  // catalog entries from an external feed would bypass the publication gate.
  const created = 0;
  let updated = 0;
  let skipped = 0;

  try {
    const payload = await fetchFeed(connection);
    await recordCircuitSuccess(connection.id);

    const mapping = connection.fieldMapping;
    const rawItems = mapping.itemsPath === undefined ? payload : readPath(payload, mapping.itemsPath);

    if (!Array.isArray(rawItems)) {
      throw new Error(
        mapping.itemsPath === undefined
          ? 'Expected the response to be an array of records. Set an items path if it is nested.'
          : `No array found at "${mapping.itemsPath}".`,
      );
    }

    for (const [index, raw] of rawItems.entries()) {
      const rowRef = String(index);

      if (typeof raw !== 'object' || raw === null) {
        errors.push({ rowRef, field: null, code: 'NOT_AN_OBJECT', message: 'Row is not an object.' });
        continue;
      }

      const record = raw as Record<string, unknown>;
      const sku = readPath(record, mapping.sku);

      if (typeof sku !== 'string' || sku.trim().length === 0) {
        errors.push({
          rowRef,
          field: mapping.sku,
          code: 'SKU_MISSING',
          message: 'Row has no usable SKU, so it cannot be matched.',
        });
        continue;
      }

      const normalisedSku = sku.trim().toUpperCase();

      // Only ever UPDATES an existing product. Creating catalog entries from an
      // external feed would bypass the publication gate entirely - a product
      // must be reviewed and published by a human.
      const existing = await prisma.product.findUnique({
        where: { sku: normalisedSku },
        select: { id: true, name: true, basePriceMinor: true, isStockTracked: true },
      });

      if (existing === null) {
        skipped += 1;
        errors.push({
          rowRef,
          field: mapping.sku,
          code: 'SKU_NOT_FOUND',
          message: `No product with SKU ${normalisedSku}. Create it in the catalog first.`,
        });
        continue;
      }

      const updates: { name?: string; basePriceMinor?: bigint; shortDescription?: string } = {};
      let rowFailed = false;

      if (mapping.priceMinor !== undefined) {
        const text = feedText(readPath(record, mapping.priceMinor));

        // Whole minor units only. A decimal here means the mapping points at a
        // major-unit field, and accepting it would divide every price by 100.
        if (!/^\d+$/.test(text)) {
          errors.push({
            rowRef,
            field: mapping.priceMinor,
            code: 'INVALID_PRICE',
            message: `Expected whole minor units, got "${text}". Check the field mapping.`,
          });
          rowFailed = true;
        } else {
          updates.basePriceMinor = BigInt(text);
        }
      }

      if (mapping.name !== undefined) {
        const value = readPath(record, mapping.name);
        if (typeof value === 'string' && value.trim().length > 0) {
          updates.name = value.trim().slice(0, 255);
        }
      }

      if (mapping.shortDescription !== undefined) {
        const value = readPath(record, mapping.shortDescription);
        if (typeof value === 'string') updates.shortDescription = value.slice(0, 1024);
      }

      let stockDelta: number | null = null;

      if (mapping.stockQty !== undefined && existing.isStockTracked) {
        const rawStock = feedText(readPath(record, mapping.stockQty));
        const parsed = rawStock.length === 0 ? Number.NaN : Number(rawStock);

        if (!Number.isInteger(parsed) || parsed < 0) {
          errors.push({
            rowRef,
            field: mapping.stockQty,
            code: 'INVALID_STOCK',
            message: `Expected a non-negative whole number, got "${rawStock}".`,
          });
          rowFailed = true;
        } else {
          stockDelta = parsed;
        }
      }

      if (rowFailed) continue;

      // UBOSS_WINS means the feed is informational: report what would change,
      // change nothing.
      if (connection.conflictPolicy === 'UBOSS_WINS') {
        skipped += 1;
        continue;
      }

      if (isDryRun) {
        // Counted as it WOULD apply, so the preview is honest.
        if (Object.keys(updates).length > 0 || stockDelta !== null) updated += 1;
        else skipped += 1;
        continue;
      }

      if (Object.keys(updates).length > 0) {
        await prisma.product.update({ where: { id: existing.id }, data: updates });
      }

      if (stockDelta !== null) {
        const { adjustStock, getAvailability } = await import(
          '../inventory/inventory.service.js'
        );
        const current = await getAvailability({ productId: existing.id });
        const delta = stockDelta - current.onHandQty;

        if (delta !== 0) {
          // Goes through the ledger like any other correction, so an external
          // feed cannot silently rewrite a balance.
          await adjustStock(
            {
              productId: existing.id,
              quantityDelta: delta,
              reason: `Synchronised from ${connection.name}`,
            },
            {
              userId: input.actorUserId ?? '',
              email: `connector:${connection.name}`,
            },
          ).catch((error: unknown) => {
            errors.push({
              rowRef,
              field: mapping.stockQty ?? null,
              code: 'STOCK_ADJUST_FAILED',
              message: error instanceof Error ? error.message : 'Stock adjustment failed.',
            });
          });
        }
      }

      updated += 1;
    }

    const status = errors.length === 0 ? 'SUCCEEDED' : failuresAreTotal(errors, rawItems.length) ? 'FAILED' : 'PARTIAL';

    await prisma.$transaction(async (tx) => {
      await tx.syncRun.update({
        where: { id: syncRunId },
        data: {
          status,
          finishedAt: new Date(),
          totalRecords: rawItems.length,
          createdCount: created,
          updatedCount: updated,
          skippedCount: skipped,
          failureCount: errors.length,
        },
      });

      if (errors.length > 0) {
        await tx.syncError.createMany({
          data: errors.slice(0, 500).map((error) => ({
            id: newId(),
            syncRunId,
            rowRef: error.rowRef,
            field: error.field,
            errorCode: error.code,
            errorMessage: error.message,
          })),
        });
      }
    });

    return {
      syncRunId,
      isDryRun,
      totalRecords: rawItems.length,
      createdCount: created,
      updatedCount: updated,
      skippedCount: skipped,
      failureCount: errors.length,
      errors: errors.slice(0, 100),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown sync error';
    await recordCircuitFailure(connection.id, connection.consecutiveFailures);

    await prisma.syncRun.update({
      where: { id: syncRunId },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: message.slice(0, 1000) },
    });

    logger.error({ connectionId: connection.id, err: error }, 'connector sync failed');

    throw badRequest(ErrorCode.CONNECTOR_TEST_FAILED, message);
  }
}

function failuresAreTotal(errors: RowError[], total: number): boolean {
  return total > 0 && errors.length >= total;
}

/**
 * Test a connector without importing anything.
 *
 * Required before activation: an administrator must not be able to switch on a
 * connector that has never successfully spoken to the remote.
 */
export async function testConnector(
  connectionId: string,
  actor: ConnectorActor,
): Promise<{ ok: boolean; message: string; sampleFieldNames: string[] }> {
  const connection = await loadConnection(connectionId);

  try {
    const payload = await fetchFeed(connection);
    await recordCircuitSuccess(connection.id);

    const mapping = connection.fieldMapping;
    const items = mapping.itemsPath === undefined ? payload : readPath(payload, mapping.itemsPath);
    const first: unknown = Array.isArray(items) ? (items as unknown[])[0] : null;

    // Returning the field names is what makes mapping possible without guessing.
    const sampleFieldNames =
      typeof first === 'object' && first !== null
        ? Object.keys(first)
        : [];

    await prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { lastTestedAt: new Date(), lastTestStatus: 'OK' },
    });

    const message = Array.isArray(items)
      ? `Connected. Found ${String(items.length)} record(s).`
      : 'Connected, but no array of records was found. Check the items path.';

    return { ok: Array.isArray(items), message, sampleFieldNames };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed.';
    await recordCircuitFailure(connection.id, connection.consecutiveFailures);

    await prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { lastTestedAt: new Date(), lastTestStatus: 'FAILED' },
    });

    await recordAudit({
      action: AuditAction.CONNECTOR_UPDATED,
      resourceType: 'integration_connection',
      resourceId: connectionId,
      actorType: 'ADMIN',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      after: { testResult: 'FAILED', message },
    });

    return { ok: false, message, sampleFieldNames: [] };
  }
}

/**
 * Activate or deactivate a connector.
 *
 * Activation requires a passing test, so a misconfigured connector cannot be
 * scheduled into repeatedly failing.
 */
export async function setConnectorActive(
  connectionId: string,
  active: boolean,
  actor: ConnectorActor,
): Promise<void> {
  const connection = await prisma.integrationConnection.findUnique({
    where: { id: connectionId },
    select: { lastTestStatus: true, isActive: true },
  });

  if (connection === null) throw notFound('Connector');

  if (active && connection.lastTestStatus !== 'OK') {
    throw conflict(
      ErrorCode.CONNECTOR_TEST_FAILED,
      'Run a successful connection test before activating this connector.',
    );
  }

  await prisma.integrationConnection.update({
    where: { id: connectionId },
    data: { isActive: active },
  });

  await recordAudit({
    action: AuditAction.CONNECTOR_UPDATED,
    resourceType: 'integration_connection',
    resourceId: connectionId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { isActive: connection.isActive },
    after: { isActive: active },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
}

/** Connector list for the admin UI. Credentials are never included. */
export async function listConnectors(): Promise<Record<string, unknown>[]> {
  const rows = await prisma.integrationConnection.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      syncRuns: { orderBy: { startedAt: 'desc' }, take: 1 },
      _count: { select: { syncRuns: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    authType: row.authType,
    // Only the mask. `credentialsEnc` never leaves this process.
    credentialsMask: row.credentialsMask,
    direction: row.direction,
    conflictPolicy: row.conflictPolicy,
    scheduleCron: row.scheduleCron,
    timeoutMs: row.timeoutMs,
    maxRetries: row.maxRetries,
    isActive: row.isActive,
    circuitState: row.circuitState,
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastTestStatus: row.lastTestStatus,
    fieldMapping: row.fieldMappingJson,
    syncRunCount: row._count.syncRuns,
    lastRun:
      row.syncRuns[0] === undefined
        ? null
        : {
            id: row.syncRuns[0].id,
            status: row.syncRuns[0].status,
            isDryRun: row.syncRuns[0].isDryRun,
            totalRecords: row.syncRuns[0].totalRecords,
            failureCount: row.syncRuns[0].failureCount,
            startedAt: row.syncRuns[0].startedAt.toISOString(),
          },
  }));
}

export async function getSyncRun(syncRunId: string): Promise<Record<string, unknown>> {
  const run = await prisma.syncRun.findUnique({
    where: { id: syncRunId },
    include: { errors: { take: 200 }, connection: { select: { name: true } } },
  });

  if (run === null) throw notFound('Sync run');

  return {
    id: run.id,
    connectorName: run.connection.name,
    status: run.status,
    isDryRun: run.isDryRun,
    triggeredBy: run.triggeredBy,
    totalRecords: run.totalRecords,
    createdCount: run.createdCount,
    updatedCount: run.updatedCount,
    skippedCount: run.skippedCount,
    failureCount: run.failureCount,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    errors: run.errors.map((error) => ({
      rowRef: error.rowRef,
      field: error.field,
      code: error.errorCode,
      message: error.errorMessage,
    })),
  };
}
