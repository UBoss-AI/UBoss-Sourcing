/**
 * Reading "how many are in a box" out of a sentence somebody typed.
 *
 * The source column is free text and nobody standardised it. One workbook
 * contains all of these, meaning the same thing four ways:
 *
 *     100Pcs x 20Box=2000PCS
 *     100pcs×10box=1,000 pcs/Outer
 *     100pcs-inner/outer-100*20=2000 pcs
 *     inner -40 pcs/outer -160 pcs
 *     50 pcs one pouch/400 pcs
 *     400Pcs
 *
 * Two rules govern everything below.
 *
 * **Never invent a number.** "400Pcs" says a carton holds four hundred. It does
 * not say how they are boxed inside, and a plausible-looking inner count made
 * up here would be picked by a warehouse and shipped. A missing figure stays
 * missing, and the status says so.
 *
 * **Never silently correct one.** Where the source states all three numbers and
 * they do not multiply out, the row is marked NEEDS_REVIEW with every figure
 * kept as written. Quietly replacing the stated total with the product of the
 * other two is how a customer ends up disputing a quantity nobody can explain
 * - and the sheet is as likely to be right about the total as about the
 * factors.
 *
 * Deriving is not inventing, and the difference is exact division. Given 50 to
 * a pouch and 400 to a carton, "8 pouches" is arithmetic with one answer, and
 * it is recorded with a message saying where it came from. Given 50 and 410, it
 * is not, and nothing is derived.
 */

export type PackingParseStatus = 'PARSED' | 'PARTIAL' | 'NEEDS_REVIEW' | 'UNPARSED';

export interface ParsedPacking {
  /** The source text, untouched. Always present, whatever was understood. */
  raw: string;
  piecesPerInnerPack: number | null;
  innerPacksPerOuterCarton: number | null;
  piecesPerOuterCarton: number | null;
  /** What the source called the inner pack - "Box", "Pouch", "Packet". */
  innerPackType: string | null;
  outerPackType: string | null;
  status: PackingParseStatus;
  /** Why it is not PARSED, or how a figure was arrived at. Null when silent. */
  message: string | null;
}

/** A quantity above this is a typo or a misread separator, not a carton. */
const MAX_PLAUSIBLE_QUANTITY = 10_000_000;

/**
 * Words for the box the pieces sit in, mapped to how we say them back.
 *
 * The source's own word is kept rather than normalised to "inner pack",
 * because the screen has to match the paperwork a warehouse is reading from.
 */
const INNER_PACK_WORDS: [RegExp, string][] = [
  [/\bbox(?:es)?\b/, 'Box'],
  [/\bpouch(?:es)?\b/, 'Pouch'],
  [/\bpkts?\b|\bpackets?\b/, 'Packet'],
  [/\bbags?\b/, 'Bag'],
  [/\btrays?\b/, 'Tray'],
  [/\bblisters?\b/, 'Blister'],
  [/\bstrips?\b/, 'Strip'],
];

const OUTER_PACK_WORDS: [RegExp, string][] = [
  [/\bcartons?\b|\bctns?\b/, 'Carton'],
  [/\bouter\b/, 'Outer carton'],
  [/\bcases?\b/, 'Case'],
  [/\bmasters?\b/, 'Master carton'],
];

/**
 * Fold the many ways of writing the same expression into one.
 *
 * Both multiplication signs and the asterisk become "x"; thousands separators
 * inside numbers are dropped so "1,000" is one number rather than two; and
 * everything is lowercased. Hyphens become spaces because the source uses them
 * as punctuation ("inner -40 pcs") rather than as minus signs, and leaving them
 * attached turns 40 into -40.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[×✕✖]/g, 'x')
    .replace(/\*/g, 'x')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function plausible(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_PLAUSIBLE_QUANTITY;
}

function packWordIn(text: string, words: [RegExp, string][]): string | null {
  for (const [pattern, label] of words) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/** Format a count with thousands separators, for messages a person reads. */
function grouped(value: number): string {
  return value.toLocaleString('en-GB');
}

/**
 * English plural for the handful of pack nouns this module produces.
 *
 * Not a general pluraliser, and not trying to be: the words are "box", "pouch",
 * "packet", "bag", "tray", "blister", "strip" and "carton", all of which obey
 * the sibilant rule. Anything else falls through to a bare "s", which is right
 * far more often than it is wrong for a noun somebody typed into a pack column.
 */
function pluralise(word: string, count: number): string {
  if (count === 1) return word;
  return /(?:s|x|z|ch|sh)$/.test(word) ? `${word}es` : `${word}s`;
}

/**
 * `100 pcs x 20 box = 2000 pcs` and everything that means the same.
 *
 * The piece word after the first number is optional because the source often
 * omits it inside a compound form like "100x20=2000".
 */
const EXPLICIT_PRODUCT =
  /(\d+)\s*(?:pcs?|pieces?)?\s*x\s*(\d+)\s*([a-z]*)\s*=\s*(\d+)\s*(?:pcs?|pieces?)?/;

/** The same without a stated total: `100 pcs x 20 box`. */
const PRODUCT_WITHOUT_TOTAL = /(\d+)\s*(?:pcs?|pieces?)\s*x\s*(\d+)\s*([a-z]+)/;

/** Every "<number> pcs" in the string, in the order they appear. */
const PIECE_COUNTS = /(\d+)\s*(?:pcs?|pieces?)\b/g;

/** A string that is nothing but a count: `400Pcs`, `80 PCS`. */
const BARE_TOTAL = /^(\d+)\s*(?:pcs?|pieces?)$/;

export function parsePacking(rawInput: string | null | undefined): ParsedPacking {
  const raw = (rawInput ?? '').trim();

  const empty: ParsedPacking = {
    raw,
    piecesPerInnerPack: null,
    innerPacksPerOuterCarton: null,
    piecesPerOuterCarton: null,
    innerPackType: null,
    outerPackType: null,
    status: 'UNPARSED',
    message: null,
  };

  if (raw === '') return { ...empty, message: 'The source gives no packing quantity.' };

  const text = normalise(raw);
  const innerWord = packWordIn(text, INNER_PACK_WORDS);
  const outerWord = packWordIn(text, OUTER_PACK_WORDS);

  // --- 1. All three numbers stated ------------------------------------------
  const explicit = EXPLICIT_PRODUCT.exec(text);
  if (explicit !== null) {
    const inner = Number.parseInt(explicit[1] ?? '', 10);
    const packs = Number.parseInt(explicit[2] ?? '', 10);
    const stated = Number.parseInt(explicit[4] ?? '', 10);
    // The word sitting between the multiplier and the "=" names the inner pack
    // in this form: "20box" makes it a box. It beats a word found anywhere else
    // in the string, which may belong to the outer carton.
    const wordBetween = packWordIn(explicit[3] ?? '', INNER_PACK_WORDS);

    if (plausible(inner) && plausible(packs) && plausible(stated)) {
      const product = inner * packs;
      const agrees = product === stated;

      return {
        raw,
        piecesPerInnerPack: inner,
        innerPacksPerOuterCarton: packs,
        piecesPerOuterCarton: stated,
        innerPackType: wordBetween ?? innerWord,
        outerPackType: outerWord,
        status: agrees ? 'PARSED' : 'NEEDS_REVIEW',
        message: agrees
          ? null
          : `The source multiplies out to ${grouped(product)} pieces per carton ` +
            `(${grouped(inner)} x ${grouped(packs)}) but states ${grouped(stated)}. ` +
            'Both figures are kept as written; confirm which is right before selling by the carton.',
      };
    }
  }

  // --- 2. Factors stated, no total ------------------------------------------
  const withoutTotal = PRODUCT_WITHOUT_TOTAL.exec(text);
  if (withoutTotal !== null) {
    const inner = Number.parseInt(withoutTotal[1] ?? '', 10);
    const packs = Number.parseInt(withoutTotal[2] ?? '', 10);

    if (plausible(inner) && plausible(packs) && plausible(inner * packs)) {
      return {
        raw,
        piecesPerInnerPack: inner,
        innerPacksPerOuterCarton: packs,
        piecesPerOuterCarton: inner * packs,
        innerPackType: packWordIn(withoutTotal[3] ?? '', INNER_PACK_WORDS) ?? innerWord,
        outerPackType: outerWord,
        status: 'PARSED',
        message:
          `Pieces per carton calculated from the two figures given ` +
          `(${grouped(inner)} x ${grouped(packs)}); the source states no total.`,
      };
    }
  }

  // --- 3. An inner count and a total, in that order -------------------------
  //
  // "inner -40 pcs/outer -160 pcs", "50 pcs one pouch/400 pcs", "200 pcs-one
  // pouch-total-1600 pcs". Two piece counts and nothing multiplying them: the
  // smaller-first pair is an inner pack and the carton it goes into.
  const counts = [...text.matchAll(PIECE_COUNTS)]
    .map((match) => Number.parseInt(match[1] ?? '', 10))
    .filter(plausible);

  const [first, second] = counts;

  if (counts.length === 2 && first !== undefined && second !== undefined) {
    const inner = first;
    const outer = second;

    if (inner < outer) {
      const divides = outer % inner === 0;
      const packs = divides ? outer / inner : null;

      return {
        raw,
        piecesPerInnerPack: inner,
        innerPacksPerOuterCarton: packs,
        piecesPerOuterCarton: outer,
        innerPackType: innerWord,
        outerPackType: outerWord,
        status: divides ? 'PARSED' : 'PARTIAL',
        message: divides
          ? `${grouped(outer / inner)} inner packs per carton calculated from the two figures given ` +
            `(${grouped(outer)} ÷ ${grouped(inner)}); the source states the count but not the number of packs.`
          : `The source gives ${grouped(inner)} pieces per pack and ${grouped(outer)} per carton, ` +
            'which do not divide evenly. The number of packs per carton is left blank rather than rounded.',
      };
    }

    if (inner === outer) {
      // One figure, written twice. Nothing is known about the breakdown.
      return {
        raw,
        piecesPerInnerPack: null,
        innerPacksPerOuterCarton: null,
        piecesPerOuterCarton: outer,
        innerPackType: null,
        outerPackType: outerWord,
        status: 'PARTIAL',
        message: 'The source gives a total only; how it is boxed inside is not stated.',
      };
    }
  }

  // --- 4. A bare total ------------------------------------------------------
  const bare = BARE_TOTAL.exec(text);
  if (bare !== null) {
    const total = Number.parseInt(bare[1] ?? '', 10);
    if (plausible(total)) {
      return {
        raw,
        piecesPerInnerPack: null,
        innerPacksPerOuterCarton: null,
        piecesPerOuterCarton: total,
        innerPackType: null,
        outerPackType: outerWord,
        status: 'PARTIAL',
        message: 'The source gives a total only; how it is boxed inside is not stated.',
      };
    }
  }

  if (counts.length === 1 && first !== undefined) {
    return {
      raw,
      piecesPerInnerPack: null,
      innerPacksPerOuterCarton: null,
      piecesPerOuterCarton: first,
      innerPackType: null,
      outerPackType: outerWord,
      status: 'PARTIAL',
      message: 'The source gives a total only; how it is boxed inside is not stated.',
    };
  }

  return {
    ...empty,
    innerPackType: innerWord,
    outerPackType: outerWord,
    message: 'No packing quantity could be read from this text. It is kept exactly as written.',
  };
}

/**
 * "100 pieces × 20 boxes = 2,000 pieces", or null when there is nothing to say.
 *
 * Built here rather than in each screen so the storefront, the admin panel and
 * the import report all phrase the same fact identically. A reader comparing
 * two of them should not have to work out whether two different sentences mean
 * the same thing.
 */
export function packingFormula(packing: {
  piecesPerInnerPack: number | null;
  innerPacksPerOuterCarton: number | null;
  piecesPerOuterCarton: number | null;
  innerPackType: string | null;
}): string | null {
  const { piecesPerInnerPack, innerPacksPerOuterCarton, piecesPerOuterCarton } = packing;

  if (piecesPerInnerPack === null || innerPacksPerOuterCarton === null) {
    return piecesPerOuterCarton === null ? null : `${grouped(piecesPerOuterCarton)} pieces per carton`;
  }

  const packLabel = pluralise((packing.innerPackType ?? 'pack').toLowerCase(), innerPacksPerOuterCarton);
  const total = piecesPerOuterCarton ?? piecesPerInnerPack * innerPacksPerOuterCarton;

  return (
    `${grouped(piecesPerInnerPack)} pieces × ${grouped(innerPacksPerOuterCarton)} ${packLabel} = ` +
    `${grouped(total)} pieces`
  );
}
