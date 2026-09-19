/**
 * Deterministic variation.
 *
 * Every number the demonstration catalogue does not have written down - a
 * price inside its band, a stock level, which variants are out of stock, how
 * much a list price sits above a selling price - is derived here from a STRING
 * rather than drawn from `Math.random`.
 *
 * That is the whole reason this file exists. A seed whose figures move on
 * every run is a seed nobody can review: the second run shows four hundred
 * changed prices and there is no way to tell which of them changed because the
 * blueprint changed. Derived from the key, a re-run that edits one blueprint
 * changes one product's figures and leaves the other four hundred and thirteen
 * byte-identical, which makes the diff worth reading.
 *
 * It is not cryptography and must never be used as if it were. FNV-1a and a
 * 32-bit xorshift are here because they are short, have no dependencies and
 * give the same answer on every machine and every Node version - which is
 * exactly what `node:crypto` also gives, at the cost of a hash per figure when
 * there are several thousand of them.
 */

/** FNV-1a, 32-bit. Stable across platforms; not a security primitive. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // The FNV prime, 16777619, by shift-and-add: a plain `*` overflows into a
    // double past 2^53 and the low bits - the only ones that matter here -
    // stop being reproducible.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A stream of numbers in [0, 1), fixed by the string it was started from.
 *
 * Draw order matters: asking for a price before a stock figure and asking for
 * them the other way round give different answers. That is fine, and it is why
 * `generate.ts` draws each kind of figure from its own stream with its own
 * suffix - `${key}:price`, `${key}:stock` - so adding a new derived figure
 * cannot shift the ones that already exist.
 */
export class Rng {
  private state: number;

  constructor(seed: string) {
    // Zero is the one state xorshift cannot leave, so a string that happens to
    // hash to it would return 0 for ever.
    this.state = hashString(seed) || 0x9e3779b9;
  }

  /** The next value in [0, 1). */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x / 0x1_0000_0000;
  }

  /** An integer in [low, high], both ends included. */
  int(low: number, high: number): number {
    if (high <= low) return low;
    return low + Math.floor(this.next() * (high - low + 1));
  }

  /** A value in [low, high], as a fraction. */
  float(low: number, high: number): number {
    return low + this.next() * (high - low);
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** One of these, or undefined when there are none. */
  pick<T>(values: readonly T[]): T | undefined {
    if (values.length === 0) return undefined;
    return values[this.int(0, values.length - 1)];
  }
}

/**
 * A figure in a band, rounded to something a price list would actually print.
 *
 * Money only. `position` is where in the band this variant sits - 0 for the
 * cheapest combination of options, 1 for the dearest - so the selector moves
 * the price in the direction a buyer expects rather than scattering it.
 *
 * The rounding step grows with the amount, because trade prices do: a ₹42
 * fitting is priced to the rupee, a ₹4,200 tool to the ten, and a ₹420,000
 * machine to the thousand. A generator that rounds everything to the paisa
 * produces a catalogue of numbers no supplier has ever quoted.
 */
export function bandedPrice(
  low: number,
  high: number,
  position: number,
  jitter: number,
): number {
  const clamped = Math.min(1, Math.max(0, position));
  const span = high - low;
  // The jitter is a fraction of the band rather than of the price, so a narrow
  // band stays narrow instead of being widened by its own variation.
  const raw = low + span * clamped + span * 0.06 * (jitter - 0.5);
  const bounded = Math.min(high, Math.max(low, raw));

  const step =
    bounded >= 50_000_00 ? 100_00 : bounded >= 5_000_00 ? 10_00 : bounded >= 500_00 ? 1_00 : 25;

  const rounded = Math.round(bounded / step) * step;
  // Never below one minor unit: a free product is a publication blocker, not a
  // bargain.
  return Math.max(step, rounded);
}
