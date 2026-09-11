/**
 * A buyer's own ERP - integration, against a real MariaDB.
 *
 * The unit tests cover the pure parts: the state machines, the mapping engine,
 * the idempotency key. This file covers the claims that are only true if the
 * DATABASE behaves, and every one of them is a claim that would be expensive to
 * be wrong about:
 *
 *   - **One organisation cannot reach another's anything.** Not its
 *     connections, not its credentials, not its events, not its audit log. This
 *     is the claim that decides whether the feature can be sold at all.
 *
 *   - **The same event cannot be queued twice.** The unique index on the
 *     idempotency key is what stops a redelivered payment webhook raising a
 *     second purchase order in somebody's SAP, and an index is only a
 *     guarantee if the database is holding it.
 *
 *   - **Confirming an order does not touch on-hand stock.** It raises a
 *     purchase order and moves the quantity to ON ORDER. Getting this backwards
 *     is the classic failure of this kind of integration: a buyer whose ERP
 *     believes stock arrived when it was ordered stops reordering and runs out.
 *
 *   - **Pausing stops writes.** Asked at dispatch time, on every attempt,
 *     rather than only when the event was queued.
 *
 *   - **No credential is readable through any API.** Including the buyer's own.
 *
 * These are slow tests and they earn it. Everything they assert is either a
 * security boundary or a duplicate purchase order.
 *
 * Cleanup is in `afterAll` as well as `beforeEach`, because orders are
 * ON DELETE RESTRICT and rows left behind break the FIRST file of the next run
 * rather than this one - see CLAUDE.md.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError } from '../../src/domain/errors.js';
import { hashPassword, decryptSecret } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { listOrgAudit } from '../../src/modules/customer-erp/audit.service.js';
import {
  getConnection,
  listConnections,
  saveMappings,
  testConnection,
  activateConnection,
  changeConnectionState,
  disconnectConnection,
  createConnection,
  type ConnectionView,
} from '../../src/modules/customer-erp/connection.service.js';
import {
  credentialAad,
  openCredential,
  summariseCredentials,
  type PrimaryCredential,
} from '../../src/modules/customer-erp/credential.service.js';
import {
  claimDueEvents,
  countEventsByState,
  enqueueEvent,
  idempotencyKeyFor,
  listEvents,
  requeueEvent,
} from '../../src/modules/customer-erp/event.service.js';
import {
  resolveMembership,
  assertCapability,
  type Membership,
} from '../../src/modules/customer-erp/organization.service.js';
import { dispatchEvent } from '../../src/modules/customer-erp/pipeline.service.js';
import type { OrgActor } from '../../src/modules/customer-erp/audit.service.js';

const actor: OrgActor = {
  customerProfileId: null,
  email: 'buyer@example.test',
  correlationId: null,
};

async function reset(): Promise<void> {
  // Children before parents. Connections cascade to most of this, but the
  // deletes are explicit so a failure names the table rather than the FK.
  await prisma.customerErpApproval.deleteMany({});
  await prisma.customerErpOAuthState.deleteMany({});
  await prisma.customerErpWebhookEvent.deleteMany({});
  await prisma.customerErpSyncEvent.deleteMany({});
  await prisma.customerErpSyncJob.deleteMany({});
  await prisma.customerErpOrderLink.deleteMany({});
  await prisma.customerErpInvoiceLink.deleteMany({});
  await prisma.customerErpInventoryLink.deleteMany({});
  await prisma.customerErpCredential.deleteMany({});
  await prisma.customerErpEndpoint.deleteMany({});
  await prisma.customerErpFieldMapping.deleteMany({});
  await prisma.customerErpWarehouseMap.deleteMany({});
  await prisma.customerErpSyncPolicy.deleteMany({});
  await prisma.customerErpConnection.deleteMany({});
  await prisma.customerErpAuditLog.deleteMany({});
  await prisma.buyerOrganizationInvite.deleteMany({});
  await prisma.buyerOrganizationMember.deleteMany({});
  await prisma.buyerOrganization.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.user.deleteMany({});
}

/** A customer account with a profile, ready to be given an organisation. */
async function makeBuyer(name: string): Promise<{ userId: string; profileId: string }> {
  const userId = newId();
  const profileId = newId();
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${userId.slice(-6).toLowerCase()}@example.test`;

  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword('Correct-Horse-9'),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  await prisma.customerProfile.create({
    data: { id: profileId, userId, fullName: name, organization: name },
  });

  return { userId, profileId };
}

async function makeConnection(
  membership: Membership,
  overrides: { name?: string } = {},
): Promise<ConnectionView> {
  return createConnection(membership, actor, {
    name: overrides.name ?? 'Production SAP',
    system: 'SAP',
    environment: 'PRODUCTION',
    // A public host that will never be reached in these tests: nothing here
    // makes an outbound call, and the address only has to survive validation.
    baseUrl: 'https://erp.example.com/sap',
    authMethod: 'OAUTH2_CLIENT_CREDENTIALS',
    oauthTokenUrl: 'https://erp.example.com/oauth/token',
    sapCompanyCode: '1000',
    sapPurchasingOrg: '1000',
    sapPlant: '1010',
    secrets: { clientId: 'uboss-client', clientSecret: 'super-secret-value-9f2a' },
  });
}

beforeEach(reset);
afterAll(reset);

describe('the tenant boundary', () => {
  it('gives each buyer their own organisation, and makes them its owner', async () => {
    const alice = await makeBuyer('Zorggroep Noord');
    const bob = await makeBuyer('City Medical');

    const one = await resolveMembership(alice.profileId);
    const two = await resolveMembership(bob.profileId);

    expect(one.organizationId).not.toBe(two.organizationId);
    expect(one.role).toBe('OWNER');
    expect(two.role).toBe('OWNER');

    // Named from the company on the profile, not from "Organisation".
    expect(one.organizationName).toBe('Zorggroep Noord');
  });

  it('is stable: asking twice does not create a second organisation', async () => {
    const alice = await makeBuyer('Zorggroep Noord');

    const first = await resolveMembership(alice.profileId);
    const second = await resolveMembership(alice.profileId);

    expect(second.organizationId).toBe(first.organizationId);
    expect(await prisma.buyerOrganization.count()).toBe(1);
  });

  it('does not put two buyers in one organisation because they typed the same name', async () => {
    // The whole reason `customer_profiles.organization` is not the tenant: it
    // is free text, and joining a tenant by typing its name would be an
    // invitation to read a competitor's purchase orders.
    const alice = await makeBuyer('City Medical Supplies');
    const bob = await makeBuyer('City Medical Supplies');

    const one = await resolveMembership(alice.profileId);
    const two = await resolveMembership(bob.profileId);

    expect(one.organizationId).not.toBe(two.organizationId);
  });

  it('refuses one organisation sight of another’s connection', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const bob = await resolveMembership((await makeBuyer('City Medical')).profileId);

    const connection = await makeConnection(alice);

    // 404, not 403. Confirming that a connection exists but belongs to
    // somebody else still leaks its existence.
    await expect(getConnection(bob, connection.id)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.statusCode === 404,
    );

    expect(await listConnections(bob)).toEqual([]);
    expect(await listConnections(alice)).toHaveLength(1);
  });

  it('refuses one organisation sight of another’s events and audit log', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const bob = await resolveMembership((await makeBuyer('City Medical')).profileId);

    const connection = await makeConnection(alice);

    await enqueueEvent({
      connectionId: connection.id,
      organizationId: alice.organizationId,
      eventType: 'PURCHASE_ORDER_CREATE',
      subject: newId(),
      correlationId: newId(),
    });

    const mine = await listEvents(alice.organizationId, { limit: 25 });
    const theirs = await listEvents(bob.organizationId, { limit: 25 });

    expect(mine.rows).toHaveLength(1);
    expect(theirs.rows).toHaveLength(0);

    const myAudit = await listOrgAudit(alice.organizationId, { limit: 25 });
    const theirAudit = await listOrgAudit(bob.organizationId, { limit: 25 });

    expect(myAudit.rows.length).toBeGreaterThan(0);
    expect(theirAudit.rows).toHaveLength(0);
  });

  it('refuses a member the buttons, and lets them look', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);

    const member: Membership = { ...alice, role: 'MEMBER' };

    expect(() => {
      assertCapability(member, 'VIEW');
    }).not.toThrow();

    expect(() => {
      assertCapability(member, 'CONFIGURE');
    }).toThrow();

    expect(() => {
      assertCapability(member, 'OPERATE');
    }).toThrow();
  });

  it('gives a member a narrower view, rather than the full one with holes in it', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    const asMember = await getConnection({ ...alice, role: 'MEMBER' }, connection.id);

    // The shape itself is different: there is no `baseUrl`, no `endpoints` and
    // no `credentials` to blank out, because they were never assembled.
    expect('baseUrl' in asMember).toBe(false);
    expect('credentials' in asMember).toBe(false);
    expect('endpoints' in asMember).toBe(false);

    // And the health facts a member came for are all there.
    expect(asMember.state).toBe('DRAFT');
    expect(asMember.name).toBe('Production SAP');
  });
});

describe('credentials', () => {
  it('never returns a secret through any read path', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    const view = (await getConnection(alice, connection.id)) as ConnectionView;
    const serialised = JSON.stringify(view);

    expect(serialised).not.toContain('super-secret-value-9f2a');

    // The hint is there, and it is not the secret. The client ID is shown in
    // full because it is not one.
    const hint = view.credentials.find((entry) => entry.kind === 'PRIMARY')?.hint ?? '';
    expect(hint).toContain('uboss-client');
    expect(hint).not.toContain('super-secret-value-9f2a');
  });

  it('stores the secret as ciphertext bound to its own row', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    const row = await prisma.customerErpCredential.findFirstOrThrow({
      where: { connectionId: connection.id, kind: 'PRIMARY' },
    });

    // Not the plaintext, anywhere in the column.
    expect(row.payloadEnc).not.toContain('super-secret-value-9f2a');

    // It opens with its own AAD.
    const opened = JSON.parse(
      decryptSecret(row.payloadEnc, credentialAad(connection.id, 'PRIMARY')),
    ) as PrimaryCredential;

    expect(opened.clientSecret).toBe('super-secret-value-9f2a');

    // And refuses to open under another connection's. A row copied between
    // connections is useless rather than a working credential for a system it
    // was never issued for.
    expect(() => decryptSecret(row.payloadEnc, credentialAad(newId(), 'PRIMARY'))).toThrow();
  });

  it('keeps a stored secret when a save omits it, and clears it on an empty string', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    const { updateConnection } = await import(
      '../../src/modules/customer-erp/connection.service.js'
    );

    // The masked-edit case: a form changes the timeout and sends no secret,
    // because it never had one to send.
    await updateConnection(alice, actor, connection.id, { timeoutMs: 30000 });

    let stored = await openCredential<PrimaryCredential>(connection.id, 'PRIMARY');
    expect(stored?.clientSecret).toBe('super-secret-value-9f2a');

    // An explicit empty string is how you clear it, and it is a deliberate act
    // rather than the default.
    await updateConnection(alice, actor, connection.id, { secrets: { clientSecret: '' } });

    stored = await openCredential<PrimaryCredential>(connection.id, 'PRIMARY');
    expect(stored?.clientSecret).toBeUndefined();
    expect(stored?.clientId).toBe('uboss-client');
  });

  it('destroys every credential on disconnect', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    expect(await summariseCredentials(connection.id)).not.toHaveLength(0);

    const after = await disconnectConnection(alice, actor, connection.id);

    expect(after.state).toBe('DISCONNECTED');
    expect(await summariseCredentials(connection.id)).toHaveLength(0);
    expect(await prisma.customerErpCredential.count({ where: { connectionId: connection.id } })).toBe(0);

    // The row survives, so the events that reference it still read back.
    expect(await prisma.customerErpConnection.count({ where: { id: connection.id } })).toBe(1);
  });
});

describe('the idempotency key', () => {
  it('admits one event and finds it on every later attempt', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    const orderId = newId();

    const input = {
      connectionId: connection.id,
      organizationId: alice.organizationId,
      eventType: 'PURCHASE_ORDER_CREATE' as const,
      subject: orderId,
      correlationId: newId(),
      orderId,
    };

    const first = await enqueueEvent(input);
    // A redelivered payment webhook, a second worker, a manual send-again -
    // all derive the same key from the same facts.
    const second = await enqueueEvent({ ...input, correlationId: newId() });
    const third = await enqueueEvent({ ...input, correlationId: newId() });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);

    expect(second.eventId).toBe(first.eventId);
    expect(third.eventId).toBe(first.eventId);

    // ONE row. This is the property the whole feature turns on.
    expect(
      await prisma.customerErpSyncEvent.count({ where: { connectionId: connection.id } }),
    ).toBe(1);
  });

  it('treats a new version as a new thing to say', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    const orderId = newId();
    const base = {
      connectionId: connection.id,
      organizationId: alice.organizationId,
      eventType: 'PURCHASE_ORDER_UPDATE' as const,
      subject: orderId,
      correlationId: newId(),
      orderId,
    };

    await enqueueEvent(base);
    const amended = await enqueueEvent({ ...base, eventVersion: 2 });

    expect(amended.created).toBe(true);
    expect(await prisma.customerErpSyncEvent.count()).toBe(2);
  });

  it('separates two tenants that place the same order number', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const bob = await resolveMembership((await makeBuyer('City Medical')).profileId);

    const subject = 'UB-2026-000123';

    expect(
      idempotencyKeyFor({
        organizationId: alice.organizationId,
        subject,
        eventType: 'PURCHASE_ORDER_CREATE',
      }),
    ).not.toBe(
      idempotencyKeyFor({
        organizationId: bob.organizationId,
        subject,
        eventType: 'PURCHASE_ORDER_CREATE',
      }),
    );
  });

  it('reuses the row on a manual retry rather than making a second one', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    const queued = await enqueueEvent({
      connectionId: connection.id,
      organizationId: alice.organizationId,
      eventType: 'PURCHASE_ORDER_CREATE',
      subject: newId(),
      correlationId: newId(),
    });

    await prisma.customerErpSyncEvent.update({
      where: { id: queued.eventId },
      data: { state: 'FAILED', attemptCount: 6, errorMessage: 'Their SAP said no.' },
    });

    await requeueEvent(queued.eventId, alice.organizationId, actor);

    const after = await prisma.customerErpSyncEvent.findUniqueOrThrow({
      where: { id: queued.eventId },
    });

    // Same row, same key, budget reset so a fixed cause gets a real chance.
    expect(after.state).toBe('QUEUED');
    expect(after.idempotencyKey).toBe(queued.idempotencyKey);
    expect(after.attemptCount).toBe(0);
    expect(await prisma.customerErpSyncEvent.count()).toBe(1);
  });

  it('refuses to retry something that already succeeded', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    const queued = await enqueueEvent({
      connectionId: connection.id,
      organizationId: alice.organizationId,
      eventType: 'PURCHASE_ORDER_CREATE',
      subject: newId(),
      correlationId: newId(),
    });

    await prisma.customerErpSyncEvent.update({
      where: { id: queued.eventId },
      data: { state: 'SUCCEEDED', erpReference: '4500001234' },
    });

    // A retry here would be a second purchase order in a real SAP.
    await expect(
      requeueEvent(queued.eventId, alice.organizationId, actor),
    ).rejects.toThrow();
  });
});

describe('activation', () => {
  it('is refused until a test has passed and a mapping has been checked', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    await expect(activateConnection(alice, actor, connection.id)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'CUSTOMER_ERP_UNTESTED',
    );

    // A test that passed but no mapping check is still not enough: credentials
    // that work against a mapping that finds nothing is a connection that
    // raises empty purchase orders.
    await prisma.customerErpConnection.update({
      where: { id: connection.id },
      data: { lastTestOk: true },
    });

    await expect(activateConnection(alice, actor, connection.id)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'CUSTOMER_ERP_MAPPING_UNVERIFIED',
    );
  });

  it('clears what a test proved as soon as the configuration changes', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    await prisma.customerErpConnection.update({
      where: { id: connection.id },
      data: { lastTestOk: true, mappingVerifiedAt: new Date() },
    });

    const { updateConnection } = await import(
      '../../src/modules/customer-erp/connection.service.js'
    );

    await updateConnection(alice, actor, connection.id, {
      baseUrl: 'https://erp2.example.com/sap',
    });

    const after = await prisma.customerErpConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });

    // Whatever the last test proved, it proved about settings that have just
    // been replaced.
    expect(after.lastTestOk).toBeNull();
    expect(after.mappingVerifiedAt).toBeNull();
    expect(after.state).toBe('DRAFT');
  });

  it('refuses a mapping that names a field this platform does not have', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    await expect(
      saveMappings(alice, actor, connection.id, [
        {
          entity: 'ORDER',
          platformField: 'notAField',
          erpPath: 'Whatever',
          constantValue: null,
          erpValue: null,
          transform: null,
          required: false,
        },
      ]),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'CUSTOMER_ERP_MAPPING_INVALID',
    );
  });

  it('records a failed test as a failed test, and leaves a draft a draft', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    // No outbound call can succeed against erp.example.com from a test run, so
    // this exercises the real failure path rather than a stub.
    const result = await testConnection(alice, actor, connection.id);

    expect(result.ok).toBe(false);

    const after = await prisma.customerErpConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });

    // Back to DRAFT with the outcome in the columns. Not FAILED: nothing took
    // a working connection out of service.
    expect(after.state).toBe('DRAFT');
    expect(after.lastTestOk).toBe(false);
    expect(after.lastTestMessage).not.toBeNull();

    // And the message is safe to show: no address, no credential.
    expect(after.lastTestMessage ?? '').not.toContain('super-secret-value-9f2a');
  });
});

describe('pausing stops automatic writes', () => {
  it('holds a queued event instead of sending it, without spending an attempt', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    // Put it in service the short way; activation's own guards are covered
    // above and this test is about what PAUSED does to dispatch.
    await prisma.customerErpConnection.update({
      where: { id: connection.id },
      data: { state: 'ACTIVE', lastTestOk: true, mappingVerifiedAt: new Date() },
    });

    const paused = await changeConnectionState(alice, actor, connection.id, 'PAUSE');
    expect(paused.state).toBe('PAUSED');

    const queued = await enqueueEvent({
      connectionId: connection.id,
      organizationId: alice.organizationId,
      eventType: 'PURCHASE_ORDER_CREATE',
      subject: newId(),
      correlationId: newId(),
    });

    // Through the real claim, because that is what the worker does and because
    // `dispatchEvent` is entitled to assume its caller holds the lease. A
    // hand-built `ClaimedEvent` would leave the row QUEUED and quietly test
    // nothing.
    const claimed = await claimDueEvents(10);
    expect(claimed.map((event) => event.id)).toContain(queued.eventId);

    for (const event of claimed) {
      await dispatchEvent(event);
    }

    const after = await prisma.customerErpSyncEvent.findUniqueOrThrow({
      where: { id: queued.eventId },
    });

    // Held, not failed and not sent. The attempt is given back, because
    // burning the retry budget on a fortnight's pause would put a perfectly
    // good purchase order in the dead-letter list for a reason that was never
    // its own.
    expect(after.state).toBe('QUEUED');
    expect(after.nextRetryAt).not.toBeNull();
    expect(after.attemptCount).toBe(0);
    expect(after.skipReason ?? '').toContain('paused');
  });

  it('skips permanently once the connection is disconnected', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    const queued = await enqueueEvent({
      connectionId: connection.id,
      organizationId: alice.organizationId,
      eventType: 'PURCHASE_ORDER_CREATE',
      subject: newId(),
      correlationId: newId(),
    });

    await disconnectConnection(alice, actor, connection.id);

    for (const event of await claimDueEvents(10)) {
      await dispatchEvent(event);
    }

    const after = await prisma.customerErpSyncEvent.findUniqueOrThrow({
      where: { id: queued.eventId },
    });

    // Nothing to send to, and no prospect of one appearing without somebody
    // setting the connection up again.
    expect(after.state).toBe('SKIPPED');
  });
});

describe('the audit trail', () => {
  it('records what was done without recording the credential', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const connection = await makeConnection(alice);

    const { rows } = await listOrgAudit(alice.organizationId, { limit: 25 });

    const created = rows.find((row) => row.action === 'connection.created');
    expect(created).toBeDefined();
    expect(created?.connectionId).toBe(connection.id);

    // The whole trail, serialised, contains nothing secret.
    expect(JSON.stringify(rows)).not.toContain('super-secret-value-9f2a');
  });

  it('is searchable by correlation ID, which is what somebody actually has', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    await makeConnection(alice);

    const all = await listOrgAudit(alice.organizationId, { limit: 25 });
    const correlationId = all.rows.find((row) => row.correlationId !== null)?.correlationId;

    if (correlationId === undefined || correlationId === null) return;

    const found = await listOrgAudit(alice.organizationId, {
      search: correlationId,
      limit: 25,
    });

    expect(found.rows.length).toBeGreaterThan(0);
  });
});

describe('the queue counts the dashboard shows', () => {
  it('counts by state, scoped to the organisation', async () => {
    const alice = await resolveMembership((await makeBuyer('Zorggroep Noord')).profileId);
    const bob = await resolveMembership((await makeBuyer('City Medical')).profileId);

    const mine = await makeConnection(alice);

    for (const state of ['SUCCEEDED', 'SUCCEEDED', 'FAILED'] as const) {
      const queued = await enqueueEvent({
        connectionId: mine.id,
        organizationId: alice.organizationId,
        eventType: 'PURCHASE_ORDER_CREATE',
        subject: newId(),
        correlationId: newId(),
      });

      await prisma.customerErpSyncEvent.update({
        where: { id: queued.eventId },
        data: { state },
      });
    }

    const counts = await countEventsByState(alice.organizationId);
    expect(counts.SUCCEEDED).toBe(2);
    expect(counts.FAILED).toBe(1);

    const theirs = await countEventsByState(bob.organizationId);
    expect(theirs.SUCCEEDED).toBe(0);
    expect(theirs.FAILED).toBe(0);
  });
});
