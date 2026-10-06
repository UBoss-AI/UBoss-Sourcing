/**
 * Recently viewed products and suppliers (checklist Master row 88).
 *
 * A per-browser convenience, so it lives in localStorage: nothing here is
 * shared, audited or needed by the server. Every read and write is guarded,
 * because storage can be missing, full or blocked, and the page must render
 * the same without it.
 */
export interface ViewedItem {
  kind: 'product' | 'supplier';
  slug: string;
  name: string;
  /** The product's main picture when it was viewed, for the home page row. */
  imageUrl?: string;
  viewedAt: string;
}

const KEY = 'recently-viewed.v1';
const LIMIT = 8;

export function readRecentlyViewed(): ViewedItem[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ViewedItem[]).filter((item) => typeof item.slug === 'string') : [];
  } catch {
    return [];
  }
}

export function recordViewed(item: Omit<ViewedItem, 'viewedAt'>, now = new Date()): void {
  if (item.slug === '' || item.name === '') return;
  try {
    const rest = readRecentlyViewed().filter((entry) => !(entry.kind === item.kind && entry.slug === item.slug));
    window.localStorage.setItem(KEY, JSON.stringify([{ ...item, viewedAt: now.toISOString() }, ...rest].slice(0, LIMIT)));
  } catch {
    // Storage unavailable: the list simply stays empty.
  }
}
