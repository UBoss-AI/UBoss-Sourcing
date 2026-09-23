/**
 * A seller's own key for their own carrier account.
 *
 * The only module in this system that reads `SellerCarrierCredential`. Every
 * other file asks this one for an adapter, never for a secret, and no endpoint
 * anywhere returns what is stored here.
 *
 * WHY THESE ARE THE SELLER'S AND NOT THE OPERATOR'S
 *
 * `CarrierIntegration` holds the OPERATOR's credentials - one row per carrier
 * API this installation wired up, shared by every shipment the operator
 * dispatches. That is right for the operator's own freight and wrong for a
 * marketplace: a seller's DHL contract, its negotiated rates and its invoices
 * are the seller's, and a key in a shared row would let one seller's
 * consignment bill another seller's account. That is a tenant boundary crossed
 * at the credential, which no amount of checking further up can undo.
 *
 * THE FOUR RULES
 *
 *   1. **Encrypted with AAD bound to the connection.** An envelope copied out
 *      of one seller's row and into another's fails to decrypt rather than
 *      quietly authorising the wrong company's parcels.
 *   2. **Never returned.** There is no function here that hands a caller the
 *      plaintext except `adapterForConnection`, which closes over it and
 *      returns an object with methods - so the secret exists in one stack
 *      frame and is never serialised.
 *   3. **Never logged.** Carrier failures are reduced to a safe sentence by
 *      `safeCarrierMessage` before they are stored or shown; a failure message
 *      is the commonest place a key leaks.
 *   4. **Rotation replaces, it does not accumulate.** A superseded credential
 *      is a secret with no remaining purpose; keeping it is a liability rather
 *      than an audit trail. WHO rotated and WHEN is in `SellerAuditLog`.
 */
import type { CarrierProvider } from '../../generated/prisma/enums.js';
import { ErrorCode, AppError, badRequest, notFound } from '../../domain/errors.js';
import { decryptSecret, encryptSecret } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import type { SellerActor } from './fulfilment-method.service.js';

/**
 * The additional authenticated data every envelope is bound to.
 *
 * The connection's own id. Decryption fails if the envelope is moved, which is
 * the property that makes "copy this row into my connection" useless.
 */
function aadFor(connectionId: string): string {
  return `seller_carrier_credential:${connectionId}`;
}

/**
 * Which fields each provider actually needs.
 *
 * Declared rather than accepted freely so a seller cannot store arbitrary
 * material in an encrypted column, and so the connection screen can ask for
 * exactly the right boxes per carrier instead of a generic key/value grid
 * nobody can fill in correctly.
 *
 * These names come from each carrier's own current documentation. They are
 * NOT environment variables - nothing in `config/env.ts` reads them, and the
 * old `DHL_API_KEY` style names in `.env.example` are a leftover from when the
 * operator was expected to hold one account for everybody.
 */
export const CREDENTIAL_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // MyDHL API: a Basic-auth pair issued per customer account.
  DHL: ['apiKey', 'apiSecret'],
  // FedEx: OAuth2 client credentials.
  FEDEX: ['clientId', 'clientSecret'],
  UPS: ['clientId', 'clientSecret'],
  // A seller-supplied endpoint behind the generic adapter.
  CUSTOM: ['apiKey'],
});

export function credentialFieldsFor(provider: CarrierProvider): readonly string[] {
  return CREDENTIAL_FIELDS[provider] ?? [];
}

/**
 * Reduce a carrier's refusal to something safe to store and show.
 *
 * Truncated, stripped of anything that looks like a credential, and never the
 * request. A seller needs to know that DHL said no and roughly why; nothing
 * downstream needs the Authorization header that was on the request, and a
 * message field is exactly where one ends up if nobody stops it.
 */
export function safeCarrierMessage(value: unknown): string {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : 'The carrier did not accept the request.';

  return (
    raw
      // Anything that looks like a bearer token, a key or a long opaque run.
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
      .replace(/\b(authorization|api[-_]?key|secret|password|token)\b\s*[:=]\s*\S+/gi, '$1 [redacted]')
      .slice(0, 480)
  );
}

export interface StoreCredentialInput {
  sellerAccountId: string;
  actor: SellerActor;
  connectionId: string;
  /** Provider-specific, validated against `CREDENTIAL_FIELDS`. */
  fields: Record<string, string>;
}

/**
 * Store or replace the key behind one connection.
 *
 * Replacing is rotation: the row is updated in place and `version` goes up, so
 * there is never a second copy of a secret lying around. The connection drops
 * back to CREDENTIALS_SET, which means a new test has to pass before it can
 * carry anything again - a rotated key that was typed wrongly must not inherit
 * the previous key's green tick.
 */
export async function storeCarrierCredential(input: StoreCredentialInput): Promise<void> {
  const connection = await prisma.sellerCarrierConnection.findFirst({
    // Both ids in one query. Another seller's connection is not found.
    where: { id: input.connectionId, sellerAccountId: input.sellerAccountId },
    select: { id: true, provider: true, state: true },
  });

  if (connection === null) throw notFound('Carrier connection');

  const expected = credentialFieldsFor(connection.provider);

  if (expected.length === 0) {
    throw badRequest(
      ErrorCode.CARRIER_OPERATION_NOT_SUPPORTED,
      `${connection.provider} does not take API credentials.`,
      [{ code: 'NO_CREDENTIALS', meta: { provider: connection.provider } }],
    );
  }

  const missing = expected.filter(
    (field) => typeof input.fields[field] !== 'string' || input.fields[field]?.trim().length === 0,
  );

  if (missing.length > 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `${connection.provider} needs ${missing.join(' and ')}.`,
      missing.map((field) => ({ field, code: 'REQUIRED' })),
    );
  }

  // Only the declared fields are kept. Anything else a caller sent is dropped
  // rather than encrypted, so the column cannot become a place to stash things.
  const payload: Record<string, string> = {};
  for (const field of expected) payload[field] = input.fields[field]?.trim() ?? '';

  const envelope = encryptSecret(JSON.stringify(payload), aadFor(connection.id));

  /*
   * The hint is derived from the ACCOUNT-identifying field, never from the
   * secret. Four characters of a client id confirm which key this is; four
   * characters of a secret are four characters of a secret.
   */
  const hintSource = payload.clientId ?? payload.apiKey ?? '';
  const maskedHint = hintSource.length > 4 ? `…${hintSource.slice(-4)}` : null;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.sellerCarrierCredential.findUnique({
      where: { sellerCarrierConnectionId: connection.id },
      select: { id: true, version: true },
    });

    if (existing === null) {
      await tx.sellerCarrierCredential.create({
        data: {
          id: newId(),
          sellerCarrierConnectionId: connection.id,
          credentialsEnc: envelope,
          maskedHint,
          createdBySellerMemberId: input.actor.memberId ?? newId(),
        },
      });
    } else {
      await tx.sellerCarrierCredential.update({
        where: { id: existing.id },
        data: {
          credentialsEnc: envelope,
          maskedHint,
          version: existing.version + 1,
          rotatedAt: new Date(),
        },
      });
    }

    await tx.sellerCarrierConnection.update({
      where: { id: connection.id },
      data: {
        // Back behind the test gate. A rotated key has not been proved.
        state: 'CREDENTIALS_SET',
        lastTestPassedAt: null,
        productionConfirmedAt: null,
        consecutiveFailures: 0,
        lastFailureMessage: null,
      },
    });
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.carrier.credential.stored',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerCarrierConnection',
    resourceId: connection.id,
    // The provider and the fact that it happened. Never a value, not even
    // masked - `redact` in the audit service would catch most of it, and not
    // sending it is better than relying on that.
    after: { provider: connection.provider, fieldsProvided: expected },
    summary: `Stored API credentials for ${connection.provider}.`,
  });
}

/**
 * Destroy the key behind a connection.
 *
 * The row goes, rather than being blanked. A disconnected connection keeps its
 * history, its shipments and its tracking; what it does not keep is anything
 * that could still authenticate.
 */
export async function destroyCarrierCredential(input: {
  sellerAccountId: string;
  actor: SellerActor;
  connectionId: string;
}): Promise<void> {
  const connection = await prisma.sellerCarrierConnection.findFirst({
    where: { id: input.connectionId, sellerAccountId: input.sellerAccountId },
    select: { id: true, provider: true },
  });

  if (connection === null) throw notFound('Carrier connection');

  await prisma.$transaction(async (tx) => {
    await tx.sellerCarrierCredential.deleteMany({
      where: { sellerCarrierConnectionId: connection.id },
    });

    await tx.sellerCarrierConnection.update({
      where: { id: connection.id },
      data: {
        state: 'DISCONNECTED',
        disconnectedAt: new Date(),
        lastTestPassedAt: null,
        productionConfirmedAt: null,
      },
    });
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.carrier.credential.destroyed',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'SellerCarrierConnection',
    resourceId: connection.id,
    summary: `Disconnected ${connection.provider} and destroyed its credentials.`,
  });
}

/**
 * Read the plaintext, for the one caller that has to.
 *
 * NOT EXPORTED BEYOND THIS MODULE'S OWN ADAPTER FACTORY. It returns the secret,
 * which is why it is deliberately awkward to reach: there is no route that
 * calls it, no service outside `carrier/` that imports it, and its result is
 * never put on an object that leaves a function.
 *
 * Returns null rather than throwing for an absent credential. "Not configured"
 * is a state this system has a screen for, not a fault.
 */
export async function readCarrierCredential(
  connectionId: string,
): Promise<Record<string, string> | null> {
  const row = await prisma.sellerCarrierCredential.findUnique({
    where: { sellerCarrierConnectionId: connectionId },
    select: { credentialsEnc: true },
  });

  if (row === null) return null;

  try {
    const parsed: unknown = JSON.parse(decryptSecret(row.credentialsEnc, aadFor(connectionId)));

    if (typeof parsed !== 'object' || parsed === null) return null;

    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') output[key] = value;
    }

    return output;
  } catch {
    /*
     * A credential that will not decrypt is a configuration fault, and the
     * exception carries the ciphertext. Swallowed rather than logged: the
     * caller treats null as "unconfigured", the seller sees a connection test
     * fail with a message that names the connection, and nothing writes an
     * envelope into a log file.
     */
    return null;
  }
}

/** Raised where a connection has no usable credential. */
export function credentialUnavailable(provider: CarrierProvider): AppError {
  return new AppError({
    statusCode: 409,
    code: ErrorCode.SELLER_CARRIER_CREDENTIAL_UNAVAILABLE,
    message:
      `The ${provider} credentials for this connection are missing or unreadable. ` +
      'Enter them again on the connection screen.',
    details: [{ code: 'CREDENTIAL_UNAVAILABLE', meta: { provider } }],
  });
}
