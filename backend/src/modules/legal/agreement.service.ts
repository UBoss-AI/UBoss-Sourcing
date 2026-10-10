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
import { AppError, badRequest, ErrorCode, forbidden, notFound } from '../../domain/errors.js';
import {
  acceptableVersions,
  canBindCompany,
  consentPurposeFor,
  CONSUMER_ACTIVATION_KINDS,
  isCompanyLevelKind,
  PRIVACY_NOTICE_KIND,
  SELLER_SUBMISSION_KINDS,
  servicesKindsForScope,
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

/**
 * The boxes on the screen. SERVICES - the Seller Platform Services Agreement -
 * exists only for the SELLER scope, and is its own box: reading or accepting
 * the Terms never touches it, and the reverse.
 */
export type AgreementRole = 'TERMS' | 'PRIVACY' | 'SERVICES';

export interface AgreementRecordView {
  recordId: string;
  documentId: string;
  version: string;
  locale: string;
  action: 'TERMS_ACCEPTED' | 'PRIVACY_NOTICE_ACKNOWLEDGED';
  /** Server time, ISO. */
  recordedAt: string;
  /**
   * True for a company-level acceptance given by ANOTHER member of the
   * company. It counts for this person, but it is not theirs to clear.
   */
  byOtherMember: boolean;
}

/**
 * The company a COMPANY_BUYER screen is for, from the session's confirmed
 * membership - never from the request.
 */
export interface AgreementCompany {
  companyId: string;
  role: string;
}

export interface AgreementCompanyView {
  companyId: string;
  companyName: string;
  /** May this person accept the B2B Buyer Platform Services Agreement for the company? */
  canBind: boolean;
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
  /** The Seller Platform Services Agreement for SELLER; empty for every other scope. */
  services: AgreementDocumentStatus[];
  privacy: AgreementDocumentStatus;
  termsComplete: boolean;
  servicesComplete: boolean;
  privacyComplete: boolean;
  /** Every box done: the person may continue. */
  complete: boolean;
  /** The company the COMPANY_BUYER screen is for; null on every other scope. */
  company: AgreementCompanyView | null;
  /**
   * COMPANY_BUYER only: the services box is empty and this person cannot fill
   * it - an owner or company admin must accept it for the company first.
   */
  awaitingSignatory: boolean;
}

export interface AgreementActor {
  userId: string;
  email: string;
  actorType: AuditActorType;
  correlationId?: string | null;
  /**
   * For the SELLER scope: the seller the person acts for, from their
   * membership as the server resolved it. Never from the request body.
   */
  sellerAccountId?: string | null;
  /** For the COMPANY_BUYER scope: the company and the person's role in it, from the session. */
  company?: AgreementCompany | null;
}

function kindsForRole(scope: AgreementScopeName, role: AgreementRole): readonly AgreementDocumentKind[] {
  if (role === 'TERMS') return termsKindsForScope(scope);
  if (role === 'SERVICES') return servicesKindsForScope(scope);
  return [PRIVACY_NOTICE_KIND];
}

function allKinds(scope: AgreementScopeName): AgreementDocumentKind[] {
  return [...termsKindsForScope(scope), ...servicesKindsForScope(scope), PRIVACY_NOTICE_KIND];
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
async function activeRecords(
  userId: string,
  kinds: readonly AgreementDocumentKind[],
  companyId: string | null = null,
) {
  const companyKinds = kinds.filter(isCompanyLevelKind);
  const personalKinds = kinds.filter((kind) => !isCompanyLevelKind(kind));
  const rows = await prisma.consentRecord.findMany({
    where: {
      activeDocumentId: { not: null },
      OR: [
        { userId, legalDocument: { kind: { in: [...personalKinds] } } },
        // A company-level record counts for every member, whoever gave it.
        ...(companyId !== null && companyKinds.length > 0
          ? [{ companyId, activeCompanyKey: companyId, legalDocument: { kind: { in: [...companyKinds] } } }]
          : []),
      ],
    },
    select: {
      id: true,
      userId: true,
      activeCompanyKey: true,
      legalDocumentId: true,
      locale: true,
      action: true,
      acceptedAt: true,
      legalDocument: { select: { kind: true, version: true } },
    },
    orderBy: { acceptedAt: 'desc' },
  });
  // A person's B2B Terms count only for the company they were accepted for;
  // everything else personal (the Privacy Policy) counts wherever they are.
  return rows.filter(
    (row) =>
      row.legalDocument?.kind !== 'B2B_BUYER_TERMS' || (companyId !== null && row.activeCompanyKey === companyId),
  );
}

type ActiveRecord = Awaited<ReturnType<typeof activeRecords>>[number];

function recordFor(kind: AgreementDocumentKind, versions: string[], records: ActiveRecord[]): ActiveRecord | null {
  return (
    records.find(
      (record) => record.legalDocument?.kind === kind && versions.includes(record.legalDocument.version),
    ) ?? null
  );
}

/**
 * Which screen somebody shopping for themselves answers to.
 *
 * CONSUMER - the B2C Consumer Terms, the Privacy Policy and the B2C Platform
 * Services Agreement - once every one of the three has a version in force;
 * BUYER, exactly as before, until then. Decided by what is published, never
 * by a tab or a request: an individual cannot pick the screen that suits
 * them, and an unfinished set (a draft, an approval still pending, one of the
 * three not supplied) can never become a sign-in nobody can pass.
 *
 * Switching to CONSUMER asks everybody prospectively: the Terms of Use they
 * accepted stay on record, nothing is copied across, and an order already
 * confirmed keeps the terms it was confirmed under.
 */
export async function individualAgreementScope(now = new Date()): Promise<'CONSUMER' | 'BUYER'> {
  for (const kind of CONSUMER_ACTIVATION_KINDS) {
    if ((await countingVersions(kind, now)).length === 0) return 'BUYER';
  }
  return 'CONSUMER';
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
export async function assertAgreementsSatisfied(
  userId: string,
  scope: AgreementScopeName,
  companyId: string | null = null,
): Promise<void> {
  if (!env.FEATURE_AGREEMENT_GATE) return;

  const now = new Date();
  const kinds = allKinds(scope);
  const required = new Map<AgreementDocumentKind, string[]>();
  for (const kind of kinds) {
    const versions = await countingVersions(kind, now);
    if (versions.length > 0) required.set(kind, versions);
  }
  if (required.size === 0) return;

  const records = await activeRecords(userId, [...required.keys()], scope === 'COMPANY_BUYER' ? companyId : null);
  const missing = [...required].filter(([kind, versions]) => recordFor(kind, versions, records) === null);
  if (missing.length === 0) return;

  throw new AppError({
    statusCode: 403,
    code: ErrorCode.AGREEMENTS_REQUIRED,
    message: 'Accept the Terms and acknowledge the Privacy Policy to continue.',
    details: missing.map(([kind]) => ({ code: 'AGREEMENT_MISSING', meta: { kind, scope } })),
  });
}

export interface SellerSubmissionAgreement {
  kind: AgreementDocumentKind;
  recordId: string;
  legalDocumentId: string;
  version: string;
  contentSha256: string;
}

/**
 * What a seller application is submitted against: the person's acceptance of
 * the Seller Terms and Conditions AND the Seller Platform Services Agreement,
 * each in a PUBLISHED version that still counts. Read fresh - never from the
 * gate's cache - because a version published since the person read it must
 * send them back to read it, not slip through for fifteen seconds.
 *
 * Stricter than the gate on purpose: a kind with nothing published does not
 * lock anybody out of the Hub, but nobody can submit an application against
 * an agreement that does not exist yet - a draft is never enough.
 *
 * A record the person gave while acting for ANOTHER seller does not count
 * here. One written before records named a seller (null) still does: nobody
 * can say it was for a different one, and none is rewritten.
 *
 * Off with the agreement gate (`FEATURE_AGREEMENT_GATE`), which production
 * refuses to start without. Returns the records, for the submission's audit.
 */
export async function assertSellerSubmissionAgreements(
  userId: string,
  sellerAccountId: string,
): Promise<SellerSubmissionAgreement[]> {
  if (!env.FEATURE_AGREEMENT_GATE) return [];

  const now = new Date();
  const kinds: readonly AgreementDocumentKind[] = SELLER_SUBMISSION_KINDS;
  const records = await prisma.consentRecord.findMany({
    where: {
      userId,
      activeDocumentId: { not: null },
      OR: [{ sellerAccountId }, { sellerAccountId: null }],
      legalDocument: { kind: { in: [...kinds] }, status: 'PUBLISHED' },
    },
    select: {
      id: true,
      acceptedAt: true,
      legalDocument: { select: { id: true, kind: true, version: true, contentSha256: true } },
    },
    orderBy: { acceptedAt: 'desc' },
  });

  const found: SellerSubmissionAgreement[] = [];
  const problems: { field: string; code: string; meta: { kind: string } }[] = [];
  for (const kind of kinds) {
    const versions = acceptableVersions(await inForceVersions(kind, now));
    if (versions.length === 0) {
      problems.push({ field: kind, code: 'AGREEMENT_NOT_PUBLISHED', meta: { kind } });
      continue;
    }
    const record = records.find(
      (row) => row.legalDocument?.kind === kind && versions.includes(row.legalDocument.version),
    );
    if (record?.legalDocument === undefined || record.legalDocument === null) {
      problems.push({ field: kind, code: 'AGREEMENT_NOT_ACCEPTED', meta: { kind } });
      continue;
    }
    found.push({
      kind,
      recordId: record.id,
      legalDocumentId: record.legalDocument.id,
      version: record.legalDocument.version,
      contentSha256: record.legalDocument.contentSha256 ?? '',
    });
  }

  if (problems.length > 0) {
    throw new AppError({
      statusCode: 409,
      code: ErrorCode.SELLER_AGREEMENTS_REQUIRED,
      message:
        'Accept the current Seller Terms and Conditions and Seller Platform Services Agreement before sending your application.',
      details: problems,
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

function toRecordView(record: ActiveRecord, userId: string): AgreementRecordView {
  return {
    byOtherMember: record.userId !== userId,
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
  company: AgreementCompany | null = null,
): Promise<AgreementStatus> {
  const now = new Date();
  const kinds = allKinds(scope);
  const companyId = scope === 'COMPANY_BUYER' ? (company?.companyId ?? null) : null;
  const records = await activeRecords(userId, kinds, companyId);

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
        record: record === null ? null : toRecordView(record, userId),
        unavailable: current === null,
      };
    }),
  );

  const termsCount = termsKindsForScope(scope).length;
  const privacy = statuses[statuses.length - 1] as AgreementDocumentStatus;
  const terms = statuses.slice(0, termsCount);
  const services = statuses.slice(termsCount, -1);
  const done = (status: AgreementDocumentStatus): boolean => status.unavailable || status.record !== null;
  const termsComplete = terms.every(done);
  const servicesComplete = services.every(done);
  const privacyComplete = done(privacy);

  let companyView: AgreementCompanyView | null = null;
  if (companyId !== null && company !== null) {
    const row = await prisma.buyerCompany.findUnique({
      where: { id: companyId },
      select: { legalName: true, tradingName: true, applicationReference: true },
    });
    companyView = {
      companyId,
      companyName: row?.tradingName ?? row?.legalName ?? row?.applicationReference ?? '',
      canBind: canBindCompany(company.role),
    };
  }

  return {
    scope,
    terms,
    services,
    privacy,
    termsComplete,
    servicesComplete,
    privacyComplete,
    complete: termsComplete && servicesComplete && privacyComplete,
    company: companyView,
    awaitingSignatory: companyView !== null && !servicesComplete && !companyView.canBind,
  };
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
  const company = input.scope === 'COMPANY_BUYER' ? (actor.company ?? null) : null;
  if (input.scope === 'COMPANY_BUYER' && company === null) {
    throw forbidden(ErrorCode.BUYER_CONTEXT_INVALID, 'Choose the company you are acting for first.');
  }
  // The services agreement binds the company: only somebody who may bind it
  // can accept it. Checked before anything is read, so the refusal is the
  // same whatever ids were sent.
  if (company !== null && input.role === 'SERVICES' && !canBindCompany(company.role)) {
    throw forbidden(
      ErrorCode.COMPANY_SIGNATORY_REQUIRED,
      'Only an owner or company admin can accept this agreement for the company.',
    );
  }
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
          : input.role === 'SERVICES'
            ? 'That document is not the Platform Services Agreement for this account.'
            : 'That document is not the Privacy Policy.',
        [{ field: 'documentIds', code: 'AGREEMENT_DOCUMENT_NOT_APPLICABLE', meta: { documentId: id } }],
      );
    }
  }

  const action = input.role === 'PRIVACY' ? 'PRIVACY_NOTICE_ACKNOWLEDGED' : 'TERMS_ACCEPTED';
  const sellerAccountId = input.scope === 'SELLER' ? (actor.sellerAccountId ?? null) : null;

  for (const id of ids) {
    const kind = kindOf.get(id) as AgreementDocumentKind;

    await prisma
      .$transaction(async (tx) => {
        // Re-checked inside the write: a version published since the dialog
        // opened is refused here, not recorded as though it had been read.
        const document = await assertCurrentDocument({ kind, documentId: id, client: tx });

        // Which company the record is for: the B2B Terms and the services
        // agreement name it; the Privacy Policy is the person's own.
        const companyId = company !== null && kind !== PRIVACY_NOTICE_KIND ? company.companyId : null;
        const existing = await tx.consentRecord.findFirst({
          where: isCompanyLevelKind(kind)
            ? // Accepted once for the company: nobody countersigns.
              { activeDocumentId: document.id, companyId, activeCompanyKey: companyId ?? '' }
            : companyId !== null
              ? { userId: actor.userId, activeDocumentId: document.id, activeCompanyKey: companyId }
              : { userId: actor.userId, activeDocumentId: document.id },
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
            sellerAccountId,
            companyId,
            activeCompanyKey: companyId ?? '',
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
              sellerAccountId,
              companyId,
              companyRole: companyId === null ? null : (company?.role ?? null),
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
  const companyId = input.scope === 'COMPANY_BUYER' ? (actor.company?.companyId ?? null) : null;
  // Only what this person gave: a company acceptance another member gave is
  // not theirs to undo.
  const records = (await activeRecords(actor.userId, kinds, companyId)).filter(
    (record) => record.userId === actor.userId,
  );
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
