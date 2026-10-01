/**
 * Saved searches (checklist Master row 87): the page lists the buyer's
 * searches, switches alerts and deletes; the results-page button saves the
 * search on screen and is absent for a signed-out shopper.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveSearchButton } from '@/components/catalog/SaveSearchButton';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { SavedSearchesPage, type SavedSearch } from './SavedSearchesPage';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SEARCH: SavedSearch = {
  id: '01JSAVEDSEARCH000000000001',
  name: 'Nitrile gloves',
  query: 'nitrile gloves',
  filters: { category: 'gloves', currency: 'EUR', minPrice: '100' },
  alertsEnabled: true,
  lastNotifiedAt: null,
  createdAt: '2026-09-30T10:00:00.000Z',
};

function callsTo(method: string): [string, RequestInit][] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([, init]) => (init?.method ?? 'GET') === method)
    .map(([url, init]) => [url, init ?? {}]);
}

describe('SavedSearchesPage', () => {
  it('lists the searches, links each to its results, and switches alerts off', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'PATCH'
          ? jsonResponse({ ...SEARCH, alertsEnabled: false })
          : jsonResponse({ items: [SEARCH], limit: 20 }),
      ),
    );
    renderWithProviders(<SavedSearchesPage />);

    expect((await screen.findAllByText('Nitrile gloves')).length).toBeGreaterThan(0);
    const open = screen.getAllByRole('link').find((link) =>
      link.getAttribute('href')?.startsWith('/search?'),
    );
    expect(open).toHaveAttribute('href', '/search?q=nitrile+gloves&category=gloves&minPrice=100');

    const toggle = screen.getByRole('button', { pressed: true });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(callsTo('PATCH')).toHaveLength(1);
    });
    const [url, init] = callsTo('PATCH')[0] ?? ['', {}];
    expect(url).toContain(`/account/saved-searches/${SEARCH.id}`);
    expect(JSON.parse(init.body as string)).toEqual({ alertsEnabled: false });
  });
});

describe('SaveSearchButton', () => {
  const props = {
    q: 'nitrile gloves',
    category: 'gloves',
    minPrice: '100',
    maxPrice: null,
    currency: 'EUR',
    country: 'DE',
  };

  it('saves the search on screen with its filters', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...SEARCH }, 201));
    renderWithProviders(<SaveSearchButton {...props} />);

    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(callsTo('POST')).toHaveLength(1);
    });
    const [url, init] = callsTo('POST')[0] ?? ['', {}];
    expect(url).toContain('/account/saved-searches');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'nitrile gloves',
      query: 'nitrile gloves',
      filters: { category: 'gloves', country: 'DE', currency: 'EUR', minPrice: '100' },
    });
    // Once saved it offers the way to the list instead.
    expect(await screen.findByRole('link')).toHaveAttribute('href', '/account/saved-searches');
  });

  it('is absent for a signed-out shopper and without a search term', () => {
    const { unmount } = renderWithProviders(<SaveSearchButton {...props} />, {
      session: makeSession({ user: null, isCustomer: false }),
    });
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    renderWithProviders(<SaveSearchButton {...props} q="  " />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
