/**
 * The vanish, and the placeholder clock — the parts of
 * `ui/placeholders-and-vanish-input.tsx` that are not components.
 *
 * They live apart from it for the reason `components/toast.tsx` and
 * `components/toast-context.ts` live apart: a module that exports anything other
 * than components loses Vite fast refresh for every component in it, and the
 * lint rule that says so is an error here, not a suggestion. The long note on
 * where this effect came from, and on the ten things that had to change in it,
 * is in the component module.
 *
 * `pages/ai/AiComposer.tsx` imports `useVanish` directly, because the AI
 * composer is a textarea that grows and owns a draft its parent clears — none
 * of which it is prepared to hand over to a component that renders its own
 * field.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';

// ---------------------------------------------------------------------------
// Painting the text
// ---------------------------------------------------------------------------

/**
 * Drawn at twice the field's size and displayed at half of it, so the
 * particles are crisp on a retina screen without the loop paying for it.
 */
const RESOLUTION = 2;

/** Sample every other pixel on both axes. See the header. */
const SAMPLE_STEP = 2;

/** Roughly how many frames the sweep takes to cross the text. */
const SWEEP_FRAMES = 32;

/**
 * How long the effect is allowed to last before it is ended regardless.
 *
 * Generous — about three times the sweep at sixty frames a second — because
 * this is a backstop and not a schedule. See the note on the deadline in
 * `useVanish` for the case it exists for.
 */
const SWEEP_DEADLINE_MS = 3000;

interface Particle {
  x: number;
  y: number;
  /** Side of the square, in canvas pixels. Shrinks to nothing on the way out. */
  r: number;
  colour: string;
}

/** The value, broken at the width the field itself would break it at. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    let line = '';

    for (const word of paragraph.split(' ')) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;

      if (ctx.measureText(candidate).width <= maxWidth || line.length === 0) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }

    lines.push(line);
  }

  return lines;
}

/**
 * Paint the field's text onto the canvas and return it as particles.
 *
 * Null when there is nothing to do — no element, no canvas, or a browser
 * without a 2D context. jsdom is the last of those, so a test that submits the
 * composer gets the real clearing behaviour and no animation, rather than an
 * exception from a canvas it never asked about.
 */
function paint(
  canvas: HTMLCanvasElement | null,
  field: HTMLInputElement | HTMLTextAreaElement | null,
  text: string,
): Particle[] | null {
  if (canvas === null || field === null || text.length === 0) return null;

  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  const styles = getComputedStyle(field);
  const width = field.clientWidth;
  const height = field.clientHeight;
  if (width === 0 || height === 0) return null;

  canvas.width = width * RESOLUTION;
  canvas.height = height * RESOLUTION;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const fontSize = parseFloat(styles.fontSize) * RESOLUTION;
  ctx.font = `${styles.fontStyle} ${styles.fontWeight} ${String(fontSize)}px ${styles.fontFamily}`;
  ctx.fillStyle = styles.color;
  ctx.textBaseline = 'top';

  const padLeft = parseFloat(styles.paddingLeft) * RESOLUTION;
  const padTop = parseFloat(styles.paddingTop) * RESOLUTION;
  const maxWidth = canvas.width - padLeft - parseFloat(styles.paddingRight) * RESOLUTION;

  // `line-height: normal` computes to the string rather than to a length, and
  // parses to NaN. 1.4 is close enough to what a browser picks for the fonts
  // this storefront loads, and it is only used to space lines that are about
  // to be destroyed.
  const parsedLineHeight = parseFloat(styles.lineHeight);
  const lineHeight = Number.isNaN(parsedLineHeight)
    ? fontSize * 1.4
    : parsedLineHeight * RESOLUTION;

  const lines = wrap(ctx, text, maxWidth);
  for (const [index, line] of lines.entries()) {
    ctx.fillText(line, padLeft, padTop + index * lineHeight);
  }

  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const particles: Particle[] = [];

  for (let y = 0; y < canvas.height; y += SAMPLE_STEP) {
    const row = y * canvas.width * 4;

    for (let x = 0; x < canvas.width; x += SAMPLE_STEP) {
      const at = row + x * 4;
      const alpha = pixels[at + 3] ?? 0;

      // Alpha, not colour — see the header. Anything faint enough to be
      // antialiasing rather than ink is left out; it would only ever be a
      // particle nobody can see.
      if (alpha > 32) {
        particles.push({
          x,
          y,
          r: 1,
          colour: `rgba(${String(pixels[at] ?? 0)}, ${String(pixels[at + 1] ?? 0)}, ${String(pixels[at + 2] ?? 0)}, ${String(alpha / 255)})`,
        });
      }
    }
  }

  return particles.length === 0 ? null : particles;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface Vanish {
  /** Put this on a canvas laid over the field. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** True while the particles are on screen. Hide the real text under it. */
  isVanishing: boolean;
  /** Blow the given text away. Does not clear the field — see the header. */
  vanish: (text: string) => void;
}

/**
 * The vanish, on any field a caller already owns.
 *
 * Takes a ref rather than rendering an input, because the two places that want
 * this effect are a single-line search box and a textarea that grows, and
 * neither of them is prepared to give up the control it already has.
 */
export function useVanish(
  field: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
): Vanish {
  const reduced = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const frameRef = useRef<number | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const [isVanishing, setIsVanishing] = useState(false);

  // Nothing may still be drawing into a canvas the document no longer holds.
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (deadlineRef.current !== null) window.clearTimeout(deadlineRef.current);
    },
    [],
  );

  const vanish = useCallback(
    (text: string) => {
      if (reduced) return;

      /*
       * Whatever was in flight stops here.
       *
       * Somebody can send twice in quick succession, and two live frame loops
       * writing to one canvas is a flicker with no owner — each frame clears
       * what the other has just drawn. The second send is the one that matters,
       * so the first one's loop is cancelled rather than left to race it.
       */
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }

      const particles = paint(canvasRef.current, field.current, text);
      if (particles === null) return;

      particlesRef.current = particles;
      setIsVanishing(true);

      /*
       * A deadline, because the frame loop can be parked indefinitely.
       *
       * `requestAnimationFrame` does not run in a background tab. Somebody who
       * presses Send and switches tab in the same second leaves the sweep
       * frozen part-way, and the field is transparent while it is frozen — so
       * without this, coming back to that tab an hour later would show a
       * half-dissolved picture over text that cannot be read. A timer is not
       * parked, so it ends the effect whether or not anybody was watching it,
       * and what is left is the ordinary composer.
       */
      if (deadlineRef.current !== null) window.clearTimeout(deadlineRef.current);
      deadlineRef.current = window.setTimeout(() => {
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        particlesRef.current = [];
        setIsVanishing(false);
      }, SWEEP_DEADLINE_MS);

      const rightmost = particles.reduce((furthest, one) => Math.max(furthest, one.x), 0);
      const step = Math.max(rightmost / SWEEP_FRAMES, 1);

      /*
       * One frame of the sweep.
       *
       * Everything left of `edge` is untouched — it is still the text as it was
       * painted. Everything at or right of it has started to come apart, drifts
       * a pixel in each axis and loses a little of its size, and is dropped
       * once there is nothing left of it. So the words disintegrate from the
       * right, which is the end somebody just finished typing.
       */
      const drawFrame = (edge: number): void => {
        frameRef.current = requestAnimationFrame(() => {
          const surviving: Particle[] = [];

          for (const particle of particlesRef.current) {
            if (particle.x < edge) {
              surviving.push(particle);
              continue;
            }

            if (particle.r <= 0) continue;

            particle.x += Math.random() > 0.5 ? 1 : -1;
            particle.y += Math.random() > 0.5 ? 1 : -1;
            particle.r -= 0.05 * Math.random();
            surviving.push(particle);
          }

          particlesRef.current = surviving;

          const canvas = canvasRef.current;
          const ctx = canvas?.getContext('2d') ?? null;

          if (canvas !== null && ctx !== null) {
            ctx.clearRect(edge, 0, canvas.width, canvas.height);

            for (const particle of surviving) {
              if (particle.x <= edge) continue;
              ctx.fillStyle = particle.colour;
              ctx.fillRect(particle.x, particle.y, particle.r, particle.r);
            }
          }

          /*
           * Done when nothing is left, and the edge keeps going regardless.
           *
           * The edge is deliberately allowed to run past the left of the
           * canvas rather than stopping at it, and that is the termination
           * condition rather than an oversight. A particle left of the edge is
           * held still — it is the text as it was painted — and a dispersing
           * particle random-walks a pixel an axis per frame, so it can wander
           * left of an edge that has stopped moving. It would then be held
           * still for ever, the loop would never empty, and the composer's own
           * text would stay transparent underneath it. An edge that keeps
           * descending overtakes every particle eventually.
           */
          if (surviving.length > 0) {
            drawFrame(edge - step);
          } else {
            frameRef.current = null;
            if (deadlineRef.current !== null) {
              window.clearTimeout(deadlineRef.current);
              deadlineRef.current = null;
            }
            setIsVanishing(false);
          }
        });
      };

      drawFrame(rightmost);
    },
    [field, reduced],
  );

  return { canvasRef, isVanishing, vanish };
}

// ---------------------------------------------------------------------------
// Cycling placeholders
// ---------------------------------------------------------------------------

/** How long a placeholder stays up before the next one, in milliseconds. */
const PLACEHOLDER_DURATION = 3000;

/**
 * The index of the placeholder currently showing.
 *
 * A hidden tab parks it rather than queueing up a burst of changes for the
 * moment somebody comes back — the same behaviour `greeting/HeroStage.tsx`
 * describes for the scene behind the greeting, and for the same reason.
 */
export function useCyclingPlaceholder(count: number, isPaused: boolean): number {
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduced || isPaused || count < 2) return undefined;

    let timer: number | null = null;

    const start = (): void => {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        setIndex((previous) => (previous + 1) % count);
      }, PLACEHOLDER_DURATION);
    };

    const stop = (): void => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };

    const settle = (): void => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    settle();
    document.addEventListener('visibilitychange', settle);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', settle);
    };
  }, [reduced, isPaused, count]);

  // A list that shrinks under a live index would otherwise read past its end.
  return count === 0 ? 0 : index % count;
}
