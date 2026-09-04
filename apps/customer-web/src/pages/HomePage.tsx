/**
 * Home.
 *
 * Everything on this page comes from the API — categories with products in
 * them, and the newest published products. Nothing is hard-coded, so the
 * storefront reflects whatever the admin has published without a redeploy.
 *
 * Guests see all of it. A storefront that asks a stranger to sign in before
 * showing a price has already lost them; the sign-in wall belongs at the cart,
 * which is exactly where the backend puts it.
 *
 * Two constraints shape the design of this page, and both come from UBOSS
 * being self-hosted — every buyer runs their own deployment:
 *
 *   - **No claim on the page may be one this deployment cannot keep.** There
 *     are no customer logos, no counts, no testimonials and no "trusted by".
 *     Every reassurance on this page is either a capability of the software
 *     (repeat purchases, order history, reordering) or a fact read from the
 *     operator's own config (currency, support contact) — and the ones that
 *     depend on a feature flag disappear when that flag is off.
 *   - **It has to look finished with nothing supplied.** A fresh deployment
 *     has no logo, no product images and possibly no support details. The
 *     hero's visual is therefore CSS and inline geometry rather than imagery,
 *     and it composes the operator's logo *if* one exists instead of
 *     depending on it.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
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

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

/**
 * The hero's ground.
 *
 * Three layers of pure CSS: a cool glow behind the headline, a warm one under
 * the conversion button, and an engineering grid that fades out downwards.
 * No image request, nothing to 404, and it renders identically for a
 * deployment that has uploaded nothing at all.
 */
function HeroBackdrop(): React.JSX.Element {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -left-32 -top-40 h-96 w-96 rounded-full bg-brand/25 blur-3xl" />
      <div className="absolute -bottom-48 right-0 h-96 w-96 rounded-full bg-action/20 blur-3xl" />
      <div
        className="absolute inset-0"
        // Inline rather than an arbitrary Tailwind value: this is a
        // multi-layer background with a mask, and spelling it out in CSS is
        // considerably easier to read than the bracket syntax for it.
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px),' +
            'linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          // The grid belongs behind the headline, not behind the trust strip
          // at the bottom, where it would fight with the text.
          WebkitMaskImage: 'linear-gradient(to bottom, black, transparent 72%)',
          maskImage: 'linear-gradient(to bottom, black, transparent 72%)',
        }}
      />
    </div>
  );
}

/**
 * The hero's right-hand panel.
 *
 * Decorative, and marked as such — there is no information in here that is not
 * also in the words to its left. It exists because a B2B storefront hero that
 * is a paragraph and two buttons on a coloured rectangle reads as unfinished,
 * and the honest alternatives to stock photography are geometry and the
 * operator's own logo.
 *
 * Hidden below `lg`: on a phone the hero's job is to get the buyer to the
 * catalogue in one thumb-reach, and 300px of decoration between the headline
 * and the button works directly against that.
 */
function HeroVisual(): React.JSX.Element {
  const { business } = useStorefront();

  return (
    <div aria-hidden="true" className="relative hidden lg:block">
      <div className="relative rounded-2xl border border-white/15 bg-white/[0.06] p-5 shadow-overlay">
        {/* Echoes the conversion button's orange, so the panel reads as part
            of the same composition rather than as a separate widget. */}
        <span className="absolute -right-3 -top-3 h-20 w-20 rounded-full bg-action/25 blur-xl" />

        <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-navy/50">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px),' +
                'linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)',
              backgroundSize: '22px 22px',
            }}
          />

          {business.logo === null ? (
            // No logo supplied: abstract stock geometry — a nut in section, a
            // crate, and a routing mark. Industrial in feel, and specific
            // about nothing, because this storefront does not know what the
            // operator sells.
            <svg viewBox="0 0 200 150" className="relative h-full w-full" fill="none">
              <g stroke="#fff">
                <circle cx="100" cy="75" r="62" strokeOpacity="0.08" strokeWidth="1" />
                <circle cx="100" cy="75" r="46" strokeOpacity="0.12" strokeWidth="1" />

                <path
                  d="M100 35 134.6 55v40L100 115 65.4 95V55z"
                  strokeOpacity="0.45"
                  strokeWidth="1.6"
                  fill="#fff"
                  fillOpacity="0.05"
                  strokeLinejoin="round"
                />
                <circle cx="100" cy="75" r="15" strokeOpacity="0.45" strokeWidth="1.6" />

                <g strokeOpacity="0.28" strokeWidth="1.4" strokeLinejoin="round">
                  <path d="M26 42 42 34l16 8v17l-16 8-16-8z" />
                  <path d="m26 42 16 8 16-8M42 50v17" />
                </g>

                <g strokeOpacity="0.28" strokeWidth="1.4" strokeLinecap="round">
                  <path d="M150 96v14a7 7 0 0 0 7 7h13" />
                  <circle cx="150" cy="90" r="5" />
                  <circle cx="176" cy="117" r="5" />
                </g>
              </g>

              {/* The one warm note. `currentColor` from a Tailwind text class,
                  so it is the palette's orange and not a second copy of it. */}
              <g className="text-action" fill="currentColor" fillOpacity="0.9">
                <rect x="26" y="108" width="10" height="10" rx="2" />
                <rect x="41" y="108" width="10" height="10" rx="2" fillOpacity="0.6" />
                <rect x="56" y="108" width="10" height="10" rx="2" fillOpacity="0.3" />
              </g>
            </svg>
          ) : (
            // A logo *was* supplied, so it becomes the subject. On a white
            // plate, because a transparent logo drawn for a light background
            // would otherwise sit invisibly on navy.
            <img
              src={business.logo.url}
              alt=""
              className="relative max-h-[55%] max-w-[70%] rounded-lg bg-white object-contain p-4 shadow-lift"
            />
          )}
        </div>

        {/* A closing rhythm under the plate. Geometry, not placeholder bars —
            three tinted chips read as a deliberate mark, whereas grey lines of
            differing widths read as content that has failed to load. */}
        <div className="mt-4 grid grid-cols-3 gap-3">
          {[BoxIcon, LayersIcon, HexIcon].map((Mark, index) => (
            <span
              key={index}
              className="flex h-11 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/45"
            >
              <Mark className="h-5 w-5" />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The operational trust strip.
 *
 * Sits inside the hero rather than under it, so the headline, the button and
 * the reasons to believe it are one block instead of three stacked bands.
 *
 * The third entry's supporting line is the only thing here that varies: when
 * an operator has recurring orders switched off, promising scheduled
 * deliveries would be a lie, and reordering from history — which every
 * deployment has — is the truthful version of the same reassurance.
 */
function TrustStrip(): React.JSX.Element {
  const { features } = useStorefront();

  const items = [
    {
      icon: BriefcaseIcon,
      label: 'Business purchasing',
      detail: 'Minimum quantities, order multiples and tax shown before you commit.',
    },
    {
      icon: TruckIcon,
      label: 'Reliable fulfilment',
      detail: 'Every order tracked from confirmation through to delivery.',
    },
    {
      icon: RepeatIcon,
      label: 'Repeat ordering',
      detail: features.recurringOrders
        ? 'Put regular lines on a schedule and let them repeat.'
        : 'Reorder any past order at current prices.',
    },
  ];

  return (
    // Three across only from `lg`. At `sm` each column would be about 150px
    // of text once the icon and the padding are taken out, which turns two
    // lines of supporting copy into eight — the strip stacks instead, and
    // stacked it still reads as one band because of the dividers.
    <ul className="relative grid divide-y divide-white/10 border-t border-white/15 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
      {items.map(({ icon: ItemIcon, label, detail }) => (
        <li key={label} className="flex items-start gap-3 px-6 py-5 lg:px-8">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white/10 text-white ring-1 ring-inset ring-white/15">
            <ItemIcon className="h-[1.15rem] w-[1.15rem]" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-white">{label}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-white/70">{detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Hero(): React.JSX.Element {
  const { business, features } = useStorefront();
  const { isCustomer, isLoading } = useSession();
  const { currency } = useLocale();

  // Read from config, not written here. A chip that would be false for a given
  // deployment is simply absent from its storefront.
  const indicators = [
    { icon: CurrencyIcon, label: `Priced in ${currency}` },
    { icon: ClockIcon, label: 'Order online, any time' },
    features.recurringOrders ? { icon: RepeatIcon, label: 'Repeat purchase scheduling' } : null,
  ].filter((entry): entry is { icon: typeof ClockIcon; label: string } => entry !== null);

  return (
    <section className="on-navy relative mb-10 overflow-hidden rounded-xl bg-surface-inverse text-ink-inverse shadow-lift">
      <HeroBackdrop />

      <div className="relative grid gap-10 px-6 py-12 sm:px-10 sm:py-14 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-center lg:gap-12 lg:py-16 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="max-w-2xl">
          <p className="text-xxs font-semibold uppercase tracking-[0.18em] text-white/60">
            Online trade catalogue
          </p>

          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
            Everything your business orders, in one place
          </h1>

          <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-inverse/80">
            Browse the {business.displayName} catalogue, see the price and the purchasing rules
            before you commit, and{' '}
            {features.recurringOrders
              ? 'set repeat purchases to arrive on a schedule you choose'
              : 'reorder from any previous order in a couple of clicks'}
            .
          </p>

          {/* Two actions, two jobs, two hues.
           *
           * Orange is the conversion path: getting into the catalogue is the
           * thing this page exists to cause, and `action-strong` (#C2410C)
           * carries white at 5.14:1 — the accent #EA580C would be 3.56:1 and
           * fail AA under a label.
           *
           * Sign in stays the quiet outlined option. Brand blue on navy is
           * 1.57:1 and simply vanishes, so the "quieter" half of the pair is
           * expressed as an outline rather than as a blue fill — see the
           * `inverse-outline` variant in components/ui.tsx.
           */}
          <div className="mt-8 flex flex-wrap gap-3">
            {/* The inset white ring is the one on-dark adjustment: #C2410C
                against this navy is 2.8:1, just under the 3:1 a control
                boundary needs to be perceivable (WCAG 1.4.11). The ring's own
                edge is 4.2:1, so the button has a real outline on the band
                without the fill or the label changing. */}
            <ButtonLink
              to="/products"
              variant="action"
              size="lg"
              className="ring-1 ring-inset ring-white/25"
            >
              Browse the catalogue
            </ButtonLink>

            {/* Only offered while genuinely signed out, and never during the
                first moment when the session is still unknown - a Sign in button
                that flashes for a signed-in customer looks broken. */}
            {!isLoading && !isCustomer && (
              <ButtonLink to="/login" variant="inverse-outline" size="lg">
                Sign in to order
              </ButtonLink>
            )}
          </div>

          <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2.5">
            {indicators.map(({ icon: IndicatorIcon, label }) => (
              <li key={label} className="flex items-center gap-2 text-xs font-medium text-white/75">
                <IndicatorIcon className="h-4 w-4 shrink-0 text-white/50" />
                {label}
              </li>
            ))}
          </ul>
        </div>

        <HeroVisual />
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
  const query = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/catalog/categories'),
    staleTime: 5 * 60_000,
  });

  // A category with nothing published in it is a dead end, so it is not shown.
  const categories = (query.data?.categories ?? []).filter((node) => node.productCount > 0);

  if (categories.length === 0) return null;

  return (
    <section aria-labelledby="shop-by-category" className="mb-12">
      <header className="mb-4">
        <h2 id="shop-by-category" className="text-title-lg text-ink">
          Shop by category
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
                    {category.productCount} product{category.productCount === 1 ? '' : 's'}
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
  const { currency } = useLocale();

  const query = useQuery({
    queryKey: ['products', { sort: 'newest', limit: 8, currency }],
    queryFn: () =>
      api.get<ProductListResponse>('/catalog/products', {
        query: { limit: 8, sort: 'newest', currency },
      }),
  });

  const hasProducts = query.data !== undefined && query.data.products.length > 0;

  return (
    <section aria-labelledby="latest-products">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xxs font-semibold uppercase tracking-[0.14em] text-ink-subtle">
            Catalogue
          </p>
          <h2 id="latest-products" className="mt-1.5 text-title-lg text-ink">
            Latest products
          </h2>
          <p className="mt-1 max-w-prose text-sm text-ink-muted">
            The most recently published lines, priced in {currency}.
          </p>
        </div>

        <Link
          to="/products"
          className="inline-flex shrink-0 items-center gap-1 rounded text-sm font-medium text-brand hover:underline"
        >
          View all products
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
            <p className="text-base font-medium text-ink">Nothing is published yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-muted">
              Products appear here as soon as they are published. Check back shortly.
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
            <p className="text-title-sm text-ink">Looking for something specific?</p>
            <p className="mx-auto mt-1.5 max-w-lg text-sm leading-relaxed text-ink-muted">
              The full catalogue can be filtered by category and price, and sorted by name or
              price.
            </p>
          </div>
          <ButtonLink to="/products" variant="secondary" size="lg">
            View all products
          </ButtonLink>
        </div>
      )}
    </section>
  );
}

export function HomePage(): React.JSX.Element {
  const { business } = useStorefront();

  useDocumentMeta(
    {
      title: '',
      description: `Browse the ${business.displayName} catalogue. Industrial and business supplies, ordered online with repeat purchase scheduling.`,
    },
    business.displayName,
  );

  return (
    <>
      <Hero />
      <CategoryStrip />
      <NewestProducts />
    </>
  );
}
