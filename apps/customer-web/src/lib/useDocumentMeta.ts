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

interface DocumentMeta {
  /** The page-specific part. The business name is appended automatically. */
  title: string;
  description?: string;
  /**
   * Account, cart, checkout and order pages must never be indexed — they are
   * per-customer and often carry an order number in the URL.
   */
  noIndex?: boolean;
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
  { title, description, noIndex }: DocumentMeta,
  siteName: string,
): void {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title.length > 0 ? `${title} · ${siteName}` : siteName;

    const cleanups: (() => void)[] = [];

    if (description !== undefined) {
      cleanups.push(setNamedMeta('description', description));
    }

    if (noIndex === true) {
      cleanups.push(setNamedMeta('robots', 'noindex, nofollow'));
    }

    return () => {
      document.title = previousTitle;
      for (const cleanup of cleanups) cleanup();
    };
  }, [title, description, noIndex, siteName]);
}
