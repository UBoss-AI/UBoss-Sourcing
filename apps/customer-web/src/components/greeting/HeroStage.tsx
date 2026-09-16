/**
 * The greeting's WebGL stage.
 *
 * A real 3D scene behind the hero: a glass globe with the world's coastlines on
 * it, three orbits that genuinely pass in front of and behind it, a lit
 * platform under it, a depth field of particles and a ground plane receding
 * into fog. Not a video, not a sprite sheet, not a CSS approximation of
 * perspective — an actual camera looking at actual geometry, which is the only
 * way an orbit can occlude the globe on one side of its travel and be occluded
 * by it on the other.
 *
 * The globe itself is `scene/globe.ts` and the orbits are `scene/orbits.ts`.
 * This file owns what is left: the camera, the lights, the depth field, the
 * ground, where the hub sits on screen, and the loop and the four brakes on it.
 *
 * **Nothing here fetches an image.** The continents are coordinates in
 * `scene/world-land.ts`, rasterised into a canvas at runtime. See that file for
 * why a downloaded earth texture was the wrong answer for a product that other
 * companies install on their own networks.
 *
 * WHY THIS IS AN ENHANCEMENT AND NEVER A DEPENDENCY
 *
 * `GreetingBackdrop` — four layers of CSS — stays underneath this, always, and
 * is what a visitor sees until the moment this fades in over it. That is not
 * belt-and-braces; it is the only arrangement that satisfies the greeting's
 * standing constraint that **the page must look finished with nothing
 * supplied**. WebGL is unavailable more often than it is convenient to admit:
 * a blocklisted driver, a locked-down enterprise browser, a machine that has
 * already spent its context budget on other tabs, a headless renderer taking a
 * screenshot. Every one of those lands on the CSS backdrop and looks
 * deliberate, because it is.
 *
 * So: nothing here is load-bearing. No text lives in the canvas, no control
 * lives in the canvas, and the canvas is `aria-hidden`. The four capabilities
 * a visitor can actually press are DOM, in `SourcingHub`, on top of this — see
 * that file for why they are not painted into the scene.
 *
 * WHY THE LIBRARY IS IMPORTED INSIDE AN EFFECT
 *
 * `await import('three')` rather than a top-level import, so three.js lands in
 * its own chunk that the catalogue never pays for. The landing page's job is
 * to get somebody to the products; a hero that put half a megabyte in front of
 * that would be a hero working against the page it decorates. The chunk is
 * fetched after the first paint, and if the fetch never finishes — a flaky
 * connection, a blocked CDN — the CSS backdrop is simply what the page has.
 *
 * WHAT STOPS IT COSTING ANYTHING
 *
 * Four separate brakes, because a hero that keeps a GPU busy while somebody is
 * reading a product page three screens down is a hero draining a battery for
 * nobody:
 *
 *   - **Off-screen is paused.** An `IntersectionObserver` stops the loop the
 *     moment the hero leaves the viewport and starts it again when it returns.
 *   - **A hidden tab is paused.** `visibilitychange`, for the same reason.
 *   - **Reduced motion renders one frame.** Not a slower animation — one
 *     frame, then nothing. Somebody who asked for no motion gets a still
 *     image, which is what they asked for.
 *   - **Device pixel ratio is capped.** A 3× phone rendering this at native
 *     density is shading nine times the pixels of a 1× laptop for a backdrop
 *     nobody is going to inspect.
 *
 * THEME
 *
 * Colours are read from the same CSS custom properties the rest of the
 * storefront uses, so the scene is the storefront's palette rather than a
 * second one that drifts from it. They are re-read when the theme changes,
 * which is both the explicit toggle (`data-theme` on the root) and the
 * system's own setting.
 */
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { readStagePalette } from './stage-palette';

/**
 * Where the core should sit, as a fraction of the canvas.
 *
 * Measured from a real element rather than guessed from a breakpoint. The hero
 * is a two-column grid that becomes one column below `lg`, and the hub moves a
 * long way when it does — a hard-coded anchor would be right at exactly one
 * window size. Measured on resize only, never per frame, because
 * `getBoundingClientRect` forces layout and doing that sixty times a second is
 * how a backdrop starts costing more than the page it sits behind.
 */
interface Anchor {
  x: number;
  y: number;
}

interface HeroStageProps {
  /**
   * The element the core should centre itself on — the hub. Optional: with no
   * anchor the core sits in the middle of the canvas, which is the right
   * answer for a narrow window where the hub is centred anyway.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /**
   * Told once, when the first frame is actually on screen.
   *
   * The hub draws its own glass sphere in CSS, and that sphere and this core
   * occupy the same place. Exactly one of them may be visible, and which one
   * is not knowable until the context has been created and the chunk has
   * arrived — so the hub is told rather than asked, and hides its own sphere
   * only once there is something real to hide it for. Getting this backwards
   * — hiding the CSS sphere optimistically and hoping WebGL turns up — is how
   * a blocked driver produces a hero with a hole in it.
   */
  onActive?: (active: boolean) => void;
}

/**
 * How much scene this visit should get.
 *
 * Three answers, and the page is finished at every one of them:
 *
 *   - `full` — the globe with its network, its arcs and three orbits.
 *   - `reduced` — the same globe with a quarter of the texture, no wireframe,
 *     no arcs, two orbits, a thinner particle field and a lower pixel ratio.
 *     A mid-range laptop or a large tablet gets a picture that still says
 *     everything the full one says, at roughly a third of the fill rate.
 *   - `null` — no canvas at all, and `orchestration.css` keeps drawing the
 *     sphere it has always drawn. This is a finished page too; see the note at
 *     the top of this file.
 *
 * Deliberately conservative at the bottom end. A device reporting four cores or
 * fewer is usually a phone that would render even the reduced tier at fifteen
 * frames a second and get hot doing it, and fifteen frames a second reads as
 * broken rather than as atmospheric — the CSS drawing is genuinely the better
 * page there, and it is a good one.
 */
type StageTier = 'full' | 'reduced';

function chooseTier(): StageTier | null {
  if (typeof window === 'undefined') return null;
  if (typeof document === 'undefined') return null;

  /*
   * Does this environment have WebGL 2 at all?
   *
   * Asked by looking for the constructor rather than by asking a canvas for a
   * context, deliberately. Creating a throwaway context to find out costs a
   * real GPU allocation on a page that may be about to decide it does not want
   * one — and in jsdom it is worse than that: `getContext` is unimplemented,
   * so every test that renders the greeting logged a stack trace through
   * three.js before the failure was caught and handled correctly. The
   * behaviour was right and the output said something was broken, which is its
   * own kind of bug.
   *
   * The constructor is present in every browser that can run the scene and
   * absent in jsdom, so this is both the cheap check and the honest one.
   */
  if (typeof WebGL2RenderingContext === 'undefined') return null;

  // `deviceMemory` is Chromium-only; its absence is not evidence of anything,
  // so it only ever rules a device out, never in.
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof memory === 'number' && memory > 0 && memory < 4) return null;

  const cores = navigator.hardwareConcurrency;
  if (typeof cores === 'number' && cores > 0 && cores <= 4) return null;

  // Comfortable, not merely capable. Six cores or four gigabytes is a machine
  // that can render this well; it is not one to hand the full texture and a
  // thousand extra wireframe segments to.
  if (typeof memory === 'number' && memory > 0 && memory < 8) return 'reduced';
  if (typeof cores === 'number' && cores > 0 && cores <= 6) return 'reduced';

  /*
   * A narrow window gets the reduced tier whatever the hardware says.
   *
   * Below `lg` the hub is a 17rem square under the search bar rather than a
   * 30rem one beside it, so the globe is roughly a third of the area it gets on
   * a desktop — at which point the wireframe is below a pixel per cell and the
   * arcs are three pixels long. They are not visible, so they are not rendered.
   * That a phone is also the device that can least afford them is a bonus
   * rather than the reason.
   */
  if (window.matchMedia('(max-width: 1023px)').matches) return 'reduced';

  return 'full';
}

export function HeroStage({ anchorRef, onActive }: HeroStageProps): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  /*
   * Opacity is state because it is the one thing React is allowed to own here.
   * Everything else in the scene is written straight to the GPU; this is a
   * single class change, once, when the first frame is on screen — so the
   * canvas never appears as a blank rectangle over the backdrop it is
   * replacing.
   */
  const [visible, setVisible] = useState(false);

  /*
   * The callback, held in a ref.
   *
   * A parent that passes an inline arrow would otherwise tear the whole scene
   * down and build it again on every one of its own renders — a new WebGL
   * context, a fresh evaluation of the chunk and another fade-in, for a prop
   * that did not actually change.
   */
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;

  useEffect(() => {
    const tier = chooseTier();
    if (tier === null) return;

    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (canvas === null || host === null) return;

    /*
     * Everything the teardown has to undo, collected as it is created.
     *
     * A single-page storefront mounts and unmounts this every time somebody
     * comes back to the landing page. A WebGL context that is not disposed is
     * not merely leaked memory — browsers cap the number of live contexts per
     * page (around sixteen) and silently kill the oldest, so a visitor who
     * navigated home a dozen times would watch earlier scenes go black.
     */
    let disposed = false;
    let frame = 0;
    let cleanup: (() => void) | null = null;

    /*
     * Read through a call rather than directly.
     *
     * `disposed` is set by the teardown below, which the type checker cannot
     * see from inside the async body — so a bare `if (disposed)` there is
     * narrowed to "always false" and flagged as dead code. It is not dead: it
     * is the check that stops a scene being built inside a component that has
     * already gone away.
     */
    const isDisposed = (): boolean => disposed;

    void (async () => {
      /*
       * The library and the scene together, in one round trip.
       *
       * The scene modules are imported here rather than at the top of the file
       * for the same reason three.js is, and the cost of getting it wrong is
       * measurable: they carry the world's coastlines, and as static imports
       * they put 14 kB of longitude and latitude into the landing page's OWN
       * chunk — which the browser has to finish downloading before it can draw
       * the headline the page exists to show. Deferred, they land in the chunk
       * beside three.js, fetched after the first paint and not fetched at all
       * by a device that has decided it does not want the scene.
       *
       * `Promise.all` rather than three awaits in a row: they do not depend on
       * one another, and serialising them would cost two extra round trips on
       * exactly the connection least able to afford them.
       */
      const [THREE, globeModule, orbitsModule] = await Promise.all([
        import('three'),
        import('./scene/globe'),
        import('./scene/orbits'),
      ]);

      // The component may have unmounted while the chunk was in flight.
      if (isDisposed()) return;

      let renderer: InstanceType<typeof THREE.WebGLRenderer>;

      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: true,
          // The CSS backdrop shows through everywhere the scene does not
          // paint, which is most of it.
          alpha: true,
          powerPreference: 'high-performance',
          // Nothing is read back and nothing is screenshotted from here.
          preserveDrawingBuffer: false,
        });
      } catch {
        // No context. The CSS backdrop is the page; say nothing about it.
        return;
      }

      /*
       * 1.5, not the device's own, and not 2 as this used to be.
       *
       * The cost of a pixel ratio is quadratic: a 3x phone rendering at native
       * density shades nine times the fragments of a 1x laptop, and this scene
       * is almost entirely transparent shells stacked on top of one another, so
       * every one of those fragments is shaded several times over. Against that,
       * what 2 buys over 1.5 is a slightly crisper edge on a hairline orbit.
       * 1.5 is where that trade stops being worth it.
       */
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier === 'full' ? 1.5 : 1.25));

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
      camera.position.set(0, 0, 7.4);

      let palette = readStagePalette();

      /*
       * Fog does the depth work.
       *
       * Without it the particle field reads as confetti on a flat plane: every
       * point is the same brightness whether it is one unit from the camera or
       * twenty, so the eye has nothing to build distance from. With it the far
       * half of the field dissolves into the page's own background colour and
       * the near half stands in front of it, which is the whole illusion.
       */
      const fog = new THREE.Fog(palette.surface, 6, 17);
      scene.fog = fog;

      // --- The globe -----------------------------------------------------
      //
      // Layers rather than one transmissive material. Real transmission means
      // rendering the scene again into a back buffer every frame for a
      // refraction nobody can inspect behind a headline; a metallic sphere
      // under a Fresnel rim reads as glass from a metre away and costs two
      // draw calls. See `scene/globe.ts` for what each layer is doing.

      /*
       * Everything that belongs to the hub, in one group.
       *
       * Positioned and SCALED together, because the hub is not a fixed size:
       * it is a 30rem square beside the headline on a desktop and a much
       * smaller one under the text on a phone. A globe built at one world size
       * would be correct at one window width and either lost in the middle of
       * the square or bursting out of it everywhere else. Scaling the group
       * rather than the globe keeps the orbits, the atmosphere and the platform
       * in proportion to it for free.
       */
      const hub = new THREE.Group();
      scene.add(hub);

      const globe = globeModule.createGlobe(THREE, palette, globeModule.GLOBE_QUALITY[tier]);
      hub.add(globe.group);

      const orbits = orbitsModule.createOrbits(THREE, palette, orbitsModule.ORBIT_COUNT[tier]);
      hub.add(orbits.group);


      // --- The depth field -----------------------------------------------

      const PARTICLES = tier === 'full' ? 620 : 280;
      const positions = new Float32Array(PARTICLES * 3);
      const drifts = new Float32Array(PARTICLES);

      for (let i = 0; i < PARTICLES; i += 1) {
        // A hollow shell rather than a solid box: points near the camera's
        // axis sit on top of the core and read as dirt on the screen.
        const radius = 3.4 + Math.random() * 7.2;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);

        positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta) * 0.62;
        positions[i * 3 + 2] = radius * Math.cos(phi) - 2.4;
        drifts[i] = 0.12 + Math.random() * 0.38;
      }

      const fieldGeometry = new THREE.BufferGeometry();
      fieldGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      const fieldMaterial = new THREE.PointsMaterial({
        color: palette.brand,
        size: 0.031,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
      });
      const field = new THREE.Points(fieldGeometry, fieldMaterial);
      scene.add(field);

      // --- The ground ----------------------------------------------------
      //
      // The engineering grid the CSS backdrop draws flat, laid down in
      // perspective so it actually recedes. This is the layer that says "there
      // is a floor under this", and it is why the core reads as floating
      // rather than as pasted on.

      const grid = new THREE.GridHelper(34, 34, palette.brand, palette.brand);
      const gridMaterial = grid.material;
      gridMaterial.transparent = true;
      gridMaterial.opacity = 0.085;
      grid.position.y = -2.9;
      scene.add(grid);

      // --- Light ---------------------------------------------------------

      /*
       * Four lights, and the fill is the one that matters.
       *
       * A key light alone puts half the globe in the dark, and on a navy page
       * "in the dark" means "gone" — the object loses its silhouette and what
       * is left reads as a crescent floating in the hero. The cool fill on the
       * opposite side lifts the shadow half just far enough to keep its edge
       * against the background while staying clearly the shadow side.
       */
      const ambient = new THREE.AmbientLight(palette.highlight, 0.7);
      scene.add(ambient);

      const key = new THREE.DirectionalLight(0xffffff, 2.1);
      key.position.set(3.2, 3.4, 4.6);
      scene.add(key);

      const fill = new THREE.DirectionalLight(palette.highlight, 0.95);
      fill.position.set(-3.8, -1.6, 1.8);
      scene.add(fill);

      // The one that follows the pointer. Warm, and on the opposite side of
      // the globe from the key light, so moving a mouse across the hero rakes
      // the surface rather than merely brightening it.
      const rim = new THREE.PointLight(palette.action, 34, 24, 2);
      rim.position.set(-3.4, -1.2, 3.2);
      scene.add(rim);

      /*
       * The moving reflection, and it is a light rather than an animated
       * texture.
       *
       * The ocean is a metal and the two bands are polished titanium, which
       * means almost everything you see on them is a reflection of something.
       * With every light nailed down, those reflections are nailed down too and
       * the globe looks like a photograph of a globe — correct, and inert. One
       * specular circling slowly behind the camera's shoulder is what puts a
       * highlight travelling across the glass and along the bands, and it is
       * the single cheapest thing in this file that makes the object read as
       * real. Its period is deliberately not a multiple of the globe's, so the
       * two never fall into step and start looking mechanical.
       */
      const sweep = new THREE.PointLight(palette.steel, 26, 22, 2);
      scene.add(sweep);

      // --- Layout --------------------------------------------------------

      let anchor: Anchor = { x: 0.5, y: 0.5 };
      let anchorSize = 0;
      let width = 1;
      let height = 1;

      /**
       * How wide the GLOBE should be, as a fraction of the square it is given.
       *
       * **This is the number to change to make the globe bigger or smaller.**
       * Everything else in the scene is expressed in globe radii and follows
       * it: the atmosphere reaches 1.24, the outermost orbit 1.6 and the lit
       * platform 2.1, so the whole ecosystem spans about five times this.
       *
       * 0.42, against the CSS sphere's 0.33. A rendered object needs more room
       * than a drawn one to read as an object: the drawing was a flat disc
       * whose whole silhouette was the shape, and this is a sphere whose
       * silhouette is broken by coastlines, a wireframe and three orbits
       * crossing it. Below about 0.36 the continents stop being recognisable,
       * which loses the one thing the globe is here to say.
       *
       * The ceiling is `NODE_RADIUS_FRACTION` in `orchestration-nodes.ts`: the
       * cards ride at 0.37 of the square and are 9.5rem across, so anything
       * here past about 0.44 puts the globe ITSELF under a card. The orbits
       * around it are already allowed to pass behind the cards, and should —
       * the cards are opaque panels, so an orbit disappearing behind one and
       * coming out the other side is depth rather than collision. Check due
       * north and due east, not the diagonal — that note applies to this
       * number for the same reason it applies to that one.
       */
      const CORE_DIAMETER_FRACTION = 0.42;

      /**
       * The same number below `lg`, where nothing is orbiting.
       *
       * The ceiling above exists because four cards ride a circle around the
       * square. They only do that from `lg`: below it they sit still in a grid
       * *under* the hub — see the arrangement note in `orchestration.css` —
       * which leaves the square empty and the ceiling with nothing to protect.
       * Holding the desktop fraction there wastes most of a phone's most
       * valuable screen on padding around a 100px object.
       *
       * 0.52 rather than the 0.62 a lone core used to get: the globe now brings
       * orbits and a platform out to five times its own width, and at 0.62 the
       * outer orbit ran off both sides of a 17rem square.
       *
       * The breakpoint is read from a media query rather than from the
       * measured width, so it is the same 1024px the stylesheet switches on. A
       * second definition of "narrow" in this file is a second thing to keep
       * in step.
       */
      const CORE_DIAMETER_FRACTION_NARROW = 0.52;
      const wideLayout = window.matchMedia('(min-width: 1024px)');

      /**
       * Put the hub where the drawing's orb is, at the size the square wants.
       *
       * Both halves are measured rather than assumed. The offset comes from
       * where the square actually is — it moves from the right-hand column to
       * under the headline below `lg` — and the scale from how big it actually
       * is, which changes continuously with the window rather than in steps.
       */
      const applyAnchor = (): void => {
        // `tan(fov/2) * distance` is the half-height of the frustum at the
        // hub's depth; the half-width is that times the aspect. Everything
        // below is a conversion between canvas pixels and world units there.
        const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
        const halfWidth = halfHeight * camera.aspect;

        hub.position.x = (anchor.x - 0.5) * 2 * halfWidth;
        hub.position.y = -(anchor.y - 0.5) * 2 * halfHeight;

        if (anchorSize > 0 && height > 0) {
          const worldPerPixel = (halfHeight * 2) / height;
          const fraction = wideLayout.matches
            ? CORE_DIAMETER_FRACTION
            : CORE_DIAMETER_FRACTION_NARROW;
          // The core is built at radius 1, so the wanted radius in world units
          // IS the scale — everything else in the group is expressed in core
          // radii and comes along in proportion.
          hub.scale.setScalar((anchorSize * fraction * worldPerPixel) / 2);
        }

        // The ground stays under the whole hero rather than under the hub, or
        // it would slide sideways with it and stop reading as a floor.
        grid.position.x = hub.position.x * 0.35;
      };

      const measure = (): void => {
        const rect = host.getBoundingClientRect();
        width = Math.max(rect.width, 1);
        height = Math.max(rect.height, 1);

        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();

        const target = anchorRef?.current ?? null;

        if (target === null) {
          anchor = { x: 0.5, y: 0.5 };
          // With nothing to measure, fall back to the smaller side of the
          // canvas — the same thing a square drawn to fit would do.
          anchorSize = Math.min(width, height) * 0.62;
        } else {
          const box = target.getBoundingClientRect();
          anchor = {
            x: (box.left + box.width / 2 - rect.left) / width,
            y: (box.top + box.height / 2 - rect.top) / height,
          };
          // The square's smaller side, so a hub squeezed by a narrow column
          // shrinks with it instead of overflowing.
          anchorSize = Math.min(box.width, box.height);
        }

        applyAnchor();
      };

      measure();

      const resizeObserver = new ResizeObserver(() => { measure(); });
      resizeObserver.observe(host);
      if (anchorRef?.current != null) resizeObserver.observe(anchorRef.current);

      /*
       * The breakpoint, watched separately.
       *
       * Crossing 1024px rearranges the hub from an orbit to a grid, and the
       * core's share of the square changes with it. The `ResizeObserver` above
       * usually catches that — the square is a different size on each side —
       * but not always: a window resized while the hero is off-screen, or a
       * tablet turned on its side into a layout of the same width, both cross
       * the breakpoint without the observed boxes changing.
       */
      const onLayoutChange = (): void => { measure(); };
      wideLayout.addEventListener('change', onLayoutChange);

      // --- Pointer -------------------------------------------------------
      //
      // Held in plain numbers and eased towards on each frame rather than
      // applied directly: a light that snaps to the cursor reads as a bug, and
      // easing is also what keeps a fast flick across the hero from looking
      // like a strobe.

      let pointerX = 0;
      let pointerY = 0;
      let easedX = 0;
      let easedY = 0;

      const onPointerMove = (event: PointerEvent): void => {
        const rect = host.getBoundingClientRect();
        pointerX = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
        pointerY = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1;
      };

      const onPointerLeave = (): void => {
        pointerX = 0;
        pointerY = 0;
      };

      window.addEventListener('pointermove', onPointerMove, { passive: true });
      host.addEventListener('pointerleave', onPointerLeave);

      // --- Theme ---------------------------------------------------------

      const repaint = (): void => {
        palette = readStagePalette();

        fog.color.setHex(palette.surface);
        fieldMaterial.color.setHex(palette.brand);
        gridMaterial.color.setHex(palette.brand);
        ambient.color.setHex(palette.highlight);
        fill.color.setHex(palette.highlight);
        rim.color.setHex(palette.action);
        sweep.color.setHex(palette.steel);

        globe.repaint(palette);
        orbits.repaint(palette);
      };

      const themeObserver = new MutationObserver(() => { repaint(); });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'class'],
      });

      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
      const onSystemTheme = (): void => { repaint(); };
      systemTheme.addEventListener('change', onSystemTheme);

      // --- The loop ------------------------------------------------------

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

      let onScreen = true;
      let running = false;
      let last = performance.now();
      let elapsed = 0;

      const draw = (delta: number): void => {
        elapsed += delta;

        globe.update(elapsed, delta);
        orbits.update(elapsed, delta);

        // The travelling specular. Behind the camera's shoulder and well off
        // to one side, circling once every 26 seconds — see the note where it
        // is created for why this light exists at all.
        const sweepAngle = elapsed * 0.242;
        sweep.position.set(Math.cos(sweepAngle) * 3.4, 1.9, Math.sin(sweepAngle) * 2.2 + 3.4);

        field.rotation.y += delta * 0.012;

        easedX += (pointerX - easedX) * Math.min(delta * 2.4, 1);
        easedY += (pointerY - easedY) * Math.min(delta * 2.4, 1);

        rim.position.x = -3.4 + easedX * 3.6;
        rim.position.y = -1.2 - easedY * 2.8;

        // The camera moves a long way less than the pointer does. Parallax
        // reads as depth up to about a degree and as seasickness past it.
        camera.position.x = easedX * 0.32;
        camera.position.y = -easedY * 0.22;
        camera.lookAt(0, 0, 0);

        renderer.render(scene, camera);
      };

      const tick = (): void => {
        if (isDisposed()) return;

        const now = performance.now();
        // Clamped: a tab that was throttled in the background hands back a
        // delta of several seconds, and every rotation above would jump.
        const delta = Math.min((now - last) / 1000, 0.05);
        last = now;

        draw(delta);
        frame = requestAnimationFrame(tick);
      };

      const start = (): void => {
        if (running || isDisposed()) return;
        if (reducedMotion.matches) return;
        running = true;
        last = performance.now();
        frame = requestAnimationFrame(tick);
      };

      const stop = (): void => {
        running = false;
        if (frame !== 0) cancelAnimationFrame(frame);
        frame = 0;
      };

      const intersection = new IntersectionObserver(
        (entries) => {
          onScreen = entries[0]?.isIntersecting ?? false;
          if (onScreen && !document.hidden) start();
          else stop();
        },
        { threshold: 0 },
      );
      intersection.observe(host);

      const onVisibility = (): void => {
        if (document.hidden) stop();
        else if (onScreen) start();
      };
      document.addEventListener('visibilitychange', onVisibility);

      // Somebody who turns reduced motion on mid-visit gets a still frame from
      // the next moment, rather than at the next page load.
      const onReducedMotion = (): void => {
        if (reducedMotion.matches) {
          stop();
          draw(0);
        } else if (onScreen && !document.hidden) {
          start();
        }
      };
      reducedMotion.addEventListener('change', onReducedMotion);

      // One frame before anything is revealed, so the fade-in never shows an
      // empty canvas — and the whole of the reduced-motion experience.
      draw(0);
      setVisible(true);
      onActiveRef.current?.(true);
      if (!reducedMotion.matches) start();

      cleanup = (): void => {
        onActiveRef.current?.(false);
        stop();
        resizeObserver.disconnect();
        wideLayout.removeEventListener('change', onLayoutChange);
        intersection.disconnect();
        themeObserver.disconnect();
        systemTheme.removeEventListener('change', onSystemTheme);
        reducedMotion.removeEventListener('change', onReducedMotion);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pointermove', onPointerMove);
        host.removeEventListener('pointerleave', onPointerLeave);

        globe.dispose();
        orbits.dispose();

        fieldGeometry.dispose();
        fieldMaterial.dispose();
        grid.geometry.dispose();
        gridMaterial.dispose();

        renderer.dispose();
        /*
         * And the context itself.
         *
         * `renderer.dispose()` releases three.js's own GPU objects but leaves
         * the WebGL context alive — browsers cap those at around sixteen per
         * page and silently kill the oldest when a seventeenth is asked for.
         * A single-page storefront mounts this every time somebody comes back
         * to the landing page, so without this a visitor who navigated home a
         * dozen times would watch an earlier scene go black.
         */
        renderer.forceContextLoss();
      };
    })();

    return () => {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      cleanup?.();
    };
  }, [anchorRef]);

  if (chooseTier() === null) return null;

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        className={`h-full w-full transition-opacity duration-[1200ms] ease-out ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </div>
  );
}
