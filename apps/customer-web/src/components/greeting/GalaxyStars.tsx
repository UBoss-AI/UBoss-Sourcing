/**
 * A drifting star field behind the home page's greeting.
 *
 * Adapted from React Bits' "Galaxy" (ogl + one fragment shader), with one
 * deliberate change: it only ever draws the stars. The original can clear to
 * black, and a black ground would take the storefront's blue theme with it, so
 * this is always the transparent variant — every pixel that is not a star has
 * an alpha of zero and the page's own backdrop shows through untouched.
 *
 * Three more differences from the original, each for this page:
 *
 *   - **Pointer from the window, not the container.** The backdrop is
 *     `pointer-events-none` so it never steals a click from the hero, which
 *     means the container never sees a `mousemove`. The window does.
 *   - **Sized by a ResizeObserver**, not `window.resize`: the greeting's height
 *     changes with its content without the window changing at all.
 *   - **Still under reduced motion, and silent without WebGL.** A visitor who
 *     asked for less movement gets one frozen frame; a browser (or jsdom) with
 *     no WebGL context gets nothing, rather than an error on the home page.
 *
 * The stars are light-on-transparent, which disappears on the light palette's
 * white. There the canvas is inverted and its hue turned back, so the same
 * stars read as ink-blue points instead — see `.galaxy-stars` in index.css.
 */
import { Color, Mesh, Program, Renderer, Triangle } from 'ogl';
import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const fragmentShader = `
precision highp float;

uniform float uTime;
uniform vec3 uResolution;
uniform vec2 uFocal;
uniform vec2 uRotation;
uniform float uStarSpeed;
uniform float uDensity;
uniform float uHueShift;
uniform float uSpeed;
uniform vec2 uMouse;
uniform float uGlowIntensity;
uniform float uSaturation;
uniform bool uMouseRepulsion;
uniform float uTwinkleIntensity;
uniform float uRotationSpeed;
uniform float uRepulsionStrength;
uniform float uMouseActiveFactor;

varying vec2 vUv;

#define NUM_LAYER 4.0
#define STAR_COLOR_CUTOFF 0.2
#define MAT45 mat2(0.7071, -0.7071, 0.7071, 0.7071)
#define PERIOD 3.0

float Hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float tri(float x) {
  return abs(fract(x) * 2.0 - 1.0);
}

float tris(float x) {
  float t = fract(x);
  return 1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0));
}

float trisn(float x) {
  float t = fract(x);
  return 2.0 * (1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0))) - 1.0;
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float Star(vec2 uv, float flare) {
  float d = length(uv);
  float m = (0.05 * uGlowIntensity) / d;
  float rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  m += rays * flare * uGlowIntensity;
  uv *= MAT45;
  rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  m += rays * 0.3 * flare * uGlowIntensity;
  m *= smoothstep(1.0, 0.2, d);
  return m;
}

vec3 StarLayer(vec2 uv) {
  vec3 col = vec3(0.0);

  vec2 gv = fract(uv) - 0.5;
  vec2 id = floor(uv);

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 si = id + vec2(float(x), float(y));
      float seed = Hash21(si);
      float size = fract(seed * 345.32);
      float glossLocal = tri(uStarSpeed / (PERIOD * seed + 1.0));
      float flareSize = smoothstep(0.9, 1.0, size) * glossLocal;

      float red = smoothstep(STAR_COLOR_CUTOFF, 1.0, Hash21(si + 1.0)) + STAR_COLOR_CUTOFF;
      float blu = smoothstep(STAR_COLOR_CUTOFF, 1.0, Hash21(si + 3.0)) + STAR_COLOR_CUTOFF;
      float grn = min(red, blu) * seed;
      vec3 base = vec3(red, grn, blu);

      float hue = atan(base.g - base.r, base.b - base.r) / (2.0 * 3.14159) + 0.5;
      hue = fract(hue + uHueShift / 360.0);
      float sat = length(base - vec3(dot(base, vec3(0.299, 0.587, 0.114)))) * uSaturation;
      float val = max(max(base.r, base.g), base.b);
      base = hsv2rgb(vec3(hue, sat, val));

      vec2 pad = vec2(tris(seed * 34.0 + uTime * uSpeed / 10.0), tris(seed * 38.0 + uTime * uSpeed / 30.0)) - 0.5;

      float star = Star(gv - offset - pad, flareSize);
      vec3 color = base;

      float twinkle = trisn(uTime * uSpeed + seed * 6.2831) * 0.5 + 1.0;
      twinkle = mix(1.0, twinkle, uTwinkleIntensity);
      star *= twinkle;

      col += star * size * color;
    }
  }

  return col;
}

void main() {
  vec2 focalPx = uFocal * uResolution.xy;
  vec2 uv = (vUv * uResolution.xy - focalPx) / uResolution.y;

  vec2 mouseNorm = uMouse - vec2(0.5);

  if (uMouseRepulsion) {
    vec2 mousePosUV = (uMouse * uResolution.xy - focalPx) / uResolution.y;
    float mouseDist = length(uv - mousePosUV);
    vec2 repulsion = normalize(uv - mousePosUV) * (uRepulsionStrength / (mouseDist + 0.1));
    uv += repulsion * 0.05 * uMouseActiveFactor;
  } else {
    vec2 mouseOffset = mouseNorm * 0.1 * uMouseActiveFactor;
    uv += mouseOffset;
  }

  float autoRotAngle = uTime * uRotationSpeed;
  mat2 autoRot = mat2(cos(autoRotAngle), -sin(autoRotAngle), sin(autoRotAngle), cos(autoRotAngle));
  uv = autoRot * uv;

  uv = mat2(uRotation.x, -uRotation.y, uRotation.y, uRotation.x) * uv;

  vec3 col = vec3(0.0);

  for (float i = 0.0; i < 1.0; i += 1.0 / NUM_LAYER) {
    float depth = fract(i + uStarSpeed * uSpeed);
    float scale = mix(20.0 * uDensity, 0.5 * uDensity, depth);
    float fade = depth * smoothstep(1.0, 0.9, depth);
    col += StarLayer(uv * scale + i * 453.32) * fade;
  }

  // Stars only: everything that is not a star is fully transparent.
  float alpha = smoothstep(0.0, 0.3, length(col));
  gl_FragColor = vec4(col, min(alpha, 1.0));
}
`;

export interface GalaxyStarsProps {
  density?: number;
  glowIntensity?: number;
  saturation?: number;
  hueShift?: number;
  twinkleIntensity?: number;
  rotationSpeed?: number;
  repulsionStrength?: number;
  starSpeed?: number;
  speed?: number;
  mouseRepulsion?: boolean;
  mouseInteraction?: boolean;
  className?: string;
}

export function GalaxyStars({
  density = 1,
  glowIntensity = 0.3,
  saturation = 0,
  hueShift = 140,
  twinkleIntensity = 0.3,
  rotationSpeed = 0.1,
  repulsionStrength = 2,
  starSpeed = 0.5,
  speed = 1,
  mouseRepulsion = true,
  mouseInteraction = true,
  className,
}: GalaxyStarsProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;

    let renderer: Renderer;
    try {
      renderer = new Renderer({ alpha: true, premultipliedAlpha: false });
    } catch {
      // No WebGL here. The page's own backdrop is the whole picture.
      return undefined;
    }

    const gl = renderer.gl;
    // ogl hands back a null context rather than throwing on some browsers.
    if (!(gl as WebGLRenderingContext | null)) return undefined;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    const targetMouse = { x: 0.5, y: 0.5 };
    const smoothMouse = { x: 0.5, y: 0.5 };
    let targetActive = 0;
    let smoothActive = 0;

    // Held here, typed, because ogl types `program.uniforms` as `any`.
    const uniforms = {
      uTime: { value: 0 },
      uResolution: { value: new Color(1, 1, 1) },
      uFocal: { value: new Float32Array([0.5, 0.5]) },
      uRotation: { value: new Float32Array([1, 0]) },
      uStarSpeed: { value: starSpeed },
      uDensity: { value: density },
      uHueShift: { value: hueShift },
      uSpeed: { value: speed },
      uMouse: { value: new Float32Array([0.5, 0.5]) },
      uGlowIntensity: { value: glowIntensity },
      uSaturation: { value: saturation },
      uMouseRepulsion: { value: mouseRepulsion },
      uTwinkleIntensity: { value: twinkleIntensity },
      uRotationSpeed: { value: rotationSpeed },
      uRepulsionStrength: { value: repulsionStrength },
      uMouseActiveFactor: { value: 0 },
    };
    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      transparent: true,
      uniforms,
    });

    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

    const resize = (): void => {
      renderer.setSize(container.offsetWidth, container.offsetHeight);
      uniforms.uResolution.value = new Color(
        gl.canvas.width,
        gl.canvas.height,
        gl.canvas.width / Math.max(gl.canvas.height, 1),
      );
      // A frozen field still has to be redrawn at the new size.
      if (reducedMotion) renderer.render({ scene: mesh });
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    container.appendChild(gl.canvas);
    resize();

    let frame = 0;
    const update = (t: number): void => {
      frame = requestAnimationFrame(update);

      uniforms.uTime.value = t * 0.001;
      uniforms.uStarSpeed.value = (t * 0.001 * starSpeed) / 10;

      const lerp = 0.05;
      smoothMouse.x += (targetMouse.x - smoothMouse.x) * lerp;
      smoothMouse.y += (targetMouse.y - smoothMouse.y) * lerp;
      smoothActive += (targetActive - smoothActive) * lerp;

      uniforms.uMouse.value[0] = smoothMouse.x;
      uniforms.uMouse.value[1] = smoothMouse.y;
      uniforms.uMouseActiveFactor.value = smoothActive;

      renderer.render({ scene: mesh });
    };

    const onPointerMove = (event: PointerEvent): void => {
      const rect = container.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;

      targetActive = inside ? 1 : 0;
      if (inside) {
        targetMouse.x = (event.clientX - rect.left) / rect.width;
        targetMouse.y = 1 - (event.clientY - rect.top) / rect.height;
      }
    };

    const onPointerLeave = (): void => {
      targetActive = 0;
    };

    const interactive = mouseInteraction && !reducedMotion;

    if (reducedMotion) {
      // One still frame, a few seconds in so the layers have spread out.
      uniforms.uTime.value = 4;
      uniforms.uStarSpeed.value = (4 * starSpeed) / 10;
      renderer.render({ scene: mesh });
    } else {
      frame = requestAnimationFrame(update);
    }

    if (interactive) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', onPointerLeave);
    }

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (interactive) {
        window.removeEventListener('pointermove', onPointerMove);
        document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      }
      gl.canvas.remove();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [
    density,
    glowIntensity,
    saturation,
    hueShift,
    twinkleIntensity,
    rotationSpeed,
    repulsionStrength,
    starSpeed,
    speed,
    mouseRepulsion,
    mouseInteraction,
    reducedMotion,
  ]);

  return <div ref={containerRef} aria-hidden="true" className={className} />;
}
