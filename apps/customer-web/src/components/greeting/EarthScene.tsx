/**
 * The greeting's scene.
 *
 * Everything that is expensive lives here, behind the `React.lazy` boundary in
 * `HeroStage.tsx`: three.js, Fiber, Drei, both earth textures and the geometry
 * below. A visitor whose device said no to the scene, or who never scrolled
 * far enough to need it, downloads none of it.
 *
 * WHAT IS IN IT
 *
 *   - **The earth**, `components/ui/3d-globe.tsx` — a textured sphere with an
 *     atmosphere, lit flat so that no part of it is ever in shadow. It is a
 *     mark before it is a planet, and a mark with a night side is half a mark.
 *   - **The lanes**, drawn between real sourcing hubs, with a light travelling
 *     each one. They turn with the surface, because they are places.
 *     Nothing is pinned to them: a flag on a stick over each city was tried
 *     and it read as a map with stickers on it rather than as the earth.
 *   - **Three orbits**, `scene/orbits.ts`, unchanged from the globe this
 *     replaced. They do *not* turn with the surface; they circle it.
 *   - **A depth field and a floor**, which are what stop the earth reading as
 *     a sticker on a gradient. The fog is doing most of that work: without it
 *     every particle is equally bright at one unit and at twenty, and the eye
 *     has nothing to build distance from.
 *
 * WHY THE COLOURS ARE READ RATHER THAN WRITTEN
 *
 * Every colour comes from the same CSS custom properties the rest of the
 * storefront uses, re-read when the theme changes — both the explicit toggle
 * and the system's own setting. A scene with its own palette is a second
 * palette, and a second palette drifts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Globe3D } from '@/components/ui/3d-globe';
import type { GlobeAnchor } from '@/components/ui/3d-globe';
import { LANES, hub } from './scene/hubs';
import { ORBIT_COUNT, createOrbits } from './scene/orbits';
import { readStagePalette } from './stage-palette';
import type { StagePalette } from './stage-palette';

/** The globe's own radius in this scene. Everything else is in these units. */
const RADIUS = 2;

export interface EarthSceneProps {
  /** Where the globe sits over the hero, measured by `HeroStage`. */
  anchor: GlobeAnchor | undefined;
  /** `full` gets every lane and three orbits; `reduced` gets neither. */
  tier: 'full' | 'reduced';
  /** Fiber's loop mode: the pause switch for an off-screen or hidden hero. */
  frameloop: 'always' | 'demand' | 'never';
  /** Told once, when a frame has genuinely rendered. */
  onReady: () => void;
}

/** How much of the scene each tier gets. */
const QUALITY = {
  full: { lanes: LANES.length, particles: 620, dpr: 1.5 },
  /*
   * Not the full tier with smaller numbers: the lanes go entirely. At a third
   * of the width an arc is two pixels of moving line, which reads as a
   * rendering artefact rather than as a route.
   */
  reduced: { lanes: 0, particles: 280, dpr: 1.25 },
} as const;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** The storefront's palette, kept current through both ways it can change. */
function useStagePalette(): StagePalette {
  const [palette, setPalette] = useState<StagePalette>(() => readStagePalette());

  useEffect(() => {
    const repaint = (): void => {
      setPalette(readStagePalette());
    };

    const themeObserver = new MutationObserver(repaint);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });

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
// The lanes
// ---------------------------------------------------------------------------

/** A point on the sphere, in the same orientation the globe's texture uses. */
function onSphere(lat: number, lng: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);

  return new THREE.Vector3(
    -(radius * Math.sin(phi) * Math.cos(theta)),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

/**
 * Trade lanes, and a light travelling each one.
 *
 * The arc is a quadratic curve whose control point is the midpoint of the two
 * cities pushed away from the centre — so a hop between Antwerp and London
 * stays low and a run to Shanghai climbs, which is what the eye expects of a
 * route on a globe.
 *
 * A static line reads as a drawing on the surface; a light moving along it
 * reads as traffic. That is the whole reason the bead exists, and it is the
 * cheapest moving thing in the scene: one small sphere per lane, positioned
 * from a curve that was sampled once.
 */
function TradeLanes({ palette, count }: { palette: StagePalette; count: number }): React.JSX.Element | null {
  const beadsRef = useRef<THREE.Group>(null);

  const lanes = useMemo(() => {
    return LANES.slice(0, count)
      .map(([fromId, toId]) => {
        const from = hub(fromId);
        const to = hub(toId);
        if (from === undefined || to === undefined) return null;

        const start = onSphere(from.lat, from.lng, RADIUS);
        const end = onSphere(to.lat, to.lng, RADIUS);

        // Higher for a longer hop: the lift is a share of how far apart the
        // ends are, so every arc clears the surface by a similar-looking
        // amount whatever its length.
        const lift = 1 + start.distanceTo(end) / (RADIUS * 3.4);
        const control = start.clone().add(end).multiplyScalar(0.5).normalize()
          .multiplyScalar(RADIUS * lift);

        const curve = new THREE.QuadraticBezierCurve3(start, control, end);

        return {
          curve,
          geometry: new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)),
          // Deliberately not all in step: lanes that pulse together read as an
          // animation, and lanes that do not read as traffic.
          phase: Math.random(),
          seconds: 3.4 + Math.random() * 2.2,
        };
      })
      .filter((lane): lane is NonNullable<typeof lane> => lane !== null);
  }, [count]);

  const material = useMemo(
    () => new THREE.LineBasicMaterial({ transparent: true, opacity: 0.38 }),
    [],
  );
  const beadMaterial = useMemo(() => new THREE.MeshBasicMaterial(), []);
  const beadGeometry = useMemo(() => new THREE.SphereGeometry(RADIUS * 0.011, 8, 8), []);

  useEffect(() => {
    material.color.setHex(palette.highlight);
    beadMaterial.color.setHex(palette.action);
  }, [palette, material, beadMaterial]);

  useEffect(() => {
    return () => {
      for (const lane of lanes) lane.geometry.dispose();
      material.dispose();
      beadMaterial.dispose();
      beadGeometry.dispose();
    };
  }, [lanes, material, beadMaterial, beadGeometry]);

  useFrame((state) => {
    const group = beadsRef.current;
    if (group === null) return;

    const elapsed = state.clock.getElapsedTime();

    lanes.forEach((lane, index) => {
      const bead = group.children[index];
      if (bead === undefined) return;

      const t = (lane.phase + elapsed / lane.seconds) % 1;
      bead.position.copy(lane.curve.getPointAt(t));
      // Fading in at both ends, so a light does not pop into existence over a
      // city and vanish over another one.
      const fade = Math.sin(t * Math.PI);
      bead.scale.setScalar(0.4 + fade * 1.4);
    });
  });

  /*
   * The lines, built once into a group rather than as thirteen `<primitive>`
   * children. `new THREE.Line(...)` inside JSX would construct a fresh object
   * on every render — and a render happens on every theme change and every
   * resize, so the scene would quietly fill up with orphaned lines.
   */
  const lines = useMemo(() => {
    const group = new THREE.Group();
    for (const lane of lanes) group.add(new THREE.Line(lane.geometry, material));

    return group;
  }, [lanes, material]);

  if (lanes.length === 0) return null;

  return (
    <group>
      <primitive object={lines} />

      <group ref={beadsRef}>
        {lanes.map((_lane, index) => (
          <mesh key={`bead-${String(index)}`} geometry={beadGeometry} material={beadMaterial} />
        ))}
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// The orbits
// ---------------------------------------------------------------------------

/**
 * The three rings, straight out of `scene/orbits.ts`.
 *
 * That module builds a plain `THREE.Group` and knows nothing about React,
 * which is exactly why it survived the move to Fiber untouched: `<primitive>`
 * puts an object three.js already built into the tree, and `useFrame` drives
 * the same `update` the old imperative loop called.
 */
function Orbits({ palette, count }: { palette: StagePalette; count: number }): React.JSX.Element {
  /*
   * The palette the rings are BUILT with, held in a ref.
   *
   * Rebuilding three rings and their beads because a colour changed would be
   * three geometries and six materials thrown away for something `repaint`
   * does in place — so the build depends on the count alone, and the effect
   * below carries every later theme change into it.
   */
  const initialPalette = useRef(palette);
  const orbits = useMemo(() => createOrbits(THREE, initialPalette.current, count), [count]);

  useEffect(() => {
    orbits.repaint(palette);
  }, [orbits, palette]);

  useEffect(() => {
    return () => {
      orbits.dispose();
    };
  }, [orbits]);

  useFrame((state, delta) => {
    orbits.update(state.clock.getElapsedTime(), delta);
  });

  return <primitive object={orbits.group} />;
}

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

/**
 * The particle field.
 *
 * A hollow shell rather than a solid box: points near the camera's axis sit on
 * top of the globe and read as dirt on the screen rather than as distance.
 */
function DepthField({ palette, count }: { palette: StagePalette; count: number }): React.JSX.Element {
  const pointsRef = useRef<THREE.Points>(null);

  const geometry = useMemo(() => {
    const positions = new Float32Array(count * 3);

    for (let i = 0; i < count; i += 1) {
      const radius = 3.4 + Math.random() * 7.2;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta) * 0.62;
      positions[i * 3 + 2] = radius * Math.cos(phi) - 2.4;
    }

    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    return buffer;
  }, [count]);

  const material = useMemo(
    () =>
      new THREE.PointsMaterial({
        size: 0.031,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
      }),
    [],
  );

  useEffect(() => {
    material.color.setHex(palette.brand);
  }, [palette, material]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useFrame((_state, delta) => {
    const points = pointsRef.current;
    if (points !== null) points.rotation.y += delta * 0.012;
  });

  return <points ref={pointsRef} geometry={geometry} material={material} />;
}

/**
 * The floor.
 *
 * The engineering grid the CSS backdrop draws flat, laid down in perspective
 * so it actually recedes. This is the layer that says there is a floor under
 * this, and it is why the earth reads as floating rather than as pasted on.
 */
function Floor({ palette }: { palette: StagePalette }): React.JSX.Element {
  const grid = useMemo(() => new THREE.GridHelper(34, 34), []);

  useEffect(() => {
    grid.material.transparent = true;
    grid.material.opacity = 0.085;
    grid.material.color.setHex(palette.brand);
    grid.position.y = -2.9;
  }, [grid, palette]);

  useEffect(() => {
    return () => {
      grid.geometry.dispose();
      grid.material.dispose();
    };
  }, [grid]);

  return <primitive object={grid} />;
}

/**
 * The travelling specular.
 *
 * One light circling slowly behind the camera's shoulder. With every light
 * nailed down the highlights are nailed down too, and the globe looks like a
 * photograph of a globe — correct, and inert. Its period is deliberately not a
 * multiple of the earth's rotation, so the two never fall into step.
 */
function Sweep({ palette }: { palette: StagePalette }): React.JSX.Element {
  const lightRef = useRef<THREE.PointLight>(null);

  useFrame((state) => {
    const light = lightRef.current;
    if (light === null) return;

    const angle = state.clock.getElapsedTime() * 0.242;
    light.position.set(Math.cos(angle) * 3.4, 1.9, Math.sin(angle) * 2.2 + 3.4);
  });

  return <pointLight ref={lightRef} color={palette.steel} intensity={26} distance={22} decay={2} />;
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

export default function EarthScene({
  anchor,
  tier,
  frameloop,
  onReady,
}: EarthSceneProps): React.JSX.Element {
  const palette = useStagePalette();
  const quality = QUALITY[tier];

  const atmosphere = useMemo(
    () => `#${palette.highlight.toString(16).padStart(6, '0')}`,
    [palette.highlight],
  );

  return (
    <Globe3D
      anchor={anchor}
      frameloop={frameloop}
      dpr={quality.dpr}
      onReady={onReady}
      config={{
        radius: RADIUS,
        atmosphereColor: atmosphere,
        atmosphereIntensity: 0.6,
        atmosphereBlur: 2.4,
        bumpScale: 4,
        // 16.4 degrees a second is one turn every 22 seconds, which is the
        // same rate the globe this replaced turned at. Below about 15 seconds
        // a turn it reads as a spinning object and pulls the eye off the
        // search bar, which is what the page is actually for.
        autoRotateSpeed: 16.4,
        markerSize: 0.06,
        /*
         * Lit flat, on purpose.
         *
         * A key light gives a planet a day side and a night side, which is
         * what a planet has and not what a LOGO has: half of the mark was
         * in shadow at any moment, and which half depended on where the
         * object had turned to. Nearly all the light is ambient now, so
         * every longitude is the same brightness as it comes round, and the
         * small directional that is left only keeps the sphere from reading
         * as a flat disc.
         */
        ambientIntensity: 3.2,
        pointLightIntensity: 0.3,
        parallax: 0.32,
      }}
      orbiting={<Orbits palette={palette} count={ORBIT_COUNT[tier]} />}
      pinned={<TradeLanes palette={palette} count={quality.lanes} />}
    >
      {/*
       * Fog, and it is doing the depth work rather than the atmosphere.
       *
       * The far half of the particle field dissolves into the page's own
       * background colour and the near half stands in front of it, which is
       * the whole illusion. Its colour is the page's surface for exactly that
       * reason — fog in any other colour is a coloured haze, not distance.
       */}
      <fog attach="fog" args={[palette.surface, 6, 17]} />

      <DepthField palette={palette} count={quality.particles} />
      <Floor palette={palette} />
      <Sweep palette={palette} />
    </Globe3D>
  );
}
