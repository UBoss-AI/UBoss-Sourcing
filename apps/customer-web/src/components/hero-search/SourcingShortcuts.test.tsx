import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourcingShortcuts } from './SourcingShortcuts';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { renderWithProviders } from '@/test/harness';
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });
const config = { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, rfq: true, imageSearch: true } };
describe('sourcing shortcuts', () => {
  it('preserves typed words in separate product, supplier and editable RFQ destinations and explicitly opens image search', async () => {
    const image = vi.fn();
    renderWithProviders(<SourcingShortcuts term=" glove & mask " onImageSearch={image} />, { config });
    expect(screen.getByRole('link', { name: 'Product' })).toHaveAttribute('href', '/products?q=glove%20%26%20mask');
    expect(screen.getByRole('link', { name: 'Supplier' })).toHaveAttribute('href', '/suppliers?q=glove%20%26%20mask');
    expect(screen.getByRole('link', { name: 'RFQ' })).toHaveAttribute('href', '/account/rfqs/new?title=glove%20%26%20mask');
    expect(screen.getByRole('button', { name: 'Image search' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Image search' })); expect(image).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(call => (call[1] as RequestInit | undefined)?.method !== 'POST')).toBe(true);
  });
  it('makes no supplier claim and reserves no space above the chips', () => {
    renderWithProviders(<SourcingShortcuts term="" onImageSearch={() => {}} />, { config });
    // The row starts with the chips: no hidden placeholder line holds a gap open.
    const section = screen.getByRole('region');
    expect(section.firstElementChild?.querySelector('a')).toHaveAttribute('href', '/products');
    expect(screen.queryByText(/verified/i)).toBeNull();
    // Nothing is read for it either.
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/catalog/suppliers'))).toBe(false);
  });
  it('keeps feature-off destinations unavailable', () => {
    renderWithProviders(<SourcingShortcuts term="" onImageSearch={() => {}} />, { config: { ...config, features: { ...config.features, rfq: false, imageSearch: false } } });
    expect(screen.queryByRole('link', { name: 'RFQ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Image search' })).not.toBeInTheDocument();
    expect(screen.getByText('RFQ is unavailable here')).toBeVisible();
  });
});
