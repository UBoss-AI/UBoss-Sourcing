/**
 * "Is this listing finished, and if not, what exactly is missing?"
 *
 * One implementation, called by three things that must never disagree: the
 * counters the seller watches while typing ("Product Description (8/8)"), the
 * gate on the submit button, and the moderation queue's view of what arrived.
 * A second implementation of "complete" is how a seller is told a listing is
 * ready and then refused by the server a second later, with no way to find out
 * which of the two was lying.
 *
 * That is the same argument `quoteSchedule` makes about pricing, and it holds
 * for the same reason: the number on the screen and the number the server acts
 * on have to come from one place.
 *
 * **The counters are computed here, never sent by the browser.** The wizard
 * renders what this returns. It does not count fields itself - it cannot, since
 * which fields a category requires is a database row it only ever sees a
 * filtered copy of.
 */

/** The sections the seller sees a completion count for. */
export const LISTING_SECTIONS = [
  'PRODUCT_PHOTOS',
  'PRICE_STOCK_SHIPPING',
  'PRODUCT_DESCRIPTION',
  'ADDITIONAL_INFORMATION',
  'MEDICAL_COMPLIANCE',
] as const;

export type ListingSectionName = (typeof LISTING_SECTIONS)[number];

/**
 * How a section is getting on.
 *
 * `OPTIONAL` is a real state and not a synonym for `NOT_STARTED`: the
 * "Additional Information" section on the reference screens shows a count out
 * of eighteen where none of the eighteen is required, and telling the seller
 * that section is incomplete would send them hunting for a blocker that does
 * not exist.
 */
export type SectionState =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETE'
  | 'ERROR'
  | 'OPTIONAL'
  | 'UNDER_REVIEW';

/** One field the wizard renders, as this module needs to see it. */
export interface AttributeDefinition {
  attributeKey: string;
  label: string;
  section: ListingSectionName;
  type:
    | 'TEXT'
    | 'LONG_TEXT'
    | 'RICH_TEXT'
    | 'NUMBER'
    | 'DECIMAL'
    | 'MEASUREMENT'
    | 'DROPDOWN'
    | 'MULTI_SELECT'
    | 'BOOLEAN'
    | 'DATE'
    | 'KEY_VALUE_LIST'
    | 'DOCUMENT';
  isRequired: boolean;
  allowedValues?: readonly { value: string }[] | null;
  allowedUnits?: readonly string[] | null;
  minNumber?: number | null;
  maxNumber?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  pattern?: string | null;
  unit?: string | null;
  isRegulatoryOnly?: boolean;
}

/** An image slot, as this module needs to see it. */
export interface MediaSlotRequirement {
  slot: string;
  label: string;
  isRequired: boolean;
}

export interface UploadedMedia {
  slot: string;
  uploaded: boolean;
  rejectionCode?: string | null;
}

export interface ListingIssue {
  severity: 'BLOCKER' | 'WARNING' | 'ADVISORY';
  code: string;
  section: ListingSectionName | null;
  attributeKey: string | null;
  message: string;
}

export interface SectionSummary {
  section: ListingSectionName;
  /** How many of this section's fields carry an acceptable value. */
  completed: number;
  /** How many it has in total - required and optional together. */
  total: number;
  /** How many of them are required. Zero makes the section OPTIONAL. */
  required: number;
  /** How many required ones are still missing. */
  missingRequired: number;
  state: SectionState;
}

export interface CompletenessInput {
  definitions: readonly AttributeDefinition[];
  /** Attribute key -> whatever the seller typed. Unvalidated. */
  values: Readonly<Record<string, unknown>>;
  mediaSlots: readonly MediaSlotRequirement[];
  media: readonly UploadedMedia[];
  /**
   * Whether the product is a regulated device. Decides whether the
   * `isRegulatoryOnly` definitions count at all - a waiting-room chair in the
   * same category as a sterile implant must not be asked for a UDI.
   */
  isRegulatedDevice: boolean;
  /** Whether the offer carries a price, a currency and a quantity. */
  hasPrice: boolean;
  /** Whether any location holds stock for it. */
  hasStock: boolean;
}

export interface CompletenessResult {
  sections: SectionSummary[];
  issues: ListingIssue[];
  /** True when no BLOCKER issue remains. */
  isSubmittable: boolean;
}

/**
 * Has this field been answered at all?
 *
 * Empty string, empty array and empty object all count as unanswered, and that
 * is the case worth being careful about: a `MULTI_SELECT` the seller opened and
 * closed leaves `[]`, which is truthy in JavaScript and would otherwise count
 * as a completed field. `false` and `0`, on the other hand, ARE answers - a
 * "sterile: no" that counted as blank would block every non-sterile product.
 */
export function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Check one value against one definition.
 *
 * Returns the reason it is unacceptable, or null. A value that is simply
 * absent is NOT an error here - that is the caller's business, because an
 * absent optional field is fine and an absent required one is a different
 * message.
 */
export function validateAttributeValue(
  definition: AttributeDefinition,
  value: unknown,
): { code: string; message: string } | null {
  if (!hasValue(value)) return null;

  switch (definition.type) {
    case 'NUMBER':
    case 'DECIMAL':
    case 'MEASUREMENT': {
      const numeric =
        definition.type === 'MEASUREMENT'
          ? asNumber((value as { amount?: unknown })?.amount)
          : asNumber(value);

      if (numeric === null) {
        return { code: 'NOT_A_NUMBER', message: `${definition.label} must be a number.` };
      }
      if (definition.type === 'NUMBER' && !Number.isInteger(numeric)) {
        return {
          code: 'NOT_AN_INTEGER',
          message: `${definition.label} must be a whole number.`,
        };
      }
      if (definition.minNumber !== null && definition.minNumber !== undefined && numeric < definition.minNumber) {
        return {
          code: 'BELOW_MINIMUM',
          message: `${definition.label} cannot be below ${String(definition.minNumber)}.`,
        };
      }
      if (definition.maxNumber !== null && definition.maxNumber !== undefined && numeric > definition.maxNumber) {
        return {
          code: 'ABOVE_MAXIMUM',
          message: `${definition.label} cannot be above ${String(definition.maxNumber)}.`,
        };
      }

      if (definition.type === 'MEASUREMENT') {
        const unit = (value as { unit?: unknown })?.unit;
        const allowed = definition.allowedUnits ?? [];

        if (typeof unit !== 'string' || unit.length === 0) {
          return { code: 'UNIT_REQUIRED', message: `${definition.label} needs a unit.` };
        }
        // Units are constrained on purpose. "12 cm" and "120 mm" are the same
        // length and sort apart in a buyer's filter, so an unconstrained unit
        // field quietly breaks search rather than the form.
        if (allowed.length > 0 && !allowed.includes(unit)) {
          return {
            code: 'UNIT_NOT_ALLOWED',
            message: `${definition.label} must use one of: ${allowed.join(', ')}.`,
          };
        }
      }
      return null;
    }

    case 'DROPDOWN': {
      const allowed = (definition.allowedValues ?? []).map((option) => option.value);
      if (allowed.length > 0 && !allowed.includes(String(value))) {
        return {
          code: 'VALUE_NOT_ALLOWED',
          message: `${definition.label} is not one of the permitted options.`,
        };
      }
      return null;
    }

    case 'MULTI_SELECT': {
      if (!Array.isArray(value)) {
        return { code: 'NOT_A_LIST', message: `${definition.label} must be a list.` };
      }
      const allowed = (definition.allowedValues ?? []).map((option) => option.value);
      if (allowed.length > 0) {
        const stray = value.map(String).find((entry) => !allowed.includes(entry));
        if (stray !== undefined) {
          return {
            code: 'VALUE_NOT_ALLOWED',
            message: `${definition.label} contains an option that is not permitted: ${stray}.`,
          };
        }
      }
      return null;
    }

    case 'BOOLEAN':
      return typeof value === 'boolean'
        ? null
        : { code: 'NOT_A_BOOLEAN', message: `${definition.label} must be yes or no.` };

    case 'DATE':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? null
        : { code: 'NOT_A_DATE', message: `${definition.label} must be a date.` };

    case 'KEY_VALUE_LIST': {
      if (!Array.isArray(value)) {
        return { code: 'NOT_A_LIST', message: `${definition.label} must be a list of entries.` };
      }
      // The "In the box" group from the reference screens. Three refusals,
      // and each one is a real thing sellers submit: a row with a name and no
      // quantity, a row that is blank because they pressed "+" twice, and a
      // quantity of zero, which means the item is not in the box.
      for (const [index, entry] of value.entries()) {
        const row = entry as { name?: unknown; quantity?: unknown };
        const name = typeof row?.name === 'string' ? row.name.trim() : '';
        const quantity = asNumber(row?.quantity);

        if (name.length === 0) {
          return {
            code: 'EMPTY_ROW',
            message: `${definition.label}: entry ${String(index + 1)} has no name.`,
          };
        }
        if (quantity === null || quantity <= 0) {
          return {
            code: 'QUANTITY_INVALID',
            message: `${definition.label}: "${name}" needs a quantity above zero.`,
          };
        }
      }
      return null;
    }

    case 'TEXT':
    case 'LONG_TEXT':
    case 'RICH_TEXT':
    case 'DOCUMENT':
    default: {
      const text = String(value);
      if (definition.minLength !== null && definition.minLength !== undefined && text.trim().length < definition.minLength) {
        return {
          code: 'TOO_SHORT',
          message: `${definition.label} needs at least ${String(definition.minLength)} characters.`,
        };
      }
      if (definition.maxLength !== null && definition.maxLength !== undefined && text.length > definition.maxLength) {
        return {
          code: 'TOO_LONG',
          message: `${definition.label} cannot be longer than ${String(definition.maxLength)} characters.`,
        };
      }
      if (definition.pattern !== null && definition.pattern !== undefined && definition.pattern.length > 0) {
        let expression: RegExp;
        try {
          expression = new RegExp(definition.pattern);
        } catch {
          // A bad pattern is the operator's mistake, not the seller's. Refusing
          // the seller's value because an administrator typed a broken regex
          // would block a listing for a reason nobody on that screen can fix.
          return null;
        }
        if (!expression.test(text)) {
          return {
            code: 'PATTERN_MISMATCH',
            message: `${definition.label} is not in the expected format.`,
          };
        }
      }
      return null;
    }
  }
}

/**
 * Count every section, collect every issue, and say whether it can be
 * submitted.
 *
 * The counting rule, which is what the seller actually sees: a field counts as
 * completed when it holds a value AND that value passes its definition. A
 * field holding something invalid is NOT counted, and raises an ERROR on its
 * section - otherwise "8/8 complete" could sit above a red field, which is the
 * single most confusing thing a form of this size can do.
 */
export function evaluateListing(input: CompletenessInput): CompletenessResult {
  const issues: ListingIssue[] = [];
  const summaries = new Map<ListingSectionName, SectionSummary>();

  for (const section of LISTING_SECTIONS) {
    summaries.set(section, {
      section,
      completed: 0,
      total: 0,
      required: 0,
      missingRequired: 0,
      state: 'NOT_STARTED',
    });
  }

  const sectionHasError = new Set<ListingSectionName>();

  for (const definition of input.definitions) {
    // A regulatory field on a product that is not a regulated device is not
    // asked for and does not count towards anything.
    if (definition.isRegulatoryOnly === true && !input.isRegulatedDevice) continue;

    const summary = summaries.get(definition.section);
    if (summary === undefined) continue;

    summary.total += 1;
    if (definition.isRequired) summary.required += 1;

    const value = input.values[definition.attributeKey];
    const present = hasValue(value);

    if (!present) {
      if (definition.isRequired) {
        summary.missingRequired += 1;
        issues.push({
          severity: 'BLOCKER',
          code: 'REQUIRED_FIELD_MISSING',
          section: definition.section,
          attributeKey: definition.attributeKey,
          message: `${definition.label} is required.`,
        });
      }
      continue;
    }

    const failure = validateAttributeValue(definition, value);

    if (failure === null) {
      summary.completed += 1;
      continue;
    }

    sectionHasError.add(definition.section);
    if (definition.isRequired) summary.missingRequired += 1;

    issues.push({
      // An invalid value blocks whether or not the field was required: a
      // malformed UDI on an optional field is still a malformed UDI, and
      // publishing it would put a wrong identifier in front of a hospital.
      severity: 'BLOCKER',
      code: failure.code,
      section: definition.section,
      attributeKey: definition.attributeKey,
      message: failure.message,
    });
  }

  // --- Photographs -------------------------------------------------------
  //
  // Counted as their own section rather than as attributes, because a slot is
  // not a field: it is either filled with an acceptable image or it is not,
  // and the reasons it can be unacceptable (too small, blurred, duplicated,
  // watermarked) are checks on bytes rather than on a value.
  const photos = summaries.get('PRODUCT_PHOTOS');
  if (photos !== undefined) {
    const bySlot = new Map<string, UploadedMedia>();
    for (const item of input.media) {
      if (item.uploaded) bySlot.set(item.slot, item);
    }

    for (const slot of input.mediaSlots) {
      photos.total += 1;
      if (slot.isRequired) photos.required += 1;

      const uploaded = bySlot.get(slot.slot);

      if (uploaded === undefined) {
        if (slot.isRequired) {
          photos.missingRequired += 1;
          issues.push({
            severity: 'BLOCKER',
            code: 'REQUIRED_IMAGE_MISSING',
            section: 'PRODUCT_PHOTOS',
            attributeKey: slot.slot,
            message: `A ${slot.label.toLowerCase()} photograph is required.`,
          });
        }
        continue;
      }

      if (uploaded.rejectionCode !== null && uploaded.rejectionCode !== undefined && uploaded.rejectionCode.length > 0) {
        sectionHasError.add('PRODUCT_PHOTOS');
        if (slot.isRequired) photos.missingRequired += 1;
        issues.push({
          severity: 'BLOCKER',
          code: uploaded.rejectionCode,
          section: 'PRODUCT_PHOTOS',
          attributeKey: slot.slot,
          message: `The ${slot.label.toLowerCase()} photograph was not accepted.`,
        });
        continue;
      }

      photos.completed += 1;
    }
  }

  // --- The two commercial facts that are not attributes -------------------
  //
  // Price and stock live on the offer, not in `attributesJson`, so they are
  // checked here explicitly. Both are blockers: a listing with no price cannot
  // be bought, and one with no stock anywhere would go live out of stock,
  // which wastes the moderator's time as well as the buyer's.
  if (!input.hasPrice) {
    issues.push({
      severity: 'BLOCKER',
      code: 'PRICE_REQUIRED',
      section: 'PRICE_STOCK_SHIPPING',
      attributeKey: 'price',
      message: 'A price and currency are required before this can be reviewed.',
    });
  }

  if (!input.hasStock) {
    issues.push({
      // A warning rather than a blocker, and the difference is deliberate: a
      // seller who lists a made-to-order item has no stock to declare, and
      // refusing them would be refusing a legitimate way of selling. The
      // moderator sees it.
      severity: 'WARNING',
      code: 'NO_STOCK_ALLOCATED',
      section: 'PRICE_STOCK_SHIPPING',
      attributeKey: 'stock',
      message: 'No warehouse holds stock for this listing yet.',
    });
  }

  // --- Resolve each section's state --------------------------------------
  for (const summary of summaries.values()) {
    if (sectionHasError.has(summary.section)) {
      summary.state = 'ERROR';
    } else if (summary.required === 0) {
      // Nothing here is required. Complete once everything present is valid,
      // optional while it is untouched - never "incomplete", which would send
      // the seller looking for a blocker that does not exist.
      summary.state = summary.completed > 0 ? 'COMPLETE' : 'OPTIONAL';
    } else if (summary.missingRequired === 0) {
      summary.state = 'COMPLETE';
    } else if (summary.completed > 0) {
      summary.state = 'IN_PROGRESS';
    } else {
      summary.state = 'NOT_STARTED';
    }
  }

  return {
    sections: LISTING_SECTIONS.map((section) => summaries.get(section)).filter(
      (summary): summary is SectionSummary => summary !== undefined,
    ),
    issues,
    isSubmittable: !issues.some((issue) => issue.severity === 'BLOCKER'),
  };
}

/**
 * The pack hierarchy, checked.
 *
 * "One box of 100 units, ten boxes of 1,000 units must be calculated and
 * displayed consistently" - and the way that goes wrong is not usually a wrong
 * multiplication, it is a seller filling in three of the four figures and the
 * fourth being inferred differently in two places. So the total is computed
 * here, once, and any total the seller also typed is checked against it rather
 * than trusted.
 *
 * Integer arithmetic throughout. These are counts of physical things; a
 * fractional unit per pack is a data-entry error, not a half a syringe.
 */
export interface PackHierarchy {
  unitsPerPack?: number | null;
  packsPerBox?: number | null;
  boxesPerCarton?: number | null;
  cartonsPerPallet?: number | null;
  /** What the seller said the total was, if they said. */
  statedTotalUnits?: number | null;
}

export interface PackHierarchyResult {
  /** Sellable base units in one of the largest declared package. */
  totalUnits: number;
  issues: ListingIssue[];
}

export function evaluatePackHierarchy(pack: PackHierarchy): PackHierarchyResult {
  const issues: ListingIssue[] = [];

  const levels: { key: keyof PackHierarchy; label: string }[] = [
    { key: 'unitsPerPack', label: 'Units per pack' },
    { key: 'packsPerBox', label: 'Packs per box' },
    { key: 'boxesPerCarton', label: 'Boxes per carton' },
    { key: 'cartonsPerPallet', label: 'Cartons per pallet' },
  ];

  let total = 1;
  let sawAnyLevel = false;

  for (const level of levels) {
    const raw = pack[level.key];
    if (raw === null || raw === undefined) continue;

    const value = Number(raw);

    if (!Number.isInteger(value) || value <= 0) {
      issues.push({
        severity: 'BLOCKER',
        code: 'PACK_LEVEL_INVALID',
        section: 'PRICE_STOCK_SHIPPING',
        attributeKey: String(level.key),
        message: `${level.label} must be a whole number above zero.`,
      });
      continue;
    }

    sawAnyLevel = true;
    total *= value;
  }

  if (!sawAnyLevel) total = 1;

  const stated = pack.statedTotalUnits;
  if (stated !== null && stated !== undefined && Number(stated) !== total) {
    issues.push({
      severity: 'BLOCKER',
      code: 'PACK_TOTAL_MISMATCH',
      section: 'PRICE_STOCK_SHIPPING',
      attributeKey: 'statedTotalUnits',
      message: `The pack sizes multiply out to ${String(total)} units, not ${String(stated)}.`,
    });
  }

  return { totalUnits: total, issues };
}

/**
 * Volume price bands, checked.
 *
 * Two rules, and both are about what a buyer would see rather than about
 * tidiness: two bands starting at the same quantity means one quantity has two
 * prices and nobody can say which applies, and a band that is not cheaper than
 * the one below it means ordering more costs more, which a buyer will read as
 * a bug in the shop.
 */
export interface PriceTier {
  minQuantity: number;
  priceMinor: bigint;
}

export function evaluatePriceTiers(
  basePriceMinor: bigint,
  tiers: readonly PriceTier[],
): ListingIssue[] {
  const issues: ListingIssue[] = [];
  const sorted = [...tiers].sort((a, b) => a.minQuantity - b.minQuantity);

  let previousQuantity: number | null = null;
  let previousPrice = basePriceMinor;

  for (const tier of sorted) {
    if (!Number.isInteger(tier.minQuantity) || tier.minQuantity < 2) {
      issues.push({
        severity: 'BLOCKER',
        code: 'TIER_QUANTITY_INVALID',
        section: 'PRICE_STOCK_SHIPPING',
        attributeKey: 'priceTiers',
        message: 'A volume band has to start at two or more.',
      });
      continue;
    }

    if (previousQuantity !== null && tier.minQuantity === previousQuantity) {
      issues.push({
        severity: 'BLOCKER',
        code: 'TIER_QUANTITY_DUPLICATE',
        section: 'PRICE_STOCK_SHIPPING',
        attributeKey: 'priceTiers',
        message: `Two volume bands both start at ${String(tier.minQuantity)}.`,
      });
      continue;
    }

    if (tier.priceMinor >= previousPrice) {
      issues.push({
        severity: 'BLOCKER',
        code: 'TIER_NOT_CHEAPER',
        section: 'PRICE_STOCK_SHIPPING',
        attributeKey: 'priceTiers',
        message: `The band from ${String(tier.minQuantity)} is not cheaper than the one below it.`,
      });
    }

    previousQuantity = tier.minQuantity;
    previousPrice = tier.priceMinor;
  }

  return issues;
}
