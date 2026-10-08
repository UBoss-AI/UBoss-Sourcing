/**
 * A seller's health rating, drawn the way Amazon's Account Health page draws
 * its Account Health Rating: one bar, three coloured zones, a marker at the
 * score, and the band written beside it in words.
 *
 * The zones are NOT to scale. On a straight 0-1,000 line the two zones that
 * matter (0-99 and 100-199) would be a fifth of the bar between them and the
 * marker would sit in an unreadable sliver. Amazon draws them wide for the
 * same reason; the score is always written as a number, so nothing is read
 * off the bar's geometry alone.
 *
 * Every string arrives translated through `useI18n`. Colour is never the only
 * signal: the band is always written, and the badge carries a dot and a label.
 */
import { Badge } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { HealthBand } from '@/lib/console-types';
import { BAND_TONE, HEALTH_ZONES, healthPosition } from '@/lib/health';
import { cx } from '@/lib/cx';
import { formatNumber } from '@/lib/format';

export function HealthBadge({ band, score }: { band: HealthBand; score?: number | undefined }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Badge tone={BAND_TONE[band]} dot>
      {t(`health.band.${band}`)}
      {score === undefined ? null : <span className="ml-1 tabular opacity-80">{formatNumber(score)}</span>}
    </Badge>
  );
}

export function HealthMeter({ score, band, className }: { score: number; band: HealthBand; className?: string | undefined }): React.JSX.Element {
  const { t } = useI18n();
  const position = healthPosition(score);

  return (
    <div className={cx('w-full', className)}>
      <div
        className="relative pt-3"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1000}
        aria-valuenow={score}
        aria-valuetext={t('health.meterValue', { score: formatNumber(score), band: t(`health.band.${band}`) })}
        aria-label={t('health.rating')}
      >
        {/* The marker: a small downward triangle above the bar. */}
        <span
          aria-hidden="true"
          className="absolute top-0 h-0 w-0 -translate-x-1/2 border-x-[6px] border-t-[8px] border-x-transparent border-t-ink transition-[left] duration-700 motion-reduce:transition-none"
          style={{ left: `${String(position)}%` }}
        />
        <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
          {HEALTH_ZONES.map((zone) => (
            <span key={zone.band} className={cx('h-full', zone.fill, zone.band === band ? 'opacity-100' : 'opacity-40')} style={{ width: `${String(zone.width)}%` }} />
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex text-xxs text-ink-subtle tabular" aria-hidden="true">
        {HEALTH_ZONES.map((zone) => (
          <span key={zone.band} style={{ width: `${String(zone.width)}%` }} className="truncate">
            {zone.from === 200 ? '200–1000' : `${String(zone.from)}–${String(zone.to)}`}
          </span>
        ))}
      </div>
    </div>
  );
}
