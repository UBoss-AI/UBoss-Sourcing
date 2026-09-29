/**
 * `/suppliers/:slug` (checklist Master row 5): everything the profile holds,
 * each section only when it has something, a real 404, and an error that can
 * be retried.
 */
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupplierPage } from './SupplierPage';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import type { SupplierProfile } from '@/lib/types';

const fetchMock = vi.fn();

function profile(overrides: Partial<SupplierProfile> = {}): SupplierProfile {
  return {
    slug: 'acme-castings',
    displayName: 'Acme Castings',
    kind: 'MANUFACTURER',
    registrationCountry: 'IN',
    verifiedAt: '2026-02-01T00:00:00.000Z',
    logoUrl: null,
    description: 'We make precision castings.',
    websiteUrl: 'https://acme.example.com/',
    yearsInBusiness: 18,
    productCount: 2,
    categories: [{ slug: 'castings', name: 'Castings', productCount: 2 }],
    exportCapable: true,
    exportMarkets: ['DE', 'US'],
    yearsExporting: 7,
    responseSlaHours: 24,
    capabilities: ['CNC machining'],
    factories: [
      {
        name: 'Pune plant',
        city: 'Pune',
        region: 'Maharashtra',
        countryCode: 'IN',
        establishedYear: 2008,
        workforceCount: 140,
        monthlyCapacity: 50000,
        capacityUnit: 'pieces',
        productsMade: 'Valves and flanges',
      },
    ],
    certifications: [
      {
        standard: 'ISO 9001',
        issuer: 'TÜV',
        certificateNumber: 'ISO-1',
        scope: null,
        issuedOn: '2025-01-01',
        expiresOn: '2099-01-01',
        verifiedAt: '2026-01-15T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function render(path = '/suppliers/acme-castings'): void {
  renderWithProviders(
    <Routes>
      <Route path="/suppliers/:slug" element={<SupplierPage />} />
    </Routes>,
    { route: path },
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SupplierPage', () => {
  it('shows the company, what the marketplace verified, and what the supplier states', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ supplier: profile() }));
    render();

    expect(await screen.findByRole('heading', { level: 1, name: 'Acme Castings' })).toBeInTheDocument();
    expect(screen.getByText(/Manufacturer · India · 18 years in business/)).toBeInTheDocument();
    expect(screen.getByText('Verified since February 2026')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See its 2 products' })).toHaveAttribute('href', '/products?seller=acme-castings');
    const website = screen.getByRole('link', { name: /Website/ });
    expect(website).toHaveAttribute('href', 'https://acme.example.com/');
    expect(website).toHaveAttribute('rel', 'noopener noreferrer nofollow');

    expect(screen.getByRole('region', { name: 'Verified certifications' })).toHaveTextContent('ISO 9001');
    expect(screen.getByRole('region', { name: 'Factories' })).toHaveTextContent('Pune, Maharashtra, India');
    expect(screen.getByRole('region', { name: 'Capabilities and export' })).toHaveTextContent('Exports to: Germany, United States');
    expect(screen.getByRole('link', { name: /Castings/ })).toHaveAttribute('href', '/category/castings?seller=acme-castings');
    // What the marketplace did not check is labelled as the supplier's own words.
    expect(screen.getAllByText('As stated by the supplier.').length).toBeGreaterThanOrEqual(1);
  });

  it('leaves out every section it has nothing for', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        supplier: profile({
          description: null,
          websiteUrl: null,
          yearsInBusiness: null,
          factories: [],
          certifications: [],
          capabilities: [],
          exportCapable: false,
          exportMarkets: [],
          yearsExporting: null,
          responseSlaHours: null,
        }),
      }),
    );
    render();

    await screen.findByRole('heading', { level: 1 });
    for (const name of ['About the supplier', 'Verified certifications', 'Factories', 'Capabilities and export']) {
      expect(screen.queryByRole('region', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('link', { name: /Website/ })).not.toBeInTheDocument();
  });

  it('is a not-found page for an unknown supplier, and never asks for a malformed slug', async () => {
    fetchMock.mockResolvedValue(errorResponse(404, 'NOT_FOUND', 'Supplier not found.'));
    render('/suppliers/nobody');
    expect(await screen.findByRole('heading', { level: 1 })).not.toHaveTextContent('nobody');

    fetchMock.mockClear();
    render('/suppliers/Not%20A%20Slug');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers a retry when the read fails for another reason', async () => {
    fetchMock.mockResolvedValue(errorResponse(503, 'SERVICE_UNAVAILABLE', 'Unavailable.'));
    render();
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });
});
