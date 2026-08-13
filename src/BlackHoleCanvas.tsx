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

function animateFallback(canvas: HTMLCanvasElement, phaseRef: React.MutableRefObject<DropPhase>) {
  const context = canvas.getContext("2d");
  if (!context) return () => undefined;
  let frame = 0;
  const started = performance.now();

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
    context.clearRect(0, 0, width, height);

    const voidGlow = context.createRadialGradient(cx, cy, 4 * scale, cx, cy, 57 * scale);
    voidGlow.addColorStop(0, "rgba(0,0,0,1)");
    voidGlow.addColorStop(0.31, "rgba(0,0,0,1)");
    voidGlow.addColorStop(0.38, "rgba(92,255,214,.42)");
    voidGlow.addColorStop(0.48, "rgba(16,111,100,.13)");
    voidGlow.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = voidGlow;
    context.fillRect(0, 0, width, height);

    context.save();
    context.translate(cx, cy);
    context.rotate(-0.1 + Math.sin(t * 0.22) * 0.018);
    context.scale(1, 0.25);
    for (let ring = 0; ring < 6; ring += 1) {
      context.beginPath();
      context.strokeStyle = ring % 2
        ? `rgba(70,255,202,${0.16 + ring * 0.04})`
        : `rgba(255,174,94,${0.12 + ring * 0.035})`;
      context.lineWidth = (1.1 + ring * 0.34) * scale;
      context.arc(0, 0, (34 + ring * 3.4 + Math.sin(t * 0.7 + ring) * 0.8) * scale, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();

    const horizon = context.createRadialGradient(cx - 4 * scale, cy - 5 * scale, 0, cx, cy, 25 * scale);
    horizon.addColorStop(0, "#020709");
    horizon.addColorStop(0.72, "#000102");
    horizon.addColorStop(0.9, "#000");
    horizon.addColorStop(1, phaseRef.current === "ready" ? "rgba(86,255,210,.8)" : "rgba(36,110,103,.32)");
    context.fillStyle = horizon;
    context.beginPath();
    context.arc(cx, cy, 25 * scale, 0, Math.PI * 2);
    context.fill();
    frame = requestAnimationFrame(render);
  };
  frame = requestAnimationFrame(render);
  return () => cancelAnimationFrame(frame);
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
      if (!adapter || stopped) return;
      const device = await adapter.requestDevice();
      if (stopped) return;
      const context = canvas.getContext("webgpu") as any;
      if (!context) return;
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
      if (!stopped) setWebGpuReady(false);
    });

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      if (captureTimer !== undefined) window.clearInterval(captureTimer);
      setWebGpuReady(false);
    };
  }, []);

  return (
    <span className={`black-hole-renderer${webGpuReady ? " is-ready" : ""}`} aria-hidden="true">
      <canvas ref={gpuCanvas} className="black-hole-canvas" />
    </span>
  );
}
