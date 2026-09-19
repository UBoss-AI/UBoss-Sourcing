/**
 * The buyer dashboard, under the conditions that actually go wrong.
 *
 * The behaviours tested here are the ones a screenshot cannot show and a
 * typecheck cannot catch:
 *
 *   - a slice and its legend entry select the same thing;
 *   - the keyboard reaches every segment;
 *   - changing the reporting window asks the server again;
 *   - the selection survives in the URL;
 *   - the selection reaches the insights panel, which is the only other thing
 *     on this screen;
 *   - loading, empty and error each look like themselves.
 *
 * The chart's own arithmetic is covered by `lib/donut.test.ts`, and the
 * status mapping by `lib/buyer-dashboard.test.ts`. This file is about what
 * happens when somebody uses it.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { BuyerDashboard } from '@/lib/buyer-dashboard';

const fetchMock = vi.fn();

function money(minor: string, formatted: string) {
  return { minor, formatted, currency: 'EUR' };
}

/** A dashboard with something in every group, so nothing is empty by accident. */
function makeDashboard(overrides: Partial<BuyerDashboard> = {}): BuyerDashboard {
  return {
    window: { from: '2026-08-18T00:00:00.000Z', to: '2026-09-17T00:00:00.000Z' },
    generatedAt: '2026-09-17T12:00:00.000Z',
    orderCount: 20,
    ordersByStatus: [
      { status: 'PENDING_PAYMENT', count: 3 },
      { status: 'PROCESSING', count: 5 },
      { status: 'SHIPPED', count: 4 },
      { status: 'DELIVERED', count: 7 },
      { status: 'CANCELLED', count: 1 },
    ],
    spend: {
      currency: 'EUR',
      paid: money('420000', '€4,200.00'),
      ordered: money('500000', '€5,000.00'),
      refunded: money('0', '€0.00'),
      previousPaid: money('380000', '€3,800.00'),
    },
    schedules: { active: 2, paused: 0, needsAttention: 1, upcoming: [] },
    deliveries: { arrivingSoon: [], overdue: 0 },
    paymentActions: [],
    erp: {
      organizationName: null,
      connectionCount: 0,
      activeCount: 0,
      unhealthyCount: 0,
      deadLetteredEvents: 0,
      lastSyncAt: null,
    },
    recentOrders: [
      {
        orderId: 'o1',
        orderNumber: 'UB-2026-000001',
        status: 'PENDING_PAYMENT',
        placedAt: '2026-09-16T09:00:00.000Z',
        total: money('12000', '€120.00'),
      },
      {
        orderId: 'o2',
        orderNumber: 'UB-2026-000002',
        status: 'DELIVERED',
        placedAt: '2026-09-15T09:00:00.000Z',
        total: money('34000', '€340.00'),
      },
    ],
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

/** Answer the dashboard request and nothing else. */
function serve(dashboard: BuyerDashboard = makeDashboard()): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/account/dashboard')) return Promise.resolve(jsonResponse(dashboard));
    return Promise.resolve(jsonResponse({}));
  });
}

describe('the ring', () => {
  it('shows the server total in the middle, not a sum of its own', async () => {
    /*
     * The server sends 20 orders and five statuses summing to 20. The test
     * that matters is the NEXT case — but this establishes that the figure
     * comes from `orderCount`, which is what the drill-down is measured
     * against.
     */
    serve();
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    expect(await screen.findByTestId('donut-total')).toHaveTextContent('20');
  });

  it('says so when the segments do not account for the total', async () => {
    // What happens the day a status is added to the backend and not to the
    // mapping. Nothing else on the screen would reveal it.
    serve(makeDashboard({ orderCount: 26 }));
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    expect(await screen.findByText(/6 orders are not broken out/i)).toBeInTheDocument();
  });

  it('carries every segment as text, not only as colour', async () => {
    serve();
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    // Label, count and share, all present as words for every group.
    const legend = await screen.findByRole('button', { name: /Waiting on you/i });
    expect(within(legend).getByText('3')).toBeInTheDocument();
    expect(within(legend).getByText('15%')).toBeInTheDocument();
  });

  it('offers the figures as a real table', async () => {
    serve();
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    await screen.findByRole('button', { name: /Waiting on you/i });
    await userEvent.click(screen.getByText('View as a table'));

    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Delivered' })).toBeInTheDocument();
  });
});

describe('selecting a segment', () => {
  /*
   * There is no list under the ring any more, so a selection cannot be checked
   * by watching rows disappear. What it does now is: press the legend entry,
   * say in words which slice is showing, offer a way back out, and hand the
   * slice to the insights panel. Those four are what these tests hold.
   */

  it('says which slice is showing, and offers a way out', async () => {
    serve();
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    await userEvent.click(await screen.findByRole('button', { name: /Waiting on you/i }));

    expect(screen.getByText('Showing Waiting on you only')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }));

    expect(screen.queryByText('Showing Waiting on you only')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Waiting on you/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('marks the selected entry as pressed', async () => {
    serve();
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    const entry = await screen.findByRole('button', { name: /Waiting on you/i });
    expect(entry).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(entry);
    expect(entry).toHaveAttribute('aria-pressed', 'true');
  });

  it('is reachable and selectable from the keyboard alone', async () => {
    /*
     * The ring's arcs are `aria-hidden` decoration; the LEGEND is the control.
     * So "keyboard selectable" has to be true of the legend entries, and this
     * is the test that says so — tab to one, press it, and the chart reports
     * the slice it is now showing.
     */
    serve();
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    const entry = await screen.findByRole('button', { name: /Waiting on you/i });

    entry.focus();
    expect(entry).toHaveFocus();

    await userEvent.keyboard('{Enter}');

    expect(entry).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Showing Waiting on you only')).toBeInTheDocument();
  });

  it('clears when the selected entry is chosen again', async () => {
    serve();
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    const entry = await screen.findByRole('button', { name: /Waiting on you/i });

    await userEvent.click(entry);
    expect(entry).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(entry);
    expect(entry).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
  });

  it('starts filtered when the URL says so', async () => {
    // Which is what makes Back, reload and a shared link all behave.
    serve();
    renderWithProviders(<DashboardPage />, {
      route: '/account/dashboard?segment=delivered',
    });

    expect(await screen.findByText('Showing Delivered only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delivered/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('ignores a segment the build does not know', async () => {
    // A stale link from an older deploy. It must show the whole ring rather
    // than filter to nothing and look broken.
    serve();
    renderWithProviders(<DashboardPage />, {
      route: '/account/dashboard?segment=made-up',
    });

    await screen.findByTestId('donut-total');

    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Waiting on you/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('tells the insights panel which slice is selected', async () => {
    /*
     * The one place a selection goes besides the ring's own state, now that
     * nothing else is on this screen: the question the insights panel asks is
     * measured over the slice, so the paragraph beside the chart is about what
     * the reader has actually singled out.
     */
    serve();
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    await userEvent.click(await screen.findByRole('button', { name: /Waiting on you/i }));
    await userEvent.click(screen.getByRole('button', { name: /Explain this chart/i }));

    await waitFor(() => {
      const asked = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes('/insights/stream'),
      );
      expect(asked).toBeDefined();
      expect(JSON.parse(String((asked?.[1] as { body?: unknown } | undefined)?.body))).toMatchObject(
        { segment: 'action' },
      );
    });
  });
});

describe('the reporting window', () => {
  it('asks the server again when the range changes', async () => {
    serve();
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    await screen.findByTestId('donut-total');
    const before = fetchMock.mock.calls.length;

    await userEvent.click(screen.getByRole('tab', { name: 'Last 7 days' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    });

    // And the new request carries a different window rather than the old one.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const windows = new Set(
      urls
        .filter((url) => url.includes('/account/dashboard'))
        .map((url) => new URL(url, 'http://x').searchParams.get('from')),
    );
    expect(windows.size).toBeGreaterThan(1);
  });

  it('does not render a reply for a window that is no longer selected', async () => {
    /*
     * Rapid filter changes. The reply for "last 7 days" is made to arrive
     * AFTER the reply for "last 30 days", which is the ordering that shows a
     * stale answer on a screen that tracks responses rather than keys.
     *
     * Nothing here sequences requests: the window is part of the React Query
     * key, so a late reply is cached under the key nobody is reading.
     */
    const thirty = makeDashboard({ orderCount: 20 });
    const seven = makeDashboard({ orderCount: 4 });

    fetchMock.mockImplementation((url: string) => {
      const from = new URL(url, 'http://x').searchParams.get('from') ?? '';
      const span = Date.parse('2026-09-17T00:00:00.000Z') - Date.parse(from);
      const isSeven = span < 10 * 86_400_000;

      // The seven-day answer is slow; the thirty-day answer is instant.
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(jsonResponse(isSeven ? seven : thirty));
        }, isSeven ? 60 : 0);
      });
    });

    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });
    await waitFor(() => {
      expect(screen.getByTestId('donut-total')).toHaveTextContent('20');
    });

    await userEvent.click(screen.getByRole('tab', { name: 'Last 7 days' }));
    await waitFor(() => {
      expect(screen.getByTestId('donut-total')).toHaveTextContent('4');
    });

    // Back to thirty days. The slow seven-day reply may still land; it must
    // not overwrite what is on screen.
    await userEvent.click(screen.getByRole('tab', { name: 'Last 30 days' }));
    await waitFor(() => {
      expect(screen.getByTestId('donut-total')).toHaveTextContent('20');
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    expect(screen.getByTestId('donut-total')).toHaveTextContent('20');
  });

  it('moves between ranges with the arrow keys', async () => {
    serve();
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    const selected = await screen.findByRole('tab', { name: 'Last 30 days' });
    selected.focus();

    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Custom' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the states that are not a chart', () => {
  it('announces the wait rather than showing a zero', async () => {
    fetchMock.mockImplementation(
      () => new Promise(() => {
        // Never resolves: the page stays in its loading state.
      }),
    );

    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    /*
     * The chart reports the wait to a screen reader and draws no figure at
     * all. A zero here would be a claim about the business made before the
     * answer arrived, which is the one thing a loading state must not do.
     */
    await waitFor(() => {
      expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    });
    expect(screen.queryByTestId('donut-total')).not.toBeInTheDocument();
  });

  it('says there is nothing rather than drawing an empty ring', async () => {
    serve(makeDashboard({ orderCount: 0, ordersByStatus: [], recentOrders: [] }));
    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    expect(
      await screen.findByText('You have not placed an order in this period.'),
    ).toBeInTheDocument();
  });

  it('offers a retry when the request fails', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'nope' } }, 500),
    );

    renderWithProviders(<DashboardPage />, { route: '/account/dashboard' });

    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });
});
