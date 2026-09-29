/**
 * Evidence on a dispute: photographs, delivery notes, inspection reports.
 *
 * The support ticket's upload pipeline, reused rather than copied: the bytes
 * decide the type (`sniff`), the malware scanner looks before anything is
 * stored (`scan`), the object is private at a random key, and a download is a
 * five-minute, single-use link minted for one signed-in person.
 *
 * Who may add or open a file is exactly who may open the dispute: the buyer
 * and the seller through `ownDisputeId`, staff holding `dispute.view` (and
 * `dispute.manage` to add). Evidence is seen by both parties - a seller cannot
 * answer a photograph they cannot see - and each file says whose it is.
 *
 * Audited both ways, by id, type and size - never the file's name.
 */
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { safeFileName } from '../../domain/chat-text.js';
import { acceptsMessages } from '../../domain/dispute-state.js';
import { AppError, ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  createAdminNotification,
} from '../notifications/admin-notification.service.js';
import {
  assertAttachmentsAvailable,
  scan,
  servable,
  sniff,
} from '../support/support-attachment.service.js';
import {
  consoleDisputePath,
  ownDisputeId,
  requirePermission,
  requireSellerCanRespond,
  writeEvent,
  type PartyActor,
  type StaffActor,
} from './dispute-common.js';

/** How many files one dispute may carry, all parties together. */
export const DISPUTE_FILES_PER_DISPUTE = 20;

const LINK_TTL_MS = 5 * 60_000;

type Uploader = PartyActor | StaffActor;

async function disputeIdFor(actor: Uploader, reference: string | null, id: string | null): Promise<string> {
  if (actor.side === 'STAFF') {
    requirePermission(actor, Permission.DISPUTE_VIEW);
    const row = await prisma.dispute.findUnique({ where: { id: id ?? '' }, select: { id: true } });
    if (row === null) throw notFound('Dispute');
    return row.id;
  }
  return ownDisputeId(actor, reference ?? '');
}

/**
 * Add one file. `reference` for a party, `id` for staff.
 */
export async function uploadDisputeEvidence(
  actor: Uploader,
  target: { reference?: string; id?: string },
  input: { bytes: Buffer; fileName: string },
) {
  if (actor.side === 'STAFF') requirePermission(actor, Permission.DISPUTE_MANAGE);
  if (actor.side === 'SELLER') requireSellerCanRespond(actor);
  assertAttachmentsAvailable();
  const disputeId = await disputeIdFor(actor, target.reference ?? null, target.id ?? null);

  const dispute = await prisma.dispute.findUniqueOrThrow({
    where: { id: disputeId },
    select: { reference: true, status: true, _count: { select: { attachments: true } } },
  });
  if (!acceptsMessages(dispute.status)) {
    throw conflict(ErrorCode.DISPUTE_TRANSITION_NOT_ALLOWED, 'This dispute is closed and takes no more evidence.', [
      { code: 'CLOSED', meta: { from: dispute.status } },
    ]);
  }
  if (dispute._count.attachments >= DISPUTE_FILES_PER_DISPUTE) {
    throw new AppError({
      statusCode: 409,
      code: ErrorCode.SUPPORT_ATTACHMENT_LIMIT_REACHED,
      message: `A dispute can carry up to ${String(DISPUTE_FILES_PER_DISPUTE)} files.`,
      details: [{ code: 'LIMIT', meta: { limit: DISPUTE_FILES_PER_DISPUTE } }],
    });
  }
  if (input.bytes.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The file is empty.', [{ field: 'file', code: 'EMPTY' }]);
  }
  if (input.bytes.length > env.SUPPORT_ATTACHMENT_MAX_BYTES) {
    throw badRequest(
      ErrorCode.MEDIA_TOO_LARGE,
      `Files can be up to ${(env.SUPPORT_ATTACHMENT_MAX_BYTES / 1_048_576).toFixed(0)} MB.`,
      [{ field: 'file', code: 'FILE_TOO_LARGE', meta: { maxBytes: env.SUPPORT_ATTACHMENT_MAX_BYTES } }],
    );
  }

  const sniffed = sniff(input.bytes);
  const scanState = await scan(input.bytes);
  if (!servable(scanState)) assertAttachmentsAvailable();

  const stored = await storage.put(input.bytes, sniffed.mimeType, sniffed.extension, 'private');
  const id = newId();
  const fileName = safeFileName(input.fileName, `evidence.${sniffed.extension}`);
  const party = actor.side;

  try {
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.disputeAttachment.create({
        data: {
          id,
          disputeId,
          party,
          storageKey: stored.storageKey,
          fileName,
          contentType: stored.mimeType,
          kind: sniffed.kind,
          byteSize: stored.sizeBytes,
          contentHash: createHash('sha256').update(input.bytes).digest('hex'),
          scanState,
          uploadedByUserId: actor.userId,
        },
      });
      await writeEvent(tx, {
        disputeId,
        kind: 'EVIDENCE_ADDED',
        party,
        visibleToBuyer: true,
        visibleToSeller: true,
        actorUserId: actor.userId,
        toValue: id,
        createdAt: now,
      });
      await tx.dispute.update({ where: { id: disputeId }, data: { lastActivityAt: now } });
      await recordAudit(
        {
          action: AuditAction.DISPUTE_EVIDENCE_UPLOADED,
          resourceType: 'dispute',
          resourceId: disputeId,
          actorType: party === 'STAFF' ? 'ADMIN' : 'CUSTOMER',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          after: { attachmentId: id, party, contentType: stored.mimeType, byteSize: stored.sizeBytes, scanState },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
      if (party !== 'STAFF') {
        await createAdminNotification(
          {
            kind: AdminNotificationKind.DISPUTE_ACTIVITY,
            variables: { reference: dispute.reference, what: 'EVIDENCE' },
            linkPath: consoleDisputePath(disputeId),
            requiredPermission: Permission.DISPUTE_VIEW,
            relatedType: 'dispute',
            relatedId: disputeId,
          },
          tx,
        );
      }
    });
  } catch (error) {
    await storage.delete(stored.storageKey).catch(() => undefined);
    throw error;
  }

  return {
    attachment: {
      id,
      party,
      fileName,
      contentType: stored.mimeType,
      kind: sniffed.kind,
      byteSize: stored.sizeBytes,
      createdAt: new Date().toISOString(),
    },
  };
}

function tokenHash(side: string, attachmentId: string, token: string): string {
  return sha256Hex(`dispute-evidence:${side}:${attachmentId}:${token}`);
}

async function attachmentFor(actor: Uploader, target: { reference?: string; id?: string }, attachmentId: string) {
  const disputeId = await disputeIdFor(actor, target.reference ?? null, target.id ?? null);
  const file = await prisma.disputeAttachment.findFirst({
    where: { id: attachmentId, disputeId },
    select: { id: true, disputeId: true, storageKey: true, fileName: true, contentType: true, scanState: true },
  });
  if (file === null) throw notFound('Attachment');
  if (!servable(file.scanState)) {
    throw conflict(ErrorCode.SUPPORT_ATTACHMENTS_UNAVAILABLE, 'This installation does not serve files that have not been scanned for malware.', [
      { code: 'NO_SCANNER' },
    ]);
  }
  return file;
}

/** A link that works for five minutes, once, for this person. */
export async function createDisputeEvidenceLink(
  actor: Uploader,
  target: { reference?: string; id?: string },
  attachmentId: string,
  downloadPath: string,
) {
  const file = await attachmentFor(actor, target, attachmentId);
  const { token } = generateToken(32);
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await prisma.authToken.create({
    data: {
      id: newId(),
      userId: actor.userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: tokenHash(actor.side, file.id, token),
      expiresAt,
      createdById: actor.userId,
    },
  });
  return { url: `${downloadPath}?token=${token}`, expiresAt: expiresAt.toISOString(), fileName: file.fileName, contentType: file.contentType };
}

/** Hand over the bytes for a link, once. The token AND the session must match. */
export async function redeemDisputeEvidenceLink(
  actor: Uploader,
  target: { reference?: string; id?: string },
  attachmentId: string,
  token: string,
): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const record = await prisma.authToken.findUnique({
    where: { tokenHash: tokenHash(actor.side, attachmentId, token) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });
  if (record === null || record.userId !== actor.userId || record.consumedAt !== null || record.expiresAt.getTime() <= Date.now()) {
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
  }
  const file = await attachmentFor(actor, target, attachmentId);
  const consumed = await prisma.authToken.updateMany({ where: { id: record.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) throw forbidden(ErrorCode.TOKEN_ALREADY_USED, 'This download link has already been used.');

  const body = await storage.get(file.storageKey);
  await recordAudit({
    action: AuditAction.DISPUTE_EVIDENCE_DOWNLOADED,
    resourceType: 'dispute',
    resourceId: file.disputeId,
    actorType: actor.side === 'STAFF' ? 'ADMIN' : 'CUSTOMER',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { attachmentId },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  return { body, contentType: file.contentType, fileName: file.fileName };
}
