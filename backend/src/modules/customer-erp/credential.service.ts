/**
 * The vault.
 *
 * Every secret belonging to a buyer's ERP connection is written and read here
 * and nowhere else. That is the whole design: one module means one place to
 * audit, one place to change when a deployment moves to a managed KMS, and one
 * place where a mistake could happen instead of forty.
 *
 * FOUR RULES, NONE OF WHICH HAS AN EXCEPTION
 *
 *   1. **Nothing in this file returns a secret to an HTTP response.** The only
 *      exported reader is `openCredential`, whose result is consumed inside a
 *      request builder and never travels further. Every view shape in this
 *      feature carries `hint` instead - `X-API-Key: sk_live...9f2a` - which is
 *      derived at write time and is safe to render.
 *
 *   2. **Ciphertext is bound to its row.** AAD is
 *      `customer_erp_credential:<connectionId>:<kind>`, so an envelope copied
 *      into another connection - by a support script, a restore, or somebody
 *      curious - fails authentication rather than decrypting into a working
 *      credential for a system it was never issued for.
 *
 *   3. **A save that omits a secret field keeps the stored one.** That is what
 *      makes a masked edit form work: the buyer changes the timeout, the form
 *      sends no client secret because it never had one to send, and the secret
 *      survives. Sending an explicit empty string is how you clear it, and that
 *      is a deliberate act rather than the default.
 *
 *   4. **Disconnecting destroys them.** Not soft-deleted, not retained "for the
 *      audit trail" - the audit trail records that a credential existed and was
 *      revoked, which is the part that has evidential value. Keeping the
 *      credential itself would mean a disconnected connection is still a
 *      standing authority against somebody's SAP system.
 *
 * ON ENVELOPE ENCRYPTION AND KMS
 *
 * `encryptSecret`/`decryptSecret` in `infra/crypto.ts` are AES-256-GCM under a
 * key this process holds, taken from `SECRETS_ENCRYPTION_KEY`. That is envelope
 * encryption with a single, statically-provisioned data key, and the envelope
 * carries a `v1:` version prefix precisely so a deployment can move to a
 * managed KMS - wrapping per-row data keys, rotating the master - without
 * rewriting the rows it already has. `CredentialEnvelope` below is the seam:
 * a KMS-backed implementation replaces these two functions and nothing else in
 * the feature changes.
 */
import type { CustomerErpCredentialKind } from '../../generated/prisma/enums.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

export type CredentialKind =
  | 'PRIMARY'
  | 'OAUTH_TOKENS'
  | 'WEBHOOK_SIGNING'
  | 'CLIENT_CERTIFICATE';

/**
 * What a PRIMARY payload can hold.
 *
 * One encrypted JSON object rather than a column each, because the shape
 * depends on the authentication method and half the columns would always be
 * null. The cost is that reading one field decrypts all of them, which is the
 * right trade: they are read together, in one place, for the duration of one
 * request.
 */
export interface PrimaryCredential {
  /** API_KEY */
  apiKey?: string;
  /** BEARER_TOKEN */
  bearerToken?: string;
  /** BASIC */
  username?: string;
  password?: string;
  /** Both OAuth grants. For monday the SECRET is the operator's, not stored here. */
  clientId?: string;
  clientSecret?: string;
  /** MONDAY_PERSONAL_TOKEN */
  personalToken?: string;
  /**
   * Header name -> value, for an ERP wanting a second secret alongside the
   * first: a subscription key, a gateway token. Kept apart from the
   * connection's `customHeadersJson`, which the API returns.
   */
  secretHeaders?: Record<string, string>;
}

/** What an OAuth grant came back with. */
export interface OAuthTokenCredential {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  /** Epoch milliseconds. Mirrored to the row's `expiresAt` for the sweep. */
  expiresAtMs?: number;
  scope?: string;
}

export interface WebhookSigningCredential {
  /** The HMAC-SHA256 key inbound deliveries are verified against. */
  signingSecret: string;
}

export interface ClientCertificateCredential {
  certificatePem: string;
  privateKeyPem: string;
  passphrase?: string;
}

export type CredentialPayload =
  | PrimaryCredential
  | OAuthTokenCredential
  | WebhookSigningCredential
  | ClientCertificateCredential;

/** AAD. Binds the ciphertext to the row that holds it. */
export function credentialAad(connectionId: string, kind: CredentialKind): string {
  return `customer_erp_credential:${connectionId}:${kind}`;
}

/**
 * The seam a KMS implementation replaces.
 *
 * Two functions and a version string. A deployment moving to AWS KMS, Azure Key
 * Vault or GCP KMS implements this interface over per-row wrapped data keys and
 * registers it; nothing else in the feature knows the difference, because
 * nothing else in the feature calls `encryptSecret` directly.
 */
export interface CredentialEnvelope {
  seal(plaintext: string, aad: string): string;
  open(envelope: string, aad: string): string;
}

const localEnvelope: CredentialEnvelope = {
  seal: (plaintext, aad) => encryptSecret(plaintext, aad),
  open: (envelope, aad) => decryptSecret(envelope, aad),
};

let envelope: CredentialEnvelope = localEnvelope;

/**
 * Install a different envelope implementation.
 *
 * Exported for the KMS case and for tests that need a failing vault. Called at
 * boot, once, before anything reads a credential - there is deliberately no
 * per-request selection, because a system that can be pointed at two vaults can
 * be pointed at the wrong one.
 */
export function useCredentialEnvelope(implementation: CredentialEnvelope): void {
  envelope = implementation;
}

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

/**
 * What a screen shows in place of the secret.
 *
 * Enough to recognise WHICH key is configured - a buyer with a live key and a
 * test key needs to tell them apart - and never enough to use one. `maskSecret`
 * keeps a short prefix and the last four characters; anything shorter than nine
 * characters is shown as `****` in full, because a prefix of a short secret is
 * most of it.
 */
export function hintFor(kind: CredentialKind, payload: CredentialPayload): string | null {
  switch (kind) {
    case 'PRIMARY': {
      const primary = payload as PrimaryCredential;

      if (primary.apiKey !== undefined) return maskSecret(primary.apiKey);
      if (primary.bearerToken !== undefined) return `Bearer ${maskSecret(primary.bearerToken)}`;
      if (primary.personalToken !== undefined) return maskSecret(primary.personalToken);
      if (primary.clientId !== undefined) {
        // The client ID is not a secret, so it is shown in full - it is the
        // one part of an OAuth pair a buyer can check against their own ERP's
        // configuration screen without going and finding a password manager.
        return `client ${primary.clientId.slice(0, 48)}`;
      }
      if (primary.username !== undefined) return `${primary.username.slice(0, 48)} / ••••••`;
      return null;
    }
    case 'OAUTH_TOKENS': {
      const tokens = payload as OAuthTokenCredential;
      return `access ${maskSecret(tokens.accessToken)}${
        tokens.refreshToken === undefined ? '' : ' + refresh'
      }`;
    }
    case 'WEBHOOK_SIGNING':
      return maskSecret((payload as WebhookSigningCredential).signingSecret);
    case 'CLIENT_CERTIFICATE':
      // Never the certificate's bytes, not even a prefix: the point of the hint
      // is recognition, and a PEM header is identical on every certificate ever
      // issued.
      return 'client certificate installed';
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface SaveCredentialInput {
  connectionId: string;
  kind: CredentialKind;
  payload: CredentialPayload;
  /** Where the secret's own lifetime is knowable. */
  expiresAt?: Date | null;
  grantedScope?: string | null;
}

type CredentialClient = Pick<typeof prisma, 'customerErpCredential'>;

/**
 * Write or replace one credential.
 *
 * Whole-payload replacement rather than a merge, and that is the safer shape:
 * merging would mean a form that stopped sending `password` left the old one in
 * place beside a new `username`, producing a pair that never existed. Callers
 * that want "keep what is there" call `mergePrimary` below, which is explicit
 * about it.
 */
export async function saveCredential(
  input: SaveCredentialInput,
  tx?: unknown,
): Promise<void> {
  const client = (tx as CredentialClient | undefined) ?? prisma;

  const sealed = envelope.seal(
    JSON.stringify(input.payload),
    credentialAad(input.connectionId, input.kind),
  );

  const hint = hintFor(input.kind, input.payload);

  await client.customerErpCredential.upsert({
    where: {
      connectionId_kind: { connectionId: input.connectionId, kind: input.kind },
    },
    create: {
      id: newId(),
      connectionId: input.connectionId,
      kind: input.kind,
      payloadEnc: sealed,
      hint,
      expiresAt: input.expiresAt ?? null,
      grantedScope: input.grantedScope ?? null,
    },
    update: {
      payloadEnc: sealed,
      hint,
      expiresAt: input.expiresAt ?? null,
      grantedScope: input.grantedScope ?? null,
      rotatedAt: new Date(),
    },
  });
}

/**
 * Apply only the secret fields a form actually sent, keeping the rest.
 *
 * Rule 3 from this file's header, in one function. `undefined` means "the form
 * did not send this, keep what is stored"; an empty string means "the person
 * cleared it, remove it". Those two have to be different, and a `??` would
 * collapse them.
 */
export async function mergePrimaryCredential(
  connectionId: string,
  patch: Partial<Record<keyof PrimaryCredential, string | undefined>> & {
    secretHeaders?: Record<string, string> | undefined;
  },
  tx?: unknown,
): Promise<{ changed: boolean }> {
  const existing = (await openCredential<PrimaryCredential>(connectionId, 'PRIMARY')) ?? {};
  const next: PrimaryCredential = { ...existing };
  let changed = false;

  const scalarKeys = [
    'apiKey',
    'bearerToken',
    'username',
    'password',
    'clientId',
    'clientSecret',
    'personalToken',
  ] as const;

  for (const key of scalarKeys) {
    const value = patch[key];
    if (value === undefined) continue;

    changed = true;
    if (value.length === 0) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  if (patch.secretHeaders !== undefined) {
    changed = true;
    if (Object.keys(patch.secretHeaders).length === 0) {
      delete next.secretHeaders;
    } else {
      next.secretHeaders = patch.secretHeaders;
    }
  }

  if (!changed) return { changed: false };

  // Everything cleared is not an empty credential, it is no credential - and a
  // row holding `{}` would make `openCredential` answer "configured" when
  // nothing is.
  if (Object.keys(next).length === 0) {
    await deleteCredential(connectionId, 'PRIMARY', tx);
    return { changed: true };
  }

  await saveCredential({ connectionId, kind: 'PRIMARY', payload: next }, tx);
  return { changed: true };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Decrypt one credential, for the duration of one call.
 *
 * Returns null rather than throwing when there is none: a connection may
 * legitimately be mid-setup, and the request that follows will fail against the
 * ERP with a 401 that says so far more usefully than an exception here would.
 *
 * Returns null ALSO when the ciphertext will not open - a rotated key, a row
 * restored from another environment - and logs it as the operational fault it
 * is. What it must never do is let the underlying error escape: those messages
 * hint at key state, and this one is reached from a path that reports failures
 * to a customer.
 */
export async function openCredential<T extends CredentialPayload>(
  connectionId: string,
  kind: CredentialKind,
): Promise<T | null> {
  const row = await prisma.customerErpCredential.findUnique({
    where: { connectionId_kind: { connectionId, kind } },
  });

  if (row === null) return null;

  try {
    return JSON.parse(envelope.open(row.payloadEnc, credentialAad(connectionId, kind))) as T;
  } catch (error) {
    logger.error(
      { connectionId, kind, err: error instanceof Error ? error.name : 'unknown' },
      'a buyer ERP credential could not be decrypted; treating it as absent',
    );
    return null;
  }
}

/** What a screen may know: that a credential exists, and roughly which one. */
export interface CredentialSummary {
  kind: CredentialKind;
  hint: string | null;
  expiresAt: string | null;
  grantedScope: string | null;
  rotatedAt: string | null;
  /** True when `expiresAt` is in the past. The dashboard's amber light. */
  expired: boolean;
}

export async function summariseCredentials(
  connectionId: string,
): Promise<CredentialSummary[]> {
  const rows = await prisma.customerErpCredential.findMany({
    where: { connectionId },
    orderBy: { kind: 'asc' },
  });

  const now = Date.now();

  return rows.map((row) => ({
    kind: row.kind,
    hint: row.hint,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    grantedScope: row.grantedScope,
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
  }));
}

/** Whether a kind is present, without decrypting it. */
export async function hasCredential(
  connectionId: string,
  kind: CredentialKind,
): Promise<boolean> {
  const row = await prisma.customerErpCredential.findUnique({
    where: { connectionId_kind: { connectionId, kind } },
    select: { id: true },
  });

  return row !== null;
}

// ---------------------------------------------------------------------------
// Destroying
// ---------------------------------------------------------------------------

export async function deleteCredential(
  connectionId: string,
  kind: CredentialKind,
  tx?: unknown,
): Promise<void> {
  const client = (tx as CredentialClient | undefined) ?? prisma;

  await client.customerErpCredential
    .delete({ where: { connectionId_kind: { connectionId, kind } } })
    .catch(() => undefined);
}

/**
 * Destroy every secret a connection holds.
 *
 * Called on disconnect and on delete. Rule 4: the audit trail records that a
 * credential existed and was revoked, which is the part with evidential value.
 * Keeping the credential itself would mean a disconnected connection is still a
 * standing authority against somebody's SAP system, waiting for the next bug
 * that forgets to check the state.
 */
export async function purgeCredentials(connectionId: string, tx?: unknown): Promise<number> {
  const client = (tx as CredentialClient | undefined) ?? prisma;

  const result = await client.customerErpCredential.deleteMany({ where: { connectionId } });
  return result.count;
}

/** Convert the database enum to the union this module uses. */
export function toCredentialKind(kind: CustomerErpCredentialKind): CredentialKind {
  return kind;
}
