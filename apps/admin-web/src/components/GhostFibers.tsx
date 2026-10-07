/**
 * Ghost fibers: slow, twisting strands of light, drawn by one fragment shader.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web,
 * apps/logistics-web and apps/audit-web. It takes no translation key and no
 * app type, so the four copies cannot drift.
 *
 * Plain WebGL2 rather than a scene library: the whole thing is one triangle
 * that covers the canvas and a shader that colours every pixel, which is a
 * screenful of code and not worth a dependency in four apps.
 *
 * It is decoration and behaves like it. The canvas is `aria-hidden`, takes no
 * pointer events, and the loop stops whenever nobody can see it - the tab is
 * hidden, the element is off screen, or the visitor asked their device for
 * less motion, in which case it draws one still frame and stops. Without
 * WebGL2 it draws nothing, and whatever is behind it (the page's own ground)
 * shows instead.
 */
import { useEffect, useRef } from 'react';

const VERTEX = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uSpeed;
uniform float uScale;
uniform float uRotation;
uniform float uLayers;
uniform float uWaveAmplitude;
uniform float uWaveFrequency;
uniform float uWaveSpeed;
uniform float uLayerSpeed;
uniform float uTwist;
uniform float uTwistFrequency;
uniform float uTwistSpeed;
uniform float uLineFrequency;
uniform float uLineSpacing;
uniform float uLineSharpness;
uniform float uGlowFalloff;
uniform float uGlowIntensity;
uniform float uBrightness;
uniform float uBlueBoost;
uniform float uVignette;
uniform float uGrain;
uniform float uRotationSpeed;
uniform float uLightMode;
uniform float uFiberStrength;
uniform vec3 uLineColor;
uniform vec3 uGlowColor;
uniform vec3 uBackdrop;
uniform vec3 uTintA;
uniform vec3 uTintB;
uniform float uTint;
uniform float uLumaFloor;
uniform vec3 uLiftColor;

out vec4 fragColor;

#define MAX_LAYERS 10

mat2 rotate2d(float angle) {
  float sine = sin(angle);
  float cosine = cos(angle);
  return mat2(cosine, -sine, sine, cosine);
}

float grainHash(vec2 point) {
  point = floor(point);
  float hash = 52.9829189 * fract(dot(point, vec2(0.065, 0.005)));
  return fract(hash);
}

float layeredGrain(vec2 fragmentPixel) {
  vec2 point = mod(fragmentPixel + vec2(uTime * 30.0, -uTime * 21.0), 1024.0);
  vec2 rotated = mat2(0.8, -0.5, 0.5, 0.8) * point;
  float grain = 0.0;
  grain += 0.40 * grainHash(rotated);
  grain += 0.25 * grainHash(rotated * 2.0 + 17.0);
  grain += 0.20 * grainHash(rotated * 4.0 + 47.0);
  grain += 0.10 * grainHash(rotated * 8.0 + 113.0);
  grain += 0.05 * grainHash(rotated * 16.0 + 191.0);
  return grain;
}

void main() {
  vec2 resolution = max(uResolution, vec2(1.0));
  vec2 uv = (2.0 * gl_FragCoord.xy - resolution) / resolution.y;
  float time = uTime * uSpeed;
  vec3 backdrop = uBackdrop;
  vec3 centerTone = max(uLineColor * 0.85567 - uGlowColor * 0.06186, vec3(0.0));
  vec3 cloudTone = uLineColor * 0.19588 + uGlowColor * 0.2268;
  vec2 p = uv;
  p /= max(uScale, 0.05);
  p = rotate2d(radians(uRotation) + time * uRotationSpeed) * p;
  vec3 color = vec3(0.0);
  float fiberField = 0.0;

  for (int index = 0; index < MAX_LAYERS; index++) {
    float fi = float(index) + 1.0;
    if (fi > uLayers) break;

    p += uWaveAmplitude * sin(p.yx * fi * uWaveFrequency + time * (uWaveSpeed + fi * uLayerSpeed));

    float radius = length(p);
    float polarAngle = atan(p.y, p.x);
    polarAngle += sin(radius * uTwistFrequency - time * uTwistSpeed + fi) * uTwist;
    p = vec2(cos(polarAngle), sin(polarAngle)) * radius;

    float lines = abs(sin(p.x * (uLineFrequency + fi * uLineSpacing) + sin(p.y * 3.0 + time)));
    lines = pow(max(0.0, 1.0 - lines), uLineSharpness);
    fiberField += lines / fi;
    color += uLineColor * lines / fi;

    float glow = exp(-uGlowFalloff * abs(sin(p.x * 3.0 + time + fi)));
    color += uGlowColor * glow * uGlowIntensity / (fi * 2.0);
  }

  float center = exp(-2.2 * dot(uv, uv));
  color += centerTone * center;

  float cloud = exp(-1.5 * length(uv + vec2(sin(time * 0.3) * 0.25, cos(time * 0.25) * 0.18)));
  color += cloudTone * cloud;

  float vignette = 1.0 - smoothstep(0.35, 1.45, length(uv));
  color *= mix(1.0 - uVignette, 1.0, vignette);
  color = 1.0 - exp(-color * uBrightness);
  color.b *= uBlueBoost;

  vec3 outputColor;
  if (uLightMode > 0.5) {
    float edgeFade = mix(1.0 - uVignette, 1.0, vignette);
    float fibers = pow(smoothstep(0.12, 1.05, fiberField) * edgeFade, 1.5);
    // Two pale tints that drift across the screen, so the colour moves
    // between indigo and sky rather than being one flat blue.
    float drift = 0.5 + 0.5 * sin(uv.x * 1.4 - uv.y * 0.8 + time * 0.6);
    vec3 tint = mix(uTintA, uTintB, drift);
    // A broad wash where the strands gather, and a haze along each strand:
    // the dark rendering's glow, drawn as colour on a pale ground.
    float atmosphere = clamp((center * 0.55 + cloud * 0.45) * edgeFade, 0.0, 1.0);
    float haze = clamp(dot(color, vec3(0.299, 0.587, 0.114)) * 1.4, 0.0, 1.0) * edgeFade;

    outputColor = mix(backdrop, tint, atmosphere * uTint * 0.6);
    outputColor = mix(outputColor, tint, haze * uTint);
    outputColor = mix(outputColor, mix(outputColor, uLineColor, 0.52), fibers * uFiberStrength);
  } else {
    outputColor = backdrop + color * uFiberStrength;
  }

  float noise = (layeredGrain(gl_FragCoord.xy) - 0.5) * uGrain;
  outputColor = clamp(outputColor + noise, 0.0, 1.0);

  // A floor under the relative luminance (as WCAG measures it). A pixel
  // darker than the floor is lifted toward uLiftColor until it reaches it -
  // a light blue rather than white, so a strand stays blue however strongly
  // it is drawn, and text drawn straight on this ground keeps its contrast.
  if (uLumaFloor > 0.0) {
    vec3 linear = pow(outputColor, vec3(2.2));
    vec3 target = pow(uLiftColor, vec3(2.2));
    vec3 weights = vec3(0.2126, 0.7152, 0.0722);
    float luma = dot(linear, weights);
    float targetLuma = dot(target, weights);
    if (luma < uLumaFloor && targetLuma > luma) {
      float lift = clamp((uLumaFloor - luma) / (targetLuma - luma), 0.0, 1.0);
      outputColor = pow(mix(linear, target, lift), vec3(1.0 / 2.2));
    }
  }

  fragColor = vec4(outputColor, 1.0);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.trim().replace(/^#/, '');
  const normalized = value.length === 3 ? value.replace(/./g, (channel) => channel + channel) : value;
  const match = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalized);
  if (match === null) return [1, 1, 1];
  return [parseInt(match[1] ?? 'ff', 16) / 255, parseInt(match[2] ?? 'ff', 16) / 255, parseInt(match[3] ?? 'ff', 16) / 255];
}

export interface GhostFibersProps {
  lineColor?: string;
  glowColor?: string;
  /** The ground the fibers are drawn on. */
  backdrop?: string;
  /** The light rendering: dark fibers on a pale ground, no additive glow. */
  lightMode?: boolean;
  /** How strongly the fibers show, 0-1. */
  fiberStrength?: number;
  /** The light rendering's two drifting tints, and how strongly they show (0-1). */
  tintA?: string;
  tintB?: string;
  tint?: number;
  /**
   * The light rendering's floor under relative luminance, 0-1. 0 is off. Set it
   * to keep page text at its contrast over the strands: 0.78 keeps every light
   * text token at 4.5:1 or better.
   */
  lumaFloor?: number;
  /** What a pixel under the floor is lifted toward. Its luminance must sit above the floor. */
  liftColor?: string;
  speed?: number;
  scale?: number;
  rotation?: number;
  rotationSpeed?: number;
  layers?: number;
  waveAmplitude?: number;
  waveFrequency?: number;
  waveSpeed?: number;
  layerSpeed?: number;
  twist?: number;
  twistFrequency?: number;
  twistSpeed?: number;
  lineFrequency?: number;
  lineSpacing?: number;
  lineSharpness?: number;
  glowFalloff?: number;
  glowIntensity?: number;
  brightness?: number;
  blueBoost?: number;
  vignette?: number;
  grain?: number;
  /** Drawing-buffer scale. Below 1 renders fewer pixels; the fibers are soft enough not to show it. */
  dpr?: number;
  fps?: number;
  paused?: boolean;
  className?: string;
}

/** Uniform name -> value, refreshed from the props on every change. */
type Uniforms = Record<string, number | readonly number[]>;

function uniformsOf(props: Required<Omit<GhostFibersProps, 'dpr' | 'fps' | 'paused' | 'className'>>): Uniforms {
  return {
    uSpeed: props.speed,
    uScale: props.scale,
    uRotation: props.rotation,
    uRotationSpeed: props.rotationSpeed,
    uLayers: Math.min(Math.max(Math.round(props.layers), 1), 10),
    uWaveAmplitude: props.waveAmplitude,
    uWaveFrequency: props.waveFrequency,
    uWaveSpeed: props.waveSpeed,
    uLayerSpeed: props.layerSpeed,
    uTwist: props.twist,
    uTwistFrequency: props.twistFrequency,
    uTwistSpeed: props.twistSpeed,
    uLineFrequency: props.lineFrequency,
    uLineSpacing: props.lineSpacing,
    uLineSharpness: props.lineSharpness,
    uGlowFalloff: props.glowFalloff,
    uGlowIntensity: props.glowIntensity,
    uBrightness: props.brightness,
    uBlueBoost: props.blueBoost,
    uVignette: props.vignette,
    uGrain: props.grain,
    uLightMode: props.lightMode ? 1 : 0,
    uFiberStrength: props.fiberStrength,
    uTint: props.tint,
    uLumaFloor: props.lumaFloor,
    uLiftColor: hexToRgb(props.liftColor),
    uTintA: hexToRgb(props.tintA),
    uTintB: hexToRgb(props.tintB),
    uLineColor: hexToRgb(props.lineColor),
    uGlowColor: hexToRgb(props.glowColor),
    uBackdrop: hexToRgb(props.backdrop),
  };
}

interface Engine {
  setUniforms: (uniforms: Uniforms) => void;
  setPaused: (paused: boolean) => void;
  setFps: (fps: number) => void;
}

const engines = new WeakMap<HTMLDivElement, Engine>();

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function GhostFibers({
  lineColor = '#140E35',
  glowColor = '#3437A0',
  backdrop = '#120F17',
  lightMode = false,
  fiberStrength = 1,
  tintA = '#A5B4FC',
  tintB = '#7DD3FC',
  tint = 0,
  lumaFloor = 0,
  liftColor = '#FFFFFF',
  speed = 0.2,
  scale = 2,
  rotation = 0,
  rotationSpeed = 0.25,
  layers = 4,
  waveAmplitude = 0.015,
  waveFrequency = 3,
  waveSpeed = 0.15,
  layerSpeed = 0.08,
  twist = 0.1,
  twistFrequency = 5,
  twistSpeed = 1.2,
  lineFrequency = 5,
  lineSpacing = 2,
  lineSharpness = 16,
  glowFalloff = 10,
  glowIntensity = 1.6,
  brightness = 2,
  blueBoost = 1.25,
  vignette = 0.8,
  grain = 0.05,
  dpr = 1,
  fps = 60,
  paused = false,
  className = '',
}: GhostFibersProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // The context, the program and the loop. Rebuilt only when the buffer scale changes.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (gl === null) return undefined;

    const vertexShader = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (vertexShader === null || fragmentShader === null) return undefined;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) return undefined;
    gl.useProgram(program);

    // One triangle larger than the screen: every pixel is inside it, and there is no diagonal seam.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);

    const locations = new Map<string, WebGLUniformLocation | null>();
    const location = (name: string): WebGLUniformLocation | null => {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
      return locations.get(name) ?? null;
    };
    const setUniforms = (uniforms: Uniforms): void => {
      for (const [name, value] of Object.entries(uniforms)) {
        const where = location(name);
        if (where === null) continue;
        if (typeof value === 'number') gl.uniform1f(where, value);
        else if (value.length === 2) gl.uniform2f(where, value[0] ?? 0, value[1] ?? 0);
        else gl.uniform3f(where, value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
      }
    };

    const scaleFactor = Math.min(Math.max(dpr, 0.25), 2) * Math.min(window.devicePixelRatio || 1, 2);
    let elapsed = 0;
    let frameId = 0;
    let previousTime = performance.now();
    let lastRenderTime = 0;
    let frameRate = 60;
    let isPaused = false;
    let isVisible = true;
    let isPageVisible = !document.hidden;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const render = (): void => {
      setUniforms({ uTime: elapsed });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const stop = (): void => {
      if (frameId !== 0) cancelAnimationFrame(frameId);
      frameId = 0;
    };
    const canAnimate = (): boolean => isVisible && isPageVisible && !isPaused && !reducedMotion.matches;

    const loop = (now: number): void => {
      frameId = 0;
      if (!canAnimate()) return;
      const delta = Math.min((now - previousTime) / 1000, 0.1);
      previousTime = now;
      elapsed += delta;
      if (now - lastRenderTime >= 1000 / frameRate - 0.5) {
        render();
        lastRenderTime = now;
      }
      frameId = requestAnimationFrame(loop);
    };
    const start = (): void => {
      if (!canAnimate() || frameId !== 0) return;
      previousTime = performance.now();
      frameId = requestAnimationFrame(loop);
    };
    const settle = (): void => {
      if (canAnimate()) start();
      else {
        stop();
        render();
      }
    };

    const setSize = (): void => {
      const rect = container.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * scaleFactor));
      canvas.height = Math.max(1, Math.floor(rect.height * scaleFactor));
      gl.viewport(0, 0, canvas.width, canvas.height);
      setUniforms({ uResolution: [canvas.width, canvas.height] });
      render();
    };

    const handleVisibility = (): void => {
      isPageVisible = !document.hidden;
      settle();
    };
    const resizeObserver = new ResizeObserver(setSize);
    resizeObserver.observe(container);
    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry?.isIntersecting ?? true;
        settle();
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(container);
    document.addEventListener('visibilitychange', handleVisibility);
    reducedMotion.addEventListener('change', settle);

    // A still frame for reduced motion is drawn a few seconds in, where the
    // strands have spread out, rather than at the very first instant.
    if (reducedMotion.matches) elapsed = 6;

    engines.set(container, {
      setUniforms: (uniforms) => {
        setUniforms(uniforms);
        render();
      },
      setPaused: (value) => {
        isPaused = value;
        settle();
      },
      setFps: (value) => {
        frameRate = Math.min(Math.max(value, 1), 120);
      },
    });

    setSize();
    start();

    return () => {
      stop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      reducedMotion.removeEventListener('change', settle);
      engines.delete(container);
      if (canvas.parentNode === container) container.removeChild(canvas);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [dpr]);

  // The look. Cheap: a handful of uniforms and one redraw.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const engine = engines.get(container);
    if (engine === undefined) return;
    engine.setUniforms(
      uniformsOf({
        lineColor, glowColor, backdrop, lightMode, fiberStrength, tintA, tintB, tint, lumaFloor, liftColor, speed, scale, rotation, rotationSpeed, layers,
        waveAmplitude, waveFrequency, waveSpeed, layerSpeed, twist, twistFrequency, twistSpeed, lineFrequency,
        lineSpacing, lineSharpness, glowFalloff, glowIntensity, brightness, blueBoost, vignette, grain,
      }),
    );
    engine.setFps(fps);
    engine.setPaused(paused);
  }, [
    lineColor, glowColor, backdrop, lightMode, fiberStrength, tintA, tintB, tint, lumaFloor, liftColor, speed, scale, rotation, rotationSpeed, layers,
    waveAmplitude, waveFrequency, waveSpeed, layerSpeed, twist, twistFrequency, twistSpeed, lineFrequency,
    lineSpacing, lineSharpness, glowFalloff, glowIntensity, brightness, blueBoost, vignette, grain, fps, paused, dpr,
  ]);

  return <div ref={containerRef} className={`relative h-full w-full overflow-hidden ${className}`.trim()} />;
}
