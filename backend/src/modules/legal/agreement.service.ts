/**
 * The agreement screen after sign-in: has this person accepted the Terms for
 * their kind of account, and acknowledged the Privacy Policy, in versions that
 * still count?
 *
 * ## What the screen records, and what it never does
 *
 * Two separate things, never one:
 *
 *   - **Terms accepted** (`TERMS_ACCEPTED`) - a contract the person agrees to.
 *   - **Privacy notice acknowledged** (`PRIVACY_NOTICE_ACKNOWLEDGED`) - the
 *     person was shown how their data is used. Not a consent: the processing
 *     the notice describes rests on contract and legitimate interest, and the
 *     notice says so. Acknowledging it switches on no optional processing.
 *
 * Each is one `ConsentRecord` that points at the exact published document,
 * copies its version, language and hash from the stored row, and takes its
 * time from the database clock. The browser only ever names a document id; a
 * document that is not the one in force for the person's kind of account is
 * refused.
 *
 * ## Which versions still count
 *
 * The newest version in force always does. An older one keeps counting until
 * a version that asked for re-acceptance takes effect (`acceptableVersions`).
 * So a correction published with `requiresReacceptance` off asks nobody again,
 * and a real change asks everybody on their next request.
 *
 * ## Kinds with nothing published
 *
 * A document that is not published cannot be asked for: there is nothing to
 * read. Such a kind is reported `unavailable` and does not block the person.
 * Signing UP still refuses without published Terms (`assertAcceptableTerms`);
 * this gate exists for people who already have an account, and locking every
 * one of them - the staff who would publish the documents included - out of a
 * deployment that has not finished its legal set-up would be an outage, not a
 * safeguard. The going-live checklist says to publish them.
 */
import { env } from '../../config/env.js';
import { AppError, badRequest, ErrorCode, notFound } from '../../domain/errors.js';
import {
  acceptableVersions,
  consentPurposeFor,
  PRIVACY_NOTICE_KIND,
  termsKindsForScope,
  type AgreementDocumentKind,
  type AgreementScopeName,
} from '../../domain/legal-document.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit, type AuditActorType } from '../audit/audit.service.js';
import {
  assertCurrentDocument,
  findCurrentDocument,
  inForceVersions,
  type CurrentLegalDocument,
} from './legal-document.service.js';
import { legalPublicationGeneration } from './publication-generation.js';

/** The two boxes on the screen. */
export type AgreementRole = 'TERMS' | 'PRIVACY';

export interface AgreementRecordView {
  recordId: string;
  documentId: string;
  version: string;
  locale: string;
  action: 'TERMS_ACCEPTED' | 'PRIVACY_NOTICE_ACKNOWLEDGED';
  /** Server time, ISO. */
  recordedAt: string;
}

export interface AgreementDocumentStatus {
  kind: AgreementDocumentKind;
  /** What to read now, in the person's language where published. Null when nothing is in force. */
  current: CurrentLegalDocument | null;
  /** The record that counts for this kind, or null when none does. */
  record: AgreementRecordView | null;
  /** True when nothing of this kind is in force, so it is not asked for. */
  unavailable: boolean;
}

export interface AgreementStatus {
  scope: AgreementScopeName;
  /** The Terms, in reading order: a seller reads the Terms of Use, then the Seller Addendum. */
  terms: AgreementDocumentStatus[];
  privacy: AgreementDocumentStatus;
  termsComplete: boolean;
  privacyComplete: boolean;
  /** Both boxes done: the person may continue. */
  complete: boolean;
}

export interface AgreementActor {
  userId: string;
  email: string;
  actorType: AuditActorType;
  correlationId?: string | null;
}

function kindsForRole(scope: AgreementScopeName, role: AgreementRole): readonly AgreementDocumentKind[] {
  return role === 'TERMS' ? termsKindsForScope(scope) : [PRIVACY_NOTICE_KIND];
}

function allKinds(scope: AgreementScopeName): AgreementDocumentKind[] {
  return [...termsKindsForScope(scope), PRIVACY_NOTICE_KIND];
}

// ---------------------------------------------------------------------------
// Which versions count - cached, because the gate asks on every request
// ---------------------------------------------------------------------------

/** How long one process trusts its copy of the versions in force. */
const REQUIREMENT_TTL_MS = 15_000;

interface CachedRequirement {
  /** Versions whose acceptance counts, newest first. Empty: nothing in force. */
  versions: string[];
  expiresAt: number;
  generation: number;
}

const requirementCache = new Map<AgreementDocumentKind, CachedRequirement>();

/** For tests that write documents straight into the database. */
export function resetAgreementRequirementCache(): void {
  requirementCache.clear();
}

async function countingVersions(kind: AgreementDocumentKind, now: Date): Promise<string[]> {
  const cached = requirementCache.get(kind);
  const generation = legalPublicationGeneration();
  if (cached !== undefined && cached.expiresAt > now.getTime() && cached.generation === generation) {
    return cached.versions;
  }
  const versions = acceptableVersions(await inForceVersions(kind, now));
  requirementCache.set(kind, { versions, expiresAt: now.getTime() + REQUIREMENT_TTL_MS, generation });
  return versions;
}

/**
 * The person's records that are in force, one per document, with the
 * document's kind and version. Cleared and withdrawn records are left out by
 * the `activeDocumentId` column, which is null for both.
 */
async function activeRecords(userId: string, kinds: readonly AgreementDocumentKind[]) {
  return prisma.consentRecord.findMany({
    where: {
      userId,
      activeDocumentId: { not: null },
      legalDocument: { kind: { in: [...kinds] } },
    },
    select: {
      id: true,
      legalDocumentId: true,
      locale: true,
      action: true,
      acceptedAt: true,
      legalDocument: { select: { kind: true, version: true } },
    },
    orderBy: { acceptedAt: 'desc' },
  });
}

type ActiveRecord = Awaited<ReturnType<typeof activeRecords>>[number];

function recordFor(kind: AgreementDocumentKind, versions: string[], records: ActiveRecord[]): ActiveRecord | null {
  return (
    records.find(
      (record) => record.legalDocument?.kind === kind && versions.includes(record.legalDocument.version),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Refuse with AGREEMENTS_REQUIRED unless every document in force for this
 * scope has a record that counts. Called by every guard that admits a person
 * to the application itself; never by sign-in, sign-out, the agreement screen,
 * the public documents, support or privacy requests.
 */
export async function assertAgreementsSatisfied(userId: string, scope: AgreementScopeName): Promise<void> {
  if (!env.FEATURE_AGREEMENT_GATE) return;

  const now = new Date();
  const kinds = allKinds(scope);
  const required = new Map<AgreementDocumentKind, string[]>();
  for (const kind of kinds) {
    const versions = await countingVersions(kind, now);
    if (versions.length > 0) required.set(kind, versions);
  }
  if (required.size === 0) return;

  const records = await activeRecords(userId, [...required.keys()]);
  const missing = [...required].filter(([kind, versions]) => recordFor(kind, versions, records) === null);
  if (missing.length === 0) return;

  throw new AppError({
    statusCode: 403,
    code: ErrorCode.AGREEMENTS_REQUIRED,
    message: 'Accept the Terms and acknowledge the Privacy Policy to continue.',
    details: missing.map(([kind]) => ({ code: 'AGREEMENT_MISSING', meta: { kind, scope } })),
  });
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

function toRecordView(record: ActiveRecord): AgreementRecordView {
  return {
    recordId: record.id,
    documentId: record.legalDocumentId ?? '',
    version: record.legalDocument?.version ?? '',
    locale: record.locale ?? '',
    action: record.action ?? 'TERMS_ACCEPTED',
    recordedAt: record.acceptedAt.toISOString(),
  };
}

/** Where the person stands, read fresh - never from the gate's cache. */
export async function getAgreementStatus(
  userId: string,
  scope: AgreementScopeName,
  locale: string,
): Promise<AgreementStatus> {
  const now = new Date();
  const kinds = allKinds(scope);
  const records = await activeRecords(userId, kinds);

  const statuses = await Promise.all(
    kinds.map(async (kind): Promise<AgreementDocumentStatus> => {
      const [current, history] = await Promise.all([
        findCurrentDocument(kind, locale, now),
        inForceVersions(kind, now),
      ]);
      const versions = acceptableVersions(history);
      const record = versions.length === 0 ? null : recordFor(kind, versions, records);
      return {
        kind,
        current,
        record: record === null ? null : toRecordView(record),
        unavailable: current === null,
      };
    }),
  );

  const privacy = statuses[statuses.length - 1] as AgreementDocumentStatus;
  const terms = statuses.slice(0, -1);
  const done = (status: AgreementDocumentStatus): boolean => status.unavailable || status.record !== null;
  const termsComplete = terms.every(done);
  const privacyComplete = done(privacy);

  return { scope, terms, privacy, termsComplete, privacyComplete, complete: termsComplete && privacyComplete };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/**
 * Record what the person did in one dialog: "I agree" on the Terms, or "I
 * acknowledge" on the Privacy Policy. Never both - each box is its own call.
 *
 * Every id must name the document in force for a kind this scope asks for
 * under that box; anything else is refused and nothing is written. A document
 * that already has an active record from this person is left alone, so a
 * double click or a retried request writes one row.
 */
export async function recordAgreement(
  actor: AgreementActor,
  input: { scope: AgreementScopeName; role: AgreementRole; documentIds: string[] },
): Promise<void> {
  const allowed = kindsForRole(input.scope, input.role);
  const ids = [...new Set(input.documentIds)];
  if (ids.length === 0 || ids.length > allowed.length) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Name the documents you read.', [
      { field: 'documentIds', code: 'INVALID_COUNT' },
    ]);
  }

  // Which kind each id is, read from the stored row - never from the request.
  const rows = await prisma.legalDocument.findMany({
    where: { id: { in: ids }, status: 'PUBLISHED' },
    select: { id: true, kind: true },
  });
  const kindOf = new Map(rows.map((row) => [row.id, row.kind as string]));

  for (const id of ids) {
    const kind = kindOf.get(id);
    if (kind === undefined || !(allowed as readonly string[]).includes(kind)) {
      // A real document of another kind is refused the same way as a made-up
      // id: this box does not accept it.
      throw badRequest(
        ErrorCode.AGREEMENT_DOCUMENT_NOT_APPLICABLE,
        input.role === 'TERMS'
          ? 'That document is not the Terms for this account.'
          : 'That document is not the Privacy Policy.',
        [{ field: 'documentIds', code: 'AGREEMENT_DOCUMENT_NOT_APPLICABLE', meta: { documentId: id } }],
      );
    }
  }

  const action = input.role === 'TERMS' ? 'TERMS_ACCEPTED' : 'PRIVACY_NOTICE_ACKNOWLEDGED';

  for (const id of ids) {
    const kind = kindOf.get(id) as AgreementDocumentKind;

    await prisma
      .$transaction(async (tx) => {
        // Re-checked inside the write: a version published since the dialog
        // opened is refused here, not recorded as though it had been read.
        const document = await assertCurrentDocument({ kind, documentId: id, client: tx });

        const existing = await tx.consentRecord.findFirst({
          where: { userId: actor.userId, activeDocumentId: document.id },
          select: { id: true },
        });
        if (existing !== null) return;

        const recordId = newId();
        await tx.consentRecord.create({
          data: {
            id: recordId,
            userId: actor.userId,
            purpose: consentPurposeFor(kind),
            textVersion: document.version,
            textHash: document.contentSha256,
            legalDocumentId: document.id,
            activeDocumentId: document.id,
            locale: document.locale,
            acceptanceSource: 'AGREEMENT_SCREEN',
            action,
            scope: input.scope,
          },
        });

        await recordAudit(
          {
            action:
              action === 'TERMS_ACCEPTED'
                ? AuditAction.LEGAL_TERMS_ACCEPTED
                : AuditAction.LEGAL_PRIVACY_NOTICE_ACKNOWLEDGED,
            resourceType: 'consent_record',
            resourceId: recordId,
            actorType: actor.actorType,
            actorUserId: actor.userId,
            actorEmail: actor.email,
            after: {
              kind,
              version: document.version,
              locale: document.locale,
              scope: input.scope,
              legalDocumentId: document.id,
              contentSha256: document.contentSha256,
            },
            correlationId: actor.correlationId ?? null,
          },
          tx,
        );
      })
      .catch((error: unknown) => {
        // Two requests at once: the unique index let one through, and that
        // one is the record. Nothing to do for the other.
        if (!isUniqueViolation(error)) throw error;
      });
  }
}

/**
 * Untick a box before Continue. The record stays - with `clearedAt` and no
 * active id - and an audit event says it was cleared, so nothing in the
 * history is deleted. Clearing is not withdrawing a consent: the record says
 * "cleared on the agreement screen", and nothing else the person agreed to is
 * touched. Afterwards the gate asks again.
 */
export async function clearAgreement(
  actor: AgreementActor,
  input: { scope: AgreementScopeName; role: AgreementRole },
): Promise<void> {
  const kinds = kindsForRole(input.scope, input.role);
  const records = await activeRecords(actor.userId, kinds);
  if (records.length === 0) throw notFound('Agreement');

  await prisma.$transaction(async (tx) => {
    for (const record of records) {
      // Conditional on still being active, so two clears do not both log.
      const cleared = await tx.consentRecord.updateMany({
        where: { id: record.id, activeDocumentId: { not: null } },
        data: { activeDocumentId: null, clearedAt: new Date() },
      });
      if (cleared.count !== 1) continue;

      await recordAudit(
        {
          action: AuditAction.LEGAL_AGREEMENT_CLEARED,
          resourceType: 'consent_record',
          resourceId: record.id,
          actorType: actor.actorType,
          actorUserId: actor.userId,
          actorEmail: actor.email,
          before: {
            kind: record.legalDocument?.kind ?? null,
            version: record.legalDocument?.version ?? null,
            action: record.action,
          },
          after: { cleared: true, scope: input.scope },
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
    }
  });
}

export interface AgreementHistoryEntry {
  recordId: string;
  kind: string;
  title: string;
  documentId: string;
  version: string;
  locale: string;
  action: 'TERMS_ACCEPTED' | 'PRIVACY_NOTICE_ACKNOWLEDGED';
  scope: AgreementScopeName | null;
  recordedAt: string;
  clearedAt: string | null;
  withdrawnAt: string | null;
}

/** Everything this person accepted or acknowledged, newest first, for their account page. */
export async function listAgreementHistory(userId: string): Promise<AgreementHistoryEntry[]> {
  const rows = await prisma.consentRecord.findMany({
    where: { userId, legalDocumentId: { not: null } },
    select: {
      id: true,
      locale: true,
      action: true,
      scope: true,
      acceptedAt: true,
      clearedAt: true,
      withdrawnAt: true,
      legalDocument: { select: { id: true, kind: true, version: true, title: true } },
    },
    orderBy: { acceptedAt: 'desc' },
    take: 200,
  });
  return rows
    .filter((row) => row.legalDocument !== null)
    .map((row) => ({
      recordId: row.id,
      kind: row.legalDocument?.kind ?? '',
      title: row.legalDocument?.title ?? '',
      documentId: row.legalDocument?.id ?? '',
      version: row.legalDocument?.version ?? '',
      locale: row.locale ?? '',
      action: row.action ?? 'TERMS_ACCEPTED',
      scope: row.scope,
      recordedAt: row.acceptedAt.toISOString(),
      clearedAt: row.clearedAt?.toISOString() ?? null,
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    }));
}
