/**
 * Seller Hub home: RFQs, inspection and compliance work appear as actions that
 * lead where the work is done, and the workspace links reach every part of the
 * Hub. RFQ rows only where the deployment offers RFQs.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Outlet, Route, Routes } from 'react-router-dom';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { renderWithProviders } from '@/test/harness';
import type { SellerDashboard } from '@/lib/seller';
import type { SellerOutletContext } from './SellerLayout';
import { SellerDashboardPage } from './SellerDashboardPage';

vi.mock('@/lib/seller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/seller')>();
  return { ...actual, fetchDashboard: vi.fn() };
});

const sellerApi = await import('@/lib/seller');
const fetchDashboard = vi.mocked(sellerApi.fetchDashboard);

const DASHBOARD: SellerDashboard = {
  range: 'today',
  periodFrom: '2026-09-30T00:00:00.000Z',
  periodTo: '2026-10-01T00:00:00.000Z',
  newOrders: 0,
  ordersToDispatch: 0,
  overdueOrders: 0,
  grossSales: null,
  netEarnings: null,
  upcomingPayout: null,
  returnsOpen: 0,
  refundsInPeriod: 0,
  activeListings: 4,
  listingsNeedingChanges: 0,
  listingsInReview: 0,
  draftListings: 0,
  lowStockSkus: 0,
  outOfStockSkus: 0,
  qualityScore: null,
  hasNothingYet: false,
  documentsExpiringSoon: [],
  closedLocations: [],
  onboarding: { percentComplete: 100, canSubmit: false, blockingSteps: [] },
  payout: { state: 'ACTIVE', isProviderConfigured: true, missingConfigurationKey: null, pendingRequirements: [] },
  rfqs: { awaitingResponse: 3, closingSoon: 1 },
  inspection: {
    readinessDue: 1,
    capaDue: 2,
    items: [
      { kind: 'READINESS', sellerOrderGroupId: 'G1', sellerOrderNumber: 'SO-1', dueAt: null },
      { kind: 'CAPA', sellerOrderGroupId: 'G2', sellerOrderNumber: 'SO-2', dueAt: null },
    ],
  },
  compliance: { certificatesExpiringSoon: 0, certificatesLapsed: 1, listingsOnHold: 2, verificationNeedsInput: 0 },
  shipmentDocs: {
    ordersHeld: 1,
    sellerActionNeeded: 1,
    items: [
      {
        sellerOrderGroupId: 'G3',
        sellerOrderNumber: 'SO-3',
        missingDocuments: ['Certificate of origin'],
        holdCodes: ['DOCUMENT_MISSING'],
        onSeller: true,
      },
    ],
  },
  settlementHolds: {
    fundsOnHold: 1,
    statementsOnHold: 0,
    amounts: [{ currency: 'EUR', amountMinor: '12500' }],
    payoutsPausedByOperator: false,
    payoutHoldReason: null,
  },
  ordersAtRisk: {
    withinHours: 24,
    count: 1,
    items: [
      {
        sellerOrderGroupId: 'G4',
        sellerOrderNumber: 'SO-4',
        dispatchDueAt: '2026-10-01T10:00:00.000Z',
        reasons: ['DISPATCH_DUE_SOON', 'OPEN_DISPUTE'],
      },
    ],
  },
  unavailable: [],
};

function render(rfq: boolean): void {
  const seller = { isTrading: true, displayName: 'Acme' } as unknown as SellerOutletContext;
  renderWithProviders(
    <Routes>
      <Route element={<Outlet context={seller} />}>
        <Route path="/seller/dashboard" element={<SellerDashboardPage />} />
      </Route>
    </Routes>,
    {
      route: '/seller/dashboard',
      config: { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, rfq } },
    },
  );
}

const hrefs = (): string[] =>
  screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');

describe('the seller home', () => {
  it('links each inspection action to its order and each compliance action to where it is fixed', async () => {
    fetchDashboard.mockResolvedValue(DASHBOARD);
    render(true);

    await waitFor(() => {
      expect(hrefs()).toContain('/seller/orders/G1');
    });
    const links = hrefs();
    expect(links).toContain('/seller/orders/G1');
    expect(links).toContain('/seller/orders/G2');
    expect(links).toContain('/seller/factories');
    expect(links).toContain('/seller/rfqs');
    // The workspace: catalogue, logistics, payouts and performance in one place.
    for (const path of ['/seller/listings', '/seller/logistics', '/seller/payments', '/seller/performance']) {
      expect(links).toContain(path);
    }
  });

  it('queues orders at risk, shipment documents and money on hold, each linked to where it is fixed', async () => {
    fetchDashboard.mockResolvedValue(DASHBOARD);
    render(true);

    expect(await screen.findByText('Order SO-4 is at risk')).toBeInTheDocument();
    expect(
      screen.getByText('Dispatch is due within 24 hours · A claim is open on this order'),
    ).toBeInTheDocument();
    expect(screen.getByText('Shipping documents for SO-3')).toBeInTheDocument();
    expect(screen.getByText('Still needed before dispatch: Certificate of origin')).toBeInTheDocument();
    expect(screen.getByText('Money on hold')).toBeInTheDocument();
    const links = hrefs();
    expect(links).toContain('/seller/orders/G3');
    expect(links).toContain('/seller/orders/G4');
    expect(links).toContain('/seller/payments');
  });

  it('leaves RFQs out where the deployment does not offer them', async () => {
    fetchDashboard.mockResolvedValue(DASHBOARD);
    render(false);

    await waitFor(() => {
      expect(hrefs()).toContain('/seller/performance');
    });
    expect(hrefs()).not.toContain('/seller/rfqs');
  });
});
