/**
 * A stored card, as something to look at and something to pick.
 *
 * The words and the class names live in `lib/cards.ts`; this file holds only
 * what renders, so the two components below are the whole of how a saved card
 * appears anywhere in the storefront. That matters more here than it usually
 * would: a customer identifies a card by sight, from four digits and a brand,
 * and if the checkout drew them differently from the account screen then "is
 * that the same card?" becomes a real question at the moment they are deciding
 * to spend money.
 */
import { CardIcon, CheckIcon } from '@/components/icons';
import { cardExpiry, choiceCardClass, useCardLabel } from '@/lib/cards';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import type { SavedCard } from '@/lib/types';

/** The corner tick. Text as well as a glyph, so it survives a greyscale print. */
export function SelectedFlag(): React.JSX.Element {
  const { t } = useI18n();

  return (
    <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-brand-fill px-2 py-0.5 text-xxs font-semibold text-white">
      <CheckIcon className="h-3 w-3" />
      {t('checkout.selected')}
    </span>
  );
}

/**
 * One selectable stored card.
 *
 * Used at the checkout, where picking one is the difference between typing a
 * card number and not. The expiry line is omitted rather than filled with a
 * placeholder when the gateway gave none — Razorpay's saved-card API returns
 * no expiry, and something shaped like a date that is not one is worse than a
 * missing line.
 */
export function SavedCardChoice({
  card,
  isSelected,
  onSelect,
  name,
}: {
  card: SavedCard;
  isSelected: boolean;
  onSelect: () => void;
  /** The radio group this belongs to. */
  name: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const label = useCardLabel();
  const expires = cardExpiry(card);

  return (
    <label className={choiceCardClass(isSelected, 'sm')}>
      <input
        type="radio"
        name={name}
        className="mt-0.5 h-4 w-4 shrink-0 border-border-strong text-brand"
        checked={isSelected}
        onChange={onSelect}
      />
      <span
        aria-hidden="true"
        className={cx(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
          isSelected ? 'bg-brand-fill text-white' : 'bg-surface-sunken text-ink-muted',
        )}
      >
        <CardIcon className="h-4 w-4" />
      </span>
      <span className="min-w-0 pr-16 text-sm">
        <span className="block font-medium tabular text-ink">{label(card)}</span>
        {expires !== null && (
          <span className="mt-0.5 block text-xs tabular text-ink-muted">
            {t('paymentMethods.expires', { date: expires })}
          </span>
        )}
      </span>
      {isSelected && <SelectedFlag />}
    </label>
  );
}
