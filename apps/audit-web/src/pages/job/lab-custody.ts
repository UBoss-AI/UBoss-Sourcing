/**
 * The chain of custody arrives as JSON the server wrote; read it defensively,
 * keeping only entries that carry a time and both parties.
 */
export interface CustodyEntry {
  at: string;
  from: string;
  to: string;
  note: string | null;
}

export function custodyOf(value: unknown): CustodyEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: CustodyEntry[] = [];
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const { at, from, to, note } = record;
    if (typeof at !== 'string' || typeof from !== 'string' || typeof to !== 'string') continue;
    entries.push({ at, from, to, note: typeof note === 'string' ? note : null });
  }
  return entries;
}

/** A `datetime-local` value (reader's own clock) as an ISO instant, or null. */
export function localInputToIso(value: string): string | null {
  if (value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
