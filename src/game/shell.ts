import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Observable } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";
import type { AbstractEngine } from "@babylonjs/core";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import { Button } from "@babylonjs/gui/2D/controls/button";
import { Checkbox } from "@babylonjs/gui/2D/controls/checkbox";
import { Control } from "@babylonjs/gui/2D/controls/control";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle";
import { Slider } from "@babylonjs/gui/2D/controls/sliders/slider";
import { StackPanel } from "@babylonjs/gui/2D/controls/stackPanel";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock";
import { QUALITY_PRESETS, type LevelInfo, type QualityLevel } from "../config";
import { getSettings, updateSettings } from "../engine/settings";

/**
 * What the game is doing at the top level:
 * - `menu`: the main menu is up; a level idles behind it as a backdrop.
 * - `playing`: the player has control.
 * - `paused`: the level is frozen with the pause menu over it.
 */
export type ShellState = "menu" | "playing" | "paused";

export interface ShellOptions {
  engine: AbstractEngine;
  title: string;
  levels: LevelInfo[];
  /** State to start in. */
  initialState: ShellState;
}

export interface Shell {
  readonly state: ShellState;
  readonly onStateChanged: Observable<ShellState>;
  /** The player chose a level (from the main menu, the level list, or "Restart"). */
  readonly onLevelRequested: Observable<LevelInfo>;
  /** The level now loaded, so "Play" and "Restart" know what to start. */
  currentLevel: LevelInfo;
  pause(): void;
  resume(): void;
  togglePause(): void;
  /** Draws the menus. Call once per frame, after the game scene has rendered. */
  render(): void;
  dispose(): void;
}

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const ACCENT = "#3b82f6";
const QUALITY_LEVELS = Object.keys(QUALITY_PRESETS) as QualityLevel[];

/**
 * The game's menus: main menu, pause, settings and level select, drawn with
 * Babylon GUI.
 *
 * They live in a small scene of their own, rendered on top of the game. That
 * keeps them alive across level changes and hot reloads, and out of the
 * game's post-processing.
 *
 * The shell only decides *what state the game is in* and reports what the
 * player asked for; main.ts acts on it (loading levels, pausing the clock).
 */
export function createShell(options: ShellOptions): Shell {
  const { engine, levels } = options;

  const scene = new Scene(engine);
  scene.autoClear = false; // draw over the game, don't wipe it
  scene.clearColor = new Color4(0, 0, 0, 0);
  new FreeCamera("shellCamera", Vector3.Zero(), scene);
  const ui = AdvancedDynamicTexture.CreateFullscreenUI("shell", true, scene, undefined, true);

  const onStateChanged = new Observable<ShellState>();
  const onLevelRequested = new Observable<LevelInfo>();
  let state: ShellState = options.initialState;
  let currentLevel = levels[0]!;

  // --- Building blocks -----------------------------------------------------

  const dim = new Rectangle("dim");
  dim.thickness = 0;
  dim.background = "rgba(6, 8, 12, 0.62)";
  dim.isPointerBlocker = true; // clicks on the backdrop don't reach the game
  ui.addControl(dim);

  const card = new Rectangle("card");
  card.widthInPixels = 380;
  card.adaptHeightToChildren = true;
  card.cornerRadius = 14;
  card.thickness = 1;
  card.color = "rgba(255, 255, 255, 0.08)";
  card.background = "rgba(18, 21, 28, 0.94)";
  card.isPointerBlocker = true;
  ui.addControl(card);

  const column = new StackPanel("column");
  column.widthInPixels = 316;
  column.paddingTopInPixels = 28;
  column.paddingBottomInPixels = 28;
  card.addControl(column);

  function heading(text: string): void {
    const block = new TextBlock(undefined, text);
    block.color = "#f4f6f9";
    block.fontFamily = FONT;
    block.fontSizeInPixels = 22;
    block.fontWeight = "600";
    block.heightInPixels = 44;
    block.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    column.addControl(block);
  }

  function button(label: string, onClick: () => void, primary = false): Button {
    const control = Button.CreateSimpleButton(`button:${label}`, label);
    const rest = primary ? ACCENT : "rgba(255, 255, 255, 0.07)";
    const hover = primary ? "#5b9bff" : "rgba(255, 255, 255, 0.14)";
    control.heightInPixels = 52;
    control.paddingTopInPixels = 4;
    control.paddingBottomInPixels = 4;
    control.cornerRadius = 9;
    control.thickness = 0;
    control.background = rest;
    control.color = "#f4f6f9";
    control.fontFamily = FONT;
    control.fontSizeInPixels = 15;
    control.pointerEnterAnimation = () => (control.background = hover);
    control.pointerOutAnimation = () => (control.background = rest);
    control.pointerDownAnimation = () => (control.alpha = 0.85);
    control.pointerUpAnimation = () => (control.alpha = 1);
    control.onPointerUpObservable.add(onClick);
    column.addControl(control);
    return control;
  }

  /** A labelled row: the label on the left, a control on the right. */
  function row(label: string, control: Control): TextBlock {
    const line = new Rectangle();
    line.thickness = 0;
    line.heightInPixels = 46;
    const text = new TextBlock(undefined, label);
    text.color = "#c5ccd6";
    text.fontFamily = FONT;
    text.fontSizeInPixels = 14;
    text.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    line.addControl(text);
    control.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    line.addControl(control);
    column.addControl(line);
    return text;
  }

  function slider(label: string, min: number, max: number, value: number, onChange: (value: number) => void): void {
    const control = new Slider();
    control.minimum = min;
    control.maximum = max;
    control.value = value;
    control.widthInPixels = 170;
    control.heightInPixels = 16;
    control.color = ACCENT;
    control.background = "rgba(255, 255, 255, 0.14)";
    control.thumbColor = "#f4f6f9";
    control.isThumbCircle = true;
    control.thumbWidth = "16px";
    control.barOffset = "5px";
    control.onValueChangedObservable.add(onChange);
    row(label, control);
  }

  function checkbox(label: string, value: boolean, onChange: (value: boolean) => void): void {
    const control = new Checkbox();
    control.widthInPixels = 20;
    control.heightInPixels = 20;
    control.isChecked = value;
    control.color = ACCENT;
    control.background = "rgba(255, 255, 255, 0.1)";
    control.onIsCheckedChangedObservable.add(onChange);
    row(label, control);
  }

  /** A button that steps through a short list of options. */
  function choice<T extends string>(label: string, values: readonly T[], value: T, onChange: (value: T) => void): void {
    let index = Math.max(0, values.indexOf(value));
    const control = Button.CreateSimpleButton(`choice:${label}`, values[index]!);
    control.widthInPixels = 170;
    control.heightInPixels = 32;
    control.cornerRadius = 7;
    control.thickness = 0;
    control.background = "rgba(255, 255, 255, 0.1)";
    control.color = "#f4f6f9";
    control.fontFamily = FONT;
    control.fontSizeInPixels = 14;
    control.onPointerUpObservable.add(() => {
      index = (index + 1) % values.length;
      if (control.textBlock) control.textBlock.text = values[index]!;
      onChange(values[index]!);
    });
    row(label, control);
  }

  function gap(pixels = 10): void {
    const spacer = new Rectangle();
    spacer.thickness = 0;
    spacer.heightInPixels = pixels;
    column.addControl(spacer);
  }

  // --- Screens ----------------------------------------------------------------

  type Screen = "main" | "pause" | "settings" | "levels";

  function show(screen: Screen | null): void {
    column.clearControls();
    const visible = screen !== null;
    dim.isVisible = visible;
    card.isVisible = visible;
    if (!visible) return;

    /** Where "Back" goes from a sub-screen. */
    const home: Screen = state === "paused" ? "pause" : "main";

    switch (screen) {
      case "main":
        heading(options.title);
        button("Play", () => onLevelRequested.notifyObservers(currentLevel), true);
        if (levels.length > 1) button("Levels", () => show("levels"));
        button("Settings", () => show("settings"));
        break;

      case "pause":
        heading("Paused");
        button("Resume", resume, true);
        button("Settings", () => show("settings"));
        button("Restart level", () => onLevelRequested.notifyObservers(currentLevel));
        button("Main menu", () => setState("menu"));
        break;

      case "levels":
        heading("Levels");
        for (const level of levels) button(level.name, () => onLevelRequested.notifyObservers(level), level === currentLevel);
        gap();
        button("Back", () => show(home));
        break;

      case "settings": {
        const settings = getSettings();
        heading("Settings");
        choice("Graphics quality", QUALITY_LEVELS, settings.quality, (quality) => updateSettings({ quality }));
        slider("Volume", 0, 1, settings.masterVolume, (masterVolume) => updateSettings({ masterVolume }));
        slider("Look sensitivity", 0.2, 3, settings.lookSensitivity, (lookSensitivity) => updateSettings({ lookSensitivity }));
        checkbox("Invert vertical look", settings.invertY, (invertY) => updateSettings({ invertY }));
        gap();
        button("Back", () => show(home));
        break;
      }
    }
  }

  function setState(next: ShellState): void {
    if (next === state) return;
    state = next;
    show(state === "menu" ? "main" : state === "paused" ? "pause" : null);
    onStateChanged.notifyObservers(state);
  }

  function resume(): void {
    setState("playing");
  }

  show(state === "menu" ? "main" : state === "paused" ? "pause" : null);

  return {
    get state() {
      return state;
    },
    onStateChanged,
    onLevelRequested,
    get currentLevel() {
      return currentLevel;
    },
    set currentLevel(level: LevelInfo) {
      currentLevel = level;
    },
    pause() {
      if (state === "playing") setState("paused");
    },
    resume,
    togglePause() {
      if (state === "playing") setState("paused");
      else if (state === "paused") setState("playing");
    },
    render() {
      if (state !== "playing") scene.render(); // nothing to draw while the player has control
    },
    dispose() {
      onStateChanged.clear();
      onLevelRequested.clear();
      scene.dispose();
    },
  };
}
