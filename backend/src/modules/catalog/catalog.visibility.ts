/**
 * Public visibility.
 *
 * The SOP's core operating principle (section 2.1): a product reaches the
 * Customer Website only after an authorised administrator marks it Active AND
 * Published.
 *
 * That rule lives in exactly one place - this file - and every public read goes
 * through it. The alternative, each route composing its own `where` clause, is
 * how a draft product eventually leaks: one endpoint forgets one condition, and
 * nothing fails loudly.
 */
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * The only `where` fragment permitted on a public product read.
 *
 * Four conditions, each load-bearing:
 *   status ACTIVE     - not draft, not deactivated
 *   isPublished       - explicitly published by an authorised admin
 *   archivedAt null   - not soft-deleted
 *   category active   - an archived category takes its products with it, so
 *                       retiring a range does not leave orphans reachable by
 *                       direct URL
 */
export function publicProductWhere(): Prisma.ProductWhereInput {
  return {
    status: 'ACTIVE',
    isPublished: true,
    archivedAt: null,
    category: { isActive: true, archivedAt: null },
  };
}

/** Public category visibility. */
export function publicCategoryWhere(): Prisma.CategoryWhereInput {
  return { isActive: true, archivedAt: null };
}

/**
 * Fields safe to return on a public product read.
 *
 * An allowlist, not an exclusion list. Adding an internal column to the schema
 * must not silently expose it - cost price, internal notes and supplier data
 * stay invisible because they were never named here.
 */
const PUBLIC_PRODUCT_SELECT_BASE = {
  id: true,
  name: true,
  slug: true,
  sku: true,
  shortDescription: true,
  description: true,
  descriptionHtml: true,
  basePriceMinor: true,
  compareAtPriceMinor: true,
  currency: true,
  minOrderQty: true,
  maxOrderQty: true,
  qtyIncrement: true,
  isRecurringEligible: true,
  isStockTracked: true,
  hasVariants: true,
  publishedAt: true,
  metaTitle: true,
  metaDescription: true,

  /**
   * GPSR Art. 19. Public because the whole point of the article is that a
   * buyer sees this BEFORE they buy - who made it, how to reach them, what it
   * is, and what the warnings are. Hiding any of it behind checkout is the
   * non-compliance the regulation was written about.
   */
  gtin: true,
  modelIdentifier: true,
  safetyWarnings: true,
  safetyInstructions: true,

  /**
   * MDR device identification, where the product is one.
   *
   * Public for the same reason the GPSR block is: a buyer comparing devices
   * needs the class, the notified body and the UDI before they commit, and a
   * hospital's procurement team will not place an order without them.
   */
  deviceInfo: {
    select: {
      deviceClass: true,
      basicUdiDi: true,
      udiDi: true,
      notifiedBodyNumber: true,
      declarationOfConformityUrl: true,
      intendedPurpose: true,
      isSterile: true,
      isSingleUse: true,
      hasMeasuringFunction: true,
      containsBiologicalMaterial: true,
    },
  },
  manufacturer: {
    select: {
      legalName: true,
      tradeName: true,
      addressJson: true,
      countryCode: true,
      email: true,
      phone: true,
      website: true,
      // MDR Art. 31. Named on the listing because a buyer's compliance team
      // asks for it and would otherwise have to write and wait.
      eudamedSrn: true,
    },
  },
  euResponsible: {
    select: {
      legalName: true,
      tradeName: true,
      addressJson: true,
      countryCode: true,
      email: true,
      phone: true,
      website: true,
    },
  },

  /**
   * At most one translation row, chosen by the caller's language.
   *
   * Selected here rather than joined per query so every public read gets the
   * same shape, and `applyProductCopy` has something to layer over the base
   * columns. `take: 1` with a `language` filter is a point lookup on the
   * unique index, not a scan.
   */
  translations: {
    select: {
      language: true,
      name: true,
      shortDescription: true,
      description: true,
      metaTitle: true,
      metaDescription: true,
      safetyWarnings: true,
      safetyInstructions: true,
      intendedPurpose: true,
    },
    take: 1,
  },

  category: {
    select: {
      id: true,
      name: true,
      slug: true,
      translations: { select: { name: true }, take: 1 },
    },
  },
  taxClass: {
    select: {
      code: true,
      name: true,
      ratePercent: true,
      isInclusive: true,
      // The EU band, so a public price can be quoted at the destination member
      // state's rate rather than at whatever the class's flat percentage says.
      vatCategory: true,
    },
  },
  media: {
    select: {
      sortOrder: true,
      isPrimary: true,
      media: { select: { url: true, altText: true, width: true, height: true } },
    },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
  },
  attributes: {
    select: { name: true, value: true, sortOrder: true },
    orderBy: { sortOrder: 'asc' },
  },
  variants: {
    // A deactivated variant must not be selectable on the storefront.
    where: { isActive: true, archivedAt: null },
    select: {
      id: true,
      sku: true,
      name: true,
      optionsJson: true,
      priceMinor: true,
      sortOrder: true,
    },
    orderBy: { sortOrder: 'asc' },
  },
} as const satisfies Prisma.ProductSelect;

/**
 * Everything a product needs before it may be published.
 *
 * Publication is the moment a product becomes buyable, so the incomplete cases
 * are caught here rather than surfacing as a broken storefront page or an order
 * priced at zero.
 */
export interface PublishValidationInput {
  name: string;
  slug: string;
  sku: string;
  shortDescription: string | null;
  description: string | null;
  basePriceMinor: bigint;
  minOrderQty: number;
  maxOrderQty: number | null;
  qtyIncrement: number;
  hasVariants: boolean;
  mediaCount: number;
  activeVariantCount: number;
  categoryIsActive: boolean;
}

export interface PublishBlocker {
  field: string;
  code: string;
  message: string;
}

/**
 * Return every reason a product cannot be published, not just the first, so the
 * Admin Panel can show a complete checklist instead of one error at a time.
 */
export function validateForPublish(input: PublishValidationInput): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];

  if (input.name.trim().length === 0) {
    blockers.push({ field: 'name', code: 'REQUIRED', message: 'A product name is required.' });
  }

  if (input.slug.trim().length === 0) {
    blockers.push({ field: 'slug', code: 'REQUIRED', message: 'A URL slug is required.' });
  }

  if (input.sku.trim().length === 0) {
    blockers.push({ field: 'sku', code: 'REQUIRED', message: 'A SKU is required.' });
  }

  const hasCopy =
    (input.shortDescription?.trim().length ?? 0) > 0 || (input.description?.trim().length ?? 0) > 0;
  if (!hasCopy) {
    blockers.push({
      field: 'description',
      code: 'REQUIRED',
      message: 'Add a short or full description before publishing.',
    });
  }

  // A zero price is almost always an unfinished draft rather than a giveaway.
  // Publishing one would let customers order stock for nothing.
  if (input.basePriceMinor <= 0n) {
    blockers.push({
      field: 'basePriceMinor',
      code: 'PRICE_REQUIRED',
      message: 'Set a price greater than zero before publishing.',
    });
  }

  if (input.mediaCount === 0) {
    blockers.push({
      field: 'media',
      code: 'IMAGE_REQUIRED',
      message: 'Add at least one product image before publishing.',
    });
  }

  if (input.minOrderQty < 1) {
    blockers.push({
      field: 'minOrderQty',
      code: 'INVALID',
      message: 'Minimum order quantity must be at least 1.',
    });
  }

  if (input.qtyIncrement < 1) {
    blockers.push({
      field: 'qtyIncrement',
      code: 'INVALID',
      message: 'Quantity increment must be at least 1.',
    });
  }

  if (input.maxOrderQty !== null && input.maxOrderQty < input.minOrderQty) {
    blockers.push({
      field: 'maxOrderQty',
      code: 'INVALID_RANGE',
      message: 'Maximum order quantity cannot be lower than the minimum.',
    });
  }

  // A variant product with no sellable variant renders an empty selector and
  // cannot be added to a cart.
  if (input.hasVariants && input.activeVariantCount === 0) {
    blockers.push({
      field: 'variants',
      code: 'NO_ACTIVE_VARIANTS',
      message: 'This product uses variants but has no active variant to sell.',
    });
  }

  if (!input.categoryIsActive) {
    blockers.push({
      field: 'categoryId',
      code: 'CATEGORY_INACTIVE',
      message: 'Its category is inactive, so the product would not be reachable.',
    });
  }

  return blockers;
}

/**
 * URL slug from a display name.
 *
 * Uniqueness is enforced by a database unique index, not here - this only
 * produces a candidate.
 */
export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      // Strip combining marks so accented characters degrade to their base form.
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200)
  );
}

/**
 * The public product select, filtered to one language's translation.
 *
 * A function rather than a constant because the language is per request and
 * Prisma's nested `where` cannot be parameterised after the fact. The
 * alternative - selecting every language and picking in code - would drag
 * seven copies of every description across the wire for a 24-product grid.
 *
 * Passing null selects no translation rows at all, which is what an
 * unlocalised caller (the admin panel, an export) wants.
 */
export function publicProductSelect(language: string | null) {
  return {
    ...PUBLIC_PRODUCT_SELECT_BASE,
    translations: {
      ...PUBLIC_PRODUCT_SELECT_BASE.translations,
      // `language: ''` can never match a stored row, so this is an empty
      // result rather than a special case at every call site.
      where: { language: language ?? '' },
    },
    category: {
      select: {
        ...PUBLIC_PRODUCT_SELECT_BASE.category.select,
        translations: {
          ...PUBLIC_PRODUCT_SELECT_BASE.category.select.translations,
          where: { language: language ?? '' },
        },
      },
    },
  } as const;
}

/**
 * The shape above, for typing a row that came back from it. Identical whatever
 * language was asked for - only the contents of `translations` differ.
 */
export const PUBLIC_PRODUCT_SELECT = publicProductSelect(null);
