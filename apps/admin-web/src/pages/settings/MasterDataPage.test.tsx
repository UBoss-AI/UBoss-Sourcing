/**
 * The master data page (checklist Master row 75): lists the chosen list,
 * adds an entry, switches one off, and is read-only without settings.write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { MasterDataPage } from './MasterDataPage';

const fetchMock = vi.fn();

const UOMS = {
  entries: [
    { id: '01KMDUOM00000000000000000KG', kind: 'UOM', code: 'KG', name: 'Kilogram', description: null, defaultSeverity: null, sortOrder: 0, isActive: true },
  ],
};

const READINESS = {
  generatedAt: '2026-10-02T10:00:00.000Z',
  ready: false,
  missingRequired: 1,
  checks: [
    { key: 'units', required: true, status: 'OK', count: 1 },
    { key: 'platformTerms', required: true, status: 'MISSING', count: 0 },
    { key: 'incoterms', required: false, status: 'WARNING', count: 0 },
  ],
  demo: [
    { key: 'demoProducts', count: 0 },
    { key: 'localAccounts', count: 4 },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderPage(permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'owner@example.test' },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
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
              <MasterDataPage />
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function callsWith(method: string): [string, RequestInit][] {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method) as [string, RequestInit][];
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) =>
    Promise.resolve(
      url.includes('/admin/master-data-readiness')
        ? json(READINESS)
        : init?.method === undefined || init.method === 'GET'
          ? json(UOMS)
          : json({ entry: UOMS.entries[0] }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MasterDataPage', () => {
  it('lists units of measure and adds a new one', async () => {
    renderPage(['settings.read', 'settings.write']);
    expect(await screen.findByText('Kilogram')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/admin/master-data/UOM'))).toBe(true);

    const inputs = screen.getAllByRole('textbox');
    // code, name, description - in form order after the list.
    fireEvent.change(inputs[0] as HTMLElement, { target: { value: 'CTN' } });
    fireEvent.change(inputs[1] as HTMLElement, { target: { value: 'Carton' } });
    fireEvent.submit(inputs[0]?.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(callsWith('POST')).toHaveLength(1);
    });
    const [url, init] = callsWith('POST')[0] as [string, RequestInit];
    expect(url).toContain('/admin/master-data/UOM');
    expect(JSON.parse(init.body as string)).toEqual({ code: 'CTN', name: 'Carton', description: null, sortOrder: 0 });
  });

  it('switches an entry off', async () => {
    renderPage(['settings.read', 'settings.write']);
    await screen.findByText('Kilogram');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('masterData.deactivate') }));

    await waitFor(() => {
      expect(callsWith('PATCH')).toHaveLength(1);
    });
    const [url, init] = callsWith('PATCH')[0] as [string, RequestInit];
    expect(url).toContain(`/admin/master-data/UOM/${UOMS.entries[0]?.id ?? ''}`);
    expect(JSON.parse(init.body as string)).toEqual({ isActive: false });
  });

  it('shows the go-live readiness of each master list and any demonstration data left (LIVE-019)', async () => {
    renderPage(['settings.read']);
    expect(await screen.findByText(i18n.t('readiness.notReady'))).toBeTruthy();
    expect(screen.getByText(i18n.t('readiness.check.platformTerms'))).toBeTruthy();
    expect(screen.getByText(i18n.t('readiness.status.MISSING'))).toBeTruthy();
    expect(screen.getByText(i18n.t('readiness.demo.localAccounts'))).toBeTruthy();
    // A demo list with nothing in it is not named.
    expect(screen.queryByText(i18n.t('readiness.demo.demoProducts'))).toBeNull();
  });

  it('is read-only without settings.write', async () => {
    renderPage(['settings.read']);
    await screen.findByText('Kilogram');
    expect(screen.queryByRole('button', { name: i18n.t('masterData.deactivate') })).toBeNull();
    expect(screen.queryByRole('button', { name: i18n.t('masterData.add') })).toBeNull();
  });
});
