/**
 * What the Glovia Tally Bridge is allowed to do.
 *
 * The bridge is a small agent the seller runs on the machine beside
 * TallyPrime. It connects OUTWARD to this API, claims work queued for its own
 * seller, talks to Tally over the local network, and reports back. Nothing
 * ever connects in.
 *
 * THE TRUST BOUNDARY, AND WHAT IT MEANS FOR THIS FILE
 *
 * The bridge runs on somebody else's computer. It can be modified, replaced,
 * or run by somebody who is not the seller. So everything it SAYS is treated
 * as a claim, and every claim that matters is checked here:
 *
 *   - It cannot say which seller it is. Its token names a device, the device
 *     names a connection, and every query is filtered on that.
 *   - It cannot mark a job successful. It reports Tally's COUNTERS, and
 *     `completeTask` decides from them - see the note there about HTTP 200.
 *   - It cannot tell us the connection is fine. A test result is a set of
 *     facts with a time on it, and `decideConnectionState` reaches the verdict.
 *   - It cannot pick up another seller's work, because the claim query is
 *     scoped by its own connection id and never by anything in the request.
 *
 * A compromised bridge can therefore lie about one seller's own Tally to that
 * seller. It cannot reach another seller, and it cannot make an accounting
 * event appear to have posted when it did not.
 */
import { env } from '../../config/env.js';
import { notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { applyTestResult } from './connection.service.js';
import { storeMasters, type MappingEntity } from './mapping.service.js';
import { claimTasks, completeTask, type ClaimedErpTask, type TaskResultInput } from './job.service.js';
import type { AuthenticatedBridge } from './pairing.service.js';

export interface HeartbeatInput {
  bridge: AuthenticatedBridge;
  agentVersion: string | null;
  osLabel: string | null;
  /** What the agent says its local Tally address is. RECORDED, never dialled. */
  reportedTallyAddress: string | null;
  /** Whether the agent can currently reach Tally at all, as IT sees things. */
  tallyReachable: boolean | null;
  ipHash: string | null;
}

export interface HeartbeatResult {
  /** How long the agent should wait before beating again, in seconds. */
  intervalSeconds: number;
  /** How many tasks are waiting, so a quiet agent can poll lazily. */
  pendingTasks: number;
  /** True when the agent should rotate its token now. */
  shouldRotateToken: boolean;
  /** The company this connection posts into, so the agent can pre-check it. */
  companyName: string | null;
}

/**
 * "I am still here."
 *
 * The ONLY thing that makes `CONNECTED` possible. `decideConnectionState`
 * requires a heartbeat inside `HEARTBEAT_FRESH_SECONDS`, so a machine that
 * stops beating stops being connected without anything having to notice - the
 * absence of a row IS the signal, which is why no code path can accidentally
 * leave a stale "connected" behind.
 *
 * `tallyReachable` is recorded as the agent's OPINION and is deliberately not
 * enough to make a connection healthy on its own: only a test that actually
 * asked Tally for the company list can do that.
 */
export async function recordHeartbeat(input: HeartbeatInput): Promise<HeartbeatResult> {
  const now = new Date();

  const device = await prisma.sellerErpBridgeDevice.update({
    where: { id: input.bridge.deviceId },
    data: {
      lastHeartbeatAt: now,
      state: 'ACTIVE',
      lastSeenIpHash: input.ipHash,
      agentVersion: input.agentVersion?.slice(0, 32) ?? undefined,
      osLabel: input.osLabel?.slice(0, 64) ?? undefined,
      reportedTallyAddress: input.reportedTallyAddress?.slice(0, 255) ?? undefined,
    },
    select: { tokenExpiresAt: true },
  });

  const [pendingTasks, connection] = await Promise.all([
    prisma.sellerErpSyncJob.count({
      where: {
        connectionId: input.bridge.connectionId,
        status: { in: ['PENDING', 'RETRY_SCHEDULED'] },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
    }),
    prisma.sellerErpConnection.findUnique({
      where: { id: input.bridge.connectionId },
      select: { companyName: true },
    }),
  ]);

  /*
   * Rotate a week before expiry.
   *
   * Told to the agent rather than enforced by a sweep, because the agent is
   * the only party that can hold the new token - and a week is long enough
   * that a machine switched on once a fortnight still gets the message before
   * its credential dies in a cupboard.
   */
  const rotateAfter = 7 * 24 * 60 * 60 * 1000;
  const shouldRotateToken =
    device.tokenExpiresAt !== null &&
    device.tokenExpiresAt.getTime() - now.getTime() < rotateAfter;

  return {
    // A minute, which the freshness window tolerates two misses of.
    intervalSeconds: 60,
    pendingTasks,
    shouldRotateToken,
    companyName: connection?.companyName ?? null,
  };
}

/**
 * Hand this bridge its own seller's work.
 *
 * The connection id comes from the TOKEN, never from the request. That is the
 * whole of the tenant isolation on this endpoint and it is structural rather
 * than checked: there is no parameter in which a bridge could name a
 * connection, so there is nothing to validate and nothing to forget to
 * validate.
 */
export async function pollTasks(input: {
  bridge: AuthenticatedBridge;
  limit: number;
}): Promise<{ tasks: ClaimedErpTask[]; leaseSeconds: number }> {
  const tasks = await claimTasks({
    connectionId: input.bridge.connectionId,
    deviceId: input.bridge.deviceId,
    limit: input.limit,
  });

  return { tasks, leaseSeconds: env.SELLER_ERP_TASK_LEASE_SECONDS };
}

/** What the bridge reports back about one task. */
export interface BridgeTaskResult {
  jobId: string;
  ok: boolean;
  httpStatus?: number | null;
  durationMs?: number | null;
  errorCode?: string | null;
  sanitizedError?: string | null;
  requestHash?: string | null;
  responseHash?: string | null;
  tally?: {
    created?: number | null;
    altered?: number | null;
    deleted?: number | null;
    ignored?: number | null;
    errors?: number | null;
    exceptions?: number | null;
    lastVoucherId?: string | null;
  } | null;
  voucherNumber?: string | null;
  masterName?: string | null;
  lineErrors?: { message: string; lineNumber: number | null; missingMaster: string | null }[];
  /** A CONNECTION_TEST's findings. */
  companies?: { name: string; guid?: string | null; booksFrom?: string | null }[];
  tallyVersion?: string | null;
  baseCurrency?: string | null;
  /** A MASTER_PULL's findings, by entity. */
  masters?: {
    entity: string;
    rows: { name: string; guid?: string | null; parent?: string | null; extra?: Record<string, string> }[];
  }[];
  /** An INVENTORY_PULL's findings. */
  stock?: { stockItemName: string; closingQuantity: number; unitName?: string | null }[];
}

/**
 * Record the outcome of one task.
 *
 * The read results - a test's company list, a pull's masters - are applied
 * FIRST and the job is completed second. That order matters on a failure: a
 * test that reached Tally, listed the companies, and then failed on something
 * else has still told us which companies are open, and throwing that away
 * would leave the seller unable to pick one.
 */
export async function submitTaskResult(input: {
  bridge: AuthenticatedBridge;
  result: BridgeTaskResult;
}): Promise<void> {
  const { bridge, result } = input;

  /*
   * The job is re-read and its ownership checked before anything is applied.
   *
   * `completeTask` checks it too. Twice, because the read results below are
   * applied before it runs, and applying a company list off a job belonging to
   * another connection would write one seller's Tally companies onto another
   * seller's row.
   */
  const job = await prisma.sellerErpSyncJob.findUnique({
    where: { id: result.jobId },
    select: { id: true, connectionId: true, eventType: true },
  });

  /*
   * A 404, and the same 404 for both cases.
   *
   * "No such job" and "somebody else's job" answer identically, because a
   * bridge that could tell them apart could enumerate other sellers' work by
   * guessing ids. `notFound` rather than `badRequest`: the request was well
   * formed, and as far as this caller is concerned the row does not exist.
   */
  if (job === null || job.connectionId !== bridge.connectionId) {
    throw notFound('ERP task');
  }

  if (job.eventType === 'CONNECTION_TEST' && result.companies !== undefined) {
    await applyTestResult({
      connectionId: bridge.connectionId,
      ok: result.ok,
      companies: result.companies.slice(0, 50).map((company) => ({
        name: company.name.slice(0, 255),
        guid: company.guid?.slice(0, 96) ?? null,
        booksFrom: parseIsoDate(company.booksFrom ?? null),
      })),
      tallyVersion: result.tallyVersion ?? null,
      baseCurrency: result.baseCurrency ?? null,
      message: result.sanitizedError ?? null,
    });
  }

  if (job.eventType === 'MASTER_PULL' && result.masters !== undefined) {
    for (const group of result.masters.slice(0, 20)) {
      // Only entities this system knows how to map. A bridge naming something
      // else is ignored rather than trusted to widen the enum by asserting.
      if (!isMappingEntity(group.entity)) continue;

      await storeMasters({
        connectionId: bridge.connectionId,
        entity: group.entity,
        masters: group.rows.slice(0, 5000).map((row) => ({
          name: row.name,
          guid: row.guid ?? null,
          parent: row.parent ?? null,
          extra: row.extra ?? {},
        })),
      });
    }
  }

  if (job.eventType === 'INVENTORY_PULL' && result.stock !== undefined) {
    await applyStockSnapshot({
      connectionId: bridge.connectionId,
      rows: result.stock.slice(0, env.SELLER_ERP_MAX_ATTEMPTS * 1000),
    });
  }

  const taskResult: TaskResultInput = {
    jobId: result.jobId,
    connectionId: bridge.connectionId,
    deviceId: bridge.deviceId,
    ok: result.ok,
    tallyCounters: result.tally ?? null,
    voucherNumber: result.voucherNumber ?? null,
    masterName: result.masterName ?? null,
    lineErrors: result.lineErrors ?? [],
    errorCode: result.errorCode ?? null,
    sanitizedError: result.sanitizedError ?? null,
    httpStatus: result.httpStatus ?? null,
    requestHash: result.requestHash ?? null,
    responseHash: result.responseHash ?? null,
    durationMs: result.durationMs ?? null,
  };

  await completeTask(taskResult);
}

const MAPPING_ENTITIES: ReadonlySet<string> = new Set([
  'PARTY_LEDGER',
  'STOCK_ITEM',
  'GODOWN',
  'UNIT',
  'ALTERNATE_UNIT',
  'SALES_ORDER_VOUCHER_TYPE',
  'SALES_INVOICE_VOUCHER_TYPE',
  'RECEIPT_VOUCHER_TYPE',
  'CREDIT_NOTE_VOUCHER_TYPE',
  'SALES_LEDGER',
  'FREIGHT_LEDGER',
  'DISCOUNT_LEDGER',
  'COMMISSION_LEDGER',
  'GATEWAY_FEE_LEDGER',
  'ROUNDING_LEDGER',
  'TAX_LEDGER_CGST',
  'TAX_LEDGER_SGST',
  'TAX_LEDGER_IGST',
  'TAX_LEDGER_CESS',
  'TAX_LEDGER_OTHER',
  'COST_CENTRE',
  'CURRENCY',
]);

function isMappingEntity(value: string): value is MappingEntity {
  return MAPPING_ENTITIES.has(value);
}

function parseIsoDate(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * What Tally says the seller has in stock.
 *
 * RECORDED AND COMPARED, and only APPLIED where the seller has explicitly
 * chosen `TALLY` as the authority. The four answers in
 * `SellerErpInventoryAuthority` are a real question with no universally right
 * answer, and the default is `DISABLED` - a seller who has not decided gets
 * their figures left alone.
 *
 * Even under `TALLY`, the platform's balance is moved through a recorded
 * movement rather than overwritten, so the seller's own ledger still adds up
 * afterwards and somebody can see why it changed. That is the same discipline
 * the operator's ERP snapshot follows, and for the same reason: a stock figure
 * that changed with no movement behind it is a figure nobody can explain.
 */
async function applyStockSnapshot(input: {
  connectionId: string;
  rows: { stockItemName: string; closingQuantity: number; unitName?: string | null }[];
}): Promise<void> {
  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: input.connectionId },
    select: { id: true, sellerAccountId: true, inventoryAuthority: true },
  });

  if (connection === null || connection.inventoryAuthority === 'DISABLED') return;

  // Tally's name -> our offer, through the confirmed stock-item mappings.
  const mappings = await prisma.sellerErpMapping.findMany({
    where: { connectionId: input.connectionId, entity: 'STOCK_ITEM', isConfirmed: true },
    select: { localKey: true, tallyName: true },
  });

  const offerByTallyName = new Map(mappings.map((row) => [row.tallyName, row.localKey]));

  const now = new Date();

  for (const row of input.rows) {
    const offerId = offerByTallyName.get(row.stockItemName);
    if (offerId === undefined) continue;

    const quantity = Math.max(0, Math.trunc(row.closingQuantity));

    /*
     * Written to `erpQuantity`, beside the real balance, in every mode.
     *
     * That column is the divergence made visible: the seller's inventory
     * screen shows their figure and Tally's side by side, and the difference
     * is a thing somebody looks at rather than a silent overwrite. Under
     * `GLOVIA` and `MANUAL` that is all that happens, which is the point.
     */
    await prisma.sellerInventory.updateMany({
      where: { offerId, sellerAccountId: connection.sellerAccountId },
      data: { erpQuantity: quantity, erpSyncedAt: now },
    });

    if (connection.inventoryAuthority !== 'TALLY') continue;

    /*
     * Under TALLY, the figure is applied - through a MOVEMENT.
     *
     * The movement is what keeps the ledger honest: a balance that jumped with
     * nothing behind it is a number nobody can account for, and this is an
     * inventory system whose whole job is accounting for them. The movement
     * type already exists for exactly this case.
     */
    const balances = await prisma.sellerInventory.findMany({
      where: { offerId, sellerAccountId: connection.sellerAccountId },
      select: { id: true, locationId: true, availableQuantity: true },
    });

    // Only meaningful where the offer is stocked in ONE place. Tally's closing
    // balance is a single figure per item; splitting it across three godowns
    // would be inventing a distribution nobody stated.
    const only = balances.length === 1 ? balances[0] : undefined;
    if (only === undefined) continue;

    const delta = quantity - only.availableQuantity;
    if (delta === 0) continue;

    await prisma.$transaction(async (tx) => {
      await tx.sellerInventory.update({
        where: { id: only.id },
        data: { availableQuantity: quantity, version: { increment: 1 } },
      });

      await tx.sellerInventoryMovement.create({
        data: {
          id: newId(),
          sellerAccountId: connection.sellerAccountId,
          offerId,
          locationId: only.locationId,
          type: 'ERP_RECONCILIATION',
          quantityDelta: delta,
          balanceAfter: quantity,
          referenceType: 'seller_erp_connection',
          referenceId: connection.id,
          reason: `TallyPrime reported ${String(quantity)} in stock.`,
          /*
           * Makes a repeated pull harmless.
           *
           * A poll that times out after Tally answered is retried, and without
           * this the same reconciliation would be written twice - which for a
           * DELTA movement means the balance moves twice. Keyed on the figure
           * and the day, so a genuinely new figure tomorrow is a new movement
           * and the same figure re-reported today is not.
           */
          idempotencyKey: `tally:${connection.id}:${offerId}:${String(quantity)}:${now.toISOString().slice(0, 10)}`,
        },
      });
    });
  }
}
