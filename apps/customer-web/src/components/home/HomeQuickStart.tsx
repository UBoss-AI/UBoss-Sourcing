/**
 * Home quick start (checklist JOURNEY-001).
 *
 * Two jobs under the greeting, kept deliberately apart:
 *
 *   - **Buyer and supplier paths are different calls to action.** A buyer
 *     searches, asks for quotes or follows an order; a manufacturer wants to
 *     sell here. One mixed row of buttons makes both read each other's labels,
 *     so they are two cards with their own heading.
 *   - **Recent activity is personal, and so it can be put away.** What this
 *     browser looked at last is useful on the second visit and noise on the
 *     tenth. "Hide" removes it for thirty days; the choice is remembered in this
 *     browser only and nothing is sent anywhere.
 *
 * Nothing here claims a fact the deployment cannot keep: the quotation link
 * appears only when requests for quotation are switched on, and the recent
 * list only when there is something in it.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { readRecentlyViewed } from '@/lib/recently-viewed';
import { useI18n } from '@/i18n/i18n-context';

const HIDE_KEY = 'home.recentActivity.hiddenAt';
const HIDE_DAYS = 30;

function hiddenNow(now = Date.now()): boolean {
  try {
    const at = window.localStorage.getItem(HIDE_KEY);
    if (at === null) return false;
    const when = Date.parse(at);
    return Number.isFinite(when) && now - when < HIDE_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

function remember(hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(HIDE_KEY, new Date().toISOString());
    else window.localStorage.removeItem(HIDE_KEY);
  } catch {
    // Storage blocked: the choice lasts for this page only, which is still a choice.
  }
}

const card = 'rounded-lg border border-border bg-surface p-5 shadow-card';
const link = 'inline-flex min-h-11 items-center font-medium text-brand underline-offset-2 hover:underline';

export function HomeQuickStart(): React.JSX.Element {
  const { t } = useI18n();
  const { business, features } = useStorefront();
  const recent = useMemo(() => readRecentlyViewed().slice(0, 4), []);
  const [hidden, setHidden] = useState(hiddenNow);
  const showRecent = recent.length > 0 && !hidden;

  return (
    <section aria-labelledby="quick-start-heading" className="mt-10">
      <h2 id="quick-start-heading" className="sr-only">
        {t('home.quickStart.heading')}
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div className={card}>
          <h3 className="text-title-xs text-ink">{t('home.quickStart.buyerTitle')}</h3>
          <p className="mt-1 text-sm text-ink-muted">{t('home.quickStart.buyerBody')}</p>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <li>
              <Link to="/search" className={link}>{t('home.quickStart.browse')}</Link>
            </li>
            {features.rfq === true && (
              <li>
                <Link to="/account/rfqs/new" className={link}>{t('home.quickStart.requestQuotes')}</Link>
              </li>
            )}
            <li>
              <Link to="/account/orders" className={link}>
                {t('home.quickStart.trackOrders')}
              </Link>
            </li>
          </ul>
        </div>

        <div className={card}>
          <h3 className="text-title-xs text-ink">{t('home.quickStart.sellerTitle')}</h3>
          <p className="mt-1 text-sm text-ink-muted">
            {t('home.quickStart.sellerBody', { marketplace: business.displayName })}
          </p>
          <p className="mt-3 text-sm">
            <Link to="/sell" className={link}>
              {t('home.quickStart.sell', { marketplace: business.displayName })}
            </Link>
          </p>
        </div>
      </div>

      {showRecent && (
        <div className={`${card} mt-4`} aria-labelledby="recent-activity-heading">
          <div className="flex items-start justify-between gap-3">
            <h3 id="recent-activity-heading" className="text-title-xs text-ink">
              {t('home.quickStart.recentTitle')}
            </h3>
            <button
              type="button"
              className="min-h-11 rounded-md px-2 text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
              onClick={() => {
                remember(true);
                setHidden(true);
              }}
            >
              {t('home.quickStart.hideRecent')}
            </button>
          </div>
          <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            {recent.map((item) => (
              <li key={`${item.kind}:${item.slug}`} className="min-w-0">
                <Link
                  to={item.kind === 'product' ? `/product/${item.slug}` : `/suppliers/${item.slug}`}
                  className={`${link} max-w-full truncate`}
                >
                  {item.name}
                </Link>
                <span className="text-xs text-ink-muted">
                  {item.kind === 'product' ? t('home.quickStart.viewedProduct') : t('home.quickStart.viewedSupplier')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
