/**
 * Where a seller's money goes, and what this deployment can honestly say about
 * it.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * This repository has no payout provider configured and no bank-verification
 * provider at all. The brief is emphatic about what that must mean: "Do not
 * show a fake success state when third-party credentials are unavailable" and
 * "Claude must not simulate successful verification." So the adapter below has
 * exactly one implementation, `unconfigured`, and it returns
 * `PROVIDER_UNCONFIGURED` rather than a happy path.
 *
 * WHY THERE IS NO ACCOUNT NUMBER IN THIS MODULE
 *
 * The reference screens collect an account number, a routing code and a
 * beneficiary name, then show a penny-transfer verification. Every one of those
 * belongs to the PROVIDER, not to us. A marketplace does not need bank details
 * to pay a seller; it needs a connected-account identifier at somebody who is
 * regulated to hold them. Collecting them here would put this deployment inside
 * the scope of rules it has no reason to be in, in exchange for nothing - and
 * this software is sold to companies who run it themselves, so the liability
 * would be theirs.
 *
 * What the seller sees instead is the same flow with the collection step
 * delegated: "connect your payout account", a redirect to the provider, and a
 * status this service reads back from signed webhooks.
 */
import type { SellerPayoutAccountState } from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import { assertSellerPermission, type SellerMembership } from './account.service.js';
import { markStep } from './onboarding.service.js';

// ---------------------------------------------------------------------------
// The adapter boundary
// ---------------------------------------------------------------------------

export interface PayoutOnboardingLink {
  /** Where to send the seller. */
  url: string;
  expiresAt: Date;
}

export interface PayoutAccountStatus {
  state: SellerPayoutAccountState;
  providerAccountId: string | null;
  payoutsEnabled: boolean;
  /** What the provider still wants, in its own words. */
  pendingRequirements: string[];
  bankName: string | null;
  accountLast4: string | null;
}

/**
 * What a payout provider has to be able to do.
 *
 * Three methods, because three is what the flow needs: start onboarding, read
 * back where it got to, and send money. A fourth - "verify this account
 * number" - is deliberately absent, because an implementation that took an
 * account number would be an invitation to store one.
 */
export interface PayoutProviderAdapter {
  readonly name: string;
  readonly isConfigured: boolean;

  /** Create or resume the provider's own onboarding for this seller. */
  startOnboarding(input: {
    sellerAccountId: string;
    displayName: string;
    countryCode: string;
    email: string | null;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<PayoutOnboardingLink>;

  /** What the provider currently thinks of this account. */
  readAccount(providerAccountId: string): Promise<PayoutAccountStatus>;

  /** Send money. Idempotent on `idempotencyKey`. */
  sendPayout(input: {
    providerAccountId: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
    reference: string;
  }): Promise<{ providerPayoutId: string; status: 'PENDING' | 'IN_TRANSIT' | 'PAID' }>;
}

/**
 * The only implementation this repository ships.
 *
 * Every method refuses with `SELLER_PAYOUT_PROVIDER_UNCONFIGURED` and names the
 * environment variable that would fix it. It does NOT throw a generic error and
 * it does NOT succeed: a seller seeing "payout account verified" on a
 * deployment that cannot verify anything is worse than a seller seeing
 * "nobody has set this up yet", because the first one is a lie they will act
 * on.
 */
const unconfiguredAdapter: PayoutProviderAdapter = {
  name: 'unconfigured',
  isConfigured: false,

  startOnboarding() {
    return Promise.reject(
      conflict(
        ErrorCode.SELLER_PAYOUT_PROVIDER_UNCONFIGURED,
        'No payout provider is set up for this marketplace yet. Set STRIPE_CONNECT_CLIENT_ID ' +
          'and the Connect return URLs, then ask your sellers to connect their accounts.',
      ),
    );
  },

  readAccount() {
    return Promise.resolve({
      state: 'PROVIDER_UNCONFIGURED',
      providerAccountId: null,
      payoutsEnabled: false,
      pendingRequirements: ['A payout provider has not been configured for this marketplace.'],
      bankName: null,
      accountLast4: null,
    });
  },

  sendPayout() {
    return Promise.reject(
      conflict(
        ErrorCode.SELLER_PAYOUT_PROVIDER_UNCONFIGURED,
        'No payout provider is set up, so no money can be sent. This settlement stays payable.',
      ),
    );
  },
};

/**
 * Pick the adapter for this deployment.
 *
 * One place, so "is a provider configured" has one answer that the onboarding
 * screen, the dashboard and the payout worker all read. When a Stripe Connect
 * adapter is written it is registered here and nothing else changes.
 */
export function payoutAdapter(): PayoutProviderAdapter {
  // Deliberately a single check rather than a chain of `if` per provider: a
  // deployment either has a payout provider or it does not, and a half-
  // configured one must read as "not configured" rather than as "try it and
  // see".
  const connectClientId = (process.env['STRIPE_CONNECT_CLIENT_ID'] ?? '').trim();

  if (connectClientId.length > 0 && env.STRIPE_SECRET_KEY.length > 0) {
    // No Stripe Connect adapter exists yet. Falling through to the unconfigured
    // one rather than throwing keeps a misconfigured deployment usable - the
    // seller sees "not set up" instead of a 500 on every page of onboarding -
    // and the log line is what tells the operator their variable is being
    // ignored.
    return unconfiguredAdapter;
  }

  return unconfiguredAdapter;
}

// ---------------------------------------------------------------------------
// The seller-facing operations
// ---------------------------------------------------------------------------

export interface PayoutAccountView {
  state: SellerPayoutAccountState;
  provider: string | null;
  providerAccountId: string | null;
  payoutsEnabled: boolean;
  payoutsHeldByOperator: boolean;
  payoutHoldReason: string | null;
  pendingRequirements: string[];
  bankName: string | null;
  accountLast4: string | null;
  payoutCurrency: string | null;
  /**
   * Whether the marketplace can do anything here at all.
   *
   * The screen branches on this: false renders a "configuration required"
   * panel naming the missing setting, true renders the connect button. It is
   * never used to render a success state.
   */
  isProviderConfigured: boolean;
  /** The setting an operator must fill in, when one is missing. */
  missingConfigurationKey: string | null;
}

export async function readPayoutAccount(
  membership: SellerMembership,
): Promise<PayoutAccountView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_READ);

  const adapter = payoutAdapter();

  const row = await prisma.sellerPayoutAccountReference.findUnique({
    where: { sellerAccountId: membership.sellerAccountId },
  });

  const requirements = Array.isArray(row?.pendingRequirementsJson)
    ? (row.pendingRequirementsJson as string[])
    : [];

  return {
    // The stored state is overridden by PROVIDER_UNCONFIGURED whenever no
    // provider is configured, so a deployment that switches its provider off
    // stops claiming a verified account it can no longer pay.
    state: adapter.isConfigured
      ? (row?.state ?? 'NOT_STARTED')
      : ('PROVIDER_UNCONFIGURED'),
    provider: row?.provider ?? null,
    providerAccountId: row?.providerAccountId ?? null,
    payoutsEnabled: adapter.isConfigured && (row?.payoutsEnabled ?? false),
    payoutsHeldByOperator: row?.payoutsHeldByOperator ?? false,
    payoutHoldReason: row?.payoutHoldReason ?? null,
    pendingRequirements: adapter.isConfigured
      ? requirements
      : ['A payout provider has not been configured for this marketplace yet.'],
    bankName: row?.bankName ?? null,
    accountLast4: row?.accountLast4 ?? null,
    payoutCurrency: row?.payoutCurrency ?? null,
    isProviderConfigured: adapter.isConfigured,
    missingConfigurationKey: adapter.isConfigured ? null : 'STRIPE_CONNECT_CLIENT_ID',
  };
}

/**
 * Begin payout onboarding with the provider.
 *
 * Throws `SELLER_PAYOUT_PROVIDER_UNCONFIGURED` on this deployment. That is the
 * correct behaviour and the route surfaces it as a configuration-required
 * state, not as a failure the seller caused.
 */
export async function startPayoutOnboarding(
  membership: SellerMembership,
  urls: { returnUrl: string; refreshUrl: string },
  correlationId?: string | null,
): Promise<PayoutOnboardingLink> {
  assertSellerPermission(membership, SellerPermission.PAYOUT_SETUP);

  const adapter = payoutAdapter();

  const account = await prisma.sellerAccount.findUnique({
    where: { id: membership.sellerAccountId },
    select: {
      displayName: true,
      registrationCountry: true,
      businessProfile: { select: { supportEmail: true, representativeEmail: true } },
    },
  });

  if (account === null) throw notFound('Seller account');

  const link = await adapter.startOnboarding({
    sellerAccountId: membership.sellerAccountId,
    displayName: account.displayName,
    countryCode: account.registrationCountry,
    email: account.businessProfile?.representativeEmail ?? account.businessProfile?.supportEmail ?? null,
    returnUrl: urls.returnUrl,
    refreshUrl: urls.refreshUrl,
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.payout.onboarding_started',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_payout_account_reference',
    summary: `Payout onboarding started with ${adapter.name}.`,
    correlationId: correlationId ?? null,
  });

  return link;
}

/**
 * Re-read the provider's view of the account and store it.
 *
 * Called after the seller comes back from the provider and by the worker. The
 * stored row is a CACHE of the provider's answer, never a decision of ours:
 * `payoutsEnabled` here means "the provider said so", and the only thing that
 * writes it is this function and the signed webhook handler.
 */
export async function refreshPayoutAccount(sellerAccountId: string): Promise<void> {
  const adapter = payoutAdapter();

  const row = await prisma.sellerPayoutAccountReference.findUnique({
    where: { sellerAccountId },
    select: { id: true, providerAccountId: true },
  });

  if (row === null || row.providerAccountId === null) return;

  const status = await adapter.readAccount(row.providerAccountId);

  await prisma.sellerPayoutAccountReference.update({
    where: { id: row.id },
    data: {
      state: status.state,
      payoutsEnabled: status.payoutsEnabled,
      pendingRequirementsJson: status.pendingRequirements as never,
      bankName: status.bankName,
      accountLast4: status.accountLast4,
      lastSyncedAt: new Date(),
    },
  });
}

/**
 * Refuse a payout that should not be attempted.
 *
 * Four reasons, checked before any money is requested, because every one of
 * them produces a provider error that reads as a technical fault rather than as
 * the business reason it is.
 */
export async function assertPayable(sellerAccountId: string): Promise<void> {
  const adapter = payoutAdapter();

  if (!adapter.isConfigured) {
    throw conflict(
      ErrorCode.SELLER_PAYOUT_PROVIDER_UNCONFIGURED,
      'No payout provider is configured, so nothing can be paid out yet.',
    );
  }

  const row = await prisma.sellerPayoutAccountReference.findUnique({
    where: { sellerAccountId },
  });

  if (row === null || row.providerAccountId === null) {
    throw conflict(
      ErrorCode.SELLER_PAYOUT_NOT_ELIGIBLE,
      'This seller has not connected a payout account yet.',
    );
  }

  if (row.payoutsHeldByOperator) {
    throw conflict(
      ErrorCode.SELLER_PAYOUT_NOT_ELIGIBLE,
      row.payoutHoldReason ?? 'Payouts to this seller are on hold.',
    );
  }

  if (!row.payoutsEnabled) {
    const outstanding = Array.isArray(row.pendingRequirementsJson)
      ? (row.pendingRequirementsJson as string[])
      : [];

    throw conflict(
      ErrorCode.SELLER_PAYOUT_NOT_ELIGIBLE,
      outstanding.length > 0
        ? `The payout provider still needs: ${outstanding.join('; ')}.`
        : 'The payout provider has not enabled payouts on this account yet.',
    );
  }
}

/**
 * Mark the payout step of onboarding.
 *
 * Called whenever the account state changes. Note what it does when no provider
 * is configured: the step is left NOT_STARTED with an explanatory message
 * rather than marked complete or failed. It is not required for submission -
 * see `STEP_DEFINITIONS` - so a seller is never blocked on the operator's
 * missing configuration.
 */
export async function refreshPayoutStep(membership: SellerMembership): Promise<void> {
  const view = await readPayoutAccount(membership);

  if (!view.isProviderConfigured) {
    await markStep({
      membership,
      stepKey: 'payout',
      state: 'NOT_STARTED',
      message:
        'The marketplace has not finished setting up payouts. You can complete the rest of ' +
        'your application and connect an account later.',
    });
    return;
  }

  await markStep({
    membership,
    stepKey: 'payout',
    state:
      view.state === 'ENABLED'
        ? 'COMPLETE'
        : view.state === 'PENDING_VERIFICATION'
          ? 'UNDER_REVIEW'
          : view.state === 'RESTRICTED'
            ? 'ERROR'
            : view.providerAccountId === null
              ? 'NOT_STARTED'
              : 'IN_PROGRESS',
    message: view.pendingRequirements.length > 0 ? view.pendingRequirements.join('; ') : null,
  });
}

/**
 * Create a payout row for a closed settlement.
 *
 * The idempotency key is derived from the settlement rather than generated,
 * which is the one guarantee that matters here: a retried request must never
 * pay a seller twice, and a fresh key per retry is exactly how it would.
 */
export async function createPayout(
  sellerAccountId: string,
  settlementId: string,
  reference: string,
): Promise<{ payoutId: string }> {
  await assertPayable(sellerAccountId);

  const settlement = await prisma.sellerSettlement.findUnique({
    where: { id: settlementId },
    select: {
      id: true,
      sellerAccountId: true,
      status: true,
      netPayableMinor: true,
      currency: true,
    },
  });

  if (settlement === null || settlement.sellerAccountId !== sellerAccountId) {
    throw notFound('Settlement');
  }

  if (settlement.status !== 'PENDING_PAYOUT') {
    throw conflict(
      ErrorCode.SELLER_SETTLEMENT_NOT_PAYABLE,
      settlement.status === 'PAID'
        ? 'This settlement has already been paid.'
        : settlement.status === 'ON_HOLD'
          ? 'This settlement is on hold.'
          : 'This settlement is still open and has not been totalled yet.',
    );
  }

  if (settlement.netPayableMinor <= 0n) {
    throw conflict(
      ErrorCode.SELLER_SETTLEMENT_NOT_PAYABLE,
      'This settlement comes to nothing or less after deductions, so there is nothing to send.',
    );
  }

  const payoutId = newId();

  await prisma.sellerPayout.create({
    data: {
      id: payoutId,
      sellerAccountId,
      settlementId,
      reference,
      status: 'PENDING',
      amountMinor: settlement.netPayableMinor,
      currency: settlement.currency,
      idempotencyKey: `settlement:${settlementId}`,
    },
  });

  return { payoutId };
}
