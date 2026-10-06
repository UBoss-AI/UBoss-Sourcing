/**
 * The earth.
 *
 * A textured, lit sphere with an atmosphere around it and, for a caller that
 * wants them, pins standing off its surface. Rendered with React Three Fiber.
 * It is the front page's logo — the object a visitor sees before they read
 * anything — and a small version of it is the brand mark in the header when a
 * deployment has uploaded no logo of its own. Neither of those two passes any
 * pins: the storefront wanted the earth, not a map with stickers on it.
 *
 * ---
 *
 * WHERE THIS CAME FROM, AND WHAT HAD TO CHANGE
 *
 * The shape of this file is the Aceternity `3d-globe` component. Four things
 * about it could not survive contact with this repository, and each one is a
 * rule this project has already paid to learn:
 *
 *   - **`"use client"` is gone.** That is a Next.js directive; this app is
 *     Vite, and the line is at best noise.
 *   - **`cn` is `cx`.** This project's class joiner is `lib/cx.ts`. There is no
 *     `clsx`/`tailwind-merge` pair here and adding one to satisfy an import
 *     would be two dependencies for one function.
 *   - **Nothing is fetched.** The original pulls its earth and its elevation
 *     map from unpkg and its pins from a CDN. UBOSS is installed on other
 *     companies' networks: the front page of a deployment behind a firewall
 *     cannot depend on a third party answering. Both maps are in
 *     `src/assets/globe/`, imported, hashed and served from this origin, and
 *     the pins are drawn (see `GlobeMarker.content`).
 *   - **The pins are optionally inert.** A decorative globe inside an
 *     `aria-hidden` container must not contain focusable controls — that is a
 *     keyboard trap with no name. Pass no handlers and the pins render as
 *     plain, unfocusable plates; pass `onMarkerClick` and they become real
 *     buttons with an accessible name.
 *
 * The textures are downscaled copies of `three-globe`'s NASA Blue Marble
 * example imagery: 2048×1024 at quality 82 (247 kB, from 1.4 MB) and a
 * greyscale 1024×512 elevation map (23 kB, from 378 kB). At the size this
 * renders — a 30rem square at most — neither downscale is visible, and the
 * pair is smaller than the hero's own JavaScript.
 *
 * ---
 *
 * COST
 *
 * Nothing here is in the bundle a visitor downloads before the first paint.
 * Every caller reaches this file through a `React.lazy` boundary, so three.js,
 * Fiber, Drei and both textures land in their own chunk fetched afterwards —
 * and not at all on a device that has decided it does not want a 3D scene. See
 * `components/greeting/HeroStage.tsx`, which is that decision.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls, useTexture } from '@react-three/drei';
import * as THREE from 'three';
import { cx } from '@/lib/cx';
import earthTextureUrl from '@/assets/globe/earth-blue-marble.jpg';
import earthBumpUrl from '@/assets/globe/earth-topology.jpg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GlobeMarker {
  /** Degrees north, -90 to 90. */
  lat: number;
  /** Degrees east, -180 to 180. */
  lng: number;
  /**
   * What sits on top of the pin.
   *
   * Drawn, not fetched — a flag, an initial, a glyph. An `src` is accepted for
   * a caller that genuinely has an image on this origin, but a deployment that
   * has supplied nothing must still get a finished picture, so `content` is
   * the path the storefront itself takes.
   */
  content?: ReactNode;
  /** An image on this origin. Ignored when `content` is given. */
  src?: string;
  /** Named for the title attribute and for the button's accessible name. */
  label?: string;
  /** Overrides `config.markerSize` for this one pin. */
  size?: number;
}

/**
 * Where the globe sits in the canvas, and how big it is.
 *
 * The hero's canvas covers the whole greeting card while the globe belongs
 * over one part of it — a square that moves from beside the headline to under
 * it as the window narrows. Rather than guess that from a breakpoint, the
 * caller measures the element it wants to sit on and hands the measurement
 * here; the maths from canvas pixels to world units needs the camera, which
 * only exists inside the Canvas.
 */
export interface GlobeAnchor {
  /** Centre of the target box, as a fraction of the canvas. 0.5 is the middle. */
  x: number;
  /** Same, vertically. */
  y: number;
  /** The target box's smaller side, in CSS pixels. */
  sizePx: number;
  /** How much of that box the globe's diameter should fill. */
  diameterFraction: number;
}

export interface Globe3DConfig {
  /** Globe radius in world units. Everything else is expressed in these. */
  radius?: number;
  /**
   * The earth, and its elevation map.
   *
   * Both default to the copies in `src/assets/globe/`, and both must be on
   * this origin — see this file's header for why a URL to somebody else's CDN
   * is not an option here. A caller drawing the globe small should hand over
   * the small map: a 40px mark does not need 2048×1024, and the texture it is
   * given is uploaded to the GPU whatever size it renders at.
   */
  textureUrl?: string;
  /** `null` draws a smooth ball and fetches nothing for the relief. */
  bumpMapUrl?: string | null;
  /** Whether to show the atmosphere glow. */
  showAtmosphere?: boolean;
  /** Atmosphere colour. */
  atmosphereColor?: string;
  /** Atmosphere intensity. */
  atmosphereIntensity?: number;
  /** Atmosphere softness: higher is more diffuse. */
  atmosphereBlur?: number;
  /** Terrain relief. 0 is a smooth ball. */
  bumpScale?: number;
  /** Degrees per second of idle rotation. 0 stops it. */
  autoRotateSpeed?: number;
  /** Let the visitor turn it. Off makes the whole canvas inert. */
  interactive?: boolean;
  /** Only with `interactive`. */
  enableZoom?: boolean;
  /** Only with `interactive`. */
  enablePan?: boolean;
  minDistance?: number;
  maxDistance?: number;
  /** Default pin size, as a fraction of the globe's radius. */
  markerSize?: number;
  /** Ambient light intensity. */
  ambientIntensity?: number;
  /** Key light intensity. */
  pointLightIntensity?: number;
  /** How far the camera drifts with the pointer, in world units. 0 disables it. */
  parallax?: number;
  /** Background colour. `null` lets the page show through. */
  backgroundColor?: string | null;
}

export interface Globe3DProps {
  markers?: readonly GlobeMarker[];
  config?: Globe3DConfig;
  className?: string;
  /** See `GlobeAnchor`. Centred and fitted to the canvas without one. */
  anchor?: GlobeAnchor | undefined;
  /**
   * Anything else in the scene: fog, extra lights, a particle field.
   *
   * Attached to the root scene, so it neither moves nor scales with the globe
   * — which is what a floor, a fog colour and a depth field all want.
   */
  children?: ReactNode;
  /**
   * Things that live around the globe: rings, a platform, a halo.
   *
   * Positioned and scaled with it, so they stay in proportion as the anchor
   * resizes, but not rotated with it — a ring that turned with the surface
   * would stop reading as an orbit.
   */
  orbiting?: ReactNode;
  /**
   * Things that belong to the surface: arcs between cities, a route, a label
   * over a country. Turns with the earth, exactly like the pins do.
   */
  pinned?: ReactNode;
  /**
   * Fiber's loop mode, and the caller's pause switch.
   *
   * `never` is a stopped loop that still holds its last frame — what an
   * off-screen hero, a hidden tab and a reduced-motion visitor all get.
   */
  frameloop?: 'always' | 'demand' | 'never';
  /** Device pixel ratio ceiling. The cost of this scene is quadratic in it. */
  dpr?: number;
  /** Told once, when there is genuinely a rendered frame on screen. */
  onReady?: () => void;
  onMarkerClick?: (marker: GlobeMarker) => void;
  onMarkerHover?: (marker: GlobeMarker | null) => void;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Latitude and longitude to a point on a sphere.
 *
 * The negated x is what lines the texture up with the coordinates: the map is
 * wrapped with its seam at 180°, and without it every pin sits on the ocean
 * mirrored from where it belongs.
 */
function latLngToVector3(lat: number, lng: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);

  return new THREE.Vector3(
    -(radius * Math.sin(phi) * Math.cos(theta)),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

/**
 * Scratch vectors, module level.
 *
 * Every pin asks "am I facing the camera?" on every frame. Allocating two
 * `Vector3`s per pin per frame is 1,500 objects a second for a dozen pins,
 * which is a garbage collector pause in the middle of a fade-in.
 */
const WORLD = new THREE.Vector3();
const TO_CAMERA = new THREE.Vector3();

// ---------------------------------------------------------------------------
// A pin
// ---------------------------------------------------------------------------

interface MarkerProps {
  marker: GlobeMarker;
  radius: number;
  defaultSize: number;
  interactive: boolean;
  onClick?: ((marker: GlobeMarker) => void) | undefined;
  onHover?: ((marker: GlobeMarker | null) => void) | undefined;
}

function Marker({
  marker,
  radius,
  defaultSize,
  interactive,
  onClick,
  onHover,
}: MarkerProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [facing, setFacing] = useState(true);
  const headRef = useRef<THREE.Group>(null);
  const { camera } = useThree();

  const size = marker.size ?? defaultSize;

  // Where the pin meets the ground, and where its head floats.
  const foot = useMemo(
    () => latLngToVector3(marker.lat, marker.lng, radius * 1.001),
    [marker.lat, marker.lng, radius],
  );
  const head = useMemo(
    () => latLngToVector3(marker.lat, marker.lng, radius * 1.18),
    [marker.lat, marker.lng, radius],
  );

  /** The stem: where its middle is, and which way is up for it. */
  const { stemCentre, stemRotation, stemLength } = useMemo(() => {
    const centre = foot.clone().lerp(head, 0.5);
    const direction = head.clone().sub(foot).normalize();
    const rotation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction,
    );

    return { stemCentre: centre, stemRotation: rotation, stemLength: head.distanceTo(foot) };
  }, [foot, head]);

  /*
   * Hide the half of them that is round the back.
   *
   * The pin heads are DOM, and DOM has no depth buffer — without this the pins
   * on the far side of the globe are drawn in front of it, and the object
   * stops reading as a sphere entirely. The dot product is the pin's own
   * direction against the camera's; above zero is the near hemisphere, and the
   * margin hides them a moment before they reach the silhouette, where they
   * would otherwise appear to slide across the edge.
   */
  useFrame(() => {
    const group = headRef.current;
    if (group === null) return;

    group.getWorldPosition(WORLD);
    TO_CAMERA.copy(camera.position).normalize();

    const near = WORLD.normalize().dot(TO_CAMERA) > 0.12;
    setFacing((was) => (was === near ? was : near));
  });

  const plate = (
    <span
      className={cx(
        'flex items-center justify-center overflow-hidden rounded-full border border-white/70',
        'bg-white shadow-lift transition-transform duration-200',
        hovered && 'scale-125',
      )}
      style={{ width: '13px', height: '13px' }}
    >
      {marker.content ?? (
        // Only ever a same-origin image; see the note on `GlobeMarker.src`.
        <img
          src={marker.src}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      )}
    </span>
  );

  return (
    <group visible={facing}>
      {/* The stem. */}
      <mesh position={stemCentre} quaternion={stemRotation}>
        <cylinderGeometry args={[radius * 0.0018, radius * 0.0018, stemLength, 6]} />
        <meshBasicMaterial
          color={hovered ? '#ffffff' : '#9fb4d0'}
          transparent
          opacity={hovered ? 0.95 : 0.65}
        />
      </mesh>

      {/* The point where it enters the surface. */}
      <mesh position={foot} quaternion={stemRotation}>
        <coneGeometry args={[radius * 0.009, radius * 0.024, 8]} />
        <meshBasicMaterial color="#f97316" />
      </mesh>

      {/* The head. */}
      <group ref={headRef} position={head}>
        <Html
          transform
          center
          sprite
          distanceFactor={radius * size * 25}
          style={{
            pointerEvents: interactive && facing ? 'auto' : 'none',
            opacity: facing ? 1 : 0,
            transition: 'opacity 150ms ease-out',
          }}
        >
          {interactive ? (
            <button
              type="button"
              title={marker.label}
              className="block cursor-pointer appearance-none border-0 bg-transparent p-0"
              onMouseEnter={() => {
                setHovered(true);
                onHover?.(marker);
              }}
              onMouseLeave={() => {
                setHovered(false);
                onHover?.(null);
              }}
              onFocus={() => {
                setHovered(true);
              }}
              onBlur={() => {
                setHovered(false);
              }}
              onClick={() => {
                onClick?.(marker);
              }}
            >
              {plate}
              <span className="sr-only">{marker.label}</span>
            </button>
          ) : (
            // Decorative: no handlers, no tab stop, nothing for a screen
            // reader to announce out of an aria-hidden canvas.
            plate
          )}
        </Html>
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// The globe
// ---------------------------------------------------------------------------

interface GlobeBodyProps {
  config: Required<Globe3DConfig>;
  markers: readonly GlobeMarker[];
  anchor: GlobeAnchor | undefined;
  orbiting?: ReactNode;
  pinned?: ReactNode;
  onMarkerClick?: ((marker: GlobeMarker) => void) | undefined;
  onMarkerHover?: ((marker: GlobeMarker | null) => void) | undefined;
  onReady?: (() => void) | undefined;
}

function GlobeBody({
  config,
  markers,
  anchor,
  orbiting,
  pinned,
  onMarkerClick,
  onMarkerHover,
  onReady,
}: GlobeBodyProps): React.JSX.Element {
  const spinRef = useRef<THREE.Group>(null);
  const readyRef = useRef(false);
  const { camera, size } = useThree();

  /*
   * Start the loop again when `frameloop` becomes a running mode.
   *
   * Fiber stops its `requestAnimationFrame` chain entirely once no root wants
   * a frame, and **setting `frameloop` back to `always` does not restart it**
   * — nothing in that path invalidates, so the chain stays stopped and the
   * scene holds the last frame it drew for ever. Every caller here pauses on
   * something that comes back: the hero pauses when it scrolls off screen, and
   * both it and the sign-in panel pause on a hidden tab. Without this the
   * globe froze permanently the first time one of those happened, which is a
   * still picture that looks almost right — the worst kind of broken.
   *
   * Asked of the store rather than taken from a prop, because the prop belongs
   * to `Globe3D` outside the Canvas and this has to run inside it.
   */
  const frameloop = useThree((state) => state.frameloop);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    if (frameloop !== 'never') invalidate();
  }, [frameloop, invalidate]);

  /*
   * Both maps, or just the earth.
   *
   * The hook count does not change either way, so this stays a legal
   * conditional: a caller that asked for no relief does not pay for the
   * elevation map at all, which is the difference between 23 kB and nothing
   * for a mark 40 pixels across.
   */
  const urls =
    config.bumpMapUrl === null
      ? [config.textureUrl]
      : [config.textureUrl, config.bumpMapUrl];
  const textures = useTexture(urls);
  const earth = textures[0];
  const bump = config.bumpMapUrl === null ? undefined : textures[1];

  useMemo(() => {
    if (earth !== undefined) {
      earth.colorSpace = THREE.SRGBColorSpace;
      earth.anisotropy = 8;
    }
    if (bump !== undefined) bump.anisotropy = 4;
  }, [earth, bump]);

  /*
   * Where the globe sits, and how big it is.
   *
   * `tan(fov/2) × distance` is the half-height of the frustum at the globe's
   * depth; everything below converts canvas pixels into world units there. The
   * globe is built at `config.radius`, so the scale is simply the ratio
   * between the radius the anchor asks for and the one it has.
   */
  const { position, scale } = useMemo(() => {
    if (anchor === undefined || size.height <= 0) {
      return { position: new THREE.Vector3(0, 0, 0), scale: 1 };
    }

    const perspective = camera as THREE.PerspectiveCamera;
    const halfHeight = Math.tan((perspective.fov * Math.PI) / 360) * perspective.position.z;
    const halfWidth = halfHeight * (size.width / Math.max(size.height, 1));
    const worldPerPixel = (halfHeight * 2) / size.height;
    const wantedRadius = (anchor.sizePx * anchor.diameterFraction * worldPerPixel) / 2;

    return {
      position: new THREE.Vector3(
        (anchor.x - 0.5) * 2 * halfWidth,
        -(anchor.y - 0.5) * 2 * halfHeight,
        0,
      ),
      scale: wantedRadius / config.radius,
    };
  }, [anchor, camera, size.width, size.height, config.radius]);

  useFrame((_state, delta) => {
    const spin = spinRef.current;
    if (spin !== null && config.autoRotateSpeed !== 0) {
      spin.rotation.y += (config.autoRotateSpeed * Math.PI * delta) / 180;
    }

    // One notification, on the first frame that genuinely rendered — the
    // caller uses it to stop drawing whatever it was showing instead.
    if (!readyRef.current) {
      readyRef.current = true;
      onReady?.();
    }
  });

  return (
    <group position={position} scale={scale}>
      {/*
       * The atmosphere does not turn with the earth.
       *
       * It is a shell of scattered light around the planet, not a feature of
       * its surface: rotating it would be rotating the sky.
       */}
      {config.showAtmosphere && (
        <Atmosphere
          radius={config.radius}
          color={config.atmosphereColor}
          intensity={config.atmosphereIntensity}
          blur={config.atmosphereBlur}
        />
      )}

      {orbiting}

      <group ref={spinRef}>
        <mesh>
          <sphereGeometry args={[config.radius, 64, 64]} />
          <meshStandardMaterial
            map={earth ?? null}
            bumpMap={bump ?? null}
            bumpScale={config.bumpScale * 0.05}
            roughness={0.72}
            metalness={0.02}
          />
        </mesh>

        {markers.map((marker) => (
          <Marker
            key={`${marker.label ?? 'pin'}-${marker.lat}-${marker.lng}`}
            marker={marker}
            radius={config.radius}
            defaultSize={config.markerSize}
            interactive={onMarkerClick !== undefined}
            onClick={onMarkerClick}
            onHover={onMarkerHover}
          />
        ))}

        {pinned}
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Atmosphere
// ---------------------------------------------------------------------------

interface AtmosphereProps {
  radius: number;
  color: string;
  intensity: number;
  blur: number;
}

/**
 * The glow.
 *
 * A slightly larger sphere drawn from the inside — `BackSide` — whose shader
 * lights only the pixels where the surface turns away from the camera. That is
 * a Fresnel term, and it is the whole of the effect: bright at the silhouette,
 * invisible in the middle, which is what atmosphere actually does.
 */
function Atmosphere({ radius, color, intensity, blur }: AtmosphereProps): React.JSX.Element {
  const material = useMemo(() => {
    // Higher `blur` means a softer edge, so it drives the exponent downwards.
    const fresnelPower = Math.max(0.5, 5 - blur);

    return new THREE.ShaderMaterial({
      uniforms: {
        atmosphereColor: { value: new THREE.Color(color) },
        intensity: { value: intensity },
        fresnelPower: { value: fresnelPower },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 atmosphereColor;
        uniform float intensity;
        uniform float fresnelPower;
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
          float fresnel = pow(1.0 - abs(dot(vNormal, normalize(-vPosition))), fresnelPower);
          gl_FragColor = vec4(atmosphereColor, fresnel * intensity);
        }
      `,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
    });
  }, [color, intensity, blur]);

  return (
    <mesh scale={1.14}>
      <sphereGeometry args={[radius, 48, 32]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/**
 * The drift.
 *
 * The camera follows the pointer by a fraction of a degree and eases as it
 * goes. Parallax reads as depth up to about a degree and as seasickness past
 * it, and a camera that snaps to the cursor reads as a bug.
 */
function CameraRig({ amount }: { amount: number }): null {
  const eased = useRef({ x: 0, y: 0 });

  useFrame((state, delta) => {
    if (amount === 0) return;

    const step = Math.min(delta * 2.4, 1);
    eased.current.x += (state.pointer.x - eased.current.x) * step;
    eased.current.y += (state.pointer.y - eased.current.y) * step;

    state.camera.position.x = eased.current.x * amount;
    state.camera.position.y = eased.current.y * amount * 0.7;
    state.camera.lookAt(0, 0, 0);
  });

  return null;
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

const defaultConfig: Required<Globe3DConfig> = {
  radius: 2,
  textureUrl: earthTextureUrl,
  bumpMapUrl: earthBumpUrl,
  showAtmosphere: true,
  atmosphereColor: '#4da6ff',
  atmosphereIntensity: 0.55,
  atmosphereBlur: 2,
  bumpScale: 1,
  autoRotateSpeed: 3,
  interactive: false,
  enableZoom: false,
  enablePan: false,
  minDistance: 5,
  maxDistance: 15,
  markerSize: 0.06,
  ambientIntensity: 0.75,
  pointLightIntensity: 1.9,
  parallax: 0,
  backgroundColor: null,
};

export function Globe3D({
  markers = [],
  config = {},
  className,
  anchor,
  children,
  orbiting,
  pinned,
  frameloop = 'always',
  dpr = 1.5,
  onReady,
  onMarkerClick,
  onMarkerHover,
}: Globe3DProps): React.JSX.Element {
  const merged = useMemo(() => ({ ...defaultConfig, ...config }), [config]);

  return (
    <div className={cx('relative h-full w-full', className)}>
      <Canvas
        frameloop={frameloop}
        gl={{
          antialias: true,
          // The page shows through everywhere the scene does not paint, which
          // is most of it.
          alpha: true,
          powerPreference: 'high-performance',
          preserveDrawingBuffer: false,
        }}
        dpr={[1, dpr]}
        camera={{ fov: 38, near: 0.1, far: 100, position: [0, 0, merged.radius * 3.7] }}
        style={{ background: merged.backgroundColor ?? 'transparent' }}
      >
        {/*
         * Four lights, and the fill is the one that matters: a key light alone
         * leaves half the planet unlit, and on a dark page an unlit half is a
         * lost silhouette — what remains reads as a crescent rather than as a
         * sphere.
         */}
        <ambientLight intensity={merged.ambientIntensity} />
        <directionalLight position={[3.2, 3.4, 4.6]} intensity={merged.pointLightIntensity} />
        <directionalLight
          position={[-3.8, -1.6, 1.8]}
          intensity={merged.pointLightIntensity * 0.32}
          color="#88ccff"
        />

        <CameraRig amount={merged.parallax} />

        {/*
         * No fallback element.
         *
         * Drei's `Html` fallback would be a line of English in the middle of a
         * storefront that speaks eight languages, for the fraction of a second
         * between the chunk arriving and the texture decoding. The caller is
         * already showing something finished underneath — see `onReady` — so
         * the honest fallback here is nothing at all.
         */}
        <Suspense fallback={null}>
          <GlobeBody
            config={merged}
            markers={markers}
            anchor={anchor}
            orbiting={orbiting}
            pinned={pinned}
            onMarkerClick={onMarkerClick}
            onMarkerHover={onMarkerHover}
            onReady={onReady}
          />
        </Suspense>

        {children}

        {merged.interactive && (
          <OrbitControls
            makeDefault
            enablePan={merged.enablePan}
            enableZoom={merged.enableZoom}
            minDistance={merged.minDistance}
            maxDistance={merged.maxDistance}
            rotateSpeed={0.4}
            enableDamping
            dampingFactor={0.1}
          />
        )}
      </Canvas>
    </div>
  );
}
