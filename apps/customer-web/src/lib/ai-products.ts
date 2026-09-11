/**
 * The product references inside an assistant reply.
 *
 * The one thing the storefront takes from generated text about a product is
 * its **identifier**. Not its name, not its price, not its stock, and above
 * all not its image URL — those are read back from the catalogue API, which is
 * the only thing in this system that knows them. So a reply that mentions a
 * product code that does not exist produces no card at all rather than a
 * plausible-looking one, and there is no path by which a URL the model wrote
 * can end up in a `src` attribute.
 *
 * On a catalogue of cannulae and feeding tubes that is not a stylistic
 * preference. An invented product code is somebody ordering the wrong device.
 *
 * Two reference forms are recognised, and both are things the model is
 * already told to write:
 *
 *   - **The reference line**, `[[products: slug-one, slug-two]]`, which the
 *     system prompt asks for at the end of any answer about particular
 *     products. It carries the model's own ordering, which is its
 *     recommendation, and it is stripped from the visible text — nobody should
 *     read the machinery.
 *   - **Product paths** (`/product/some-slug`) written in the prose. The
 *     fallback, and it matters: it is how cards still appear under a reply
 *     from a model that skipped the line, and those paths are already links in
 *     the transcript, so a card is the same reference in a richer shape.
 *
 * A partially-streamed reference line is hidden too. Without that the reader
 * watches `[[products: easy-jet-dispo` type itself out one character at a
 * time under the answer, which looks like the assistant has broken.
 */

/** A complete reference line. Global: a reply may end up with more than one. */
const REFERENCE_LINE = /\[\[\s*products\s*:([^\]]*)\]\]/gi;

/**
 * A reference line that is still arriving.
 *
 * Deliberately not `\[\[.*$`. That would swallow any stray bracket pair the
 * model wrote in prose and never give it back, because nothing later completes
 * it. This matches only an opening bracket followed by a *prefix of*
 * `products`, optionally followed by the colon and whatever has arrived
 * since — so the tail is hidden while it can still turn into a reference line
 * and shown the moment it cannot.
 *
 * The second bracket is optional, which costs one thing and buys another: a
 * reply whose very last character is `[` loses that bracket permanently, and
 * in exchange nobody ever watches a reference line assemble itself one
 * character at a time. A trailing lone bracket at the end of a finished answer
 * carries no meaning; the flicker did.
 */
const PARTIAL_REFERENCE_LINE =
  /\[\[?\s*(?:p(?:r(?:o(?:d(?:u(?:c(?:t(?:s(?:\s*:[^\]]*\]?)?)?)?)?)?)?)?)?)?$/i;

/** Product paths, the same pattern the transcript linkifies. */
const PRODUCT_PATH = /\/product\/([a-z0-9][a-z0-9-]*)/gi;

/**
 * A plausible catalogue identifier.
 *
 * Slugs are lower-case and hyphenated; product codes in this catalogue are
 * upper-case and carry digits, dots and slashes. Anything else — a sentence
 * the model put inside the brackets, an empty entry from a trailing comma — is
 * dropped here rather than sent to the API as a query nobody meant.
 */
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;

/**
 * How many cards one reply may show.
 *
 * The prompt asks for at most six. This is the same number enforced on the
 * reading side, so a model that overshoots produces a bounded row rather than
 * a wall of cards under a two-sentence answer.
 */
export const MAX_AI_PRODUCTS = 6;

export interface AssistantReply {
  /** The reply as it should be read. Reference lines removed. */
  text: string;
  /** Catalogue identifiers, in the order the reply put them, de-duplicated. */
  refs: string[];
}

/**
 * Split a reply into what to read and what to look up.
 *
 * Pure, and called on every render of a streaming message — so it does no work
 * beyond two regular expressions over a string that is at most a few hundred
 * characters.
 */
export function readAssistantReply(content: string): AssistantReply {
  const refs: string[] = [];

  const collect = (list: string): void => {
    for (const entry of list.split(',')) {
      const ref = entry.trim();
      if (ref.length === 0 || !REFERENCE.test(ref)) continue;
      if (!refs.includes(ref)) refs.push(ref);
    }
  };

  let text = content.replace(REFERENCE_LINE, (_match, list: string) => {
    collect(list);
    return '';
  });

  // Hide the half-arrived line, but do not treat it as a reference: the slugs
  // in it are incomplete, and looking up `easy-jet-dispo` would resolve
  // nothing while making a request per keystroke.
  text = text.replace(PARTIAL_REFERENCE_LINE, '');

  // The fallback. Only consulted when the model wrote no reference line at
  // all — a reply that has one has already stated its ordering, and mixing the
  // two would re-order it by wherever a link happened to fall in a sentence.
  if (refs.length === 0) {
    for (const match of content.matchAll(PRODUCT_PATH)) {
      const slug = match[1];
      if (slug !== undefined && !refs.includes(slug)) refs.push(slug);
    }
  }

  return {
    /*
     * Trailing blank lines go, leading ones stay.
     *
     * The reference line sits at the end after a newline, so removing it
     * leaves the paragraph break behind — which renders as an empty bubble row
     * under every answer that mentions a product.
     */
    text: text.replace(/\s+$/, ''),
    refs: refs.slice(0, MAX_AI_PRODUCTS),
  };
}
