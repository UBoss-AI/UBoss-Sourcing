/**
 * A seller's connection to their own accounting system: creating it, reading
 * its true state, testing it, and switching it off.
 *
 * THE ONE RULE THIS FILE SERVES
 *
 * "Connected" is never stored as a flag somebody sets. It is a conclusion,
 * reached by `decideConnectionState` in `domain/seller-erp-state.ts`, from
 * four facts that each carry a timestamp: a fresh bridge heartbeat, a test
 * that passed recently, the configured company present among the open ones,
 * and every required mapping confirmed. Take away any one and the answer is a
 * different word with a different instruction beside it.
 *
 * Nothing here has a branch that produces CONNECTED because nothing has gone
 * wrong lately. A connection nobody has tested reads TALLY_UNAVAILABLE, which
 * is the honest thing to say: we do not currently know that Tally is there.
 *
 * WHAT A TEST ACTUALLY IS
 *
 * A round trip to the seller's machine, and it cannot be done inline: the
 * bridge PULLS work, so a test is a task queued for it and answered when it
 * next polls - normally within a second or two. `startConnectionTest` queues
 * it; `applyTestResult` is what the bridge's answer lands in. A "test" that
 * returned instantly without leaving this server would be testing nothing.
 */
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  HEARTBEAT_FRESH_SECONDS,
  canDispatch,
  decideConnectionState,
  needsSellerAction,
  type SellerErpState,
} from '../../domain/seller-erp-state.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { assertSafeErpUrl } from '../../infra/outbound-http.js';
import { prisma } from '../../infra/prisma.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from '../seller/account.service.js';
import { recordErpAudit } from './audit.service.js';
import { enqueueErpEvent } from './job.service.js';
import { missingMappings, refreshMappingCompleteness } from './mapping.service.js';

/**
 * The whole truth about one connection, for the status screen.
 *
 * Every field that could be mistaken for a claim carries its own timestamp,
 * and the screen shows them. A status with no time beside it is a status
 * nobody can check.
 */
export interface ErpConnectionView {
  id: string;
  name: string;
  provider: string;
  state: SellerErpState;
  stateReason: string | null;
  stateChangedAt: string;
  networkMode: string;
  /** Present only in DIRECT_PRIVATE mode, and never a credential. */
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

  /** Live counts, so the screen never has to guess. */
  pendingJobs: number;
  failedJobs: number;
  inFlightJobs: number;
  /** How many mappings a sync would still need. */
  missingMappingCount: number;

  /** Whether a bridge is paired at all, and whether it is beating. */
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

/** Every connection this seller has. */
export async function listConnections(
  membership: SellerMembership,
): Promise<ErpConnectionView[]> {
  assertSellerPermission(membership, SellerPermission.INTEGRATION_READ);

  const connections = await prisma.sellerErpConnection.findMany({
    where: { sellerAccountId: membership.sellerAccountId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  const views: ErpConnectionView[] = [];
  for (const connection of connections) {
    views.push(await readConnectionView(connection.id));
  }

  return views;
}

/** One connection, with its state decided fresh. */
export async function readConnection(
  membership: SellerMembership,
  connectionId: string,
): Promise<ErpConnectionView> {
  assertSellerPermission(membership, SellerPermission.INTEGRATION_READ);

  const owner = await prisma.sellerErpConnection.findUnique({
    where: { id: connectionId },
    select: { sellerAccountId: true },
  });

  assertSellerOwnership(membership, owner?.sellerAccountId ?? null, 'ERP connection');

  return readConnectionView(connectionId);
}

/**
 * Build the view, and RE-DECIDE the state while doing it.
 *
 * The stored `state` column is a cache for indexes and for the dispatcher; the
 * screen gets the answer worked out from the facts as they are at this
 * instant. That matters because the single most common transition -
 * CONNECTED to BRIDGE_OFFLINE - happens by a heartbeat NOT arriving, and
 * nothing writes a row when something does not happen. A screen reading the
 * stored column would show "Connected" over a machine somebody switched off an
 * hour ago.
 */
async function readConnectionView(connectionId: string): Promise<ErpConnectionView> {
  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: connectionId },
    include: {
      bridgeDevices: {
        where: { state: { in: ['ACTIVE', 'OFFLINE'] } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      pairingCodes: {
        where: { consumedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      syncPolicy: true,
    },
  });

  if (connection === null) throw notFound('ERP connection');

  const now = new Date();
  const device = connection.bridgeDevices[0] ?? null;
  const pending = connection.pairingCodes[0] ?? null;

  const [counts, missing] = await Promise.all([
    prisma.sellerErpSyncJob.groupBy({
      by: ['status'],
      where: { connectionId },
      _count: { _all: true },
    }),
    missingMappings(connectionId),
  ]);

  const countBy = (status: string): number =>
    counts.find((row) => row.status === status)?._count._all ?? 0;

  const bridgeOnline =
    device !== null &&
    device.state === 'ACTIVE' &&
    device.lastHeartbeatAt !== null &&
    now.getTime() - device.lastHeartbeatAt.getTime() <= HEARTBEAT_FRESH_SECONDS * 1000;

  const decision = decideConnectionState({
    disabledAt: connection.disabledAt,
    networkMode: connection.networkMode,
    companyName: connection.companyName,
    hasActiveBridge: device !== null && device.state !== 'REVOKED',
    hasPendingPairing: pending !== null && pending.expiresAt > now,
    // A code that lapsed unused, or a device that was revoked and not
    // replaced. Either way the seller pairs again.
    pairingExpired:
      (pending !== null && pending.expiresAt <= now) ||
      (device === null && connection.state === 'PAIRING_EXPIRED'),
    lastHeartbeatAt: device?.lastHeartbeatAt ?? null,
    lastTestAt: connection.lastTestAt,
    lastTestOk: connection.lastTestOk,
    // The last test having passed at all IS the evidence Tally answered; a
    // test that could not reach Tally sets `lastTestOk` false.
    tallyReachable: connection.lastTestOk,
    // A company is "loaded" when the last test found it. `applyTestResult`
    // is the only thing that writes `companyGuid` and the selected flag.
    companyLoaded: connection.lastTestOk && connection.companyName !== null,
    mappingComplete: connection.mappingCompleteAt !== null,
    validationFailed: connection.state === 'VALIDATION_FAILED',
    hasJobsInFlight: countBy('IN_FLIGHT') > 0,
    hasWarnings: countBy('FAILED') > 0 || countBy('DEAD_LETTER') > 0,
    now,
  });

  /*
   * The recomputed state is written back, but only when it has MOVED.
   *
   * Written back so the dispatcher's indexed query on `state` is accurate
   * without it having to run this whole function per connection. Only on a
   * change so a status screen being refreshed does not rewrite
   * `stateChangedAt` and make every connection look as if it changed a second
   * ago - which would destroy the one column that says how long a problem has
   * been going on.
   */
  if (decision.state !== connection.state) {
    await prisma.sellerErpConnection.update({
      where: { id: connectionId },
      data: {
        state: decision.state,
        stateReason: decision.reason,
        stateChangedAt: now,
      },
    });
  }

  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    state: decision.state,
    stateReason: decision.reason,
    stateChangedAt:
      decision.state === connection.state
        ? connection.stateChangedAt.toISOString()
        : now.toISOString(),
    networkMode: connection.networkMode,
    directBaseUrl: connection.directBaseUrl,

    companyName: connection.companyName,
    companyGuid: connection.companyGuid,
    companyBooksFrom: connection.companyBooksFrom?.toISOString().slice(0, 10) ?? null,
    tallyVersion: connection.tallyVersion,
    tallyBaseCurrency: connection.tallyBaseCurrency,

    lastTestAt: connection.lastTestAt?.toISOString() ?? null,
    lastTestOk: connection.lastTestOk,
    lastTestMessage: connection.lastTestMessage,
    lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt?.toISOString() ?? null,
    lastHeartbeatAt: device?.lastHeartbeatAt?.toISOString() ?? null,
    mappingCompleteAt: connection.mappingCompleteAt?.toISOString() ?? null,
    initialSyncCompletedAt: connection.initialSyncCompletedAt?.toISOString() ?? null,

    inventoryAuthority: connection.inventoryAuthority,
    autoCreateMasters: connection.autoCreateMasters,

    pendingJobs: countBy('PENDING') + countBy('RETRY_SCHEDULED') + countBy('BLOCKED'),
    failedJobs: countBy('FAILED') + countBy('DEAD_LETTER'),
    inFlightJobs: countBy('IN_FLIGHT'),
    missingMappingCount: missing.length,

    hasBridge: device !== null,
    bridgeOnline,
    bridgeLabel: device?.label ?? null,

    needsAction: needsSellerAction(decision.state),
    canSync: canDispatch(decision.state),

    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

export interface CreateConnectionInput {
  name: string;
  networkMode?: 'BRIDGE' | 'DIRECT_PRIVATE';
  /** Only for DIRECT_PRIVATE, and only where the operator allowed it. */
  directBaseUrl?: string | null;
}

/**
 * Create a connection.
 *
 * It starts with NOTHING switched on: no company, no policy, no masters
 * created, nothing posting. That is the point. A seller pressing "connect"
 * has expressed an intention to set something up, not a consent to have
 * vouchers appear in their accounts, and every step from here is an explicit
 * one.
 */
export async function createConnection(input: {
  membership: SellerMembership;
  body: CreateConnectionInput;
  actorUserId: string | null;
  ipHash: string | null;
  correlationId: string | null;
}): Promise<ErpConnectionView> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_WRITE);

  const name = input.body.name.trim().slice(0, 128);

  if (name.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give this connection a name you will recognise.', [
      { field: 'name', code: 'REQUIRED' },
    ]);
  }

  const existing = await prisma.sellerErpConnection.count({
    where: { sellerAccountId: input.membership.sellerAccountId },
  });

  if (existing >= env.SELLER_ERP_MAX_CONNECTIONS) {
    throw conflict(
      ErrorCode.CONFLICT,
      `This account already has ${String(env.SELLER_ERP_MAX_CONNECTIONS)} Tally connections. Remove one before adding another.`,
    );
  }

  const networkMode = input.body.networkMode ?? 'BRIDGE';
  const directBaseUrl =
    networkMode === 'DIRECT_PRIVATE' ? assertDirectUrlAllowed(input.body.directBaseUrl ?? '') : null;

  const id = newId();

  await prisma.$transaction(async (tx) => {
    await tx.sellerErpConnection.create({
      data: {
        id,
        sellerAccountId: input.membership.sellerAccountId,
        name,
        networkMode,
        directBaseUrl,
        state: networkMode === 'BRIDGE' ? 'BRIDGE_REQUIRED' : 'NOT_CONFIGURED',
        stateReason:
          networkMode === 'BRIDGE'
            ? 'Install the Glovia Tally Bridge on the machine that runs TallyPrime, then pair it.'
            : 'Choose which Tally company to use.',
        createdByProfileId: input.membership.customerProfileId,
      },
    });

    /*
     * The policy row, with everything off except posting a Sales Order.
     *
     * A Sales Order creates no revenue entry - it is a record that an order
     * exists - so it is the one thing that can default on without changing
     * anybody's books. The invoice, the receipt and the credit note all move
     * money in the accounts and every one of them stays off until a person
     * switches it on.
     */
    await tx.sellerErpSyncPolicy.create({
      data: { id: newId(), connectionId: id },
    });
  });

  await recordErpAudit({
    sellerAccountId: input.membership.sellerAccountId,
    connectionId: id,
    action: 'seller_erp.connection_created',
    actor: { type: 'CUSTOMER', userId: input.actorUserId, label: input.membership.displayName },
    summary: `A TallyPrime connection called "${name}" was created.`,
    meta: { connectionId: id, networkMode },
    ipHash: input.ipHash,
    correlationId: input.correlationId,
  });

  return readConnectionView(id);
}

/**
 * Check a direct-mode address, or refuse it.
 *
 * Three locks, and all three have to pass:
 *
 *   1. The operator has to have turned direct mode on at all. It is off by
 *      default and the startup check refuses to let it on without an
 *      allowlist.
 *   2. The address has to pass `assertSafeErpUrl` - the same SSRF guard every
 *      other outbound call in this system goes through, which re-resolves at
 *      request time because DNS moves.
 *   3. The host has to be on the operator's allowlist.
 *
 * TallyPrime's HTTP listener has NO AUTHENTICATION. Anyone who can reach the
 * port can read the whole ledger and post vouchers into it. So there is no
 * safe public address here and this mode means, and only means, "a host inside
 * the network the operator controls".
 */
function assertDirectUrlAllowed(raw: string): string {
  if (!env.SELLER_ERP_ALLOW_DIRECT_MODE) {
    throw badRequest(
      ErrorCode.SELLER_ERP_DIRECT_MODE_REFUSED,
      'This marketplace does not allow a direct connection to TallyPrime. Use the Glovia Tally Bridge.',
      [{ field: 'networkMode', code: 'DIRECT_MODE_DISABLED' }],
    );
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the address TallyPrime answers on.', [
      { field: 'directBaseUrl', code: 'REQUIRED' },
    ]);
  }

  /*
   * The SSRF guard, with private targets EXPLICITLY allowed.
   *
   * That flag looks alarming and is the point of the mode: the whole premise
   * is an address on the operator's own private network. What makes it safe is
   * the allowlist below, which is required by the startup check and is what
   * turns "any private address" into "these hosts". Without the allowlist this
   * would be an SSRF proxy, which is why the two can never be configured apart.
   */
  const url = assertSafeErpUrl(trimmed, { allowPrivate: true });

  const host = url.hostname.toLowerCase();

  const allowed = env.SELLER_ERP_DIRECT_HOST_SUFFIXES.some((suffix) =>
    suffix.startsWith('.') ? host.endsWith(suffix) || host === suffix.slice(1) : host === suffix,
  );

  if (!allowed) {
    throw badRequest(
      ErrorCode.SELLER_ERP_DIRECT_MODE_REFUSED,
      'That address is not one this marketplace allows a direct connection to.',
      [{ field: 'directBaseUrl', code: 'HOST_NOT_ALLOWED' }],
    );
  }

  return url.toString();
}

/**
 * Queue a connection test.
 *
 * Returns the job id, not a result: the bridge pulls work, so the answer
 * arrives when it next polls. The screen shows "testing" and updates when
 * `applyTestResult` lands. A function that returned a verdict here would be
 * returning one it had not obtained.
 */
export async function startConnectionTest(input: {
  membership: SellerMembership;
  connectionId: string;
  actorUserId: string | null;
}): Promise<{ jobId: string | null; state: SellerErpState }> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_WRITE);

  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: input.connectionId },
    select: { id: true, sellerAccountId: true, companyName: true, disabledAt: true },
  });

  assertSellerOwnership(input.membership, connection?.sellerAccountId ?? null, 'ERP connection');
  if (connection === null) throw notFound('ERP connection');

  if (connection.disabledAt !== null) {
    throw conflict(
      ErrorCode.SELLER_ERP_NOT_CONFIGURED,
      'This connection is switched off. Switch it on before testing it.',
    );
  }

  const jobId = await enqueueErpEvent({
    connectionId: connection.id,
    sellerAccountId: connection.sellerAccountId,
    eventType: 'CONNECTION_TEST',
    sourceEntityType: 'seller_erp_connection',
    sourceEntityId: connection.id,
    payload: { kind: 'CONNECTION_TEST', companyName: connection.companyName },
    trigger: 'MANUAL',
    /*
     * A moving discriminator, and the ONE place in this module where that is
     * correct.
     *
     * Every other event is deduplicated on purpose - the same order must not
     * post twice. A test is the opposite: a seller pressing "test" after
     * opening the right company in Tally is asking a NEW question, and
     * deduplicating it would answer them with the old result for ever.
     */
    discriminator: String(Date.now()),
    maxAttempts: 1,
  });

  const view = await readConnectionView(connection.id);
  return { jobId, state: view.state };
}

export interface TestResult {
  connectionId: string;
  ok: boolean;
  /** The companies the bridge found OPEN in Tally. */
  companies: { name: string; guid: string | null; booksFrom: Date | null }[];
  tallyVersion: string | null;
  baseCurrency: string | null;
  /** Safe to show. Never a body, never a path from the seller's machine. */
  message: string | null;
}

/**
 * Record what a test found.
 *
 * Called from the bridge's result endpoint. It writes the facts and NOTHING
 * ELSE - it does not decide the state. `readConnectionView` decides, from
 * these facts plus the heartbeat plus the mappings, every time anybody asks.
 * Two places deciding would eventually disagree, and the one that wrote
 * "Connected" would be the one on screen.
 */
export async function applyTestResult(result: TestResult): Promise<void> {
  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: result.connectionId },
    select: { id: true, sellerAccountId: true, companyName: true },
  });

  if (connection === null) return;

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    for (const company of result.companies.slice(0, 50)) {
      await tx.sellerErpCompany.upsert({
        where: {
          connectionId_tallyName: { connectionId: connection.id, tallyName: company.name },
        },
        create: {
          id: newId(),
          connectionId: connection.id,
          tallyName: company.name,
          tallyGuid: company.guid,
          booksFrom: company.booksFrom,
          isSelected: company.name === connection.companyName,
          lastSeenAt: now,
        },
        update: {
          tallyGuid: company.guid,
          booksFrom: company.booksFrom,
          isSelected: company.name === connection.companyName,
          lastSeenAt: now,
        },
      });
    }

    const selected =
      connection.companyName === null
        ? null
        : (result.companies.find((company) => company.name === connection.companyName) ?? null);

    /*
     * `lastTestOk` means "Tally answered AND the company we post into is
     * open". Not merely "the request completed".
     *
     * A test that reached Tally and found the wrong company open is not a
     * passing test - posting against it would go into the wrong books - and
     * recording it as one is how `COMPANY_NOT_LOADED` would never be reached.
     */
    const companyIsOpen = connection.companyName === null || selected !== null;

    await tx.sellerErpConnection.update({
      where: { id: connection.id },
      data: {
        lastTestAt: now,
        lastTestOk: result.ok && companyIsOpen,
        lastTestMessage:
          result.message?.slice(0, 512) ??
          (result.ok && !companyIsOpen
            ? `TallyPrime is running and "${connection.companyName ?? ''}" is not open in it.`
            : null),
        tallyVersion: result.tallyVersion?.slice(0, 64) ?? undefined,
        tallyBaseCurrency: result.baseCurrency?.slice(0, 16) ?? undefined,
        companyGuid: selected?.guid ?? undefined,
        companyBooksFrom: selected?.booksFrom ?? undefined,
        // A passing test clears the circuit. It is the evidence the outage is
        // over, and it is the only thing that closes it - a timer would reopen
        // the floodgates against a machine that is still off.
        ...(result.ok && companyIsOpen
          ? { consecutiveFailures: 0, circuitState: 'CLOSED' as const, circuitOpenedAt: null }
          : {}),
      },
    });
  });
}

/**
 * Choose which Tally company this connection posts into.
 *
 * Only from the companies a test actually found. A free-text company name is
 * refused, and that refusal is the guard against the worst failure this
 * feature has: a typo in a company name posts a quarter of sales into a
 * company that does not exist, Tally creates nothing, and every job
 * dead-letters - or worse, matches a different company on the same machine.
 */
export async function selectCompany(input: {
  membership: SellerMembership;
  connectionId: string;
  companyName: string;
  actorUserId: string | null;
  correlationId: string | null;
}): Promise<ErpConnectionView> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_WRITE);

  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: input.connectionId },
    select: { id: true, sellerAccountId: true, companyName: true },
  });

  assertSellerOwnership(input.membership, connection?.sellerAccountId ?? null, 'ERP connection');
  if (connection === null) throw notFound('ERP connection');

  const company = await prisma.sellerErpCompany.findUnique({
    where: {
      connectionId_tallyName: { connectionId: connection.id, tallyName: input.companyName },
    },
  });

  if (company === null) {
    throw badRequest(
      ErrorCode.SELLER_ERP_COMPANY_NOT_LOADED,
      'That company was not among the ones TallyPrime reported. Open it in Tally and test the connection again.',
      [{ field: 'companyName', code: 'NOT_FOUND' }],
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.sellerErpCompany.updateMany({
      where: { connectionId: connection.id },
      data: { isSelected: false },
    });

    await tx.sellerErpCompany.update({
      where: { id: company.id },
      data: { isSelected: true },
    });

    await tx.sellerErpConnection.update({
      where: { id: connection.id },
      data: {
        companyName: company.tallyName,
        companyGuid: company.tallyGuid,
        companyBooksFrom: company.booksFrom,
        /*
         * Changing the company invalidates the last test.
         *
         * The test proved the OLD company was open. It says nothing about the
         * new one, and carrying `lastTestOk` across would show "Connected"
         * over a company nobody has checked is loaded.
         */
        lastTestOk: false,
        lastTestMessage: 'The company was changed. Test the connection again.',
      },
    });
  });

  await recordErpAudit({
    sellerAccountId: connection.sellerAccountId,
    connectionId: connection.id,
    action: 'seller_erp.company_selected',
    actor: { type: 'CUSTOMER', userId: input.actorUserId, label: input.membership.displayName },
    summary:
      connection.companyName === null
        ? `Sales will post into the Tally company "${company.tallyName}".`
        : `The Tally company was changed from "${connection.companyName}" to "${company.tallyName}".`,
    meta: { companyName: company.tallyName, companyGuid: company.tallyGuid },
    correlationId: input.correlationId,
  });

  return readConnectionView(connection.id);
}

/** The companies the last test found open, for the picker. */
export async function listCompanies(
  membership: SellerMembership,
  connectionId: string,
): Promise<
  { name: string; guid: string | null; booksFrom: string | null; isSelected: boolean; lastSeenAt: string }[]
> {
  assertSellerPermission(membership, SellerPermission.INTEGRATION_READ);

  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: connectionId },
    select: { sellerAccountId: true },
  });
  assertSellerOwnership(membership, connection?.sellerAccountId ?? null, 'ERP connection');

  const companies = await prisma.sellerErpCompany.findMany({
    where: { connectionId },
    orderBy: { tallyName: 'asc' },
  });

  return companies.map((company) => ({
    name: company.tallyName,
    guid: company.tallyGuid,
    booksFrom: company.booksFrom?.toISOString().slice(0, 10) ?? null,
    isSelected: company.isSelected,
    lastSeenAt: company.lastSeenAt.toISOString(),
  }));
}

/**
 * Switch a connection off, or back on.
 *
 * Off stops everything: nothing is queued, the bridge's own token stops
 * authenticating, and no job is handed out. Configuration and history are
 * untouched, so switching back on needs nothing retyped.
 *
 * Queued work is NOT discarded. A seller pausing for a week comes back to the
 * week's orders waiting, which is what pausing should mean. Somebody who wants
 * them gone cancels them individually and can see exactly what they cancelled.
 */
export async function setConnectionEnabled(input: {
  membership: SellerMembership;
  connectionId: string;
  enabled: boolean;
  actorUserId: string | null;
  correlationId: string | null;
}): Promise<ErpConnectionView> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_WRITE);

  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: input.connectionId },
    select: { id: true, sellerAccountId: true, name: true, disabledAt: true },
  });

  assertSellerOwnership(input.membership, connection?.sellerAccountId ?? null, 'ERP connection');
  if (connection === null) throw notFound('ERP connection');

  await prisma.sellerErpConnection.update({
    where: { id: connection.id },
    data: {
      disabledAt: input.enabled ? null : new Date(),
      state: input.enabled ? 'BRIDGE_REQUIRED' : 'DISABLED',
      stateChangedAt: new Date(),
      stateReason: input.enabled
        ? 'Switched back on. Test the connection to confirm Tally is answering.'
        : 'Switched off by the seller.',
      // A connection coming back on has not been tested since it went off, and
      // saying otherwise would show "Connected" over an untested machine.
      ...(input.enabled ? { lastTestOk: false } : {}),
    },
  });

  await recordErpAudit({
    sellerAccountId: connection.sellerAccountId,
    connectionId: connection.id,
    action: input.enabled ? 'seller_erp.enabled' : 'seller_erp.disabled',
    actor: { type: 'CUSTOMER', userId: input.actorUserId, label: input.membership.displayName },
    summary: `"${connection.name}" was switched ${input.enabled ? 'on' : 'off'}.`,
    meta: { connectionId: connection.id },
    correlationId: input.correlationId,
  });

  return readConnectionView(connection.id);
}

/**
 * Re-decide the state and store it, without building the whole view.
 *
 * For the worker's maintenance pass, which has to move a connection to
 * BRIDGE_OFFLINE when a heartbeat stops arriving - something no request can
 * do, because nothing writes a row when something does not happen.
 */
export async function refreshConnectionState(connectionId: string): Promise<SellerErpState> {
  const view = await readConnectionView(connectionId);
  await refreshMappingCompleteness(connectionId);
  return view.state;
}
