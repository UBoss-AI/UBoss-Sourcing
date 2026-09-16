/**
 * The sourcing globe.
 *
 * Everything inside the sphere's own silhouette, plus the lit platform it
 * stands on. The things that go *around* it — the orbits and the lights riding
 * them — are `orbits.ts`, and the camera, the lights and the loop that drives
 * both are `../HeroStage.tsx`.
 *
 * WHAT IT IS MADE OF, AND WHY IT IS MADE THAT WAY
 *
 * Nine layers, none of which is a photograph:
 *
 *   1. **An inner glow**, a back-faced sphere just under the surface. It is
 *      what stops the globe going flat black on its shadow side, and it is the
 *      only thing in the scene that pulses.
 *   2. **The ocean**, a metallic sphere. `MeshStandardMaterial` with high
 *      metalness and low roughness is what gives glass its behaviour under a
 *      moving light: a tight specular that travels across the surface as the
 *      light does, rather than a flat tint.
 *   3. **The land**, a shell 0.4% larger carrying a canvas texture whose sea is
 *      transparent. The coastlines come from `world-land.ts` — coordinates this
 *      repository owns, rasterised at runtime. No image is fetched, ever.
 *   4. **A geodesic network**, the restrained wireframe. An icosphere's edges
 *      rather than a latitude/longitude grid: a graticule reads as a school
 *      atlas and bunches at the poles, and an even triangulation reads as a
 *      network, which is what this page is about.
 *   5. **Connection points**, sitting on land and only on land. A light in the
 *      middle of the Pacific reads as a mistake.
 *   6. **Connection arcs** between a few of them, lifted off the surface.
 *   7. **Two titanium bands**, the structural detail. The one object in the
 *      scene with a bright tight specular and no colour of its own.
 *   8. **A rim light**, a Fresnel shell hugging the surface, which is what
 *      gives the silhouette its lit edge.
 *   9. **An atmosphere**, the same Fresnel much softer and much larger.
 *
 * WHY FRESNEL IS A SHADER AND NOT A TEXTURE
 *
 * The rim and the halo both need brightness that depends on the angle between
 * the surface and the eye, and nothing in three.js's stock materials expresses
 * that. The alternative is a radial-gradient sprite billboarded at the camera,
 * which is what most globes on the web do and which gives itself away the
 * moment anything passes in front of it — a sprite has no depth, so an orbit
 * crossing the halo is drawn either wholly over or wholly under it. Twelve
 * lines of GLSL is the cheaper and the more honest answer.
 *
 * COLOUR SPACE
 *
 * Every colour handed to a shader uniform is converted explicitly with
 * `setHex(value, SRGBColorSpace)`. Three.js converts the colours of its own
 * materials for you and does not touch a uniform you set yourself, so a rim
 * light built without that conversion comes out visibly paler than the metal
 * band beside it — for a while this looked like a lighting bug rather than a
 * colour-space one.
 */
import type { StagePalette } from '../stage-palette';
import { createLandMask, landPoints, lonLatToVector, paintWorld } from './world-land';

/** The library, passed in rather than imported: see `HeroStage`'s dynamic import. */
type Three = typeof import('three');

/**
 * How much globe this device is getting.
 *
 * Every field is something that costs either fill rate or memory, gathered in
 * one place so that the two tiers are readable side by side rather than
 * scattered through the builder as a dozen ternaries.
 */
export interface GlobeQuality {
  /** Sphere tessellation, width and height segments. */
  segments: readonly [number, number];
  /** The land texture's width in pixels. Height is half of it. */
  textureWidth: number;
  /** Candidate points tested against the land mask; roughly a third survive. */
  nodeSamples: number;
  /** How many great-circle connections are drawn between those points. */
  arcs: number;
  /** Whether the geodesic network is drawn at all. */
  network: boolean;
}

export const GLOBE_QUALITY: Readonly<Record<'full' | 'reduced', GlobeQuality>> = {
  full: { segments: [64, 48], textureWidth: 1024, nodeSamples: 520, arcs: 14, network: true },
  /*
   * The reduced tier is not the full one with a smaller number in each slot; it
   * is the set of layers that survive being small. The network goes entirely,
   * because a wireframe at a third of the pixel count stops reading as a mesh
   * and starts reading as moire, and the arcs go with it. What is kept is what
   * carries the idea: continents, a lit rim and some lights on land.
   */
  reduced: { segments: [40, 28], textureWidth: 512, nodeSamples: 260, arcs: 0, network: false },
};

/** One built globe, and the four things the stage does with it. */
export interface Globe {
  /** Added to the hub group by the caller. Built at radius 1. */
  group: import('three').Group;
  /** Advance the animation. `elapsed` is seconds since the scene started. */
  update: (elapsed: number, delta: number) => void;
  /** Re-read the colours, for a theme change. */
  repaint: (palette: StagePalette) => void;
  /** Release every geometry, material and texture. */
  dispose: () => void;
}

/**
 * How long one rotation takes, in seconds.
 *
 * **This is the number to change to make the globe turn faster or slower**, and
 * it is 22 rather than anything quicker on purpose. Below about 15 seconds the
 * motion starts to read as a spinning object and pulls the eye away from the
 * search bar, which is what the page is actually for; above about 30 it reads
 * as not moving at all and the effect is wasted. 22 is a rotation you notice
 * only if you look.
 */
export const GLOBE_ROTATION_SECONDS = 22;

/**
 * Where longitude zero faces when the scene starts.
 *
 * Tuned against the reference: Europe, Africa and the Middle East across the
 * front, which is the view a European buyer recognises as theirs. It only sets
 * the starting angle — the globe turns past every other view within a rotation.
 */
const INITIAL_SPIN = -0.55;

/** The Fresnel shell used twice, once tight on the surface and once as a halo. */
function fresnelMaterial(
  THREE: Three,
  colour: number,
  intensity: number,
  power: number,
  side: import('three').Side,
): import('three').ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color().setHex(colour, THREE.SRGBColorSpace) },
      uIntensity: { value: intensity },
      uPower: { value: power },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vView = -viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uPower;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        // How square-on this fragment is to the eye. 0 facing us, 1 at the
        // silhouette, which is exactly where a lit rim belongs.
        float facing = 1.0 - abs(dot(normalize(vView), normalize(vNormal)));
        gl_FragColor = vec4(uColor, pow(facing, uPower) * uIntensity);
      }
    `,
    side,
    transparent: true,
    // Additive so it lifts what is behind it rather than tinting it, and no
    // depth write so two of these plus the orbits can overlap in any order.
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

/** `rgb()` from a packed integer, for the canvas the land is painted on. */
function css(colour: number, alpha = 1): string {
  const r = (colour >> 16) & 0xff;
  const g = (colour >> 8) & 0xff;
  const b = colour & 0xff;

  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

export function createGlobe(THREE: Three, palette: StagePalette, quality: GlobeQuality): Globe {
  const group = new THREE.Group();
  group.rotation.y = INITIAL_SPIN;

  // The globe is tilted like a globe on a stand rather than stood bolt
  // upright. A sphere spinning about a perfectly vertical axis reads as a
  // loading spinner; a few degrees of tilt is what says "this is a planet".
  group.rotation.z = 0.28;

  const [widthSegments, heightSegments] = quality.segments;

  /* --- 1. The inner glow ------------------------------------------------ */

  const glowGeometry = new THREE.SphereGeometry(0.965, 32, 24);
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color().setHex(palette.highlight, THREE.SRGBColorSpace),
    transparent: true,
    opacity: 0.09,
    side: THREE.BackSide,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(glowGeometry, glowMaterial));

  /* --- 2. The ocean ----------------------------------------------------- */

  const oceanGeometry = new THREE.SphereGeometry(1, widthSegments, heightSegments);
  const oceanMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHex(palette.deep, THREE.SRGBColorSpace),
    /*
     * High metalness and low roughness, which is what makes this read as glass
     * rather than as paint. The trade is that a metal is lit almost entirely by
     * reflection, so on a scene with no environment map the shadow side would
     * go to nothing — the emissive floor below is what holds it up, and the
     * inner glow behind it does the rest.
     */
    metalness: 0.5,
    roughness: 0.42,
    emissive: new THREE.Color().setHex(palette.deep, THREE.SRGBColorSpace),
    emissiveIntensity: 0.1,
    transparent: true,
    opacity: 0.94,
  });
  group.add(new THREE.Mesh(oceanGeometry, oceanMaterial));

  /* --- 3. The land ------------------------------------------------------ */

  const textureWidth = quality.textureWidth;
  const landCanvas = document.createElement('canvas');
  landCanvas.width = textureWidth;
  landCanvas.height = textureWidth / 2;

  const landContext = landCanvas.getContext('2d');
  const landTexture = new THREE.CanvasTexture(landCanvas);
  landTexture.colorSpace = THREE.SRGBColorSpace;
  landTexture.anisotropy = 4;

  const drawLand = (colours: StagePalette): void => {
    if (landContext === null) return;

    paintWorld(landContext, landCanvas.width, landCanvas.height, {
      fill: css(colours.land),
      // The coastline is the highlight at a low alpha rather than a solid
      // line: solid, it outlined every island in white and the globe looked
      // like a vector map. At a quarter it reads as an edge catching the light.
      coast: css(colours.highlight, 0.62),
      coastWidth: 2.2,
    });

    landTexture.needsUpdate = true;
  };

  drawLand(palette);

  const landGeometry = new THREE.SphereGeometry(1.004, widthSegments, heightSegments);
  const landMaterial = new THREE.MeshBasicMaterial({
    map: landTexture,
    transparent: true,
    opacity: 0.96,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(landGeometry, landMaterial));

  /* --- 4. The geodesic network ------------------------------------------ */

  let networkGeometry: import('three').BufferGeometry | null = null;
  let networkSource: import('three').BufferGeometry | null = null;
  let networkMaterial: import('three').LineBasicMaterial | null = null;

  if (quality.network) {
    // Detail 2 is 320 faces. Detail 3 quadruples that and, at this size, the
    // edges start touching and the mesh turns into a grey film over the globe.
    networkSource = new THREE.IcosahedronGeometry(1.017, 2);
    networkGeometry = new THREE.WireframeGeometry(networkSource);
    networkMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color().setHex(palette.highlight, THREE.SRGBColorSpace),
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
    });
    group.add(new THREE.LineSegments(networkGeometry, networkMaterial));
  }

  /* --- 5. Connection points --------------------------------------------- */

  const mask = createLandMask();
  const sites = landPoints(quality.nodeSamples, mask);

  const nodePositions = new Float32Array(sites.length * 3);
  sites.forEach((site, index) => {
    const point = lonLatToVector(site[0], site[1], 1.014);
    nodePositions[index * 3] = point.x;
    nodePositions[index * 3 + 1] = point.y;
    nodePositions[index * 3 + 2] = point.z;
  });

  const nodeGeometry = new THREE.BufferGeometry();
  nodeGeometry.setAttribute('position', new THREE.BufferAttribute(nodePositions, 3));

  const nodeMaterial = new THREE.PointsMaterial({
    color: new THREE.Color().setHex(palette.highlight, THREE.SRGBColorSpace),
    size: 0.027,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  group.add(new THREE.Points(nodeGeometry, nodeMaterial));

  /* --- 6. Connection arcs ----------------------------------------------- */

  const arcGeometries: import('three').BufferGeometry[] = [];
  let arcMaterial: import('three').LineBasicMaterial | null = null;

  if (quality.arcs > 0 && sites.length > 8) {
    arcMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color().setHex(palette.highlight, THREE.SRGBColorSpace),
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    /*
     * Which sites are joined is fixed rather than random.
     *
     * A random pick is a different picture on every page load, and a few of
     * those pictures are bad ones — three arcs stacked along the same great
     * circle, or a bundle all leaving the same city. Striding through the list
     * by two co-prime steps gives one arrangement, chosen once, that spreads
     * the arcs over the whole globe.
     */
    for (let i = 0; i < quality.arcs; i += 1) {
      const from = sites[(i * 7) % sites.length];
      const to = sites[(i * 23 + 11) % sites.length];
      if (from === undefined || to === undefined) continue;

      const start = lonLatToVector(from[0], from[1], 1.015);
      const end = lonLatToVector(to[0], to[1], 1.015);

      const a = new THREE.Vector3(start.x, start.y, start.z);
      const b = new THREE.Vector3(end.x, end.y, end.z);

      // How far the arc bows off the surface: proportional to how far apart
      // its ends are, so a short hop stays low and a transatlantic one lifts.
      const lift = 1 + a.distanceTo(b) * 0.17;
      const mid = a.clone().add(b).normalize().multiplyScalar(lift);

      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(24));
      arcGeometries.push(geometry);
      group.add(new THREE.Line(geometry, arcMaterial));
    }
  }

  /* --- 7. The titanium bands -------------------------------------------- */

  const bandGeometry = new THREE.TorusGeometry(1.045, 0.011, 8, 180);
  const bandMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHex(palette.steel, THREE.SRGBColorSpace),
    metalness: 1,
    roughness: 0.24,
  });

  /*
   * Two hoops, and neither of them is edge-on.
   *
   * A torus lies in the XY plane, so `rotation.x = PI/2` lays it flat — and
   * flat, from a camera that is level with it, is a perfectly straight line
   * drawn across the middle of the globe. That was the first attempt and it
   * looked like a scratch on the lens rather than like a band round a sphere.
   * At 1.30 radians the hoop is about a quarter as tall as it is wide, which is
   * the ellipse the eye reads as a ring seen from slightly above, and it is
   * also far enough off the horizontal to stay clear of the word in the middle.
   */
  const bands = [
    { x: 1.3, y: 0 },
    { x: 1.3, y: 1.25 },
  ].map((tilt) => {
    const mesh = new THREE.Mesh(bandGeometry, bandMaterial);
    mesh.rotation.x = tilt.x;
    mesh.rotation.y = tilt.y;
    // Added to the group's PARENT space by staying outside the spin below:
    // a band that turned with the globe would be a hoop rolling round it.
    return mesh;
  });

  /* --- 8 & 9. Rim and atmosphere ---------------------------------------- */

  const rimGeometry = new THREE.SphereGeometry(1.012, widthSegments, heightSegments);
  const rimMaterial = fresnelMaterial(THREE, palette.highlight, 0.72, 3.4, THREE.FrontSide);
  group.add(new THREE.Mesh(rimGeometry, rimMaterial));

  const atmosphereGeometry = new THREE.SphereGeometry(1.24, 48, 32);
  const atmosphereMaterial = fresnelMaterial(THREE, palette.brand, 0.75, 2.1, THREE.BackSide);

  /*
   * The spinning part and the standing part.
   *
   * Everything above that is painted ON the world turns; the bands, the halo
   * and the platform do not. Splitting them here rather than rotating meshes
   * one by one is what guarantees they cannot drift out of step.
   */
  const spin = group;
  const still = new THREE.Group();
  for (const band of bands) still.add(band);
  still.add(new THREE.Mesh(atmosphereGeometry, atmosphereMaterial));

  /* --- The platform ----------------------------------------------------- */

  const platform = new THREE.Group();
  platform.position.y = -1.42;
  platform.rotation.x = -Math.PI / 2;
  still.add(platform);

  const haloCanvas = document.createElement('canvas');
  haloCanvas.width = 128;
  haloCanvas.height = 128;
  const haloContext = haloCanvas.getContext('2d');

  const haloTexture = new THREE.CanvasTexture(haloCanvas);
  haloTexture.colorSpace = THREE.SRGBColorSpace;

  const drawHalo = (colours: StagePalette): void => {
    if (haloContext === null) return;

    haloContext.clearRect(0, 0, 128, 128);
    const gradient = haloContext.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, css(colours.highlight, 0.5));
    gradient.addColorStop(0.45, css(colours.brand, 0.18));
    gradient.addColorStop(1, css(colours.brand, 0));
    haloContext.fillStyle = gradient;
    haloContext.fillRect(0, 0, 128, 128);

    haloTexture.needsUpdate = true;
  };

  drawHalo(palette);

  const discGeometry = new THREE.CircleGeometry(2.1, 48);
  const discMaterial = new THREE.MeshBasicMaterial({
    map: haloTexture,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  platform.add(new THREE.Mesh(discGeometry, discMaterial));

  // Three hairline rings on that floor. They are what make the disc read as a
  // machined plate the globe is standing over rather than as a smudge.
  const plateGeometries: import('three').RingGeometry[] = [];
  const plateMaterials: import('three').MeshBasicMaterial[] = [];

  for (const [inner, alpha] of [
    [1.08, 0.5],
    [1.4, 0.32],
    [1.76, 0.2],
  ] as const) {
    const geometry = new THREE.RingGeometry(inner, inner + 0.012, 96);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHex(palette.highlight, THREE.SRGBColorSpace),
      transparent: true,
      opacity: alpha,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    plateGeometries.push(geometry);
    plateMaterials.push(material);
    platform.add(new THREE.Mesh(geometry, material));
  }

  /* --- Assembly --------------------------------------------------------- */

  const root = new THREE.Group();
  root.add(spin);
  root.add(still);

  const ROTATION_RATE = (Math.PI * 2) / GLOBE_ROTATION_SECONDS;

  return {
    group: root,

    update: (elapsed, delta) => {
      spin.rotation.y += delta * ROTATION_RATE;

      /*
       * The one pulse in the whole scene, and it is deliberately hard to see.
       *
       * A sixth of a cycle per second is slower than breathing, and the swing
       * is three hundredths of an opacity. Anything faster or wider becomes a
       * throb, and a page-sized object throbbing behind a search bar is both
       * distracting and, past a few hertz, an accessibility problem. This is
       * nowhere near that: the full cycle takes about nine seconds.
       */
      glowMaterial.opacity = 0.09 + Math.sin(elapsed * 0.68) * 0.025;
      nodeMaterial.opacity = 0.9 + Math.sin(elapsed * 0.53) * 0.08;
    },

    repaint: (colours) => {
      glowMaterial.color.setHex(colours.highlight, THREE.SRGBColorSpace);
      oceanMaterial.color.setHex(colours.deep, THREE.SRGBColorSpace);
      oceanMaterial.emissive.setHex(colours.deep, THREE.SRGBColorSpace);
      nodeMaterial.color.setHex(colours.highlight, THREE.SRGBColorSpace);
      bandMaterial.color.setHex(colours.steel, THREE.SRGBColorSpace);
      networkMaterial?.color.setHex(colours.highlight, THREE.SRGBColorSpace);
      arcMaterial?.color.setHex(colours.highlight, THREE.SRGBColorSpace);

      (rimMaterial.uniforms.uColor?.value as import('three').Color | undefined)?.setHex(
        colours.highlight,
        THREE.SRGBColorSpace,
      );
      (atmosphereMaterial.uniforms.uColor?.value as import('three').Color | undefined)?.setHex(
        colours.brand,
        THREE.SRGBColorSpace,
      );

      for (const material of plateMaterials) {
        material.color.setHex(colours.highlight, THREE.SRGBColorSpace);
      }

      drawLand(colours);
      drawHalo(colours);
    },

    dispose: () => {
      glowGeometry.dispose();
      glowMaterial.dispose();
      oceanGeometry.dispose();
      oceanMaterial.dispose();
      landGeometry.dispose();
      landMaterial.dispose();
      landTexture.dispose();
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      bandGeometry.dispose();
      bandMaterial.dispose();
      rimGeometry.dispose();
      rimMaterial.dispose();
      atmosphereGeometry.dispose();
      atmosphereMaterial.dispose();
      discGeometry.dispose();
      discMaterial.dispose();
      haloTexture.dispose();

      networkGeometry?.dispose();
      networkSource?.dispose();
      networkMaterial?.dispose();
      arcMaterial?.dispose();

      for (const geometry of arcGeometries) geometry.dispose();
      for (const geometry of plateGeometries) geometry.dispose();
      for (const material of plateMaterials) material.dispose();
    },
  };
}
