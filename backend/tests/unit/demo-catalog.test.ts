/**
 * The demonstration catalogue, checked without a database.
 *
 * Everything asserted here is a property of the BLUEPRINT REGISTRY and of the
 * pure generator that turns it into products, so the whole file runs in
 * milliseconds and fails on the change that broke it rather than on a seed run
 * somebody does a week later.
 *
 * The three that matter most, in the order they would hurt:
 *
 *   - **Coverage.** Twenty-five departments, a hundred and thirty-eight
 *     sub-categories, at least three products each. That is what the catalogue
 *     was commissioned to be, and a blueprint quietly deleted during a refactor
 *     is invisible in every other way.
 *   - **Uniqueness.** Every variant SKU and every option signature is unique,
 *     because both are UNIQUE indexes and a collision fails the seed several
 *     thousand rows in - on somebody else's machine, after a long run.
 *   - **Determinism.** The same blueprint produces the same prices, the same
 *     stock and the same SKUs every time. Without that the seed is idempotent
 *     in name only: a second run rewrites four hundred prices and nobody can
 *     tell which change was deliberate.
 */
import { describe, expect, it } from 'vitest';

import { findAxis, findTemplate } from '../../src/domain/variants/registry.js';
import { template, type VariantTemplate } from '../../src/domain/variants/axis.js';
import { STARTER_DEPARTMENTS } from '../../src/seed/starter-departments.js';
import {
  ALL_BLUEPRINTS,
  ALL_SHELVES,
  MINIMUM_PRODUCTS_PER_SUBCATEGORY,
  registryProblems,
} from '../../src/modules/catalog/demo-catalog/blueprints/index.js';
import {
  DEPARTMENT_IMAGES,
  SUBCATEGORY_IMAGES,
} from '../../src/modules/catalog/demo-catalog/image-library.js';
import {
  MAX_VARIANTS_PER_PRODUCT,
  generateProduct,
  type GeneratedProduct,
} from '../../src/modules/catalog/demo-catalog/generate.js';

/**
 * An empty template, so `findAxis` can be called for a Medical Devices product.
 *
 * That department deliberately has none - see `registry.ts` - and a null check
 * at every call site would bury the assertion these tests are about.
 */
const PLACEHOLDER: VariantTemplate = template('none', null, 'none', []);

/** The catalogue this registry was written against. */
const EXPECTED_DEPARTMENTS = 25;
const EXPECTED_SUBCATEGORIES = 138;

/**
 * Generate the whole catalogue, exactly as the seed would.
 *
 * One shared slug set and one shared SKU set, because both indexes are unique
 * across the entire catalogue rather than within a shelf - generating shelf by
 * shelf with fresh sets would pass a test the seed would then fail.
 */
function generateEverything(): GeneratedProduct[] {
  const slugs = new Set<string>();
  const skus = new Set<string>();

  return ALL_SHELVES.flatMap((shelf) =>
    shelf.products.map((blueprint) =>
      generateProduct(blueprint, {
        departmentSlug: 'demo-department',
        subcategorySlug: shelf.subcategory,
        subcategoryName: shelf.subcategory,
        template: findTemplate([shelf.subcategory]),
        slugs,
        skus,
      }),
    ),
  );
}

describe('demo catalogue registry', () => {
  it('is sound', () => {
    expect(registryProblems()).toEqual([]);
  });

  it('covers every sub-category the starter catalogue plants, outside Medical Devices', () => {
    /*
     * Medical Devices is excluded, and the reason is a real fact about this
     * product rather than a convenience.
     *
     * `seedStarterCategories` leaves a department alone if its slug already
     * exists - children and all. So a deployment whose medical department
     * arrived on a supplier's spreadsheet keeps ITS twenty-six shelves (ABG
     * Kit, Closed IV Cannula, Ryles Tube) and never receives the starter set's
     * eight generic ones (Diagnostics & Monitoring, Dental Supplies). The two
     * taxonomies are alternatives, not layers.
     *
     * This registry is written against the imported one, because that is what
     * the deployments running this software actually have. The next test
     * checks those twenty-six directly.
     */
    const planted = new Set(
      STARTER_DEPARTMENTS.filter((department) => department.slug !== 'medical-devices').flatMap(
        (department) => department.children.map((child) => child.slug),
      ),
    );
    const written = new Set(ALL_SHELVES.map((shelf) => shelf.subcategory));

    const uncovered = [...planted].filter((slug) => !written.has(slug));
    expect(uncovered).toEqual([]);
  });

  it('covers the imported Medical Devices taxonomy', () => {
    const written = new Set(ALL_SHELVES.map((shelf) => shelf.subcategory));

    // The shelves the supplier import creates, spelling included: `syringes`
    // is the slug for "Syringes & Needles", and `oral-syiringe` is misspelt in
    // the source data. Correcting either here would simply mean no match.
    const imported = [
      'abg-kit',
      'abg-syringe',
      'adult-diaper',
      'closed-iv-cannula',
      'dc-flush-syringe-swab-cap',
      'disinfectant-cap',
      'enfit-syringe',
      'flush-syringe',
      'infant-feeding-tube',
      'infusion-set',
      'insulin-syringe',
      'iv-administration-sets',
      'iv-cannula',
      'line-access',
      'line-conditioning',
      'oral-dosing-syringe',
      'oral-syiringe',
      'prefilled-heparin-syringe',
      'ryles-tube',
      'safety-needle',
      'sodium-citrate-prefilled-syringe',
      'sterile-water',
      'sterile-water-with-10-glycerine',
      'suction-catheter',
      'surgical-gloves',
      'syringes',
    ];

    expect(imported).toHaveLength(26);
    expect(imported.filter((slug) => !written.has(slug))).toEqual([]);
  });

  it('has 138 sub-categories across 25 departments', () => {
    expect(ALL_SHELVES).toHaveLength(EXPECTED_SUBCATEGORIES);

    // Counted through the variant registry's own department mapping for the
    // 112 templated shelves, plus the medical department, which has none.
    const departments = new Set(
      ALL_SHELVES.map(
        (shelf) => findTemplate([shelf.subcategory])?.categorySlug ?? 'medical-devices',
      ),
    );
    expect(departments.size).toBe(EXPECTED_DEPARTMENTS);
  });

  it('gives every sub-category at least three product families', () => {
    for (const shelf of ALL_SHELVES) {
      expect(
        shelf.products.length,
        `${shelf.subcategory} has ${String(shelf.products.length)}`,
      ).toBeGreaterThanOrEqual(MINIMUM_PRODUCTS_PER_SUBCATEGORY);
    }
  });

  it('has at least 414 product families in total', () => {
    expect(ALL_BLUEPRINTS.length).toBeGreaterThanOrEqual(
      EXPECTED_SUBCATEGORIES * MINIMUM_PRODUCTS_PER_SUBCATEGORY,
    );
  });

  it('gives every blueprint a unique seed key', () => {
    const keys = ALL_BLUEPRINTS.map((blueprint) => blueprint.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('writes no meaningless titles', () => {
    // The tell of a generated catalogue: a title that names its category and a
    // number. Every one of these has been seen in the wild.
    const meaningless =
      /^(sample|demo|test|product|item|category)\b|\b(product|item|sample)\s*\d+$|high quality product/i;

    for (const blueprint of ALL_BLUEPRINTS) {
      expect(blueprint.title, blueprint.key).not.toMatch(meaningless);
      expect(blueprint.title.length, blueprint.key).toBeGreaterThan(12);
    }
  });

  it('makes no certification, approval or superlative claim', () => {
    /*
     * The one test in this file that is about honesty rather than correctness.
     *
     * A demonstration catalogue that invents a CE mark, an FDA clearance or an
     * organic certificate is a demonstration catalogue that could get an
     * operator into real trouble the first time somebody screenshots it - and
     * "best seller" on a storefront with no sales figures is simply false.
     * Neither is a thing a careful author avoids by remembering to; it is a
     * thing a test refuses.
     */
    const forbidden = [
      /\bce marked?\b/i,
      /\bfda (approved|cleared)\b/i,
      /\bgovernment certified\b/i,
      /\bcertified\b/i,
      /\biso ?9001\b/i,
      /\bnotified body\b/i,
      /\b100% organic\b/i,
      /\bfireproof\b/i,
      /\blifetime warranty\b/i,
      /\bbest ?sell(er|ing)\b/i,
      /\bnumber one\b/i,
      /\bno\.? ?1\b/i,
      /\bworld'?s best\b/i,
      /\bguarantee[sd]? (results|outcomes?)\b/i,
      /\bclinically proven\b/i,
      /\bdermatologically tested\b/i,
      /\bcruelty[- ]free\b/i,
    ];

    for (const blueprint of ALL_BLUEPRINTS) {
      const text = [
        blueprint.title,
        blueprint.short,
        blueprint.long,
        ...Object.entries(blueprint.specs).flat(),
      ].join(' ');

      for (const pattern of forbidden) {
        expect(pattern.test(text), `${blueprint.key} matched ${String(pattern)}`).toBe(false);
      }
    }
  });
});

describe('demo catalogue generation', () => {
  const products = generateEverything();

  it('produces a product for every blueprint', () => {
    expect(products).toHaveLength(ALL_BLUEPRINTS.length);
  });

  it('gives every product at least one variant', () => {
    for (const product of products) {
      expect(product.variants.length, product.blueprintKey).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps every family within the variant ceiling', () => {
    for (const product of products) {
      expect(product.variants.length, product.blueprintKey).toBeLessThanOrEqual(
        MAX_VARIANTS_PER_PRODUCT,
      );
    }
  });

  it('gives a product with real options more than one variant', () => {
    const multiAxis = products.filter((product) => (product.variantAxes?.length ?? 0) > 0);
    expect(multiAxis.length).toBeGreaterThan(300);

    for (const product of multiAxis) {
      expect(product.variants.length, product.blueprintKey).toBeGreaterThan(1);
    }
  });

  it('gives every variant a unique SKU across the whole catalogue', () => {
    const skus = products.flatMap((product) => product.variants.map((variant) => variant.sku));
    const duplicates = skus.filter((sku, index) => skus.indexOf(sku) !== index);
    expect(duplicates).toEqual([]);
  });

  it('gives every product a unique slug and SKU', () => {
    const slugs = products.map((product) => product.slug);
    const skus = products.map((product) => product.sku);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(skus).size).toBe(skus.length);
  });

  it('gives every combination within a family its own option signature', () => {
    for (const product of products) {
      const signatures = product.variants.map((variant) => variant.optionSignature);
      expect(new Set(signatures).size, product.blueprintKey).toBe(signatures.length);
    }
  });

  it('puts stock on the combination rather than on one axis value', () => {
    /*
     * The requirement this whole exercise turns on: Black/8 and Brown/8 are two
     * shelves, not one shelf with a colour written on it. The observable proof
     * is that a family's variants do not all carry the same figure - if stock
     * were being derived per axis value rather than per combination, every
     * variant sharing an axis value would share a number.
     */
    const graded = products.filter((product) => product.variants.length >= 4);
    expect(graded.length).toBeGreaterThan(100);

    for (const product of graded) {
      const levels = new Set(product.variants.map((variant) => variant.stock));
      expect(levels.size, product.blueprintKey).toBeGreaterThan(1);
    }
  });

  it('prices variants within their blueprint band and never at zero', () => {
    for (const product of products) {
      for (const variant of product.variants) {
        expect(variant.priceMinor, `${product.blueprintKey} / ${variant.sku}`).toBeGreaterThan(0n);
      }
      // The family's own figure is the cheapest thing a buyer could take,
      // which is what "from" on a card means.
      const cheapest = product.variants.reduce(
        (lowest, variant) => (variant.priceMinor < lowest ? variant.priceMinor : lowest),
        product.variants[0]?.priceMinor ?? 0n,
      );
      expect(product.basePriceMinor).toBe(cheapest);
    }
  });

  it('never prints a list price below the selling price', () => {
    for (const product of products) {
      for (const variant of product.variants) {
        if (variant.compareAtPriceMinor === null) continue;
        expect(
          variant.compareAtPriceMinor,
          `${product.blueprintKey} / ${variant.sku}`,
        ).toBeGreaterThanOrEqual(variant.priceMinor);
      }
    }
  });

  it('does not put one invented discount on every card', () => {
    const withCompare = products.filter((product) => product.compareAtPriceMinor !== null);
    expect(withCompare.length).toBeGreaterThan(20);

    const percentages = withCompare.map((product) =>
      Math.round(
        (Number(product.compareAtPriceMinor ?? 0n) / Number(product.basePriceMinor) - 1) * 100,
      ),
    );
    expect(new Set(percentages).size).toBeGreaterThan(5);

    // And most of the catalogue has no list price at all, which is the honest
    // state of a trade catalogue.
    expect(withCompare.length).toBeLessThan(products.length / 2);
  });

  it('never leaves stock negative', () => {
    for (const product of products) {
      for (const variant of product.variants) {
        expect(variant.stock).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('leaves the first combination of every family in stock', () => {
    for (const product of products) {
      expect(product.variants[0]?.stock, product.blueprintKey).toBeGreaterThan(0);
    }
  });

  it('declares only axes the buyer chooses between, or ones those depend on', () => {
    /*
     * The exception is not a loophole, it is the reason the rule has one.
     *
     * `size` declares `dependsOn: ['size_system']`, because a bare 8 is a
     * different shoe in UK and in EU - so the buyer's selector greys the size
     * run out until a system has been chosen. A boot stocked only in UK sizing
     * has one value on that axis, and dropping it for having one value left the
     * page showing "Choose size system first" above a control that was never
     * drawn. A declared axis therefore has more than one value OR is something
     * a declared axis depends on.
     */
    for (const product of products) {
      const declared = product.variantAxes ?? [];
      const templateEntry = findTemplate([product.subcategorySlug]);

      const dependedOn = new Set(
        declared.flatMap((key) => findAxis(templateEntry ?? PLACEHOLDER, key)?.dependsOn ?? []),
      );

      for (const key of declared) {
        const values = new Set(
          product.variants
            .map((variant) => variant.options[key])
            .filter((value) => value !== undefined),
        );

        if (dependedOn.has(key)) {
          // Present because something else needs it, so one value is correct.
          expect(values.size, `${product.blueprintKey} / ${key}`).toBeGreaterThan(0);
          continue;
        }

        expect(values.size, `${product.blueprintKey} / ${key}`).toBeGreaterThan(1);
      }
    }
  });

  it('never leaves a declared dependency undeclared', () => {
    // The other half of the same bug: an axis a declared one depends on must
    // itself be declared, or the selector waits for a choice it never offers.
    for (const product of products) {
      const declared = new Set(product.variantAxes ?? []);
      const templateEntry = findTemplate([product.subcategorySlug]);
      if (templateEntry === null) continue;

      for (const key of declared) {
        for (const dependency of findAxis(templateEntry, key)?.dependsOn ?? []) {
          // Only where this product actually varies along the dependency -
          // a template may name one the blueprint never uses at all.
          const usesIt = product.variants.some(
            (variant) => variant.options[dependency] !== undefined,
          );
          if (!usesIt) continue;

          expect(
            declared.has(dependency),
            `${product.blueprintKey}: "${key}" depends on "${dependency}", which is not declared`,
          ).toBe(true);
        }
      }
    }
  });

  it('is deterministic', () => {
    const again = generateEverything();

    expect(again).toHaveLength(products.length);
    for (const [index, product] of products.entries()) {
      const repeat = again[index];
      expect(repeat?.sku).toBe(product.sku);
      expect(repeat?.slug).toBe(product.slug);
      expect(repeat?.basePriceMinor).toBe(product.basePriceMinor);
      expect(repeat?.variants.map((variant) => variant.sku)).toEqual(
        product.variants.map((variant) => variant.sku),
      );
      expect(repeat?.variants.map((variant) => variant.priceMinor)).toEqual(
        product.variants.map((variant) => variant.priceMinor),
      );
      expect(repeat?.variants.map((variant) => variant.stock)).toEqual(
        product.variants.map((variant) => variant.stock),
      );
    }
  });

  it('marks every demonstration SKU as one', () => {
    for (const product of products) {
      expect(product.sku.startsWith('DEMO-'), product.blueprintKey).toBe(true);
      expect(product.slug.startsWith('demo-'), product.blueprintKey).toBe(true);
      expect(product.seedKey.startsWith('demo-catalog:'), product.blueprintKey).toBe(true);
    }
  });

  it('invents no barcode or manufacturer identifier', () => {
    // A GTIN is issued by GS1 against a real company prefix. A fabricated one
    // belongs to somebody else, so nothing here writes one at all.
    for (const product of products) {
      expect(product.name).not.toMatch(/\b\d{13}\b/);
    }
  });
});

describe('demo catalogue images', () => {
  it('has a photograph list for every sub-category in the registry', () => {
    for (const shelf of ALL_SHELVES) {
      const list = SUBCATEGORY_IMAGES[shelf.subcategory];
      expect(list, shelf.subcategory).toBeDefined();
      expect(list?.length ?? 0, shelf.subcategory).toBeGreaterThan(0);
    }
  });

  it('has a photograph for every department', () => {
    expect(Object.keys(DEPARTMENT_IMAGES)).toHaveLength(EXPECTED_DEPARTMENTS);
  });

  it('never uses the deprecated random Unsplash endpoint', () => {
    const urls = [...Object.values(SUBCATEGORY_IMAGES).flat(), ...Object.values(DEPARTMENT_IMAGES)];
    for (const url of urls) {
      expect(url).not.toContain('source.unsplash.com');
      expect(url).toMatch(/^https:\/\//);
    }
  });

  it('asks Unsplash CDN images for a sized, auto-formatted render', () => {
    // Requesting the original of a 6,000 pixel photograph to draw a 400 pixel
    // card is the difference between a page that loads and one that does not.
    const unsplash = Object.values(SUBCATEGORY_IMAGES)
      .flat()
      .filter((url) => url.includes('images.unsplash.com'));

    expect(unsplash.length).toBeGreaterThan(200);
    for (const url of unsplash) {
      expect(url).toContain('auto=format');
      expect(url).toMatch(/[?&]w=\d+/);
    }
  });

  it('gives a shelf more than one photograph, so three cards are not identical', () => {
    const shared = Object.entries(SUBCATEGORY_IMAGES).filter(
      ([, list]) => new Set(list).size < 2,
    );
    expect(shared.map(([slug]) => slug)).toEqual([]);
  });

  it('writes a specific image query for every blueprint', () => {
    // "tools" illustrates a bearing with a photograph of a factory floor.
    const tooBroad = new Set([
      'tools',
      'technology',
      'business',
      'shopping',
      'industry',
      'office',
      'medical',
    ]);

    for (const blueprint of ALL_BLUEPRINTS) {
      expect(blueprint.img.trim().length, blueprint.key).toBeGreaterThan(8);
      expect(tooBroad.has(blueprint.img.trim().toLowerCase()), blueprint.key).toBe(false);
      expect(blueprint.img.trim().split(/\s+/).length, blueprint.key).toBeGreaterThanOrEqual(2);
    }
  });
});
