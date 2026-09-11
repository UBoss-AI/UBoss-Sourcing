/**
 * Buy this now, or have it delivered again and again.
 *
 * Two ways to spend the same basket, and until now the second one was a link
 * in the summary panel that a buyer had to scroll past the whole cart to find.
 * Putting them side by side at the top of the cart is the honest shape: they
 * are alternatives, not a purchase and an afterthought.
 *
 * **Links, not a tab panel**, and the distinction is not pedantry. These lead
 * to two different routes — `/cart` and `/accounts/schedule` — so a real
 * `role="tablist"` would promise a screen reader that the content below swaps
 * in place, which it does not; the page navigates. A navigation region with
 * `aria-current="page"` on the one you are on says exactly what is true, and
 * it comes with working middle-click, open-in-new-tab and back button for
 * free. The segmented look is the same either way.
 *
 * **Nothing is removed by this.** Instant Buy is the cart the storefront
 * always had, on the same route, with the same checkout: it is the default
 * because it is what most people came for, and the tab merely names what was
 * previously unnamed.
 *
 * The row renders only where the second destination exists. A deployment with
 * recurring orders switched off has one way to spend a basket, and a tab
 * leading to a screen that explains it is switched off teaches the customer
 * that the navigation lies — the same rule `account-nav.ts` follows.
 */
import { Link } from 'react-router-dom';
import { CartIcon, RepeatIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { useStorefront } from '@/app/storefront-context';
import { useI18n } from '@/i18n/i18n-context';

/** Which of the two the current screen is. */
export type CartMode = 'instant' | 'schedule';

/** Where the schedule half of the cart lives. */
export const SCHEDULE_CART_PATH = '/accounts/schedule';

function tabClass(isCurrent: boolean): string {
  return cx(
    // A generous hit area on a phone, where this is the first thing thumbed —
    // so the two split the width below `sm` and size to their own labels above
    // it. Left at `flex-1` throughout, a laptop gets two 700px pills, which
    // read as a pair of banners rather than as a choice between two tabs.
    'group relative flex flex-1 items-center justify-center gap-2 rounded-md py-2.5 text-sm',
    'px-3 sm:flex-none sm:px-6',
    'font-medium transition-[background-color,color,box-shadow] motion-reduce:transition-none',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
    'focus-visible:ring-offset-surface-sunken',
    isCurrent
      ? // A raised, filled pill rather than a recoloured word. "Which of these
        // am I in" is the only question this row answers, and a colour change
        // on one of two items answers it faintly.
        'bg-surface text-brand shadow-card ring-1 ring-inset ring-border'
      : 'text-ink-muted hover:bg-surface/70 hover:text-ink',
  );
}

export function CartModeTabs({ current }: { current: CartMode }): React.JSX.Element | null {
  const { t } = useI18n();
  const { features } = useStorefront();

  if (!features.recurringOrders) return null;

  return (
    <nav aria-label={t('cartTabs.label')} className="mb-6">
      <div
        className={cx(
          // The sunken track under two pills, with the brand tint bled in from
          // the left. Subtle on purpose: this is a control, and a saturated
          // gradient behind a control competes with the thing it contains.
          'flex gap-1 rounded-lg border border-border bg-gradient-to-r from-brand-soft/60 to-surface-sunken p-1',
          'shadow-sunken',
          // Full width on a phone, hugging its content from `sm`.
          'w-full sm:inline-flex sm:w-auto',
        )}
      >
        <Link
          to="/cart"
          className={tabClass(current === 'instant')}
          {...(current === 'instant' ? { 'aria-current': 'page' as const } : {})}
        >
          <CartIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t('cartTabs.instantBuy')}
        </Link>

        <Link
          to={SCHEDULE_CART_PATH}
          className={tabClass(current === 'schedule')}
          {...(current === 'schedule' ? { 'aria-current': 'page' as const } : {})}
        >
          <RepeatIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t('cartTabs.scheduleCart')}
        </Link>
      </div>

      {/* One line, because the difference between the two is worth a sentence
          and not a paragraph: one takes money today, the other takes it again
          on a date the customer chooses. */}
      <p className="mt-2 px-1 text-xs text-ink-muted">
        {current === 'instant' ? t('cartTabs.instantHint') : t('cartTabs.scheduleHint')}
      </p>
    </nav>
  );
}
