/**
 * The greeting's headline: a name that stays, and a word that changes.
 *
 * The hero reads "UBOSS Sourcing", then "UBOSS Intelligence", then "UBOSS
 * Optimism". The name comes from the operator's own settings and the changing
 * word comes from the phrase book, which leaves one question this module
 * exists to answer: what happens when the configured name already ends in one
 * of those words.
 *
 * The first deployment to run this is called "UBOSS Sourcing", and it read
 * "UBOSS Sourcing Sourcing". Trimming the word out of the name in the markup
 * would be this software editing its operator's name, which it does not get to
 * do. What it can do is notice that the name's last word and the headline's
 * first word are the same word, and say it once: the name hands its tail over,
 * the cycle picks it up, and the headline *opens* on precisely the name the
 * operator configured before it goes anywhere else.
 *
 * Three things fall out of that and all three are deliberate:
 *
 *   - **The cycle is rotated, not reordered.** It starts on the word the name
 *     gave up, then carries on through the rest in their usual order. A
 *     deployment called "Northgate Innovation" opens on "Northgate
 *     Innovation", not on a word its own name never mentioned.
 *   - **A name is matched against English as well as the current language.**
 *     A business name is not translated - it is a fact about who is selling,
 *     not a string - so "UBOSS Sourcing" stays "UBOSS Sourcing" on the German
 *     storefront, where the cycle says "Beschaffung". Matching both lists is
 *     what stops that deployment reading "UBOSS Sourcing Beschaffung".
 *   - **A one-word name keeps its word.** "Sourcing" on its own does not
 *     become a headline with no name in it.
 *
 * Nothing here is case-sensitive, and the operator's own spelling is what
 * survives: a shop called "UBOSS SOURCING" opens on "SOURCING", not on
 * "Sourcing".
 */

/**
 * The words the headline cycles through, in order.
 *
 * Their English forms live here beside their keys because this module has to
 * compare them against a business name, and a business name is written in
 * whatever language the business is called - usually English, whatever the
 * storefront is being read in.
 */
export const HEADLINE_WORDS = [
  { key: 'greeting.flip.sourcing', english: 'Sourcing' },
  { key: 'greeting.flip.intelligence', english: 'Intelligence' },
  { key: 'greeting.flip.optimism', english: 'Optimism' },
  { key: 'greeting.flip.innovation', english: 'Innovation' },
] as const;

export interface Headline {
  /** The part of the name that stays still. */
  name: string;
  /** What the word after it cycles through, starting on what it shows first. */
  words: string[];
}

/** Everything before the last space, and everything after it. */
function splitTail(value: string): { head: string; tail: string } | null {
  const trimmed = value.trim();
  const cut = trimmed.lastIndexOf(' ');

  // No space at all is a one-word name, which keeps its word.
  if (cut <= 0) return null;

  return { head: trimmed.slice(0, cut).trimEnd(), tail: trimmed.slice(cut + 1) };
}

/**
 * Split a configured business name into a still half and a cycling half.
 *
 * @param displayName The operator's own name for the shop, untouched.
 * @param translated  The cycling words in the language being read, in the same
 *                    order as `HEADLINE_WORDS`.
 */
export function splitHeadline(displayName: string, translated: string[]): Headline {
  const words = translated.length > 0 ? translated : HEADLINE_WORDS.map((word) => word.english);
  const parts = splitTail(displayName);

  if (parts === null) return { name: displayName.trim(), words };

  const tail = parts.tail.toLocaleLowerCase();
  const start = HEADLINE_WORDS.findIndex(
    (word, position) =>
      word.english.toLocaleLowerCase() === tail ||
      (words[position] ?? '').toLocaleLowerCase() === tail,
  );

  // The name ends in a word of its own. Nothing to hand over.
  if (start === -1) return { name: displayName.trim(), words };

  return {
    name: parts.head,
    // The operator's own spelling of the word it gave up, then the rest of the
    // cycle in its usual order.
    words: [parts.tail, ...words.slice(start + 1), ...words.slice(0, start)],
  };
}
