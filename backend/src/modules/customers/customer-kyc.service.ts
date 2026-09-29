/**
 * An individual buyer's identity check, importer details and marketing
 * choices - checklist Master row 11.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 *
 *   - Identity details the buyer types: legal name, date of birth,
 *     nationality, residence, the kind of identity document and its expiry.
 *     The document NUMBER is kept only masked (`maskDocumentNumber`): the
 *     buyer types it, the last four characters are kept, the rest never
 *     reaches the database.
 *   - The files that prove it, in private storage, scanned before they are
 *     kept (the same rules as a company's verification documents).
 *   - Importer details - importer of record, EORI, tax id, import licence,
 *     customs broker, preferred Incoterm - which are the buyer's statement and
 *     are never "verified".
 *
 * WHO MOVES THE CHECK
 *
 * The buyer submits; staff with `buyer_company.review` verify or reject (the
 * same people who check company applications). Every move goes through
 * `domain/customer-kyc-state.ts`, and every write is audited. A buyer only
 * ever reaches their own record: every function here is keyed by the
 * caller's own profile id.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import {
  assertCustomerKycTransition,
  isKycEditable,
  maskDocumentNumber,
  type CustomerKycStatusName,
} from '../../domain/customer-kyc-state.js';
import { ErrorCode, badRequest, conflict, notFound, serviceUnavailable } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { MalwareDetectedError, MalwareScannerUnavailableError, scanForMalware } from '../../infra/malware-scan.js';
import { prisma } from '../../infra/prisma.js';
import { sniffDocumentType, storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export interface KycActor {
  userId: string;
  email: string | null;
  ipAddress?: string | null;
  correlationId?: string | null;
}

const ACCEPTED_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
/** Files a buyer may have waiting or accepted at once. */
export const KYC_DOCUMENTS_LIMIT = 10;
const DOCUMENT_TYPES = ['PASSPORT', 'NATIONAL_ID', 'DRIVING_LICENCE'] as const;
export const KYC_DOCUMENT_KINDS = ['IDENTITY', 'PROOF_OF_ADDRESS', 'IMPORT_LICENCE', 'TAX_REGISTRATION', 'OTHER'] as const;
/** Kinds that belong to the identity check and are locked with it. */
const IDENTITY_KINDS = new Set(['IDENTITY', 'PROOF_OF_ADDRESS']);
const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;

const country = z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase());
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const identityInput = z.object({
  legalName: optionalText(255),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  nationality: country.nullable().optional(),
  residenceCountry: country.nullable().optional(),
  idDocumentType: z.enum(DOCUMENT_TYPES).nullable().optional(),
  /** Typed whole; stored masked. Omit to keep the stored one. */
  idDocumentNumber: z.string().trim().min(4).max(40).optional(),
  idDocumentExpiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export const importerInput = z.object({
  isImporter: z.boolean(),
  importerName: optionalText(255),
  eoriNumber: z.string().trim().regex(/^[A-Za-z]{2}[A-Za-z0-9]{1,15}$/).nullable().optional(),
  importerTaxId: optionalText(64),
  importLicenceNumber: optionalText(64),
  customsBrokerName: optionalText(255),
  customsBrokerEmail: z.string().trim().email().max(320).nullable().optional(),
  preferredIncoterm: z.enum(INCOTERMS).nullable().optional(),
});

export const marketingInput = z.object({
  marketingEmailOptIn: z.boolean(),
  marketingSmsOptIn: z.boolean(),
  productNewsOptIn: z.boolean(),
});

const blank = (value: string | null | undefined): string | null | undefined =>
  value === undefined ? undefined : value === null || value.trim() === '' ? null : value.trim();
const dateOnly = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10));
const dateFrom = (value: string | null | undefined): Date | null | undefined =>
  value === undefined ? undefined : value === null ? null : new Date(`${value}T00:00:00.000Z`);

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/**
 * The buyer's record, created empty on first use. A VERIFIED check whose
 * identity document has passed its expiry date is moved to EXPIRED here, on
 * the first read after it lapses, so no screen and no decision ever sees a
 * lapsed document described as verified.
 */
async function row(customerProfileId: string) {
  const kyc = await prisma.customerKyc.upsert({
    where: { customerProfileId },
    create: { id: newId(), customerProfileId },
    update: {},
  });
  if (kyc.status !== 'VERIFIED' || kyc.idDocumentExpiresOn === null || dateOnly(kyc.idDocumentExpiresOn)! >= todayUtc()) {
    return kyc;
  }
  assertCustomerKycTransition({ from: 'VERIFIED', to: 'EXPIRED', actor: 'SYSTEM' });
  await prisma.$transaction(async (tx) => {
    // Conditional on the version read: a staff decision made in between wins.
    const moved = await tx.customerKyc.updateMany({
      where: { customerProfileId, status: 'VERIFIED', version: kyc.version },
      data: { status: 'EXPIRED', version: { increment: 1 } },
    });
    if (moved.count === 0) return;
    await recordAudit(
      {
        action: AuditAction.CUSTOMER_KYC_EXPIRED,
        resourceType: 'customer_kyc',
        resourceId: customerProfileId,
        actorType: 'SYSTEM',
        before: { status: 'VERIFIED' },
        after: { status: 'EXPIRED', idDocumentExpiresOn: dateOnly(kyc.idDocumentExpiresOn) },
      },
      tx,
    );
  });
  return prisma.customerKyc.findUniqueOrThrow({ where: { customerProfileId } });
}

/**
 * Moves the check from `from` to `to` only if nobody moved it since it was
 * read. Two reviewers deciding at once, or a buyer submitting while a
 * reviewer decides, get one winner and one clear refusal - never two writes.
 */
async function moveStatus(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  customerProfileId: string,
  from: { status: CustomerKycStatusName; version: number },
  data: Record<string, unknown>,
): Promise<void> {
  const moved = await tx.customerKyc.updateMany({
    where: { customerProfileId, status: from.status, version: from.version },
    data: { ...data, version: { increment: 1 } },
  });
  if (moved.count === 0) {
    throw conflict(ErrorCode.CUSTOMER_KYC_TRANSITION_INVALID, 'This identity check changed while you were looking at it. Reload it and try again.');
  }
}

export interface KycView {
  status: CustomerKycStatusName;
  editable: boolean;
  identity: {
    legalName: string | null;
    dateOfBirth: string | null;
    nationality: string | null;
    residenceCountry: string | null;
    idDocumentType: string | null;
    idDocumentNumberMasked: string | null;
    idDocumentExpiresOn: string | null;
  };
  importer: {
    isImporter: boolean;
    importerName: string | null;
    eoriNumber: string | null;
    importerTaxId: string | null;
    importLicenceNumber: string | null;
    customsBrokerName: string | null;
    customsBrokerEmail: string | null;
    preferredIncoterm: string | null;
  };
  submittedAt: string | null;
  reviewedAt: string | null;
  /** The reviewer's reason when refused; shown to the buyer. */
  reviewNote: string | null;
  documents: {
    id: string;
    kind: string;
    status: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    reviewNote: string | null;
    createdAt: string;
  }[];
}

async function view(customerProfileId: string): Promise<KycView> {
  const kyc = await row(customerProfileId);
  const documents = await prisma.customerKycDocument.findMany({
    where: { customerProfileId, status: { not: 'WITHDRAWN' } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, kind: true, status: true, fileName: true, mimeType: true, sizeBytes: true, reviewNote: true, createdAt: true },
  });
  return {
    status: kyc.status,
    editable: isKycEditable(kyc.status),
    identity: {
      legalName: kyc.legalName,
      dateOfBirth: dateOnly(kyc.dateOfBirth),
      nationality: kyc.nationality,
      residenceCountry: kyc.residenceCountry,
      idDocumentType: kyc.idDocumentType,
      idDocumentNumberMasked: kyc.idDocumentNumberMasked,
      idDocumentExpiresOn: dateOnly(kyc.idDocumentExpiresOn),
    },
    importer: {
      isImporter: kyc.isImporter,
      importerName: kyc.importerName,
      eoriNumber: kyc.eoriNumber,
      importerTaxId: kyc.importerTaxId,
      importLicenceNumber: kyc.importLicenceNumber,
      customsBrokerName: kyc.customsBrokerName,
      customsBrokerEmail: kyc.customsBrokerEmail,
      preferredIncoterm: kyc.preferredIncoterm,
    },
    submittedAt: kyc.submittedAt?.toISOString() ?? null,
    reviewedAt: kyc.reviewedAt?.toISOString() ?? null,
    reviewNote: kyc.status === 'REJECTED' ? kyc.reviewNote : null,
    documents: documents.map((document) => ({ ...document, createdAt: document.createdAt.toISOString() })),
  };
}

export async function getOwnKyc(customerProfileId: string): Promise<KycView> {
  return view(customerProfileId);
}

export async function updateOwnIdentity(
  customerProfileId: string,
  input: z.infer<typeof identityInput>,
  actor: KycActor,
): Promise<KycView> {
  const kyc = await row(customerProfileId);
  if (!isKycEditable(kyc.status)) {
    throw conflict(
      ErrorCode.CUSTOMER_KYC_NOT_EDITABLE,
      kyc.status === 'VERIFIED'
        ? 'Your identity is verified; those details are fixed. Contact support if they have changed.'
        : 'Your identity details are with a reviewer and cannot be changed until they decide.',
    );
  }
  if (input.dateOfBirth !== undefined && input.dateOfBirth !== null && new Date(input.dateOfBirth) > new Date()) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The date of birth cannot be in the future.', [
      { field: 'dateOfBirth', code: 'FUTURE' },
    ]);
  }

  await prisma.$transaction(async (tx) => {
    // Same status and version as read: a submission in between is not overwritten.
    await moveStatus(tx, customerProfileId, kyc, {
      legalName: blank(input.legalName),
      dateOfBirth: dateFrom(input.dateOfBirth),
      nationality: input.nationality,
      residenceCountry: input.residenceCountry,
      idDocumentType: input.idDocumentType,
      ...(input.idDocumentNumber === undefined ? {} : { idDocumentNumberMasked: maskDocumentNumber(input.idDocumentNumber) }),
      idDocumentExpiresOn: dateFrom(input.idDocumentExpiresOn),
    });
    await recordAudit(
      {
        action: AuditAction.CUSTOMER_KYC_UPDATED,
        resourceType: 'customer_kyc',
        resourceId: customerProfileId,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        // Which fields changed, never their values: this is identity data.
        after: { part: 'identity', fields: Object.keys(input).filter((key) => key !== 'idDocumentNumber').concat(input.idDocumentNumber === undefined ? [] : ['idDocumentNumberMasked']) },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
  return view(customerProfileId);
}

export async function updateOwnImporter(
  customerProfileId: string,
  input: z.infer<typeof importerInput>,
  actor: KycActor,
): Promise<KycView> {
  await row(customerProfileId);
  const upper = (value: string | null | undefined) => (value === undefined || value === null ? value : value.toUpperCase());
  await prisma.$transaction(async (tx) => {
    await tx.customerKyc.update({
      where: { customerProfileId },
      data: {
        isImporter: input.isImporter,
        importerName: blank(input.importerName),
        eoriNumber: upper(blank(input.eoriNumber)),
        importerTaxId: blank(input.importerTaxId),
        importLicenceNumber: blank(input.importLicenceNumber),
        customsBrokerName: blank(input.customsBrokerName),
        customsBrokerEmail: blank(input.customsBrokerEmail),
        preferredIncoterm: input.preferredIncoterm,
        version: { increment: 1 },
      },
    });
    await recordAudit(
      {
        action: AuditAction.CUSTOMER_KYC_UPDATED,
        resourceType: 'customer_kyc',
        resourceId: customerProfileId,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { part: 'importer', isImporter: input.isImporter },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
  return view(customerProfileId);
}

export async function submitOwnKyc(customerProfileId: string, actor: KycActor): Promise<KycView> {
  const kyc = await row(customerProfileId);
  assertCustomerKycTransition({ from: kyc.status, to: 'SUBMITTED', actor: 'BUYER' });

  const missing = (
    [
      ['legalName', kyc.legalName],
      ['dateOfBirth', kyc.dateOfBirth],
      ['nationality', kyc.nationality],
      ['residenceCountry', kyc.residenceCountry],
      ['idDocumentType', kyc.idDocumentType],
      ['idDocumentNumber', kyc.idDocumentNumberMasked],
    ] as const
  )
    .filter(([, value]) => value === null)
    .map(([field]) => field);
  const hasIdentityFile =
    (await prisma.customerKycDocument.count({
      where: { customerProfileId, kind: 'IDENTITY', status: { in: ['PENDING', 'ACCEPTED'] } },
    })) > 0;
  if (!hasIdentityFile) missing.push('identityDocument' as never);
  if (missing.length > 0) {
    throw badRequest(
      ErrorCode.CUSTOMER_KYC_INCOMPLETE,
      'Fill in every identity detail and upload a copy of your identity document before sending it for review.',
      missing.map((field) => ({ field, code: 'REQUIRED' })),
    );
  }
  if (kyc.idDocumentExpiresOn !== null && dateOnly(kyc.idDocumentExpiresOn)! < todayUtc()) {
    throw badRequest(ErrorCode.CUSTOMER_KYC_INCOMPLETE, 'Your identity document has expired. Add a document that is still valid.', [
      { field: 'idDocumentExpiresOn', code: 'EXPIRED' },
    ]);
  }

  await prisma.$transaction(async (tx) => {
    await moveStatus(tx, customerProfileId, kyc, { status: 'SUBMITTED', submittedAt: new Date(), reviewNote: null });
    await recordAudit(
      {
        action: AuditAction.CUSTOMER_KYC_SUBMITTED,
        resourceType: 'customer_kyc',
        resourceId: customerProfileId,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: kyc.status },
        after: { status: 'SUBMITTED' },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
  return view(customerProfileId);
}

function isServable(scanState: string): boolean {
  return scanState === 'CLEAN' || env.BUYER_COMPANY_ALLOW_UNSCANNED_DOCUMENTS;
}

function safeName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._ -]/gu, '').trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : fallback;
}

export async function uploadOwnKycDocument(input: {
  customerProfileId: string;
  kind: (typeof KYC_DOCUMENT_KINDS)[number];
  fileName: string;
  bytes: Buffer;
  actor: KycActor;
}): Promise<KycView> {
  const kyc = await row(input.customerProfileId);
  if (IDENTITY_KINDS.has(input.kind) && !isKycEditable(kyc.status)) {
    throw conflict(ErrorCode.CUSTOMER_KYC_NOT_EDITABLE, 'Identity documents cannot be added while the check is with a reviewer or verified.');
  }
  const active = await prisma.customerKycDocument.count({
    where: { customerProfileId: input.customerProfileId, status: { in: ['PENDING', 'ACCEPTED'] } },
  });
  if (active >= KYC_DOCUMENTS_LIMIT) {
    throw conflict(ErrorCode.CONFLICT, `You can keep up to ${String(KYC_DOCUMENTS_LIMIT)} documents. Withdraw one first.`);
  }
  if (input.bytes.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The file is empty.', [{ field: 'file', code: 'EMPTY' }]);
  }
  if (input.bytes.length > env.BUYER_COMPANY_DOCUMENT_MAX_BYTES) {
    throw badRequest(ErrorCode.MEDIA_TOO_LARGE, 'The file is too large.', [
      { field: 'file', code: 'FILE_TOO_LARGE', meta: { maxBytes: env.BUYER_COMPANY_DOCUMENT_MAX_BYTES } },
    ]);
  }
  let sniffed: { mimeType: string; extension: string };
  try {
    sniffed = sniffDocumentType(input.bytes);
  } catch {
    throw badRequest(ErrorCode.MEDIA_TYPE_NOT_ALLOWED, 'Upload a PDF, or a JPEG, PNG or WebP image of the document.');
  }
  if (!ACCEPTED_TYPES.has(sniffed.mimeType)) {
    throw badRequest(ErrorCode.MEDIA_TYPE_NOT_ALLOWED, 'Upload a PDF, or a JPEG, PNG or WebP image of the document.');
  }

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
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.customerKycDocument.create({
      data: {
        id,
        customerProfileId: input.customerProfileId,
        kind: input.kind,
        fileName: safeName(input.fileName, `document.${sniffed.extension}`),
        storageKey: stored.storageKey,
        mimeType: sniffed.mimeType,
        sizeBytes: input.bytes.length,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        scanState,
      },
    });
    await recordAudit(
      {
        action: AuditAction.CUSTOMER_KYC_DOCUMENT_UPLOADED,
        resourceType: 'customer_kyc_document',
        resourceId: id,
        actorType: 'CUSTOMER',
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        after: { kind: input.kind, mimeType: sniffed.mimeType, sizeBytes: input.bytes.length, scanState },
        ipAddress: input.actor.ipAddress ?? null,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
  });
  return view(input.customerProfileId);
}

export async function withdrawOwnKycDocument(customerProfileId: string, documentId: string, actor: KycActor): Promise<KycView> {
  // Scoped to the caller's own profile: another buyer's id is simply not found.
  const document = await prisma.customerKycDocument.findFirst({
    where: { id: documentId, customerProfileId },
    select: { id: true, status: true },
  });
  if (document === null) throw notFound('Document');
  if (document.status !== 'PENDING') {
    throw conflict(ErrorCode.CUSTOMER_KYC_NOT_EDITABLE, 'Only a document nobody has decided on yet can be withdrawn.');
  }
  await prisma.$transaction(async (tx) => {
    const withdrawn = await tx.customerKycDocument.updateMany({
      where: { id: documentId, customerProfileId, status: 'PENDING' },
      data: { status: 'WITHDRAWN' },
    });
    if (withdrawn.count === 0) {
      throw conflict(ErrorCode.CUSTOMER_KYC_NOT_EDITABLE, 'Only a document nobody has decided on yet can be withdrawn.');
    }
    await recordAudit(
      {
        action: AuditAction.CUSTOMER_KYC_DOCUMENT_WITHDRAWN,
        resourceType: 'customer_kyc_document',
        resourceId: documentId,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
  return view(customerProfileId);
}

// --- Staff ------------------------------------------------------------------

export async function getKycForStaff(customerProfileId: string): Promise<KycView> {
  const exists = await prisma.customerProfile.count({ where: { id: customerProfileId } });
  if (exists === 0) throw notFound('Customer');
  return view(customerProfileId);
}

export async function decideKycDocument(input: {
  documentId: string;
  decision: 'ACCEPTED' | 'REJECTED';
  note: string | null;
  actor: KycActor;
}): Promise<void> {
  const document = await prisma.customerKycDocument.findUnique({ where: { id: input.documentId } });
  if (document === null) throw notFound('Document');
  if (document.status !== 'PENDING') {
    throw conflict(ErrorCode.CUSTOMER_KYC_TRANSITION_INVALID, 'Only a document waiting for a decision can be decided.');
  }
  if (input.decision === 'REJECTED' && (input.note === null || input.note.trim().length < 5)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the document is refused; the buyer is shown the reason.', [
      { field: 'note', code: 'REQUIRED' },
    ]);
  }
  await prisma.$transaction(async (tx) => {
    // Only while still PENDING: a withdrawal or a second reviewer in between wins.
    const decided = await tx.customerKycDocument.updateMany({
      where: { id: input.documentId, status: 'PENDING' },
      data: { status: input.decision, reviewNote: blank(input.note) ?? null, reviewedAt: new Date(), reviewedById: input.actor.userId },
    });
    if (decided.count === 0) {
      throw conflict(ErrorCode.CUSTOMER_KYC_TRANSITION_INVALID, 'Only a document waiting for a decision can be decided.');
    }
    await recordAudit(
      {
        action: AuditAction.CUSTOMER_KYC_DOCUMENT_DECIDED,
        resourceType: 'customer_kyc_document',
        resourceId: input.documentId,
        actorType: 'ADMIN',
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        before: { status: document.status },
        after: { status: input.decision },
        ipAddress: input.actor.ipAddress ?? null,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
  });
}

export async function decideKyc(input: {
  customerProfileId: string;
  decision: 'VERIFIED' | 'REJECTED';
  /** The status the reviewer was looking at when they decided. */
  expectedStatus: CustomerKycStatusName;
  note: string | null;
  actor: KycActor;
}): Promise<KycView> {
  const exists = await prisma.customerKyc.count({ where: { customerProfileId: input.customerProfileId } });
  if (exists === 0) throw notFound('Identity check');
  const kyc = await row(input.customerProfileId);
  // A decision taken on a screen that is out of date - a colleague verified it,
  // or it expired - is refused rather than quietly overturning what happened.
  if (kyc.status !== input.expectedStatus) {
    throw conflict(ErrorCode.CUSTOMER_KYC_TRANSITION_INVALID, 'This identity check changed while you were looking at it. Reload it and decide again.', [
      { code: 'STALE', meta: { expected: input.expectedStatus, actual: kyc.status } },
    ]);
  }
  assertCustomerKycTransition({ from: kyc.status, to: input.decision, actor: 'STAFF' });

  if (input.decision === 'REJECTED' && (input.note === null || input.note.trim().length < 5)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the check is refused; the buyer is shown the reason.', [
      { field: 'note', code: 'REQUIRED' },
    ]);
  }
  if (input.decision === 'VERIFIED') {
    const accepted = await prisma.customerKycDocument.count({
      where: { customerProfileId: input.customerProfileId, kind: 'IDENTITY', status: 'ACCEPTED' },
    });
    if (accepted === 0) {
      throw conflict(ErrorCode.CUSTOMER_KYC_INCOMPLETE, 'Accept the identity document before verifying the check.', [
        { field: 'identityDocument', code: 'NOT_ACCEPTED' },
      ]);
    }
    if (kyc.idDocumentExpiresOn !== null && dateOnly(kyc.idDocumentExpiresOn)! < todayUtc()) {
      throw conflict(ErrorCode.CUSTOMER_KYC_INCOMPLETE, 'The identity document has expired since it was sent. Refuse the check so the buyer can add a valid one.', [
        { field: 'idDocumentExpiresOn', code: 'EXPIRED' },
      ]);
    }
  }

  await prisma.$transaction(async (tx) => {
    await moveStatus(tx, input.customerProfileId, kyc, {
      status: input.decision,
      reviewedAt: new Date(),
      reviewedById: input.actor.userId,
      reviewNote: blank(input.note) ?? null,
    });
    await recordAudit(
      {
        action: AuditAction.CUSTOMER_KYC_DECIDED,
        resourceType: 'customer_kyc',
        resourceId: input.customerProfileId,
        actorType: 'ADMIN',
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        before: { status: kyc.status },
        after: { status: input.decision },
        ipAddress: input.actor.ipAddress ?? null,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
  });
  return view(input.customerProfileId);
}

export async function readKycDocumentForStaff(
  documentId: string,
  actor: KycActor,
): Promise<{ bytes: Buffer; fileName: string; mimeType: string }> {
  const document = await prisma.customerKycDocument.findUnique({ where: { id: documentId } });
  if (document === null || document.status === 'WITHDRAWN') throw notFound('Document');
  if (!isServable(document.scanState)) {
    throw conflict(ErrorCode.CONFLICT, 'This file has not been scanned and cannot be opened on this installation.');
  }
  const bytes = await storage.get(document.storageKey);
  await recordAudit({
    action: AuditAction.CUSTOMER_KYC_DOCUMENT_VIEWED,
    resourceType: 'customer_kyc_document',
    resourceId: documentId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  return { bytes, fileName: document.fileName, mimeType: document.mimeType };
}

// --- Marketing choices ------------------------------------------------------

export interface MarketingView {
  marketingEmailOptIn: boolean;
  marketingSmsOptIn: boolean;
  productNewsOptIn: boolean;
  marketingUpdatedAt: string | null;
}

export async function getMarketing(customerProfileId: string): Promise<MarketingView> {
  const row = await prisma.customerPreference.findUnique({ where: { customerProfileId } });
  return {
    marketingEmailOptIn: row?.marketingEmailOptIn ?? false,
    marketingSmsOptIn: row?.marketingSmsOptIn ?? false,
    productNewsOptIn: row?.productNewsOptIn ?? false,
    marketingUpdatedAt: row?.marketingUpdatedAt?.toISOString() ?? null,
  };
}

export async function updateMarketing(
  customerProfileId: string,
  input: z.infer<typeof marketingInput>,
  actor: KycActor,
): Promise<MarketingView> {
  const before = await getMarketing(customerProfileId);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.customerPreference.upsert({
      where: { customerProfileId },
      create: { id: newId(), customerProfileId, ...input, marketingUpdatedAt: now },
      update: { ...input, marketingUpdatedAt: now },
    });
    // The consent record: what was chosen, when, from where.
    await recordAudit(
      {
        action: AuditAction.CUSTOMER_MARKETING_PREFERENCES_UPDATED,
        resourceType: 'customer_preference',
        resourceId: customerProfileId,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { email: before.marketingEmailOptIn, sms: before.marketingSmsOptIn, productNews: before.productNewsOptIn },
        after: { email: input.marketingEmailOptIn, sms: input.marketingSmsOptIn, productNews: input.productNewsOptIn },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
  return getMarketing(customerProfileId);
}
