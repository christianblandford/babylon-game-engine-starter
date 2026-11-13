import { Observable } from "@babylonjs/core/Misc/observable";
import type { QualityLevel } from "../config";

/** Player preferences, saved in the browser and editable from the settings menu. */
export interface Settings {
  quality: QualityLevel;
  /** 0..1 */
  masterVolume: number;
  /** Multiplier on look speed: 1 is the default feel. */
  lookSensitivity: number;
  invertY: boolean;
}

const DEFAULTS: Settings = { quality: "high", masterVolume: 0.7, lookSensitivity: 1, invertY: false };
const STORAGE_KEY = "settings";

function read(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Settings>;
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS }; // storage blocked or corrupt: fall back quietly
  }
}

let current = read();

/** Fires with the new settings after every change. */
export const onSettingsChanged = new Observable<Settings>();

export function getSettings(): Readonly<Settings> {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage blocked: the change still applies for this session */
  }
  onSettingsChanged.notifyObservers(current);
}
