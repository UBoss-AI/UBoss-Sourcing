/**
 * Seller Hub → Performance: every rate is shown as a percentage with the
 * counts behind it, a rate over nothing is a dash, and the window buttons ask
 * the server for that window.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import type { SellerPerformance } from '@/lib/seller-performance';
import { SellerPerformancePage } from './SellerPerformancePage';

vi.mock('@/lib/seller-performance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/seller-performance')>();
  return { ...actual, fetchPerformance: vi.fn() };
});

const performanceApi = await import('@/lib/seller-performance');
const fetchPerformance = vi.mocked(performanceApi.fetchPerformance);

const r = (numerator: number, denominator: number): { numerator: number; denominator: number } => ({
  numerator,
  denominator,
});

const DATA: SellerPerformance = {
  days: 90,
  periodFrom: '2026-07-03T00:00:00.000Z',
  periodTo: '2026-10-01T00:00:00.000Z',
  rfq: { invited: 7, quoted: 0, won: 0, conversion: r(0, 0), quoteRate: r(0, 7) },
  orders: { placed: 3, cancelled: 1, delivered: 2, fulfilmentRate: r(2, 2), cancellationRate: r(1, 3) },
  delivery: {
    deliveredInPeriod: 2,
    withoutPromisedDate: 0,
    onTime: r(1, 2),
    inFull: r(1, 2),
    otif: r(1, 4),
    dispatchOnTime: r(2, 2),
  },
  quality: {
    returns: 1,
    returnRate: r(1, 2),
    inspectionsSigned: 1,
    inspectionsFailed: 1,
    inspectionFailRate: r(1, 1),
    openNcrs: 1,
  },
  claims: { opened: 1, open: 1, chargebacks: 0, claimRate: r(1, 3) },
};

describe('seller performance', () => {
  it('shows each rate as a percentage, and nothing measured as a dash', async () => {
    fetchPerformance.mockResolvedValue(DATA);
    renderWithProviders(<SellerPerformancePage />);

    // OTIF 1 of 4.
    expect(await screen.findByText('25%')).toBeInTheDocument();
    // Cancellation and claim rate, 1 of 3.
    expect(screen.getAllByText('33%')).toHaveLength(2);
    // RFQ conversion over no quotes.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(fetchPerformance).toHaveBeenCalledWith(90);
  });

  it('asks for the window the seller picks', async () => {
    fetchPerformance.mockResolvedValue(DATA);
    renderWithProviders(<SellerPerformancePage />);
    await screen.findByText('25%');

    const buttons = screen.getAllByRole('button', { pressed: false });
    const first = buttons[0];
    if (first === undefined) throw new Error('no window button');
    fireEvent.click(first);
    await waitFor(() => {
      expect(fetchPerformance).toHaveBeenCalledWith(30);
    });
  });
});
