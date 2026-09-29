/**
 * Suppliers above the search results (checklist Master row 2): shown only for
 * a real search that matched somebody, linking to that supplier's products,
 * and silent otherwise.
 */
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupplierMatches } from './SupplierMatches';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(names: string[]): void {
  fetchMock.mockResolvedValue(
    jsonResponse({
      suppliers: names.map((name, index) => ({
        slug: `supplier-${String(index)}`,
        displayName: name,
        kind: 'MANUFACTURER',
        registrationCountry: 'IN',
        verifiedAt: null,
        productCount: 3,
        logoUrl: null,
      })),
      countries: [{ country: 'IN', count: names.length }],
      total: names.length,
    }),
  );
}

async function settled(): Promise<void> {
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalled();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('SupplierMatches', () => {
  it('lists the matching verified suppliers, each opening their products', async () => {
    answer(['Acme Precision Castings']);
    renderWithProviders(<SupplierMatches q="acme" />);

    expect(await screen.findByRole('region', { name: 'Verified suppliers matching “acme”' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Acme Precision Castings/ });
    expect(link).toHaveAttribute('href', '/products?seller=supplier-0');
    expect(link).toHaveTextContent('India');
    // The shield is decoration; its meaning is read out as text.
    expect(link).toHaveTextContent(/Verified by/);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/catalog/suppliers');
    expect(url).toContain('q=acme');
    expect(url).toContain('limit=6');
  });

  it('asks nothing and shows nothing without a real search', async () => {
    renderWithProviders(<SupplierMatches q=" a " />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('shows nothing when nobody matched', async () => {
    answer([]);
    renderWithProviders(<SupplierMatches q="gloves" />);
    await settled();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('shows nothing, and no error, when the read fails', async () => {
    fetchMock.mockResolvedValue(errorResponse(503, 'SERVICE_UNAVAILABLE', 'Unavailable.'));
    renderWithProviders(<SupplierMatches q="gloves" />);
    await settled();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
