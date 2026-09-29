/**
 * The command centre's key figures and system health (checklist SCREEN-065).
 *
 *   - the headline figures come from the dashboard endpoint, each measured
 *     against the previous period;
 *   - the change is worked out in whole minor units, not floats, and says so
 *     honestly when there is nothing to compare with;
 *   - each thing that is stuck shows its count and links to the screen that
 *     fixes it; nothing stuck says so;
 *   - staff without report.read see none of it and no request is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { i18n } from '@/i18n/config';
import type { DashboardResponse, Money } from '@/lib/types';
import { changeBetween, changeBetweenCounts } from '@/lib/command-centre';
import { CommandCentreTiles } from './CommandCentreTiles';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

const { api } = await import('@/lib/api');
const get = vi.mocked(api.get);

const money = (minor: string): Money => ({ minor, formatted: (Number(minor) / 100).toFixed(2), currency: 'INR' });

function summary(orders: number, gross: string): DashboardResponse['sales'] {
  return {
    currency: 'INR',
    window: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z' },
    orderCount: orders,
    grossSales: money(gross),
    tax: money('0'),
    shipping: money('0'),
    discount: money('0'),
    collected: money(gross),
    refunded: money('0'),
    netRevenue: money(gross),
    averageOrderValue: money(orders === 0 ? '0' : String(BigInt(gross) / BigInt(orders))),
  };
}

function dashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    sales: summary(12, '600000'),
    previousSales: summary(10, '500000'),
    salesSeries: [],
    ordersByStatus: [],
    payments: {
      currency: 'INR',
      byStatus: [],
      captured: '0',
      failed: '0',
      refunded: '0',
      refundCount: 0,
      rejectedWebhooks: 0,
      unreconciled: 0,
    },
    lowStock: { count: 3, items: [] },
    recurring: { byStatus: [], upcoming: [], failedOccurrences: 0, needsAttention: [] },
    alerts: {
      failedNotifications: 0,
      deadJobs: 0,
      rejectedWebhooks: 0,
      unreconciledPayments: 0,
      schedulesNeedingAttention: 0,
    },
    ...overrides,
  };
}

function renderTiles(permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'owner@example.test' },
    isLoading: false,
    can: (permission: string) => permissions.includes(permission),
    canAny: (...wanted: string[]) => wanted.some((permission) => permissions.includes(permission)),
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SessionContext.Provider value={session}>
          <MemoryRouter>
            <CommandCentreTiles window={{ from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z' }} />
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  get.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('changeBetween', () => {
  it('works in minor units and signs the result', () => {
    expect(changeBetween(money('600000'), money('500000'))).toBe('+20.0%');
    expect(changeBetween(money('450000'), money('500000'))).toBe('-10.0%');
    expect(changeBetween(money('500000'), money('500000'))).toBe('0.0%');
  });

  it('does not lose precision on amounts a float would round', () => {
    // 9007199254740993 is not representable as a double; the percentage still is.
    expect(changeBetween(money('18014398509481986'), money('9007199254740993'))).toBe('+100.0%');
  });

  it('has nothing to say when there was nothing before', () => {
    expect(changeBetween(money('600000'), money('0'))).toBeNull();
    expect(changeBetweenCounts(5, 0)).toBeNull();
    expect(changeBetweenCounts(15, 10)).toBe('+50.0%');
  });
});

describe('CommandCentreTiles', () => {
  it('shows the key figures, each against the previous period', async () => {
    get.mockResolvedValue(dashboard());
    renderTiles(['report.read']);

    expect(await screen.findByText('Orders')).toBeTruthy();
    expect(screen.getByText('Gross sales')).toBeTruthy();
    expect(screen.getByText('Average order value')).toBeTruthy();
    expect(screen.getByText('Net revenue')).toBeTruthy();
    // 12 orders against 10, and 6,000 against 5,000, are both +20%.
    expect(screen.getAllByText('+20.0% vs the previous period').length).toBeGreaterThanOrEqual(2);
    expect(get).toHaveBeenCalledWith(expect.stringContaining('/admin/dashboard?from='));
  });

  it('says so when there is no earlier period to compare with', async () => {
    get.mockResolvedValue(dashboard({ previousSales: summary(0, '0') }));
    renderTiles(['report.read']);

    await screen.findByText('Orders');
    expect(screen.getAllByText('Nothing to compare with yet').length).toBeGreaterThan(0);
  });

  it('shows what is stuck, with a count that opens the screen that fixes it', async () => {
    get.mockResolvedValue(
      dashboard({
        alerts: {
          failedNotifications: 4,
          deadJobs: 2,
          rejectedWebhooks: 0,
          unreconciledPayments: 1,
          schedulesNeedingAttention: 0,
        },
      }),
    );
    renderTiles(['report.read']);

    const health = (await screen.findByText('System health')).closest('section') as HTMLElement;
    const dead = within(health).getByRole('link', { name: 'Background jobs that gave up: 2' });
    expect(dead.getAttribute('href')).toBe('/operations/dead-jobs');
    const mail = within(health).getByRole('link', { name: 'Emails that could not be sent: 4' });
    expect(mail.getAttribute('href')).toBe('/operations/failed-notifications');
    expect(within(health).getByRole('link', { name: 'Payments not matched to an order: 1' })).toBeTruthy();
    // Two of the five are fine and say so instead of showing a zero.
    expect(within(health).getAllByText('OK').length).toBe(2);
    expect(within(health).getByRole('status').textContent).toMatch(/Something is stuck/);
  });

  it('says nothing is stuck when nothing is', async () => {
    get.mockResolvedValue(dashboard());
    renderTiles(['report.read']);

    const health = (await screen.findByText('System health')).closest('section') as HTMLElement;
    expect(within(health).getAllByText('OK').length).toBe(5);
    expect(within(health).getByRole('status').textContent).toBe('Nothing is stuck.');
  });

  it('shows nothing, and asks for nothing, without report.read', async () => {
    renderTiles(['settings.read']);

    await waitFor(() => {
      expect(screen.queryByText('Orders')).toBeNull();
    });
    expect(screen.queryByText('System health')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
