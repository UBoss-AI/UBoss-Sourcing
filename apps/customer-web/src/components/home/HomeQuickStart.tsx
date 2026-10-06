/**
 * Home quick start (checklist JOURNEY-001).
 *
 * Two jobs under the greeting, kept deliberately apart:
 *
 *   - **Buyer and supplier paths are different calls to action.** A buyer
 *     searches, asks for quotes or follows an order; a manufacturer wants to
 *     sell here. One mixed row of buttons makes both read each other's labels,
 *     so they are two cards, each with an icon, a heading, a line saying what
 *     the path is for and its own buttons.
 *   - **Recent activity is personal, and so it can be put away.** What this
 *     browser looked at last is useful on the second visit and noise on the
 *     tenth. It is a row of small cards (picture when one was recorded, name
 *     clamped to two lines, "viewed" caption). "Hide" removes it for thirty
 *     days; the choice is remembered in this browser only and nothing is sent
 *     anywhere.
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
import { Button, ButtonLink } from '@/components/ui';

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

const card = 'flex flex-col rounded-xl border border-border bg-surface p-5 shadow-card sm:p-6';

/** The tile a quick-start card leads with. Decorative: the heading says it. */
function CardIcon({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand ring-1 ring-brand/20"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </span>
  );
}

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
          <div className="flex items-start gap-4">
            <CardIcon>
              <path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.76L20.5 8H6.2" />
              <circle cx="9.5" cy="19.5" r="1.25" />
              <circle cx="17" cy="19.5" r="1.25" />
            </CardIcon>
            <div className="min-w-0">
              <h3 className="text-title-xs text-ink">{t('home.quickStart.buyerTitle')}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">{t('home.quickStart.buyerBody')}</p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2 md:mt-auto md:pt-5">
            <ButtonLink to="/search" variant="primary" size="sm">
              {t('home.quickStart.browse')}
            </ButtonLink>
            {features.rfq === true && (
              <ButtonLink to="/account/rfqs/new" variant="secondary" size="sm">
                {t('home.quickStart.requestQuotes')}
              </ButtonLink>
            )}
            <ButtonLink to="/account/orders" variant="secondary" size="sm">
              {t('home.quickStart.trackOrders')}
            </ButtonLink>
          </div>
        </div>

        <div className={card}>
          <div className="flex items-start gap-4">
            <CardIcon>
              <path d="M4 9.5 5.5 4h13L20 9.5" />
              <path d="M4 9.5a2.67 2.67 0 0 0 5.33 0 2.67 2.67 0 0 0 5.34 0 2.67 2.67 0 0 0 5.33 0" />
              <path d="M5 12v8h14v-8" />
              <path d="M10 20v-4.5h4V20" />
            </CardIcon>
            <div className="min-w-0">
              <h3 className="text-title-xs text-ink">{t('home.quickStart.sellerTitle')}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                {t('home.quickStart.sellerBody', { marketplace: business.displayName })}
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2 md:mt-auto md:pt-5">
            <ButtonLink to="/sell" variant="secondary" size="sm">
              {t('home.quickStart.sell', { marketplace: business.displayName })}
            </ButtonLink>
          </div>
        </div>
      </div>

      {showRecent && (
        <section className={`${card} mt-4`} aria-labelledby="recent-activity-heading">
          <div className="flex items-center justify-between gap-3">
            <h3 id="recent-activity-heading" className="text-title-xs text-ink">
              {t('home.quickStart.recentTitle')}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                remember(true);
                setHidden(true);
              }}
            >
              {t('home.quickStart.hideRecent')}
            </Button>
          </div>
          <ul className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {recent.map((item) => (
              <li key={`${item.kind}:${item.slug}`} className="min-w-0">
                <Link
                  to={item.kind === 'product' ? `/product/${item.slug}` : `/suppliers/${item.slug}`}
                  className="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                >
                  <span className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-surface-sunken">
                    {item.imageUrl === undefined ? (
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="h-8 w-8 text-ink-subtle"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        {item.kind === 'product' ? (
                          <>
                            <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
                            <path d="M3 8l9 5 9-5M12 13v8" />
                          </>
                        ) : (
                          <>
                            <path d="M4 21V8l8-5 8 5v13" />
                            <path d="M9 21v-6h6v6" />
                          </>
                        )}
                      </svg>
                    ) : (
                      <img
                        src={item.imageUrl}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-contain p-2"
                      />
                    )}
                  </span>
                  <span className="flex flex-1 flex-col gap-1 p-3">
                    <span className="line-clamp-2 text-sm font-medium leading-snug text-ink group-hover:text-brand">
                      {item.name}
                    </span>
                    <span className="mt-auto text-xs text-ink-muted">
                      {item.kind === 'product'
                        ? t('home.quickStart.viewedProduct')
                        : t('home.quickStart.viewedSupplier')}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
