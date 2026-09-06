/**
 * Accessibility assertions, run against what the browser actually gets.
 *
 * The European Accessibility Act (Directive (EU) 2019/882) has applied to
 * e-commerce services since 28 June 2025, and the harmonised standard behind
 * it — EN 301 549 — is WCAG 2.1 AA. This storefront is exactly the kind of
 * service it covers.
 *
 * Two layers already exist and neither reaches this one:
 *
 *   - `eslint-plugin-jsx-a11y` reads JSX. It cannot see an accessible name
 *     that is composed at runtime, a duplicate `id` produced by rendering the
 *     same component twice, or an `aria-describedby` pointing at an element
 *     that a conditional never rendered.
 *   - `scripts/contrast-audit.cjs` reads the palette. It cannot see which
 *     colours a component actually puts together.
 *
 * axe-core runs against the rendered DOM, which is where those live.
 *
 * **What this cannot do.** jsdom has no layout: nothing here has a size, a
 * position or a computed colour, so the rules about contrast, target size and
 * reflow are meaningless and are disabled below rather than left to report
 * confident nonsense. A green run here is not a conformance claim — it is a
 * regression guard on the failures that can be caught this way. Real
 * conformance needs a person with a screen reader, and `docs/ACCESSIBILITY.md`
 * says so.
 */
import axe, { type AxeResults, type ElementContext, type RunOptions, type Result } from 'axe-core';
import { expect } from 'vitest';

/**
 * Rules that cannot produce a meaningful answer in jsdom.
 *
 * Disabled with a reason each, rather than as a block, because a disabled rule
 * with no justification is how a suite quietly stops testing the thing it was
 * written for.
 */
const JSDOM_BLIND_SPOTS: Readonly<Record<string, { enabled: false }>> = Object.freeze({
  // Needs computed colour and layout. Covered instead by the token audit in
  // `npm run audit:contrast`, which checks the palette directly.
  'color-contrast': { enabled: false },
  // Both need a viewport and a box model.
  'target-size': { enabled: false },
  'meta-viewport': { enabled: false },
});

/**
 * Rules a component fragment cannot satisfy on its own.
 *
 * A test renders one panel, not a document, so "this page needs a main
 * landmark" and "every h2 needs an h1 above it" are true of the page and
 * meaningless of the fragment. `checkPageA11y` turns them back on.
 */
const FRAGMENT_BLIND_SPOTS: Readonly<Record<string, { enabled: false }>> = Object.freeze({
  region: { enabled: false },
  'page-has-heading-one': { enabled: false },
  'landmark-one-main': { enabled: false },
  'html-has-lang': { enabled: false },
  bypass: { enabled: false },
});

function describe(violations: Result[]): string {
  return violations
    .map((violation) => {
      const where = violation.nodes
        .slice(0, 3)
        .map((node) => `      ${node.html.slice(0, 160)}`)
        .join('\n');

      return [
        `  [${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help}`,
        `    ${violation.helpUrl}`,
        where,
      ].join('\n');
    })
    .join('\n\n');
}

async function run(container: ElementContext, options: RunOptions): Promise<AxeResults> {
  return axe.run(container, options);
}

/**
 * Assert that a rendered fragment has no detectable accessibility violations.
 *
 * Pass the container from `renderWithProviders`. Fails with the rule, the
 * impact, a link to the rule's page and the offending markup — an assertion
 * that says only "3 violations" sends the reader back to the docs.
 */
export async function expectNoA11yViolations(
  container: Element,
  options: { rules?: Record<string, { enabled: boolean }> } = {},
): Promise<void> {
  const results = await run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules: { ...JSDOM_BLIND_SPOTS, ...FRAGMENT_BLIND_SPOTS, ...options.rules },
  });

  expect(
    results.violations,
    results.violations.length === 0
      ? ''
      : `\n\nWCAG 2.1 AA violations:\n\n${describe(results.violations)}\n`,
  ).toEqual([]);
}

/**
 * The same, for something rendered as a whole page.
 *
 * Keeps the document-level rules on: a landmark structure, one `h1`, a way to
 * skip the navigation. Those are the rules a screen-reader user relies on to
 * move around at all, and they are the ones a component test can never assert.
 */
export async function expectNoPageA11yViolations(container: Element): Promise<void> {
  const results = await run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules: {
      ...JSDOM_BLIND_SPOTS,
      // The harness renders into a bare div rather than a document, so these
      // two still cannot pass however correct the app is.
      'html-has-lang': { enabled: false },
      'landmark-one-main': { enabled: false },
    },
  });

  expect(
    results.violations,
    results.violations.length === 0
      ? ''
      : `\n\nWCAG 2.1 AA violations:\n\n${describe(results.violations)}\n`,
  ).toEqual([]);
}
