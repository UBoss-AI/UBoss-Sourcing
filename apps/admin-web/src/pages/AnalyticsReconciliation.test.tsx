/**
 * Analytics reconciliation (LIVE-020): each client-reported business event is
 * shown beside the records it should match, with coverage, and an
 * over-report is flagged rather than hidden.
 */
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import { AnalyticsReconciliation } from './AnalyticsReconciliation';

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

describe('AnalyticsReconciliation', () => {
  it('shows analytics beside the source records and flags an over-report', async () => {
    vi.mocked(api.get).mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/reconciliation')
          ? {
              timeZone: 'UTC',
              rows: [
                { event: 'checkout_completed', source: 'orders.ONE_TIME', analytics: 18, sourceCount: 20, difference: -2, coverage: 90, overReported: false },
                { event: 'rfq_submitted', source: 'rfq_requests.submittedAt', analytics: 6, sourceCount: 5, difference: 1, coverage: 120, overReported: true },
              ],
            }
          : { topScreens: [{ screen: '/product/:slug', surface: 'STOREFRONT', views: 340 }] },
      ),
    );
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <AnalyticsReconciliation range={{ from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' }} />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    const checkout = (await screen.findAllByText('Checkouts completed vs orders placed'))[0]?.closest('tr');
    expect(checkout).not.toBeNull();
    expect(within(checkout as HTMLElement).getByText('90%')).toBeInTheDocument();
    expect(screen.getAllByText('120%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('/product/:slug').length).toBeGreaterThan(0);
    expect(vi.mocked(api.get)).toHaveBeenCalledWith('/admin/analytics/reconciliation', { query: { from: '2026-09-01', to: '2026-09-30' } });
  });
});
