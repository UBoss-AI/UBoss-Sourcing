/**
 * The brand mark, for a deployment that has uploaded no logo.
 *
 * A 40px earth, turning slowly, in the plate where the header would otherwise
 * show the first letter of the business name. It is the same object as the
 * one on the landing page — `components/ui/3d-globe.tsx` — at a twentieth of
 * the size, which is the point: a marketplace whose front page is a globe and
 * whose header is a grey letter has two brands.
 *
 * THE LETTER IS STILL THERE, AND IT IS THE BASE
 *
 * It renders first, underneath, and the globe fades in over it if and when
 * there is genuinely a frame to show. That ordering is the whole design:
 *
 *   - **A logo may not depend on WebGL.** The header is on every page, and a
 *     blocklisted driver, a locked-down browser or a machine out of GPU
 *     contexts must produce a finished header, not a hole in one.
 *   - **A logo may not depend on a download.** The scene is lazy, so for the
 *     first moments of a visit there is nothing to draw. The letter is what is
 *     there, and it is a perfectly good mark.
 *   - **Reduced motion means no spinning object in the chrome.** Not a slower
 *     one. Somebody who asked for stillness gets the letter, on every page,
 *     for the whole visit.
 *
 * WHY IT IS CHEAP ENOUGH TO PUT ON EVERY PAGE
 *
 * It draws a 40px square: at the capped pixel ratio that is 3,600 fragments a
 * frame, which is less work than one of the product cards underneath it does
 * on a hover. It takes the 1024×512 earth rather than the landing page's
 * 2048×1024 — the texture is uploaded to the GPU at its own size whatever size
 * it renders at — it carries no pins, no lanes and no orbits, and its loop
 * stops the moment the tab is hidden.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import earthSmallUrl from '@/assets/globe/earth-blue-marble-sm.jpg';

const Globe3D = lazy(async () => {
  const module = await import('@/components/ui/3d-globe');

  return { default: module.Globe3D };
});

export interface EarthMarkProps {
  /** The letter under it, and the mark itself wherever the globe cannot go. */
  initial: string;
  /**
   * How big to draw it.
   *
   * `md` is 40px, which is the storefront header. `sm` is 28px, which is the
   * console and portal rails — those are 28px marks inside a 40px row, and a
   * 40px earth in one of them would make the brand row taller than every row
   * beneath it. Two fixed sizes rather than a number, because the classes have
   * to be literal for Tailwind to emit them.
   */
  size?: 'sm' | 'md';
}

/** Box, letter and radius, per size. The globe fills whatever box it is in. */
const SIZES = {
  sm: { box: 'h-7 w-7', letter: 'text-xs', radius: 'rounded-md' },
  md: { box: 'h-10 w-10', letter: 'text-base', radius: 'rounded-md' },
} as const;

/**
 * Can this browser draw it at all?
 *
 * The constructor rather than a throwaway context, for the reason
 * `HeroStage` gives at length: asking a canvas costs a real GPU allocation on
 * a page that may be about to decide it does not want one, and in jsdom it
 * logs a stack trace through three.js for a branch that is behaving correctly.
 */
function supported(): boolean {
  return typeof window !== 'undefined' && typeof WebGL2RenderingContext !== 'undefined';
}

/** And does this visitor want it drawn? */
function wanted(): boolean {
  return supported() && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function EarthMark({ initial, size = 'md' }: EarthMarkProps): React.JSX.Element {
  const { box, letter, radius } = SIZES[size];
  const [allowed, setAllowed] = useState<boolean>(() => wanted());
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    // Nothing to listen for where the globe could never render: a browser
    // without WebGL does not start drawing one because somebody turned an
    // animation preference back on.
    if (!supported()) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onPreference = (): void => {
      setAllowed(wanted());
    };
    const onVisibility = (): void => {
      setRunning(!document.hidden);
    };

    reducedMotion.addEventListener('change', onPreference);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      reducedMotion.removeEventListener('change', onPreference);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <span aria-hidden="true" className={`relative block shrink-0 ${box}`}>
      {/* The letter. Always rendered, and on its own it is a finished mark. */}
      <span
        className={`flex items-center justify-center bg-brand-fill font-bold text-white shadow-card transition-opacity duration-500 ${box} ${letter} ${radius} ${
          ready ? 'opacity-0' : 'opacity-100'
        }`}
      >
        {initial}
      </span>

      {allowed && (
        <span
          className={`absolute inset-0 transition-opacity duration-700 ${
            ready ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <Suspense fallback={null}>
            <Globe3D
              frameloop={running ? 'always' : 'never'}
              dpr={1.5}
              onReady={() => {
                setReady(true);
              }}
              config={{
                radius: 2,
                textureUrl: earthSmallUrl,
                // No elevation map at 40px: a bump map is shading detail a few
                // pixels across, and at this size there are no few pixels.
                bumpMapUrl: null,
                bumpScale: 0,
                atmosphereIntensity: 0.75,
                atmosphereBlur: 2.8,
                // Slower than the hero's. A mark that spins at reading speed
                // in the corner of every page is a mark competing with the
                // page, and this one is two centimetres from the navigation.
                autoRotateSpeed: 9,
                // Flat, for the same reason the hero is: a 40px mark with a
                // night side is a 20px mark.
                ambientIntensity: 3.4,
                pointLightIntensity: 0.25,
              }}
            />
          </Suspense>
        </span>
      )}
    </span>
  );
}
