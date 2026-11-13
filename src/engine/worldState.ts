import { DataStorage } from "@babylonjs/core/Misc/dataStorage";
import { Observable } from "@babylonjs/core/Misc/observable";

/**
 * What the player has done to the world, remembered.
 *
 * A level is rebuilt every time it is entered, and built the way its map
 * says: the gate up, every fire lit. Whatever should stay changed (a gate
 * lowered, a chest emptied, a lever thrown, where the player was) is written
 * here, and read back when the thing is built again. It outlives scenes (it
 * is made once, in main.ts) and it is saved in the browser as it changes, so
 * it outlives the page as well.
 *
 * It is a flat list of named values:
 *
 *     state.set("town/gate.lowered", true);
 *     state.get("town/gate.lowered", false);      // false is the answer when nothing is stored
 *
 * Names are yours to choose; the convention is the place, then the thing,
 * then what about it: `<level>/<thing>.<property>`, with an interior as
 * `<level>/<interior>/<thing>.<property>`. `scope("town")` gives a view that
 * writes the place for you, which is what a level's own code is handed.
 *
 * Babylon has no save-game system. It has `DataStorage` (a guarded wrapper
 * over the browser's local storage, used here) and `SceneSerializer`, which
 * writes out a whole scene's meshes and materials and is the wrong tool: a
 * save is the handful of facts that differ from the level as built, not the
 * level.
 */

export type StateValue = string | number | boolean;

export interface WorldState {
  /** The stored value, or `fallback` when there is none (or it is of another type). */
  get<T extends StateValue>(key: string, fallback: T): T;
  /** Stores a value; `undefined` forgets it. Setting what is already there does nothing. */
  set(key: string, value: StateValue | undefined): void;
  /** A view of this state that puts `prefix/` before every name. */
  scope(prefix: string): WorldState;
  /** Fires after a value changes, with its full name. */
  readonly onChanged: Observable<{ key: string; value: StateValue | undefined }>;
  /** True if anything is stored: there is a game to continue. */
  readonly any: boolean;
  /** Forgets everything: a new game. */
  reset(): void;
  /** Writes to the browser now, instead of a moment after the last change. */
  flush(): void;
  /** Everything stored, by full name. For a debug panel, or for sending a save somewhere else. */
  snapshot(): Record<string, StateValue>;
}

/** Bump when the meaning of stored names changes; older saves are then dropped rather than misread. */
const VERSION = 1;
/** How long after a change the save is written (ms): a burst of changes is one write. */
const WRITE_DELAY = 400;

interface SaveFile {
  version: number;
  saved: string;
  values: Record<string, StateValue>;
}

/** `slot` names the save in the browser's storage: one per save game. */
export function createWorldState(slot = "save"): WorldState {
  const storageKey = `world:${slot}`;
  const onChanged = new Observable<{ key: string; value: StateValue | undefined }>();
  const values = new Map<string, StateValue>();

  const stored = DataStorage.ReadJson<SaveFile | null>(storageKey, null);
  if (stored && stored.version === VERSION && stored.values && typeof stored.values === "object") {
    for (const [key, value] of Object.entries(stored.values)) values.set(key, value);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    const file: SaveFile = { version: VERSION, saved: new Date().toISOString(), values: Object.fromEntries(values) };
    DataStorage.WriteJson(storageKey, file);
  }
  const touch = (): void => {
    timer ??= setTimeout(flush, WRITE_DELAY);
  };
  // A tab being closed gets no later moment to write in.
  globalThis.addEventListener?.("pagehide", () => {
    if (timer !== undefined) flush();
  });

  function view(prefix: string): WorldState {
    const name = (key: string): string => prefix + key;
    return {
      get<T extends StateValue>(key: string, fallback: T): T {
        const value = values.get(name(key));
        return typeof value === typeof fallback ? (value as T) : fallback;
      },
      set(key, value) {
        const full = name(key);
        if (values.get(full) === value) return;
        if (value === undefined) values.delete(full);
        else values.set(full, value);
        touch();
        onChanged.notifyObservers({ key: full, value });
      },
      scope: (inner) => view(`${prefix}${inner}/`),
      onChanged,
      get any() {
        return values.size > 0;
      },
      reset() {
        const keys = [...values.keys()];
        values.clear();
        flush();
        for (const key of keys) onChanged.notifyObservers({ key, value: undefined });
      },
      flush,
      snapshot: () => Object.fromEntries(values),
    };
  }
  return view("");
}
