/**
 * The market pages panel (checklist Master row 8): loads each market's text,
 * saves it as typed (blank fields as nothing), refuses a bad category address
 * before sending, and is read-only without settings.write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { MarketPagesPanel } from './MarketPagesPanel';

const fetchMock = vi.fn();

const MARKETS = {
  markets: [
    { code: 'IN', name: 'India', currencyCode: 'INR', profile: null },
    {
      code: 'DE',
      name: 'Germany',
      currencyCode: 'EUR',
      profile: {
        headline: 'Buying for Germany',
        intro: 'We ship from Pune.',
        dutiesGuidance: null,
        deliveryPromise: null,
        complianceNotes: null,
        featuredCategories: ['gloves'],
        isPublished: true,
        updatedAt: '2026-09-29T00:00:00.000Z',
      },
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderPanel(permissions: string[]): void {
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
              <MarketPagesPanel />
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
    Promise.resolve(init?.method === 'PUT' ? json({ updated: true }) : json(MARKETS)),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MarketPagesPanel', () => {
  it('saves the chosen market as typed, blank fields as nothing', async () => {
    renderPanel(['settings.read', 'settings.write']);

    const country = await screen.findByLabelText('Country');
    fireEvent.change(country, { target: { value: 'DE' } });
    expect(await screen.findByDisplayValue('Buying for Germany')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Duties and taxes guidance'), { target: { value: 'VAT at checkout.' } });
    fireEvent.change(screen.getByLabelText(/Featured categories/), { target: { value: 'gloves, masks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save market page' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true);
    });
    const [url, init] = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PUT') as [string, RequestInit];
    expect(url).toContain('/admin/settings/market-profiles/DE');
    expect(JSON.parse(init.body as string)).toEqual({
      headline: 'Buying for Germany',
      intro: 'We ship from Pune.',
      dutiesGuidance: 'VAT at checkout.',
      deliveryPromise: null,
      complianceNotes: null,
      featuredCategories: ['gloves', 'masks'],
      isPublished: true,
    });
  });

  it('refuses a malformed category address before sending anything', async () => {
    renderPanel(['settings.read', 'settings.write']);
    fireEvent.change(await screen.findByLabelText(/Featured categories/), { target: { value: 'Gloves & Masks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save market page' }));

    expect((await screen.findByRole('alert')).textContent).toContain('is not a category address');
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });

  it('is read-only without settings.write', async () => {
    renderPanel(['settings.read']);
    expect(await screen.findByText(/You can read these settings but not change them/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save market page' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Headline').disabled).toBe(true);
  });
});
