/**
 * Inspection evidence: photographs, video, documents and measurements.
 *
 * Tamper-resistant in the ways a platform can honestly promise (JOURNEY-039):
 *
 *   - The BYTES decide the type, never the header, and the file is scanned
 *     before it is stored, in the private tree nobody can reach by URL.
 *   - The SHA-256 of the bytes as received is stored beside them. A report
 *     signs over those hashes, so a file swapped in storage later no longer
 *     matches the signed report.
 *   - Two times are kept: when the device says it was taken, and when the
 *     server received it. A photograph "taken" after the server had it is
 *     visible for what it is.
 *   - Nothing is ever deleted or replaced. There is no delete route.
 *   - A retry of a failed upload carries the same `clientUploadId` and gets the
 *     same row back, so a phone on a factory floor with one bar of signal can
 *     simply try again.
 */
import { createHash } from 'node:crypto';
import { ErrorCode, badRequest, serviceUnavailable } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import {
  MalwareDetectedError,
  MalwareScannerUnavailableError,
  scanForMalware,
} from '../../infra/malware-scan.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { sniffDocumentType, sniffMediaType, storage } from '../../infra/storage/index.js';
import type { InspectionActor } from './context.js';

/** 25 MB for a picture or a document, 100 MB for a video. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export type EvidencePurpose =
  | 'GENERAL'
  | 'CHECKLIST'
  | 'SAMPLING'
  | 'PACKAGING'
  | 'MEASUREMENT'
  | 'DEFECT'
  | 'CAPA'
  | 'RELEASE'
  | 'BINDING'
  | 'RECLASSIFICATION';

export interface EvidenceInput {
  requirementId: string;
  jobId: string | null;
  defectId?: string | null;
  checkItemCode?: string | null;
  purpose: EvidencePurpose;
  fileName: string;
  bytes: Buffer;
  capturedAt?: Date | null;
  clientUploadId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  measurement?: string | null;
  note?: string | null;
}

export interface StoredEvidence {
  id: string;
  purpose: EvidencePurpose;
  mediaKind: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  fileName: string;
  contentType: string;
  sizeBytes: number;
  contentHash: string;
  capturedAt: Date;
  receivedAt: Date;
  duplicate: boolean;
}

function identify(bytes: Buffer): { mimeType: string; extension: string; kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT' } {
  if (bytes.length > 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    const document = sniffDocumentType(bytes);
    return { ...document, kind: 'DOCUMENT' };
  }
  const media = sniffMediaType(bytes);
  return { mimeType: media.mimeType, extension: media.extension, kind: media.kind };
}

async function scan(bytes: Buffer): Promise<string> {
  try {
    const result = await scanForMalware(bytes);
    return result.status === 'CLEAN' ? 'CLEAN' : 'UNSCANNED';
  } catch (error) {
    if (error instanceof MalwareDetectedError) {
      throw badRequest(ErrorCode.MALWARE_DETECTED, 'The uploaded file failed the security scan.');
    }
    if (error instanceof MalwareScannerUnavailableError) {
      throw serviceUnavailable('The file security scanner is temporarily unavailable.', error);
    }
    throw error;
  }
}

/**
 * Check, scan, hash and store one file. The caller has already decided the
 * person may attach evidence to this requirement, job or defect.
 */
export async function storeEvidence(actor: InspectionActor, input: EvidenceInput): Promise<StoredEvidence> {
  const clientUploadId = input.clientUploadId?.trim().slice(0, 64) || null;

  if (clientUploadId !== null) {
    const existing = await prisma.inspectionEvidence.findUnique({
      where: { requirementId_clientUploadId: { requirementId: input.requirementId, clientUploadId } },
    });
    if (existing !== null) return { ...toStored(existing), duplicate: true };
  }

  if (input.bytes.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The file is empty.', [{ field: 'file', code: 'EMPTY' }]);
  }

  const type = identify(input.bytes);
  const limit = type.kind === 'VIDEO' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (input.bytes.length > limit) {
    throw badRequest(ErrorCode.MEDIA_TOO_LARGE, `That file is too large. The limit is ${String(limit / 1_048_576)} MB.`, [
      { field: 'file', code: 'TOO_LARGE', meta: { maxBytes: limit } },
    ]);
  }

  const scanState = await scan(input.bytes);
  const contentHash = createHash('sha256').update(input.bytes).digest('hex');
  const stored = await storage.put(input.bytes, type.mimeType, type.extension, 'private');
  const receivedAt = new Date();

  // A capture time in the future is a device clock, not a fact. Keep the
  // server's time instead of a claim nobody can check.
  const captured =
    input.capturedAt !== null && input.capturedAt !== undefined && input.capturedAt.getTime() <= receivedAt.getTime() + 5 * 60 * 1000
      ? input.capturedAt
      : receivedAt;

  const id = newId();

  try {
    const row = await prisma.inspectionEvidence.create({
      data: {
        id,
        requirementId: input.requirementId,
        jobId: input.jobId,
        defectId: input.defectId ?? null,
        checkItemCode: input.checkItemCode ?? null,
        purpose: input.purpose,
        mediaKind: type.kind,
        fileName: input.fileName.slice(0, 255) || 'evidence',
        contentType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
        contentHash,
        scanState,
        capturedAt: captured,
        receivedAt,
        uploadedById: actor.userId,
        uploadedByLabel: actor.label.slice(0, 160),
        uploadedByParty: actor.party,
        clientUploadId,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        measurement: input.measurement?.trim().slice(0, 255) || null,
        note: input.note?.trim().slice(0, 512) || null,
      },
    });
    return { ...toStored(row), duplicate: false };
  } catch (error) {
    // The same upload retried and raced itself.
    if ((error as { code?: string }).code === 'P2002' && clientUploadId !== null) {
      const existing = await prisma.inspectionEvidence.findUniqueOrThrow({
        where: { requirementId_clientUploadId: { requirementId: input.requirementId, clientUploadId } },
      });
      return { ...toStored(existing), duplicate: true };
    }
    throw error;
  }
}

function toStored(row: {
  id: string;
  purpose: EvidencePurpose;
  mediaKind: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  fileName: string;
  contentType: string;
  sizeBytes: number;
  contentHash: string;
  capturedAt: Date;
  receivedAt: Date;
}): Omit<StoredEvidence, 'duplicate'> {
  return {
    id: row.id,
    purpose: row.purpose,
    mediaKind: row.mediaKind,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    capturedAt: row.capturedAt,
    receivedAt: row.receivedAt,
  };
}

/** The bytes of one evidence file. The caller has checked who may see it. */
export interface EvidenceViewer {
  party: 'AGENCY' | 'SELLER' | 'BUYER';
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/**
 * The bytes of one evidence file. The caller has already decided the viewer
 * may see it; every read is written to the audit log with who read it, from
 * which side, so access to inspection evidence can be reconstructed later.
 */
export async function readEvidenceBytes(evidenceId: string, viewer: EvidenceViewer): Promise<{
  bytes: Buffer;
  contentType: string;
  fileName: string;
}> {
  const row = await prisma.inspectionEvidence.findUniqueOrThrow({
    where: { id: evidenceId },
    select: { storageKey: true, contentType: true, fileName: true, jobId: true },
  });
  await recordAudit({
    action: AuditAction.INSPECTION_EVIDENCE_DOWNLOADED,
    resourceType: 'inspection_evidence',
    resourceId: evidenceId,
    actorType: 'CUSTOMER',
    actorUserId: viewer.userId,
    actorEmail: viewer.email,
    after: { party: viewer.party, jobId: row.jobId },
    ipAddress: viewer.ipAddress ?? null,
    correlationId: viewer.correlationId ?? null,
  });
  return { bytes: await storage.get(row.storageKey), contentType: row.contentType, fileName: row.fileName };
}

/** What a list of evidence looks like on every screen. No storage keys. */
export const EVIDENCE_SELECT = {
  id: true,
  jobId: true,
  defectId: true,
  releaseId: true,
  bindingId: true,
  checkItemCode: true,
  purpose: true,
  mediaKind: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  contentHash: true,
  scanState: true,
  capturedAt: true,
  receivedAt: true,
  uploadedByLabel: true,
  uploadedByParty: true,
  latitude: true,
  longitude: true,
  measurement: true,
  note: true,
} as const;
