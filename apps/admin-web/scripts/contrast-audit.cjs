/**
 * Contrast audit of the design tokens.
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

function readTokens(file) {
  const css = fs.readFileSync(file, 'utf8');
  const tokens = {};

  // `--name: R G B;` — the Tailwind channel form this palette uses, so the
  // same token can be given an alpha at the call site.
  for (const match of css.matchAll(/--([a-z0-9-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g)) {
    tokens[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }

  return tokens;
}

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

/**
 * The pairs the components actually render.
 *
 * Chosen from the call sites rather than generated from every combination: a
 * report listing nine hundred pairs nobody puts together is a report nobody
 * reads twice.
 */
const TEXT_PAIRS = [
  ['ink', 'surface', 'Body text on a card'],
  ['ink', 'surface-sunken', 'Body text on a sunken panel'],
  ['ink-muted', 'surface', 'Secondary text on a card'],
  ['ink-muted', 'surface-sunken', 'Secondary text on a sunken panel'],
  ['ink-subtle', 'surface', 'Tertiary text on a card'],
  ['ink-subtle', 'surface-sunken', 'Tertiary text on a sunken panel'],
  ['ink-inverse', 'surface-inverse', 'Text on the inverse surface'],
  ['ink-inverse', 'navy', 'Header text on navy'],
  ['ink-inverse', 'brand', 'Label on a primary button'],
  ['ink-inverse', 'brand-hover', 'Label on a hovered primary button'],
  ['ink-inverse', 'action-strong', 'Label on the buy button'],
  ['ink-inverse', 'action-strong-hover', 'Label on the hovered buy button'],
  ['ink-inverse', 'operational', 'Label on an operational button'],
  ['ink-inverse', 'danger', 'Label on a destructive button'],
  ['ink-inverse', 'success', 'Label on a success button'],
  ['brand', 'surface', 'A link'],
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
];

function evaluate(tokens, pairs, threshold, label) {
  const rows = [];
  let failures = 0;

  for (const [fg, bg, description] of pairs) {
    if (tokens[fg] === undefined || tokens[bg] === undefined) {
      // A renamed token is a real problem: the pair silently stops being
      // checked, which is exactly how a guard rots.
      rows.push(`  MISSING  ${description}  (--${fg} / --${bg})`);
      failures += 1;
      continue;
    }

    const value = ratio(tokens[fg], tokens[bg]);
    const pass = value >= threshold;
    if (!pass) failures += 1;

    rows.push(
      `  ${pass ? 'ok  ' : 'FAIL'} ${value.toFixed(2).padStart(6)}:1  ${description}` +
        `  (--${fg} on --${bg})`,
    );
  }

  console.log(`\n=== ${label} — needs ${String(threshold)}:1 ===`);
  for (const row of rows) console.log(row);

  return failures;
}

function main() {
  const tokens = readTokens(CSS_FILE);

  console.log(`Palette: ${path.relative(process.cwd(), CSS_FILE)}`);
  console.log(`${String(Object.keys(tokens).length)} tokens read.`);

  let failures = 0;
  failures += evaluate(tokens, TEXT_PAIRS, 4.5, 'Text (WCAG 1.4.3 AA)');
  failures += evaluate(tokens, UI_PAIRS, 3, 'Controls and states (WCAG 1.4.11 AA)');

  console.log('\n=== Exempt, by decision ===');
  for (const [fg, bg, why] of DECORATIVE) {
    const value = tokens[fg] && tokens[bg] ? ratio(tokens[fg], tokens[bg]).toFixed(2) : '?';
    console.log(`  ${String(value).padStart(6)}:1  --${fg} on --${bg}  — ${why}`);
  }

  if (failures > 0) {
    console.error(`\n${String(failures)} contrast failure(s). See WCAG 2.1 SC 1.4.3 and 1.4.11.`);
    process.exit(1);
  }

  console.log('\nNo contrast failures.');
}

main();
