import "./engine/babylonFeatures"; // first: registers the engine features the game relies on
import { LEVELS, findLevel, getQuality, type LevelInfo } from "./config";
import { createAudio } from "./engine/audio";
import { applyPixelRatio, createEngine } from "./engine/createEngine";
import { Input } from "./engine/input";
import { getSettings, onSettingsChanged } from "./engine/settings";
import { createWorldState } from "./engine/worldState";
import { createGameScene, type GameScene } from "./game/scene";
import { createShell } from "./game/shell";

type SceneFactory = typeof createGameScene;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const loading = document.getElementById("loading") as HTMLElement;
const params = new URLSearchParams(location.search);
const debugEnabled = import.meta.env.DEV || params.has("debug");

let factory: SceneFactory = createGameScene;
let loadScene: (next?: SceneFactory, level?: LevelInfo, arrival?: string, resume?: boolean) => Promise<void> = async (next) => {
  if (next) factory = next; // engine still booting; picked up by the first load
};

async function boot(): Promise<void> {
  const engine = await createEngine(canvas);
  const input = new Input(canvas);
  const audio = await createAudio();
  audio.masterVolume = getSettings().masterVolume;
  // Placeholder sound effects, synthesised so there are no files to ship.
  await Promise.all([
    audio.synth("jump", { duration: 0.16, frequency: 260, frequencyEnd: 520, gain: 0.25 }),
    audio.synth("land", { duration: 0.14, frequency: 90, frequencyEnd: 50, noise: 0.6, gain: 0.6 }),
  ]);

  // Dev-only tooling stays out of the production bundle's main chunk.
  const debug = debugEnabled
    ? new (await import("./engine/debug")).DebugTools({ engine, reloadScene: () => void loadScene() })
    : null;

  // What the player has changed in the world, and where they were: kept
  // across levels, saved in the browser. `?newgame` starts it empty.
  const state = createWorldState();
  if (params.has("newgame")) state.reset();
  /** The level the saved game was last in, if there is one. */
  const savedLevel = (): LevelInfo | undefined => findLevel(state.get("player/level", ""));

  // Menus. Players start at the main menu; in development you drop straight
  // into the game (add ?menu to the URL to see the menu flow).
  const shell = createShell({
    engine,
    title: "Babylon Game Scaffold",
    levels: LEVELS,
    canContinue: () => savedLevel() !== undefined,
    initialState: import.meta.env.DEV && !params.has("menu") ? "playing" : "menu",
  });

  // `?level=town` starts in a particular level; `?level=town/hall` inside one of its interiors.
  shell.currentLevel = findLevel(params.get("level")) ?? shell.currentLevel;

  let current: GameScene | null = null;
  let loadId = 0;

  /** Makes the loaded scene match the shell: frozen behind a menu, or live. */
  const syncToShell = (): void => {
    const playing = shell.state === "playing";
    if (current) current.clock.paused = !playing;
    input.pointerLockOnClick = playing;
    if (playing) input.requestPointerLock();
    else input.exitPointerLock();
  };

  loadScene = async (next = factory, level = shell.currentLevel, arrival, resume = false) => {
    factory = next;
    const id = ++loadId;
    const quality = getQuality();
    const firstLoad = current === null;
    if (!firstLoad && level !== shell.currentLevel) loading.classList.remove("hidden");
    try {
      // The old scene keeps rendering while the new one loads, then they swap.
      const created = await next({
        engine,
        canvas,
        input,
        audio,
        quality,
        level,
        arrival,
        state,
        resume,
        debug: debugEnabled,
        // A door that leads to another level: load it, and arrive at the door's marker.
        travelTo: (next, marker) => void loadScene(factory, next, marker),
      });
      if (id !== loadId) {
        created.dispose(); // a newer load started meanwhile
        return;
      }
      current?.dispose();
      current = created;
      shell.currentLevel = level;
      created.applySettings(getSettings());
      syncToShell();
      // Handy in the browser console: `game.scene`, `game.player`, `game.map`, ...
      if (debugEnabled) (window as unknown as { game: GameScene }).game = created;
      applyPixelRatio(engine, quality.maxPixelRatio);
      engine.resize();
      debug?.bind(created);
    } catch (error) {
      console.error("Scene failed to load:", error);
      if (firstLoad) loading.textContent = "Failed to load — see the console.";
    } finally {
      if (id === loadId && current) loading.classList.add("hidden");
    }
  };

  // --- Menus drive the game -------------------------------------------------
  shell.onStateChanged.add(syncToShell);
  shell.onLevelRequested.add((level) => {
    // "Play" on the level already idling behind the menu just starts it;
    // anything else (another level, or a restart mid-game) loads fresh.
    const fresh = level !== shell.currentLevel || shell.state === "paused";
    // "Restart level" means the level as it was at its start: what was done
    // in it (a gate lowered, a fire put out) is forgotten. Without that,
    // lowering the town's gate and restarting leaves the player on the road
    // outside, and the only lever is inside.
    if (level === shell.currentLevel && shell.state === "paused") state.forget(`${level.id}/`);
    void (fresh ? loadScene(factory, level) : Promise.resolve()).then(() => shell.resume());
  });

  // "Continue": back to the level, the place in it and the spot the save was made at.
  shell.onContinueRequested.add(() => {
    void loadScene(factory, savedLevel() ?? shell.currentLevel, undefined, true).then(() => shell.resume());
  });
  // "New game": forget everything, start the first level from its beginning.
  shell.onNewGameRequested.add(() => {
    state.reset();
    void loadScene(factory, LEVELS[0]!).then(() => shell.resume());
  });

  // Losing the mouse capture mid-game (Esc, alt-tab) pauses, as players expect.
  document.addEventListener("pointerlockchange", () => {
    if (!input.pointerLocked) shell.pause();
  });

  let appliedQuality = getSettings().quality;
  onSettingsChanged.add((settings) => {
    audio.masterVolume = settings.masterVolume;
    current?.applySettings(settings);
    if (settings.quality !== appliedQuality) {
      appliedQuality = settings.quality;
      void loadScene(); // quality changes shadow maps, buffers and view distance: rebuild
    }
  });

  engine.runRenderLoop(() => {
    if (!current) return;
    input.update();
    if (input.wasPressed("pause")) shell.togglePause();
    current.scene.render();
    shell.render();
    input.endFrame();
    debug?.frame();
  });
  new ResizeObserver(() => engine.resize()).observe(canvas);

  // `?continue` picks the saved game up where it was (in development there is no menu to ask from).
  if (params.has("continue") && savedLevel()) await loadScene(factory, savedLevel(), undefined, true);
  else await loadScene();
}

void boot();

// Hot reload: when game/scene.ts (or anything it imports) changes, rebuild the
// scene in place. The engine, input, audio, menus and page all stay alive.
if (import.meta.hot) {
  import.meta.hot.accept("./game/scene", (module) => {
    if (module) void loadScene(module.createGameScene as SceneFactory);
  });
}
