/**
 * The settlement preview asks for the fee a real order would pay.
 *
 * A market or category fee policy applies to an order by the buyer's country
 * and the product's category. The preview used to send neither, so it could
 * quote a fee no order would ever be charged. It now sends the market (the
 * seller's own to start with) and, once chosen, one of the seller's listings.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocale, renderWithProviders } from '@/test/harness';
import { SettlementPreviewCard } from './SettlementPreviewCard';

const fetchSettlementEstimate = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const fetchOffers = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/lib/seller-logistics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/seller-logistics')>();
  return { ...actual, fetchSettlementEstimate: (...args: unknown[]) => fetchSettlementEstimate(...args) };
});
vi.mock('@/lib/seller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/seller')>();
  return { ...actual, fetchOffers: (...args: unknown[]) => fetchOffers(...args) };
});

const money = (minor: string) => ({ amountMinor: minor, currency: 'INR', formatted: `₹${minor}` });

beforeEach(() => {
  fetchSettlementEstimate.mockReset();
  fetchSettlementEstimate.mockResolvedValue({
    estimate: {
      currency: 'INR',
      grossProceeds: money('10000'),
      sellerDeliveryProceeds: money('0'),
      ubossDelivery: money('0'),
      feeBasis: money('10000'),
      platformFee: money('0'),
      platformFeeTax: money('0'),
      refundsAdjustments: money('0'),
      estimatedSettlement: money('10000'),
      feeTaxLabel: 'Tax',
      feeTaxVerified: false,
      feeTaxRatePercent: '0',
      policy: null,
    },
  });
  fetchOffers.mockReset();
  fetchOffers.mockResolvedValue({
    rows: [{ id: 'offer-gloves', productName: 'Nitrile gloves', sellerSku: 'GL-1' }],
    total: 1,
    counts: {},
  });
});

const locale = makeLocale({
  country: 'IN',
  countries: [
    { code: 'IN', name: 'India', currencyCode: 'INR', phonePrefix: '+91' },
    { code: 'DE', name: 'Germany', currencyCode: 'EUR', phonePrefix: '+49' },
  ],
});

describe('SettlementPreviewCard', () => {
  it('sends the seller’s market from the start', async () => {
    renderWithProviders(<SettlementPreviewCard currency="INR" />, { locale });

    await waitFor(() => {
      expect(fetchSettlementEstimate).toHaveBeenCalledWith(expect.objectContaining({ marketCountry: 'IN' }));
    });
  });

  it('sends the chosen market and listing, so their fee policies apply', async () => {
    renderWithProviders(<SettlementPreviewCard currency="INR" />, { locale });

    fireEvent.change(await screen.findByLabelText("Buyer's country"), { target: { value: 'DE' } });
    fireEvent.change(await screen.findByLabelText('Listing'), { target: { value: 'offer-gloves' } });

    await waitFor(() => {
      expect(fetchSettlementEstimate).toHaveBeenCalledWith(
        expect.objectContaining({ marketCountry: 'DE', offerId: 'offer-gloves' }),
      );
    });
  });
});
