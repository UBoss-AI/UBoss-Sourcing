/**
 * What this visitor has picked to compare (checklist Master row 6).
 *
 * A per-visitor convenience, so it lives in this browser and nowhere else: the
 * products and suppliers somebody is weighing up are nobody else's business
 * and need no account. Only the slug and the name are kept - every figure on
 * the comparison page is read fresh from the API when it opens, so a price
 * that changed since the item was added is the new price, never a stale copy.
 *
 * Storage can be missing (private windows, blocked site data) and every read
 * and write is guarded: without it the list simply lasts as long as the page.
 */
import { useSyncExternalStore } from 'react';

export type CompareKind = 'products' | 'suppliers';

export interface CompareEntry {
  slug: string;
  name: string;
}

/** Four columns is what a phone can still scroll through and a desk can show. */
export const COMPARE_LIMIT = 4;

const STORAGE_SLOT = 'uboss.compare.v1';
const EVENT = 'uboss-compare-changed';

type Lists = Record<CompareKind, CompareEntry[]>;

let memory: Lists = { products: [], suppliers: [] };

function isEntry(value: unknown): value is CompareEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CompareEntry).slug === 'string' &&
    /^[a-z0-9-]{1,255}$/.test((value as CompareEntry).slug) &&
    typeof (value as CompareEntry).name === 'string'
  );
}

function read(): Lists {
  try {
    const raw = localStorage.getItem(STORAGE_SLOT);
    if (raw === null) return memory;
    const parsed = JSON.parse(raw) as Partial<Record<CompareKind, unknown>>;
    const pick = (list: unknown): CompareEntry[] =>
      Array.isArray(list) ? list.filter(isEntry).slice(0, COMPARE_LIMIT) : [];
    return { products: pick(parsed.products), suppliers: pick(parsed.suppliers) };
  } catch {
    return memory;
  }
}

let snapshot: Lists = read();

function write(next: Lists): void {
  memory = next;
  snapshot = next;
  try {
    localStorage.setItem(STORAGE_SLOT, JSON.stringify(next));
  } catch {
    // Kept in memory for this page instead.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  const refresh = (): void => {
    snapshot = read();
    onChange();
  };
  window.addEventListener(EVENT, onChange);
  // Another tab changed it.
  window.addEventListener('storage', refresh);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', refresh);
  };
}

/** Add, or do nothing if it is already there or the list is full. Returns whether it is in the list afterwards. */
export function addToCompare(kind: CompareKind, entry: CompareEntry): boolean {
  const current = snapshot[kind];
  if (current.some((item) => item.slug === entry.slug)) return true;
  if (current.length >= COMPARE_LIMIT) return false;
  write({ ...snapshot, [kind]: [...current, { slug: entry.slug, name: entry.name }] });
  return true;
}

export function removeFromCompare(kind: CompareKind, slug: string): void {
  write({ ...snapshot, [kind]: snapshot[kind].filter((item) => item.slug !== slug) });
}

export function clearCompare(kind: CompareKind): void {
  write({ ...snapshot, [kind]: [] });
}

export function useCompareList(kind: CompareKind): CompareEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot[kind],
    () => snapshot[kind],
  );
}

/** For tests: forget everything, in memory and in storage. */
export function resetCompareForTests(): void {
  memory = { products: [], suppliers: [] };
  try {
    localStorage.removeItem(STORAGE_SLOT);
  } catch {
    // ignore
  }
  snapshot = memory;
}
