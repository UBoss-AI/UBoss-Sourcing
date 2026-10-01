/**
 * Finance -> Ledger (checklist Master rows 59, 60, 61): one row per order with
 * gross, fee, fee tax, refunds and settlement; the journal on demand; held
 * funds with the two-person early release; and the write actions only for
 * FINANCE_POLICY_WRITE.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { LedgerPage } from './LedgerPage';

vi.mock('@/lib/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ledger')>();
  return {
    ...actual,
    fetchLedgerOrders: vi.fn(),
    fetchOrderLedger: vi.fn(),
    fetchHolds: vi.fn(),
    decideRelease: vi.fn(),
    runPayouts: vi.fn(),
  };
});
const api = await import('@/lib/ledger');

function renderPage(userId: string, permissions: string[]): void {
  const session = {
    user: { id: userId, email: `${userId}@example.test` },
    isLoading: false,
    can: (permission: string) => permissions.includes(permission),
    canAny: (...wanted: string[]) => wanted.some((permission) => permissions.includes(permission)),
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <MemoryRouter>
              <LedgerPage />
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const ORDER = {
  orderId: 'O1',
  orderNumber: 'ORD-501',
  lastActivityAt: null,
  settlement: 'HELD' as const,
  currency: 'INR',
  grossMinor: '100000',
  platformFeeMinor: '10000',
  platformFeeTaxMinor: '1800',
  sellerShareMinor: '88200',
  refundsMinor: '0',
  refundsChargedToSellersMinor: '0',
  releasedMinor: '0',
  heldMinor: '88200',
  chargebackLossMinor: '0',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LedgerPage', () => {
  it('lists each order with gross, fee, fee tax and seller share, and opens its journal', async () => {
    vi.mocked(api.fetchLedgerOrders).mockResolvedValue({ items: [ORDER], total: 1, page: 1, pageSize: 25 });
    vi.mocked(api.fetchOrderLedger).mockResolvedValue({
      orderId: 'O1',
      orderNumber: 'ORD-501',
      currency: 'INR',
      summary: ORDER,
      entries: [
        {
          id: 'E1',
          kind: 'SALE_ALLOCATED',
          currency: 'INR',
          memo: 'Sale allocated',
          actorLabel: 'System',
          occurredAt: '2026-10-01T00:00:00Z',
          providerReference: null,
          reversesEntryId: null,
          lines: [{ account: 'SELLER_HELD', owner: 'S1', amountMinor: '-88200' }],
        },
      ],
      holds: [],
      refunds: [],
      chargebacks: [],
    });
    renderPage('u1', ['payment.read']);
    const link = await screen.findByRole('button', { name: 'ORD-501' });
    const row = link.closest('tr');
    expect(row?.textContent).toContain('1,000.00');
    expect(row?.textContent).toContain('100.00');
    expect(row?.textContent).toContain('18.00');
    expect(row?.textContent).toContain('882.00');
    fireEvent.click(link);
    expect(await screen.findByText(/SALE_ALLOCATED/)).toBeTruthy();
    // Read-only staff see no money-moving actions.
    expect(screen.queryByRole('button', { name: /payout/i })).toBeNull();
  });

  it('lets a second person approve an early release, but not the one who asked', async () => {
    vi.mocked(api.fetchLedgerOrders).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    const hold = {
      id: 'H1',
      orderId: 'O1',
      sellerOrderNumber: 'SO-1',
      sellerName: 'North',
      currency: 'INR',
      status: 'HELD' as const,
      allocatedMinor: '88200',
      releasedMinor: '0',
      reserveMinor: '0',
      conditions: [],
      holdCode: null,
      holdReason: null,
      releaseKind: null,
      releasedAt: null,
      pendingRelease: { id: 'R1', reason: 'Buyer confirmed', requestedById: 'alice', requestedByLabel: 'alice@x', requestedAt: '2026-10-01T00:00:00Z' },
    };
    vi.mocked(api.fetchHolds).mockResolvedValue({ items: [hold], total: 1, page: 1, pageSize: 50 });
    vi.mocked(api.decideRelease).mockResolvedValue(undefined);

    renderPage('alice', ['payment.read', 'finance.policy.write']);
    fireEvent.click(screen.getAllByRole('tab')[1] as HTMLElement);
    await screen.findByText('SO-1');
    const buttonsForAlice = screen.getAllByRole('button').length;
    cleanup();

    renderPage('bob', ['payment.read', 'finance.policy.write']);
    fireEvent.click(screen.getAllByRole('tab')[1] as HTMLElement);
    await screen.findByText('SO-1');
    // Bob has approve and reject on top of what Alice saw.
    expect(screen.getAllByRole('button').length).toBe(buttonsForAlice + 2);
    const before = screen.getAllByRole('button');
    fireEvent.click(before[before.length - 2] as HTMLElement);
    await waitFor(() => {
      expect(api.decideRelease).toHaveBeenCalledWith('R1', true);
    });
  });
});
