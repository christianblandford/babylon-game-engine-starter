import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { BoxParticleEmitter } from "@babylonjs/core/Particles/EmitterTypes/boxParticleEmitter";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { ParticleSystemSet } from "@babylonjs/core/Particles/particleSystemSet";
import { SubEmitter } from "@babylonjs/core/Particles/subEmitter";
import type { AbstractMesh, IParticleSystem, Nullable, Observer, Scene } from "@babylonjs/core";
import type { GameContext } from "./context";
import type { MapMarker, StreamedMap } from "./map";

/**
 * Effects are looked up by name:
 *
 * - `dust`, `sparks`: small bursts defined in code in this file. Copy one as
 *   the starting point for an effect of your own.
 * - `campfire`: fire + smoke + a flickering light. `brazier`: the same
 *   without the smoke, for a fire indoors or in a hearth, where a column of
 *   sunlit smoke has no business. `explosion`: adds a flash.
 * - Anything else is a **particle file**: `spawn("magic")` loads
 *   `/assets/particles/systems/magic.json`, with its textures under
 *   `/assets/particles/textures/`. That is the format Babylon's particle
 *   editor and Inspector save, so effects authored there drop straight in.
 *
 * `fire`, `smoke`, `explosion` and `rain` ship as placeholder files (Babylon's
 * stock presets). Replace or delete them once you have your own.
 */
export type EffectName = "dust" | "sparks" | "splash" | "campfire" | "brazier" | "explosion" | "fire" | "smoke" | (string & {});

export interface EffectOptions {
  /** 1 is a sensible size next to the player (a fire about 1 m tall). */
  scale?: number;
  /**
   * Multiplies the particles' colour. Particles are unlit, and this scene is
   * rendered in HDR under a bright sun, so effects authored for a plain scene
   * look dark here: 2 to 3 is typical. Values above that make them glow.
   */
  brightness?: number;
}

export interface EffectHandle {
  /** Stops emitting and lets what's already in the air fade out, then cleans up. */
  stop(): void;
  /** Removes everything immediately. */
  dispose(): void;
}

export interface Effects {
  /**
   * Starts an effect at a point, or attached to a mesh so it follows it.
   * Continuous effects run until you `stop()` them; one-shot effects
   * (`explosion`, `dust`, `sparks`) clean up after themselves.
   */
  spawn(name: EffectName, at: Vector3 | AbstractMesh, options?: EffectOptions): Promise<EffectHandle>;
  /** Fire-and-forget version of `spawn` for one-shot effects. */
  burst(name: EffectName, at: Vector3, options?: EffectOptions): void;
  /**
   * Runs effects placed in Blender: any Empty with a custom property `fx`
   * (an effect name) and optionally `fx_scale`. They start when the camera
   * comes near and stop when it leaves.
   */
  followMap(map: StreamedMap): void;
  /** Switches an effect placed in the map off or back on, by its Empty's name. */
  setPlaced(markerName: string, on: boolean): void;
  /** True while rain is falling around the camera. */
  raining: boolean;
  dispose(): void;
}

const PRESET_URL = "/assets/particles";
/**
 * Adjustments that make the stock presets fit this scene. They are authored
 * bonfire- and bomb-sized for a plain, non-HDR scene, so each is scaled down
 * to player size, brightened, and in smoke's case thinned out. Your own files
 * are used as authored unless you add an entry here.
 */
interface PresetTuning {
  scale: number;
  brightness: number;
  /** Multiplies opacity. */
  opacity?: number;
  /** Multiplies how many particles are emitted per second. */
  density?: number;
  /** Multiplies how long each particle lives. */
  lifetime?: number;
}
const PRESET_TUNING: Record<string, PresetTuning> = {
  fire: { scale: 0.2, brightness: 1.7 },
  smoke: { scale: 0.16, brightness: 2.2, opacity: 0.35, density: 0.4, lifetime: 0.55 },
  explosion: { scale: 0.08, brightness: 1.5, opacity: 0.6 },
  rain: { scale: 1, brightness: 2 },
};
/** Map effects run while the camera is within this distance (m), with a little slack before stopping. */
const MAP_EFFECT_DISTANCE = 110;
const MAP_EFFECT_SLACK = 20;
/** How far above the camera rain is born, so that it reaches the ground around the player. */
const RAIN_HEIGHT = 27;

const presetData = new Map<string, Promise<unknown>>();

function loadPreset(name: string): Promise<unknown> {
  let pending = presetData.get(name);
  if (!pending) {
    pending = fetch(`${PRESET_URL}/systems/${name}.json`).then((response) => {
      if (!response.ok) throw new Error(`Particle preset not found: ${name}`);
      return response.json();
    });
    presetData.set(name, pending);
  }
  return pending;
}

/** Resizes a particle system as a whole: emitter, particle size, speeds and gravity. */
function scaleSystem(system: IParticleSystem, k: number): void {
  system.minSize *= k;
  system.maxSize *= k;
  system.minEmitPower *= k;
  system.maxEmitPower *= k;
  system.gravity.scaleInPlace(k);

  const emitter = system.particleEmitterType as unknown as Record<string, unknown>;
  if (emitter instanceof BoxParticleEmitter) {
    emitter.minEmitBox.scaleInPlace(k);
    emitter.maxEmitBox.scaleInPlace(k);
  } else {
    if (typeof emitter.radius === "number") emitter.radius *= k;
    if (typeof emitter.height === "number") emitter.height *= k;
  }
  for (const limit of system.getLimitVelocityGradients() ?? []) {
    limit.factor1 *= k;
    if (limit.factor2 !== undefined) limit.factor2 *= k;
  }
  if (system instanceof ParticleSystem) {
    for (const entry of system.subEmitters ?? []) {
      for (const sub of Array.isArray(entry) ? entry : [entry]) {
        scaleSystem(sub instanceof SubEmitter ? sub.particleSystem : sub, k);
      }
    }
  }
}

/** Multiplies a particle system's colours (and optionally opacity), including its sub-emitters. */
function tintSystem(system: IParticleSystem, brightness: number, opacity: number): void {
  const apply = (colour: Color4 | undefined): void => {
    if (!colour) return;
    colour.r *= brightness;
    colour.g *= brightness;
    colour.b *= brightness;
    colour.a *= opacity;
  };
  apply(system.color1);
  apply(system.color2);
  apply(system.colorDead);
  for (const step of system.getColorGradients() ?? []) {
    apply(step.color1);
    apply(step.color2);
  }
  if (system instanceof ParticleSystem) {
    for (const entry of system.subEmitters ?? []) {
      for (const sub of Array.isArray(entry) ? entry : [entry]) {
        tintSystem(sub instanceof SubEmitter ? sub.particleSystem : sub, brightness, opacity);
      }
    }
  }
}

export function createEffects(ctx: GameContext): Effects {
  const { scene, camera, quality } = ctx;
  ParticleSystemSet.BaseAssetsUrl = PRESET_URL;

  const live = new Set<EffectHandle>();
  let disposed = false;

  // Effect lights (firelight, explosion flashes) live in a light cluster. To
  // the materials a cluster is one fixed light, so adding and removing lights
  // inside it never recompiles a shader; ordinary lights would stall the game
  // for a few hundred milliseconds every time one appeared or vanished.
  const lightCluster = new ClusteredLightContainer("effectLights", [], scene);
  const lightsSupported = lightCluster.isSupported;

  // Lights are never taken out of the cluster or disposed while the game
  // runs: both make Babylon go through every mesh in the scene and mark its
  // materials for re-checking, which costs a 40 to 60 ms frame each time a
  // fire goes out. A light no longer needed is switched off, parked far away
  // and handed to the next effect that asks for one.
  const spareLights: PointLight[] = [];
  function addLight(name: string, position: Vector3, colour: Color3, range: number): PointLight | null {
    if (!lightsSupported || disposed) return null;
    let light = spareLights.pop();
    if (light) {
      light.name = name;
      light.position.copyFrom(position);
    } else {
      light = new PointLight(name, position, scene, true); // true: not a regular scene light
      lightCluster.addLight(light);
    }
    light.diffuse = colour;
    light.specular = colour;
    light.range = range;
    light.intensity = 0;
    return light;
  }
  function removeLight(light: PointLight): void {
    light.intensity = 0;
    light.range = 0.01;
    light.position.set(0, -100000, 0);
    spareLights.push(light);
  }
  // Putting a light into the cluster has the same cost as taking one out, so a
  // handful are made now, while the level is still loading, and parked.
  const SPARE_LIGHTS = 8;
  if (lightsSupported) {
    for (let i = 0; i < SPARE_LIGHTS; i++) {
      const light = new PointLight("spareLight", Vector3.Zero(), scene, true);
      lightCluster.addLight(light);
      removeLight(light);
    }
  }

  /** A soft round dot, drawn once, for effects that don't need a sprite sheet. */
  let dot: DynamicTexture | null = null;
  function softDot(): DynamicTexture {
    if (dot) return dot;
    const size = 64;
    dot = new DynamicTexture("softDot", size, scene, true);
    const g = dot.getContext();
    const fade = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    fade.addColorStop(0, "rgba(255,255,255,1)");
    fade.addColorStop(0.4, "rgba(255,255,255,0.55)");
    fade.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = fade;
    g.fillRect(0, 0, size, size);
    dot.update();
    dot.hasAlpha = true;
    return dot;
  }

  // Systems that have finished emitting are removed once their last particle
  // has died. (Babylon's own `disposeOnStop` doesn't fire for every kind of
  // system, so this is done explicitly.)
  const fading = new Map<IParticleSystem, number>();
  const fadeOut = (system: IParticleSystem): void => void fading.set(system, performance.now());
  let reapFrame = 0;
  const reaper = scene.onBeforeRenderObservable.add(() => {
    if (reapFrame++ % 20 !== 0 || fading.size === 0) return;
    const now = performance.now();
    for (const [system, since] of fading) {
      if (now - since > 1000 && system.getActiveCount() === 0) {
        fading.delete(system);
        system.dispose();
      }
    }
  });

  function handleFor(systems: IParticleSystem[], extra?: { stop?(): void; dispose(): void }): EffectHandle {
    const handle: EffectHandle = {
      stop() {
        live.delete(handle);
        extra?.stop?.() ?? extra?.dispose();
        for (const system of systems) {
          system.stop();
          fadeOut(system);
        }
      },
      dispose() {
        live.delete(handle);
        extra?.dispose();
        for (const system of systems) {
          fading.delete(system);
          system.dispose();
        }
      },
    };
    live.add(handle);
    return handle;
  }

  // --- Particle files ----------------------------------------------------------

  async function preset(name: string, at: Vector3 | AbstractMesh, options: EffectOptions): Promise<IParticleSystem[]> {
    const data = await loadPreset(name);
    if (disposed) return [];
    const tuning = PRESET_TUNING[name] ?? { scale: 1, brightness: 1 };
    const set = ParticleSystemSet.Parse(data, scene, false);
    for (const system of set.systems) {
      scaleSystem(system, (options.scale ?? 1) * tuning.scale);
      tintSystem(system, (options.brightness ?? 1) * tuning.brightness, tuning.opacity ?? 1);
      system.emitRate *= tuning.density ?? 1;
      system.minLifeTime *= tuning.lifetime ?? 1;
      system.maxLifeTime *= tuning.lifetime ?? 1;
      // Thin out the busy systems on lower quality presets; leave the handful
      // of big animated sprites (a flame is only a few particles) alone.
      if (system.getCapacity() >= 100) system.emitRate *= quality.particles;
      system.emitter = at;
      system.start();
    }
    return set.systems;
  }

  /** A warm point light that flickers. */
  function fireLight(at: Vector3 | AbstractMesh, scale: number): { stop(): void; dispose(): void } | undefined {
    const origin = at instanceof Vector3 ? at : at.getAbsolutePosition();
    const light = addLight("fireLight", origin.add(new Vector3(0, 0.6 * scale, 0)), new Color3(1, 0.5, 0.18), 14 * scale);
    if (!light) return undefined;
    const strength = 9 * scale * scale;
    let level = 0; // fades in and out so the light never pops
    let target = 1;
    const started = performance.now();
    let observer: Nullable<Observer<Scene>> = scene.onBeforeRenderObservable.add(() => {
      const t = (performance.now() - started) / 1000;
      level += (target - level) * Math.min(1, scene.getEngine().getDeltaTime() / 400);
      const flicker = 0.82 + 0.1 * Math.sin(t * 11.3) + 0.08 * Math.sin(t * 23.7 + 1.3);
      light.intensity = strength * flicker * level;
      if (target === 0 && level < 0.02) dispose();
    });
    function dispose(): void {
      if (!observer) return;
      scene.onBeforeRenderObservable.remove(observer);
      observer = null;
      removeLight(light!);
    }
    return { stop: () => (target = 0), dispose };
  }

  /** A brief flash for explosions. */
  function flashLight(at: Vector3, scale: number): void {
    const light = addLight("flash", at.add(new Vector3(0, 0.5 * scale, 0)), new Color3(1, 0.7, 0.35), 30 * scale);
    if (!light) return;
    const started = performance.now();
    const observer = scene.onBeforeRenderObservable.add(() => {
      const t = (performance.now() - started) / 450;
      light.intensity = 220 * scale * scale * Math.max(0, 1 - t) ** 2;
      if (t >= 1) {
        scene.onBeforeRenderObservable.remove(observer);
        removeLight(light);
      }
    });
  }

  // --- Effects defined in code ----------------------------------------------

  function burstSystem(name: string, at: Vector3, count: number): ParticleSystem {
    const system = new ParticleSystem(name, count, scene);
    system.particleTexture = softDot();
    system.emitter = at.clone();
    system.emitRate = 0;
    system.manualEmitCount = Math.max(1, Math.round(count * quality.particles));
    fadeOut(system); // one-shot: remove it when the last particle is gone
    return system;
  }

  /** A low puff of dust, for landings and impacts. */
  function dust(at: Vector3, scale: number): ParticleSystem {
    const system = burstSystem("dust", at, 14);
    system.createBoxEmitter(
      new Vector3(-1, 0.25, -1),
      new Vector3(1, 0.7, 1),
      new Vector3(-0.12 * scale, 0, -0.12 * scale),
      new Vector3(0.12 * scale, 0.04 * scale, 0.12 * scale),
    );
    system.minEmitPower = 0.25 * scale;
    system.maxEmitPower = 0.9 * scale;
    system.minLifeTime = 0.45;
    system.maxLifeTime = 0.95;
    system.minSize = 0.14 * scale;
    system.maxSize = 0.3 * scale;
    system.addSizeGradient(0, 0.5);
    system.addSizeGradient(1, 1.9);
    system.addDragGradient(0, 0.5);
    system.addDragGradient(1, 0.9);
    system.gravity = new Vector3(0, 0.25 * scale, 0);
    system.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    system.addColorGradient(0, new Color4(0.75, 0.68, 0.55, 0.38));
    system.addColorGradient(1, new Color4(0.75, 0.68, 0.55, 0));
    return system;
  }

  /** Water thrown up and falling back: something landing in, or climbing out of, water. */
  function splash(at: Vector3, scale: number): ParticleSystem {
    const system = burstSystem("splash", at, 36);
    system.createConeEmitter(0.25 * scale, Math.PI / 1.6);
    system.minEmitPower = 1.2 * scale;
    system.maxEmitPower = 3.2 * scale;
    system.minLifeTime = 0.35;
    system.maxLifeTime = 0.8;
    system.minSize = 0.03 * scale;
    system.maxSize = 0.09 * scale;
    system.gravity = new Vector3(0, -9, 0);
    system.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    system.addColorGradient(0, new Color4(1.6, 1.75, 1.9, 0.75));
    system.addColorGradient(1, new Color4(1.4, 1.6, 1.8, 0));
    return system;
  }

  /** A spray of hot sparks that arc and fall. Colours above 1 make the bloom pick them up. */
  function sparks(at: Vector3, scale: number): ParticleSystem {
    const system = burstSystem("sparks", at, 40);
    system.createConeEmitter(0.05 * scale, Math.PI / 2.2);
    system.minEmitPower = 1.8 * scale;
    system.maxEmitPower = 5 * scale;
    system.minLifeTime = 0.3;
    system.maxLifeTime = 0.9;
    system.minSize = 0.025 * scale;
    system.maxSize = 0.05 * scale;
    system.gravity = new Vector3(0, -9.81 * scale, 0);
    system.blendMode = ParticleSystem.BLENDMODE_ADD;
    system.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    system.addColorGradient(0, new Color4(9, 6, 2, 1));
    system.addColorGradient(0.5, new Color4(7, 2.4, 0.4, 1));
    system.addColorGradient(1, new Color4(1, 0.1, 0, 0));
    return system;
  }

  // --- Rain follows the camera -----------------------------------------------

  let rain: EffectHandle | null = null;
  let rainWanted = false;
  async function startRain(): Promise<void> {
    const cloud = new Vector3();
    const follow = scene.onBeforeRenderObservable.add(() => {
      cloud.copyFrom(camera.globalPosition).addInPlaceFromFloats(0, RAIN_HEIGHT, 0);
    });
    cloud.copyFrom(camera.globalPosition).addInPlaceFromFloats(0, RAIN_HEIGHT, 0);
    const systems = await preset("rain", cloud, {});
    const handle = handleFor(systems, { dispose: () => scene.onBeforeRenderObservable.remove(follow) });
    if (rainWanted && !disposed) rain = handle;
    else handle.dispose();
  }

  // --- Public API ----------------------------------------------------------------

  async function spawn(name: EffectName, at: Vector3 | AbstractMesh, options: EffectOptions = {}): Promise<EffectHandle> {
    const scale = options.scale ?? 1;
    const origin = at instanceof Vector3 ? at : at.getAbsolutePosition();
    switch (name) {
      case "campfire": {
        const smokeFrom = at instanceof Vector3 ? at.add(new Vector3(0, 0.7 * scale, 0)) : at;
        const [flames, smoke] = await Promise.all([preset("fire", at, options), preset("smoke", smokeFrom, options)]);
        return handleFor([...flames, ...smoke], fireLight(at, scale));
      }
      case "brazier":
        return handleFor(await preset("fire", at, options), fireLight(at, scale));
      case "explosion": {
        const systems = await preset("explosion", origin.clone(), options);
        for (const system of systems) fadeOut(system); // each stops itself; clean up after
        flashLight(origin, scale);
        return handleFor(systems);
      }
      case "rain":
        throw new Error('Rain surrounds the camera: set `effects.raining = true` instead of spawning it.');
      case "dust":
      case "splash":
      case "sparks": {
        const system = name === "dust" ? dust(origin, scale) : name === "splash" ? splash(origin, scale) : sparks(origin, scale);
        system.start();
        return handleFor([system]);
      }
      default:
        return handleFor(await preset(name, at, options)); // a particle file
    }
  }

  // One per map followed: a level, and any interior loaded beside it.
  const mapObservers: Nullable<Observer<Scene>>[] = [];
  /** Names of map-placed effects that have been switched off. */
  const placedOff = new Set<string>();
  /** Raised when an effect is switched by hand, so every map looks at once instead of at its next check. */
  let placedChanges = 0;

  return {
    spawn,
    burst(name, at, options) {
      void spawn(name, at, options).catch((error) => console.error(`Effect "${name}" failed:`, error));
    },
    followMap(map) {
      const placed = map.manifest.markers.filter((marker) => typeof marker.props.fx === "string");
      if (placed.length === 0) return;
      const running = new Map<MapMarker, { wanted: boolean; handle: EffectHandle | null }>();
      let frame = 0;
      let seenChanges = placedChanges;
      mapObservers.push(scene.onBeforeRenderObservable.add(() => {
        // Starting an effect takes about 10 ms (its particle systems are built
        // from the file each time), and a street of chimneys comes into range
        // all at once: so one start at most per look, a few frames apart.
        const due = frame++ % 6 === 0 || seenChanges !== placedChanges;
        seenChanges = placedChanges;
        if (!due) return;
        let started = false;
        for (const marker of placed) {
          const [x, y, z] = marker.position;
          const distance = Math.hypot(camera.globalPosition.x - x, camera.globalPosition.z - z);
          let state = running.get(marker);
          const near = !placedOff.has(marker.name) && distance < MAP_EFFECT_DISTANCE + (state?.wanted ? MAP_EFFECT_SLACK : 0);
          if (near && !state) {
            if (started) continue; // its turn comes next time
            started = true;
            const entry = { wanted: true, handle: null as EffectHandle | null };
            running.set(marker, (state = entry));
            const scale = typeof marker.props.fx_scale === "number" ? marker.props.fx_scale : 1;
            spawn(String(marker.props.fx), new Vector3(x, y, z), { scale })
              .then((handle) => {
                if (entry.wanted) entry.handle = handle;
                else handle.stop(); // the camera left while it was loading
              })
              .catch((error) => {
                console.error(`Map effect "${marker.name}" (${String(marker.props.fx)}) failed:`, error);
              });
          } else if (!near && state) {
            state.wanted = false;
            state.handle?.stop();
            running.delete(marker);
          }
        }
      }));
    },
    setPlaced(markerName, on) {
      if (on) placedOff.delete(markerName);
      else placedOff.add(markerName);
      placedChanges++; // act on it this frame, not at the next check
    },
    get raining() {
      return rainWanted;
    },
    set raining(on: boolean) {
      if (on === rainWanted) return;
      rainWanted = on;
      if (on) void startRain().catch((error) => console.error("Rain failed:", error));
      else {
        rain?.stop();
        rain = null;
      }
    },
    dispose() {
      disposed = true;
      for (const observer of mapObservers) scene.onBeforeRenderObservable.remove(observer);
      scene.onBeforeRenderObservable.remove(reaper);
      for (const handle of [...live]) handle.dispose();
      for (const system of fading.keys()) system.dispose();
      fading.clear();
      lightCluster.dispose();
      dot?.dispose();
    },
  };
}
