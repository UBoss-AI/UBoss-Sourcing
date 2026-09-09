/**
 * Home — the greeting page.
 *
 * Two jobs, in this order: say what this deployment does and get somebody into
 * the catalogue, and — for a customer who is already signed in — say what is
 * arranged and what is not finished. Everything below the greeting comes from
 * the API: the categories with products in them, and the newest published
 * lines. Nothing is hard-coded, so the storefront reflects whatever the admin
 * has published without a redeploy.
 *
 * Guests see all of the catalogue half of it. A storefront that asks a
 * stranger to sign in before showing a price has already lost them; the
 * sign-in wall belongs at the cart, which is exactly where the backend puts
 * it. What a guest does *not* see is any action that would only bounce them
 * off a session guard — no AI composer, no account panel.
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
import { GreetingPanel } from '@/components/greeting/GreetingPanel';
import { SourcingHub } from '@/components/greeting/SourcingHub';
import { useGreetingStatus } from '@/components/greeting/greeting-status';
import { ProductCard, ProductCardSkeleton } from '@/components/ProductCard';
import { ButtonLink, ErrorState } from '@/components/ui';
import {
  BoxIcon,
  BriefcaseIcon,
  ChevronRightIcon,
  ClockIcon,
  CurrencyIcon,
  CylinderIcon,
  FlowIcon,
  GridIcon,
  HexIcon,
  LayersIcon,
  RepeatIcon,
  TruckIcon,
} from '@/components/icons';
import { api } from '@/lib/api';
import { useLocale } from '@/app/locale-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { CategoryNode, ProductListResponse } from '@/lib/types';
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
      <div className="absolute inset-0 bg-gradient-to-b from-sky-50 via-white to-white" />
      <div className="absolute -right-24 -top-40 h-[34rem] w-[34rem] rounded-full bg-sky-200/40 blur-3xl" />
      <div className="absolute -bottom-40 -left-24 h-96 w-96 rounded-full bg-brand/[0.07] blur-3xl" />
      <div
        className="absolute inset-0"
        // Inline rather than an arbitrary Tailwind value: this is a
        // multi-layer background with a mask, and spelling it out in CSS is
        // considerably easier to read than the bracket syntax for it.
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(29,78,216,0.045) 1px, transparent 1px),' +
            'linear-gradient(to bottom, rgba(29,78,216,0.045) 1px, transparent 1px)',
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
 * The operational trust strip.
 *
 * Sits inside the greeting rather than under it, so the headline, the buttons
 * and the reasons to believe them are one block instead of three stacked
 * bands.
 *
 * The third entry's supporting line is the only thing here that varies: when
 * an operator has recurring orders switched off, promising scheduled
 * deliveries would be a lie, and reordering from history — which every
 * deployment has — is the truthful version of the same reassurance.
 */
function TrustStrip(): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();

  const items = [
    {
      icon: BriefcaseIcon,
      label: t('home.businessPurchasing'),
      detail: t('home.minimumQuantities'),
    },
    {
      icon: TruckIcon,
      label: t('home.reliableFulfilment'),
      detail: t('home.everyOrderTracked'),
    },
    {
      icon: RepeatIcon,
      label: t('home.repeatOrdering'),
      detail: features.recurringOrders
        ? t('home.putRegularLinesOnASchedule')
        : t('home.reorderAnyPastOrder'),
    },
  ];

  return (
    // Three across only from `lg`. At `sm` each column would be about 150px
    // of text once the icon and the padding are taken out, which turns two
    // lines of supporting copy into eight — the strip stacks instead, and
    // stacked it still reads as one band because of the dividers.
    <ul className="relative grid divide-y divide-border border-t border-border bg-surface/60 backdrop-blur-sm lg:grid-cols-3 lg:divide-x lg:divide-y-0">
      {items.map(({ icon: ItemIcon, label, detail }) => (
        <li key={label} className="flex items-start gap-3 px-6 py-5 lg:px-8">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand ring-1 ring-inset ring-brand/15">
            <ItemIcon className="h-[1.15rem] w-[1.15rem]" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">{label}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{detail}</span>
          </span>
        </li>
      ))}
    </ul>
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

  const { greetingName } = useGreetingStatus({
    isCustomer,
    hasRecurringOrders: features.recurringOrders,
  });

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
    ? greetingName === null
      ? t('greeting.welcomeBack')
      : t('greeting.welcomeBackNamed', { name: greetingName })
    : t('greeting.eyebrow');

  return (
    <section className="relative mb-10 overflow-hidden rounded-2xl border border-border shadow-lift">
      <GreetingBackdrop />

      <div className="relative grid gap-12 px-6 py-12 sm:px-10 sm:py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)] lg:items-center lg:gap-10 lg:py-16">
        <div className="max-w-2xl">
          <p className="text-xxs font-semibold uppercase tracking-[0.18em] text-brand">{eyebrow}</p>

          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
            {t('greeting.headline')}
          </h1>

          <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-muted">
            {isCustomer
              ? t('greeting.leadCustomer')
              : t('greeting.leadGuest', { store: business.displayName })}
          </p>

          {/* Two actions, two jobs, two hues.
           *
           * Orange is the conversion path: getting into the catalogue is the
           * thing this page exists to cause, and `action-strong` (#C2410C)
           * carries white at 5.14:1 — the accent #EA580C would be 3.56:1 and
           * fail AA under a label.
           *
           * The second button is the one that changes with the session. A
           * guest gets exactly one sign-in action and it is a filled primary
           * button rather than a text link, so it is unmissable without
           * displacing the catalogue as the thing the page is asking for. A
           * customer gets their account instead — offering "Sign in" to
           * somebody already signed in is the classic way a landing page
           * announces that it has not read the session.
           */}
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink to="/products" variant="action" size="lg">
              {t('home.browseTheCatalogue')}
            </ButtonLink>

            {/* Never rendered while the session is still unknown: a Sign in
                button that flashes for a signed-in customer looks broken. */}
            {!isLoading &&
              (isCustomer ? (
                <ButtonLink to="/account/orders" variant="secondary" size="lg">
                  {t('greeting.action.dashboard')}
                </ButtonLink>
              ) : (
                <ButtonLink to="/login" variant="primary" size="lg">
                  {t('home.signInToOrder')}
                </ButtonLink>
              ))}
          </div>

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

      <TrustStrip />
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
                        'linear-gradient(to right, rgba(29,78,216,0.07) 1px, transparent 1px),' +
                        'linear-gradient(to bottom, rgba(29,78,216,0.07) 1px, transparent 1px)',
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
// Product discovery
// ---------------------------------------------------------------------------

/**
 * The newest published products, and a way past them.
 *
 * Deliberately *not* "most ordered" or "popular": the catalogue API exposes
 * `sort=newest` and nothing about demand, and a shelf labelled "best sellers"
 * that is really "whatever was published last" is a lie the customer cannot
 * check. The pathway out of the section is the honest way to give this page a
 * second act.
 */
function NewestProducts(): React.JSX.Element {
  const { t, language } = useI18n();

  const { currency, country } = useLocale();

  const query = useQuery({
    queryKey: ['products', { sort: 'newest', limit: 8, currency, country, language }],
    queryFn: () =>
      api.get<ProductListResponse>('/catalog/products', {
        query: { limit: 8, sort: 'newest', currency, country: country ?? undefined, language },
      }),
  });

  const hasProducts = query.data !== undefined && query.data.products.length > 0;

  return (
    <section aria-labelledby="latest-products">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xxs font-semibold uppercase tracking-[0.14em] text-ink-subtle">
            {t('home.catalogue')}
          </p>
          <h2 id="latest-products" className="mt-1.5 text-title-lg text-ink">
            {t('home.latestProducts')}
          </h2>
          <p className="mt-1 max-w-prose text-sm text-ink-muted">
            {t('home.mostRecentlyPublished', { currency })}
          </p>
        </div>

        <Link
          to="/products"
          className="inline-flex shrink-0 items-center gap-1 rounded text-sm font-medium text-brand hover:underline"
        >
          {t('home.viewAllProducts')}
          <ChevronRightIcon className="h-4 w-4" />
        </Link>
      </header>

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.isPending && (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <li key={index}>
              <ProductCardSkeleton />
            </li>
          ))}
        </ul>
      )}

      {query.data !== undefined &&
        (query.data.products.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface px-6 py-14 text-center shadow-card">
            <p className="text-base font-medium text-ink">{t('home.nothingIsPublishedYet')}</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-muted">
              {t('home.productsAppearHereAsSoon')}
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {query.data.products.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        ))}

      {/* The secondary pathway. Eight cards is a taste of the catalogue, and
          the customer who has scrolled past all of them has demonstrated
          exactly one thing: they want the rest. Repeated here rather than only
          in the section header, because on a phone the header is by then
          several screens above. */}
      {hasProducts && (
        <div className="mt-8 flex flex-col items-center gap-4 rounded-lg border border-border bg-surface px-6 py-8 text-center shadow-card">
          <div>
            <p className="text-title-sm text-ink">{t('home.lookingForSomethingSpecific')}</p>
            <p className="mx-auto mt-1.5 max-w-lg text-sm leading-relaxed text-ink-muted">
              {t('home.theFullCatalogueCanBe')}
            </p>
          </div>
          <ButtonLink to="/products" variant="secondary" size="lg">
            {t('home.viewAllProducts')}
          </ButtonLink>
        </div>
      )}
    </section>
  );
}

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

  return (
    <>
      <Greeting />
      {/* Below the greeting rather than inside it: it is about an account, and
          a guest — who is most of the traffic — renders nothing at all here,
          not even an empty spacer. */}
      <GreetingPanel />
      <CategoryStrip />
      <NewestProducts />
    </>
  );
}
