/**
 * Auto-pay: a customer's standing authority to be charged while they are away.
 *
 * The distinction this module exists to keep is between a saved card and
 * permission to use it. `customer_payment_methods` holds the first;
 * `customer_autopay_settings` holds the second, and they are separate tables
 * because they are separate facts. A customer who saved a card to check out
 * faster has not agreed to be billed weeks later without being asked, and
 * conflating the two is exactly how somebody gets a charge they never
 * authorised.
 *
 * So nothing here can be switched on by a flag, an admin, or a side effect.
 * `enableAutoPay` requires:
 *
 *   - a saved instrument that is chargeable TODAY (cards expire, and customers
 *     detach them in Stripe's own portal without telling us), and
 *   - an explicit `consentAccepted` from the request that carried the tick, with
 *     the wording version, the time, a hash of the address it came from and the
 *     user agent. That is the evidence a disputed charge is settled with, and
 *     "we had permission" is a claim rather than a fact without it.
 *
 * Two limits, and they are different instructions rather than degrees of the
 * same one:
 *
 *   `maxTransactionMinor`     - above this, REFUSE. The customer has said no
 *                               single charge should ever be this big, and the
 *                               right answer to one that is is to stop.
 *   `approvalThresholdMinor`  - above this, ASK. Nothing is charged, the
 *                               customer is told, and the delivery waits for
 *                               them. A deferral, not a refusal.
 *
 * Both are compared in the same currency or not at all. A cap of 5000 typed
 * against EUR is not a cap on a JPY total, and converting one silently is a
 * decision about somebody's money that nothing here is entitled to make - so a
 * mismatch refuses, loudly, with its own error code.
 */
import { Prisma } from '../../generated/prisma/client.js';
import type {
  AutoPayCapPeriod,
  AutoPayRetryPreference,
  AutoPayStatus,
} from '../../generated/prisma/enums.js';
import {
  MARKETPLACE_SUPPLIER_KEY,
  type ScopedLine,
  capPeriodWindow,
  firstLineOutsideScope,
  parseScopeList,
} from '../../domain/autopay-authority.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { assertChargeable } from './payment-method.service.js';

export interface AutoPayActor {
  customerProfileId: string;
  userId: string;
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface AutoPayView {
  status: AutoPayStatus;
  enabled: boolean;
  paymentMethodId: string | null;
  /** Enough to recognise the card, never enough to use it. */
  paymentMethodLabel: string | null;
  paymentMethodUsable: boolean;
  maxTransactionMinor: string | null;
  approvalThresholdMinor: string | null;
  limitCurrency: string | null;
  retryPreference: AutoPayRetryPreference;
  notifyOnCharge: boolean;
  notifyOnFailure: boolean;
  /** The customer's own end date for this authority, or null for none. */
  authorityExpiresAt: string | null;
  /** True once that date has passed: nothing will be charged. */
  authorityExpired: boolean;
  /** The customer's own start date, or null for "from when it was switched on". */
  authorityStartsAt: string | null;
  /** True while that date is still ahead: nothing will be charged yet. */
  authorityNotStarted: boolean;
  /** The most that may be charged automatically per calendar period. */
  periodCapMinor: string | null;
  capPeriod: AutoPayCapPeriod | null;
  /** What automatic charges have used of the cap in the current period. */
  periodUsedMinor: string | null;
  /** Seller account ids and MARKETPLACE, or null for every supplier. */
  scopeSellerKeys: string[] | null;
  /** Category ids, or null for every category. */
  scopeCategoryIds: string[] | null;
  consentAcceptedAt: string | null;
  consentVersion: string | null;
  consentWithdrawnAt: string | null;
  enabledAt: string | null;
  pausedAt: string | null;
  /** The wording the customer would be agreeing to if they enabled it now. */
  currentConsentVersion: string;
}

type SettingRow = Prisma.CustomerAutoPaySettingGetPayload<{
  include: { paymentMethod: true };
}>;

/**
 * Money crosses the API as a STRING, never a JS number.
 *
 * `BigInt` does not survive `JSON.stringify`, and a `number` loses precision
 * above 2^53 - which for a currency with no minor units is a real total, not a
 * theoretical one. See CLAUDE.md.
 */
function minorToString(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function toView(row: SettingRow | null): AutoPayView {
  const currentConsentVersion = env.AUTOPAY_CONSENT_VERSION;

  if (row === null) {
    // A customer who has never opted in. Returned as a shape rather than a 404
    // so the screen renders the off state without a special case.
    return {
      status: 'DISABLED',
      enabled: false,
      paymentMethodId: null,
      paymentMethodLabel: null,
      paymentMethodUsable: false,
      maxTransactionMinor: null,
      approvalThresholdMinor: null,
      limitCurrency: null,
      retryPreference: 'STANDARD',
      notifyOnCharge: true,
      notifyOnFailure: true,
      authorityExpiresAt: null,
      authorityExpired: false,
      authorityStartsAt: null,
      authorityNotStarted: false,
      periodCapMinor: null,
      capPeriod: null,
      periodUsedMinor: null,
      scopeSellerKeys: null,
      scopeCategoryIds: null,
      consentAcceptedAt: null,
      consentVersion: null,
      consentWithdrawnAt: null,
      enabledAt: null,
      pausedAt: null,
      currentConsentVersion,
    };
  }

  const method = row.paymentMethod;

  return {
    status: row.status,
    enabled: row.status === 'ACTIVE',
    paymentMethodId: row.paymentMethodId,
    paymentMethodLabel:
      method === null
        ? null
        : `${method.brand ?? 'Card'} ending ${method.last4 ?? '****'}`,
    paymentMethodUsable: method !== null && method.status === 'ACTIVE',
    maxTransactionMinor: minorToString(row.maxTransactionMinor),
    approvalThresholdMinor: minorToString(row.approvalThresholdMinor),
    limitCurrency: row.limitCurrency,
    retryPreference: row.retryPreference,
    notifyOnCharge: row.notifyOnCharge,
    notifyOnFailure: row.notifyOnFailure,
    authorityExpiresAt: row.authorityExpiresAt?.toISOString() ?? null,
    authorityExpired: row.authorityExpiresAt !== null && row.authorityExpiresAt.getTime() <= Date.now(),
    authorityStartsAt: row.authorityStartsAt?.toISOString() ?? null,
    authorityNotStarted: row.authorityStartsAt !== null && row.authorityStartsAt.getTime() > Date.now(),
    periodCapMinor: minorToString(row.periodCapMinor),
    capPeriod: row.capPeriod,
    periodUsedMinor: null,
    scopeSellerKeys: parseScopeList(row.scopeSellerKeysJson),
    scopeCategoryIds: parseScopeList(row.scopeCategoryIdsJson),
    consentAcceptedAt: row.consentAcceptedAt?.toISOString() ?? null,
    consentVersion: row.consentVersion,
    consentWithdrawnAt: row.consentWithdrawnAt?.toISOString() ?? null,
    enabledAt: row.enabledAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    currentConsentVersion,
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function assertAutoPayFeatureEnabled(): void {
  if (!env.FEATURE_CUSTOMER_AUTOPAY) {
    throw forbidden(
      ErrorCode.FEATURE_DISABLED,
      'Automatic payment is not enabled for this store.',
    );
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getAutoPaySettings(customerProfileId: string): Promise<AutoPayView> {
  const row = await prisma.customerAutoPaySetting.findUnique({
    where: { customerProfileId },
    include: { paymentMethod: true },
  });

  const view = toView(row);
  if (row !== null && row.periodCapMinor !== null && row.capPeriod !== null && row.limitCurrency !== null) {
    view.periodUsedMinor = (
      await automaticChargesInPeriod(customerProfileId, row.limitCurrency, row.capPeriod, new Date())
    ).toString();
  }
  return view;
}

/**
 * What automatic (off-session, scheduled) charges have taken - or are in the
 * middle of taking - from this customer in the current period.
 *
 * Counted from the payment attempts themselves rather than from orders, and
 * including attempts still in flight: two plans running in the same minute
 * must not both see the whole cap available. A failed or cancelled attempt
 * moved no money and does not count. Only the scheduled engine's own charges
 * count (their idempotency key is the occurrence's, `occ:...`): an order the
 * customer paid by hand was not taken under this authority.
 */
export async function automaticChargesInPeriod(
  customerProfileId: string,
  currency: string,
  period: AutoPayCapPeriod,
  now: Date,
): Promise<bigint> {
  const window = capPeriodWindow(now, period);
  const total = await prisma.paymentTransaction.aggregate({
    where: {
      currency,
      idempotencyKey: { startsWith: 'occ:' },
      status: { in: ['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED'] },
      createdAt: { gte: window.start, lt: window.end },
      order: { customerProfileId },
    },
    _sum: { amountMinor: true },
  });
  return total._sum.amountMinor ?? 0n;
}

// ---------------------------------------------------------------------------
// Enabling
// ---------------------------------------------------------------------------

export interface EnableAutoPayInput {
  paymentMethodId: string;
  /**
   * The tick. Not a default, not inferred from anything else, and the request
   * is refused without it. A customer who did not tick the box did not agree.
   */
  consentAccepted: boolean;
  maxTransactionMinor?: bigint | null;
  approvalThresholdMinor?: bigint | null;
  limitCurrency?: string | null;
  retryPreference?: AutoPayRetryPreference;
  notifyOnCharge?: boolean;
  notifyOnFailure?: boolean;
  /** The end date of the authority. Null means until switched off. */
  authorityExpiresAt?: Date | null;
  /** The start date of the authority. Null means from now. */
  authorityStartsAt?: Date | null;
  periodCapMinor?: bigint | null;
  capPeriod?: AutoPayCapPeriod | null;
  /** Seller account ids and MARKETPLACE. Null: every supplier. */
  scopeSellerKeys?: string[] | null;
  /** Category ids. Null: every category. */
  scopeCategoryIds?: string[] | null;
}

/**
 * The start has to come before the end, and a period cap is an amount, a
 * period and a currency together - the rule `chk_autopay_period_cap` holds
 * the table to.
 */
function assertAuthorityWindowAndCap(input: {
  authorityStartsAt: Date | null;
  authorityExpiresAt: Date | null;
  periodCapMinor: bigint | null;
  capPeriod: AutoPayCapPeriod | null;
  limitCurrency: string | null;
}): void {
  if (
    input.authorityStartsAt !== null &&
    input.authorityExpiresAt !== null &&
    input.authorityStartsAt.getTime() >= input.authorityExpiresAt.getTime()
  ) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The start date has to be before the end date.', [
      { field: 'authorityStartsAt', code: 'AFTER_END' },
    ]);
  }

  if (input.periodCapMinor === null) return;

  if (input.periodCapMinor <= 0n) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A cap of nothing would stop every payment. Leave it empty for no cap.',
      [{ field: 'periodCapMinor', code: 'MUST_BE_POSITIVE' }],
    );
  }
  if (input.capPeriod === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Choose the period your cap applies to: a week, a month, a quarter or a year.',
      [{ field: 'capPeriod', code: 'REQUIRED' }],
    );
  }
  if ((input.limitCurrency ?? '') === '') {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Choose the currency your limits are in. An amount without a currency is not a limit.',
      [{ field: 'limitCurrency', code: 'REQUIRED' }],
    );
  }
}

/**
 * Every supplier and category named in a scope has to exist. A typo stored as
 * a scope would quietly hold every delivery from the supplier the customer
 * meant, and they would only find out when one was not paid for.
 */
async function assertScopeKnown(input: {
  scopeSellerKeys?: string[] | null;
  scopeCategoryIds?: string[] | null;
}): Promise<void> {
  const sellers = [...new Set(input.scopeSellerKeys ?? [])].filter(
    (key) => key !== MARKETPLACE_SUPPLIER_KEY,
  );
  if (sellers.length > 0) {
    const found = await prisma.sellerAccount.count({ where: { id: { in: sellers } } });
    if (found !== sellers.length) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'One of the suppliers you chose no longer exists.', [
        { field: 'scopeSellerKeys', code: 'NOT_FOUND' },
      ]);
    }
  }
  const categories = [...new Set(input.scopeCategoryIds ?? [])];
  if (categories.length > 0) {
    const found = await prisma.category.count({ where: { id: { in: categories } } });
    if (found !== categories.length) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'One of the categories you chose no longer exists.', [
        { field: 'scopeCategoryIds', code: 'NOT_FOUND' },
      ]);
    }
  }
}

/** A scope list for a JSON column: DbNull for "every", a de-duplicated list otherwise. */
function scopeJson(value: string[] | null): string[] | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : [...new Set(value)];
}

/**
 * An end date has to be in the future. A date already past would switch the
 * authority on and off in the same breath, and the customer would believe they
 * had set something up.
 */
function assertExpiryInFuture(value: Date | null | undefined): void {
  if (value === undefined || value === null) return;
  if (value.getTime() <= Date.now()) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Choose an end date in the future, or leave it empty to keep automatic payment until you switch it off.',
      [{ field: 'authorityExpiresAt', code: 'IN_THE_PAST' }],
    );
  }
}

/**
 * Validate the two limits together.
 *
 * A threshold above the maximum can never fire - the charge is refused before
 * anybody is asked - so a customer who set one has misunderstood which field
 * does what, and storing it silently means they believe they will be consulted
 * about charges that are simply going to fail.
 */
function assertLimitsCoherent(input: {
  maxTransactionMinor?: bigint | null;
  approvalThresholdMinor?: bigint | null;
  limitCurrency?: string | null;
}): void {
  const max = input.maxTransactionMinor ?? null;
  const threshold = input.approvalThresholdMinor ?? null;

  if ((max !== null || threshold !== null) && (input.limitCurrency ?? '') === '') {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Choose the currency your limits are in. An amount without a currency is not a limit.',
      [{ field: 'limitCurrency', code: 'REQUIRED' }],
    );
  }

  if (max !== null && max <= 0n) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A maximum of nothing would stop every payment. Switch automatic payment off instead.',
      [{ field: 'maxTransactionMinor', code: 'MUST_BE_POSITIVE' }],
    );
  }

  if (threshold !== null && threshold <= 0n) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A threshold of nothing would ask you about every payment. Leave it empty to be asked ' +
        'about none.',
      [{ field: 'approvalThresholdMinor', code: 'MUST_BE_POSITIVE' }],
    );
  }

  if (max !== null && threshold !== null && threshold >= max) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The amount you want to be asked about has to be below your maximum. Above the maximum, ' +
        'nothing is charged at all and you are not asked.',
      [{ field: 'approvalThresholdMinor', code: 'ABOVE_MAXIMUM' }],
    );
  }
}

/**
 * Turn auto-pay on, with consent recorded.
 *
 * Every refusal here names something the customer can go and do. "Not eligible"
 * is not one of them.
 */
export async function enableAutoPay(
  actor: AutoPayActor,
  input: EnableAutoPayInput,
): Promise<AutoPayView> {
  assertAutoPayFeatureEnabled();

  if (!input.consentAccepted) {
    throw badRequest(
      ErrorCode.AUTOPAY_CONSENT_REQUIRED,
      'Automatic payment can only be switched on if you agree to it. Tick the box to confirm ' +
        'you authorise payments to be taken without you being present.',
      [{ field: 'consentAccepted', code: 'REQUIRED' }],
    );
  }

  // Ownership by WHERE clause, like every other read in this feature. A
  // payment method belonging to somebody else is indistinguishable from one
  // that does not exist.
  const method = await prisma.customerPaymentMethod.findFirst({
    where: { id: input.paymentMethodId, customerProfileId: actor.customerProfileId },
  });

  if (method === null) {
    throw badRequest(
      ErrorCode.AUTOPAY_PAYMENT_METHOD_REQUIRED,
      'Choose a saved card to use for automatic payments.',
      [{ field: 'paymentMethodId', code: 'NOT_FOUND' }],
    );
  }

  // Throws with a specific reason - detached, expired - rather than a generic
  // refusal, because the two need different things from the customer.
  assertChargeable(method);

  assertLimitsCoherent(input);
  assertExpiryInFuture(input.authorityExpiresAt);
  assertAuthorityWindowAndCap({
    authorityStartsAt: input.authorityStartsAt ?? null,
    authorityExpiresAt: input.authorityExpiresAt ?? null,
    periodCapMinor: input.periodCapMinor ?? null,
    capPeriod: input.capPeriod ?? null,
    limitCurrency: input.limitCurrency ?? null,
  });
  await assertScopeKnown(input);

  const now = new Date();

  const data = {
    status: 'ACTIVE' as const,
    authorityExpiresAt: input.authorityExpiresAt ?? null,
    authorityStartsAt: input.authorityStartsAt ?? null,
    periodCapMinor: input.periodCapMinor ?? null,
    capPeriod: (input.periodCapMinor ?? null) === null ? null : (input.capPeriod ?? null),
    scopeSellerKeysJson: scopeJson(input.scopeSellerKeys ?? null),
    scopeCategoryIdsJson: scopeJson(input.scopeCategoryIds ?? null),
    paymentMethodId: input.paymentMethodId,
    maxTransactionMinor: input.maxTransactionMinor ?? null,
    approvalThresholdMinor: input.approvalThresholdMinor ?? null,
    limitCurrency: input.limitCurrency?.toUpperCase() ?? null,
    retryPreference: input.retryPreference ?? ('STANDARD' as const),
    notifyOnCharge: input.notifyOnCharge ?? true,
    notifyOnFailure: input.notifyOnFailure ?? true,
    consentAcceptedAt: now,
    consentVersion: env.AUTOPAY_CONSENT_VERSION,
    // Hashed, never the address itself. It is evidence that consent came from
    // somewhere; keeping the raw IP would make this a worse table to leak.
    consentIpHash: actor.ipAddress === null || actor.ipAddress === undefined ? null : sha256Hex(actor.ipAddress),
    consentUserAgent: actor.userAgent?.slice(0, 256) ?? null,
    // A fresh opt-in clears any earlier withdrawal. Leaving it set would make
    // the row say consent was both given and taken back, with no way to tell
    // which happened last.
    consentWithdrawnAt: null,
    enabledAt: now,
    pausedAt: null,
  };

  const saved = await prisma.customerAutoPaySetting.upsert({
    where: { customerProfileId: actor.customerProfileId },
    create: { id: newId(), customerProfileId: actor.customerProfileId, ...data },
    update: data,
    include: { paymentMethod: true },
  });

  await recordAudit({
    action: AuditAction.AUTOPAY_ENABLED,
    resourceType: 'autopay',
    resourceId: saved.id,
    actorType: 'CUSTOMER',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: {
      consentVersion: data.consentVersion,
      paymentMethodId: input.paymentMethodId,
      // Recorded as strings: an audit row is JSON, and a BigInt does not
      // survive the trip.
      maxTransactionMinor: minorToString(data.maxTransactionMinor),
      approvalThresholdMinor: minorToString(data.approvalThresholdMinor),
      limitCurrency: data.limitCurrency,
      authorityExpiresAt: data.authorityExpiresAt?.toISOString() ?? null,
      authorityStartsAt: data.authorityStartsAt?.toISOString() ?? null,
      periodCapMinor: minorToString(data.periodCapMinor),
      capPeriod: data.capPeriod,
      scopeSellerKeys: input.scopeSellerKeys ?? null,
      scopeCategoryIds: input.scopeCategoryIds ?? null,
    },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return toView(saved);
}

/**
 * Change limits, preferences or the card, without re-asking for consent.
 *
 * Consent was given to the ARRANGEMENT, and lowering a maximum or switching
 * notifications off does not need it renewed. Raising a maximum is the one edit
 * where that is arguable, and the audit row records the before and after so the
 * question can be answered from the trail rather than argued about.
 */
export async function updateAutoPaySettings(
  actor: AutoPayActor,
  input: Partial<EnableAutoPayInput>,
): Promise<AutoPayView> {
  assertAutoPayFeatureEnabled();

  const existing = await prisma.customerAutoPaySetting.findUnique({
    where: { customerProfileId: actor.customerProfileId },
    include: { paymentMethod: true },
  });

  if (existing === null) throw notFound('Your automatic payment settings');

  if (input.paymentMethodId !== undefined) {
    const method = await prisma.customerPaymentMethod.findFirst({
      where: { id: input.paymentMethodId, customerProfileId: actor.customerProfileId },
    });

    if (method === null) {
      throw badRequest(
        ErrorCode.AUTOPAY_PAYMENT_METHOD_REQUIRED,
        'Choose a saved card to use for automatic payments.',
        [{ field: 'paymentMethodId', code: 'NOT_FOUND' }],
      );
    }

    assertChargeable(method);
  }

  // Validated against the MERGED state, not the incoming fields alone.
  // Otherwise clearing the currency while leaving a maximum in place would
  // pass, and the row would store an amount nobody could compare anything to.
  assertLimitsCoherent({
    maxTransactionMinor:
      input.maxTransactionMinor === undefined
        ? existing.maxTransactionMinor
        : input.maxTransactionMinor,
    approvalThresholdMinor:
      input.approvalThresholdMinor === undefined
        ? existing.approvalThresholdMinor
        : input.approvalThresholdMinor,
    limitCurrency:
      input.limitCurrency === undefined ? existing.limitCurrency : input.limitCurrency,
  });
  assertExpiryInFuture(input.authorityExpiresAt);
  const mergedCap =
    input.periodCapMinor === undefined ? existing.periodCapMinor : input.periodCapMinor;
  const mergedPeriod =
    mergedCap === null ? null : input.capPeriod === undefined ? existing.capPeriod : input.capPeriod;
  assertAuthorityWindowAndCap({
    authorityStartsAt:
      input.authorityStartsAt === undefined ? existing.authorityStartsAt : input.authorityStartsAt,
    authorityExpiresAt:
      input.authorityExpiresAt === undefined ? existing.authorityExpiresAt : input.authorityExpiresAt,
    periodCapMinor: mergedCap,
    capPeriod: mergedPeriod,
    limitCurrency: input.limitCurrency === undefined ? existing.limitCurrency : input.limitCurrency,
  });
  await assertScopeKnown(input);

  const saved = await prisma.customerAutoPaySetting.update({
    where: { customerProfileId: actor.customerProfileId },
    data: {
      ...(input.paymentMethodId === undefined ? {} : { paymentMethodId: input.paymentMethodId }),
      ...(input.maxTransactionMinor === undefined
        ? {}
        : { maxTransactionMinor: input.maxTransactionMinor }),
      ...(input.approvalThresholdMinor === undefined
        ? {}
        : { approvalThresholdMinor: input.approvalThresholdMinor }),
      ...(input.limitCurrency === undefined
        ? {}
        : { limitCurrency: input.limitCurrency?.toUpperCase() ?? null }),
      ...(input.retryPreference === undefined ? {} : { retryPreference: input.retryPreference }),
      ...(input.notifyOnCharge === undefined ? {} : { notifyOnCharge: input.notifyOnCharge }),
      ...(input.notifyOnFailure === undefined ? {} : { notifyOnFailure: input.notifyOnFailure }),
      ...(input.authorityExpiresAt === undefined
        ? {}
        : { authorityExpiresAt: input.authorityExpiresAt }),
      ...(input.authorityStartsAt === undefined ? {} : { authorityStartsAt: input.authorityStartsAt }),
      periodCapMinor: mergedCap,
      capPeriod: mergedPeriod,
      ...(input.scopeSellerKeys === undefined
        ? {}
        : { scopeSellerKeysJson: scopeJson(input.scopeSellerKeys) }),
      ...(input.scopeCategoryIds === undefined
        ? {}
        : { scopeCategoryIdsJson: scopeJson(input.scopeCategoryIds) }),
    },
    include: { paymentMethod: true },
  });

  await recordAudit({
    action: AuditAction.AUTOPAY_SETTINGS_UPDATED,
    resourceType: 'autopay',
    resourceId: saved.id,
    actorType: 'CUSTOMER',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: {
      maxTransactionMinor: minorToString(existing.maxTransactionMinor),
      approvalThresholdMinor: minorToString(existing.approvalThresholdMinor),
      limitCurrency: existing.limitCurrency,
      paymentMethodId: existing.paymentMethodId,
      retryPreference: existing.retryPreference,
      authorityExpiresAt: existing.authorityExpiresAt?.toISOString() ?? null,
      authorityStartsAt: existing.authorityStartsAt?.toISOString() ?? null,
      periodCapMinor: minorToString(existing.periodCapMinor),
      capPeriod: existing.capPeriod,
      scopeSellerKeys: parseScopeList(existing.scopeSellerKeysJson),
      scopeCategoryIds: parseScopeList(existing.scopeCategoryIdsJson),
    },
    after: {
      maxTransactionMinor: minorToString(saved.maxTransactionMinor),
      approvalThresholdMinor: minorToString(saved.approvalThresholdMinor),
      limitCurrency: saved.limitCurrency,
      paymentMethodId: saved.paymentMethodId,
      retryPreference: saved.retryPreference,
      authorityExpiresAt: saved.authorityExpiresAt?.toISOString() ?? null,
      authorityStartsAt: saved.authorityStartsAt?.toISOString() ?? null,
      periodCapMinor: minorToString(saved.periodCapMinor),
      capPeriod: saved.capPeriod,
      scopeSellerKeys: parseScopeList(saved.scopeSellerKeysJson),
      scopeCategoryIds: parseScopeList(saved.scopeCategoryIdsJson),
    },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return toView(saved);
}

/**
 * Pause or resume.
 *
 * Pausing does NOT withdraw consent, and that is the whole reason it is not
 * simply "disable". A customer going on holiday wants their arrangement intact
 * when they come back; making them re-consent to resume would be treating a
 * fortnight away as a change of mind.
 */
export async function setAutoPayPaused(
  actor: AutoPayActor,
  paused: boolean,
): Promise<AutoPayView> {
  assertAutoPayFeatureEnabled();

  const existing = await prisma.customerAutoPaySetting.findUnique({
    where: { customerProfileId: actor.customerProfileId },
    include: { paymentMethod: true },
  });

  if (existing === null) throw notFound('Your automatic payment settings');

  if (existing.status === 'DISABLED') {
    throw conflict(
      ErrorCode.AUTOPAY_NOT_ENABLED,
      'Automatic payment is switched off, so there is nothing to pause. Switch it on first.',
    );
  }

  const nextStatus: AutoPayStatus = paused ? 'PAUSED' : 'ACTIVE';

  if (existing.status === nextStatus) return toView(existing);

  // Resuming re-checks the card. It may have expired or been detached in
  // Stripe's own portal during the pause, and letting a customer resume into an
  // arrangement that cannot charge would only fail at the next delivery.
  if (!paused) {
    const method =
      existing.paymentMethodId === null
        ? null
        : await prisma.customerPaymentMethod.findFirst({
            where: { id: existing.paymentMethodId, customerProfileId: actor.customerProfileId },
          });

    if (method === null) {
      throw conflict(
        ErrorCode.AUTOPAY_PAYMENT_METHOD_REQUIRED,
        'The card this was set up with is no longer saved. Choose another one to resume.',
      );
    }

    assertChargeable(method);
  }

  const saved = await prisma.customerAutoPaySetting.update({
    where: { customerProfileId: actor.customerProfileId },
    data: { status: nextStatus, pausedAt: paused ? new Date() : null },
    include: { paymentMethod: true },
  });

  await recordAudit({
    action: paused ? AuditAction.AUTOPAY_PAUSED : AuditAction.AUTOPAY_RESUMED,
    resourceType: 'autopay',
    resourceId: saved.id,
    actorType: 'CUSTOMER',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { status: existing.status },
    after: { status: nextStatus },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return toView(saved);
}

/**
 * Withdraw consent.
 *
 * The row is kept rather than deleted, so the customer's limits and preferences
 * survive a change of mind and so the trail can still show that consent was
 * given, then taken back, and when. `consentAcceptedAt` is cleared because the
 * CHECK constraint on the table requires it: a row that is not DISABLED must
 * carry consent, and the inverse - a DISABLED row still claiming consent -
 * would be a record saying somebody may be charged when they may not.
 */
export async function disableAutoPay(actor: AutoPayActor): Promise<AutoPayView> {
  const existing = await prisma.customerAutoPaySetting.findUnique({
    where: { customerProfileId: actor.customerProfileId },
    include: { paymentMethod: true },
  });

  // Nothing to do, and deliberately not an error: a customer switching off
  // something already off has got what they wanted.
  if (existing === null) return toView(null);

  const saved = await prisma.customerAutoPaySetting.update({
    where: { customerProfileId: actor.customerProfileId },
    data: {
      status: 'DISABLED',
      consentAcceptedAt: null,
      consentWithdrawnAt: new Date(),
      pausedAt: null,
    },
    include: { paymentMethod: true },
  });

  await recordAudit({
    action: AuditAction.AUTOPAY_DISABLED,
    resourceType: 'autopay',
    resourceId: saved.id,
    actorType: 'CUSTOMER',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: { status: existing.status, consentVersion: existing.consentVersion },
    after: { status: 'DISABLED' },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return toView(saved);
}

// ---------------------------------------------------------------------------
// The decision, at charge time
// ---------------------------------------------------------------------------

export type AutoPayDecision =
  /** Charge it, using this instrument. */
  | { outcome: 'CHARGE'; paymentMethodId: string; retryPreference: AutoPayRetryPreference }
  /**
   * Do not charge, and ask the customer first. The amount crossed the threshold
   * they set for being consulted.
   */
  | {
      outcome: 'ASK_CUSTOMER';
      /** AUTOPAY_APPROVAL_REQUIRED, AUTOPAY_PERIOD_CAP_REACHED or AUTOPAY_OUTSIDE_SCOPE. */
      code: string;
      reason: string;
      /** The limit that fired, in `currency`; null for a scope question. */
      thresholdMinor: string | null;
      currency: string;
    }
  /** Do not charge, and do not ask. Something makes this charge impermissible. */
  | { outcome: 'REFUSE'; code: string; reason: string };

/**
 * May this charge be made without the customer present?
 *
 * The one function every off-session charge path calls, and the reason there is
 * one place where that question is answered. It reads rather than writes, so it
 * is safe to call speculatively - the review screen uses it to warn a customer
 * that a basket will need their approval before they ever get to the day it
 * would be charged.
 *
 * The order of the checks is the order of severity, and it matters. Consent is
 * checked before limits, because a customer who never agreed should be told
 * that rather than being told their basket is too expensive.
 */
export async function evaluateAutoPay(input: {
  customerProfileId: string;
  amountMinor: bigint;
  currency: string;
  /**
   * Who supplies each line and what category it is in, for the supplier and
   * category scope. A caller with no basket to describe leaves it out, and a
   * scope is then treated as NOT satisfied: "we did not look" is not "it is
   * covered".
   */
  lines?: readonly ScopedLine[];
  now?: Date;
}): Promise<AutoPayDecision> {
  const now = input.now ?? new Date();

  if (!env.FEATURE_CUSTOMER_AUTOPAY) {
    return {
      outcome: 'REFUSE',
      code: ErrorCode.FEATURE_DISABLED,
      reason: 'Automatic payment is not enabled for this store.',
    };
  }

  const settings = await prisma.customerAutoPaySetting.findUnique({
    where: { customerProfileId: input.customerProfileId },
    include: { paymentMethod: true },
  });

  if (settings === null || settings.status === 'DISABLED') {
    return {
      outcome: 'REFUSE',
      code: ErrorCode.AUTOPAY_NOT_ENABLED,
      reason: 'Automatic payment is not switched on for this account.',
    };
  }

  if (settings.status === 'PAUSED') {
    return {
      outcome: 'REFUSE',
      code: ErrorCode.AUTOPAY_NOT_ENABLED,
      reason: 'Automatic payment is paused for this account.',
    };
  }

  // The customer's own end date. Checked before the card and the limits:
  // an authority that has run out is not a charge that is too large.
  if (settings.authorityExpiresAt !== null && settings.authorityExpiresAt.getTime() <= now.getTime()) {
    return {
      outcome: 'REFUSE',
      code: ErrorCode.AUTOPAY_AUTHORITY_EXPIRED,
      reason: 'The end date you set for automatic payment has passed. Set a new one to carry on.',
    };
  }

  // The customer's own start date. Before it, the authority does not exist yet.
  if (settings.authorityStartsAt !== null && settings.authorityStartsAt.getTime() > now.getTime()) {
    return {
      outcome: 'REFUSE',
      code: ErrorCode.AUTOPAY_AUTHORITY_NOT_STARTED,
      reason: 'The start date you set for automatic payment has not come yet.',
    };
  }

  // The CHECK constraint should make this unreachable. It is checked anyway,
  // because the one thing worse than refusing a charge that was authorised is
  // making one that was not.
  if (settings.consentAcceptedAt === null) {
    return {
      outcome: 'REFUSE',
      code: ErrorCode.AUTOPAY_CONSENT_REQUIRED,
      reason: 'There is no record of consent for automatic payments on this account.',
    };
  }

  const method = settings.paymentMethod;

  if (method === null || settings.paymentMethodId === null) {
    return {
      outcome: 'REFUSE',
      code: ErrorCode.AUTOPAY_PAYMENT_METHOD_REQUIRED,
      reason: 'There is no saved card for automatic payments.',
    };
  }

  try {
    assertChargeable(method);
  } catch {
    return {
      outcome: 'REFUSE',
      code: ErrorCode.AUTOPAY_PAYMENT_METHOD_REQUIRED,
      reason: 'The saved card can no longer be charged. Add a new one.',
    };
  }

  // --- The operator's own backstop ---------------------------------------
  //
  // Applied on top of the customer's limits, never instead of them, and in the
  // order's own currency because it is a sanity ceiling rather than a
  // negotiated one. It exists so a pricing bug cannot become a five-figure
  // charge nobody authorised.
  if (env.AUTOPAY_PLATFORM_MAX_MINOR > 0 && input.amountMinor > BigInt(env.AUTOPAY_PLATFORM_MAX_MINOR)) {
    return {
      outcome: 'REFUSE',
      code: ErrorCode.AUTOPAY_LIMIT_EXCEEDED,
      reason: 'This amount is above the maximum this store will take automatically.',
    };
  }

  // --- The customer's own limits -----------------------------------------
  const hasLimits =
    settings.maxTransactionMinor !== null || settings.approvalThresholdMinor !== null;

  if (hasLimits) {
    // A limit in another currency cannot be applied, and converting it would be
    // deciding on the customer's behalf what they meant. Refused with its own
    // code so the message can say exactly that.
    if (settings.limitCurrency !== input.currency) {
      return {
        outcome: 'REFUSE',
        code: ErrorCode.AUTOPAY_CURRENCY_MISMATCH,
        reason:
          `Your automatic payment limits are set in ${settings.limitCurrency ?? 'another currency'} ` +
          `and this order is in ${input.currency}. Update your limits to cover this currency.`,
      };
    }

    if (settings.maxTransactionMinor !== null && input.amountMinor > settings.maxTransactionMinor) {
      return {
        outcome: 'REFUSE',
        code: ErrorCode.AUTOPAY_LIMIT_EXCEEDED,
        reason: 'This amount is above the maximum you set for automatic payments.',
      };
    }

    if (
      settings.approvalThresholdMinor !== null &&
      input.amountMinor > settings.approvalThresholdMinor
    ) {
      // Deferred, not refused. The customer asked to be consulted about amounts
      // this size, and they are about to be.
      return {
        outcome: 'ASK_CUSTOMER',
        code: ErrorCode.AUTOPAY_APPROVAL_REQUIRED,
        reason: 'This amount is above the level you asked to be consulted about.',
        thresholdMinor: settings.approvalThresholdMinor.toString(),
        currency: settings.limitCurrency ?? input.currency,
      };
    }
  }

  // --- Supplier and category scope ---------------------------------------
  //
  // Asked rather than refused: the customer may well want this order, they
  // just did not authorise it to be paid without them. Paying it themselves
  // is the approval.
  const scope = {
    sellerKeys: parseScopeList(settings.scopeSellerKeysJson),
    categoryIds: parseScopeList(settings.scopeCategoryIdsJson),
  };
  if (scope.sellerKeys !== null || scope.categoryIds !== null) {
    const outside =
      input.lines === undefined
        ? { dimension: scope.sellerKeys !== null ? ('SUPPLIER' as const) : ('CATEGORY' as const) }
        : firstLineOutsideScope(scope, input.lines);
    if (outside !== null) {
      return {
        outcome: 'ASK_CUSTOMER',
        code: ErrorCode.AUTOPAY_OUTSIDE_SCOPE,
        reason:
          outside.dimension === 'SUPPLIER'
            ? 'This order includes a supplier your automatic payment does not cover.'
            : 'This order includes a category your automatic payment does not cover.',
        thresholdMinor: null,
        currency: input.currency,
      };
    }
  }

  // --- The cap per calendar period ----------------------------------------
  if (settings.periodCapMinor !== null && settings.capPeriod !== null) {
    if (settings.limitCurrency !== input.currency) {
      return {
        outcome: 'REFUSE',
        code: ErrorCode.AUTOPAY_CURRENCY_MISMATCH,
        reason:
          `Your automatic payment limits are set in ${settings.limitCurrency ?? 'another currency'} ` +
          `and this order is in ${input.currency}. Update your limits to cover this currency.`,
      };
    }

    const used = await automaticChargesInPeriod(
      input.customerProfileId,
      input.currency,
      settings.capPeriod,
      now,
    );

    if (used + input.amountMinor > settings.periodCapMinor) {
      return {
        outcome: 'ASK_CUSTOMER',
        code: ErrorCode.AUTOPAY_PERIOD_CAP_REACHED,
        reason:
          'This payment would take your automatic payments for this period above the cap you set.',
        thresholdMinor: settings.periodCapMinor.toString(),
        currency: input.currency,
      };
    }
  }

  return {
    outcome: 'CHARGE',
    paymentMethodId: settings.paymentMethodId,
    retryPreference: settings.retryPreference,
  };
}

/**
 * Record that a charge was NOT made because of the customer's own settings.
 *
 * On the audit trail because a delivery that did not happen needs an
 * explanation as much as one that did, and "why was I not charged" is a
 * question with a specific answer that should not require reading logs.
 */
export async function recordWithheldCharge(input: {
  customerProfileId: string;
  userId: string | null;
  orderId: string | null;
  amountMinor: bigint;
  currency: string;
  decision: AutoPayDecision;
  correlationId?: string | null;
}): Promise<void> {
  if (input.decision.outcome === 'CHARGE') return;

  await recordAudit({
    action: AuditAction.AUTOPAY_CHARGE_WITHHELD,
    resourceType: 'order',
    resourceId: input.orderId,
    actorType: 'SYSTEM',
    actorUserId: input.userId,
    after: {
      outcome: input.decision.outcome,
      reason: input.decision.reason,
      amountMinor: input.amountMinor.toString(),
      currency: input.currency,
      code: input.decision.code,
    },
    correlationId: input.correlationId ?? null,
  });
}

/**
 * How many further attempts the customer's preference allows.
 *
 * Zero means fail and tell them - the choice of somebody who would rather pay
 * by hand than have a card retried behind their back. The platform's own
 * ceiling still applies on top: a preference cannot ask for more attempts than
 * the deployment permits, because repeated declines are read by banks as a
 * signal about the card itself.
 */
export function retryAttemptsFor(preference: AutoPayRetryPreference): number {
  switch (preference) {
    case 'NONE':
      return 0;
    case 'ONCE':
      return 1;
    case 'STANDARD':
      return Math.max(0, env.SCHEDULE_MAX_PAYMENT_ATTEMPTS - 1);
  }
}
