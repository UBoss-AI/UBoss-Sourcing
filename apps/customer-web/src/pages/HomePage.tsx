/**
 * Home — the greeting page.
 *
 * One job: say what this deployment does, and get somebody to say what they
 * are looking for. Everything on it comes from the API — the categories with
 * products in them, and, once asked for, the catalogue itself. Nothing is
 * hard-coded, so the storefront reflects whatever the admin has published
 * without a redeploy.
 *
 * The page is the same for a guest and for a signed-in customer, apart from
 * the line above the headline. It used to carry an account panel underneath —
 * five quick actions, a next-delivery strip and an auto-pay promotion — and
 * that is gone: every one of those destinations is now in the account menu in
 * the header, which is where somebody looking for their own account goes, and
 * a landing page that spends its second screen on links for the minority who
 * are signed in is a landing page not doing its one job. Nothing was lost with
 * it; see `components/account/AccountMenu.tsx`.
 *
 * A storefront that asks a stranger to sign in before showing a price has
 * already lost them; the sign-in wall belongs at the cart, which is exactly
 * where the backend puts it.
 *
 * Three constraints shape the design, and the first two come from UBOSS being
 * self-hosted — every buyer runs their own deployment:
 *
 *   - **No claim on the page may be one this deployment cannot keep.** There
 *     are no customer logos, no counts, no testimonials and no "trusted by".
 *     Every reassurance is either a capability of the software or a fact read
 *     from the operator's own config, and the ones that depend on a feature
 *     flag disappear when that flag is off. That extends to the sourcing hub:
 *     a node whose capability is switched off explains itself instead of
 *     linking somewhere that would 404.
 *   - **It has to look finished with nothing supplied.** A fresh deployment
 *     has no logo, no product images and possibly no support details. The
 *     greeting's visual is CSS, SVG and inline geometry rather than imagery,
 *     and it composes the operator's logo *if* one exists instead of
 *     depending on it.
 *   - **The greeting must not cost the catalogue anything.** The hub animates
 *     `transform` and `opacity` and nothing else, so it composites on the GPU
 *     and does no layout for the life of the page — see
 *     `components/greeting/orchestration.css`.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { HeroSearch } from '@/components/hero-search/HeroSearch';
import { InlineProducts } from '@/components/home/InlineProducts';
import { SourcingHub } from '@/components/greeting/SourcingHub';
import { useAccountIdentity } from '@/pages/account/useAccountIdentity';
import {
  BoxIcon,
  ChevronRightIcon,
  ClockIcon,
  CurrencyIcon,
  CylinderIcon,
  FlowIcon,
  GridIcon,
  HexIcon,
  LayersIcon,
  RepeatIcon,
} from '@/components/icons';
import { api } from '@/lib/api';
import { useLocale } from '@/app/locale-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { CategoryNode } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

/**
 * The greeting's ground.
 *
 * White, brand blue and sky, in four layers of pure CSS: two soft washes that
 * put the light where the hub is, a faint engineering grid that fades out
 * downwards, and a hairline horizon under it all. No image request, nothing to
 * 404, and it renders identically for a deployment that has uploaded nothing.
 *
 * Everything here is behind the content at a low enough opacity that the text
 * on top of it is still ink on white — the palette's 15.8:1 — rather than ink
 * on a tint nobody measured.
 */
function GreetingBackdrop(): React.JSX.Element {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-bloom/30 via-surface to-surface" />
      <div className="absolute -right-24 -top-40 h-[34rem] w-[34rem] rounded-full bg-bloom/40 blur-3xl" />
      <div className="absolute -bottom-40 -left-24 h-96 w-96 rounded-full bg-brand/[0.07] blur-3xl" />
      <div
        className="absolute inset-0"
        // Inline rather than an arbitrary Tailwind value: this is a
        // multi-layer background with a mask, and spelling it out in CSS is
        // considerably easier to read than the bracket syntax for it.
        style={{
          backgroundImage:
            'linear-gradient(to right, rgb(var(--brand) / 0.045) 1px, transparent 1px),' +
            'linear-gradient(to bottom, rgb(var(--brand) / 0.045) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          // The grid belongs behind the headline and the hub, not behind the
          // trust strip at the bottom, where it would fight with the text.
          WebkitMaskImage: 'linear-gradient(to bottom, black, transparent 78%)',
          maskImage: 'linear-gradient(to bottom, black, transparent 78%)',
        }}
      />
    </div>
  );
}

/**
 * The greeting itself.
 *
 * The headline is one translation key and stays the same for everybody. What
 * changes for a signed-in customer is the line *above* it — splitting a
 * sentence across two keys so that half of it could be a name is how a
 * catalogue ends up with "Welcome back," in one language and a fragment that
 * cannot be ordered in seven others.
 *
 * The name itself is optional twice over: `fullName` is nullable in the API
 * and blank in plenty of real purchasing accounts, and the read that supplies
 * it may not have finished or may have failed. All three land on the same
 * generic greeting rather than on "Welcome back, undefined".
 */
function Greeting(): React.JSX.Element {
  const { t } = useI18n();

  const { business, features } = useStorefront();
  const { isCustomer, isLoading } = useSession();
  const { currency } = useLocale();

  // Only the name, and only to decide the line above the headline. Shared with
  // the header button and the profile sidebar, so all three greet somebody the
  // same way — and so opening the account menu on this page costs no request.
  const { shortName } = useAccountIdentity(isCustomer);

  // Read from config, not written here. A chip that would be false for a
  // given deployment is simply absent from its storefront.
  const indicators = [
    { icon: CurrencyIcon, label: t('home.pricedIn', { currency }) },
    { icon: ClockIcon, label: t('home.orderOnlineAnyTime') },
    features.recurringOrders
      ? { icon: RepeatIcon, label: t('home.repeatPurchaseScheduling') }
      : null,
  ].filter((entry): entry is { icon: typeof ClockIcon; label: string } => entry !== null);

  const eyebrow = !isLoading && isCustomer
    ? shortName === null
      ? t('greeting.welcomeBack')
      : t('greeting.welcomeBackNamed', { name: shortName })
    : t('greeting.eyebrow');

  return (
    <section className="relative mb-10 overflow-hidden rounded-2xl border border-border shadow-lift">
      <GreetingBackdrop />

      {/*
       * `lg:items-stretch`, and a shorter band than it had.
       *
       * The row's height is set by the hub, which is a 34rem square. The text
       * column is about 100px shorter than that, and with `items-center` the
       * difference was split above and below it — so the card opened with
       * ~113px of nothing above the eyebrow while the hub beside it started at
       * the padding. Two columns starting at different heights inside one card
       * reads as a mistake, because it is one.
       *
       * Stretched, the column fills the row and `justify-between` spends the
       * slack in the one place it belongs: between the search bar and the
       * trust strip, which is a gap the composition wanted anyway. The eyebrow
       * now lines up with the top of the hub and the strip with its bottom.
       *
       * The padding came down with it (64px to 48px at `lg`), because the
       * band was tall enough to push the categories under the fold on a
       * laptop, and the first thing below the hero is the thing this page is
       * for.
       */}
      <div className="relative grid grid-cols-1 gap-12 px-6 py-10 sm:px-10 sm:py-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-stretch lg:gap-10 lg:py-12">
        <div className="flex max-w-2xl flex-col lg:justify-between">
          <div>
          <p className="text-xxs font-semibold uppercase tracking-[0.18em] text-brand">{eyebrow}</p>

          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
            {t('greeting.headline')}
          </h1>

          <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-muted">
            {isCustomer
              ? t('greeting.leadCustomer')
              : t('greeting.leadGuest', { store: business.displayName })}
          </p>

          {/*
           * The search module, where two call-to-action buttons used to be.
           *
           * The buttons said "Browse the catalogue" and "Sign in", and the
           * first of those asked somebody to go and look for a thing they
           * could already name. A search bar lets them say it — which on a
           * catalogue of several thousand consumables is the difference
           * between a landing page and a front door.
           *
           * Nothing was lost with them. Submitting an empty box goes to the
           * same browse-all page the orange button did, and the sign-in path
           * is in the header on every screen and behind AI Mode for anybody who
           * needs it. See `components/hero-search/HeroSearch.tsx`.
           */}
          <HeroSearch />

          {/* A guest still gets one plain way in, under the bar rather than
              beside it: the search box is what this block is asking for, and a
              filled button next to it would compete with the thing it is
              asking for. Never rendered while the session is unknown — a Sign
              in link that flashes for a signed-in customer looks broken. */}
          {!isLoading && !isCustomer && (
            <p className="mt-4 text-sm text-ink-muted">
              {t('home.orSignInPrompt')}{' '}
              <Link
                to="/login"
                className="font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
              >
                {t('home.signInToOrder')}
              </Link>
            </p>
          )}

          </div>

          {/* The second flex child, so the slack in a stretched column lands
              here rather than above the eyebrow. `mt-8` is the minimum gap;
              on a tall row it grows. */}
          <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2.5">
            {indicators.map(({ icon: IndicatorIcon, label }) => (
              <li
                key={label}
                className="flex items-center gap-2 text-xs font-medium text-ink-muted"
              >
                <IndicatorIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-brand" />
                {label}
              </li>
            ))}
          </ul>
        </div>

        {/* The hub is navigation as well as decoration, so it is not
            `aria-hidden` and it is not hidden on a phone — it rearranges. */}
        <SourcingHub />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/*
 * Categories have no image in the API, so every card needs a placeholder — and
 * a grid of twelve identical placeholders is worse than the plain text cards
 * this replaced, because it looks like twelve failed image loads.
 *
 * The mark is therefore chosen from the category's own name. Same category,
 * same mark on every visit and for every visitor; different categories, mostly
 * different marks. All six are abstract stock geometry, so a mark cannot be
 * wrong about what a category contains — see components/icons.tsx.
 */
const CATEGORY_MARKS = [BoxIcon, HexIcon, LayersIcon, GridIcon, CylinderIcon, FlowIcon];

function categoryMark(seed: string): (props: { className?: string }) => React.JSX.Element {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100_003;
  }

  return CATEGORY_MARKS[hash % CATEGORY_MARKS.length] ?? BoxIcon;
}

function CategoryStrip(): React.JSX.Element | null {
  const { t, language } = useI18n();

  const query = useQuery({
    queryKey: ['categories', language],
    queryFn: () =>
      api.get<{ categories: CategoryNode[] }>('/catalog/categories', { query: { language } }),
    staleTime: 5 * 60_000,
  });

  // A category with nothing published in it is a dead end, so it is not shown.
  const categories = (query.data?.categories ?? []).filter((node) => node.productCount > 0);

  if (categories.length === 0) return null;

  return (
    <section aria-labelledby="shop-by-category" className="mb-12">
      <header className="mb-4">
        <h2 id="shop-by-category" className="text-title-lg text-ink">
          {t('home.shopByCategory')}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          {categories.length} {categories.length === 1 ? 'department' : 'departments'} currently
          stocked.
        </p>
      </header>

      {/* Three across from `md`, not `sm`. The card is a horizontal row — mark,
          name, count, chevron — so a 200px column at `sm` would leave the
          category name about 80px, and "Packaging & Consumables" would arrive
          in four lines. */}
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {categories.map((category) => {
          const Mark = categoryMark(category.slug);

          return (
            <li key={category.id}>
              <Link
                to={`/category/${category.slug}`}
                className="group flex h-full items-center gap-3.5 rounded-lg border border-border bg-surface p-3.5 shadow-card transition-[border-color,box-shadow] hover:border-border-hover hover:shadow-card-hover sm:gap-4 sm:p-4"
              >
                {/* The placeholder treatment. A tinted plate rather than a
                    grey box: grey reads as a missing image, a brand-tinted
                    plate reads as a chosen mark. */}
                <span
                  aria-hidden="true"
                  className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-brand-soft text-brand ring-1 ring-inset ring-brand/15 transition-colors group-hover:bg-brand-soft-hover sm:h-14 sm:w-14"
                >
                  <span
                    className="absolute inset-0"
                    style={{
                      backgroundImage:
                        'linear-gradient(to right, rgb(var(--brand) / 0.07) 1px, transparent 1px),' +
                        'linear-gradient(to bottom, rgb(var(--brand) / 0.07) 1px, transparent 1px)',
                      backgroundSize: '8px 8px',
                    }}
                  />
                  <Mark className="relative h-6 w-6 sm:h-7 sm:w-7" />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-snug text-ink group-hover:text-brand">
                    {category.name}
                  </span>
                  <span className="mt-1 block text-xs text-ink-muted">
                    {category.productCount} product
                    {category.productCount === 1 ? '' : 's'}
                  </span>
                </span>

                <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-subtle transition-colors group-hover:text-brand" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

export function HomePage(): React.JSX.Element {
  const { t } = useI18n();

  const { business } = useStorefront();

  useDocumentMeta(
    {
      title: '',
      description: t('home.catalogueDescription', { store: business.displayName }),
    },
    business.displayName,
  );

  /*
   * The product list is simply on the page.
   *
   * This used to be conditional, on which of two tabs the hero's search
   * module was showing — state this page owned so that choosing AI Mode could
   * take the list away. AI Mode is a link to its own page now, so Products is
   * the only thing the bar under the headline can be, and there is no second
   * answer to "what am I looking at" for the list to compete with.
   *
   * Two earlier attempts are worth not repeating. Fetching only once the tab
   * was *pressed* left a visibly selected tab with nothing under it, which
   * reads as a broken page to a first-time visitor. Scrolling the list into
   * view when it appeared was right for a press and wrong on arrival, and now
   * that it is never revealed by a press there is nothing left to scroll to.
   */
  return (
    <>
      <Greeting />

      <CategoryStrip />

      <InlineProducts />
    </>
  );
}
