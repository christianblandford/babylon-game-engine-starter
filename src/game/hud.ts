import { Control } from "@babylonjs/gui/2D/controls/control";
import { Ellipse } from "@babylonjs/gui/2D/controls/ellipse";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle";
import { StackPanel } from "@babylonjs/gui/2D/controls/stackPanel";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock";
import type { AbstractMesh } from "@babylonjs/core";
import type { GameContext } from "../engine/context";
import type { Player } from "./player";

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

export interface Hud {
  /** Floats a text label above a mesh; it follows the mesh on screen. */
  label(mesh: AbstractMesh, text: string): void;
  /** Shows "[key] text" low on the screen, for something the player can use now. Null hides it. */
  prompt(key: string, text: string | null): void;
  /** Shows a line of text near the top of the screen for a few seconds. */
  toast(text: string): void;
  /**
   * Shows what someone is saying, low on the screen: who, the line, the
   * answers on offer (numbered) and a hint of what to press. Null puts it away.
   */
  say(speech: { speaker: string | null; text: string; choices: string[]; hint: string } | null): void;
  dispose(): void;
}

/**
 * In-game UI drawn with Babylon GUI: a controls hint, a first-person crosshair
 * and labels anchored to things in the world.
 */
export function createHud(ctx: GameContext, player: Player, showDebugHints: boolean): Hud {
  // Drawn after post-processing, so UI isn't tone-mapped, bloomed or blurred.
  const ui = ctx.renderer.createGui("hud");

  // --- Controls hint ---------------------------------------------------------
  const lines = [
    "Click to capture the mouse  ·  Esc to release",
    "WASD move  ·  Shift run  ·  Space jump",
    "V first / third person  ·  Wheel zoom  ·  P pause",
  ];
  if (showDebugHints) lines.push("`  debug panel  ·  Shift+`  inspector");

  const hint = new Rectangle("hint");
  hint.widthInPixels = 372;
  hint.heightInPixels = 22 + lines.length * 20;
  hint.cornerRadius = 10;
  hint.thickness = 0;
  hint.background = "rgba(10, 12, 16, 0.55)";
  hint.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  hint.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  hint.leftInPixels = 16;
  hint.topInPixels = -16;
  ui.addControl(hint);

  const hintText = new TextBlock("hintText", lines.join("\n"));
  hintText.color = "#e8ecf1";
  hintText.fontFamily = FONT;
  hintText.fontSizeInPixels = 13;
  hintText.lineSpacing = "4px";
  hintText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  hintText.paddingLeftInPixels = 14;
  hint.addControl(hintText);

  // --- Crosshair (first person only) -----------------------------------------
  const crosshair = new Ellipse("crosshair");
  crosshair.widthInPixels = crosshair.heightInPixels = 6;
  crosshair.thickness = 1;
  crosshair.color = "rgba(0, 0, 0, 0.6)";
  crosshair.background = "rgba(255, 255, 255, 0.9)";
  crosshair.isVisible = player.viewMode === "first";
  ui.addControl(crosshair);
  const viewObserver = player.onViewModeChanged.add((mode) => (crosshair.isVisible = mode === "first"));

  // --- Interaction prompt ------------------------------------------------------
  const prompt = new Rectangle("prompt");
  prompt.heightInPixels = 36;
  prompt.adaptWidthToChildren = true;
  prompt.cornerRadius = 10;
  prompt.thickness = 0;
  prompt.background = "rgba(10, 12, 16, 0.6)";
  prompt.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  prompt.topInPixels = -120;
  prompt.isVisible = false;
  ui.addControl(prompt);
  const promptText = new TextBlock("promptText", "");
  promptText.color = "#ffffff";
  promptText.fontFamily = FONT;
  promptText.fontSizeInPixels = 15;
  promptText.resizeToFit = true;
  promptText.paddingLeftInPixels = promptText.paddingRightInPixels = 16;
  prompt.addControl(promptText);

  // --- Dialogue ------------------------------------------------------------------
  const speech = new Rectangle("speech");
  speech.width = "92%";
  speech.adaptHeightToChildren = true;
  speech.cornerRadius = 14;
  speech.thickness = 0;
  speech.background = "rgba(10, 12, 16, 0.78)";
  speech.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  speech.topInPixels = -40;
  speech.isVisible = false;
  ui.addControl(speech);
  // Never wider than is comfortable to read, nor than the window. (The UI is
  // laid out in the page's own pixels, whatever resolution the game renders at.)
  const fitSpeech = (): void => {
    const windowWidth = ctx.engine.getRenderWidth() * ctx.engine.getHardwareScalingLevel();
    speech.widthInPixels = Math.max(240, Math.min(760, windowWidth - 32));
  };
  const speechLines = new StackPanel("speechLines");
  speechLines.isVertical = true;
  speechLines.paddingTopInPixels = speechLines.paddingBottomInPixels = 16;
  speechLines.paddingLeftInPixels = speechLines.paddingRightInPixels = 22;
  speech.addControl(speechLines);
  const speechText = (name: string, size: number, color: string, weight = "400"): TextBlock => {
    const block = new TextBlock(name, "");
    block.color = color;
    block.fontFamily = FONT;
    block.fontSizeInPixels = size;
    block.fontWeight = weight;
    block.lineSpacing = "5px";
    block.textWrapping = true; // at words
    block.resizeToFit = true;
    block.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    block.paddingBottomInPixels = 6;
    speechLines.addControl(block);
    return block;
  };
  const speechSpeaker = speechText("speechSpeaker", 14, "#8fb8ff", "700");
  const speechLine = speechText("speechLine", 18, "#ffffff");
  // One block per answer: a single block holding several lines sizes itself a line short and clips the last.
  const speechChoices = Array.from({ length: 9 }, (_, i) => speechText(`speechChoice${i}`, 16, "#e8ecf1"));
  const speechHint = speechText("speechHint", 12, "rgba(232, 236, 241, 0.6)");

  // --- Toast ---------------------------------------------------------------------
  const toast = new TextBlock("toast", "");
  toast.color = "#ffffff";
  toast.fontFamily = FONT;
  toast.fontSizeInPixels = 22;
  toast.fontWeight = "600";
  toast.shadowColor = "rgba(0, 0, 0, 0.7)";
  toast.shadowBlur = 8;
  toast.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  toast.topInPixels = 90;
  toast.heightInPixels = 40;
  toast.alpha = 0;
  ui.addControl(toast);
  /** Seconds of game time left on screen; it fades over the last half second. */
  let toastTime = 0;
  const toastObserver = ctx.scene.onBeforeRenderObservable.add(() => {
    if (toastTime <= 0) return;
    toastTime -= ctx.clock.delta;
    toast.alpha = Math.min(1, Math.max(0, toastTime / 0.5));
  });

  return {
    prompt(key, text) {
      prompt.isVisible = text !== null;
      if (text !== null) promptText.text = `[ ${key} ]   ${text}`;
    },
    toast(text) {
      toast.text = text;
      toast.alpha = 1;
      toastTime = 3;
    },
    say(said) {
      speech.isVisible = said !== null;
      hint.isVisible = said === null; // the controls hint would sit under it
      if (!said) return;
      fitSpeech();
      speechSpeaker.text = said.speaker ?? "";
      speechSpeaker.isVisible = said.speaker !== null;
      speechLine.text = said.text;
      speechChoices.forEach((block, i) => {
        block.isVisible = i < said.choices.length;
        if (block.isVisible) block.text = `${i + 1}.  ${said.choices[i]}`;
      });
      speechHint.text = said.hint;
    },
    label(mesh, text) {
      const tag = new Rectangle(`label:${mesh.name}`);
      tag.heightInPixels = 24;
      tag.adaptWidthToChildren = true;
      tag.cornerRadius = 12;
      tag.thickness = 0;
      tag.background = "rgba(10, 12, 16, 0.6)";
      ui.addControl(tag);
      tag.linkWithMesh(mesh);
      tag.linkOffsetYInPixels = -52;

      const tagText = new TextBlock(undefined, text);
      tagText.color = "#ffffff";
      tagText.fontFamily = FONT;
      tagText.fontSizeInPixels = 12;
      tagText.resizeToFit = true;
      tagText.paddingLeftInPixels = tagText.paddingRightInPixels = 10;
      tag.addControl(tagText);
    },
    dispose() {
      player.onViewModeChanged.remove(viewObserver);
      ctx.scene.onBeforeRenderObservable.remove(toastObserver);
      ui.dispose();
    },
  };
}
