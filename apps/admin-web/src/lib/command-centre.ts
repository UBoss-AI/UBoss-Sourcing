/**
 * Small pure helpers for the command centre tiles. Kept out of the component
 * file so that file exports only a component (Fast Refresh keeps its state).
 */
import type { Money } from './types';

export const KPI_QUERY_KEY = ['admin-command-centre'] as const;

/**
 * How much `current` moved against `previous`, as a signed percentage with one
 * decimal, or null when there is nothing to compare with. BigInt throughout:
 * a money amount is never turned into a float on its way to a percentage.
 */
export function changeBetween(current: Money, previous: Money): string | null {
  const before = BigInt(previous.minor);
  if (before === 0n) return null;
  const basisPoints = ((BigInt(current.minor) - before) * 10_000n) / before;
  return formatChange(Number(basisPoints) / 100);
}

/** The same for a plain count. */
export function changeBetweenCounts(current: number, previous: number): string | null {
  if (previous === 0) return null;
  return formatChange(((current - previous) * 100) / previous);
}

function formatChange(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
}
