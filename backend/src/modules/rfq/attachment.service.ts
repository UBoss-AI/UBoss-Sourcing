/**
 * Files on a request for quotation: a drawing, a specification sheet, a
 * certificate, a photograph of a sample.
 *
 * The same four rules as support and chat attachments, because it is the same
 * problem:
 *
 *   1. **The bytes decide the type.** A PDF or a JPEG, PNG, WebP or GIF image,
 *      whatever the file claims to be called (`sniffDocumentType`). No
 *      archives, no Office documents, no SVG, no executables.
 *   2. **Scanned before stored.** An infected file never reaches storage, and
 *      a scanner that does not answer fails the upload closed. With no scanner
 *      configured, files are unavailable unless the operator explicitly
 *      accepted unscanned ones - which production refuses.
 *   3. **Private.** The object sits under the private prefix at a random key
 *      and is only ever streamed back through a signed-in route that checks,
 *      on that request, that the caller may see it.
 *   4. **Audited both ways**, by id, type and size - never the file's name.
 *
 * WHO SEES WHAT
 *
 *   - The buyer sees every file on their own request.
 *   - An invited seller sees the requirement's files once they are part of a
 *     requirement version (a file on a draft, or waiting for the next
 *     amendment, is not part of anything a seller was asked), and the files
 *     in its OWN thread - never another seller's quote or negotiation.
 */
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { safeFileName } from '../../domain/chat-text.js';
import {
  AppError,
  ErrorCode,
  badRequest,
  conflict,
  serviceUnavailable,
} from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import {
  MalwareDetectedError,
  MalwareScannerUnavailableError,
  scanForMalware,
} from '../../infra/malware-scan.js';
import { prisma } from '../../infra/prisma.js';
import { sniffDocumentType, storage } from '../../infra/storage/index.js';
import type { Prisma, RfqAttachmentPurpose } from '../../generated/prisma/client.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { rfqNotFound } from './access.js';

export const RFQ_ATTACHMENT_TYPES = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export function rfqAttachmentAvailability(): { available: boolean; reason: 'NO_SCANNER' | null } {
  if (env.MALWARE_SCANNER_DRIVER !== 'clamav' && !env.RFQ_ALLOW_UNSCANNED_ATTACHMENTS) {
    return { available: false, reason: 'NO_SCANNER' };
  }
  return { available: true, reason: null };
}

/** What a form may offer: whether files can be added at all, and the limits. */
export function rfqAttachmentPolicy(): {
  available: boolean;
  reason: 'NO_SCANNER' | null;
  maxBytes: number;
  maxFiles: number;
  types: readonly string[];
} {
  return {
    ...rfqAttachmentAvailability(),
    maxBytes: env.RFQ_ATTACHMENT_MAX_BYTES,
    maxFiles: env.RFQ_ATTACHMENTS_PER_RFQ,
    types: RFQ_ATTACHMENT_TYPES,
  };
}

function assertAvailable(): void {
  if (!rfqAttachmentAvailability().available) {
    throw conflict(
      ErrorCode.RFQ_ATTACHMENTS_UNAVAILABLE,
      'Files cannot be attached because no malware scanner is configured.',
      [{ code: 'NO_SCANNER' }],
    );
  }
}

function servable(scanState: string): boolean {
  return scanState === 'CLEAN' || env.RFQ_ALLOW_UNSCANNED_ATTACHMENTS;
}

async function scan(bytes: Buffer): Promise<'CLEAN' | 'SCANNER_UNCONFIGURED'> {
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

export interface RfqAttachmentView {
  id: string;
  purpose: RfqAttachmentPurpose;
  fileName: string;
  contentType: string;
  byteSize: number;
  /** The requirement version a requirement file belongs to; null while pending. */
  requirementVersion: number | null;
  /** The offer version a quote or negotiation file was sent with; null while pending. */
  quoteVersionId: string | null;
  uploadedBy: 'BUYER' | 'SUPPLIER';
  createdAt: string;
}

export const ATTACHMENT_SELECT = {
  id: true,
  purpose: true,
  fileName: true,
  contentType: true,
  byteSize: true,
  requirementVersion: true,
  uploadedByParty: true,
  createdAt: true,
} as const satisfies Prisma.RfqAttachmentSelect;

type AttachmentRow = Prisma.RfqAttachmentGetPayload<{ select: typeof ATTACHMENT_SELECT }> & {
  quoteVersionId?: string | null;
};

export function attachmentView(row: AttachmentRow): RfqAttachmentView {
  return {
    id: row.id,
    purpose: row.purpose,
    fileName: row.fileName,
    contentType: row.contentType,
    byteSize: row.byteSize,
    requirementVersion: row.requirementVersion,
    quoteVersionId: row.quoteVersionId ?? null,
    uploadedBy: row.uploadedByParty === 'SUPPLIER' ? 'SUPPLIER' : 'BUYER',
    createdAt: row.createdAt.toISOString(),
  };
}

/** The files an invited seller may see on a request. */
export function supplierAttachmentWhere(
  rfqId: string,
  sellerAccountId: string,
): Prisma.RfqAttachmentWhereInput {
  return {
    rfqId,
    OR: [
      { purpose: 'REQUIREMENT', requirementVersion: { not: null } },
      {
        purpose: { in: ['QUOTE', 'NEGOTIATION'] },
        sellerAccountId,
        // Its own uploads at once; the buyer's only once they were sent.
        OR: [{ uploadedByParty: 'SUPPLIER' }, { quoteVersionId: { not: null } }],
      },
    ],
  };
}

export interface Uploader {
  party: 'BUYER' | 'SUPPLIER';
  userId: string;
  email: string | null;
}

/**
 * Store one file on a request. The caller has already established that the
 * uploader may add a file of this purpose to this request.
 */
export async function storeRfqAttachment(
  rfqId: string,
  input: {
    bytes: Buffer;
    fileName: string;
    purpose: RfqAttachmentPurpose;
    sellerAccountId: string | null;
  },
  uploader: Uploader,
): Promise<RfqAttachmentView> {
  assertAvailable();

  const count = await prisma.rfqAttachment.count({ where: { rfqId } });
  if (count >= env.RFQ_ATTACHMENTS_PER_RFQ) {
    throw new AppError({
      statusCode: 409,
      code: ErrorCode.RFQ_ATTACHMENT_LIMIT_REACHED,
      message: `A request can carry up to ${String(env.RFQ_ATTACHMENTS_PER_RFQ)} files.`,
      details: [{ code: 'LIMIT', meta: { limit: env.RFQ_ATTACHMENTS_PER_RFQ } }],
    });
  }

  if (input.bytes.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The file is empty.', [
      { field: 'file', code: 'EMPTY' },
    ]);
  }
  if (input.bytes.length > env.RFQ_ATTACHMENT_MAX_BYTES) {
    throw badRequest(
      ErrorCode.MEDIA_TOO_LARGE,
      `Files can be up to ${(env.RFQ_ATTACHMENT_MAX_BYTES / 1_048_576).toFixed(0)} MB.`,
      [{ field: 'file', code: 'FILE_TOO_LARGE', meta: { maxBytes: env.RFQ_ATTACHMENT_MAX_BYTES } }],
    );
  }

  // Throws MEDIA_TYPE_NOT_ALLOWED for anything that is not a PDF or an image.
  const sniffed = sniffDocumentType(input.bytes);
  const scanState = await scan(input.bytes);
  if (!servable(scanState)) assertAvailable();

  const stored = await storage.put(input.bytes, sniffed.mimeType, sniffed.extension, 'private');
  const id = newId();
  const fileName = safeFileName(input.fileName, `attachment.${sniffed.extension}`);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.rfqAttachment.create({
        data: {
          id,
          rfqId,
          purpose: input.purpose,
          sellerAccountId: input.sellerAccountId,
          uploadedByParty: uploader.party,
          uploadedByUserId: uploader.userId,
          storageKey: stored.storageKey,
          fileName,
          contentType: stored.mimeType,
          byteSize: stored.sizeBytes,
          contentHash: createHash('sha256').update(input.bytes).digest('hex'),
          scanState,
        },
      });
      await recordAudit(
        {
          action: AuditAction.RFQ_ATTACHMENT_UPLOADED,
          resourceType: 'rfq_request',
          resourceId: rfqId,
          actorType: 'CUSTOMER',
          actorUserId: uploader.userId,
          actorEmail: uploader.email,
          after: {
            attachmentId: id,
            purpose: input.purpose,
            party: uploader.party,
            sellerAccountId: input.sellerAccountId,
            contentType: stored.mimeType,
            byteSize: stored.sizeBytes,
            scanState,
          },
        },
        tx,
      );
    });
  } catch (error) {
    // Nothing references the object now; do not leave it behind.
    await storage.delete(stored.storageKey).catch(() => undefined);
    throw error;
  }

  const row = await prisma.rfqAttachment.findUniqueOrThrow({
    where: { id },
    select: ATTACHMENT_SELECT,
  });
  return attachmentView(row);
}

/**
 * Remove a file nobody else has seen yet: a requirement file not yet in any
 * version, or an uploader's own file not yet sent with an offer. Anything a
 * seller or the buyer was shown stays, because it is part of what was asked
 * or offered.
 */
export async function removePendingAttachment(
  rfqId: string,
  attachmentId: string,
  where: Prisma.RfqAttachmentWhereInput,
  actor: Uploader,
): Promise<void> {
  const row = await prisma.rfqAttachment.findFirst({
    where: { AND: [{ id: attachmentId, rfqId }, where] },
    select: { id: true, storageKey: true, requirementVersion: true, purpose: true },
  });
  if (row === null) rfqNotFound();
  if (row.requirementVersion !== null) {
    throw conflict(
      ErrorCode.RFQ_NOT_EDITABLE,
      'This file is part of a submitted requirement and cannot be removed.',
      [{ code: 'FROZEN' }],
    );
  }
  await prisma.$transaction(async (tx) => {
    const removed = await tx.rfqAttachment.deleteMany({
      where: { id: row.id, requirementVersion: null },
    });
    if (removed.count !== 1) {
      throw conflict(
        ErrorCode.RFQ_NOT_EDITABLE,
        'This file is part of a submitted requirement and cannot be removed.',
        [{ code: 'FROZEN' }],
      );
    }
    await recordAudit(
      {
        action: AuditAction.RFQ_ATTACHMENT_REMOVED,
        resourceType: 'rfq_request',
        resourceId: rfqId,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { attachmentId: row.id, purpose: row.purpose },
      },
      tx,
    );
  });
  await storage.delete(row.storageKey).catch(() => undefined);
}

/**
 * Hand over the bytes of one file, if `where` (the caller's visibility rule)
 * reaches it. Anything it does not reach is "not found".
 */
export async function readRfqAttachment(
  rfqId: string,
  attachmentId: string,
  where: Prisma.RfqAttachmentWhereInput,
  actor: Uploader,
): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const row = await prisma.rfqAttachment.findFirst({
    where: { AND: [{ id: attachmentId, rfqId }, where] },
    select: { id: true, storageKey: true, contentType: true, fileName: true, scanState: true },
  });
  if (row === null) rfqNotFound();
  if (!servable(row.scanState)) {
    throw conflict(
      ErrorCode.RFQ_ATTACHMENTS_UNAVAILABLE,
      'This installation does not serve files that have not been scanned for malware.',
      [{ code: 'NO_SCANNER' }],
    );
  }
  const body = await storage.get(row.storageKey);
  await recordAudit({
    action: AuditAction.RFQ_ATTACHMENT_DOWNLOADED,
    resourceType: 'rfq_request',
    resourceId: rfqId,
    actorType: 'CUSTOMER',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { attachmentId: row.id, party: actor.party },
  });
  return { body, contentType: row.contentType, fileName: row.fileName };
}

/** Private objects of these requests, for erasure to delete after commit. */
export async function storageKeysOf(rfqIds: readonly string[]): Promise<string[]> {
  if (rfqIds.length === 0) return [];
  const rows = await prisma.rfqAttachment.findMany({
    where: { rfqId: { in: [...rfqIds] } },
    select: { storageKey: true },
  });
  return rows.map((row) => row.storageKey);
}
