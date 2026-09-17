/**
 * The dashboard's reporting window, and where it is kept.
 *
 * In the URL, not in component state. An operator who wants to send a
 * colleague "the exceptions from last week" sends the address bar, and
 * pressing Back after drilling into a segment returns to the window they were
 * looking at rather than to the default. That is the same decision the admin
 * dashboard already made for its own window; this generalises it and adds the
 * selected segment alongside.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web and
 * apps/logistics-web — see the note at the top of components/dashboard/console.tsx.
 *
 * ---
 *
 * TWO THINGS ABOUT THE WINDOW THAT ARE EASY TO GET WRONG
 *
 *   - **"Today" is a calendar day, not the last 24 hours.** A dispatcher
 *     asking what is due today means between this morning and tonight. A
 *     rolling 24 hours would include yesterday afternoon, which is how a
 *     delivery that already happened turns up in "due today".
 *   - **"Last 7 days" is a rolling window and is meant to be.** It is a volume
 *     comparison rather than a diary, and anchoring it to calendar weeks makes
 *     the figure jump every Monday for a reason nobody looking at it can see.
 *
 * Both are resolved against the VIEWER's clock and sent as instants. The
 * server stores and compares instants; the boundary between "yesterday" and
 * "today" is a question about where the person is standing, and only the
 * browser knows that.
 */

/** The windows offered, in the order they are shown. */
export const RANGE_KEYS = ['today', '7d', '30d', 'custom'] as const;

export type RangeKey = (typeof RANGE_KEYS)[number];

export const DEFAULT_RANGE: RangeKey = '30d';

/** An instant pair, as the API takes them. */
export interface ReportingWindow {
  from: string;
  to: string;
}

export function isRangeKey(value: string | null): value is RangeKey {
  return value !== null && (RANGE_KEYS as readonly string[]).includes(value);
}

/** `yyyy-mm-dd` in the viewer's own timezone, which is what a date input wants. */
export function toDateInputValue(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * A `yyyy-mm-dd` read as a LOCAL day boundary.
 *
 * `new Date('2026-09-17')` is parsed as UTC midnight by the specification,
 * which in Athens is 3am and in São Paulo is the previous evening — so a
 * custom range typed as "the 17th" would silently be a different day for most
 * of the people this product is sold to. Constructing from the parts avoids
 * that entirely.
 *
 * Returns null for anything that is not a complete date, so a half-typed field
 * leaves the window alone rather than jumping to the year 202.
 */
export function parseLocalDate(value: string, endOfDay: boolean): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);

  // Rejects 31 February, which the constructor would happily roll into March.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;

  return date;
}

/**
 * The window a range key means, resolved against a clock.
 *
 * `now` is a parameter rather than a call to `new Date()` so that this is
 * testable without freezing time globally — the tests pass a fixed instant and
 * assert the boundaries, which is the only way to catch a rolling window that
 * has quietly become a calendar one.
 *
 * A `custom` range with an unusable pair falls back to the 30-day default
 * rather than throwing. A half-typed date must not take the dashboard down.
 */
export function resolveRange(
  key: RangeKey,
  now: Date,
  custom?: { from: string; to: string },
): ReportingWindow {
  const to = now;

  if (key === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { from: start.toISOString(), to: to.toISOString() };
  }

  if (key === 'custom' && custom !== undefined) {
    const from = parseLocalDate(custom.from, false);
    const until = parseLocalDate(custom.to, true);

    if (from !== null && until !== null && from.getTime() <= until.getTime()) {
      return { from: from.toISOString(), to: until.toISOString() };
    }
  }

  const days = key === '7d' ? 7 : 30;
  return {
    from: new Date(now.getTime() - days * 86_400_000).toISOString(),
    to: to.toISOString(),
  };
}

/**
 * How long the window is, in whole days. For a "vs the previous N days" line.
 *
 * Rounded rather than floored: a 30-day window is 30 days and a hair once the
 * `to` boundary is "now", and flooring that reports 29.
 */
export function windowDays(window: ReportingWindow): number {
  const span = new Date(window.to).getTime() - new Date(window.from).getTime();
  return Math.max(1, Math.round(span / 86_400_000));
}
