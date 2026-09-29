/**
 * Files on a return: the buyer's photographs and videos of the problem, and a
 * return label the seller or staff made at their carrier.
 *
 * The same pipeline as support attachments, for the same reasons:
 *
 *   1. **The bytes decide the type.** An image (JPEG, PNG, WebP, GIF), a video
 *      (MP4, WebM, MOV) or a PDF, whatever the file claims to be called.
 *   2. **Scanned before stored.** An infected file never reaches storage, and a
 *      scanner that does not answer fails the upload closed. With no scanner,
 *      files are refused unless the operator accepted unscanned ones - which
 *      production refuses.
 *   3. **Private, and out through a single-use link** minted for one signed-in
 *      person, valid for five minutes, spent on first use.
 *   4. **Audited both ways**, by id, type and size - never the file's name.
 *
 * This module does not decide who may reach a return. Its callers resolve the
 * return through the buyer's, the seller's or staff's own scope first and pass
 * only an id they are entitled to.
 */
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { safeFileName } from '../../domain/chat-text.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound, serviceUnavailable } from '../../domain/errors.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { MalwareDetectedError, MalwareScannerUnavailableError, scanForMalware } from '../../infra/malware-scan.js';
import { prisma } from '../../infra/prisma.js';
import { sniffDocumentType, sniffMediaType, storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit, type AuditActorType } from '../audit/audit.service.js';

/** How many files one return may carry, evidence and labels together. */
export const RETURN_FILES_PER_RETURN = 10;
/** How many the buyer may send with the request itself. */
export const RETURN_FILES_PER_REQUEST = 6;

const LINK_TTL_MS = 5 * 60_000;

export const RETURN_FILE_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
]);

export function returnFilesAvailable(): boolean {
  return env.MALWARE_SCANNER_DRIVER === 'clamav' || env.RETURN_ALLOW_UNSCANNED_FILES;
}

export function returnFilePolicy(): {
  available: boolean;
  maxBytes: number;
  maxFiles: number;
  types: readonly string[];
} {
  return {
    available: returnFilesAvailable(),
    maxBytes: env.RETURN_FILE_MAX_BYTES,
    maxFiles: RETURN_FILES_PER_REQUEST,
    types: RETURN_FILE_TYPES,
  };
}

export function assertReturnFilesAvailable(): void {
  if (!returnFilesAvailable()) {
    throw conflict(
      ErrorCode.RETURN_FILES_UNAVAILABLE,
      'Files cannot be added to returns because no malware scanner is configured.',
      [{ code: 'NO_SCANNER' }],
    );
  }
}

export interface PreparedFile {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  extension: string;
  mediaKind: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  contentHash: string;
}

/**
 * Check one file before anything is stored: present, within the size limit,
 * and by its own bytes an image, a video or a PDF. Throws the same codes the
 * other upload paths use, so the storefront words them the same way.
 */
export function prepareReturnFile(input: { bytes: Buffer; fileName: string }): PreparedFile {
  if (input.bytes.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The file is empty.', [
      { field: 'file', code: 'EMPTY' },
    ]);
  }
  if (input.bytes.length > env.RETURN_FILE_MAX_BYTES) {
    throw badRequest(
      ErrorCode.MEDIA_TOO_LARGE,
      `Files can be up to ${(env.RETURN_FILE_MAX_BYTES / 1_048_576).toFixed(0)} MB.`,
      [{ field: 'file', code: 'FILE_TOO_LARGE', meta: { maxBytes: env.RETURN_FILE_MAX_BYTES } }],
    );
  }

  let sniffed: { mimeType: string; extension: string; mediaKind: PreparedFile['mediaKind'] };
  try {
    const media = sniffMediaType(input.bytes);
    sniffed = { mimeType: media.mimeType, extension: media.extension, mediaKind: media.kind };
  } catch {
    try {
      const document = sniffDocumentType(input.bytes);
      if (document.mimeType !== 'application/pdf' && !document.mimeType.startsWith('image/')) {
        throw new Error('not allowed');
      }
      sniffed = {
        mimeType: document.mimeType,
        extension: document.extension,
        mediaKind: document.mimeType === 'application/pdf' ? 'DOCUMENT' : 'IMAGE',
      };
    } catch {
      throw badRequest(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        'Attach an image (JPEG, PNG, WebP, GIF), a video (MP4, WebM, MOV) or a PDF.',
        [{ field: 'file', code: 'UNSUPPORTED_TYPE' }],
      );
    }
  }

  return {
    bytes: input.bytes,
    fileName: safeFileName(input.fileName, `file.${sniffed.extension}`),
    ...sniffed,
    contentHash: createHash('sha256').update(input.bytes).digest('hex'),
  };
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

export interface StoredFile extends PreparedFile {
  storageKey: string;
  byteSize: number;
  scanState: 'CLEAN' | 'SCANNER_UNCONFIGURED';
}

/** Scan and store prepared files. On any failure, whatever was stored is removed. */
export async function storeReturnFiles(files: readonly PreparedFile[]): Promise<StoredFile[]> {
  if (files.length === 0) return [];
  assertReturnFilesAvailable();
  const stored: StoredFile[] = [];
  try {
    for (const file of files) {
      const scanState = await scan(file.bytes);
      if (scanState !== 'CLEAN' && !env.RETURN_ALLOW_UNSCANNED_FILES) assertReturnFilesAvailable();
      const put = await storage.put(file.bytes, file.mimeType, file.extension, 'private');
      stored.push({ ...file, storageKey: put.storageKey, byteSize: put.sizeBytes, scanState });
    }
  } catch (error) {
    await discardStoredFiles(stored);
    throw error;
  }
  return stored;
}

export async function discardStoredFiles(files: readonly { storageKey: string }[]): Promise<void> {
  for (const file of files) await storage.delete(file.storageKey).catch(() => undefined);
}

/** Write the rows for stored files, inside the caller's transaction. */
export async function recordReturnFiles(
  tx: Prisma.TransactionClient,
  input: {
    returnRequestId: string;
    kind: 'EVIDENCE' | 'LABEL';
    files: readonly StoredFile[];
    uploadedById: string;
    uploaderType: 'CUSTOMER' | 'SELLER' | 'ADMIN';
    auditActorType: AuditActorType;
    actorEmail: string;
  },
): Promise<string[]> {
  const ids: string[] = [];
  for (const file of input.files) {
    const id = newId();
    ids.push(id);
    await tx.returnRequestFile.create({
      data: {
        id,
        returnRequestId: input.returnRequestId,
        kind: input.kind,
        storageKey: file.storageKey,
        fileName: file.fileName,
        contentType: file.mimeType,
        mediaKind: file.mediaKind,
        byteSize: file.byteSize,
        contentHash: file.contentHash,
        scanState: file.scanState,
        uploadedById: input.uploadedById,
        uploaderType: input.uploaderType,
      },
    });
    await recordAudit(
      {
        action: AuditAction.RETURN_FILE_UPLOADED,
        resourceType: 'return_request',
        resourceId: input.returnRequestId,
        actorType: input.auditActorType,
        actorUserId: input.uploadedById,
        actorEmail: input.actorEmail,
        after: {
          fileId: id,
          kind: input.kind,
          contentType: file.mimeType,
          byteSize: file.byteSize,
          scanState: file.scanState,
        },
      },
      tx,
    );
  }
  return ids;
}

export async function countReturnFiles(returnRequestId: string): Promise<number> {
  return prisma.returnRequestFile.count({ where: { returnRequestId } });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

type Side = 'BUYER' | 'SELLER' | 'STAFF';

function tokenHash(side: Side, fileId: string, token: string): string {
  return sha256Hex(`return-file:${side}:${fileId}:${token}`);
}

async function servableFile(returnRequestId: string, fileId: string) {
  const file = await prisma.returnRequestFile.findFirst({
    where: { id: fileId, returnRequestId },
    select: { id: true, storageKey: true, fileName: true, contentType: true, scanState: true },
  });
  if (file === null) throw notFound('File');
  if (file.scanState !== 'CLEAN' && !env.RETURN_ALLOW_UNSCANNED_FILES) {
    throw conflict(
      ErrorCode.RETURN_FILES_UNAVAILABLE,
      'This installation does not serve files that have not been scanned for malware.',
      [{ code: 'NO_SCANNER' }],
    );
  }
  return file;
}

/** A five-minute, single-use link for this person to one file of a return they may see. */
export async function createReturnFileLink(input: {
  side: Side;
  userId: string;
  returnRequestId: string;
  fileId: string;
  downloadPath: string;
}): Promise<{ url: string; expiresAt: string; fileName: string; contentType: string }> {
  const file = await servableFile(input.returnRequestId, input.fileId);
  const { token } = generateToken(32);
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  // The AuthToken table, like every other private file here, so the expiry
  // sweep and the single-use rule apply without a store of their own.
  await prisma.authToken.create({
    data: {
      id: newId(),
      userId: input.userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: tokenHash(input.side, file.id, token),
      expiresAt,
      createdById: input.userId,
    },
  });
  return {
    url: `${input.downloadPath}?token=${token}`,
    expiresAt: expiresAt.toISOString(),
    fileName: file.fileName,
    contentType: file.contentType,
  };
}

/** Hand over the bytes for a link, once. The token and the session must both match. */
export async function redeemReturnFileLink(input: {
  side: Side;
  userId: string;
  email: string;
  auditActorType: AuditActorType;
  returnRequestId: string;
  fileId: string;
  token: string;
}): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const record = await prisma.authToken.findUnique({
    where: { tokenHash: tokenHash(input.side, input.fileId, input.token) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });
  if (
    record === null ||
    record.userId !== input.userId ||
    record.consumedAt !== null ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
  }
  const file = await servableFile(input.returnRequestId, input.fileId);
  const consumed = await prisma.authToken.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw forbidden(ErrorCode.TOKEN_ALREADY_USED, 'This download link has already been used.');
  }
  const body = await storage.get(file.storageKey);
  await recordAudit({
    action: AuditAction.RETURN_FILE_DOWNLOADED,
    resourceType: 'return_request',
    resourceId: input.returnRequestId,
    actorType: input.auditActorType,
    actorUserId: input.userId,
    actorEmail: input.email,
    after: { fileId: file.id, side: input.side },
  });
  return { body, contentType: file.contentType, fileName: file.fileName };
}
