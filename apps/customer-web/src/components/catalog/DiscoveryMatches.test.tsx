import { useState } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, makeLocale, renderWithProviders } from '@/test/harness';
import { rememberCatalogueSearch, recentCatalogueSearches } from '@/lib/recent-catalogue-searches';
import { DiscoveryMatches } from './DiscoveryMatches';
const fetchMock = vi.fn();
const response = { query: 'gloves', terms: ['gloves'], currency: 'EUR', country: 'DE', suggestions: [], items: [
  { scope: 'product', label: 'Sterile gloves', href: '/product/gloves' },
  { scope: 'category', label: 'Medical gloves', href: '/category/gloves' },
  { scope: 'supplier', label: 'Glove supplier', href: '/suppliers/glove-maker' },
  { scope: 'capability', label: 'OEM supplier', href: '/suppliers/oem-maker' },
] };
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });
describe('public catalogue matches', () => {
  it('offers labelled destinations with the current market and keyboard activation', async () => {
    fetchMock.mockResolvedValue(jsonResponse(response));
    renderWithProviders(<DiscoveryMatches q="gloves" />, { locale: makeLocale({ currency: 'EUR', country: 'DE' }) });
    const link = await screen.findByRole('link', { name: 'Product Sterile gloves' });
    expect(link).toHaveAttribute('href', '/product/gloves');
    expect(screen.getByRole('link', { name: 'Category Medical gloves' })).toHaveAttribute('href', '/category/gloves');
    expect(screen.getByRole('link', { name: 'Supplier Glove supplier' })).toHaveAttribute('href', '/suppliers/glove-maker');
    expect(screen.getByRole('link', { name: 'Supplier capability OEM supplier' })).toHaveAttribute('href', '/suppliers/oem-maker');
    link.focus(); expect(link).toHaveFocus(); await userEvent.keyboard('{Enter}');
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toMatch(/catalog\/search$/); expect(url.searchParams.get('q')).toBe('gloves');
    expect(url.searchParams.get('currency')).toBe('EUR'); expect(url.searchParams.get('country')).toBe('DE'); expect(url.searchParams.get('language')).toBe('en');
  });
  it('keeps a refused request recoverable with an explicit retry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Refused' } }, 503)).mockResolvedValueOnce(jsonResponse(response));
    renderWithProviders(<DiscoveryMatches q="gloves" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Product Sterile gloves' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('treats a malformed successful response as a recoverable read failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: null, suggestions: null }));
    renderWithProviders(<DiscoveryMatches q="gloves" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
  it('offers spelling suggestions and browsing without rewriting the buyer’s request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...response, query: 'glovs', items: [], suggestions: ['gloves'] }));
    renderWithProviders(<DiscoveryMatches q="glovs" />);
    expect(await screen.findByRole('link', { name: 'gloves' })).toHaveAttribute('href', '/search?q=gloves');
    expect(screen.getByRole('link', { name: 'Browse the catalogue' })).toHaveAttribute('href', '/products');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('q')).toBe('glovs');
  });
  it('debounces changing words and hides previously matched records while a new search settles', async () => {
    fetchMock.mockResolvedValue(jsonResponse(response));
    function ChangingQuery(): React.JSX.Element { const [q, setQ] = useState('gloves'); return <><button type="button" onClick={() => { setQ('boots'); }}>Change query</button><DiscoveryMatches q={q} /></>; }
    renderWithProviders(<ChangingQuery />);
    expect(await screen.findByText('Sterile gloves')).toBeInTheDocument();
    fetchMock.mockResolvedValue(jsonResponse({ ...response, query: 'boots', items: [], suggestions: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Change query' }));
    expect(screen.queryByText('Sterile gloves')).not.toBeInTheDocument();
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2); });
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('q')).toBe('boots');
  });
  it('escapes public display text and supplies recent-search editing and clearing without a network read', async () => {
    rememberCatalogueSearch('<img src=x onerror=alert(1)>'); const select = vi.fn();
    const view = renderWithProviders(<DiscoveryMatches q="" onRecentSelect={select} />);
    const recent = screen.getByRole('button', { name: '<img src=x onerror=alert(1)>' });
    recent.focus(); await userEvent.keyboard('{Enter}'); expect(select).toHaveBeenCalledWith('<img src=x onerror=alert(1)>');
    expect(view.container.querySelector('img')).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear recent searches' }));
    expect(recentCatalogueSearches()).toEqual([]); expect(screen.queryByRole('button', { name: '<img src=x onerror=alert(1)>' })).not.toBeInTheDocument();
  });
});
