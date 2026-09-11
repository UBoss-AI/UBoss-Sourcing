/**
 * The wall clocks a schedule can run on.
 *
 * A standing order fires at a time of day in a named zone, not at a UTC
 * instant — "06:00 on the 9th" has to still be 06:00 after the clocks change,
 * and after the buyer moves country. So the zone is a field the customer
 * chooses, and this is where the choices come from.
 *
 * Asked of the browser rather than hard-coded. `Intl.supportedValuesOf` gives
 * the full IANA list the platform actually knows, which is the same authority
 * the server validates against — a hand-written list would offer a zone the
 * API refuses, or omit the one this particular buyer needs. The curated
 * fallback exists for the environments that do not have it (older Safari,
 * jsdom under test) and is deliberately short: it is a fallback, not a second
 * catalogue to maintain.
 *
 * **Whatever the plan is already on is always in the list**, even when the
 * platform has never heard of it. A control that silently drops the value it
 * was given is a control that changes a live schedule's clock the first time
 * somebody opens it to change something else.
 */

/**
 * Zones offered where the platform cannot enumerate them.
 *
 * One per region this product is actually sold into — see the note in
 * PROJECT-GUIDE.md on the European expansion — plus UTC, which is the only
 * honest answer for a buyer who does not want a local clock at all.
 */
const FALLBACK_ZONES: readonly string[] = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Brussels',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Rome',
  'Europe/Warsaw',
  'Europe/Athens',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
];

/** Whether this platform will accept a zone at all. */
export function isKnownTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every zone worth offering, with `current` guaranteed present.
 *
 * Sorted, so a list of six hundred entries can be scanned by continent.
 */
export function timezoneOptions(current: string): string[] {
  let zones: string[];

  try {
    // Not in the DOM types this project builds against, and present in every
    // browser it targets. Read through a narrow cast rather than widening
    // `Intl` globally, which would let a typo compile anywhere.
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;

    zones = typeof supported === 'function' ? supported('timeZone') : [...FALLBACK_ZONES];
  } catch {
    zones = [...FALLBACK_ZONES];
  }

  if (zones.length === 0) zones = [...FALLBACK_ZONES];

  // The plan's own zone, whether or not this platform lists it. Losing it
  // would move a live schedule's clock by opening a form.
  if (current.length > 0 && !zones.includes(current)) zones = [current, ...zones];

  return [...new Set(zones)].sort((a, b) => a.localeCompare(b));
}

/**
 * A zone as a person reads it: "Europe/Berlin (GMT+02:00)".
 *
 * The offset is the part that answers the question somebody is actually
 * asking — "is this the clock I am looking at?" — and it is computed for now
 * rather than for the delivery date, which is the honest simplification: it is
 * a label on a picker, not a promise about a date in November.
 */
export function timezoneLabel(zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date());

    const offset = parts.find((part) => part.type === 'timeZoneName')?.value;
    return offset === undefined ? zone : `${zone} (${offset})`;
  } catch {
    return zone;
  }
}
