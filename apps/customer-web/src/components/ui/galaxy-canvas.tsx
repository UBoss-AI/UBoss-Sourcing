/**
 * A small rotating spiral galaxy, drawn on a canvas with real depth.
 *
 * Stars sit on logarithmic spiral arms in a flat disc, the disc is tilted
 * towards the viewer, and every frame each star is rotated about the disc's
 * axis and projected through a perspective camera - so near stars are larger
 * and brighter and the far side of the disc recedes, rather than a flat
 * pattern sliding across the screen. A dense, warm core and a faint twinkle
 * finish it.
 *
 * Original work, in the spirit of React Bits' "Galaxy" background. No React
 * Bits source is included: that library is MIT + Commons Clause, and this
 * software is itself redistributed to every company that runs it.
 *
 * Cheap by construction: a few hundred points, one canvas, `requestAnimationFrame`
 * only while mounted and the tab is visible, device pixel ratio capped at 2.
 * Where there is no 2-D context (tests, very old browsers) it draws nothing
 * and the card's own gradient shows through.
 */
import { useEffect, useRef } from 'react';

interface Star {
  radius: number;
  angle: number;
  height: number;
  size: number;
  hue: number;
  twinkle: number;
}

/** Deterministic pseudo-random numbers, so the galaxy is the same shape each time. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeStars(count: number, arms: number): Star[] {
  const random = seeded(20260925);
  const stars: Star[] = [];
  for (let index = 0; index < count; index += 1) {
    // Denser towards the centre: the square of a uniform draw.
    const t = random();
    const radius = 0.04 + t * t * 0.96;
    const arm = index % arms;
    // A logarithmic spiral: the angle grows with the log of the radius.
    const spiral = Math.log(radius * 12 + 1) * 2.1;
    const spread = (random() - 0.5) * (0.55 - radius * 0.3);
    stars.push({
      radius,
      angle: (arm / arms) * Math.PI * 2 + spiral + spread,
      height: (random() - 0.5) * 0.08 * (1 - radius),
      size: 0.5 + random() * 1.4,
      // Warm core, cool outer arms.
      hue: radius < 0.25 ? 35 + random() * 20 : 200 + random() * 70,
      twinkle: random() * Math.PI * 2,
    });
  }
  return stars;
}

export function GalaxyCanvas({
  className,
  starCount = 700,
  arms = 3,
  /** Radians per second about the disc's axis. */
  speed = 0.35,
}: {
  className?: string;
  starCount?: number;
  arms?: number;
  speed?: number;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d') ?? null;
    if (canvas === null || context === null) return undefined;

    const stars = makeStars(starCount, arms);
    const tilt = 1.05; // radians: the disc leans towards the viewer
    const cosTilt = Math.cos(tilt);
    const sinTilt = Math.sin(tilt);
    let frame = 0;
    let start = 0;

    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();

    const draw = (now: number): void => {
      if (start === 0) start = now;
      const elapsed = (now - start) / 1000;
      const { width, height } = canvas.getBoundingClientRect();
      const scale = Math.min(width, height * 1.6) * 0.5;
      const centreX = width / 2;
      const centreY = height / 2;
      const camera = 2.4;

      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = 'lighter';

      // The core's glow, drawn first so stars sit on top of it.
      const glow = context.createRadialGradient(
        centreX,
        centreY,
        0,
        centreX,
        centreY,
        scale * 0.45,
      );
      glow.addColorStop(0, 'rgba(255, 220, 170, 0.8)');
      glow.addColorStop(0.35, 'rgba(190, 150, 255, 0.3)');
      glow.addColorStop(1, 'rgba(40, 30, 90, 0)');
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      for (const star of stars) {
        // Inner stars orbit faster, as a real disc does.
        const angle = star.angle + elapsed * speed * (1.4 - star.radius * 0.8);
        const x = Math.cos(angle) * star.radius;
        const z0 = Math.sin(angle) * star.radius;
        // Tilt about the X axis, then project.
        const y = star.height * cosTilt - z0 * sinTilt;
        const z = star.height * sinTilt + z0 * cosTilt;
        const depth = camera / (camera + z);
        const screenX = centreX + x * scale * depth;
        const screenY = centreY + y * scale * depth;
        const nearness = Math.min(1, Math.max(0, (depth - 0.7) / 0.6));
        const shimmer = 0.75 + Math.sin(elapsed * 3 + star.twinkle) * 0.25;
        const alpha = Math.min(1, (0.5 + nearness * 0.6) * shimmer);
        const size = star.size * depth * 1.25;

        context.fillStyle = `hsla(${String(star.hue)}, 90%, ${String(70 + nearness * 20)}%, ${alpha.toFixed(3)})`;
        context.beginPath();
        context.arc(screenX, screenY, size, 0, Math.PI * 2);
        context.fill();
      }
      context.globalCompositeOperation = 'source-over';
      frame = window.requestAnimationFrame(draw);
    };

    const onVisibility = (): void => {
      window.cancelAnimationFrame(frame);
      if (!document.hidden) frame = window.requestAnimationFrame(draw);
    };

    frame = window.requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [starCount, arms, speed]);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} />;
}
