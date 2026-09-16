/**
 * Guided seller onboarding: the steps, what each needs, and how far along one
 * seller is.
 *
 * The step LIST is code, because the shape of the journey is the product. What
 * each step DEMANDS is data - `SellerOnboardingRequirement` rows keyed by
 * country - because the brief is emphatic about it and it is the difference
 * between a marketplace and an Indian marketplace: a deployment in Germany
 * needs a VAT number and an EORI, one in India needs a GSTIN, and hard-coding
 * either makes the other impossible.
 *
 * Progress is computed here and stored on `SellerOnboardingProgress`, not
 * derived in the browser. The wizard shows a percentage and the dashboard shows
 * the same percentage on a page that loads none of the underlying rows; two
 * implementations of "how far along" is how those two numbers disagree.
 */
import type { SellerKind } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import {
  assertApplicationEditable,
  assertSellerPermission,
  transitionApplication,
  type SellerMembership,
} from './account.service.js';

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

export const ONBOARDING_STEPS = [
  'account_verification',
  'business_identity',
  'kyb_kyc',
  'store_profile',
  'locations',
  'payout',
  'compliance',
  'agreements',
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];

export type OnboardingStepState =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETE'
  | 'ERROR'
  | 'UNDER_REVIEW';

interface StepDefinition {
  key: OnboardingStepKey;
  title: string;
  summary: string;
  /**
   * Whether the application can be submitted without it.
   *
   * `payout` is the interesting one: it is NOT required to submit. A seller
   * whose deployment has no payout provider configured would otherwise be
   * unable to finish an application at all - see
   * `SELLER_PAYOUT_PROVIDER_UNCONFIGURED` - and blocking them on a provider the
   * operator has not set up is blocking them on somebody else's task. It is
   * required before a payout can actually be sent, which is where it belongs.
   */
  isRequiredForSubmission: boolean;
}

export const STEP_DEFINITIONS: readonly StepDefinition[] = Object.freeze([
  {
    key: 'account_verification',
    title: 'Contact verification',
    summary: 'Confirm the email address and mobile number we will reach you on.',
    isRequiredForSubmission: true,
  },
  {
    key: 'business_identity',
    title: 'Business identity',
    summary: 'The registered name, country, registration number and tax details.',
    isRequiredForSubmission: true,
  },
  {
    key: 'kyb_kyc',
    title: 'Identity and documents',
    summary: 'Who represents the business, and the documents that prove it exists.',
    isRequiredForSubmission: true,
  },
  {
    key: 'store_profile',
    title: 'Store details',
    summary: 'The name buyers see, your logo, and how they reach your support desk.',
    isRequiredForSubmission: true,
  },
  {
    key: 'locations',
    title: 'Pickup and returns',
    summary: 'Where orders are dispatched from and where returns go back to.',
    isRequiredForSubmission: true,
  },
  {
    key: 'payout',
    title: 'Payout account',
    summary: 'Where the marketplace sends the money you earn.',
    isRequiredForSubmission: false,
  },
  {
    key: 'compliance',
    title: 'Compliance',
    summary: 'Any certificates or declarations the things you sell need.',
    // Not required to submit. The marketplace is general - a seller of
    // packaging has no quality certificate and never will - so what this step
    // asks for is per country and per seller kind, and is empty for most
    // sellers. Where a deployment does regulate a trade, it marks those
    // requirements required and this step blocks submission on its own.
    isRequiredForSubmission: false,
  },
  {
    key: 'agreements',
    title: 'Agreements',
    summary: 'The marketplace agreement, the commission schedule and the returns policy.',
    isRequiredForSubmission: true,
  },
]);

const STEP_BY_KEY = new Map<string, StepDefinition>(
  STEP_DEFINITIONS.map((step) => [step.key, step]),
);

export function isOnboardingStep(value: string): value is OnboardingStepKey {
  return STEP_BY_KEY.has(value);
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

export interface RequirementView {
  fieldKey: string;
  stepKey: OnboardingStepKey;
  label: string;
  helpText: string | null;
  isRequired: boolean;
  isDocument: boolean;
  /** Sent so the form can say the same thing sooner. Never trusted. */
  validationPattern: string | null;
}

/**
 * Which fields this seller's country and kind demand.
 *
 * Country-specific rows override the global ones with the same field key, and
 * they override rather than add for a reason: a deployment that needs "tax
 * number" everywhere and "GSTIN, 15 characters, this pattern" in India should
 * express the second as a replacement, not have the seller asked twice.
 */
export async function requirementsFor(
  countryCode: string,
  kind: SellerKind,
): Promise<RequirementView[]> {
  const rows = await prisma.sellerOnboardingRequirement.findMany({
    where: {
      countryKey: { in: ['*', countryCode.toUpperCase()] },
      OR: [{ appliesToKind: null }, { appliesToKind: kind }],
    },
    orderBy: [{ sortOrder: 'asc' }, { fieldKey: 'asc' }],
  });

  const byField = new Map<string, RequirementView>();

  for (const row of rows) {
    if (!isOnboardingStep(row.stepKey)) continue;

    const view: RequirementView = {
      fieldKey: row.fieldKey,
      stepKey: row.stepKey,
      label: row.label,
      helpText: row.helpText,
      isRequired: row.isRequired,
      isDocument: row.isDocument,
      validationPattern: row.validationPattern,
    };

    const existing = byField.get(row.fieldKey);

    // A country row wins over a global one. Rows arrive with '*' before a
    // country code only by luck of the sort, so the check is explicit.
    if (existing === undefined || row.countryKey !== '*') {
      byField.set(row.fieldKey, view);
    }
  }

  return [...byField.values()];
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

interface StoredStep {
  state: OnboardingStepState;
  updatedAt: string;
  message?: string | null;
}

export interface StepView {
  key: OnboardingStepKey;
  title: string;
  summary: string;
  state: OnboardingStepState;
  isRequiredForSubmission: boolean;
  message: string | null;
  requirements: RequirementView[];
}

export interface OnboardingView {
  steps: StepView[];
  completedSteps: number;
  requiredSteps: number;
  /** 0-100, for the progress bar. */
  percentComplete: number;
  lastStepKey: OnboardingStepKey | null;
  /** Every required step is complete and the application can be submitted. */
  canSubmit: boolean;
  /** Which required steps are still outstanding, for the blocked-submit note. */
  blockingSteps: { key: OnboardingStepKey; title: string }[];
}

function parseSteps(value: unknown): Record<string, StoredStep> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, StoredStep>;
}

/**
 * The two steps nothing else marks.
 *
 * `account_verification` and `store_profile` have no requirement rows of their
 * own - what they ask for is already stored elsewhere, on the user and on the
 * seller account - so nothing was ever marking them and a seller could finish
 * the whole application and still be refused at submission with no way to see
 * why.
 *
 * Derived on every read rather than written by a form, which is also more
 * honest: a seller who changes their email address in their account settings
 * un-verifies it, and this step follows that without anybody remembering to
 * clear a flag.
 */
async function deriveStandingSteps(membership: SellerMembership): Promise<void> {
  const [profile, account] = await Promise.all([
    prisma.customerProfile.findUnique({
      where: { id: membership.customerProfileId },
      select: { user: { select: { emailVerifiedAt: true, phoneVerifiedAt: true, phone: true } } },
    }),
    prisma.sellerAccount.findUnique({
      where: { id: membership.sellerAccountId },
      select: {
        description: true,
        businessProfile: { select: { supportEmail: true, supportPhone: true } },
      },
    }),
  ]);

  // --- Contact verification ------------------------------------------------
  //
  // Email is required; a mobile number is only required once one has been
  // given. A deployment that never collects phone numbers must not leave every
  // seller stuck on a step about a field they were never shown.
  const user = profile?.user ?? null;
  const emailVerified = user?.emailVerifiedAt !== null && user?.emailVerifiedAt !== undefined;
  const hasPhone = typeof user?.phone === 'string' && user.phone.length > 0;
  const phoneVerified = user?.phoneVerifiedAt !== null && user?.phoneVerifiedAt !== undefined;

  const contactOutstanding: string[] = [];
  if (!emailVerified) contactOutstanding.push('Confirm your email address');
  if (hasPhone && !phoneVerified) contactOutstanding.push('Confirm your mobile number');

  await markStep({
    membership,
    stepKey: 'account_verification',
    state: contactOutstanding.length === 0 ? 'COMPLETE' : 'IN_PROGRESS',
    message: contactOutstanding.length === 0 ? null : contactOutstanding.join('. ') + '.',
    // Derived on a read, not done by the seller - see `isResumePoint`.
    isResumePoint: false,
  });

  // --- Store details -------------------------------------------------------

  await markStoreProfileStep({
    membership,
    description: account?.description,
    supportEmail: account?.businessProfile?.supportEmail,
    isResumePoint: false,
  });

  /*
   * --- The requirement steps ------------------------------------------------
   *
   * Derived here too, for the same reason as the two above: what a step is
   * waiting for can change without the seller touching it. An operator accepts
   * a certificate, or refuses one, or a certificate simply expires - and all
   * three happen outside any request the seller makes.
   *
   * It also makes the checklist honest on a first visit. Without it, a seller
   * who has filled in nothing sees "Not started" against a step that is in fact
   * waiting on two named documents, which is the least useful thing it could
   * say.
   */
  await markRequirementSteps({
    sellerAccountId: membership.sellerAccountId,
    registrationCountry: membership.registrationCountry,
  });
}

/**
 * Decide whether the store details step is finished, and record the answer.
 *
 * The public shop name is chosen when the application starts, so the only
 * things outstanding here are what a buyer needs in order to reach the seller
 * about an order they have placed.
 *
 * One implementation with two callers on purpose. The derive above runs on
 * every read of the application; the save behind the form calls it too, so the
 * seller is told what is still missing in the same words the moment they press
 * the button, instead of being left to work out why the tick never appeared.
 */
async function markStoreProfileStep(input: {
  membership: SellerMembership;
  description: string | null | undefined;
  supportEmail: string | null | undefined;
  isResumePoint: boolean;
  correlationId?: string | null;
}): Promise<{ state: OnboardingStepState; missing: string[] }> {
  const missing: string[] = [];

  if ((input.description ?? '').trim().length === 0) {
    missing.push('A description of your business');
  }
  if ((input.supportEmail ?? '').trim().length === 0) {
    missing.push('A support email address');
  }

  const state: OnboardingStepState = missing.length === 0 ? 'COMPLETE' : 'IN_PROGRESS';

  await markStep({
    membership: input.membership,
    stepKey: 'store_profile',
    state,
    message: missing.length === 0 ? null : `Still needed: ${missing.join(', ')}.`,
    isResumePoint: input.isResumePoint,
    correlationId: input.correlationId ?? null,
  });

  return { state, missing };
}

/** Everything the onboarding screen and the dashboard progress bar need. */
export async function readOnboarding(membership: SellerMembership): Promise<OnboardingView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_READ);

  // Before the read, not after: the submit gate calls this too, so a step
  // derived here is a step the gate has already seen.
  await deriveStandingSteps(membership);

  const [progress, account] = await Promise.all([
    prisma.sellerOnboardingProgress.findUnique({
      where: { sellerAccountId: membership.sellerAccountId },
    }),
    prisma.sellerAccount.findUnique({
      where: { id: membership.sellerAccountId },
      select: { kind: true, registrationCountry: true },
    }),
  ]);

  const stored = parseSteps(progress?.stepsJson ?? null);
  const requirements = await requirementsFor(
    account?.registrationCountry ?? membership.registrationCountry,
    account?.kind ?? 'RESELLER',
  );

  const steps: StepView[] = STEP_DEFINITIONS.map((definition) => {
    const entry = stored[definition.key];
    const mine = requirements.filter((requirement) => requirement.stepKey === definition.key);

    return {
      key: definition.key,
      title: definition.title,
      summary: definition.summary,
      state: entry?.state ?? 'NOT_STARTED',
      /*
       * A step is required if the journey says so, OR if this deployment has
       * made anything on it required.
       *
       * The second half is what makes Compliance work as designed. Nothing on
       * it is required by default - a seller of packaging has no ISO
       * certificate and never will - and an operator who regulates a trade
       * turns a row required in a table. Without this, that edit would change
       * what the step ASKS for and not whether it has to be answered, which is
       * a requirement in name only.
       */
      isRequiredForSubmission:
        definition.isRequiredForSubmission || mine.some((requirement) => requirement.isRequired),
      message: entry?.message ?? null,
      requirements: mine,
    };
  });

  /*
   * What counts as "done" for the submit gate.
   *
   * COMPLETE or UNDER_REVIEW, and the second one is not a loophole - it is the
   * only thing that stops a deadlock. UNDER_REVIEW means "everything was
   * supplied and a document is with the marketplace", and the marketplace
   * reviews documents as part of reviewing the APPLICATION. Blocking submission
   * on a state only the reviewer can move, when the reviewer only looks after
   * submission, is a seller who can never submit and an operator who never sees
   * why.
   *
   * What is still refused is the thing the seller can actually fix: a missing
   * certificate, or one that was sent back.
   */
  const isSettled = (state: OnboardingStepState): boolean =>
    state === 'COMPLETE' || state === 'UNDER_REVIEW';

  const required = steps.filter((step) => step.isRequiredForSubmission);
  const blocking = required.filter((step) => !isSettled(step.state));
  const completedRequired = required.length - blocking.length;

  return {
    steps,
    completedSteps: steps.filter((step) => isSettled(step.state)).length,
    requiredSteps: required.length,
    // Out of the REQUIRED steps, not out of all of them. A seller who has
    // finished everything they must do should see 100%, not 87% because they
    // have not connected a payout account the operator has not configured -
    // and for the same reason, waiting on somebody else's review counts as
    // done: it is not work they still owe.
    percentComplete:
      required.length === 0 ? 100 : Math.round((completedRequired / required.length) * 100),
    lastStepKey:
      progress?.lastStepKey !== null && progress?.lastStepKey !== undefined && isOnboardingStep(progress.lastStepKey)
        ? progress.lastStepKey
        : null,
    canSubmit: blocking.length === 0,
    blockingSteps: blocking.map((step) => ({ key: step.key, title: step.title })),
  };
}

/**
 * Everything `markStep` actually reads.
 *
 * Narrower than a `SellerMembership` on purpose, and a full membership still
 * satisfies it. The marks that follow an OPERATOR's decision - a certificate
 * accepted or refused - have no membership to pass, because the person who made
 * the decision is not a member of the seller's organisation. Widening the
 * parameter is honest about that; casting a half-built object to
 * `SellerMembership` at those call sites would not be.
 */
export type StepSubject = Pick<SellerMembership, 'sellerAccountId'>;

export interface MarkStepInput {
  membership: StepSubject;
  stepKey: OnboardingStepKey;
  state: OnboardingStepState;
  message?: string | null;
  correlationId?: string | null;
  tx?: PrismaTransaction;
  /**
   * Whether this mark is where the seller left off.
   *
   * Defaults to true, because almost every mark follows something the seller
   * just saved. The two standing steps are the exception: they are re-derived
   * on every READ of the application, and writing the bookmark from there
   * moved it on every page load - so "carry on where you were" always landed
   * on Store details, whatever the seller had actually been working on, and
   * the application never opened where it begins.
   */
  isResumePoint?: boolean;
}

/**
 * Record that one step has moved, and recompute the counters.
 *
 * Called by whichever service actually saved the underlying data - the
 * business profile service marks `business_identity`, the location service
 * marks `locations`. Deliberately not a route of its own that a client could
 * call: a seller who could POST "store_profile is complete" could submit an
 * application with nothing in it.
 */
export async function markStep(input: MarkStepInput): Promise<void> {
  const run = async (tx: PrismaTransaction): Promise<void> => {
    const progress = await tx.sellerOnboardingProgress.findUnique({
      where: { sellerAccountId: input.membership.sellerAccountId },
    });

    const steps = parseSteps(progress?.stepsJson ?? null);

    steps[input.stepKey] = {
      state: input.state,
      updatedAt: new Date().toISOString(),
      message: input.message ?? null,
    };

    const completed = STEP_DEFINITIONS.filter(
      (definition) => steps[definition.key]?.state === 'COMPLETE',
    ).length;
    const requiredTotal = STEP_DEFINITIONS.filter(
      (definition) => definition.isRequiredForSubmission,
    ).length;

    const data = {
      stepsJson: steps as never,
      completedSteps: completed,
      requiredSteps: requiredTotal,
      ...(input.isResumePoint === false ? {} : { lastStepKey: input.stepKey }),
    };

    if (progress === null) {
      await tx.sellerOnboardingProgress.create({
        data: { id: newId(), sellerAccountId: input.membership.sellerAccountId, ...data },
      });
      return;
    }

    await tx.sellerOnboardingProgress.update({ where: { id: progress.id }, data });
  };

  if (input.tx !== undefined) {
    await run(input.tx);
    return;
  }

  await prisma.$transaction(run);
}

// ---------------------------------------------------------------------------
// The business profile
// ---------------------------------------------------------------------------

export interface BusinessProfilePatch {
  representativeName?: string | null;
  representativeEmail?: string | null;
  representativePhone?: string | null;
  representativeRole?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  preferredLanguage?: string | null;
  timezone?: string | null;
  companyRegistrationNumber?: string | null;
  taxRegistrationNumber?: string | null;
  eoriNumber?: string | null;
  eudamedSrn?: string | null;
  websiteUrl?: string | null;
  yearsInBusiness?: number | null;
  registeredAddressLine1?: string | null;
  registeredAddressLine2?: string | null;
  registeredCity?: string | null;
  registeredRegion?: string | null;
  registeredPostcode?: string | null;
  registeredCountry?: string | null;
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingCity?: string | null;
  billingRegion?: string | null;
  billingPostcode?: string | null;
  billingCountry?: string | null;
  extraIdentifiers?: Record<string, string> | null;
}

/**
 * Which requirement fields this profile answers, mapped to their columns.
 *
 * The map is here rather than in the requirement rows because a requirement
 * describes what to ASK for; where the answer is stored is a fact about this
 * schema. A requirement whose field key is not in this map is answered by a
 * document upload instead, and `isDocument` on the row says so.
 */
const REQUIREMENT_COLUMNS: Readonly<Record<string, keyof BusinessProfilePatch>> = Object.freeze({
  company_registration_number: 'companyRegistrationNumber',
  tax_registration_number: 'taxRegistrationNumber',
  eori_number: 'eoriNumber',
  eudamed_srn: 'eudamedSrn',
  representative_name: 'representativeName',
  representative_email: 'representativeEmail',
  representative_phone: 'representativePhone',
  website_url: 'websiteUrl',
  registered_address: 'registeredAddressLine1',
});

/**
 * Save the business identity step and re-evaluate whether it is finished.
 *
 * The completeness check runs against the country's own requirement rows, so
 * the same seller moving from RESELLER to MANUFACTURER can drop back to
 * IN_PROGRESS without anybody writing a special case for it.
 */
/**
 * Whose steps are being re-evaluated.
 *
 * Not a `SellerMembership`, because the OPERATOR who accepts or refuses a
 * certificate has none - they are not a member of the seller's organisation,
 * and their decision still has to move the seller's checklist. The country is
 * carried because a brand-new account may not have one stored yet.
 */
export interface RequirementStepSubject {
  sellerAccountId: string;
  registrationCountry: string;
}

/** What one step is still waiting for. */
export interface StepOutcome {
  /** Labels of the requirements with no acceptable answer at all. */
  missing: string[];
  /** Documents uploaded and not yet decided by the marketplace. */
  waitingOnReview: string[];
}

/**
 * Work out what every requirement-driven step is still waiting for, and record
 * it.
 *
 * ONE implementation, with three callers: the business-identity form, a
 * document upload, and an operator's decision about a document. That is the
 * point of it existing. Before this, typed fields were judged here and
 * documents were not judged at all, so a deployment that required a business
 * registration certificate let a seller tick `kyb_kyc` by typing two fields and
 * uploading nothing - and once documents WERE judged, two functions marking the
 * same step from two directions would have flapped between them on every save.
 *
 * The three states a step can land in, and what each means to the seller:
 *
 *   - `IN_PROGRESS` - something is missing and it is theirs to supply. The
 *     message names it.
 *   - `UNDER_REVIEW` - everything has been supplied and at least one document
 *     is with the marketplace. Nothing for them to do but wait, and the step
 *     says so rather than looking unfinished.
 *   - `COMPLETE` - every required answer is in and every required document has
 *     been accepted.
 *
 * A document that has EXPIRED does not count as accepted. A certificate that
 * ran out in March is not evidence in April, and the seller finding that out
 * from their own checklist is better than finding out from a refusal.
 */
export async function markRequirementSteps(
  subject: RequirementStepSubject,
  correlationId?: string | null,
): Promise<Map<OnboardingStepKey, StepOutcome>> {
  const account = await prisma.sellerAccount.findUnique({
    where: { id: subject.sellerAccountId },
    select: { kind: true, registrationCountry: true },
  });

  const requirements = await requirementsFor(
    account?.registrationCountry ?? subject.registrationCountry,
    account?.kind ?? 'RESELLER',
  );

  const [profile, documents] = await Promise.all([
    prisma.sellerBusinessProfile.findUnique({ where: { sellerAccountId: subject.sellerAccountId } }),
    prisma.sellerDocument.findMany({
      where: { sellerAccountId: subject.sellerAccountId, supersededAt: null },
      select: {
        requirementFieldKey: true,
        approvedAt: true,
        rejectedReason: true,
        expiresOn: true,
      },
    }),
  ]);

  /** Country-specific answers, keyed by the requirement that asked for them. */
  const extras = (profile?.extraIdentifiersJson ?? {}) as Record<string, unknown>;
  const stored = profile as unknown as Record<string, unknown> | null;
  const now = Date.now();

  const byStep = new Map<OnboardingStepKey, StepOutcome>();

  for (const requirement of requirements) {
    // Every step that ASKS for anything gets an entry, so a step whose only
    // requirement is optional is still marked complete rather than left at
    // NOT_STARTED forever.
    const outcome = byStep.get(requirement.stepKey) ?? { missing: [], waitingOnReview: [] };
    byStep.set(requirement.stepKey, outcome);

    if (!requirement.isRequired) continue;

    if (requirement.isDocument) {
      const answers = documents.filter(
        (document) => document.requirementFieldKey === requirement.fieldKey,
      );

      const accepted = answers.some(
        (document) =>
          document.approvedAt !== null &&
          (document.expiresOn === null || document.expiresOn.getTime() >= now),
      );

      if (accepted) continue;

      const waiting = answers.some(
        (document) => document.approvedAt === null && document.rejectedReason === null,
      );

      if (waiting) outcome.waitingOnReview.push(requirement.label);
      else outcome.missing.push(requirement.label);

      continue;
    }

    const column = REQUIREMENT_COLUMNS[requirement.fieldKey];
    const value =
      column === undefined ? extras[requirement.fieldKey] : (stored?.[column] ?? null);

    const text = typeof value === 'string' ? value.trim() : '';

    if (text.length === 0) {
      outcome.missing.push(requirement.label);
      continue;
    }

    // An answer in the wrong format is not an answer, and letting it through
    // means the moderator finds it instead of the seller.
    if (
      requirement.validationPattern !== null &&
      requirement.validationPattern !== undefined &&
      requirement.validationPattern.length > 0
    ) {
      try {
        if (!new RegExp(requirement.validationPattern).test(text)) {
          outcome.missing.push(requirement.label);
        }
      } catch {
        // A broken pattern is an operator's mistake. Refusing the seller for it
        // would block them on something nobody on that screen can fix.
      }
    }
  }

  for (const [stepKey, outcome] of byStep) {
    await markStep({
      membership: subject,
      stepKey,
      state:
        outcome.missing.length > 0
          ? 'IN_PROGRESS'
          : outcome.waitingOnReview.length > 0
            ? 'UNDER_REVIEW'
            : 'COMPLETE',
      message:
        outcome.missing.length > 0
          ? `Still needed: ${outcome.missing.join(', ')}.`
          : outcome.waitingOnReview.length > 0
            ? `We are checking what you uploaded: ${outcome.waitingOnReview.join(', ')}.`
            : null,
      // Not a bookmark. This runs on an upload, on a save and on somebody
      // else's decision, and moving "carry on where you were" from any of those
      // is how the application stopped opening where the seller left it.
      isResumePoint: false,
      correlationId: correlationId ?? null,
    });
  }

  return byStep;
}

export async function saveBusinessProfile(
  membership: SellerMembership,
  patch: BusinessProfilePatch,
  correlationId?: string | null,
): Promise<{ state: OnboardingStepState; missing: string[] }> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  assertApplicationEditable(membership);

  const { extraIdentifiers, ...columns } = patch;

  const saved = await prisma.sellerBusinessProfile.upsert({
    where: { sellerAccountId: membership.sellerAccountId },
    create: {
      id: newId(),
      sellerAccountId: membership.sellerAccountId,
      ...columns,
      ...(extraIdentifiers === null || extraIdentifiers === undefined ? {} : { extraIdentifiersJson: extraIdentifiers as never }),
    },
    update: {
      ...columns,
      ...(extraIdentifiers === null || extraIdentifiers === undefined ? {} : { extraIdentifiersJson: extraIdentifiers as never }),
    },
  });

  /*
   * Re-evaluate EVERY step this profile can satisfy, not just the one the
   * caller was thinking of.
   *
   * The bug this closes was reachable and total: a seller filled in the
   * representative's name and email - which `kyb_kyc` asks for and this table
   * stores - and the step stayed NOT_STARTED forever, because only
   * `business_identity` was ever marked. They could complete the whole
   * application and never be allowed to submit it, with nothing on screen
   * telling them what was wrong.
   */
  const outcome = await markRequirementSteps(
    { sellerAccountId: membership.sellerAccountId, registrationCountry: membership.registrationCountry },
    correlationId,
  );

  const missing = outcome.get('business_identity')?.missing ?? [];
  const state: OnboardingStepState = missing.length === 0 ? 'COMPLETE' : 'IN_PROGRESS';

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.business_profile.saved',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_business_profile',
    resourceId: saved.id,
    summary: 'Business identity details were saved.',
    correlationId: correlationId ?? null,
  });

  return { state, missing };
}

// ---------------------------------------------------------------------------
// The store details
// ---------------------------------------------------------------------------

export interface StoreProfilePatch {
  description?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
}

/**
 * Save the store details step and answer, in the same breath, whether it is
 * finished.
 *
 * The answer is returned rather than left to be discovered on the next read.
 * A seller who fills this step in and sees no tick has no way of knowing
 * whether the save worked, what is still missing, or whether the form is
 * broken - and the honest reply to "I filled it in" is the list of what is
 * still outstanding, said straight away.
 */
export async function saveStoreProfile(
  membership: SellerMembership,
  patch: StoreProfilePatch,
  correlationId?: string | null,
): Promise<{ state: OnboardingStepState; missing: string[] }> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  assertApplicationEditable(membership);

  if (patch.description !== undefined) {
    await prisma.sellerAccount.update({
      where: { id: membership.sellerAccountId },
      data: { description: patch.description },
    });
  }

  // The support contacts live on the business profile, so they go through the
  // one function that writes it - which also re-evaluates the requirement
  // steps, and would otherwise be bypassed by this route.
  if (patch.supportEmail !== undefined || patch.supportPhone !== undefined) {
    await saveBusinessProfile(
      membership,
      {
        ...(patch.supportEmail === undefined ? {} : { supportEmail: patch.supportEmail }),
        ...(patch.supportPhone === undefined ? {} : { supportPhone: patch.supportPhone }),
      },
      correlationId,
    );
  }

  // Read back rather than judging the patch: a save that left one of the two
  // fields alone is still a save, and what decides the step is what is now
  // stored, not what this request happened to carry.
  const account = await prisma.sellerAccount.findUnique({
    where: { id: membership.sellerAccountId },
    select: {
      description: true,
      businessProfile: { select: { supportEmail: true } },
    },
  });

  return markStoreProfileStep({
    membership,
    description: account?.description,
    supportEmail: account?.businessProfile?.supportEmail,
    // This one the seller did do, so it is where they carry on from.
    isResumePoint: true,
    correlationId: correlationId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Agreements
// ---------------------------------------------------------------------------

/**
 * The agreements a seller must accept before submitting, and the version in
 * force.
 *
 * Versions are settings rather than constants so an operator can publish a new
 * commission schedule without a deploy, and every acceptance stores the version
 * it was given - which is what makes "which schedule was this seller on in
 * March" answerable when a settlement is disputed.
 */
export const REQUIRED_AGREEMENTS = [
  'MARKETPLACE_AGREEMENT',
  'COMMISSION_SCHEDULE',
  'RETURNS_POLICY',
  'PRIVACY_POLICY',
  'INTELLECTUAL_PROPERTY_DECLARATION',
] as const;

export type RequiredAgreementKind = (typeof REQUIRED_AGREEMENTS)[number];

export interface AcceptAgreementInput {
  membership: SellerMembership;
  kind: RequiredAgreementKind;
  version: string;
  acceptedName: string;
  /**
   * A drawing, or a typed name rendered as one.
   *
   * Stored as EVIDENCE ALONGSIDE the click-through record, never instead of
   * it, and never described in the interface as a verified signature. The
   * brief is explicit: a drawn signature is not a verified legal signature, and
   * presenting one as though it were is the kind of claim that only matters
   * once, in a dispute, when it turns out to be false. A real e-signature needs
   * a provider that binds the act to an identity, and none is configured here.
   */
  signatureStorageKey?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export async function acceptAgreement(input: AcceptAgreementInput): Promise<void> {
  const { membership } = input;

  // OWNER only - the one permission ADMIN deliberately lacks. Signing binds
  // the business, and running the business's day is not the same as signing
  // for it.
  assertSellerPermission(membership, SellerPermission.AGREEMENT_ACCEPT);

  const name = input.acceptedName.trim();
  if (name.length < 2) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Type the name of the person accepting.', [
      { field: 'acceptedName', code: 'TOO_SHORT' },
    ]);
  }

  await prisma.sellerAgreementAcceptance.create({
    data: {
      id: newId(),
      sellerAccountId: membership.sellerAccountId,
      kind: input.kind,
      version: input.version,
      method: input.signatureStorageKey === null || input.signatureStorageKey === undefined ? 'CLICKWRAP' : 'DRAWN_CONSENT',
      acceptedByProfileId: membership.customerProfileId,
      acceptedName: name,
      signatureStorageKey: input.signatureStorageKey ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });

  const accepted = await prisma.sellerAgreementAcceptance.findMany({
    where: { sellerAccountId: membership.sellerAccountId },
    select: { kind: true },
    distinct: ['kind'],
  });

  const have = new Set(accepted.map((row) => row.kind));
  const outstanding = REQUIRED_AGREEMENTS.filter((kind) => !have.has(kind));

  await markStep({
    membership,
    stepKey: 'agreements',
    state: outstanding.length === 0 ? 'COMPLETE' : 'IN_PROGRESS',
    message: outstanding.length === 0 ? null : `${String(outstanding.length)} still to accept.`,
    correlationId: input.correlationId ?? null,
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.agreement.accepted',
    actor: { type: 'CUSTOMER', label: name },
    resourceType: 'seller_agreement_acceptance',
    summary: `${input.kind.replace(/_/g, ' ').toLowerCase()} accepted at version ${input.version}.`,
    correlationId: input.correlationId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * Hand the application to the marketplace.
 *
 * Refuses with one detail entry per outstanding step, each carrying the step
 * key, so the interface links straight to the screen that fixes it. A single
 * "your application is incomplete" would make the seller open all eight.
 */
export async function submitApplication(
  membership: SellerMembership,
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_SUBMIT);
  assertApplicationEditable(membership);

  const view = await readOnboarding(membership);

  if (!view.canSubmit) {
    throw conflict(
      ErrorCode.SELLER_ONBOARDING_INCOMPLETE,
      'Some required steps are not finished yet.',
      view.blockingSteps.map((step) => ({
        field: step.key,
        code: 'STEP_INCOMPLETE',
        message: `${step.title} is not finished.`,
      })),
    );
  }

  await transitionApplication({
    sellerAccountId: membership.sellerAccountId,
    to: 'SUBMITTED',
    actor: 'SELLER',
    actorLabel: membership.displayName,
    correlationId: correlationId ?? null,
  });
}
