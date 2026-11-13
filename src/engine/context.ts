import type { AbstractEngine, AbstractMesh, DirectionalLight, FreeCamera, Scene, Vector3 } from "@babylonjs/core";
import type { QualitySettings } from "../config";
import type { GameClock } from "./clock";
import type { Input } from "./input";
import type { Renderer } from "./renderer";

/** Sun, sky, image-based lighting and shadows. Implemented in `lighting.ts`. */
export interface Lighting {
  readonly sun: DirectionalLight;
  /** Unit vector pointing from the world *toward* the sun. */
  readonly sunDirection: Vector3;
  /** Makes a mesh (and optionally its children) cast shadows. */
  addShadowCaster(mesh: AbstractMesh, includeDescendants?: boolean): void;
  /** Moves the sun; the sky, shadows and ambient lighting all follow. */
  setSunDirection(direction: Vector3): void;
}

/** One-shot sound effects. Implemented in `audio.ts`. */
export interface AudioSystem {
  /** Plays a registered sound by name. Safe to call before audio is unlocked. */
  play(name: string, options?: { volume?: number; playbackRate?: number }): void;
  /** Loads a sound file and registers it under `name`. */
  load(name: string, url: string): Promise<void>;
  /** 0..1 */
  masterVolume: number;
}

/**
 * Everything a piece of game code needs. One is built per scene in
 * `game/scene.ts` and handed to each system (player, level, HUD, ...).
 */
export interface GameContext {
  readonly engine: AbstractEngine;
  readonly canvas: HTMLCanvasElement;
  readonly scene: Scene;
  /** The single gameplay camera. Post-processing and shadows are bound to it. */
  readonly camera: FreeCamera;
  readonly input: Input;
  /** Game time: use `clock.delta` for anything that should stop when paused. */
  readonly clock: GameClock;
  readonly quality: QualitySettings;
  readonly lighting: Lighting;
  /** Shadows, post-processing and on-screen UI surfaces. */
  readonly renderer: Renderer;
  readonly audio: AudioSystem;
}
