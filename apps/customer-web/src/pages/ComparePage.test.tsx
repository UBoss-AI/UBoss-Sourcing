/**
 * Compare (checklist Master row 6): the list is per visitor and capped, every
 * value is read fresh, a gone item says so, and the table is a real table.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComparePage } from './ComparePage';
import { CompareButton } from '@/components/compare/CompareButton';
import { COMPARE_LIMIT, addToCompare, resetCompareForTests } from '@/lib/compare';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

function productBody(slug: string, name: string, price: string, extra: Record<string, unknown> = {}) {
  return {
    product: {
      id: slug,
      name,
      slug,
      sku: slug,
      price: { minor: price, formatted: (Number(price) / 100).toFixed(2), currency: 'INR' },
      compareAtPrice: null,
      purchaseRules: { minOrderQty: 10, maxOrderQty: null, qtyIncrement: 5, isRecurringEligible: false },
      primaryImage: null,
      specifications: [{ group: 'general', rows: [{ label: 'Material', value: 'Steel', unit: null, highlight: false }] }],
      purchasability: { isPriceOnRequest: false, isOrderable: true, unavailabilityReason: null, canAddToCart: true },
    },
    currency: 'INR',
    country: 'DE',
    taxNote: '',
    sourcing: {
      seller: { slug: 'acme', displayName: 'Acme Castings', kind: 'MANUFACTURER', registrationCountry: 'IN', verifiedAt: null },
      destination: 'DE',
      delivery: { status: 'AVAILABLE', notes: [] },
      handlingTimeDays: 7,
      countryOfOrigin: 'IN',
      inspection: { outlook: 'REQUIRED', fromValueMinor: null, currency: null },
    },
    ...extra,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  resetCompareForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CompareButton', () => {
  it('adds and removes, and says when the list is full', async () => {
    for (let i = 0; i < COMPARE_LIMIT; i += 1) addToCompare('products', { slug: `p-${String(i)}`, name: `P${String(i)}` });
    renderWithProviders(<CompareButton kind="products" slug="extra" name="Extra" />);

    await userEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(screen.getByRole('status')).toHaveTextContent('You can compare up to 4 at a time');
    expect(screen.getByRole('button', { name: 'Compare' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggles an item in and out, and offers the comparison once there are two', async () => {
    addToCompare('products', { slug: 'first', name: 'First' });
    renderWithProviders(<CompareButton kind="products" slug="second" name="Second" />);

    await userEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(screen.getByRole('button', { name: 'In comparison' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: 'Compare 2 items' })).toHaveAttribute('href', '/compare?tab=products');

    await userEvent.click(screen.getByRole('button', { name: 'In comparison' }));
    expect(screen.getByRole('button', { name: 'Compare' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('ComparePage', () => {
  it('reads every product fresh and lays them out in a real table', async () => {
    addToCompare('products', { slug: 'valve', name: 'Valve (old name)' });
    addToCompare('products', { slug: 'gone', name: 'Gone product' });
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/catalog/products/valve')
          ? jsonResponse(productBody('valve', 'Brass valve', '125000'))
          : errorResponse(404, 'NOT_FOUND', 'Product not found.'),
      ),
    );
    renderWithProviders(<ComparePage />, { route: '/compare' });

    const table = await screen.findByRole('table', { name: 'Products compared side by side' });
    // Today's name from the read, not the one remembered when it was added.
    expect(await within(table).findByRole('link', { name: 'Brass valve' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Price' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /Brass valve/ })).toBeInTheDocument();
    expect(within(table).getByText('Multiples of 5')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Acme Castings' })).toHaveAttribute('href', '/suppliers/acme');
    expect(within(table).getByText('Required')).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Material' })).toBeInTheDocument();
    // An item that has gone says so; it is never shown with remembered figures.
    expect(await within(table).findByText('No longer available here.')).toBeInTheDocument();
    // The country chosen by the shopper travels with each read.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('currency=');
  });

  it('removes a column and empties cleanly', async () => {
    addToCompare('products', { slug: 'valve', name: 'Valve' });
    fetchMock.mockResolvedValue(jsonResponse(productBody('valve', 'Brass valve', '125000')));
    renderWithProviders(<ComparePage />, { route: '/compare' });

    expect(await screen.findByText('Add at least one more to compare side by side.')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Valve' }));
    expect(screen.getByText('Nothing to compare yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Products (0)' })).toHaveAttribute('aria-current', 'page');
  });

  it('compares suppliers on the suppliers view', async () => {
    addToCompare('suppliers', { slug: 'acme', name: 'Acme' });
    fetchMock.mockResolvedValue(
      jsonResponse({
        supplier: {
          slug: 'acme',
          displayName: 'Acme Castings',
          kind: 'MANUFACTURER',
          registrationCountry: 'IN',
          verifiedAt: null,
          logoUrl: null,
          description: null,
          websiteUrl: null,
          yearsInBusiness: 18,
          productCount: 12,
          categories: [{ slug: 'castings', name: 'Castings', productCount: 12 }],
          exportCapable: true,
          exportMarkets: ['DE'],
          yearsExporting: null,
          responseSlaHours: 24,
          capabilities: [],
          factories: [],
          certifications: [],
        },
      }),
    );
    renderWithProviders(<ComparePage />, { route: '/compare?tab=suppliers' });

    const table = await screen.findByRole('table', { name: 'Suppliers compared side by side' });
    expect(await within(table).findByRole('link', { name: 'Acme Castings' })).toHaveAttribute('href', '/suppliers/acme');
    expect(within(table).getByText('None verified')).toBeInTheDocument();
    expect(within(table).getByText('Germany')).toBeInTheDocument();
    expect(within(table).getByText('24 hours')).toBeInTheDocument();
  });

  it('ignores a tampered stored list', async () => {
    localStorage.setItem('uboss.compare.v1', JSON.stringify({ products: [{ slug: '<script>', name: 'x' }, 'junk'] }));
    resetCompareForTests();
    localStorage.setItem('uboss.compare.v1', JSON.stringify({ products: [{ slug: '<script>', name: 'x' }, 'junk'] }));
    renderWithProviders(<ComparePage />, { route: '/compare' });
    expect(await screen.findByText('Nothing to compare yet')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
