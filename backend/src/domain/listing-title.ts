/**
 * How a product title is built.
 *
 * Deterministic, server-side, and from a fixed list of permitted fields. The
 * reference screens put it plainly - "Product Title is created automatically...
 * Title creation logic cannot be changed" - and the reason a marketplace works
 * that way is that a title is not decoration. It is the string a buyer
 * searches, compares and decides on, and when sellers write their own the
 * result is "BEST QUALITY ⭐ Surgical Gloves ⭐ FAST DELIVERY" competing against
 * "Nitrile Examination Glove, Powder-Free, Medium, Box of 100".
 *
 * Two things follow from generating it here rather than in the wizard:
 *
 *   - **The preview and the stored title are the same string.** A seller who
 *     previews a title and then submits gets what they saw, because one
 *     function produced both.
 *   - **"Preview title" can be honestly disabled.** It lights up exactly when
 *     every title component is present and valid, which is a question only the
 *     server can answer, since the component list is a database row.
 */

import { hasValue, validateAttributeValue, type AttributeDefinition } from './listing-completeness.js';

/** A definition that contributes to the title, with its position. */
export interface TitleComponentDefinition extends AttributeDefinition {
  titleOrder: number;
}

export interface TitleInput {
  /** Every title-component definition for this category, in any order. */
  components: readonly TitleComponentDefinition[];
  values: Readonly<Record<string, unknown>>;
  /** The brand name, which always leads the title when there is one. */
  brandName?: string | null;
}

export interface TitleContribution {
  attributeKey: string;
  label: string;
  /** The text this field put into the title. */
  text: string;
}

export type TitleResult =
  | {
      ready: true;
      title: string;
      /**
       * Which fields produced the title, in order. The wizard shows this under
       * the preview - a seller who cannot see why the title says "Medium" has
       * no way to change it, since they cannot edit the title itself.
       */
      contributions: TitleContribution[];
    }
  | {
      ready: false;
      title: null;
      /** Which required components are missing or invalid, to explain the
       * disabled button rather than just disabling it. */
      blockedBy: { attributeKey: string; label: string; reason: 'MISSING' | 'INVALID' }[];
    };

/**
 * Render one value as the fragment it contributes.
 *
 * A measurement becomes "120 mm" rather than "120" - dropping the unit from a
 * title is how two different products end up with the same name. A multi-select
 * joins with ", " and a boolean contributes its label only when true, because
 * "Sterile" belongs in a title and "Sterile: No" does not; a non-sterile
 * product simply does not carry the word.
 */
function renderComponent(definition: TitleComponentDefinition, value: unknown): string | null {
  switch (definition.type) {
    case 'MEASUREMENT': {
      const measurement = value as { amount?: unknown; unit?: unknown };
      const unit = measurement?.unit;

      // Narrowed to the two shapes a measurement can legitimately arrive as.
      // An object here would stringify to "[object Object]" and put that in a
      // product title, where it would be searched, compared and ordered from.
      const amount =
        typeof measurement?.amount === 'number' || typeof measurement?.amount === 'string'
          ? String(measurement.amount)
          : null;

      if (amount === null) return null;
      return typeof unit === 'string' && unit.length > 0 ? `${amount} ${unit}` : amount;
    }

    case 'BOOLEAN':
      return value === true ? definition.label : null;

    case 'MULTI_SELECT':
      return Array.isArray(value) ? value.map(String).join(', ') : null;

    case 'NUMBER':
    case 'DECIMAL':
      return definition.unit !== null && definition.unit !== undefined && definition.unit.length > 0
        ? `${String(value)} ${definition.unit}`
        : String(value);

    default: {
      const text = String(value).trim();
      return text.length > 0 ? text : null;
    }
  }
}

/** Collapse runs of whitespace and strip stray separators. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
}

/** Titles are stored in VARCHAR(512); this is the limit that matters. */
export const MAX_TITLE_LENGTH = 512;

/**
 * Build the title, or say why it cannot be built yet.
 *
 * A component that is **required** and missing blocks the title. A component
 * that is optional and missing is simply skipped - which is what lets one
 * category serve both a product that has a gauge and one that does not,
 * without giving the second one a title with a hole in it.
 */
export function generateTitle(input: TitleInput): TitleResult {
  const ordered = [...input.components].sort((a, b) => {
    if (a.titleOrder !== b.titleOrder) return a.titleOrder - b.titleOrder;
    // A stable tie-break, so two components sharing an order do not swap places
    // between two runs and produce two different titles for one listing.
    return a.attributeKey.localeCompare(b.attributeKey);
  });

  const blockedBy: { attributeKey: string; label: string; reason: 'MISSING' | 'INVALID' }[] = [];
  const contributions: TitleContribution[] = [];

  const brand = typeof input.brandName === 'string' ? input.brandName.trim() : '';
  if (brand.length > 0) {
    contributions.push({ attributeKey: 'brand', label: 'Brand', text: brand });
  }

  for (const definition of ordered) {
    const value = input.values[definition.attributeKey];

    if (!hasValue(value)) {
      if (definition.isRequired) {
        blockedBy.push({
          attributeKey: definition.attributeKey,
          label: definition.label,
          reason: 'MISSING',
        });
      }
      continue;
    }

    if (validateAttributeValue(definition, value) !== null) {
      blockedBy.push({
        attributeKey: definition.attributeKey,
        label: definition.label,
        reason: 'INVALID',
      });
      continue;
    }

    const text = renderComponent(definition, value);
    if (text === null || text.trim().length === 0) continue;

    contributions.push({
      attributeKey: definition.attributeKey,
      label: definition.label,
      text: tidy(text),
    });
  }

  if (blockedBy.length > 0) {
    return { ready: false, title: null, blockedBy };
  }

  if (contributions.length === 0) {
    // Nothing to build from at all. Treated as not ready rather than as an
    // empty title, because an empty title would be stored and published.
    return {
      ready: false,
      title: null,
      blockedBy: [{ attributeKey: 'title', label: 'Product title', reason: 'MISSING' }],
    };
  }

  const assembled = tidy(contributions.map((entry) => entry.text).join(', '));

  // Truncated on a separator rather than mid-word, and only when it genuinely
  // does not fit. A title cut through the middle of "Powder-Fr" reads as
  // corrupted data.
  const title =
    assembled.length <= MAX_TITLE_LENGTH
      ? assembled
      : tidy(assembled.slice(0, MAX_TITLE_LENGTH).replace(/[^,]*$/, ''));

  return { ready: true, title, contributions };
}

/**
 * May this seller type their own title?
 *
 * A single place for the policy so the button, the API and the moderation queue
 * agree. `allowSellerEditedTitles` is a marketplace setting with a default of
 * false; where it is false the wizard offers "Request title correction"
 * instead, which is a moderator's job rather than a refusal.
 */
export function canSellerEditTitle(settings: { allowSellerEditedTitles: boolean }): boolean {
  return settings.allowSellerEditedTitles;
}
