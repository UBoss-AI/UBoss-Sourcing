/**
 * Stripe Connect: the payout provider for the facilitator model (D13).
 *
 * Each seller gets an Express connected account that Stripe onboards and
 * verifies - bank details, identity, tax - on Stripe's own pages. This
 * deployment stores the `acct_...` id and what Stripe last said about it,
 * never a bank account number.
 *
 * A payout is a Stripe **transfer** from the platform balance to the
 * connected account. Stripe then pays the connected account's bank on the
 * account's own schedule; that leg is Stripe's and is shown as
 * `lastBankPayoutStatus` when Stripe reports it.
 *
 * Amounts are integer minor units, Stripe's own unit, so the BigInt crosses
 * the boundary as a decimal string with no conversion.
 */
import { conflict, ErrorCode } from '../../domain/errors.js';
import { logger } from '../../infra/logger.js';
import type {
  PayoutAccountStatus,
  PayoutOnboardingLink,
  PayoutProviderAdapter,
  ProviderTransfer,
} from './payout.service.js';

const API_BASE = 'https://api.stripe.com/v1';
const REQUEST_TIMEOUT_MS = 20_000;

type Form = Record<string, string>;

function encode(form: Form): string {
  return Object.entries(form)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

interface StripeAccount {
  id: string;
  details_submitted?: boolean;
  payouts_enabled?: boolean;
  charges_enabled?: boolean;
  default_currency?: string;
  requirements?: { currently_due?: string[]; past_due?: string[]; disabled_reason?: string | null };
  external_accounts?: {
    data?: { bank_name?: string | null; last4?: string | null; status?: string | null; currency?: string | null }[];
  };
}

/** Stripe's requirement keys, made readable: `individual.id_number` -> "individual id number". */
function readable(requirement: string): string {
  return requirement.replace(/[._]/g, ' ');
}

export function mapStripeAccount(account: StripeAccount): PayoutAccountStatus {
  const due = [...(account.requirements?.past_due ?? []), ...(account.requirements?.currently_due ?? [])];
  const bank = account.external_accounts?.data?.[0];
  const payoutsEnabled = account.payouts_enabled === true;

  const disabled = account.requirements?.disabled_reason ?? '';
  const state: PayoutAccountStatus['state'] = payoutsEnabled
    ? 'ENABLED'
    : disabled.startsWith('rejected')
      ? 'RESTRICTED'
      : due.length > 0 || account.details_submitted !== true
        ? 'REQUIREMENTS_DUE'
        : 'PENDING_VERIFICATION';

  return {
    state,
    providerAccountId: account.id,
    payoutsEnabled,
    pendingRequirements: [...new Set(due.map(readable))],
    bankName: bank?.bank_name ?? null,
    accountLast4: bank?.last4 ?? null,
    bankAccountStatus: bank?.status ?? null,
    detailsSubmitted: account.details_submitted === true,
    payoutCurrency: (bank?.currency ?? account.default_currency ?? null)?.toUpperCase() ?? null,
  };
}

export function stripeConnectAdapter(secretKey: string): PayoutProviderAdapter {
  async function call<T>(method: 'GET' | 'POST', path: string, form?: Form, idempotencyKey?: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(idempotencyKey !== undefined ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(form !== undefined ? { body: encode(form) } : {}),
        signal: controller.signal,
      });
      const parsed = (await response.json().catch(() => null)) as
        | (T & { error?: { code?: string; message?: string } })
        | null;
      if (!response.ok || parsed === null) {
        // The body is not logged: Stripe echoes request fields, one of which
        // can be the seller's email.
        logger.warn({ httpStatus: response.status, path, providerCode: parsed?.error?.code }, 'stripe connect request failed');
        throw conflict(
          ErrorCode.SELLER_PAYOUT_NOT_ELIGIBLE,
          parsed?.error?.message ?? `Stripe refused the request (HTTP ${String(response.status)}).`,
        );
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'stripe_connect',
    isConfigured: true,

    async startOnboarding(input): Promise<PayoutOnboardingLink> {
      let accountId = input.existingProviderAccountId;
      if (accountId === null) {
        const created = await call<StripeAccount>(
          'POST',
          '/accounts',
          {
            type: 'express',
            country: input.countryCode,
            ...(input.email !== null ? { email: input.email } : {}),
            'capabilities[transfers][requested]': 'true',
            'business_profile[name]': input.displayName,
            'metadata[sellerAccountId]': input.sellerAccountId,
          },
          `connect-account:${input.sellerAccountId}`,
        );
        accountId = created.id;
      }
      const link = await call<{ url: string; expires_at: number }>('POST', '/account_links', {
        account: accountId,
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
        type: 'account_onboarding',
      });
      return { url: link.url, expiresAt: new Date(link.expires_at * 1000), providerAccountId: accountId };
    },

    async readAccount(providerAccountId): Promise<PayoutAccountStatus> {
      return mapStripeAccount(await call<StripeAccount>('GET', `/accounts/${encodeURIComponent(providerAccountId)}`));
    },

    async sendPayout(input) {
      const transfer = await call<{ id: string }>(
        'POST',
        '/transfers',
        {
          amount: input.amountMinor.toString(),
          currency: input.currency.toLowerCase(),
          destination: input.providerAccountId,
          transfer_group: input.reference,
          'metadata[reference]': input.reference,
        },
        input.idempotencyKey,
      );
      // A transfer is complete when Stripe accepts it: the money is in the
      // connected account's balance. Its bank payout is the account's own.
      return { providerPayoutId: transfer.id, status: 'PAID' as const };
    },

    async listTransfers(since, until): Promise<ProviderTransfer[]> {
      const out: ProviderTransfer[] = [];
      let startingAfter: string | null = null;
      for (let page = 0; page < 50; page += 1) {
        const query: string[] = [
          'limit=100',
          `created[gte]=${String(Math.floor(since.getTime() / 1000))}`,
          `created[lt]=${String(Math.floor(until.getTime() / 1000))}`,
        ];
        if (startingAfter !== null) query.push(`starting_after=${startingAfter}`);
        const result = await call<{
          data: { id: string; amount: number; currency: string; destination: string; reversed?: boolean }[];
          has_more: boolean;
        }>('GET', `/transfers?${query.join('&')}`);
        for (const row of result.data) {
          out.push({
            id: row.id,
            amountMinor: BigInt(row.amount),
            currency: row.currency.toUpperCase(),
            destination: row.destination,
          });
        }
        if (!result.has_more || result.data.length === 0) break;
        startingAfter = result.data[result.data.length - 1]?.id ?? null;
      }
      return out;
    },
  };
}
