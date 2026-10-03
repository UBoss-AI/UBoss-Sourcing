/**
 * The sentence under the home page's headline, and the supplier lists that are
 * no longer on the page.
 *
 * The rule under test is the one that keeps the page honest on every
 * deployment: **a claim about suppliers appears only when the API says there
 * are suppliers to make it about**, and a country is named only when every
 * verified supplier is registered there.
 *
 * "Verified suppliers" and "Newly verified suppliers" moved to the admin
 * console's Sellers screen. The storefront must show neither, and must not
 * spend a request on either.
 */
import { act, screen, waitFor } from '@testing-library/react';
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

describe('the value proposition on the home page', () => {
  it('names the country when every verified supplier is registered there', async () => {
    serve({
      suppliers: [supplier()],
      countries: [{ country: 'IN', count: 2 }],
      total: 2,
    });
    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId('value-proposition')).toHaveTextContent(/in India/);
    });
    expect(screen.getByTestId('value-proposition')).toHaveTextContent(
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

    await waitFor(() => {
      expect(screen.getByTestId('value-proposition')).toHaveTextContent(
        'Source direct from verified suppliers, priced in your currency and ordered online.',
      );
    });
  });

  it('shows no verified-supplier section and no supplier cards, even with suppliers', async () => {
    serve({
      suppliers: [supplier(), supplier({ slug: 'older-co', displayName: 'Older Co' })],
      countries: [{ country: 'IN', count: 2 }],
      total: 2,
    });
    renderHome();
    await suppliersSettled();

    expect(screen.queryByRole('region', { name: /Verified suppliers/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Newly verified suppliers/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /verified suppliers/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Acme Industries')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Older Co/ })).not.toBeInTheDocument();
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
    await waitFor(() => {
      expect(screen.getByTestId('value-proposition')).toHaveTextContent(/in India/);
    });

    const shown = screen.getByTestId('value-proposition');
    const line = shown.parentElement;
    expect(line).not.toBeNull();
    const hidden = Array.from(line?.children ?? []).filter((child) => child !== shown);
    expect(hidden).toHaveLength(2);
    for (const child of hidden) expect(child).toHaveAttribute('aria-hidden', 'true');
    expect(shown).not.toHaveAttribute('aria-hidden');
  });

  it('asks for one supplier, once, and never for the newest-suppliers list', async () => {
    serve({ suppliers: [supplier()], countries: [{ country: 'IN', count: 1 }], total: 1 });
    renderHome();
    await suppliersSettled();

    const reads = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/catalog/suppliers'));
    expect(reads).toHaveLength(1);
    expect(String(reads[0]?.[0])).toContain('limit=1');
    expect(String(reads[0]?.[0])).not.toContain('sort=newest');
  });
});
