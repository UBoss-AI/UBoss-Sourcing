/**
 * The curated shelves on the landing page.
 *
 * WHAT A COLLECTION IS ALLOWED TO BE
 *
 * A set of DEPARTMENTS, named by slug. That is the whole definition, and the
 * restriction is the point: every product on these shelves is there because an
 * administrator filed it under one of these departments, which is a fact about
 * the catalogue rather than a claim about the product.
 *
 * WHAT A COLLECTION IS NOT ALLOWED TO BE
 *
 * "Trending", "Best sellers", "Most popular", "Customer favourites". This
 * software has no sales figures on the storefront and no view counts, so every
 * one of those would be a sentence made up to fill a heading - and a shopper
 * who works out that "Best sellers" is arbitrary stops believing the prices
 * too. `home.newArrivals` is the one shelf that makes a claim, and it is one
 * the API can actually answer: `sort=newest` is publication date.
 *
 * WHEN A DEPARTMENT IS MISSING
 *
 * Nothing breaks and nothing is reported. These are the slugs the starter
 * catalogue plants, and an operator is free to rename, re-parent or retire any
 * of them - this is a product other companies buy and run. A slug the
 * catalogue does not have is dropped by the API (see `resolveFilters`), so a
 * collection narrows rather than emptying, and a collection that comes back
 * with nothing renders nothing at all rather than an empty box with a heading
 * over it.
 */
import type { TranslationKey } from '@/i18n/i18n-context';

export interface Collection {
  /** Stable id: the query key and the heading's `id` are built from it. */
  readonly id: string;
  readonly titleKey: TranslationKey;
  readonly blurbKey: TranslationKey;
  /** Department slugs, sent to `/catalog/products?category=` as one list. */
  readonly categories: readonly string[];
}

export const COLLECTIONS: readonly Collection[] = Object.freeze([
  {
    id: 'business-essentials',
    titleKey: 'home.collectionBusinessEssentials',
    blurbKey: 'home.collectionBusinessEssentialsBlurb',
    categories: ['office-stationery', 'packaging-shipping', 'cleaning-hygiene', 'furniture-fixtures'],
  },
  {
    id: 'industrial-professional',
    titleKey: 'home.collectionIndustrial',
    blurbKey: 'home.collectionIndustrialBlurb',
    categories: [
      'industrial-supplies',
      'tools-hardware',
      'electrical-lighting',
      'safety-protective-equipment',
      'building-construction',
    ],
  },
  {
    id: 'technology-electronics',
    titleKey: 'home.collectionTechnology',
    blurbKey: 'home.collectionTechnologyBlurb',
    categories: ['computers-it', 'phones-communication', 'electronics-components'],
  },
  {
    id: 'home-lifestyle',
    titleKey: 'home.collectionLifestyle',
    blurbKey: 'home.collectionLifestyleBlurb',
    categories: [
      'home-kitchen',
      'clothing-textiles',
      'beauty-personal-care',
      'sports-outdoors',
      'toys-hobbies-crafts',
    ],
  },
]);

/**
 * How many cards one collection shows.
 *
 * Six: three across at `lg`, two at `sm`, and a full row either way. Four
 * collections at six is twenty-four cards, plus six new arrivals - thirty
 * products on a landing page, which is a shop front rather than a catalogue
 * dump. The whole four hundred are one click away on `/catalog`.
 */
export const COLLECTION_SIZE = 6;
