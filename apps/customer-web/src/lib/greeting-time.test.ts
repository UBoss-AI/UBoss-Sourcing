/**
 * The hour bands, and the one the small hours must not fall into.
 *
 * Dates are built with local-time constructor arguments rather than ISO
 * strings, because `greetingPeriod` reads `getHours()` — the reader's own
 * clock, which is the point of it — and `new Date('…T03:00:00Z')` is three in
 * the morning only for a reader on UTC.
 */
import { describe, expect, it } from 'vitest';
import { GREETING_KEYS, greetingPeriod } from './greeting-time';

const at = (hour: number): Date => new Date(2026, 8, 18, hour, 30, 0);

describe('greetingPeriod', () => {
  it.each([
    [5, 'morning'],
    [9, 'morning'],
    [11, 'morning'],
    [12, 'afternoon'],
    [16, 'afternoon'],
    [17, 'evening'],
    [21, 'evening'],
  ] as const)('reads %i:30 as %s', (hour, expected) => {
    expect(greetingPeriod(at(hour))).toBe(expected);
  });

  it.each([22, 23, 0, 3, 4])('greets plainly at %i:30, never cheerfully', (hour) => {
    // A dispatch desk ordering at three in the morning wished a good evening
    // reads as a machine guessing, which is the opposite of a warm greeting.
    expect(greetingPeriod(at(hour))).toBe('plain');
  });

  it('has a named key for every period', () => {
    for (const keys of Object.values(GREETING_KEYS)) {
      expect(keys.named).toMatch(/^aiMode\./);
    }
  });

  it('has a nameless key for every period a guest should be greeted in', () => {
    expect(GREETING_KEYS.morning.bare).toBe('aiMode.greetingMorning');
    expect(GREETING_KEYS.afternoon.bare).toBe('aiMode.greetingAfternoon');
    expect(GREETING_KEYS.evening.bare).toBe('aiMode.greetingEvening');

    // And none in the small hours: "Hello" alone above "How can we help you
    // today?" says nothing the line under it does not.
    expect(GREETING_KEYS.plain.bare).toBeNull();
  });
});
