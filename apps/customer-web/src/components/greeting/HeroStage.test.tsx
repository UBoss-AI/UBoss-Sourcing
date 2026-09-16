/**
 * The greeting's WebGL stage.
 *
 * What can and cannot be asserted here is worth stating plainly, because the
 * temptation is to write tests that look like they cover a 3D scene and do
 * not. jsdom has no WebGL, no GPU and no layout: "the core is the right size",
 * "the rings occlude it" and "it runs at sixty frames a second" are questions
 * this suite cannot answer, and a person looking at a browser is how this
 * project answers them — the same arrangement `greeting.test.tsx` and
 * `docs/ACCESSIBILITY.md` already describe for the CSS animation.
 *
 * What this suite DOES guard is the contract around the scene, which is where
 * the expensive regressions live:
 *
 *   - **It stands down where it cannot run.** jsdom has no WebGL, so the
 *     component must render nothing at all rather than a blank canvas over the
 *     backdrop, and must never report itself active. Exactly the same path a
 *     real visitor with a blocklisted driver takes.
 *   - **It never claims to be active when it is not.** `onActive` is what makes
 *     the hub hide its own sphere; a stage that reported optimistically would
 *     leave a hero with a hole in it on every machine that cannot render one.
 *   - **The hero says so in the DOM.** `data-stage` is the only channel between
 *     the scene and the stylesheet, and `orchestration.css` keys four rules off
 *     it.
 *   - **The colour helpers do what the scene needs of them.** Those are pure,
 *     they are the reason a bead is not a black hole on the dark theme, and
 *     they are cheap to hold still.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HeroStage } from './HeroStage';
import { DEEP_MIX, HIGHLIGHT_MIX, LAND_MIX, darken, lighten, mix } from './stage-palette';

/** Relative luminance, to the WCAG definition. */
function luminance(colour: number): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };

  return (
    0.2126 * channel((colour >> 16) & 0xff) +
    0.7152 * channel((colour >> 8) & 0xff) +
    0.0722 * channel(colour & 0xff)
  );
}

/** Contrast against white, which is what the hub's label is. */
function contrastWithWhite(colour: number): number {
  return 1.05 / (luminance(colour) + 0.05);
}

/** `--brand` on each theme, from `index.css`. */
const BRAND_LIGHT = 0x1d4ed8;
const BRAND_DARK = 0x8ab4ff;

describe('standing down where WebGL is not available', () => {
  it('renders nothing at all in an environment without WebGL 2', () => {
    // jsdom is that environment, which is the point: this is the same branch a
    // blocklisted driver or a locked-down enterprise browser lands on.
    expect(typeof WebGL2RenderingContext).toBe('undefined');

    const { container } = render(<HeroStage />);

    // Not an empty canvas, not a transparent host - nothing. The CSS backdrop
    // underneath is then simply what the hero is, which is a finished page.
    expect(container).toBeEmptyDOMElement();
  });

  it('never reports itself active', async () => {
    const onActive = vi.fn();

    render(<HeroStage onActive={onActive} />);

    // Given a tick, in case anything asynchronous was going to claim otherwise.
    await Promise.resolve();

    expect(onActive).not.toHaveBeenCalled();
  });

  it('leaves no canvas behind for a screen reader to meet', () => {
    render(<HeroStage />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
  });
});

describe('the hero tells the stylesheet what happened', () => {
  /*
   * `data-stage` is the whole interface between the scene and
   * `orchestration.css`, which hides the drawn sphere, the drawn glow, the
   * drawn aura and the drawn rings when it reads `on`. This asserts the
   * DEFAULT, because the default is the one that has to be safe: a hero that
   * started at `on` and corrected itself would flash a hole on every machine
   * that cannot render the scene.
   */
  it('starts at off, so nothing is hidden before there is something to hide it for', () => {
    render(
      <section data-stage="off">
        <HeroStage />
      </section>,
    );

    expect(document.querySelector('[data-stage]')).toHaveAttribute('data-stage', 'off');
  });
});

describe('colours that have to work on both themes', () => {
  /*
   * The regression these exist for is worth stating, because it looked like a
   * rendering fault rather than a colour mistake. The beads and the lattice
   * were `--bloom`, which is a pale sky on the light theme and a DEEP NAVY on
   * the dark one — it is a background wash, not a highlight. On the dark theme
   * the bead riding the inner ring rendered darker than the page behind it and
   * read as a hole punched through the ring.
   *
   * No token in the palette is light on both themes, so the scene derives one.
   */
  it('produces a highlight that is light on either theme', () => {
    for (const brand of [BRAND_LIGHT, BRAND_DARK]) {
      expect(luminance(lighten(brand, HIGHLIGHT_MIX))).toBeGreaterThan(luminance(brand));
      // Comfortably into the top half of the range, which is what "reads as a
      // highlight against a navy page" means in practice.
      expect(luminance(lighten(brand, HIGHLIGHT_MIX))).toBeGreaterThan(0.45);
    }
  });

  it('produces a core body that white text can sit on, on either theme', () => {
    // The hub paints "Sourcing" over the middle of the core in white. The
    // pale-crystal version of this scene was about 1.9:1 there.
    for (const brand of [BRAND_LIGHT, BRAND_DARK]) {
      expect(contrastWithWhite(darken(brand, DEEP_MIX))).toBeGreaterThanOrEqual(4.5);
    }
  });

  /*
   * The land is the half of the globe that is easy to forget.
   *
   * "Sourcing" is painted over the middle of the sphere, and what is behind it
   * is whatever has rotated there — which for most of every revolution is a
   * continent rather than an ocean. Holding only the ocean to 4.5:1 would give
   * a label that passes when the Pacific is facing us and fails when Africa is.
   */
  it('produces land that white text can sit on, on either theme', () => {
    for (const brand of [BRAND_LIGHT, BRAND_DARK]) {
      const land = mix(darken(brand, DEEP_MIX), brand, LAND_MIX);
      expect(contrastWithWhite(land)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('lifts the land clear of the ocean, on either theme', () => {
    /*
     * The other end of the same squeeze. A globe whose continents are within a
     * few percent of its sea is a plain blue ball, and the one thing the globe
     * is on the page to say is that it is the world.
     *
     * A ratio rather than a difference in luminance: on the light theme both
     * values are very dark, where a fixed difference would be an enormous
     * change, and on the dark theme both are mid, where the same difference
     * would be invisible.
     */
    for (const brand of [BRAND_LIGHT, BRAND_DARK]) {
      const ocean = darken(brand, DEEP_MIX);
      const land = mix(ocean, brand, LAND_MIX);

      expect(luminance(land) / (luminance(ocean) + 0.0001)).toBeGreaterThan(2);
    }
  });
});

describe('mixing colours', () => {
  it('lands on each end at the ends of the range', () => {
    expect(mix(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mix(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(mix(0x1d4ed8, 0x8ab4ff, 0)).toBe(0x1d4ed8);
  });

  it('mixes each channel independently', () => {
    // Half way from pure red to pure blue is neither, in both channels.
    // 0x80 rather than 0x7f in each: 255/2 is 127.5, and it rounds up.
    expect(mix(0xff0000, 0x0000ff, 0.5)).toBe(0x800080);
  });

  it('leaves black and white alone at the ends of the range', () => {
    expect(lighten(0x000000, 1)).toBe(0xffffff);
    expect(darken(0xffffff, 1)).toBe(0x000000);
    expect(lighten(0x1d4ed8, 0)).toBe(0x1d4ed8);
    expect(darken(0x1d4ed8, 0)).toBe(0x1d4ed8);
  });
});
