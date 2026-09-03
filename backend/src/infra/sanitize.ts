/**
 * HTML sanitisation.
 *
 * Product descriptions are authored by administrators and rendered on the
 * public storefront. An administrator is trusted more than a customer, but not
 * unconditionally: a compromised staff account, a pasted supplier description,
 * or a CSV import from an external feed are all ways hostile markup reaches
 * this field. Once stored, it renders for every visitor.
 *
 * So the rule is allowlist, not blocklist. Anything not named below is dropped.
 * A blocklist loses to the next encoding trick; an allowlist does not.
 *
 * Sanitisation happens on WRITE, not on read. Storing raw markup and cleaning
 * it at render time means every future reader has to remember - and one that
 * forgets is a stored XSS.
 */
import sanitizeHtml from 'sanitize-html';

/**
 * Tags a product description legitimately needs.
 *
 * Deliberately absent, and why:
 *   script, style      - executable
 *   iframe, object,
 *   embed, form, input - embed or exfiltrate
 *   svg                - XML that can carry script
 *   a                  - see below; links are allowed but heavily constrained
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'h4',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'blockquote',
  'code',
  'pre',
  'span',
  'a',
] as const;

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],

  allowedAttributes: {
    // No `style` anywhere: CSS can position an invisible overlay over a Buy
    // button, and url() has historically been an execution vector.
    a: ['href', 'title', 'target', 'rel'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
  },

  // http/https/mailto only. `javascript:` and `data:` are the two that matter:
  // the first executes, the second can carry a whole HTML document.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,

  // Every link opens in a new tab WITHOUT handing the opener window over.
  // Without noopener, the linked page can navigate the storefront tab to a
  // phishing clone - a real attack, not a theoretical one.
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      },
    }),
  },

  // Drop the content of anything executable rather than leaving its text
  // behind as stray characters on the page.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe'],

  disallowedTagsMode: 'discard',
  enforceHtmlBoundary: true,
};

/** Longest description we will store. Bounded so a paste cannot fill the disk. */
const MAX_HTML_BYTES = 100_000;

/**
 * Clean administrator-authored HTML for public rendering.
 *
 * Returns null for empty input, so an absent description stays absent rather
 * than becoming an empty string that renders as a blank block.
 */
export function sanitiseProductHtml(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const bounded = trimmed.slice(0, MAX_HTML_BYTES);
  const cleaned = sanitizeHtml(bounded, SANITIZE_OPTIONS).trim();

  // Input that was ENTIRELY markup - `<script>alert(1)</script>` - sanitises to
  // nothing. Storing an empty string would render a blank block; null does not.
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Strip every tag, leaving readable text.
 *
 * For fields that must never contain markup at all: short descriptions, meta
 * descriptions, notification variables. Entities are decoded so `&amp;` reads
 * as `&` rather than leaking escaping into the plain-text view.
 */
export function stripHtml(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;

  const cleaned = sanitizeHtml(input.slice(0, MAX_HTML_BYTES), {
    allowedTags: [],
    allowedAttributes: {},
    // Otherwise the text inside a <script> survives as visible content.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe'],
  })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Does this markup survive sanitisation unchanged?
 *
 * Lets the Admin Panel warn "some formatting will be removed" at edit time,
 * rather than an author discovering it after publishing.
 */
export function isCleanHtml(input: string): boolean {
  return sanitizeHtml(input, SANITIZE_OPTIONS).trim() === input.trim();
}
