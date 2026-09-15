/**
 * One company, however many accounts it holds here.
 *
 * The problem this file exists to solve is an operator's, not a shopper's. A
 * single business can reach this marketplace through three doors at once: it
 * buys (a customer account), it sells (a seller organisation), and it carries
 * (a logistics partner). Each door has its own table, its own screen and its
 * own idea of what the business is called, so an administrator looking at a
 * list of accounts cannot tell which of them are the same company — and the
 * question they are actually asking is "who is this, and what else do they do
 * here?".
 *
 * So the directory groups by COMPANY first and by account second. The grouping
 * key is the company's name, normalised, because that is the only thing the
 * three tables genuinely share: there is no company table, deliberately —
 * inventing one would mean every existing seller, buyer and carrier had to be
 * reconciled into it before anybody could sign in.
 *
 * WHY NAME AND NOT SOMETHING STRONGER
 *
 * A registration number would be a better key and is not available: a buyer
 * types their employer's name into a free-text field, and no shopper is asked
 * for a company register entry before they are allowed to buy a box of gloves.
 * Matching on the normalised name is therefore a HINT, and the interface says
 * so — every account inside a company node keeps its own legal name, country
 * and status on screen, so an operator can see at a glance when two unrelated
 * businesses have collided under one name and treat them as the two accounts
 * they are.
 *
 * What the normalisation must NOT do is over-merge. Case, punctuation and the
 * common legal suffixes are removed; nothing else is. "Northwind Medical" and
 * "Northwind Medical Supplies" stay two companies, because they might be.
 */

/** Which door into the marketplace one account is. */
export type DirectoryAccountKind = 'SELLER' | 'BUYER' | 'LOGISTICS';

/**
 * Legal-form suffixes stripped before comparing two names.
 *
 * Present because "Northwind Medical Ltd" on a seller application and
 * "Northwind Medical" typed by that company's buyer into their profile are the
 * same company, and an operator who has to spot that themselves will not.
 *
 * Multi-market on purpose — this product is sold to companies trading across
 * Europe and India, and a list containing only "ltd" would merge English
 * companies and leave every German and Polish one split.
 */
const LEGAL_SUFFIXES: readonly string[] = Object.freeze([
  'ltd',
  'limited',
  'llp',
  'llc',
  'inc',
  'incorporated',
  'plc',
  'pvt',
  'private',
  'co',
  'company',
  'corp',
  'corporation',
  'gmbh',
  'mbh',
  'ag',
  'kg',
  'ohg',
  'ug',
  'bv',
  'nv',
  'sa',
  'sas',
  'sarl',
  'srl',
  'spa',
  'sl',
  'sp',
  'zoo',
  'sro',
  'oy',
  'ab',
  'as',
  'aps',
  'ae',
  'epe',
  'ike',
]);

/**
 * The key two names are compared on.
 *
 * Lowercased, accents folded, punctuation dropped, whitespace collapsed, and
 * trailing legal suffixes removed. Returns an empty string for a name that is
 * nothing but punctuation, which the caller must treat as "no company name"
 * rather than as a company called "".
 */
export function normaliseCompanyName(raw: string): string {
  const folded = raw
    .normalize('NFKD')
    // Combining marks: "Médica" and "Medica" are one company.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Ampersand written out, because "Smith & Sons" and "Smith and Sons" are
    // the same company typed by two different people.
    .replace(/&/g, ' and ')
    /*
     * Full stops are removed rather than turned into spaces, and the order
     * matters: an abbreviated legal form is written "B.V.", "S.r.l.", "Pvt.
     * Ltd." as often as not, and splitting on the dots turns "bv" into two
     * one-letter words that match nothing in the suffix list below.
     */
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (folded.length === 0) return '';

  const words = folded.split(' ');

  // Only trailing suffixes, and never the last remaining word: a company
  // genuinely called "Co" must not normalise to nothing.
  while (words.length > 1) {
    const last = words[words.length - 1] ?? '';
    if (!LEGAL_SUFFIXES.includes(last)) break;
    words.pop();
  }

  return words.join(' ');
}

/** One account, as the index knows it before anything is hydrated. */
export interface DirectoryIndexEntry {
  kind: DirectoryAccountKind;
  /** The row's own id. For a buyer group it is the raw organisation name. */
  id: string;
  /** What to call the company when this entry is the one that names the node. */
  name: string;
  /** ISO-3166-1 alpha-2, where the source knows one. */
  country: string | null;
  /**
   * A second name this entry should also match on — a seller's legal name
   * beside its trading name. Matching on both is what connects "Northwind
   * Medical" the shop front to "Northwind Medical Supplies Ltd" the employer a
   * buyer typed in.
   */
  alsoKnownAs?: string | null;
}

/** One company and the accounts found under its name. */
export interface DirectoryCompanyNode {
  /** Stable across pages and safe in a URL. Derived from the normalised name. */
  key: string;
  name: string;
  country: string | null;
  kinds: DirectoryAccountKind[];
  entries: DirectoryIndexEntry[];
}

/**
 * Which node an entry belongs to, preferring the strongest name.
 *
 * A seller names the node when there is one, then a carrier, then the buyers'
 * own spelling — not because buyers are less important, but because a seller
 * account's `displayName` has been through an availability check and an
 * operator's review, and an organisation field has been through neither.
 */
const NAMING_PRECEDENCE: Readonly<Record<DirectoryAccountKind, number>> = Object.freeze({
  SELLER: 3,
  LOGISTICS: 2,
  BUYER: 1,
});

/**
 * Group index entries into companies.
 *
 * Pure, so the grouping rule can be tested without a database — and it is the
 * rule most likely to be argued with, because it is the one deciding that two
 * rows an operator sees are one business.
 *
 * Entries whose normalised name is empty are returned as their own single-entry
 * node rather than merged: an account with no usable company name is not the
 * same company as every other account with no usable company name.
 */
export function groupIntoCompanies(entries: readonly DirectoryIndexEntry[]): DirectoryCompanyNode[] {
  const byKey = new Map<string, DirectoryCompanyNode>();

  // An alias index, so a buyer organisation matching a seller's LEGAL name
  // lands on the seller's node even though the node is keyed on its trading
  // name. Built in a first pass over the strongest entries only: letting a
  // buyer's free-text organisation claim an alias would let one mistyped
  // profile pull unrelated accounts together.
  const aliasToKey = new Map<string, string>();

  const ordered = [...entries].sort(
    (a, b) => NAMING_PRECEDENCE[b.kind] - NAMING_PRECEDENCE[a.kind],
  );

  for (const entry of ordered) {
    const normalised = normaliseCompanyName(entry.name);
    const alias =
      entry.alsoKnownAs === undefined || entry.alsoKnownAs === null
        ? ''
        : normaliseCompanyName(entry.alsoKnownAs);

    const key =
      normalised.length === 0
        ? `${entry.kind.toLowerCase()}:${entry.id}`
        : (aliasToKey.get(normalised) ?? `company:${normalised}`);

    const existing = byKey.get(key);

    if (existing === undefined) {
      byKey.set(key, {
        key,
        name: entry.name,
        country: entry.country,
        kinds: [entry.kind],
        entries: [entry],
      });
    } else {
      existing.entries.push(entry);
      if (!existing.kinds.includes(entry.kind)) existing.kinds.push(entry.kind);
      // The first entry named the node — it had the higher precedence. The
      // country only fills a gap, it never overwrites.
      existing.country ??= entry.country;
    }

    if (normalised.length > 0) {
      if (!aliasToKey.has(normalised)) aliasToKey.set(normalised, key);
      if (alias.length > 0 && entry.kind !== 'BUYER' && !aliasToKey.has(alias)) {
        aliasToKey.set(alias, key);
      }
    }
  }

  // Kinds in a fixed order, so a node's badges do not reshuffle between pages
  // depending on which account happened to be read first.
  const kindOrder: DirectoryAccountKind[] = ['SELLER', 'BUYER', 'LOGISTICS'];

  return [...byKey.values()]
    .map((node) => ({
      ...node,
      kinds: kindOrder.filter((kind) => node.kinds.includes(kind)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
