/**
 * Which photograph is of which product.
 *
 * This file makes a claim about a medical device — "this picture shows this
 * thing" — so it is a table somebody can read and a test can check, not a
 * similarity score. Two rules govern it.
 *
 * **Only the operator's own photographs.** Every image here is SPM's own
 * product shot out of `Images/`, resized by `scripts/prepare-product-images.mjs`.
 * Nothing is fetched from the internet. A stock photograph of somebody else's
 * surgical glove attached to this catalogue's glove is a fabricated product
 * record, and on a medical device it is a worse outcome than the neutral
 * placeholder the grid already draws.
 *
 * **No picture is better than a near one.** A department with no matching
 * photograph gets none, and the importer reports it. A general disposable
 * syringe standing in for an insulin syringe would be wrong in exactly the way
 * nobody notices: right shape, right colour, wrong graduations, and the
 * graduations are the entire product.
 *
 * ORDER IS THE RULE. The first match wins, so narrow department names come
 * before the ones that contain them — "Closed IV Cannula" before "IV Cannula",
 * "Sterile Water With 10% Glycerine" before "Sterile Water", "DC Flush
 * Syringe" is caught by the same rule as "Flush Syringe" on purpose.
 */

export interface ProductImageRule {
  /** File under `backend/assets/product-images`. */
  file: string;
  /**
   * What the photograph shows, for a reader who cannot see it.
   *
   * Describes the picture rather than repeating the product name — the name is
   * already the heading beside it, and a screen reader saying it twice is the
   * commonest alt-text mistake there is.
   */
  altText: string;
  /** The department, matched on its name. */
  category: RegExp;
  /**
   * Narrower still: only products whose generic name matches.
   *
   * Used where one department holds two genuinely different things, which is
   * the case for Insulin Syringe — it also carries plain hypodermic and
   * auto-disable syringes, and only those are what the photograph shows.
   */
  genericName?: RegExp;
  /** Narrower again, on the brand. */
  brand?: RegExp;
}

export const PRODUCT_IMAGE_RULES: readonly ProductImageRule[] = [
  // --- Intravenous access -------------------------------------------------
  {
    file: 'closed-iv-cannula.jpg',
    altText:
      'A closed-system intravenous cannula: a winged blue hub with an integrated valve, a short extension line and a needle-free connector.',
    category: /\bclosed\b.*\bcannulae?s?\b/,
  },
  {
    // Only where the brand says so. "EASY VEIN WIN" is left to the plain
    // photograph: the name suggests wings and does not state them, and a guess
    // is exactly what this table exists to avoid.
    file: 'iv-cannula-safety-winged.jpg',
    altText:
      'Winged intravenous cannulae with injection ports and needle-stick safety guards, in seven colour-coded gauges from 14G to 26G.',
    category: /\bcannulae?s?\b/,
    brand: /\bsafy\b|\bsafety\b/,
  },
  {
    file: 'iv-cannula.jpg',
    altText:
      'Four intravenous cannulae side by side in colour-coded gauges, 18G to 24G, each with its protective needle cap.',
    category: /\bcannulae?s?\b/,
  },
  {
    file: 'infusion-set.jpg',
    altText:
      'An intravenous infusion set: a bag spike, a drip chamber, a roller clamp on clear tubing and a luer connector.',
    category: /\binfusions?\b|\badministration\s*sets?\b/,
  },
  {
    file: 'safety-needle.jpg',
    altText:
      'Hypodermic safety needles with their hinged guards folded back over the shaft, green hubs uppermost.',
    category: /\bsafety\b.*\bneedles?\b|\bneedles?\b.*\bsafety\b/,
  },

  // --- Prefilled syringes. Four fills, four photographs. ------------------
  {
    file: 'heparin-flush-syringe.jpg',
    altText:
      'Prefilled heparin flush syringes in 3 ml, 5 ml and 10 ml, colour-coded blue, yellow and pink for 10, 100 and 1000 IU per ml.',
    category: /\bheparin\b/,
  },
  {
    file: 'citrate-flush-syringe.jpg',
    altText:
      'Prefilled sodium citrate flush syringes with green caps, in 3 ml, 5 ml and 10 ml.',
    category: /\bcitrate\b/,
  },
  {
    file: 'glycerine-syringe.jpg',
    altText:
      'A 10 ml prefilled syringe of 10% glycerine solution with an orange screw cap.',
    category: /\bglycerine?\b|\bglycerol\b/,
  },
  {
    file: 'sterile-water-syringe.jpg',
    altText:
      'A 10 ml prefilled syringe of sterile water with a purple screw cap, for inflating a Foley balloon catheter.',
    category: /\bsterile\s*water\b/,
  },
  {
    // Covers the plain flush department and the swab-cap one: both are the
    // same saline flush syringe, and the cap is an accessory to it.
    file: 'flush-syringe.jpg',
    altText:
      'Prefilled 0.9% sodium chloride flush syringes in five sizes, from 3 ml to 50 ml.',
    category: /\bflush\b|\bswab\s*caps?\b/,
  },

  // --- Blood gas ----------------------------------------------------------
  {
    file: 'abg-sampling-kit.jpg',
    altText:
      'The Easy Blood-Collect in-line arterial blood sampling set in its retail carton, with the luer cap shown beside it.',
    category: /\babg\b.*\bkits?\b|\bsampling\s*kits?\b/,
  },
  {
    file: 'abg-syringe.jpg',
    altText:
      'Arterial blood gas syringes with dark green caps, in 1 ml and 3 ml, pre-loaded with calcium-balanced lithium heparin.',
    category: /\babg\b|\bblood\s*gas\b/,
  },

  // --- Plain syringes -----------------------------------------------------
  {
    // The Insulin Syringe department also holds plain hypodermic and
    // auto-disable syringes, and this photograph is of those. A true insulin
    // syringe has its own graduations and fixed needle and is NOT pictured
    // here — it gets no image until somebody photographs one.
    file: 'hypodermic-syringe.jpg',
    altText:
      'Disposable syringes without needles, in seven sizes from 1 ml to 50 ml, showing their graduations.',
    category: /\bsyringes?\b/,
    genericName: /\bhypodermic\b|\bauto\s*disable\b|\bad\s*syringe/,
  },
];

export interface ProductForImageMatch {
  categoryName: string;
  /** From the import record where there is one, else the product's own name. */
  genericName: string;
  brand: string;
}

/** Punctuation out, single spaces, lower case — see `category-mark.ts`. */
function normalise(value: string): string {
  return value
    .toLocaleLowerCase('en-GB')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The photograph for one product, or null where the catalogue has none of it.
 *
 * Null is a real answer and the commonest one for nine of the twenty-two
 * departments. The caller leaves those alone.
 */
export function imageRuleFor(product: ProductForImageMatch): ProductImageRule | null {
  const category = normalise(product.categoryName);
  const generic = normalise(product.genericName);
  const brand = normalise(product.brand);

  for (const rule of PRODUCT_IMAGE_RULES) {
    if (!rule.category.test(category)) continue;
    if (rule.genericName !== undefined && !rule.genericName.test(generic)) continue;
    if (rule.brand !== undefined && !rule.brand.test(brand)) continue;
    return rule;
  }

  return null;
}
