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
import { env } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PUBLIC_PACKAGING_SELECT } from './packaging.service.js';

/**
 * The only `where` fragment permitted on a public product read.
 *
 * Five conditions, each load-bearing:
 *   status ACTIVE     - not draft, not deactivated
 *   isPublished       - explicitly published by an authorised admin
 *   archivedAt null   - not soft-deleted
 *   category active   - an archived category takes its products with it, so
 *                       retiring a range does not leave orphans reachable by
 *                       direct URL
 *   demoEntry is null - unless this deployment has asked for the
 *                       demonstration catalogue; see below
 */
export function publicProductWhere(): Prisma.ProductWhereInput {
  return {
    status: 'ACTIVE',
    isPublished: true,
    archivedAt: null,
    category: { isActive: true, archivedAt: null },
    ...demoCatalogWhere(),
  };
}

/**
 * Whether the demonstration catalogue is on the shelf.
 *
 * `ENABLE_DEMO_CATALOG=false` does not delete anything and does not unpublish
 * anything. It adds one condition to the single filter every public catalogue
 * read already goes through, and every product the demonstration seed planted
 * leaves the storefront together - out of the grid, out of search, out of the
 * facet counts and out of its own URL, which 404s like any other product that
 * is not for sale here.
 *
 * Done here rather than by unpublishing, because unpublishing is the
 * operator's decision about their own catalogue and this is a deployment
 * setting. An operator who has switched the demonstration catalogue off and
 * then publishes a product by hand in the admin panel must not find it
 * invisible; an operator who switches it back on must not have to re-publish
 * four hundred rows.
 *
 * The empty object when it is ON is deliberate: a deployment that wants the
 * demonstration catalogue adds NO condition at all, so the query planner sees
 * exactly the query it saw before this existed.
 */
function demoCatalogWhere(): Prisma.ProductWhereInput {
  return env.ENABLE_DEMO_CATALOG ? {} : { demoEntry: null };
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

  /**
   * Public because they change what the page offers to do.
   *
   * `isPriceOnRequest` replaces the price with an invitation to ask for one,
   * and `isOrderable` replaces the buy controls with a notice. A storefront
   * that could not see them would render a price of zero beside a working Add
   * to basket button, which is the worst of every available outcome.
   */
  isPriceOnRequest: true,
  isOrderable: true,
  unavailabilityReason: true,
  minOrderQty: true,
  maxOrderQty: true,
  qtyIncrement: true,
  isRecurringEligible: true,
  isStockTracked: true,

  /**
   * Public because it decides what the price on the card MEANS.
   *
   * The operator sells cartons, so the operator's per-piece figure is rendered
   * as a carton total. A third-party seller sells pieces, and rendering their
   * offer the same way multiplies it by five hundred on the shopper's screen
   * before they have clicked anything. A storefront that could not see this
   * flag has no way to tell the two apart, and the bug it caused was silent in
   * exactly that way - every number was real, and one of them was five hundred
   * times too big.
   */
  isMarketplaceProduct: true,

  /**
   * Public because it decides what the figure beside it is a price FOR.
   *
   * Null is a piece, which is what most of a general catalogue is sold as. A
   * number is a carton of that many, and the card multiplies by it - which is
   * right for a box of five hundred cannulas and was catastrophically wrong
   * for the cordless drill it used to be applied to as well, because the
   * carton used to be a property of the whole shop rather than of the product.
   *
   * The storefront never reads this to do its own arithmetic; `sellUnit` on
   * the same response is the answer, computed from this on the same code path
   * the basket uses. It travels so the product page can say "one carton has
   * 500 pieces" only where that sentence is true.
   */
  piecesPerCarton: true,
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
      /**
       * The materialised ancestor trail, so the variant template for a shelf
       * an operator added under one of ours can be resolved without a walk up
       * the tree. See `findTemplate`: lookup is nearest-slug-first, and a
       * "Safety Boots" an operator created under "Footwear" inherits
       * Footwear's axes because that is what a subcategory of it is.
       */
      path: true,
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
    select: { name: true, value: true, sortOrder: true, groupKey: true, unit: true, isHighlight: true },
    orderBy: { sortOrder: 'asc' },
  },

  /**
   * The description's sections: a heading and plain text each, with a picture
   * where the seller chose one. Active ones in every language; the route
   * shows the reader's language's set when there is one, else the product's own
   * (`descriptionSectionsFor`).
   */
  descriptionSections: {
    where: { isActive: true },
    select: {
      heading: true,
      body: true,
      language: true,
      altText: true,
      sortOrder: true,
      image: { select: { url: true, altText: true, width: true, height: true } },
    },
    orderBy: { sortOrder: 'asc' },
  },

  /**
   * How it is packed, and what a carton holds.
   *
   * Public, and load-bearing rather than decorative: it is what a buyer orders
   * by. The internal columns of the same import - licence status, production
   * capacity, the operator's workflow state - live on another table entirely
   * and cannot arrive here by accident.
   *
   * The sticker artwork dimension is excluded by name. It is a print
   * specification for the operator's label supplier, not a fact about the
   * product, and putting a label's size in a list of box sizes would have a
   * buyer measuring a shelf against it.
   */
  /**
   * The product-level row only - `variantKey` is the empty string.
   *
   * A grid of two dozen products does not need thirty packing rows each, and
   * selecting them all here would drag several thousand rows across the wire to
   * render one line of summary text per card. The import writes this row
   * alongside the per-variant ones for exactly this read; the detail page asks
   * for the rest separately. See `packaging.service.ts`.
   */
  packagings: {
    where: { variantKey: '' },
    select: PUBLIC_PACKAGING_SELECT,
    take: 1,
  },

  /**
   * The dimensions this product sells along, as template axis keys.
   *
   * Public because the storefront cannot draw a selector without them. Only
   * the keys travel; the labels, units and sort orders are served by
   * `/catalog/variant-axes`, which the storefront caches for the session -
   * sending 112 templates' worth of definitions on every product read would be
   * the same data over and over.
   *
   * Null or empty means "no declared axes", and the storefront then shows the
   * option list it has always shown. That is what keeps Medical Devices, where
   * a hospital buyer picks several sizes at once, working as it does.
   */
  variantAxesJson: true,

  variants: {
    // A deactivated variant must not be selectable on the storefront.
    where: { isActive: true, archivedAt: null },
    select: {
      id: true,
      sku: true,
      name: true,
      // Specifications that differ for this variant. See `shownSpecifications`.
      attributes: {
        select: { name: true, value: true, unit: true, groupKey: true, sortOrder: true },
        orderBy: { sortOrder: 'asc' },
      },
      optionsJson: true,
      priceMinor: true,
      sortOrder: true,
      gtin: true,
      modelIdentifier: true,

      /**
       * Public because every one of these changes what the buy panel says
       * BEFORE the button is pressed.
       *
       * A minimum of ten discovered at the cart has wasted the buyer twice; a
       * pack of ten discovered on the delivery note has sent them ten times
       * what they meant to buy. Both are on the product page or they are a
       * surprise.
       *
       * Stock quantities are deliberately still not among them. This
       * storefront does not publish warehouse figures, and a variant selector
       * is not the place to start.
       */
      compareAtPriceMinor: true,
      minOrderQty: true,
      qtyIncrement: true,
      maxOrderQty: true,
      leadTimeDays: true,
      multipackCount: true,
      netContentValue: true,
      netContentUnit: true,
      unitPricingBaseValue: true,
      unitPricingBaseUnit: true,
      manufacturerPackLabel: true,

      /** This size's own photographs, falling back to the family's. */
      media: {
        select: {
          isPrimary: true,
          sortOrder: true,
          media: { select: { url: true, altText: true, width: true, height: true } },
        },
        orderBy: { sortOrder: 'asc' },
      },
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
  isPriceOnRequest: boolean;
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
  //
  // Unless the operator has said the price is deliberately not published, which
  // is a real and common thing to say about a B2B range quoted per account. The
  // check is not skipped so much as satisfied a different way: a product priced
  // on request cannot be added to a basket at all, so there is no path by which
  // its zero reaches a total.
  if (input.basePriceMinor <= 0n && !input.isPriceOnRequest) {
    blockers.push({
      field: 'basePriceMinor',
      code: 'PRICE_REQUIRED',
      message: 'Set a price greater than zero, or mark this product as priced on request.',
    });
  }

  // A product with a real price still needs a picture. One priced on request
  // does not: the neutral placeholder the grid already draws is an honest
  // answer to "we have not photographed this yet", and requiring a photograph
  // before a specification sheet can be published would keep a catalogue of
  // several hundred genuine products entirely invisible while somebody
  // arranges a photoshoot. The listing is a specification either way.
  if (input.mediaCount === 0 && !input.isPriceOnRequest) {
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
