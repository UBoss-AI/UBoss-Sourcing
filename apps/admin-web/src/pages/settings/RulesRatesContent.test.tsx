/**
 * Country rules (Master row 69), rate cards (row 71) and storefront content
 * (row 72) in the admin panel: each lists what the server holds, sends money
 * as minor-unit strings, refuses a half-typed threshold before sending, runs
 * the "test a rate" form, and is read-only without the write permission.
 *
 * Labels are read through i18n so the test holds whatever the English copy is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { CountryRulesPage } from './CountryRulesPage';
import { ContentBlocksPage } from './ContentBlocksPage';
import { RateCardsPage } from '../logistics/RateCardsPage';

const fetchMock = vi.fn();
/** Any key, typed loosely: the copy is looked up, not asserted. */
const tr = (key: string, options?: Record<string, unknown>): string =>
  (i18n.t as unknown as (k: string, o?: Record<string, unknown>) => string)(key, options);
const label = (key: string): RegExp => new RegExp(`^${tr(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*\\*\\s*\\(required\\))?$`);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderPage(page: React.JSX.Element, permissions: string[]): void {
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
            <MemoryRouter>{page}</MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const RULE = {
  id: 'r1',
  scope: 'CATEGORY',
  countryCode: 'DE',
  effect: 'BLOCK',
  product: null,
  category: { id: 'c1', slug: 'solvents', name: 'Solvents' },
  reason: 'Solvents cannot be imported.',
  requiredDocuments: [],
  minOrderValueMinor: '500000',
  thresholdCurrency: 'EUR',
  source: 'Reg 1',
  version: '1',
  ownerName: 'Compliance',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveUntil: null,
  isActive: true,
};

function serve(): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/admin/market-rules')) return Promise.resolve(method === 'GET' ? json({ rules: [RULE] }) : json({ rule: RULE }, 201));
    if (url.includes('/admin/categories')) {
      return Promise.resolve(json({ categories: [{ id: 'c1', parentId: null, name: 'Solvents', slug: 'solvents', depth: 0, sortOrder: 0, isActive: true, children: [] }] }));
    }
    if (url.includes('/admin/logistics/lanes/quote')) {
      return Promise.resolve(
        json({
          quotes: [
            { laneId: 'l1', laneName: 'Pune air', laneVersion: 1, mode: 'AIR', carrierName: 'Test Air', serviceLevel: 'STANDARD', transitDaysMin: 3, transitDaysMax: 6, currency: 'INR', baseMinor: '100000', fuelMinor: '12500', totalMinor: '112500' },
          ],
        }),
      );
    }
    if (url.includes('/admin/logistics/lanes')) return Promise.resolve(json({ lanes: [] }));
    if (url.includes('/admin/content-blocks')) {
      return Promise.resolve(
        json({
          blocks: [
            { id: 'b1', placement: 'HOME_BANNER', category: null, title: 'Monsoon sale', body: null, imageUrl: null, linkUrl: null, coupon: { code: 'RAIN10', status: 'ACTIVE', isPubliclyListed: true }, countryCode: '', languageCode: 'de', startsAt: null, endsAt: null, isPublished: true, sortOrder: 0 },
          ],
        }),
      );
    }
    return Promise.resolve(json({}));
  });
}

const sent = (method: string): [string, RequestInit] | undefined =>
  fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method) as [string, RequestInit] | undefined;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  serve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CountryRulesPage', () => {
  it('lists rules with their threshold and saves a new one with the threshold in minor units', async () => {
    renderPage(<CountryRulesPage />, ['settings.read', 'settings.write']);
    expect(await screen.findByText('Solvents cannot be imported.')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: tr('countryRules.add') })[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText(label('countryRules.country')), { target: { value: 'de' } });
    await screen.findByRole('option', { name: 'Solvents' });
    fireEvent.change(screen.getByLabelText(label('countryRules.category')), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText(label('countryRules.reason')), { target: { value: 'Not allowed in.' } });
    fireEvent.change(screen.getByLabelText(label('countryRules.source')), { target: { value: 'Reg 2' } });
    fireEvent.change(screen.getByLabelText(label('countryRules.version')), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(label('countryRules.owner')), { target: { value: 'Compliance' } });
    fireEvent.change(screen.getByLabelText(label('countryRules.threshold')), { target: { value: '50.25' } });

    // Amount without a currency is refused before anything is sent.
    fireEvent.click(screen.getByRole('button', { name: tr('countryRules.save') }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(sent('POST')).toBeUndefined();

    fireEvent.change(screen.getByLabelText(label('countryRules.thresholdCurrency')), { target: { value: 'eur' } });
    fireEvent.click(screen.getByRole('button', { name: tr('countryRules.save') }));
    await waitFor(() => {
      expect(sent('POST')).toBeDefined();
    });
    const [url, init] = sent('POST') as [string, RequestInit];
    expect(url).toContain('/admin/market-rules');
    expect(JSON.parse(init.body as string)).toMatchObject({
      scope: 'CATEGORY',
      countryCode: 'DE',
      effect: 'BLOCK',
      categoryId: 'c1',
      minOrderValueMinor: '5025',
      thresholdCurrency: 'EUR',
    });
  });

  it('is read-only without settings.write', async () => {
    renderPage(<CountryRulesPage />, ['settings.read']);
    expect(await screen.findByText('Solvents cannot be imported.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: tr('countryRules.add') })).toBeNull();
    expect(screen.queryByRole('button', { name: tr('countryRules.delete') })).toBeNull();
  });
});

describe('RateCardsPage', () => {
  it('tests a rate in grams and shows the total in major units', async () => {
    renderPage(<RateCardsPage />, ['logistics.read']);
    fireEvent.change(await screen.findByLabelText(label('rateCards.origin')), { target: { value: 'in' } });
    fireEvent.change(screen.getByLabelText(label('rateCards.destination')), { target: { value: 'ki' } });
    fireEvent.change(screen.getByLabelText(label('rateCards.weightKg')), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: tr('rateCards.testRun') }));

    expect(await screen.findByText(/1125\.00 INR/)).toBeTruthy();
    const [url, init] = sent('POST') as [string, RequestInit];
    expect(url).toContain('/admin/logistics/lanes/quote');
    expect(JSON.parse(init.body as string)).toEqual({ originCountry: 'IN', destinationCountry: 'KI', weightGrams: 12000 });
    // No logistics.write: no way to add a card.
    expect(screen.queryByRole('button', { name: tr('rateCards.add') })).toBeNull();
  });
});

describe('ContentBlocksPage', () => {
  it('lists blocks with their state, targeting and coupon', async () => {
    renderPage(<ContentBlocksPage />, ['settings.read', 'settings.write']);
    expect(await screen.findByText('Monsoon sale')).toBeTruthy();
    expect(screen.getByText(tr('contentBlocks.state.live'))).toBeTruthy();
    expect(screen.getByText(new RegExp(tr('contentBlocks.promotes', { code: 'RAIN10' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
    expect(screen.getAllByRole('button', { name: tr('contentBlocks.add') }).length).toBeGreaterThan(0);
  });
});
