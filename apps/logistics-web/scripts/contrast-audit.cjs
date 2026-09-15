/**
 * Contrast audit of the design tokens, in both themes.
 *
 * WCAG 2.1 AA asks for 4.5:1 on body text (1.4.3) and 3:1 on the visual
 * information that identifies a control or its state (1.4.11). The European
 * Accessibility Act points at EN 301 549, which points at those.
 *
 * Nothing else in this repository can catch a contrast regression.
 * `eslint-plugin-jsx-a11y` reads JSX and a contrast ratio does not exist until
 * two colours meet; axe-core is run under jsdom, which has no computed colour
 * at all. So this reads the palette directly, and it is the only guard on the
 * one accessibility property most likely to be broken by an innocent-looking
 * design tweak.
 *
 * Run: `npm run audit:contrast`. Exits non-zero on a failure, so CI can hold
 * the line.
 *
 * ---
 *
 * **Two palettes, audited separately.**
 *
 * There is a dark theme, and it is not a filter over the light one — it is a
 * second set of values for the same token names. So every pair below is
 * measured twice, once per theme, and a pair that passes in light and fails in
 * dark is a failure. That sounds obvious and it is the entire reason this file
 * was rewritten: the previous version read the whole stylesheet with one
 * regular expression, so the moment a dark block was added below the light one
 * the last match won and the audit quietly began reporting on dark values
 * only — under headings that said nothing had changed. A guard that reports on
 * half the product while claiming to cover it is worse than no guard.
 *
 * The dark palette is read as *overrides*: the light `:root` block is the full
 * set, and dark redefines the subset it changes. That is how the CSS behaves,
 * and it means a token the dark block forgets is audited at its light value
 * against dark surfaces — which is exactly the failure that forgetting causes,
 * so it shows up as one rather than as a missing row.
 *
 * **The duplicated dark block is checked for drift.** Dark is declared twice
 * in the CSS on purpose — once under `prefers-color-scheme` and once under
 * `[data-theme='dark']`, see the note in index.css. Hand-duplicated
 * declarations diverge, and a divergence here would mean the theme a visitor
 * gets from their operating system differs from the one they get from the
 * toggle. So the two blocks are compared token by token before anything is
 * measured.
 *
 * ---
 *
 * **Text tokens and fill tokens are different pairs.**
 *
 * Each hue has two steps: the bare token (`--brand`) is the one text is drawn
 * in, and `--brand-fill` is the one a solid button is filled with. In light
 * mode they are the same value; in dark they must not be, because a hue light
 * enough to read as text on a dark card cannot also carry a white label. So
 * the bare token is audited as a foreground and the `-fill` token as a
 * background, and swapping a call site from one to the other is a change this
 * audit can see.
 *
 * ---
 *
 * **What counts as a failure, and what does not.**
 *
 * 1.4.11 covers the parts of a control a user needs in order to identify it: a
 * text input's border, a focus ring, a checked state. It expressly does not
 * cover decoration. A card's hairline divider is decoration — the card is
 * identified by the content inside it, not by the line around it — so
 * `--border` is audited against the 3:1 threshold only where it separates
 * controls, and the decorative uses are listed under DECORATIVE with the
 * reasoning rather than being quietly skipped.
 *
 * Getting that distinction wrong in the strict direction is not harmless: a
 * report that flags a decorative hairline teaches whoever reads it that the
 * failures are noise, and the next real one is skipped too.
 */
const fs = require('fs');
const path = require('path');

const CSS_FILE = path.join(__dirname, '..', 'src', 'index.css');

/** The selector that opens the full light palette. */
const LIGHT_SELECTOR = ':root {';

/** The two selectors the dark palette is declared under. See index.css. */
const DARK_SELECTORS = [":root:not([data-theme='light']) {", ":root[data-theme='dark'] {"];

// ---------------------------------------------------------------------------
// Reading the stylesheet
// ---------------------------------------------------------------------------

/**
 * The text between the braces of the block a selector opens.
 *
 * Brace-counted rather than matched with a regular expression, because the
 * blocks this file cares about are nested inside `@layer base` and one of them
 * is nested inside a media query as well, and `[^}]*` stops at the first inner
 * closing brace it finds.
 */
function blockBody(css, opener) {
  const start = css.indexOf(opener);
  if (start === -1) return null;

  let depth = 0;
  for (let i = start + opener.length - 1; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + opener.length, i);
    }
  }

  return null;
}

/** `--name: R G B;` — the Tailwind channel form this palette uses. */
function readTokens(source) {
  const tokens = {};

  for (const match of source.matchAll(/--([a-z0-9-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g)) {
    tokens[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }

  return tokens;
}

/**
 * The light palette, the dark palette, and whether the two dark blocks agree.
 *
 * A missing block is fatal rather than skipped: an audit that silently drops a
 * whole theme because somebody reformatted a selector is the failure mode this
 * rewrite exists to prevent.
 */
function readPalettes(file) {
  const css = fs.readFileSync(file, 'utf8');

  const lightBody = blockBody(css, LIGHT_SELECTOR);
  if (lightBody === null) {
    throw new Error(`No \`${LIGHT_SELECTOR}\` block in ${file}. The light palette is the base.`);
  }

  const light = readTokens(lightBody);
  const darkBlocks = DARK_SELECTORS.map((selector) => {
    const body = blockBody(css, selector);
    if (body === null) throw new Error(`No \`${selector}\` block in ${file}.`);
    return { selector, tokens: readTokens(body) };
  });

  // Both dark blocks are hand-written copies of one another. Compare them
  // before measuring: a token that has drifted between them means the theme
  // the operating system asks for and the theme the toggle asks for are
  // different themes, which no amount of contrast checking would reveal.
  const drift = [];
  const [first, ...rest] = darkBlocks;
  for (const other of rest) {
    const names = new Set([...Object.keys(first.tokens), ...Object.keys(other.tokens)]);
    for (const name of [...names].sort()) {
      const a = first.tokens[name];
      const b = other.tokens[name];
      if (a === undefined) drift.push(`--${name} is only in \`${other.selector}\``);
      else if (b === undefined) drift.push(`--${name} is only in \`${first.selector}\``);
      else if (a.join(' ') !== b.join(' ')) {
        drift.push(`--${name} is ${a.join(' ')} in one dark block and ${b.join(' ')} in the other`);
      }
    }
  }

  return { light, dark: { ...light, ...first.tokens }, drift, darkCount: Object.keys(first.tokens).length };
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

/** WCAG relative luminance. */
function luminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// The pairs the components actually render
// ---------------------------------------------------------------------------

/**
 * Chosen from the call sites rather than generated from every combination: a
 * report listing nine hundred pairs nobody puts together is a report nobody
 * reads twice.
 */
const TEXT_PAIRS = [
  ['ink', 'surface', 'Body text on a card'],
  ['ink', 'surface-raised', 'Body text on a raised card'],
  ['ink', 'surface-sunken', 'Body text on a sunken panel'],
  ['ink-muted', 'surface', 'Secondary text on a card'],
  ['ink-muted', 'surface-sunken', 'Secondary text on a sunken panel'],
  ['ink-subtle', 'surface', 'Tertiary text on a card'],
  ['ink-subtle', 'surface-sunken', 'Tertiary text on a sunken panel'],
  // Added when the page ground went sky. A tinted ground is a darker ground,
  // and the quietest text in the app is the first thing that stops passing on
  // it — including inside a row somebody is hovering, which is darker still.
  ['ink-subtle', 'surface-hover', 'Tertiary text in a hovered row'],
  ['ink-inverse', 'surface-inverse', 'Text on the inverse surface'],
  // Not the chrome any more — the header and the sidebar are white over a
  // sky page. What is still drawn on this is a dialog scrim and the two
  // `inverse` button variants, and both carry text.
  ['ink-inverse', 'navy', 'Text on the deep-blue ground'],
  // The `-fill` steps: a solid plate with a light label on it. These are the
  // pairs that made a second token per hue necessary — see the file header.
  ['ink-inverse', 'brand-fill', 'Label on a primary button'],
  ['ink-inverse', 'brand-fill-hover', 'Label on a hovered primary button'],
  ['ink-inverse', 'action-fill', 'Label on the buy button'],
  ['ink-inverse', 'action-fill-hover', 'Label on the hovered buy button'],
  ['ink-inverse', 'operational-fill', 'Label on an operational button'],
  ['ink-inverse', 'danger-fill', 'Label on a destructive button'],
  ['ink-inverse', 'success-fill', 'Label on a success plate'],
  // Nothing draws a label on `--warning-fill` today: every warning fill in
  // either app is a dot or a meter bar with no text on it. Audited anyway, so
  // that the first component to put a label there inherits a value that
  // already works rather than one nobody measured.
  ['ink-inverse', 'warning-fill', 'Label on a warning plate (no call site yet)'],
  // The bare steps: a hue used as text, which is what they are tuned for.
  ['brand', 'surface', 'A link'],
  ['brand', 'surface-sunken', 'A link on a sunken panel'],
  ['brand', 'brand-soft', 'Badge text, brand'],
  ['success', 'success-soft', 'Badge text, success'],
  ['warning', 'warning-soft', 'Badge text, warning'],
  ['danger', 'danger-soft', 'Badge text, danger'],
  ['operational', 'operational-soft', 'Badge text, operational'],
  ['action-strong', 'action-soft', 'Badge text, action'],
  ['danger', 'surface', 'Inline error text'],
  ['warning', 'surface', 'Inline warning text'],
  ['success', 'surface', 'Inline success text'],
];

/** 1.4.11: what a user needs in order to identify a control or its state. */
const UI_PAIRS = [
  ['border-strong', 'surface', 'Input border'],
  ['border-strong', 'surface-raised', 'Input border on a raised card'],
  ['border-strong', 'surface-sunken', 'Input border on a sunken panel'],
  ['border-hover', 'surface', 'Hovered input border'],
  ['ring', 'surface', 'Focus ring'],
  ['ring', 'surface-sunken', 'Focus ring on a sunken panel'],
  ['danger', 'surface', 'Invalid input border'],
];

/**
 * Pairs that are exempt, with the reason.
 *
 * Written down rather than omitted. A future reader asking "why is the card
 * border not checked?" should find the answer here rather than assume it was
 * forgotten.
 */
const DECORATIVE = [
  ['border', 'surface', 'Card hairline — the card is identified by its contents, not its edge'],
  ['border-subtle', 'surface', 'Divider between rows in a list'],
  ['bloom', 'surface', 'The greeting backdrop wash, drawn at 30–40% behind nothing legible'],
];

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function evaluate(tokens, pairs, threshold, label) {
  const rows = [];
  let failures = 0;

  for (const [fg, bg, description] of pairs) {
    if (tokens[fg] === undefined || tokens[bg] === undefined) {
      // A renamed token is a real problem: the pair silently stops being
      // checked, which is exactly how a guard rots.
      rows.push(`    MISSING  ${description}  (--${fg} / --${bg})`);
      failures += 1;
      continue;
    }

    const value = ratio(tokens[fg], tokens[bg]);
    const pass = value >= threshold;
    if (!pass) failures += 1;

    rows.push(
      `    ${pass ? 'ok  ' : 'FAIL'} ${value.toFixed(2).padStart(6)}:1  ${description}` +
        `  (--${fg} on --${bg})`,
    );
  }

  console.log(`\n  --- ${label} — needs ${String(threshold)}:1 ---`);
  for (const row of rows) console.log(row);

  return failures;
}

/** Both WCAG sections, for one theme. */
function auditTheme(name, tokens) {
  console.log(`\n=================== ${name.toUpperCase()} ===================`);

  let failures = 0;
  failures += evaluate(tokens, TEXT_PAIRS, 4.5, 'Text (WCAG 1.4.3 AA)');
  failures += evaluate(tokens, UI_PAIRS, 3, 'Controls and states (WCAG 1.4.11 AA)');

  console.log('\n  --- Exempt, by decision ---');
  for (const [fg, bg, why] of DECORATIVE) {
    const value = tokens[fg] && tokens[bg] ? ratio(tokens[fg], tokens[bg]).toFixed(2) : '?';
    console.log(`    ${String(value).padStart(6)}:1  --${fg} on --${bg}  — ${why}`);
  }

  return failures;
}

function main() {
  const { light, dark, drift, darkCount } = readPalettes(CSS_FILE);

  console.log(`Palette: ${path.relative(process.cwd(), CSS_FILE)}`);
  console.log(
    `${String(Object.keys(light).length)} tokens in light, ` +
      `${String(darkCount)} of them redefined for dark.`,
  );

  let failures = drift.length;
  if (drift.length > 0) {
    console.log('\n=== The two dark blocks have drifted apart ===');
    for (const line of drift) console.log(`  FAIL  ${line}`);
  }

  failures += auditTheme('light', light);
  failures += auditTheme('dark', dark);

  if (failures > 0) {
    console.error(`\n${String(failures)} contrast failure(s). See WCAG 2.1 SC 1.4.3 and 1.4.11.`);
    process.exit(1);
  }

  console.log('\nNo contrast failures, in either theme.');
}

main();
