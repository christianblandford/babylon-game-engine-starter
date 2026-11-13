import { Engine } from "@babylonjs/core/Engines/engine";
import type { AbstractEngine } from "@babylonjs/core";

/**
 * Creates the rendering engine: WebGPU where the browser has it, WebGL2
 * otherwise. `?engine=webgl` in the URL forces WebGL2 (to compare, or to work
 * around a WebGPU driver problem); `?engine=webgpu` is accepted too.
 *
 * WebGPU is the default because it is about twice as fast here: the test
 * town's median frame is 12 ms on WebGPU and 26 ms on WebGL2 on the same
 * machine. A WebGL2 draw call costs far more by the time the browser has
 * translated it for the system's own graphics API, and a scene like the town
 * is hundreds of them.
 */
export async function createEngine(canvas: HTMLCanvasElement): Promise<AbstractEngine> {
  const asked = new URLSearchParams(location.search).get("engine");
  const wantsWebGPU = asked !== "webgl" && asked !== "webgl2" && "gpu" in navigator;

  if (wantsWebGPU) {
    // Loaded on demand so WebGL-only builds don't pay for the WebGPU backend.
    // WebGPU registers its engine capabilities (render targets, cube textures,
    // multi-target rendering...) as separate modules; take the whole set.
    const [{ WebGPUEngine }] = await Promise.all([
      import("@babylonjs/core/Engines/webgpuEngine"),
      import("@babylonjs/core/Engines/WebGPU/Extensions/index"),
    ]);
    if (await WebGPUEngine.IsSupportedAsync) {
      const engine = new WebGPUEngine(canvas, {
        antialias: false,
        stencil: true,
        powerPreference: "high-performance",
        // Ask for what the GPU can actually do, not WebGPU's conservative
        // defaults. The lit material with four shadow cascades plus motion
        // vectors passes 17 values between shader stages; the default cap is 16.
        setMaximumLimits: true,
        // Likewise for optional GPU features. Without this the engine has no
        // compressed-texture support, and every KTX2 texture is unpacked to
        // full-size RGBA: four to eight times the video memory.
        enableAllFeatures: true,
      });
      await engine.initAsync();
      return engine;
    }
    console.warn("WebGPU is not available in this browser; using WebGL2.");
  }

  // Anti-aliasing is done by the post-processing pipeline (MSAA + FXAA), so the
  // canvas itself doesn't need it.
  return new Engine(canvas, false, {
    stencil: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });
}

/** Renders at the device's pixel density, capped so high-DPI screens don't melt the GPU. */
export function applyPixelRatio(engine: AbstractEngine, maxPixelRatio: number): void {
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, maxPixelRatio));
}
