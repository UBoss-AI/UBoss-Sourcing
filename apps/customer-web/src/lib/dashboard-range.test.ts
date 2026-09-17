/**
 * Guards on the reporting window.
 *
 * A window is the quietest thing on a dashboard to get wrong: every figure on
 * the screen still looks like a figure, and the only symptom is that they are
 * all measured over a period nobody asked for.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RANGE,
  isRangeKey,
  parseLocalDate,
  resolveRange,
  toDateInputValue,
  windowDays,
} from './dashboard-range';

/** A Thursday afternoon, in whatever timezone the test machine is in. */
const NOW = new Date(2026, 8, 17, 14, 30, 0, 0);

describe('isRangeKey', () => {
  it('accepts the four offered windows and nothing else', () => {
    expect(isRangeKey('today')).toBe(true);
    expect(isRangeKey('7d')).toBe(true);
    expect(isRangeKey('30d')).toBe(true);
    expect(isRangeKey('custom')).toBe(true);

    // What arrives when somebody edits the address bar. It must fall back
    // rather than produce a window of NaN, which the API would reject with a
    // 400 and the screen would render as "something went wrong".
    expect(isRangeKey('last-fortnight')).toBe(false);
    expect(isRangeKey(null)).toBe(false);
  });
});

describe('resolveRange', () => {
  it('treats "today" as the calendar day, not the last 24 hours', () => {
    const window = resolveRange('today', NOW);
    const from = new Date(window.from);

    // The failure this exists for: a rolling 24 hours starts at 2:30pm
    // YESTERDAY, so a delivery that already happened turns up under "due
    // today" and the dispatcher chases it.
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    expect(from.getDate()).toBe(NOW.getDate());
    expect(new Date(window.to).getTime()).toBe(NOW.getTime());
  });

  it('keeps the 7- and 30-day windows rolling', () => {
    // Deliberately NOT anchored to calendar weeks. It is a volume comparison,
    // and a figure that jumps every Monday for an invisible reason is worse
    // than one that moves smoothly.
    expect(windowDays(resolveRange('7d', NOW))).toBe(7);
    expect(windowDays(resolveRange('30d', NOW))).toBe(30);
  });

  it('honours a complete custom range, at local day boundaries', () => {
    const window = resolveRange('custom', NOW, { from: '2026-09-01', to: '2026-09-07' });

    const from = new Date(window.from);
    const to = new Date(window.to);

    expect(from.getDate()).toBe(1);
    expect(from.getHours()).toBe(0);
    // Inclusive of the last day: a range ending on the 7th has to contain the
    // 7th, or a report run on Monday for "last week" silently loses Sunday.
    expect(to.getDate()).toBe(7);
    expect(to.getHours()).toBe(23);
  });

  it('falls back to the default rather than breaking on a half-typed date', () => {
    // Every keystroke in a date field reaches this. "2026-09-" must not take
    // the dashboard down or ask the API for the year 202.
    const partial = resolveRange('custom', NOW, { from: '2026-09-', to: '2026-09-07' });
    expect(windowDays(partial)).toBe(30);

    const empty = resolveRange('custom', NOW, { from: '', to: '' });
    expect(windowDays(empty)).toBe(30);
  });

  it('falls back when the range runs backwards', () => {
    const backwards = resolveRange('custom', NOW, { from: '2026-09-20', to: '2026-09-01' });
    expect(windowDays(backwards)).toBe(30);
  });

  it('defaults to the thirty-day window', () => {
    expect(windowDays(resolveRange(DEFAULT_RANGE, NOW))).toBe(30);
  });
});

describe('parseLocalDate', () => {
  it('reads a date as a local boundary, never as UTC', () => {
    /*
     * The bug this exists for: `new Date('2026-09-17')` is UTC midnight by
     * specification, which is 3am in Athens and the previous evening in São
     * Paulo. A European marketplace whose custom ranges are a day out in half
     * its markets is a marketplace whose reports nobody trusts.
     */
    const start = parseLocalDate('2026-09-17', false);

    expect(start?.getFullYear()).toBe(2026);
    expect(start?.getMonth()).toBe(8);
    expect(start?.getDate()).toBe(17);
    expect(start?.getHours()).toBe(0);
  });

  it('closes an end-of-day boundary on the last millisecond', () => {
    const end = parseLocalDate('2026-09-17', true);

    expect(end?.getHours()).toBe(23);
    expect(end?.getMinutes()).toBe(59);
    expect(end?.getMilliseconds()).toBe(999);
  });

  it('rejects a date that does not exist', () => {
    // The constructor would roll this into 3 March without complaining.
    expect(parseLocalDate('2026-02-31', false)).toBeNull();
    expect(parseLocalDate('2026-13-01', false)).toBeNull();
    expect(parseLocalDate('not-a-date', false)).toBeNull();
    expect(parseLocalDate('', false)).toBeNull();
  });
});

describe('toDateInputValue', () => {
  it('formats in the viewer timezone, zero-padded', () => {
    expect(toDateInputValue(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toDateInputValue(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('round-trips through parseLocalDate', () => {
    const value = toDateInputValue(NOW);
    const parsed = parseLocalDate(value, false);

    expect(parsed?.getDate()).toBe(NOW.getDate());
    expect(parsed?.getMonth()).toBe(NOW.getMonth());
  });
});
