/**
 * The catalogue filter panel.
 *
 * Every filter here is a promise to a shopper that the grid beneath it has
 * been narrowed. So what these tests assert is the round trip: ticking a
 * control writes the parameter the API reads, a chip appears saying what was
 * done, and removing the chip undoes exactly that one thing.
 *
 * The URL is the whole state of this page — a filtered list is something
 * people send to a colleague — so a filter that changed only local state would
 * pass a rendering test and still be broken.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogPage } from './CatalogPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { makeProduct } from '@/test/fixtures';

const fetchMock = vi.fn();

/** Every request the page has made, in order. */
function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

/** The most recent product listing request, as parsed parameters. */
function lastListingParams(): URLSearchParams {
  const listings = requestedUrls().filter((url) => url.includes('/catalog/products'));
  const last = listings.at(-1);
  if (last === undefined) throw new Error('The page never asked for any products.');
  return new URL(last, 'http://localhost').searchParams;
}

/**
 * Serve the catalogue: one product, one facet, a price range.
 *
 * The facets are deliberately not empty — the panel renders whatever the
 * catalogue says it can be filtered by, and a test against an empty response
 * would assert nothing about the part that is hardest to get right.
 */
function serveCatalog(): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/catalog/filters')) {
      return Promise.resolve(
        jsonResponse({
          currency: 'INR',
          priceRange: {
            min: { minor: '42000', formatted: '420.00', currency: 'INR' },
            max: { minor: '450000', formatted: '4,500.00', currency: 'INR' },
          },
          attributes: [
            {
              name: 'Sterilisation',
              values: [
                { value: 'Gamma sterile', count: 6 },
                { value: 'Ethylene oxide', count: 11 },
              ],
            },
          ],
        }),
      );
    }

    if (url.includes('/catalog/categories/')) {
      return Promise.resolve(jsonResponse({ category: { id: 'c1', name: 'Consumables' } }));
    }

    // The tree, for the panel's category block. Two levels, because the whole
    // point of that block is the step back up to the parent.
    if (url.includes('/catalog/categories')) {
      return Promise.resolve(
        jsonResponse({
          categories: [
            {
              id: 'c0',
              name: 'Consumables',
              slug: 'consumables',
              parentId: null,
              depth: 0,
              sortOrder: 1,
              isActive: true,
              productCount: 40,
              children: [
                {
                  id: 'c1',
                  name: 'Line Access',
                  slug: 'line-access',
                  parentId: 'c0',
                  depth: 1,
                  sortOrder: 1,
                  isActive: true,
                  productCount: 7,
                  children: [],
                },
                {
                  id: 'c2',
                  name: 'Syringes',
                  slug: 'syringes',
                  parentId: 'c0',
                  depth: 1,
                  sortOrder: 2,
                  isActive: true,
                  productCount: 12,
                  children: [],
                },
              ],
            },
          ],
        }),
      );
    }

    return Promise.resolve(
      jsonResponse({
        products: [makeProduct()],
        currency: 'INR',
        pagination: { page: 1, limit: 24, total: 1, totalPages: 1 },
      }),
    );
  });
}

/** The desktop sidebar. The same controls also live in the mobile dialog. */
function sidebar(): HTMLElement {
  return screen.getByRole('complementary');
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  serveCatalog();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CatalogPage filters', () => {
  it('says what it does in ordinary words', async () => {
    renderWithProviders(<CatalogPage />, { route: '/products' });

    // Not "Availability" and "Purchasing" — the shop's words for these. A
    // filter panel is read by someone who has never seen a catalogue admin.
    expect(await screen.findByText('Show only')).toBeInTheDocument();

    const panel = sidebar();
    expect(within(panel).getByLabelText(/In stock/)).toBeInTheDocument();
    expect(within(panel).getByLabelText(/On offer/)).toBeInTheDocument();
    expect(within(panel).getByText('Hide anything that has sold out.')).toBeInTheDocument();
  });

  it('tells the shopper what the catalogue costs before they guess', async () => {
    renderWithProviders(<CatalogPage />, { route: '/products' });

    expect(
      await screen.findByText('Prices here run from ₹420.00 to ₹4,500.00.'),
    ).toBeInTheDocument();
  });

  it('asks the server for in-stock products, and says so with a chip', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogPage />, { route: '/products' });

    await user.click(await within(sidebar()).findByLabelText(/In stock/));

    await waitFor(() => {
      expect(lastListingParams().get('inStockOnly')).toBe('true');
    });

    // The chip is how somebody looking at four results finds out why there are
    // only four, without opening anything.
    expect(screen.getByRole('button', { name: 'Remove filter: In stock' })).toBeInTheDocument();
  });

  it('offers the attributes the catalogue says it has, with their counts', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogPage />, { route: '/products' });

    // Nothing about Sterilisation is written into the page: it is offered
    // because this catalogue reported it as a filter.
    const facet = await within(sidebar()).findByLabelText(/Gamma sterile/);
    expect(within(sidebar()).getByText('6')).toBeInTheDocument();

    await user.click(facet);

    await waitFor(() => {
      expect(lastListingParams().getAll('attr')).toEqual(['Sterilisation:Gamma sterile']);
    });
  });

  it('sends two ticked values of one attribute as two parameters', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogPage />, { route: '/products' });

    const panel = sidebar();
    await user.click(await within(panel).findByLabelText(/Gamma sterile/));
    await user.click(await within(panel).findByLabelText(/Ethylene oxide/));

    // Not one comma-joined parameter: the API reads repeated `attr` pairs, and
    // a value may itself contain a comma.
    await waitFor(() => {
      expect(lastListingParams().getAll('attr')).toEqual([
        'Sterilisation:Gamma sterile',
        'Sterilisation:Ethylene oxide',
      ]);
    });
  });

  it('removes one facet value without disturbing the other', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogPage />, {
      route: '/products?attr=Sterilisation%3AGamma+sterile&attr=Sterilisation%3AEthylene+oxide',
    });

    await user.click(
      await screen.findByRole('button', { name: 'Remove filter: Sterilisation: Gamma sterile' }),
    );

    await waitFor(() => {
      expect(lastListingParams().getAll('attr')).toEqual(['Sterilisation:Ethylene oxide']);
    });
  });

  it('does not reload the facet list when a facet value is ticked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogPage />, { route: '/products' });

    await user.click(await within(sidebar()).findByLabelText(/Gamma sterile/));
    await waitFor(() => {
      expect(lastListingParams().getAll('attr')).toHaveLength(1);
    });

    // The counts are taken with the attribute filters left off, so ticking a
    // value cannot change them. Refetching would only shuffle the list under
    // the shopper's cursor.
    const facetRequests = requestedUrls().filter((url) => url.includes('/catalog/filters'));
    expect(facetRequests.every((url) => !url.includes('attr='))).toBe(true);
  });

  it('narrows the catalogue by when a product was added', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogPage />, { route: '/products' });

    await user.selectOptions(await within(sidebar()).findByLabelText('When it was added'), '30');

    await waitFor(() => {
      expect(lastListingParams().get('addedWithinDays')).toBe('30');
    });

    expect(
      screen.getByRole('button', { name: 'Remove filter: Added in the last 30 days' }),
    ).toBeInTheDocument();
  });

  it('drops the page number when a filter changes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogPage />, { route: '/products?page=3' });

    await user.click(await within(sidebar()).findByLabelText(/On offer/));

    // Page 3 of the old result very likely does not exist in the new one, and
    // landing on an empty page reads as "no matches" rather than "wrong page".
    await waitFor(() => {
      expect(lastListingParams().get('onSaleOnly')).toBe('true');
    });
    expect(lastListingParams().get('page')).toBe('1');
  });

  it('clears every filter at once but keeps the search term', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogPage />, {
      route:
        '/products?q=bandage&inStock=true&onSale=true&added=7&attr=Sterilisation%3AGamma+sterile',
    });

    // The sidebar's own Clear all, not the one beside the chips: both call the
    // same thing, and picking by container says which is under test.
    await user.click(await within(sidebar()).findByRole('button', { name: 'Clear all' }));

    await waitFor(() => {
      const params = lastListingParams();
      expect(params.get('inStockOnly')).toBeNull();
      expect(params.get('onSaleOnly')).toBeNull();
      expect(params.get('addedWithinDays')).toBeNull();
      expect(params.getAll('attr')).toEqual([]);
      // The search is the shopper's intent, not a filter. Clearing filters
      // must not throw away what they were looking for.
      expect(params.get('q')).toBe('bandage');
    });
  });
});

/**
 * The listing's own controls: the order it is in, and where in the tree it is.
 *
 * Both write to the URL, which is the whole state of this page — a sorted,
 * filtered listing is something people send to a colleague. A control that
 * changed only local state would pass a rendering test and still be broken.
 */
describe('CatalogPage listing controls', () => {
  it('offers every order as a pressable option, with the current one pressed', async () => {
    renderWithProviders(<CatalogPage />, { route: '/products' });

    const bar = await screen.findByRole('group', { name: 'Sort by' });

    // Five options, not a dropdown hiding four of them: trying another order
    // is the fastest thing a shopper does on a listing page.
    expect(within(bar).getAllByRole('button')).toHaveLength(5);
    expect(within(bar).getByRole('button', { name: 'Newest first' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(bar).getByRole('button', { name: 'Price: low to high' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('asks the server for the order that was pressed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogPage />, { route: '/products' });

    const bar = await screen.findByRole('group', { name: 'Sort by' });
    await user.click(within(bar).getByRole('button', { name: 'Price: low to high' }));

    await waitFor(() => {
      expect(lastListingParams().get('sort')).toBe('price_asc');
    });

    expect(
      within(await screen.findByRole('group', { name: 'Sort by' })).getByRole('button', {
        name: 'Price: low to high',
      }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends the shopper back up the tree from inside a category', async () => {
    // Rendered through a real route, not bare: the page reads its category
    // from `useParams`, so a bare render is the /products case however the
    // memory router's entry is spelled — which is a trap worth leaving
    // written down, because the test passes and asserts the wrong page.
    renderWithProviders(
      <Routes>
        <Route path="/category/:slug" element={<CatalogPage />} />
      </Routes>,
      { route: '/category/line-access' },
    );

    const panel = sidebar();

    // The step up, which a department page reached from a menu otherwise only
    // has via the breadcrumb at the very top of the page.
    expect(await within(panel).findByRole('link', { name: 'Consumables' })).toHaveAttribute(
      'href',
      '/category/consumables',
    );

    // Where you are, stated and not a link: a link to the page you are on is
    // a control that does nothing.
    const here = within(panel).getByText('Line Access');
    expect(here).toHaveAttribute('aria-current', 'page');
    expect(here.closest('a')).toBeNull();
  });

  it('lists the top level when no category is chosen', async () => {
    renderWithProviders(<CatalogPage />, { route: '/products' });

    const panel = sidebar();

    expect(await within(panel).findByRole('link', { name: /Consumables/ })).toHaveAttribute(
      'href',
      '/category/consumables',
    );
    // No "up" link from the root, because there is nowhere up to go.
    expect(within(panel).queryByRole('link', { name: 'All products' })).not.toBeInTheDocument();
  });
});
