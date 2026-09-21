/**
 * Paperwork and proof.
 *
 * Labels, packing lists, customs documents, damage photographs, signatures and
 * Proofs of Delivery. Two rules govern all of them and neither is negotiable:
 *
 *  1. **The bytes live under the PRIVATE storage prefix and are read back only
 *     through a short-lived signed token.** A signature is a person's
 *     handwriting; a commercial invoice is a price list. Neither is ever a
 *     guessable URL and neither is ever a public one.
 *
 *  2. **An unscanned file is never marked clean.** This deployment ships with
 *     no malware scanner, so an upload records `SKIPPED`, and whether a
 *     SKIPPED document may be served is the operator's own decision
 *     (`LOGISTICS_ALLOW_UNSCANNED_DOCUMENTS`, false by default). The one thing
 *     that cannot happen is a file being called CLEAN because nothing looked
 *     at it.
 *
 * WHO MAY READ WHAT
 *
 * Visibility is per DOCUMENT rather than per kind, because the same kind can
 * be either: a commercial invoice is essential at a customs post and none of a
 * domestic courier's business. The default for anything priced is OPERATOR.
 */
import type {
  LogisticsDocumentAudience,
  LogisticsDocumentKind,
  LogisticsDocumentScanState,
} from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import {
  ErrorCode,
  badRequest,
  conflict,
  forbidden,
  notFound,
  serviceUnavailable,
} from '../../domain/errors.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import {
  MalwareDetectedError,
  MalwareScannerUnavailableError,
  scanForMalware,
} from '../../infra/malware-scan.js';
import { prisma } from '../../infra/prisma.js';
import { sniffMediaType, storage } from '../../infra/storage/index.js';
import { recordLogisticsAudit } from './audit.service.js';
import { assertShipmentAccess } from './shipment.service.js';
import {
  assertLogisticsPermission,
  type LogisticsMembership,
} from './partner.service.js';

/**
 * Ten megabytes. A photograph of a damaged pallet, not a video of one.
 *
 * Its own limit rather than `UPLOAD_MAX_BYTES`: a carrier's evidence
 * photograph and an operator's product image are different jobs with different
 * ceilings, and sharing one would mean raising the catalogue's limit to accept
 * a pallet photograph.
 */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * Which document kinds a carrier may upload.
 *
 * A carrier produces evidence - what it saw, what it collected, what it handed
 * over. It does not produce the commercial paperwork: a commercial invoice or
 * a customs declaration is the seller's or the operator's, and a carrier that
 * could upload one could substitute one.
 */
const PARTNER_UPLOADABLE: ReadonlySet<LogisticsDocumentKind> = new Set<LogisticsDocumentKind>([
  'PROOF_OF_DELIVERY',
  'DELIVERY_SIGNATURE',
  'DELIVERY_PHOTO',
  'DAMAGE_EVIDENCE',
  'RETURN_DOCUMENT',
  'MANIFEST',
  'OTHER',
]);

export interface UploadDocumentInput {
  shipmentId: string;
  kind: LogisticsDocumentKind;
  fileName: string;
  contentType: string;
  bytes: Buffer;
  audience?: LogisticsDocumentAudience;
}

export interface StoredDocument {
  id: string;
  kind: LogisticsDocumentKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanState: LogisticsDocumentScanState;
  createdAt: Date;
}

/**
 * Scan a file, or record honestly that nothing did.
 *
 * The seam a deployment wires a scanner into. Today it returns SKIPPED, which
 * is the truth, and `LOGISTICS_ALLOW_UNSCANNED_DOCUMENTS` decides whether a
 * SKIPPED file may later be served.
 *
 * It deliberately does NOT return CLEAN. A function that says "clean" when it
 * did nothing is the single worst thing this file could contain, because every
 * control downstream would be reading a value it had no reason to trust.
 */
async function scanDocument(
  bytes: Buffer,
): Promise<{ state: LogisticsDocumentScanState; detail: string | null }> {
  try {
    const result = await scanForMalware(bytes);
    return result.status === 'CLEAN'
      ? { state: 'CLEAN', detail: null }
      : { state: 'SKIPPED', detail: 'Malware scanning is disabled in this environment.' };
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
 * Store one file against a consignment.
 *
 * The content type is checked against the allowlist AND the bytes are hashed,
 * so a file can later be shown to be the one that was uploaded - which is what
 * makes a delivery photograph evidence rather than a picture.
 */
export async function uploadShipmentDocument(
  membership: LogisticsMembership,
  input: UploadDocumentInput,
  correlationId?: string | null,
): Promise<StoredDocument> {
  assertLogisticsPermission(membership, LogisticsPermission.DOCUMENT_WRITE);

  if (!PARTNER_UPLOADABLE.has(input.kind)) {
    throw forbidden(
      ErrorCode.PERMISSION_DENIED,
      'A carrier can attach evidence to a shipment, not its commercial paperwork.',
    );
  }

  /*
   * The BYTES decide the type, never the header.
   *
   * `sniffMediaType` reads the magic bytes and throws for anything it does not
   * recognise - which includes SVG, deliberately, because an SVG is a
   * script-capable document rather than a picture and serving one inline is a
   * stored-XSS vector. A client can claim any Content-Type; only the file
   * itself is trusted.
   */
  const sniffed = sniffMediaType(input.bytes);

  if (sniffed.kind !== 'IMAGE') {
    throw badRequest(ErrorCode.MEDIA_TYPE_NOT_ALLOWED, 'Attach a photograph.', [
      { field: 'file', code: 'TYPE_NOT_ALLOWED', meta: { mimeType: sniffed.mimeType } },
    ]);
  }

  if (input.bytes.length === 0 || input.bytes.length > MAX_DOCUMENT_BYTES) {
    throw badRequest(ErrorCode.MEDIA_TOO_LARGE, 'That file is too large. The limit is 10 MB.', [
      { field: 'file', code: 'TOO_LARGE', meta: { maxBytes: MAX_DOCUMENT_BYTES } },
    ]);
  }

  const access = await assertShipmentAccess(membership, input.shipmentId, 'WRITE');

  const id = newId();

  /*
   * PRIVATE, always.
   *
   * The driver puts it under the private prefix and returns the key it chose;
   * the static route is not mounted over that prefix at all, so an unguessable
   * URL is never the only thing between a signature image and the open
   * internet.
   */
  // Scan before storage so malicious bytes never enter the object store.
  const scan = await scanDocument(input.bytes);
  const stored = await storage.put(input.bytes, sniffed.mimeType, sniffed.extension, 'private');

  await prisma.logisticsShipmentDocument.create({
    data: {
      id,
      shipmentId: access.shipmentId,
      kind: input.kind,
      audience: input.audience ?? 'BOTH',
      fileName: input.fileName.slice(0, 255),
      contentType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      storageKey: stored.storageKey,
      // So a file can later be shown to be the one that was uploaded, which is
      // what makes a delivery photograph evidence rather than a picture.
      contentHash: stored.checksum,
      scanState: scan.state,
      scannedAt: scan.state === 'PENDING' ? null : new Date(),
      scanDetail: scan.detail,
      uploadedByUserId: membership.userId,
      uploadedBySource: membership.driverProfileId !== null ? 'DRIVER_APP' : 'LOGISTICS_PORTAL',
    },
  });

  await recordLogisticsAudit({
    logisticsPartnerId: membership.logisticsPartnerId,
    actorUserId: membership.userId,
    actorLabel: membership.fullName,
    action: 'logistics.document.uploaded',
    resourceType: 'logistics_shipment_document',
    resourceId: id,
    after: { kind: input.kind, sizeBytes: input.bytes.length, scanState: scan.state },
    summary: `${input.fileName} was attached.`,
    correlationId: correlationId ?? null,
  });

  return {
    id,
    kind: input.kind,
    fileName: input.fileName,
    contentType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    scanState: scan.state,
    createdAt: new Date(),
  };
}

export interface DocumentRow {
  id: string;
  kind: LogisticsDocumentKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanState: LogisticsDocumentScanState;
  /** False where the deployment refuses unscanned files. */
  isDownloadable: boolean;
  createdAt: Date;
}

/**
 * The documents a carrier may see on one consignment.
 *
 * Filtered by audience in the QUERY. An OPERATOR-only document is never
 * loaded, rather than loaded and hidden - the same reasoning that keeps prices
 * out of the shipment select entirely.
 */
export async function listShipmentDocuments(
  membership: LogisticsMembership,
  shipmentId: string,
): Promise<DocumentRow[]> {
  assertLogisticsPermission(membership, LogisticsPermission.DOCUMENT_READ);

  const access = await assertShipmentAccess(membership, shipmentId, 'READ');

  const rows = await prisma.logisticsShipmentDocument.findMany({
    where: {
      shipmentId: access.shipmentId,
      deletedAt: null,
      audience: { in: ['PARTNER', 'BOTH'] },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      kind: true,
      fileName: true,
      contentType: true,
      sizeBytes: true,
      scanState: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({ ...row, isDownloadable: isServable(row.scanState) }));
}

/**
 * May this file be handed to somebody?
 *
 * CLEAN always. SKIPPED only where the operator has said so. INFECTED, FAILED
 * and PENDING never - and PENDING is in that list deliberately: "the scan has
 * not finished" is not "the scan passed".
 */
function isServable(scanState: LogisticsDocumentScanState): boolean {
  if (scanState === 'CLEAN') return true;
  if (scanState === 'SKIPPED') return env.LOGISTICS_ALLOW_UNSCANNED_DOCUMENTS;
  return false;
}

export interface SignedDocumentLink {
  url: string;
  expiresAt: Date;
  fileName: string;
  contentType: string;
}

/**
 * A link that works for a few minutes and then does not.
 *
 * The token is 32 bytes of CSPRNG output; only its SHA-256 is stored, and it
 * is single-purpose - it redeems ONE document. The same shape the report
 * export and the Art. 15 bundle downloads already use, and for the same
 * reason: an unguessable path is not an authorisation, and a link that
 * outlives the page it was rendered on ends up in a chat window.
 */
export async function createDocumentLink(
  membership: LogisticsMembership,
  documentId: string,
  correlationId?: string | null,
): Promise<SignedDocumentLink> {
  assertLogisticsPermission(membership, LogisticsPermission.DOCUMENT_READ);

  const document = await prisma.logisticsShipmentDocument.findFirst({
    where: {
      id: documentId,
      deletedAt: null,
      audience: { in: ['PARTNER', 'BOTH'] },
      // The tenant boundary, expressed as a join rather than checked
      // afterwards: a document on somebody else's consignment is never loaded.
      shipment: {
        assignments: { some: { logisticsPartnerId: membership.logisticsPartnerId } },
      },
    },
    select: {
      id: true,
      shipmentId: true,
      fileName: true,
      contentType: true,
      scanState: true,
    },
  });

  if (document === null) throw notFound('Document');

  // Re-checked through the one function that also narrows a driver to their
  // own stops.
  await assertShipmentAccess(membership, document.shipmentId, 'READ');

  if (!isServable(document.scanState)) {
    throw conflict(
      ErrorCode.SELLER_DOCUMENT_REJECTED,
      document.scanState === 'SKIPPED'
        ? 'This installation does not serve files that have not been scanned for malware.'
        : 'This file cannot be downloaded.',
      [{ code: 'SCAN_STATE', meta: { scanState: document.scanState } }],
    );
  }

  // The raw token only. The hash stored below binds the DOCUMENT id into it,
  // so `generateToken`'s own hash of the bare token would be the wrong value.
  const { token } = generateToken(32);
  const expiresAt = new Date(Date.now() + env.LOGISTICS_DOCUMENT_URL_TTL_SECONDS * 1000);

  /*
   * The token is stored on the AuthToken table the rest of the system uses,
   * scoped to the person who asked for it.
   *
   * Reusing that table rather than adding a fifth token store means the
   * existing expiry sweep, the existing single-use enforcement and the
   * existing "issuing a new one supersedes the old" behaviour all apply for
   * free - and none of them can drift from the others.
   */
  await prisma.authToken.create({
    data: {
      id: newId(),
      userId: membership.userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: sha256Hex(`logistics-document:${document.id}:${token}`),
      expiresAt,
      createdById: membership.userId,
    },
  });

  await recordLogisticsAudit({
    logisticsPartnerId: membership.logisticsPartnerId,
    actorUserId: membership.userId,
    actorLabel: membership.fullName,
    action: 'logistics.document.downloaded',
    resourceType: 'logistics_shipment_document',
    resourceId: document.id,
    summary: `${document.fileName} was downloaded.`,
    correlationId: correlationId ?? null,
  });

  return {
    url: `/api/v1/logistics/documents/${document.id}/download?token=${token}`,
    expiresAt,
    fileName: document.fileName,
    contentType: document.contentType,
  };
}

/**
 * Redeem a link and hand over the bytes.
 *
 * The token is the authority; the caller's session is checked too, because a
 * link forwarded to a colleague at another carrier should not work for them.
 * Both, rather than either.
 */
export async function redeemDocumentLink(
  membership: LogisticsMembership,
  documentId: string,
  token: string,
): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const record = await prisma.authToken.findUnique({
    // The document id is part of what is hashed, so a token minted for one
    // file cannot redeem another even for the same person.
    where: { tokenHash: sha256Hex(`logistics-document:${documentId}:${token}`) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });

  if (
    record === null ||
    record.userId !== membership.userId ||
    record.consumedAt !== null ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This download link is no longer valid.');
  }

  const document = await prisma.logisticsShipmentDocument.findFirst({
    where: {
      id: documentId,
      deletedAt: null,
      audience: { in: ['PARTNER', 'BOTH'] },
      shipment: {
        assignments: { some: { logisticsPartnerId: membership.logisticsPartnerId } },
      },
    },
    select: { storageKey: true, contentType: true, fileName: true, scanState: true },
  });

  if (document === null) throw notFound('Document');
  if (!isServable(document.scanState)) {
    throw conflict(ErrorCode.SELLER_DOCUMENT_REJECTED, 'This file cannot be downloaded.');
  }

  /*
   * Single use, enforced by a conditional update.
   *
   * A browser that follows a redirect twice would otherwise spend the token
   * on the first hop; guarding on `consumedAt: null` and checking the affected
   * count is the same pattern `consumeToken` uses, and it is what makes
   * "single use" true rather than intended.
   */
  const consumed = await prisma.authToken.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  if (consumed.count !== 1) {
    throw forbidden(ErrorCode.TOKEN_ALREADY_USED, 'This download link has already been used.');
  }

  // The driver throws for a key it cannot read, which is the right shape: a
  // row pointing at bytes that are gone is a fault rather than an empty file.
  const body = await storage.get(document.storageKey);

  return { body, contentType: document.contentType, fileName: document.fileName };
}
