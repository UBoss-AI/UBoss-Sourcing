/**
 * The tags a search engine and a link preview actually read.
 *
 * WHAT THIS CAN AND CANNOT DO, STATED PLAINLY
 *
 * This is a single-page application. Everything here is written into the head
 * after the app boots, which is fine for Google and Bing - both render
 * JavaScript before indexing - and useless for a crawler that does not. Link
 * previews are the sharper limit: Slack, WhatsApp, LinkedIn and most chat
 * clients fetch the raw HTML and never run a line of script, so an Open Graph
 * tag written here is invisible to them. They see the fallback in
 * `index.html`.
 *
 * That is a real ceiling and no amount of care in this file raises it. Server
 * rendering, or a prerender step for the catalogue routes, is what raises it,
 * and `useDocumentMeta` is deliberately the one seam that would have to
 * change. What this file does is make everything else correct, so that when a
 * renderer arrives the metadata is already right rather than being invented
 * at the same time.
 *
 * WHY CANONICAL AND HREFLANG ARE HERE AT ALL
 *
 * The storefront serves eight languages from the SAME url - the language is a
 * preference, not a path segment. To a search engine that reads as one page
 * whose content changes unpredictably, which is the worst of both worlds: no
 * language gets ranked for its own audience, and the eight look like
 * duplicates of each other.
 *
 * `hreflang` with a `?lang=` parameter is the honest fix available without
 * restructuring every route: it tells a crawler that these eight addresses are
 * the same page in different languages and which to show whom, and the
 * canonical on each points at itself so none is treated as a copy of another.
 */

/** Every language the storefront ships, and the one to fall back to. */
export const SEO_LANGUAGES = ['en', 'de', 'el', 'es', 'fr', 'it', 'nl', 'pl'] as const;

/**
 * The origin a canonical URL is built from.
 *
 * `VITE_PUBLIC_SITE_URL` when a deployment sets one, and the browser's own
 * origin otherwise. Configurable because a site behind a CDN, a tunnel or a
 * reverse proxy can be reached on more than one hostname, and a canonical that
 * names the wrong one is worse than none: it tells a crawler to index an
 * address nobody uses.
 *
 * Never a hard-coded domain. This software is run by whoever bought it.
 */
export function siteOrigin(): string {
  const configured: unknown = import.meta.env['VITE_PUBLIC_SITE_URL'];

  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim().replace(/\/+$/, '');
  }

  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

/** An absolute URL for a path, with the query and hash dropped. */
export function canonicalUrl(pathname: string): string {
  const origin = siteOrigin();
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;

  return `${origin}${path}`;
}

/**
 * Replace a set of `<link>` tags, returning a function that removes them.
 *
 * Tagged with `data-seo` so this owns exactly what it wrote. The head also
 * carries font preconnects and the icon, and a cleanup that cleared every
 * `<link>` would take those with it on the first route change.
 */
function setLinks(rel: string, entries: { href: string; hreflang?: string }[]): () => void {
  const created: HTMLLinkElement[] = [];

  for (const entry of entries) {
    const element = document.createElement('link');
    element.rel = rel;
    element.href = entry.href;
    if (entry.hreflang !== undefined) element.hreflang = entry.hreflang;
    element.dataset['seo'] = 'true';

    document.head.appendChild(element);
    created.push(element);
  }

  return () => {
    for (const element of created) element.remove();
  };
}

function setProperty(property: string, content: string): () => void {
  const element = document.createElement('meta');
  element.setAttribute('property', property);
  element.content = content;
  element.dataset['seo'] = 'true';

  document.head.appendChild(element);

  return () => {
    element.remove();
  };
}

function setName(name: string, content: string): () => void {
  const element = document.createElement('meta');
  element.name = name;
  element.content = content;
  element.dataset['seo'] = 'true';

  document.head.appendChild(element);

  return () => {
    element.remove();
  };
}

export interface SeoTags {
  pathname: string;
  title: string;
  description: string;
  siteName: string;
  /** Absolute or root-relative. Root-relative is resolved against the origin. */
  imageUrl?: string | null;
  /** `website` for most pages, `product` for a product page. */
  type?: 'website' | 'product';
  /** Suppresses canonical and hreflang entirely. */
  noIndex?: boolean;
}

/**
 * Write the canonical, the language alternates and the sharing tags.
 *
 * Returns a cleanup, so a route change removes what the previous route wrote
 * rather than leaving a product's Open Graph image attached to the cart.
 *
 * A `noIndex` page gets NONE of this. An account page, a cart or a checkout is
 * per-customer and often carries an order number in its URL; a canonical on
 * one is an invitation to index it, and an Open Graph description is a leak
 * into whatever chat client the link is pasted into.
 */
export function applySeoTags(tags: SeoTags): () => void {
  if (tags.noIndex === true) return () => undefined;

  const cleanups: (() => void)[] = [];
  const url = canonicalUrl(tags.pathname);

  cleanups.push(setLinks('canonical', [{ href: url }]));

  // The eight languages, plus x-default for a crawler that matches none of
  // them. x-default points at the unparameterised URL, which is the page as it
  // resolves for a visitor whose browser asks for something else entirely.
  cleanups.push(
    setLinks('alternate', [
      ...SEO_LANGUAGES.map((language) => ({
        href: `${url}?lang=${language}`,
        hreflang: language,
      })),
      { href: url, hreflang: 'x-default' },
    ]),
  );

  const image =
    tags.imageUrl === null || tags.imageUrl === undefined
      ? null
      : tags.imageUrl.startsWith('http')
        ? tags.imageUrl
        : `${siteOrigin()}${tags.imageUrl.startsWith('/') ? '' : '/'}${tags.imageUrl}`;

  cleanups.push(
    setProperty('og:type', tags.type ?? 'website'),
    setProperty('og:title', tags.title),
    setProperty('og:description', tags.description),
    setProperty('og:url', url),
    setProperty('og:site_name', tags.siteName),
    setName('twitter:card', image === null ? 'summary' : 'summary_large_image'),
    setName('twitter:title', tags.title),
    setName('twitter:description', tags.description),
  );

  if (image !== null) {
    cleanups.push(setProperty('og:image', image), setName('twitter:image', image));
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

/**
 * Write one JSON-LD block, and remove it on cleanup.
 *
 * Structured data is the part of this file that earns the most: a Product with
 * a valid Offer is what puts a price and an availability line under a result
 * in Google, and it is read from the same figures the page renders rather than
 * being assembled separately - a rich result that disagrees with the page is a
 * manual action waiting to happen.
 */
export function applyJsonLd(id: string, data: unknown): () => void {
  const element = document.createElement('script');
  element.type = 'application/ld+json';
  element.dataset['seoJsonld'] = id;

  // `JSON.stringify` escapes nothing that matters inside a script element
  // except a closing tag, which cannot appear in JSON but can appear inside a
  // string value - a product called `</script>` is the injection this stops.
  element.textContent = JSON.stringify(data).replace(/</g, '\\u003c');

  document.head.appendChild(element);

  return () => {
    element.remove();
  };
}

export interface ProductJsonLdInput {
  name: string;
  description: string | null;
  sku: string;
  brand: string | null;
  imageUrls: string[];
  url: string;
  /** Major units as a decimal string, e.g. "1499.50". Never a number. */
  price: string | null;
  currency: string | null;
  inStock: boolean;
  /** True when the figure was converted rather than typed for this currency. */
  priceIsApproximate?: boolean;
}

/**
 * A `Product` with an `Offer`, in the shape Google documents.
 *
 * Two decisions worth stating.
 *
 * **The price is a string, all the way through.** It arrives from the API as
 * an exact decimal and goes into the JSON as one. `schema.org` permits a
 * number and Google accepts one, but putting it through `Number` here would
 * reintroduce, in the last hundred lines of the stack, exactly the float error
 * the whole money design exists to avoid.
 *
 * **A converted price is omitted, not published.** An approximate figure -
 * derived from another currency at yesterday's reference rate - is honest on a
 * page that captions it as approximate and dishonest in a rich result that
 * cannot. Google treats a price in structured data as a commitment and
 * penalises a mismatch, so the offer is published only where the shop has a
 * real figure for that currency.
 */
export function productJsonLd(input: ProductJsonLdInput): Record<string, unknown> {
  const offer =
    input.price === null || input.currency === null || input.priceIsApproximate === true
      ? null
      : {
          '@type': 'Offer',
          url: input.url,
          priceCurrency: input.currency,
          price: input.price,
          availability: input.inStock
            ? 'https://schema.org/InStock'
            : 'https://schema.org/OutOfStock',
        };

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: input.name,
    ...(input.description === null ? {} : { description: input.description }),
    sku: input.sku,
    ...(input.brand === null ? {} : { brand: { '@type': 'Brand', name: input.brand } }),
    ...(input.imageUrls.length === 0 ? {} : { image: input.imageUrls }),
    url: input.url,
    ...(offer === null ? {} : { offers: offer }),
  };
}

export interface BreadcrumbEntry {
  name: string;
  path: string;
}

/** A `BreadcrumbList`, which is what puts a category trail under a result. */
export function breadcrumbJsonLd(entries: BreadcrumbEntry[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: entries.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: entry.name,
      item: canonicalUrl(entry.path),
    })),
  };
}

/** The shop itself, for the home page. */
export function organizationJsonLd(input: {
  name: string;
  description: string;
  logoUrl: string | null;
}): Record<string, unknown> {
  const origin = siteOrigin();

  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: input.name,
    description: input.description,
    url: origin,
    ...(input.logoUrl === null ? {} : { logo: `${origin}${input.logoUrl}` }),
  };
}
