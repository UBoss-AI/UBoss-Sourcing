/**
 * Per-route document title and meta tags.
 *
 * This is a single-page app, so there is no server render to put a `<title>`
 * in the initial HTML. What this does buy: a correct browser tab and bookmark,
 * a correct history entry, and a correct title announced when a screen reader
 * notices the page changed. Crawlers that execute JavaScript pick it up; those
 * that do not, will not.
 *
 * If organic search becomes a priority, this hook is the seam to replace with
 * server rendering — every page already declares its metadata through it, so
 * the call sites would not change.
 */
import { useEffect } from 'react';
import { applyJsonLd, applySeoTags } from './seo';

interface DocumentMeta {
  /** The page-specific part. The business name is appended automatically. */
  title: string;
  description?: string;
  /**
   * Account, cart, checkout and order pages must never be indexed — they are
   * per-customer and often carry an order number in the URL.
   */
  noIndex?: boolean;
  /** The image a shared link previews with. A product's primary photograph. */
  imageUrl?: string | null;
  /** `product` on a product page, `website` everywhere else. */
  type?: 'website' | 'product';
}

/**
 * Set a `<meta name="...">`, returning a function that restores what was there.
 *
 * Restoring matters: without it, navigating from a product page to the cart
 * would leave the product's description attached to the cart.
 */
function setNamedMeta(name: string, content: string): () => void {
  const existing = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);

  if (existing !== null) {
    const previous = existing.content;
    existing.content = content;

    return () => {
      existing.content = previous;
    };
  }

  const created = document.createElement('meta');
  created.name = name;
  created.content = content;
  document.head.appendChild(created);

  return () => {
    created.remove();
  };
}

export function useDocumentMeta(
  { title, description, noIndex, imageUrl, type }: DocumentMeta,
  siteName: string,
): void {
  useEffect(() => {
    const previousTitle = document.title;
    const composed = title.length > 0 ? `${title} · ${siteName}` : siteName;
    document.title = composed;

    const cleanups: (() => void)[] = [];

    if (description !== undefined) {
      cleanups.push(setNamedMeta('description', description));
    }

    if (noIndex === true) {
      cleanups.push(setNamedMeta('robots', 'noindex, nofollow'));
    }

    // The canonical, the eight language alternates and the sharing tags.
    //
    // Driven from this hook rather than added page by page, so a route that
    // declares its title gets its canonical for free and cannot be forgotten.
    // `applySeoTags` writes nothing at all for a `noIndex` page - an account
    // page or a checkout must not be canonicalised or previewable.
    cleanups.push(
      applySeoTags({
        pathname: window.location.pathname,
        title: composed,
        description: description ?? '',
        siteName,
        imageUrl: imageUrl ?? null,
        ...(type === undefined ? {} : { type }),
        ...(noIndex === undefined ? {} : { noIndex }),
      }),
    );

    return () => {
      document.title = previousTitle;
      for (const cleanup of cleanups) cleanup();
    };
  }, [title, description, noIndex, siteName, imageUrl, type]);
}

/**
 * Attach a JSON-LD block for as long as the component is mounted.
 *
 * Separate from `useDocumentMeta` because only a few pages have structured
 * data worth publishing - a product, a category trail, the home page - and
 * making every page pass `null` for it would be noise on eighty call sites.
 *
 * `data` is serialised into the dependency list rather than compared by
 * reference: callers build the object inline, so a reference comparison would
 * rewrite the tag on every single render.
 */
export function useJsonLd(id: string, data: unknown): void {
  const serialised = data === null ? null : JSON.stringify(data);

  useEffect(() => {
    if (serialised === null) return;
    return applyJsonLd(id, JSON.parse(serialised));
  }, [id, serialised]);
}
