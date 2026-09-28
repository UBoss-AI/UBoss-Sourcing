/**
 * Company documents: upload, withdrawal, review, and the one way out.
 *
 * The controls, in the order a file meets them:
 *
 *   1. **Who and when.** Only a member who may manage the application, only
 *      while it is editable, and the two kinds that touch a natural person
 *      (REPRESENTATIVE_IDENTITY, OWNERSHIP_DECLARATION) only against an open
 *      reviewer request naming that kind.
 *   2. **Size**, then **type from the bytes** - PDF, JPEG, PNG or WebP. The
 *      browser's MIME type and the file name are never read.
 *   3. **Active content and polyglots.** A PDF carrying JavaScript, launch
 *      actions, embedded files or XFA forms is refused, as is an image with
 *      data after its end marker (the classic image-that-is-also-a-ZIP) or
 *      markup anywhere inside it. A PDF with more pages than
 *      BUYER_COMPANY_DOCUMENT_MAX_PAGES is refused.
 *   4. **Malware scan** before anything is stored.
 *   5. **Storage** under a generated key in the private area. No original
 *      file name is kept; the name a reviewer downloads is built from the
 *      document kind and the application reference.
 *   6. **Out** only through a single-use link that expires in minutes, is
 *      bound to the member of staff who asked for it, and is served as an
 *      attachment with `nosniff` and a sandboxing CSP - never rendered inline.
 *      Every download is audited.
 */
import {
  REVIEWER_REQUEST_ONLY_KINDS,
  type BuyerCompanyDocumentKindName,
} from '../../domain/buyer-company-requirements.js';
import { isEditableStatus } from '../../domain/buyer-company-state.js';
import { env } from '../../config/env.js';
import {
  ErrorCode,
  badRequest,
  conflict,
  forbidden,
  notFound,
  serviceUnavailable,
} from '../../domain/errors.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import {
  MalwareDetectedError,
  MalwareScannerUnavailableError,
  scanForMalware,
} from '../../infra/malware-scan.js';
import { prisma } from '../../infra/prisma.js';
import { sniffDocumentType, storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  assertCanManage,
  assertCompaniesEnabled,
  loadMembership,
  writeEvent,
  type Actor,
} from './shared.js';

const ACCEPTED_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

function refuse(code: string, message: string, meta?: Record<string, string | number>): never {
  throw badRequest(ErrorCode.BUYER_COMPANY_DOCUMENT_REJECTED, message, [
    { field: 'file', code, ...(meta !== undefined ? { meta } : {}) },
  ]);
}

/** Markup that has no business inside a scan or a photograph. */
const MARKUP = /<\s*(script|html|svg|iframe|object|embed|\?php)\b/i;

/** PDF features that make a document do something when opened. */
const PDF_ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA|SubmitForm|ImportData)\b/;

/**
 * Pages in a PDF, counted from its page objects. Null when the page tree is
 * inside compressed object streams and cannot be counted without a parser -
 * such a file is not refused for it, only left uncounted.
 */
export function countPdfPages(text: string): number | null {
  const matches = text.match(/\/Type\s*\/Page(?![s\w])/g);
  return matches === null ? null : matches.length;
}

/**
 * Look inside a file that has already passed the type sniff. Throws on
 * anything that makes it more than a document. Exported for the tests.
 */
export function inspectDocumentBytes(
  bytes: Buffer,
  mimeType: string,
): { pageCount: number | null } {
  // latin1 maps every byte to one character, so offsets survive and binary
  // content cannot throw a decoding error.
  const text = bytes.toString('latin1');

  // An archive or an executable hiding anywhere in the file.
  if (text.includes('PK\u0003\u0004') || text.includes('\u007fELF')) {
    refuse('POLYGLOT', 'This file contains something other than a document.');
  }

  if (mimeType === 'application/pdf') {
    if (PDF_ACTIVE.test(text)) {
      refuse(
        'ACTIVE_CONTENT',
        'This PDF contains scripts, attachments or forms. Print it to a plain PDF and upload that.',
      );
    }
    if (!text.slice(-2048).includes('%%EOF')) {
      refuse('UNREADABLE', 'This PDF looks incomplete. Save it again and upload the new copy.');
    }
    const pageCount = countPdfPages(text);
    if (pageCount !== null && pageCount > env.BUYER_COMPANY_DOCUMENT_MAX_PAGES) {
      refuse(
        'TOO_MANY_PAGES',
        `Upload no more than ${String(env.BUYER_COMPANY_DOCUMENT_MAX_PAGES)} pages.`,
        {
          maxPages: env.BUYER_COMPANY_DOCUMENT_MAX_PAGES,
        },
      );
    }
    return { pageCount };
  }

  // Images: no markup anywhere, and nothing after the end of the picture.
  if (MARKUP.test(text))
    refuse('ACTIVE_CONTENT', 'This image contains markup and cannot be accepted.');

  if (mimeType === 'image/png') {
    const end = text.lastIndexOf('IEND');
    if (end < 0 || bytes.length - (end + 8) > 16) {
      refuse(
        'POLYGLOT',
        'This image has extra data after it. Save it again and upload the new copy.',
      );
    }
  }
  if (mimeType === 'image/jpeg') {
    const end = bytes.lastIndexOf(Buffer.from([0xff, 0xd9]));
    if (end < 0 || bytes.length - (end + 2) > 16) {
      refuse(
        'POLYGLOT',
        'This image has extra data after it. Save it again and upload the new copy.',
      );
    }
  }

  return { pageCount: 1 };
}

export interface UploadInput {
  userId: string;
  companyId: string;
  kind: BuyerCompanyDocumentKindName;
  infoRequestId?: string | null;
  bytes: Buffer;
  actor: Actor;
}

export async function uploadCompanyDocument(input: UploadInput): Promise<{ documentId: string }> {
  assertCompaniesEnabled();
  const membership = await loadMembership(input.userId, input.companyId);
  assertCanManage(membership);

  const company = await prisma.buyerCompany.findUniqueOrThrow({
    where: { id: input.companyId },
    select: { status: true, infoRequests: { where: { status: 'OPEN' } } },
  });

  if (!isEditableStatus(company.status)) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_NOT_EDITABLE,
      'Documents cannot be added while the application is being reviewed.',
    );
  }

  const openRequests = company.infoRequests;
  const request =
    input.infoRequestId === undefined || input.infoRequestId === null
      ? null
      : (openRequests.find((row) => row.id === input.infoRequestId) ?? null);
  if (input.infoRequestId !== undefined && input.infoRequestId !== null && request === null) {
    throw notFound('Request');
  }

  if (REVIEWER_REQUEST_ONLY_KINDS.has(input.kind)) {
    const asked = openRequests.some(
      (row) =>
        Array.isArray(row.requestedDocumentKindsJson) &&
        row.requestedDocumentKindsJson.includes(input.kind),
    );
    if (!asked) {
      throw forbidden(
        ErrorCode.BUYER_COMPANY_DOCUMENT_REJECTED,
        'This kind of document is only needed when our reviewer asks for it.',
      );
    }
  }

  if (input.bytes.length === 0) refuse('EMPTY', 'The file is empty.');
  if (input.bytes.length > env.BUYER_COMPANY_DOCUMENT_MAX_BYTES) {
    refuse(
      'TOO_LARGE',
      `Upload a file of ${String(Math.floor(env.BUYER_COMPANY_DOCUMENT_MAX_BYTES / 1_000_000))} MB or less.`,
      {
        maxBytes: env.BUYER_COMPANY_DOCUMENT_MAX_BYTES,
      },
    );
  }

  let sniffed: { mimeType: string; extension: string };
  try {
    sniffed = sniffDocumentType(input.bytes);
  } catch {
    return refuse('TYPE', 'Upload a PDF, or a JPEG, PNG or WebP image of the document.');
  }
  if (!ACCEPTED_TYPES.has(sniffed.mimeType)) {
    refuse('TYPE', 'Upload a PDF, or a JPEG, PNG or WebP image of the document.');
  }

  const { pageCount } = inspectDocumentBytes(input.bytes, sniffed.mimeType);

  let scanState: 'CLEAN' | 'UNSCANNED';
  try {
    scanState = (await scanForMalware(input.bytes)).status === 'CLEAN' ? 'CLEAN' : 'UNSCANNED';
  } catch (error) {
    if (error instanceof MalwareDetectedError) {
      throw badRequest(ErrorCode.MALWARE_DETECTED, 'The uploaded file failed the security scan.');
    }
    if (error instanceof MalwareScannerUnavailableError) {
      throw serviceUnavailable('The file security scanner is temporarily unavailable.', error);
    }
    throw error;
  }

  const stored = await storage.put(input.bytes, sniffed.mimeType, sniffed.extension, 'private');
  const documentId = newId();
  const contentHash = sha256Hex(input.bytes.toString('base64'));

  await prisma.$transaction(async (tx) => {
    // A newer upload of the same kind replaces the one still waiting; an
    // accepted document is left alone, and nothing is deleted.
    await tx.buyerCompanyDocument.updateMany({
      where: {
        companyId: input.companyId,
        kind: input.kind,
        status: { in: ['PENDING_REVIEW', 'REJECTED'] },
      },
      data: { status: 'SUPERSEDED', supersededById: documentId },
    });

    await tx.buyerCompanyDocument.create({
      data: {
        id: documentId,
        companyId: input.companyId,
        kind: input.kind,
        storageKey: stored.storageKey,
        mimeType: sniffed.mimeType,
        sizeBytes: input.bytes.length,
        pageCount,
        contentHash,
        scanState,
        uploadedByUserId: input.userId,
        infoRequestId: request?.id ?? null,
      },
    });

    await writeEvent(tx, {
      companyId: input.companyId,
      kind: 'DOCUMENT_UPLOADED',
      visibility: 'APPLICANT',
      actor: input.actor,
      data: { documentId, kind: input.kind },
    });

    await recordAudit(
      {
        action: AuditAction.BUYER_COMPANY_DOCUMENT_UPLOADED,
        resourceType: 'buyer_company_document',
        resourceId: documentId,
        actorType: 'CUSTOMER',
        actorUserId: input.userId,
        after: {
          companyId: input.companyId,
          kind: input.kind,
          sizeBytes: input.bytes.length,
          scanState,
        },
        ipAddress: input.actor.ipAddress ?? null,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { documentId };
}

/** Take back a document nobody has decided on yet. The row stays, marked WITHDRAWN. */
export async function withdrawCompanyDocument(
  userId: string,
  companyId: string,
  documentId: string,
  actor: Actor,
): Promise<void> {
  assertCompaniesEnabled();
  const membership = await loadMembership(userId, companyId);
  assertCanManage(membership);

  await prisma.$transaction(async (tx) => {
    const company = await tx.buyerCompany.findUniqueOrThrow({
      where: { id: companyId },
      select: { status: true },
    });
    if (!isEditableStatus(company.status)) {
      throw conflict(
        ErrorCode.BUYER_COMPANY_NOT_EDITABLE,
        'Documents cannot be changed while the application is being reviewed.',
      );
    }

    const withdrawn = await tx.buyerCompanyDocument.updateMany({
      where: { id: documentId, companyId, status: 'PENDING_REVIEW' },
      data: { status: 'WITHDRAWN' },
    });
    if (withdrawn.count !== 1) throw notFound('Document');

    await writeEvent(tx, {
      companyId,
      kind: 'DOCUMENT_WITHDRAWN',
      visibility: 'APPLICANT',
      actor,
      data: { documentId },
    });
    await recordAudit(
      {
        action: AuditAction.BUYER_COMPANY_DOCUMENT_WITHDRAWN,
        resourceType: 'buyer_company_document',
        resourceId: documentId,
        actorType: 'CUSTOMER',
        actorUserId: userId,
        after: { companyId },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Staff side
// ---------------------------------------------------------------------------

function isServable(scanState: 'CLEAN' | 'UNSCANNED'): boolean {
  return scanState === 'CLEAN' || env.BUYER_COMPANY_ALLOW_UNSCANNED_DOCUMENTS;
}

function tokenHashFor(documentId: string, token: string): string {
  return sha256Hex(`buyer-company-document:${documentId}:${token}`);
}

/**
 * A link that downloads one document once, within minutes, for the member of
 * staff who asked for it.
 */
export async function createDocumentLink(
  adminUserId: string,
  documentId: string,
): Promise<{ url: string; expiresAt: string }> {
  const document = await prisma.buyerCompanyDocument.findUnique({
    where: { id: documentId },
    select: { id: true, scanState: true },
  });
  if (document === null) throw notFound('Document');
  if (!isServable(document.scanState)) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_DOCUMENT_REJECTED,
      'This installation does not serve files that have not been scanned for malware.',
    );
  }

  const { token } = generateToken(32);
  const expiresAt = new Date(Date.now() + env.LOGISTICS_DOCUMENT_URL_TTL_SECONDS * 1000);

  // The AuthToken table, like every other signed link here, so the existing
  // expiry sweep and single-use enforcement apply unchanged.
  await prisma.authToken.create({
    data: {
      id: newId(),
      userId: adminUserId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: tokenHashFor(document.id, token),
      expiresAt,
      createdById: adminUserId,
    },
  });

  return {
    url: `/api/v1/admin/buyer-company-documents/${document.id}/download?token=${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Spend a link and hand over the bytes. Audited, and on the company's timeline. */
export async function redeemDocumentLink(
  adminUserId: string,
  documentId: string,
  token: string,
  correlationId?: string | null,
): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const record = await prisma.authToken.findUnique({
    where: { tokenHash: tokenHashFor(documentId, token) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });

  if (
    record === null ||
    record.userId !== adminUserId ||
    record.consumedAt !== null ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
  }

  const document = await prisma.buyerCompanyDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      kind: true,
      companyId: true,
      storageKey: true,
      mimeType: true,
      scanState: true,
      company: { select: { applicationReference: true } },
    },
  });
  if (document === null) throw notFound('Document');
  if (!isServable(document.scanState)) {
    throw conflict(ErrorCode.BUYER_COMPANY_DOCUMENT_REJECTED, 'This file cannot be downloaded.');
  }

  const consumed = await prisma.authToken.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw forbidden(ErrorCode.TOKEN_ALREADY_USED, 'This download link has already been used.');
  }

  await prisma.$transaction(async (tx) => {
    await writeEvent(tx, {
      companyId: document.companyId,
      kind: 'DOCUMENT_VIEWED',
      visibility: 'INTERNAL',
      actor: { type: 'ADMIN', userId: adminUserId },
      data: { documentId, kind: document.kind },
    });
    await recordAudit(
      {
        action: AuditAction.BUYER_COMPANY_DOCUMENT_VIEWED,
        resourceType: 'buyer_company_document',
        resourceId: documentId,
        actorType: 'ADMIN',
        actorUserId: adminUserId,
        after: { companyId: document.companyId, kind: document.kind },
        correlationId: correlationId ?? null,
      },
      tx,
    );
  });

  const extension =
    document.mimeType === 'application/pdf' ? 'pdf' : (document.mimeType.split('/')[1] ?? 'bin');
  return {
    body: await storage.get(document.storageKey),
    contentType: document.mimeType,
    fileName: `${document.company.applicationReference}-${document.kind.toLowerCase()}.${extension}`,
  };
}

/** Accept or refuse one document. A refusal says why, in words the applicant reads. */
export async function decideCompanyDocument(input: {
  adminUserId: string;
  documentId: string;
  decision: 'ACCEPTED' | 'REJECTED';
  reason?: string | null;
  correlationId?: string | null;
}): Promise<{ companyId: string }> {
  const reason = input.reason?.trim() ?? '';
  if (input.decision === 'REJECTED' && reason.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the document is not accepted.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }

  return prisma.$transaction(async (tx) => {
    const document = await tx.buyerCompanyDocument.findUnique({
      where: { id: input.documentId },
      select: { id: true, companyId: true, status: true, kind: true },
    });
    if (document === null) throw notFound('Document');
    if (document.status === 'SUPERSEDED' || document.status === 'WITHDRAWN') {
      throw conflict(ErrorCode.CONFLICT, 'That document has been replaced or withdrawn.');
    }

    await tx.buyerCompanyDocument.update({
      where: { id: document.id },
      data: {
        status: input.decision,
        reviewedByUserId: input.adminUserId,
        reviewedAt: new Date(),
        reviewReason: reason.length > 0 ? reason.slice(0, 1000) : null,
      },
    });

    await writeEvent(tx, {
      companyId: document.companyId,
      kind: input.decision === 'ACCEPTED' ? 'DOCUMENT_ACCEPTED' : 'DOCUMENT_REJECTED',
      visibility: 'APPLICANT',
      actor: { type: 'ADMIN', userId: input.adminUserId },
      message: reason.length > 0 ? reason : null,
      data: { documentId: document.id, kind: document.kind },
    });

    await recordAudit(
      {
        action: AuditAction.BUYER_COMPANY_DOCUMENT_DECIDED,
        resourceType: 'buyer_company_document',
        resourceId: document.id,
        actorType: 'ADMIN',
        actorUserId: input.adminUserId,
        before: { status: document.status },
        after: { status: input.decision },
        correlationId: input.correlationId ?? null,
      },
      tx,
    );

    return { companyId: document.companyId };
  });
}
