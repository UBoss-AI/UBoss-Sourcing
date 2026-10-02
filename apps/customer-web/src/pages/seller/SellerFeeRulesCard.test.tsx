/**
 * Seller Hub -> Payments: the fee rules that can change the seller's fee
 * (checklist JOURNEY-054). Read-only; live and upcoming rules are told apart,
 * and the screen says a rule never reaches an order already settled.
 */
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import { SellerFeeRulesCard } from './SellerFeeRulesCard';

const fetchSellerFeeRules = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/lib/finance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/finance')>();
  return { ...actual, fetchSellerFeeRules: (...args: unknown[]) => fetchSellerFeeRules(...args) };
});

const base = {
  scope: 'GLOBAL',
  marketCountry: null,
  categoryName: null,
  currency: null,
  minValue: null,
  maxValue: null,
  volumeThreshold: null,
  volumeWindowDays: null,
  sellerTier: null,
  percentRate: null,
  discountPercent: null,
  effectiveTo: null,
};

beforeEach(() => {
  fetchSellerFeeRules.mockReset();
});

describe('SellerFeeRulesCard', () => {
  it('lists live and upcoming rules with their terms, and the seller tier', async () => {
    fetchSellerFeeRules.mockResolvedValue({
      feeTier: 'GOLD',
      rules: [
        { ...base, id: 'R1', kind: 'SELLER_TIER', name: 'Gold sellers', sellerTier: 'GOLD', percentRate: '5', effectiveFrom: '2026-10-01T00:00:00.000Z', upcoming: false },
        {
          ...base,
          id: 'R2',
          kind: 'PROMOTION',
          scope: 'CATEGORY',
          categoryName: 'Textiles',
          name: 'Textile launch',
          discountPercent: '20',
          effectiveFrom: '2026-11-01T00:00:00.000Z',
          effectiveTo: '2026-12-01T00:00:00.000Z',
          upcoming: true,
        },
      ],
    });
    renderWithProviders(<SellerFeeRulesCard />);

    const list = await screen.findByRole('list', { name: 'Fee rules that apply to you' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Sellers in tier GOLD: fee 5%');
    expect(items[0]?.textContent).toContain('In force');
    expect(items[1]?.textContent).toContain('20% off the fee');
    expect(items[1]?.textContent).toContain('category Textiles');
    expect(items[1]?.textContent).toContain('Starts later');
    expect(screen.getByText('Your fee tier: GOLD')).toBeTruthy();
    expect(screen.getByText(/Orders already settled keep the fee they were given/)).toBeTruthy();
    // Read-only: nothing to press.
    expect(within(list).queryByRole('button')).toBeNull();
  });

  it('says so when no rule applies', async () => {
    fetchSellerFeeRules.mockResolvedValue({ feeTier: null, rules: [] });
    renderWithProviders(<SellerFeeRulesCard />);
    expect(await screen.findByText('No fee rules apply to you')).toBeTruthy();
    expect(screen.getByText('You are not in a fee tier.')).toBeTruthy();
  });
});
