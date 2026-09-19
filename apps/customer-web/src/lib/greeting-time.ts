/**
 * Which greeting the hour of the day has earned.
 *
 * "Hello" is correct at every hour and warm at none of them. A buyer opening
 * the assistant at nine in the morning and a buyer opening it after dinner are
 * not having the same day, and a shop that notices reads as a shop staffed by
 * somebody. That is the whole of what this is for.
 *
 * Four bands, and the fourth is the reason this is a module rather than two
 * comparisons written inline:
 *
 *   05:00-11:59  morning
 *   12:00-16:59  afternoon
 *   17:00-21:59  evening
 *   22:00-04:59  neither
 *
 * **"Good evening" at three in the morning is worse than "Hello".** It is the
 * kind of wrongness a person notices instantly and reads as a machine guessing,
 * which is the opposite of what a warm greeting is for - so the small hours get
 * the plain greeting back rather than a cheerful one that does not fit. Night
 * shifts are a real part of this audience: wards, warehouses and dispatch desks
 * all order at four in the morning.
 *
 * The hour is the READER's, off their own clock, because that is the only hour
 * that describes the day they are actually having. It is deliberately not the
 * operator's timezone: a buyer in Rotterdam greeted by a shop's Indian morning
 * is being told about somebody else's day.
 */
export type GreetingPeriod = 'morning' | 'afternoon' | 'evening' | 'plain';

/** The hour bands, as `[from, until)` in the reader's own local time. */
export function greetingPeriod(now: Date = new Date()): GreetingPeriod {
  const hour = now.getHours();

  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'plain';
}

/**
 * The translation key for a period, with and without a name to use.
 *
 * Two whole sentences per period rather than a greeting with a name glued on
 * the end. Gluing works in all eight languages this ships in, which is exactly
 * what makes it a trap: the ninth needs the name somewhere else, and by then
 * the concatenation is in the component and not in the catalogue where a
 * translator can reach it. A sentence per key is a sentence a translator owns.
 *
 * `plain` has no nameless form on purpose. "Hello" on its own above "How can we
 * help you today?" is a line that says nothing the line under it does not, and
 * the page has always simply dropped this line where there is no name.
 */
export const GREETING_KEYS = {
  morning: { named: 'aiMode.greetingMorningNamed', bare: 'aiMode.greetingMorning' },
  afternoon: { named: 'aiMode.greetingAfternoonNamed', bare: 'aiMode.greetingAfternoon' },
  evening: { named: 'aiMode.greetingEveningNamed', bare: 'aiMode.greetingEvening' },
  plain: { named: 'aiMode.greeting', bare: null },
} as const;
