/**
 * The sourcing card on the buyer dashboard (checklist Master row 15): real
 * counts, links to the filtered list, next actions that open the right page,
 * a dash (not a zero) for a figure the server could not measure, and a
 * failure that stays inside the card.
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourcingSummaryCard } from './SourcingSummaryCard';
import { DashboardPage } from '@/pages/account/DashboardPage';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import type { RfqDashboardSummary } from '@/lib/rfq';

const fetchMock = vi.fn();

function summary(overrides: Partial<RfqDashboardSummary> = {}): RfqDashboardSummary {
  return {
    requests: { draft: 1, open: 3, awarded: 2, closed: 0 },
    quotes: { open: 5, awaitingYou: 2, shortlisted: 1 },
    negotiations: { active: 1, awaitingYou: 0, accepted: 2 },
    samples: { inProgress: 1, awaitingYou: 1, approved: 0 },
    nextActions: [
      { kind: 'REVIEW_OFFER', rfqId: 'r1', rfqReference: 'RFQ-2026-000001', rfqTitle: 'Nitrile gloves', quoteId: 'q1', sampleReference: null, at: '2026-09-29T10:00:00.000Z' },
      { kind: 'DECIDE_SAMPLE', rfqId: 'r2', rfqReference: 'RFQ-2026-000002', rfqTitle: 'Masks', quoteId: null, sampleReference: 'SMP-2026-000004', at: '2026-09-29T09:00:00.000Z' },
    ],
    unavailable: [],
    generatedAt: '2026-09-29T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SourcingSummaryCard', () => {
  it('shows the counts, links each to its filtered list and each next action to where it is done', async () => {
    fetchMock.mockResolvedValue(jsonResponse(summary()));
    renderWithProviders(<SourcingSummaryCard />);

    expect(await screen.findByText('2 waiting on you')).toBeInTheDocument();
    expect(screen.getByTestId('rfq-tile-open')).toHaveTextContent('3');
    expect(screen.getByTestId('rfq-tile-quotes')).toHaveTextContent('5');
    expect(screen.getByText('2 waiting on you')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open requests/ })).toHaveAttribute('href', '/account/rfqs?status=OPEN');
    expect(screen.getByRole('link', { name: /Drafts/ })).toHaveAttribute('href', '/account/rfqs?status=DRAFT');
    expect(screen.getByRole('link', { name: /Awarded/ })).toHaveAttribute('href', '/account/rfqs?status=AWARDED');
    expect(screen.getByRole('link', { name: /Answer the latest offer on RFQ-2026-000001/ })).toHaveAttribute(
      'href',
      '/account/rfqs/r1/quotes/q1',
    );
    expect(screen.getByRole('link', { name: /Approve or reject sample SMP-2026-000004/ })).toHaveAttribute(
      'href',
      '/account/rfqs/r2?tab=samples',
    );
  });

  it('shows a dash for a block the server could not measure, and says the figures are partial', async () => {
    fetchMock.mockResolvedValue(jsonResponse(summary({ samples: null, nextActions: null, unavailable: ['samples', 'nextActions'] })));
    renderWithProviders(<SourcingSummaryCard />);

    expect(await screen.findByText(/A dash means unknown, not zero/)).toBeInTheDocument();
    expect(screen.getByTestId('rfq-tile-samples')).toHaveTextContent('–');
    expect(screen.getByTestId('rfq-tile-open')).toHaveTextContent('3');
    expect(screen.getByText(/A dash means unknown, not zero/)).toBeInTheDocument();
    expect(screen.getByText('Next actions could not be loaded just now.')).toBeInTheDocument();
  });

  it('keeps a sourcing failure inside its card: the order ring still renders', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/rfqs/summary')) return Promise.resolve(errorResponse(500, 'INTERNAL', 'boom'));
      if (url.includes('/account/dashboard')) {
        return Promise.resolve(
          jsonResponse({
            window: { from: '2026-08-18T00:00:00.000Z', to: '2026-09-17T00:00:00.000Z' },
            generatedAt: '2026-09-17T12:00:00.000Z',
            orderCount: 4,
            ordersByStatus: [{ status: 'DELIVERED', count: 4 }],
            spend: null,
            schedules: { active: 0, paused: 0, needsAttention: 0, upcoming: [] },
            deliveries: { arrivingSoon: [], overdue: 0 },
            paymentActions: [],
            erp: null,
            recentOrders: [],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<DashboardPage />, {
      route: '/account/dashboard',
      config: { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, rfq: true } },
    });

    expect(await screen.findByText(/Sourcing figures could not be loaded/)).toBeInTheDocument();
    expect(await screen.findByTestId('donut-total')).toHaveTextContent('4');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
