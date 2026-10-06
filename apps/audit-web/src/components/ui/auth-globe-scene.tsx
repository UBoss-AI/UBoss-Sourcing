/**
 * The earth beside a sign-in form.
 *
 * Everything expensive lives here, behind the `React.lazy` boundary in
 * `auth-globe.tsx`: three.js, Fiber, Drei and both earth textures. Somebody
 * whose browser or machine said no to a 3D scene downloads none of it, and the
 * panel they get instead is a finished picture — see that file.
 *
 * WHAT IS IN IT
 *
 *   - **The earth**, `components/ui/3d-globe.tsx`, turning slowly, with an
 *     atmosphere in the deployment's own brand hue.
 *   - **Fifteen pins**, one per sourcing hub, each carrying its country's
 *     two-letter code. They stand off the surface on stems and turn with it,
 *     and the half that is round the back is hidden — see the globe's own
 *     notes for why that matters when the heads are DOM rather than geometry.
 *   - **A depth field**, a thin shell of particles around the globe. Without
 *     it the earth reads as a sticker on a gradient; with it there is
 *     something in front of and behind the object, which is the whole of the
 *     illusion.
 *
 * **One file, three apps.** It sits beside `auth-form.tsx` under the same rule
 * that file states: the three copies are byte-identical, and a change to one
 * is a change to all three or the sign-in screens start drifting apart while
 * claiming to be one product.
 *
 * WHY THE PINS ARE INERT
 *
 * No handlers are passed, so the globe renders the heads as plain plates with
 * no tab stop and nothing for a screen reader to announce. The panel above
 * this is `aria-hidden`, and a focusable control inside an `aria-hidden`
 * container is a keyboard trap with no name — strictly worse than no control.
 * The pins say "this software moves goods between these places"; there is
 * nothing to press, so there is no button.
 *
 * WHY THE CITIES ARE HARD-CODED AND THE COLOURS ARE NOT
 *
 * The hubs are an illustration of what the software is *for*, not a claim
 * about any particular deployment — the same standing rule the storefront's
 * hero works under. Nothing here is read from the API and nothing here says a
 * given operator ships anywhere.
 *
 * The palette is the opposite: it is read from the same CSS custom properties
 * every other component uses, so a buyer who sets `--brand` to their own blue
 * gets an atmosphere in it without anybody editing this file.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Globe3D } from '@/components/ui/3d-globe';
import type { GlobeAnchor, GlobeMarker } from '@/components/ui/3d-globe';

/** The globe's radius in this scene. Everything else is expressed in these. */
const RADIUS = 2;

// ---------------------------------------------------------------------------
// The places
// ---------------------------------------------------------------------------

interface AuthHub {
  city: string;
  /** ISO 3166-1 alpha-2, and what the pin head actually shows. */
  code: string;
  lat: number;
  lng: number;
}

/**
 * Fifteen cities, each somewhere goods genuinely move through.
 *
 * Invented coordinates in the middle of an ocean are the detail that gives a
 * globe away, so every one of these is a real deep-water port.
 *
 * **Spread on purpose, and that is a design constraint rather than a
 * preference.** The first list here was the storefront hero's, which is
 * Europe-centred because that is where this product is sold — nine of its
 * thirteen hubs sat inside twenty degrees of each other. Drawn as pins on a
 * sphere a quarter of a screen wide, those nine landed on top of one another
 * in a heap somewhere over the Alps, and a heap of overlapping discs says
 * nothing at all. Europe keeps four, far enough apart to read as four; the
 * rest are the ports the long-haul lanes actually end at, which is also what
 * makes the globe worth being a globe rather than a map of one continent.
 *
 * A two-letter code rather than a flag: this project's own development
 * machines are Windows, where a regional-indicator pair renders as the two
 * letters anyway — so the letters are what is drawn, deliberately, at a size
 * chosen for them.
 */
const HUBS: readonly AuthHub[] = [
  // Europe: north, south-west, south-east and the Baltic.
  { city: 'Rotterdam', code: 'NL', lat: 51.9, lng: 4.5 },
  { city: 'Algeciras', code: 'ES', lat: 36.1, lng: -5.4 },
  { city: 'Piraeus', code: 'GR', lat: 37.9, lng: 23.6 },
  { city: 'Gdańsk', code: 'PL', lat: 54.4, lng: 18.6 },

  // The Americas. Four rather than two: the earth turns, and with only New
  // York and Santos on this side there was a stretch of every rotation where
  // the picture was a plain sphere with a pin on it.
  { city: 'Vancouver', code: 'CA', lat: 49.3, lng: -123.1 },
  { city: 'New York', code: 'US', lat: 40.7, lng: -74.0 },
  { city: 'Colón', code: 'PA', lat: 9.4, lng: -79.9 },
  { city: 'Santos', code: 'BR', lat: -23.9, lng: -46.3 },

  // Africa and the Gulf.
  { city: 'Durban', code: 'ZA', lat: -29.9, lng: 31.0 },
  { city: 'Dubai', code: 'AE', lat: 25.3, lng: 55.3 },

  // Asia and the Pacific.
  { city: 'Mumbai', code: 'IN', lat: 19.1, lng: 72.9 },
  { city: 'Singapore', code: 'SG', lat: 1.4, lng: 103.8 },
  { city: 'Shanghai', code: 'CN', lat: 31.2, lng: 121.5 },
  { city: 'Tokyo', code: 'JP', lat: 35.7, lng: 139.7 },
  { city: 'Sydney', code: 'AU', lat: -33.9, lng: 151.2 },
];

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

/**
 * One CSS custom property as a packed 0xRRGGBB integer.
 *
 * The tokens are stored as `"29 78 216"` — space-separated channels, so that
 * Tailwind can put an alpha into them — which is not a form any colour parser
 * accepts.
 */
function readChannel(styles: CSSStyleDeclaration, name: string, fallback: number): number {
  const raw = styles.getPropertyValue(name).trim();
  if (raw.length === 0) return fallback;

  const parts = raw.split(/[\s,]+/).map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return fallback;

  return ((parts[0] ?? 0) << 16) | ((parts[1] ?? 0) << 8) | (parts[2] ?? 0);
}

/** A colour mixed towards white. */
function lighten(colour: number, amount: number): number {
  const mix = (channel: number): number => Math.round(channel + (255 - channel) * amount);

  return (mix((colour >> 16) & 0xff) << 16) | (mix((colour >> 8) & 0xff) << 8) | mix(colour & 0xff);
}

/** `0x1d4ed8` as `#1d4ed8`. */
function hex(colour: number): string {
  return `#${colour.toString(16).padStart(6, '0')}`;
}

interface ScenePalette {
  /** The particle field. */
  brand: number;
  /**
   * The atmosphere, and it cannot be a token.
   *
   * No token in the palette is light on both themes: every one is defined for
   * its job against a particular background, and a glow around a lit sphere
   * has to read as light against a white page and against a near-black one.
   * So it is derived from `--brand` rather than picked.
   */
  halo: number;
}

function readScenePalette(): ScenePalette {
  const styles = getComputedStyle(document.documentElement);
  const brand = readChannel(styles, '--brand', 0x1d4ed8);

  return { brand, halo: lighten(brand, 0.62) };
}

/** The palette, kept current through both ways a theme can change. */
function useScenePalette(): ScenePalette {
  const [palette, setPalette] = useState<ScenePalette>(() => readScenePalette());

  useEffect(() => {
    const repaint = (): void => {
      setPalette(readScenePalette());
    };

    // The explicit toggle, which writes an attribute on <html>.
    const themeObserver = new MutationObserver(repaint);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });

    // And the operating system's own setting, for a deployment following it.
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    systemTheme.addEventListener('change', repaint);

    return () => {
      themeObserver.disconnect();
      systemTheme.removeEventListener('change', repaint);
    };
  }, []);

  return palette;
}

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

/**
 * The particle field.
 *
 * A hollow shell rather than a solid box: points near the camera's axis sit on
 * top of the globe and read as dirt on the screen rather than as distance.
 * It turns on its own axis, slowly and in the opposite sense to the earth, so
 * the two never look like one rigid object.
 */
function DepthField({ colour, count }: { colour: number; count: number }): React.JSX.Element {
  const pointsRef = useRef<THREE.Points>(null);

  const geometry = useMemo(() => {
    const positions = new Float32Array(count * 3);

    for (let i = 0; i < count; i += 1) {
      const distance = RADIUS * 1.9 + Math.random() * RADIUS * 3.4;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      positions[i * 3] = distance * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = distance * Math.sin(phi) * Math.sin(theta) * 0.7;
      positions[i * 3 + 2] = distance * Math.cos(phi);
    }

    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    return buffer;
  }, [count]);

  const material = useMemo(
    () =>
      new THREE.PointsMaterial({
        size: 0.028,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.55,
        // Off, so a particle behind the globe does not punch a hole in the
        // atmosphere it is seen through.
        depthWrite: false,
      }),
    [],
  );

  useEffect(() => {
    material.color.setHex(colour);
  }, [colour, material]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useFrame((_state, delta) => {
    const points = pointsRef.current;
    if (points !== null) points.rotation.y -= delta * 0.014;
  });

  return <points ref={pointsRef} geometry={geometry} material={material} />;
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

export interface AuthGlobeSceneProps {
  /** Where the earth sits in the panel, and how big it is. Measured by the
   * panel, because the maths from canvas pixels to world units needs the
   * camera and the camera only exists inside the Canvas. */
  anchor: GlobeAnchor | undefined;
  /**
   * Fiber's loop mode, and the panel's pause switch.
   *
   * `never` is a stopped loop that still holds its last frame — a hidden tab.
   * `demand` renders the frame it is asked for and then nothing, which is what
   * "one still image" means for somebody who asked for no motion.
   */
  frameloop: 'always' | 'demand' | 'never';
  /** How much scene this visit gets. */
  tier: 'full' | 'reduced';
  /** Told once, when a frame has genuinely rendered. */
  onReady: () => void;
}

/** How much scene each tier gets. */
const QUALITY = {
  full: { particles: 420, dpr: 1.5 },
  reduced: { particles: 190, dpr: 1.25 },
} as const;

/**
 * How big a pin head is.
 *
 * Drei scales a transformed `Html` by `distanceFactor / 400`, and the globe
 * asks for `radius * markerSize * 25` — so this puts the 13px plate at about a
 * twentieth of the globe's diameter, which is where a two-letter code is still
 * a two-letter code rather than a smudge.
 */
const MARKER_SIZE = 0.13;

export default function AuthGlobeScene({
  anchor,
  frameloop,
  tier,
  onReady,
}: AuthGlobeSceneProps): React.JSX.Element {
  const palette = useScenePalette();
  const quality = QUALITY[tier];

  const markers = useMemo<readonly GlobeMarker[]>(
    () =>
      HUBS.map((place) => ({
        lat: place.lat,
        lng: place.lng,
        label: place.city,
        content: (
          <span className="text-[6px] font-bold leading-none tracking-tight text-brand-fill">
            {place.code}
          </span>
        ),
      })),
    [],
  );

  return (
    <Globe3D
      anchor={anchor}
      frameloop={frameloop}
      dpr={quality.dpr}
      onReady={onReady}
      markers={markers}
      config={{
        radius: RADIUS,
        showAtmosphere: true,
        atmosphereColor: hex(palette.halo),
        atmosphereIntensity: 0.55,
        atmosphereBlur: 2.4,
        bumpScale: 4,
        // 11 degrees a second is one turn every thirty-three seconds. Slower
        // than the storefront's hero on purpose: this one sits beside a form
        // somebody is typing into, and anything faster pulls the eye off the
        // password field.
        autoRotateSpeed: 11,
        markerSize: MARKER_SIZE,
        /*
         * Lit nearly flat.
         *
         * A key light gives a planet a day side and a night side, and a pin
         * that has turned onto the night side is a pin nobody can read. Most
         * of the light is ambient so every longitude is about the same
         * brightness as it comes round, and the small directional that is left
         * only keeps the sphere from reading as a flat disc.
         */
        ambientIntensity: 2.6,
        pointLightIntensity: 0.75,
        parallax: 0.28,
      }}
    >
      <DepthField colour={palette.brand} count={quality.particles} />
    </Globe3D>
  );
}
