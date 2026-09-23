/**
 * A seller's own carrier account: the two gates, and the credential.
 *
 * WHAT IS DELIBERATELY NOT EXERCISED HERE
 *
 * A successful DHL or FedEx test. That needs a real credential on a real
 * account, and in this product credentials belong to each seller - the
 * repository holds none and a test that invented one would be testing a mock.
 * So what is asserted is the half that decides whether a screen tells the
 * truth: that nothing reaches ACTIVE without a real call having passed, that a
 * provider with no API refuses to be "tested" rather than reporting success,
 * and that the key is never readable from anywhere but the one service that
 * decrypts it.
 *
 * No test in this file makes an outbound request.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  confirmCarrierForProduction,
  createCarrierConnection,
  listCarrierConnections,
  pauseCarrierConnection,
  testCarrierConnection,
} from '../../src/modules/seller/carrier-connection.service.js';
import {
  destroyCarrierCredential,
  readCarrierCredential,
  storeCarrierCredential,
} from '../../src/modules/seller/carrier-credential.service.js';
import type { SellerActor } from '../../src/modules/seller/fulfilment-method.service.js';

const SLUG_A = 'conn-owner-co';
const SLUG_B = 'conn-rival-co';

let sellerA = '';
let sellerB = '';

const ACTOR: SellerActor = { memberId: null, userId: null, label: 'Conn Owner Co' };

async function cleanUp(): Promise<void> {
  const slugs = { in: [SLUG_A, SLUG_B] };

  await prisma.sellerCarrierCredential.deleteMany({
    where: { connection: { sellerAccount: { slug: slugs } } },
  });
  await prisma.sellerCarrierConnection.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: slugs } });
}

async function makeSeller(slug: string, displayName: string): Promise<string> {
  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: `${displayName} Ltd`,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
      slug,
      kind: 'RESELLER',
      registrationCountry: 'IN',
      status: 'DRAFT',
    },
  });

  return seller.id;
}

beforeAll(async () => {
  await cleanUp();
  sellerA = await makeSeller(SLUG_A, 'Conn Owner Co');
  sellerB = await makeSeller(SLUG_B, 'Conn Rival Co');
});

afterAll(async () => {
  await cleanUp();
});

// ---------------------------------------------------------------------------

describe('the two gates before a connection carries a real parcel', () => {
  let connectionId = '';

  it('starts a new connection as not configured', async () => {
    const connection = await createCarrierConnection({
      sellerAccountId: sellerA,
      actor: ACTOR,
      provider: 'DHL',
      environment: 'SANDBOX',
      accountNumber: '123456789',
    });

    connectionId = connection.id;

    expect(connection.state).toBe('NOT_CONFIGURED');
    expect(connection.hasCredential).toBe(false);
    // The account number is not a secret, but the whole of it on a screen is
    // more than the screen needs to confirm which account this is.
    expect(connection.accountNumberHint).toBe('…6789');
  });

  it('refuses to go live before anything has been tested', async () => {
    await expect(
      confirmCarrierForProduction({
        sellerAccountId: sellerA,
        actor: ACTOR,
        connectionId,
      }),
    ).rejects.toMatchObject({ code: 'SELLER_CARRIER_CONNECTION_NOT_READY' });
  });

  it('moves to credentials-set when a key is stored, and no further', async () => {
    await storeCarrierCredential({
      sellerAccountId: sellerA,
      actor: ACTOR,
      connectionId,
      fields: { apiKey: 'demo-key-1234', apiSecret: 'demo-secret-5678' },
    });

    const [connection] = await listCarrierConnections(sellerA);

    // A saved form is not a working integration.
    expect(connection?.state).toBe('CREDENTIALS_SET');
    expect(connection?.hasCredential).toBe(true);
    expect(connection?.lastTestPassedAt).toBeNull();
  });

  it('still refuses to go live on a stored key alone', async () => {
    await expect(
      confirmCarrierForProduction({ sellerAccountId: sellerA, actor: ACTOR, connectionId }),
    ).rejects.toMatchObject({ code: 'SELLER_CARRIER_CONNECTION_NOT_READY' });
  });

  it('goes live only once a test has genuinely passed', async () => {
    // The test itself needs a real carrier, so the flag is set directly here -
    // which is exactly what `testCarrierConnection` does after a call returns,
    // and is the ONLY thing that sets it in the real code path.
    await prisma.sellerCarrierConnection.update({
      where: { id: connectionId },
      data: { state: 'TEST_PASSED', lastTestPassedAt: new Date() },
    });

    const connection = await confirmCarrierForProduction({
      sellerAccountId: sellerA,
      actor: ACTOR,
      connectionId,
    });

    expect(connection.state).toBe('ACTIVE');
    expect(connection.productionConfirmedAt).not.toBeNull();
  });

  it('drops back behind the gate when the key is rotated', async () => {
    // A rotated key that was typed wrongly must not inherit the previous key's
    // green tick.
    await storeCarrierCredential({
      sellerAccountId: sellerA,
      actor: ACTOR,
      connectionId,
      fields: { apiKey: 'rotated-key-9999', apiSecret: 'rotated-secret-0000' },
    });

    const [connection] = await listCarrierConnections(sellerA);

    expect(connection?.state).toBe('CREDENTIALS_SET');
    expect(connection?.lastTestPassedAt).toBeNull();
    expect(connection?.productionConfirmedAt).toBeNull();
  });

  it('keeps one credential row through a rotation rather than accumulating', async () => {
    const rows = await prisma.sellerCarrierCredential.findMany({
      where: { sellerCarrierConnectionId: connectionId },
    });

    // A superseded secret has no remaining purpose; keeping it is a liability
    // rather than an audit trail.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(2);
    expect(rows[0]?.rotatedAt).not.toBeNull();
  });

  it('refuses to resume a paused connection that has not been re-tested', async () => {
    await pauseCarrierConnection({
      sellerAccountId: sellerA,
      actor: ACTOR,
      connectionId,
      resume: false,
    });

    await expect(
      pauseCarrierConnection({ sellerAccountId: sellerA, actor: ACTOR, connectionId, resume: true }),
    ).rejects.toMatchObject({ code: 'SELLER_CARRIER_CONNECTION_NOT_READY' });
  });
});

describe('the credential itself', () => {
  let connectionId = '';

  beforeAll(async () => {
    const connection = await createCarrierConnection({
      sellerAccountId: sellerB,
      actor: ACTOR,
      provider: 'FEDEX',
      environment: 'SANDBOX',
      accountNumber: '999888777',
    });

    connectionId = connection.id;

    await storeCarrierCredential({
      sellerAccountId: sellerB,
      actor: ACTOR,
      connectionId,
      fields: { clientId: 'client-abcdefgh', clientSecret: 'secret-ijklmnop' },
    });
  });

  it('is never returned by the screen that lists connections', async () => {
    const connections = await listCarrierConnections(sellerB);
    const serialised = JSON.stringify(connections);

    expect(serialised).not.toContain('secret-ijklmnop');
    expect(serialised).not.toContain('client-abcdefgh');
    // What the seller does get: four characters of the ACCOUNT-identifying
    // field, never anything derived from the secret.
    expect(connections[0]?.credentialHint).toBe('…efgh');
  });

  it('is stored encrypted rather than as text', async () => {
    const row = await prisma.sellerCarrierCredential.findUniqueOrThrow({
      where: { sellerCarrierConnectionId: connectionId },
    });

    expect(row.credentialsEnc).not.toContain('secret-ijklmnop');
    expect(row.credentialsEnc).not.toContain('client-abcdefgh');
  });

  it('reads back correctly for the one service allowed to', async () => {
    const credentials = await readCarrierCredential(connectionId);

    expect(credentials).toEqual({
      clientId: 'client-abcdefgh',
      clientSecret: 'secret-ijklmnop',
    });
  });

  it('will not decrypt if the envelope is moved to another connection', async () => {
    /*
     * THE POINT OF BINDING THE AAD TO THE CONNECTION ID.
     *
     * Somebody with database access copies one seller's envelope into their
     * own connection row. Without the binding it would decrypt and their
     * parcels would be billed to the first seller's carrier account. With it,
     * the read returns null and the connection is simply unconfigured.
     */
    const stolen = await prisma.sellerCarrierCredential.findUniqueOrThrow({
      where: { sellerCarrierConnectionId: connectionId },
      select: { credentialsEnc: true },
    });

    const otherConnection = await createCarrierConnection({
      sellerAccountId: sellerA,
      actor: ACTOR,
      provider: 'FEDEX',
      environment: 'SANDBOX',
    });

    await prisma.sellerCarrierCredential.create({
      data: {
        id: newId(),
        sellerCarrierConnectionId: otherConnection.id,
        credentialsEnc: stolen.credentialsEnc,
        createdBySellerMemberId: newId(),
      },
    });

    expect(await readCarrierCredential(otherConnection.id)).toBeNull();
  });

  it('refuses a key with a field the provider does not use', async () => {
    await expect(
      storeCarrierCredential({
        sellerAccountId: sellerB,
        actor: ACTOR,
        connectionId,
        fields: { apiKey: 'wrong-shape-for-fedex' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('is destroyed rather than blanked on disconnection', async () => {
    await destroyCarrierCredential({ sellerAccountId: sellerB, actor: ACTOR, connectionId });

    const row = await prisma.sellerCarrierCredential.findUnique({
      where: { sellerCarrierConnectionId: connectionId },
    });

    expect(row).toBeNull();

    const connection = await prisma.sellerCarrierConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });

    // The connection survives, because shipments point at it. What does not
    // survive is anything that could still authenticate.
    expect(connection.state).toBe('DISCONNECTED');
  });
});

describe('India Post is never described as connected', () => {
  let connectionId = '';

  it('starts on external-link tracking rather than an API', async () => {
    const connection = await createCarrierConnection({
      sellerAccountId: sellerA,
      actor: ACTOR,
      provider: 'INDIA_POST',
      environment: 'PRODUCTION',
    });

    connectionId = connection.id;

    expect(connection.trackingMode).toBe('EXTERNAL_LINK');
    expect(connection.hasVerifiedApi).toBe(false);
  });

  it('refuses to be tested, rather than reporting a pass', async () => {
    /*
     * THE ASSERTION THIS WHOLE PROVIDER POSTURE EXISTS FOR.
     *
     * A "test" that succeeded here would tell a seller their integration works
     * when there is no integration. Refusing is the honest answer, and it is
     * also what keeps `lastTestPassedAt` null - so nothing downstream can
     * render a green connected badge for India Post.
     */
    await expect(
      testCarrierConnection({ sellerAccountId: sellerA, actor: ACTOR, connectionId }),
    ).rejects.toMatchObject({ code: 'CARRIER_OPERATION_NOT_SUPPORTED' });

    const connection = await prisma.sellerCarrierConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });

    expect(connection.lastTestPassedAt).toBeNull();
    expect(connection.state).not.toBe('ACTIVE');
  });
});

describe('one seller cannot reach another', () => {
  let connectionId = '';

  beforeAll(async () => {
    const connection = await createCarrierConnection({
      sellerAccountId: sellerA,
      actor: ACTOR,
      provider: 'UPS',
      environment: 'SANDBOX',
    });

    connectionId = connection.id;
  });

  it('cannot store a key on it', async () => {
    await expect(
      storeCarrierCredential({
        sellerAccountId: sellerB,
        actor: ACTOR,
        connectionId,
        fields: { clientId: 'a', clientSecret: 'b' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cannot test it', async () => {
    await expect(
      testCarrierConnection({ sellerAccountId: sellerB, actor: ACTOR, connectionId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cannot activate it', async () => {
    await expect(
      confirmCarrierForProduction({ sellerAccountId: sellerB, actor: ACTOR, connectionId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cannot destroy its credential', async () => {
    await expect(
      destroyCarrierCredential({ sellerAccountId: sellerB, actor: ACTOR, connectionId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cannot see it in their own list', async () => {
    const theirs = await listCarrierConnections(sellerB);
    expect(theirs.find((connection) => connection.id === connectionId)).toBeUndefined();
  });
});
