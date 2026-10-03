import { useQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourcingShortcuts } from './SourcingShortcuts';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { HOME_SUPPLIER_COUNT } from '@/lib/verified-suppliers';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
function QueryStatus(): React.JSX.Element {
  const { status } = useQuery({ queryKey: ['verified-suppliers', HOME_SUPPLIER_COUNT], enabled: false });
  return <output data-testid="manufacturer-query-status">{status}</output>;
}
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });
const config = { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, rfq: true, imageSearch: true } };
describe('sourcing shortcuts', () => {
  it('preserves typed words in separate product, supplier and editable RFQ destinations and explicitly opens image search', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ suppliers: [] })); const image = vi.fn();
    renderWithProviders(<SourcingShortcuts term=" glove & mask " onImageSearch={image} />, { config });
    expect(screen.getByRole('link', { name: 'Product' })).toHaveAttribute('href', '/products?q=glove%20%26%20mask');
    expect(screen.getByRole('link', { name: 'Supplier' })).toHaveAttribute('href', '/suppliers?q=glove%20%26%20mask');
    expect(screen.getByRole('link', { name: 'RFQ' })).toHaveAttribute('href', '/account/rfqs/new?title=glove%20%26%20mask');
    expect(screen.getByRole('button', { name: 'Image search' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Image search' })); expect(image).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(call => (call[1] as RequestInit | undefined)?.method !== 'POST')).toBe(true);
  });
  it('shows the manufacturer statement only for an actual Indian manufacturer and reserves its layout', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ suppliers: [{ kind: 'MANUFACTURER', registrationCountry: 'IN', verifiedAt: '2026-01-01T00:00:00.000Z' }] }));
    renderWithProviders(<SourcingShortcuts term="" onImageSearch={() => {}} />, { config });
    const line = screen.getByText('Source from verified Indian manufacturers');
    expect(line).toHaveStyle({ visibility: 'hidden' });
    expect(line).toHaveAttribute('aria-hidden', 'true');
    expect(line).not.toHaveAttribute('hidden');
    await waitFor(() => { expect(line).toBeVisible(); });
    expect(line).toHaveAttribute('aria-hidden', 'false');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('limit=8');
    expect(screen.getByRole('link', { name: 'Supplier' })).toHaveAttribute('href', '/suppliers');
  });
  it.each([
    { suppliers: [{ kind: 'TRADER', registrationCountry: 'IN', verifiedAt: '2026-01-01T00:00:00.000Z' }] },
    { suppliers: [{ kind: 'MANUFACTURER', registrationCountry: 'DE', verifiedAt: '2026-01-01T00:00:00.000Z' }] },
    ...[undefined, null, '', 'not-a-date', '2026-02-30T00:00:00.000Z', '2026-01-01', '2999-01-01T00:00:00.000Z', 123].map(verifiedAt => ({ suppliers: [{ kind: 'MANUFACTURER', registrationCountry: 'IN', verifiedAt }] })),
    { suppliers: [null] }, { suppliers: [17, 'manufacturer', {}] }, { suppliers: 'invalid' }, {}, null,
  ])('makes no manufacturer claim for unrelated or malformed data %#', async response => {
    fetchMock.mockResolvedValue(jsonResponse(response));
    renderWithProviders(<><SourcingShortcuts term="" onImageSearch={() => {}} /><QueryStatus /></>, { config });
    await waitFor(() => { expect(screen.getByTestId('manufacturer-query-status')).toHaveTextContent('success'); });
    const line = screen.getByText('Source from verified Indian manufacturers');
    expect(line).not.toBeVisible();
    expect(line).toHaveStyle({ visibility: 'hidden' });
    expect(line).toHaveAttribute('aria-hidden', 'true');
    expect(line).not.toHaveAttribute('hidden');
  });
  it('keeps feature-off destinations unavailable and makes no claim after a failed read', async () => {
    fetchMock.mockResolvedValue(errorResponse(503, 'UNAVAILABLE', 'Unavailable'));
    renderWithProviders(<><SourcingShortcuts term="" onImageSearch={() => {}} /><QueryStatus /></>, { config: { ...config, features: { ...config.features, rfq: false, imageSearch: false } } });
    await waitFor(() => { expect(screen.getByTestId('manufacturer-query-status')).toHaveTextContent('error'); });
    expect(screen.queryByRole('link', { name: 'RFQ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Image search' })).not.toBeInTheDocument();
    expect(screen.getByText('RFQ is unavailable here')).toBeVisible();
    const line = screen.getByText('Source from verified Indian manufacturers');
    expect(line).not.toBeVisible();
    expect(line).toHaveStyle({ visibility: 'hidden' });
    expect(line).toHaveAttribute('aria-hidden', 'true');
    expect(line).not.toHaveAttribute('hidden');
  });
});
