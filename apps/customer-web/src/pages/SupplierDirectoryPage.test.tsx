import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupplierDirectoryPage } from './SupplierDirectoryPage';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
const fetchMock = vi.fn();
const supplier = { slug: 'approved-maker', displayName: '<script>Approved maker</script>', registrationCountry: 'IN', kind: 'MANUFACTURER', verifiedAt: null, productCount: 1, logoUrl: null };
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });
describe('public supplier destination', () => {
  it('loads escaped public labels and supplier destinations, then searches the submitted name', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ suppliers: [supplier] }));
    renderWithProviders(<SupplierDirectoryPage />, { route: '/suppliers?q=maker' });
    const link = await screen.findByRole('link', { name: /Approved maker/ }); expect(link).toHaveAttribute('href', '/suppliers/approved-maker'); expect(link.querySelector('script')).toBeNull();
    expect(link).not.toHaveAccessibleName(/Verified/i); expect(screen.queryByText('Verified')).not.toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Supplier public name' }); expect(input).toHaveValue('maker');
    const user = userEvent.setup(); await user.clear(input); await user.type(input, 'other'); await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => { expect(fetchMock.mock.calls.some(call => String(call[0]).includes('q=other'))).toBe(true); });
  });
  it('shows loading and an honest empty state', async () => {
    let finish: (value: Response) => void = () => {}; fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    renderWithProviders(<SupplierDirectoryPage />); expect(screen.getByRole('status')).toBeVisible();
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); }); finish(jsonResponse({ suppliers: [] }));
    expect(await screen.findByText('No approved suppliers matched. Try fewer words or clear the search.')).toBeVisible();
  });
  it.each([
    null, 7, 'invalid', {}, { suppliers: null },
    ...[null, 7, 'invalid', {}, { ...supplier, displayName: {} }, { ...supplier, displayName: '' },
      { ...supplier, slug: null }, { ...supplier, slug: '../escape' }, { ...supplier, slug: '' },
      { ...supplier, slug: 'a'.repeat(181) }, { ...supplier, registrationCountry: {} },
      { ...supplier, registrationCountry: 'ZZ' }, { ...supplier, registrationCountry: 'in' },
    ].map(row => ({ suppliers: [supplier, row] })),
    { suppliers: Array.from({ length: 25 }, () => supplier) },
  ])('rejects malformed public rows after settlement and recovers only on explicit retry %#', async response => {
    fetchMock.mockResolvedValueOnce(jsonResponse(response)).mockResolvedValue(jsonResponse({ suppliers: [supplier] }));
    renderWithProviders(<SupplierDirectoryPage />);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Approved maker/ })).not.toBeInTheDocument();
    expect(screen.queryByText('No approved suppliers matched. Try fewer words or clear the search.')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /Approved maker/ })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each(['failure', 'malformed'])('offers explicit retry after %s, then renders the recovered public response', async kind => {
    fetchMock.mockResolvedValueOnce(kind === 'failure' ? errorResponse(503, 'UNAVAILABLE', 'Unavailable') : jsonResponse({ suppliers: null })).mockResolvedValue(jsonResponse({ suppliers: [supplier] }));
    renderWithProviders(<SupplierDirectoryPage />); expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByText('No approved suppliers matched. Try fewer words or clear the search.')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' })); expect(await screen.findByRole('link', { name: /Approved maker/ })).toBeVisible();
  });
});
