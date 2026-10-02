/**
 * Seller Hub → Payments, the statements a seller is shown.
 *
 *   - a period is shown as the days it covers, in UTC: an October statement
 *     reads 1 October to 31 October wherever the seller is, although its end
 *     is stored as 1 November 00:00;
 *   - each line is labelled by its kind in the reader's language, followed by
 *     the order number it is about - the stored description carries no words;
 *   - the net is what the server sent, never a sum made in the browser.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Outlet, Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '@/test/harness';
import type { SettlementRow } from '@/lib/seller';
import type { SellerOutletContext } from './SellerLayout';
import { SellerPaymentsPage } from './SellerPaymentsPage';

vi.mock('@/lib/seller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/seller')>();
  return {
    ...actual,
    fetchSettlements: vi.fn(),
    fetchSettlementLines: vi.fn(),
    fetchSettlementFunds: vi.fn(),
    fetchPayouts: vi.fn(),
    // Left pending: the payout card is not what these tests are about.
    fetchPayoutAccount: vi.fn(() => new Promise(() => undefined)),
    refreshPayoutAccount: vi.fn(),
  };
});

const sellerApi = await import('@/lib/seller');
const fetchSettlements = vi.mocked(sellerApi.fetchSettlements);
const fetchSettlementLines = vi.mocked(sellerApi.fetchSettlementLines);
const fetchPayouts = vi.mocked(sellerApi.fetchPayouts);
const fetchSettlementFunds = vi.mocked(sellerApi.fetchSettlementFunds);
fetchSettlementFunds.mockResolvedValue({ currencies: [], payoutsPausedByOperator: false, payoutHoldReason: null });

const OCTOBER: SettlementRow = {
  id: '01STATEMENT000000000000000',
  reference: 'STL-2026-10-0001',
  status: 'PENDING_PAYOUT',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  currency: 'INR',
  grossMinor: '105000',
  commissionMinor: '11800',
  processingFeeMinor: '0',
  refundsMinor: '0',
  adjustmentsMinor: '0',
  netPayableMinor: '93200',
  holdReason: null,
};

function render(): void {
  const seller = { isTrading: true } as unknown as SellerOutletContext;
  renderWithProviders(
    <Routes>
      <Route element={<Outlet context={seller} />}>
        <Route path="/seller/payments" element={<SellerPaymentsPage />} />
      </Route>
    </Routes>,
    { route: '/seller/payments' },
  );
}

describe('a seller statement', () => {
  it('shows the days it covers, in UTC, with its reference', async () => {
    fetchSettlements.mockResolvedValue({ settlements: [OCTOBER], total: 1 });
    fetchPayouts.mockResolvedValue({ payouts: [] });
    render();

    expect(await screen.findByText('STL-2026-10-0001')).toBeInTheDocument();
    const from = new Date('2026-10-01T00:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC' });
    const to = new Date('2026-10-31T12:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC' });
    expect(screen.getByText(`From ${from} until ${to}`)).toBeInTheDocument();
  });

  it('labels each line by its kind, then the order it is about', async () => {
    fetchSettlements.mockResolvedValue({ settlements: [OCTOBER], total: 1 });
    fetchPayouts.mockResolvedValue({ payouts: [] });
    fetchSettlementLines.mockResolvedValue({
      lines: [
        { id: 'l1', kind: 'SALE', amountMinor: '100000', currency: 'INR', description: 'SO-01043', reason: null, orderGroupId: 'g1', occurredAt: '2026-10-05T12:00:00.000Z' },
        { id: 'l2', kind: 'COMMISSION', amountMinor: '-10000', currency: 'INR', description: 'SO-01043', reason: null, orderGroupId: 'g1', occurredAt: '2026-10-05T12:00:00.000Z' },
        { id: 'l3', kind: 'SHIPPING_CHARGE', amountMinor: '5000', currency: 'INR', description: 'SO-01043', reason: null, orderGroupId: 'g1', occurredAt: '2026-10-05T12:00:00.000Z' },
      ],
    });
    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Show every line' }));

    expect(await screen.findByText('Sale · SO-01043')).toBeInTheDocument();
    expect(screen.getByText('Marketplace commission · SO-01043')).toBeInTheDocument();
    expect(screen.getByText('Your delivery charge · SO-01043')).toBeInTheDocument();
  });

  it('labels the fee tax and an inspection fee, and says when there is no logistics charge (JOURNEY-034)', async () => {
    fetchSettlements.mockResolvedValue({ settlements: [OCTOBER], total: 1 });
    fetchPayouts.mockResolvedValue({ payouts: [] });
    fetchSettlementLines.mockResolvedValue({
      lines: [
        { id: 'l1', kind: 'COMMISSION_TAX', amountMinor: '-1800', currency: 'INR', description: 'SO-01043', reason: null, orderGroupId: 'g1', occurredAt: '2026-10-05T12:00:00.000Z' },
        { id: 'l2', kind: 'INSPECTION_FEE', amountMinor: '-4000', currency: 'INR', description: 'SO-01043', reason: null, orderGroupId: 'g1', occurredAt: '2026-10-05T12:00:00.000Z' },
      ],
    });
    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Show every line' }));
    expect(await screen.findByText('Tax on the commission · SO-01043')).toBeInTheDocument();
    expect(screen.getByText('Inspection fee · SO-01043')).toBeInTheDocument();
    expect(screen.getByText(/^Logistics charges: none\./)).toBeInTheDocument();
    expect(screen.queryByText('Inspection charges: none on this statement.')).not.toBeInTheDocument();
  });

  it('offers the statement as a CSV file and shows money not on a statement yet (JOURNEY-034)', async () => {
    fetchSettlements.mockResolvedValue({ settlements: [OCTOBER], total: 1 });
    fetchPayouts.mockResolvedValue({ payouts: [] });
    fetchSettlementFunds.mockResolvedValueOnce({
      currencies: [{ currency: 'INR', heldMinor: '50000', onHoldMinor: '20000', reserveMinor: '5000', nextReserveReleaseAt: null }],
      payoutsPausedByOperator: true,
      payoutHoldReason: 'Open claim on SO-01043',
    });
    render();

    const download = await screen.findByRole('link', { name: 'Download CSV' });
    expect(download.getAttribute('href')).toContain('/seller/settlements/01STATEMENT000000000000000/export.csv');
    expect(screen.getByRole('link', { name: 'Download statements as CSV' }).getAttribute('href')).toContain(
      '/seller/settlements/export.csv?from=',
    );
    expect(await screen.findByText('Not on a statement yet')).toBeInTheDocument();
    expect(screen.getByText('Payouts are paused: Open claim on SO-01043')).toBeInTheDocument();
  });
});
