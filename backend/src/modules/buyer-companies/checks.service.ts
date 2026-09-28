/**
 * The automated part of verification: registry lookups, the rule-based
 * signals, duplicate detection and the risk level they add up to.
 *
 * None of it decides anything. The run ends by putting the application in
 * front of a reviewer - UNDER_REVIEW - whatever the registries said, and a
 * registry that could not be reached is recorded as exactly that. There is
 * no path from here to APPROVED or REJECTED; the state machine does not have
 * one for SYSTEM.
 *
 * DUPLICATES ARE SIGNALS. A second application naming the same registration
 * number is usually a colleague who did not know somebody had started, or a
 * rejected applicant trying again properly. It is shown to the reviewer with
 * the other application's reference; it never refuses anything by itself.
 */
import { env } from '../../config/env.js';
import {
  identifierInconsistencies,
  normaliseIdentifier,
  type BuyerCompanyEntityTypeName,
} from '../../domain/buyer-company-identifiers.js';
import { logger } from '../../infra/logger.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  VERIFICATION_PROVIDERS,
  type CheckResult,
  type CompanySubject,
} from './providers/index.js';
import { SYSTEM_ACTOR, transitionCompany, writeEvent, type Actor, type Tx } from './shared.js';

interface Row extends CheckResult {
  provider: string;
}

function subjectOf(company: {
  id: string;
  legalName: string | null;
  tradingName: string | null;
  entityType: BuyerCompanyEntityTypeName | null;
  registrationCountry: string | null;
  registrationNumberNormalized: string | null;
  identifiers: { scheme: string; valueNormalized: string | null; notApplicable: boolean }[];
}): CompanySubject {
  const identifiers = new Map<string, string>();
  for (const row of company.identifiers) {
    if (!row.notApplicable && row.valueNormalized !== null)
      identifiers.set(row.scheme, row.valueNormalized);
  }
  return {
    companyId: company.id,
    legalName: company.legalName,
    tradingName: company.tradingName,
    entityType: company.entityType,
    registrationCountry: company.registrationCountry,
    registrationNumber: company.registrationNumberNormalized,
    identifiers,
  };
}

const SIGNAL_INCLUDE = {
  identifiers: true,
  addresses: true,
  documents: { select: { contentHash: true, status: true } },
} as const;

type SignalCompany = Prisma.BuyerCompanyGetPayload<{ include: typeof SIGNAL_INCLUDE }>;

/** Other companies that share something identifying with this one. */
export async function duplicateSignals(company: SignalCompany): Promise<Row[]> {
  const rows: Row[] = [];
  const others = { id: { not: company.id }, archivedAt: null };
  const describe = (other: { applicationReference: string; status: string }): string =>
    `${other.applicationReference} (${other.status.toLowerCase().replace(/_/g, ' ')})`;
  const add = (
    subject: string,
    summary: string,
    matches: { applicationReference: string; status: string; id: string }[],
  ): void => {
    if (matches.length === 0) return;
    rows.push({
      provider: 'DUPLICATES',
      subject,
      outcome: 'SIGNAL',
      summary: `${summary}: ${matches.map(describe).join(', ')}.`,
      request: { subject },
      result: {
        matches: matches.map((match) => ({
          id: match.id,
          reference: match.applicationReference,
          status: match.status,
        })),
      },
    });
  };
  const select = { id: true, applicationReference: true, status: true } as const;

  if (company.registrationCountry !== null && company.registrationNumberNormalized !== null) {
    add(
      'REGISTRATION',
      'Same registration number as',
      await prisma.buyerCompany.findMany({
        where: {
          ...others,
          registrationCountry: company.registrationCountry,
          registrationNumberNormalized: company.registrationNumberNormalized,
        },
        select,
        take: 10,
      }),
    );
  }

  for (const identifier of company.identifiers) {
    if (identifier.notApplicable || identifier.valueNormalized === null) continue;
    const matches = await prisma.buyerCompanyIdentifier.findMany({
      where: {
        scheme: identifier.scheme,
        valueNormalized: identifier.valueNormalized,
        company: others,
      },
      select: { company: { select } },
      take: 10,
    });
    add(
      identifier.scheme,
      `Same ${identifier.scheme} as`,
      matches.map((match) => match.company),
    );
  }

  if (company.legalNameNormalized !== null && company.legalNameNormalized.length > 2) {
    add(
      'LEGAL_NAME',
      'Same legal name as',
      await prisma.buyerCompany.findMany({
        where: {
          ...others,
          legalNameNormalized: company.legalNameNormalized,
          registrationCountry: company.registrationCountry,
        },
        select,
        take: 10,
      }),
    );
  }

  if (
    company.businessDomain !== null &&
    company.businessDomainStatus !== 'FREE_MAIL_PROVIDER' &&
    company.businessDomainStatus !== 'UNKNOWN'
  ) {
    add(
      'EMAIL_DOMAIN',
      'Same business email domain as',
      await prisma.buyerCompany.findMany({
        where: { ...others, businessDomain: company.businessDomain },
        select,
        take: 10,
      }),
    );
  }

  const registered = company.addresses.find((address) => address.kind === 'REGISTERED_OFFICE');
  if (registered !== undefined) {
    const matches = await prisma.buyerCompanyAddress.findMany({
      where: { fingerprint: registered.fingerprint, kind: 'REGISTERED_OFFICE', company: others },
      select: { company: { select } },
      take: 10,
    });
    add(
      'ADDRESS',
      'Same registered office as',
      matches.map((match) => match.company),
    );
  }

  const hashes = [...new Set(company.documents.map((document) => document.contentHash))];
  if (hashes.length > 0) {
    const matches = await prisma.buyerCompanyDocument.findMany({
      where: { contentHash: { in: hashes }, company: others },
      select: { company: { select } },
      take: 10,
    });
    const unique = new Map(matches.map((match) => [match.company.id, match.company]));
    add('DOCUMENT', 'An identical document was uploaded to', [...unique.values()]);
  }

  return rows;
}

/**
 * Seller accounts for what looks like the same legal entity.
 *
 * Its own provider rather than a DUPLICATES row, and on purpose: a company
 * that both sells and buys here is ordinary, and an approved seller with the
 * same registration number must not read as "an approved duplicate" and push
 * the risk to HIGH. What the reviewer gets is the comparison, with the seller
 * account's OWN status beside it - which is information, never a decision.
 * Seller approval grants nothing on the buyer side, and this row does not
 * change that.
 *
 *   - The seller account the draft was started from, when its registration
 *     number still matches: PASS - the two halves agree.
 *   - That seller account, when the number no longer matches: SIGNAL - the
 *     applicant changed it after pre-filling, and the reviewer should see why.
 *   - Any OTHER seller account with the same registration number: SIGNAL.
 */
export async function sellerAccountSignals(company: SignalCompany): Promise<Row[]> {
  const rows: Row[] = [];
  const number = company.registrationNumberNormalized;
  const describe = (seller: { displayName: string; status: string }): string =>
    `${seller.displayName} (${seller.status.toLowerCase().replace(/_/g, ' ')})`;
  const select = {
    id: true,
    legalName: true,
    displayName: true,
    status: true,
    registrationCountry: true,
    businessProfile: { select: { companyRegistrationNumber: true } },
  } as const;
  const sameNumber = (raw: string | null | undefined): boolean =>
    number !== null && raw !== null && raw !== undefined && normaliseIdentifier(raw) === number;

  if (company.linkedSellerAccountId !== null) {
    const linked = await prisma.sellerAccount.findUnique({
      where: { id: company.linkedSellerAccountId },
      select,
    });
    if (linked !== null) {
      const matches =
        linked.registrationCountry === company.registrationCountry &&
        sameNumber(linked.businessProfile?.companyRegistrationNumber);
      rows.push({
        provider: 'SELLER_ACCOUNT',
        subject: 'LINKED_SELLER',
        outcome: matches ? 'PASS' : 'SIGNAL',
        summary: matches
          ? `Started from seller account ${describe(linked)}; the registration details still match.`
          : `Started from seller account ${describe(linked)}, but the registration country or number has since been changed.`,
        request: { sellerAccountId: linked.id },
        result: { sellerAccountId: linked.id, sellerStatus: linked.status, matches },
      });
    }
  }

  if (company.registrationCountry !== null && number !== null) {
    // Stored as typed on the seller side, so compared normalised here. The
    // raw forms narrow the query; the normalised comparison decides.
    const candidates = await prisma.sellerAccount.findMany({
      where: {
        ...(company.linkedSellerAccountId === null
          ? {}
          : { id: { not: company.linkedSellerAccountId } }),
        archivedAt: null,
        registrationCountry: company.registrationCountry,
        businessProfile: {
          companyRegistrationNumber: {
            in: [...new Set([number, company.registrationNumber ?? number])],
          },
        },
      },
      select,
      take: 10,
    });
    const others = candidates.filter((seller) =>
      sameNumber(seller.businessProfile?.companyRegistrationNumber),
    );
    if (others.length > 0) {
      rows.push({
        provider: 'SELLER_ACCOUNT',
        subject: 'REGISTRATION',
        outcome: 'SIGNAL',
        summary: `Same registration number as seller account ${others.map(describe).join(', ')}.`,
        request: { subject: 'REGISTRATION' },
        result: {
          sellers: others.map((seller) => ({ id: seller.id, status: seller.status })),
        },
      });
    }
  }

  return rows;
}

/** The rule-based signals: identifiers that contradict each other, and the email domain. */
function ruleSignals(company: SignalCompany, subject: CompanySubject): Row[] {
  const rows: Row[] = [];

  for (const inconsistency of identifierInconsistencies({
    registrationCountry: company.registrationCountry,
    entityType: company.entityType,
    registrationNumber: company.registrationNumberNormalized,
    identifiers: subject.identifiers,
  })) {
    rows.push({
      provider: 'CONSISTENCY',
      subject: inconsistency.schemes.join('+'),
      outcome: 'SIGNAL',
      summary:
        {
          GSTIN_PAN_MISMATCH: 'The PAN inside the GSTIN (characters 3-12) is not the PAN given.',
          PAN_HOLDER_TYPE_MISMATCH:
            'The PAN’s fourth character does not match the legal form (C for a company, F for a firm or LLP).',
          VAT_NIP_MISMATCH: 'The Polish VAT number is not "PL" followed by the NIP given.',
          CEIDG_NIP_MISMATCH:
            'A Polish sole trader is registered in CEIDG under their NIP, but the registration number is not the NIP.',
        }[inconsistency.code] ?? inconsistency.code,
      request: { rule: inconsistency.code },
    });
  }

  if (
    company.businessDomainStatus === 'FREE_MAIL_PROVIDER' ||
    company.businessDomainStatus === 'DIFFERS_FROM_WEBSITE'
  ) {
    rows.push({
      provider: 'EMAIL_DOMAIN',
      subject: 'BUSINESS_EMAIL',
      outcome: 'SIGNAL',
      summary:
        company.businessDomainStatus === 'FREE_MAIL_PROVIDER'
          ? 'The business email is on a free webmail service. Common for small businesses; look for other evidence.'
          : 'The business email domain is not the website’s domain.',
      request: { domain: company.businessDomain },
    });
  }

  return rows;
}

/**
 * How much attention the application needs, from what the checks found.
 * Advisory: it orders the queue and, when BUYER_COMPANY_SECOND_REVIEW_RISK is
 * set, asks for a second reviewer. It never decides.
 */
export function riskLevelFor(
  rows: readonly Pick<Row, 'outcome' | 'provider' | 'result'>[],
): 'NONE' | 'LOW' | 'ELEVATED' | 'HIGH' {
  const approvedDuplicate = rows.some(
    (row) =>
      row.provider === 'DUPLICATES' &&
      Array.isArray((row.result as { matches?: unknown } | null | undefined)?.matches) &&
      (row.result as { matches: { status: string }[] }).matches.some(
        (match) => match.status === 'APPROVED',
      ),
  );
  if (approvedDuplicate || rows.some((row) => row.outcome === 'FAIL')) return 'HIGH';
  if (rows.some((row) => row.outcome === 'SIGNAL' || row.outcome === 'INCONCLUSIVE'))
    return 'ELEVATED';
  if (rows.some((row) => row.outcome === 'UNAVAILABLE' || row.outcome === 'MANUAL_REQUIRED'))
    return 'LOW';
  return 'NONE';
}

/** Run every provider and signal, and write one row per result. */
export async function runChecks(
  companyId: string,
  caseId: string | null,
  actor: Actor = SYSTEM_ACTOR,
): Promise<{ rows: number; riskLevel: string }> {
  const company = await prisma.buyerCompany.findUniqueOrThrow({
    where: { id: companyId },
    include: SIGNAL_INCLUDE,
  });

  const subject = subjectOf(company);
  const rows: Row[] = [];

  for (const provider of VERIFICATION_PROVIDERS) {
    if (!provider.appliesTo(subject)) continue;
    try {
      for (const result of await provider.check(subject))
        rows.push({ ...result, provider: provider.key });
    } catch (error) {
      // A provider is written never to throw. If one does anyway, that is a
      // bug here, not a verdict about the company.
      logger.error({ err: error, provider: provider.key }, 'verification provider threw');
      rows.push({
        provider: provider.key,
        subject: 'PROVIDER',
        outcome: 'UNAVAILABLE',
        summary: `${provider.label} failed unexpectedly. Check by hand.`,
        request: {},
      });
    }
  }

  rows.push(...ruleSignals(company, subject));
  rows.push(...(await duplicateSignals(company)));
  rows.push(...(await sellerAccountSignals(company)));

  const riskLevel = riskLevelFor(rows);

  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      await tx.buyerCompanyCheck.create({
        data: {
          id: newId(),
          companyId,
          caseId,
          provider: row.provider,
          subject: row.subject.slice(0, 48),
          outcome: row.outcome,
          summary: row.summary.slice(0, 500),
          requestJson: row.request,
          ...(row.result !== undefined && row.result !== null
            ? { resultJson: row.result as Prisma.InputJsonValue }
            : {}),
          sourceReference: row.sourceReference?.slice(0, 128) ?? null,
          sourceUrl: row.sourceUrl?.slice(0, 512) ?? null,
          triggeredByUserId: actor.userId,
        },
      });
    }

    await tx.buyerCompany.update({ where: { id: companyId }, data: { riskLevel } });

    if (caseId !== null && secondReviewRequired(riskLevel)) {
      await tx.buyerCompanyVerificationCase.update({
        where: { id: caseId },
        data: { requiresSecondReview: true },
      });
    }

    await writeEvent(tx, {
      companyId,
      caseId,
      kind: 'CHECKS_RUN',
      visibility: 'INTERNAL',
      actor,
      data: {
        riskLevel,
        outcomes: rows.reduce<Record<string, number>>((counts, row) => {
          counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
          return counts;
        }, {}),
      },
    });

    await recordAudit(
      {
        action: AuditAction.BUYER_COMPANY_CHECKS_RUN,
        resourceType: 'buyer_company',
        resourceId: companyId,
        actorType: actor.type,
        actorUserId: actor.userId,
        after: { rows: rows.length, riskLevel },
      },
      tx,
    );
  });

  return { rows: rows.length, riskLevel };
}

export function secondReviewRequired(riskLevel: string): boolean {
  const threshold = env.BUYER_COMPANY_SECOND_REVIEW_RISK;
  if (threshold === 'OFF') return false;
  if (threshold === 'HIGH') return riskLevel === 'HIGH';
  return riskLevel === 'HIGH' || riskLevel === 'ELEVATED';
}

/**
 * The job: SUBMITTED/RESUBMITTED -> AUTOMATED_CHECK_IN_PROGRESS -> checks ->
 * UNDER_REVIEW. A reviewer who already opened the case by hand (it is
 * UNDER_REVIEW) still gets the checks, with no status change.
 */
export async function runAutomatedChecksJob(
  companyId: string,
  caseId: string | null,
): Promise<void> {
  const company = await prisma.buyerCompany.findUnique({
    where: { id: companyId },
    select: { status: true },
  });
  if (company === null) return;

  const startedFrom = company.status;
  if (startedFrom === 'SUBMITTED' || startedFrom === 'RESUBMITTED') {
    await prisma.$transaction(async (tx: Tx) => {
      await transitionCompany(tx, {
        companyId,
        to: 'AUTOMATED_CHECK_IN_PROGRESS',
        actor: SYSTEM_ACTOR,
        as: 'SYSTEM',
      });
    });
  } else if (startedFrom !== 'UNDER_REVIEW' && startedFrom !== 'AUTOMATED_CHECK_IN_PROGRESS') {
    // Withdrawn or decided while the job waited. Nothing to do.
    return;
  }

  try {
    await runChecks(companyId, caseId);
  } finally {
    // Whatever happened above - every provider down, a bug - the application
    // goes to a person. It must never sit in AUTOMATED_CHECK_IN_PROGRESS.
    const now = await prisma.buyerCompany.findUnique({
      where: { id: companyId },
      select: { status: true },
    });
    if (now?.status === 'AUTOMATED_CHECK_IN_PROGRESS') {
      await prisma.$transaction(async (tx: Tx) => {
        await transitionCompany(tx, {
          companyId,
          to: 'UNDER_REVIEW',
          actor: SYSTEM_ACTOR,
          as: 'SYSTEM',
        });
      });
    }
  }
}

/** For the reviewer's "re-run checks" button - the same identifiers, fresh answers. */
export function normaliseForCheck(value: string): string {
  return normaliseIdentifier(value);
}
