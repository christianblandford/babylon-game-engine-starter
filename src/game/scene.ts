import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PhysicsHelper } from "@babylonjs/core/Physics/physicsHelper";
import { Scene } from "@babylonjs/core/scene";
import type { AbstractEngine, Mesh } from "@babylonjs/core";
import type GUI from "lil-gui";
import { ASSETS, LEVELS, type LevelInfo, type QualitySettings } from "../config";
import type { GameAudio } from "../engine/audio";
import type { GameContext } from "../engine/context";
import type { Input } from "../engine/input";
import { createLighting, type SceneLighting } from "../engine/lighting";
import { enablePhysics } from "../engine/physics";
import { chooseRenderer, createRenderer, type Renderer } from "../engine/renderer";
import { loadContainer } from "../engine/assets";
import { createClock, type GameClock } from "../engine/clock";
import type { Dialogue } from "../engine/dialogue";
import { createEffects, type Effects } from "../engine/effects";
import { createGroundCover } from "../engine/groundCover";
import { loadMap, type StreamedMap } from "../engine/map";
import { createNavigation, type Navigation } from "../engine/navigation";
import { INDOORS, createSpaces, type Spaces } from "../engine/spaces";
import { createTriggers, type Triggers } from "../engine/triggers";
import type { WorldState } from "../engine/worldState";
import { createWater, waterSurface } from "../engine/water";
import { createWind } from "../engine/wind";
import { createConversations } from "./conversations";
import { createHud } from "./hud";
import { setUpInteractions } from "./interactions";
import { buildLevel } from "./level";
import { createNpcs } from "./npcs";
import type { Settings } from "../engine/settings";
import { DEFAULT_PLAYER_OPTIONS, createPlayer, type Player, type ViewMode } from "./player";

/** Long-lived services owned by main.ts and shared by every scene. */
export interface SceneHost {
  engine: AbstractEngine;
  canvas: HTMLCanvasElement;
  input: Input;
  audio: GameAudio;
  quality: QualitySettings;
  /** Which level to build. */
  level: LevelInfo;
  /** The marker to start at, when the level was reached through a door. Default: `spawn`. */
  arrival?: string;
  /** Leaves this scene for another level, arriving at `marker` there. */
  travelTo(level: LevelInfo, marker?: string): void;
  /** What the player has changed in the world: outlives scenes, saved in the browser. */
  state: WorldState;
  /** True to put the player where the saved game left them, instead of at the level's start. */
  resume?: boolean;
  /** True when the debug tools are loaded (dev builds, or `?debug`). */
  debug: boolean;
}

export interface GameScene {
  scene: Scene;
  lighting: SceneLighting;
  renderer: Renderer;
  /** Null when no map has been exported and the flat fallback ground is in use. */
  map: StreamedMap | null;
  player: Player;
  effects: Effects;
  /** Where characters can walk, and the agents walking there. */
  navigation: Navigation;
  /** Trigger zones and things the player can use. */
  triggers: Triggers;
  /** This level, the interiors loaded beside it, and the doors between them. */
  spaces: Spaces;
  /** Stories and the conversation going on, if any. */
  dialogue: Dialogue;
  /** Game time. `clock.paused = true` freezes the level (the menus use this). */
  clock: GameClock;
  /** Applies the player's saved preferences (look speed and so on). */
  applySettings(settings: Settings): void;
  extendDebugPanel(gui: GUI): void;
  dispose(): void;
}

/** Used when the map has no `spawn` marker (or there is no map). */
const DEFAULT_SPAWN = new Vector3(0, 0.2, -4);
/** Fall below this and you're put back at the spawn point. */
const KILL_HEIGHT = -25;

/**
 * Builds the game world. This is the file to start editing: it is hot-swapped
 * on save, so changes here (or in anything it imports) appear without a page
 * reload.
 */
export async function createGameScene(host: SceneHost): Promise<GameScene> {
  const { engine, canvas, input, audio, quality } = host;
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  scene.skipPointerMovePicking = true; // no mesh picking on every mouse move; costly in big worlds

  try {
    // One gameplay camera. The player controller drives it; post-processing
    // and shadows are bound to it.
    const camera = new FreeCamera("camera", new Vector3(0, 2, -10), scene);
    camera.minZ = 0.1;
    camera.maxZ = 1500;
    camera.fov = 1.0;

    // Start downloads/compiles that don't depend on each other together.
    const [, , lighting] = await Promise.all([
      enablePhysics(scene),
      loadContainer(scene, ASSETS.fox),
      Promise.resolve(
        createLighting(scene, camera, quality, host.level.sunDirection ? { sunDirection: Vector3.FromArray(host.level.sunDirection) } : {}),
      ),
    ]);
    // Shadows, post-processing and UI surfaces: Frame Graph by default,
    // or `?renderer=classic` for Babylon's older pipeline.
    const renderer = await createRenderer(chooseRenderer(), scene, camera, quality, lighting);

    const clock = createClock(scene);
    const ctx: GameContext = { engine, canvas, scene, camera, input, clock, quality, lighting, renderer, audio, state: host.state };

    // The world: a map streamed in around the camera, if this level has one.
    // If it fails to load (not exported yet, say), fall back to flat ground so
    // the game still runs.
    // Wind, for grass and for map foliage.
    const wind = createWind(ctx);

    // Water takes the place of Blender materials by name: "Water" is clear
    // enough to see the bottom of a pond or moat; "Sea" is opaque, for open
    // water whose floor isn't modelled, with a longer swell.
    const water = createWater(ctx);
    const sea = createWater(ctx, { clarity: 0, rippleSize: 12, rippleStrength: 0.45 });

    let map: StreamedMap | null = null;
    if (host.level.map) {
      try {
        map = await loadMap(ctx, host.level.map, {
          viewDistance: quality.viewDistance,
          detailDistance: host.level.detailDistance,
          materials: { Water: water.override, Sea: sea.override },
          wind,
        });
      } catch (error) {
        console.warn(`Map for level "${host.level.id}" didn't load; using flat ground.`, error);
      }
    }
    // With the map's height image, water knows its own depth: clear in the shallows, gone at the waterline.
    if (map?.manifest.heights) {
      water.setHeights(map.manifest.heights, map.baseUrl);
      sea.setHeights(map.manifest.heights, map.baseUrl);
    }

    // Grass, planted wherever the map's ground asks for it.
    const grass = map ? createGroundCover(ctx, map, { wind }) : null;

    // The scaffold's demo props, unless the level opts out. (With no map they
    // also provide the ground, so then they are built regardless.)
    const level = map && host.level.demoProps === false ? { statics: [] } : buildLevel(ctx, map);

    const marker = (host.arrival ? map?.marker(host.arrival) : undefined) ?? map?.marker("spawn");
    const spawn = marker ? Vector3.FromArray(marker.position) : DEFAULT_SPAWN;
    // Where the saved game left the player, if this level is being resumed:
    // which place (the level itself or one of its interiors) and the spot.
    const whereabouts = host.state.scope("player");
    const saved =
      host.resume && whereabouts.get("level", "") === host.level.id
        ? {
            space: whereabouts.get("space", host.level.id),
            position: new Vector3(whereabouts.get("x", spawn.x), whereabouts.get("y", spawn.y), whereabouts.get("z", spawn.z)),
            yaw: whereabouts.get("yaw", 0),
          }
        : null;
    const outside = saved?.space === host.level.id ? saved : null; // resumed out in the level itself
    const start = outside?.position ?? spawn;
    camera.position.copyFrom(start).addInPlaceFromFloats(0, 2, 0); // streaming follows the camera
    await map?.whenLoadedAround(start); // ground must exist before anything stands on it

    // The player floats and swims wherever either kind of water is deep enough.
    const player = await createPlayer(ctx, { position: start, yaw: outside?.yaw ?? marker?.yaw ?? 0, waterLevel: waterSurface(water, sea) });
    player.onJump.add(() => audio.play("jump", { playbackRate: 0.95 + Math.random() * 0.1 }));
    player.onLand.add((impactSpeed) => audio.play("land", { volume: Math.min(1, impactSpeed / 8) }));

    // Particles: effects placed in the map (Empties with an `fx` property)
    // run as the camera nears them, and landings kick up dust.
    const effects = createEffects(ctx);
    if (map) effects.followMap(map);
    player.onLand.add((impactSpeed) => effects.burst("dust", player.position, { scale: Math.min(1.6, impactSpeed / 4) }));
    // Going into water, or climbing out, throws some of it about.
    player.onSwimChanged.add(({ swimming, speed }) => {
      const scale = swimming ? Math.min(1.8, 0.7 + speed / 5) : 0.6;
      effects.burst("splash", player.position.add(new Vector3(0, DEFAULT_PLAYER_OPTIONS.floatDepth, 0)), { scale });
      audio.play("land", { volume: Math.min(1, 0.4 + speed / 8), playbackRate: swimming ? 0.5 : 0.8 });
    });

    // Where characters can walk: worked out from the ground and obstacles now
    // loaded, a little each frame, and again whenever the map streams in or
    // out. Nothing waits for it; characters start moving as their surroundings
    // become known.
    const navigation = await createNavigation(ctx);
    /** Things made in code that are in the way for now, such as a closed gate. */
    const blockers = new Set<Mesh>();
    const walkable = () => {
      const world = map?.collisionGeometry();
      return { meshes: [...(world?.meshes ?? []), ...level.statics, ...blockers], obstacles: world?.obstacles };
    };
    void navigation.rebuild(walkable());
    map?.onDetailChanged.add(() => void navigation.rebuild(walkable()));
    // A few foxes that wander near the spawn point and sometimes come over.
    const npcs = await createNpcs(ctx, navigation, { around: spawn, player });

    const hud = createHud(ctx, player, host.debug);
    const beacon = scene.getMeshByName("beacon");
    if (beacon) hud.label(beacon, "Emissive + bloom");

    // Zones that notice the player walking in, and things to use with the
    // interact key: placed in Blender (Empties with a `trigger` or `interact`
    // property) or added in code. What each one does is in interactions.ts.
    const triggers = createTriggers(ctx, player);
    if (map) triggers.followMap(map);
    triggers.onFocusChanged.add((target) => hud.prompt(input.labelFor("interact"), target?.prompt ?? null));
    setUpInteractions(ctx, {
      triggers,
      effects,
      hud,
      map,
      state: host.state.scope(host.level.id), // this level's own corner of the saved world
      blockNavigation(mesh, blocked) {
        if (blocked) blockers.add(mesh);
        else blockers.delete(mesh);
        void navigation.rebuild(walkable());
      },
    });

    // People to talk to: Empties with `talk = "<story>"`, saying what the
    // story of that name in game/stories/ has them say.
    const conversations = createConversations(ctx, { triggers, hud, player });
    if (map) conversations.followMap(map);

    // Doors. An Empty in Blender with `door = "hall#entrance"` leads to that
    // marker in that space: an interior is loaded here, beside this level,
    // and entered behind a short fade; another world replaces this scene.
    const spaces = createSpaces(ctx, {
      home: {
        id: host.level.id,
        map,
        environment: host.level.indoors ? { ...INDOORS, ...host.level.environment } : host.level.environment,
      },
      lighting,
      triggers,
      find(id) {
        // One of this level's interiors, or else another level.
        const inside = host.level.interiors?.find((candidate) => candidate.id === id);
        if (inside) return { id, map: inside.map, interior: true, environment: inside.environment };
        const level = LEVELS.find((candidate) => candidate.id === id);
        return level?.map ? { id, map: level.map, interior: false, environment: level.environment } : undefined;
      },
      async load(space, origin) {
        const inside = await loadMap(ctx, space.map, {
          viewDistance: quality.viewDistance,
          materials: { Water: water.override, Sea: sea.override },
          wind,
          origin,
          fog: false, // the level's own haze stands; each space says how much of it there is
        });
        effects.followMap(inside);
        triggers.followMap(inside);
        conversations.followMap(inside);
        return inside;
      },
      place: (position, yaw) => player.teleport(position, yaw),
      position: () => player.position,
      leave(space, arriveAt) {
        const next = LEVELS.find((candidate) => candidate.id === space.id);
        if (next) host.travelTo(next, arriveAt);
      },
    });
    // A door closing behind you.
    spaces.onTravelled.add(() => audio.play("land", { volume: 0.5, playbackRate: 0.7 }));

    // Where the player is goes into the saved game: on arriving anywhere, and
    // every couple of seconds while standing on something (not in mid-fall,
    // or "Continue" would resume the fall).
    const remember = (): void => {
      const at = player.position.subtract(spaces.origin(spaces.current)); // in the place's own coordinates
      whereabouts.set("level", host.level.id);
      whereabouts.set("space", spaces.current);
      whereabouts.set("x", Math.round(at.x * 100) / 100);
      whereabouts.set("y", Math.round(at.y * 100) / 100);
      whereabouts.set("z", Math.round(at.z * 100) / 100);
      whereabouts.set("yaw", Math.round(camera.rotation.y * 100) / 100);
    };
    spaces.onTravelled.add(remember);
    let sinceRemembered = 0;
    scene.onBeforeRenderObservable.add(() => {
      sinceRemembered += clock.delta;
      if (sinceRemembered < 2 || spaces.travelling || !player.isGrounded) return;
      sinceRemembered = 0;
      remember();
    });

    /** Moves the player somewhere else on the map, loading that area first. */
    const travel = async (destination: Vector3): Promise<void> => {
      await map?.whenLoadedAround(destination);
      player.teleport(destination);
    };

    scene.onBeforeRenderObservable.add(() => {
      if (player.position.y >= KILL_HEIGHT || spaces.travelling) return;
      // Fell out of the world. From inside a building, that means back out of its door.
      if (spaces.current === host.level.id) player.teleport(spawn);
      else void spaces.travel("back").catch(() => player.teleport(spawn));
    });

    // Don't show the world until its lighting is baked and shaders are compiled.
    await lighting.ready;
    await scene.frameGraph?.whenReadyAsync();
    // Materials compile in the background (noticeably so on WebGPU). Wait for
    // them, but never hold the loading screen hostage to one slow shader.
    await Promise.race([scene.whenReadyAsync(), new Promise((resolve) => setTimeout(resolve, 10_000))]);

    // Look around the places the level names, still behind the loading
    // screen, so their shaders are compiled now and not mid-run (see `warmUp`
    // in config.ts). Done last, with everything in place (effects and their
    // lights, grass, characters), because what a material's shader contains
    // depends on all of it; and with the game running, so that fires and
    // smoke near each place start up and compile theirs.
    /** Draws frames by hand: this scene is not on screen yet, so nothing else is drawing it. */
    const draw = async (frames: number): Promise<void> => {
      for (let i = 0; i < frames && !scene.isDisposed; i++) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    if (map && host.level.warmUp?.length) {
      const eye = new Vector3();
      const target = new Vector3();
      // Added last, so it has the final say over the camera each frame.
      const hold = scene.onBeforeRenderObservable.add(() => {
        camera.position.copyFrom(eye);
        camera.setTarget(target);
      });
      for (const name of host.level.warmUp) {
        const place = map.marker(name);
        if (!place || scene.isDisposed) continue;
        eye.fromArray(place.position).addInPlaceFromFloats(0, 2, 0);
        target.copyFrom(eye).addInPlaceFromFloats(0, -1, 10);
        camera.position.copyFrom(eye); // streaming follows the camera
        await map.whenLoadedAround(eye);
        for (let turn = 0; turn < 4; turn++) {
          target.copyFrom(eye).addInPlaceFromFloats(Math.sin((turn * Math.PI) / 2) * 10, -1, Math.cos((turn * Math.PI) / 2) * 10);
          await draw(3);
        }
        // Shaders compile in the background on WebGL: give them a moment, then draw what was waiting on them.
        await Promise.race([scene.whenReadyAsync(), new Promise((resolve) => setTimeout(resolve, 4000))]);
        await draw(2);
      }
      scene.onBeforeRenderObservable.remove(hold);
      // Back to the start. The ground there may have unloaded meanwhile.
      camera.position.copyFrom(start).addInPlaceFromFloats(0, 2, 0);
      await map.whenLoadedAround(start);
      player.teleport(start);
      await draw(2);
    }

    // A game saved inside one of the level's interiors: go back in, to the
    // same spot, before the loading screen lifts. The trip waits on frames,
    // and nobody else is drawing this scene yet.
    if (saved && !outside) {
      let arrived = false;
      void spaces
        .travel(saved.space, { position: saved.position, yaw: saved.yaw })
        .catch((error) => console.warn(`Could not resume in "${saved.space}":`, error))
        .finally(() => (arrived = true));
      while (!arrived && !scene.isDisposed) await draw(1);
    }

    return {
      scene,
      lighting,
      renderer,
      map,
      player,
      effects,
      navigation,
      triggers,
      spaces,
      dialogue: conversations.dialogue,
      clock,
      applySettings(settings) {
        player.configure({
          mouseSensitivity: DEFAULT_PLAYER_OPTIONS.mouseSensitivity * settings.lookSensitivity,
          stickLookSpeed: DEFAULT_PLAYER_OPTIONS.stickLookSpeed * settings.lookSensitivity,
          invertY: settings.invertY,
        });
      },
      extendDebugPanel(gui) {
        const state = { view: player.viewMode, respawn: () => void travel(spawn) };
        const folder = gui.addFolder("Player");
        const view = folder
          .add(state, "view", ["first", "third"])
          .name("View")
          .onChange((mode: ViewMode) => player.setViewMode(mode));
        player.onViewModeChanged.add((mode) => {
          state.view = mode;
          view.updateDisplay();
        });
        folder.add(state, "respawn").name("Respawn");

        // A few metres in front of the player, wherever the camera is looking.
        const ahead = (): Vector3 => {
          const forward = camera.getDirection(Vector3.Forward());
          forward.y = 0;
          return player.position.add(forward.normalize().scale(4)).addInPlaceFromFloats(0, 0.3, 0);
        };
        const fx = gui.addFolder("Effects");
        const fxActions = {
          explosion: () => {
            const at = ahead();
            effects.burst("explosion", at);
            // Purely for show: an explosion that also shoves nearby physics objects.
            new PhysicsHelper(scene).applyRadialExplosionImpulse(at, 6, 14);
          },
          sparks: () => effects.burst("sparks", ahead()),
          dust: () => effects.burst("dust", ahead()),
        };
        fx.add(fxActions, "explosion").name("Explosion ahead");
        fx.add(fxActions, "sparks").name("Sparks ahead");
        fx.add(fxActions, "dust").name("Dust puff ahead");
        fx.add(effects, "raining").name("Rain");

        const wet = gui.addFolder("Water");
        wet.add(water, "clarity", 0, 1, 0.01).name("Clarity");
        wet.add(water, "rippleStrength", 0, 2, 0.01).name("Ripples");
        wet.add(water.material, "roughness", 0, 0.5, 0.005).name("Roughness");
        wet.close();

        gui
          .add({ navmesh: false }, "navmesh")
          .name("Show walkable area")
          .onChange((on: boolean) => navigation.showDebug(on));
        gui
          .add({ zones: false }, "zones")
          .name("Show triggers")
          .onChange((on: boolean) => triggers.showDebug(on));

        if (map) {
          const streamed = map;
          const world = gui.addFolder(`Map: ${streamed.manifest.name}`);
          world.add(streamed, "detailDistance", 32, 400, 1).name("Full-detail distance");
          world.add(streamed, "viewDistance", 100, 1200, 1).name("View distance");
          const readout = { chunks: "" };
          world.add(readout, "chunks").name("Loaded").disable().listen();
          const refresh = setInterval(() => {
            const { detailed, far, total, triangles } = streamed.stats;
            readout.chunks = `${detailed} near + ${far} far / ${total} · ${(triangles / 1000).toFixed(0)}k tris`;
          }, 500);
          scene.onDisposeObservable.addOnce(() => clearInterval(refresh));
          for (const point of streamed.manifest.markers) {
            world.add({ go: () => void travel(Vector3.FromArray(point.position)) }, "go").name(`Go to "${point.name}"`);
          }
        }
      },
      dispose() {
        conversations.dispose();
        spaces.dispose();
        triggers.dispose();
        grass?.dispose();
        wind.dispose();
        water.dispose();
        sea.dispose();
        npcs.dispose();
        navigation.dispose();
        effects.dispose();
        hud.dispose();
        renderer.dispose();
        scene.dispose();
      },
    };
  } catch (error) {
    scene.dispose();
    throw error;
  }
}
