/** Up to eight search words in this browser tab. Never sent to analytics. */
const KEY = 'uboss:recent-catalogue-searches';
export function recentCatalogueSearches(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 120))].slice(0, 8) : [];
  } catch { return []; }
}
export function rememberCatalogueSearch(value: string): void {
  const term = value.trim();
  if (term.length === 0 || term.length > 120) return;
  try { sessionStorage.setItem(KEY, JSON.stringify([term, ...recentCatalogueSearches().filter(x => x.toLocaleLowerCase() !== term.toLocaleLowerCase())].slice(0, 8))); } catch { /* Browser storage is optional. */ }
}
export function clearCatalogueSearches(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* Browser storage is optional. */ }
}
