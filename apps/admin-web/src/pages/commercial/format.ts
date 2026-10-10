/**
 * Plain helpers the commercial-policy screens share: money display, translated
 * codes and the small conversions their forms need. Kept apart from the
 * components so fast refresh keeps working.
 */
import type { Translate, TranslationKey } from '@/i18n/i18n-context';
import { currencyExponent, formatMoney, minorToMajor } from '@/lib/format';

/** A minor-unit string in its currency, or a dash. */
export function money(minor: string | null | undefined, currency: string | null | undefined): string {
  if (minor === null || minor === undefined || currency === null || currency === undefined || currency === '') return '—';
  return formatMoney({ minor, formatted: minorToMajor(minor, currencyExponent(currency)), currency });
}

/** A code the server sends, in words when this catalogue knows it, otherwise as sent. */
export function codeLabel(t: Translate, code: string): string {
  return t(`commercial.code.${code}` as TranslationKey, { defaultValue: code });
}

/** Status words shared by every list. */
export function statusLabel(t: Translate, status: string): string {
  return t(`commercial.status.${status}` as TranslationKey, { defaultValue: status });
}

/** Splits "IN, DE , fr" into ["IN","DE","FR"]. */
export function splitCodes(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);
}

/** A date input value (yyyy-mm-dd) from an ISO instant. */
export function dateInput(iso: string | null | undefined): string {
  return iso === null || iso === undefined ? '' : iso.slice(0, 10);
}

/** An ISO instant from a date input, or null when blank. */
export function isoOrNull(date: string): string | null {
  return date.trim() === '' ? null : new Date(`${date}T00:00:00.000Z`).toISOString();
}
