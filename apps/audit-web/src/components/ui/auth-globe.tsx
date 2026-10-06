/**
 * The picture beside a sign-in form.
 *
 * This file owns the *decisions* — whether to render a 3D scene at all, how
 * much of one, and when to stop. The scene itself is `auth-globe-scene.tsx`
 * and the globe is `components/ui/3d-globe.tsx`.
 *
 * **One file, three apps.** It sits beside `auth-form.tsx` under the same rule
 * that file states: the three copies are byte-identical, and a change to one
 * is a change to all three, or the sign-in screens start drifting apart while
 * claiming to be one product.
 *
 * WHY THE CSS PICTURE UNDER IT IS NOT A SPINNER
 *
 * `AuthGlobeFallback` — a brand wash, a drawn disc and a meridian grid — is
 * painted first, always, and stays underneath until the moment the canvas
 * fades in over it. That is not belt-and-braces; it is the only arrangement
 * that keeps the panel a finished picture in every case it actually has to
 * survive, and there are more of those than is convenient to admit: a
 * blocklisted driver, a locked-down enterprise browser, a machine that has
 * spent its GPU budget on other tabs, a headless renderer taking a screenshot,
 * a warehouse tablet. Every one of those lands on the drawing and looks
 * deliberate, because it is.
 *
 * So nothing here is load-bearing. The panel is `aria-hidden` and carries no
 * text, no control and no tab stop: everything a person has to read or press
 * is the form beside it. A visitor who never sees this panel has lost
 * decoration and nothing else.
 *
 * WHY THE SCENE IS LAZY
 *
 * `React.lazy` rather than a static import, so three.js, Fiber, Drei and both
 * earth textures land in their own chunk. Sign-in is the one screen a person
 * is *waiting* on — it stands between them and the thing they came to do — so
 * the form must be typeable before any of that has been asked for. The chunk
 * is fetched after the first paint, and if the fetch never finishes the
 * drawing is simply what the panel is.
 *
 * WHAT STOPS IT COSTING ANYTHING
 *
 *   - **A hidden tab is paused**, once there is a frame to hold. `frameloop`
 *     goes to `never`, which is a stopped loop still showing its last frame.
 *     The "once there is a frame" half is load bearing; see the note on
 *     `frameloop` below.
 *   - **Reduced motion renders one frame.** Not a slower rotation — one frame,
 *     then nothing. Somebody who asked for no motion gets a still image.
 *   - **Weak devices get no canvas**, and mid-range ones get the reduced tier.
 *   - **Device pixel ratio is capped** per tier, in the scene.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { GlobeAnchor } from '@/components/ui/3d-globe';
import { cx } from '@/lib/cx';

const AuthGlobeScene = lazy(() => import('./auth-globe-scene'));

/**
 * How much scene this visit should get, and the page is finished at all three
 * answers:
 *
 *   - `full` — the earth, its atmosphere, thirteen pins and a depth field.
 *   - `reduced` — the same earth with a thinner particle field and a lower
 *     pixel ratio. A mid-range laptop gets a picture that says everything the
 *     full one says at roughly half the fill rate.
 *   - `null` — no canvas at all, and `AuthGlobeFallback` is the panel.
 *
 * Deliberately conservative at the bottom end. A device reporting four cores
 * or fewer would render this at fifteen frames a second and get hot doing it,
 * and fifteen frames a second reads as broken rather than as atmospheric.
 */
type GlobeTier = 'full' | 'reduced';

function chooseTier(): GlobeTier | null {
  if (typeof window === 'undefined') return null;
  if (typeof document === 'undefined') return null;

  /*
   * Does this environment have WebGL 2 at all?
   *
   * Asked by looking for the constructor rather than by asking a canvas for a
   * context. Creating a throwaway context to find out costs a real GPU
   * allocation on a panel that may be about to decide it does not want one —
   * and in jsdom it is worse than that: `getContext` is unimplemented, so
   * every test that renders a sign-in page would log a stack trace through
   * three.js before the failure was caught and handled correctly. The
   * behaviour would be right and the output would say something was broken,
   * which is its own kind of bug.
   */
  if (typeof WebGL2RenderingContext === 'undefined') return null;

  // `deviceMemory` is Chromium-only; its absence is not evidence of anything,
  // so it only ever rules a device out, never in.
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof memory === 'number' && memory > 0 && memory < 4) return null;

  const cores = navigator.hardwareConcurrency;
  if (typeof cores === 'number' && cores > 0 && cores <= 4) return null;

  // Comfortable, not merely capable.
  if (typeof memory === 'number' && memory > 0 && memory < 8) return 'reduced';
  if (typeof cores === 'number' && cores > 0 && cores <= 6) return 'reduced';

  return 'full';
}

// ---------------------------------------------------------------------------
// The drawing underneath
// ---------------------------------------------------------------------------

/**
 * The panel with nothing supplied: a lit disc on a brand wash, with a meridian
 * grid across it.
 *
 * Four layers, all CSS, all free. It is what the panel is on a device that
 * gets no canvas, and what it is for the moment before one arrives — see this
 * file's header for why that moment must already look finished.
 */
export function AuthGlobeFallback({
  /**
   * Whether the drawn earth is still the earth on screen.
   *
   * The canvas over this one is transparent, so the disc does not simply
   * disappear behind it — the rendered globe is a different size and lands in
   * a slightly different place, and the drawing was left showing round the
   * outside of it as a blue ring nobody could explain. So the disc fades out
   * exactly as the rendered one fades in, and the two cross over.
   *
   * The wash does not fade. It is the panel's background rather than part of
   * the drawing, and the rendered scene is lit to sit on it.
   */
  showDisc = true,
}: {
  showDisc?: boolean;
} = {}): React.JSX.Element {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
      {/* The wash: a light source above and behind the disc. */}
      <div className="absolute inset-0 bg-[radial-gradient(90%_70%_at_50%_18%,rgb(var(--bloom)/0.55),transparent_72%)]" />

      {/* The disc. `aspect-square` against the smaller side, so it stays round
          in a panel of any proportion. */}
      <div
        className={cx(
          'absolute left-1/2 top-1/2 h-[min(60%,26rem)] aspect-square -translate-x-1/2 -translate-y-1/2',
          'transition-opacity duration-[1200ms] ease-out',
          showDisc ? 'opacity-100' : 'opacity-0',
        )}
      >
        <div className="h-full w-full rounded-full bg-[radial-gradient(circle_at_32%_28%,rgb(var(--brand)/0.55),rgb(var(--brand-fill)/0.85)_55%,rgb(var(--brand-fill)/0.35))] shadow-[0_0_80px_-10px_rgb(var(--brand)/0.5)]" />

        {/* The meridians, drawn as two repeating gradients rather than as
            twenty elements, and masked to the disc so they curve with it. */}
        <div className="absolute inset-0 rounded-full opacity-25 [background-image:repeating-linear-gradient(90deg,rgb(255_255_255/0.6)_0_1px,transparent_1px_14%),repeating-linear-gradient(0deg,rgb(255_255_255/0.6)_0_1px,transparent_1px_18%)]" />

        {/* The terminator: the edge the light does not reach. */}
        <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_30%_26%,transparent_45%,rgb(0_0_0/0.35))]" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * How much of the panel's smaller side the globe's diameter fills.
 *
 * **This is the number to change to make the globe bigger or smaller.** The
 * atmosphere reaches 1.12 of the globe's own radius and the pins stand off to
 * 1.18, so what is actually drawn spans about 1.2 times this — which is where
 * 0.62 comes from: it leaves the pins on the limb room to be pins rather than
 * shapes pressed against the edge of the panel, and leaves the atmosphere room
 * to fade out into the wash instead of being cut off by it.
 */
const DIAMETER_FRACTION = 0.62;

export function AuthGlobe({ className }: { className?: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Asked once. The answer cannot change for the life of the page, and asking
  // it on every render would run two media queries per frame of a resize.
  const [tier] = useState<GlobeTier | null>(() => chooseTier());

  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);
  const [visible, setVisible] = useState(false);
  const [anchor, setAnchor] = useState<GlobeAnchor | undefined>(undefined);

  /*
   * The loop mode, and the first frame is not negotiable.
   *
   * Until a frame has actually rendered — which is what `visible` records, via
   * `onReady` — the loop runs whatever else is true. Only afterwards do the
   * brakes apply. That ordering is the whole of it, and it is there because
   * the obvious arrangement is broken in a way that is easy to miss: a panel
   * that mounts with `never`, because the tab it opened in was in the
   * background, has no frame to hold and never draws one, so the earth simply
   * never appears — and someone opening sign-in in a new background tab, which
   * is how a middle-click or a restored session arrives, gets that every time.
   *
   * Running while hidden costs nothing worth counting: the browser throttles
   * `requestAnimationFrame` in a background tab to somewhere near zero, so in
   * practice the first frame is drawn the moment the tab is looked at, and the
   * brakes take over immediately after.
   */
  const frameloop: 'always' | 'demand' | 'never' = !visible
    ? 'always'
    : paused
      ? 'never'
      : still
        ? // Renders the frame it is asked for and then nothing, which is what
          // "one still image" means for somebody who asked for no motion.
          'demand'
        : 'always';

  /*
   * How big the earth is, measured rather than left to the camera.
   *
   * Without an anchor the globe fits itself to the canvas, which means its
   * size follows whichever side of the panel is *smaller in world terms* — so
   * the same component drew a comfortable sphere beside a sign-in form and a
   * cropped one beside a create-account form, purely because the second form
   * has more fields in it. Measuring the box and asking for a fraction of its
   * shorter side makes the picture the same picture on every screen this
   * appears on.
   *
   * What is measured is the part of the panel **actually on screen**, not the
   * whole of it. The panel is a full window tall and pinned to the top of it,
   * but it starts below whatever chrome each app puts above it — the
   * storefront's header, the logistics portal's — so at the top of the page
   * its bottom edge hangs below the fold, and a globe centred in the box sits
   * that far too low with its foot cut off. Centring on the visible slice
   * instead needs no app to tell this one how tall its own header is, which is
   * the only version of this that cannot go stale.
   *
   * Measured on resize and scroll, never per frame: `getBoundingClientRect`
   * forces layout, and doing that sixty times a second is how a decoration
   * starts costing more than the page it decorates. A sticky panel stops
   * moving after the first scroll, so this settles almost immediately.
   */
  useEffect(() => {
    if (tier === null) return;

    const host = hostRef.current;
    if (host === null) return;

    let queued = 0;

    const measure = (): void => {
      queued = 0;

      const box = host.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;

      const top = Math.max(box.top, 0);
      const bottom = Math.min(box.bottom, window.innerHeight);
      const height = Math.max(bottom - top, 0);
      if (height <= 0) return;

      setAnchor({
        x: 0.5,
        // As a fraction of the panel, which is the frame the canvas uses.
        y: (top + height / 2 - box.top) / box.height,
        sizePx: Math.min(box.width, height),
        diameterFraction: DIAMETER_FRACTION,
      });
    };

    // Coalesced, so a momentum scroll asks for one measurement a frame at
    // worst rather than one an event.
    const schedule = (): void => {
      if (queued !== 0) return;
      queued = window.requestAnimationFrame(measure);
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(host);
    window.addEventListener('scroll', schedule, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', schedule);
      if (queued !== 0) window.cancelAnimationFrame(queued);
    };
  }, [tier]);

  useEffect(() => {
    if (tier === null) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const settle = (): void => {
      setPaused(document.hidden);
      setStill(reducedMotion.matches);
    };

    document.addEventListener('visibilitychange', settle);
    // Somebody who turns reduced motion on mid-visit gets a still frame from
    // the next moment, rather than at the next page load.
    reducedMotion.addEventListener('change', settle);

    settle();

    return () => {
      document.removeEventListener('visibilitychange', settle);
      reducedMotion.removeEventListener('change', settle);
    };
  }, [tier]);

  const onReady = useCallback(() => {
    setVisible(true);
  }, []);

  return (
    <div ref={hostRef} aria-hidden="true" className={cx('relative overflow-hidden', className)}>
      <AuthGlobeFallback showDisc={!visible} />

      {tier !== null && (
        <div
          className={cx(
            'absolute inset-0 transition-opacity duration-[1200ms] ease-out',
            visible ? 'opacity-100' : 'opacity-0',
          )}
        >
          {/* Nothing while the chunk is in flight: the drawing under this is
              already a finished picture, and a spinner over it would be the
              panel apologising for something nobody noticed. */}
          <Suspense fallback={null}>
            <AuthGlobeScene anchor={anchor} frameloop={frameloop} tier={tier} onReady={onReady} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
