/**
 * How a stored card reads, and how a choosable card looks.
 *
 * There were three copies of the labelling. `AutoPayPage`,
 * `PaymentMethodsPage` and `CardSetupDialog` each grew their own, and they had
 * already drifted: two hardcoded the English words "Card" and "****" into a
 * storefront that ships in eight languages, and the three disagreed about
 * whether to show an expiry. A card is the one thing on these screens a
 * customer identifies by sight, so it has to read identically in the account
 * area and at the checkout — otherwise "is that the same card?" becomes a real
 * question at the moment somebody is deciding to spend money.
 *
 * What may be shown is settled on the server and is deliberately meagre: a
 * brand and four digits. No card number reaches this application, so there is
 * no version of any of this that could render one.
 */
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import type { SavedCard } from '@/lib/types';

/**
 * The shared look of every choosable card on a page — an address, a way to
 * pay, a stored card.
 *
 * Selection is carried by three signals at once, because one is never enough:
 * the ring, the control itself, and the "Selected" tick. Somebody who cannot
 * separate the blue ring from the grey border can still see the tick.
 */
export function choiceCardClass(isSelected: boolean, size: 'md' | 'sm' = 'md'): string {
  return cx(
    'relative flex cursor-pointer gap-3 rounded-lg border transition-colors',
    size === 'md' ? 'p-4' : 'p-3',
    isSelected
      ? 'border-brand bg-brand-soft ring-2 ring-brand ring-offset-1 ring-offset-surface'
      : 'border-border bg-surface hover:border-brand/50 hover:bg-surface-hover',
  );
}

/**
 * "Visa ···· 4242", translated.
 *
 * The brand is the gateway's own string and is not translated — Visa is Visa
 * everywhere. The fallbacks are, which is the bug this replaces: a customer
 * reading the storefront in Greek was shown the English word "Card" for any
 * instrument whose brand the gateway would not name.
 */
export function useCardLabel(): (card: Pick<SavedCard, 'brand' | 'last4'>) => string {
  const { t } = useI18n();

  return (card) => `${card.brand ?? t('paymentMethods.card')} ···· ${card.last4 ?? '••••'}`;
}

/**
 * "11/30", or null where the gateway gave no expiry.
 *
 * Two digits, so 3/2027 does not read as an odd date beside 11/2026. Null is a
 * real answer rather than a gap to fill: Razorpay's saved-card API returns no
 * expiry at all, and a placeholder there would look like a date.
 */
export function cardExpiry(card: Pick<SavedCard, 'expMonth' | 'expYear'>): string | null {
  if (card.expMonth === null || card.expYear === null) return null;

  return `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`;
}
