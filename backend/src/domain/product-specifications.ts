/**
 * Product specifications and description sections: the rules, in one place.
 *
 * WHAT A SPECIFICATION IS
 *
 * A label, a value and optionally a unit - "Capacity: 500 ml" - in one of a
 * fixed set of groups. The groups are a list here, not free text, for two
 * reasons: their headings are translated by each app (a seller's "Tech Specs"
 * and another's "Technical data" would be two headings nobody can translate),
 * and they are shown in one order on every product, so a buyer learns where to
 * look. Existing rows written before groups existed have none, and read as
 * GENERAL.
 *
 * A specification is stored on the product (`product_attributes`) and may be
 * OVERRIDDEN per variant (`product_variant_attributes`): a row on the variant
 * with the same label replaces the product's, and a label only the variant has
 * is added. The buyer who picks another option sees that option's values and
 * none of the previous one's.
 *
 * WHAT A DESCRIPTION SECTION IS
 *
 * A heading and plain text - line breaks kept, nothing else. Not HTML: a
 * seller's words are shown as text, so there is no markup to sanitise because
 * there is no markup. Anything that looks like a tag is removed on the way in,
 * so a pasted `<script>` does not even sit in the database as a string.
 *
 * Nothing here invents content. Empty values, empty groups and duplicates are
 * dropped; nothing is filled in.
 */
import { z } from 'zod';

/** In display order. */
export const SPEC_GROUPS = [
  'GENERAL',
  'TECHNICAL',
  'DIMENSIONS_WEIGHT',
  'MATERIAL',
  'PERFORMANCE',
  'COMPATIBILITY',
  'PACKAGING',
  'CARTON',
  'CONTAINER',
  'COMPLIANCE',
  'WARRANTY',
  'IN_THE_BOX',
  'MANUFACTURER',
  'SELLER',
  'ORIGIN',
] as const;
export type SpecGroup = (typeof SPEC_GROUPS)[number];

/**
 * The units a value may carry. A closed list because "12 cm" and "120 mm" and
 * "12cms" are one fact written three ways, and a unit the list does not know
 * belongs in the value itself.
 */
export const SPEC_UNITS = [
  'mm', 'cm', 'm', 'km', 'in', 'ft',
  'mg', 'g', 'kg', 't', 'oz', 'lb',
  'ml', 'l', 'm³', 'fl oz', 'gal',
  'W', 'kW', 'V', 'A', 'mA', 'mAh', 'Ah', 'Wh', 'kWh', 'Ω',
  'Hz', 'kHz', 'MHz', 'GHz', 'dB',
  '°C', '°F', 'K',
  'Pa', 'kPa', 'bar', 'psi',
  'rpm', 's', 'min', 'h', 'd',
  'pcs', '%', 'GB', 'TB', 'MB',
  'lm', 'lx', 'N', 'Nm',
] as const;
export type SpecUnit = (typeof SPEC_UNITS)[number];

export const SPEC_LIMITS = Object.freeze({
  groups: SPEC_GROUPS.length,
  rows: 120,
  label: 128,
  value: 512,
  sections: 12,
  heading: 120,
  body: 8_000,
  alt: 255,
  highlights: 12,
  variantOverrides: 400,
});

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
/** Anything shaped like a tag or a comment. Plain text has no business holding one. */
const TAG = /<\/?[a-zA-Z!][^>]*>|<!--[\s\S]*?-->/g;

/** One line: controls and tags out, whitespace collapsed, trimmed. */
export function cleanLine(value: string): string {
  return value.replace(TAG, ' ').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
}

/** A block of text: as above, but intentional line breaks kept (at most one blank line in a row). */
export function cleanBlock(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(TAG, ' ')
    .replace(CONTROL, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const line = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform(cleanLine)
    .pipe(z.string().max(max));

export const specRowSchema = z
  .object({
    label: line(SPEC_LIMITS.label).pipe(z.string().min(1, 'A specification needs a label.')),
    value: line(SPEC_LIMITS.value),
    unit: z.enum(SPEC_UNITS).nullable().default(null),
    highlight: z.boolean().default(false),
  })
  .strict();

export const specGroupSchema = z
  .object({
    group: z.enum(SPEC_GROUPS),
    rows: z.array(specRowSchema).max(SPEC_LIMITS.rows),
  })
  .strict();

export const descriptionSectionSchema = z
  .object({
    heading: line(SPEC_LIMITS.heading),
    body: z
      .string()
      .max(SPEC_LIMITS.body * 2)
      .transform(cleanBlock)
      .pipe(z.string().max(SPEC_LIMITS.body)),
    /** A picture already uploaded to this listing, or null. */
    imageMediaId: z.string().length(26).nullable().default(null),
    altText: line(SPEC_LIMITS.alt).nullable().default(null),
  })
  .strict();

export const variantOverrideSchema = z
  .object({
    /** The variant's option signature, as the listing's matrix names it. */
    variantSignature: z.string().min(1).max(512),
    group: z.enum(SPEC_GROUPS),
    label: line(SPEC_LIMITS.label).pipe(z.string().min(1)),
    value: line(SPEC_LIMITS.value),
    unit: z.enum(SPEC_UNITS).nullable().default(null),
  })
  .strict();

/** What a seller submits for a listing's description and specifications. */
export const listingContentSchema = z
  .object({
    specifications: z.array(specGroupSchema).max(SPEC_LIMITS.groups).default([]),
    descriptionSections: z.array(descriptionSectionSchema).max(SPEC_LIMITS.sections).default([]),
    variantOverrides: z.array(variantOverrideSchema).max(SPEC_LIMITS.variantOverrides).default([]),
  })
  .strict();

export type ListingContent = z.infer<typeof listingContentSchema>;
export type SpecRowInput = z.infer<typeof specRowSchema>;

export interface ContentIssue {
  field: string;
  code: 'DUPLICATE_LABEL' | 'DUPLICATE_GROUP' | 'EMPTY_VALUE' | 'EMPTY_SECTION' | 'TOO_MANY_HIGHLIGHTS';
}

const labelKey = (label: string): string => label.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();

/**
 * The problems a save must refuse, with the field each is about. A label may
 * appear once per product (a buyer shown "Weight" twice cannot tell which is
 * true), a value may not be empty, a section needs words.
 */
export function contentIssues(content: ListingContent): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const seenGroups = new Set<string>();
  const seenLabels = new Set<string>();
  let highlights = 0;
  content.specifications.forEach((group, g) => {
    if (seenGroups.has(group.group)) issues.push({ field: `specifications.${g}.group`, code: 'DUPLICATE_GROUP' });
    seenGroups.add(group.group);
    group.rows.forEach((row, r) => {
      const key = labelKey(row.label);
      if (seenLabels.has(key)) issues.push({ field: `specifications.${g}.rows.${r}.label`, code: 'DUPLICATE_LABEL' });
      seenLabels.add(key);
      if (row.value === '') issues.push({ field: `specifications.${g}.rows.${r}.value`, code: 'EMPTY_VALUE' });
      if (row.highlight) highlights += 1;
    });
  });
  if (highlights > SPEC_LIMITS.highlights) issues.push({ field: 'specifications', code: 'TOO_MANY_HIGHLIGHTS' });
  content.descriptionSections.forEach((section, s) => {
    if (section.heading === '' && section.body === '') {
      issues.push({ field: `descriptionSections.${s}`, code: 'EMPTY_SECTION' });
    }
  });
  const seenOverride = new Set<string>();
  content.variantOverrides.forEach((row, o) => {
    const key = `${row.variantSignature}\u0000${labelKey(row.label)}`;
    if (seenOverride.has(key)) issues.push({ field: `variantOverrides.${o}.label`, code: 'DUPLICATE_LABEL' });
    seenOverride.add(key);
    if (row.value === '') issues.push({ field: `variantOverrides.${o}.value`, code: 'EMPTY_VALUE' });
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Reading: rows as stored, to groups as shown
// ---------------------------------------------------------------------------

export interface StoredSpecRow {
  name: string;
  value: string;
  unit: string | null;
  groupKey: string | null;
  sortOrder: number;
  isHighlight?: boolean;
}

export interface ShownSpecRow {
  label: string;
  value: string;
  unit: string | null;
  highlight: boolean;
}

export interface ShownSpecGroup {
  group: SpecGroup;
  rows: ShownSpecRow[];
}

function groupOf(key: string | null): SpecGroup {
  return (SPEC_GROUPS as readonly string[]).includes(key ?? '') ? (key as SpecGroup) : 'GENERAL';
}

/**
 * The groups a buyer sees, in the fixed order: product rows with the chosen
 * variant's overrides applied. Empty values, empty groups and a label seen
 * twice are left out; a value the database holds as "null" or "undefined"
 * text is treated as empty, because that is a broken import, not a fact.
 */
export function shownSpecifications(
  productRows: readonly StoredSpecRow[],
  variantRows: readonly StoredSpecRow[] = [],
): ShownSpecGroup[] {
  const overrides = new Map(variantRows.map((row) => [labelKey(row.name), row]));
  const merged: StoredSpecRow[] = [];
  const seen = new Set<string>();
  const take = (row: StoredSpecRow, highlight: boolean): void => {
    const key = labelKey(row.name);
    if (seen.has(key)) return;
    const value = row.value.trim();
    if (value === '' || /^(null|undefined|n\/?a|-|—)$/i.test(value) || row.name.trim() === '') return;
    seen.add(key);
    merged.push({ ...row, value, isHighlight: highlight });
  };
  for (const row of [...productRows].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const override = overrides.get(labelKey(row.name));
    take(override === undefined ? row : { ...override, groupKey: override.groupKey ?? row.groupKey }, row.isHighlight === true);
  }
  for (const row of [...variantRows].sort((a, b) => a.sortOrder - b.sortOrder)) take(row, false);

  return SPEC_GROUPS.map((group) => ({
    group,
    rows: merged
      .filter((row) => groupOf(row.groupKey) === group)
      .map((row) => ({
        label: row.name,
        value: row.value,
        unit: (SPEC_UNITS as readonly string[]).includes(row.unit ?? '') ? row.unit : null,
        highlight: row.isHighlight === true,
      })),
  })).filter((group) => group.rows.length > 0);
}

/** Rows to store for a product from a seller's groups: one per label, ordered. */
export function productRowsFrom(content: ListingContent): (StoredSpecRow & { isHighlight: boolean })[] {
  const rows: (StoredSpecRow & { isHighlight: boolean })[] = [];
  const seen = new Set<string>();
  let order = 0;
  const groups = [...content.specifications].sort(
    (a, b) => SPEC_GROUPS.indexOf(a.group) - SPEC_GROUPS.indexOf(b.group),
  );
  for (const group of groups) {
    for (const row of group.rows) {
      const key = labelKey(row.label);
      if (row.value === '' || seen.has(key)) continue;
      seen.add(key);
      rows.push({
        name: row.label,
        value: row.value,
        unit: row.unit,
        groupKey: group.group,
        sortOrder: order++,
        isHighlight: row.highlight,
      });
    }
  }
  return rows;
}

/** A draft's stored content, or null when there is none or it no longer validates. */
export function readListingContent(value: unknown): ListingContent | null {
  if (value === null || value === undefined) return null;
  const parsed = listingContentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
