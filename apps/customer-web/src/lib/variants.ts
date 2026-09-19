/**
 * Variant resolution in the browser.
 *
 * Mirrors `backend/src/domain/variants/resolver.ts` and the pack half of
 * `backend/src/domain/variants/commerce.ts`. It is a mirror rather than a
 * shared package because this repository has no shared package and the
 * alternative — asking the server which sizes are still possible every time
 * somebody taps a colour — would put a network round trip between a tap and a
 * button changing state.
 *
 * Nothing here is trusted by anything that matters. The server recomputes the
 * signature, the availability and every purchasing rule on add-to-cart and
 * again at checkout, so the worst a wrong answer here can do is show a shopper
 * a button they should not have been offered. Which is bad, and is why the two
 * implementations are tested against the same cases — but it is not a way to
 * buy something on terms nobody agreed to.
 *
 * The three states matter and are not interchangeable:
 *
 *   available     — there is one, and it is here
 *   out of stock  — there is one, it is not here right now
 *   not offered   — no such thing is sold; nothing to wait for
 *
 * Collapsing the last two into one grey button is the commonest way a variant
 * selector lies to somebody.
 */
import type { Money } from './format';
import type { ProductVariant, VariantAxisDefinition } from './types';

// ---------------------------------------------------------------------------
// NORMALISATION
// ---------------------------------------------------------------------------

/**
 * The comparable form of a value.
 *
 * Must fold identically to `normaliseValue` on the server, including the
 * letters that do not decompose under NFKD — a German "Größe" has to fold the
 * same way in both places or a shared link resolves to nothing.
 */
export function normaliseValue(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    .replace(/đ|ð/g, 'd')
    .replace(/ł/g, 'l')
    .replace(/þ/g, 'th')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normaliseAxisKey(key: string): string {
  return normaliseValue(key).replace(/-/g, '_');
}

// ---------------------------------------------------------------------------
// SORTING
// ---------------------------------------------------------------------------

const APPAREL_ORDER: readonly string[] = [
  'xxxs', '3xs', 'xxs', '2xs', 'xs', 's', 'small', 'm', 'medium', 'l', 'large',
  'xl', 'x-large', 'xxl', '2xl', 'xxxl', '3xl', '4xl', 'xxxxl', '5xl', '6xl', '7xl', '8xl',
];

function leadingNumber(value: string): number | null {
  const match = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(value);
  const digits = match?.[1];
  if (digits === undefined) return null;
  const parsed = Number(digits.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

export type AxisSortMode = 'NUMERIC' | 'APPAREL' | 'GIVEN' | 'ALPHA';

/** Order one axis's values. Stable: ties keep the order they arrived in. */
export function sortAxisValues(values: readonly string[], mode: AxisSortMode): string[] {
  const indexed = values.map((value, index) => ({ value, index }));

  return indexed
    .sort((left, right) => {
      if (mode === 'GIVEN') return left.index - right.index;
      if (mode === 'ALPHA') {
        return left.value.localeCompare(right.value) || left.index - right.index;
      }

      if (mode === 'NUMERIC') {
        const a = leadingNumber(left.value);
        const b = leadingNumber(right.value);
        if (a === null && b === null) {
          return left.value.localeCompare(right.value) || left.index - right.index;
        }
        // A value with no number sorts after every value with one, rather than
        // being read as zero and jumping to the front of a size run.
        if (a === null) return 1;
        if (b === null) return -1;
        return a - b || left.value.localeCompare(right.value) || left.index - right.index;
      }

      const a = APPAREL_ORDER.indexOf(normaliseValue(left.value));
      const b = APPAREL_ORDER.indexOf(normaliseValue(right.value));
      if (a === -1 && b === -1) {
        return left.value.localeCompare(right.value) || left.index - right.index;
      }
      if (a === -1) return 1;
      if (b === -1) return -1;
      return a - b;
    })
    .map((entry) => entry.value);
}

// ---------------------------------------------------------------------------
// RESOLUTION
// ---------------------------------------------------------------------------

export type ValueState = 'AVAILABLE' | 'OUT_OF_STOCK' | 'NOT_OFFERED';

export interface ResolvedValue {
  /** Exactly as the seller typed it. Never the folded form. */
  label: string;
  value: string;
  state: ValueState;
}

export interface ResolvedAxis {
  key: string;
  label: string;
  definition: VariantAxisDefinition | null;
  values: ResolvedValue[];
  selected: string | null;
  /** True while an axis this one depends on is unanswered. */
  isBlocked: boolean;
}

export interface Resolution {
  axes: ResolvedAxis[];
  variant: ProductVariant | null;
  isComplete: boolean;
  /** Unanswered axes, in order. The first is where focus goes on a failed add. */
  missingAxisKeys: string[];
  priceRange: { min: Money; max: Money } | null;
  matchCount: number;
}

export type Selection = Readonly<Record<string, string>>;

function optionOf(variant: ProductVariant, axisKey: string): string | null {
  const wanted = normaliseAxisKey(axisKey);
  for (const [key, value] of Object.entries(variant.options)) {
    if (normaliseAxisKey(key) === wanted) return value;
  }
  return null;
}

function matchesExcept(
  variant: ProductVariant,
  selection: Selection,
  exceptAxisKey: string | null,
): boolean {
  const except = exceptAxisKey === null ? null : normaliseAxisKey(exceptAxisKey);

  for (const [axisKey, chosen] of Object.entries(selection)) {
    if (chosen === '') continue;
    if (normaliseAxisKey(axisKey) === except) continue;
    const held = optionOf(variant, axisKey);
    if (held === null || normaliseValue(held) !== normaliseValue(chosen)) return false;
  }
  return true;
}

/**
 * Whether this one can be had right now.
 *
 * `isInStock` is a BOOLEAN the server sends, never a quantity: this storefront
 * does not publish warehouse figures, because a competitor should not be able
 * to read stock levels off a shop front. But "is there one" and "how many are
 * there" are different questions, and the first one has to be answerable or
 * the selector can only ever say "not offered" — which makes a size that is
 * temporarily empty look identical to a size that is not sold.
 *
 * Null or absent means the question has no answer here: an untracked product,
 * or a read that did not look stock up. Both are purchasable, because stock is
 * confirmed when the item goes in the basket, which is what actually happens.
 */
function hasStock(variant: ProductVariant): boolean {
  if (variant.isInStock === false) return false;
  if (variant.isInStock === true) return true;

  // Older responses, and the admin previews, carry a figure instead.
  return (
    variant.availableQty === undefined || variant.availableQty === null || variant.availableQty > 0
  );
}

export function resolveVariants(
  axisKeys: readonly string[],
  definitions: Readonly<Record<string, VariantAxisDefinition>>,
  variants: readonly ProductVariant[],
  selection: Selection,
): Resolution {
  const live = variants.filter((variant) => variant.isActive !== false);

  const answered = new Set(
    Object.entries(selection)
      .filter(([, value]) => value !== '')
      .map(([key]) => normaliseAxisKey(key)),
  );

  const axes: ResolvedAxis[] = axisKeys.map((axisKey) => {
    const definition = definitions[axisKey] ?? null;

    const isBlocked = (definition?.dependsOn ?? []).some(
      (dependency) => !answered.has(normaliseAxisKey(dependency)),
    );

    // Every value any live variant carries, deduplicated by its folded form
    // and displayed with the first spelling the seller used.
    const labels = new Map<string, string>();
    for (const variant of live) {
      const held = optionOf(variant, axisKey);
      if (held === null || held === '') continue;
      const folded = normaliseValue(held);
      if (!labels.has(folded)) labels.set(folded, held);
    }

    const ordered = sortAxisValues([...labels.values()], definition?.sort ?? 'GIVEN');

    const values = ordered.map<ResolvedValue>((label) => {
      const folded = normaliseValue(label);

      // Compatible with every OTHER answered axis. Ignoring this axis's own
      // current answer is what lets somebody change their mind about colour
      // without the size they already picked greying out every colour.
      const compatible = live.filter(
        (variant) =>
          normaliseValue(optionOf(variant, axisKey) ?? '') === folded &&
          matchesExcept(variant, selection, axisKey),
      );

      return {
        label,
        value: folded,
        state:
          compatible.length === 0
            ? 'NOT_OFFERED'
            : compatible.some((variant) => hasStock(variant))
              ? 'AVAILABLE'
              : 'OUT_OF_STOCK',
      };
    });

    const chosen = Object.entries(selection).find(
      ([key]) => normaliseAxisKey(key) === normaliseAxisKey(axisKey),
    );

    return {
      key: axisKey,
      label: definition?.label ?? axisKey,
      definition,
      values,
      selected: chosen === undefined || chosen[1] === '' ? null : chosen[1],
      isBlocked,
    };
  });

  const matching = live.filter((variant) => matchesExcept(variant, selection, null));

  const missingAxisKeys = axes
    .filter((axis) => axis.selected === null && axis.values.length > 0)
    .map((axis) => axis.key);

  // Two rows matching a full selection is a duplicate-combination bug on the
  // server. Answering "the first one" would hide it, so the selection is
  // simply not complete and the buy button stays disabled.
  const isComplete = missingAxisKeys.length === 0 && matching.length === 1;

  const priced = matching.filter((variant) => variant.price !== null);
  const first = priced[0]?.price ?? null;

  const priceRange =
    first === null
      ? null
      : priced.reduce<{ min: Money; max: Money }>(
          (range, variant) => {
            const price = variant.price;
            if (price === null) return range;
            return {
              min: BigInt(price.minor) < BigInt(range.min.minor) ? price : range.min,
              max: BigInt(price.minor) > BigInt(range.max.minor) ? price : range.max,
            };
          },
          { min: first, max: first },
        );

  return {
    axes,
    variant: isComplete ? (matching[0] ?? null) : null,
    isComplete,
    missingAxisKeys,
    priceRange,
    matchCount: matching.length,
  };
}

/** The selection that names one known variant, for a default or a restore. */
export function selectionForVariant(
  axisKeys: readonly string[],
  variant: ProductVariant,
): Selection {
  const selection: Record<string, string> = {};
  for (const axisKey of axisKeys) {
    const held = optionOf(variant, axisKey);
    if (held !== null && held !== '') selection[axisKey] = held;
  }
  return selection;
}

/**
 * A selection read from the URL, keeping only what this product can honour.
 *
 * A stale link naming an axis the seller has removed resolves to the axes that
 * remain, so an old bookmark opens partly filled rather than blank. A value no
 * variant offers is dropped for the same reason: an impossible selection must
 * never be the state the page opens in.
 */
export function selectionFromParams(
  axisKeys: readonly string[],
  params: URLSearchParams,
  variants: readonly ProductVariant[],
): Selection {
  const selection: Record<string, string> = {};

  for (const axisKey of axisKeys) {
    const raw = params.get(axisKey);
    if (raw === null || raw === '') continue;

    const folded = normaliseValue(raw);
    const match = variants
      .filter((variant) => variant.isActive !== false)
      .map((variant) => optionOf(variant, axisKey))
      .find((held) => held !== null && normaliseValue(held) === folded);

    if (match !== null && match !== undefined) selection[axisKey] = match;
  }

  return selection;
}

/** The selection as URL parameters, folded so a shared link is tidy. */
export function selectionToParams(selection: Selection): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(selection)) {
    if (value !== '') params[key] = normaliseValue(value);
  }
  return params;
}

// ---------------------------------------------------------------------------
// PACKS
// ---------------------------------------------------------------------------

/**
 * What one purchasable unit contains, and what a whole cart line contains.
 *
 * The arithmetic a catalogue most often leaves to the reader: 500 g × 10 is
 * 5 kg, and two of those is 10 kg. Done with a scaled integer rather than a
 * float, because 0.1 + 0.2 is not 0.3 and a total weight that is wrong in the
 * seventh decimal place prints as wrong.
 *
 * Returns null wherever the answer would have to be invented — no net content
 * stated, or a value that is not a number. The page then says nothing, which
 * is the honest thing to say.
 */
export interface PackSummary {
  multipackCount: number;
  netContent: { value: string; unit: string } | null;
  totalContent: { value: string; unit: string } | null;
  manufacturerPackLabel: string | null;
}

const SCALE = 6;

function parseScaled(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, '0'));
}

function formatScaled(scaled: bigint): string {
  const factor = 10n ** BigInt(SCALE);
  const whole = scaled / factor;
  const fraction = (scaled % factor).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

export function summarisePack(variant: ProductVariant): PackSummary {
  const multipackCount = Math.max(variant.multipackCount ?? 1, 1);

  const netContent =
    variant.netContentValue === null ||
    variant.netContentValue === undefined ||
    variant.netContentUnit === null ||
    variant.netContentUnit === undefined
      ? null
      : { value: variant.netContentValue, unit: variant.netContentUnit };

  const scaled = netContent === null ? null : parseScaled(netContent.value);

  return {
    multipackCount,
    netContent,
    totalContent:
      scaled === null || netContent === null
        ? null
        : { value: formatScaled(scaled * BigInt(multipackCount)), unit: netContent.unit },
    manufacturerPackLabel: variant.manufacturerPackLabel ?? null,
  };
}

/** What the whole line contains: total content × how many they are buying. */
export function lineContent(
  summary: PackSummary,
  quantity: number,
): { value: string; unit: string } | null {
  if (summary.totalContent === null) return null;
  if (!Number.isInteger(quantity) || quantity < 1) return null;

  const scaled = parseScaled(summary.totalContent.value);
  if (scaled === null) return null;

  return { value: formatScaled(scaled * BigInt(quantity)), unit: summary.totalContent.unit };
}

/**
 * The purchasing rules that apply to one variant.
 *
 * The variant's own where it has them, the product family's otherwise. Null on
 * a variant field is not a missing value — it means "the product's rule", and
 * the server resolves it exactly the same way on every cart mutation.
 */
export function rulesForVariant(
  productRules: { minOrderQty: number; qtyIncrement: number; maxOrderQty: number | null },
  variant: ProductVariant | null,
): { minOrderQty: number; qtyIncrement: number; maxOrderQty: number | null } {
  if (variant === null) return productRules;

  return {
    minOrderQty: variant.minOrderQty ?? productRules.minOrderQty,
    qtyIncrement: variant.qtyIncrement ?? productRules.qtyIncrement,
    maxOrderQty: variant.maxOrderQty ?? productRules.maxOrderQty,
  };
}
