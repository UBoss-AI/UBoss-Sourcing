/**
 * How a machine becomes trusted to speak for one seller's books.
 *
 * THE PROBLEM THIS SOLVES
 *
 * TallyPrime runs on a PC in a seller's office. This API runs somewhere else.
 * Something has to connect the two, and every shape of that except one is
 * unsafe:
 *
 *   - This server dialling the seller's machine needs an address, and Tally's
 *     listener has no authentication - an address that works for us works for
 *     anybody who finds it.
 *   - A shared secret typed into both ends is a secret in an email.
 *   - A login on the agent is a second password for the seller to lose.
 *
 * So: the seller, already authenticated in the Seller Hub, presses a button.
 * They get a short code with minutes to live. They walk to the machine and
 * paste it into the agent. The agent trades the code for a long-lived token,
 * once, and the code is dead. From then on the agent authenticates with the
 * token and connects OUTWARD only.
 *
 * WHAT IS STORED
 *
 * Neither the code nor the token. Only their SHA-256 and a short display
 * prefix - the same thing `AuthToken` and the carrier webhook secrets already
 * do here. A hash cannot be turned back into a credential by anybody,
 * including us and including whoever ends up with a database dump, and
 * verification needs nothing more. The plaintext is shown once and never
 * again; a seller who loses it generates another.
 *
 * WHY THE FAILURES ARE ALL THE SAME FAILURE
 *
 * Wrong code, expired code, already-used code and too-many-guesses all answer
 * `SELLER_ERP_PAIRING_INVALID` with one wording. Telling the holder of a bad
 * code which of those it is hands them an oracle: "expired" means the code was
 * real, which is most of the work of guessing one.
 */
import { randomInt } from 'node:crypto';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from '../seller/account.service.js';
import { recordErpAudit } from './audit.service.js';

/**
 * The alphabet a pairing code is drawn from.
 *
 * The same one `generateTemporaryPassword` uses, and for the same reason: this
 * string is read off a screen and retyped on another machine, and `I`, `O`,
 * `0` and `1` are where that goes wrong. 32 characters divides 256 exactly, so
 * a masked random byte selects uniformly - but `randomInt` is used below
 * anyway, which is uniform by construction and does not need the arithmetic to
 * be right.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Characters per group, and how many groups. `K7M2-P9XQ-4RTW`. */
const GROUP_SIZE = 4;
const GROUP_COUNT = 3;

/**
 * Twelve characters from a 32-letter alphabet: 60 bits.
 *
 * Enough that guessing is hopeless even without the attempt cap and the rate
 * limit, both of which apply anyway. Short enough to retype without
 * transcription errors, which is what the alphabet is for.
 */
function generatePairingCode(): string {
  const groups: string[] = [];

  for (let group = 0; group < GROUP_COUNT; group += 1) {
    let chunk = '';
    for (let index = 0; index < GROUP_SIZE; index += 1) {
      // `randomInt` is CSPRNG-backed and rejection-samples internally, so
      // there is no modulo bias to reason about.
      chunk += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    groups.push(chunk);
  }

  return groups.join('-');
}

/**
 * The code as it is compared.
 *
 * Case-folded and stripped of separators, so a seller who types it in lower
 * case, or without the dashes, or with a space where a dash was, still pairs.
 * The stored hash is of the NORMALISED form, so both ends agree.
 */
function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface IssuedPairingCode {
  /** Shown ONCE. Never stored, never logged, never returned again. */
  code: string;
  /** The first group, for telling two open codes apart on screen. */
  codePrefix: string;
  expiresAt: string;
  deviceLabel: string;
}

/**
 * Issue a pairing code for one connection.
 *
 * `INTEGRATION_WRITE` and nothing weaker. This is the grant that lets somebody
 * attach a machine to the seller's books; a Catalogue Manager who can edit a
 * listing must not be able to do it, and the seller role definitions already
 * put this permission on OWNER and ADMIN only.
 */
export async function issuePairingCode(input: {
  membership: SellerMembership;
  connectionId: string;
  deviceLabel: string;
  actorUserId: string | null;
  ipHash: string | null;
  correlationId: string | null;
}): Promise<IssuedPairingCode> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_WRITE);

  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: input.connectionId },
    select: { id: true, sellerAccountId: true, networkMode: true, disabledAt: true },
  });

  assertSellerOwnership(input.membership, connection?.sellerAccountId ?? null, 'ERP connection');
  if (connection === null) throw notFound('ERP connection');

  if (connection.networkMode !== 'BRIDGE') {
    throw badRequest(
      ErrorCode.SELLER_ERP_DIRECT_MODE_REFUSED,
      'This connection talks to Tally directly and does not use a bridge.',
      [{ field: 'connectionId', code: 'NOT_BRIDGE_MODE' }],
    );
  }

  if (connection.disabledAt !== null) {
    throw conflict(
      ErrorCode.SELLER_ERP_NOT_CONFIGURED,
      'This connection is switched off. Switch it on before pairing a machine.',
    );
  }

  /*
   * A ceiling on codes per hour, per seller.
   *
   * The attempt cap burns a code after five wrong guesses, which is worth
   * little if a thousand fresh ones can be minted to guess at. Counted over
   * the whole seller rather than per connection, because the limit is about
   * the credential-minting capability and not about any one connection.
   */
  const since = new Date(Date.now() - 60 * 60 * 1000);

  const recent = await prisma.sellerErpPairingCode.count({
    where: { sellerAccountId: input.membership.sellerAccountId, createdAt: { gte: since } },
  });

  if (recent >= env.SELLER_ERP_PAIRING_RATE_PER_HOUR) {
    throw conflict(
      ErrorCode.RATE_LIMITED,
      'Too many pairing codes have been generated for this account in the last hour. Try again shortly.',
    );
  }

  const label = input.deviceLabel.trim().slice(0, 120);

  if (label.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the machine a name you will recognise.', [
      { field: 'deviceLabel', code: 'REQUIRED' },
    ]);
  }

  const code = generatePairingCode();
  const normalised = normaliseCode(code);
  const expiresAt = new Date(Date.now() + env.SELLER_ERP_PAIRING_TTL_MINUTES * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    /*
     * Any earlier unused code for this connection is expired first.
     *
     * One live code at a time. Two outstanding codes means two machines can
     * pair, and the seller who generated a second because the first "did not
     * work" has no idea the first is still good. Expired rather than deleted,
     * so the trail of how many were issued survives.
     */
    await tx.sellerErpPairingCode.updateMany({
      where: {
        connectionId: input.connectionId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { expiresAt: new Date() },
    });

    await tx.sellerErpPairingCode.create({
      data: {
        id: newId(),
        sellerAccountId: input.membership.sellerAccountId,
        connectionId: input.connectionId,
        codeHash: sha256Hex(normalised),
        codePrefix: normalised.slice(0, GROUP_SIZE),
        expiresAt,
        deviceLabel: label,
        createdByProfileId: input.membership.customerProfileId,
      },
    });

    await tx.sellerErpConnection.update({
      where: { id: input.connectionId },
      data: { state: 'AWAITING_PAIRING', stateChangedAt: new Date() },
    });
  });

  await recordErpAudit({
    sellerAccountId: input.membership.sellerAccountId,
    connectionId: input.connectionId,
    action: 'seller_erp.pairing_code_issued',
    actor: { type: 'CUSTOMER', userId: input.actorUserId, label: input.membership.displayName },
    summary: `A pairing code was issued for "${label}".`,
    // The PREFIX, never the code. Enough to match this row against the one on
    // screen; useless to anybody who reads the audit table.
    meta: { deviceLabel: label, codePrefix: normalised.slice(0, GROUP_SIZE) },
    ipHash: input.ipHash,
    correlationId: input.correlationId,
  });

  return {
    code,
    codePrefix: normalised.slice(0, GROUP_SIZE),
    expiresAt: expiresAt.toISOString(),
    deviceLabel: label,
  };
}

export interface PairingResult {
  /** Shown to the AGENT once, in its own response. Never stored in plaintext. */
  token: string;
  deviceId: string;
  connectionId: string;
  sellerAccountId: string;
  expiresAt: string | null;
  /** So the agent can label itself the way the seller labelled it. */
  deviceLabel: string;
}

/**
 * Trade a pairing code for a bridge token.
 *
 * UNAUTHENTICATED by necessity: the agent has no credential yet, and the code
 * IS the credential for this one call. Everything that makes that safe is
 * here - the code is short-lived, single-use, attempt-capped, rate-limited at
 * issue, and consumed inside a transaction that cannot run twice.
 *
 * The consume is a CONDITIONAL UPDATE rather than a read-then-write. Two
 * agents racing the same code - or one agent retrying after a timeout that
 * actually succeeded - must produce one device, not two, and on MariaDB 10.4
 * with no `SELECT ... FOR UPDATE SKIP LOCKED` the affected-row count is what
 * decides who won. Exactly the lease pattern `JobQueue` uses.
 */
export async function redeemPairingCode(input: {
  code: string;
  agentVersion: string | null;
  osLabel: string | null;
  /** What the agent says its local Tally address is. RECORDED, never dialled. */
  reportedTallyAddress: string | null;
  ipHash: string | null;
  correlationId: string | null;
}): Promise<PairingResult> {
  const normalised = normaliseCode(input.code);

  // Refused before touching the database. A "code" of the wrong shape is not a
  // wrong guess worth counting against anything - it is a scanner.
  if (normalised.length !== GROUP_SIZE * GROUP_COUNT) throw pairingRefused();

  const row = await prisma.sellerErpPairingCode.findUnique({
    where: { codeHash: sha256Hex(normalised) },
    select: {
      id: true,
      sellerAccountId: true,
      connectionId: true,
      expiresAt: true,
      consumedAt: true,
      attemptCount: true,
      deviceLabel: true,
    },
  });

  /*
   * A code nobody issued. Counted against nothing, because there is nothing to
   * count it against - and the refusal is the same sentence a real-but-expired
   * code gets, so the two are indistinguishable from outside.
   */
  if (row === null) throw pairingRefused();

  if (row.consumedAt !== null || row.expiresAt <= new Date()) {
    throw pairingRefused();
  }

  if (row.attemptCount >= env.SELLER_ERP_PAIRING_MAX_ATTEMPTS) {
    throw pairingRefused();
  }

  const { token, tokenHash } = generateToken(32);
  const deviceId = newId();
  const expiresAt = new Date(
    Date.now() + env.SELLER_ERP_BRIDGE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  const paired = await prisma.$transaction(async (tx) => {
    /*
     * The race is settled HERE.
     *
     * `consumedAt: null` in the where clause plus the affected-row count is
     * the whole guarantee: two agents presenting the same code in the same
     * second both reach this, one updates a row and one updates none, and the
     * loser is refused exactly as if the code had already been used - which it
     * now has.
     */
    const claimed = await tx.sellerErpPairingCode.updateMany({
      where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date(), consumedByDeviceId: deviceId },
    });

    if (claimed.count !== 1) return null;

    /*
     * Any earlier device on this connection is revoked.
     *
     * One live bridge per connection. A seller who re-pairs has moved
     * machines, or is replacing one that was lost - and a lost machine still
     * holding a valid token is the thing pairing again is meant to fix.
     * Revoked rather than deleted: the row is the evidence that a machine was
     * once trusted, and the tasks it completed point at it.
     */
    await tx.sellerErpBridgeDevice.updateMany({
      where: { connectionId: row.connectionId, state: { in: ['PENDING', 'ACTIVE', 'OFFLINE'] } },
      data: {
        state: 'REVOKED',
        revokedAt: new Date(),
        revokedReason: 'Replaced by a newly paired machine.',
      },
    });

    await tx.sellerErpBridgeDevice.create({
      data: {
        id: deviceId,
        sellerAccountId: row.sellerAccountId,
        connectionId: row.connectionId,
        label: row.deviceLabel,
        state: 'ACTIVE',
        tokenHash,
        // Enough to identify the device on screen, far short of enough to
        // authenticate with.
        tokenPrefix: token.slice(0, 8),
        tokenExpiresAt: expiresAt,
        lastHeartbeatAt: new Date(),
        lastSeenIpHash: input.ipHash,
        agentVersion: input.agentVersion?.slice(0, 32) ?? null,
        osLabel: input.osLabel?.slice(0, 64) ?? null,
        // Recorded so the seller can confirm the agent found the right Tally.
        // This API never connects to it - see the schema's note.
        reportedTallyAddress: input.reportedTallyAddress?.slice(0, 255) ?? null,
      },
    });

    // The bridge is up; whether TALLY is up is a separate question that only a
    // test can answer, so the connection does not jump to CONNECTED here.
    await tx.sellerErpConnection.update({
      where: { id: row.connectionId },
      data: { state: 'TALLY_UNAVAILABLE', stateChangedAt: new Date(), stateReason: null },
    });

    return true;
  });

  if (paired === null) throw pairingRefused();

  await recordErpAudit({
    sellerAccountId: row.sellerAccountId,
    connectionId: row.connectionId,
    action: 'seller_erp.paired',
    // SYSTEM, not CUSTOMER: nobody was signed in for this call. The person who
    // caused it is on the `pairing_code_issued` row a few minutes earlier, and
    // the two are joined by the connection and the label.
    actor: { type: 'SYSTEM', label: 'Glovia Tally Bridge' },
    summary: `"${row.deviceLabel}" was paired and can now exchange work with Tally.`,
    meta: {
      deviceId,
      deviceLabel: row.deviceLabel,
      tokenPrefix: token.slice(0, 8),
      agentVersion: input.agentVersion ?? null,
      osLabel: input.osLabel ?? null,
    },
    ipHash: input.ipHash,
    correlationId: input.correlationId,
  });

  return {
    token,
    deviceId,
    connectionId: row.connectionId,
    sellerAccountId: row.sellerAccountId,
    expiresAt: expiresAt.toISOString(),
    deviceLabel: row.deviceLabel,
  };
}

/**
 * Count a failed guess against a code that EXISTS.
 *
 * Called by the route after a refusal, outside the main path, because the
 * refusal itself must not reveal whether there was a row to count against. A
 * code that does not exist increments nothing and is refused identically.
 */
export async function recordPairingAttempt(code: string): Promise<void> {
  const normalised = normaliseCode(code);
  if (normalised.length !== GROUP_SIZE * GROUP_COUNT) return;

  await prisma.sellerErpPairingCode.updateMany({
    where: { codeHash: sha256Hex(normalised), consumedAt: null },
    data: { attemptCount: { increment: 1 } },
  });
}

function pairingRefused(): ReturnType<typeof badRequest> {
  return badRequest(
    ErrorCode.SELLER_ERP_PAIRING_INVALID,
    'That pairing code is not usable. Generate a new one in the Seller Hub and try again.',
    [{ field: 'code', code: 'INVALID' }],
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface BridgeDeviceView {
  id: string;
  label: string;
  state: string;
  tokenPrefix: string;
  tokenExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  /** True only while the heartbeat is inside the freshness window. */
  isOnline: boolean;
  agentVersion: string | null;
  osLabel: string | null;
  reportedTallyAddress: string | null;
  tasksCompleted: number;
  tasksFailed: number;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

/** Every machine ever paired to this connection, newest first. */
export async function listBridgeDevices(
  membership: SellerMembership,
  connectionId: string,
): Promise<BridgeDeviceView[]> {
  assertSellerPermission(membership, SellerPermission.INTEGRATION_READ);

  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: connectionId },
    select: { sellerAccountId: true },
  });
  assertSellerOwnership(membership, connection?.sellerAccountId ?? null, 'ERP connection');

  const devices = await prisma.sellerErpBridgeDevice.findMany({
    where: { connectionId },
    orderBy: { createdAt: 'desc' },
  });

  const cutoff = Date.now() - 180 * 1000;

  return devices.map((device) => ({
    id: device.id,
    label: device.label,
    state: device.state,
    tokenPrefix: device.tokenPrefix,
    tokenExpiresAt: device.tokenExpiresAt?.toISOString() ?? null,
    lastHeartbeatAt: device.lastHeartbeatAt?.toISOString() ?? null,
    isOnline:
      device.state === 'ACTIVE' &&
      device.lastHeartbeatAt !== null &&
      device.lastHeartbeatAt.getTime() >= cutoff,
    agentVersion: device.agentVersion,
    osLabel: device.osLabel,
    reportedTallyAddress: device.reportedTallyAddress,
    tasksCompleted: device.tasksCompleted,
    tasksFailed: device.tasksFailed,
    revokedAt: device.revokedAt?.toISOString() ?? null,
    revokedReason: device.revokedReason,
    createdAt: device.createdAt.toISOString(),
  }));
}

/**
 * Take a machine's trust away, immediately.
 *
 * The token stops working on the next request, because every authenticated
 * bridge call re-reads the device row - there is no cached session and no
 * grace period. That is the point of a revocation: a seller who has lost a
 * laptop presses this and the laptop is out, not out in an hour.
 *
 * Any work that machine had claimed is released rather than failed. It was
 * never attempted, the lease is gone, and the next paired machine picks it up.
 */
export async function revokeBridgeDevice(input: {
  membership: SellerMembership;
  deviceId: string;
  reason: string | null;
  actorUserId: string | null;
  ipHash: string | null;
  correlationId: string | null;
}): Promise<void> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_WRITE);

  const device = await prisma.sellerErpBridgeDevice.findUnique({
    where: { id: input.deviceId },
    select: { id: true, sellerAccountId: true, connectionId: true, label: true, state: true },
  });

  assertSellerOwnership(input.membership, device?.sellerAccountId ?? null, 'Bridge device');
  if (device === null) throw notFound('Bridge device');

  if (device.state === 'REVOKED') {
    throw conflict(ErrorCode.CONFLICT, 'That machine has already been revoked.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.sellerErpBridgeDevice.update({
      where: { id: device.id },
      data: {
        state: 'REVOKED',
        revokedAt: new Date(),
        revokedReason: input.reason?.slice(0, 255) ?? 'Revoked by the seller.',
      },
    });

    /*
     * Work it was holding goes back in the queue.
     *
     * Released, not failed. The task was claimed and not attempted - releasing
     * it costs nothing and loses nothing, while failing it would consume an
     * attempt and eventually dead-letter an accounting event because somebody
     * replaced a PC.
     */
    await tx.sellerErpSyncJob.updateMany({
      where: { connectionId: device.connectionId, status: 'IN_FLIGHT', leaseOwner: device.id },
      data: { status: 'PENDING', leaseOwner: null, leaseExpiresAt: null },
    });

    const stillPaired = await tx.sellerErpBridgeDevice.count({
      where: { connectionId: device.connectionId, state: { in: ['ACTIVE', 'OFFLINE'] } },
    });

    if (stillPaired === 0) {
      await tx.sellerErpConnection.update({
        where: { id: device.connectionId },
        data: {
          state: 'BRIDGE_REQUIRED',
          stateChangedAt: new Date(),
          stateReason: 'The paired machine was revoked. Pair another to resume.',
        },
      });
    }
  });

  await recordErpAudit({
    sellerAccountId: input.membership.sellerAccountId,
    connectionId: device.connectionId,
    action: 'seller_erp.revoked',
    actor: { type: 'CUSTOMER', userId: input.actorUserId, label: input.membership.displayName },
    summary: `"${device.label}" was revoked and can no longer reach this account.`,
    meta: { deviceId: device.id, deviceLabel: device.label, reason: input.reason ?? null },
    ipHash: input.ipHash,
    correlationId: input.correlationId,
  });
}

// ---------------------------------------------------------------------------
// Authenticating a bridge
// ---------------------------------------------------------------------------

export interface AuthenticatedBridge {
  deviceId: string;
  sellerAccountId: string;
  connectionId: string;
  label: string;
}

/**
 * Who is this bearer token, and may it still act?
 *
 * Every bridge request goes through here and re-reads the row. No session, no
 * cache, no grace: a revocation takes effect on the next call, and a token
 * past its expiry stops working without anybody having to sweep it.
 *
 * Looked up BY HASH, so nothing anywhere holds the token itself. A database
 * dump contains no usable credential.
 */
export async function authenticateBridge(token: string): Promise<AuthenticatedBridge> {
  // Refused before the query for anything that is not plausibly one of ours.
  // `generateToken(32)` produces 43 base64url characters.
  if (token.length < 20 || token.length > 200) throw bridgeUnauthorised();

  const device = await prisma.sellerErpBridgeDevice.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: {
      id: true,
      sellerAccountId: true,
      connectionId: true,
      label: true,
      state: true,
      tokenExpiresAt: true,
      connection: { select: { disabledAt: true } },
    },
  });

  if (device === null) throw bridgeUnauthorised();
  if (device.state === 'REVOKED' || device.state === 'PENDING') throw bridgeUnauthorised();
  if (device.tokenExpiresAt !== null && device.tokenExpiresAt <= new Date()) {
    throw bridgeUnauthorised();
  }

  // A connection the seller switched off stops accepting its own agent. Not a
  // revocation - the device is intact and resumes when the connection does -
  // but nothing may be exchanged while it is off.
  if (device.connection.disabledAt !== null) throw bridgeUnauthorised();

  return {
    deviceId: device.id,
    sellerAccountId: device.sellerAccountId,
    connectionId: device.connectionId,
    label: device.label,
  };
}

function bridgeUnauthorised(): ReturnType<typeof badRequest> {
  return badRequest(
    ErrorCode.SELLER_ERP_BRIDGE_UNAUTHORISED,
    'This bridge is not authorised. Pair the machine again in the Seller Hub.',
    [{ code: 'UNAUTHORISED' }],
  );
}

/**
 * Issue a fresh token to an already-authenticated bridge.
 *
 * Rotation, and the agent does it on its own well before expiry. Kept simple
 * on purpose: one token per device, replaced atomically, with the old hash
 * gone the instant the new one lands. There is no overlap window, because an
 * agent that has just been handed a new token has no reason to use the old one
 * and a window is a second live credential for the duration.
 */
export async function rotateBridgeToken(bridge: AuthenticatedBridge): Promise<{
  token: string;
  expiresAt: string;
}> {
  const { token, tokenHash } = generateToken(32);
  const expiresAt = new Date(
    Date.now() + env.SELLER_ERP_BRIDGE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  await prisma.sellerErpBridgeDevice.update({
    where: { id: bridge.deviceId },
    data: {
      tokenHash,
      tokenPrefix: token.slice(0, 8),
      tokenIssuedAt: new Date(),
      tokenRotatedAt: new Date(),
      tokenExpiresAt: expiresAt,
    },
  });

  await recordErpAudit({
    sellerAccountId: bridge.sellerAccountId,
    connectionId: bridge.connectionId,
    action: 'seller_erp.token_rotated',
    actor: { type: 'SYSTEM', label: 'Glovia Tally Bridge' },
    summary: `"${bridge.label}" rotated its credential.`,
    meta: { deviceId: bridge.deviceId, tokenPrefix: token.slice(0, 8) },
  });

  return { token, expiresAt: expiresAt.toISOString() };
}
