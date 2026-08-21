import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import shaderCode from "./shaders/black_hole_trash.wgsl?raw";
import type { DropPhase, EffectQuality, TerrainMode, WeatherState } from "./types";

interface BlackHoleCanvasProps {
  phase: DropPhase;
  weather?: WeatherState | null;
  weatherIntensity?: number;
  recycledCount?: number;
  terrainMode?: TerrainMode;
  terrainIntensity?: number;
  mouseGravityEnabled?: boolean;
  effectQuality?: EffectQuality;
}

interface DesktopFrame {
  width: number;
  height: number;
  rgba: number[];
  monitorName?: string | null;
  scaleFactor?: number;
  captureBackend?: string;
}

const terrainModeValue: Record<TerrainMode, number> = {
  none: 0,
  gravity: 1,
  crater: 2,
  liquid: 3,
  snow: 4,
  dunes: 5,
  dust: 6,
};

// Gargantua preset from BlackHoleTrash, tuned only for this 124 px companion.
const GARGANTUA = [
  4500, 1.52, 0.1, 2.2, 7, 0.85, 0.35, 2, 1.4, 0.5, 7, 5, 1.28, 1.35,
];

const WEBGL_VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const WEBGL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_phase;
uniform sampler2D u_desktop;
uniform float u_has_desktop;
out vec4 fragColor;

const float B_CRIT = 2.5980762;
const float LENS_DEPTH = 21.0;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
vec2 mirrorUV(vec2 u) {
  vec2 m = u - 2.0 * floor(u / 2.0);
  return 1.0 - abs(1.0 - m);
}
vec3 blackbody(float T) {
  float t = clamp(T, 1500.0, 40000.0) / 100.0;
  float r = 1.0;
  if (t > 66.0) r = clamp(1.292936 * pow(t - 60.0, -0.1332047), 0.0, 1.0);
  float g = 0.0;
  if (t <= 66.0) g = clamp(0.3900816 * log(t) - 0.6318414, 0.0, 1.0);
  else g = clamp(1.1298909 * pow(t - 60.0, -0.0755148), 0.0, 1.0);
  float b = 1.0;
  if (t < 66.0) { b = t <= 19.0 ? 0.0 : clamp(0.5432068 * log(t - 10.0) - 1.196254, 0.0, 1.0); }
  return vec3(r, g, b);
}
vec3 stars(vec3 d) {
  vec2 sph = vec2(atan(d.x, -d.z), asin(clamp(d.y, -1.0, 1.0)));
  vec2 g = sph * 40.0;
  vec2 id = floor(g);
  float h = hash21(id);
  if (h < 0.92) return vec3(0.0);
  vec2 f = fract(g) - 0.5;
  vec2 off = (vec2(hash21(id + 17.3), hash21(id + 31.7)) - 0.5) * 0.7;
  float spark = smoothstep(0.10, 0.0, length(f - off));
  float tw = 0.7 + 0.3 * sin(u_time * (0.5 + 2.0 * hash21(id + 5.1)) + 40.0 * h);
  vec3 tint = mix(vec3(1.0, 0.82, 0.60), vec3(0.75, 0.85, 1.0), hash21(id + 2.9));
  return tint * spark * tw * ((h - 0.92) / 0.08);
}
float vnoiseWrapY(vec2 p, float perY) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, perY);
  float y1 = mod(i.y + 1.0, perY);
  return mix(mix(hash21(vec2(i.x, y0)), hash21(vec2(i.x + 1.0, y0)), f.x),
             mix(hash21(vec2(i.x, y1)), hash21(vec2(i.x + 1.0, y1)), f.x), f.y);
}

// Live desktop when available; procedural checkerboard otherwise.
vec3 background(vec2 uvin) {
  vec2 uvm = mirrorUV(uvin);
  if (u_has_desktop > 0.5) {
    return texture(u_desktop, uvm).rgb;
  }
  vec3 grad = vec3(uvm.x, uvm.y, 0.6) * 0.12;
  float cx = step(0.5, fract(uvm.x * 16.0));
  float cy = step(0.5, fract(uvm.y * 9.0));
  float c = abs(cx - cy);
  vec3 checker = mix(vec3(0.05, 0.06, 0.09), vec3(0.14, 0.16, 0.22), c);
  return mix(checker, grad, 0.35);
}

vec3 shadeDisk(vec3 xc, vec3 vdir, vec3 n, vec3 e2, float rin, float rout, float t, float sdir, float spd, float trans) {
  float rc = length(xc);
  if (rc <= rin || rc >= rout) return vec3(0.0);
  float band = smoothstep(rin, rin * 1.25, rc) * (1.0 - smoothstep(rout * 0.70, rout, rc));
  float phi = atan(dot(xc, e2), xc.x);
  float turns = phi / 6.2831853;
  float kep = pow(rin / rc, 1.5);
  float gloc = sqrt(max(1.0 - 1.5 / rc, 0.02));
  float swirl = rc * 0.5 * 0.12 - t * kep * spd * gloc * sdir;
  float streaks = vnoiseWrapY(vec2(rc * 2.8, turns * 19.0 + swirl * 3.0), 19.0) * 0.65
              + vnoiseWrapY(vec2(rc * 1.0, turns * 9.0 + swirl * 1.5 + 7.0), 9.0) * 0.35;
  streaks = 0.35 + 0.5 * streaks * streaks;
  vec3 gasdir = normalize(cross(n, xc)) * sdir;
  float beta = clamp(1.0 / sqrt(max(2.0 * (rc - 1.0), 0.2)), 0.0, 0.99);
  float g = gloc / max(1.0 + beta * dot(gasdir, vdir), 0.05);
  float xpr = max(1.0 - sqrt(rin / rc), 0.0);
  float tprof = pow(rin / rc, 0.75) * pow(xpr, 0.25) / 0.488;
  vec3 cbb = blackbody(4500.0 * tprof * g);
  float boost = pow(g, 1.4);
  float density = band * streaks;
  return trans * cbb * (2.2 * density * tprof * tprof * boost);
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  uv.y = 1.0 - uv.y;
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  float t = u_time;
  float rh = 0.205;
  vec2 center = vec2(0.5, 0.48);
  vec2 p = (uv - center) * vec2(aspect, 1.0);
  float plen = length(p);
  float W = B_CRIT / max(rh, 1e-4);
  vec2 pr = p * W;
  float b = length(pr);
  float window = exp(-pow(plen / (7.0 * rh), 2.0));
  float rin = 1.6, rout = 7.0, Z0 = 14.0;
  float incl = 1.52;
  float ci = cos(incl), si = sin(incl);
  vec3 n = vec3(0.0, si, ci);
  vec3 e2 = vec3(0.0, ci, -si);
  float sdir = 1.0, spd = 1.0;
  vec3 col = vec3(0.0);

  if (b >= rout + 3.0) {
    float uu = Z0 / sqrt(Z0 * Z0 + b * b);
    float defl = (2.0 / (W * W)) / max(plen, 1e-4)
      * (1.29 * uu + 0.07) * max(LENS_DEPTH - 2.14 * uu + 0.75, 0.0) * window;
    vec2 dir = p / max(plen, 1e-5);
    vec2 sp = p - dir * defl;
    vec2 buv = center + sp / vec2(aspect, 1.0);
    col = background(buv);
    vec3 d = normalize(vec3(-(pr / b) * (2.0 / b), -1.0));
    col += stars(d) * 1.35 * window;
  } else {
    vec3 x = vec3(pr, Z0);
    vec3 v = vec3(0.0, 0.0, -1.0);
    float h2 = dot(pr, pr);
    vec3 emitc = vec3(0.0);
    float trans = 1.0;
    bool captured = false;
    float sPrev = dot(x, n);
    vec3 xPrev = x;
    for (int i = 0; i < 48; i++) {
      float r2 = dot(x, x);
      if (r2 < 1.0) { captured = true; break; }
      if (x.z < -Z0 && v.z < 0.0) break;
      if (r2 > 4.0 * Z0 * Z0) break;
      float r = sqrt(r2);
      float dt = clamp(0.16 * r, 0.03, 1.5);
      vec3 acc = -1.5 * h2 * x / (r2 * r2 * r);
      v += acc * (0.5 * dt); x += v * dt;
      r2 = dot(x, x); r = sqrt(r2);
      acc = -1.5 * h2 * x / (r2 * r2 * r);
      v += acc * (0.5 * dt);
      float s = dot(x, n);
      if (s * sPrev < 0.0 && trans > 0.02) {
        float tc = sPrev / (sPrev - s);
        vec3 xc = mix(xPrev, x, tc);
        emitc += shadeDisk(xc, normalize(v), n, e2, rin, rout, t, sdir, spd, trans);
        float rc = length(xc);
        if (rc > rin && rc < rout) {
          float band = smoothstep(rin, rin * 1.25, rc) * (1.0 - smoothstep(rout * 0.70, rout, rc));
          float streaks = vnoiseWrapY(vec2(rc * 2.8, atan(dot(xc, e2), xc.x) / 6.2831853 * 19.0), 19.0) * 0.65
                      + vnoiseWrapY(vec2(rc * 1.0, atan(dot(xc, e2), xc.x) / 6.2831853 * 9.0 + 7.0), 9.0) * 0.35;
          streaks = 0.35 + 0.5 * streaks * streaks;
          trans *= (1.0 - clamp(0.5 * band * streaks, 0.0, 1.0));
        }
      }
      sPrev = s; xPrev = x;
    }
    if (!captured && dot(x, x) < 4.0) captured = true;
    if (captured) {
      col = vec3(0.0);
    } else {
      vec3 d = normalize(v);
      col = vec3(0.02, 0.03, 0.04) + stars(d) * 1.35;
      // Project escaped ray onto the desktop sky plane for live lensing.
      if (d.z < -0.05) {
        float tpl = (-LENS_DEPTH - x.z) / d.z;
        vec2 hp = (x + d * tpl).xy;
        vec2 q = hp / W;
        vec2 sp = vec2(q.x, -q.y);
        vec2 suv = center + (p + (sp - p) * window) / vec2(aspect, 1.0);
        float toward = smoothstep(0.05, 0.35, -d.z);
        col += background(suv) * toward;
      }
    }
    col += emitc;
  }
  float glow = exp(-pow(plen / (rh * 2.5), 2.0)) * 0.12;
  vec3 glowColor = mix(vec3(0.15, 0.4, 0.35), vec3(0.34, 1.0, 0.82), u_phase);
  col += glowColor * glow;
  if (plen < rh * 0.92) col = vec3(0.0);
  fragColor = vec4(col, 1.0);
}`;

function makeSpaceTexture(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) return canvas;

  const background = context.createRadialGradient(142, 104, 8, 128, 128, 190);
  background.addColorStop(0, "#183d3a");
  background.addColorStop(0.28, "#071d21");
  background.addColorStop(0.72, "#02080d");
  background.addColorStop(1, "#000205");
  context.fillStyle = background;
  context.fillRect(0, 0, 256, 256);

  const cloud = context.createLinearGradient(15, 235, 238, 21);
  cloud.addColorStop(0, "rgba(25, 224, 176, 0)");
  cloud.addColorStop(0.48, "rgba(25, 224, 176, .3)");
  cloud.addColorStop(1, "rgba(65, 121, 158, 0)");
  context.strokeStyle = cloud;
  context.lineWidth = 24;
  context.beginPath();
  context.moveTo(-20, 218);
  context.bezierCurveTo(58, 179, 154, 76, 278, 35);
  context.stroke();

  context.strokeStyle = "rgba(144, 255, 226, .38)";
  context.lineWidth = 1.2;
  context.beginPath();
  context.moveTo(-18, 206);
  context.bezierCurveTo(66, 168, 159, 68, 276, 31);
  context.stroke();

  let seed = 0x51f15e;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let index = 0; index < 180; index += 1) {
    const x = random() * 256;
    const y = random() * 256;
    const radius = random() > 0.9 ? 1.3 : 0.55;
    context.fillStyle = random() > 0.7
      ? `rgba(117, 255, 220, ${0.22 + random() * 0.48})`
      : `rgba(200, 222, 255, ${0.18 + random() * 0.42})`;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
  return canvas;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.error("Shader compile error:", gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
  return null;
}

function initWebGL2Renderer(
  canvas: HTMLCanvasElement,
  phaseRef: React.MutableRefObject<DropPhase>,
  effectQualityRef: React.MutableRefObject<EffectQuality>,
): (() => void) | null {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
  if (!gl) return null;

  const vert = compileShader(gl, gl.VERTEX_SHADER, WEBGL_VERTEX_SHADER);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, WEBGL_FRAGMENT_SHADER);
  if (!vert || !frag) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Program link error:", gl.getProgramInfoLog(program));
    return null;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  const uResolution = gl.getUniformLocation(program, "u_resolution");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uPhase = gl.getUniformLocation(program, "u_phase");
  const uHasDesktop = gl.getUniformLocation(program, "u_has_desktop");
  const uDesktop = gl.getUniformLocation(program, "u_desktop");
  if (uHasDesktop) gl.uniform1f(uHasDesktop, 0);
  if (uDesktop) gl.uniform1i(uDesktop, 0);

  let stopped = false;
  let texture: WebGLTexture | null = null;
  let hasDesktop = 0;
  let captureTimer: number | undefined;
  let captureBusy = false;
  let lastCapture = 0;

  if (isTauri()) {
    texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);

    const captureFrame = async () => {
      if (captureBusy || stopped || phaseRef.current !== "idle") return;
      const captureInterval = effectQualityRef.current === "cinematic" ? 300 : effectQualityRef.current === "eco" ? 900 : 520;
      if (performance.now() - lastCapture < captureInterval) return;
      lastCapture = performance.now();
      captureBusy = true;
      try {
        const desktop = await invoke<DesktopFrame>("capture_desktop_under_widget");
        if (stopped || desktop.width < 1 || desktop.height < 1) return;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.RGBA, desktop.width, desktop.height, 0, gl.RGBA,
          gl.UNSIGNED_BYTE, new Uint8Array(desktop.rgba),
        );
        hasDesktop = 1;
      } catch {
        // Linux/Wayland and protected desktops keep the procedural background.
      } finally {
        captureBusy = false;
      }
    };
    void captureFrame();
    captureTimer = window.setInterval(() => void captureFrame(), 240);
  }

  let rafId = 0;
  const started = performance.now();
  const render = (now: number) => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, (now - started) / 1000);
    gl.uniform1f(uPhase, phaseRef.current === "ready" ? 1 : 0);
    if (uHasDesktop) gl.uniform1f(uHasDesktop, hasDesktop);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    rafId = requestAnimationFrame(render);
  };
  rafId = requestAnimationFrame(render);
  return () => {
    stopped = true;
    cancelAnimationFrame(rafId);
    if (captureTimer !== undefined) window.clearInterval(captureTimer);
    gl.deleteProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    gl.deleteBuffer(buffer);
    if (texture) gl.deleteTexture(texture);
  };
}

function initFallbackRenderer(
  canvas: HTMLCanvasElement,
  phaseRef: React.MutableRefObject<DropPhase>,
  effectQualityRef: React.MutableRefObject<EffectQuality>,
): () => void {
  const webgl2Cleanup = initWebGL2Renderer(canvas, phaseRef, effectQualityRef);
  if (webgl2Cleanup) return webgl2Cleanup;

  const context = canvas.getContext("2d");
  if (!context) return () => {};

  let rafId = 0;
  let stopped = false;
  const started = performance.now();
  let desktopImageData: ImageData | null = null;
  let desktopCanvas: HTMLCanvasElement | null = null;
  let captureBusy = false;
  let lastCapture = 0;
  let captureTimer: number | undefined;

  if (isTauri()) {
    const captureFrame = async () => {
      if (captureBusy || stopped || phaseRef.current !== "idle") return;
      const captureInterval = effectQualityRef.current === "cinematic" ? 300 : effectQualityRef.current === "eco" ? 900 : 520;
      if (performance.now() - lastCapture < captureInterval) return;
      lastCapture = performance.now();
      captureBusy = true;
      try {
        const desktop = await invoke<DesktopFrame>("capture_desktop_under_widget");
        if (stopped || desktop.width < 1 || desktop.height < 1) return;
        if (!desktopCanvas) desktopCanvas = document.createElement("canvas");
        desktopCanvas.width = desktop.width;
        desktopCanvas.height = desktop.height;
        const ctx2d = desktopCanvas.getContext("2d");
        if (!ctx2d) return;
        desktopImageData = new ImageData(new Uint8ClampedArray(desktop.rgba), desktop.width, desktop.height);
        ctx2d.putImageData(desktopImageData, 0, 0);
      } catch {
        // Linux/Wayland and protected desktops keep the built-in starfield.
      } finally {
        captureBusy = false;
      }
    };
    void captureFrame();
    captureTimer = window.setInterval(() => void captureFrame(), 240);
  }

  const stars = Array.from({ length: 80 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: Math.random() * 0.9 + 0.3,
    tw: Math.random() * Math.PI * 2,
    sp: 0.4 + Math.random() * 1.6,
  }));

  const B_CRIT = 2.5980762;
  const LENS_DEPTH = 21;
  const Z0 = 14;

  const render = (now: number) => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const scale = height / 124;
    const cx = width * 0.5;
    const cy = height * 0.48;
    const t = (now - started) / 1000;
    const currentPhase = phaseRef.current;
    const rh = 0.205;
    const eventHorizon = rh * height;
    const W = B_CRIT / rh;
    const lensRadius = 7 * eventHorizon;

    context.clearRect(0, 0, width, height);

    if (desktopImageData && desktopCanvas) {
      context.drawImage(desktopCanvas, 0, 0, width, height);
      const x0 = Math.max(0, Math.floor(cx - lensRadius));
      const y0 = Math.max(0, Math.floor(cy - lensRadius));
      const w = Math.min(width, Math.ceil(cx + lensRadius)) - x0;
      const h = Math.min(height, Math.ceil(cy + lensRadius)) - y0;
      if (w > 1 && h > 1) {
        const imageData = context.getImageData(x0, y0, w, h);
        const source = desktopImageData;
        const sw = source.width;
        const sh = source.height;
        const sx = sw / width;
        const sy = sh / height;
        for (let py = 0; py < h; py++) {
          for (let px = 0; px < w; px++) {
            const gx = x0 + px;
            const gy = y0 + py;
            const dx = gx - cx;
            const dy = gy - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const idx = (py * w + px) * 4;
            if (dist < eventHorizon * 0.92) {
              imageData.data[idx] = 0;
              imageData.data[idx + 1] = 0;
              imageData.data[idx + 2] = 0;
              imageData.data[idx + 3] = 255;
              continue;
            }
            const un = dist / height;
            const win = Math.exp(-Math.pow(un / (7 * rh), 2));
            if (win < 0.005) continue;
            const yt = un * W;
            const uu = Z0 / Math.sqrt(Z0 * Z0 + yt * yt);
            const defl = (2 / (W * W)) / Math.max(un, 1e-4) * (1.29 * uu + 0.07) * Math.max(LENS_DEPTH - 2.14 * uu + 0.75, 0) * win * height;
            const dirx = dx / Math.max(dist, 1e-5);
            const diry = dy / Math.max(dist, 1e-5);
            const sxp = gx - dirx * defl;
            const syp = gy - diry * defl;
            const tx = Math.floor(sxp * sx);
            const ty = Math.floor(syp * sy);
            if (tx >= 0 && tx < sw && ty >= 0 && ty < sh) {
              const srcIdx = (ty * sw + tx) * 4;
              imageData.data[idx] = source.data[srcIdx];
              imageData.data[idx + 1] = source.data[srcIdx + 1];
              imageData.data[idx + 2] = source.data[srcIdx + 2];
              imageData.data[idx + 3] = 255;
            }
          }
        }
        context.putImageData(imageData, x0, y0);
      }
    } else {
      const bg = context.createRadialGradient(cx, cy, 0, cx, cy, 85 * scale);
      bg.addColorStop(0, "rgba(8,22,28,0.7)");
      bg.addColorStop(0.35, "rgba(5,14,20,0.35)");
      bg.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = bg;
      context.fillRect(0, 0, width, height);
      for (const star of stars) {
        const sxs = star.x * width;
        const sys = star.y * height;
        const tw = (0.5 + 0.5 * Math.sin(t * star.sp + star.tw)) * 0.5;
        context.fillStyle = `rgba(200,222,255,${tw})`;
        context.beginPath();
        context.arc(sxs, sys, star.r * scale, 0, Math.PI * 2);
        context.fill();
      }
    }

    context.save();
    context.translate(cx, cy);
    context.scale(1, 0.22);
    for (let ring = 0; ring < 14; ring += 1) {
      const radius = (27 + ring * 2.6) * scale;
      const rot = t * (0.25 + ring * 0.04) * (ring % 2 ? 1 : -1);
      const inner = ring < 5;
      const hue = inner ? 28 + ring * 6 : 175 - ring * 6;
      const sat = inner ? 90 : 65;
      const light = inner ? 62 - ring * 3 : 52;
      const alpha = Math.max(0.06, 0.55 - ring * 0.034);
      for (let seg = 0; seg < 48; seg += 1) {
        const a0 = (seg / 48) * Math.PI * 2;
        const a1 = ((seg + 1) / 48) * Math.PI * 2;
        const bright = 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(a0 - rot));
        context.strokeStyle = `hsla(${hue},${sat}%,${light}%,${alpha * bright})`;
        context.lineWidth = (1.4 + ring * 0.18) * scale;
        context.beginPath();
        context.arc(0, 0, radius + Math.sin(t * 0.7 + ring) * 0.6 * scale, a0, a1 + 0.01);
        context.stroke();
      }
    }
    context.restore();

    const innerGlow = context.createRadialGradient(cx, cy, 23 * scale, cx, cy, 28 * scale);
    innerGlow.addColorStop(0, "rgba(255,200,100,0)");
    innerGlow.addColorStop(0.45, "rgba(255,225,160,0.85)");
    innerGlow.addColorStop(1, "rgba(255,200,100,0)");
    context.fillStyle = innerGlow;
    context.beginPath();
    context.arc(cx, cy, 28 * scale, 0, Math.PI * 2);
    context.fill();

    if (desktopImageData) {
      const rim = context.createRadialGradient(cx, cy, 22 * scale, cx, cy, 26 * scale);
      rim.addColorStop(0, "rgba(0,0,0,0)");
      rim.addColorStop(0.85, currentPhase === "ready" ? "rgba(86,255,210,0.4)" : "rgba(36,110,103,0.15)");
      rim.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = rim;
      context.beginPath();
      context.arc(cx, cy, 26 * scale, 0, Math.PI * 2);
      context.fill();
    } else {
      const horizon = context.createRadialGradient(cx - 3 * scale, cy - 4 * scale, 0, cx, cy, 24 * scale);
      horizon.addColorStop(0, "#000000");
      horizon.addColorStop(0.78, "#000000");
      horizon.addColorStop(0.93, currentPhase === "ready" ? "rgba(86,255,210,0.55)" : "rgba(36,110,103,0.18)");
      horizon.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = horizon;
      context.beginPath();
      context.arc(cx, cy, 24 * scale, 0, Math.PI * 2);
      context.fill();
    }

    const glowColor = currentPhase === "ready" ? "86,255,210" : "46,130,120";
    const outerGlow = context.createRadialGradient(cx, cy, 24 * scale, cx, cy, 58 * scale);
    outerGlow.addColorStop(0, `rgba(${glowColor},0.16)`);
    outerGlow.addColorStop(0.5, `rgba(${glowColor},0.05)`);
    outerGlow.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = outerGlow;
    context.fillRect(0, 0, width, height);

    rafId = requestAnimationFrame(render);
  };

  rafId = requestAnimationFrame(render);
  return () => {
    stopped = true;
    cancelAnimationFrame(rafId);
    if (captureTimer !== undefined) window.clearInterval(captureTimer);
  };
}

export function BlackHoleCanvas({
  phase,
  weather,
  weatherIntensity = 1,
  recycledCount = 0,
  terrainMode = "gravity",
  terrainIntensity = 0.65,
  mouseGravityEnabled = true,
  effectQuality = "balanced",
}: BlackHoleCanvasProps) {
  const gpuCanvas = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);
  const weatherRef = useRef(weather);
  const weatherIntensityRef = useRef(weatherIntensity);
  const recycledCountRef = useRef(recycledCount);
  const terrainModeRef = useRef(terrainMode);
  const terrainIntensityRef = useRef(terrainIntensity);
  const mouseGravityRef = useRef(mouseGravityEnabled);
  const effectQualityRef = useRef(effectQuality);
  const pointerRef = useRef({ x: 0.5, y: 0.5, previousX: 0.5, previousY: 0.5, active: 0 });
  const trailRef = useRef(Array.from({ length: 16 }, () => ({ x: 0.5, y: 0.5, age: 1 })));
  const phaseStartedRef = useRef(performance.now());
  const [webGpuReady, setWebGpuReady] = useState(false);
  const [fallbackReady, setFallbackReady] = useState(false);
  const [webGpuNotSupported, setWebGpuNotSupported] = useState(false);

  useEffect(() => {
    phaseRef.current = phase;
    phaseStartedRef.current = performance.now();
  }, [phase]);

  useEffect(() => {
    weatherRef.current = weather;
  }, [weather]);

  useEffect(() => {
    weatherIntensityRef.current = weatherIntensity;
  }, [weatherIntensity]);

  useEffect(() => {
    recycledCountRef.current = recycledCount;
  }, [recycledCount]);

  useEffect(() => { terrainModeRef.current = terrainMode; }, [terrainMode]);
  useEffect(() => { terrainIntensityRef.current = terrainIntensity; }, [terrainIntensity]);
  useEffect(() => { mouseGravityRef.current = mouseGravityEnabled; }, [mouseGravityEnabled]);
  useEffect(() => { effectQualityRef.current = effectQuality; }, [effectQuality]);

  useEffect(() => {
    const updatePointer = (event: PointerEvent) => {
      const canvas = gpuCanvas.current;
      if (!canvas) return;
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
      const pointer = pointerRef.current;
      pointer.previousX = pointer.x;
      pointer.previousY = pointer.y;
      pointer.x = x;
      pointer.y = y;
      pointer.active = event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom ? 1 : 0;
      trailRef.current.unshift({ x, y, age: 0 });
      trailRef.current.length = 16;
    };
    const leavePointer = () => { pointerRef.current.active = 0; };
    window.addEventListener("pointermove", updatePointer, { passive: true });
    window.addEventListener("pointerleave", leavePointer);
    return () => {
      window.removeEventListener("pointermove", updatePointer);
      window.removeEventListener("pointerleave", leavePointer);
    };
  }, []);

  useEffect(() => {
    const canvas = gpuCanvas.current;
    const gpu = (navigator as Navigator & { gpu?: any }).gpu;
    if (!canvas || !gpu) return;
    let stopped = false;
    let frame = 0;
    let captureTimer: number | undefined;

    void (async () => {
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (stopped) return;
      if (!adapter) {
        setWebGpuNotSupported(true);
        return;
      }
      const device = await adapter.requestDevice();
      if (stopped) return;
      const context = canvas.getContext("webgpu") as any;
      if (!context) {
        setWebGpuNotSupported(true);
        return;
      }
      const format = gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "premultiplied" });

      const module = device.createShaderModule({ code: shaderCode });
      const compilation = await module.getCompilationInfo?.();
      if (compilation?.messages?.some((message: any) => message.type === "error")) {
        console.error("BlackHole WGSL compilation failed", compilation.messages);
        return;
      }
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      const uniforms = device.createBuffer({ size: 400, usage: 0x40 | 0x08 });
      const spaceTexture = device.createTexture({
        size: [256, 256, 1],
        format: "rgba8unorm",
        usage: 0x04 | 0x02 | 0x10,
      });
      const desktopTextureCanvas = makeSpaceTexture();
      device.queue.copyExternalImageToTexture(
        { source: desktopTextureCanvas },
        { texture: spaceTexture },
        [256, 256],
      );

      if (isTauri() && navigator.userAgent.includes("Windows")) {
        let captureBusy = false;
        let lastCapture = 0;
        const refreshDesktopTexture = async () => {
          if (captureBusy || stopped || phaseRef.current !== "idle") return;
          const captureInterval = effectQualityRef.current === "cinematic" ? 300 : effectQualityRef.current === "eco" ? 900 : 520;
          if (performance.now() - lastCapture < captureInterval) return;
          lastCapture = performance.now();
          captureBusy = true;
          try {
            const desktop = await invoke<DesktopFrame>("capture_desktop_under_widget");
            if (stopped || desktop.width < 1 || desktop.height < 1) return;
            const source = document.createElement("canvas");
            source.width = desktop.width;
            source.height = desktop.height;
            const sourceContext = source.getContext("2d");
            const targetContext = desktopTextureCanvas.getContext("2d");
            if (!sourceContext || !targetContext) return;
            sourceContext.putImageData(
              new ImageData(new Uint8ClampedArray(desktop.rgba), desktop.width, desktop.height),
              0,
              0,
            );
            targetContext.clearRect(0, 0, 256, 256);
            targetContext.drawImage(source, 0, 0, 256, 256);
            device.queue.copyExternalImageToTexture(
              { source: desktopTextureCanvas },
              { texture: spaceTexture },
              [256, 256],
            );
            document.title = "Codex Cosmos · 实时引力透镜";
          } catch {
            // Linux/Wayland and protected desktops keep the built-in starfield.
          } finally {
            captureBusy = false;
          }
        };
        void refreshDesktopTexture();
        captureTimer = window.setInterval(() => void refreshDesktopTexture(), 240);
      }
      const sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "mirror-repeat",
        addressModeV: "mirror-repeat",
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: spaceTexture.createView() },
          { binding: 2, resource: sampler },
        ],
      });
      const began = performance.now();
      let lastRendered = 0;
      setWebGpuReady(true);

      const render = (now: number) => {
        if (stopped) return;
        frame = requestAnimationFrame(render);
        const frameInterval = effectQualityRef.current === "cinematic" ? 17 : effectQualityRef.current === "eco" ? 55 : 32;
        if (now - lastRendered < frameInterval) return;
        lastRendered = now;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          context.configure({ device, format, alphaMode: "premultiplied" });
        }

        const elapsed = (now - began) / 1000;
        const currentPhase = phaseRef.current;
        const currentWeather = weatherRef.current;
        const weatherMix = Math.max(0, Math.min(1, weatherIntensityRef.current));
        const growth = Math.min(0.045, Math.log2(recycledCountRef.current + 1) * 0.0065);
        const rainy = currentWeather ? currentWeather.weatherCode >= 51 && currentWeather.weatherCode <= 82 : false;
        const snowy = currentWeather ? currentWeather.weatherCode >= 71 && currentWeather.weatherCode <= 77 : false;
        const stormy = currentWeather ? currentWeather.weatherCode >= 95 : false;
        const windFactor = Math.min(1, (currentWeather?.windSpeed ?? 0) / 45);
        const values = new Float32Array(100);
        values[0] = width;
        values[1] = height;
        values[2] = elapsed * (currentPhase === "processing" ? 1.65 : 0.72);
        values[3] = 1;
        values.set(GARGANTUA, 4);
        const weatherTemperature = snowy ? 6200 : rainy ? 5100 : currentWeather?.isDay === false ? 3900 : 4500;
        const weatherExposure = currentWeather?.isDay === false ? 1.42 : rainy ? 1.06 : 1.28;
        const weatherStars = currentWeather?.isDay === false ? 1.9 : rainy ? 0.55 : 1.35;
        values[4] = 4500 + (weatherTemperature - 4500) * weatherMix;
        values[6] = 0.1 + windFactor * 0.16 * weatherMix;
        values[13] = 0.5 + windFactor * 2.5 * weatherMix;
        values[15] = 1.28 + (weatherExposure - 1.28) * weatherMix;
        values[17] = 1.35 + (weatherStars - 1.35) * weatherMix;
        values[12] = currentPhase === "ready" ? 1.85 : currentPhase === "success" ? 2.1 : 1.4;
        values[18] = (currentPhase === "ready" ? 0.205 : 0.182) + growth;
        values[19] = 0.5;
        values[20] = 0.48;
        values[21] = Math.min(0.9, 0.48 + growth * 5 + (stormy ? 0.16 * weatherMix : 0));
        values[22] = elapsed * 0.12;
        const pointer = pointerRef.current;
        const pointerStrength = mouseGravityRef.current ? pointer.active : 0;
        const pull = pointerStrength * 0.045 * terrainIntensityRef.current;
        values[19] = 0.5 + (pointer.x - 0.5) * pull;
        values[20] = 0.48 + (pointer.y - 0.48) * pull;
        values[24] = pointer.x;
        values[25] = pointer.y;
        values[26] = pointerStrength;
        values[27] = 0;
        values[28] = pointer.x - pointer.previousX;
        values[29] = pointer.y - pointer.previousY;
        values[30] = pointerStrength;
        values[31] = terrainIntensityRef.current;
        values[35] = terrainModeValue[terrainModeRef.current];
        trailRef.current.forEach((sample, index) => {
          sample.age = Math.min(1, sample.age + frameInterval / 1000);
          const offset = 36 + index * 4;
          values[offset] = sample.x;
          values[offset + 1] = sample.y;
          values[offset + 2] = sample.age;
          values[offset + 3] = pointerStrength;
        });
        pointer.previousX += (pointer.x - pointer.previousX) * 0.72;
        pointer.previousY += (pointer.y - pointer.previousY) * 0.72;
        if (currentPhase === "success") {
          values[32] = Math.min(1, (now - phaseStartedRef.current) / 2100);
          values[33] = 1.15;
          values[34] = 1;
        }
        device.queue.writeBuffer(uniforms, 0, values);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0.008, b: 0.012, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
      };
      frame = requestAnimationFrame(render);
      void device.lost.then(() => {
        if (!stopped) setWebGpuReady(false);
      });
    })().catch((error) => {
      console.error("BlackHole WebGPU initialization failed", error);
      if (!stopped) {
        setWebGpuReady(false);
        setWebGpuNotSupported(true);
      }
    });

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      if (captureTimer !== undefined) window.clearInterval(captureTimer);
      setWebGpuReady(false);
    };
  }, []);

  useEffect(() => {
    const gpu = (navigator as Navigator & { gpu?: any }).gpu;
    if (!!gpu && !webGpuNotSupported) return;
    const canvas = gpuCanvas.current;
    if (canvas) {
      setFallbackReady(true);
      return initFallbackRenderer(canvas, phaseRef, effectQualityRef);
    }
  }, [webGpuNotSupported]);

  return (
    <span className={`black-hole-renderer${webGpuReady || fallbackReady ? " is-ready" : ""}`} aria-hidden="true">
      <canvas ref={gpuCanvas} className="black-hole-canvas" />
    </span>
  );
}
