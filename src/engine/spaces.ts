import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Observable } from "@babylonjs/core/Misc/observable";
import type { GameContext } from "./context";
import type { SceneLighting } from "./lighting";
import type { MapMarker, StreamedMap } from "./map";
import type { Triggers } from "./triggers";

/**
 * Places, and the doors between them.
 *
 * A game world is more than one map: the town, the inside of its hall, a
 * cellar under an inn, another island. Each is a **space**: a map exported
 * from Blender plus the light it is seen in. Spaces are joined by **doors**:
 * Empties in Blender with a custom property
 *
 *     door = "hall#entrance"      (the space's id, then a marker in it)
 *
 * and optionally `prompt` ("Enter") and `radius`. `door = "back"` leads to
 * wherever the player came into this space from. A door is used with the
 * interact key; give the Empty `walk = true` as well and it is a zone that
 * takes whoever walks into it (the Empty's drawn size is the zone).
 *
 * How the trip is made depends on what the destination is:
 *
 * - **An interior** is loaded into the scene that is already running, beside
 *   the level (a couple of hundred metres past its edge), and the player is
 *   moved there behind a short fade. The space left behind is not unloaded:
 *   it is hidden and its streaming is held where it was, so walking back out
 *   is the same short fade. This is what
 *   makes a door cheap. Nothing that takes seconds (the renderer, physics,
 *   the sky, the player, compiled shaders) is rebuilt, and an interior is a
 *   megabyte or two that starts loading as the player walks up to its door.
 * - **Another world** (a different sky, a map too big to keep two of) is a
 *   change of level: the game's `leave` callback is called and normally
 *   rebuilds the scene behind the loading screen.
 *
 * What a space looks like inside is its `Environment`: how much sun and sky
 * reach it, fog, exposure. Indoors the sun is left on. It still casts
 * shadows, so in a closed room it arrives only through the windows, as
 * shafts across the floor; what is turned down is the sky's ambient light,
 * which Babylon cannot shadow and which would otherwise light a cellar like a
 * field. (To about a third: at a fifth a stone hall is a cave.)
 */

export interface Environment {
  /** Sunlight, as a share of the level's own (1 = unchanged, 0 = none: a cave). */
  sun: number;
  /** The sky's ambient light and reflections, as a share of the level's own. */
  ambient: number;
  /** Distance haze, as a share of the level's own. 0 turns it off. */
  fog: number;
  /** Exposure, as a multiple of the renderer's own: above 1 in a dim room, as eyes adjust. */
  exposure: number;
  /** How far from the camera shadows are drawn (m). Short in a room: the same shadow map then covers less, and is sharper. */
  shadowDistance?: number;
}

/** A level's own light: nothing changed. */
export const OUTDOORS: Environment = { sun: 1, ambient: 1, fog: 1, exposure: 1 };
/** A room with windows: sun through the openings, a little sky, no haze, eyes adjusted. */
export const INDOORS: Environment = { sun: 1, ambient: 0.35, fog: 0, exposure: 1.5, shadowDistance: 45 };

export interface SpaceInfo {
  id: string;
  /** The map's manifest. */
  map: string;
  /** True for a space that is entered through a door without leaving the scene. */
  interior: boolean;
  environment?: Partial<Environment>;
}

export interface SpacesOptions {
  /** The space the scene was built around, already loaded. */
  home: { id: string; map: StreamedMap | null; environment?: Partial<Environment> };
  lighting: SceneLighting;
  triggers: Triggers;
  /** Looks a space up by id (the game's list of them). */
  find(id: string): SpaceInfo | undefined;
  /**
   * Loads an interior's map with its origin at `origin`, and attaches
   * whatever the game attaches to a map (placed effects, trigger zones).
   */
  load(space: SpaceInfo, origin: Vector3): Promise<StreamedMap>;
  /** Puts the player at a spot, facing `yaw`. */
  place(position: Vector3, yaw: number): void;
  /** Where the player is now (to come back to, for a door that leads "back"). */
  position(): Vector3;
  /** Called for a destination that is not an interior. `marker` is where to arrive. */
  leave(space: SpaceInfo, marker: string | undefined): void;
  /** Start loading an interior when the camera is this close to a door into it (m). Default 30. */
  preloadDistance?: number;
}

export interface Spaces {
  /** The id of the space the player is in. */
  readonly current: string;
  /** True from the moment a door is used until the player can move again. */
  readonly travelling: boolean;
  /**
   * Goes to "space#marker" (or "space", for its `spawn` marker; or "back").
   * Resolves on arrival. With `at`, the player is put there instead of at a
   * marker: for restoring a saved game, where nobody walked through a door.
   * `at.position` is in the place's own coordinates (see `origin`).
   */
  travel(destination: string, at?: { position: Vector3; yaw: number }): Promise<void>;
  /** Loads an interior now, without going there, so that going there is instant. */
  preload(id: string): Promise<void>;
  /** The map of a space, if it is loaded. */
  map(id: string): StreamedMap | null;
  /**
   * Where a loaded space's own zero is in the scene: nothing for the level,
   * a spot beside it for an interior. Which spot depends on the order things
   * were loaded in, so a position that must mean the same thing next time
   * (a saved game) is kept relative to this.
   */
  origin(id: string): Vector3;
  /** Fires on arrival, with the ids of the space left and the space entered. */
  readonly onTravelled: Observable<{ from: string; to: string }>;
  /** How long things took (ms): each interior's load, and the last trip from door to arrival (the fade back in not counted). */
  readonly timings: { loads: Record<string, number>; lastTrip: { from: string; to: string; ms: number } | null };
  dispose(): void;
}

/**
 * Where interiors are put: this far past the level's eastern edge, a row of
 * plots this wide. Near enough to matter: a position is stored in 32 bits,
 * and what that buys shrinks with distance from zero. At 2 km (where
 * interiors first went, to be past the camera's reach) it is a quarter of a
 * millimetre, and after the arithmetic on the way to the screen two surfaces
 * 5 mm apart, a cloth on a table or a device on a banner, can no longer be
 * told apart at a shallow angle: they swap, whole, as the camera moves. At
 * 400 m it is eight times finer. Far enough for the rest: effects, grass and
 * zones all reach less than this, so nothing of one place runs in the other.
 * Being near means being in view, so the place the player is not in is
 * hidden (`map.shown`) instead of being out of sight.
 */
const POCKET_GAP = 192;
const POCKET_PLOT = 256;
/** Fade to black and back (ms, each way). */
const FADE = 220;
/** Frames drawn behind the black before it lifts, so first-sight shader compiles are not seen. */
const SETTLE_FRAMES = 4;

interface Loaded {
  info: SpaceInfo;
  map: StreamedMap | null;
  origin: Vector3;
  environment: Environment;
  /** Where the player came in from, for a door that leads "back". */
  cameFrom: { space: string; position: Vector3; yaw: number } | null;
}

export function createSpaces(ctx: GameContext, options: SpacesOptions): Spaces {
  const { scene, camera } = ctx;
  const { lighting, triggers } = options;
  const preloadDistance = options.preloadDistance ?? 30;
  const onTravelled = new Observable<{ from: string; to: string }>();

  // The level's own light, which every environment is a share of.
  const base = {
    sun: lighting.sunIntensity,
    ambient: lighting.environmentIntensity,
    fog: scene.fogDensity,
    exposure: ctx.renderer.controls.exposure,
    shadowDistance: ctx.renderer.controls.shadowDistance,
  };
  function apply(environment: Environment): void {
    lighting.sunIntensity = base.sun * environment.sun;
    lighting.environmentIntensity = base.ambient * environment.ambient;
    scene.fogDensity = base.fog * environment.fog;
    ctx.renderer.controls.exposure = base.exposure * environment.exposure;
    ctx.renderer.controls.shadowDistance = environment.shadowDistance ?? base.shadowDistance;
  }

  const timings: Spaces["timings"] = { loads: {}, lastTrip: null };
  const spaces = new Map<string, Loaded>();
  const loading = new Map<string, Promise<Loaded>>();
  spaces.set(options.home.id, {
    info: { id: options.home.id, map: "", interior: false },
    map: options.home.map,
    origin: Vector3.Zero(),
    environment: { ...OUTDOORS, ...options.home.environment },
    cameFrom: null,
  });
  let current = options.home.id;
  let travelling = false;
  let disposed = false;
  let pockets = 0;
  // The middle of the level's eastern edge, at ground level: interiors go beyond it.
  const bounds = options.home.map?.manifest;
  const homeEdge = bounds ? new Vector3(bounds.max[0], 0, (bounds.min[2] + bounds.max[2]) / 2) : Vector3.Zero();
  apply(spaces.get(current)!.environment);

  // --- Doors -------------------------------------------------------------------

  /** A door's marker, kept with the space it stands in. */
  const doors: { space: string; marker: MapMarker; to: string }[] = [];
  function addDoors(space: string, map: StreamedMap): void {
    for (const marker of map.manifest.markers) {
      const to = marker.props.door;
      if (typeof to !== "string") continue;
      doors.push({ space, marker, to });
      if (import.meta.env.DEV) void check(space, marker.name, to);
      const position = Vector3.FromArray(marker.position);
      if (marker.props.walk === true || marker.props.walk === 1) {
        triggers.addZone({ name: "door", position, size: marker.size ? Vector3.FromArray(marker.size) : new Vector3(2, 2.4, 2), shape: marker.shape, yaw: marker.yaw, marker });
      } else {
        triggers.addInteractable({
          name: "door",
          at: position,
          prompt: typeof marker.props.prompt === "string" ? marker.props.prompt : "Enter",
          radius: typeof marker.props.radius === "number" ? marker.props.radius : 2.2,
          marker,
        });
      }
    }
  }
  /** In development, says so at once if a door leads to a place or a marker that does not exist. */
  async function check(space: string, door: string, to: string): Promise<void> {
    if (to === "back") return;
    const [id, markerName = "spawn"] = to.split("#") as [string, string | undefined];
    const info = id === options.home.id ? null : options.find(id);
    if (info === undefined) {
      console.warn(`Door "${door}" in "${space}" leads to "${to}", but there is no place called "${id}".`);
      return;
    }
    try {
      const markers = info ? ((await (await fetch(info.map)).json()) as { markers: MapMarker[] }).markers : (options.home.map?.manifest.markers ?? []);
      if (!markers.some((marker) => marker.name === markerName)) {
        console.warn(`Door "${door}" in "${space}" leads to "${to}", but "${id}" has no marker called "${markerName}".`);
      }
    } catch {
      console.warn(`Door "${door}" in "${space}" leads to "${to}", but the map of "${id}" could not be read (not exported yet?).`);
    }
  }
  const use = (marker: MapMarker | undefined): void => {
    const to = marker?.props.door;
    if (typeof to === "string") void travel(to).catch((error) => console.error(`Door "${marker!.name}" leads nowhere:`, error));
  };
  triggers.onInteract("door", (door) => use(door.marker));
  triggers.onEnter("door", ({ zone }) => use(zone.marker));
  if (options.home.map) addDoors(options.home.id, options.home.map);

  // --- Loading interiors -------------------------------------------------------

  function load(id: string): Promise<Loaded> {
    const have = spaces.get(id);
    if (have) return Promise.resolve(have);
    let pending = loading.get(id);
    if (!pending) {
      const info = options.find(id);
      if (!info) return Promise.reject(new Error(`No space called "${id}".`));
      if (!info.interior) return Promise.reject(new Error(`"${id}" is not an interior, so it cannot be loaded beside this level.`));
      // Plots in a row along the edge, working outward from its middle: 0, +1, -1, +2...
      const plot = pockets++;
      const along = Math.ceil(plot / 2) * (plot % 2 === 1 ? 1 : -1);
      const origin = new Vector3(homeEdge.x + POCKET_GAP, homeEdge.y, homeEdge.z + along * POCKET_PLOT);
      const started = performance.now();
      pending = options.load(info, origin).then(async (map) => {
        // A map streams around the camera, and the camera is elsewhere: have
        // this one stream around its own middle until somebody walks in.
        const middle = new Vector3((map.manifest.min[0] + map.manifest.max[0]) / 2, map.manifest.min[1], (map.manifest.min[2] + map.manifest.max[2]) / 2);
        map.shown = false; // until somebody walks in
        map.hold(middle);
        await map.whenLoadedAround(middle);
        const loaded: Loaded = { info, map, origin, environment: { ...INDOORS, ...info.environment }, cameFrom: null };
        spaces.set(id, loaded);
        loading.delete(id);
        addDoors(id, map);
        timings.loads[id] = Math.round(performance.now() - started);
        return loaded;
      });
      pending.catch(() => loading.delete(id));
      loading.set(id, pending);
    }
    return pending;
  }

  // Start loading what is behind a door as the player walks up to it.
  let frame = 0;
  const watch = scene.onBeforeRenderObservable.add(() => {
    if (frame++ % 20 !== 0 || travelling) return;
    const eye = camera.globalPosition;
    for (const door of doors) {
      if (door.space !== current || door.to === "back") continue;
      const id = door.to.split("#")[0]!;
      if (spaces.has(id) || loading.has(id) || !options.find(id)?.interior) continue;
      const [x, , z] = door.marker.position;
      if (Math.hypot(eye.x - x, eye.z - z) < preloadDistance) void load(id).catch((error) => console.warn(`Could not load "${id}" ahead of time:`, error));
    }
  });

  // --- The trip ----------------------------------------------------------------

  // A black sheet over the canvas. Plain HTML: it has to cover the picture
  // whatever the renderer is doing, including while a frame is held up.
  const sheet = document.createElement("div");
  sheet.style.cssText = `position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;transition:opacity ${FADE}ms ease;z-index:5`;
  (ctx.canvas.parentElement ?? document.body).appendChild(sheet);
  const fade = (to: 0 | 1): Promise<void> => {
    sheet.style.opacity = String(to);
    return new Promise((resolve) => setTimeout(resolve, FADE + 30));
  };
  const frames = (count: number): Promise<void> =>
    new Promise((resolve) => {
      let left = count;
      const tick = scene.onAfterRenderObservable.add(() => {
        if (--left > 0) return;
        scene.onAfterRenderObservable.remove(tick);
        resolve();
      });
      // A page in the background draws no frames: don't wait for ever on one.
      setTimeout(() => {
        scene.onAfterRenderObservable.remove(tick);
        resolve();
      }, 1500);
    });

  async function travel(destination: string, at?: { position: Vector3; yaw: number }): Promise<void> {
    if (travelling || disposed) return;
    const here = spaces.get(current)!;
    let id: string;
    let markerName: string | undefined;
    let back: Loaded["cameFrom"] = null;
    if (destination === "back") {
      back = here.cameFrom;
      if (!back) {
        // Nobody walked in (a saved game was restored here): go out by a door that leads in.
        const way = doors.find((door) => door.space !== current && door.to.split("#")[0] === current);
        if (!way) throw new Error(`"back" from "${current}", but no door leads into it.`);
        back = { space: way.space, position: Vector3.FromArray(way.marker.position), yaw: way.marker.yaw };
      }
      id = back.space;
    } else {
      [id, markerName] = destination.split("#") as [string, string | undefined];
    }

    // Somewhere that is neither loaded nor an interior: a change of level.
    if (!spaces.has(id)) {
      const info = options.find(id);
      if (!info) throw new Error(`No space called "${id}".`);
      if (!info.interior) {
        options.leave(info, markerName);
        return;
      }
    }

    travelling = true;
    const wasPaused = ctx.clock.paused;
    try {
      const started = performance.now();
      const [there] = await Promise.all([load(id), fade(1)]);
      if (disposed) return;
      ctx.clock.paused = true; // nothing moves while the world is swapped

      let position: Vector3;
      let yaw: number;
      if (back) {
        ({ position, yaw } = back);
      } else if (at) {
        position = at.position.add(there.origin);
        yaw = at.yaw;
      } else {
        const marker = there.map?.marker(markerName ?? "spawn");
        if (!marker) throw new Error(`"${id}" has no marker called "${markerName ?? "spawn"}".`);
        position = Vector3.FromArray(marker.position);
        yaw = marker.yaw;
        // Remember the way back: where the player stands now, turned round.
        there.cameFrom = { space: current, position: options.position().clone(), yaw: camera.rotation.y + Math.PI };
      }

      // The space being left stays loaded exactly as it is. The one arrived
      // in is held around the arrival point until the camera has got there:
      // a map that streams around the camera while the camera is still in
      // the other space unloads itself, and the trip then takes seconds.
      here.map?.hold(options.position());
      there.map?.hold(position);
      await there.map?.whenLoadedAround(position);
      if (disposed) return;
      // One place is seen at a time. (Both are a short walk apart, see POCKET_GAP.)
      if (there.map) there.map.shown = true;
      if (here.map && here !== there) here.map.shown = false;
      apply(there.environment);
      options.place(position, yaw);
      const from = current;
      current = id;

      // Let a few frames go by behind the black: anything seen for the first
      // time compiles its shaders now, not as the picture comes back.
      ctx.clock.paused = wasPaused;
      await frames(SETTLE_FRAMES);
      there.map?.hold(null); // the camera is with the player again: stream around it
      await Promise.race([scene.whenReadyAsync(), new Promise((resolve) => setTimeout(resolve, 3000))]);
      await frames(2);
      timings.lastTrip = { from, to: id, ms: Math.round(performance.now() - started) };
      onTravelled.notifyObservers({ from, to: id });
    } finally {
      ctx.clock.paused = wasPaused;
      travelling = false;
      await fade(0);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    scene.onBeforeRenderObservable.remove(watch);
    sheet.remove();
    onTravelled.clear();
    // The level's own light back, for whoever keeps the scene.
    apply(OUTDOORS);
  }
  scene.onDisposeObservable.addOnce(dispose);

  return {
    get current() {
      return current;
    },
    get travelling() {
      return travelling;
    },
    travel,
    preload: (id) => load(id).then(() => undefined),
    map: (id) => spaces.get(id)?.map ?? null,
    origin: (id) => spaces.get(id)?.origin ?? Vector3.Zero(),
    onTravelled,
    timings,
    dispose,
  };
}
