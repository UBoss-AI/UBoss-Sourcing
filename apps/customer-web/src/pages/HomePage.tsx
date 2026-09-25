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
import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { HeroSearch } from '@/components/hero-search/HeroSearch';
import { CollectionShelves } from '@/components/home/CollectionShelves';
import { InlineProducts } from '@/components/home/InlineProducts';
import { HeroStage } from '@/components/greeting/HeroStage';
import { FlipWords } from '@/components/ui/flip-words';
import { PRODUCT_BRAND, PRODUCT_TAGLINE } from '@/lib/brand';
import { cx } from '@/lib/cx';
import { SourcingHub } from '@/components/greeting/SourcingHub';
import { useAccountIdentity } from '@/pages/account/useAccountIdentity';
import { ClockIcon, CurrencyIcon, RepeatIcon } from '@/components/icons';
import { CategoryCarousel } from '@/components/catalog/CategoryCarousel';
import { stockedCategories } from '@/lib/category-tree';
import { formatNumber } from '@/lib/format';
import { api } from '@/lib/api';
import { useLocale } from '@/app/locale-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { CategoryNode } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

/**
 * The home page's ground — the whole page's, not the greeting's.
 *
 * White, brand blue and sky, in pure CSS: two soft washes that put the light
 * where the hub is, a faint engineering grid, and a sparse field of points
 * that carries the WebGL stage's particles on down the page. No image request,
 * nothing to 404, and it renders identically for a deployment that has
 * uploaded nothing.
 *
 * IT USED TO BELONG TO THE GREETING, AND THAT WAS THE CARD.
 *
 * Drawn inside the greeting's rounded, bordered section, it stopped at that
 * section's edges — so the hero read as a panel floating on the body's sunken
 * colour, with a band of that colour between it and the header. It is drawn
 * once now, behind every section of the page, and nothing below it restarts
 * it: the categories, the shelves and the catalogue all sit on the same
 * ground the headline does.
 *
 * The washes are pinned to the top in `rem` rather than stretched in percent,
 * because the page is thousands of pixels tall and a gradient in percent of
 * that would put the hero's light somewhere around the third shelf. The grid
 * and the points run the full height, fading to a floor rather than to
 * nothing, so the page never changes ground halfway down.
 *
 * Everything here is behind the content at a low enough opacity that the text
 * on top of it is still ink on white — the palette's 15.8:1 — rather than ink
 * on a tint nobody measured. Static, so there is nothing for reduced motion to
 * stop; the only moving layer is `HeroStage`, which has its own brakes.
 */
function HomeBackdrop(): React.JSX.Element {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-[48rem] bg-gradient-to-b from-bloom/30 via-surface to-surface" />
      <div className="absolute -right-24 -top-40 h-[34rem] w-[34rem] rounded-full bg-bloom/40 blur-3xl" />
      <div className="absolute -left-24 top-[26rem] h-96 w-96 rounded-full bg-brand/[0.07] blur-3xl" />
      <div
        className="absolute inset-0"
        // Inline rather than an arbitrary Tailwind value: this is a
        // multi-layer background with a mask, and spelling it out in CSS is
        // considerably easier to read than the bracket syntax for it.
        style={{
          backgroundImage:
            // The points: two offset tiles of single dots, at sizes that do
            // not divide each other, so the field never reads as a lattice.
            'radial-gradient(circle at 30% 40%, rgb(var(--brand) / 0.35) 1px, transparent 1.5px),' +
            'radial-gradient(circle at 70% 80%, rgb(var(--brand) / 0.22) 1px, transparent 1.5px),' +
            'linear-gradient(to right, rgb(var(--brand) / 0.045) 1px, transparent 1px),' +
            'linear-gradient(to bottom, rgb(var(--brand) / 0.045) 1px, transparent 1px)',
          backgroundSize: '173px 211px, 257px 139px, 44px 44px, 44px 44px',
          // Full strength behind the headline and the hub, easing to a floor
          // under the sections below — present all the way down, but never at
          // a strength that fights a product card's text.
          WebkitMaskImage: 'linear-gradient(to bottom, black, rgb(0 0 0 / 0.45) 44rem)',
          maskImage: 'linear-gradient(to bottom, black, rgb(0 0 0 / 0.45) 44rem)',
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

  /*
   * The two phrases under the tagline, in the order they are shown.
   *
   * The two halves of the strapline — "Source with Intelligence", "Deliver
   * with Confidence" — each its own key, so each language's approved wording
   * of the pair survives the split. It used to alternate the whole strapline
   * with `Powered by UBOSS`; the attribution is the footer's small print now,
   * and the line under the name is the product's tagline, which does not move.
   *
   * Rebuilt on each render, which costs nothing: `FlipWords` arms its timer
   * off the length of the list, not off the identity of the array.
   */
  const phrases = [t('greeting.taglineSource'), t('greeting.taglineDeliver')];
  const isProductBrand = business.displayName === PRODUCT_BRAND;

  const eyebrow =
    !isLoading && isCustomer
      ? shortName === null
        ? t('greeting.welcomeBack')
        : t('greeting.welcomeBackNamed', { name: shortName })
      : t('greeting.eyebrow');

  /*
   * The WebGL stage, and the one thing it changes about the hub.
   *
   * `hubRef` is what the scene anchors its core to — the hub moves from the
   * right-hand column to under the text below `lg`, and a core placed by
   * breakpoint rather than by measurement would be correct at one window
   * width. `stageActive` is the scene reporting that it genuinely rendered, at
   * which point the hub gives up drawing its own glass sphere; see
   * `HeroStage`'s `onActive` for why that is reported rather than assumed.
   *
   * Both are held here rather than inside the hub because the canvas is the
   * whole card's backdrop, not the hub's — the depth field and the ground
   * plane run behind the headline and the search bar too, which is what stops
   * the effect looking like a widget bolted onto one corner.
   */
  const hubRef = useRef<HTMLDivElement | null>(null);
  const [stageActive, setStageActive] = useState(false);
  const onStageActive = useCallback((active: boolean) => {
    setStageActive(active);
  }, []);

  return (
    /*
     * Full-bleed, and not a card.
     *
     * No border, no radius, no shadow and no ground of its own: the backdrop
     * is the page's (see `HomeBackdrop`), and a greeting framed as a panel on
     * top of it would bring back exactly the floating card this replaced. The
     * section still clips, because the canvas inside it is sized to it and the
     * orbits are allowed to run past the hub's square.
     */
    <section data-stage={stageActive ? 'on' : 'off'} className="relative overflow-hidden">
      {/*
       * The stage spans the full width with the section, and fades out over
       * its last few rem. Without the fade the canvas's floor and particle
       * field stopped on a hard horizontal line where the section ends — a
       * seam in the one background this page is meant to have. The globe sits
       * well above the fade, so it is never touched by it.
       */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 7rem), transparent)',
          maskImage: 'linear-gradient(to bottom, black calc(100% - 7rem), transparent)',
        }}
      >
        <HeroStage anchorRef={hubRef} onActive={onStageActive} />
      </div>

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
      {/* The reading measure the frame used to supply, on the content only:
          the ground behind it is full width, the text and the hub stay
          exactly where they were. */}
      <div className="relative mx-auto max-w-content px-4">
        <div className="relative grid grid-cols-1 gap-12 px-6 py-10 sm:px-10 sm:py-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-stretch lg:gap-10 lg:py-12">
          <div className="flex max-w-2xl flex-col lg:justify-between">
            <div>
              <p className="text-xxs font-semibold uppercase tracking-[0.18em] text-brand">
                {eyebrow}
              </p>

              {/*
                The shop's own name, read from the configuration rather than the
                phrase book, and nothing else.

                It used to be a translation key whose value was this software's
                own product name, which meant every business that bought this
                product greeted its customers with the vendor's name - and on a
                seller's shop front the seller's own customers were welcomed to
                somebody else's marketplace. A name is not a string to translate;
                it is a fact about who is selling.

                IT ALSO USED TO MOVE, AND THAT IS THE OTHER HALF OF THIS.

                One word beside the name cycled — sourcing, intelligence,
                optimism, innovation — which made the name itself part of a
                rotation: "Glovia Sourcing", then "Glovia Intelligence". A brand
                that rewrites itself every three seconds is not a brand, and a
                reader arriving mid-cycle saw a product this deployment does not
                sell. The headline is now the name, still, and the moving copy is
                the strapline below, where a phrase changing is a phrase changing
                rather than a name changing.

                `lib/greeting-headline.ts` went with it: the whole module existed
                to stop a name that ended in a cycling word saying that word
                twice, and with nothing cycling after the name there is nothing
                to collide with.
              */}
              <h1
                className={cx(
                  'mt-3 font-bold text-ink',
                  // The product's own name is the wordmark, in its script face
                  // and a step larger, because a script's short x-height reads a
                  // size smaller than Inter. A deployment's own name is set as
                  // the heading it always was — see the note in `Header.tsx`.
                  isProductBrand
                    ? 'font-brand text-5xl leading-tight sm:text-6xl lg:text-[4rem]'
                    : 'text-3xl tracking-tight sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]',
                )}
              >
                {business.displayName}
              </h1>

              {/*
               * The tagline, still. It is the product's slogan rather than a
               * sentence, so it is a constant and reads the same in every
               * language — see `lib/brand.ts` — and it belongs to Glovia, so a
               * deployment greeting its customers under its own name does not
               * carry it. Set in the wordmark's script, like the name above it.
               */}
              {isProductBrand && (
                <p className="greeting-tagline mt-1 font-brand text-2xl font-bold text-brand sm:text-3xl">
                  {PRODUCT_TAGLINE}
                </p>
              )}

              {/*
               * The two halves of the strapline, alternating.
               *
               * It used to be a sentence, and a different sentence for a guest
               * than for a signed-in customer. Both are gone, deliberately: the
               * guest's version explained what a catalogue is to somebody
               * already looking at one, and the search bar directly below it
               * asks the same question in one control instead of three lines.
               *
               * `sm:whitespace-nowrap` because it is a strapline and a
               * strapline broken over two lines is two half-thoughts. It is held
               * to one line from 640px up, which every translation of it fits
               * at this type size; under that it wraps, because a phone is
               * narrower than the shortest of them and clipping a tagline is
               * worse than turning it.
               *
               * THE GRID IS WHAT STOPS THE LINE JUMPING.
               *
               * Both phrases are in the flow, in the same cell — one visible and
               * one `invisible` — so the row is as tall as the taller of them
               * and stays that height for the life of the page. Without it the
               * band grew and shrank by two lines every few seconds on a phone,
               * where one phrase wraps and the other does not, and everything
               * below the hero moved with it. It cannot
               * be a `min-height`: the taller phrase is a different phrase in
               * each of the eight languages, and a number measured in English is
               * a number that is wrong in Polish.
               *
               * The measuring copies are `aria-hidden`, and `FlipWords` is
               * handed one steady sentence covering both phrases — so a screen
               * reader is told the whole message once and is never read to
               * again. See `components/ui/flip-words.tsx`.
               *
               * 4.2s rather than the component's 3s: these are phrases rather
               * than single words, and somebody has to have time to finish one.
               */}
              <p className="mt-4 grid text-base leading-relaxed text-ink-muted sm:whitespace-nowrap sm:text-lg">
                {phrases.map((phrase) => (
                  <span
                    key={phrase}
                    aria-hidden="true"
                    className="invisible col-start-1 row-start-1"
                  >
                    {phrase}
                  </span>
                ))}

                {/* `greeting-strapline` carries no styling. It is a handle, the
                    way `.orch-orb` is one: with both phrases in the cell as
                    measuring copies, a test asking "what does this line say" by
                    its text would find the copy that is deliberately invisible.
                    See `pages/brand.test.tsx`. */}
                <span className="greeting-strapline col-start-1 row-start-1">
                  <FlipWords
                    words={phrases}
                    duration={4200}
                    srLabel={`${t('greeting.taglineSource')}. ${t('greeting.taglineDeliver')}.`}
                  />
                </span>
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
          <SourcingHub stageRef={hubRef} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/*
 * Categories have no image in the API, so every card has to supply its own —
 * and a grid of twelve identical placeholders is worse than the plain text
 * cards that preceded it, because it looks like twelve failed image loads.
 *
 * Two lookups answer it, both keyed on the department's NAME so that a
 * deployment slugging its catalogue differently still gets the right picture.
 * A department this catalogue recognises gets a photograph
 * (`lib/category-cover.ts`); anything else gets its drawn mark on a brand
 * plate (`lib/category-mark.ts`), which is what every category used to get and
 * is still a finished-looking card. Neither is a fact about the operator's
 * business, so a fresh deployment that has uploaded nothing still has a front
 * page.
 *
 * It is a rail rather than a grid. Twenty-five departments as a grid is most
 * of a screen of small tiles between the greeting and the catalogue — the two
 * things the page is actually for — and it pushed both below the fold. A rail
 * shows the same twenty-five in one band, at a size where the picture does
 * some work, and leaves the rest of the page where it was.
 */

function CategoryStrip(): React.JSX.Element | null {
  const { t, language } = useI18n();

  const query = useQuery({
    queryKey: ['categories', language],
    queryFn: () =>
      api.get<{ categories: CategoryNode[] }>('/catalog/categories', { query: { language } }),
    staleTime: 5 * 60_000,
  });

  const categories = stockedCategories(query.data?.categories ?? []);

  if (categories.length === 0) return null;

  return (
    <section aria-labelledby="shop-by-category" className="mb-12">
      <header className="mb-4">
        <h2 id="shop-by-category" className="text-title-lg text-ink">
          {t('home.shopByCategory')}
        </h2>
        {/* Translated, which it was not: this line used to build itself out
            of an English noun and an English plural rule in JSX, so a
            storefront read in Greek said "22 departments currently stocked."
            in the middle of a Greek page. */}
        <p className="mt-1 text-sm text-ink-muted">
          {t('home.departmentsStocked', {
            count: categories.length,
            departments: formatNumber(categories.length),
          })}
        </p>
      </header>

      <CategoryCarousel categories={categories} />
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
  /*
   * One ground for the whole page, owned here.
   *
   * `StoreLayout` hands this route the full width with no padding, so the
   * backdrop starts at the header's bottom edge and reaches both sides of the
   * window. The sections below the greeting get the reading measure back from
   * their own wrapper. `overflow-x-clip` rather than `overflow-hidden`: the
   * backdrop's washes deliberately hang past the edges, and `hidden` would make
   * this a scroll container and break every `sticky` inside the page.
   */
  return (
    <div className="relative min-h-screen overflow-x-clip">
      <HomeBackdrop />

      <Greeting />

      <div className="relative mx-auto max-w-content px-4 pb-6 sm:pb-8">
        <CategoryStrip />

        {/*
        Curated shelves, between the department rail and the full catalogue.

        The rail above is a table of contents and the list below is a list;
        neither shows a first-time visitor what this catalogue actually sells.
        These do: four groups of departments and the newest lines, six cards
        each, so somebody landing here sees office supplies, industrial
        tooling, technology and consumer goods in one screenful.

        Every shelf is a real category read and disappears entirely when it has
        nothing to show, so a deployment with one department published looks
        deliberate rather than broken. See `components/home/collections.ts` for
        why none of these headings claims popularity.
      */}
        <CollectionShelves />

        <InlineProducts />
      </div>
    </div>
  );
}
