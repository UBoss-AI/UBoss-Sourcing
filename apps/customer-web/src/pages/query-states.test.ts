/**
 * Every screen that reads data shows it loading, failing and empty (LIVE-003).
 *
 * A panel that renders nothing while it loads looks broken; one that renders
 * its empty state when the read FAILED tells the person something false -
 * "you have no addresses", "nothing set up yet" - and invites them to create
 * a duplicate of what is already there. This walks every page and panel under
 * `src/pages` that calls a data query and checks, in its source, that it:
 *
 *   - handles the loading state (`isPending`, `isLoading`, a LoadingState,
 *     a spinner or a skeleton, or a table told it is loading);
 *   - handles the failed state (`isError`, an ErrorState, or a table given
 *     the error);
 *   - and, where it renders a list from the data, says when the list is empty.
 *
 * A source check, not a render: rendering ninety screens with every query in
 * every state is a test suite of its own. What this catches is the screen
 * that never thought about a state at all, which is the defect that shipped.
 * A screen that handles a state in a way the patterns do not see goes in
 * EXEMPT, with the reason - written down, so the next person can disagree.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type State = 'loading' | 'error' | 'empty';

const PAGES = dirname(fileURLToPath(import.meta.url));

const EXEMPT: Record<string, { states: State[]; reason: string }> = {
  'checkout/LabelRequirementsNotice.tsx': {
    states: ['loading', 'error'],
    reason: 'An informational notice inside checkout: a LABEL_REQUIRED rule never stops a sale, so while loading or after a failed read it shows nothing and checkout carries on; the product and market pages show the same rules.',
  },
  'checkout/DestinationGuidanceNotice.tsx': {
    states: ['loading', 'error'],
    reason: 'Advisory importer and document guidance inside checkout (ENH-022): while loading or after a failed read it shows nothing and checkout carries on; placing the order still enforces destination rules.',
  },
  'account/CloseAccountPanel.tsx': {
    states: ['error'],
    reason: 'A failed impact read renders closeAccount.impactUnavailable (closure === null) and still offers the close; the server applies the rules either way.',
  },
  'company/CompanyRegisterPage.tsx': {
    states: ['error'],
    reason: 'The only query is an optional prefill from the buyer’s seller account; without it the form is simply blank, which is correct.',
  },
  'seller/SellerFulfilmentPage.tsx': {
    states: ['loading', 'error'],
    reason: 'Reads the same query key as LogisticsPartnerPanel, which renders the loading and error states for the page.',
  },
  'seller/SellerPackagingPanel.tsx': {
    states: ['empty'],
    reason: 'The mapped lists are the presets compiled into the build (containers, Incoterms), never empty.',
  },
};

const QUERY = /\buse(?:Infinite|Suspense)?Query\(/;
const LOADING = /\.isPending\b|\.isLoading\b|<LoadingState\b|Skeleton|<Spinner\b|loadingLabel=|\bloading=\{/;
const ERROR = /\.isError\b|<ErrorState\b|\berror=\{|\.error\b/;
const LISTS = /\?\? \[\]\)\.map\(|\.data\??\.[A-Za-z]+\??\.map\(|\brows=\{(?!\d)/;
const EMPTY = /<EmptyState\b|<PageEmptyState\b|emptyTitle=|\.length === 0|\.length > 0|\.length !== 0|\.length \?|\.length &&/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [path] : [];
  });
}

function missingStates(text: string): State[] {
  const missing: State[] = [];
  if (!LOADING.test(text)) missing.push('loading');
  if (!ERROR.test(text)) missing.push('error');
  if (LISTS.test(text) && !EMPTY.test(text)) missing.push('empty');
  return missing;
}

describe('query states on every data screen (LIVE-003)', () => {
  const screens = sources(PAGES)
    .map((path) => ({ name: relative(PAGES, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }))
    .filter((screen) => QUERY.test(screen.text));

  it('finds the screens that read data', () => {
    expect(screens.length).toBeGreaterThan(30);
  });

  it('handles loading, failure and empty on each, or says why not', () => {
    const problems = screens.flatMap((screen) => {
      const exempt = new Set(EXEMPT[screen.name]?.states ?? []);
      const missing = missingStates(screen.text).filter((state) => !exempt.has(state));
      return missing.length === 0 ? [] : [`${screen.name}: no ${missing.join(', ')} state`];
    });
    expect(problems).toEqual([]);
  });

  it('keeps no exemption for a screen that no longer needs it', () => {
    const stale = Object.entries(EXEMPT).flatMap(([name, entry]) => {
      const screen = screens.find((candidate) => candidate.name === name);
      if (screen === undefined) return [`${name}: no longer reads data, or was moved`];
      const missing = new Set(missingStates(screen.text));
      return entry.states.filter((state) => !missing.has(state)).map((state) => `${name}: ${state} is handled now`);
    });
    expect(stale).toEqual([]);
  });
});
