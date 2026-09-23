/**
 * A seller's connection to their own carrier account: setting it up, proving
 * it works, and taking it out of service.
 *
 * THE TWO GATES, WHICH ARE THE POINT OF THIS FILE
 *
 * A connection reaches ACTIVE - the only state in which it carries a real
 * parcel - when BOTH of these are true, and never on one:
 *
 *   1. `lastTestPassedAt` is set, which happens only when a call genuinely
 *      reached the carrier and got an answer. Not when a form saved.
 *   2. `productionConfirmedAt` is set, which happens only when a named person
 *      at the seller said "yes, ship real parcels with this".
 *
 * Without the first, a saved form looks like a working integration. Without
 * the second, a seller who was experimenting discovers they have been shipping
 * live. Both failures are the same kind: a screen claiming something nobody
 * checked.
 *
 * WHAT THIS FILE WILL NOT DO
 *
 * Return a credential, in any form, to any caller. `adapterForSellerConnection`
 * reads one and closes over it; the object it hands back exposes carrier
 * operations and nothing else. There is no function here whose return value
 * contains a secret, which is why there is no endpoint that could accidentally
 * serialise one.
 */
import type { CarrierProvider } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  defaultTrackingModeFor,
  hasVerifiedOfficialApi,
} from '../../domain/seller-fulfilment.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import type { CarrierAdapter } from '../logistics/carrier/adapter.js';
import { DhlApiAdapter } from '../logistics/carrier/dhl.adapter.js';
import { FedExApiAdapter } from '../logistics/carrier/fedex.adapter.js';
import { indiaPostAdapter } from '../logistics/carrier/registry.js';
import { recordSellerAudit } from './audit.service.js';
import {
  credentialUnavailable,
  readCarrierCredential,
  safeCarrierMessage,
} from './carrier-credential.service.js';
import type { SellerActor } from './fulfilment-method.service.js';

/**
 * Take a carrier connection out of service after this many failures in a row.
 *
 * A connection that has been broken for a fortnight should not be called every
 * few minutes for a fortnight - that is the seller's rate limit being spent on
 * a request nobody expects to work.
 */
const FAILURE_THRESHOLD = 5;

export interface ConnectionView {
  id: string;
  provider: CarrierProvider;
  environment: 'SANDBOX' | 'PRODUCTION';
  state: string;
  trackingMode: string;
  /** The last four characters of the account number, never the whole thing. */
  accountNumberHint: string | null;
  /** What the credential screen shows in place of the key. Never derived from it. */
  credentialHint: string | null;
  hasCredential: boolean;
  lastTestAt: string | null;
  lastTestPassedAt: string | null;
  lastTestMessage: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  consecutiveFailures: number;
  productionConfirmedAt: string | null;
  /** Whether this provider has an API at all. False for India Post. */
  hasVerifiedApi: boolean;
}

function toView(row: {
  id: string;
  provider: CarrierProvider;
  environment: 'SANDBOX' | 'PRODUCTION';
  state: string;
  trackingMode: string;
  accountNumber: string | null;
  lastTestAt: Date | null;
  lastTestPassedAt: Date | null;
  lastTestMessage: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureMessage: string | null;
  consecutiveFailures: number;
  productionConfirmedAt: Date | null;
  credential: { maskedHint: string | null } | null;
}): ConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    state: row.state,
    trackingMode: row.trackingMode,
    accountNumberHint:
      row.accountNumber === null || row.accountNumber.length <= 4
        ? row.accountNumber
        : `…${row.accountNumber.slice(-4)}`,
    credentialHint: row.credential?.maskedHint ?? null,
    hasCredential: row.credential !== null,
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastTestPassedAt: row.lastTestPassedAt?.toISOString() ?? null,
    lastTestMessage: row.lastTestMessage,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    lastFailureMessage: row.lastFailureMessage,
    consecutiveFailures: row.consecutiveFailures,
    productionConfirmedAt: row.productionConfirmedAt?.toISOString() ?? null,
    hasVerifiedApi: hasVerifiedOfficialApi(row.provider),
  };
}

const VIEW_SELECT = {
  id: true,
  provider: true,
  environment: true,
  state: true,
  trackingMode: true,
  accountNumber: true,
  lastTestAt: true,
  lastTestPassedAt: true,
  lastTestMessage: true,
  lastSuccessAt: true,
  lastFailureAt: true,
  lastFailureMessage: true,
  consecutiveFailures: true,
  productionConfirmedAt: true,
  // The HINT only. `credentialsEnc` is not in this select and is not in any
  // select outside `carrier-credential.service.ts`.
  credential: { select: { maskedHint: true } },
} as const;

export async function listCarrierConnections(sellerAccountId: string): Promise<ConnectionView[]> {
  const rows = await prisma.sellerCarrierConnection.findMany({
    where: { sellerAccountId },
    select: VIEW_SELECT,
    orderBy: [{ provider: 'asc' }, { environment: 'asc' }],
  });

  return rows.map(toView);
}

export interface CreateConnectionInput {
  sellerAccountId: string;
  actor: SellerActor;
  provider: CarrierProvider;
  environment: 'SANDBOX' | 'PRODUCTION';
  accountNumber?: string | null;
  billingAccountNumber?: string | null;
  defaultServiceCode?: string | null;
  labelFormat?: string | null;
}

/**
 * Declare that this seller has an account with this carrier.
 *
 * Creates the row and nothing else - no credential, no test, no entitlement.
 * The connection starts NOT_CONFIGURED, which is exactly what it is, and the
 * screen says so.
 *
 * India Post gets `trackingMode` EXTERNAL_LINK from
 * `defaultTrackingModeFor`, and there is no path in this file that can move it
 * to AUTOMATIC_API - because there is no API to move it for.
 */
export async function createCarrierConnection(
  input: CreateConnectionInput,
): Promise<ConnectionView> {
  const existing = await prisma.sellerCarrierConnection.findUnique({
    where: {
      sellerAccountId_provider_environment: {
        sellerAccountId: input.sellerAccountId,
        provider: input.provider,
        environment: input.environment,
      },
    },
    select: { id: true, state: true },
  });

  if (existing !== null && existing.state !== 'DISCONNECTED') {
    throw conflict(
      ErrorCode.CONFLICT,
      `You already have a ${input.provider} connection for that environment.`,
      [{ code: 'ALREADY_CONNECTED', meta: { provider: input.provider } }],
    );
  }

  const id = existing?.id ?? newId();

  const data = {
    accountNumber: input.accountNumber ?? null,
    billingAccountNumber: input.billingAccountNumber ?? null,
    defaultServiceCode: input.defaultServiceCode ?? null,
    labelFormat: input.labelFormat ?? null,
    trackingMode: defaultTrackingModeFor(input.provider),
    state: 'NOT_CONFIGURED' as const,
    disconnectedAt: null,
  };

  if (existing === null) {
    await prisma.sellerCarrierConnection.create({
      data: {
        id,
        sellerAccountId: input.sellerAccountId,
        provider: input.provider,
        environment: input.environment,
        createdBySellerMemberId: input.actor.memberId,
        ...data,
      },
    });
  } else {
    // Reconnecting after a disconnection reuses the row, so the shipments that
    // point at it keep pointing at something. The credential was destroyed and
    // is not restored.
    await prisma.sellerCarrierConnection.update({ where: { id }, data });
  }

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.carrier.connection.created',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerCarrierConnection',
    resourceId: id,
    after: { provider: input.provider, environment: input.environment },
    summary: `Added a ${input.provider} connection.`,
  });

  const row = await prisma.sellerCarrierConnection.findUniqueOrThrow({
    where: { id },
    select: VIEW_SELECT,
  });

  return toView(row);
}

/**
 * The adapter for one seller's connection.
 *
 * The ONLY place a seller's carrier credential is turned into something that
 * can make a call. It reads the plaintext, hands it to a constructor, and
 * returns the constructed object - so the secret lives in this function's
 * frame and in a private field, and never on anything that is returned,
 * serialised or logged.
 *
 * India Post is deliberately reachable here and deliberately returns the
 * refusing adapter. It is a real choice a seller can make; what it is not is
 * an API.
 */
export async function adapterForSellerConnection(connectionId: string): Promise<CarrierAdapter> {
  const connection = await prisma.sellerCarrierConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, provider: true, environment: true, accountNumber: true },
  });

  if (connection === null) throw notFound('Carrier connection');

  if (connection.provider === 'INDIA_POST') {
    // No credential is read, because there is nothing to authenticate to.
    return indiaPostAdapter();
  }

  const credentials = await readCarrierCredential(connection.id);

  if (credentials === null) throw credentialUnavailable(connection.provider);

  switch (connection.provider) {
    case 'DHL': {
      const apiKey = credentials.apiKey;
      const apiSecret = credentials.apiSecret;

      if (apiKey === undefined || apiSecret === undefined) {
        throw credentialUnavailable('DHL');
      }

      return new DhlApiAdapter({
        environment: connection.environment,
        credentials: { apiKey, apiSecret },
        accountNumber: connection.accountNumber,
      });
    }

    case 'FEDEX': {
      const clientId = credentials.clientId;
      const clientSecret = credentials.clientSecret;

      if (clientId === undefined || clientSecret === undefined) {
        throw credentialUnavailable('FEDEX');
      }

      return new FedExApiAdapter({
        environment: connection.environment,
        credentials: { clientId, clientSecret },
        accountNumber: connection.accountNumber,
      });
    }

    default:
      throw badRequest(
        ErrorCode.CARRIER_OPERATION_NOT_SUPPORTED,
        `${connection.provider} cannot be connected as a seller carrier account.`,
        [{ code: 'UNSUPPORTED_PROVIDER', meta: { provider: connection.provider } }],
      );
  }
}

export interface TestResult {
  passed: boolean;
  /** Safe to show. Never a header, a token or a request body. */
  message: string;
  connection: ConnectionView;
}

/**
 * Actually call the carrier, and write down what happened.
 *
 * THE ONE FUNCTION THAT MAY SET `lastTestPassedAt`. It sets it only after a
 * call returned - not after a save, not after a validation, not because the
 * fields looked right. That is the whole mechanism behind "never show a green
 * connected status because the adapter returned mock data": there is no mock
 * data, and the flag is written in the branch that handled a real answer.
 *
 * The test is a RATE QUOTE against the seller's own account, because it
 * exercises the thing that has to work - authentication, the account number,
 * and the carrier's willingness to serve the lane - rather than an endpoint
 * that answers for anybody.
 */
export async function testCarrierConnection(input: {
  sellerAccountId: string;
  actor: SellerActor;
  connectionId: string;
}): Promise<TestResult> {
  const connection = await prisma.sellerCarrierConnection.findFirst({
    where: { id: input.connectionId, sellerAccountId: input.sellerAccountId },
    select: { id: true, provider: true, state: true },
  });

  if (connection === null) throw notFound('Carrier connection');

  if (!hasVerifiedOfficialApi(connection.provider)) {
    /*
     * Nothing to test, and saying so is the honest answer rather than
     * returning a pass.
     *
     * India Post is the case. A "test" that succeeded here would be this
     * software telling a seller their integration works when there is no
     * integration - which is the exact failure the whole provider posture
     * exists to prevent.
     */
    throw badRequest(
      ErrorCode.CARRIER_OPERATION_NOT_SUPPORTED,
      `${connection.provider} has no API to test. Consignments are tracked by hand.`,
      [{ code: 'NO_API', meta: { provider: connection.provider } }],
    );
  }

  const now = new Date();
  let passed: boolean;
  let message: string;

  try {
    const adapter = await adapterForSellerConnection(connection.id);

    // A round trip that costs nothing and books nothing.
    await adapter.getRates({
      from: {
        companyName: 'Connection test',
        line1: '1 Test Street',
        city: 'London',
        postalCode: 'EC1A 1BB',
        countryCode: 'GB',
      },
      to: {
        companyName: 'Connection test',
        line1: '1 Test Street',
        city: 'Dublin',
        postalCode: 'D02 AF30',
        countryCode: 'IE',
      },
      parcels: [{ reference: 'TEST', weightGrams: 1000 }],
    });

    passed = true;
    message = 'The carrier answered. This connection is working.';
  } catch (error) {
    passed = false;
    message = safeCarrierMessage(error);
  }

  await prisma.sellerCarrierConnection.update({
    where: { id: connection.id },
    data: {
      lastTestAt: now,
      lastTestMessage: message,
      ...(passed
        ? {
            lastTestPassedAt: now,
            lastSuccessAt: now,
            consecutiveFailures: 0,
            lastFailureMessage: null,
            /*
             * TEST_PASSED, not ACTIVE. The second gate is a person saying yes,
             * and a test cannot speak for them.
             *
             * A connection that was already ACTIVE stays ACTIVE - re-testing a
             * working connection must not take it out of service.
             */
            ...(connection.state === 'ACTIVE' ? {} : { state: 'TEST_PASSED' as const }),
          }
        : {
            lastFailureAt: now,
            lastFailureMessage: message,
            consecutiveFailures: { increment: 1 },
          }),
    },
  });

  if (!passed) {
    // Out of service at the threshold, so a broken connection stops being
    // called on every order.
    const after = await prisma.sellerCarrierConnection.findUniqueOrThrow({
      where: { id: connection.id },
      select: { consecutiveFailures: true, state: true },
    });

    if (after.consecutiveFailures >= FAILURE_THRESHOLD && after.state !== 'DISCONNECTED') {
      await prisma.sellerCarrierConnection.update({
        where: { id: connection.id },
        data: { state: 'ERROR' },
      });
    }
  }

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.carrier.connection.tested',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerCarrierConnection',
    resourceId: connection.id,
    after: { passed },
    summary: `Tested the ${connection.provider} connection: ${passed ? 'it answered' : 'it did not'}.`,
  });

  const row = await prisma.sellerCarrierConnection.findUniqueOrThrow({
    where: { id: connection.id },
    select: VIEW_SELECT,
  });

  return { passed, message, connection: toView(row) };
}

/**
 * The second gate: a person says to start shipping real parcels with it.
 *
 * Refuses unless a test has passed. The order matters and is not
 * interchangeable - confirming first and testing later would mean a
 * connection could go live on a credential nobody had ever exercised.
 */
export async function confirmCarrierForProduction(input: {
  sellerAccountId: string;
  actor: SellerActor;
  connectionId: string;
}): Promise<ConnectionView> {
  const connection = await prisma.sellerCarrierConnection.findFirst({
    where: { id: input.connectionId, sellerAccountId: input.sellerAccountId },
    select: { id: true, provider: true, state: true, lastTestPassedAt: true },
  });

  if (connection === null) throw notFound('Carrier connection');

  if (connection.lastTestPassedAt === null) {
    throw conflict(
      ErrorCode.SELLER_CARRIER_CONNECTION_NOT_READY,
      `Test the ${connection.provider} connection first. It goes live once a real call has ` +
        'reached the carrier and you have confirmed it here.',
      [{ code: 'TEST_REQUIRED', meta: { provider: connection.provider } }],
    );
  }

  await prisma.sellerCarrierConnection.update({
    where: { id: connection.id },
    data: {
      state: 'ACTIVE',
      productionConfirmedAt: new Date(),
      productionConfirmedBySellerMemberId: input.actor.memberId,
    },
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.carrier.connection.activated',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerCarrierConnection',
    resourceId: connection.id,
    after: { state: 'ACTIVE' },
    summary: `Put the ${connection.provider} connection into service.`,
  });

  const row = await prisma.sellerCarrierConnection.findUniqueOrThrow({
    where: { id: connection.id },
    select: VIEW_SELECT,
  });

  return toView(row);
}

/** Stop using a connection without destroying its credential. */
export async function pauseCarrierConnection(input: {
  sellerAccountId: string;
  actor: SellerActor;
  connectionId: string;
  resume: boolean;
}): Promise<ConnectionView> {
  const connection = await prisma.sellerCarrierConnection.findFirst({
    where: { id: input.connectionId, sellerAccountId: input.sellerAccountId },
    select: { id: true, provider: true, state: true, lastTestPassedAt: true },
  });

  if (connection === null) throw notFound('Carrier connection');

  if (input.resume && connection.lastTestPassedAt === null) {
    throw conflict(
      ErrorCode.SELLER_CARRIER_CONNECTION_NOT_READY,
      'Test the connection before putting it back into service.',
      [{ code: 'TEST_REQUIRED' }],
    );
  }

  await prisma.sellerCarrierConnection.update({
    where: { id: connection.id },
    data: { state: input.resume ? 'ACTIVE' : 'PAUSED' },
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: input.resume
      ? 'seller.carrier.connection.resumed'
      : 'seller.carrier.connection.paused',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerCarrierConnection',
    resourceId: connection.id,
    after: { state: input.resume ? 'ACTIVE' : 'PAUSED' },
    summary: `${input.resume ? 'Resumed' : 'Paused'} the ${connection.provider} connection.`,
  });

  const row = await prisma.sellerCarrierConnection.findUniqueOrThrow({
    where: { id: connection.id },
    select: VIEW_SELECT,
  });

  return toView(row);
}
