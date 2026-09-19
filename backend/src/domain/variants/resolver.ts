/**
 * Variant resolution: which choices are still possible, given what has been
 * chosen so far.
 *
 * The rule the whole file exists to enforce: **availability is read off the
 * variants that actually exist, never assumed from the axes.** Four sizes and
 * two colours is eight boxes on a screen and, very often, five SKUs in a
 * warehouse. A selector that offers all eight and fails at Add to Cart has
 * wasted the buyer's time and made the catalogue look like it is guessing.
 *
 * Three states, and they are three different sentences to a buyer:
 *
 *   - **Available.** There is a variant with this value, compatible with
 *     everything else chosen, and it has stock.
 *   - **Out of stock.** That variant exists, it is a real product, it is
 *     simply not here right now. Come back, or ask.
 *   - **Not offered.** No such thing is sold. Size 8 in black when black only
 *     runs 6-7. Nothing to wait for.
 *
 * Collapsing the last two into one greyed-out button is the single most
 * common way a variant selector lies. They are drawn differently and read
 * differently by a screen reader - see the selector component.
 *
 * Pure, and deliberately so. It takes the variant list it is given and returns
 * a verdict; it never fetches, and it never decides that something is
 * available because it could not find out.
 */
import { normaliseAxisKey, normaliseValue, sortAxisValues, type VariantAxis } from './axis.js';

/** One sellable SKU, as the resolver needs to see it. */
export interface ResolvableVariant {
  readonly id: string;
  readonly sku: string;
  /** Axis key to the value the seller typed. Keys are normalised on the way in. */
  readonly options: Readonly<Record<string, string>>;
  readonly isActive: boolean;
  /**
   * On-hand less reserved, or null when this deployment does not publish
   * quantities.
   *
   * Null is NOT zero and must never be treated as zero: the storefront
   * deliberately does not publish stock levels, and a selector that greyed out
   * every option on a shop that hides its numbers would be unusable. Null
   * means "purchasable, and the true figure is confirmed when it goes in the
   * basket", which is exactly what the cart does.
   */
  readonly availableQty: number | null;
  /** Minor units. Null inherits the product family's price. */
  readonly priceMinor: bigint | null;
}

export type ValueState = 'AVAILABLE' | 'OUT_OF_STOCK' | 'NOT_OFFERED';

export interface ResolvedValue {
  /** Exactly as the seller typed it, for display. */
  readonly label: string;
  /** The folded form, which is what a selection is compared against. */
  readonly value: string;
  readonly state: ValueState;
}

export interface ResolvedAxis {
  readonly key: string;
  readonly label: string;
  readonly values: readonly ResolvedValue[];
  /** The chosen value's label, or null. */
  readonly selected: string | null;
  /** True when an earlier axis this one depends on has not been answered. */
  readonly isBlocked: boolean;
}

export interface Resolution {
  readonly axes: readonly ResolvedAxis[];
  /** The one variant the selection identifies, or null. */
  readonly variantId: string | null;
  /** Every axis has a value AND those values name exactly one live variant. */
  readonly isComplete: boolean;
  /** Axes still to answer, in template order. The first is where focus goes. */
  readonly missingAxisKeys: readonly string[];
  /** Cheapest and dearest of the variants still reachable. Null when unpriced. */
  readonly priceRange: { readonly minMinor: bigint; readonly maxMinor: bigint } | null;
  /** How many variants still match. 1 with a complete selection. */
  readonly matchCount: number;
}

/** What the buyer has chosen so far: axis key to the label they picked. */
export type Selection = Readonly<Record<string, string>>;

function optionOf(variant: ResolvableVariant, axisKey: string): string | null {
  const wanted = normaliseAxisKey(axisKey);
  for (const [key, value] of Object.entries(variant.options)) {
    if (normaliseAxisKey(key) === wanted) return value;
  }
  return null;
}

/** Whether a variant satisfies every selected axis except the one named. */
function matchesExcept(
  variant: ResolvableVariant,
  selection: Selection,
  exceptAxisKey: string | null,
): boolean {
  const except = exceptAxisKey === null ? null : normaliseAxisKey(exceptAxisKey);

  for (const [axisKey, chosen] of Object.entries(selection)) {
    if (normaliseAxisKey(axisKey) === except) continue;
    const held = optionOf(variant, axisKey);
    if (held === null) return false;
    if (normaliseValue(held) !== normaliseValue(chosen)) return false;
  }
  return true;
}

/**
 * Null means "not published", and that is purchasable.
 *
 * See `availableQty` above. The only thing that makes a value OUT_OF_STOCK is
 * a published figure of zero or less.
 */
function hasStock(variant: ResolvableVariant): boolean {
  return variant.availableQty === null || variant.availableQty > 0;
}

/**
 * Resolve a selection against the real variant list.
 *
 * `axes` is the product family's ACTIVE axes in template order, not the whole
 * template: a seller who stocks one colour has no colour axis and the buyer is
 * asked nothing about it.
 */
export function resolveVariants(
  axes: readonly VariantAxis[],
  variants: readonly ResolvableVariant[],
  selection: Selection,
  fallbackPriceMinor: bigint | null = null,
): Resolution {
  const live = variants.filter((variant) => variant.isActive);

  const answered = new Set(
    Object.entries(selection)
      .filter(([, value]) => value !== '')
      .map(([key]) => normaliseAxisKey(key)),
  );

  const resolvedAxes: ResolvedAxis[] = axes.map((axisEntry) => {
    // An axis whose prerequisites are unanswered offers nothing yet. Showing
    // a numeric size run before the size system is picked offers a
    // measurement with no unit.
    const isBlocked = (axisEntry.dependsOn ?? []).some(
      (dependency) => !answered.has(normaliseAxisKey(dependency)),
    );

    // Every value any live variant carries on this axis, deduplicated by its
    // folded form but displayed with the first spelling the seller used.
    const labels = new Map<string, string>();
    for (const variant of live) {
      const held = optionOf(variant, axisEntry.key);
      if (held === null || held === '') continue;
      const folded = normaliseValue(held);
      if (!labels.has(folded)) labels.set(folded, held);
    }

    const ordered = sortAxisValues([...labels.values()], axisEntry.sort);

    const values: ResolvedValue[] = ordered.map((label) => {
      const folded = normaliseValue(label);

      // Compatible with everything chosen on the OTHER axes. Ignoring this
      // axis's own current choice is what lets a buyer change their mind about
      // colour without the size they already picked disabling every colour.
      const compatible = live.filter(
        (variant) =>
          normaliseValue(optionOf(variant, axisEntry.key) ?? '') === folded &&
          matchesExcept(variant, selection, axisEntry.key),
      );

      const state: ValueState =
        compatible.length === 0
          ? 'NOT_OFFERED'
          : compatible.some((variant) => hasStock(variant))
            ? 'AVAILABLE'
            : 'OUT_OF_STOCK';

      return { label, value: folded, state };
    });

    const selectedRaw = Object.entries(selection).find(
      ([key]) => normaliseAxisKey(key) === normaliseAxisKey(axisEntry.key),
    );

    return {
      key: axisEntry.key,
      label: axisEntry.label,
      values,
      selected: selectedRaw === undefined || selectedRaw[1] === '' ? null : selectedRaw[1],
      isBlocked,
    };
  });

  // Variants still reachable from here: every selected axis satisfied.
  const matching = live.filter((variant) => matchesExcept(variant, selection, null));

  const missingAxisKeys = resolvedAxes
    .filter((entry) => entry.selected === null && entry.values.length > 0)
    .map((entry) => entry.key);

  // One variant, and nothing left to ask. Two rows matching a full selection
  // is a duplicate-combination bug upstream, and answering "the first one"
  // would hide it - so the selection is simply not complete.
  const isComplete = missingAxisKeys.length === 0 && matching.length === 1;

  const prices = matching
    .map((variant) => variant.priceMinor ?? fallbackPriceMinor)
    .filter((price): price is bigint => price !== null);

  const first = prices[0];
  const priceRange =
    first === undefined
      ? null
      : {
          minMinor: prices.reduce((low, price) => (price < low ? price : low), first),
          maxMinor: prices.reduce((high, price) => (price > high ? price : high), first),
        };

  return {
    axes: resolvedAxes,
    variantId: isComplete ? (matching[0]?.id ?? null) : null,
    isComplete,
    missingAxisKeys,
    priceRange,
    matchCount: matching.length,
  };
}

/**
 * The selection that identifies one known variant.
 *
 * Used to restore a shared link and to seed the page from a default variant.
 * The values come off the variant itself, so a link survives the seller
 * correcting the spelling of a colour - the stored label changes, the
 * selection rebuilt from it still matches.
 */
export function selectionForVariant(
  axes: readonly VariantAxis[],
  variant: ResolvableVariant,
): Selection {
  const selection: Record<string, string> = {};
  for (const axisEntry of axes) {
    const held = optionOf(variant, axisEntry.key);
    if (held !== null && held !== '') selection[axisEntry.key] = held;
  }
  return selection;
}

/**
 * A selection read from URL parameters, keeping only axes this product has.
 *
 * A stale link naming an axis the seller has since removed resolves to the
 * axes that remain rather than to nothing, so an old bookmark degrades to a
 * partly-filled page instead of a blank one. Values that match no variant are
 * dropped for the same reason: an impossible selection must never be the state
 * the page opens in.
 */
export function selectionFromParams(
  axes: readonly VariantAxis[],
  params: Readonly<Record<string, string | undefined>>,
  variants: readonly ResolvableVariant[],
): Selection {
  const selection: Record<string, string> = {};

  for (const axisEntry of axes) {
    const raw = params[axisEntry.key];
    if (raw === undefined || raw === '') continue;

    const folded = normaliseValue(raw);
    const match = variants
      .filter((variant) => variant.isActive)
      .map((variant) => optionOf(variant, axisEntry.key))
      .find((held) => held !== null && normaliseValue(held) === folded);

    if (match !== null && match !== undefined) selection[axisEntry.key] = match;
  }

  return selection;
}
