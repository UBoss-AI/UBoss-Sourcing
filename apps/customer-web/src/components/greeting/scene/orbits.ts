/**
 * The orbital paths, and the lights that travel them.
 *
 * Three rings round the globe: two in the storefront's sky blue and one warm
 * accent. The accent is the only warm thing in the scene and it is one ring out
 * of three on purpose — it is what stops a picture made entirely of blues going
 * monotone, and a second one would tip the whole composition orange.
 *
 * WHAT EACH RING IS MADE OF
 *
 * A path, one or two travelling nodes, and a trail behind each node. The trail
 * is a short arc of the same torus rather than a particle stream: a stream of
 * points is a buffer to rewrite on every frame and it flickers at the head,
 * where an arc is one draw call that never changes and simply rides along.
 *
 * WHY THE NESTING IS THREE DEEP
 *
 * `ring` carries the tilt and never moves. `carrier` turns about the ring's own
 * axis and is what actually animates. The node and its trail are children of
 * the carrier, so a node's position on its path is never computed — it is a
 * consequence of one rotation, which is both cheaper and impossible to get out
 * of step with the trail behind it.
 *
 * WHY THE RINGS DO NOT ALL TURN THE SAME WAY
 *
 * Two rings turning the same way at similar rates read as one thick ring being
 * spun. Alternating the direction is what makes three separate paths legible as
 * three, and it is also what guarantees that at any moment something is
 * crossing in front of the globe while something else is crossing behind it,
 * which is where the depth in the picture comes from.
 */
import type { StagePalette } from '../stage-palette';

/** The library, passed in rather than imported: see `HeroStage`'s dynamic import. */
type Three = typeof import('three');

/** Which of the palette's two ends a ring is drawn in. */
type OrbitTone = 'cool' | 'warm';

interface OrbitSpec {
  /** Distance from the globe's centre, in globe radii. */
  radius: number;
  /** Tilt about x, then yaw about y. Both in radians. */
  tilt: number;
  yaw: number;
  /**
   * Seconds for one lap. Negative runs the other way.
   *
   * **These are the numbers to change to make the orbits faster or slower.**
   * All three sit inside 12-20 seconds, which is the window where a travelling
   * light reads as purposeful: quicker looks agitated next to a globe taking 22
   * seconds to turn, and slower stops reading as travel at all.
   */
  seconds: number;
  tone: OrbitTone;
  /** How bright the path itself is. The nodes on it are always full strength. */
  opacity: number;
  /** Where each node sits on the path at the start, in turns (0-1). */
  phases: readonly number[];
}

const ORBITS: readonly OrbitSpec[] = [
  { radius: 1.26, tilt: 1.19, yaw: 0, seconds: 14, tone: 'cool', opacity: 0.5, phases: [0, 0.55] },
  { radius: 1.44, tilt: -0.62, yaw: 0.88, seconds: -18, tone: 'cool', opacity: 0.34, phases: [0.3] },
  { radius: 1.6, tilt: 0.36, yaw: -0.72, seconds: 16, tone: 'warm', opacity: 0.46, phases: [0.7] },
];

/** How long a light's trail is, in radians of its own orbit. */
const TRAIL_ARC = 0.85;

export interface Orbits {
  group: import('three').Group;
  update: (elapsed: number, delta: number) => void;
  repaint: (palette: StagePalette) => void;
  dispose: () => void;
}

/**
 * Build the orbits.
 *
 * `count` is how many of the three to build, so the reduced tier can drop the
 * outermost — which is the one that spends the most of its lap behind the
 * feature cards, and therefore the one whose absence costs the picture least.
 */
export function createOrbits(THREE: Three, palette: StagePalette, count: number): Orbits {
  const group = new THREE.Group();

  const geometries: import('three').BufferGeometry[] = [];
  const materials: import('three').Material[] = [];

  const toneColour = (tone: OrbitTone, colours: StagePalette): number =>
    tone === 'warm' ? colours.action : colours.highlight;

  const carriers: { carrier: import('three').Group; rate: number }[] = [];
  const tinted: { material: { color: import('three').Color }; tone: OrbitTone }[] = [];

  for (const spec of ORBITS.slice(0, count)) {
    const ring = new THREE.Group();
    ring.rotation.x = spec.tilt;
    ring.rotation.y = spec.yaw;
    group.add(ring);

    const colour = toneColour(spec.tone, palette);

    /* --- The path ------------------------------------------------------ */

    // Three radial segments, not eight. The tube is six thousandths of a globe
    // radius across, so it is never more than a pixel or two wide on screen and
    // its cross-section is something nobody can resolve. Eight would be five
    // hundred wasted triangles per ring.
    const pathGeometry = new THREE.TorusGeometry(spec.radius, 0.006, 3, 200);
    const pathMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHex(colour, THREE.SRGBColorSpace),
      transparent: true,
      opacity: spec.opacity,
      depthWrite: false,
    });

    geometries.push(pathGeometry);
    materials.push(pathMaterial);
    tinted.push({ material: pathMaterial, tone: spec.tone });
    ring.add(new THREE.Mesh(pathGeometry, pathMaterial));

    /* --- The lights riding it ------------------------------------------ */

    const nodeGeometry = new THREE.SphereGeometry(0.031, 14, 14);
    const nodeMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHex(colour, THREE.SRGBColorSpace),
    });

    // A second, larger and much fainter sphere around each node. It is the
    // cheapest honest glow there is: no sprite, no post-processing pass, and it
    // is real geometry, so an orbit passing behind the globe takes its glow
    // behind the globe with it instead of leaving a halo floating in front.
    const auraGeometry = new THREE.SphereGeometry(0.075, 14, 14);
    const auraMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHex(colour, THREE.SRGBColorSpace),
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const trailGeometry = new THREE.TorusGeometry(spec.radius, 0.011, 3, 48, TRAIL_ARC);
    const trailMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHex(colour, THREE.SRGBColorSpace),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    geometries.push(nodeGeometry, auraGeometry, trailGeometry);
    materials.push(nodeMaterial, auraMaterial, trailMaterial);
    tinted.push(
      { material: nodeMaterial, tone: spec.tone },
      { material: auraMaterial, tone: spec.tone },
      { material: trailMaterial, tone: spec.tone },
    );

    for (const phase of spec.phases) {
      const carrier = new THREE.Group();
      carrier.rotation.z = phase * Math.PI * 2;
      ring.add(carrier);

      const node = new THREE.Mesh(nodeGeometry, nodeMaterial);
      node.position.x = spec.radius;
      carrier.add(node);

      const aura = new THREE.Mesh(auraGeometry, auraMaterial);
      aura.position.x = spec.radius;
      carrier.add(aura);

      // The torus arc is drawn from angle zero forwards, so rotating the mesh
      // back by its own length puts its leading edge exactly under the node —
      // which is what makes it a trail rather than a streak running ahead.
      const trail = new THREE.Mesh(trailGeometry, trailMaterial);
      trail.rotation.z = -TRAIL_ARC;
      carrier.add(trail);

      carriers.push({ carrier, rate: (Math.PI * 2) / spec.seconds });
    }
  }

  return {
    group,

    update: (_elapsed, delta) => {
      for (const { carrier, rate } of carriers) carrier.rotation.z += delta * rate;
    },

    repaint: (colours) => {
      for (const entry of tinted) {
        entry.material.color.setHex(toneColour(entry.tone, colours), THREE.SRGBColorSpace);
      }
    },

    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

/** How many rings each tier gets. The reduced tier drops the outermost. */
export const ORBIT_COUNT = { full: ORBITS.length, reduced: 2 } as const;
