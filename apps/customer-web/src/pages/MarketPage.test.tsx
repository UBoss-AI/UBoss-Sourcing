/**
 * `/markets/:country` (checklist Master row 8): the system's facts always, the
 * operator's text only when published, and a working market switch.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketPage } from './MarketPage';
import { errorResponse, jsonResponse, makeLocale, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

function body(profile: unknown = null, restrictions: unknown[] = []) {
  return { country: { code: 'DE', name: 'Germany', currencyCode: 'EUR' }, profile, restrictions };
}

function render(path: string, locale = makeLocale()): void {
  renderWithProviders(
    <Routes>
      <Route path="/markets/:country" element={<MarketPage />} />
    </Routes>,
    { route: path, locale },
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MarketPage', () => {
  it('shows the currency and says when nothing is restricted, with no operator text unpublished', async () => {
    fetchMock.mockResolvedValue(jsonResponse(body()));
    render('/markets/de');

    expect(await screen.findByRole('heading', { level: 1, name: 'Shopping from Germany' })).toBeInTheDocument();
    expect(screen.getByText('Buyers in Germany are quoted in EUR.')).toBeInTheDocument();
    expect(screen.getByText(/has recorded no restrictions for Germany/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Notes from/ })).not.toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/catalog/markets/DE');
  });

  it('lists what may not be sold there and what needs documents, with the reasons', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        body(null, [
          { effect: 'BLOCK', category: { slug: 'solvents', name: 'Solvents' }, product: null, reason: 'Import ban.', requiredDocuments: [] },
          { effect: 'DOCUMENTS_REQUIRED', category: null, product: { slug: 'drone', name: 'Drone' }, reason: 'Licensed.', requiredDocuments: ['Permit'] },
        ]),
      ),
    );
    render('/markets/de');

    expect(await screen.findByRole('link', { name: 'Solvents' })).toHaveAttribute('href', '/category/solvents');
    expect(screen.getByText('Import ban.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Drone' })).toHaveAttribute('href', '/product/drone');
    expect(screen.getByText('Documents needed: Permit')).toBeInTheDocument();
  });

  it('shows the operator’s published text, labelled as theirs', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        body({
          headline: 'Buying for Germany',
          intro: 'We ship from Pune.',
          dutiesGuidance: 'VAT is charged at checkout.',
          deliveryPromise: null,
          complianceNotes: null,
          featuredCategories: [{ slug: 'gloves', name: 'Gloves' }],
        }),
      ),
    );
    render('/markets/de');

    expect(await screen.findByRole('heading', { level: 1, name: 'Buying for Germany' })).toBeInTheDocument();
    expect(screen.getByText('VAT is charged at checkout.')).toBeInTheDocument();
    expect(screen.queryByText('Delivery')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Gloves' })).toHaveAttribute('href', '/category/gloves');
    expect(screen.getByText(/for this market\./)).toBeInTheDocument();
  });

  it('switches the shopper to this market through the locale choice', async () => {
    fetchMock.mockResolvedValue(jsonResponse(body()));
    const choose = vi.fn(() => Promise.resolve());
    render('/markets/de', makeLocale({ country: 'IN', choose }));

    await userEvent.click(await screen.findByRole('button', { name: 'Shop as a buyer in Germany' }));
    expect(choose).toHaveBeenCalledWith('DE', 'EUR');
  });

  it('says so when the shopper is already in this market', async () => {
    fetchMock.mockResolvedValue(jsonResponse(body()));
    render('/markets/de', makeLocale({ country: 'DE' }));
    expect(await screen.findByText('You are shopping as a buyer in Germany.')).toBeInTheDocument();
  });

  it('is a not-found page for a country not sold to, and never asks for a malformed code', async () => {
    fetchMock.mockResolvedValue(errorResponse(404, 'NOT_FOUND', 'Market not found.'));
    render('/markets/zz');
    expect(await screen.findByRole('heading', { level: 1 })).not.toHaveTextContent('Shopping from');

    fetchMock.mockClear();
    render('/markets/germany');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
