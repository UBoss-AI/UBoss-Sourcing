/** Deadline arithmetic for <Countdown> (ENH-030). At the exact deadline it is overdue. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The relative phrase and tone for a deadline at `now`. Exported for tests. */
export function countdownParts(deadline: Date, now: Date, locale: string): { overdue: boolean; soon: boolean; phrase: string } {
  const diff = deadline.getTime() - now.getTime();
  const overdue = diff <= 0;
  const size = Math.abs(diff);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  const sign = overdue ? -1 : 1;
  const phrase =
    size >= 2 * DAY
      ? format.format(sign * Math.floor(size / DAY), 'day')
      : size >= 2 * HOUR
        ? format.format(sign * Math.floor(size / HOUR), 'hour')
        : format.format(sign * Math.max(1, Math.floor(size / MINUTE)), 'minute');
  return { overdue, soon: !overdue && diff < DAY, phrase };
}
