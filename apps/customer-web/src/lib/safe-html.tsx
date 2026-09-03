/**
 * Rendering rich product descriptions.
 *
 * The backend already sanitises `descriptionHtml` against an allowlist before
 * storing it, so what arrives here should be clean. This is a *second* layer,
 * and it exists because "should be" is doing a lot of work in that sentence:
 * a future migration, a direct database edit, or a bug in a write path that
 * skips the sanitiser would all land here, and this is the last place before
 * the browser executes it.
 *
 * It uses `DOMParser`, not a regular expression. Regex-based HTML stripping is
 * how sanitisers get bypassed — the browser's own parser is the only thing
 * that agrees with the browser about what a tag is.
 *
 * `DOMParser` builds an inert document: scripts in it never execute, images
 * never fetch, and `onerror` never fires. Nodes are inspected there and only
 * the survivors are moved into the live page.
 */
import { useMemo } from 'react';

/**
 * Elements allowed through, matching the backend's allowlist.
 *
 * Anything not on this list is unwrapped — its children are kept, the element
 * itself is dropped. Deleting the subtree would silently lose a paragraph of
 * product description because of one stray `<div>`.
 */
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'UL', 'OL', 'LI',
  'H2', 'H3', 'H4', 'BLOCKQUOTE', 'A', 'TABLE', 'THEAD', 'TBODY',
  'TR', 'TH', 'TD', 'SPAN', 'CODE', 'PRE', 'HR',
]);

/** Removed entirely, children and all — nothing inside them is content. */
const DROP_ENTIRELY = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'LINK', 'META', 'SVG']);

/** Attributes allowed on a surviving element. Everything else is stripped. */
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  A: new Set(['href', 'title']),
  TD: new Set(['colspan', 'rowspan']),
  TH: new Set(['colspan', 'rowspan', 'scope']),
};

/** A URL scheme safe to follow. `javascript:` is the one that matters. */
function isSafeHref(value: string): boolean {
  const trimmed = value.trim().toLowerCase();

  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return true;

  return trimmed.startsWith('https://') || trimmed.startsWith('http://') || trimmed.startsWith('mailto:');
}

function scrub(element: Element): void {
  // Iterate over a copy: the loop mutates the child list.
  for (const child of [...element.children]) {
    if (DROP_ENTIRELY.has(child.tagName)) {
      child.remove();
      continue;
    }

    scrub(child);

    if (!ALLOWED_TAGS.has(child.tagName)) {
      // Unwrap rather than delete, so the text inside survives.
      child.replaceWith(...child.childNodes);
      continue;
    }

    const allowed = ALLOWED_ATTRIBUTES[child.tagName] ?? new Set<string>();

    for (const attribute of [...child.attributes]) {
      const name = attribute.name.toLowerCase();

      // Every event handler, in one rule. `onerror` on an image is the classic.
      if (name.startsWith('on') || !allowed.has(name)) {
        child.removeAttribute(attribute.name);
        continue;
      }

      if (name === 'href' && !isSafeHref(attribute.value)) {
        child.removeAttribute(attribute.name);
      }
    }

    if (child.tagName === 'A' && child.hasAttribute('href')) {
      // An outbound link must not be able to reach back through opener.
      child.setAttribute('rel', 'noopener noreferrer nofollow');
      child.setAttribute('target', '_blank');
    }
  }
}

/**
 * Render server-sanitised product HTML, sanitised again here.
 *
 * Returns null for empty content, so a caller can skip the whole section
 * rather than rendering an empty box with a heading over it.
 */
export function SafeHtml({
  html,
  className,
}: {
  html: string | null;
  className?: string;
}): React.JSX.Element | null {
  const clean = useMemo(() => {
    if (html === null || html.trim() === '') return null;

    // An inert document: nothing in here executes or fetches while we work.
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    scrub(parsed.body);

    const result = parsed.body.innerHTML.trim();
    return result === '' ? null : result;
  }, [html]);

  if (clean === null) return null;

  return (
    // Set only after the scrub above. The name is a warning, and it is
    // earned - this is the single place in the app that uses it.
    <div className={className} dangerouslySetInnerHTML={{ __html: clean }} />
  );
}
