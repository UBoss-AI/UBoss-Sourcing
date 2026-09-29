/**
 * A number of days or hours as words in the reader's language ("30 days",
 * "30 Tage", "30 dni").
 *
 * Done with `Intl.NumberFormat` units rather than translated plural strings,
 * so a figure dropped into a sentence gets the right plural form in every
 * language the storefront ships, including those with several.
 */
type DurationUnit = 'day' | 'hour';

function formatter(language: string, unit: DurationUnit): Intl.NumberFormat {
  return new Intl.NumberFormat(language, { style: 'unit', unit, unitDisplay: 'long' });
}

export function formatDays(value: number, language: string): string {
  return formatter(language, 'day').format(value);
}

export function formatHours(value: number, language: string): string {
  return formatter(language, 'hour').format(value);
}

/** "15–30 days", or "7 days" when both ends are the same. */
export function formatDayRange(min: number, max: number, language: string): string {
  if (min === max) return formatDays(min, language);
  // The unit is said once, after the upper end, so the range reads as one quantity.
  return `${new Intl.NumberFormat(language).format(min)}\u2013${formatDays(max, language)}`;
}
