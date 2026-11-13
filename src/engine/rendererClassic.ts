import { Constants } from "@babylonjs/core/Engines/constants";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline";
import type { Camera, Scene } from "@babylonjs/core";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import type { QualitySettings } from "../config";
import type { SceneLighting } from "./lighting";
import { BLOOM, type RenderControls, type Renderer } from "./renderer";
import { cullShadowCascades } from "./shadowCulling";

/**
 * The classic renderer: cascaded shadow maps on the sun, plus Babylon's
 * ready-made pipelines attached to the camera. The scene renders into a
 * floating-point buffer (so bright things can be brighter than white), then:
 * ambient occlusion → bloom → ACES tone mapping → colour grading → FXAA.
 */
export function createClassicRenderer(
  scene: Scene,
  camera: Camera,
  quality: QualitySettings,
  lighting: SceneLighting,
): Renderer {
  // --- Shadows ---------------------------------------------------------------
  const shadows = new CascadedShadowGenerator(quality.shadowMapSize, lighting.sun, undefined, camera);
  cullShadowCascades(shadows);
  shadows.numCascades = quality.shadowCascades;
  shadows.shadowMaxZ = quality.shadowDistance;
  shadows.lambda = 0.85; // split distribution: 1 = more resolution near the camera
  shadows.cascadeBlendPercentage = 0.08;
  shadows.stabilizeCascades = true; // stops shadow edges shimmering as the camera moves
  shadows.depthClamp = true;
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = quality.level === "low" ? ShadowGenerator.QUALITY_LOW : ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = 0.003;
  shadows.normalBias = 0.02;

  // --- Post-processing -------------------------------------------------------
  // Created first so occlusion is applied to the HDR image before bloom/tone mapping.
  let ssao: SSAO2RenderingPipeline | null = null;
  if (quality.ssao && SSAO2RenderingPipeline.IsSupported) {
    // Half-float output: the default 8-bit buffer would clip everything
    // brighter than white before bloom and tone mapping ever saw it.
    ssao = new SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [camera], false, Constants.TEXTURETYPE_HALF_FLOAT);
    ssao.samples = quality.ssaoSamples;
    // Leave SSAO's own buffers single-sampled: multisampling them roughly
    // halves the frame rate for no visible gain (the blur hides the edges).
    ssao.textureSamples = 1;
    ssao.bilateralSamples = 8;
    ssao.radius = 1.4;
    ssao.totalStrength = 1.1;
    ssao.base = 0.05;
    ssao.maxZ = 120;
    ssao.minZAspect = 0.4;
    ssao.expensiveBlur = true;
  }

  const pipeline = new DefaultRenderingPipeline("default", true, scene, [camera]);
  pipeline.samples = quality.msaaSamples;
  pipeline.fxaaEnabled = quality.fxaa;

  pipeline.bloomEnabled = quality.bloom;
  pipeline.bloomThreshold = BLOOM.threshold;
  pipeline.bloomWeight = BLOOM.strength;
  pipeline.bloomKernel = BLOOM.kernel;
  pipeline.bloomScale = 0.5;

  pipeline.imageProcessingEnabled = true;
  const grade = pipeline.imageProcessing;
  grade.toneMappingEnabled = true;
  grade.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  grade.exposure = 1.25;
  grade.contrast = 1.08;
  grade.vignetteEnabled = true;
  grade.vignetteWeight = 1.1;
  grade.vignetteStretch = 0.4;

  const controls: RenderControls = {
    get exposure() { return grade.exposure; },
    set exposure(v) { grade.exposure = v; },
    get contrast() { return grade.contrast; },
    set contrast(v) { grade.contrast = v; },
    get toneMapping() { return grade.toneMappingEnabled; },
    set toneMapping(v) { grade.toneMappingEnabled = v; },
    get vignette() { return grade.vignetteEnabled; },
    set vignette(v) { grade.vignetteEnabled = v; },
    get bloom() { return pipeline.bloomEnabled; },
    set bloom(v) { pipeline.bloomEnabled = v; },
    get bloomStrength() { return pipeline.bloomWeight; },
    set bloomStrength(v) { pipeline.bloomWeight = v; },
    get bloomThreshold() { return pipeline.bloomThreshold; },
    set bloomThreshold(v) { pipeline.bloomThreshold = v; },
    get fxaa() { return pipeline.fxaaEnabled; },
    set fxaa(v) { pipeline.fxaaEnabled = v; },
    get shadowDistance() { return shadows.shadowMaxZ; },
    set shadowDistance(v) { shadows.shadowMaxZ = v; },
    get showShadowCascades() { return shadows.debug; },
    set showShadowCascades(v) { shadows.debug = v; },
    get sharpen() { return pipeline.sharpenEnabled; },
    set sharpen(v) { pipeline.sharpenEnabled = !!v; },
    get depthOfField() { return pipeline.depthOfFieldEnabled; },
    set depthOfField(v) { pipeline.depthOfFieldEnabled = !!v; },
    get chromaticAberration() { return pipeline.chromaticAberrationEnabled; },
    set chromaticAberration(v) { pipeline.chromaticAberrationEnabled = !!v; },
    get grain() { return pipeline.grainEnabled; },
    set grain(v) { pipeline.grainEnabled = !!v; },
  };
  if (ssao) {
    const ao = ssao;
    Object.defineProperties(controls, {
      ssaoStrength: { get: () => ao.totalStrength, set: (v: number) => (ao.totalStrength = v), enumerable: true },
      ssaoRadius: { get: () => ao.radius, set: (v: number) => (ao.radius = v), enumerable: true },
    });
  }

  return {
    kind: "classic",
    controls,
    addShadowCaster(mesh, includeDescendants = true) {
      shadows.addShadowCaster(mesh, includeDescendants);
    },
    createGui(name) {
      const gui = AdvancedDynamicTexture.CreateFullscreenUI(name, true, scene, undefined, true);
      if (gui.layer) gui.layer.applyPostProcess = false;
      return gui;
    },
    dispose() {
      pipeline.dispose();
      ssao?.dispose();
      shadows.dispose();
    },
  };
}
