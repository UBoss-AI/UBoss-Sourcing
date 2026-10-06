/**
 * The agency's assignment calendar: days down the page, booked against the
 * agency's daily capacity, and the jobs on each day with the seller's
 * readiness. Times are as the server sends them (UTC), and say so.
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { EnumBadge, QueryBoundary } from '@/components/console';
import { Badge, Button, Card, PageHeader, Select, Toolbar, ToolbarActions, ToolbarField } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, fetchCalendar } from '@/lib/console-api';
import type { CalendarDay } from '@/lib/console-types';
import { cx } from '@/lib/cx';
import { placeLine, enumLabel } from '@/lib/enum-labels';
import { formatCalendarDate, formatNumber } from '@/lib/format';

const DAY_MS = 86_400_000;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function CalendarPage(): React.JSX.Element {
  const { t } = useI18n();
  const [from, setFrom] = useState(() => isoDay(new Date()));
  const [days, setDays] = useState(14);

  const query = useQuery({
    queryKey: consoleKeys.calendar(from, days),
    queryFn: () => fetchCalendar(from, days),
    placeholderData: keepPreviousData,
  });

  const shift = (direction: 1 | -1): void => {
    setFrom(isoDay(new Date(new Date(`${from}T00:00:00Z`).getTime() + direction * days * DAY_MS)));
  };

  return (
    <>
      <PageHeader title={t('screens.calendar.title')} description={t('screens.calendar.description')} />
      <Card>
        <Toolbar>
          <ToolbarField label={t('calendar.from')}>
            <input
              type="date"
              value={from}
              onChange={(event) => {
                if (event.target.value !== '') setFrom(event.target.value);
              }}
              className="h-10 rounded-md border border-border-strong bg-surface px-3 text-sm text-ink shadow-card"
            />
          </ToolbarField>
          <ToolbarField label={t('calendar.days')}>
            <Select
              value={String(days)}
              onChange={(event) => {
                setDays(Number(event.target.value));
              }}
            >
              {[7, 14, 28, 42].map((value) => (
                <option key={value} value={value}>
                  {t('calendar.daysOption', { days: formatNumber(value) })}
                </option>
              ))}
            </Select>
          </ToolbarField>
          <ToolbarActions>
            <Button
              size="md"
              onClick={() => {
                shift(-1);
              }}
            >
              {t('calendar.earlier')}
            </Button>
            <Button
              size="md"
              onClick={() => {
                setFrom(isoDay(new Date()));
              }}
            >
              {t('calendar.today')}
            </Button>
            <Button
              size="md"
              onClick={() => {
                shift(1);
              }}
            >
              {t('calendar.later')}
            </Button>
          </ToolbarActions>
        </Toolbar>
        <QueryBoundary query={query}>
          {(data) => (
            <div className="p-4">
              <p className="mb-3 text-xs text-ink-muted">
                {t('calendar.capacityNote', { capacity: formatNumber(data.capacity) })}
              </p>
              <ol className="space-y-2">
                {data.days.map((day) => (
                  <DayRow key={day.date} day={day} />
                ))}
              </ol>
            </div>
          )}
        </QueryBoundary>
      </Card>
    </>
  );
}

function DayRow({ day }: { day: CalendarDay }): React.JSX.Element {
  const { t } = useI18n();
  const ratio = day.capacity <= 0 ? 0 : Math.min(100, Math.round((day.booked / day.capacity) * 100));
  return (
    <li className="rounded-md border border-border-subtle bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="w-40 shrink-0 text-sm font-medium text-ink">{formatCalendarDate(day.date)}</p>
        <div className="flex min-w-40 flex-1 items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
            <div
              className={cx('h-full rounded-full transition-[width]', day.full ? 'bg-danger' : 'bg-accent')}
              style={{ width: `${String(ratio)}%` }}
            />
          </div>
          <span className="text-xs tabular text-ink-muted">
            {t('calendar.booked', { booked: formatNumber(day.booked), capacity: formatNumber(day.capacity) })}
          </span>
        </div>
        {day.full && <Badge tone="danger">{t('calendar.full')}</Badge>}
      </div>
      {day.jobs.length > 0 && (
        <ul className="mt-2 space-y-1.5 border-t border-border-subtle pt-2">
          {day.jobs.map((job) => (
            <li key={job.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="tabular text-xs text-ink-muted">{t('calendar.timeUtc', { time: job.time })}</span>
              <Link to={`/jobs/${encodeURIComponent(job.id)}`} className="font-medium text-accent hover:underline">
                {job.jobNumber}
              </Link>
              <EnumBadge family="jobStatus" value={job.status} />
              <EnumBadge family="readiness" value={job.readiness} />
              <span className="min-w-0 truncate text-xs text-ink-muted">
                {placeLine(job.inspectionPoint) ?? enumLabel(t, 'inspectionPointType', job.inspectionPointType)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
