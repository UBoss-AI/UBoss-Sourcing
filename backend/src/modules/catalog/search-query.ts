/** Public search interpretation. No provider, private data or inferred buying terms. */
export interface SearchInterpretation {
  original: string;
  terms: string[];
  groups: string[][];
}

const LEADING_REQUEST = /^(?:(?:please\s+)?(?:find|show|search\s+for|looking\s+for|i\s+need|i\s+am\s+looking\s+for|i'm\s+looking\s+for))\s+(?:(?:me|us)\s+)?/iu;
const LEADING_SCOPE = /^(?:products?|categories|suppliers?|manufacturers?)\s+(?:for|of|who\s+(?:make|sell)|that\s+(?:make|sell))\s+/iu;

export function normalizeSearch(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en');
}

/** Only explicit request prefixes are removed; materials, numbers and specs survive. */
export function interpretSearch(value: string, synonyms: readonly { term: string; synonymsJson: unknown }[] = []): SearchInterpretation {
  const original = normalizeSearch(value);
  const meaningful = original.replace(LEADING_REQUEST, '').replace(LEADING_SCOPE, '').trim();
  // A request with no object remains searchable as written instead of matching everything.
  const terms = [...new Set((meaningful || original).split(' ').filter(Boolean))];
  const groups = terms.map(term => [term]);
  for (const synonym of synonyms) {
    const term = normalizeSearch(synonym.term);
    if (!Array.isArray(synonym.synonymsJson)) continue;
    const aliases = synonym.synonymsJson.filter((x): x is string => typeof x === 'string')
      .map(normalizeSearch).filter(x => x.length > 0 && x.length <= 120).slice(0, 12);
    // A phrase synonym replaces its entire phrase, rather than requiring all of its
    // original words alongside the alias ("IV catheter" must also find "cannula").
    if (term === meaningful || term === original) return { original, terms, groups: [[term, ...new Set(aliases)]] };
    const index = terms.indexOf(term);
    if (index >= 0) groups[index] = [...new Set([term, ...aliases])];
  }
  return { original, terms, groups };
}

/** A conservative one-edit spelling suggestion, never an automatic rewrite. */
export function oneEditApart(left: string, right: string): boolean {
  const a = [...normalizeSearch(left)], b = [...normalizeSearch(right)];
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  if (a.join('') === b.join('')) return false;
  if (a.length === b.length) {
    const differing = a.map((char, i) => char === b[i] ? -1 : i).filter(i => i >= 0);
    if (differing.length === 1) return true;
    if (differing.length !== 2) return false;
    const first = differing[0], second = differing[1];
    if (first === undefined || second === undefined) return false;
    return second === first + 1 && a[first] === b[second] && a[second] === b[first];
  }
  const shorter = a.length < b.length ? a : b, longer = a.length < b.length ? b : a;
  let i = 0, j = 0, skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) { i++; j++; }
    else { if (skipped) return false; skipped = true; j++; }
  }
  return true;
}

/** SQL LIKE fragments retain literal %, _ and backslash from the buyer's words. */
export function literalLike(value: string): string {
  return value.replace(/[\\%_]/gu, char => '\\' + char);
}
