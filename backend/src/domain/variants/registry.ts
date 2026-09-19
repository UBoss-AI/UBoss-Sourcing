/**
 * The variant template registry.
 *
 * One lookup, one source of truth, 112 templates. The seller's matrix builder,
 * the buyer's selector, the catalogue's facets and the validator all ask this
 * the same question - "what are the dimensions of this shelf?" - and get the
 * same answer, which is the only reason a filter on the search page and a
 * selector on the product page can agree about what "Size" means.
 *
 * ---
 *
 * **Lookup is by SLUG, and slugs come from the database.** A category's
 * display name is the operator's to change: this is a product other companies
 * buy and run, and one of them will rename "Footwear" to "Shoes & Boots" on
 * their second day. The slug is what survives that. `categories.slug` is
 * unique and stable, and the starter categories seed plants exactly the slugs
 * named here.
 *
 * **A renamed or newly invented category simply has no template**, and that is
 * a supported state rather than a failure. `findTemplate` returns null, the
 * seller gets the free-form option editor the catalogue has always had, and
 * nothing breaks. A marketplace where a seller cannot list something because
 * our list of shelves did not anticipate it is not a marketplace.
 *
 * **Medical Devices deliberately has no template.** Its variants are authored
 * as free-form options today and a hospital buyer picks several sizes at once
 * rather than narrowing down to one - see the variant picker on the product
 * page. Giving that department an axis template would replace a working
 * purchasing flow with a different one for no reason anybody asked for. The
 * null answer here is what keeps it exactly as it is.
 */
import type { VariantAxis, VariantTemplate } from './axis.js';
import { normaliseAxisKey } from './axis.js';
import { COMMERCE_TEMPLATES } from './templates.commerce.js';
import { CONSUMER_TEMPLATES } from './templates.consumer.js';
import { INDUSTRIAL_TEMPLATES } from './templates.industrial.js';
import { TRADE_TEMPLATES } from './templates.trade.js';

/** Every template, in department order. */
export const VARIANT_TEMPLATES: readonly VariantTemplate[] = Object.freeze([
  ...INDUSTRIAL_TEMPLATES,
  ...COMMERCE_TEMPLATES,
  ...TRADE_TEMPLATES,
  ...CONSUMER_TEMPLATES,
]);

const BY_SUBCATEGORY: ReadonlyMap<string, VariantTemplate> = new Map(
  VARIANT_TEMPLATES.filter(
    (entry): entry is VariantTemplate & { subcategorySlug: string } =>
      entry.subcategorySlug !== null,
  ).map((entry) => [entry.subcategorySlug, entry]),
);

const DEPARTMENT_SLUGS: ReadonlySet<string> = new Set(
  VARIANT_TEMPLATES.map((entry) => entry.categorySlug),
);

/**
 * The template for a category, by its own slug and its ancestors'.
 *
 * `slugs` is the category's slug followed by its parents', nearest first -
 * which is how a three-level catalogue works. An operator who adds
 * "Footwear > Safety Boots" of their own gets Footwear's template for the
 * shelf underneath it, because that is what a subcategory of footwear is.
 *
 * A department slug on its own resolves to nothing: "Clothing & Textiles" is
 * four different shelves with four different shapes, and averaging them into
 * one template would offer a fabric roll an apparel size run.
 */
export function findTemplate(slugs: readonly string[]): VariantTemplate | null {
  for (const slug of slugs) {
    const found = BY_SUBCATEGORY.get(slug);
    if (found !== undefined) return found;
  }
  return null;
}

/** Whether a slug names a department this registry knows about. */
export function isKnownDepartment(slug: string): boolean {
  return DEPARTMENT_SLUGS.has(slug);
}

/** One axis of one template, by key. Null when the template does not offer it. */
export function findAxis(templateEntry: VariantTemplate, key: string): VariantAxis | null {
  const wanted = normaliseAxisKey(key);
  return templateEntry.axes.find((entry) => normaliseAxisKey(entry.key) === wanted) ?? null;
}

/**
 * The axes a product family has actually switched on, in template order.
 *
 * A product declares its active axes as a list of keys. This resolves them
 * against the template and DISCARDS anything the template does not know -
 * which is what makes a template edit safe: an axis removed from a template
 * stops being offered to new products without invalidating the variants of
 * every product that already used it. Those rows keep their stored option
 * values and keep selling; they simply stop being editable through the
 * template-driven form.
 *
 * Order is the template's, never the product's. Two products on one shelf
 * showing Colour above Size and Size above Colour is the kind of inconsistency
 * a shopper notices without being able to say why.
 */
export function resolveActiveAxes(
  templateEntry: VariantTemplate | null,
  activeKeys: readonly string[],
): VariantAxis[] {
  if (templateEntry === null) return [];
  const wanted = new Set(activeKeys.map((key) => normaliseAxisKey(key)));
  return templateEntry.axes.filter((entry) => wanted.has(normaliseAxisKey(entry.key)));
}

/** How many templates this registry holds. Asserted by the template test. */
export const TEMPLATE_COUNT = VARIANT_TEMPLATES.length;
