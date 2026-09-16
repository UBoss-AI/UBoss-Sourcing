/**
 * The colours the WebGL stage renders with.
 *
 * Its own module rather than part of `HeroStage.tsx` for a reason that is more
 * than tidiness: a file that exports both a component and plain functions
 * cannot be hot-reloaded, so every keystroke while working on the scene would
 * reload the whole page — and a reload tears down a WebGL context and builds a
 * new one. The one thing you want while adjusting a colour is for the object
 * you are adjusting to stay on screen.
 *
 * WHAT THIS EXISTS TO SOLVE
 *
 * The scene must be the storefront's own palette, not a second one pasted
 * beside it, so the values are read from the same CSS custom properties every
 * other component uses — a deployment that changes `--brand` gets a core in
 * its own blue without anybody editing this.
 *
 * But **no token in the palette is light on both themes, and none is dark on
 * both**, because every one of them is defined for its job against a
 * particular background. `--bloom` is the trap that proved it: a pale sky on
 * the light theme and a deep navy on the dark one, because it is a background
 * wash. Used as the bead riding a ring it rendered darker than the page and
 * read as a hole punched through the ring.
 *
 * A rendered object needs both ends regardless of theme — highlights that read
 * as light, and a body dark enough for the white label the hub paints over it
 * — so the two are derived from `--brand` rather than picked from the tokens.
 */

/** The palette, read from the document rather than repeated here. */
export interface StagePalette {
  brand: number;
  navy: number;
  action: number;
  bloom: number;
  /** A light tint of the brand, for anything that has to read as a highlight. */
  highlight: number;
  /** A deep tint of the brand: the globe's ocean, under the white label. */
  deep: number;
  /**
   * The land on the globe, one step up from the ocean.
   *
   * It has to be light enough to read as a continent against the sea and dark
   * enough for the white label the hub paints over the middle of it. Both ends
   * are asserted in `HeroStage.test.tsx`; see `LAND_MIX`.
   */
  land: number;
  /**
   * Polished titanium, for the structural bands round the globe.
   *
   * Cool and nearly neutral rather than blue: a metal band in the same hue as
   * everything else stops reading as metal and starts reading as another ring.
   * What makes it look machined is that it is the one thing in the scene with
   * a bright, tight specular and almost no colour of its own.
   */
  steel: number;
  surface: number;
}

/**
 * One CSS custom property as a packed 0xRRGGBB integer.
 *
 * The tokens are stored as `"29 78 216"` — space-separated channels, so that
 * Tailwind can put an alpha into them — which is not a form any colour parser
 * accepts. Parsed here rather than duplicated as hex constants, so a change to
 * the palette reaches the scene without anybody remembering that it has to.
 */
function readChannel(styles: CSSStyleDeclaration, name: string, fallback: number): number {
  const raw = styles.getPropertyValue(name).trim();
  if (raw.length === 0) return fallback;

  const parts = raw.split(/[\s,]+/).map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return fallback;

  return ((parts[0] ?? 0) << 16) | ((parts[1] ?? 0) << 8) | (parts[2] ?? 0);
}

/**
 * A colour mixed towards white.
 *
 * For the lattice inside the core, the beads riding the rings and the fill
 * light — everything that has to read as a highlight whichever theme is on.
 * See this file's header for why a token cannot do this job.
 */
export function lighten(colour: number, amount: number): number {
  const mix = (channel: number): number => Math.round(channel + (255 - channel) * amount);

  return (
    (mix((colour >> 16) & 0xff) << 16) | (mix((colour >> 8) & 0xff) << 8) | mix(colour & 0xff)
  );
}

/**
 * A colour mixed towards black.
 *
 * The core's body has to be dark, and not as a matter of taste: the word
 * "Sourcing" is painted over the middle of it in white by the hub, and against
 * a pale blue crystal that was about 1.9:1 — which is not a contrast ratio, it
 * is a rumour. Taking the body down to a deep blue restores the relationship
 * the CSS sphere had, where the label sat on navy and read at a glance.
 *
 * The lit facets are still bright. They get there from the key light rather
 * than from the base colour, which is also what gives the object its range.
 */
export function darken(colour: number, amount: number): number {
  const mix = (channel: number): number => Math.round(channel * (1 - amount));

  return (
    (mix((colour >> 16) & 0xff) << 16) | (mix((colour >> 8) & 0xff) << 8) | mix(colour & 0xff)
  );
}

/** A colour blended towards another, channel by channel. */
export function mix(from: number, to: number, amount: number): number {
  const channel = (shift: number): number =>
    Math.round(
      ((from >> shift) & 0xff) + (((to >> shift) & 0xff) - ((from >> shift) & 0xff)) * amount,
    );

  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/**
 * How far the derived colours sit from the brand hue.
 *
 * Named because every one of them is asserted: `HeroStage.test.tsx` checks that
 * the highlight reads as light on either theme, and that both the ocean and the
 * land clear 4.5:1 against the white label on either theme. Move any of these
 * numbers and that suite is where you find out what it cost.
 */
export const HIGHLIGHT_MIX = 0.62;
export const DEEP_MIX = 0.78;

/**
 * How far the land is lifted out of the ocean.
 *
 * Towards the BRAND rather than towards white, and that is the whole point of
 * it. `lighten` mixes towards white, which raises lightness and drops
 * saturation together — the first version of the globe used it and the
 * continents came out a flat slate grey sitting on a blue sea, which reads as
 * a weather map rather than as sapphire. Mixing towards the brand raises the
 * lightness and keeps the hue, so the land is the same blue as the ocean with
 * the light turned up on it.
 *
 * Squeezed from both sides. Below about 0.25 the continents stop separating
 * from the sea on the dark theme and the globe reads as a plain ball; above
 * about 0.6 the land behind the word "Sourcing" drops under 4.5:1 on that same
 * theme. 0.46 sits inside that window at roughly 5.6:1.
 */
export const LAND_MIX = 0.46;

/** Titanium: the highlight taken most of the way to a neutral cool grey. */
const STEEL_TARGET = 0xe2e8f0;
const STEEL_MIX = 0.55;

export function readStagePalette(): StagePalette {
  const styles = getComputedStyle(document.documentElement);
  const brand = readChannel(styles, '--brand', 0x1d4ed8);

  // Light on white and light on navy, which no token is.
  const highlight = lighten(brand, HIGHLIGHT_MIX);
  // Dark enough for white text in both themes, for the same reason.
  const deep = darken(brand, DEEP_MIX);

  return {
    brand,
    navy: readChannel(styles, '--navy', 0x0c2350),
    action: readChannel(styles, '--action', 0xea580c),
    bloom: readChannel(styles, '--bloom', 0xbae6fd),
    surface: readChannel(styles, '--surface', 0xffffff),
    highlight,
    deep,
    land: mix(deep, brand, LAND_MIX),
    steel: mix(highlight, STEEL_TARGET, STEEL_MIX),
  };
}
