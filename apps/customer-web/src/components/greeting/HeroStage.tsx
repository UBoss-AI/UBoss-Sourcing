/**
 * The greeting's WebGL stage.
 *
 * A real 3D scene behind the hero: the earth, turning, with trade lanes
 * travelling between real sourcing hubs, three orbits that genuinely pass in
 * front of and behind it, a depth field of particles and a ground plane
 * receding into fog. Not a video, not a sprite sheet, not a CSS
 * approximation of perspective — an actual camera looking at actual geometry,
 * which is the only way an orbit can occlude the globe on one side of its
 * travel and be occluded by it on the other.
 *
 * This file owns the *decisions*: whether to render at all, how much to
 * render, where on screen the globe belongs, and when to stop. The scene
 * itself is `EarthScene.tsx` and the globe is `components/ui/3d-globe.tsx`.
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
 * that file for why they are not painted into the scene. Nothing inside the
 * canvas is focusable either: a tab stop inside an `aria-hidden` container is
 * a control with no name, which is worse than no control at all.
 *
 * WHY THE SCENE IS LAZY
 *
 * `React.lazy` rather than a static import, so three.js, Fiber, Drei and both
 * earth textures land in their own chunk that the catalogue never pays for.
 * The landing page's job is to get somebody to the products; a hero that put
 * half a megabyte in front of that would be a hero working against the page it
 * decorates. The chunk is fetched after the first paint, and if the fetch
 * never finishes — a flaky connection, a blocked CDN — the CSS backdrop is
 * simply what the page has.
 *
 * WHAT STOPS IT COSTING ANYTHING
 *
 * Four brakes, because a hero that keeps a GPU busy while somebody is reading
 * a product page three screens down is a hero draining a battery for nobody.
 * All four work the same way now: they set Fiber's `frameloop`, and `never` is
 * a stopped loop that still holds its last frame on screen.
 *
 *   - **Off-screen is paused.** An `IntersectionObserver` stops the loop the
 *     moment the hero leaves the viewport and starts it again when it returns.
 *   - **A hidden tab is paused.** `visibilitychange`, for the same reason.
 *   - **Reduced motion renders one frame.** Not a slower animation — one
 *     frame, then nothing. Somebody who asked for no motion gets a still
 *     image, which is what they asked for.
 *   - **Device pixel ratio is capped**, per tier, in `EarthScene`. A 3x phone
 *     rendering this at native density shades nine times the pixels of a 1x
 *     laptop for a backdrop nobody is going to inspect.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { GlobeAnchor } from '@/components/ui/3d-globe';

const EarthScene = lazy(() => import('./EarthScene'));

interface HeroStageProps {
  /**
   * The element the globe should centre itself on — the hub. Optional: with no
   * anchor the globe sits in the middle of the canvas, which is the right
   * answer for a narrow window where the hub is centred anyway.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /**
   * Told once, when the first frame is actually on screen.
   *
   * The hub draws its own glass sphere in CSS, and that sphere and this globe
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
 *   - `full` — the earth with ten trade lanes and three orbits.
 *   - `reduced` — the same earth with no lanes, two orbits, a thinner particle
 *     field and a lower pixel ratio. A mid-range laptop or a large tablet gets
 *     a picture that still says everything the full one says, at roughly a
 *     third of the fill rate.
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
  // that can render this well; it is not one to hand the full texture and ten
  // animated lanes to.
  if (typeof memory === 'number' && memory > 0 && memory < 8) return 'reduced';
  if (typeof cores === 'number' && cores > 0 && cores <= 6) return 'reduced';

  /*
   * A narrow window gets the reduced tier whatever the hardware says.
   *
   * Below `lg` the hub is a 17rem square under the search bar rather than a
   * 30rem one beside it, so the globe is roughly a third of the area it gets on
   * a desktop — at which point a lane is three pixels long. It is not visible,
   * so it is not rendered.
   * That a phone is also the device that can least afford them is a bonus
   * rather than the reason.
   */
  if (window.matchMedia('(max-width: 1023px)').matches) return 'reduced';

  return 'full';
}

/**
 * How wide the GLOBE should be, as a fraction of the square it is given.
 *
 * **This is the number to change to make the globe bigger or smaller.**
 * Everything else in the scene is expressed in globe radii and follows it: the
 * atmosphere reaches 1.14 and the outermost orbit 1.6, so the whole ecosystem
 * spans about three times this.
 *
 * 0.42, against the CSS sphere's 0.33. A rendered object needs more room than
 * a drawn one to read as an object: the drawing was a flat disc whose whole
 * silhouette was the shape, and this is a sphere whose silhouette is broken by
 * coastlines, lanes and three orbits crossing it.
 *
 * The ceiling is `NODE_RADIUS_FRACTION` in `orchestration-nodes.ts`: the cards
 * ride at 0.37 of the square and are 9.5rem across, so anything here past
 * about 0.44 puts the globe ITSELF under a card. The orbits around it are
 * already allowed to pass behind the cards, and should — the cards are opaque
 * panels, so an orbit disappearing behind one and coming out the other side is
 * depth rather than collision.
 */
const CORE_DIAMETER_FRACTION = 0.42;

/**
 * The same number below `lg`, where nothing is orbiting.
 *
 * The ceiling above exists because four cards ride a circle around the square.
 * They only do that from `lg`: below it they sit still in a grid *under* the
 * hub — see the arrangement note in `orchestration.css` — which leaves the
 * square empty and the ceiling with nothing to protect. Holding the desktop
 * fraction there wastes most of a phone's most valuable screen on padding
 * around a 100px object.
 */
const CORE_DIAMETER_FRACTION_NARROW = 0.52;

export function HeroStage({ anchorRef, onActive }: HeroStageProps): React.JSX.Element | null {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Asked once. The answer cannot change for the life of the page, and asking
  // it on every render would run four media queries per frame of a resize.
  const [tier] = useState<StageTier | null>(() => chooseTier());

  const [anchor, setAnchor] = useState<GlobeAnchor | undefined>(undefined);
  const [frameloop, setFrameloop] = useState<'always' | 'demand' | 'never'>('always');
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

  // --- Where the globe goes ------------------------------------------------
  //
  // Measured from the real element rather than guessed from a breakpoint. The
  // hero is a two-column grid that becomes one column below `lg`, and the hub
  // moves a long way when it does — a hard-coded anchor would be right at
  // exactly one window size. Measured on resize only, never per frame, because
  // `getBoundingClientRect` forces layout and doing that sixty times a second
  // is how a backdrop starts costing more than the page it sits behind.

  useEffect(() => {
    if (tier === null) return;

    const host = hostRef.current;
    if (host === null) return;

    const wideLayout = window.matchMedia('(min-width: 1024px)');

    const measure = (): void => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(rect.width, 1);
      const height = Math.max(rect.height, 1);
      const target = anchorRef?.current ?? null;

      const diameterFraction = wideLayout.matches
        ? CORE_DIAMETER_FRACTION
        : CORE_DIAMETER_FRACTION_NARROW;

      if (target === null) {
        setAnchor({
          x: 0.5,
          y: 0.5,
          // With nothing to measure, fall back to the smaller side of the
          // canvas — the same thing a square drawn to fit would do.
          sizePx: Math.min(width, height) * 0.62,
          diameterFraction,
        });

        return;
      }

      const box = target.getBoundingClientRect();

      setAnchor({
        x: (box.left + box.width / 2 - rect.left) / width,
        y: (box.top + box.height / 2 - rect.top) / height,
        // The square's smaller side, so a hub squeezed by a narrow column
        // shrinks with it instead of overflowing.
        sizePx: Math.min(box.width, box.height),
        diameterFraction,
      });
    };

    measure();

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(host);
    if (anchorRef?.current != null) resizeObserver.observe(anchorRef.current);

    /*
     * The breakpoint, watched separately.
     *
     * Crossing 1024px rearranges the hub from an orbit to a grid, and the
     * globe's share of the square changes with it. The `ResizeObserver` above
     * usually catches that — the square is a different size on each side —
     * but not always: a window resized while the hero is off-screen, or a
     * tablet turned on its side into a layout of the same width, both cross
     * the breakpoint without the observed boxes changing.
     */
    wideLayout.addEventListener('change', measure);

    return () => {
      resizeObserver.disconnect();
      wideLayout.removeEventListener('change', measure);
    };
  }, [tier, anchorRef]);

  // --- The brakes ----------------------------------------------------------

  useEffect(() => {
    if (tier === null) return;

    const host = hostRef.current;
    if (host === null) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let onScreen = true;

    const settle = (): void => {
      if (!onScreen || document.hidden) {
        setFrameloop('never');

        return;
      }

      // `demand` renders the frame it is asked for and then nothing, which is
      // exactly what "one still image" means here.
      setFrameloop(reducedMotion.matches ? 'demand' : 'always');
    };

    const intersection = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? false;
        settle();
      },
      { threshold: 0 },
    );
    intersection.observe(host);

    document.addEventListener('visibilitychange', settle);
    // Somebody who turns reduced motion on mid-visit gets a still frame from
    // the next moment, rather than at the next page load.
    reducedMotion.addEventListener('change', settle);

    settle();

    return () => {
      intersection.disconnect();
      document.removeEventListener('visibilitychange', settle);
      reducedMotion.removeEventListener('change', settle);
    };
  }, [tier]);

  // --- Telling the hub -----------------------------------------------------

  const onReady = useCallback(() => {
    setVisible(true);
    onActiveRef.current?.(true);
  }, []);

  useEffect(() => {
    return () => {
      onActiveRef.current?.(false);
    };
  }, []);

  if (tier === null) return null;

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-[1200ms] ease-out ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {/* Nothing while the chunk is in flight: the CSS backdrop under this is
          already a finished picture, and a spinner over it would be the page
          apologising for something nobody noticed. */}
      <Suspense fallback={null}>
        <EarthScene anchor={anchor} tier={tier} frameloop={frameloop} onReady={onReady} />
      </Suspense>
    </div>
  );
}
