/**
 * Seller Hub payments (checklist Master rows 43 and 12): receivables, held
 * funds per order, and connecting the Stripe payout account.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import { ConnectPayoutAccount, SellerFundsPanel } from './SellerFundsPanel';

const fetchSellerFinance = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const fetchSellerHolds = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const fetchPayoutAccount = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const startPayoutOnboarding = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/lib/finance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/finance')>();
  return {
    ...actual,
    fetchSellerFinance: (...args: unknown[]) => fetchSellerFinance(...args),
    fetchSellerHolds: (...args: unknown[]) => fetchSellerHolds(...args),
  };
});
vi.mock('@/lib/seller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/seller')>();
  return {
    ...actual,
    fetchPayoutAccount: (...args: unknown[]) => fetchPayoutAccount(...args),
    startPayoutOnboarding: (...args: unknown[]) => startPayoutOnboarding(...args),
  };
});

const terms = { requiresDelivery: true, releaseAfterDays: 7, disputeBlocksRelease: true, inspectionRequired: false, reserveBps: 1000, reserveDays: 30 };

beforeEach(() => {
  fetchSellerFinance.mockReset();
  fetchSellerHolds.mockReset();
  fetchPayoutAccount.mockReset();
  startPayoutOnboarding.mockReset();
});

describe('SellerFundsPanel', () => {
  it('shows each balance from the ledger and every held order with its conditions', async () => {
    fetchSellerFinance.mockResolvedValue({
      enabled: true,
      releaseTerms: terms,
      lastReconciledAt: null,
      balances: [
        {
          currency: 'INR',
          grossSalesMinor: '100000',
          platformFeesMinor: '10000',
          platformFeeTaxMinor: '1800',
          refundsChargedMinor: '0',
          heldMinor: '0',
          reserveMinor: '8820',
          availableMinor: '79380',
          inTransitMinor: '0',
          paidOutMinor: '0',
        },
      ],
    });
    fetchSellerHolds.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 'H1',
          sellerOrderGroupId: 'G1',
          sellerOrderNumber: 'SO-77',
          currency: 'INR',
          status: 'RELEASED',
          allocatedMinor: '88200',
          releasedMinor: '79380',
          reserveMinor: '8820',
          conditions: [{ key: 'DELIVERED', met: true, at: null }],
          holdCode: null,
          holdReason: null,
          releasedAt: null,
          reserveReleaseAt: null,
          payout: { reference: 'PO-1', status: 'PAID' },
        },
      ],
    });
    renderWithProviders(<SellerFundsPanel />);
    expect(await screen.findByText('SO-77')).toBeInTheDocument();
    const balances = await screen.findByLabelText('INR');
    expect(balances.querySelectorAll('dd')).toHaveLength(9);
    expect(balances.textContent).toContain('793.80');
  });

  it('renders nothing when held funds are switched off', async () => {
    fetchSellerFinance.mockResolvedValue({ enabled: false, releaseTerms: terms, balances: [], lastReconciledAt: null });
    fetchSellerHolds.mockResolvedValue({ items: [], total: 0 });
    const { container } = renderWithProviders(<SellerFundsPanel />);
    await waitFor(() => {
      expect(fetchSellerFinance).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });
});

describe('ConnectPayoutAccount', () => {
  it('starts Stripe onboarding and lists what Stripe still needs', async () => {
    fetchPayoutAccount.mockResolvedValue({
      state: 'REQUIREMENTS_DUE',
      provider: 'stripe_connect',
      providerAccountId: 'acct_123',
      payoutsEnabled: false,
      payoutsHeldByOperator: false,
      payoutHoldReason: null,
      pendingRequirements: ['external account'],
      bankName: null,
      accountLast4: null,
      payoutCurrency: null,
      bankAccountStatus: null,
      detailsSubmitted: false,
      lastSyncedAt: null,
      isProviderConfigured: true,
      missingConfigurationKey: null,
    });
    startPayoutOnboarding.mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<ConnectPayoutAccount />);
    expect(await screen.findByText('acct_123')).toBeInTheDocument();
    expect(screen.getByText('external account')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(startPayoutOnboarding).toHaveBeenCalledTimes(1);
    });
  });

  it('shows nothing when no payout provider is configured', async () => {
    fetchPayoutAccount.mockResolvedValue({ isProviderConfigured: false, pendingRequirements: [] });
    const { container } = renderWithProviders(<ConnectPayoutAccount />);
    await waitFor(() => {
      expect(fetchPayoutAccount).toHaveBeenCalled();
    });
    expect(container.querySelector('button')).toBeNull();
  });
});
