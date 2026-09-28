/**
 * The sections of the About page, in the order the page stacks them.
 *
 * Two approved visual references are behind these. The six-card grid under a
 * centred heading, with a soft glow behind it, is `AboutCapabilities`; the
 * picture-left, text-right "What we do" block is `AboutStory`, with its picture
 * in `AboutMedia`. What was taken out of both is what a reference carries and a
 * shipped page must not: a component-wide font override (this app has its own
 * type), remote icons and a stock photograph (the CSP is `img-src 'self'`, and
 * nobody licensed them), a play button with no video behind it, and a "Read
 * more" button that went nowhere. The spacing, the card rhythm, the rounded
 * media and the way it stacks on a phone are kept.
 *
 * Every word is in the catalogue, and every sentence that names the business
 * says `{{marketplace}}` - the name this deployment trades under, which is the
 * product's own until the operator sets theirs. The tagline and the attribution
 * are constants from `lib/brand.ts`, for the reasons given there.
 */
import { useStorefront } from '@/app/storefront-context';
import { ButtonLink } from '@/components/ui';
import { ArrowRightIcon } from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';
import { PARENT_ATTRIBUTION, PRODUCT_BRAND, PRODUCT_TAGLINE } from '@/lib/brand';
import { cx } from '@/lib/cx';
import {
  aboutCapabilities,
  aboutStory,
  capabilityBodyKey,
  capabilityTitleKey,
  type AboutStoryKey,
} from './about-content';
import { AboutMedia } from './AboutMedia';

/** Where "Explore what you can do" takes the reader. */
export const ABOUT_CAPABILITIES_ID = 'about-capabilities';

function storyKey(key: AboutStoryKey): `about.story.${AboutStoryKey}` {
  return `about.story.${key}`;
}

/**
 * The page's heading.
 *
 * The heading is the product's tagline where the storefront is the product's
 * own, set in the wordmark's face as it is under the name in the header. On a
 * deployment trading under another name it is an ordinary translated heading
 * instead: Gloviaa Mart's slogan over Northwind's shop would be the software
 * putting its own brand on somebody else's business - the same rule the header
 * follows.
 */
export function AboutIntro(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const isProductBrand = business.displayName === PRODUCT_BRAND;

  return (
    <header className="text-center">
      <p className="text-xxs font-semibold uppercase tracking-[0.2em] text-brand">
        {t('about.eyebrow')}
      </p>
      <h1
        data-route-focus
        tabIndex={-1}
        className={cx(
          'mx-auto mt-3 max-w-3xl text-ink focus:outline-none',
          isProductBrand
            ? 'font-brand text-4xl font-bold leading-tight sm:text-5xl'
            : 'text-title-xl sm:text-4xl sm:leading-tight',
        )}
      >
        {isProductBrand ? PRODUCT_TAGLINE : t('about.headingFallback')}
      </h1>
      <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-ink-muted">
        {t('about.lede')}
      </p>
      {/* The same small print as the footer's, and not translated, for the
          reason `lib/brand.ts` gives. */}
      <p className="mt-4 text-xs font-medium text-ink-subtle">{PARENT_ATTRIBUTION}</p>
    </header>
  );
}

/** "What we do": the picture on the left, the story on the right. */
export function AboutStory(): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();

  return (
    <section
      aria-labelledby="about-story-title"
      className="flex flex-col items-center gap-10 lg:flex-row lg:items-center lg:justify-center lg:gap-14"
    >
      <AboutMedia />

      <div className="w-full max-w-xl text-sm leading-relaxed text-ink-muted sm:text-base">
        <h2 id="about-story-title" className="text-title-lg uppercase tracking-wide text-ink">
          {t('about.story.title')}
        </h2>
        <div
          aria-hidden="true"
          className="mt-2 h-[3px] w-24 rounded-full bg-gradient-to-r from-brand-fill to-bloom"
        />

        <div className="mt-6 space-y-3">
          {aboutStory(features).map((key) => (
            <p key={key}>{t(storyKey(key))}</p>
          ))}
        </div>

        {/* A real destination: the capabilities below, on this page. An
            anchor, so it works with a middle click and without script; the
            handler keeps the jump out of the history. Left to the browser it
            added a `#` entry, and because the app restores scroll itself,
            Back then removed the hash and left the reader where they were -
            one press of Back that did nothing visible. Now Back leaves the
            page, as it would on any other link. `scrollIntoView` with no
            behaviour follows the stylesheet's, which is smooth unless the
            visitor asked for less motion. */}
        <a
          href={`#${ABOUT_CAPABILITIES_ID}`}
          onClick={(event) => {
            const target = document.getElementById(ABOUT_CAPABILITIES_ID);
            if (target === null) return;
            event.preventDefault();
            target.scrollIntoView({ block: 'start' });
            target.focus({ preventScroll: true });
          }}
          className="mt-8 inline-flex min-h-11 items-center gap-2 rounded-full bg-gradient-to-r from-brand-fill to-brand-fill-hover px-7 py-3 text-sm font-medium text-white shadow-card transition hover:-translate-y-0.5 hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:translate-y-0"
        >
          {t('about.story.readMore')}
          <ArrowRightIcon className="h-4 w-4 rotate-90" />
        </a>
      </div>
    </section>
  );
}

/** The capability grid, under its own centred heading. */
export function AboutCapabilities(): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();
  const capabilities = aboutCapabilities(features);

  return (
    <section
      id={ABOUT_CAPABILITIES_ID}
      aria-labelledby="about-capabilities-title"
      tabIndex={-1}
      // Clear of the sticky header when the anchor above lands here.
      className="relative isolate scroll-mt-24 focus:outline-none"
    >
      {/* The glow from the reference, as a gradient and kept inside this
          section's own stacking context (`isolate`), so it can never slide
          behind an unrelated one - or spill sideways into a scrollbar. It sits
          behind the cards, which are opaque, and never behind loose text. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-24 -z-10 mx-auto h-[26rem] max-w-3xl rounded-full bg-[radial-gradient(closest-side,rgb(var(--bloom)/0.55),transparent)]"
      />

      <h2 id="about-capabilities-title" className="text-center text-title-xl text-ink">
        {t('about.capabilities.title')}
      </h2>
      <p className="mx-auto mt-2 max-w-lg text-center text-sm text-ink-muted">
        {t('about.capabilities.description')}
      </p>

      <ul className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
        {capabilities.map(({ key, icon: Icon }) => (
          <li
            key={key}
            data-capability={key}
            className="rounded-xl border border-border bg-surface p-6 shadow-card"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-md border border-brand/20 bg-brand-soft text-brand">
              <Icon className="h-5 w-5" />
            </span>
            <h3 className="mt-5 text-base font-semibold text-ink">{t(capabilityTitleKey(key))}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t(capabilityBodyKey(key))}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Where to go next. Three real destinations, nothing that only looks like one. */
export function AboutCallToAction(): React.JSX.Element {
  const { t } = useI18n();

  return (
    <section
      aria-labelledby="about-cta-title"
      className="rounded-2xl border border-border bg-surface px-6 py-10 text-center shadow-card"
    >
      <h2 id="about-cta-title" className="text-title-lg text-ink">
        {t('about.cta.title')}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
        {t('about.cta.body')}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <ButtonLink to="/products" variant="primary">
          {t('about.cta.browse')}
        </ButtonLink>
        <ButtonLink to="/sell">{t('about.cta.sell')}</ButtonLink>
        <ButtonLink to="/support" variant="ghost">
          {t('about.cta.support')}
        </ButtonLink>
      </div>
    </section>
  );
}
