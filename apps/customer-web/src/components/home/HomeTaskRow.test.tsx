import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeTaskRow } from './HomeTaskRow';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
const config = { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, rfq: true } };
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/rfqs/summary')) return Promise.resolve(jsonResponse({ quotes: { open: 3, awaitingYou: 2, shortlisted: 0 } }));
    if (url.includes('/account/inspections')) return Promise.resolve(jsonResponse({ inspections: [{ jobNumber: 'INSP-1', status: 'ACCEPTED', scheduledFor: '2026-10-05T00:00:00Z', orderId: 'o9', orderNumber: 'ORD-9' }] }));
    return Promise.resolve(jsonResponse({ deliveries: { arrivingSoon: [{ orderId: 'o1' }], overdue: 0 }, paymentActions: [{ orderId: 'o2', orderNumber: 'ORD-2' }], buyAgain: [{ productId: 'p', name: 'Nitrile gloves', slug: 'nitrile-gloves', timesOrdered: 3 }] }));
  });
});
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

describe('home task row (DYNAMIC-004)', () => {
  it('shows the signed-in buyer’s quotes, inspections, shipments, payments and repeat order', async () => {
    renderWithProviders(<HomeTaskRow />, { config, session: makeSession({ isCustomer: true }) });
    expect(await screen.findByRole('link', { name: 'Quotes waiting for your decision: 2' })).toHaveAttribute('href', '/account/rfqs');
    expect(await screen.findByRole('link', { name: 'Open inspections: 1 (next: order ORD-9)' })).toHaveAttribute('href', '/account/orders/o9');
    expect(await screen.findByRole('link', { name: 'Shipments on the way: 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Payments to make: 1' })).toHaveAttribute('href', '/account/orders/o2');
    expect(screen.getByRole('link', { name: 'Buy again: Nitrile gloves' })).toHaveAttribute('href', '/product/nitrile-gloves');
  });
  it('shows nothing and asks for nothing when signed out', () => {
    const { container } = renderWithProviders(<HomeTaskRow />, { config, session: makeSession({ isCustomer: false }) });
    expect(container.querySelector('section')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
