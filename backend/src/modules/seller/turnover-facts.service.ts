/**
 * What the seller turnover policy says about one seller, read from the
 * database, and the one function that stores a declaration. No import of the
 * onboarding or account services, so the onboarding checklist and
 * `startSellerApplication` can both use it without a cycle - the same split as
 * `kyb-facts.service.ts`.
 *
 * The rule itself is `domain/seller-turnover.ts`. The settings are
 * `SELLER_TURNOVER_*`, read on every call rather than captured at import, so
 * one deployment changing them needs a restart and nothing else.
 */
import { env } from '../../config/env.js';
import { currencyExponent } from '../../domain/money.js';
import { ErrorCode, conflict, type ErrorDetail } from '../../domain/errors.js';
import {
  isoDate,
  mostRecentFinancialYear,
  turnoverStanding,
  type TurnoverStanding,
} from '../../domain/seller-turnover.js';
import type { SellerVerificationState } from '../../generated/prisma/enums.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

/** The requirement key turnover evidence is uploaded against. */
export const TURNOVER_EVIDENCE_FIELD_KEY = 'annual_turnover_evidence';

export interface TurnoverPolicy {
  required: boolean;
  minimumMinor: bigint;
  currency: string;
  policyVersion: string;
  financialYearStartMonth: number;
}

export function turnoverPolicy(): TurnoverPolicy {
  return {
    required: env.SELLER_TURNOVER_REQUIRED,
    minimumMinor: BigInt(env.SELLER_TURNOVER_MIN_MINOR),
    currency: env.SELLER_TURNOVER_CURRENCY,
    policyVersion: env.SELLER_TURNOVER_POLICY_VERSION,
    financialYearStartMonth: env.SELLER_TURNOVER_FY_START_MONTH,
  };
}

/** The policy as it crosses the wire: money as a string of minor units. */
export interface TurnoverPolicyView {
  required: boolean;
  minimumMinor: string;
  currency: string;
  currencyExponent: number;
  policyVersion: string;
  financialYearStartMonth: number;
  /** The most recently completed year with the usual start month, for the form's default. */
  suggestedFinancialYear: { start: string; end: string };
}

export function turnoverPolicyView(today: Date = new Date()): TurnoverPolicyView {
  const policy = turnoverPolicy();
  return {
    required: policy.required,
    minimumMinor: policy.minimumMinor.toString(),
    currency: policy.currency,
    currencyExponent: currencyExponent(policy.currency),
    policyVersion: policy.policyVersion,
    financialYearStartMonth: policy.financialYearStartMonth,
    suggestedFinancialYear: mostRecentFinancialYear(policy.financialYearStartMonth, today),
  };
}

export interface TurnoverFacts {
  /** False when the rule is off, or the seller was approved before it existed. */
  applies: boolean;
  /** Approved at some point before - the rule is not applied retrospectively. */
  grandfathered: boolean;
  standing: TurnoverStanding;
  current: Awaited<ReturnType<typeof currentDeclaration>>;
}

export async function currentDeclaration(sellerAccountId: string) {
  return prisma.sellerTurnoverDeclaration.findFirst({
    where: { sellerAccountId, isCurrent: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/**
 * Where one seller stands against the policy today.
 *
 * `grandfathered` is any seller that has ever been approved. The rule applies
 * to applications - new ones, and in-progress ones when they are submitted -
 * and does not reach back to take selling away from a business the
 * marketplace already accepted. A retrospective policy is the operator's
 * decision to make separately, not a side effect of this one.
 */
export async function turnoverFactsFor(
  sellerAccountId: string,
  today: Date = new Date(),
): Promise<TurnoverFacts> {
  const policy = turnoverPolicy();
  const [account, current] = await Promise.all([
    prisma.sellerAccount.findUnique({ where: { id: sellerAccountId }, select: { approvedAt: true } }),
    currentDeclaration(sellerAccountId),
  ]);

  const grandfathered = account?.approvedAt !== null && account?.approvedAt !== undefined;
  const standing = turnoverStanding(current, policy, today);

  return { applies: policy.required && !grandfathered, grandfathered, standing, current };
}

/**
 * What the business-identity step still needs because of the policy, in the
 * checklist's words. Empty when the rule does not apply or is met.
 */
export async function turnoverGapsFor(sellerAccountId: string): Promise<string[]> {
  const facts = await turnoverFactsFor(sellerAccountId);
  if (!facts.applies) return [];

  switch (facts.standing) {
    case 'ELIGIBLE':
      return [];
    case 'NOT_DECLARED':
      return ['Annual turnover and financial year'];
    case 'OUT_OF_DATE':
      return ['Annual turnover for your most recently completed financial year'];
    case 'BELOW_MINIMUM':
      return ['Annual turnover above the seller minimum'];
  }
}

export function notEligible(standing: Exclude<TurnoverStanding, 'ELIGIBLE'>): never {
  const policy = turnoverPolicy();
  throw conflict(
    ErrorCode.SELLER_TURNOVER_NOT_ELIGIBLE,
    standing === 'NOT_DECLARED'
      ? 'Declare your annual turnover before applying.'
      : standing === 'OUT_OF_DATE'
        ? 'Declare your turnover for your most recently completed financial year.'
        : 'Your business does not currently meet the seller turnover requirement.',
    [
      {
        field: 'amountMinor',
        code: standing,
        meta: { minimumMinor: policy.minimumMinor.toString(), currency: policy.currency },
      },
    ],
  );
}

/**
 * The submit gate. Called by `submitApplication` for every submission and
 * resubmission, so the route a client uses makes no difference.
 */
export async function assertTurnoverEligibleForSubmission(sellerAccountId: string): Promise<void> {
  const facts = await turnoverFactsFor(sellerAccountId);
  if (!facts.applies) return;
  if (facts.standing !== 'ELIGIBLE') notEligible(facts.standing);
}

/**
 * What approval is still waiting for under the policy. The declaration alone
 * is never enough: a reviewer has to have verified the figure.
 */
export async function turnoverApprovalGaps(sellerAccountId: string): Promise<ErrorDetail[]> {
  const facts = await turnoverFactsFor(sellerAccountId);
  if (!facts.applies) return [];

  if (facts.standing === 'NOT_DECLARED') {
    return [{ code: 'TURNOVER_NOT_DECLARED', field: 'turnover', message: 'No annual turnover has been declared.' }];
  }
  if (facts.standing !== 'ELIGIBLE') {
    return [
      {
        code: 'TURNOVER_NOT_ELIGIBLE',
        field: 'turnover',
        message:
          facts.standing === 'OUT_OF_DATE'
            ? 'The declared turnover is not for the most recently completed financial year.'
            : 'The declared turnover does not exceed the seller minimum.',
      },
    ];
  }
  if (facts.current?.verificationState !== 'VERIFIED') {
    return [{ code: 'TURNOVER_NOT_VERIFIED', field: 'turnover', message: 'The declared turnover has not been verified.' }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Storing a declaration
//
// Here rather than in `turnover.service.ts` because `startSellerApplication`
// stores the first declaration in the same transaction that creates the
// seller, and the account service cannot import a service that imports it.
// ---------------------------------------------------------------------------

export interface ParsedTurnover {
  amountMinor: bigint;
  currency: string;
  financialYearStart: Date;
  financialYearEnd: Date;
}

async function hasLiveEvidence(sellerAccountId: string, tx: PrismaTransaction): Promise<boolean> {
  const count = await tx.sellerDocument.count({
    where: { sellerAccountId, requirementFieldKey: TURNOVER_EVIDENCE_FIELD_KEY, supersededAt: null },
  });
  return count > 0;
}

/** Waiting for a reviewer when there is something to review, otherwise for the seller. */
export async function pendingStateFor(sellerAccountId: string, tx: PrismaTransaction): Promise<SellerVerificationState> {
  return (await hasLiveEvidence(sellerAccountId, tx)) ? 'IN_PROGRESS' : 'AWAITING_INPUT';
}

export interface RecordDeclarationInput {
  sellerAccountId: string;
  declaredByProfileId: string | null;
  parsed: ParsedTurnover;
  tx: PrismaTransaction;
}

/**
 * Store a declaration. The same figures for the same year keep the current
 * row - and its verification - and only refresh the declaration time and the
 * policy version. Different figures or a different year end the current row
 * (`AMENDED`) and start a new one that needs review again.
 */
export async function recordTurnoverDeclaration(input: RecordDeclarationInput): Promise<{ id: string; changed: boolean }> {
  const { tx, parsed } = input;
  const policy = turnoverPolicy();
  const now = new Date();

  const current = await tx.sellerTurnoverDeclaration.findFirst({
    where: { sellerAccountId: input.sellerAccountId, isCurrent: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });

  const same =
    current !== null &&
    current.amountMinor === parsed.amountMinor &&
    current.currency === parsed.currency &&
    isoDate(current.financialYearStart) === isoDate(parsed.financialYearStart) &&
    isoDate(current.financialYearEnd) === isoDate(parsed.financialYearEnd);

  if (same) {
    await tx.sellerTurnoverDeclaration.update({
      where: { id: current.id },
      data: {
        declaredAt: now,
        declaredByProfileId: input.declaredByProfileId,
        policyVersion: policy.policyVersion,
        minimumMinor: policy.minimumMinor,
      },
    });
    return { id: current.id, changed: false };
  }

  await tx.sellerTurnoverDeclaration.updateMany({
    where: { sellerAccountId: input.sellerAccountId, isCurrent: true },
    data: { isCurrent: false, supersededReason: 'AMENDED' },
  });

  const id = newId();
  await tx.sellerTurnoverDeclaration.create({
    data: {
      id,
      sellerAccountId: input.sellerAccountId,
      amountMinor: parsed.amountMinor,
      currency: parsed.currency,
      financialYearStart: parsed.financialYearStart,
      financialYearEnd: parsed.financialYearEnd,
      minimumMinor: policy.minimumMinor,
      policyVersion: policy.policyVersion,
      declaredAt: now,
      declaredByProfileId: input.declaredByProfileId,
      verificationState: await pendingStateFor(input.sellerAccountId, tx),
      isCurrent: true,
    },
  });
  return { id, changed: true };
}

