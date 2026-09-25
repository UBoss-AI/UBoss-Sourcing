/**
 * The preorder assistant's answers, as staff read them in a conversation.
 *
 * The customer read these before asking for a person. Each is stored as the
 * server built it - a question id, then lines of translation keys and typed
 * values - so staff see exactly what the customer was told, in the console's
 * language. The words live in this app's catalogue under the same keys as the
 * storefront's (`preorderChat.assistant.*`), so both sides say the same thing.
 *
 * Rendered as text, always: nothing in an answer is HTML.
 */
import type { Translate, TranslationKey } from '@/i18n/i18n-context';
import { formatMoney, minorToMajor, currencyExponent, humanise } from './format';

export const FAQ_IDS = [
  'moq',
  'bulkPricing',
  'container20',
  'container40',
  'stock',
  'insufficientStock',
  'deliveryDate',
  'splitShipments',
  'customisation',
  'payment',
  'logistics',
  'changeCancel',
] as const;
export type FaqId = (typeof FAQ_IDS)[number];

export type FaqValue =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'date'; value: string }
  | { kind: 'money'; minor: string; currency: string }
  | { kind: 'unit'; value: string }
  | { kind: 'countries'; value: string[] };

export interface FaqAnswer {
  faqId: FaqId;
  version: number;
  outcome: 'ANSWERED' | 'NEEDS_CONFIRMATION';
  lines: { key: string; values: Record<string, FaqValue> }[];
  askedAt: string;
}

function isoDate(value: string, intlLocale: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return value;
  return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))),
  );
}

function countries(codes: string[], intlLocale: string): string {
  let names = codes;
  try {
    const display = new Intl.DisplayNames([intlLocale], { type: 'region' });
    names = codes.map((code) => display.of(code) ?? code);
  } catch {
    /* the codes are still true */
  }
  return names.join(', ');
}

export function formatFaqValue(value: FaqValue, t: Translate, intlLocale: string): string {
  switch (value.kind) {
    case 'number':
      return new Intl.NumberFormat(intlLocale).format(value.value);
    case 'text':
      return value.value;
    case 'date':
      return isoDate(value.value, intlLocale);
    case 'money':
      return formatMoney({
        minor: value.minor,
        formatted: minorToMajor(value.minor, currencyExponent(value.currency)),
        currency: value.currency,
      });
    case 'unit':
      return t(`preorderChats.unit.${value.value}` as TranslationKey, { defaultValue: humanise(value.value) });
    case 'countries':
      return countries(value.value, intlLocale);
  }
}

export function faqLineText(
  line: { key: string; values: Record<string, FaqValue> },
  t: Translate,
  intlLocale: string,
): string {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(line.values)) values[name] = formatFaqValue(value, t, intlLocale);
  return t(line.key as TranslationKey, values);
}

export function faqQuestionText(id: string, t: Translate): string {
  return (FAQ_IDS as readonly string[]).includes(id)
    ? t(`preorderChat.assistant.q.${id}` as TranslationKey)
    : t('preorderChat.assistant.q.unknown');
}
