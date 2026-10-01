/**
 * Reports → marketplace: GMV per currency, the supplier quality table with each
 * rate shown as its counts, and the settlement card only for payment.read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import { MarketplaceReports, type MarketplaceReport, type SettlementReport } from './MarketplaceReports';

let canPay = true;
vi.mock('@/auth/session-context', () => ({ useSession: () => ({ can: () => canPay }) }));
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

const money = (minor: string, formatted: string): { minor: string; formatted: string; currency: string } => ({
  minor,
  formatted,
  currency: 'INR',
});

const REPORT: MarketplaceReport = {
  gmv: {
    byCurrency: [{ currency: 'INR', orders: 4, gmv: money('4000000', '40000.00'), discount: money('0', '0.00') }],
    sellerGmv: [{ currency: 'INR', sellerOrders: 3, gmv: money('3000000', '30000.00'), commission: money('300000', '3000.00') }],
  },
  supplierQuality: [
    {
      sellerAccountId: 'S1',
      displayName: 'Acme Supplies',
      orders: 4,
      cancelled: 0,
      returns: 1,
      claims: 2,
      inspections: 0,
      inspectionFails: 0,
    },
  ],
  inspection: {
    requirementsByStatus: [{ status: 'FAILED', count: 1 }],
    jobsByStatus: [],
    signed: 2,
    failed: 1,
    openNcrsBySeverity: [],
    overdueReports: 0,
  },
  disputes: { byStatus: [{ kind: 'CLAIM', status: 'AWAITING_SELLER', count: 2 }], byResolution: [], awarded: [], sellerResponseOverdue: 1 },
};

const SETTLEMENTS: SettlementReport = {
  settlements: [
    {
      status: 'ON_HOLD',
      currency: 'INR',
      count: 1,
      gross: money('2000000', '20000.00'),
      commission: money('200000', '2000.00'),
      refunds: money('0', '0.00'),
      netPayable: money('1800000', '18000.00'),
    },
  ],
  payouts: [],
  failedPayoutsOpen: 0,
  settlementsOnHold: 1,
};

function show(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <MemoryRouter>
          <MarketplaceReports range={{ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }} />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
  canPay = true;
  vi.mocked(api.get).mockImplementation((path: string) =>
    Promise.resolve(path.endsWith('/settlements') ? SETTLEMENTS : REPORT),
  );
});

describe('marketplace reports', () => {
  it('shows supplier quality as counts over orders, and claims and returns per seller', async () => {
    show();
    expect(await screen.findByText('Acme Supplies')).toBeInTheDocument();
    expect(screen.getByText('1 / 4 (25%)')).toBeInTheDocument();
    expect(screen.getByText('2 / 4 (50%)')).toBeInTheDocument();
    // No inspection signed: a dash, never 0%.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // Inspection fail rate over the reports signed.
    expect(screen.getByText('1 / 2 (50%)')).toBeInTheDocument();
  });

  it('asks for the window it was given, and fetches settlements for payment.read', async () => {
    show();
    await screen.findByText('Acme Supplies');
    expect(api.get).toHaveBeenCalledWith('/admin/reports/marketplace', {
      query: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    });
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/admin/reports/settlements', expect.any(Object));
    });
  });

  it('never asks for settlements without payment.read', async () => {
    canPay = false;
    show();
    await screen.findByText('Acme Supplies');
    expect(api.get).not.toHaveBeenCalledWith('/admin/reports/settlements', expect.any(Object));
  });
});
