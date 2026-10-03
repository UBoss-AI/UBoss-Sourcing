import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UniversalSearchPage } from './UniversalSearchPage';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/catalog/products')) return Promise.resolve(jsonResponse({ products: [{ slug: 'nitrile-gloves', name: 'Nitrile gloves' }], pagination: {} }));
    if (url.includes('/catalog/suppliers')) return Promise.resolve(jsonResponse({ suppliers: [{ slug: 'acme', displayName: 'Acme Medical' }] }));
    return Promise.resolve(jsonResponse({ orders: [{ id: 'o1', orderNumber: 'ORD-77' }], invoices: [{ id: 'i1', number: 'INV-77', orderId: 'o1' }], shipments: [{ id: 's1', trackingNumber: 'TRK77', orderId: 'o1' }], rfqs: [{ id: 'r1', reference: 'RFQ-77', title: 'Gloves' }] }));
  });
});
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

describe('universal search (ENH-004)', () => {
  it('shows products, suppliers, the buyer’s own records and help in one place', async () => {
    renderWithProviders(<UniversalSearchPage />, { route: '/find?q=77', session: makeSession({ isCustomer: true }) });
    expect(await screen.findByRole('link', { name: 'Nitrile gloves' })).toHaveAttribute('href', '/product/nitrile-gloves');
    expect(await screen.findByRole('link', { name: 'Acme Medical' })).toHaveAttribute('href', '/suppliers/acme');
    expect(await screen.findByRole('link', { name: 'Order ORD-77' })).toHaveAttribute('href', '/account/orders/o1');
    expect(screen.getByRole('link', { name: 'Invoice INV-77' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Shipment TRK77' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request RFQ-77: Gloves' })).toHaveAttribute('href', '/account/rfqs/r1');
  });
  it('does not ask for account records when signed out', async () => {
    renderWithProviders(<UniversalSearchPage />, { route: '/find?q=support', session: makeSession({ isCustomer: false }) });
    expect(await screen.findByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support');
    expect(screen.queryByText('Your records')).toBeNull();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/account/search'))).toBe(false);
  });
});
