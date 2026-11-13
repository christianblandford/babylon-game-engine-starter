import { PhysicsViewer } from "@babylonjs/core/Debug/physicsViewer";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractEngine, Scene } from "@babylonjs/core";
import GUI from "lil-gui";
import { QUALITY_PRESETS, getQuality, type QualityLevel } from "../config";
import { updateSettings } from "./settings";
import type { SceneLighting } from "./lighting";
import type { Renderer } from "./renderer";

/** What the debug tools need from the currently loaded scene. */
export interface DebugTarget {
  scene: Scene;
  lighting: SceneLighting;
  renderer: Renderer;
  /** Lets the game add its own folders/controls to the panel. */
  extendDebugPanel?(gui: GUI): void;
}

export interface DebugHost {
  engine: AbstractEngine;
  /** Rebuilds the current scene from scratch (used after a quality change). */
  reloadScene(): void;
}

const DEG = Math.PI / 180;

/**
 * Development tooling, loaded only in dev builds or with `?debug` in the URL:
 *
 *   `        toggle the tuning panel (lighting, post-processing, quality, physics)
 *   Shift+`  toggle the Babylon Inspector (scene graph, materials, textures, perf)
 *
 * plus a stats readout (frame rate, frame time, draw calls, active meshes).
 */
export class DebugTools {
  private readonly stats = document.createElement("div");
  private gui: GUI | null = null;
  private target: DebugTarget | null = null;
  private instrumentation: SceneInstrumentation | null = null;
  private physicsViewer: PhysicsViewer | null = null;
  private inspector: { dispose(): void } | null = null;
  private panelOpen = false;
  private lastStatsUpdate = 0;

  constructor(private readonly host: DebugHost) {
    this.stats.id = "stats";
    document.body.appendChild(this.stats);

    window.addEventListener("keydown", (e) => {
      if (e.code !== "Backquote" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (e.shiftKey) void this.toggleInspector();
      else this.togglePanel();
    });
  }

  /** Points the tools at a (new) scene. Call after every scene load. */
  bind(target: DebugTarget): void {
    const inspectorWasOpen = this.inspector !== null;
    this.closeInspector();
    this.physicsViewer = null; // its meshes died with the old scene
    this.instrumentation?.dispose();

    this.target = target;
    this.instrumentation = new SceneInstrumentation(target.scene);
    this.buildPanel(target);
    if (inspectorWasOpen) void this.toggleInspector();
  }

  /** Call once per rendered frame. */
  frame(): void {
    const now = performance.now();
    if (now - this.lastStatsUpdate < 250 || !this.target) return;
    this.lastStatsUpdate = now;
    const { engine } = this.host;
    const fps = engine.getFps();
    const activeMeshes = this.target.scene.getActiveMeshes().length;
    this.stats.textContent =
      `${fps.toFixed(0)} fps · ${(1000 / Math.max(fps, 1)).toFixed(1)} ms · ` +
      `${this.instrumentation?.drawCallsCounter.current ?? 0} draws` +
      // The classic renderer keeps one scene-wide list of visible meshes; with
      // a frame graph each pass has its own, so there is no single count.
      (activeMeshes > 0 ? ` · ${activeMeshes} meshes` : "");
  }

  togglePanel(): void {
    this.panelOpen = !this.panelOpen;
    this.gui?.show(this.panelOpen);
  }

  async toggleInspector(): Promise<void> {
    if (this.inspector) {
      this.closeInspector();
      return;
    }
    if (!this.target) return;
    document.exitPointerLock();
    // Large (it's a full React app), so it's only downloaded when first opened.
    const { ShowInspector } = await import("@babylonjs/inspector");
    this.inspector = ShowInspector(this.target.scene);
  }

  private closeInspector(): void {
    this.inspector?.dispose();
    this.inspector = null;
  }

  private buildPanel({ scene, lighting, renderer, extendDebugPanel }: DebugTarget): void {
    this.gui?.destroy();
    const gui = (this.gui = new GUI({ title: "Debug  ( ` )", width: 300 }));
    gui.show(this.panelOpen);

    // --- General -------------------------------------------------------------
    const general = {
      quality: getQuality().level,
      inspector: () => void this.toggleInspector(),
      reload: () => this.host.reloadScene(),
      colliders: false,
    };
    gui
      .add(general, "quality", Object.keys(QUALITY_PRESETS))
      .name("Quality preset")
      .onChange((level: QualityLevel) => {
        updateSettings({ quality: level }); // main.ts reloads the scene when quality changes
      });
    gui.add(general, "colliders").name("Show physics colliders").onChange((on: boolean) => this.showColliders(scene, on));
    gui.add(general, "inspector").name("Toggle Inspector  ( Shift+` )");
    gui.add(general, "reload").name("Reload scene");

    // --- Lighting ------------------------------------------------------------
    const dir = lighting.sunDirection;
    const sun = {
      elevation: Math.asin(Math.min(1, Math.max(-1, dir.y))) / DEG,
      azimuth: Math.atan2(dir.x, dir.z) / DEG,
    };
    const applySun = (): void => {
      const cosElevation = Math.cos(sun.elevation * DEG);
      lighting.setSunDirection(
        new Vector3(
          Math.sin(sun.azimuth * DEG) * cosElevation,
          Math.sin(sun.elevation * DEG),
          Math.cos(sun.azimuth * DEG) * cosElevation,
        ),
      );
    };
    const light = gui.addFolder("Lighting");
    light.add(sun, "elevation", 0, 90, 0.5).name("Sun elevation °").onChange(applySun);
    light.add(sun, "azimuth", -180, 180, 1).name("Sun azimuth °").onChange(applySun);
    light.add(lighting, "sunIntensity", 0, 8, 0.05).name("Sun intensity");
    light.add(lighting, "environmentIntensity", 0, 3, 0.05).name("Ambient intensity");
    light.add(scene, "fogDensity", 0, 0.03, 0.0005).name("Fog density");
    light.add(renderer.controls, "shadowDistance", 10, 300, 1).name("Shadow distance");
    light.add(renderer.controls, "showShadowCascades").name("Tint shadow cascades");

    // --- Post-processing -----------------------------------------------------
    const controls = renderer.controls;
    const post = gui.addFolder(`Post-processing (${renderer.kind === "frameGraph" ? "frame graph" : "classic"})`);
    post.add(controls, "exposure", 0.2, 3, 0.01).name("Exposure");
    post.add(controls, "contrast", 0.5, 2, 0.01).name("Contrast");
    post.add(controls, "toneMapping").name("Tone mapping");
    post.add(controls, "vignette").name("Vignette");
    post.add(controls, "bloom").name("Bloom");
    post.add(controls, "bloomStrength", 0, 1, 0.01).name("Bloom strength");
    post.add(controls, "bloomThreshold", 0, 3, 0.01).name("Bloom threshold");
    post.add(controls, "fxaa").name("FXAA");
    if (controls.taa !== undefined) post.add(controls, "taa").name("TAA");
    // Only what this renderer and quality preset actually provide.
    if (controls.ssaoStrength !== undefined) post.add(controls, "ssaoStrength", 0, 3, 0.01).name("SSAO strength");
    if (controls.ssaoRadius !== undefined) post.add(controls, "ssaoRadius", 0.1, 5, 0.01).name("SSAO radius");
    if (controls.sharpen !== undefined) post.add(controls, "sharpen").name("Sharpen");
    if (controls.depthOfField !== undefined) post.add(controls, "depthOfField").name("Depth of field");
    if (controls.chromaticAberration !== undefined) post.add(controls, "chromaticAberration").name("Chromatic aberration");
    if (controls.grain !== undefined) post.add(controls, "grain").name("Film grain");
    post.close();

    extendDebugPanel?.(gui);
  }

  private showColliders(scene: Scene, on: boolean): void {
    this.physicsViewer?.dispose();
    this.physicsViewer = null;
    if (!on) return;
    const viewer = (this.physicsViewer = new PhysicsViewer(scene));
    for (const node of [...scene.meshes, ...scene.transformNodes]) {
      if (node.physicsBody) viewer.showBody(node.physicsBody);
    }
  }
}
