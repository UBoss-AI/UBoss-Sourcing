/**
 * The hex-dot globe.
 *
 * The one on the front page: a dark sphere whose continents are drawn as a
 * field of small hexagons, a lit atmosphere around it, and trade arcs that
 * travel between real sourcing hubs. It turns on its own and a visitor can
 * take hold of it and spin it.
 *
 * ---
 *
 * WHAT THIS IS BUILT ON, AND WHAT IT IS NOT
 *
 * `three-globe`, which is the library behind the "GitHub globe" treatment
 * Aceternity UI popularised. That component is written for React Three Fiber;
 * this page already owns a three.js renderer, a camera and a frame loop in
 * `HeroStage.tsx`, so the globe is built as a plain `THREE.Object3D` and
 * dropped into the scene that already exists. Adding Fiber and Drei to render
 * one object inside a renderer we already have would have cost about 300 KB
 * and a second reconciler for no behaviour.
 *
 * It implements the SAME `Globe` interface as `globe.ts`, deliberately: the
 * stage builds it, calls `update` each frame, `repaint` on a theme change and
 * `dispose` on unmount, and knows nothing else about it. Swapping the two is
 * one import.
 *
 * ---
 *
 * WHERE THE LAND COMES FROM
 *
 * `world-land.ts` — coordinates this repository owns, already used by the
 * previous globe to rasterise its coastlines. They are converted to GeoJSON
 * polygons here because `three-globe` speaks GeoJSON.
 *
 * **No image and no map data is ever fetched.** That was true of the globe
 * this replaces and it stays true: the front page of a medical marketplace
 * should not make a request to a tile server, and a customer running this
 * behind their own firewall should not have to allow one.
 */
import type * as ThreeNamespace from 'three';
import type ThreeGlobeInstance from 'three-globe';
import { LAND, type Ring } from './world-land';
import type { StagePalette } from '../stage-palette';

type Three = typeof ThreeNamespace;

/** Mirrors the contract in `globe.ts`, so the stage cannot tell them apart. */
export interface HexGlobe {
  group: ThreeNamespace.Group;
  update: (elapsed: number, delta: number) => void;
  repaint: (palette: StagePalette) => void;
  dispose: () => void;
  /** Take hold of it. `dx` is a horizontal drag in pixels. */
  drag: (dx: number, dy: number) => void;
  /** Let go. The idle rotation eases back in rather than snapping. */
  release: () => void;
}

export interface HexGlobeQuality {
  /**
   * The H3 grid resolution, 0-15, and it must be a whole number.
   *
   * NOT a size in degrees — `three-globe` hexagonalises with Uber's H3, and
   * passing it a fraction throws `Resolution argument was outside of
   * acceptable range` before a single hexagon is drawn.
   *
   * It is also the single biggest cost in the scene, because each step up is
   * roughly seven times the cells: 3 is about 12,000 worldwide and reads as a
   * dotted map at the size this sits at on a laptop; 4 is about 80,000 and
   * drops frames on anything without a discrete GPU.
   */
  hexResolution: number;
  /** Fraction of each hexagon's cell it fills. Below 1 leaves the gaps. */
  hexMargin: number;
  /** How many trade arcs travel at once. Zero on the reduced tier. */
  arcs: number;
}

export const HEX_GLOBE_QUALITY: Readonly<Record<'full' | 'reduced', HexGlobeQuality>> = {
  full: { hexResolution: 3, hexMargin: 0.72, arcs: 10 },
  /*
   * Not the full tier with smaller numbers: the arcs go entirely. At a third
   * of the width an arc is two pixels of moving line, which reads as a
   * rendering artefact rather than as a route, and each one is an animated
   * material the phone is paying for every frame.
   */
  reduced: { hexResolution: 2, hexMargin: 0.7, arcs: 0 },
};

/**
 * Sourcing lanes, as real places.
 *
 * Europe-centred because that is where this product is sold, and each end is a
 * city with a port or an airport that medical goods genuinely move through.
 * Invented coordinates in the middle of an ocean are the detail that gives a
 * globe away.
 */
const LANES: readonly { from: [number, number]; to: [number, number] }[] = [
  { from: [4.4, 51.2], to: [-0.1, 51.5] }, // Antwerp — London
  { from: [4.4, 51.2], to: [8.7, 50.1] }, // Antwerp — Frankfurt
  { from: [8.7, 50.1], to: [12.5, 41.9] }, // Frankfurt — Rome
  { from: [4.9, 52.4], to: [23.7, 38.0] }, // Amsterdam — Athens
  { from: [2.3, 48.9], to: [-3.7, 40.4] }, // Paris — Madrid
  { from: [21.0, 52.2], to: [4.4, 51.2] }, // Warsaw — Antwerp
  { from: [4.4, 51.2], to: [72.9, 19.1] }, // Antwerp — Mumbai
  { from: [8.7, 50.1], to: [103.8, 1.4] }, // Frankfurt — Singapore
  { from: [-0.1, 51.5], to: [-74.0, 40.7] }, // London — New York
  { from: [4.9, 52.4], to: [121.5, 31.2] }, // Amsterdam — Shanghai
];

/**
 * The land, as GeoJSON.
 *
 * `three-globe` takes features and hexagonalises their interiors. The rings in
 * `world-land.ts` are already closed loops of `[lon, lat]`, which is GeoJSON's
 * own coordinate order, so this is a wrapper rather than a conversion.
 */
function landFeatures(rings: readonly Ring[]): object[] {
  return rings.map((ring) => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring.map(([lon, lat]) => [lon, lat])] },
  }));
}

/** `#rrggbb` from a palette entry, which is what three-globe's accessors want. */
function hex(colour: number): string {
  return `#${colour.toString(16).padStart(6, '0')}`;
}

/**
 * How long one idle rotation takes, in seconds.
 *
 * The same 22 the previous globe used, and for the same reason: below about 15
 * it reads as a spinning object and pulls the eye off the search bar, which is
 * what the page is for; above about 30 it reads as not moving at all.
 */
export const HEX_GLOBE_ROTATION_SECONDS = 22;

/** Where longitude zero faces at the start: Europe, Africa and the Middle East. */
const INITIAL_SPIN = -0.55;

/**
 * Build it.
 *
 * `ThreeGlobe` is imported by the caller and passed in, for the same reason
 * `THREE` is: `HeroStage` loads the whole scene lazily, so nothing here is in
 * the bundle a visitor downloads before they have scrolled to it.
 */
export function createHexGlobe(
  THREE: Three,
  ThreeGlobe: new (options?: { animateIn?: boolean }) => ThreeGlobeInstance,
  palette: StagePalette,
  quality: HexGlobeQuality,
): HexGlobe {
  const group = new THREE.Group();

  /*
   * `animateIn: false`.
   *
   * The library's own entrance grows the globe from nothing over a second and
   * a half. The stage already has its own arrival animation for the whole hub,
   * and two easing curves running against each other on the same object is the
   * thing that makes a page feel unfinished rather than polished.
   */
  const globe = new ThreeGlobe({ animateIn: false });

  const paint = (current: StagePalette): void => {
    globe
      .hexPolygonsData(landFeatures(LAND))
      .hexPolygonResolution(quality.hexResolution)
      .hexPolygonMargin(quality.hexMargin)
      // Flat, unlit hexagons. Lighting them would put a specular on each of
      // several thousand instances and turn the continents into glitter.
      .hexPolygonUseDots(false)
      .hexPolygonColor(() => hex(current.land))
      .showAtmosphere(true)
      .atmosphereColor(hex(current.bloom))
      .atmosphereAltitude(0.17);

    if (quality.arcs > 0) {
      globe
        .arcsData(LANES.slice(0, quality.arcs))
        .arcColor(() => [hex(current.brand), hex(current.action)])
        .arcAltitudeAutoScale(0.42)
        .arcStroke(0.45)
        // A travelling dash rather than a solid line: a static arc reads as a
        // drawn-on decoration, and the movement is what says "goods go this
        // way" without a label.
        .arcDashLength(0.4)
        .arcDashGap(0.85)
        .arcDashInitialGap(() => Math.random())
        .arcDashAnimateTime(3600);
    }
  };

  paint(palette);

  /*
   * The globe is built at three-globe's own radius of 100 and the stage works
   * at radius 1, so it is scaled once here rather than every call site being
   * told about the difference.
   */
  const sphere = globe as unknown as ThreeNamespace.Object3D;
  sphere.scale.setScalar(1 / 100);
  group.add(sphere);
  group.rotation.y = INITIAL_SPIN;

  /*
   * Dragging.
   *
   * `velocity` is what the pointer has added; it decays back to zero, so
   * letting go coasts to a stop and the idle rotation takes over rather than
   * the globe snapping back to where it would have been. `held` stops the idle
   * rotation while a finger or a cursor is down.
   */
  let velocityY = 0;
  let velocityX = 0;
  let held = false;

  return {
    group,

    update: (_elapsed, delta) => {
      // Idle rotation, only while nobody has hold of it.
      if (!held) {
        group.rotation.y += (Math.PI * 2 * delta) / HEX_GLOBE_ROTATION_SECONDS;
      }

      group.rotation.y += velocityY * delta;
      // Tilt is clamped: past about 60 degrees the globe is being looked at
      // from above, the arcs cross the silhouette and it stops reading as a
      // world.
      group.rotation.x = Math.min(0.9, Math.max(-0.9, group.rotation.x + velocityX * delta));

      // Exponential decay, framerate-independent. A linear damping would coast
      // for a different distance on a 144 Hz screen than on a 60 Hz one.
      const damping = Math.exp(-2.6 * delta);
      velocityY *= damping;
      velocityX *= damping;
    },

    repaint: paint,

    drag: (dx, dy) => {
      held = true;
      // Pixels to radians per second. 0.012 makes a 100px flick spin it about
      // a fifth of a turn, which is enough to feel responsive and not enough
      // to lose the continent being looked at.
      velocityY = dx * 0.012;
      velocityX = dy * 0.006;
    },

    release: () => {
      held = false;
    },

    dispose: () => {
      group.remove(sphere);

      sphere.traverse((child) => {
        const mesh = child as Partial<ThreeNamespace.Mesh>;
        mesh.geometry?.dispose();

        const material = mesh.material;
        if (Array.isArray(material)) for (const entry of material) entry.dispose();
        else material?.dispose();
      });
    },
  };
}
