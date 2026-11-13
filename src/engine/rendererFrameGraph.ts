// Engine capabilities the graph relies on (drawing to several targets at once).
import "@babylonjs/core/Engines/Extensions/engine.multiRender";
import { Constants } from "@babylonjs/core/Engines/constants";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask";
import { FrameGraphExecuteTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/executeTask";
import { FrameGraphBloomTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/bloomTask";
import { FrameGraphFXAATask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/fxaaTask";
import { FrameGraphImageProcessingTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/imageProcessingTask";
import { FrameGraphSharpenTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/sharpenTask";
import { FrameGraphSSAO2RenderingPipelineTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/ssao2RenderingPipelineTask";
import { FrameGraphTAATask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/taaTask";
import { FrameGraphCascadedShadowGeneratorTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/csmShadowGeneratorTask";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { backbufferColorTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh, Camera, FrameGraphObjectList, FrameGraphTextureHandle, Scene } from "@babylonjs/core";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import { FrameGraphGUITask } from "@babylonjs/gui/2D/FrameGraph/guiTask";
import type { QualitySettings } from "../config";
import type { SceneLighting } from "./lighting";
import { BLOOM, type RenderControls, type Renderer } from "./renderer";
import { cullShadowCascades } from "./shadowCulling";

/** Ambient occlusion is only computed this close to the camera, in metres. */
const SSAO_DISTANCE = 120;
/**
 * Every pass that draws lit surfaces must ask for this. Effect lights
 * (engine/effects.ts) live in a light cluster, and a cluster sorts its lights
 * into screen tiles and depth slices once per pass, for that pass's camera.
 * The classic pipeline does that for every camera; a Frame Graph pass only
 * does it when told to. Left off, the cluster's tables stay empty and its
 * lights are applied to the wrong parts of the screen: blown-out patches on
 * the ground near the camera whenever a fire is somewhere behind it.
 */
const LIT = { enableClusteredLights: true };

/**
 * The Frame Graph renderer. Every frame runs this list of steps, in order:
 *
 *   1. clear        a floating-point (HDR) colour buffer + depth
 *   2. shadows      cascaded shadow maps for the sun
 *   3. cull         work out which meshes are in view, once for every pass
 *   4. scene        everything in view, lit and shadowed. With SSAO in the
 *                   quality preset this is three steps: solid surfaces (which
 *                   also record depth and surface direction), ambient
 *                   occlusion from those, then transparent things and particles;
 *                   and, where the preset asks for it, temporal anti-aliasing
 *   5. bloom        glow around anything brighter than sunlit white
 *   6. grade        ACES tone mapping, exposure, contrast, vignette
 *   7. fxaa         edge smoothing (or a light sharpen after temporal AA)
 *   8. present      copy to the screen
 *   9. gui          HUD, drawn last so it is never tone-mapped or blurred
 *
 * Each step is a "task" whose inputs are the outputs of earlier ones, so the
 * order of the code below *is* the pipeline: to add an effect, create its task
 * and splice it into the chain of `colour` handles.
 */
export async function createFrameGraphRenderer(
  scene: Scene,
  camera: Camera,
  quality: QualitySettings,
  lighting: SceneLighting,
): Promise<Renderer> {
  const engine = scene.getEngine();
  const frameGraph = new FrameGraph(scene);
  scene.frameGraph = frameGraph;
  // With a frame graph the scene has no single "active camera"; each task is
  // given one. Anything that still asks the scene (GUI labels, picking) gets this.
  scene.cameraToUseForPointers = camera;

  const screenSized = (name: string, type: number, format: number, samples: number, percent = 100): FrameGraphTextureHandle =>
    frameGraph.textureManager.createRenderTargetTexture(name, {
      size: { width: percent, height: percent },
      sizeIsPercentage: true,
      options: { createMipMaps: false, samples, types: [type], formats: [format], useSRGBBuffers: [false], labels: [name] },
    });

  // Ambient occlusion needs each pixel's depth and surface direction. The
  // opaque pass writes those alongside the colour, into buffers that are not
  // multisampled, so with SSAO on, edges are smoothed afterwards: by temporal
  // anti-aliasing where the preset has it, otherwise by FXAA.
  const samples = quality.ssao ? 1 : quality.msaaSamples;

  // --- 1. Clear ----------------------------------------------------------------
  const clear = new FrameGraphClearTextureTask("clear", frameGraph);
  clear.color = new Color4(0, 0, 0, 1);
  clear.clearColor = true;
  clear.clearDepth = true;
  clear.targetTexture = screenSized("sceneColour", Constants.TEXTURETYPE_HALF_FLOAT, Constants.TEXTUREFORMAT_RGBA, samples);
  clear.depthTexture = screenSized("sceneDepth", Constants.TEXTURETYPE_FLOAT, Constants.TEXTUREFORMAT_DEPTH32_FLOAT, samples);
  frameGraph.addTask(clear);

  // --- 2. Shadows --------------------------------------------------------------
  const casters: AbstractMesh[] = [];
  const shadows = new FrameGraphCascadedShadowGeneratorTask("shadows", frameGraph);
  shadows.light = lighting.sun;
  shadows.camera = camera;
  shadows.objectList = { meshes: casters, particleSystems: [] };
  shadows.mapSize = quality.shadowMapSize;
  shadows.numCascades = quality.shadowCascades;
  shadows.shadowMaxZ = quality.shadowDistance;
  shadows.lambda = 0.85; // split distribution: 1 = more resolution near the camera
  shadows.cascadeBlendPercentage = 0.08;
  shadows.stabilizeCascades = true; // stops shadow edges shimmering as the camera moves
  shadows.depthClamp = true;
  shadows.filter = ShadowGenerator.FILTER_PCF;
  shadows.filteringQuality = quality.level === "low" ? ShadowGenerator.QUALITY_LOW : ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = 0.003;
  shadows.normalBias = 0.02;
  frameGraph.addTask(shadows);

  cullShadowCascades(shadows.shadowGenerator as CascadedShadowGenerator);

  // --- 3. What's in view -------------------------------------------------------
  // These are the scene's own live lists, so meshes and effects that come and
  // go (streamed map chunks, particles) are picked up without rebuilding. The
  // cull step drops everything outside the camera's view once, for all passes.
  const cull = new FrameGraphCullObjectsTask("cull", frameGraph, scene);
  cull.objectList = { meshes: scene.meshes, particleSystems: scene.particleSystems };
  cull.camera = camera;
  frameGraph.addTask(cull);

  /** Settings every pass that draws the scene shares. */
  const drawsScene = <T extends FrameGraphObjectRendererTask>(task: T, objects: FrameGraphObjectList = cull.outputObjectList): T => {
    task.objectList = objects;
    task.camera = camera;
    task.shadowGenerators = [shadows];
    task.forceLayerMaskCheck = true; // keeps the lighting probe's helper meshes out of view
    task.disableImageProcessing = true; // stay in linear HDR; the grade step does the rest
    return task;
  };

  let colour: FrameGraphTextureHandle;
  let ssao: FrameGraphSSAO2RenderingPipelineTask | null = null;
  let taa: FrameGraphTAATask | null = null;

  if (!quality.ssao) {
    // --- 4. The scene, in one pass ---------------------------------------------
    const main = drawsScene(new FrameGraphObjectRendererTask("scene", frameGraph, scene, LIT));
    main.targetTexture = clear.outputTexture;
    main.depthTexture = clear.outputDepthTexture;
    main.isMainObjectRenderer = true;
    frameGraph.addTask(main);
    colour = main.outputTexture;
  } else {
    // The solid and see-through passes each get only the meshes they draw.
    // Handing a pass an instanced mesh it then skips trips a Babylon quirk: the
    // instance is marked as handled without being drawn, the mark is never
    // cleared, and every copy of that mesh disappears from then on.
    const solid: FrameGraphObjectList = { meshes: [], particleSystems: [] };
    const seeThrough: FrameGraphObjectList = { meshes: [], particleSystems: scene.particleSystems };
    const sort = new FrameGraphExecuteTask("sort", frameGraph);
    sort.func = () => {
      const solidMeshes: AbstractMesh[] = (solid.meshes = []);
      const seeThroughMeshes: AbstractMesh[] = (seeThrough.meshes = []);
      for (const mesh of cull.outputObjectList.meshes ?? []) {
        (mesh.material?.needAlphaBlendingForMesh(mesh) ? seeThroughMeshes : solidMeshes).push(mesh);
      }
    };
    frameGraph.addTask(sort);

    // --- 4a. Solid surfaces, also recording depth and surface direction --------
    const opaque = drawsScene(new FrameGraphGeometryRendererTask("opaque", frameGraph, scene, LIT), solid);
    opaque.targetTexture = clear.outputTexture;
    opaque.depthTexture = clear.outputDepthTexture;
    opaque.isMainObjectRenderer = true;
    opaque.renderParticles = false;
    opaque.samples = samples;
    opaque.textureDescriptions = [
      { type: Constants.PREPASS_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_R },
      { type: Constants.PREPASS_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
    ];
    if (quality.taa) {
      // How far each pixel moved since the last frame, for temporal anti-aliasing.
      opaque.textureDescriptions.push({
        type: Constants.PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE,
        textureType: Constants.TEXTURETYPE_HALF_FLOAT,
        textureFormat: Constants.TEXTUREFORMAT_RGBA,
      });
    }
    frameGraph.addTask(opaque);

    // --- 4b. Ambient occlusion: darken creases and contact points --------------
    // Both the occlusion and its blur at half size. The blur is the costly
    // half (two passes of many taps); at full size, with Babylon's default of
    // 16 taps each way, the whole effect took 4 ms of a 27 ms frame. Like
    // this it takes under 2, and the two cannot be told apart in a
    // screenshot: temporal anti-aliasing averages away what noise is left.
    ssao = new FrameGraphSSAO2RenderingPipelineTask("ssao", frameGraph, 0.5, 0.5, Constants.TEXTURETYPE_HALF_FLOAT);
    ssao.sourceTexture = opaque.outputTexture;
    ssao.depthTexture = opaque.geometryViewDepthTexture;
    ssao.normalTexture = opaque.geometryViewNormalTexture;
    ssao.camera = camera;
    ssao.ssao.samples = quality.ssaoSamples;
    ssao.ssao.bilateralSamples = 8;
    ssao.ssao.radius = 1.4;
    ssao.ssao.totalStrength = 1.1;
    ssao.ssao.base = 0.05;
    ssao.ssao.maxZ = SSAO_DISTANCE;
    ssao.ssao.minZAspect = 0.4;
    frameGraph.addTask(ssao);

    // --- 4c. Glass, water, particles: drawn after, so occlusion never dims them -
    const transparent = drawsScene(new FrameGraphObjectRendererTask("transparent", frameGraph, scene, LIT), seeThrough);
    transparent.targetTexture = ssao.outputTexture;
    transparent.depthTexture = opaque.outputDepthTexture;
    frameGraph.addTask(transparent);
    colour = transparent.outputTexture;

    // --- 4d. Temporal anti-aliasing ----------------------------------------------
    // Each frame is drawn shifted by a fraction of a pixel and blended with the
    // previous ones, which resolves edges far better than a single frame can.
    // The motion texture lets it follow moving pixels instead of smearing them,
    // and clamping to the neighbourhood rejects history that no longer matches.
    if (quality.taa) {
      taa = new FrameGraphTAATask("taa", frameGraph);
      taa.sourceTexture = colour;
      taa.objectRendererTask = opaque;
      taa.velocityTexture = opaque.geometryLinearVelocityTexture;
      taa.postProcess.reprojectHistory = true;
      taa.postProcess.clampHistory = true;
      taa.postProcess.disableOnCameraMove = false;
      taa.postProcess.samples = 8;
      taa.postProcess.factor = 0.1;
      frameGraph.addTask(taa);
      colour = taa.outputTexture;
    }
  }

  // --- 5. Bloom ----------------------------------------------------------------
  // The threshold is in scene brightness, where sunlit white is about 3: only
  // things brighter than that glow (fire, sparks, emissive surfaces, the sun).
  const bloom = new FrameGraphBloomTask("bloom", frameGraph, BLOOM.strength, BLOOM.kernel, BLOOM.threshold, true, 0.5);
  bloom.sourceTexture = colour;
  bloom.disabled = !quality.bloom;
  frameGraph.addTask(bloom);
  colour = bloom.outputTexture;

  // --- 6. Tone mapping and colour grading --------------------------------------
  const grade = new FrameGraphImageProcessingTask("grade", frameGraph);
  grade.sourceTexture = colour;
  grade.postProcess.fromLinearSpace = true;
  grade.postProcess.toneMappingEnabled = true;
  grade.postProcess.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  grade.postProcess.exposure = 1.25;
  grade.postProcess.contrast = 1.08;
  grade.postProcess.vignetteEnabled = true;
  grade.postProcess.vignetteWeight = 1.1;
  grade.postProcess.vignetteStretch = 0.4;
  frameGraph.addTask(grade);
  colour = grade.outputTexture;

  // --- 7. Anti-aliasing ----------------------------------------------------------
  // FXAA smooths edges within a single frame. Where temporal anti-aliasing is
  // running it has already done the job (better), so FXAA steps aside and a
  // light sharpen restores the crispness temporal blending takes away.
  const fxaa = new FrameGraphFXAATask("fxaa", frameGraph);
  fxaa.sourceTexture = colour;
  fxaa.disabled = !quality.fxaa || taa !== null;
  frameGraph.addTask(fxaa);
  colour = fxaa.outputTexture;

  let sharpen: FrameGraphSharpenTask | null = null;
  if (taa) {
    sharpen = new FrameGraphSharpenTask("sharpen", frameGraph);
    sharpen.sourceTexture = colour;
    sharpen.postProcess.edgeAmount = 0.2;
    sharpen.postProcess.colorAmount = 1;
    frameGraph.addTask(sharpen);
    colour = sharpen.outputTexture;
  }

  // --- 8. Present ------------------------------------------------------------------
  const present = new FrameGraphCopyToBackbufferColorTask("present", frameGraph);
  present.sourceTexture = colour;
  frameGraph.addTask(present);

  // The graph's buffers are sized from the screen, so rebuild them when it changes.
  let disposed = false;
  let rebuilding: Promise<void> = frameGraph.buildAsync();
  const rebuild = (): void => {
    // Not waiting for readiness here: everything is already compiled, and
    // waiting would freeze the picture for a second on every resize.
    rebuilding = rebuilding.then(() => (disposed ? undefined : frameGraph.buildAsync(false))).catch(console.error);
  };
  // Dragging a window edge fires a stream of resizes; rebuild once it settles.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const resizeObserver = engine.onResizeObservable.add(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rebuild, 150);
  });
  await rebuilding;

  const controls: RenderControls = {
    get exposure() { return grade.postProcess.exposure; },
    set exposure(v) { grade.postProcess.exposure = v; },
    get contrast() { return grade.postProcess.contrast; },
    set contrast(v) { grade.postProcess.contrast = v; },
    get toneMapping() { return grade.postProcess.toneMappingEnabled; },
    set toneMapping(v) { grade.postProcess.toneMappingEnabled = v; },
    get vignette() { return grade.postProcess.vignetteEnabled; },
    set vignette(v) { grade.postProcess.vignetteEnabled = v; },
    get bloom() { return !bloom.disabled; },
    set bloom(v) { bloom.disabled = !v; },
    get bloomStrength() { return bloom.bloom.weight; },
    set bloomStrength(v) { bloom.bloom.weight = v; },
    get bloomThreshold() { return bloom.bloom.threshold; },
    set bloomThreshold(v) { bloom.bloom.threshold = v; },
    get fxaa() { return !fxaa.disabled; },
    set fxaa(v) { fxaa.disabled = !v; },
    get shadowDistance() { return shadows.shadowMaxZ; },
    set shadowDistance(v) { shadows.shadowMaxZ = v; },
    get showShadowCascades() { return shadows.debug; },
    set showShadowCascades(v) { shadows.debug = v; },
  };
  if (taa) {
    const temporal = taa;
    const crisp = sharpen;
    Object.defineProperty(controls, "taa", {
      get: () => !temporal.disabled,
      set: (on: boolean) => {
        temporal.disabled = !on;
        if (crisp) crisp.disabled = !on;
      },
      enumerable: true,
    });
  }
  if (ssao) {
    const ao = ssao.ssao;
    Object.defineProperties(controls, {
      ssaoStrength: { get: () => ao.totalStrength, set: (v: number) => (ao.totalStrength = v), enumerable: true },
      ssaoRadius: { get: () => ao.radius, set: (v: number) => (ao.radius = v), enumerable: true },
    });
  }

  return {
    kind: "frameGraph",
    controls,
    addShadowCaster(mesh, includeDescendants = true) {
      for (const caster of includeDescendants ? [mesh, ...mesh.getChildMeshes()] : [mesh]) {
        if (casters.includes(caster)) continue;
        casters.push(caster);
        // The list is ours, so we have to drop meshes that are removed (an
        // unloaded map chunk, a disposed character) ourselves.
        caster.onDisposeObservable.addOnce(() => {
          const index = casters.indexOf(caster);
          if (index >= 0) casters.splice(index, 1);
        });
      }
    },
    createGui(name) {
      // --- 9. GUI: appended after "present", straight onto the screen.
      const gui = AdvancedDynamicTexture.CreateFullscreenUI(name, true, { scene, useStandalone: true }, undefined, true);
      const task = new FrameGraphGUITask(name, frameGraph, gui);
      task.targetTexture = backbufferColorTextureHandle;
      frameGraph.addTask(task);
      rebuild();
      return gui;
    },
    dispose() {
      disposed = true;
      clearTimeout(resizeTimer);
      engine.onResizeObservable.remove(resizeObserver);
      if (scene.frameGraph === frameGraph) scene.frameGraph = null;
      frameGraph.dispose();
    },
  };
}
