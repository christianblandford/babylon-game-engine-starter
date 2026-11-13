import type { AbstractMesh, Camera, Scene } from "@babylonjs/core";
import type { AdvancedDynamicTexture } from "@babylonjs/gui";
import type { QualitySettings } from "../config";
import type { SceneLighting } from "./lighting";

/**
 * How the frame is put together.
 *
 * - `frameGraph`: Babylon's Frame Graph. The whole frame (shadows, the scene,
 *   ambient occlusion, bloom, tone mapping, UI) is described as one explicit
 *   list of steps in `rendererFrameGraph.ts`. This is where new rendering
 *   features go (temporal anti-aliasing, volumetric light, custom passes).
 * - `classic`: Babylon's older arrangement, where post-processes are attached
 *   to the camera as ready-made pipelines. Kept as a fallback and for
 *   comparison.
 *
 * Pick one with `?renderer=classic` or `?renderer=framegraph` in the URL.
 */
export type RendererKind = "classic" | "frameGraph";

/**
 * The knobs both renderers share, so tools (the debug panel, a settings menu)
 * don't care which one is running. Entries that are `undefined` aren't
 * available in the current renderer or quality preset.
 */
export interface RenderControls {
  exposure: number;
  contrast: number;
  toneMapping: boolean;
  vignette: boolean;
  bloom: boolean;
  bloomStrength: number;
  bloomThreshold: number;
  fxaa: boolean;
  /** Temporal anti-aliasing (Frame Graph renderer, presets with SSAO). */
  taa?: boolean;
  /** How far from the camera shadows are drawn, in metres. */
  shadowDistance: number;
  /** Tints each shadow cascade a different colour, to see where they fall. */
  showShadowCascades: boolean;
  ssaoStrength?: number;
  ssaoRadius?: number;
  sharpen?: boolean;
  depthOfField?: boolean;
  chromaticAberration?: boolean;
  grain?: boolean;
}

export interface Renderer {
  readonly kind: RendererKind;
  readonly controls: RenderControls;
  /** Makes a mesh (and by default its children) cast shadows. */
  addShadowCaster(mesh: AbstractMesh, includeDescendants?: boolean): void;
  /**
   * Creates a full-screen Babylon GUI surface that is drawn after
   * post-processing, so text stays crisp and isn't tone-mapped or bloomed.
   */
  createGui(name: string): AdvancedDynamicTexture;
  dispose(): void;
}

/**
 * Bloom settings shared by both renderers. `threshold` is how bright a pixel
 * must be before it glows, on Babylon's gamma-style scale: 1.7 lands just above
 * sunlit white in this scene's lighting, so only fire, sparks, emissive
 * surfaces and the sun bloom.
 */
export const BLOOM = { strength: 0.22, kernel: 96, threshold: 1.7 } as const;

/** Which renderer to use: the URL wins, otherwise Frame Graph. */
export function chooseRenderer(): RendererKind {
  const requested = new URLSearchParams(location.search).get("renderer")?.toLowerCase();
  return requested === "classic" ? "classic" : "frameGraph";
}

export async function createRenderer(
  kind: RendererKind,
  scene: Scene,
  camera: Camera,
  quality: QualitySettings,
  lighting: SceneLighting,
): Promise<Renderer> {
  // Loaded on demand, so a build only ships the renderer it uses.
  const renderer =
    kind === "classic"
      ? (await import("./rendererClassic")).createClassicRenderer(scene, camera, quality, lighting)
      : await (await import("./rendererFrameGraph")).createFrameGraphRenderer(scene, camera, quality, lighting);
  lighting.castShadowsThrough(renderer);
  return renderer;
}
