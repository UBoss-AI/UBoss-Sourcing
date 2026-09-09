/**
 * Keeping the shop's picture of stock in step with the ERP.
 *
 * Three ways in, one way through. A webhook the ERP sends, a poll on a timer,
 * or a person pressing Sync now all end in `applyRecords`, so a figure arrives
 * the same way whichever door it came through and there is one place where a
 * quantity is decided.
 *
 * **What this writes, and what it must never write.** Every quantity here lands
 * in `erp_inventory_snapshots`, which is a RECORD OF WHAT THE ERP SAID. It does
 * NOT touch `inventory_balances`, because a balance in this system is derived
 * from the append-only `inventory_movements` ledger, where every change has a
 * reason and a person against it. A figure that arrived over HTTP, through a
 * field mapping somebody typed, has neither - and letting it overwrite the
 * ledger would leave a stock level nobody can explain and an audit trail with a
 * hole in it. There is no setting that changes this, because there is no code
 * path to it.
 *
 * **Authority.** When the two disagree, `inventoryAuthority` decides what
 * happens, and all three answers are legitimate for somebody:
 *
 *   ERP      - the customer's ERP is their system of record. Its figure is
 *              stored and used.
 *   PLATFORM - this platform's figure stands. The ERP's is recorded beside it
 *              so the divergence is visible, and nothing is overwritten.
 *   MANUAL   - neither is applied automatically. The row is flagged and a
 *              person decides. The honest answer during a migration, when both
 *              systems are half right.
 *
 * **Idempotency.** A webhook that arrives twice applies once: `erp_webhook_
 * receipts` has a UNIQUE index on (connection, event id), so the second
 * delivery collides at the door rather than relying on a handler to check. A
 * poll that overlaps a previous one finds the run already RUNNING and declines.
 * Every write is an upsert keyed on (connection, sku, warehouse), so applying
 * the same snapshot twice is a no-op rather than a doubling.
 *
 * **Rate limits are obeyed, not worked around.** A 429 stops the run, records
 * how long the ERP asked for, and marks the run RATE_LIMITED rather than
 * FAILED - what was processed is applied and the rest is taken next pass. An
 * integration that treats "slow down" as a transient error is one that gets
 * blocked by a firewall.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ErpSyncTrigger } from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { carriesTraffic } from '../../domain/erp-connection-state.js';
import { decryptSecret, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { loggerFor } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  ErpCallError,
  callErp,
  erpCredentialAad,
  redactForLedger,
  resolveEndpointUrl,
  safeErrorMessage,
} from './erp-client.js';
import {
  type FieldMapping,
  coerceCurrency,
  coerceQuantity,
  coerceString,
  extractRecords,
  parseFieldMapping,
  readPath,
} from './erp-field-mapping.js';
import {
  type ErpActor,
  assertFeatureEnabled,
  callContextFor,
  ensureOAuthToken,
  loadConnection,
  recordConnectionSuccess,
  suspendAfterFailures,
} from './erp-connection.service.js';
import { claimEvent, recordEventFailure, recordEventSuccess } from './integration-event.service.js';

type ConnectionRow = Prisma.ErpConnectionGetPayload<Record<string, never>>;

/** The '' sentinel for "no warehouse". See the schema note on `warehouseKey`. */
const NO_WAREHOUSE = '';

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface SyncOutcome {
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

export interface SyncRunView {
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

// ---------------------------------------------------------------------------
// One record, as this platform understands it
// ---------------------------------------------------------------------------

interface MappedRecord {
  sku: string;
  warehouseKey: string;
  availableQuantity: number;
  reservedQuantity: number;
  unitOfMeasure: string | null;
  erpProductId: string | null;
  erpProductName: string | null;
  priceMinor: bigint | null;
  currency: string | null;
}

interface RecordFailure {
  externalRef: string | null;
  field: string | null;
  errorCode: string;
  errorMessage: string;
}

/**
 * Turn one ERP record into something this platform can store, or say why not.
 *
 * Everything that can be wrong with a record is caught here and reported per
 * record, so one bad row does not fail a feed of five thousand. The two that
 * matter most:
 *
 *   A missing or unreadable QUANTITY is a failure, never a zero. "The ERP said
 *   nothing" and "the ERP said none left" are different facts, and quietly
 *   turning the first into the second empties a warehouse on the strength of a
 *   typo in a field name.
 *
 *   A warehouse the ERP names and the mapping does not is a failure, never a
 *   guess. Stock in the wrong building is worse than stock nowhere.
 */
function mapRecord(
  mapping: FieldMapping,
  record: unknown,
): { ok: true; value: MappedRecord } | { ok: false; failure: RecordFailure } {
  const fields = mapping.fields;

  const skuPath = fields.sku;
  const sku = skuPath === undefined ? null : coerceString(readPath(record, skuPath));

  if (sku === null) {
    return {
      ok: false,
      failure: {
        externalRef: null,
        field: 'sku',
        errorCode: 'SKU_MISSING',
        errorMessage: 'The record has no SKU at the mapped path, so it cannot be matched.',
      },
    };
  }

  const quantityPath = fields.availableQuantity;
  const available =
    quantityPath === undefined ? null : coerceQuantity(readPath(record, quantityPath));

  if (available === null) {
    return {
      ok: false,
      failure: {
        externalRef: sku,
        field: 'availableQuantity',
        errorCode: 'QUANTITY_UNREADABLE',
        errorMessage:
          'The available quantity was missing or was not a whole number. Nothing was changed ' +
          'for this SKU - a missing figure is not the same as none in stock.',
      },
    };
  }

  if (available < 0) {
    return {
      ok: false,
      failure: {
        externalRef: sku,
        field: 'availableQuantity',
        errorCode: 'QUANTITY_NEGATIVE',
        errorMessage:
          'The available quantity was negative. If this is a backorder figure, map a different ' +
          'field.',
      },
    };
  }

  // --- Warehouse -------------------------------------------------------
  const warehousePath = fields.warehouseId;
  const externalWarehouse =
    warehousePath === undefined ? null : coerceString(readPath(record, warehousePath));

  let warehouseKey = NO_WAREHOUSE;

  if (externalWarehouse !== null) {
    const map = mapping.warehouseMap ?? {};
    const mapped = map[externalWarehouse];

    if (Object.keys(map).length > 0 && mapped === undefined) {
      return {
        ok: false,
        failure: {
          externalRef: sku,
          field: 'warehouseId',
          errorCode: 'WAREHOUSE_NOT_MAPPED',
          errorMessage:
            `Your ERP reported warehouse "${externalWarehouse}", which is not in the warehouse ` +
            'mapping. Add it, or remove the warehouse mapping to keep everything in one place.',
        },
      };
    }

    // With no warehouse map at all, the ERP's own identifier is used as the
    // key. A single-warehouse customer gets sensible behaviour without having
    // to fill in a mapping table for one row.
    warehouseKey = (mapped ?? externalWarehouse).slice(0, 64);
  }

  const reservedPath = fields.reservedQuantity;
  const reserved =
    reservedPath === undefined ? 0 : (coerceQuantity(readPath(record, reservedPath)) ?? 0);

  const currency =
    fields.currency === undefined ? null : coerceCurrency(readPath(record, fields.currency));

  // Price is read only when a currency came with it. A number with no currency
  // is not an amount, and storing one would put this feature in the position of
  // guessing which - see CLAUDE.md.
  let priceMinor: bigint | null = null;
  if (fields.price !== undefined && currency !== null) {
    const { coerceMoneyMinor } = mappingHelpers;
    priceMinor = coerceMoneyMinor(readPath(record, fields.price), exponentFor(currency));
  }

  return {
    ok: true,
    value: {
      sku: sku.slice(0, 191),
      warehouseKey,
      availableQuantity: available,
      reservedQuantity: Math.max(0, reserved),
      unitOfMeasure:
        fields.unitOfMeasure === undefined
          ? null
          : coerceString(readPath(record, fields.unitOfMeasure))?.slice(0, 32) ?? null,
      erpProductId:
        fields.productId === undefined
          ? null
          : coerceString(readPath(record, fields.productId))?.slice(0, 191) ?? null,
      erpProductName:
        fields.productName === undefined
          ? null
          : coerceString(readPath(record, fields.productName))?.slice(0, 255) ?? null,
      priceMinor,
      currency,
    },
  };
}

// Imported lazily through a namespace object so the money helper can be stubbed
// in a test without reaching into the module registry.
import * as mappingHelpers from './erp-field-mapping.js';

/**
 * A currency's minor-unit exponent.
 *
 * Read from the `currencies` table where the installation has one, because that
 * is where an operator has already recorded it. Two is the fallback and is
 * correct for most of the world; JPY (0) and the Gulf currencies (3) are the
 * ones that are not, and a customer whose ERP quotes in those has a currency row
 * for them.
 */
const exponentCache = new Map<string, number>();

async function loadCurrencyExponents(): Promise<void> {
  if (exponentCache.size > 0) return;

  const rows = await prisma.currency.findMany({ select: { code: true, exponent: true } });
  for (const row of rows) exponentCache.set(row.code, row.exponent);
}

function exponentFor(currency: string): number {
  return exponentCache.get(currency) ?? 2;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

interface ApplyResult {
  applied: number;
  skipped: number;
  conflicts: number;
  failures: RecordFailure[];
}

/**
 * Write mapped records into the customer's own stock mirror.
 *
 * Every write is an upsert on `(connectionId, sku, warehouseKey)`. That is what
 * makes applying the same snapshot twice a no-op instead of a doubling, and it
 * is a database constraint rather than a check this function performs - so a
 * redelivered webhook is harmless even if the dedupe at the door somehow let it
 * past.
 *
 * `platformQuantityAtSync` records what this platform's own catalogue said at
 * the same moment, so a divergence can be SHOWN rather than merely resolved.
 * "Your ERP says 12, we say 40" is the sentence a customer needs; it cannot be
 * reconstructed afterwards.
 */
async function applyRecords(
  connection: ConnectionRow,
  records: MappedRecord[],
  options: { dryRun: boolean; syncRunId: string },
): Promise<ApplyResult> {
  if (options.dryRun) {
    return { applied: 0, skipped: records.length, conflicts: 0, failures: [] };
  }

  let applied = 0;
  let skipped = 0;
  let conflicts = 0;
  const failures: RecordFailure[] = [];

  // Resolve SKUs to this platform's catalogue in one query rather than one per
  // record. A five-thousand-record feed would otherwise be five thousand round
  // trips, which is the difference between a sync taking seconds and taking an
  // hour.
  const skus = [...new Set(records.map((record) => record.sku))];
  const products = await prisma.product.findMany({
    where: { sku: { in: skus } },
    select: { id: true, sku: true },
  });
  const productBySku = new Map(products.map((product) => [product.sku, product.id]));

  // And what this platform believes it has, for the divergence figure.
  const platformBalances = await prisma.inventoryBalance.groupBy({
    by: ['productId'],
    where: { productId: { in: [...productBySku.values()] } },
    _sum: { onHandQty: true, reservedQty: true },
  });
  const platformByProduct = new Map(
    platformBalances.map((entry) => [
      entry.productId,
      (entry._sum?.onHandQty ?? 0) - (entry._sum?.reservedQty ?? 0),
    ]),
  );

  for (const record of records) {
    const productId = productBySku.get(record.sku) ?? null;
    const platformQuantity = productId === null ? null : (platformByProduct.get(productId) ?? 0);

    const existing = await prisma.erpInventorySnapshot.findUnique({
      where: {
        connectionId_sku_warehouseKey: {
          connectionId: connection.id,
          sku: record.sku,
          warehouseKey: record.warehouseKey,
        },
      },
    });

    // --- Authority -----------------------------------------------------
    const diverges =
      platformQuantity !== null && platformQuantity !== record.availableQuantity;

    // A manual figure survives the sync only where the connection allows it.
    // Without the flag it would be overwritten on the next pass, and a control
    // that silently undoes itself is worse than no control - so the flag
    // decides, not the presence of the value.
    const manualHolds =
      connection.allowManualOverride &&
      existing?.manualQuantity !== null &&
      existing?.manualQuantity !== undefined;

    if (manualHolds) {
      skipped += 1;
      // The ERP's figure is still recorded beside the manual one, so the person
      // who set it can see what their ERP has been saying since.
      await prisma.erpInventorySnapshot.update({
        where: { id: existing.id },
        data: {
          platformQuantityAtSync: platformQuantity,
          lastSyncedAt: new Date(),
          lastSyncRunId: options.syncRunId,
        },
      });
      continue;
    }

    const authority = connection.inventoryAuthority;

    if (authority === 'MANUAL' && diverges) {
      // Nothing is applied and the row is flagged. The honest answer during a
      // migration: both systems are half right and a person has to say which.
      conflicts += 1;

      await prisma.erpInventorySnapshot.upsert({
        where: {
          connectionId_sku_warehouseKey: {
            connectionId: connection.id,
            sku: record.sku,
            warehouseKey: record.warehouseKey,
          },
        },
        create: {
          id: newId(),
          connectionId: connection.id,
          sku: record.sku,
          warehouseKey: record.warehouseKey,
          productId,
          availableQuantity: 0,
          reservedQuantity: 0,
          platformQuantityAtSync: platformQuantity,
          conflictDetectedAt: new Date(),
          lastSyncRunId: options.syncRunId,
        },
        update: {
          platformQuantityAtSync: platformQuantity,
          conflictDetectedAt: new Date(),
          lastSyncedAt: new Date(),
          lastSyncRunId: options.syncRunId,
        },
      });

      continue;
    }

    if (authority === 'PLATFORM' && diverges) {
      // The ERP figure is recorded, not applied. The customer sees the
      // divergence; their orders continue to be checked against this platform.
      conflicts += 1;
    }

    const quantityToStore =
      authority === 'PLATFORM' && platformQuantity !== null
        ? platformQuantity
        : record.availableQuantity;

    await prisma.erpInventorySnapshot.upsert({
      where: {
        connectionId_sku_warehouseKey: {
          connectionId: connection.id,
          sku: record.sku,
          warehouseKey: record.warehouseKey,
        },
      },
      create: {
        id: newId(),
        connectionId: connection.id,
        sku: record.sku,
        warehouseKey: record.warehouseKey,
        productId,
        availableQuantity: quantityToStore,
        reservedQuantity: record.reservedQuantity,
        unitOfMeasure: record.unitOfMeasure,
        erpProductId: record.erpProductId,
        erpProductName: record.erpProductName,
        priceMinor: record.priceMinor,
        currency: record.currency,
        platformQuantityAtSync: platformQuantity,
        conflictDetectedAt: authority === 'PLATFORM' && diverges ? new Date() : null,
        lastSyncRunId: options.syncRunId,
      },
      update: {
        productId,
        availableQuantity: quantityToStore,
        reservedQuantity: record.reservedQuantity,
        unitOfMeasure: record.unitOfMeasure,
        erpProductId: record.erpProductId,
        erpProductName: record.erpProductName,
        priceMinor: record.priceMinor,
        currency: record.currency,
        platformQuantityAtSync: platformQuantity,
        // Cleared when the two agree again. A stale conflict flag is a support
        // ticket about a problem that fixed itself a week ago.
        conflictDetectedAt: authority === 'PLATFORM' && diverges ? new Date() : null,
        lastSyncedAt: new Date(),
        lastSyncRunId: options.syncRunId,
      },
    });

    applied += 1;
  }

  return { applied, skipped, conflicts, failures };
}

// ---------------------------------------------------------------------------
// Running a sync
// ---------------------------------------------------------------------------

export interface RunSyncInput {
  connection: ConnectionRow;
  trigger: ErpSyncTrigger;
  correlationId: string;
  isDryRun?: boolean;
  /**
   * Records the caller already has, from a webhook body. When present nothing
   * is fetched - the ERP has already told us, and asking it again would turn
   * every push into a pull.
   */
  inlineRecords?: unknown;
  actor?: ErpActor;
}

/**
 * One pass, whatever started it.
 *
 * The single path through which a stock figure changes. Fetching differs
 * between a webhook (the records arrived with it) and a poll (they have to be
 * asked for); everything after that is identical, which is why a bug in
 * mapping, authority or de-duplication cannot exist in one trigger and not
 * another.
 */
export async function runInventorySync(input: RunSyncInput): Promise<SyncOutcome> {
  const { connection } = input;
  const log = loggerFor(input.correlationId, {
    connectionId: connection.id,
    trigger: input.trigger,
  });

  await loadCurrencyExponents();

  // One at a time per connection. Two concurrent passes would race on the same
  // upserts and produce a run whose counts describe neither.
  const alreadyRunning = await prisma.erpInventorySyncRun.findFirst({
    where: { connectionId: connection.id, status: 'RUNNING' },
    select: { id: true, startedAt: true },
  });

  if (alreadyRunning !== null) {
    const age = Date.now() - alreadyRunning.startedAt.getTime();
    if (age < STALE_RUN_MS) {
      throw conflict(
        ErrorCode.ERP_SYNC_ALREADY_RUNNING,
        'A synchronisation is already running for this connection. Wait for it to finish.',
      );
    }

    // Older than the window: the worker holding it is gone.
    await prisma.erpInventorySyncRun.update({
      where: { id: alreadyRunning.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorCode: 'ABANDONED',
        errorMessage: 'This run did not finish. It was closed so a new one could start.',
      },
    });
  }

  const mapping = parseFieldMapping(connection.fieldMappingJson);
  if (mapping === null) {
    throw badRequest(
      ErrorCode.ERP_MAPPING_INVALID,
      'This connection has no field mapping, so there is nothing to read records with.',
    );
  }

  const runId = newId();

  await prisma.erpInventorySyncRun.create({
    data: {
      id: runId,
      connectionId: connection.id,
      trigger: input.trigger,
      status: 'RUNNING',
      isDryRun: input.isDryRun ?? false,
      correlationId: input.correlationId,
    },
  });

  const claim = await claimEvent({
    connectionId: connection.id,
    eventType: input.trigger === 'WEBHOOK' ? 'INVENTORY_WEBHOOK' : 'INVENTORY_SYNC',
    correlationId: input.correlationId,
    // Keyed on the run, so a retry of THIS run collides while a later
    // scheduled pass - which is a different run and should happen - does not.
    idempotencyKey: `erp:sync:${runId}`,
  });

  const eventId = claim.outcome === 'CLAIMED' ? claim.eventId : null;
  const attempt = claim.outcome === 'CLAIMED' ? claim.attempt : 1;

  try {
    // --- Get the records -------------------------------------------------
    let payload: unknown;
    let httpStatus: number | null = null;
    let durationMs: number | null = null;

    if (input.inlineRecords !== undefined) {
      payload = input.inlineRecords;
    } else {
      const endpoint = connection.inventoryEndpoint;
      if (endpoint === null || endpoint === '') {
        throw badRequest(
          ErrorCode.VALIDATION_FAILED,
          'This connection has no inventory endpoint set.',
          [{ field: 'endpoints.inventory', code: 'REQUIRED' }],
        );
      }

      const oauthToken = await ensureOAuthToken(connection);
      const url = resolveEndpointUrl(connection.baseUrl, endpoint, 'endpoints.inventory');

      const response = await callErp(callContextFor(connection), url, {
        method: 'GET',
        oauthAccessToken: oauthToken,
      });

      payload = response.data;
      httpStatus = response.status;
      durationMs = response.durationMs;
    }

    const rawRecords = extractRecords(mapping, payload);

    if (rawRecords === null) {
      throw new ErpCallError(
        mapping.itemsPath === undefined || mapping.itemsPath === ''
          ? 'The response was not a list of records. Set the path to the list in the field ' +
            'mapping.'
          : `There was no list of records at "${mapping.itemsPath}" in the response.`,
        'UNUSABLE_RESPONSE',
        httpStatus,
      );
    }

    // A ceiling on memory and on how long a worker slot is held, not a business
    // rule. Truncation is reported rather than silent - a customer whose feed
    // is half-applied every night needs to know why.
    const truncated = rawRecords.length > env.ERP_MAX_SYNC_RECORDS;
    const records = truncated
      ? rawRecords.slice(0, env.ERP_MAX_SYNC_RECORDS)
      : rawRecords;

    // --- Map -------------------------------------------------------------
    const mapped: MappedRecord[] = [];
    const failures: RecordFailure[] = [];

    for (const record of records) {
      const result = mapRecord(mapping, record);
      if (result.ok) mapped.push(result.value);
      else failures.push(result.failure);
    }

    // --- Apply -----------------------------------------------------------
    const applyResult = await applyRecords(connection, mapped, {
      dryRun: input.isDryRun ?? false,
      syncRunId: runId,
    });

    failures.push(...applyResult.failures);

    await persistRecordErrors(runId, failures);

    const status =
      failures.length === 0
        ? 'SUCCEEDED'
        : failures.length === records.length
          ? 'FAILED'
          : 'PARTIAL';

    const message = buildMessage({
      status,
      processed: records.length,
      applied: applyResult.applied,
      failed: failures.length,
      conflicts: applyResult.conflicts,
      skipped: applyResult.skipped,
      truncated,
      dryRun: input.isDryRun ?? false,
    });

    await prisma.erpInventorySyncRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: new Date(),
        processedCount: records.length,
        appliedCount: applyResult.applied,
        skippedCount: applyResult.skipped,
        failedCount: failures.length,
        conflictCount: applyResult.conflicts,
        ...(status === 'FAILED'
          ? { errorCode: 'ALL_RECORDS_REJECTED', errorMessage: message.slice(0, 1000) }
          : {}),
      },
    });

    if (status !== 'FAILED') {
      await recordConnectionSuccess(connection.id);
    }

    if (eventId !== null) {
      await recordEventSuccess({
        eventId,
        httpStatus,
        durationMs,
        response: {
          runId,
          processed: records.length,
          applied: applyResult.applied,
          failed: failures.length,
        },
      });
    }

    await recordAudit({
      action: AuditAction.ERP_INVENTORY_SYNCED,
      resourceType: 'erp_connection',
      resourceId: connection.id,
      actorType: input.actor === undefined ? 'SYSTEM' : 'CUSTOMER',
      actorUserId: input.actor?.userId ?? null,
      actorEmail: input.actor?.email ?? null,
      after: {
        runId,
        trigger: input.trigger,
        status,
        processed: records.length,
        applied: applyResult.applied,
        failed: failures.length,
        conflicts: applyResult.conflicts,
        dryRun: input.isDryRun ?? false,
      },
      correlationId: input.correlationId,
    });

    log.info(
      { runId, status, processed: records.length, applied: applyResult.applied },
      'customer ERP inventory sync finished',
    );

    return {
      runId,
      status,
      processed: records.length,
      applied: applyResult.applied,
      skipped: applyResult.skipped,
      failed: failures.length,
      conflicts: applyResult.conflicts,
      message,
      rateLimitedUntil: null,
    };
  } catch (error) {
    const erpError = error instanceof ErpCallError ? error : null;
    const message = safeErrorMessage(error);

    // A 429 is not a failure. What was processed stands, and the rest is taken
    // next pass - after exactly as long as the ERP asked for.
    const rateLimited = erpError?.kind === 'RATE_LIMIT';
    const rateLimitedUntil =
      rateLimited && erpError !== null
        ? new Date(Date.now() + (erpError.retryAfterSeconds ?? 300) * 1000)
        : null;

    await prisma.erpInventorySyncRun.update({
      where: { id: runId },
      data: {
        status: rateLimited ? 'RATE_LIMITED' : 'FAILED',
        finishedAt: new Date(),
        rateLimitedUntil,
        errorCode: erpError?.errorCode ?? 'UNKNOWN',
        errorMessage: message.slice(0, 1000),
      },
    });

    await prisma.erpConnection.update({
      where: { id: connection.id },
      data: { lastSyncFailureAt: new Date() },
    });

    // A rate limit is the ERP working correctly, so it does not count towards
    // taking the connection out of service. Counting it would suspend the
    // connections of exactly the customers whose ERPs are best behaved.
    if (!rateLimited) {
      await suspendAfterFailures(connection.id, message);
    } else {
      // Push the next poll out to when we were told to come back.
      await prisma.erpConnection.update({
        where: { id: connection.id },
        data: { nextPollAt: rateLimitedUntil },
      });
    }

    if (eventId !== null) {
      await recordEventFailure({ eventId, attempt, error });
    }

    log.warn({ runId, err: error, rateLimited }, 'customer ERP inventory sync failed');

    return {
      runId,
      status: rateLimited ? 'RATE_LIMITED' : 'FAILED',
      processed: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      conflicts: 0,
      message,
      rateLimitedUntil: rateLimitedUntil?.toISOString() ?? null,
    };
  }
}

/** How long a RUNNING run is believed before it is treated as abandoned. */
const STALE_RUN_MS = 15 * 60 * 1000;

async function persistRecordErrors(runId: string, failures: RecordFailure[]): Promise<void> {
  if (failures.length === 0) return;

  // Capped. A feed that fails wholesale should produce a run marked FAILED with
  // one reason, not fifty thousand rows nobody will read.
  const capped = failures.slice(0, env.ERP_MAX_RECORD_ERRORS);

  await prisma.erpSyncRecordError.createMany({
    data: capped.map((failure) => ({
      id: newId(),
      syncRunId: runId,
      externalRef: failure.externalRef,
      field: failure.field,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage.slice(0, 1000),
    })),
  });
}

function buildMessage(input: {
  status: string;
  processed: number;
  applied: number;
  failed: number;
  conflicts: number;
  skipped: number;
  truncated: boolean;
  dryRun: boolean;
}): string {
  const parts: string[] = [];

  if (input.dryRun) {
    parts.push(
      `Read ${String(input.processed)} record${input.processed === 1 ? '' : 's'}. Nothing was changed.`,
    );
  } else {
    parts.push(
      `Read ${String(input.processed)} record${input.processed === 1 ? '' : 's'} and updated ` +
        `${String(input.applied)}.`,
    );
  }

  if (input.failed > 0) {
    parts.push(`${String(input.failed)} could not be applied - see the details below.`);
  }

  if (input.conflicts > 0) {
    parts.push(
      `${String(input.conflicts)} disagreed with the figures held here and were left for you to ` +
        'resolve.',
    );
  }

  if (input.skipped > 0 && !input.dryRun) {
    parts.push(`${String(input.skipped)} were left alone because they have a manual figure set.`);
  }

  if (input.truncated) {
    parts.push(
      `Only the first ${String(env.ERP_MAX_SYNC_RECORDS)} records were read. Use paging ` +
        'on your inventory endpoint to send them in smaller batches.',
    );
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Manual sync
// ---------------------------------------------------------------------------

/**
 * Sync now, pressed by the account holder.
 *
 * Refuses on a connection that is not switched on. A customer expecting "Sync
 * now" to work on a paused connection is expecting pause not to mean pause, and
 * the honest answer is the refusal rather than quietly resuming it for them.
 */
export async function syncNow(
  actor: ErpActor,
  connectionId: string,
  options: { dryRun?: boolean } = {},
): Promise<SyncOutcome> {
  assertFeatureEnabled();

  const connection = await loadConnection(connectionId);

  if (!carriesTraffic(connection.status) && options.dryRun !== true) {
    throw conflict(
      ErrorCode.ERP_CONNECTION_STATE_INVALID,
      'Switch this connection on before synchronising. A dry run works at any time.',
    );
  }

  return runInventorySync({
    connection,
    trigger: 'MANUAL',
    correlationId: actor.correlationId ?? newId(),
    isDryRun: options.dryRun ?? false,
    actor,
  });
}

// ---------------------------------------------------------------------------
// Inbound webhooks
// ---------------------------------------------------------------------------

export interface WebhookResult {
  accepted: boolean;
  duplicate: boolean;
  runId: string | null;
  message: string;
}

/**
 * Verify an HMAC-SHA256 signature over the exact bytes received.
 *
 * The raw body, not a re-serialised object. Key order and whitespace change
 * when JSON is parsed and stringified, so a signature checked against a
 * round-tripped body fails for every honest sender - and the usual "fix" for
 * that is to stop checking, which is how an endpoint that rewrites stock ends
 * up unauthenticated.
 *
 * Two spellings are accepted because ERPs differ and neither is wrong: a bare
 * hex digest, and one prefixed `sha256=`. Compared in constant time, so the
 * endpoint cannot be used as an oracle to discover a valid signature byte by
 * byte.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  provided: string | undefined,
  secret: string,
): boolean {
  if (provided === undefined || provided === '') return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const candidate = provided.trim().replace(/^sha256=/i, '').toLowerCase();

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const candidateBuffer = Buffer.from(candidate, 'utf8');

  // Length is not secret, and `timingSafeEqual` throws on a mismatch.
  if (expectedBuffer.length !== candidateBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, candidateBuffer);
}

/**
 * Handle a stock update a customer's ERP pushed to us.
 *
 * The order of checks is deliberate and each one refuses with the same shape,
 * because an endpoint that distinguishes "no such connection" from "wrong
 * signature" tells an attacker which of the two they got right.
 *
 *   1. The slug names a connection that exists, is not deleted, and is ACTIVE.
 *   2. Webhooks are switched on for it and a signing secret is configured.
 *   3. The signature over the raw bytes verifies.
 *   4. The event has not been seen before.
 *
 * Only then is anything applied. A duplicate is answered 200 with
 * `duplicate: true` rather than an error: an ERP retrying a delivery it already
 * made has done nothing wrong, and answering it with a 4xx makes it retry
 * harder.
 */
export async function handleInventoryWebhook(input: {
  slug: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  correlationId: string;
}): Promise<WebhookResult> {
  if (!env.FEATURE_ERP_INTEGRATION) {
    // 404 rather than 403. A disabled feature should not confirm that this
    // endpoint would otherwise exist.
    throw notFound('That endpoint');
  }

  const connection = await prisma.erpConnection.findFirst({
    where: { webhookSlug: input.slug, deletedAt: null },
  });

  const log = loggerFor(input.correlationId, { webhookSlug: `${input.slug.slice(0, 6)}...` });

  /**
   * Record why a delivery was refused, and produce the one error we ever send.
   *
   * The reason goes to the log and the audit trail; the SENDER always gets the
   * same sentence. An endpoint that distinguishes "no such connection" from
   * "wrong signature" tells whoever is probing it which of the two they got
   * right, and the second is worth far more to them than the first.
   *
   * Returns the error rather than throwing it, so each call site does the
   * throwing. That is not a stylistic choice: `throw` at the call site is what
   * lets TypeScript narrow `connection` to non-null on the lines below, and an
   * `await refuse(...)` that merely promises never to return does not.
   */
  const refusal = async (reason: string): Promise<Error> => {
    log.warn({ reason }, 'inbound ERP webhook refused');

    if (connection !== null) {
      await recordAudit({
        action: AuditAction.ERP_WEBHOOK_REJECTED,
        resourceType: 'erp_connection',
        resourceId: connection.id,
        actorType: 'PROVIDER',
        after: { reason },
        correlationId: input.correlationId,
      });
    }

    return forbidden(
      ErrorCode.ERP_WEBHOOK_REJECTED,
      'This request could not be accepted. Check the webhook URL and signing secret.',
    );
  };

  if (connection === null) throw await refusal('no such connection');
  if (!connection.webhookEnabled) throw await refusal('webhooks are switched off');

  const webhookSecretEnc = connection.webhookSecretEnc;
  if (webhookSecretEnc === null) throw await refusal('no signing secret configured');

  // A paused connection refuses webhooks. Accepting stock updates for something
  // somebody deliberately stopped is the opposite of what pausing means.
  if (!carriesTraffic(connection.status)) {
    throw await refusal(`connection is ${connection.status}`);
  }

  let secret: string;
  try {
    secret = decryptSecret(webhookSecretEnc, erpCredentialAad(connection.id));
  } catch {
    // A ciphertext that will not open is an operational fault - a rotated key,
    // a row copied between environments. The sender is told the same thing as
    // everybody else; the reason is on the trail for whoever investigates.
    throw await refusal('signing secret could not be read');
  }

  const headerName = connection.webhookSignatureHeader.toLowerCase();
  const rawHeader = input.headers[headerName];
  const provided = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  if (!verifyWebhookSignature(input.rawBody, provided, secret)) {
    throw await refusal('signature did not verify');
  }

  // --- De-duplicate ------------------------------------------------------
  //
  // The ERP's own event id where it sent one, and a hash of the body where it
  // did not. Two identical bodies inside the window are indistinguishable from
  // a redelivery, and for a full-quantity snapshot treating them as one is the
  // safe direction to be wrong in.
  const eventIdHeader = input.headers['x-erp-event-id'] ?? input.headers['x-event-id'];
  const externalEventId =
    (Array.isArray(eventIdHeader) ? eventIdHeader[0] : eventIdHeader)?.slice(0, 191) ??
    `sha256:${sha256Hex(input.rawBody.toString('utf8'))}`;

  const receiptId = newId();

  await prisma.erpWebhookReceipt.createMany({
    data: [
      {
        id: receiptId,
        connectionId: connection.id,
        externalEventId,
      },
    ],
    skipDuplicates: true,
  });

  const receipt = await prisma.erpWebhookReceipt.findUnique({
    where: {
      connectionId_externalEventId: { connectionId: connection.id, externalEventId },
    },
  });

  if (receipt !== null && receipt.id !== receiptId) {
    // Seen before. 200 with `duplicate: true`: the sender has done nothing
    // wrong, and a 4xx would only make it retry harder.
    log.info({ externalEventId }, 'inbound ERP webhook was a duplicate; nothing applied');

    return {
      accepted: true,
      duplicate: true,
      runId: receipt.syncRunId,
      message: 'Already received. Nothing was changed.',
    };
  }

  // --- Apply -------------------------------------------------------------
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    await prisma.erpWebhookReceipt.update({
      where: { id: receiptId },
      data: { processedAt: new Date() },
    });

    throw badRequest(ErrorCode.WEBHOOK_PAYLOAD_INVALID, 'The request body was not valid JSON.');
  }

  const outcome = await runInventorySync({
    connection,
    trigger: 'WEBHOOK',
    correlationId: input.correlationId,
    inlineRecords: payload,
  });

  await prisma.erpWebhookReceipt.update({
    where: { id: receiptId },
    data: { processedAt: new Date(), syncRunId: outcome.runId },
  });

  return {
    accepted: true,
    duplicate: false,
    runId: outcome.runId,
    message: outcome.message,
  };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Connections whose next poll is due.
 *
 * The fallback for an ERP with no outbound webhooks, which is most of them. The
 * query is the reason `ix_erp_connection_poll_due` exists, and a pass with
 * nothing due costs one indexed read.
 */
export async function pollDueConnections(limit = 20): Promise<{ polled: number; failed: number }> {
  if (!env.FEATURE_ERP_INTEGRATION) return { polled: 0, failed: 0 };

  const due = await prisma.erpConnection.findMany({
    where: {
      status: 'ACTIVE',
      pollingEnabled: true,
      deletedAt: null,
      OR: [{ nextPollAt: null }, { nextPollAt: { lte: new Date() } }],
    },
    orderBy: { nextPollAt: 'asc' },
    take: limit,
  });

  let polled = 0;
  let failed = 0;

  for (const connection of due) {
    // Booked BEFORE the run rather than after. A run that throws in a way this
    // loop does not catch would otherwise leave `nextPollAt` in the past and be
    // picked up again on the very next pass, which is a tight loop against
    // somebody else's server.
    await prisma.erpConnection.update({
      where: { id: connection.id },
      data: {
        lastPolledAt: new Date(),
        nextPollAt: new Date(Date.now() + connection.pollingIntervalMinutes * 60_000),
      },
    });

    try {
      const outcome = await runInventorySync({
        connection,
        trigger: 'SCHEDULED',
        correlationId: newId(),
      });

      if (outcome.status === 'FAILED') failed += 1;
      else polled += 1;
    } catch (error) {
      failed += 1;
      loggerFor(newId(), { connectionId: connection.id }).warn(
        { err: error },
        'scheduled ERP inventory poll could not run',
      );
    }
  }

  return { polled, failed };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listSyncRuns(
  connectionId: string,
  limit = 20,
): Promise<SyncRunView[]> {
  const rows = await prisma.erpInventorySyncRun.findMany({
    where: { connectionId },
    orderBy: { startedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });

  return rows.map((row) => ({
    id: row.id,
    connectionId: row.connectionId,
    trigger: row.trigger,
    status: row.status,
    isDryRun: row.isDryRun,
    correlationId: row.correlationId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    processedCount: row.processedCount,
    appliedCount: row.appliedCount,
    skippedCount: row.skippedCount,
    failedCount: row.failedCount,
    conflictCount: row.conflictCount,
    rateLimitedUntil: row.rateLimitedUntil?.toISOString() ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  }));
}

export async function getSyncRunErrors(
  runId: string,
): Promise<{ externalRef: string | null; field: string | null; errorCode: string; errorMessage: string }[]> {
  const run = await prisma.erpInventorySyncRun.findUnique({
    where: { id: runId },
    select: { id: true },
  });

  if (run === null) throw notFound('That synchronisation');

  const rows = await prisma.erpSyncRecordError.findMany({
    where: { syncRunId: runId },
    orderBy: { createdAt: 'asc' },
    take: env.ERP_MAX_RECORD_ERRORS,
  });

  return rows.map((row) => ({
    externalRef: row.externalRef,
    field: row.field,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  }));
}

export interface ErpInventoryView {
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

export async function listErpInventory(
  filters: { connectionId?: string; sku?: string; conflictsOnly?: boolean; limit?: number } = {},
): Promise<ErpInventoryView[]> {
  const rows = await prisma.erpInventorySnapshot.findMany({
    where: {
      ...(filters.connectionId === undefined ? {} : { connectionId: filters.connectionId }),
      ...(filters.sku === undefined ? {} : { sku: { contains: filters.sku } }),
      ...(filters.conflictsOnly === true ? { conflictDetectedAt: { not: null } } : {}),
    },
    orderBy: [{ conflictDetectedAt: 'desc' }, { sku: 'asc' }],
    take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
  });

  return rows.map((row) => ({
    sku: row.sku,
    warehouseKey: row.warehouseKey,
    productId: row.productId,
    availableQuantity: row.availableQuantity,
    reservedQuantity: row.reservedQuantity,
    // A manual figure wins where one is set. This is the number every
    // availability check downstream reads, so it is computed here rather than
    // in each caller.
    effectiveQuantity: row.manualQuantity ?? row.availableQuantity,
    unitOfMeasure: row.unitOfMeasure,
    erpProductName: row.erpProductName,
    platformQuantityAtSync: row.platformQuantityAtSync,
    hasConflict: row.conflictDetectedAt !== null,
    manualQuantity: row.manualQuantity,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
  }));
}

/**
 * Set, or clear, a figure by hand.
 *
 * Refused where the connection does not allow manual override, and that refusal
 * is the useful part: with the ERP as the authority, a manual figure is
 * overwritten by the next sync, so accepting one would be accepting a change
 * this system knows it is about to discard.
 */
export async function setManualQuantity(
  actor: ErpActor,
  input: { connectionId: string; sku: string; warehouseKey?: string; quantity: number | null },
): Promise<ErpInventoryView> {
  assertFeatureEnabled();

  const connection = await loadConnection(input.connectionId);

  if (!connection.allowManualOverride) {
    throw conflict(
      ErrorCode.INVENTORY_BALANCE_NOT_EDITABLE,
      'This connection does not allow figures to be set by hand. Turn on manual override in the ' +
        'connection settings first - otherwise the next synchronisation would overwrite it.',
    );
  }

  if (input.quantity !== null && (input.quantity < 0 || !Number.isInteger(input.quantity))) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Enter a whole number of units, or none.', [
      { field: 'quantity', code: 'INVALID' },
    ]);
  }

  const warehouseKey = input.warehouseKey ?? NO_WAREHOUSE;

  const existing = await prisma.erpInventorySnapshot.findUnique({
    where: {
      connectionId_sku_warehouseKey: {
        connectionId: input.connectionId,
        sku: input.sku,
        warehouseKey,
      },
    },
  });

  if (existing === null) throw notFound('That stock line');

  const updated = await prisma.erpInventorySnapshot.update({
    where: { id: existing.id },
    data: {
      manualQuantity: input.quantity,
      manualSetAt: input.quantity === null ? null : new Date(),
      manualSetByUserId: input.quantity === null ? null : actor.userId,
      // Setting a figure by hand IS the resolution of a divergence.
      conflictDetectedAt: null,
    },
  });

  await recordAudit({
    action: AuditAction.INVENTORY_ADJUSTED,
    resourceType: 'erp_inventory',
    resourceId: updated.id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { manualQuantity: existing.manualQuantity, erpQuantity: existing.availableQuantity },
    after: { manualQuantity: input.quantity, sku: input.sku, warehouseKey },
    correlationId: actor.correlationId ?? null,
  });

  return {
    sku: updated.sku,
    warehouseKey: updated.warehouseKey,
    productId: updated.productId,
    availableQuantity: updated.availableQuantity,
    reservedQuantity: updated.reservedQuantity,
    effectiveQuantity: updated.manualQuantity ?? updated.availableQuantity,
    unitOfMeasure: updated.unitOfMeasure,
    erpProductName: updated.erpProductName,
    platformQuantityAtSync: updated.platformQuantityAtSync,
    hasConflict: false,
    manualQuantity: updated.manualQuantity,
    lastSyncedAt: updated.lastSyncedAt.toISOString(),
  };
}

/**
 * What a customer's ERP says about a set of SKUs.
 *
 * Read by the order path before anything is charged. Returns an empty map when
 * no connection is ACTIVE, and every caller treats that as "no opinion" rather
 * than "nothing in stock" - an installation with no ERP must take orders
 * exactly as it did before this feature existed.
 */
export async function availabilityForSkus(skus: string[]): Promise<Map<string, number>> {
  if (skus.length === 0) return new Map();

  const rows = await prisma.erpInventorySnapshot.findMany({
    where: {
      sku: { in: skus },
      connection: { status: 'ACTIVE', deletedAt: null },
    },
    select: { sku: true, availableQuantity: true, manualQuantity: true },
  });

  const result = new Map<string, number>();

  for (const row of rows) {
    const quantity = row.manualQuantity ?? row.availableQuantity;
    // Summed across warehouses: a customer with stock in three places has that
    // much stock. Which warehouse it ships from is the ERP's decision, not
    // ours.
    result.set(row.sku, (result.get(row.sku) ?? 0) + quantity);
  }

  return result;
}

export { redactForLedger };
