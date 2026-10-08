/**
 * The arithmetic and tones behind the health meter and badge in
 * `components/health.tsx`. Kept apart so the component file exports only
 * components, and so the geometry is tested on its own.
 */
import type { BadgeTone } from '@/components/ui';
import type { HealthBand, IssueSeverity } from './console-types';

export const BAND_TONE: Record<HealthBand, BadgeTone> = { HEALTHY: 'success', AT_RISK: 'warning', UNHEALTHY: 'danger' };
export const SEVERITY_TONE: Record<IssueSeverity, BadgeTone> = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' };

/** Each zone's share of the bar, and the score range it stands for. */
export const HEALTH_ZONES: { band: HealthBand; from: number; to: number; start: number; width: number; fill: string }[] = [
  { band: 'UNHEALTHY', from: 0, to: 99, start: 0, width: 20, fill: 'bg-danger-fill' },
  { band: 'AT_RISK', from: 100, to: 199, start: 20, width: 20, fill: 'bg-warning-fill' },
  { band: 'HEALTHY', from: 200, to: 1000, start: 40, width: 60, fill: 'bg-success-fill' },
];

/** Where on the bar (0-100%) a score sits, piecewise across the zones. */
export function healthPosition(score: number): number {
  const clamped = Math.max(0, Math.min(1000, score));
  const zone = HEALTH_ZONES.find((entry) => clamped >= entry.from && clamped <= entry.to) ?? HEALTH_ZONES[2];
  if (zone === undefined) return 0;
  const span = zone.to - zone.from || 1;
  return zone.start + ((clamped - zone.from) / span) * zone.width;
}
