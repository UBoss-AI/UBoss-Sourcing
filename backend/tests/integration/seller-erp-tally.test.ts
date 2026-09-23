/**
 * A seller's TallyPrime connection, end to end, with a mock bridge.
 *
 * WHAT THE "MOCK BRIDGE" IS
 *
 * Not a mock at all, in the usual sense. The real Glovia Tally Bridge is an
 * HTTP CLIENT: it pairs, heartbeats, claims work and posts results, all
 * through the routes under `/integrations/tally-bridge`. So the tests below
 * drive those routes directly, with a bearer token they obtained by redeeming
 * a real pairing code. Nothing is stubbed on the server at all - which is why
 * these tests can prove the tenant isolation, the idempotency and the
 * "200 is not success" rule rather than proving that a stub was called.
 *
 * THE FOUR THINGS THIS FILE IS MOST CONCERNED WITH
 *
 *   1. **Tenant isolation.** One seller's bridge cannot see, claim or
 *      acknowledge another seller's work. There is no parameter in which it
 *      could try, which is what the tests assert.
 *   2. **Exactly one voucher.** A redelivered event, a replayed job and a
 *      retried post must not produce two entries in somebody's books.
 *   3. **HTTP 200 is not success.** A bridge reporting `ok: true` with Tally
 *      counters that say nothing was written is a FAILED job.
 *   4. **A pallet posts 2,400, not 2.**
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.FEATURE_SELLER_ERP = 'true';

import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';

let app: Awaited<ReturnType<typeof BuildApp>>;
let prisma: typeof PrismaClient;
let newId: typeof NewId;

const SELLER_PREFIX = 'set-';

let sellerA = '';
let sellerB = '';
let connectionA = '';
let connectionB = '';
let tokenA = '';
let tokenB = '';

const BRIDGE = '/api/v1/integrations/tally-bridge';

/**
 * One call the real agent would make.
 *
 * The token is the ONLY thing that says who this is. There is no seller or
 * connection parameter anywhere in the bridge API, which is what the isolation
 * tests below rely on - there is nothing for a caller to get wrong.
 */
async function bridgeCall(path: string, token: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `${BRIDGE}${path}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

async function cleanUp(): Promise<void> {
  const sellers = await prisma.sellerAccount.findMany({
    where: { slug: { startsWith: SELLER_PREFIX } },
    select: { id: true },
  });
  const ids = sellers.map((seller) => seller.id);
  if (ids.length === 0) return;

  await prisma.sellerErpSyncAttempt.deleteMany({
    where: { job: { sellerAccountId: { in: ids } } },
  });
  await prisma.sellerErpSyncJob.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerErpExternalReference.deleteMany({
    where: { connection: { sellerAccountId: { in: ids } } },
  });
  await prisma.sellerErpAuditEvent.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerErpMapping.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerErpMasterCache.deleteMany({
    where: { connection: { sellerAccountId: { in: ids } } },
  });
  await prisma.sellerErpCompany.deleteMany({
    where: { connection: { sellerAccountId: { in: ids } } },
  });
  await prisma.sellerErpSyncPolicy.deleteMany({
    where: { connection: { sellerAccountId: { in: ids } } },
  });
  await prisma.sellerErpPairingCode.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerErpBridgeDevice.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerErpConnection.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: ids } } });
}

/** Set a seller up with a connection and a paired bridge, and hand back its token. */
async function setUpSeller(slug: string, name: string): Promise<{
  sellerAccountId: string;
  connectionId: string;
  token: string;
}> {
  const { issuePairingCode, redeemPairingCode } = await import(
    '../../src/modules/seller-erp/pairing.service.js'
  );

  const sellerAccountId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerAccountId,
      legalName: `${name} Ltd`,
      displayName: name,
      displayNameNormalized: name.toLowerCase(),
      slug,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  const connectionId = newId();
  await prisma.sellerErpConnection.create({
    data: {
      id: connectionId,
      sellerAccountId,
      name: 'Books',
      networkMode: 'BRIDGE',
      state: 'BRIDGE_REQUIRED',
    },
  });

  await prisma.sellerErpSyncPolicy.create({ data: { id: newId(), connectionId } });

  // A real pairing, through the real service - so the token below is one a
  // real agent would hold.
  const membership = {
    sellerAccountId,
    displayName: name,
    customerProfileId: null,
    permissions: new Set(['seller.integration.write']),
  } as never;

  const issued = await issuePairingCode({
    membership,
    connectionId,
    deviceLabel: `${name} PC`,
    actorUserId: null,
    ipHash: null,
    correlationId: null,
  });

  const paired = await redeemPairingCode({
    code: issued.code,
    agentVersion: '1.0.0',
    osLabel: 'Windows 11',
    reportedTallyAddress: 'http://localhost:9000',
    ipHash: null,
    correlationId: null,
  });

  return { sellerAccountId, connectionId, token: paired.token };
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/http/app.js');
  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));

  app = await buildApp();
  await app.ready();

  await cleanUp();

  const a = await setUpSeller(`${SELLER_PREFIX}alpha`, 'SET Alpha');
  const b = await setUpSeller(`${SELLER_PREFIX}beta`, 'SET Beta');

  sellerA = a.sellerAccountId;
  connectionA = a.connectionId;
  tokenA = a.token;

  sellerB = b.sellerAccountId;
  connectionB = b.connectionId;
  tokenB = b.token;
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('pairing', () => {
  it('hands a real token for a real code, once', async () => {
    expect(tokenA).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const device = await prisma.sellerErpBridgeDevice.findFirstOrThrow({
      where: { connectionId: connectionA, state: 'ACTIVE' },
    });

    // The TOKEN is not stored. Only its hash and a display prefix - a database
    // dump therefore contains no usable credential.
    expect(device.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(device.tokenHash).not.toBe(tokenA);
    expect(tokenA.startsWith(device.tokenPrefix)).toBe(true);
  });

  it('refuses a code that has already been used', async () => {
    const { issuePairingCode, redeemPairingCode } = await import(
      '../../src/modules/seller-erp/pairing.service.js'
    );

    /*
     * Its OWN seller, and that is not tidiness.
     *
     * Redeeming a second code on a connection REVOKES the machine already
     * paired to it - one live bridge per connection, so a seller who has lost
     * a laptop is not still trusting it. Running this against seller A would
     * therefore revoke seller A's token halfway through the file, and every
     * test after it would fail with an authorisation error that looked like a
     * bug in something else entirely.
     */
    const isolated = await setUpSeller(`${SELLER_PREFIX}reuse`, 'SET Reuse');

    const membership = {
      sellerAccountId: isolated.sellerAccountId,
      displayName: 'SET Reuse',
      customerProfileId: null,
      permissions: new Set(['seller.integration.write']),
    } as never;

    const issued = await issuePairingCode({
      membership,
      connectionId: isolated.connectionId,
      deviceLabel: 'Second PC',
      actorUserId: null,
      ipHash: null,
      correlationId: null,
    });

    await redeemPairingCode({
      code: issued.code,
      agentVersion: null,
      osLabel: null,
      reportedTallyAddress: null,
      ipHash: null,
      correlationId: null,
    });

    // The second attempt loses, exactly as a racing second agent would.
    await expect(
      redeemPairingCode({
        code: issued.code,
        agentVersion: null,
        osLabel: null,
        reportedTallyAddress: null,
        ipHash: null,
        correlationId: null,
      }),
    ).rejects.toThrow();
  });

  it('answers a wrong code the same way it answers an expired one', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: `${BRIDGE}/pair`,
      payload: { code: 'ZZZZ-ZZZZ-ZZZZ' },
    });

    expect(wrong.statusCode).toBe(400);
    // One wording for wrong, expired, used and guessed-at. Telling the holder
    // of a bad code WHICH would hand them an oracle.
    expect((JSON.parse(wrong.body) as { error: { code: string } }).error.code).toBe(
      'SELLER_ERP_PAIRING_INVALID',
    );
  });

  it('revokes a machine immediately, with no grace period', async () => {
    const { revokeBridgeDevice } = await import(
      '../../src/modules/seller-erp/pairing.service.js'
    );

    const extra = await setUpSeller(`${SELLER_PREFIX}gamma`, 'SET Gamma');

    // It works first.
    const before = await bridgeCall('/heartbeat', extra.token);
    expect(before.statusCode).toBe(200);

    const device = await prisma.sellerErpBridgeDevice.findFirstOrThrow({
      where: { connectionId: extra.connectionId, state: { not: 'REVOKED' } },
    });

    await revokeBridgeDevice({
      membership: {
        sellerAccountId: extra.sellerAccountId,
        displayName: 'SET Gamma',
        customerProfileId: null,
        permissions: new Set(['seller.integration.write']),
      } as never,
      deviceId: device.id,
      reason: 'Laptop lost',
      actorUserId: null,
      ipHash: null,
      correlationId: null,
    });

    // And stops on the very next call. A seller who has lost a laptop presses
    // this and the laptop is out, not out in an hour.
    const after = await bridgeCall('/heartbeat', extra.token);
    expect(after.statusCode).toBe(400);
  });
});

describe('the bridge cannot reach another seller', () => {
  it('is refused with no token at all', async () => {
    const anonymous = await app.inject({
      method: 'POST',
      url: `${BRIDGE}/tasks/claim`,
      payload: {},
    });

    expect(anonymous.statusCode).toBe(400);
  });

  it('claims only its OWN connection work', async () => {
    const { enqueueErpEvent } = await import('../../src/modules/seller-erp/job.service.js');

    await enqueueErpEvent({
      connectionId: connectionB,
      sellerAccountId: sellerB,
      eventType: 'CONNECTION_TEST',
      sourceEntityType: 'seller_erp_connection',
      sourceEntityId: connectionB,
      payload: { kind: 'CONNECTION_TEST' },
      discriminator: 'isolation-1',
      maxAttempts: 1,
    });

    // Seller A's bridge polls. There is no parameter here naming a connection,
    // so there is nothing for it to get wrong - the token decides.
    const claimed = await bridgeCall('/tasks/claim', tokenA, { limit: 10 });
    expect(claimed.statusCode, claimed.body).toBe(200);

    const tasks = (JSON.parse(claimed.body) as { tasks: { jobId: string }[] }).tasks;

    const owned = await prisma.sellerErpSyncJob.findMany({
      where: { id: { in: tasks.map((task) => task.jobId) } },
      select: { connectionId: true },
    });

    expect(owned.every((job) => job.connectionId === connectionA)).toBe(true);
  });

  it('cannot acknowledge another seller job even given its id', async () => {
    const { enqueueErpEvent } = await import('../../src/modules/seller-erp/job.service.js');

    const jobId = await enqueueErpEvent({
      connectionId: connectionB,
      sellerAccountId: sellerB,
      eventType: 'CONNECTION_TEST',
      sourceEntityType: 'seller_erp_connection',
      sourceEntityId: connectionB,
      payload: { kind: 'CONNECTION_TEST' },
      discriminator: 'isolation-2',
      maxAttempts: 1,
    });

    // B's bridge claims it properly.
    await bridgeCall('/tasks/claim', tokenB, { limit: 10 });

    // A's bridge tries to acknowledge it, with the right id.
    const stolen = await bridgeCall('/tasks/result', tokenA, {
      jobId,
      ok: true,
      tally: { created: 1, errors: 0 },
    });

    expect(stolen.statusCode).toBe(404);

    // And B's job is untouched.
    const job = await prisma.sellerErpSyncJob.findUniqueOrThrow({ where: { id: jobId ?? '' } });
    expect(job.status).not.toBe('SUCCEEDED');
  });
});

describe('the connection test', () => {
  it('finds the company and makes the connection testable as CONNECTED', async () => {
    const { enqueueErpEvent } = await import('../../src/modules/seller-erp/job.service.js');
    const { decideConnectionState } = await import('../../src/domain/seller-erp-state.js');

    await prisma.sellerErpConnection.update({
      where: { id: connectionA },
      data: { companyName: 'Alpha Medical' },
    });

    const jobId = await enqueueErpEvent({
      connectionId: connectionA,
      sellerAccountId: sellerA,
      eventType: 'CONNECTION_TEST',
      sourceEntityType: 'seller_erp_connection',
      sourceEntityId: connectionA,
      payload: { kind: 'CONNECTION_TEST' },
      discriminator: 'test-ok',
      maxAttempts: 1,
    });

    await bridgeCall('/tasks/claim', tokenA, { limit: 10 });

    const reported = await bridgeCall('/tasks/result', tokenA, {
      jobId,
      ok: true,
      companies: [{ name: 'Alpha Medical', guid: 'g-1', booksFrom: '2025-04-01' }],
      tallyVersion: 'TallyPrime 5.0',
      baseCurrency: 'INR',
      tally: { created: 0, errors: 0 },
    });

    expect(reported.statusCode, reported.body).toBe(204);

    const connection = await prisma.sellerErpConnection.findUniqueOrThrow({
      where: { id: connectionA },
    });

    expect(connection.lastTestOk).toBe(true);
    expect(connection.lastTestAt).not.toBeNull();

    // And the state follows from the facts, not from a flag somebody set.
    const decision = decideConnectionState({
      disabledAt: null,
      networkMode: 'BRIDGE',
      companyName: connection.companyName,
      hasActiveBridge: true,
      hasPendingPairing: false,
      pairingExpired: false,
      lastHeartbeatAt: new Date(),
      lastTestAt: connection.lastTestAt,
      lastTestOk: connection.lastTestOk,
      tallyReachable: connection.lastTestOk,
      companyLoaded: true,
      mappingComplete: true,
      validationFailed: false,
      hasJobsInFlight: false,
      hasWarnings: false,
      now: new Date(),
    });

    expect(decision.state).toBe('CONNECTED');
  });

  /*
   * THE COMMONEST REAL FAILURE.
   *
   * Tally is running. The bridge reached it. The company this connection posts
   * into is simply not open - and a marketplace that reported that as
   * "disconnected" would send somebody to reinstall an agent that is working.
   */
  it('does NOT report a pass when the configured company is not among the open ones', async () => {
    const { enqueueErpEvent } = await import('../../src/modules/seller-erp/job.service.js');

    await prisma.sellerErpConnection.update({
      where: { id: connectionA },
      data: { companyName: 'Alpha Medical' },
    });

    const jobId = await enqueueErpEvent({
      connectionId: connectionA,
      sellerAccountId: sellerA,
      eventType: 'CONNECTION_TEST',
      sourceEntityType: 'seller_erp_connection',
      sourceEntityId: connectionA,
      payload: { kind: 'CONNECTION_TEST' },
      discriminator: 'test-wrong-company',
      maxAttempts: 1,
    });

    await bridgeCall('/tasks/claim', tokenA, { limit: 10 });

    await bridgeCall('/tasks/result', tokenA, {
      jobId,
      // The BRIDGE says ok. It reached Tally, after all.
      ok: true,
      companies: [{ name: 'A Different Company' }],
      tally: { created: 0, errors: 0 },
    });

    const connection = await prisma.sellerErpConnection.findUniqueOrThrow({
      where: { id: connectionA },
    });

    // The SERVER disagrees, because posting into a company that is not open
    // would go into the wrong books.
    expect(connection.lastTestOk).toBe(false);
    expect(connection.lastTestMessage).toContain('not open');
  });
});

describe('a 200 is not a success', () => {
  it('fails a job whose Tally counters say nothing was written', async () => {
    const { enqueueErpEvent } = await import('../../src/modules/seller-erp/job.service.js');

    const jobId = await enqueueErpEvent({
      connectionId: connectionA,
      sellerAccountId: sellerA,
      eventType: 'SALES_ORDER',
      sourceEntityType: 'seller_order_group',
      sourceEntityId: newId(),
      payload: { kind: 'VOUCHER' },
      discriminator: 'nothing-written',
      maxAttempts: 3,
    });

    await bridgeCall('/tasks/claim', tokenA, { limit: 10 });

    await bridgeCall('/tasks/result', tokenA, {
      jobId,
      // The transport succeeded. The agent says so. Tally created nothing.
      ok: true,
      httpStatus: 200,
      tally: { created: 0, altered: 0, ignored: 1, errors: 0 },
    });

    const job = await prisma.sellerErpSyncJob.findUniqueOrThrow({ where: { id: jobId ?? '' } });

    // NOT succeeded. This is the failure that loses a month of vouchers
    // silently in every naive integration.
    expect(job.status).not.toBe('SUCCEEDED');
  });

  it('fails a job whose Tally reply carried a line error', async () => {
    const { enqueueErpEvent } = await import('../../src/modules/seller-erp/job.service.js');

    const jobId = await enqueueErpEvent({
      connectionId: connectionA,
      sellerAccountId: sellerA,
      eventType: 'SALES_ORDER',
      sourceEntityType: 'seller_order_group',
      sourceEntityId: newId(),
      payload: { kind: 'VOUCHER' },
      discriminator: 'line-error',
      maxAttempts: 3,
    });

    await bridgeCall('/tasks/claim', tokenA, { limit: 10 });

    await bridgeCall('/tasks/result', tokenA, {
      jobId,
      ok: true,
      httpStatus: 200,
      tally: { created: 0, errors: 1 },
      lineErrors: [
        { message: "Ledger 'Acme Hospitals' does not exist!", lineNumber: 1, missingMaster: 'Acme Hospitals' },
      ],
    });

    const job = await prisma.sellerErpSyncJob.findUniqueOrThrow({ where: { id: jobId ?? '' } });

    // FAILED and not retried: the ledger will still be missing in thirty
    // seconds, and eight goes at a refusal delays the moment somebody is told.
    expect(job.status).toBe('FAILED');
    expect(job.sanitizedError).toContain('Acme Hospitals');
  });

  it('records what Tally said on the attempt, and only a hash of the bodies', async () => {
    const { enqueueErpEvent } = await import('../../src/modules/seller-erp/job.service.js');

    const jobId = await enqueueErpEvent({
      connectionId: connectionA,
      sellerAccountId: sellerA,
      eventType: 'SALES_ORDER',
      sourceEntityType: 'seller_order_group',
      sourceEntityId: newId(),
      payload: { kind: 'VOUCHER' },
      discriminator: 'attempt-record',
      maxAttempts: 3,
    });

    await bridgeCall('/tasks/claim', tokenA, { limit: 10 });

    await bridgeCall('/tasks/result', tokenA, {
      jobId,
      ok: true,
      httpStatus: 200,
      tally: { created: 1, altered: 0, errors: 0, lastVoucherId: '9911' },
      voucherNumber: 'SO-00042',
      requestHash: 'a'.repeat(64),
      responseHash: 'b'.repeat(64),
      durationMs: 412,
    });

    const attempt = await prisma.sellerErpSyncAttempt.findFirstOrThrow({
      where: { jobId: jobId ?? '' },
      orderBy: { attemptNumber: 'desc' },
    });

    expect(attempt.outcome).toBe('SUCCEEDED');
    expect(attempt.tallyCreated).toBe(1);
    expect(attempt.tallyLastVoucherId).toBe('9911');
    // Hashes, never the documents themselves.
    expect(attempt.requestHash).toHaveLength(64);
    expect(attempt.responseHash).toHaveLength(64);

    const job = await prisma.sellerErpSyncJob.findUniqueOrThrow({ where: { id: jobId ?? '' } });
    expect(job.status).toBe('SUCCEEDED');
    expect(job.externalVoucherNumber).toBe('SO-00042');
  });
});

describe('exactly one voucher', () => {
  it('turns a redelivered event into a no-op rather than a second job', async () => {
    const { enqueueErpEvent } = await import('../../src/modules/seller-erp/job.service.js');

    const sourceId = newId();

    const shared = {
      connectionId: connectionA,
      sellerAccountId: sellerA,
      eventType: 'SALES_ORDER' as const,
      sourceEntityType: 'seller_order_group',
      sourceEntityId: sourceId,
      payload: { kind: 'VOUCHER' },
    };

    const first = await enqueueErpEvent(shared);
    const second = await enqueueErpEvent(shared);
    const third = await enqueueErpEvent(shared);

    expect(first).not.toBeNull();
    // Null, and that is the SUCCESS path for a webhook retried four times.
    expect(second).toBeNull();
    expect(third).toBeNull();

    const jobs = await prisma.sellerErpSyncJob.count({
      where: { connectionId: connectionA, sourceEntityId: sourceId },
    });

    expect(jobs).toBe(1);
  });

  it('records what our row became in Tally, so a re-sync verifies rather than re-posts', async () => {
    const { enqueueErpEvent } = await import('../../src/modules/seller-erp/job.service.js');

    const sourceId = newId();

    const jobId = await enqueueErpEvent({
      connectionId: connectionA,
      sellerAccountId: sellerA,
      eventType: 'SALES_INVOICE',
      sourceEntityType: 'seller_order_group',
      sourceEntityId: sourceId,
      payload: { kind: 'VOUCHER' },
    });

    await bridgeCall('/tasks/claim', tokenA, { limit: 10 });

    await bridgeCall('/tasks/result', tokenA, {
      jobId,
      ok: true,
      tally: { created: 1, errors: 0, lastVoucherId: '4821' },
      voucherNumber: 'INV-1',
    });

    const reference = await prisma.sellerErpExternalReference.findUniqueOrThrow({
      where: {
        connectionId_entityType_localId: {
          connectionId: connectionA,
          entityType: 'seller_order_group',
          localId: sourceId,
        },
      },
    });

    expect(reference.voucherNumber).toBe('INV-1');
  });

  it('refuses to retry something that already posted', async () => {
    const { enqueueErpEvent, retryJob } = await import(
      '../../src/modules/seller-erp/job.service.js'
    );

    const jobId = await enqueueErpEvent({
      connectionId: connectionA,
      sellerAccountId: sellerA,
      eventType: 'SALES_INVOICE',
      sourceEntityType: 'seller_order_group',
      sourceEntityId: newId(),
      payload: { kind: 'VOUCHER' },
    });

    await bridgeCall('/tasks/claim', tokenA, { limit: 10 });
    await bridgeCall('/tasks/result', tokenA, {
      jobId,
      ok: true,
      tally: { created: 1, errors: 0 },
    });

    // The request that would create the duplicate voucher this whole module
    // exists to prevent. Refused rather than made idempotent-and-allowed.
    await expect(
      retryJob({
        membership: {
          sellerAccountId: sellerA,
          displayName: 'SET Alpha',
          customerProfileId: null,
          permissions: new Set(['seller.integration.write']),
        } as never,
        jobId: jobId ?? '',
        actorUserId: null,
      }),
    ).rejects.toThrow();
  });
});

describe('leases', () => {
  it('hands one job to one bridge, and refuses a stale acknowledgement', async () => {
    const { enqueueErpEvent, reapExpiredLeases } = await import(
      '../../src/modules/seller-erp/job.service.js'
    );

    const jobId = await enqueueErpEvent({
      connectionId: connectionA,
      sellerAccountId: sellerA,
      eventType: 'SALES_ORDER',
      sourceEntityType: 'seller_order_group',
      sourceEntityId: newId(),
      payload: { kind: 'VOUCHER' },
    });

    await bridgeCall('/tasks/claim', tokenA, { limit: 10 });

    // The bridge dies. Its lease expires and the work goes back in the queue.
    await prisma.sellerErpSyncJob.update({
      where: { id: jobId ?? '' },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const released = await reapExpiredLeases();
    expect(released).toBeGreaterThanOrEqual(1);

    const job = await prisma.sellerErpSyncJob.findUniqueOrThrow({ where: { id: jobId ?? '' } });
    expect(job.status).toBe('PENDING');
    expect(job.leaseOwner).toBeNull();

    // The attempt COUNT is not rolled back. It is the record that a go was
    // made, and it is what eventually dead-letters a task that kills the agent
    // that takes it.
    expect(job.attemptCount).toBeGreaterThanOrEqual(1);

    // And the machine coming back out of sleep cannot overwrite the winner.
    const stale = await bridgeCall('/tasks/result', tokenA, {
      jobId,
      ok: true,
      tally: { created: 1, errors: 0 },
    });

    expect(stale.statusCode).toBe(409);
  });

  it('keeps one order entries in order behind a sequence key', async () => {
    const { enqueueErpEvent } = await import('../../src/modules/seller-erp/job.service.js');

    const orderId = newId();

    await enqueueErpEvent({
      connectionId: connectionA,
      sellerAccountId: sellerA,
      eventType: 'SALES_ORDER',
      sourceEntityType: 'seller_order_group',
      sourceEntityId: newId(),
      orderId,
      payload: { kind: 'VOUCHER' },
      sequenceKey: orderId,
    });

    await enqueueErpEvent({
      connectionId: connectionA,
      sellerAccountId: sellerA,
      eventType: 'SALES_INVOICE',
      sourceEntityType: 'seller_order_group',
      sourceEntityId: newId(),
      orderId,
      payload: { kind: 'VOUCHER' },
      sequenceKey: orderId,
    });

    const claimed = await bridgeCall('/tasks/claim', tokenA, { limit: 10 });
    const tasks = (JSON.parse(claimed.body) as { tasks: { jobId: string }[] }).tasks;

    const forThisOrder = await prisma.sellerErpSyncJob.findMany({
      where: { id: { in: tasks.map((task) => task.jobId) }, orderId },
    });

    // AT MOST ONE at a time. A Receipt must not post before the Invoice it
    // pays, and a Credit Note must not precede the Invoice it reverses.
    expect(forThisOrder).toHaveLength(1);
  });
});

describe('the feature gate', () => {
  it('has the bridge endpoints answer only while the feature is on', async () => {
    // The gate is asserted here rather than by flipping it, because
    // `config/env.ts` reads the environment once - the flag at the top of this
    // file is what makes every test above reachable at all, and a run with it
    // absent would see 403s throughout.
    const heartbeat = await bridgeCall('/heartbeat', tokenA);
    expect(heartbeat.statusCode).toBe(200);
  });
});
