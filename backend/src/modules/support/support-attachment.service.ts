/**
 * Files on a support ticket: a photograph of the damage, a screen recording of
 * the error, a PDF of the invoice in question.
 *
 * The same four rules as preorder chat attachments and the seller documents,
 * because it is the same problem:
 *
 *   1. **The bytes decide the type.** An image (JPEG, PNG, WebP, GIF), a video
 *      (MP4, WebM, MOV) or a PDF, whatever the file claims to be called. No
 *      archives, no Office documents that run macros, no SVG, no executables.
 *   2. **Scanned before stored.** An infected file never reaches storage, and a
 *      scanner that does not answer fails the upload closed. With no scanner
 *      configured, files are unavailable unless the operator explicitly
 *      accepted unscanned ones - which production refuses.
 *   3. **Private, and out through a single-use link.** The object sits under
 *      the private prefix at a random key. A download needs a link minted for
 *      one signed-in person, valid for five minutes, spent on first use, and
 *      the session redeeming it must be that person's.
 *   4. **Audited both ways**, by id, type and size - never the file's name,
 *      which can itself be personal ("passport-scan-asha.pdf").
 *
 * Who may reach a file is exactly who may reach its ticket: the sender through
 * `ownTicketId` (their own ticket, from the surface they sent it on), and staff
 * holding `support_ticket.view`.
 */
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { safeFileName } from '../../domain/chat-text.js';
import {
  AppError,
  ErrorCode,
  badRequest,
  conflict,
  forbidden,
  notFound,
  serviceUnavailable,
} from '../../domain/errors.js';
import { assertWritable } from '../../domain/support-ticket-state.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import {
  MalwareDetectedError,
  MalwareScannerUnavailableError,
  scanForMalware,
} from '../../infra/malware-scan.js';
import { prisma } from '../../infra/prisma.js';
import { sniffDocumentType, sniffMediaType, storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { ownTicketId, type SupportRequester } from './support-ticket.service.js';

/** How many files one ticket may carry. */
export const SUPPORT_ATTACHMENTS_PER_TICKET = 10;

/** How long a download link works for. */
const LINK_TTL_MS = 5 * 60_000;

/** What the form may offer, said once for every app. */
export const SUPPORT_ATTACHMENT_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
]);

export type SupportAttachmentUnavailableReason = 'DISABLED' | 'NO_SCANNER';

export function supportAttachmentAvailability():
  { available: true } | { available: false; reason: SupportAttachmentUnavailableReason } {
  if (!env.SUPPORT_ATTACHMENTS_ENABLED) return { available: false, reason: 'DISABLED' };
  if (env.MALWARE_SCANNER_DRIVER !== 'clamav' && !env.SUPPORT_ALLOW_UNSCANNED_ATTACHMENTS) {
    return { available: false, reason: 'NO_SCANNER' };
  }
  return { available: true };
}

/** For the Support page: whether it may offer a file picker, and its limits. */
export function supportAttachmentPolicy(): {
  available: boolean;
  reason: SupportAttachmentUnavailableReason | null;
  maxBytes: number;
  maxFiles: number;
  types: readonly string[];
} {
  const availability = supportAttachmentAvailability();
  return {
    available: availability.available,
    reason: availability.available ? null : availability.reason,
    maxBytes: env.SUPPORT_ATTACHMENT_MAX_BYTES,
    maxFiles: SUPPORT_ATTACHMENTS_PER_TICKET,
    types: SUPPORT_ATTACHMENT_TYPES,
  };
}

/** Exported for dispute evidence, which is the same pipeline. */
export function assertAttachmentsAvailable(): void {
  assertAvailable();
}

function assertAvailable(): void {
  const availability = supportAttachmentAvailability();
  if (!availability.available) {
    throw conflict(
      ErrorCode.SUPPORT_ATTACHMENTS_UNAVAILABLE,
      availability.reason === 'DISABLED'
        ? 'Files cannot be attached to tickets on this installation.'
        : 'Files cannot be attached because no malware scanner is configured.',
      [{ code: availability.reason }],
    );
  }
}

export function servable(scanState: 'CLEAN' | 'SCANNER_UNCONFIGURED'): boolean {
  return scanState === 'CLEAN' || env.SUPPORT_ALLOW_UNSCANNED_ATTACHMENTS;
}

/** The type, from the bytes. A video or an image first; otherwise a PDF. */
export function sniff(bytes: Buffer): {
  mimeType: string;
  extension: string;
  kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
} {
  try {
    const media = sniffMediaType(bytes);
    return { mimeType: media.mimeType, extension: media.extension, kind: media.kind };
  } catch {
    try {
      const document = sniffDocumentType(bytes);
      return { ...document, kind: document.mimeType === 'application/pdf' ? 'DOCUMENT' : 'IMAGE' };
    } catch {
      throw badRequest(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        'Attach an image (JPEG, PNG, WebP, GIF), a video (MP4, WebM, MOV) or a PDF.',
        [{ field: 'file', code: 'UNSUPPORTED_TYPE' }],
      );
    }
  }
}

export async function scan(bytes: Buffer): Promise<'CLEAN' | 'SCANNER_UNCONFIGURED'> {
  try {
    const result = await scanForMalware(bytes);
    return result.status === 'CLEAN' ? 'CLEAN' : 'SCANNER_UNCONFIGURED';
  } catch (error) {
    if (error instanceof MalwareDetectedError) {
      throw badRequest(ErrorCode.MALWARE_DETECTED, 'The file failed the security scan.', [
        { field: 'file', code: 'MALWARE_DETECTED' },
      ]);
    }
    if (error instanceof MalwareScannerUnavailableError) {
      throw serviceUnavailable('The file security scanner is temporarily unavailable.', error);
    }
    throw error;
  }
}

export interface SupportAttachmentView {
  id: string;
  fileName: string;
  contentType: string;
  kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  byteSize: number;
  createdAt: string;
  /** Attached by the team rather than the sender. */
  fromTeam: boolean;
}

const ATTACHMENT_SELECT = {
  id: true,
  fileName: true,
  contentType: true,
  kind: true,
  byteSize: true,
  createdAt: true,
  uploadedByStaff: true,
} as const;

export async function listTicketAttachments(ticketId: string): Promise<SupportAttachmentView[]> {
  const rows = await prisma.supportTicketAttachment.findMany({
    where: { ticketId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: ATTACHMENT_SELECT,
  });
  return rows.map(({ uploadedByStaff, ...row }) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    fromTeam: uploadedByStaff,
  }));
}

/**
 * The sender adds one file to their own ticket.
 *
 * Allowed until the ticket is CLOSED - the same line writing on it follows.
 * Deliberately not refused by `FEATURE_SUPPORT_TICKETS` being off: a sender
 * asked for a photograph must still be able to send it.
 */
export async function uploadRequesterAttachment(
  requester: SupportRequester,
  reference: string,
  input: { bytes: Buffer; fileName: string },
): Promise<{ attachment: SupportAttachmentView }> {
  assertAvailable();
  const ticketId = await ownTicketId(requester, reference);
  return storeTicketAttachment(ticketId, input, {
    staff: false,
    userId: requester.userId,
    email: requester.email,
    actorType: requester.source === 'LOGISTICS_PORTAL' ? 'LOGISTICS' : 'CUSTOMER',
    ipAddress: requester.ipAddress ?? null,
    correlationId: requester.correlationId ?? null,
  });
}

/**
 * A member of staff adds a file to a ticket - a returns label, a corrected
 * invoice, a photograph from the warehouse. The sender sees it on their
 * request, marked as from the team. Same rules as the sender's own files.
 */
export async function uploadStaffAttachment(
  actor: { userId: string; email: string; ipAddress?: string | null; correlationId?: string | null },
  ticketId: string,
  input: { bytes: Buffer; fileName: string },
): Promise<{ attachment: SupportAttachmentView }> {
  assertAvailable();
  const exists = await prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { id: true } });
  if (exists === null) throw notFound('Support request');
  return storeTicketAttachment(ticketId, input, {
    staff: true,
    userId: actor.userId,
    email: actor.email,
    actorType: 'ADMIN',
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
}

async function storeTicketAttachment(
  ticketId: string,
  input: { bytes: Buffer; fileName: string },
  uploader: {
    staff: boolean;
    userId: string;
    email: string;
    actorType: 'ADMIN' | 'CUSTOMER' | 'LOGISTICS';
    ipAddress: string | null;
    correlationId: string | null;
  },
): Promise<{ attachment: SupportAttachmentView }> {

  const ticket = await prisma.supportTicket.findUniqueOrThrow({
    where: { id: ticketId },
    select: { status: true, _count: { select: { attachments: true } } },
  });
  assertWritable(ticket.status);
  if (ticket._count.attachments >= SUPPORT_ATTACHMENTS_PER_TICKET) {
    throw new AppError({
      statusCode: 409,
      code: ErrorCode.SUPPORT_ATTACHMENT_LIMIT_REACHED,
      message: `A ticket can carry up to ${String(SUPPORT_ATTACHMENTS_PER_TICKET)} files.`,
      details: [{ code: 'LIMIT', meta: { limit: SUPPORT_ATTACHMENTS_PER_TICKET } }],
    });
  }

  if (input.bytes.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The file is empty.', [
      { field: 'file', code: 'EMPTY' },
    ]);
  }
  if (input.bytes.length > env.SUPPORT_ATTACHMENT_MAX_BYTES) {
    throw badRequest(
      ErrorCode.MEDIA_TOO_LARGE,
      `Files can be up to ${(env.SUPPORT_ATTACHMENT_MAX_BYTES / 1_048_576).toFixed(0)} MB.`,
      [
        {
          field: 'file',
          code: 'FILE_TOO_LARGE',
          meta: { maxBytes: env.SUPPORT_ATTACHMENT_MAX_BYTES },
        },
      ],
    );
  }

  const sniffed = sniff(input.bytes);
  const scanState = await scan(input.bytes);
  if (!servable(scanState)) assertAvailable();

  const stored = await storage.put(input.bytes, sniffed.mimeType, sniffed.extension, 'private');
  const id = newId();
  const fileName = safeFileName(input.fileName, `attachment.${sniffed.extension}`);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.supportTicketAttachment.create({
        data: {
          id,
          ticketId,
          storageKey: stored.storageKey,
          fileName,
          contentType: stored.mimeType,
          kind: sniffed.kind,
          byteSize: stored.sizeBytes,
          contentHash: createHash('sha256').update(input.bytes).digest('hex'),
          scanState,
          uploadedByUserId: uploader.userId,
          uploadedByStaff: uploader.staff,
        },
      });
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { lastActivityAt: new Date() },
      });
      await recordAudit(
        {
          action: AuditAction.SUPPORT_TICKET_ATTACHMENT_UPLOADED,
          resourceType: 'support_ticket',
          resourceId: ticketId,
          actorType: uploader.actorType,
          actorUserId: uploader.userId,
          actorEmail: uploader.email,
          after: {
            attachmentId: id,
            contentType: stored.mimeType,
            byteSize: stored.sizeBytes,
            scanState,
            byStaff: uploader.staff,
          },
          ipAddress: uploader.ipAddress,
          correlationId: uploader.correlationId,
        },
        tx,
      );
    });
  } catch (error) {
    // Nothing references the object now; do not leave it behind.
    await storage.delete(stored.storageKey).catch(() => undefined);
    throw error;
  }

  const [attachment] = await listTicketAttachments(ticketId).then((rows) =>
    rows.filter((row) => row.id === id),
  );
  if (attachment === undefined) throw notFound('Attachment');
  return { attachment };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type AttachmentViewer =
  | { side: 'REQUESTER'; requester: SupportRequester; reference: string }
  | {
      side: 'STAFF';
      userId: string;
      email: string;
      ticketId: string;
      ipAddress?: string | null;
      correlationId?: string | null;
    };

function viewerUserId(viewer: AttachmentViewer): string {
  return viewer.side === 'REQUESTER' ? viewer.requester.userId : viewer.userId;
}

async function attachmentFor(viewer: AttachmentViewer, attachmentId: string) {
  // The ticket is resolved the same way every other read of it is, so a file
  // is never reachable by somebody who could not open its ticket.
  const ticketId =
    viewer.side === 'REQUESTER'
      ? await ownTicketId(viewer.requester, viewer.reference)
      : viewer.ticketId;
  const attachment = await prisma.supportTicketAttachment.findFirst({
    where: { id: attachmentId, ticketId },
    select: {
      id: true,
      ticketId: true,
      storageKey: true,
      fileName: true,
      contentType: true,
      scanState: true,
    },
  });
  if (attachment === null) throw notFound('Attachment');
  if (!servable(attachment.scanState)) {
    throw conflict(
      ErrorCode.SUPPORT_ATTACHMENTS_UNAVAILABLE,
      'This installation does not serve files that have not been scanned for malware.',
      [{ code: 'NO_SCANNER' }],
    );
  }
  return attachment;
}

function tokenHash(side: AttachmentViewer['side'], attachmentId: string, token: string): string {
  return sha256Hex(`support-attachment:${side}:${attachmentId}:${token}`);
}

/**
 * A link that works for five minutes, once, for this person. `downloadPath`
 * is the route on the caller's own surface that redeems it.
 */
export async function createSupportAttachmentLink(
  viewer: AttachmentViewer,
  attachmentId: string,
  downloadPath: string,
): Promise<{ url: string; expiresAt: string; fileName: string; contentType: string }> {
  const attachment = await attachmentFor(viewer, attachmentId);
  const { token } = generateToken(32);
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  const userId = viewerUserId(viewer);

  // The AuthToken table, like chat attachments and seller documents, so the
  // existing expiry sweep and single-use rule apply without a store of their own.
  await prisma.authToken.create({
    data: {
      id: newId(),
      userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: tokenHash(viewer.side, attachment.id, token),
      expiresAt,
      createdById: userId,
    },
  });

  return {
    url: `${downloadPath}?token=${token}`,
    expiresAt: expiresAt.toISOString(),
    fileName: attachment.fileName,
    contentType: attachment.contentType,
  };
}

/** Hand over the bytes for a link, once. The token AND the session must match. */
export async function redeemSupportAttachmentLink(
  viewer: AttachmentViewer,
  attachmentId: string,
  token: string,
): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const userId = viewerUserId(viewer);
  const record = await prisma.authToken.findUnique({
    where: { tokenHash: tokenHash(viewer.side, attachmentId, token) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });
  if (
    record === null ||
    record.userId !== userId ||
    record.consumedAt !== null ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
  }

  const attachment = await attachmentFor(viewer, attachmentId);

  const consumed = await prisma.authToken.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw forbidden(ErrorCode.TOKEN_ALREADY_USED, 'This download link has already been used.');
  }

  const body = await storage.get(attachment.storageKey);
  await recordAudit({
    action: AuditAction.SUPPORT_TICKET_ATTACHMENT_DOWNLOADED,
    resourceType: 'support_ticket',
    resourceId: attachment.ticketId,
    actorType:
      viewer.side === 'STAFF'
        ? 'ADMIN'
        : viewer.requester.source === 'LOGISTICS_PORTAL'
          ? 'LOGISTICS'
          : 'CUSTOMER',
    actorUserId: userId,
    actorEmail: viewer.side === 'STAFF' ? viewer.email : viewer.requester.email,
    after: { attachmentId },
    ipAddress:
      viewer.side === 'STAFF' ? (viewer.ipAddress ?? null) : (viewer.requester.ipAddress ?? null),
    correlationId:
      viewer.side === 'STAFF'
        ? (viewer.correlationId ?? null)
        : (viewer.requester.correlationId ?? null),
  });

  return { body, contentType: attachment.contentType, fileName: attachment.fileName };
}
