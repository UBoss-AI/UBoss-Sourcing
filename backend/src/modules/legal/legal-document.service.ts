/**
 * Legal documents: which Terms are in force, whether an acceptance of them is
 * genuine, the operator's drafts and publishing, and the PDF copy.
 *
 * ## The one rule everything here serves
 *
 * The browser never decides which Terms somebody agreed to. It shows the
 * document this service hands it, and sends back that document's id. The
 * server then checks the id names a published document of the right kind, that
 * the document's version is the one in force *now*, and copies the version,
 * language and content hash off the stored row onto the acceptance. A client
 * cannot choose a version, a hash, a language or a time - it can only point at
 * a document, and a pointer at anything but the current one is refused.
 *
 * ## Why an unpublished deployment cannot sign anybody up
 *
 * With no Terms published there is nothing for an acceptance to name, and an
 * account created then would be bound by nothing anybody can later produce. So
 * sign-up and invitation activation refuse with TERMS_DOCUMENT_UNAVAILABLE
 * until an operator publishes. That is deliberate and listed as a going-live
 * step: failing closed is a support ticket, failing open is an unenforceable
 * contract with every early customer.
 *
 * ## Languages
 *
 * A version exists in one or more languages, each a row. The reader gets the
 * version in force in their own language when the operator has published it,
 * otherwise the English one, otherwise any language of that version - and the
 * response says so (`isFallback`), so the screen can tell the reader the text
 * is not in their language rather than let them assume it is. An older
 * version in their language is never offered instead: agreeing to superseded
 * terms in a familiar language is not agreeing to the terms in force.
 */
import { AppError, ErrorCode, badRequest, conflict, notFound, unprocessable } from '../../domain/errors.js';
import {
  findLegalPlaceholders,
  LEGAL_BODY_MAX,
  LEGAL_CHANGE_SUMMARY_MAX,
  LEGAL_DOCUMENT_KINDS,
  LEGAL_TITLE_MAX,
  POLICY_KINDS,
  LEGAL_VERSION_PATTERN,
  legalContentHash,
  normaliseLegalText,
  parseLegalBody,
  pickCurrent,
  type LegalDocumentKindName,
  type TermsAcceptanceSource,
  type TermsKindName,
  type VersionRequirementRow,
} from '../../domain/legal-document.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { getMarketplaceName } from '../settings/marketplace-name.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { SUPPORTED_LANGUAGES, isSupportedLanguage } from '../identity/language.service.js';
import { PdfBuilder } from '../documents/pdf.js';
import { bumpLegalPublicationGeneration } from './publication-generation.js';

/** The language shown when the reader's own is not published. */
const FALLBACK_LOCALE = 'en';

export interface LegalActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/** What the public may see of a published document. */
export interface PublicLegalDocument {
  id: string;
  kind: LegalDocumentKindName;
  version: string;
  locale: string;
  title: string;
  body: string;
  changeSummary: string | null;
  effectiveAt: string;
  publishedAt: string;
  contentSha256: string;
  /** Whether accepting an earlier version stopped counting when this one took effect. */
  requiresReacceptance: boolean;
}

export interface CurrentLegalDocument {
  document: PublicLegalDocument;
  /** The language the reader asked for. */
  requestedLocale: string;
  /** True when `document.locale` is not the language asked for. */
  isFallback: boolean;
}

type PublishedRow = {
  id: string;
  kind: LegalDocumentKindName;
  version: string;
  locale: string;
  title: string;
  body: string;
  changeSummary: string | null;
  effectiveAt: Date;
  publishedAt: Date | null;
  contentSha256: string | null;
  requiresReacceptance: boolean;
};

const PUBLIC_SELECT = {
  id: true,
  kind: true,
  version: true,
  locale: true,
  title: true,
  body: true,
  changeSummary: true,
  effectiveAt: true,
  publishedAt: true,
  contentSha256: true,
  requiresReacceptance: true,
} as const;

function toPublic(row: PublishedRow): PublicLegalDocument {
  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    locale: row.locale,
    title: row.title,
    body: row.body,
    changeSummary: row.changeSummary,
    effectiveAt: row.effectiveAt.toISOString(),
    // A published row always has both; the CHECK constraint guarantees it.
    publishedAt: (row.publishedAt ?? row.effectiveAt).toISOString(),
    contentSha256: row.contentSha256 ?? '',
    requiresReacceptance: row.requiresReacceptance,
  };
}

export function isLegalDocumentKind(value: unknown): value is LegalDocumentKindName {
  return typeof value === 'string' && (LEGAL_DOCUMENT_KINDS as readonly string[]).includes(value);
}

/**
 * The column allows more kinds than this service manages. A row of any other
 * kind is not one of these documents, so it is treated as not there.
 */
function hasManagedKind<T extends { kind: string }>(row: T): row is T & { kind: LegalDocumentKindName } {
  return isLegalDocumentKind(row.kind);
}

// ---------------------------------------------------------------------------
// What is in force
// ---------------------------------------------------------------------------

/** The version in force for a kind, or null when nothing published has taken effect. */
async function currentVersionOf(
  kind: LegalDocumentKindName,
  now: Date,
  client: PrismaTransaction | typeof prisma = prisma,
): Promise<string | null> {
  // Two rows are enough for `pickCurrent` to settle a same-moment tie; more
  // would never change the answer because they are ordered the same way.
  const candidates = await client.legalDocument.findMany({
    where: { kind, status: 'PUBLISHED', effectiveAt: { lte: now } },
    orderBy: [{ effectiveAt: 'desc' }, { publishedAt: 'desc' }],
    select: { version: true, effectiveAt: true, publishedAt: true },
    take: 2,
  });
  return pickCurrent(candidates, now)?.version ?? null;
}

/**
 * Every version of a kind in force at `now`, NEWEST FIRST, one entry per
 * version, in the order `currentVersionOf` would choose between them. A
 * version asks for re-acceptance if any of its languages does - they are one
 * document. Input for `acceptableVersions`.
 */
export async function inForceVersions(
  kind: LegalDocumentKindName,
  now: Date = new Date(),
  client: PrismaTransaction | typeof prisma = prisma,
): Promise<VersionRequirementRow[]> {
  const rows = await client.legalDocument.findMany({
    where: { kind, status: 'PUBLISHED', effectiveAt: { lte: now } },
    orderBy: [{ effectiveAt: 'desc' }, { publishedAt: 'desc' }],
    select: { version: true, requiresReacceptance: true },
    take: 500,
  });
  const byVersion = new Map<string, VersionRequirementRow>();
  for (const row of rows) {
    const seen = byVersion.get(row.version);
    if (seen === undefined) byVersion.set(row.version, { ...row });
    else if (row.requiresReacceptance) seen.requiresReacceptance = true;
  }
  return [...byVersion.values()];
}

/**
 * The Terms a reader should be shown now, in their language where possible.
 * Null when nothing is published - the caller decides what that means.
 */
export async function findCurrentDocument(
  kind: LegalDocumentKindName,
  requestedLocale: string,
  now: Date = new Date(),
): Promise<CurrentLegalDocument | null> {
  const locale = isSupportedLanguage(requestedLocale) ? requestedLocale : FALLBACK_LOCALE;
  const version = await currentVersionOf(kind, now);
  if (version === null) return null;

  const rows = await prisma.legalDocument.findMany({
    where: { kind, version, status: 'PUBLISHED', effectiveAt: { lte: now } },
    select: PUBLIC_SELECT,
    orderBy: { locale: 'asc' },
  });

  const chosen =
    rows.find((row) => row.locale === locale) ??
    rows.find((row) => row.locale === FALLBACK_LOCALE) ??
    rows[0];
  if (chosen === undefined || !hasManagedKind(chosen)) return null;

  return {
    document: toPublic(chosen),
    requestedLocale: locale,
    isFallback: chosen.locale !== locale,
  };
}

function termsUnavailable(): AppError {
  return new AppError({
    statusCode: 503,
    code: ErrorCode.TERMS_DOCUMENT_UNAVAILABLE,
    message:
      'Accounts cannot be opened at the moment because the Terms and Conditions are not available. Please try again later.',
  });
}

/** `GET /legal/current`: the same as above, but a missing document is an error. */
export async function getCurrentDocument(
  kind: LegalDocumentKindName,
  requestedLocale: string,
): Promise<CurrentLegalDocument> {
  const current = await findCurrentDocument(kind, requestedLocale);
  if (current === null) throw termsUnavailable();
  return current;
}

/**
 * Every document in force now, one per kind, for the storefront's help and
 * policies hub (checklist Master row 9). The buyer terms and the policies -
 * not the carrier terms, which are for carrier staff. Titles and links only:
 * the body is read on the document's own page.
 */
export async function listDocumentsInForce(
  requestedLocale: string,
  now: Date = new Date(),
): Promise<{ kind: LegalDocumentKindName; id: string; title: string; version: string; effectiveAt: string; isFallback: boolean }[]> {
  const kinds: LegalDocumentKindName[] = ['PLATFORM_TERMS', ...POLICY_KINDS];
  const found = await Promise.all(kinds.map((kind) => findCurrentDocument(kind, requestedLocale, now)));
  return found
    .filter((entry): entry is CurrentLegalDocument => entry !== null)
    .map((entry) => ({
      kind: entry.document.kind,
      id: entry.document.id,
      title: entry.document.title,
      version: entry.document.version,
      effectiveAt: entry.document.effectiveAt,
      isFallback: entry.isFallback,
    }));
}

/** One published document, of any version. Drafts are never found here. */
export async function getPublishedDocument(id: string): Promise<PublicLegalDocument> {
  const row = await prisma.legalDocument.findFirst({
    where: { id, status: 'PUBLISHED' },
    select: PUBLIC_SELECT,
  });
  if (row === null || !hasManagedKind(row)) throw notFound('Document');
  return toPublic(row);
}

export interface PublishedVersionSummary {
  id: string;
  version: string;
  locale: string;
  title: string;
  effectiveAt: string;
  isCurrent: boolean;
}

/**
 * Every published version of a kind, newest first - including ones not yet in
 * force, so a reader can see what is coming. So anybody can reproduce the
 * terms they agreed to, whenever they agreed to them.
 */
export async function listPublishedVersions(
  kind: LegalDocumentKindName,
): Promise<PublishedVersionSummary[]> {
  const now = new Date();
  const [rows, current] = await Promise.all([
    prisma.legalDocument.findMany({
      where: { kind, status: 'PUBLISHED' },
      select: { id: true, version: true, locale: true, title: true, effectiveAt: true },
      orderBy: [{ effectiveAt: 'desc' }, { locale: 'asc' }],
      take: 500,
    }),
    currentVersionOf(kind, now),
  ]);
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    locale: row.locale,
    title: row.title,
    effectiveAt: row.effectiveAt.toISOString(),
    isCurrent: row.version === current && row.effectiveAt.getTime() <= now.getTime(),
  }));
}

// ---------------------------------------------------------------------------
// Checking and recording an acceptance
// ---------------------------------------------------------------------------

export interface AcceptableTerms {
  id: string;
  kind: TermsKindName;
  version: string;
  locale: string;
  contentSha256: string;
}

/**
 * Refuse unless `documentId` names the Terms in force for `kind`.
 *
 * Called BEFORE anything is written or any token is spent, so a refusal leaves
 * nothing behind and the person can simply agree to the current version and
 * press the button again. The same check is repeated inside the account's own
 * transaction by `recordTermsAcceptance`, so a version published in the
 * moment between the two cannot slip through.
 */
export async function assertAcceptableTerms(input: {
  /** Always a terms kind: a policy is informational and is never accepted. */
  kind: TermsKindName;
  acceptedTerms: boolean;
  documentId: string | null | undefined;
  now?: Date;
  client?: PrismaTransaction | typeof prisma;
}): Promise<AcceptableTerms> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();

  if (!input.acceptedTerms || input.documentId === null || input.documentId === undefined) {
    throw badRequest(
      ErrorCode.TERMS_ACCEPTANCE_REQUIRED,
      'Read the Terms and Conditions and choose I agree to continue.',
      [{ field: 'acceptedTerms', code: 'TERMS_ACCEPTANCE_REQUIRED' }],
    );
  }

  const document = await assertCurrentDocument({
    kind: input.kind,
    documentId: input.documentId,
    now,
    client,
    field: 'acceptedTerms',
  });
  return { ...document, kind: input.kind };
}

export interface CurrentDocumentRef {
  id: string;
  kind: LegalDocumentKindName;
  version: string;
  locale: string;
  contentSha256: string;
}

/**
 * Refuse unless `documentId` names a published document of `kind` whose
 * version is the one in force now, in any language. What sign-up and the
 * agreement screen both rely on: the browser points at a document, and the
 * version, language and hash are read off the stored row.
 *
 * A document that was current when the dialog opened and has since been
 * replaced is refused with TERMS_VERSION_OUTDATED, and the screen fetches the
 * new one. Nothing is written by a refusal.
 */
export async function assertCurrentDocument(input: {
  kind: LegalDocumentKindName;
  documentId: string;
  now?: Date;
  client?: PrismaTransaction | typeof prisma;
  field?: string;
}): Promise<CurrentDocumentRef> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();

  const current = await currentVersionOf(input.kind, now, client);
  if (current === null) throw termsUnavailable();

  const document = await client.legalDocument.findFirst({
    where: { id: input.documentId, kind: input.kind, status: 'PUBLISHED' },
    select: { id: true, version: true, locale: true, contentSha256: true, effectiveAt: true },
  });

  if (
    document === null ||
    document.version !== current ||
    document.effectiveAt.getTime() > now.getTime() ||
    document.contentSha256 === null
  ) {
    throw conflict(
      ErrorCode.TERMS_VERSION_OUTDATED,
      input.kind === 'PRIVACY_POLICY'
        ? 'The Privacy Policy has changed. Read the current version and acknowledge it to continue.'
        : 'The Terms and Conditions have changed. Read the current version and agree to it to continue.',
      [
        {
          field: input.field ?? 'documentId',
          code: 'TERMS_VERSION_OUTDATED',
          meta: { currentVersion: current, kind: input.kind },
        },
      ],
    );
  }

  return {
    id: document.id,
    kind: input.kind,
    version: document.version,
    locale: document.locale,
    contentSha256: document.contentSha256,
  };
}

/**
 * Write the acceptance, inside the transaction that creates or activates the
 * account. Re-checks the document first, against the same transaction.
 *
 * The time is the database's own - the column's default - never a value from
 * the request. No IP address or browser string is stored: what proves the
 * agreement is the account, the document it points at and the hash, and
 * keeping device details "for evidence" would need a purpose and a retention
 * period that the operator's privacy notice has to state.
 */
export async function recordTermsAcceptance(
  tx: PrismaTransaction,
  input: { userId: string; terms: AcceptableTerms; source: TermsAcceptanceSource },
): Promise<void> {
  const terms = await assertAcceptableTerms({
    kind: input.terms.kind,
    acceptedTerms: true,
    documentId: input.terms.id,
    client: tx,
  });

  await tx.consentRecord.create({
    data: {
      id: newId(),
      userId: input.userId,
      purpose: terms.kind,
      textVersion: terms.version,
      textHash: terms.contentSha256,
      legalDocumentId: terms.id,
      activeDocumentId: terms.id,
      locale: terms.locale,
      acceptanceSource: input.source,
      action: 'TERMS_ACCEPTED',
      scope: terms.kind === 'LOGISTICS_PARTNER_TERMS' ? 'LOGISTICS' : 'BUYER',
    },
  });
}

// ---------------------------------------------------------------------------
// The PDF copy
// ---------------------------------------------------------------------------

/**
 * A published document as a PDF, built from the stored text and nothing else.
 *
 * Deterministic: the PDF's dates are the publication date and nothing in it
 * depends on the clock, so the same document always gives the same file. The
 * footer carries the version and the start of the hash, so a printed copy can
 * be matched to the archived row.
 */
export async function renderLegalDocumentPdf(
  id: string,
): Promise<{ bytes: Buffer; fileName: string }> {
  const document = await getPublishedDocument(id);
  const publishedAt = new Date(document.publishedAt);

  const pdf = new PdfBuilder({
    title: document.title,
    issuedAt: publishedAt,
    // The operator's own trading name: these are their terms, not ours.
    author: await getMarketplaceName(prisma),
    subject: `${document.kind} ${document.version} (${document.locale})`,
    reference: `${document.version} · ${document.locale.toUpperCase()} · SHA-256 ${document.contentSha256.slice(0, 16)}`,
    watermark: null,
  });

  pdf.title(
    document.title,
    `${document.version} · ${document.effectiveAt.slice(0, 10)} · ${document.locale.toUpperCase()}`,
    null,
  );

  if (document.changeSummary !== null && document.changeSummary.length > 0) {
    pdf.paragraph(document.changeSummary, { muted: true, size: 9 });
  }

  for (const block of parseLegalBody(document.body)) {
    if (block.type === 'heading') {
      pdf.ensureSpace(40);
      pdf.doc.moveDown(0.4);
      pdf.paragraph(block.text, { bold: true, size: 11 });
    } else if (block.type === 'paragraph') {
      pdf.paragraph(block.text, { size: 10 });
    } else {
      for (const item of block.items) pdf.paragraph(`•  ${item}`, { size: 10 });
    }
  }

  pdf.doc.moveDown(1);
  pdf.paragraph(`SHA-256 ${document.contentSha256}`, { muted: true, size: 7 });

  const { bytes } = await pdf.finish();
  const safeVersion = document.version.replace(/[^A-Za-z0-9._-]/g, '_');
  return {
    bytes,
    fileName: `${document.kind.toLowerCase()}-${safeVersion}-${document.locale}.pdf`,
  };
}

// ---------------------------------------------------------------------------
// The operator's side: drafts and publishing
// ---------------------------------------------------------------------------

export interface LegalDocumentAdminView extends Omit<PublicLegalDocument, 'publishedAt' | 'contentSha256'> {
  status: 'DRAFT' | 'PUBLISHED';
  publishedAt: string | null;
  contentSha256: string | null;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
  /** How many people have accepted it. Never who. */
  acceptanceCount: number;
  /** Whether this is the version in force for its kind right now. */
  isCurrentVersion: boolean;
}

type AdminRow = PublishedRow & {
  status: 'DRAFT' | 'PUBLISHED';
  supersedesId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toAdmin(row: AdminRow, acceptanceCount: number, currentVersion: string | null, now: Date): LegalDocumentAdminView {
  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    locale: row.locale,
    title: row.title,
    body: row.body,
    changeSummary: row.changeSummary,
    effectiveAt: row.effectiveAt.toISOString(),
    requiresReacceptance: row.requiresReacceptance,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    contentSha256: row.contentSha256,
    supersedesId: row.supersedesId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    acceptanceCount,
    isCurrentVersion:
      row.status === 'PUBLISHED' &&
      row.version === currentVersion &&
      row.effectiveAt.getTime() <= now.getTime(),
  };
}

async function acceptanceCounts(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const grouped = await prisma.consentRecord.groupBy({
    by: ['legalDocumentId'],
    where: { legalDocumentId: { in: ids } },
    _count: { _all: true },
  });
  return new Map(
    grouped
      .filter((entry) => entry.legalDocumentId !== null)
      .map((entry) => [entry.legalDocumentId as string, entry._count._all]),
  );
}

/** Every document of every kind, newest first. Bodies included; there are few rows. */
export async function listLegalDocuments(filter: {
  kind?: LegalDocumentKindName | undefined;
}): Promise<LegalDocumentAdminView[]> {
  const now = new Date();
  const rows = await prisma.legalDocument.findMany({
    where: filter.kind === undefined ? {} : { kind: filter.kind },
    orderBy: [{ kind: 'asc' }, { effectiveAt: 'desc' }, { locale: 'asc' }],
    take: 500,
  });
  const counts = await acceptanceCounts(rows.map((row) => row.id));
  const current = new Map<LegalDocumentKindName, string | null>();
  for (const kind of LEGAL_DOCUMENT_KINDS) current.set(kind, await currentVersionOf(kind, now));
  return rows
    .filter(hasManagedKind)
    .map((row) => toAdmin(row, counts.get(row.id) ?? 0, current.get(row.kind) ?? null, now));
}

export async function getLegalDocumentForAdmin(id: string): Promise<LegalDocumentAdminView> {
  const row = await prisma.legalDocument.findUnique({ where: { id } });
  if (row === null || !hasManagedKind(row)) throw notFound('Document');
  const now = new Date();
  const counts = await acceptanceCounts([row.id]);
  return toAdmin(row, counts.get(row.id) ?? 0, await currentVersionOf(row.kind, now), now);
}

export interface DraftInput {
  kind: LegalDocumentKindName;
  version: string;
  locale: string;
  title: string;
  body: string;
  changeSummary?: string | null;
  effectiveAt: Date;
  /** Whether people who accepted an earlier version must accept this one. Default true. */
  requiresReacceptance?: boolean;
}

function validateDraft(input: DraftInput): DraftInput {
  const details: { field: string; code: string; message: string }[] = [];
  const version = input.version.trim();
  const title = normaliseLegalText(input.title).replace(/\n+/g, ' ');
  const body = normaliseLegalText(input.body);
  const changeSummary =
    input.changeSummary === null || input.changeSummary === undefined
      ? null
      : normaliseLegalText(input.changeSummary);

  if (!LEGAL_VERSION_PATTERN.test(version)) {
    details.push({
      field: 'version',
      code: 'INVALID_VERSION',
      message: 'Use up to 32 letters, digits, dots, dashes or underscores, such as 2026-10-01.',
    });
  }
  if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(input.locale)) {
    details.push({ field: 'locale', code: 'UNSUPPORTED_LANGUAGE', message: 'Choose a language this system supports.' });
  }
  if (title.length === 0 || title.length > LEGAL_TITLE_MAX) {
    details.push({ field: 'title', code: 'INVALID_TITLE', message: `Give a title of up to ${String(LEGAL_TITLE_MAX)} characters.` });
  }
  if (body.length === 0 || body.length > LEGAL_BODY_MAX) {
    details.push({ field: 'body', code: 'INVALID_BODY', message: 'The text is empty or too long.' });
  }
  if (changeSummary !== null && changeSummary.length > LEGAL_CHANGE_SUMMARY_MAX) {
    details.push({ field: 'changeSummary', code: 'TOO_LONG', message: 'Keep the summary of changes short.' });
  }
  if (Number.isNaN(input.effectiveAt.getTime())) {
    details.push({ field: 'effectiveAt', code: 'INVALID_DATE', message: 'Choose when this version takes effect.' });
  }
  if (details.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The document could not be saved.', details);
  }

  return {
    kind: input.kind,
    version,
    locale: input.locale,
    title,
    body,
    changeSummary: changeSummary === '' ? null : changeSummary,
    effectiveAt: input.effectiveAt,
    requiresReacceptance: input.requiresReacceptance ?? true,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

function versionExists(): AppError {
  return conflict(
    ErrorCode.LEGAL_DOCUMENT_VERSION_EXISTS,
    'A document with this version and language already exists. Choose another version.',
    [{ field: 'version', code: 'LEGAL_DOCUMENT_VERSION_EXISTS' }],
  );
}

function immutable(): AppError {
  return conflict(
    ErrorCode.LEGAL_DOCUMENT_IMMUTABLE,
    'A published document can never be changed or deleted. Write a new version instead.',
  );
}

/** Start a new version as a draft. Nobody sees it until it is published. */
export async function createDraft(input: DraftInput, actor: LegalActor): Promise<LegalDocumentAdminView> {
  const draft = validateDraft(input);
  const id = newId();

  try {
    await prisma.$transaction(async (tx) => {
      await tx.legalDocument.create({
        data: {
          id,
          kind: draft.kind,
          version: draft.version,
          locale: draft.locale,
          title: draft.title,
          body: draft.body,
          changeSummary: draft.changeSummary ?? null,
          effectiveAt: draft.effectiveAt,
          requiresReacceptance: draft.requiresReacceptance ?? true,
          createdById: actor.userId,
        },
      });
      await recordAudit(
        {
          action: AuditAction.LEGAL_DOCUMENT_DRAFTED,
          resourceType: 'legal_document',
          resourceId: id,
          actorType: 'ADMIN',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          after: { kind: draft.kind, version: draft.version, locale: draft.locale },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw versionExists();
    throw error;
  }

  return getLegalDocumentForAdmin(id);
}

/** Change a draft. A published document is refused, whoever asks. */
export async function updateDraft(
  id: string,
  input: DraftInput,
  actor: LegalActor,
): Promise<LegalDocumentAdminView> {
  const draft = validateDraft(input);

  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.legalDocument.findUnique({ where: { id }, select: { status: true } });
      if (existing === null) throw notFound('Document');

      // Conditional on DRAFT in the write itself, so a publish that lands
      // between the read above and this line still wins.
      const changed = await tx.legalDocument.updateMany({
        where: { id, status: 'DRAFT' },
        data: {
          kind: draft.kind,
          version: draft.version,
          locale: draft.locale,
          title: draft.title,
          body: draft.body,
          changeSummary: draft.changeSummary ?? null,
          effectiveAt: draft.effectiveAt,
          requiresReacceptance: draft.requiresReacceptance ?? true,
        },
      });
      if (changed.count !== 1) throw immutable();

      await recordAudit(
        {
          action: AuditAction.LEGAL_DOCUMENT_DRAFT_UPDATED,
          resourceType: 'legal_document',
          resourceId: id,
          actorType: 'ADMIN',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          after: { kind: draft.kind, version: draft.version, locale: draft.locale },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw versionExists();
    throw error;
  }

  return getLegalDocumentForAdmin(id);
}

/** Throw a draft away. A published document can never be deleted. */
export async function deleteDraft(id: string, actor: LegalActor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.legalDocument.findUnique({
      where: { id },
      select: { status: true, kind: true, version: true, locale: true },
    });
    if (existing === null) throw notFound('Document');

    const removed = await tx.legalDocument.deleteMany({ where: { id, status: 'DRAFT' } });
    if (removed.count !== 1) throw immutable();

    await recordAudit(
      {
        action: AuditAction.LEGAL_DOCUMENT_DRAFT_DELETED,
        resourceType: 'legal_document',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { kind: existing.kind, version: existing.version, locale: existing.locale },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/**
 * Publish a draft. From here on its words never change.
 *
 * The effective date cannot be in the past - it becomes now if it was - so a
 * version cannot be published as though it had applied to people who signed
 * up before anyone could read it. Nor can it be earlier than the latest
 * published version in the same language, which would make the order of
 * versions depend on when somebody pressed Publish.
 */
export async function publishDraft(id: string, actor: LegalActor): Promise<LegalDocumentAdminView> {
  await prisma.$transaction(async (tx) => {
    // Locked first, before anything is read. The hash below seals the text
    // that is published, so the text must not change between reading it and
    // publishing it: without the lock an edit committed in between (a second
    // administrator, an autosave racing Publish) was published under the hash
    // of the text before it. With it, that edit either lands before this read
    // or waits and then finds the document no longer a draft.
    await tx.$queryRaw`SELECT id FROM legal_documents WHERE id = ${id} FOR UPDATE`;

    const draft = await tx.legalDocument.findUnique({ where: { id } });
    if (draft === null) throw notFound('Document');
    if (draft.status !== 'DRAFT') throw immutable();

    // A blank left for a decision - "[[DECISION: registered legal name]]", a
    // "____" fill-in line, or a "For approval" notice - can never be
    // published: nobody may be bound by a blank or by a text still awaiting
    // approval.
    const placeholders = findLegalPlaceholders(`${draft.title}
${draft.body}
${draft.changeSummary ?? ''}`);
    if (placeholders.length > 0) {
      throw unprocessable(
        ErrorCode.LEGAL_DOCUMENT_HAS_PLACEHOLDERS,
        'This document still has blanks to fill in ([[...]] or ____) or an approval notice. Resolve each one before publishing.',
        placeholders.slice(0, 50).map((placeholder) => ({
          field: 'body',
          code: 'LEGAL_DOCUMENT_HAS_PLACEHOLDERS',
          meta: { placeholder },
        })),
      );
    }

    const now = new Date();
    const effectiveAt = draft.effectiveAt.getTime() < now.getTime() ? now : draft.effectiveAt;

    const latest = await tx.legalDocument.findFirst({
      where: { kind: draft.kind, locale: draft.locale, status: 'PUBLISHED' },
      orderBy: [{ effectiveAt: 'desc' }, { publishedAt: 'desc' }],
      select: { id: true, version: true, effectiveAt: true },
    });

    if (latest !== null && effectiveAt.getTime() < latest.effectiveAt.getTime()) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `This version would take effect before version ${latest.version}, which is already published. Choose a later date.`,
        [{ field: 'effectiveAt', code: 'BEFORE_LATEST_PUBLISHED', meta: { latestVersion: latest.version } }],
      );
    }

    const contentSha256 = legalContentHash(draft);

    const published = await tx.legalDocument.updateMany({
      where: { id, status: 'DRAFT' },
      data: {
        status: 'PUBLISHED',
        effectiveAt,
        contentSha256,
        publishedAt: now,
        publishedById: actor.userId,
        supersedesId: latest?.id ?? null,
      },
    });
    if (published.count !== 1) throw immutable();

    await recordAudit(
      {
        action: AuditAction.LEGAL_DOCUMENT_PUBLISHED,
        resourceType: 'legal_document',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          kind: draft.kind,
          version: draft.version,
          locale: draft.locale,
          effectiveAt: effectiveAt.toISOString(),
          contentSha256,
          supersedesId: latest?.id ?? null,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  bumpLegalPublicationGeneration();
  return getLegalDocumentForAdmin(id);
}
