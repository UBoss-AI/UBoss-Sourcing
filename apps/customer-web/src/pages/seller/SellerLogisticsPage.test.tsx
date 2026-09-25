/**
 * The delivery-control tabs on /seller/logistics.
 *
 * The standalone mode reads "Self Ship". Only the words changed: the mode is
 * still SELF on the wire, in the tab's id and in what the server stores, and
 * "Self + {{team}}" is its own, unchanged label.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Outlet, Route, Routes } from 'react-router-dom';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { PolicyView } from '@/lib/seller-logistics';
import type { SellerOutletContext } from './SellerLayout';
import { SellerLogisticsPage } from './SellerLogisticsPage';

const SELLER = { status: 'APPROVED', displayName: 'Acme Medical' } as unknown as SellerOutletContext;

function policy(mode: 'SELF' | 'UBOSS' | 'HYBRID', active: 'SELF' | 'UBOSS' | 'HYBRID' | null): PolicyView {
  const owners = { L1: 'SELLER', L2: 'SELLER', L3: 'SELLER', L4: 'SELLER' } as const;
  return {
    sellerAccountId: 's1',
    sellerName: 'Acme Medical',
    settlementCurrency: 'INR',
    draft: { mode, owners, version: 1, updatedAt: null },
    active:
      active === null
        ? null
        : { versionId: 'v1', versionNumber: 3, mode: active, owners, publishedAt: '2026-09-01T00:00:00.000Z' },
    hasUnpublishedChanges: false,
    levels: [],
    providers: [],
    routesCanBeOffered: true,
    locations: [],
  };
}

function render(view: PolicyView): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes('/seller/logistics/policy')) return Promise.resolve(jsonResponse({ policy: view }));
      return Promise.resolve(jsonResponse({}));
    }),
  );
  renderWithProviders(
    <Routes>
      <Route element={<Outlet context={SELLER} />}>
        <Route path="/seller/logistics" element={<SellerLogisticsPage />} />
      </Route>
    </Routes>,
    { route: '/seller/logistics' },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('delivery control tabs', () => {
  it('names the standalone mode "Self Ship", beside the two others', async () => {
    render(policy('SELF', 'SELF'));
    const selfShip = await screen.findByRole('tab', { name: /^Self Ship/ });
    expect(screen.getByRole('tab', { name: /^Glovia/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Self \+ Glovia/ })).toBeInTheDocument();
    // The old bare label is gone; the combined one is untouched.
    expect(screen.queryByRole('tab', { name: /^Self$/ })).toBeNull();

    // Still the SELF mode underneath, and the one this draft is on.
    expect(selfShip).toHaveAttribute('id', 'logistics-mode-SELF');
    expect(selfShip).toHaveAttribute('aria-selected', 'true');
  });

  it('opens a saved Self configuration on that tab, and still switches', async () => {
    render(policy('SELF', 'SELF'));
    const hybrid = await screen.findByRole('tab', { name: /^Self \+ Glovia/ });
    fireEvent.click(hybrid);
    expect(hybrid).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^Self Ship/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'logistics-mode-HYBRID');
  });

  it('opens a saved Self + team configuration on its own tab', async () => {
    render(policy('HYBRID', 'HYBRID'));
    expect(await screen.findByRole('tab', { name: /^Self \+ Glovia/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('says "Self Ship" in the published summary too', async () => {
    render(policy('SELF', 'SELF'));
    expect(await screen.findByText(/Self Ship/, { selector: 'p' })).toBeInTheDocument();
  });
});
