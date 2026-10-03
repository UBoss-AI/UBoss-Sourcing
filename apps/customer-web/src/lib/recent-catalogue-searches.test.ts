import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCatalogueSearches, recentCatalogueSearches, rememberCatalogueSearch } from './recent-catalogue-searches';
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
describe('tab-local recent catalogue searches', () => {
  it('keeps only eight bounded submitted words, most recent first, with case-insensitive deduplication', () => {
    for (let i = 0; i < 10; i++) rememberCatalogueSearch('gloves ' + String(i));
    rememberCatalogueSearch('GLOVES 9'); rememberCatalogueSearch(' '); rememberCatalogueSearch('x'.repeat(121));
    expect(recentCatalogueSearches()).toHaveLength(8); expect(recentCatalogueSearches()[0]).toBe('GLOVES 9');
    expect(recentCatalogueSearches()).not.toContain('gloves 9'); clearCatalogueSearches(); expect(recentCatalogueSearches()).toEqual([]);
  });
  it('ignores corrupt or wrong-shaped saved values', () => {
    sessionStorage.setItem('uboss:recent-catalogue-searches', '{broken'); expect(recentCatalogueSearches()).toEqual([]);
    sessionStorage.setItem('uboss:recent-catalogue-searches', '{}'); expect(recentCatalogueSearches()).toEqual([]);
    sessionStorage.setItem('uboss:recent-catalogue-searches', JSON.stringify([null, '', 12, 'gloves'])); expect(recentCatalogueSearches()).toEqual(['gloves']);
  });
  it('does not break searching when optional browser storage is refused', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage refused'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage refused'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('storage refused'); });
    expect(recentCatalogueSearches()).toEqual([]); expect(() => { rememberCatalogueSearch('gloves'); clearCatalogueSearches(); }).not.toThrow();
  });
});
