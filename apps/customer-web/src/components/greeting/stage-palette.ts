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
 * So the highlight is derived from `--brand` rather than picked from the
 * tokens: it has to read as light against a white page and against a navy one.
 *
 * The globe's own body is no longer in here. It used to be — an ocean and a
 * land tint, both held at 4.5:1 against the white word the hub paints over the
 * middle of it — and both went when the drawn globe became a photograph of the
 * earth. Nothing derived from a token can promise a contrast ratio against
 * satellite imagery, so that promise moved to where it can be kept: a scrim
 * under the label in `orchestration.css`.
 */

/** The palette, read from the document rather than repeated here. */
export interface StagePalette {
  brand: number;
  action: number;
  /** A light tint of the brand, for anything that has to read as a highlight. */
  highlight: number;
  /**
   * Polished titanium, for the light that travels behind the camera.
   *
   * Cool and nearly neutral rather than blue: a specular in the same hue as
   * everything else stops reading as a reflection and starts reading as
   * another coloured light.
   */
  steel: number;
  /** The page behind the scene, which is also the colour the fog is. */
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

/** A colour blended towards another, channel by channel. */
export function mix(from: number, to: number, amount: number): number {
  const channel = (shift: number): number =>
    Math.round(
      ((from >> shift) & 0xff) + (((to >> shift) & 0xff) - ((from >> shift) & 0xff)) * amount,
    );

  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/**
 * How far the highlight sits from the brand hue.
 *
 * Named because it is asserted: `HeroStage.test.tsx` checks that the highlight
 * reads as light on either theme. Move it and that suite is where you find out
 * what it cost.
 */
export const HIGHLIGHT_MIX = 0.62;

/** Titanium: the highlight taken most of the way to a neutral cool grey. */
const STEEL_TARGET = 0xe2e8f0;
const STEEL_MIX = 0.55;

export function readStagePalette(): StagePalette {
  const styles = getComputedStyle(document.documentElement);
  const brand = readChannel(styles, '--brand', 0x1d4ed8);

  // Light on white and light on navy, which no token is.
  const highlight = lighten(brand, HIGHLIGHT_MIX);

  return {
    brand,
    action: readChannel(styles, '--action', 0xea580c),
    surface: readChannel(styles, '--surface', 0xffffff),
    highlight,
    steel: mix(highlight, STEEL_TARGET, STEEL_MIX),
  };
}
