import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, makeLocale, renderWithProviders } from '@/test/harness';
import { makeProduct } from '@/test/fixtures';
import { OriginalProductText } from './OriginalProductText';
const fetchMock = vi.fn();
const original = makeProduct({ id: 'original-product', slug: 'gloves', name: 'Original gloves', shortDescription: 'Original brief', description: 'Original specification' });
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());
function mount() { return renderWithProviders(<><h1>Translated gloves</h1><OriginalProductText productId={original.id} slug={original.slug} currency="EUR" country="DE" /></>, { locale: makeLocale({ currency: 'EUR', country: 'DE' }) }); }
describe('original catalogue copy', () => {
  it('fetches only on keyboard activation, keeps the market, omits language, and preserves the translated product', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ product: original })); mount(); expect(fetchMock).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Show original product text' }); button.focus(); await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Original gloves')).toBeInTheDocument(); expect(screen.getByText('Original specification')).toBeInTheDocument(); expect(screen.getByRole('heading', { name: 'Translated gloves' })).toBeInTheDocument();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0])); expect(url.pathname).toMatch(/catalog\/products\/gloves$/); expect(url.searchParams.get('currency')).toBe('EUR'); expect(url.searchParams.get('country')).toBe('DE'); expect(url.searchParams.has('language')).toBe(false);
    expect(screen.getByRole('button', { name: 'Hide original product text' })).toHaveAttribute('aria-expanded', 'true'); await userEvent.click(screen.getByRole('button', { name: 'Hide original product text' })); expect(screen.queryByText('Original gloves')).not.toBeInTheDocument(); expect(screen.getByRole('heading', { name: 'Translated gloves' })).toBeInTheDocument();
  });
  it('keeps translated content on failure and retries the original read explicitly', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not available' } }, 404)).mockResolvedValueOnce(jsonResponse({ product: original })); mount(); fireEvent.click(screen.getByRole('button', { name: 'Show original product text' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded'); expect(screen.getByText('Translated gloves')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Try again' })); expect(await screen.findByText('Original gloves')).toBeInTheDocument(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('never displays source text for a different product identity', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ product: { ...original, id: 'foreign-product', name: 'Wrong original' } })); mount(); fireEvent.click(screen.getByRole('button', { name: 'Show original product text' })); expect(await screen.findByRole('alert')).toBeInTheDocument(); expect(screen.queryByText('Wrong original')).not.toBeInTheDocument();
  });
  it('escapes original plain text and sanitizes rich description markup', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ product: { ...original, name: '<img src=x onerror=alert(1)>', descriptionHtml: '<p>Original rich description</p><script>window.injected=true</script><img src=x onerror=alert(1)>' } })); const view = mount(); fireEvent.click(screen.getByRole('button', { name: 'Show original product text' })); await waitFor(() => { expect(screen.getByText('Original rich description')).toBeInTheDocument(); }); expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument(); expect(view.container.querySelector('script')).toBeNull(); expect(view.container.querySelector('[onerror]')).toBeNull();
  });
});
