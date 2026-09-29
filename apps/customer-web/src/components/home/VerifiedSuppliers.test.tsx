/**
 * The home page's verified suppliers, and the sentence under the headline.
 *
 * The rule under test is the one that keeps the page honest on every
 * deployment: **a claim about suppliers appears only when the API says there
 * are suppliers to make it about**, and a country is named only when every
 * verified supplier is registered there.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from '@/pages/HomePage';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { errorResponse, jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import type { SupplierListResponse, VerifiedSupplier } from '@/lib/types';

const fetchMock = vi.fn();
const GUEST = makeSession({ user: null, isCustomer: false });

function supplier(overrides: Partial<VerifiedSupplier> = {}): VerifiedSupplier {
  return {
    slug: 'acme-industries',
    displayName: 'Acme Industries',
    kind: 'MANUFACTURER',
    registrationCountry: 'IN',
    verifiedAt: '2026-01-10T00:00:00.000Z',
    productCount: 12,
    logoUrl: null,
    ...overrides,
  };
}

function serve(answer: SupplierListResponse | 'fail'): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/catalog/suppliers')) {
      return Promise.resolve(
        answer === 'fail'
          ? errorResponse(503, 'SERVICE_UNAVAILABLE', 'Unavailable.')
          : jsonResponse(answer),
      );
    }
    if (url.includes('/catalog/categories')) return Promise.resolve(jsonResponse({ categories: [] }));
    if (url.includes('/catalog/products')) {
      return Promise.resolve(
        jsonResponse({
          products: [],
          pagination: { page: 1, limit: 12, total: 0, totalPages: 0 },
          currency: 'INR',
          country: 'IN',
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

/**
 * Until the suppliers read has been answered and rendered.
 *
 * The "nothing is shown" cases cannot wait for something to appear, so they
 * wait for the request to have been made and then for its answer to land.
 */
async function suppliersSettled(): Promise<void> {
  await waitFor(() => {
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/catalog/suppliers'))).toBe(true);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function renderHome(): void {
  renderWithProviders(<HomePage />, { config: FALLBACK_CONFIG, session: GUEST });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verified suppliers on the home page', () => {
  it('names the country when every verified supplier is registered there', async () => {
    serve({
      suppliers: [supplier(), supplier({ slug: 'bharat-tools', displayName: 'Bharat Tools' })],
      countries: [{ country: 'IN', count: 2 }],
      total: 2,
    });
    renderHome();

    const section = await screen.findByRole('region', { name: 'Verified suppliers from India' });
    expect(within(section).getByText(/reviewed and approved by/)).toBeInTheDocument();
    expect(await screen.findByTestId('value-proposition')).toHaveTextContent(
      'Source direct from verified suppliers in India, priced in your currency and ordered online.',
    );
  });

  it('names no country when the suppliers are registered in several', async () => {
    serve({
      suppliers: [supplier(), supplier({ slug: 'euro', displayName: 'Euro Parts', registrationCountry: 'DE' })],
      countries: [
        { country: 'IN', count: 1 },
        { country: 'DE', count: 1 },
      ],
      total: 2,
    });
    renderHome();

    expect(await screen.findByRole('region', { name: 'Verified suppliers' })).toBeInTheDocument();
    expect(await screen.findByTestId('value-proposition')).toHaveTextContent(
      'Source direct from verified suppliers, priced in your currency and ordered online.',
    );
  });

  it('each card opens the catalogue filtered to that supplier and says what it knows', async () => {
    serve({
      suppliers: [supplier(), supplier({ slug: 'older-co', displayName: 'Older Co', verifiedAt: null, productCount: 1, kind: 'WHOLESALER' })],
      countries: [{ country: 'IN', count: 2 }],
      total: 2,
    });
    renderHome();

    const acme = await screen.findByRole('link', { name: /Acme Industries/ });
    expect(acme).toHaveAttribute('href', '/suppliers/acme-industries');
    expect(acme).toHaveTextContent('Manufacturer · India');
    expect(acme).toHaveTextContent('Verified since January 2026');
    expect(acme).toHaveTextContent('12 products');

    // No approval date recorded: it says verified, and never invents a date.
    const older = screen.getByRole('link', { name: /Older Co/ });
    expect(older).toHaveTextContent('Wholesaler · India');
    expect(older).toHaveTextContent('Verified by');
    expect(older).not.toHaveTextContent('since');
    expect(older).toHaveTextContent('1 product');
  });

  it('says nothing about suppliers when there are none', async () => {
    serve({ suppliers: [], countries: [], total: 0 });
    renderHome();
    await suppliersSettled();

    expect(screen.getByTestId('value-proposition')).toHaveTextContent(
      'Everything your business orders, in one place',
    );
    expect(screen.queryByRole('region', { name: /Verified suppliers/ })).not.toBeInTheDocument();
    // The wordings kept for measuring are hidden from everybody; none shown mentions suppliers.
    for (const node of screen.queryAllByText(/verified suppliers/i)) {
      expect(node).toHaveAttribute('aria-hidden', 'true');
      expect(node).toHaveClass('invisible');
    }
  });

  it('hides the section, and makes no claim, when the read fails', async () => {
    serve('fail');
    renderHome();
    await suppliersSettled();

    expect(await screen.findByTestId('value-proposition')).toHaveTextContent(
      'Everything your business orders, in one place',
    );
    expect(screen.queryByRole('region', { name: /Verified suppliers/ })).not.toBeInTheDocument();
  });

  it('survives a malformed answer without a claim or a crash', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({})));
    renderHome();
    await suppliersSettled();

    expect(await screen.findByTestId('value-proposition')).toHaveTextContent(
      'Everything your business orders, in one place',
    );
  });

  it('keeps the hidden wordings away from screen readers', async () => {
    serve({ suppliers: [supplier()], countries: [{ country: 'IN', count: 1 }], total: 1 });
    renderHome();
    await screen.findByRole('region', { name: 'Verified suppliers from India' });

    const shown = screen.getByTestId('value-proposition');
    const line = shown.parentElement;
    expect(line).not.toBeNull();
    const hidden = Array.from(line?.children ?? []).filter((child) => child !== shown);
    expect(hidden).toHaveLength(2);
    for (const child of hidden) expect(child).toHaveAttribute('aria-hidden', 'true');
    expect(shown).not.toHaveAttribute('aria-hidden');
  });

  it('asks for the suppliers once, however many parts of the page use them', async () => {
    serve({ suppliers: [supplier()], countries: [{ country: 'IN', count: 1 }], total: 1 });
    renderHome();

    await screen.findByRole('region', { name: 'Verified suppliers from India' });
    const reads = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/catalog/suppliers'));
    expect(reads).toHaveLength(1);
    expect(String(reads[0]?.[0])).toContain('limit=8');
  });
});
