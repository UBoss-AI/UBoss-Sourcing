/**
 * Verified and newly verified suppliers on the Sellers screen.
 *
 *   - both sections list what the admin route returns, and a row opens the seller;
 *   - "newly verified" keeps only approvals inside the last 90 days;
 *   - each section has its own loading, empty and error state, and a retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { i18n } from '@/i18n/config';
import type { VerifiedSupplierRow } from '@/lib/sellers';
import { VerifiedSuppliersPanels } from './VerifiedSuppliersPanels';

vi.mock('@/lib/sellers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sellers')>();
  return { ...actual, fetchVerifiedSuppliers: vi.fn() };
});

const lib = await import('@/lib/sellers');
const fetchVerified = vi.mocked(lib.fetchVerifiedSuppliers);

function supplier(overrides: Partial<VerifiedSupplierRow> = {}): VerifiedSupplierRow {
  return {
    sellerId: '01SELLER000000000000000001',
    slug: 'acme',
    displayName: 'Acme Gloves',
    kind: 'MANUFACTURER',
    registrationCountry: 'IN',
    verifiedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    productCount: 12,
    logoUrl: null,
    ...overrides,
  };
}

function renderPanels(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/sellers']}>
          <Routes>
            <Route path="/sellers" element={<VerifiedSuppliersPanels />} />
            <Route path="/sellers/:id" element={<p>Seller page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const found = heading.closest('section');
  if (found === null) throw new Error(`no section for ${name}`);
  return found;
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fetchVerified.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('VerifiedSuppliersPanels', () => {
  it('lists verified suppliers, keeps only recent ones as new, and opens a seller', async () => {
    const old = supplier({
      sellerId: '01SELLER000000000000000002',
      slug: 'old',
      displayName: 'Old Mills',
      verifiedAt: '2024-01-01T00:00:00.000Z',
    });
    fetchVerified.mockImplementation((sort) =>
      Promise.resolve(
        sort === 'newest'
          ? { suppliers: [supplier(), old], total: 2 }
          : { suppliers: [old, supplier()], total: 2 },
      ),
    );
    renderPanels();

    await screen.findAllByText('Acme Gloves');
    const all = section('Verified suppliers');
    expect(within(all).getByText('Old Mills')).toBeTruthy();
    expect(within(all).getByText('Acme Gloves')).toBeTruthy();

    const recent = section('Newly verified suppliers');
    expect(within(recent).getByText('Acme Gloves')).toBeTruthy();
    expect(within(recent).queryByText('Old Mills')).toBeNull();

    fireEvent.click(within(recent).getByText('Acme Gloves'));
    expect(await screen.findByText('Seller page')).toBeTruthy();
  });

  it('shows a loading state while the list is on its way', () => {
    fetchVerified.mockReturnValue(new Promise(() => undefined));
    renderPanels();
    expect(screen.getAllByRole('status').length).toBe(2);
  });

  it('says so when nobody is verified, in each section', async () => {
    fetchVerified.mockResolvedValue({ suppliers: [], total: 0 });
    renderPanels();
    expect(await screen.findByText('No verified suppliers yet')).toBeTruthy();
    expect(screen.getByText('Nobody verified recently')).toBeTruthy();
  });

  it('shows the error and retries', async () => {
    fetchVerified.mockRejectedValue(new Error('You do not have permission to do that.'));
    renderPanels();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.textContent).toContain('You do not have permission to do that.');

    fetchVerified.mockResolvedValue({ suppliers: [supplier()], total: 1 });
    fireEvent.click(within(section('Verified suppliers')).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(within(section('Verified suppliers')).getByText('Acme Gloves')).toBeTruthy();
    });
  });
});
