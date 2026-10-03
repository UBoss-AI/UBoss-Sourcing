import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { i18n } from '@/i18n/config';
import { ExceptionCentre } from './ExceptionCentre';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});
const { api } = await import('@/lib/api');
const get = vi.mocked(api.get);

function mount(): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}><MemoryRouter><ExceptionCentre /></MemoryRouter></I18nextProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => { cleanup(); get.mockReset(); });

describe('exception centre (ENH-019)', () => {
  it('shows every type the caller can act on and the ranked queue with links', async () => {
    get.mockResolvedValue({ total: 5, items: [
      { type: 'LATE_SHIPMENT', source: 'shipmentsLate', count: 3, severity: 'urgent', href: '/logistics/shipments?exception=open' },
      { type: 'FAILED_PAYMENT', source: 'paymentsUnreconciled', count: 2, severity: 'attention', href: '/payments' },
    ], types: ['FAILED_PAYMENT', 'MISSING_DOCUMENT', 'INSPECTION_NCR', 'LATE_SHIPMENT', 'SETTLEMENT_MISMATCH', 'INTEGRATION_FAILURE'].map((type) => ({ type, count: type === 'LATE_SHIPMENT' ? 3 : type === 'FAILED_PAYMENT' ? 2 : 0 })) });
    mount();
    const links = await screen.findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Late shipments', 'Failed payments']);
    expect(screen.getByText('Settlement mismatches: 0')).toBeTruthy();
    expect(screen.getByText('Integration failures: 0')).toBeTruthy();
  });
  it('renders nothing for a member who may act on none of them', async () => {
    get.mockResolvedValue({ total: 0, items: [], types: [] });
    mount();
    await vi.waitFor(() => { expect(get).toHaveBeenCalled(); expect(screen.queryByText('Exception centre')).toBeNull(); });
  });
});
