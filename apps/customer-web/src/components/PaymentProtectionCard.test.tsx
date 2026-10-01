/**
 * The buyer's view of how their payment is held (checklist Master row 58):
 * method, currency, status, the disclosed terms and a milestone per seller.
 */
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import { PaymentProtectionCard } from './PaymentProtectionCard';

const fetchPaymentProtection = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/lib/finance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/finance')>();
  return { ...actual, fetchPaymentProtection: (...args: unknown[]) => fetchPaymentProtection(...args) };
});

const base = {
  orderId: 'O'.repeat(26),
  orderNumber: 'ORD-1',
  currency: 'INR',
  grandTotalMinor: '100000',
  paidMinor: '100000',
  refundedMinor: '0',
  protectionEnabled: true,
  releaseTerms: { requiresDelivery: true, releaseAfterDays: 7, disputeBlocksRelease: true, inspectionRequired: false, reserveBps: 0, reserveDays: 0 },
  sellers: [
    {
      sellerOrderNumber: 'SO-9',
      sellerName: 'North Mills',
      orderStatus: 'DELIVERED',
      fundsStatus: 'ON_HOLD',
      onHoldForDispute: true,
      conditions: [
        { key: 'DELIVERED', met: true, at: '2026-10-01T00:00:00Z' },
        { key: 'NO_OPEN_DISPUTE', met: false, at: null },
      ],
      releasedAt: null,
    },
  ],
  receipts: [],
};

beforeEach(() => {
  fetchPaymentProtection.mockReset();
});

describe('PaymentProtectionCard', () => {
  it('shows the payment method, each seller milestone and its conditions', async () => {
    fetchPaymentProtection.mockResolvedValue({
      ...base,
      payment: { status: 'CAPTURED', method: 'card', provider: 'STRIPE', currency: 'INR', cardBrand: 'visa', cardLast4: '4242', capturedAt: null },
    });
    renderWithProviders(<PaymentProtectionCard orderId={base.orderId} />);
    expect(await screen.findByText('visa ···· 4242')).toBeInTheDocument();
    expect(screen.getByText(/North Mills/)).toBeInTheDocument();
    expect(screen.getByText('SO-9')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    expect(fetchPaymentProtection).toHaveBeenCalledWith(base.orderId);
  });

  it('renders nothing before the order is paid', async () => {
    fetchPaymentProtection.mockResolvedValue({ ...base, payment: null });
    const { container } = renderWithProviders(<PaymentProtectionCard orderId={base.orderId} />);
    await vi.waitFor(() => {
      expect(fetchPaymentProtection).toHaveBeenCalled();
    });
    expect(container.querySelector('section')).toBeNull();
  });
});
