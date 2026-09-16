/**
 * A seller's evidence: certificates, licences and the paperwork behind them.
 *
 * This is the file that makes the Compliance step of the application mean
 * something. Before it, a deployment that needed a CE certificate could ask for
 * one and had nowhere to put it - "evidence arrives by other means and is
 * attached by the marketplace team" is what the operator's review screen used
 * to say, which in practice meant an email with an attachment nobody could
 * later find.
 *
 * Four rules run through the whole file, and each one has cost somebody
 * somewhere real money when it was skipped:
 *
 *  1. **The bytes live under the PRIVATE storage prefix and are read back only
 *     through a short-lived, single-use link.** A notified-body certificate
 *     names an auditor and a factory; an identity document is somebody's
 *     passport. Neither is ever a guessable URL and neither is ever a permanent
 *     one. The same shape the logistics documents, the report exports and the
 *     Art. 15 bundle already use.
 *
 *  2. **The bytes decide the type, never the header.** `sniffDocumentType`
 *     accepts a PDF or a picture of a certificate and refuses everything else -
 *     no Word documents, no archives, and emphatically no SVG.
 *
 *  3. **An unscanned file is never called clean.** No malware scanner is
 *     configured in this repository, so an upload records
 *     `SCANNER_UNCONFIGURED`, which is the truth. Whether an operator may then
 *     read it by eye is their decision; what cannot happen is a file being
 *     marked CLEAN because nothing looked at it.
 *
 *  4. **Uploading is not approving.** A seller can put a certificate up; only
 *     the marketplace can accept it, and the Compliance step only completes
 *     when every REQUIRED document for that country and seller kind has been
 *     accepted. A step that ticked on upload would let a seller submit an
 *     application by attaching a blank page.
 */
import type { SellerDocumentKind, SellerDocumentScanState } from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { createHash } from 'node:crypto';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { sniffDocumentType, storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  createAdminNotification,
} from '../notifications/admin-notification.service.js';
import { Permission } from '../../domain/permissions.js';
import { OPERATOR_LABEL, recordSellerAudit } from './audit.service.js';
import { notifySeller } from './notification.service.js';
import { markRequirementSteps, type RequirementStepSubject } from './onboarding.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';

/**
 * Ten megabytes. A scanned certificate, not a scanned filing cabinet.
 *
 * Its own limit rather than `UPLOAD_MAX_BYTES`, which defaults to five and
 * exists to stop a RAW file per product: a multi-page CE certificate scanned at
 * 300dpi is routinely bigger than a product photograph, and raising the
 * catalogue's ceiling to accept one would be raising it for everything.
 */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * How many live documents one seller may hold.
 *
 * Generous - a manufacturer with eleven product families has eleven
 * declarations of conformity - but not unbounded, because every one of these
 * is rendered in a list on the operator's review screen and read from private
 * storage one signed link at a time.
 */
const MAX_DOCUMENTS_PER_SELLER = 60;

/**
 * Which kinds a seller may upload for themselves.
 *
 * Every kind in the enum except the ones that are not evidence ABOUT the
 * seller: `BRAND_AUTHORISATION` and `TRADEMARK_EVIDENCE` belong to a brand
 * request, and `INSTRUCTIONS_FOR_USE` and `STERILISATION_EVIDENCE` belong to a
 * listing. Attaching one here would put it on the account rather than on the
 * thing it is evidence for, where the person reviewing that thing would never
 * find it.
 */
export const SELLER_UPLOADABLE_KINDS = Object.freeze([
  'BUSINESS_REGISTRATION',
  'TAX_CERTIFICATE',
  'IDENTITY_PROOF',
  'ADDRESS_PROOF',
  'ISO_13485',
  'CE_CERTIFICATE',
  'DECLARATION_OF_CONFORMITY',
  'NOTIFIED_BODY_CERTIFICATE',
  'REGULATORY_LICENCE',
  'BANK_STATEMENT',
  'OTHER',
] as const);

export type SellerUploadableKind = (typeof SELLER_UPLOADABLE_KINDS)[number];

const UPLOADABLE = new Set<string>(SELLER_UPLOADABLE_KINDS);

/**
 * Scan a file, or record honestly that nothing did.
 *
 * The seam a deployment wires a scanner into. It deliberately does NOT return
 * CLEAN: a function that says "clean" when it did nothing is the worst thing
 * this file could contain, because every control downstream would be reading a
 * value it had no reason to trust.
 */
function scanDocument(_bytes: Buffer): { state: SellerDocumentScanState; scannedAt: Date | null } {
  return { state: 'SCANNER_UNCONFIGURED', scannedAt: null };
}

/**
 * May this file be handed to somebody?
 *
 * CLEAN always. `SCANNER_UNCONFIGURED` and `PENDING_SCAN` only where the
 * operator has said so - `SELLER_ALLOW_UNSCANNED_DOCUMENTS`, which defaults to
 * TRUE and explains itself in `config/env.ts`. INFECTED and SCAN_FAILED never,
 * and PENDING is on the permissive side of that line only because nothing in
 * this repository ever moves a file off it: "the scan has not finished" would
 * belong with the refusals the moment a scanner exists to finish one.
 */
function isServable(scanState: SellerDocumentScanState): boolean {
  if (scanState === 'CLEAN') return true;
  if (scanState === 'SCANNER_UNCONFIGURED' || scanState === 'PENDING_SCAN') {
    return env.SELLER_ALLOW_UNSCANNED_DOCUMENTS;
  }
  return false;
}

/** What the seller's own screen and the operator's review screen both render. */
export interface SellerDocumentView {
  id: string;
  kind: SellerDocumentKind;
  /** The requirement it was uploaded against, where it answers one. */
  requirementFieldKey: string | null;
  originalFileName: string;
  contentType: string;
  byteSize: number;
  scanState: SellerDocumentScanState;
  /** Accepted, refused, or neither - the three states a reviewer can leave. */
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  rejectedReason: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  /** True where the deployment will actually serve the bytes. */
  isDownloadable: boolean;
  createdAt: string;
}

interface DocumentRow {
  id: string;
  kind: SellerDocumentKind;
  requirementFieldKey: string | null;
  originalFileName: string;
  contentType: string;
  byteSize: number;
  scanState: SellerDocumentScanState;
  approvedAt: Date | null;
  rejectedReason: string | null;
  issuedOn: Date | null;
  expiresOn: Date | null;
  createdAt: Date;
}

function toView(row: DocumentRow): SellerDocumentView {
  return {
    id: row.id,
    kind: row.kind,
    requirementFieldKey: row.requirementFieldKey,
    originalFileName: row.originalFileName,
    contentType: row.contentType,
    byteSize: row.byteSize,
    scanState: row.scanState,
    status:
      row.approvedAt !== null ? 'APPROVED' : row.rejectedReason !== null ? 'REJECTED' : 'PENDING',
    rejectedReason: row.rejectedReason,
    // Dates, not timestamps: a certificate is issued on a day, not at a moment,
    // and rendering it with a time attaches a precision nobody supplied.
    issuedOn: row.issuedOn === null ? null : row.issuedOn.toISOString().slice(0, 10),
    expiresOn: row.expiresOn === null ? null : row.expiresOn.toISOString().slice(0, 10),
    isDownloadable: isServable(row.scanState),
    createdAt: row.createdAt.toISOString(),
  };
}

const DOCUMENT_SELECT = {
  id: true,
  kind: true,
  requirementFieldKey: true,
  originalFileName: true,
  contentType: true,
  byteSize: true,
  scanState: true,
  approvedAt: true,
  rejectedReason: true,
  issuedOn: true,
  expiresOn: true,
  createdAt: true,
} as const;

// ---------------------------------------------------------------------------
// The step behind the documents
// ---------------------------------------------------------------------------

/**
 * Re-derive the steps that documents can satisfy, and record the answer.
 *
 * A thin wrapper on purpose. What counts as a finished step is decided in ONE
 * place - `markRequirementSteps` in `onboarding.service.ts` - because that
 * function also judges the typed fields on the same steps, and two functions
 * marking one step from two directions would flap between them on every save.
 *
 * Called after every upload, every withdrawal and every operator decision, so
 * the tick on the seller’s checklist and the state the submit gate reads can
 * never disagree.
 */
export async function refreshDocumentSteps(owner: RequirementStepSubject): Promise<void> {
  await markRequirementSteps(owner);
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

export interface UploadSellerDocumentInput {
  membership: SellerMembership;
  kind: SellerUploadableKind;
  /** The requirement this answers, where it answers one. */
  requirementFieldKey?: string | null;
  fileName: string;
  bytes: Buffer;
  /** Both optional: not every kind of evidence has dates on it. */
  issuedOn?: Date | null;
  expiresOn?: Date | null;
  correlationId?: string | null;
}

/**
 * Put one file up against a seller account.
 *
 * Uploading a second file of the same kind SUPERSEDES the first rather than
 * replacing it. The old row is kept and marked, because the document an
 * approval was granted against has to stay readable: "we accepted their CE
 * certificate in March" is only an answer if the March file still exists.
 *
 * NOT gated on `assertApplicationEditable`. An approved seller whose ISO
 * certificate expires next month must be able to upload the renewal without
 * their application being reopened, and a seller whose application is with a
 * reviewer is exactly who gets asked for another document.
 */
export async function uploadSellerDocument(
  input: UploadSellerDocumentInput,
): Promise<SellerDocumentView> {
  const { membership } = input;
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);

  if (!UPLOADABLE.has(input.kind)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That is not a document you can attach here.', [
      { field: 'kind', code: 'NOT_UPLOADABLE' },
    ]);
  }

  if (input.bytes.length === 0) {
    throw badRequest(ErrorCode.IMPORT_FILE_INVALID, 'The uploaded file is empty.');
  }

  if (input.bytes.length > MAX_DOCUMENT_BYTES) {
    throw badRequest(ErrorCode.MEDIA_TOO_LARGE, 'That file is too large. The limit is 10 MB.', [
      { field: 'file', code: 'TOO_LARGE', meta: { maxBytes: MAX_DOCUMENT_BYTES } },
    ]);
  }

  // Dates first, because refusing an impossible one after the bytes are in the
  // object store would leave an orphan behind.
  if (
    input.issuedOn !== null &&
    input.issuedOn !== undefined &&
    input.expiresOn !== null &&
    input.expiresOn !== undefined &&
    input.expiresOn.getTime() < input.issuedOn.getTime()
  ) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The expiry date is before the date it was issued.',
      [{ field: 'expiresOn', code: 'BEFORE_ISSUED' }],
    );
  }

  const live = await prisma.sellerDocument.count({
    where: { sellerAccountId: membership.sellerAccountId, supersededAt: null },
  });

  if (live >= MAX_DOCUMENTS_PER_SELLER) {
    throw conflict(
      ErrorCode.CONFLICT,
      `You can hold ${String(MAX_DOCUMENTS_PER_SELLER)} documents at a time. Remove one you no longer need.`,
    );
  }

  // The BYTES decide the type. A client can claim anything.
  const sniffed = sniffDocumentType(input.bytes);

  const stored = await storage.put(input.bytes, sniffed.mimeType, sniffed.extension, 'private');
  const scan = scanDocument(input.bytes);

  const id = newId();
  const requirementFieldKey = input.requirementFieldKey ?? null;

  await prisma.$transaction(async (tx) => {
    /*
     * Supersede whatever this replaces.
     *
     * Keyed on the requirement where there is one and on the kind where there
     * is not: a seller answering two different requirements with two CE
     * certificates must not have the second retire the first, and a seller
     * re-uploading a clearer scan of the same thing must.
     */
    await tx.sellerDocument.updateMany({
      where: {
        sellerAccountId: membership.sellerAccountId,
        supersededAt: null,
        ...(requirementFieldKey === null
          ? { kind: input.kind, requirementFieldKey: null }
          : { requirementFieldKey }),
      },
      data: { supersededAt: new Date() },
    });

    await tx.sellerDocument.create({
      data: {
        id,
        sellerAccountId: membership.sellerAccountId,
        kind: input.kind,
        requirementFieldKey,
        storageKey: stored.storageKey,
        // Truncated rather than rejected: a seller whose scanner names files
        // with the whole document title should not be told to rename it. The
        // name is shown back to them and never used to build a path.
        originalFileName: input.fileName.slice(0, 255),
        contentType: stored.mimeType,
        byteSize: stored.sizeBytes,
        // So the stored file can later be shown to be the one that was
        // uploaded, which is what makes a certificate evidence rather than a
        // picture of one.
        contentHash: createHash('sha256').update(input.bytes).digest('hex'),
        scanState: scan.state,
        scannedAt: scan.scannedAt,
        issuedOn: input.issuedOn ?? null,
        expiresOn: input.expiresOn ?? null,
        uploadedByProfileId: membership.customerProfileId,
      },
    });
  });

  await refreshDocumentSteps(membership);

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.document.uploaded',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_document',
    resourceId: id,
    summary: `${input.fileName} was uploaded as ${humaniseKind(input.kind)}.`,
    correlationId: input.correlationId ?? null,
  });

  /*
   * And tell the marketplace, because nobody is watching this table.
   *
   * Without this, a certificate uploaded on a Friday sits unreviewed until
   * somebody happens to open that seller's screen. The badge on the console's
   * navigation counts the same rows this notification announces, so the two
   * always agree. `customer.read` rather than no permission at all: the row
   * names a business and what it is trying to prove about itself.
   */
  await createAdminNotification({
    kind: AdminNotificationKind.SELLER_DOCUMENT_UPLOADED,
    variables: {
      sellerName: membership.displayName,
      documentKind: humaniseKind(input.kind),
      fileName: input.fileName.slice(0, 120),
    },
    linkPath: `/sellers/${membership.sellerAccountId}`,
    requiredPermission: Permission.CUSTOMER_READ,
    relatedType: 'seller_document',
    relatedId: id,
    dedupeKey: `seller-document:${id}`,
  });

  const row = await prisma.sellerDocument.findUniqueOrThrow({
    where: { id },
    select: DOCUMENT_SELECT,
  });

  return toView(row);
}

/** "CE certificate" from CE_CERTIFICATE. */
function humaniseKind(kind: string): string {
  const words = kind.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Everything this seller has up, newest first. */
export async function listSellerDocuments(
  membership: SellerMembership,
): Promise<SellerDocumentView[]> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_READ);

  const rows = await prisma.sellerDocument.findMany({
    where: { sellerAccountId: membership.sellerAccountId, supersededAt: null },
    orderBy: { createdAt: 'desc' },
    select: DOCUMENT_SELECT,
  });

  return rows.map(toView);
}

/**
 * Withdraw one.
 *
 * Only while it is undecided. A document the marketplace has accepted is part
 * of the record of why this seller was approved, and letting the seller delete
 * it would leave that decision unexplainable. A REFUSED one stays too, so the
 * reason it was refused survives the seller's next attempt.
 *
 * Marked superseded rather than deleted, and the bytes go with it - a withdrawn
 * document nobody will ever read is a copy of somebody's passport sitting in
 * object storage for no reason.
 */
export async function withdrawSellerDocument(
  membership: SellerMembership,
  documentId: string,
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);

  const row = await prisma.sellerDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      sellerAccountId: true,
      kind: true,
      storageKey: true,
      originalFileName: true,
      approvedAt: true,
      supersededAt: true,
    },
  });

  if (row === null) throw notFound('Document');
  assertSellerOwnership(membership, row.sellerAccountId, 'Document');

  if (row.supersededAt !== null) return;

  if (row.approvedAt !== null) {
    throw conflict(
      ErrorCode.CONFLICT,
      'This document has been accepted and is part of your approval. Upload a newer one instead.',
    );
  }

  await prisma.sellerDocument.update({
    where: { id: row.id },
    data: { supersededAt: new Date() },
  });

  // Best-effort: a row correctly withdrawn must not be rolled back because the
  // object store was briefly unreachable. The sweep that matters - nobody can
  // read it - has already happened, because every read goes through a query
  // that filters `supersededAt`.
  try {
    await storage.delete(row.storageKey);
  } catch {
    // Already gone is the desired end state.
  }

  await refreshDocumentSteps(membership);

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.document.withdrawn',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_document',
    resourceId: row.id,
    summary: `${row.originalFileName} was withdrawn.`,
    correlationId: correlationId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Reading the bytes back
// ---------------------------------------------------------------------------

export interface SignedDocumentLink {
  url: string;
  expiresAt: string;
  fileName: string;
  contentType: string;
}

/**
 * How long a link lives.
 *
 * Reused from the carrier documents rather than given a setting of its own: a
 * deployment that has decided how long a signed document link should last has
 * decided it for every private document, and two settings is one of them being
 * wrong.
 */
function linkTtlMs(): number {
  return env.LOGISTICS_DOCUMENT_URL_TTL_SECONDS * 1000;
}

/**
 * Mint a link that works for a few minutes and then does not.
 *
 * The token is 32 bytes of CSPRNG output; only its SHA-256 is stored, the
 * DOCUMENT id is part of what is hashed - so a token minted for one file cannot
 * redeem another - and it is single-use. An unguessable path is not an
 * authorisation, and a link that outlives the page it was rendered on ends up
 * in a chat window.
 *
 * `audience` decides which route redeems it, and the two are separate on
 * purpose: a seller's link works on the seller route and an operator's works on
 * the operator route, so a link forwarded between the two is simply invalid.
 */
async function mintLink(
  audience: 'seller' | 'admin',
  userId: string,
  document: { id: string; originalFileName: string; contentType: string; scanState: SellerDocumentScanState },
): Promise<SignedDocumentLink> {
  if (!isServable(document.scanState)) {
    throw conflict(
      ErrorCode.SELLER_DOCUMENT_REJECTED,
      'This installation does not serve files that have not been scanned for malware.',
      [{ code: 'SCAN_STATE', meta: { scanState: document.scanState } }],
    );
  }

  const { token } = generateToken(32);
  const expiresAt = new Date(Date.now() + linkTtlMs());

  /*
   * Stored on the AuthToken table the rest of the system uses rather than in a
   * store of its own, so the existing expiry sweep and the existing single-use
   * enforcement apply for free and none of them can drift from the others.
   */
  await prisma.authToken.create({
    data: {
      id: newId(),
      userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: sha256Hex(`seller-document:${audience}:${document.id}:${token}`),
      expiresAt,
      createdById: userId,
    },
  });

  const base =
    audience === 'seller'
      ? `/api/v1/seller/documents/${document.id}/download`
      : `/api/v1/admin/seller-documents/${document.id}/download`;

  return {
    url: `${base}?token=${token}`,
    expiresAt: expiresAt.toISOString(),
    fileName: document.originalFileName,
    contentType: document.contentType,
  };
}

/** A link to one of this seller's own documents. */
export async function createSellerDocumentLink(
  membership: SellerMembership,
  userId: string,
  documentId: string,
): Promise<SignedDocumentLink> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_READ);

  const document = await prisma.sellerDocument.findFirst({
    // The tenant boundary as part of the query rather than a check afterwards:
    // another seller's document is never loaded.
    where: { id: documentId, sellerAccountId: membership.sellerAccountId },
    select: { id: true, originalFileName: true, contentType: true, scanState: true },
  });

  if (document === null) throw notFound('Document');

  return mintLink('seller', userId, document);
}

/** A link to any seller's document, for the operator reviewing it. */
export async function createAdminDocumentLink(
  adminUserId: string,
  documentId: string,
  correlationId?: string | null,
): Promise<SignedDocumentLink> {
  const document = await prisma.sellerDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      sellerAccountId: true,
      originalFileName: true,
      contentType: true,
      scanState: true,
    },
  });

  if (document === null) throw notFound('Document');

  const link = await mintLink('admin', adminUserId, document);

  // Who opened somebody's identity document, and when. On the operator's trail
  // rather than the seller's: this is the marketplace's own accountability
  // record, and it is the row an auditor asks for.
  await recordAudit({
    action: AuditAction.SELLER_DOCUMENT_VIEWED,
    resourceType: 'seller_document',
    resourceId: document.id,
    actorType: 'ADMIN',
    actorUserId: adminUserId,
    actorEmail: null,
    after: { sellerAccountId: document.sellerAccountId, fileName: document.originalFileName },
    correlationId: correlationId ?? null,
  });

  return link;
}

/**
 * Redeem a link and hand over the bytes.
 *
 * The token is the authority AND the caller's session is checked, because a
 * link forwarded to a colleague should not work for them. Both, rather than
 * either.
 */
export async function redeemDocumentLink(
  audience: 'seller' | 'admin',
  userId: string,
  documentId: string,
  token: string,
  /** The seller whose documents the caller may read. Null for an operator. */
  sellerAccountId: string | null,
): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const record = await prisma.authToken.findUnique({
    where: { tokenHash: sha256Hex(`seller-document:${audience}:${documentId}:${token}`) },
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

  const document = await prisma.sellerDocument.findFirst({
    where: {
      id: documentId,
      ...(sellerAccountId === null ? {} : { sellerAccountId }),
    },
    select: { storageKey: true, contentType: true, originalFileName: true, scanState: true },
  });

  if (document === null) throw notFound('Document');
  if (!isServable(document.scanState)) {
    throw conflict(ErrorCode.SELLER_DOCUMENT_REJECTED, 'This file cannot be downloaded.');
  }

  /*
   * Single use, enforced by a conditional update rather than by reading and
   * then writing. A browser that follows a redirect twice would otherwise spend
   * the token on the first hop.
   */
  const consumed = await prisma.authToken.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  if (consumed.count !== 1) {
    throw forbidden(ErrorCode.TOKEN_ALREADY_USED, 'This download link has already been used.');
  }

  const body = await storage.get(document.storageKey);

  return { body, contentType: document.contentType, fileName: document.originalFileName };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface DocumentDecisionInput {
  documentId: string;
  decision: 'APPROVED' | 'REJECTED';
  /** Seller-visible, and required on a refusal. */
  reason?: string | null;
  adminUserId: string;
  correlationId?: string | null;
}

/**
 * Accept or refuse one piece of evidence.
 *
 * A refusal must say why, and the rule is enforced here rather than in the
 * form: "your certificate was not accepted" with no reason is a seller who
 * uploads the same file again, and a queue that grows.
 *
 * The seller is told either way. An acceptance is worth telling them about
 * because it is usually the last thing standing between them and being able to
 * sell, and a refusal is worth telling them about for the obvious reason.
 */
export async function decideSellerDocument(input: DocumentDecisionInput): Promise<void> {
  const reason = input.reason?.trim() ?? '';

  if (input.decision === 'REJECTED' && reason.length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Say why it was not accepted. The seller sees this.',
      [{ field: 'reason', code: 'REQUIRED' }],
    );
  }

  const document = await prisma.sellerDocument.findUnique({
    where: { id: input.documentId },
    select: {
      id: true,
      sellerAccountId: true,
      kind: true,
      originalFileName: true,
      approvedAt: true,
      rejectedReason: true,
      supersededAt: true,
    },
  });

  if (document === null) throw notFound('Document');

  if (document.supersededAt !== null) {
    throw conflict(
      ErrorCode.CONFLICT,
      'The seller has replaced this document. Decide the newer one instead.',
    );
  }

  const isApproval = input.decision === 'APPROVED';

  await prisma.sellerDocument.update({
    where: { id: document.id },
    data: {
      approvedAt: isApproval ? new Date() : null,
      approvedByUserId: isApproval ? input.adminUserId : null,
      // Cleared on an approval, so a document sent back and then accepted does
      // not keep showing the seller the reason it was once refused.
      rejectedReason: isApproval ? null : reason,
    },
  });

  await recordAudit({
    action: isApproval ? AuditAction.SELLER_DOCUMENT_APPROVED : AuditAction.SELLER_DOCUMENT_REJECTED,
    resourceType: 'seller_document',
    resourceId: document.id,
    actorType: 'ADMIN',
    actorUserId: input.adminUserId,
    actorEmail: null,
    before: { approvedAt: document.approvedAt, rejectedReason: document.rejectedReason },
    after: { approvedAt: isApproval ? new Date() : null, rejectedReason: isApproval ? null : reason },
    correlationId: input.correlationId ?? null,
  });

  await recordSellerAudit({
    sellerAccountId: document.sellerAccountId,
    action: isApproval ? 'seller.document.approved' : 'seller.document.rejected',
    // A role, never a named member of staff: a seller has no business learning
    // which individual reviewed them.
    actor: { type: 'ADMIN', label: OPERATOR_LABEL },
    resourceType: 'seller_document',
    resourceId: document.id,
    summary: isApproval
      ? `${document.originalFileName} was accepted.`
      : `${document.originalFileName} was not accepted: ${reason}`,
    correlationId: input.correlationId ?? null,
  });

  await notifySeller({
    sellerAccountId: document.sellerAccountId,
    kind: 'APPLICATION_STATUS',
    title: isApproval ? 'A document was accepted' : 'A document was not accepted',
    body: isApproval
      ? `${humaniseKind(document.kind)} (${document.originalFileName}) has been accepted.`
      : reason,
    linkPath: '/seller/onboarding',
    severity: isApproval ? 'SUCCESS' : 'WARNING',
    subjectType: 'seller_document',
    subjectId: document.id,
  });

  /*
   * And re-derive the steps.
   *
   * Loaded from the account rather than from a membership, because the operator
   * deciding this has none. The seller's checklist has to answer to what the
   * marketplace has decided, not only to what the seller has uploaded, or an
   * accepted certificate would leave the step stuck on "we are checking it"
   * until the seller happened to touch that screen.
   */
  const account = await prisma.sellerAccount.findUnique({
    where: { id: document.sellerAccountId },
    select: { id: true, registrationCountry: true },
  });

  if (account !== null) {
    await refreshDocumentSteps({
      sellerAccountId: account.id,
      registrationCountry: account.registrationCountry,
    });
  }
}

/** One seller's documents, for the operator's review screen. */
export async function listDocumentsForReview(
  sellerAccountId: string,
): Promise<SellerDocumentView[]> {
  const rows = await prisma.sellerDocument.findMany({
    where: { sellerAccountId, supersededAt: null },
    orderBy: { createdAt: 'desc' },
    select: DOCUMENT_SELECT,
  });

  return rows.map(toView);
}
