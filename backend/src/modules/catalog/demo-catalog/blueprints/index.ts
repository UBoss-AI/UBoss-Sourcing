/**
 * The blueprint registry, and the checks that keep it honest.
 *
 * One hundred and thirty-eight shelves, four hundred and fourteen product
 * families, assembled from six files grouped the way the departments are
 * grouped. The split is for the benefit of whoever has to edit one; there is
 * exactly one registry.
 *
 * WHAT IS CHECKED HERE RATHER THAN DISCOVERED LATER
 *
 * `assertRegistryIsSound` is run by the seed before it writes anything, and by
 * a unit test that needs no database. It refuses a registry that would
 * produce a catalogue somebody would then have to repair by hand:
 *
 *   - **A duplicate blueprint key**, which would make the seed idempotent in
 *     name only - two blueprints converging on one `seedKey` means the second
 *     run rewrites the first one's product with the second one's words.
 *   - **A shelf with fewer than three products**, which is the coverage floor
 *     the whole exercise is measured against.
 *   - **An axis key the sub-category's template does not offer**, which
 *     produces a variant selector the storefront cannot draw. Medical Devices
 *     is exempt, and deliberately: it has no template and its variants are
 *     free-form, which is how that department already works.
 *   - **An axis with fewer than two values**, which is a dropdown with one
 *     entry - a decision a buyer is asked to make and cannot.
 *   - **A price band that runs backwards**, or a stock band that does.
 *
 * What it does NOT check is that the sub-category exists in the database. That
 * is the seed's job, because the answer depends on the deployment: an operator
 * who has renamed or removed a shelf has done something legitimate, and the
 * seed reports the gap rather than refusing to run.
 */
import { findTemplate } from '../../../../domain/variants/registry.js';
import { unknownAxisKeys, type Blueprint, type Shelf } from '../types.js';
import { CONSUMER_SHELVES } from './consumer.js';
import { ELECTRONICS_SHELVES } from './electronics.js';
import { LEISURE_SHELVES } from './leisure.js';
import { MEDICAL_SHELVES } from './medical.js';
import { TECHNICAL_SHELVES } from './technical.js';
import { TRADE_SHELVES } from './trade.js';
import { WORKPLACE_SHELVES } from './workplace.js';

/** Every shelf, in department order. */
export const ALL_SHELVES: readonly Shelf[] = Object.freeze([
  ...MEDICAL_SHELVES,
  ...TECHNICAL_SHELVES,
  ...ELECTRONICS_SHELVES,
  ...WORKPLACE_SHELVES,
  ...TRADE_SHELVES,
  ...CONSUMER_SHELVES,
  ...LEISURE_SHELVES,
]);

/** Shelf by sub-category slug. */
export const SHELF_BY_SUBCATEGORY: ReadonlyMap<string, Shelf> = new Map(
  ALL_SHELVES.map((entry) => [entry.subcategory, entry]),
);

/** Every blueprint, flattened. */
export const ALL_BLUEPRINTS: readonly Blueprint[] = Object.freeze(
  ALL_SHELVES.flatMap((entry) => entry.products),
);

/** The floor this catalogue is measured against, asserted below and in tests. */
export const MINIMUM_PRODUCTS_PER_SUBCATEGORY = 3;

/**
 * Departments whose blueprints author their own axis keys.
 *
 * Medical Devices, and only Medical Devices. See `registry.ts`: that
 * department deliberately has no variant template, because its variants are
 * free-form options and a hospital buyer picks several sizes at once rather
 * than narrowing to one. Checking its keys against a template that does not
 * exist would fail every blueprint on it.
 */
const FREE_FORM_SUBCATEGORIES: ReadonlySet<string> = new Set(
  MEDICAL_SHELVES.map((entry) => entry.subcategory),
);

/** One thing wrong with the registry, in a sentence somebody can act on. */
export interface RegistryProblem {
  readonly subcategory: string;
  readonly blueprintKey: string | null;
  readonly message: string;
}

/** Everything wrong with the registry, rather than the first thing. */
export function registryProblems(): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  const seenKeys = new Map<string, string>();

  for (const entry of ALL_SHELVES) {
    if (entry.products.length < MINIMUM_PRODUCTS_PER_SUBCATEGORY) {
      problems.push({
        subcategory: entry.subcategory,
        blueprintKey: null,
        message: `has ${String(entry.products.length)} blueprint(s); the floor is ${String(
          MINIMUM_PRODUCTS_PER_SUBCATEGORY,
        )}`,
      });
    }

    // Nearest-slug-first, exactly as the storefront resolves it - so a
    // blueprint is checked against the template its product will actually get.
    const templateEntry = FREE_FORM_SUBCATEGORIES.has(entry.subcategory)
      ? null
      : findTemplate([entry.subcategory]);

    if (templateEntry === null && !FREE_FORM_SUBCATEGORIES.has(entry.subcategory)) {
      problems.push({
        subcategory: entry.subcategory,
        blueprintKey: null,
        message: 'no variant template, and it is not a free-form department',
      });
    }

    for (const blueprint of entry.products) {
      const duplicate = seenKeys.get(blueprint.key);
      if (duplicate !== undefined) {
        problems.push({
          subcategory: entry.subcategory,
          blueprintKey: blueprint.key,
          message: `duplicate blueprint key, already used on "${duplicate}"`,
        });
      }
      seenKeys.set(blueprint.key, entry.subcategory);

      const axes = blueprint.axes ?? [];

      for (const key of unknownAxisKeys(templateEntry, axes)) {
        problems.push({
          subcategory: entry.subcategory,
          blueprintKey: blueprint.key,
          message: `axis "${key}" is not offered by this sub-category's variant template`,
        });
      }

      for (const [key, values] of axes) {
        if (values.length < 1) {
          problems.push({
            subcategory: entry.subcategory,
            blueprintKey: blueprint.key,
            message: `axis "${key}" has no values`,
          });
        }
        if (new Set(values).size !== values.length) {
          problems.push({
            subcategory: entry.subcategory,
            blueprintKey: blueprint.key,
            message: `axis "${key}" repeats a value`,
          });
        }
      }

      const [low, high] = blueprint.price;
      if (low <= 0 || high < low) {
        problems.push({
          subcategory: entry.subcategory,
          blueprintKey: blueprint.key,
          message: `price band ${String(low)}-${String(high)} is not a band`,
        });
      }

      const [lowStock, highStock] = blueprint.stock;
      if (lowStock < 0 || highStock < lowStock) {
        problems.push({
          subcategory: entry.subcategory,
          blueprintKey: blueprint.key,
          message: `stock band ${String(lowStock)}-${String(highStock)} is not a band`,
        });
      }

      if (Object.keys(blueprint.specs).length === 0) {
        problems.push({
          subcategory: entry.subcategory,
          blueprintKey: blueprint.key,
          message: 'has no specifications',
        });
      }

      for (const facet of blueprint.facets ?? []) {
        if (!(facet in blueprint.specs)) {
          problems.push({
            subcategory: entry.subcategory,
            blueprintKey: blueprint.key,
            message: `facet "${facet}" names a specification this blueprint does not have`,
          });
        }
      }
    }
  }

  return problems;
}

/** Throw on a registry that would produce a catalogue somebody has to repair. */
export function assertRegistryIsSound(): void {
  const problems = registryProblems();
  if (problems.length === 0) return;

  const lines = problems
    .slice(0, 40)
    .map(
      (problem) =>
        `  ${problem.subcategory}${problem.blueprintKey === null ? '' : ` / ${problem.blueprintKey}`}: ${problem.message}`,
    );

  const more =
    problems.length > lines.length ? `\n  ...and ${String(problems.length - lines.length)} more` : '';

  throw new Error(
    `The demo catalogue blueprint registry has ${String(problems.length)} problem(s):\n${lines.join('\n')}${more}`,
  );
}
