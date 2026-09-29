/**
 * Formatting shared by every request-for-quotation screen: deadlines in UTC,
 * quantities with their unit, and timeline details.
 */
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';

/** An instant, in UTC, in the reader's language. */
export function formatUtc(iso: string | null, intlLocale: string): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`;
}

/** "12,000 boxes", in the reader's language. */
export function useQuantityLabel(): (quantity: string | null, unit: string | null) => string {
  const { t, intlLocale } = useI18n();
  return (quantity, unit) => {
    if (quantity === null) return t('rfq.notProvided');
    const [whole = '0', fraction] = quantity.split('.');
    const grouped = new Intl.NumberFormat(intlLocale).format(BigInt(whole));
    const decimal = new Intl.NumberFormat(intlLocale, { minimumFractionDigits: 1 }).format(1.5).charAt(1);
    const number = fraction === undefined ? grouped : `${grouped}${decimal}${fraction}`;
    return unit === null ? number : `${number} ${t(`rfq.unit.${unit}` as TranslationKey)}`;
  };
}

/** A timeline detail as text: numbers and strings only. */
export function metaText(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}
