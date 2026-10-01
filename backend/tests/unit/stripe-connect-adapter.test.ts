/**
 * The Stripe Connect payout adapter, against a stubbed `fetch` - no request
 * leaves this machine. Checks what is sent (account, account link, transfer
 * with an idempotency key) and how Stripe's account is read back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapStripeAccount, stripeConnectAdapter } from '../../src/modules/seller/stripe-connect.adapter.js';

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Stripe Connect adapter', () => {
  it('creates an Express account once, then an onboarding link for it', async () => {
    const calls: { url: string; body: string; key: string | undefined }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input as string;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, body: (init?.body as string | undefined) ?? '', key: headers['Idempotency-Key'] });
      if (url.endsWith('/accounts')) return Promise.resolve(respond({ id: 'acct_123' }));
      return Promise.resolve(respond({ url: 'https://connect.stripe.com/setup/e/acct_123/x', expires_at: 1_900_000_000 }));
    });
    const adapter = stripeConnectAdapter('sk_test_x');
    const link = await adapter.startOnboarding({
      sellerAccountId: 'S'.repeat(26),
      existingProviderAccountId: null,
      displayName: 'North Ltd',
      countryCode: 'IN',
      email: 'owner@north.test',
      returnUrl: 'https://shop.test/r',
      refreshUrl: 'https://shop.test/f',
    });
    expect(link.providerAccountId).toBe('acct_123');
    expect(calls[0]?.body).toContain('type=express');
    expect(calls[0]?.body).toContain('capabilities%5Btransfers%5D%5Brequested%5D=true');
    expect(calls[0]?.key).toBe(`connect-account:${'S'.repeat(26)}`);
    expect(calls[1]?.body).toContain('account=acct_123');
    expect(calls[1]?.body).toContain('type=account_onboarding');

    calls.length = 0;
    await adapter.startOnboarding({
      sellerAccountId: 'S'.repeat(26),
      existingProviderAccountId: 'acct_123',
      displayName: 'North Ltd',
      countryCode: 'IN',
      email: null,
      returnUrl: 'https://shop.test/r',
      refreshUrl: 'https://shop.test/f',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/account_links$/);
  });

  it('sends a payout as a transfer with the payout idempotency key', async () => {
    let sent = '';
    let key: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      sent = (init?.body as string | undefined) ?? '';
      key = ((init?.headers ?? {}) as Record<string, string>)['Idempotency-Key'];
      return Promise.resolve(respond({ id: 'tr_1' }));
    });
    const result = await stripeConnectAdapter('sk_test_x').sendPayout({
      providerAccountId: 'acct_123',
      amountMinor: 8_820_000_000_000n,
      currency: 'INR',
      idempotencyKey: 'ledger-payout:P1',
      reference: 'PO-P1',
    });
    expect(result).toEqual({ providerPayoutId: 'tr_1', status: 'PAID' });
    expect(sent).toContain('amount=8820000000000');
    expect(sent).toContain('currency=inr');
    expect(sent).toContain('destination=acct_123');
    expect(key).toBe('ledger-payout:P1');
  });

  it('turns a Stripe refusal into SELLER_PAYOUT_NOT_ELIGIBLE with Stripe\'s message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({ error: { code: 'insufficient_capabilities', message: 'No transfers capability' } }, 400));
    await expect(
      stripeConnectAdapter('sk_test_x').sendPayout({ providerAccountId: 'acct_1', amountMinor: 1n, currency: 'EUR', idempotencyKey: 'k', reference: 'r' }),
    ).rejects.toMatchObject({ code: 'SELLER_PAYOUT_NOT_ELIGIBLE', message: 'No transfers capability' });
  });

  it('reads the account state, requirements and bank account from Stripe', () => {
    expect(
      mapStripeAccount({
        id: 'acct_1',
        details_submitted: true,
        payouts_enabled: true,
        external_accounts: { data: [{ bank_name: 'HDFC', last4: '6789', status: 'verified', currency: 'inr' }] },
      }),
    ).toMatchObject({ state: 'ENABLED', payoutsEnabled: true, bankName: 'HDFC', accountLast4: '6789', bankAccountStatus: 'verified', payoutCurrency: 'INR' });
    expect(
      mapStripeAccount({ id: 'acct_2', details_submitted: false, requirements: { currently_due: ['external_account', 'individual.id_number'] } }),
    ).toMatchObject({ state: 'REQUIREMENTS_DUE', pendingRequirements: ['external account', 'individual id number'] });
    expect(mapStripeAccount({ id: 'acct_3', details_submitted: true })).toMatchObject({ state: 'PENDING_VERIFICATION' });
    expect(mapStripeAccount({ id: 'acct_4', details_submitted: true, requirements: { disabled_reason: 'rejected.fraud' } })).toMatchObject({ state: 'RESTRICTED' });
  });
});
