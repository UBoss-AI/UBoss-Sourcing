/**
 * Sellers' company-detail change requests (JOURNEY-027): staff see what is on
 * file beside what is proposed, are told a material change re-opens
 * verification, must give a reason to reject, and a reader cannot decide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { SellerCompanyChangesPage, type CompanyChangeEntry } from './SellerCompanyChangesPage';

const fetchMock = vi.fn();

const CHANGE: CompanyChangeEntry = {
  id: '01JCHANGE00000000000000001',
  status: 'PENDING',
  proposed: { legalName: 'Acme Medical Private Limited' },
  previous: { legalName: 'Acme Gloves Private Limited' },
  material: true,
  reverifies: ['BUSINESS_REGISTRATION'],
  note: 'Renamed after a merger.',
  decisionReason: null,
  decidedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  seller: { id: '01JSELLER00000000000000001', displayName: 'Acme', legalName: 'Acme Gloves Private Limited' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderPage(permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'reviewer@example.test' },
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
              <SellerCompanyChangesPage />
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve(init?.method === 'POST' ? json({ change: { ...CHANGE, status: 'APPROVED' } }) : json({ changes: [CHANGE] })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the company change queue', () => {
  it('shows what is on file beside what is proposed, and that verification re-opens', async () => {
    renderPage(['customer.read']);
    expect(await screen.findByText('Acme Medical Private Limited')).toBeTruthy();
    expect(screen.getAllByText('Acme Gloves Private Limited').length).toBeGreaterThan(0);
    expect(screen.getByText('Approving re-opens these checks: BUSINESS_REGISTRATION')).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/admin/seller-company-changes?status=PENDING');
    // A reader sees the request but cannot decide it.
    expect(screen.queryByRole('button', { name: 'Record decision' })).toBeNull();
  });

  it('needs a reason to reject, and sends the decision', async () => {
    renderPage(['customer.read', 'customer.status.write']);
    await screen.findByText('Acme Medical Private Limited');
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'REJECTED' } });
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Record decision' });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Registry still shows the old name.' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => {
      const post = (fetchMock.mock.calls as [string, RequestInit | undefined][]).find(([, init]) => init?.method === 'POST');
      expect(post?.[0]).toContain(`/admin/seller-company-changes/${CHANGE.id}/decision`);
      expect(JSON.parse(post?.[1]?.body as string)).toEqual({ decision: 'REJECTED', reason: 'Registry still shows the old name.' });
    });
  });
});
